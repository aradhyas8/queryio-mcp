#!/usr/bin/env node
// npm run benchmark:mcp:grade -- <results dir> [--concurrency n] [--regrade]
// Blinded grading: the grader sees the question, the private ground truth, and one answer identified only
// by a random answer id. It never sees the arm, product, tool trace, timing, or call counts. Tool and
// product names inside the answer text are replaced with [tool] before grading.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { codexArgs, runCodex } from "./agent.mjs";
import { BENCH_DIR, readJson, sha256 } from "./lib.mjs";
import { loadPrivateManifest, loadPublicTasks } from "./tasks.mjs";

const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: { concurrency: { type: "string", default: "4" }, regrade: { type: "boolean", default: false } } });
if (!positionals[0]) throw new Error("usage: grader.mjs <results dir>");
const expDir = resolve(positionals[0]);
const manifest = readJson(join(expDir, "manifest.json"));
// Grades from different grader models must never mix: older (Claude Code) experiments keep their grades.
if (manifest.agent.executor !== "codex") throw new Error("not a Codex experiment; its grades come from the Claude Code grader");
// The grader model pinned in the manifest at experiment start wins over the current config.
const config = { ...readJson(join(BENCH_DIR, "configs", "experiment.json")).grader, ...manifest.grader };
const template = readFileSync(join(BENCH_DIR, "prompts", "grader.txt"), "utf8");
const questions = Object.fromEntries(loadPublicTasks().map((t) => [t.id, t.question]));
const truth = loadPrivateManifest();

// Anything that could reveal which server produced the answer.
const REDACT = [
  /\bmcp__\w+/gi, /\bqueryio\b/gi, /\bdbhub\b/gi, /\bpostgres[-_ ]?mcp\b/gi, /\bpostgres_mcp_\w+/gi, /\bbytebase\b/gi, /\bmicrosoft\b/gi,
  /\binspect_row\b/gi, /\bdescribe_tables\b/gi, /\blist_tables\b/gi, /\bexecute_sql\b/gi, /\bsearch_objects\b/gi, /\bdb_context\b/gi, /\bpsql\b/gi,
];
function redact(text) {
  let count = 0;
  for (const re of REDACT) text = text.replace(re, () => (count++, "[tool]"));
  return { text, count };
}

const SCHEMA = {
  type: "object",
  properties: {
    root_cause_correct: { type: "boolean" },
    verdict: { type: "string", enum: ["correct", "partial", "wrong"] },
    required_facts: { type: "array", items: { type: "object", properties: { fact: { type: "string" }, found: { type: "boolean" } }, required: ["fact", "found"], additionalProperties: false } },
    unsupported_or_incorrect_claims: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
  required: ["root_cause_correct", "verdict", "required_facts", "unsupported_or_incorrect_claims", "rationale"],
  additionalProperties: false,
};
const schemaPath = join(mkdtempSync(join(os.tmpdir(), "qio-grader-schema-")), "schema.json");
writeFileSync(schemaPath, JSON.stringify(SCHEMA));

mkdirSync(join(expDir, "grades"), { recursive: true });
// Only answers from valid runs are graded (latest attempt per run key); nothing else from runs.jsonl
// reaches the grader.
const latest = {};
if (existsSync(join(expDir, "runs.jsonl"))) {
  for (const line of readFileSync(join(expDir, "runs.jsonl"), "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    latest[r.run_key] = r;
  }
}
const validAnswers = new Set(Object.values(latest).filter((r) => r.validity.valid).map((r) => `${r.answer_id}.json`));
const answers = readdirSync(join(expDir, "answers")).filter((f) => validAnswers.has(f)).sort();
const hasVerdict = (f) => existsSync(join(expDir, "grades", f)) && readJson(join(expDir, "grades", f)).verdict;
const todo = answers.filter((f) => opts.regrade || !hasVerdict(f));
let rateLimited = false;
console.log(`[grade] ${todo.length} of ${answers.length} answers to grade with ${config.model}`);
let next = 0;
await Promise.all(Array.from({ length: Number(opts.concurrency) }, async () => {
  while (next < todo.length && !rateLimited) {
    const file = todo[next++];
    const { answer_id, task_id, answer } = readJson(join(expDir, "answers", file));
    const grade = await gradeOne(answer_id, task_id, answer);
    if (grade === "rate-limited") {
      rateLimited = true;
      break;
    }
    writeFileSync(join(expDir, "grades", file), JSON.stringify(grade, null, 2) + "\n");
    console.log(`[grade] ${answer_id} ${task_id}: ${grade.verdict}`);
  }
}));
if (rateLimited) {
  console.error("[grade] stopped: API rate/usage limit. Re-run the grader later; finished grades are kept.");
  process.exit(3);
}

async function gradeOne(answerId, taskId, answer) {
  const t = truth[taskId].expected;
  const { text, count } = redact(answer);
  const base = { answer_id: answerId, task_id: taskId, redactions: count };
  if (!text.trim()) {
    return { ...base, grader: "rule:empty-answer", verdict: "wrong", root_cause_correct: false, required_facts: t.required_facts.map((fact) => ({ fact, found: false })), unsupported_or_incorrect_claims: [], rationale: "No answer was produced." };
  }
  const prompt = template
    .replace("{{QUESTION}}", () => questions[taskId])
    .replace("{{ROOT_CAUSE}}", () => t.root_cause)
    .replace("{{REQUIRED_FACTS}}", () => t.required_facts.map((f, i) => `${i + 1}. ${f}`).join("\n"))
    .replace("{{NOT_ROOT_CAUSE}}", () => t.not_root_cause.map((f) => `- ${f}`).join("\n"))
    .replace("{{ANSWER}}", () => text);
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Fresh Codex session with no MCP server and every tool feature disabled; the answer is in the prompt.
    const cwd = mkdtempSync(join(os.tmpdir(), "qio-grader-"));
    const lastMessagePath = join(cwd, "last-message.json");
    const res = await runCodex({
      args: codexArgs({ model: config.model, effort: config.effort, developerInstructions: "You are a strict, impartial grader. Output only the requested structured result.", outputSchemaPath: schemaPath, lastMessagePath }),
      prompt,
      cwd,
      timeoutMs: config.timeout_seconds * 1000,
      lastMessagePath,
    });
    if (res.error?.kind === "rate_limit" || res.error?.kind === "usage_limit") return "rate-limited";
    let out = null;
    try {
      out = JSON.parse(res.answer);
    } catch {
      /* retried below */
    }
    if (out && SCHEMA.required.every((k) => k in out)) {
      return { ...base, grader: `llm:codex:${config.model}`, grader_effort: config.effort, grader_session_id: res.sessionId, prompt_sha256: sha256(prompt), ...out, usage: res.usage };
    }
    console.error(`[grade] ${answerId}: attempt ${attempt} returned no structured output (exit ${res.exitCode}${res.error ? `, ${res.error.message.slice(0, 200)}` : ""})`);
  }
  return { ...base, grader: "failed", verdict: null, root_cause_correct: null, required_facts: [], unsupported_or_incorrect_claims: [], rationale: "grader failed" };
}
