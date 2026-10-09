# QueryIO security and resource limits

[README](../README.md) · [Reference](reference.md)

QueryIO is a bounded investigation interface. PostgreSQL permissions determine what its connected role can access or affect. Use a dedicated role and review which records may enter your coding agent's context.

## Safeguards

- Investigation tools run in `BEGIN READ ONLY` transactions with PostgreSQL `statement_timeout` and `lock_timeout`. QueryIO attempts `ROLLBACK` after both success and failure; a connection that cannot be rolled back is destroyed rather than reused. Session advisory locks are also released during cleanup.
- Agent-supplied `query` SQL executes through an extended-protocol cursor, rejecting multiple statements in one call. The leading-keyword gate accepts `SELECT`, `WITH`, `VALUES`, `TABLE`, and `SHOW`; it rejects direct DML, DDL, `COPY`, and `EXPLAIN`. A writable CTE or side-effecting function can pass the keyword gate, so it is a mistake catcher, not a security boundary.
- `inspect_row` resolves table identities from PostgreSQL catalogs, quotes generated identifiers, and binds primary-key values as parameters. This protects those generated lookups from identifier/value injection.
- `query` caps retrieved rows and budgets returned bytes; inspections cap related rows and attempted relationships and reduce statement timeouts as their budget runs down. See the [configuration reference](reference.md#configuration-and-defaults) for scope and defaults.
- Redaction and truncation reduce accidental exposure and response size. Local audit events omit row values and raw SQL by default.

These measures do not make every permitted query harmless. SQL can consume CPU, memory, I/O, or locks, and some functions have effects outside ordinary transactional table writes. Permissions on functions and extensions matter alongside table permissions.

## Dedicated database role

Avoid using the application's role or a superuser for staging or production investigations. A role shared with the application can cancel or terminate the application's backends where PostgreSQL permits it. Superusers and roles with server-side capabilities substantially weaken containment. QueryIO reports warnings but does not refuse privileged roles.

`queryio check` prints a ready-to-edit role template for the connected database. Review it with the database owner and apply only the grants required for your investigation. This example grants SELECT on every table in `public`; narrow the grants if that would expose too much data:

```sql
CREATE ROLE queryio_role WITH LOGIN PASSWORD 'CHANGE_ME_PASSWORD';
GRANT CONNECT ON DATABASE "your_database" TO queryio_role;
GRANT USAGE ON SCHEMA public TO queryio_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO queryio_role;
ALTER ROLE queryio_role SET default_transaction_read_only = on;

-- Optional: access to future tables created by the role running this statement.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO queryio_role;
```

Repeat schema grants only where needed. `ALTER DEFAULT PRIVILEGES` applies to objects later created by the role that runs it; for a separate migration owner, use the appropriate `FOR ROLE <owner>` form. Existing application grants do not automatically transfer to this new role.

The role check detects superuser status, table write privileges, and membership in `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files`, `pg_write_all_data`, and `pg_signal_backend`. It is a diagnostic, not a complete privilege or extension audit. `default_transaction_read_only` is an additional default, not an immutable access-control policy.

Review inherited privileges, callable functions, row/column permissions, and extension access. `dblink`, foreign data wrappers (FDWs), and other external connections can have effects beyond the local read-only transaction and rollback. Restrict those capabilities in PostgreSQL according to your environment.

## Redaction and data exposure

Redaction matches exact column names, case-insensitively. Matching result cells become `[redacted]`; available statistics on matching columns are suppressed. The [reference](reference.md#configuration-and-defaults) lists default names and additions/removals.

This is best-effort accidental-exposure prevention. It does not inspect content or nested JSON, and it does not automatically hide personal data such as email addresses. Arbitrary SQL can rename sensitive columns or put their values inside expressions:

```sql
SELECT password_hash AS another_name FROM public.users;
```

The alias does not match the default redaction names. Use database permissions to keep sensitive values inaccessible; do not rely on QueryIO redaction for access control.

QueryIO sends returned records to the MCP client. Your agent or model service may receive them as context under that client's policies. QueryIO does not configure those policies or control what the agent does with the output.

The connection is read from `QUERYIO_DATABASE_URL`; QueryIO does not read `.env` files or accept a connection string as its own CLI argument. That does not protect secrets from a client, shell history, local configuration files, or other processes allowed to read the environment. An agent with shell access and alternative credentials can bypass QueryIO entirely.

## Resource-bound tradeoffs

- **Returned rows do not bound PostgreSQL work.** A join, aggregate, or sort can process many rows before producing a result. Statement timeouts limit individual PostgreSQL statements; they are not a CPU or memory quota, nor a hard end-to-end timeout on every MCP call.
- **Wide values are received before truncation.** QueryIO does not materialize an entire streaming query result, but each fetched batch contains full-width rows before shaping. Large text or JSON cells can still consume substantial memory.
- **Limits differ by tool.** `QUERYIO_MAX_RESPONSE_BYTES` budgets `query` results only. It excludes MCP wrapping and role warnings; unusually wide column metadata can exceed it. `inspect_row` uses row/relation limits and a time budget, with no equivalent total byte cap. Catalog results are not globally capped.
- **Inspection samples are incomplete evidence.** Related rows use primary-key order or `ctid`, not recency. Check `has_more` and `relations_not_attempted`, and distinguish relation failures from empty results. Fetch a recent timeline or confirm a missing relationship with targeted SQL.
- **Separate statements can see changing data.** An inspection uses the default transaction isolation, not a guaranteed stable snapshot across every lookup. Consider that when investigating a live, changing application.
- **Audit logging can fail or grow.** Logging errors do not stop tool execution; events are local files without built-in retention or tamper protection. Raw SQL logging is opt-in and can expose literals.

See [tool contracts](reference.md#tool-contracts) for response flags and [the benchmark report](../BENCHMARK.md) for observed workflow tradeoffs.
