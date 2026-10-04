# QueryIO

> **Bounded, read-oriented PostgreSQL investigation interface for coding agents (MCP stdio server)**

QueryIO gives your coding agent (Claude Code, Codex, Cursor, etc.) a safe, structured, token-efficient window into runtime PostgreSQL truth.

The repository supplies application semantics; QueryIO supplies bounded runtime database truth.

---

## The Problem

When debugging application issues (for example: *"User 4821 says their account never activated. Find out why."*), coding agents need to know what is actually in the database.

Today developers have two bad options:
1. **Unrestricted shell / `psql` database access**: Dangerous and unstructured. The agent can mutate production state or trigger accidental locks, dumps massive schemas into context, guesses table names, writes broken joins, runs `SELECT *` on wide tables, and floods turn context with megabytes of data.
2. **Generic Postgres MCP servers**: Most simply expose raw SQL over MCP. Investigating one suspicious record still requires chains of exploratory queries, manually hunting foreign keys and joining tables one at a time. Safety defaults vary, timeouts are often client-side, and none combine safe-by-default bounds, automatic value truncation, Postgres-side timeouts, accidental-secret redaction, durable metadata audit logging, and record-neighborhood inspection.

QueryIO solves this: **investigate database state autonomously without giving the agent unrestricted database access or forcing it to waste turns and context figuring out the database.**

---

## First Run (Under 2 Minutes)

Follow these four steps to go from nothing to a working investigation:

### 1. Set `QUERYIO_DATABASE_URL`

Provide your PostgreSQL connection string via the `QUERYIO_DATABASE_URL` environment variable:

```bash
export QUERYIO_DATABASE_URL="postgres://user:password@localhost:5432/my_database"
```

*(On Windows PowerShell: `$env:QUERYIO_DATABASE_URL = "postgres://user:password@localhost:5432/my_database"`)*

> [!NOTE]
> QueryIO accepts database credentials **only** through `QUERYIO_DATABASE_URL`. It explicitly refuses connection strings passed as command-line arguments (preventing credential exposure in process listings like `ps aux`) and deliberately never scans `.env` files or repository directories.

### 2. Verify with `queryio check`

Before wiring QueryIO into your agent, run the built-in preflight diagnostic:

```bash
npx -y queryio check
```

*(If testing locally before publishing: `npm pack && npx -y --package ./queryio-*.tgz queryio check`)*

`queryio check` verifies:
- Network connectivity and PostgreSQL server version
- Connected database and connected role
- Superuser status and table write privileges
- Membership in dangerous predefined roles (`pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files`, `pg_write_all_data`, `pg_signal_backend`)
- Planner statistics availability (`pg_stats`)
- Active configuration limits, redaction rules, and audit log path
- Privilege warnings, plus a ready-to-edit SQL template for creating a dedicated read-only role

### 3. Add QueryIO to Your MCP Client

#### Claude Code

Add QueryIO using the Claude Code CLI:
```bash
# Project scope (.mcp.json at repo root)
claude mcp add queryio -e QUERYIO_DATABASE_URL="postgres://user:password@localhost:5432/my_database" -- npx -y queryio

# User scope (~/.claude.json)
claude mcp add -s user queryio -e QUERYIO_DATABASE_URL="postgres://user:password@localhost:5432/my_database" -- npx -y queryio
```

Or configure it in your project's `.mcp.json` at the repository root, or user `~/.claude.json`:
```json
{
  "mcpServers": {
    "queryio": {
      "command": "npx",
      "args": ["-y", "queryio"],
      "env": {
        "QUERYIO_DATABASE_URL": "postgres://user:password@localhost:5432/my_database"
      }
    }
  }
}
```

#### Codex (OpenAI Codex / Codex CLI)

Add QueryIO to your Codex configuration file (e.g. `~/.codex/config.toml` or project config):
```toml
[mcp_servers.queryio]
command = "npx"
args = ["-y", "queryio"]
[mcp_servers.queryio.env]
QUERYIO_DATABASE_URL = "postgres://user:password@localhost:5432/my_database"
```

Or via Codex CLI:
```bash
codex mcp add queryio --env QUERYIO_DATABASE_URL="postgres://user:password@localhost:5432/my_database" -- npx -y queryio
```

### 4. Ask the Agent a Debugging Question

Open your agent session and ask a forensic question about your data:
> *"User 4821 says their account never activated. Find out why."*

In typical investigation workflows, the agent will:
- Read relevant application code in your repository to understand expected business logic and domain entities.
- Inspect runtime database state—for instance, calling `inspect_row` on `public.users` with `{"id": 4821}` to retrieve the user record and its foreign-key neighborhood (memberships, events, tokens) in a single call.
- Run targeted queries with `query` or check schema definitions with `list_tables` / `describe_tables` as needed.
- Diagnose the mismatch between application logic and database state without exploratory multi-table joins or polluting turn context.

---

## Tool Reference

QueryIO exposes four bounded, read-oriented MCP tools:

### 1. `inspect_row` (The Differentiator)

Given one concrete row by primary key, returns that row plus its declared depth-1 foreign-key neighborhood (rows it references and rows referencing it), bounded, truncated, and redacted in a single call.

- **Inputs**:
  - `table` (string, required): Schema-qualified table name (e.g. `"public.users"`).
  - `key` (object, required): Object mapping every primary key column to its value (e.g. `{"id": 4821}`). Integers beyond $2^{53}$ must be passed as strings.
- **Outputs**:
  - `table`: Schema-qualified table name.
  - `columns`: Array of root table column names.
  - `row`: Root table row values as an array.
  - `relations`: Array of depth-1 foreign-key relations (outgoing and incoming):
    - `direction`: `"outgoing"` (rows referenced by the root) or `"incoming"` (rows referencing the root).
    - `table`: Schema-qualified related table name.
    - `constraint`: PostgreSQL foreign-key constraint name.
    - `source_columns`: Referencing columns, paired by position with `target_columns`.
    - `target_columns`: Referenced columns, paired by position with `source_columns`.
    - `status`: `"ok"`, `"timeout"`, or `"error"`.
    - `order_by`: Columns used for deterministic ordering (related table PK, or `ctid` if none; explicitly deterministic, never recency).
    - `columns`: Column names of the related table.
    - `rows`: Array of row arrays (up to `QUERYIO_INSPECT_RELATED_ROWS`, default 5).
    - `rows_returned`: Count of rows returned.
    - `has_more`: Boolean indicating whether more rows existed beyond those returned. (Exact count is omitted by design).
  - `relations_not_attempted`: Array of relations skipped, each with a `reason`:
    - `"max_relations"`: Skipped because the relationship cap (`QUERYIO_INSPECT_MAX_RELATIONS`, default 25) was reached.
    - `"deadline"`: Skipped because the total server-side call deadline (`QUERYIO_INSPECT_DEADLINE_MS`, default 5000 ms) was reached.
  - `values_truncated`: Total number of individual cell values truncated.
  - `values_redacted`: Total number of individual cell values redacted.
  - `duration_ms`: Duration of the call in milliseconds.
  - `warnings`: Privilege warnings if connected as a privileged role.
- **Resilience & Guarantees**:
  - **Savepoint isolation**: Each relation executes inside its own savepoint. If one relation times out or fails, its `status` is set to `"timeout"` or `"error"`, and the remaining relations continue unaffected.
  - **Server-side total deadline**: The entire call is governed by a strict deadline. Each statement is issued with `statement_timeout = min(statement_timeout, remaining_deadline)`. If the deadline expires before fetching the root row, a structured timeout error is returned. If it expires while fetching relations, remaining relations are recorded in `relations_not_attempted` with `reason: "deadline"`.
  - **Strict PK contract**: Requires a declared primary key on the table. Composite keys require all columns. Missing rows return a structured not-found response with expected PK columns.

### 2. `describe_tables`

Batched schema and statistics inspection for one or more tables in a single turn.

- **Inputs**:
  - `tables` (array of strings, required): Schema-qualified table names (e.g. `["public.users", "public.orders"]`).
- **Outputs**:
  - `tables`: Array of table descriptions in requested order:
    - `columns`: Column name, data type, nullability, and planner statistics.
    - `primary_key`: Array of primary key column names, or `null`.
    - `foreign_keys_out`: Foreign keys originating from this table.
    - `foreign_keys_in`: Foreign keys referencing this table from other tables (and self-references).
    - `indexes`: Table indexes (name, columns/expressions, unique, primary, predicate).
- **Planner Statistics (Zero Table Scans)**:
  - Statistics are sourced strictly from `pg_stats`: `null_frac`, `n_distinct` (negative represents minus the distinct fraction of rows; `-1` means unique), and `common_values` (with frequencies, only for low-cardinality enum-like columns).
  - Absent statistics are reported as `stats_available: false` (never inferred as zeros).
  - Columns matching redaction rules have their statistics suppressed (`stats_available: false, redacted: true`).
- **Batch Fault Tolerance**: Unknown table names return a per-table error object (`{ name, error }`) without failing the rest of the batch.

### 3. `list_tables`

Compact catalog listing of tables outside system schemas (`pg_*`, `information_schema`).

- **Inputs**:
  - `filter` (string, optional): Case-insensitive substring matched against table names and column names.
- **Outputs**:
  - `tables`: Array of `{ name, estimated_rows, columns }`.
    - `name`: Schema-qualified name (e.g. `public.users`).
    - `estimated_rows`: Catalog planner estimate (`pg_class.reltuples`), or `null` if unanalyzed. Never scans tables.
    - `columns`: Total column count.

### 4. `query`

Bounded read-only SQL execution for aggregates, group-bys, and targeted forensic follow-ups.

- **Inputs**:
  - `sql` (string, required): A single read-only SQL statement (`SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`).
- **Outputs**:
  - `columns`: Array of column names.
  - `rows`: Array of row value arrays (token-efficient compact format).
  - `row_count`: Number of rows returned in this response.
  - `has_more`: Boolean. `true` if at least one more row exists beyond those returned; exact omitted count is deliberately not calculated.
  - `truncated_by`: `"rows"` if stopped by the row cap, `"bytes"` if stopped by the byte budget, or `null` if all matching rows were returned.
  - `values_truncated`: Count of cell values that exceeded `max_value_length` (cut with `…[+size]` marker, e.g. `…[+3.2KB]`).
  - `columns_redacted`: Count of returned columns matching redaction patterns (replaced with `"[redacted]"`).
  - `values_redacted`: Total count of cell values redacted.
  - `duration_ms`: Execution time in milliseconds.
  - `warnings`: Privilege warnings if applicable.
- **Structured Errors**: See [Structured Error Contract](#structured-error-contract) below.

### Structured Error Contract

When any tool execution fails, QueryIO returns a tool result with the MCP error flag set (`isError: true`) and a structured payload shape `{ error: { category, code, message, hint }, warnings? }`:

```json
{
  "error": {
    "category": "timeout",
    "code": "57014",
    "message": "canceling statement due to statement timeout"
  }
}
```

*(Note: `code` and `hint` are included when provided by PostgreSQL; `warnings` is attached only if warnings were detected.)*

Errors are mapped into deterministic, machine-readable categories:
- **Specific condition categories**:
  - `timeout`: Server-side statement timeout (`57014`) or total deadline reached.
  - `lock_timeout`: Lock acquisition timeout waiting behind conflicting table locks (`55P03`).
  - `read_only`: Write attempt in a read-only transaction (`25006`).
- **PostgreSQL error classes**:
  - When no specific condition applies, errors are named by their SQLSTATE class name (e.g. `syntax_error_or_access_rule_violation`, `integrity_constraint_violation`, `connection_exception`, `data_exception`, `insufficient_resources`), falling back to `postgres_error` for unrecognized SQLSTATE codes.
- **Client errors**:
  - `client_error`: Network failures, connection refused, or client-side errors lacking a SQLSTATE.
- **QueryIO validation and boundary errors**:
  - `read_oriented`: Non-read statements rejected by QueryIO's product-boundary gate (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `EXPLAIN`).
  - `not_found`: Table name cannot be resolved in the PostgreSQL catalog.
  - `no_primary_key`: `inspect_row` invoked on a table lacking a declared primary key.
  - `key_mismatch`: `inspect_row` key argument missing primary key columns or supplying extraneous columns.
  - `row_not_found`: `inspect_row` found no matching row for the specified primary key.

---

## Configuration & Defaults

QueryIO is configured exclusively via environment variables; there are no configuration files to manage. Command-line flags and parameters are deliberately rejected (with exit code 2) beyond the `check` diagnostic subcommand, ensuring database credentials and settings never appear in system process listings (`ps aux`).

| Environment Variable | Default | Description |
|---|---|---|
| `QUERYIO_DATABASE_URL` | *Required* | PostgreSQL connection string (`postgres://user:pass@host:port/db`). CLI args and `.env` scanning are forbidden. |
| `QUERYIO_STATEMENT_TIMEOUT_MS` | `5000` (5s) | Server-side `statement_timeout` set per transaction in PostgreSQL. |
| `QUERYIO_LOCK_TIMEOUT_MS` | `1000` (1s) | Server-side `lock_timeout` set per transaction in PostgreSQL (prevents waiting behind exclusive locks). |
| `QUERYIO_MAX_ROWS` | `100` | Maximum rows returned by `query`. |
| `QUERYIO_MAX_RESPONSE_BYTES` | `32768` (32 KB) | Maximum serialized response size before retrieval stops (`truncated_by: "bytes"`). Bounds `query` only. |
| `QUERYIO_MAX_VALUE_LENGTH` | `200` | Character limit for individual column string values before truncation with `…[+size]`. |
| `QUERYIO_INSPECT_RELATED_ROWS` | `5` | Maximum rows returned per relation in `inspect_row`. |
| `QUERYIO_INSPECT_MAX_RELATIONS` | `25` | Maximum number of relations inspected before capping with reason `max_relations`. |
| `QUERYIO_INSPECT_DEADLINE_MS` | `5000` (5s) | Total server-side deadline for an entire `inspect_row` call. |
| `QUERYIO_AUDIT_LOG` | `~/.queryio/audit.jsonl` | Path to append-only JSONL audit log. Set to `off` to disable. |
| `QUERYIO_AUDIT_INCLUDE_SQL` | `false` | When `"true"`, includes raw SQL query text in audit logs. Keep `false` to avoid logging sensitive literals. |
| `QUERYIO_REDACT_ADD` | *(empty)* | Comma-separated column names to add to redaction patterns. |
| `QUERYIO_REDACT_REMOVE` | *(empty)* | Comma-separated column names to remove from redaction patterns. |

### Redaction Rules

Default column name patterns matched case-insensitively:
`password`, `password_hash`, `secret`, `token`, `access_token`, `refresh_token`, `api_key`, `private_key`, `credential`.

Matching columns in `inspect_row` and `query` are replaced with `"[redacted]"`. Statistics for matching columns in `describe_tables` are suppressed.

---

## Audit Logging

Every MCP tool invocation appends exactly one JSON line to the audit log (`~/.queryio/audit.jsonl`).

### Privacy Contract

The audit log records **only operational metadata**:
- Timestamp, tool name, duration, and success/error status
- Tables involved (catalog-resolved schema and table names)
- Rows returned, bytes returned, and values truncated count
- For `query`: SQL query fingerprint (SHA-256 hash), `has_more`, and `truncated_by` (`"rows"`, `"bytes"`, or `null`)
- For `inspect_row`: relation counts by status (`ok`, `timeout`, `error`) and relations not attempted counts by reason (`max_relations`, `deadline`)
- **Never logged by default**: Result row values, primary key values, or raw SQL literals.
- Raw SQL appears only if explicitly enabled with `QUERYIO_AUDIT_INCLUDE_SQL=true`.

### Analyzing with `jq`

No custom log viewer is needed. Use standard `jq` commands:

```bash
# Count tool calls by tool
jq -s 'group_by(.tool) | map({tool: .[0].tool, calls: length})' ~/.queryio/audit.jsonl

# Sum total bytes returned to agent context
jq -s 'map(.bytes_returned) | add' ~/.queryio/audit.jsonl

# View failed queries and error categories
jq 'select(.success == false) | {timestamp, tool, error_category, error_code}' ~/.queryio/audit.jsonl
```

---

## Security Posture (Stated Honestly)

QueryIO provides defense-in-depth for database investigations, but security boundaries must be understood accurately.

### What QueryIO Enforces

1. **Single-Statement Extended Query Protocol**: All SQL executes via PostgreSQL's extended query protocol (`pg-cursor` / Parse protocol). Multi-statement injection attempts (such as `SELECT 1; COMMIT; DROP TABLE ...`) are rejected at statement parse time.
2. **`READ ONLY` Transaction Rollbacks**: Every operation runs within `BEGIN READ ONLY` and is unconditionally terminated with `ROLLBACK` on both success and error. Mutating queries (`INSERT`, `UPDATE`, `DELETE`, DDL) cannot commit.
3. **Server-Side Timeouts & Deadlines**: `statement_timeout` and `lock_timeout` are applied within PostgreSQL per transaction. Long-running queries or queries blocked by locks are terminated by the PostgreSQL server, not merely abandoned on the client side.
4. **Bounded Memory & Streaming**: Results stream via cursor and stop immediately once `max_rows + 1` rows or the response byte limit is reached. QueryIO never materializes unbounded result sets into Node memory.
5. **Injection Immunity for Tool Helpers**: Table names are resolved through PostgreSQL catalog OIDs; generated SQL uses catalog-quoted identifiers; all primary-key lookups use parameterized bind parameters.
6. **No Silent Credential Ingestion**: Refuses command-line DSNs to prevent process table exposure; never scans `.env` files or workspace folders.

### What Is Best-Effort

- **Name-Based Redaction**: Column redaction matches column names against known patterns. It is reliably applied to QueryIO-constructed queries (`inspect_row` and `describe_tables`). In `query`, however, an agent executing arbitrary SQL can alias column names (e.g. `SELECT password AS harmless_col FROM users`) or evaluate expressions, bypassing name matching. Column-level security belongs in PostgreSQL permissions.

### What Is Not Guaranteed

- **QueryIO is the safe default path, not a sandbox**: An agent that already has shell access and can read `DATABASE_URL` from `.env` or run `psql` directly can bypass QueryIO. QueryIO is the safe default path, not a sandbox or execution jail.
- **Safety with Privileged Roles**: If connected with a superuser role, QueryIO cannot guarantee containment.
- **Shared-Role Backend Termination**: A role shared with the application can terminate the application's backends via `pg_terminate_backend()` or `pg_cancel_backend()`.
- **Extension & Foreign Connection Escapes**: `dblink` or foreign data wrapper (FDW) connections escape the read-only transaction and rollback guarantees.

### The Superuser Warning & Dedicated Read-Only Role

> [!WARNING]
> **Connecting as a PostgreSQL superuser destroys the meaningful security boundary.**
> Superusers bypass PostgreSQL permission checks and have access to server-side capabilities such as program execution (`COPY ... FROM PROGRAM`) and filesystem access.

QueryIO allows connecting as a superuser with a clear warning so local development is not blocked, but for staging and production, you should **always** create a dedicated read-only role.

Run `npx -y queryio check` to get a customized SQL script for your database, or run:

```sql
-- Create dedicated read-only role for QueryIO:
CREATE ROLE queryio_role WITH LOGIN PASSWORD 'CHANGE_ME_PASSWORD';
-- ALTER ROLE queryio_role SET default_transaction_read_only = on additionally hardens the role.
GRANT CONNECT ON DATABASE "your_database" TO queryio_role;
-- Covers the public schema only and must be repeated per schema:
GRANT USAGE ON SCHEMA public TO queryio_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO queryio_role;
-- ALTER DEFAULT PRIVILEGES applies only to tables later created by the role that runs it;
-- tables created by another owner (e.g. a migration user) need ALTER DEFAULT PRIVILEGES FOR ROLE <owner> ...
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO queryio_role;
```

### The Read-Oriented Gate Is a Mistake Catcher, Not Security

QueryIO checks leading keywords in `query` (`SELECT`, `WITH`, `VALUES`, `TABLE`, `SHOW`) and rejects `EXPLAIN`, `COPY`, DDL, and DML with an explanatory message.

This gate is a **product-boundary guard and mistake catcher**, designed to guide agents away from unhelpful retries. It is **not** a security boundary: writable CTEs (e.g. `WITH updated AS (...)`) or side-effecting functions can syntactically begin with `WITH` or `SELECT`. The actual write prevention is enforced by the PostgreSQL transaction state (`READ ONLY`), unconditional `ROLLBACK`, and database role privileges.

---

## Resource-Bound Tradeoffs

- **Bounded retrieval limits QueryIO's memory, not Postgres's work**: QueryIO stops reading from the cursor after `max_rows + 1` rows or reaching the byte budget. However, if a query specifies `ORDER BY` across millions of unindexed rows, PostgreSQL must sort the entire table before producing the first row. That server work is bounded by `statement_timeout`, not by QueryIO's row cap.
- **Single wide rows are fetched whole**: Value truncation occurs after receiving a row. A row containing a multi-megabyte `text` or `jsonb` column is received before being truncated to `QUERYIO_MAX_VALUE_LENGTH`. Memory consumption is bounded by `max_rows + 1` rows of actual width.
- **`has_more` replaces exact omitted counts**: QueryIO reports `has_more: true` when additional rows exist, but does not provide an exact omitted count. Calculating an exact count would require running an expensive `COUNT(*)` query, which would defeat the efficiency of bounded retrieval. Agents should execute an explicit `SELECT COUNT(*)` if total counts are needed.

---

## Evaluation & Benchmarks

QueryIO was evaluated in a 25-run benchmark suite across 3 arms:
- **Arm A:** Autonomous coding agent + raw `psql`
- **Arm B:** Autonomous coding agent + QueryIO
- **Arm C:** Autonomous coding agent + DBHub (reference)

The suite tested agents on 5 real-world forensic debugging and aggregate tasks against a realistic 12,000-record seeded database (`acme` SaaS schema), with complete database resets before every run and strict workspace isolation.

All three arms achieved 100% diagnostic accuracy. On forensic debugging tasks (Tasks 1–3), `inspect_row` delivered a **38.5% reduction in median context bytes** and an **18.8% reduction in median database interactions** compared to raw `psql`. On aggregate tasks (Tasks 4–5), median interactions (+2.3%) and median bytes (-0.2%) remained at near parity, though multi-query exploration and indented JSON output led to higher mean context bytes (+27.9%).

For the full methodology, experimental controls, disclosures, and per-run breakdown tables, see [BENCHMARK.md](BENCHMARK.md).

---

## Local Development & Testing

Run integration tests against local Docker PostgreSQL:

```bash
# Start test database
docker compose up -d

# Build TypeScript
npm run build

# Run type checking
npm run typecheck

# Run test suite
npm test
```

---

## License

MIT
