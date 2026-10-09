#!/usr/bin/env node
// npm run benchmark:mcp:report -- <results dir>
// Recomputes summary.json and summary.md from the saved raw results only (manifest, runs.jsonl, grades,
// run directories). Deterministic: same inputs, byte-identical outputs. Makes no claims, only measurements.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { median, quantile, readJson } from "./lib.mjs";
import { loadPrivateManifest } from "./tasks.mjs";

const expDir = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(expDir, "manifest.json"))) throw new Error("usage: report.mjs <results dir>");
const manifest = readJson(join(expDir, "manifest.json"));
// Experiments before the Codex switch have no agent.executor and ran on Claude Code.
const codex = manifest.agent.executor === "codex";
const truth = loadPrivateManifest();
const attempts = existsSync(join(expDir, "runs.jsonl")) ? readFileSync(join(expDir, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
const grades = Object.fromEntries(
  (existsSync(join(expDir, "grades")) ? readdirSync(join(expDir, "grades")) : []).sort().map((f) => [f.replace(/\.json$/, ""), readJson(join(expDir, "grades", f))]),
);

// The latest attempt of each planned run counts; earlier invalid attempts are listed, never mixed in.
const latest = {};
for (const a of attempts) latest[a.run_key] = a;
const runs = manifest.plan.map((p) => latest[p.run_key]).filter(Boolean);
const valid = runs.filter((r) => r.validity.valid);
const invalid = attempts.filter((a) => !a.validity.valid);
const missing = manifest.plan.filter((p) => !latest[p.run_key]).map((p) => p.run_key);
for (const r of valid) {
  const g = grades[r.answer_id];
  r.verdict = g?.verdict ?? "ungraded";
  r.correct = r.verdict === "correct";
  r.difficulty = truth[r.task_id]?.difficulty;
  r.category = truth[r.task_id]?.category;
}
const graded = valid.filter((r) => r.verdict !== "ungraded");
const arms = manifest.arms;

const METRICS = [
  ["mcp_tool_calls", "MCP tool calls"],
  ["mcp_failed_calls", "Failed MCP calls"],
  ["sql_statements", "SQL statements (all)"],
  ["sql_statements_excl_control", "SQL statements (excl. txn control/SET)"],
  ["sql_errors", "SQL errors"],
  ["mcp_request_bytes", "MCP request bytes"],
  ["mcp_response_bytes", "MCP response bytes"],
  ["pgss_rows", "Rows returned (pg_stat_statements)"],
  ["wall_ms", "Wall time (ms)"],
  ["agent_turns", "Agent turns"],
  ["input_tokens", "Input tokens (incl. cache)"],
  ["output_tokens", "Output tokens"],
  ["reasoning_output_tokens", "Reasoning tokens (part of output)"],
];
const dist = (rs, k) => {
  const xs = rs.map((r) => r.metrics[k]);
  return { n: xs.filter((x) => typeof x === "number").length, median: round(median(xs)), p25: round(quantile(xs, 0.25)), p75: round(quantile(xs, 0.75)) };
};
const round = (x) => (x === null ? null : Math.round(x * 100) / 100);
const correctness = (rs) => {
  const g = rs.filter((r) => r.verdict !== "ungraded");
  return { correct: g.filter((r) => r.correct).length, partial: g.filter((r) => r.verdict === "partial").length, wrong: g.filter((r) => r.verdict === "wrong").length, graded: g.length, rate: g.length ? round(g.filter((r) => r.correct).length / g.length) : null };
};
const byArm = (rs, f) => Object.fromEntries(arms.map((a) => [a, f(rs.filter((r) => r.arm === a))]));
const groupBy = (rs, key) => [...new Set(rs.map((r) => r[key]))].sort().map((v) => [v, rs.filter((r) => r[key] === v)]);

const summary = {
  experiment_id: manifest.experiment_id,
  provenance: {
    created_at: manifest.created_at, os: manifest.os, benchmark_commit: manifest.benchmark_commit, queryio: manifest.queryio, servers: manifest.servers,
    adventureworks: { conversion: manifest.adventureworks.conversion.repository, commit: manifest.adventureworks.conversion.commit, data_sha256: manifest.adventureworks.data.sha256 },
    postgres: manifest.postgres, agent: { executor: codex ? "codex" : "claude-code", ...manifest.agent }, grader: manifest.grader ?? null, task_suite: manifest.task_suite, repetitions: manifest.repetitions, seed: manifest.seed,
    status: manifest.status ?? null, status_note: manifest.status_note ?? null,
  },
  counts: { planned: manifest.plan.length, completed: runs.length, valid: valid.length, graded: graded.length, invalid_attempts: invalid.length, missing: missing.length },
  correctness: byArm(valid, correctness),
  metrics_all_runs: byArm(valid, (rs) => Object.fromEntries(METRICS.map(([k]) => [k, dist(rs, k)]))),
  metrics_correct_runs: byArm(valid, (rs) => Object.fromEntries(METRICS.map(([k]) => [k, dist(rs.filter((r) => r.correct), k)]))),
  by_difficulty: Object.fromEntries(groupBy(valid, "difficulty").map(([d, rs]) => [d, byArm(rs, (x) => ({ ...correctness(x), median_calls: round(median(x.map((r) => r.metrics.mcp_tool_calls))), median_sql: round(median(x.map((r) => r.metrics.sql_statements_excl_control))) }))])),
  by_category: Object.fromEntries(groupBy(valid, "category").map(([c, rs]) => [c, byArm(rs, correctness)])),
  by_task: Object.fromEntries(groupBy(valid, "task_id").map(([t, rs]) => [t, { difficulty: truth[t]?.difficulty, category: truth[t]?.category, arms: byArm(rs, (x) => ({ verdicts: x.sort((a, b) => a.repetition - b.repetition).map((r) => r.verdict), median_calls: round(median(x.map((r) => r.metrics.mcp_tool_calls))), median_sql: round(median(x.map((r) => r.metrics.sql_statements_excl_control))), median_wall_s: round(median(x.map((r) => r.metrics.wall_ms / 1000))) })) }])),
  calls_by_tool: byArm(valid, (rs) => {
    const out = {};
    for (const r of rs) for (const [t, n] of Object.entries(r.metrics.mcp_calls_by_tool)) out[t] = (out[t] ?? 0) + n;
    return Object.fromEntries(Object.entries(out).sort());
  }),
  fairness_audit: audit(),
  invalid_attempts: invalid.map((a) => ({ run_key: a.run_key, attempt: a.attempt, problems: a.validity.problems })),
  missing_runs: missing,
  runs: valid.map((r) => ({ run_key: r.run_key, task_id: r.task_id, arm: r.arm, repetition: r.repetition, verdict: r.verdict, answer_id: r.answer_id, ...pick(r.metrics, METRICS.map(([k]) => k)) })),
};

function pick(o, keys) {
  return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
}

function audit() {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ check: name, ok, detail });
  const tasks = [...new Set(valid.map((r) => r.task_id))];
  add("same database content across arms (per task)", tasks.every((t) => new Set(valid.filter((r) => r.task_id === t).map((r) => r.environment.database_digest)).size === 1));
  add("database content equals task template", valid.every((r) => r.environment.database_digest === r.environment.template_digest));
  add("byte-identical task prompt across arms (per task)", tasks.every((t) => new Set(valid.filter((r) => r.task_id === t).map((r) => r.environment.prompt_sha256)).size === 1));
  add("identical system prompt", new Set(valid.map((r) => r.environment.system_prompt_sha256)).size <= 1);
  add("one agent CLI version", new Set(valid.map((r) => r.environment.agent_cli_version)).size <= 1, [...new Set(valid.map((r) => r.environment.agent_cli_version))].join(", "));
  if (codex) {
    add("same model, reasoning effort, timeout for all runs", valid.every((r) => r.environment.agent_model === manifest.agent.model && r.environment.agent_effort === manifest.agent.effort), `${manifest.agent.model}, effort ${manifest.agent.effort}, ${manifest.agent.timeout_seconds}s (requested per run; Codex does not echo the served model)`);
    add("fresh agent session per run", new Set(valid.map((r) => r.environment.agent_session_id)).size === valid.length, manifest.agent.session_isolation);
    add("agent used only database tools (no shell/file/web items)", valid.every((r) => (r.environment.agent_item_types ?? []).every((t) => ["agent_message", "reasoning", "mcp_tool_call", "todo_list", "error"].includes(t))),
      `${valid.filter((r) => r.validity.warnings.some((w) => w.startsWith("agent used built-in"))).length} run(s) used built-in non-database tools (warning)`);
  } else {
    add("same model, effort, max turns, timeout for all runs", true, `${manifest.agent.model}, effort ${manifest.agent.effort}, ${manifest.agent.max_turns} turns, ${manifest.agent.timeout_seconds}s (enforced per run; mismatching runs are invalid)`);
    add("fresh agent session per run", new Set(valid.map((r) => r.environment.agent_session_id)).size === valid.length);
    add("agent had only database tools (no filesystem/shell)", valid.every((r) => (r.environment.agent_tools ?? []).every((t) => t.startsWith("mcp__database__"))));
  }
  add("no rows written during any run", valid.every((r) => r.environment.rows_written === 0));
  add("MCP calls seen by agent equal calls seen by the recorder", true, "enforced per run; mismatching runs are invalid");
  add("SQL recorded for every run with tool calls", valid.every((r) => r.metrics.mcp_tool_calls === 0 || r.metrics.sql_statements > 0));
  add("raw traces present (transcript, MCP events, SQL events)", valid.every((r) => ["transcript.jsonl", "mcp-events.jsonl", "sql-events.jsonl"].every((f) => existsSync(join(expDir, r.run_dir, f)))));
  add("pinned server versions", Object.values(manifest.servers).every((v) => /^\d+\.\d+\.\d+$/.test(v ?? "")), JSON.stringify(manifest.servers));
  add("answers stored without arm identity", readdirSync(join(expDir, "answers")).every((f) => !("arm" in readJson(join(expDir, "answers", f)))));
  add("all valid runs graded", graded.length === valid.length, `${graded.length}/${valid.length}`);
  add("QueryIO working tree clean at experiment start", !manifest.queryio.dirty);
  return checks;
}

writeFileSync(join(expDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(join(expDir, "summary.md"), markdown(summary));
console.log(`[report] ${join(expDir, "summary.md")}`);

function markdown(s) {
  const L = [];
  const row = (cells) => L.push(`| ${cells.join(" | ")} |`);
  const head = (cells) => (row(cells), row(cells.map(() => "---")));
  const fmt = (x) => (x === null || x === undefined ? "-" : String(x));
  L.push(`# AdventureWorks MCP investigation benchmark: ${s.experiment_id}`, "");
  if (codex) L.push(`Agent: Codex CLI ${s.provenance.agent.cli_version} / Model: ${s.provenance.agent.model} (${s.provenance.agent.effort}) / Auth: ${s.provenance.agent.auth_method}. Grader: Codex CLI / ${s.provenance.grader.model} (${s.provenance.grader.effort}).`, "");
  else L.push(`Agent: Claude Code ${s.provenance.agent.cli_version} / Model: ${s.provenance.agent.model} (effort ${s.provenance.agent.effort}).`, "");
  if (s.provenance.status) L.push(`**Status: ${s.provenance.status}.** ${s.provenance.status_note ?? ""}`, "");
  L.push(`QueryIO ${s.provenance.queryio.commit.slice(0, 12)}${s.provenance.queryio.dirty ? " (dirty tree)" : ""}, DBHub ${s.provenance.servers.dbhub}, @microsoft/postgres-mcp ${s.provenance.servers.postgres_mcp}. ${s.provenance.postgres.version.split(" on ")[0]}. Task suite ${s.provenance.task_suite.hash.slice(0, 12)}, ${s.provenance.repetitions} repetition(s), seed ${s.provenance.seed}.`, "");
  L.push(`Runs: ${s.counts.valid} valid of ${s.counts.planned} planned, ${s.counts.graded} graded, ${s.counts.invalid_attempts} invalid attempt(s) excluded, ${s.counts.missing} missing.`, "");
  L.push("## Correctness (primary)", "");
  head(["", ...arms]);
  row(["Correct", ...arms.map((a) => `${s.correctness[a].correct}/${s.correctness[a].graded}`)]);
  row(["Correctness", ...arms.map((a) => (s.correctness[a].rate === null ? "-" : `${Math.round(s.correctness[a].rate * 100)}%`))]);
  row(["Partial", ...arms.map((a) => s.correctness[a].partial)]);
  row(["Wrong", ...arms.map((a) => s.correctness[a].wrong)]);
  for (const [title, key] of [["Efficiency, all valid runs (median [p25-p75])", "metrics_all_runs"], ["Efficiency, correct runs only (median [p25-p75])", "metrics_correct_runs"]]) {
    L.push("", `## ${title}`, "");
    head(["", ...arms]);
    for (const [k, label] of METRICS) row([label, ...arms.map((a) => { const d = s[key][a][k]; return d.n ? `${fmt(d.median)} [${fmt(d.p25)}-${fmt(d.p75)}]` : "-"; })]);
    row(["n", ...arms.map((a) => s[key][a].mcp_tool_calls.n)]);
  }
  L.push("", "Token counts come from the agent CLI and are reported for reference only.", "");
  L.push("## By difficulty", "");
  head(["Difficulty", ...arms.map((a) => `${a} correct`), ...arms.map((a) => `${a} median calls`)]);
  for (const [d, v] of Object.entries(s.by_difficulty)) row([d, ...arms.map((a) => `${v[a].correct}/${v[a].graded}`), ...arms.map((a) => fmt(v[a].median_calls))]);
  L.push("", "## By category", "");
  head(["Category", ...arms]);
  for (const [c, v] of Object.entries(s.by_category)) row([c, ...arms.map((a) => `${v[a].correct}/${v[a].graded}`)]);
  L.push("", "## Per task (verdict per repetition; median MCP calls / SQL statements excl. control / wall s)", "");
  head(["Task", "Difficulty", ...arms]);
  for (const [t, v] of Object.entries(s.by_task)) row([t, v.difficulty, ...arms.map((a) => `${v.arms[a].verdicts.map((x) => ({ correct: "C", partial: "P", wrong: "W" })[x] ?? "?").join("")} (${fmt(v.arms[a].median_calls)} / ${fmt(v.arms[a].median_sql)} / ${fmt(v.arms[a].median_wall_s)})`)]);
  L.push("", "## MCP calls by tool", "");
  for (const a of arms) L.push(`- ${a}: ${Object.entries(s.calls_by_tool[a]).map(([t, n]) => `${t} ${n}`).join(", ") || "-"}`);
  L.push("", "## Fairness audit", "");
  head(["Check", "Result", "Detail"]);
  for (const c of s.fairness_audit) row([c.check, c.ok ? "pass" : "FAIL", c.detail]);
  if (s.invalid_attempts.length) {
    L.push("", "## Invalid attempts (excluded)", "");
    const byReason = {};
    for (const i of s.invalid_attempts) (byReason[i.problems.join("; ")] ??= []).push(`${i.run_key}#${i.attempt}`);
    for (const [reason, keys] of Object.entries(byReason).sort()) L.push(`- ${keys.length} x ${reason}: ${keys.length > 6 ? `${keys.slice(0, 6).join(", ")}, ...` : keys.join(", ")}`);
    L.push("", "Each invalid attempt was re-run; only valid attempts are counted above. Full list in summary.json.");
  }
  if (s.missing_runs.length) L.push("", `Missing runs: ${s.missing_runs.join(", ")}`);
  return L.join("\n") + "\n";
}
