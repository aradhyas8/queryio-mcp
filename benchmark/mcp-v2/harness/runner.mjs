#!/usr/bin/env node
// npm run benchmark:mcp:run -- [--profile smoke|full] [--tasks a,b] [--arms a,b] [--reps n] [--concurrency n] [--groups n] [--resume <dir>]
// Runs every (task, arm, repetition) as a fresh, isolated agent session against its own clone of the
// task's incident database, recording MCP traffic (common recorder) and SQL (PostgreSQL log) for each.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARMS } from "../configs/arms.mjs";
import { MCP_STARTUP_TIMEOUT_SEC, codexArgs, codexAuthMethod, codexVersion, runCodex } from "./agent.mjs";
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
    groups: { type: "string" },
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
if (manifest.agent.executor !== "codex") throw new Error(`experiment was run with ${manifest.agent.executor ?? manifest.agent.cli}; this runner only executes Codex experiments`);
console.log(`[run] experiment ${manifest.experiment_id}: ${manifest.plan.length} runs, Codex ${manifest.agent.model} (${manifest.agent.effort})`);

const runsFile = join(expDir, "runs.jsonl");
const done = new Set(
  existsSync(runsFile) ? readFileSync(runsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).filter((r) => r.validity.valid).map((r) => r.run_key) : [],
);
const tail = new LogTail();
await tail.init();
// CREATE DATABASE ... TEMPLATE fails while another session uses the source, so every template build
// and clone goes through one queue.
let dbLock = Promise.resolve();
const serialized = (fn) => {
  const p = dbLock.then(fn);
  dbLock = p.catch(() => {});
  return p;
};
// Arms of one (task, repetition) group run side by side on clones of one template, so they share the
// same data, the same planner statistics, and the same time window. Up to group_concurrency groups run
// at once (each with its own template); every arm of every group sees the same concurrent load.
const parallelArms = Number(opts.concurrency ?? manifest.concurrency ?? 1);
const parallelGroups = Number(opts.groups ?? manifest.group_concurrency ?? 1);
const groups = [];
for (const item of manifest.plan) {
  if (done.has(item.run_key)) continue;
  const key = `${item.task_id}.r${item.repetition}`;
  if (groups.at(-1)?.key !== key) groups.push({ key, task_id: item.task_id, items: [] });
  groups.at(-1).items.push(item);
}
const total = groups.reduce((n, g) => n + g.items.length, 0);
let finished = 0;
let rateLimited = null;
let nextGroup = 0;
await Promise.all(Array.from({ length: Math.min(parallelGroups, groups.length) }, async () => {
  while (nextGroup < groups.length && !rateLimited) await runGroup(groups[nextGroup++]);
}));

async function runGroup(group) {
  // One template per group (keeps disk use to one template plus one clone per arm). Its content must
  // match the digest recorded the first time this task was built in this experiment.
  const name = await serialized(() => buildTemplate(group.task_id));
  const fp = await fingerprint(name);
  manifest.templates[group.task_id] ??= fp.digest;
  writeFileSync(join(expDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (manifest.templates[group.task_id] !== fp.digest) {
    await dropDatabase(name);
    throw new Error(`${group.task_id}: template content differs from the digest recorded for this experiment`);
  }
  const template = { name, digest: fp.digest };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallelArms, group.items.length) }, async () => {
    while (next < group.items.length && !rateLimited) {
      const item = group.items[next++];
      let record;
      // Rate/usage limits and lost connectivity are infrastructure, not results: nothing is recorded.
      // Rate limits and network failures are retried with backoff; a usage limit (or one that persists)
      // ends the invocation.
      for (let retry = 0; ; retry++) {
        record = await executeRun(item, template);
        const kind = record.outcome.error_kind;
        if (!["rate_limit", "usage_limit", "network"].includes(kind)) break;
        if (kind === "usage_limit" || retry >= manifest.agent.max_rate_limit_retries) {
          rateLimited = record.outcome.error_message ?? kind;
          break;
        }
        const waitS = 60 * 2 ** retry;
        console.log(`[run] ${item.run_key}: ${kind}, retrying in ${waitS}s`);
        await new Promise((r) => setTimeout(r, waitS * 1000));
      }
      if (rateLimited) continue;
      appendFileSync(runsFile, JSON.stringify(record) + "\n");
      finished++;
      const m = record.metrics;
      console.log(`[run] ${finished}/${total} ${item.run_key} ${record.validity.valid ? "valid" : `INVALID (${record.validity.problems.join("; ")})`} ` +
        `calls=${m.mcp_tool_calls} sql=${m.sql_statements} wall=${Math.round(m.wall_ms / 1000)}s out_tokens=${m.output_tokens ?? "?"}${record.validity.warnings.length ? ` warn: ${record.validity.warnings.join("; ")}` : ""}`);
    }
  }));
  await dropDatabase(name);
}
if (rateLimited) {
  console.error(`[run] stopped: API rate/usage limit (${rateLimited}). Resume with: node benchmark/mcp-v2/harness/runner.mjs --resume "${expDir}"`);
  process.exit(3);
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
      executor: "codex", cli: "codex", cli_version: codexVersion(), auth_method: codexAuthMethod(),
      model: config.agent.model, effort: config.agent.effort, max_turns: null, timeout_seconds: config.agent.timeout_seconds,
      max_rate_limit_retries: config.agent.max_rate_limit_retries,
      args_template: codexArgs({ model: config.agent.model, effort: config.agent.effort, developerInstructions: "<prompts/system.txt>", mcp: { command: "<mcp-recorder wrapping the arm's server>" }, lastMessagePath: "<run>/last-message.txt" }),
      session_isolation: "fresh CODEX_HOME per session (auth.json only), --ephemeral, --ignore-user-config, --ignore-rules, empty working directory",
    },
    grader: { executor: "codex", model: config.grader.model, effort: config.grader.effort },
    prompts: { system_sha256: sha256(systemPrompt), task_template_sha256: sha256(taskTemplate), task_sha256: Object.fromEntries(tasks.map((t) => [t, sha256(taskPrompt(t))])) },
    task_suite: { hash: suiteHash(), tasks: tasks.length },
    tasks,
    arms,
    repetitions: reps,
    seed: config.seed,
    concurrency: Number(opts.concurrency ?? config.concurrency ?? 1),
    group_concurrency: Number(opts.groups ?? config.group_concurrency ?? 1),
    plan,
    templates: {},
  };
}

async function executeRun(item, template) {
  const attempt = existsSync(join(expDir, "runs")) ? readdirSync(join(expDir, "runs")).filter((d) => d.startsWith(`${item.run_key}.a`)).length + 1 : 1;
  const runDir = join(expDir, "runs", `${item.run_key}.a${attempt}`);
  mkdirSync(runDir, { recursive: true });
  const problems = [];
  const warnings = [];

  const sb = await serialized(() => createSandbox(template.name));
  const fp = await fingerprint(sb.database);
  if (fp.digest !== template.digest) problems.push("database state differs from the task template");

  const prompt = taskPrompt(item.task_id);
  writeFileSync(join(runDir, "prompt.txt"), prompt);
  const launch = ARMS[item.arm].launch({ ...sb, privDir: runDir });
  const meta = { run_id: `${manifest.experiment_id}/${item.run_key}`, task_id: item.task_id, arm: item.arm, repetition: item.repetition, server_version: manifest.servers[item.arm === "postgres-mcp" ? "postgres_mcp" : item.arm] ?? null };
  const eventsFile = join(runDir, "mcp-events.jsonl");
  const mcp = { command: process.execPath, args: [join(BENCH_DIR, "harness", "mcp-recorder.mjs"), "--events", eventsFile, "--meta", JSON.stringify(meta), "--", launch.command, ...launch.args], env: launch.env };
  writeFileSync(join(runDir, "mcp-config.json"), JSON.stringify({ mcp_servers: { database: mcp } }, null, 2));

  const agentCwd = mkdtempSync(join(os.tmpdir(), "qio-agent-"));
  const startedAt = new Date().toISOString();
  const lastMessagePath = join(runDir, "last-message.txt");
  const agent = await runCodex({
    args: codexArgs({ model: manifest.agent.model, effort: manifest.agent.effort, developerInstructions: systemPrompt, mcp, lastMessagePath }),
    prompt,
    cwd: agentCwd,
    timeoutMs: manifest.agent.timeout_seconds * 1000,
    transcriptPath: join(runDir, "transcript.jsonl"),
    lastMessagePath,
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
  // Item types a database-only investigation may produce. Shell, file, and web items mean a disabled tool
  // was reachable (invalid); anything else unexpected (e.g. sub-agent collaboration) is a warning.
  const ALLOWED = new Set(["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"]);
  const FORBIDDEN = /command|file|patch|web|search|image|browser/;
  const otherItems = [...new Set(agent.items.map((i) => i.type).filter((t) => !ALLOWED.has(t)))];

  // Validity: any failed invariant excludes the run from results (it stays in runs.jsonl, flagged).
  if (writes !== 0) problems.push(`${writes} rows written`);
  if (!agent.sessionId) problems.push("agent session did not start");
  if (!serverInfo) problems.push("MCP server not connected");
  // Codex gives the model no tools from a server whose handshake (spawn to tools/list reply) outlasts the
  // startup timeout, and says nothing; the recorder's timestamps are the only evidence.
  const at = (e) => (e ? Date.parse(e.ts) : NaN);
  const listReq = events.find((e) => e.method === "tools/list");
  const listRes = listReq && events.find((e) => e.direction === "server_to_client" && e.id === listReq.id && at(e) >= at(listReq));
  const mcpStartupMs = listRes ? at(listRes) - at(events.find((e) => e.kind === "proxy_start")) : null;
  if (mcpStartupMs === null || !(mcpStartupMs < (MCP_STARTUP_TIMEOUT_SEC - 10) * 1000)) problems.push(`MCP tools not listed within the startup timeout (${mcpStartupMs ?? "never"} ms)`);
  const forbidden = otherItems.filter((t) => FORBIDDEN.test(t));
  if (forbidden.length) problems.push(`agent used non-database tools: ${forbidden.join(", ")}`);
  const builtins = otherItems.filter((t) => !FORBIDDEN.test(t));
  if (builtins.length) warnings.push(`agent used built-in tools: ${builtins.join(", ")}`);
  // Codex's own "codex" server only lists MCP resources (none exist); any other server is a leak.
  const dbCalls = agent.mcpCalls.filter((c) => c.server === "database");
  const codexCalls = agent.mcpCalls.filter((c) => c.server === "codex");
  if (codexCalls.length) warnings.push(`agent called Codex built-in MCP tools: ${[...new Set(codexCalls.map((c) => c.tool))].join(", ")}`);
  const foreign = agent.mcpCalls.filter((c) => c.server !== "database" && c.server !== "codex");
  if (foreign.length) problems.push(`MCP calls to other servers: ${[...new Set(foreign.map((c) => c.server))].join(", ")}`);
  if (!agent.timedOut && agent.exitCode !== 0) problems.push(`agent exited ${agent.exitCode}`);
  if (agent.error && !agent.timedOut) problems.push(`agent error (${agent.error.kind}): ${agent.error.message.slice(0, 200)}`);
  if (!events.some((e) => e.kind === "proxy_start")) problems.push("MCP recorder did not start");
  if (dbCalls.length !== calls.length) problems.push(`agent made ${dbCalls.length} database tool calls but the recorder saw ${calls.length}`);
  if (sha256(prompt) !== manifest.prompts.task_sha256[item.task_id]) problems.push("prompt differs from the manifest");
  if (calls.length > 0 && sql.length === 0) warnings.push("tool calls but no SQL recorded");

  const answer = agent.timedOut ? "" : agent.answer;
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
    outcome: { timed_out: agent.timedOut, exit_code: agent.exitCode, answer_chars: answer.length, error_kind: agent.error?.kind ?? null, error_message: agent.error?.message ?? null },
    metrics: {
      wall_ms: agent.wallMs,
      agent_turns: null, // not exposed by codex exec --json
      mcp_tool_calls: calls.length,
      mcp_failed_calls: calls.filter((c) => !c.ok).length,
      mcp_startup_ms: mcpStartupMs,
      mcp_request_bytes: sum(calls, "request_bytes"),
      mcp_response_bytes: sum(calls, "response_bytes"),
      mcp_calls_by_tool: Object.fromEntries([...new Set(calls.map((c) => c.tool))].sort().map((t) => [t, calls.filter((c) => c.tool === t).length])),
      ...sqlM,
      ...pgss,
      // Codex input_tokens already include cached_input_tokens.
      input_tokens: agent.usage?.input_tokens ?? null,
      cached_input_tokens: agent.usage?.cached_input_tokens ?? null,
      output_tokens: agent.usage?.output_tokens ?? null,
      reasoning_output_tokens: agent.usage?.reasoning_output_tokens ?? null,
    },
    environment: {
      database_digest: fp.digest,
      template_digest: template.digest,
      rows_written: writes,
      server_info: serverInfo,
      agent_executor: manifest.agent.executor,
      agent_session_id: agent.sessionId,
      agent_cli_version: manifest.agent.cli_version,
      agent_model: manifest.agent.model,
      agent_effort: manifest.agent.effort,
      agent_item_types: [...new Set(agent.items.map((i) => i.type))].sort(),
      prompt_sha256: sha256(prompt),
      system_prompt_sha256: sha256(systemPrompt),
    },
    validity: { valid: problems.length === 0, problems, warnings },
  };
}
