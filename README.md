# QueryIO

**PostgreSQL MCP for debugging with AI coding agents.**

Start with a failing user, invoice, or project. QueryIO's `inspect_row` gives your agent that record and its immediate foreign-key relationships in one call, so it can investigate what happened across related tables.

QueryIO is an open-source [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for PostgreSQL. Use it with Claude Code, Codex, or Cursor to connect application code to actual database state, then run targeted, read-oriented SQL to check the diagnosis.

**Install:** Node.js 20+ and a PostgreSQL connection. [Set `QUERYIO_DATABASE_URL`](#quick-start), run `npx -y queryio check`, then connect your agent.

## Example: why did this user never activate?

> User 4821 verified their email, but their account never activated. Find out why.

In the repository's [sample application](fixture/app/README.md), an agent can investigate like this:

1. Read [`activateUser`](fixture/app/src/activation.ts): activation requires membership in the user's current organization.
2. Call `inspect_row` with these arguments:

   ```json
   { "table": "public.users", "key": { "id": 4821 } }
   ```

   The result includes the user, the organization they reference, and rows referencing the user, including memberships, verification tokens, and events.
3. Compare the records: the user is pending with a verified email and `org_id = 88`, but their membership is still in organization 21. An event records the transfer from 21 to 88.
4. Confirm the missing membership with `query`:

   ```sql
   SELECT org_id, user_id, role
   FROM public.memberships
   WHERE user_id = 4821 AND org_id = 88;
   ```

   No row matches. Reading [`transferUser`](fixture/app/src/admin.ts) explains why: it changes `users.org_id` without creating membership in the destination organization. Activation then returns `no_membership`.

This example comes from the repository's seeded fixture and [published ground truth](fixture/TASKS.md#1-hero-user-4821-never-activated). QueryIO supplies the records; the agent uses your code to interpret them. `inspect_row` returns a bounded sample of immediate relationships, so follow-up queries are still needed to confirm missing data or find recent events.

## Why QueryIO?

- **Investigate a record across tables.** `inspect_row` follows declared foreign keys in both directions. See a user alongside memberships and events, or an invoice alongside its organization and subscription, without hand-writing each relationship lookup.
- **Keep relationships explicit.** Each relation names the table, constraint, direction, and matching columns. Composite keys, self-references, and multiple foreign keys to the same table are handled separately.
- **Know when to dig further.** Related results report `has_more`; failed or skipped relations are labeled. Use `query` for a specific check, an aggregate, or a relationship that exists only in application logic.
- **Explore an unfamiliar schema.** Find tables by table or column name, then describe several tables together, including keys, indexes, and available planner statistics.

Start with the record behind a bug, gather the relationship evidence, and use your code and targeted SQL to explain the mismatch.

<a id="first-run-under-2-minutes"></a>

## Quick start

Requires **Node.js 20+**, network access to PostgreSQL, and a database role with access to the records you want to investigate. Use a dedicated role with only the necessary read permissions; see [role setup](docs/security.md#dedicated-database-role).

### 1. Set the database connection

Replace the example credentials and database name:

```bash
export QUERYIO_DATABASE_URL="postgres://queryio_role:CHANGE_ME_PASSWORD@localhost:5432/app"
```

Windows PowerShell:

```powershell
$env:QUERYIO_DATABASE_URL = "postgres://queryio_role:CHANGE_ME_PASSWORD@localhost:5432/app"
```

QueryIO reads this environment variable at startup. It does not load `.env` files.

### 2. Check the connection

```bash
npx -y queryio check
```

The check reports connectivity, PostgreSQL version, role privileges and warnings, active limits, and the audit log path. It also prints a role creation template; it does not apply it. A successful check can still contain privilege warnings.

### 3. Connect your coding agent

Start the client from the terminal where you set `QUERYIO_DATABASE_URL`, so it can pass the connection to QueryIO. Choose the configuration for your client.

#### Claude Code

Merge this entry into `.mcp.json` at your application repository's root:

```json
{
  "mcpServers": {
    "queryio": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "queryio"],
      "env": {
        "QUERYIO_DATABASE_URL": "${QUERYIO_DATABASE_URL}"
      }
    }
  }
}
```

Claude Code expands the environment variable when it loads the configuration, keeping the connection string out of the shared file. Approve the project server when prompted and use `/mcp` to check its status. See [Claude Code's MCP configuration documentation](https://code.claude.com/docs/en/mcp).

#### Codex

Add this table to `~/.codex/config.toml`:

```toml
[mcp_servers.queryio]
command = "npx"
args = ["-y", "queryio"]
env_vars = ["QUERYIO_DATABASE_URL"]
```

`env_vars` forwards the connection from the environment where Codex starts. Restart your session, then use `/mcp` to check the available tools. See [Codex's MCP configuration documentation](https://developers.openai.com/codex/mcp/).

[CLI registration, Cursor configuration, and running from source](docs/reference.md#client-configuration) are covered in the reference.

### 4. Ask a debugging question

Give your agent a record identifier and a symptom, for example: "Invoice 90017 is paid, but its organization is still suspended. Read the billing code and investigate the related records." Use identifiers from your own database; the numbers in this README belong to the sample fixture.

<a id="tool-reference"></a>
<a id="1-inspect_row-the-differentiator"></a>
<a id="2-describe_tables"></a>
<a id="3-list_tables"></a>
<a id="4-query"></a>

## Core tools

| Tool | What it helps you do |
| --- | --- |
| `inspect_row` | Fetch a row by its full primary key, plus immediate incoming and outgoing foreign-key relationships. Defaults: up to 5 rows per relation, 25 relations, and a 5-second inspection budget. |
| `query` | Check a hypothesis with one SQL statement, including joins and aggregates. Defaults: up to 100 returned rows and a 32 KiB result budget. |
| `list_tables` | Find tables by a substring of a table or column name; see schema-qualified names, estimated row counts, and column counts. |
| `describe_tables` | Inspect several tables' columns, primary and foreign keys, indexes, and available planner statistics in one call. |

`inspect_row` requires a declared primary key and follows only declared foreign keys, one level deep. Related rows are ordered by primary key, or `ctid` when absent, **not by recency**. Check `has_more`, relation statuses, and skipped relations before drawing conclusions. The 32 KiB `query` budget does not apply to the other tools.

See the [tool contracts and configuration reference](docs/reference.md) for inputs, response fields, errors, and limits.

## When to use QueryIO

- **Activation and onboarding failures:** compare a user's status with their organization, memberships, verification records, and events.
- **Billing inconsistencies:** start with a paid invoice, inspect its organization and subscription, then query for other overdue or duplicate invoices.
- **Unexpected access or attribution:** inspect a project and its associated users, then follow up on memberships, assignments, and surviving API keys.

QueryIO fits developers debugging PostgreSQL applications with an MCP-capable coding agent, especially when the schema declares the relationships involved. It does not read your repository or know your business rules; your agent supplies that context.

### Considering QueryIO as a DBHub alternative?

Choose QueryIO when you want `inspect_row` to gather related records around a specific PostgreSQL row. [DBHub](https://github.com/bytebase/dbhub) supports multiple database engines and simultaneous connections, and has its own read-only mode, row limits, and query timeouts. Those needs may make DBHub a better fit. The [benchmark](BENCHMARK.md) does not establish that QueryIO outperforms DBHub.

QueryIO is also a poor fit for writing data, running migrations, exporting full datasets, or execution-plan analysis (`EXPLAIN` is rejected). Schemas without declared foreign keys need manual SQL for relationship investigation; tables without primary keys require `query` instead of `inspect_row`. QueryIO exposes local MCP over stdio, not an HTTP endpoint.

<a id="security-posture-stated-honestly"></a>
<a id="resource-bound-tradeoffs"></a>

## Security

QueryIO runs investigation tools in PostgreSQL `READ ONLY` transactions and rolls them back. Agent-supplied SQL is limited to one statement, with PostgreSQL statement and lock timeouts. Results use row limits, value truncation, and column-name redaction; local audit logging records metadata by default.

**QueryIO is not a complete security sandbox.** Read-only SQL can still consume database resources or call functions with side effects permitted by the connected role. Column-name redaction is best-effort: aliases, expressions, and secrets inside other columns can bypass it. Returned records enter your agent's context, where the client's data handling policies apply.

Use a dedicated database role with narrowly scoped permissions. QueryIO warns about privileged roles but permits them, and cannot prevent an agent with other credentials or shell access from bypassing it. Read the [security guidance and resource limits](docs/security.md) before connecting sensitive data.

<a id="evaluation--benchmarks"></a>

## Benchmarks

The original **25-run benchmark** compared QueryIO, raw `psql`, and DBHub on five seeded application debugging and aggregate tasks. All arms were manually graded correct in this small suite, but **QueryIO did not meet the pre-declared win condition**.

Against raw `psql`, forensic tasks used 38.5% fewer median output bytes (20.7% fewer mean bytes), while aggregate tasks used 27.9% more mean bytes and 14.0% more mean interactions. QueryIO recorded 23 failed operations versus zero for `psql`. The evaluation used a CLI shim rather than QueryIO's MCP transport, with two runs per task for QueryIO and `psql` and one for DBHub; these results do not establish general performance or superiority over DBHub.

Read [BENCHMARK.md](BENCHMARK.md) for all results and limitations.

<a id="configuration--defaults"></a>
<a id="structured-error-contract"></a>
<a id="audit-logging"></a>
<a id="local-development--testing"></a>

## Documentation and contributing

- [Reference](docs/reference.md): tools, structured errors, client configuration, environment variables, and audit logging.
- [Security](docs/security.md): database permissions, redaction limits, and resource tradeoffs.
- [Contributing](docs/contributing.md): local setup, checks, and reproducible bug reports.
- [Positioning and GitHub presentation](docs/positioning.md): audience, verified claims, and proposed repository settings.

Report bugs or suggest improvements in [GitHub issues](https://github.com/aradhyas8/queryio-mcp/issues).

<a id="license"></a>

QueryIO is licensed under [MIT](LICENSE).
