# MCP v2 benchmark: AdventureWorks investigations

This benchmark compares three PostgreSQL MCP servers used by the same coding agent on the same
AdventureWorks database:

| Arm | Server | Version |
| --- | --- | --- |
| `queryio` | QueryIO, this repository (`dist/cli.js`, production MCP server) | commit recorded per experiment |
| `dbhub` | `@bytebase/dbhub` | 1.4.0 (pinned in `servers/package-lock.json`) |
| `postgres-mcp` | `@microsoft/postgres-mcp` | 0.2.0 (pinned in `servers/package-lock.json`) |
| `psql-control` | raw psql passthrough (engineering control, opt in with `--arms`) | benchmark-owned |

The v1 benchmark (`benchmark/runner.cjs`, `fixture/`) is untouched.

The primary metric is correctness: did the agent find the true root cause? Every other metric is
secondary, and efficiency is reported both over all runs and over correct runs only.

## Commands

```bash
npm run benchmark:mcp:setup     # fetch/verify inputs, install pinned servers, build QueryIO, load + verify AdventureWorks
npm run benchmark:mcp:validate  # validate every incident from a clean snapshot (writes incidents/validation/report.json)
npm run benchmark:mcp:probe     # no-LLM check: each server via the recorder, SQL capture, write blocked
npm run benchmark:mcp:codex:smoke  # setup + 3 tasks (easy/medium/hard) x 3 arms x 1 rep + grading + report
npm run benchmark:mcp:codex        # setup + all tasks x 3 arms x 5 reps + grading + report
npm run benchmark:mcp:smoke     # setup + 5 tasks x 3 arms x 2 reps + grading + report
npm run benchmark:mcp:report -- benchmark/mcp-v2/results/<experiment>   # recompute reports from raw data
npm run benchmark:mcp:grade  -- benchmark/mcp-v2/results/<experiment>   # (re)grade answers
```

Runner options (pass after `--`): `--tasks a,b`, `--arms a,b`, `--reps n`, `--concurrency n`,
`--resume <results dir>` (fills in missing or invalid runs of an existing experiment).

Requirements: Docker, Node 22+, and the Codex CLI (`npm i -g @openai/codex`) logged in with ChatGPT
(`codex login`; agent and grader). Host port 54330. The harness copies `~/.codex/auth.json` into the
gitignored `benchmark/mcp-v2/.codex-home/` and copies refreshed tokens back, so the main login stays valid.

## Architecture

```
codex exec (fresh session + fresh CODEX_HOME)         one run
   |  stdio
   v
harness/mcp-recorder.mjs   <- same proxy for every arm: logs every JSON-RPC message + one record per tools/call
   |  stdio
   v
QueryIO | DBHub | postgres-mcp      (connects as an opaque per-run read-only role)
   |
   v
PostgreSQL 16 (Docker)    awr_<random>: clone of the task template   <- log_statement=all (jsonlog) + pg_stat_statements
```

* **Database state.** `aw_base` is AdventureWorks as loaded. For each (task, repetition) a template
  `awt_<random>` = `aw_base` + the task's mutation SQL + `ANALYZE` is built, and every arm of that
  group gets its own `CREATE DATABASE ... TEMPLATE` clone. Before each run the clone's content
  fingerprint (row counts plus an order-independent hash of every row of all 68 tables) must equal the
  template's, and the template's must equal the digest first recorded for that task in the experiment.
  After each run, `pg_stat_database` must show zero rows written. Arms of one group run side by side
  (same data, same planner statistics, same time window); groups run one after another.
* **Read-only access.** Each run logs in as `bench_<random>`, a member of the `aw_readers` group
  (SELECT only), with `default_transaction_read_only = on`, CONNECT only on its own clone. Names are
  random so the agent cannot learn the task or arm from them.
* **MCP metrics** come only from the common recorder: tool calls, failures (JSON-RPC errors and
  `isError` results), request/response bytes, and durations. `initialize`, `tools/list`, and
  notifications are logged but not counted as calls.
* **SQL metrics** come only from PostgreSQL's own statement log, filtered to the run's role, so
  internal SQL issued by any server (QueryIO's role checks, DBHub's transaction wrapping,
  postgres-mcp's catalog queries) is counted identically; harness SQL runs as `postgres` and is
  excluded. Reported as all statements, statements excluding transaction control / `SET` / empty
  pings, and SQL errors. Rows returned come from `pg_stat_statements`. A simple-protocol message with
  several statements counts once.
* **Agent.** Codex CLI headless (`codex exec`, `harness/agent.mjs`), model `gpt-5.6-terra` with
  `model_reasoning_effort=low` for every run of every arm (`configs/experiment.json`, pinned in the
  manifest). Experiment `20261005T235752-full` used `gpt-6-luna` / `max` and was stopped after 6 runs;
  it is superseded and never combined with `gpt-5.6-terra` results. Each session gets a throwaway `CODEX_HOME` holding only a copy of `auth.json` (no user
  config, `AGENTS.md`, memories, rules, or history; deleted afterwards), plus `--ignore-user-config`,
  `--ignore-rules`, `--ephemeral`, an empty temporary working directory, `-s read-only`,
  `approval_policy="never"`, `web_search="disabled"`, and the shell, file, browser, image, plugin,
  hook, skill, goal, memory, and sub-agent features disabled. The only MCP server is the arm's, named
  `database`, with `default_tools_approval_mode="approve"` (otherwise every call is refused under
  `approval_policy=never`). The system prompt goes in as `developer_instructions` (Codex keeps its own
  base instructions), the neutral task prompt over stdin, and a wall-clock timeout applies (there is no
  turn limit). Code mode stays on because MCP tools are reachable only through it in Codex 0.160; its
  `exec` cannot read files or the network. The answer key cannot be read by the agent.
* **Codex built-ins that cannot be removed.** `wait`, `request_user_input`, and the collaboration
  (sub-agent) tools remain. Sub-agents inherit the same restrictions. Their use is recorded as a
  warning on the run; any shell, file-change, or web item in the event stream makes the run invalid.
* **Executor history.** Experiments `20261005T145212-smoke` and `20261005T150745-full` were run with
  Claude Code (Claude Sonnet 5.5 agent, Claude Opus 5.5 grader). The full one is marked
  `status: partial` and was not resumed. They are kept as-is and must never be combined with Codex
  results; the runner refuses to resume them and the grader refuses to grade them.
* **Grading.** `harness/grader.mjs` gives a grader model (configured separately) only the question,
  the private ground truth, and one answer identified by a random id, with tool and product names
  replaced by `[tool]`. It returns a root-cause verdict (correct / partial / wrong), which required
  facts were found, and unsupported claims. The grader is a fresh Codex session (same isolation, no
  MCP server, `--output-schema` for the JSON shape), model and effort pinned in the manifest
  (`gpt-6-luna`, `high`). **Methodology change:** the Claude Code experiments were graded by Claude
  Opus 5.5; Codex experiments are graded by `gpt-6-luna`, so grades are not comparable across them.
  Empty answers are graded wrong by rule.
* **Validity.** A run is invalid (kept in `runs.jsonl`, excluded from the report, listed in it) if the
  database state differs, rows were written, the agent produced shell/file/web items, called an MCP
  server other than `database`, the MCP server did not connect, the agent exited with an error, the
  recorder missed calls the agent made, or the prompt differs. Timeouts are valid outcomes (graded as
  given). Rate limits (429) are retried with backoff and never recorded; a usage limit stops the
  invocation cleanly (`--resume` continues).

## Files

```
adventureworks/   source.json (pinned sources + hashes), Dockerfile, expected.json (row counts, FKs, digest)
incidents/        manifest.private.json (ground truth), mutations/<id>.sql, validation/<id>.sql, validation/report.json
tasks/            public-tasks.json (questions only)
prompts/          system.txt, task.txt, grader.txt
configs/          arms.mjs (server launch), experiment.json (agent, grader, profiles, seed)
servers/          pinned third-party MCP servers (package.json + lockfile)
harness/          setup, validate, probe, runner, mcp-recorder, postgres-recorder, agent, grader, report, pipeline
results/<id>/     manifest.json, runs.jsonl, runs/<run>/{prompt.txt, transcript.jsonl, mcp-events.jsonl,
                  sql-events.jsonl, mcp-config.json, agent-stderr.log}, answers/, grades/, summary.json, summary.md
```

## AdventureWorks source

`lorint/AdventureWorks-for-Postgres` at commit `b474991f0df1c4bf55ca4735eb0254ca0709eed2` (MIT) supplies
`install.sql` and `update_csvs.rb`; the data is Microsoft's `AdventureWorks-oltp-install-script.zip`
from the `microsoft/sql-server-samples` `adventureworks` release (MIT). Both are downloaded once to
`.cache/`, checked against the SHA-256 values in `adventureworks/source.json`, and converted inside the
image build exactly as the upstream Dockerfile does. Result: 5 schemas, 68 tables, 90 foreign keys,
plus lorint's convenience views (`pe`, `hr`, `pr`, `pu`, `sa`). The conversion shifts sales/purchasing
dates to 2022-2025; HR dates are unchanged. Chosen because it is the most widely used PostgreSQL port,
is pinned by commit, and depends only on a GitHub release asset rather than a dead CodePlex URL.

## Incidents

25 injected incidents (5 easy, 10 medium, 10 hard). Each mutation is deterministic SQL (fixed values
and dates, no `now()` / `random()`). `harness/validate.mjs` checks, for every incident, that the anomaly
exists after the mutation and was absent from the base data, that the stated facts hold, that no other
record shows the same anomaly (the "unique" checks), and that rebuilding from scratch gives identical
content. Validation queries live in `incidents/validation/` and are private.

No Type A (native-data) tasks were kept. While profiling the base data, the natural anomalies found
(salesperson territory history disagreeing with `salesperson.territoryid` for 275/277/282/289, volume
discounts recorded but not applied, 43 orders whose currency does not match their territory, credit
cards all expired relative to the shifted order dates, pending POs with received quantities) have no
single defensible root cause in the data, so they would make weak ground truth. Incidents avoid those
records.

| Id | Level | Area | Injected root cause |
| --- | --- | --- | --- |
| sales-e01 | easy | shipping | ship-to address belongs to another customer |
| purch-e02 | easy | purchasing | complete PO with every received unit rejected |
| hr-e03 | easy | employees | department history row never closed |
| sales-e04 | easy | pricing | line priced 10x the list price |
| purch-e05 | easy | vendors | product's only supplier is inactive |
| sales-m01 | medium | territories | customer record moved to another territory |
| sales-m02 | medium | payments | order charged to another person's card |
| prod-m03 | medium | pricing | overlapping open list-price history rows |
| inv-m04 | medium | inventory | inventory transaction quantity 100x the order line |
| purch-m05 | medium | purchasing | PO sent to a vendor that does not supply the product |
| sales-m06 | medium | organization | store's salesperson left; account never reassigned |
| sales-m07 | medium | discounts | line attached to a volume tier it does not qualify for |
| sales-m08 | medium | shipping | order carries another order's tracking number |
| sales-m09 | medium | payments | card payment without approval code |
| person-m10 | medium | customers | another customer has the same email address |
| hr-h01 | hard | purchasing | buyer moved to Marketing, POs still issued under their id |
| inv-h02 | hard | inventory | PO receipt booked to a similar product (no FK on the reference) |
| hr-h03 | hard | organization | hierarchy node moved under the wrong manager (string paths, no FK) |
| prod-h04 | hard | production | BOM swapped to a wrong-size frame; scrap reason misleads |
| sales-h05 | hard | sales | duplicated order line; legitimate promotion as distractor |
| sales-h06 | hard | financial | order references a rate for the wrong currency |
| sales-h07 | hard | territories | salesperson re-assigned in territory history; revenue moves |
| prod-h08 | hard | products | 10x standard cost in cost history; symptom at subcategory level |
| purch-h09 | hard | purchasing | duplicate purchase order with no receipts |
| sales-h10 | hard | discounts | expired promotion re-activated by an end-date change |

## What was reused and what was replaced

* Reused: the repository's `docker compose` + PostgreSQL 16 approach, the `pg` driver, QueryIO's
  production MCP entry point, and the v1 idea of a uniform measurement path across arms.
* Replaced: v1 ran agents by hand in an IDE harness and measured shell commands from transcripts, gave
  QueryIO a CLI shim instead of its MCP server, graded manually from a fixed table, and reset one shared
  database. v2 runs a headless agent per run, measures every arm through one MCP proxy and the PostgreSQL
  log, grades blinded, and isolates each run in its own clone. The v1 raw-psql arm survives as the
  optional `psql-control` arm (an MCP tool that pipes SQL to psql, since the agent has no shell).

## Known limitations and remaining fairness risks

* Tool names are visible to the agent (`mcp__database__inspect_row` vs `...execute_sql` vs
  `...postgres_mcp_query`), and servers send their own names in `initialize`. The prompt never names a
  product, but the agent can infer it. This is inherent to comparing products.
* `@microsoft/postgres-mcp` has no environment-variable read-only switch for env-var profiles; its
  write tool (`postgres_mcp_modify`) is exposed and fails at the database (read-only role). DBHub uses
  its documented `readonly = true`; QueryIO is read-only by design.
* postgres-mcp needs a `connect` tool call before querying; it is counted like any other call.
* The agent CLI injects some environment context (platform, working directory) into every session;
  it is identical across arms.
* Tokens are reported for reference only.
* The agent (`gpt-5.6-terra`) and the grader (`gpt-6-luna`) are both OpenAI models. Manual audit of a
  sample of grades is recommended before any public claim.
* Codex does not echo the served model in `--json` events, so the model is the one requested (pinned
  per run), not one observed. Agent turn counts are not exposed either (reported as `-`).
* Disk: each group needs one template and one clone per arm (~110 MB each). The Docker disk must have
  room; a near-full host disk stalled Docker during development.
