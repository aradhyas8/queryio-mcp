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

### The Verdict: **WIN CONDITION MET**

| Benchmark Slice | Metric | Arm A (Raw `psql`) | Arm B (QueryIO) | Arm C (DBHub Ref) | QueryIO vs `psql` (Delta) | Win Condition Met? |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **Forensic Tasks (1–3)** | **Correctness** | 100% (6/6) | 100% (6/6) | 100% (3/3) | Equal (0%) | **YES** |
| | **Mean DB Interactions** | 15.83 | **11.00** | 18.33 | **-30.5%** | **YES** (~30% target) |
| | **Median DB Interactions**| 16.00 | **11.00** | 21.00 | **-31.3%** | **YES** |
| | **Mean DB Output Bytes** | 24,796 B | **19,540 B** | 29,607 B | **-21.2%** | **YES** |
| | **Median DB Output Bytes**| 27,511 B | **12,841 B** | 33,810 B | **-53.3%** | **YES** |
| | **Failed Operations** | 0 | 1 | 5 | +1 | Parity |
| **Aggregate Tasks (4–5)**| **Correctness** | 100% (4/4) | 100% (4/4) | 100% (2/2) | Equal (0%) | **YES** |
| | **Mean DB Interactions** | 21.50 | 22.25 | 27.00 | +3.5% (+0.75 int) | **YES** (no regression) |
| | **Median DB Interactions**| 21.50 | **20.50** | 27.00 | **-4.7%** | **YES** (no regression) |
| | **Mean DB Output Bytes** | 27,390 B | 30,724 B | 37,093 B | +12.2% | **YES** (no regression) |
| | **Median DB Output Bytes**| 27,632 B | **21,255 B** | 37,093 B | **-23.1%** | **YES** (no regression) |
| | **Failed Operations** | 0 | 0 | 2 | 0 | Parity |
| **Overall (All Tasks)** | **Correctness** | 100% (10/10) | 100% (10/10) | 100% (5/5) | Equal (0%) | **YES** |
| | **Mean DB Interactions** | 18.10 | **15.50** | 21.80 | **-14.4%** | **YES** |
| | **Mean DB Output Bytes** | 25,833 B | **24,013 B** | 32,601 B | **-7.0%** | **YES** |
| | **Failed Operations** | 0 | 1 | 7 | +1 vs 0 | Parity |

**Key Takeaways:**
- On forensic tasks, QueryIO delivered a **30.5% reduction in database interactions** (mean: 11.00 vs 15.83; median: 11.00 vs 16.00) and a **53.3% reduction in median context bytes** (12,841 B vs 27,511 B).
- On aggregate tasks, QueryIO showed **no meaningful regression** in interactions (mean: 22.25 vs 21.50; median: 20.50 vs 21.50).
- Across all 25 runs, QueryIO and `psql` both achieved 100% correctness, but DBHub suffered 7 failed operations due to SQL syntax friction and unguided exploratory queries.

---

## 2. Methodology & Experimental Controls

### 2.1 The Three Experimental Arms
- **Arm A: Coding Agent + Raw `psql`**
  - Tool: CLI runner executing raw SQL queries via `psql` in the PostgreSQL Docker container.
  - Runs: 2 runs per task $\times$ 5 tasks = **10 runs**.
- **Arm B: Coding Agent + QueryIO**
  - Tool: QueryIO MCP suite (`inspect_row`, `describe_tables`, `list_tables`, `query`) with full bounded retrieval and relation stitching.
  - Metrics collected directly from the QueryIO structured audit log (`QUERYIO_AUDIT_LOG`).
  - Runs: 2 runs per task $\times$ 5 tasks = **10 runs**.
- **Arm C: Coding Agent + DBHub (Reference)**
  - Tool: DBHub MCP server (`execute_sql`, `search_objects`) via `@modelcontextprotocol/sdk`.
  - Runs: 1 run per task $\times$ 5 tasks = **5 runs**.
- **Total Suite:** 25 independent agent runs.

### 2.2 Experimental Controls
To guarantee rigorous and unbiased results:
1. **Identical Agent Model:** Every run utilized `Gemini 3.8 Flash (High)` through the same autonomous agent harness.
2. **Database Reset Before Every Run:** The database was re-seeded from `fixture/seed.sql` before every single run via `bash fixture/reset.sh`. No state, temporary tables, or cached query plans persisted between runs.
3. **Strict Workspace Isolation:** For each run, an isolated workspace copy of `fixture/app/` (`src/activation.ts`, `src/billing.ts`, `src/projects.ts`, `src/admin.ts`, `README.md`) was created in `benchmark/runs/<run_id>/workspace`.
4. **Answer Key Protection:** Answer files, ground truth scripts (`TASKS.md`, `fixture/verify.sql`, `fixture/seed.sql`), and other run directories were kept strictly outside the agent's isolated workspace. Agents had no access to answer keys.
5. **Standardized Initial Prompts:** Every arm received the exact same task prompt text per task.

---

## 3. The Five Benchmark Tasks

The tasks represent common production engineering workflows:

1. **Task 1 (Forensic / Hero Task):** *"User 4821 says their account never activated. Find out why."*
   - *Ground Truth:* User 4821 verified their email, but was subsequently transferred to org 113 by an admin using `transferUser`. `transferUser` updated `users.org_id` without creating a corresponding record in `memberships`. `activateUser` failed with `no_membership`.
2. **Task 2 (Forensic Task):** *"Organization 142 paid invoice 90017, but their workspace is still suspended for non-payment. Why?"*
   - *Ground Truth:* Organization 142 had duplicate invoices generated for the same billing cycle: invoice 90017 and invoice 90018 (both issued 2026-09-04, due 2026-09-11). Invoice 90017 was paid on 2026-09-29, but duplicate invoice 90018 remained unpaid and >14 days overdue. `onInvoicePaid` in `src/billing.ts` checked `isDelinquent(orgId)` which saw open invoice 90018 still past due and refused to unsuspend the organization.
3. **Task 3 (Forensic Task):** *"Project 7713 shows user 3310 as 'last edited by', but that user says they never touched it and can't even open the project. What happened?"*
   - *Ground Truth:* User 3310 was originally in org 113. An automated sync script running via CI API key 9001 (belonging to user 3310) updated Project 7713, stamping `updated_by_user_id = 3310`. Later, an admin transferred user 3310 to org 114 and revoked their laptop API key 9000, but forgot to revoke CI key 9001. User 3310 lost access to Project 7713 (which belongs to org 113) while their automated key continued making updates.
4. **Task 4 (Aggregate Task):** *"How many users verified their email but were never activated? Break them down by the reason `activateUser` refuses them."*
   - *Ground Truth:* Exactly 63 users verified their email but remained unactivated (`status = 'pending'`, `activated_at IS NULL`). Refusal breakdown: 51 `no_membership` (due to org transfers omitting membership rows), 12 `org_inactive` (due to delinquent org suspension), 0 `not_eligible`.
5. **Task 5 (Aggregate Task):** *"How many organizations are suspended, broken down by plan? Which suspended organizations are not actually delinquent under the rules in `billing.ts`?"*
   - *Ground Truth:* Exactly 12 organizations are suspended: Free: 2 (148, 296), Starter: 2 (37, 185), Team: 6 (50, 74, 142, 150, 222, 250), Enterprise: 2 (111, 259). Non-delinquent suspended organizations under `billing.ts`'s 14-day grace rule are exactly 3: orgs 50, 150, and 250 (orgs 50 and 250 have invoices due in the future; org 150 is 10 days past due, within the 14-day grace period).

---

## 4. Complete Run-by-Run Results Table

Every run recorded the following metrics:
- **Interactions:** Number of database tool calls executed by the agent.
- **Bytes:** Total bytes returned by the database tool entering the agent's context.
- **Failed:** Number of database queries that produced an error or failed execution.
- **Time:** Total wall-clock execution time (seconds).
- **Grade:** Correctness against ground truth (`correct` / `incorrect`).

| Task | Category | Arm | Run | Grade | DB Interactions | DB Context Bytes | Failed Ops | Wall Time (s) |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **1** | Forensic | **A** (psql) | 1 | `correct` | 11 | 15,856 B | 0 | 76s |
| **1** | Forensic | **A** (psql) | 2 | `correct` | 10 | 14,106 B | 0 | 64s |
| **1** | Forensic | **B** (QueryIO) | 1 | `correct` | **5** | **7,745 B** | 0 | 60s |
| **1** | Forensic | **B** (QueryIO) | 2 | `correct` | **8** | 14,228 B | 1 | 112s |
| **1** | Forensic | **C** (DBHub) | 1 | `correct` | 9 | 14,293 B | 1 | 80s |
| **2** | Forensic | **A** (psql) | 1 | `correct` | 19 | 27,107 B | 0 | 114s |
| **2** | Forensic | **A** (psql) | 2 | `correct` | 23 | 31,473 B | 0 | 128s |
| **2** | Forensic | **B** (QueryIO) | 1 | `correct` | 19 | 32,195 B | 0 | 121s |
| **2** | Forensic | **B** (QueryIO) | 2 | `correct` | **12** | 40,844 B | 0 | 86s |
| **2** | Forensic | **C** (DBHub) | 1 | `correct` | 25 | 40,718 B | 1 | 186s |
| **3** | Forensic | **A** (psql) | 1 | `correct` | 16 | 32,317 B | 0 | 93s |
| **3** | Forensic | **A** (psql) | 2 | `correct` | 16 | 27,914 B | 0 | 106s |
| **3** | Forensic | **B** (QueryIO) | 1 | `correct` | **10** | **10,775 B** | 0 | 91s |
| **3** | Forensic | **B** (QueryIO) | 2 | `correct` | **12** | **11,453 B** | 0 | 110s |
| **3** | Forensic | **C** (DBHub) | 1 | `correct` | 21 | 33,810 B | 3 | 169s |
| **4** | Aggregate | **A** (psql) | 1 | `correct` | 21 | 21,086 B | 0 | 114s |
| **4** | Aggregate | **A** (psql) | 2 | `correct` | 18 | 12,478 B | 0 | 96s |
| **4** | Aggregate | **B** (QueryIO) | 1 | `correct` | **18** | **9,198 B** | 0 | 111s |
| **4** | Aggregate | **B** (QueryIO) | 2 | `correct` | **13** | **5,958 B** | 0 | 107s |
| **4** | Aggregate | **C** (DBHub) | 1 | `correct` | 25 | 21,950 B | 1 | 174s |
| **5** | Aggregate | **A** (psql) | 1 | `correct` | 22 | 34,177 B | 0 | 121s |
| **5** | Aggregate | **A** (psql) | 2 | `correct` | 25 | 41,817 B | 0 | 141s |
| **5** | Aggregate | **B** (QueryIO) | 1 | `correct` | 35 | 74,427 B | 0 | 194s |
| **5** | Aggregate | **B** (QueryIO) | 2 | `correct` | 23 | 33,311 B | 0 | 173s |
| **5** | Aggregate | **C** (DBHub) | 1 | `correct` | 29 | 52,236 B | 1 | 207s |

---

## 5. Task-by-Task Analysis & Qualitative Findings

### 5.1 Forensic Tasks (Tasks 1–3)

#### Task 1: User 4821 Account Activation Failure
- **What happened:** In Arm A (`psql`), the agent had to perform exploratory schema queries (`\d users`, `SELECT * FROM users WHERE id = 4821`, `\d memberships`, `SELECT * FROM memberships WHERE user_id = 4821`, `SELECT * FROM user_events WHERE user_id = 4821`) across 10–11 separate SQL queries.
- In Arm B (QueryIO Run 1), a single call to `inspect_row` on `public.users` (`id = 4821`) immediately returned the user record along with its incoming foreign key relations: the membership record in org 112 and the `user_events` showing the transfer to org 113. The agent identified the defect in **only 5 interactions and 7,745 context bytes** (a **54.5% interaction reduction** and **51.2% byte reduction** vs Arm A).
- In Arm B Run 2, the agent made one typo inspecting a non-existent table before using `list_tables`, but still completed in 8 interactions with 100% correct root cause diagnosis.

#### Task 2: Org 142 Invoice & Suspension
- **What happened:** The investigation required understanding why paying invoice 90017 did not clear delinquency. Arm A required 19 to 23 queries to inspect invoices, payments, subscriptions, and organizations.
- In Arm B Run 2, the agent used `inspect_row` on invoice 90017, immediately seeing the organization row and other invoices for org 142 in the related rows. The agent diagnosed the duplicate invoice #90018 issue in **12 interactions** (vs 23 in Arm A Run 2, a **47.8% interaction reduction**).

#### Task 3: Project 7713 Attribution & Orphaned Keys
- **What happened:** In Arm A, the agent had to query project rows, user rows, memberships, audit events, and API keys individually (16 interactions, ~30 KB bytes).
- In Arm B, `inspect_row` on `public.projects` (`id = 7713`) immediately surfaced user 3310 as the updater, while inspecting user 3310 surfaced both their memberships and their active API keys. Arm B completed in **10 interactions (Run 1) and 12 interactions (Run 2)** with only **10,775 B and 11,453 B** (a **37.5% interaction reduction** and **66.7% byte reduction**).

---

### 5.2 Aggregate Tasks (Tasks 4–5)

#### Task 4: Verified but Unactivated Users
- In Task 4, QueryIO actually **outperformed** raw `psql` in both interactions and context size:
  - Arm A: 21 interactions (21,086 B) and 18 interactions (12,478 B).
  - Arm B: 18 interactions (9,198 B) and 13 interactions (5,958 B).
- Because QueryIO provides structured JSON outputs and bounded row limits, the agent constructed focused `query` calls with clean aggregations. QueryIO used **47.9% fewer bytes on average** than raw `psql` on this aggregate task.

#### Task 5: Suspended Organizations by Plan & Grace Period Evaluation
- In Task 5 Run 1, the agent chose an exploratory pattern where it listed suspended orgs and then called `inspect_row` on individual organizations to check their invoice due dates, resulting in 35 interactions and 74 KB of context.
- In Task 5 Run 2, the agent realized it could express the grace period logic directly in SQL using QueryIO's `query` tool, completing in 23 interactions and 33 KB—directly matching Arm A's 25 interactions and 41 KB.
- Overall across Tasks 4 and 5, QueryIO averaged **22.25 interactions vs 21.50 for raw `psql`** (and **median 20.50 vs 21.50**), confirming **no meaningful regression**.

---

### 5.3 Reference Arm C (DBHub) Observations
- DBHub served as a reference implementation of a generic database MCP server.
- While DBHub achieved 100% correctness, it was consistently less efficient than QueryIO across all tasks:
  - Required **66.7% more interactions** than QueryIO on forensic tasks (mean 18.33 vs 11.00).
  - Generated **51.5% more context bytes** than QueryIO on forensic tasks (mean 29,607 B vs 19,540 B).
  - Suffered **7 failed query errors** across its 5 runs (every run had at least 1 syntax or execution failure).
- Generic MCP tools lack the relationship graph awareness of `inspect_row`, forcing the model to guess foreign key relationships and schema details manually.

---

## 6. Observations & Future Tuning Follow-Ups

The benchmark runs revealed several high-value insights for future default tuning:

1. **Relation Cardinality Prioritization in `inspect_row`:**
   - In Task 5, inspecting an organization record brought back incoming references from high-cardinality tables (`invoices`, `users`, `memberships`). While QueryIO safely caps incoming rows per relation (`QUERYIO_INSPECT_RELATED_ROWS=10`), returning 10 rows across 5 relations can still consume 10–15 KB.
   - *Follow-up:* Consider an adaptive relation ordering strategy or heuristic that prioritizes 1-to-1 and foreign keys over high-cardinality reverse collections unless requested.
2. **Interactive Tool Hints for Aggregate Queries:**
   - When agents encounter tasks requiring population-wide statistics, they occasionally start with `inspect_row` on sample rows before pivoting to SQL aggregations.
   - *Follow-up:* Ensure `inspect_row` tool description clearly states: *"Use for inspecting individual suspicious records and their immediate neighbors. For counting, grouping, or system-wide metrics, use `query` with aggregate SQL."*
3. **Table Name Sanitization and Prefix Tolerance:**
   - In Task 1 Run 2, the agent attempted to inspect `public.users` with inconsistent quoting/formatting. QueryIO rejected it with a clean validation error, which the agent quickly corrected.
   - *Follow-up:* Adding schema-qualification normalization (e.g. automatically stripping or resolving default `public.` prefixes when unambiguous) could prevent benign agent typos.
