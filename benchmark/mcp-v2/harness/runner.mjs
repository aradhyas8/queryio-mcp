#!/usr/bin/env node
// npm run benchmark:mcp:run -- [--profile smoke|full] [--tasks a,b] [--arms a,b] [--reps n] [--concurrency n] [--resume <dir>]
// Runs every (task, arm, repetition) as a fresh, isolated agent session against its own clone of the
// task's incident database, recording MCP traffic (common recorder) and SQL (PostgreSQL log) for each.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARMS } from "../configs/arms.mjs";
import { claudeArgs, claudeVersion, runClaude } from "./agent.mjs";
import {
  BENCH_DIR, RESULTS_DIR, closeSandboxSessions, createSandbox, dropDatabase, dropStaleSandboxes, dropSandbox, fingerprint, gitInfo, fileSha256,
  opaqueId, readJson, rng, run, sandboxWrites, serverVersions, sha256, shuffle, withClient, REPO_DIR,
} from "./lib.mjs";
import { LogTail, sqlEvents, sqlMetrics, statStatements } from "./postgres-recorder.mjs";
import { verifyBase } from "./setup.mjs";
import { buildTemplate, loadPublicTasks, suiteHash } from "./tasks.mjs";

const { values: opts } = parseArgs({
  options: {
    profile: { type: "string", default: "smoke" },
    tasks: { type: "string" },
    arms: { type: "string" },
    reps: { type: "string" },
    concurrency: { type: "string" },
    resume: { type: "string" },
  },
});

const config = readJson(join(BENCH_DIR, "configs", "experiment.json"));
const systemPrompt = readFileSync(join(BENCH_DIR, "prompts", "system.txt"), "utf8");
const taskTemplate = readFileSync(join(BENCH_DIR, "prompts", "task.txt"), "utf8");
const questions = Object.fromEntries(loadPublicTasks().map((t) => [t.id, t.question]));
const taskPrompt = (id) => taskTemplate.replace("{{QUESTION}}", () => questions[id]);

await verifyBase(() => {});
await dropStaleSandboxes();
const expDir = opts.resume ? resolve(opts.resume) : join(RESULTS_DIR, `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${opts.profile}`);
const manifest = opts.resume ? readJson(join(expDir, "manifest.json")) : await newManifest();
if (!opts.resume) {
  mkdirSync(join(expDir, "prompts"), { recursive: true });
  writeFileSync(join(expDir, "prompts", "system.txt"), systemPrompt);
  for (const id of manifest.tasks) writeFileSync(join(expDir, "prompts", `${id}.txt`), taskPrompt(id));
  writeFileSync(join(expDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
} else if (manifest.task_suite.hash !== suiteHash()) {
  throw new Error("task suite changed since this experiment started; refusing to resume");
}
for (const d of ["runs", "answers"]) mkdirSync(join(expDir, d), { recursive: true });
console.log(`[run] experiment ${manifest.experiment_id}: ${manifest.plan.length} runs, model ${manifest.agent.model}`);

const runsFile = join(expDir, "runs.jsonl");
const done = new Set(
  existsSync(runsFile) ? readFileSync(runsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((r) => r.validity.valid).map((r) => r.run_key) : [],
);
const tail = new LogTail();
await tail.init();
let cloneLock = Promise.resolve();
// Arms of one (task, repetition) group run side by side on clones of one template, so they share the
// same data, the same planner statistics, and the same time window. Groups run one after another.
const parallelArms = Number(opts.concurrency ?? manifest.concurrency ?? 1);
const groups = [];
for (const item of manifest.plan) {
  if (done.has(item.run_key)) continue;
  const key = `${item.task_id}.r${item.repetition}`;
  if (groups.at(-1)?.key !== key) groups.push({ key, task_id: item.task_id, items: [] });
  groups.at(-1).items.push(item);
}
const total = groups.reduce((n, g) => n + g.items.length, 0);
let finished = 0;
const templates = {};
for (const group of groups) {
  // One template per group (keeps disk use to one template plus one clone per arm). Its content must
  // match the digest recorded the first time this task was built in this experiment.
  const name = await buildTemplate(group.task_id);
  const fp = await fingerprint(name);
  manifest.templates[group.task_id] ??= fp.digest;
  writeFileSync(join(expDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (manifest.templates[group.task_id] !== fp.digest) {
    await dropDatabase(name);
    throw new Error(`${group.task_id}: template content differs from the digest recorded for this experiment`);
  }
  templates[group.task_id] = { name, digest: fp.digest };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallelArms, group.items.length) }, async () => {
    while (next < group.items.length) {
      const item = group.items[next++];
      const record = await executeRun(item);
      appendFileSync(runsFile, JSON.stringify(record) + "\n");
      finished++;
      const m = record.metrics;
      console.log(`[run] ${finished}/${total} ${item.run_key} ${record.validity.valid ? "valid" : `INVALID (${record.validity.problems.join("; ")})`} ` +
        `calls=${m.mcp_tool_calls} sql=${m.sql_statements} wall=${Math.round(m.wall_ms / 1000)}s turns=${m.agent_turns ?? "?"}`);
    }
  }));
  await dropDatabase(name);
}
console.log(`[run] done: ${expDir}`);

async function newManifest() {
  const all = loadPublicTasks().map((t) => t.id);
  const profile = config.profiles[opts.profile];
  if (!profile && !opts.tasks) throw new Error(`unknown profile ${opts.profile}`);
  const tasks = opts.tasks ? opts.tasks.split(",") : profile.tasks === "all" ? all : profile.tasks;
  for (const t of tasks) if (!questions[t]) throw new Error(`unknown task ${t}`);
  const arms = opts.arms ? opts.arms.split(",") : config.arms;
  for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm ${a}`);
  const reps = Number(opts.reps ?? profile?.repetitions ?? 1);
  const rand = rng(config.seed);
  const plan = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const task of shuffle(tasks, rand)) {
      for (const arm of shuffle(arms, rand)) plan.push({ run_key: `${task}.${arm}.r${rep}`, task_id: task, arm, repetition: rep });
    }
  }
  const git = gitInfo();
  const pgVersion = await withClient("postgres", async (c) => (await c.query("SELECT version()")).rows[0].version);
  const image = run("docker", ["image", "inspect", "--format", "{{.Id}}", "queryio-bench-aw:pg16.10"]).stdout.trim();
  const distHash = sha256(readdirSync(join(REPO_DIR, "dist")).filter((f) => f.endsWith(".js")).sort().map((f) => fileSha256(join(REPO_DIR, "dist", f))).join(""));
  return {
    experiment_id: `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${opts.profile}-${opaqueId(3)}`,
    created_at: new Date().toISOString(),
    profile: opts.profile,
    os: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version },
    benchmark_commit: git,
    queryio: { commit: git.sha, dirty: gitInfo(["src", "package.json", "package-lock.json"]).dirty, version: serverVersions().queryio, dist_sha256: distHash },
    servers: serverVersions(),
    adventureworks: readJson(join(BENCH_DIR, "adventureworks", "source.json")),
    postgres: { version: pgVersion, image_id: image },
    agent: {
      cli: config.agent.cli, cli_version: claudeVersion(config.agent.cli), model: config.agent.model, effort: config.agent.effort,
      max_turns: config.agent.max_turns, timeout_seconds: config.agent.timeout_seconds,
      args_template: claudeArgs({ ...config.agent, maxTurns: config.agent.max_turns, systemPrompt: "<prompts/system.txt>", mcpConfigPath: "<per-run mcp-config.json>", allowedTools: "mcp__database" }),
    },
    prompts: { system_sha256: sha256(systemPrompt), task_template_sha256: sha256(taskTemplate), task_sha256: Object.fromEntries(tasks.map((t) => [t, sha256(taskPrompt(t))])) },
    task_suite: { hash: suiteHash(), tasks: tasks.length },
    tasks,
    arms,
    repetitions: reps,
    seed: config.seed,
    concurrency: Number(opts.concurrency ?? config.concurrency ?? 1),
    plan,
    templates: {},
  };
}

async function executeRun(item) {
  const attempt = existsSync(join(expDir, "runs")) ? readdirSync(join(expDir, "runs")).filter((d) => d.startsWith(`${item.run_key}.a`)).length + 1 : 1;
  const runDir = join(expDir, "runs", `${item.run_key}.a${attempt}`);
  mkdirSync(runDir, { recursive: true });
  const problems = [];
  const warnings = [];
  const template = templates[item.task_id];

  let release;
  const lock = new Promise((r) => (release = r));
  const prev = cloneLock;
  cloneLock = lock;
  await prev;
  let sb;
  try {
    sb = await createSandbox(template.name);
  } finally {
    release();
  }
  const fp = await fingerprint(sb.database);
  if (fp.digest !== template.digest) problems.push("database state differs from the task template");

  const prompt = taskPrompt(item.task_id);
  writeFileSync(join(runDir, "prompt.txt"), prompt);
  const launch = ARMS[item.arm].launch({ ...sb, privDir: runDir });
  const meta = { run_id: `${manifest.experiment_id}/${item.run_key}`, task_id: item.task_id, arm: item.arm, repetition: item.repetition, server_version: manifest.servers[item.arm === "postgres-mcp" ? "postgres_mcp" : item.arm] ?? null };
  const eventsFile = join(runDir, "mcp-events.jsonl");
  const mcpConfigPath = join(runDir, "mcp-config.json");
  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: { database: { command: process.execPath, args: [join(BENCH_DIR, "harness", "mcp-recorder.mjs"), "--events", eventsFile, "--meta", JSON.stringify(meta), "--", launch.command, ...launch.args], env: launch.env } },
  }, null, 2));

  const agentCwd = mkdtempSync(join(os.tmpdir(), "qio-agent-"));
  const startedAt = new Date().toISOString();
  const agent = await runClaude({
    cli: manifest.agent.cli,
    args: claudeArgs({ model: manifest.agent.model, effort: manifest.agent.effort, maxTurns: manifest.agent.max_turns, systemPrompt, mcpConfigPath, allowedTools: "mcp__database" }),
    prompt,
    cwd: agentCwd,
    timeoutMs: manifest.agent.timeout_seconds * 1000,
    transcriptPath: join(runDir, "transcript.jsonl"),
  });
  const endedAt = new Date().toISOString();
  writeFileSync(join(runDir, "agent-stderr.log"), agent.stderr);

  const killed = await closeSandboxSessions(sb);
  if (killed) warnings.push(`${killed} database sessions still open after the agent exited were terminated`);
  await new Promise((r) => setTimeout(r, 750));
  await tail.poll();
  const sql = sqlEvents(tail.take(sb.role));
  writeFileSync(join(runDir, "sql-events.jsonl"), sql.map((e) => JSON.stringify(e)).join("\n") + (sql.length ? "\n" : ""));
  const writes = await sandboxWrites(sb);
  const pgss = await statStatements(sb.role);
  await dropSandbox(sb);

  const events = existsSync(eventsFile) ? readFileSync(eventsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const calls = events.filter((e) => e.kind === "tool_call");
  const serverInfo = events.find((e) => e.kind === "server_info")?.server_info ?? null;
  const agentToolUses = agent.messages.filter((m) => m.type === "assistant").flatMap((m) => m.message?.content ?? []).filter((b) => b.type === "tool_use");
  const res = agent.result;

  // Validity: any failed invariant excludes the run from results (it stays in runs.jsonl, flagged).
  if (writes !== 0) problems.push(`${writes} rows written`);
  if (!agent.init) problems.push("agent session did not start");
  else {
    const extra = (agent.init.tools ?? []).filter((t) => !t.startsWith("mcp__database__"));
    if (extra.length) problems.push(`agent had non-database tools: ${extra.join(", ")}`);
    if (!(agent.init.mcp_servers ?? []).some((s) => s.name === "database" && s.status === "connected")) problems.push("MCP server not connected");
    if (agent.init.model !== manifest.agent.model) problems.push(`model ${agent.init.model} != ${manifest.agent.model}`);
  }
  const models = Object.keys(res?.modelUsage ?? {});
  if (models.some((m) => m !== manifest.agent.model)) problems.push(`other models used: ${models.join(", ")}`);
  if (!agent.timedOut && !res) problems.push(`agent exited ${agent.exitCode} without a result`);
  if (res?.is_error && res.subtype !== "error_max_turns") problems.push(`agent error: ${res.subtype} ${res.api_error_status ?? ""}`.trim());
  if (!events.some((e) => e.kind === "proxy_start")) problems.push("MCP recorder did not start");
  if (agentToolUses.length !== calls.length) problems.push(`agent made ${agentToolUses.length} tool calls but the recorder saw ${calls.length}`);
  if (sha256(prompt) !== manifest.prompts.task_sha256[item.task_id]) problems.push("prompt differs from the manifest");
  if (calls.length > 0 && sql.length === 0) warnings.push("tool calls but no SQL recorded");

  const answer = res?.result ?? "";
  const answerId = opaqueId(8);
  writeFileSync(join(expDir, "answers", `${answerId}.json`), JSON.stringify({ answer_id: answerId, task_id: item.task_id, answer }, null, 2) + "\n");

  const sum = (xs, k) => xs.reduce((a, x) => a + (x[k] ?? 0), 0);
  const sqlM = sqlMetrics(sql);
  return {
    experiment_id: manifest.experiment_id,
    run_key: item.run_key,
    attempt,
    run_dir: `runs/${item.run_key}.a${attempt}`,
    task_id: item.task_id,
    arm: item.arm,
    repetition: item.repetition,
    started_at: startedAt,
    ended_at: endedAt,
    answer_id: answerId,
    outcome: { timed_out: agent.timedOut, exit_code: agent.exitCode, result_subtype: res?.subtype ?? null, max_turns_hit: res?.subtype === "error_max_turns", answer_chars: answer.length },
    metrics: {
      wall_ms: agent.wallMs,
      agent_turns: res?.num_turns ?? null,
      mcp_tool_calls: calls.length,
      mcp_failed_calls: calls.filter((c) => !c.ok).length,
      mcp_request_bytes: sum(calls, "request_bytes"),
      mcp_response_bytes: sum(calls, "response_bytes"),
      mcp_calls_by_tool: Object.fromEntries([...new Set(calls.map((c) => c.tool))].sort().map((t) => [t, calls.filter((c) => c.tool === t).length])),
      ...sqlM,
      ...pgss,
      input_tokens: res?.usage ? (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0) : null,
      output_tokens: res?.usage?.output_tokens ?? null,
      cost_usd: res?.total_cost_usd ?? null,
    },
    environment: {
      database_digest: fp.digest,
      template_digest: template.digest,
      rows_written: writes,
      server_info: serverInfo,
      agent_session_id: agent.init?.session_id ?? null,
      agent_cli_version: agent.init?.claude_code_version ?? null,
      agent_tools: agent.init?.tools ?? null,
      prompt_sha256: sha256(prompt),
      system_prompt_sha256: sha256(systemPrompt),
    },
    validity: { valid: problems.length === 0, problems, warnings },
  };
}
