# QueryIO reference

[README](../README.md) · [Security](security.md) · [Contributing](contributing.md)

## Tool contracts

QueryIO exposes four MCP tools over stdio. Successful responses contain `structuredContent` and compact JSON text content. Columns appear once and row values are arrays in column order. Role warnings, when available, are attached as `warnings`.

### `inspect_row`

Fetch one row by its full primary key and its depth-1 declared foreign-key neighborhood in one MCP call. This gathers relationship evidence; it does not infer business rules or automatically recurse through the database.

```json
{ "table": "public.users", "key": { "id": 4821 } }
```

`table` must be schema-qualified. Use the exact name returned by `list_tables`, including its quoting for names containing dots or quotation marks. `key` must contain exactly every primary key column, with string, number, or boolean values. Pass integers outside JavaScript's safe integer range as strings. Composite key example:

```json
{ "table": "public.memberships", "key": { "org_id": 88, "user_id": 4821 } }
```

| Result field | Meaning |
| --- | --- |
| `table`, `columns`, `row` | Root table name, column names, and one row as an array. |
| `relations` | One entry per attempted foreign-key constraint and direction. |
| `relations_not_attempted` | Relationships skipped because of `max_relations` or `deadline`. Includes direction, table, constraint, and source/target columns. |
| `values_truncated`, `values_redacted` | Counts across the root and returned related rows. |
| `duration_ms` | Call duration in milliseconds. |

Each relation includes:

- `direction`: `outgoing` for rows the root references; `incoming` for rows referencing the root.
- `table`, `constraint`, `source_columns`, `target_columns`: the related table and declared foreign key. Source columns are the referencing columns, paired by position with target columns, regardless of direction.
- `status`: `ok`, `timeout`, or `error`. A failed relation is not evidence that no related records exist.
- `order_by`: the related table's primary key, or `ctid` without one. This is not chronological ordering; physical `ctid` order can change after database maintenance or updates.
- `columns`, `rows`, `rows_returned`, `has_more`: the bounded related records. `has_more` indicates additional records, without an exact omitted count.

Defaults are 5 returned rows per relation, 25 attempted relations, and a 5000 ms inspection budget. Outgoing constraints are considered before incoming constraints. Composite foreign keys, self-references, and separate constraints between the same two tables are supported. Relationships without declared foreign keys need `query`.

Each relation lookup uses a savepoint so a failed lookup can be reported while others continue within the remaining budget. Statement timeouts are reduced to the remaining inspection budget. Failure to obtain the root row can fail the whole call. The budget is not a hard wall-clock limit on pool connection acquisition, network delays, or response serialization.

### `query`

Run one read-oriented PostgreSQL statement:

```json
{ "sql": "SELECT status, count(*) FROM public.users GROUP BY status" }
```

Allowed leading commands are `SELECT`, `WITH`, `VALUES`, `TABLE`, and `SHOW`. `EXPLAIN`, `COPY`, direct DML, and DDL are rejected. The keyword gate catches mistakes; PostgreSQL permissions and transaction state supply the database restrictions. Agent SQL runs through an extended-protocol cursor, which rejects multiple statements.

| Result field | Meaning |
| --- | --- |
| `columns`, `rows` | Column names and rows as arrays. |
| `row_count` | Number of rows returned in this response. |
| `has_more` | At least one additional row existed beyond those returned. |
| `truncated_by` | `"rows"`, `"bytes"`, or `null` when retrieval completed. |
| `values_truncated` | Number of returned cells shortened. |
| `columns_redacted`, `values_redacted` | Number of matching returned columns and hidden cells. |
| `duration_ms` | Call duration in milliseconds. |

The cursor requests at most `QUERYIO_MAX_ROWS + 1` rows in total; the extra row proves `has_more`. The byte budget accounts for the core JSON response envelope and shaped rows, but is not a universal transport-size guarantee: column metadata alone can exceed a very small budget, and MCP wrapping and role warnings add bytes. There is no continuation token; write a targeted follow-up query with explicit filtering and ordering. Use an explicit `COUNT(*)` when you need a total count.

Long text, JSON, arrays, and binary values can be shortened to text with an omitted-size marker such as `…[+3.2KB]`. The configured value length is a truncation target, not a hard final length: the marker adds characters, and values barely over the target are kept whole if a marker would make them longer. Redaction happens before truncation and row byte accounting.

PostgreSQL `bigint` and `numeric` values use the driver's string representation. `date` and `timestamp without time zone` are returned as PostgreSQL text, with their array forms returned as PostgreSQL array-literal text. `timestamptz` uses the driver's date handling and serializes as an ISO timestamp in MCP JSON.

### `list_tables`

```json
{ "filter": "email" }
```

`filter` is optional and matches a case-insensitive substring of table or column names. Returns `{ tables: [{ name, estimated_rows, columns }] }` for ordinary and partitioned tables outside `pg_*` and `information_schema`; child partitions are omitted from the listing. It does not list views. Catalog visibility is not proof that the connected role can read a table.

`estimated_rows` comes from `pg_class.reltuples`, with `null` when no estimate exists. It is an estimate, not a live count; no application table scan is performed.

### `describe_tables`

```json
{ "tables": ["public.users", "public.memberships"] }
```

`tables` must be a nonempty array of schema-qualified names. Returns table descriptions in requested order with `name`, `columns`, `primary_key` (or `null`), `foreign_keys_out`, `foreign_keys_in`, and `indexes`. Foreign keys include constraint, referencing table/columns, and referenced table/columns. Indexes include name, columns or expressions, uniqueness, primary status, and any predicate.

Columns include name, PostgreSQL type, nullability, and `stats_available`. Available `pg_stats` data includes `null_frac` and `n_distinct`; a negative `n_distinct` is minus the estimated fraction of distinct rows (`-1` means unique). Low-cardinality columns can include `common_values` with frequencies. Common values are truncated, and dropped as a group if their serialized size exceeds 1024 bytes. Statistics are estimates and may be stale or unavailable; QueryIO does not run `ANALYZE` or scan tables to calculate them. Existing statistics for redacted columns are suppressed with `stats_available: false, redacted: true`.

Unknown tables return a per-table `{ name, error }` without failing other descriptions. There is no overall row or byte cap on catalog tool responses; request a small batch or use a listing filter for large schemas.

## Structured errors

Tool execution failures set the MCP error flag `isError: true` and return JSON text shaped as `{ error: { category, code, message, hint }, warnings? }`. `code` and `hint` are omitted when unavailable. For example:

```json
{
  "error": {
    "category": "timeout",
    "code": "57014",
    "message": "canceling statement due to statement timeout"
  }
}
```

Specific categories include `timeout` (`57014`), `lock_timeout` (`55P03`), and `read_only` (`25006`). Other PostgreSQL errors use SQLSTATE class names such as `syntax_error_or_access_rule_violation`, `integrity_constraint_violation`, `connection_exception`, `data_exception`, and `insufficient_resources`, with `postgres_error` as the fallback. Failures without SQLSTATE use `client_error`.

QueryIO validation categories are `read_oriented`, `not_found`, `no_primary_key`, `key_mismatch`, and `row_not_found`. See [the implementation](../src/errors.ts) for the full mapping. A relation's `status: "error"` or a `describe_tables` per-table error can occur inside an otherwise successful tool call.

## Configuration and defaults

QueryIO reads settings from environment variables at startup. Its only subcommands are `check` and `setup`; other command-line arguments, including connection strings, are rejected with exit code 2. This policy applies to the QueryIO process; MCP clients' own registration commands can still accept and persist credentials.

| Variable | Default | Purpose |
| --- | --- | --- |
| `QUERYIO_DATABASE_URL` | Required | PostgreSQL connection string. No automatic `.env` loading. A placeholder left unexpanded by the client, such as `${QUERYIO_DATABASE_URL}`, stops startup with an error. |
| `QUERYIO_STATEMENT_TIMEOUT_MS` | `5000` | PostgreSQL statement timeout within investigation transactions. |
| `QUERYIO_LOCK_TIMEOUT_MS` | `1000` | PostgreSQL timeout for waiting to acquire locks. |
| `QUERYIO_MAX_ROWS` | `100` | Returned row cap for `query`. |
| `QUERYIO_MAX_RESPONSE_BYTES` | `32768` | Core result byte budget; bounds `query` only, subject to the metadata caveat above. |
| `QUERYIO_MAX_VALUE_LENGTH` | `200` | Truncation target for individual values, in characters. |
| `QUERYIO_INSPECT_RELATED_ROWS` | `5` | Returned rows per `inspect_row` relation. |
| `QUERYIO_INSPECT_MAX_RELATIONS` | `25` | Attempted relations per inspection. |
| `QUERYIO_INSPECT_DEADLINE_MS` | `5000` | Inspection budget used to reduce statement timeouts. |
| `QUERYIO_AUDIT_LOG` | `~/.queryio/audit.jsonl` | Local JSONL log; `off` disables it. |
| `QUERYIO_AUDIT_INCLUDE_SQL` | `false` | Exactly `true` enables raw SQL logging, which can expose literals. |
| `QUERYIO_REDACT_ADD` | Empty | Comma-separated column names to add to redaction. |
| `QUERYIO_REDACT_REMOVE` | Empty | Comma-separated column names to remove from redaction. |

Numeric settings accept positive integers. Name matching for redaction is exact and case-insensitive, not a substring or content scan. Defaults: `password`, `password_hash`, `secret`, `token`, `access_token`, `refresh_token`, `api_key`, `private_key`, `credential`. See [redaction limits](security.md#redaction-and-data-exposure).

## Setup wizard

`npx -y queryio setup` configures QueryIO for Claude Code, Codex, and Cursor. It takes no arguments and asks its questions interactively.

1. **Clients.** It detects each client from its command on `PATH` or its configuration directory, and preselects the detected ones. You can choose clients that were not detected; the wizard writes their configuration and notes that the client must be installed.
2. **Scope.** Project scope, the default, writes to the current directory. Global scope writes to your user configuration, making QueryIO available in every project the client opens, and requires a second confirmation.
3. **Preview.** For each file, it shows whether it will be created, added to, or left unchanged, and prints the entry. An existing, different `queryio` entry is shown with stored connection strings and literal environment values hidden, and is replaced only if you confirm. Nothing is written until you confirm the full set of changes; declining, closing input, or pressing Ctrl+C cancels without changes.
4. **Write.** Each modified file is first copied to `~/.queryio/backups/`, outside the project so backups cannot be committed with it. Backup files are readable only by you on macOS and Linux, because an old entry may contain a stored connection string; setup names any such backup so you can delete it. The file is then replaced atomically through a temporary file. Other servers and settings are preserved, as are JSON indentation and line endings; Codex TOML is edited in place, keeping comments. If a file cannot be parsed, or cannot be updated without changing other settings, it is left unchanged and the entry to add manually is printed.
5. **Verify.** It reads each file back. When the client's command is on `PATH`, it runs `claude mcp get queryio` or `codex mcp get queryio` and reports only their scope and status lines. Cursor is not checked automatically. If `QUERYIO_DATABASE_URL` is set, it runs the same connectivity and role check as `queryio check`, reports warnings, and starts the installed QueryIO server to list its tools.

| Client | Project scope | Global scope | Connection reference |
| --- | --- | --- | --- |
| Claude Code | `.mcp.json` | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` if set) | `"QUERYIO_DATABASE_URL": "${QUERYIO_DATABASE_URL}"` |
| Codex | `.codex/config.toml` (trusted projects only) | `~/.codex/config.toml` (`$CODEX_HOME/config.toml` if set) | `env_vars = ["QUERYIO_DATABASE_URL"]` |
| Cursor | `.cursor/mcp.json` | `~/.cursor/mcp.json` | `"QUERYIO_DATABASE_URL": "${env:QUERYIO_DATABASE_URL}"` |

On Windows, the entries launch `cmd` with `/c npx -y queryio`, because `npx` is a batch shim that clients cannot always start directly. Elsewhere they launch `npx -y queryio`.

The wizard does not prompt for, store, or log the connection string, and does not read `.env` files. Configuration success, client discovery, and database connectivity are reported separately. The exit code is 0 only when configuration succeeded and PostgreSQL was reachable; it is 1 when a file could not be configured, the connection variable is missing, or the connection failed, and 130 when setup is cancelled. A passing check proves the variable is available in the wizard's terminal, not in the client: start each client from an environment where `QUERYIO_DATABASE_URL` is set. If a client starts QueryIO without it, QueryIO exits before connecting and reports the unresolved placeholder on stderr. Claude Code asks you to approve a new project server; Codex loads project configuration only for trusted projects.

## Client configuration

The [README](../README.md#quick-start) shows configurations that forward an environment variable without putting its value into the shared file. Ensure the variable is available to the process launching the MCP server, including after restarting an editor or desktop client.

### CLI registration alternatives

For Claude Code, the default scope is local to the current project and stored in `~/.claude.json`. Use `--scope user` for all projects, or `--scope project` for a shared `.mcp.json`. See the [official scope documentation](https://code.claude.com/docs/en/mcp#scope-hierarchy-and-precedence).

These examples contain placeholder credentials. Registration commands using `--env` can expose the value in shell history or process arguments, and save it in client configuration. Protect those files; do not commit real credentials.

```bash
claude mcp add queryio --transport stdio --scope user --env QUERYIO_DATABASE_URL="postgres://queryio_role:CHANGE_ME_PASSWORD@localhost:5432/app" -- npx -y queryio
```

```bash
codex mcp add queryio --env QUERYIO_DATABASE_URL="postgres://queryio_role:CHANGE_ME_PASSWORD@localhost:5432/app" -- npx -y queryio
```

Codex can also store explicit values under `[mcp_servers.queryio.env]`; the README uses `env_vars` to forward the value instead. Both are documented in [Codex's MCP reference](https://developers.openai.com/codex/mcp/). Claude Code and Codex commands are alternatives to editing their configuration files, not additional required steps.

### Cursor and other stdio MCP clients

For Cursor, merge the following into the project's `.cursor/mcp.json` or your user `~/.cursor/mcp.json`. Set `QUERYIO_DATABASE_URL` in the environment where Cursor starts. See [Cursor's MCP documentation](https://cursor.com/docs/context/mcp).

```json
{
  "mcpServers": {
    "queryio": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "queryio"],
      "env": {
        "QUERYIO_DATABASE_URL": "${env:QUERYIO_DATABASE_URL}"
      }
    }
  }
}
```

Other clients must support launching an MCP stdio server and supplying its environment. QueryIO does not expose an HTTP server. On Windows, if a client cannot launch `npx` directly, use `command: "cmd"` with `args: ["/c", "npx", "-y", "queryio"]`.

### Run from source

```bash
git clone https://github.com/aradhyas8/queryio-mcp.git
cd queryio-mcp
npm ci
npm run build
node dist/cli.js check
```

Set `QUERYIO_DATABASE_URL` first. To use this checkout from a client, set `command` to `node` and `args` to the absolute path of `dist/cli.js`. Rebuild after source changes. To test package installation without publishing, follow the [packed-package procedure](contributing.md#test-the-package-without-publishing).

## Audit logging

QueryIO attempts one local JSONL audit event per core tool invocation, including failures. It records `ts`, tool name, duration, and success status. Successful results add available counts and bytes; errors add category and code. Table names are recorded for resolved `describe_tables` tables and inspected root/attempted related tables, not by parsing arbitrary `query` SQL. `query` includes `sql_hash`, the first 16 hexadecimal characters of SHA-256 over the exact SQL text, and retrieval flags. `inspect_row` adds relation status and skipped-reason counts.

Result values, inspection key values, listing filters, and raw SQL are omitted by default. `QUERYIO_AUDIT_INCLUDE_SQL=true` includes raw SQL, which may contain sensitive literals. Hashes are fingerprints, not anonymization guarantees. Logging is best-effort: an unwritable file produces a warning on stderr and the tool still runs. The log has no built-in rotation or tamper protection.

Analyze it with `jq`:

```bash
# Count calls by tool
jq -s 'group_by(.tool) | map({tool: .[0].tool, calls: length})' ~/.queryio/audit.jsonl

# Sum logged core response bytes (not total MCP transport bytes)
jq -s 'map(.bytes_returned // 0) | add' ~/.queryio/audit.jsonl

# Inspect failures
jq 'select(.success == false) | {ts, tool, error_category, error_code}' ~/.queryio/audit.jsonl
```
