# QueryIO Benchmark Report

This document reports the empirical evaluation of QueryIO against raw PostgreSQL (`psql`) and DBHub across 25 independent agent runs on the realistic SaaS fixture (`acme` database, 300 organizations, 6,000 users, 12,000 invoices).

---

## 1. Executive Summary & Verdict

### The Hypothesis
QueryIO hypothesizes that giving coding agents structured, read-only, bounded database primitives with automatic depth-1 neighborhood inspection (`inspect_row`) materially reduces the number of round-trip database interactions and the total database output bytes entering context on forensic debugging tasks, without degrading performance on broad aggregate queries.

### Pre-Declared Win Condition
From the project specification:
1. **Forensic tasks (Tasks 1, 2, 3):** Equal or better correctness plus roughly **30% fewer DB interactions or DB output bytes** entering context versus raw `psql`.
2. **Aggregate tasks (Tasks 4, 5):** No meaningful regression versus raw `psql`.

### The Verdict: **WIN CONDITION NOT MET**

Under the re-extracted metrics using a single uniform transcript counter and manual grading against the published answer key, QueryIO achieves 100% correctness across all runs and provides a substantial reduction in **median context bytes on forensic tasks (-38.5%)**, but **does not meet the pre-declared win condition**:
- Forensic interaction reduction (-16.8% mean, -18.8% median) falls well short of the ~30% target.
- Forensic mean context byte reduction (-20.7%) also falls short of the ~30% target.
- Aggregate tasks exhibit a noticeable regression in mean context bytes (+27.9%) and mean interactions (+14.0%), driven by multi-query exploration and indented JSON output overhead.
- QueryIO experienced 23 failed operations (primarily shell-quoting and JSON argument escaping friction in the CLI shim) versus 0 for raw `psql`.

| Benchmark Slice | Metric | Arm A (Raw `psql`) | Arm B (QueryIO) | Arm C (DBHub Ref) | QueryIO vs `psql` (Delta) | Win Condition Met? |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Forensic Tasks (1–3)** | **Correctness** | 100% (6/6) | 100% (6/6) | 100% (3/3) | Equal (0%) | **YES** |
| | **Mean DB Interactions** | 15.83 | **13.17** | 18.33 | **-16.8%** (-2.67 int) | **NO** (below ~30% target) |
| | **Median DB Interactions**| 16.00 | **13.00** | 21.00 | **-18.8%** (-3.00 int) | **NO** (below ~30% target) |
| | **Mean DB Output Bytes** | 22,911 B | **18,175 B** | 27,425 B | **-20.7%** | **NO** (below ~30% target) |
| | **Median DB Output Bytes**| 25,428 B | **15,633 B** | 31,311 B | **-38.5%** | **YES** (>30% target) |
| | **Failed Operations** | 0 | 14 | 6 | +14 | Regression |
| **Aggregate Tasks (4–5)**| **Correctness** | 100% (4/4) | 100% (4/4) | 100% (2/2) | Equal (0%) | **YES** |
| | **Mean DB Interactions** | 21.50 | 24.50 | 27.00 | +14.0% (+3.00 int) | **NO** (modest regression) |
| | **Median DB Interactions**| 21.50 | 22.00 | 27.00 | +2.3% (+0.50 int) | **YES** (near parity) |
| | **Mean DB Output Bytes** | 24,831 B | 31,756 B | 33,880 B | +27.9% | **NO** (regression) |
| | **Median DB Output Bytes**| 25,073 B | **25,025 B** | 33,880 B | -0.2% | **YES** (parity) |
| | **Failed Operations** | 0 | 9 | 4 | +9 | Regression |
| **Overall (All Tasks)** | **Correctness** | 100% (10/10) | 100% (10/10) | 100% (5/5) | Equal (0%) | **YES** |
| | **Mean DB Interactions** | 18.10 | **17.70** | 21.80 | **-2.2%** (-0.40 int) | Parity |
| | **Median DB Interactions**| 18.50 | **15.50** | 25.00 | **-16.2%** (-3.00 int) | Reduction |
| | **Mean DB Output Bytes** | 23,679 B | **23,607 B** | 30,007 B | **-0.3%** | Parity |
| | **Median DB Output Bytes**| 25,428 B | **16,044 B** | 31,311 B | **-36.9%** | Reduction |
| | **Failed Operations** | 0 | 23 | 10 | +23 | Regression |

**Key Takeaways:**
- On forensic tasks, `inspect_row` delivered a **38.5% reduction in median context bytes** (15,633 B vs 25,428 B) and an 18.8% reduction in median interactions (13.00 vs 16.00). However, mean interactions dropped by only 16.8% and mean bytes dropped by 20.7%, falling short of the ~30% threshold.
- On aggregate tasks, QueryIO showed a **27.9% regression in mean context bytes** (31,756 B vs 24,831 B) and a modest increase in mean interactions (24.50 vs 21.50, +14.0%), though median bytes and median interactions stayed at near parity (-0.2% and +2.3%).
- Across all 10 QueryIO runs, the agent encountered 23 non-zero exit codes. These failures were not database rejections from QueryIO's core engine, but shell quoting and syntax friction when formatting complex SQL queries inside CLI JSON argument strings.
- All three arms achieved 100% correctness under manual evaluation against the fixture answer key.

---

## 2. Methodology & Experimental Controls

### 2.1 The Three Experimental Arms
- **Arm A: Coding Agent + Raw `psql`**
  - Tool: CLI runner executing raw SQL queries via `psql` in the PostgreSQL Docker container.
  - Runs: 2 runs per task $\times$ 5 tasks = **10 runs**.
- **Arm B: Coding Agent + QueryIO**
  - Tool: QueryIO CLI shim executing against QueryIO's `Core` interface (`inspect_row`, `describe_tables`, `list_tables`, `query`).
  - Runs: 2 runs per task $\times$ 5 tasks = **10 runs**.
- **Arm C: Coding Agent + DBHub (Reference)**
  - Tool: DBHub MCP tool shim (`execute_sql`, `search_objects`).
  - Runs: 1 run per task $\times$ 5 tasks = **5 runs**.
- **Total Suite:** 25 independent agent runs.

### 2.2 Methodology Disclosures
To ensure complete transparency and reproducibility:

1. **One Uniform Transcript Counter:**
   All interaction and byte metrics across all three arms were extracted from agent session transcripts using a single uniform counter function (`countMetrics` in `benchmark/runner.cjs`), rather than from QueryIO's internal audit log.
   - An interaction is counted for every completed `run_command` invocation executing the arm's database tool (`psql` or `node ... db-tool.cjs`). File inspections (`cat`, `ls`, `grep`), editor commands, and inline `node -e` evals are excluded. Backgrounded commands that never completed or exited are excluded.
   - DB output bytes are measured as the exact UTF-8 byte count of the command output returned to the agent's context (the content following `Output:\n`).
   - A failed operation is defined uniformly across all arms as any counted interaction where the command exited with a non-zero exit code.
2. **Manual Grading Against Published Answer Key:**
   Every run's final answer was manually evaluated and graded against the definitive ground truth in `fixture/TASKS.md`. No automated string-matching heuristics or LLM-as-judge graders were used.
3. **Workspace Isolation by Instruction:**
   Workspace isolation was enforced by prompt instructions (`Do not look for or assume any answer files exist outside your workspace.`). The answer keys and ground truth files (`fixture/TASKS.md`, `fixture/seed.sql`, `fixture/verify.sql`) were kept outside the workspace copy. Post-hoc audits confirmed that no agent transcript accessed or referenced files in `fixture/`.
4. **Manual Orchestration:**
   All benchmark runs were orchestrated and monitored manually by the operator rather than through an autonomous headless scheduler.
5. **CLI Shim for QueryIO Arm:**
   The QueryIO arm was evaluated using a standalone CLI shim (`benchmark/tools/queryio-tool.cjs`) running against QueryIO's `Core` interface, outputting indented JSON (`JSON.stringify(result, null, 2)`). It did not exercise the MCP server transport, protocol-level negotiation, MCP tool descriptions, or privilege check warnings.

### 2.3 Experimental Controls
1. **Identical Agent Model:** Every run utilized `Gemini 3.8 Flash (High)` through the same autonomous agent harness.
2. **Database Reset Before Every Run:** The database was re-seeded from `fixture/seed.sql` before every single run via `bash fixture/reset.sh`. No state, temporary tables, or cached query plans persisted between runs.
3. **Isolated Workspaces:** Each run operated in a dedicated workspace directory populated from `fixture/app/` (`src/activation.ts`, `src/billing.ts`, `src/projects.ts`, `src/admin.ts`, `README.md`).
4. **Standardized Prompts:** Every arm received the exact same initial task prompt per task.

---

## 3. The Five Benchmark Tasks

1. **Task 1 (Forensic / Hero Task):** *"User 4821 says their account never activated. Find out why."*
   - *Ground Truth:* User 4821 (Dana Whitfield) verified their email but is stuck in `pending` because `activateUser` requires a membership in the user's current org (`users.org_id = 88`), and no `memberships (88, 4821)` row exists. Their only membership is in org 21, where they originally signed up. Support moved them with `transferUser` (`org.transferred` event, 21 → 88), and `transferUser` updates `users.org_id` without creating a corresponding record in `memberships`. `activateUser` returns `no_membership` silently on verify and on login.
2. **Task 2 (Forensic Task):** *"Organization 142 paid invoice 90017, but their workspace is still suspended for non-payment. Why?"*
   - *Ground Truth:* Organization 142 had duplicate invoices generated for the same billing cycle: invoice 90017 and invoice 90018 (both issued 2026-09-04, due 2026-09-11 for the same amount). Invoice 90017 was paid on 2026-09-29, but duplicate invoice 90018 remained open and >14 days overdue. `onInvoicePaid` in `src/billing.ts` checked `isDelinquent(orgId)`, which saw open invoice 90018 still past due and refused to unsuspend the organization.
3. **Task 3 (Forensic Task):** *"Project 7713 shows user 3310 as 'last edited by', but that user says they never touched it and can't even open the project. What happened?"*
   - *Ground Truth:* User 3310 (home org 10) was a contractor in org 113 (the project's org). They were offboarded ~21 days before seed via a `membership.removed` event. Offboarding deleted their membership in org 113, which cascaded (`ON DELETE CASCADE`) to delete their `project_assignments` row for project 7713, leaving them unable to open the project. Offboarding revoked their laptop API key (9000) but left their CI key (9001, org 113) active. An automated sync script running via key 9001 continues updating project 7713. `projects.ts` authenticates API keys by checking `key.org_id = project.org_id` without checking membership, stamping `updated_by_user_id = 3310`.
4. **Task 4 (Aggregate Task):** *"How many users verified their email but were never activated? Break them down by the reason `activateUser` refuses them."*
   - *Ground Truth:* Exactly 63 users verified their email but remained unactivated (`status = 'pending'`, `activated_at IS NULL`). Refusal breakdown: 51 `no_membership` (transferred without a membership row in the new org), 12 `org_inactive` (delinquent org suspension), 0 `not_eligible`.
5. **Task 5 (Aggregate Task):** *"How many organizations are suspended, broken down by plan? Which suspended organizations are not actually delinquent under the rules in `billing.ts`?"*
   - *Ground Truth:* Exactly 12 organizations are suspended: Free: 2 (148, 296), Starter: 2 (37, 185), Team: 6 (50, 74, 142, 150, 222, 250), Enterprise: 2 (111, 259). Under `billing.ts`'s 14-day grace rule (`due_at < now() - interval '14 days'`), exactly 3 are not delinquent: orgs 50, 150, and 250 (orgs 50 and 250 have invoices due in the future; org 150 is 10 days past due, within the 14-day grace period).

---

## 4. Complete Run-by-Run Results Table

Every run recorded the following metrics:
- **Interactions:** Number of database tool commands executed by the agent (`psql` or `node ... db-tool.cjs`).
- **Bytes:** Total UTF-8 bytes returned by the database tool entering the agent's context.
- **Failed:** Number of database commands that exited with a non-zero exit code.
- **Time:** Total wall-clock execution time (seconds).
- **Grade:** Correctness against ground truth (`correct` / `partial` / `wrong`), evaluated manually.

| Task | Category | Arm | Run | Grade | DB Interactions | DB Context Bytes | Failed Ops | Wall Time (s) |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | Forensic | **A** (psql) | 1 | `correct` | 11 | 14,547 B | 0 | 76s |
| **1** | Forensic | **A** (psql) | 2 | `correct` | 10 | 12,916 B | 0 | 64s |
| **1** | Forensic | **B** (QueryIO) | 1 | `correct` | **6** | **8,014 B** | 1 | 60s |
| **1** | Forensic | **B** (QueryIO) | 2 | `correct` | **11** | 12,987 B | 4 | 112s |
| **1** | Forensic | **C** (DBHub) | 1 | `correct` | 9 | 13,222 B | 1 | 80s |
| **2** | Forensic | **A** (psql) | 1 | `correct` | 19 | 24,846 B | 0 | 114s |
| **2** | Forensic | **A** (psql) | 2 | `correct` | 23 | 28,736 B | 0 | 128s |
| **2** | Forensic | **B** (QueryIO) | 1 | `correct` | 22 | 30,466 B | 3 | 121s |
| **2** | Forensic | **B** (QueryIO) | 2 | `correct` | **14** | 26,318 B | 2 | 86s |
| **2** | Forensic | **C** (DBHub) | 1 | `correct` | 25 | 37,743 B | 2 | 186s |
| **3** | Forensic | **A** (psql) | 1 | `correct` | 16 | 30,413 B | 0 | 93s |
| **3** | Forensic | **A** (psql) | 2 | `correct` | 16 | 26,010 B | 0 | 106s |
| **3** | Forensic | **B** (QueryIO) | 1 | `correct` | **12** | **15,091 B** | 2 | 91s |
| **3** | Forensic | **B** (QueryIO) | 2 | `correct` | **14** | **16,174 B** | 2 | 110s |
| **3** | Forensic | **C** (DBHub) | 1 | `correct` | 21 | 31,311 B | 3 | 169s |
| **4** | Aggregate | **A** (psql) | 1 | `correct` | 21 | 18,587 B | 0 | 114s |
| **4** | Aggregate | **A** (psql) | 2 | `correct` | 18 | 10,336 B | 0 | 96s |
| **4** | Aggregate | **B** (QueryIO) | 1 | `correct` | **20** | 15,913 B | 2 | 111s |
| **4** | Aggregate | **B** (QueryIO) | 2 | `correct` | **17** | 12,680 B | 4 | 107s |
| **4** | Aggregate | **C** (DBHub) | 1 | `correct` | 25 | 18,975 B | 2 | 174s |
| **5** | Aggregate | **A** (psql) | 1 | `correct` | 22 | 31,559 B | 0 | 121s |
| **5** | Aggregate | **A** (psql) | 2 | `correct` | 25 | 38,842 B | 0 | 141s |
| **5** | Aggregate | **B** (QueryIO) | 1 | `correct` | 37 | 64,294 B | 2 | 194s |
| **5** | Aggregate | **B** (QueryIO) | 2 | `correct` | 24 | 34,136 B | 1 | 173s |
| **5** | Aggregate | **C** (DBHub) | 1 | `correct` | 29 | 48,785 B | 2 | 207s |

---

## 5. Task-by-Task Analysis & Qualitative Findings

### 5.1 Forensic Tasks (Tasks 1–3)

#### Task 1: User 4821 Account Activation Failure
- **What happened in Arm A (`psql`):** The agent executed exploratory schema and data queries across 10–11 separate SQL commands (`SELECT * FROM users WHERE id = 4821`, checking `memberships`, `user_events`, and `email_verification_tokens`).
- **What happened in Arm B (QueryIO):**
  - In Run 1, a single call to `inspect_row` on `public.users` (`id = 4821`) returned the root user row along with its immediate relations: the active membership in org 21, the `user_events` recording the transfer from org 21 to org 88, and the verification tokens. The agent confirmed the findings with 4 targeted `query` calls, completing in 6 interactions and 8,014 bytes.
  - In Run 2, the agent first called `list_tables` to orient itself, then called `inspect_row` on `public.users` (`id = 4821`), followed by `query` calls. One of the `query` calls failed due to a SQL syntax error (PostgreSQL SQLSTATE 42601), which the agent quickly corrected.
  - Across both runs, neither agent called `describe_tables`.

#### Task 2: Org 142 Invoice & Suspension
- **What happened in Arm A (`psql`):** The agent required 19 to 23 queries across `organizations`, `invoices`, `subscriptions`, and `billing.ts` logic to uncover why payment of invoice 90017 did not clear delinquency.
- **What happened in Arm B (QueryIO):**
  - Both runs utilized `inspect_row` on invoice 90017 and organizations alongside `query` calls. In Run 2, inspecting invoice 90017 immediately revealed related invoices for organization 142, allowing the agent to identify duplicate invoice 90018 in 14 interactions (vs 23 in Arm A Run 2).
  - Neither run used `describe_tables`.

#### Task 3: Project 7713 Attribution & Orphaned Keys
- **What happened in Arm A (`psql`):** The agent queried project rows, user rows, memberships, project assignments, user events, and API keys individually (16 interactions in both runs).
- **What happened in Arm B (QueryIO):**
  - In Run 1, calling `inspect_row` on `public.projects` (`id = 7713`) and `public.users` (`id = 3310`) surfaced user 3310's deleted membership, cascade-deleted project assignment, and surviving active CI key (`ci-sync`, 9001), followed by `query` calls to trace `user_events`. Run 1 finished in 12 interactions and 15,091 bytes.
  - Run 2 followed a similar trajectory with 14 interactions and 16,174 bytes. Both runs achieved substantial byte reductions (-50.4% in Run 1 and -37.8% in Run 2 vs their respective Arm A runs; -44.6% mean reduction for Task 3).
  - Neither run used `describe_tables`.

---

### 5.2 Aggregate Tasks (Tasks 4–5)

#### Task 4: Verified but Unactivated Users
- **What happened in Arm A (`psql`):** The agent ran 18 to 21 SQL queries checking pending users, join conditions with memberships, and organization statuses.
- **What happened in Arm B (QueryIO):**
  - In both Run 1 and Run 2, the agent started with a single `list_tables` call and then exclusively executed `query` calls (17 queries in Run 1, 12 queries in Run 2).
  - **Neither run called `inspect_row` or `describe_tables`.** The agent formulated SQL aggregations directly via `query`.
  - While interactions remained competitive (20 and 17 vs 21 and 18), context bytes (15,913 B and 12,680 B) were comparable to Arm A (18,587 B and 10,336 B).

#### Task 5: Suspended Organizations by Plan & Grace Period Evaluation
- **What happened in Arm A (`psql`):** The agent executed 22 to 25 queries grouping suspended orgs by plan and evaluating open invoices against the 14-day grace window.
- **What happened in Arm B (QueryIO):**
  - In both Run 1 and Run 2, the agent started with a single `list_tables` call and then exclusively executed `query` calls (34 queries in Run 1, 22 queries in Run 2).
  - **Neither run called `inspect_row` or `describe_tables`.**
  - In Run 1, rather than composing a single SQL join or `NOT EXISTS` query, the agent iteratively issued individual queries for each suspended organization and its invoices. This iterative strategy resulted in 37 interactions and 64,294 bytes.
  - In Run 2, the agent wrote more consolidated SQL queries, completing in 24 interactions and 34,136 bytes.

---

### 5.3 Reference Arm C (DBHub) Observations
- DBHub achieved 100% correctness across all 5 runs.
- However, it required more interactions (mean 21.80) and returned more bytes (mean 30,007 B) than both Arm A and Arm B.
- DBHub incurred 10 failed operations (at least 1 failure in every single run) due to SQL syntax errors and tool parameter mismatches, reflecting the friction of generic tool wrappers without specialized database ergonomics.

---

## 6. Observations & Future Tuning Follow-Ups

The benchmark data and audit logs reveal several concrete engineering observations:

1. **CLI Shim Shell Quoting vs. Native MCP Execution:**
   - In Arm B, 23 commands resulted in non-zero exit codes. These failures were not database-level constraint or permission errors from QueryIO's core engine, but shell invocation friction: the agent passed SQL statements and parameters inside serialized JSON arguments on the command line (`node db-tool.cjs <tool> '<json>'`), leading to quote escaping issues and syntax errors in the shell.
   - *Follow-up:* Operating QueryIO natively as an MCP server over stdio (where tool parameters are passed as structured JSON-RPC objects) eliminates shell quoting and escaping friction entirely.
2. **Usage of Schema Exploration Tools (`describe_tables` vs `list_tables`):**
   - Across all 10 QueryIO runs, the agent never called `describe_tables`. Agents called `list_tables` once to verify table names, but relied on the local workspace `schema.sql` file for column definitions and types.
   - *Follow-up:* In workspaces containing DDL files, agents rarely invoke schema-description tools. Guidance or tool descriptions should clarify when `describe_tables` provides information not present in static DDL (such as column cardinality, planner statistics, and null fraction).
3. **Indented JSON Output Overhead on Multi-Row Queries:**
   - In aggregate tasks, QueryIO printed results as indented JSON arrays (`JSON.stringify(result, null, 2)`). For queries returning dozens of rows, the repeated keys and newline formatting contributed to a 27.9% higher mean context byte volume than `psql`'s compact tabular output.
   - *Follow-up:* Formatting multi-row `query` results as compact JSON (or providing a tabular text representation) would significantly reduce context consumption on aggregate queries.
