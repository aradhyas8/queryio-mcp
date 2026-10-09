# Contributing to QueryIO

[README](../README.md) · [Reference](reference.md) · [Security](security.md)

## Local setup and checks

Use Node.js 20+ and Docker with Compose. The test suite uses PostgreSQL 16, with Node.js 20 and 22 covered by the [CI configuration](../.github/workflows/ci.yml).

```bash
git clone https://github.com/aradhyas8/queryio-mcp.git
cd queryio-mcp
npm ci
docker compose up -d --wait postgres
npm run typecheck
npm run build
npm test
```

The test runner starts the Compose service automatically when `QUERYIO_TEST_ADMIN_URL` is unset. It connects to `localhost:54329` and **drops and recreates the `queryio_test` database**. Use a disposable local PostgreSQL instance. `QUERYIO_TEST_ADMIN_URL` overrides the admin connection, but the database reset still applies.

Tests cover query bounds, read-only transactions, timeouts, redaction, catalogs, row inspection, role checks, audit events, packed CLI startup, MCP responses, benchmark metric extraction, and documentation assertions. The assertions in [`test/readme.test.ts`](../test/readme.test.ts) currently require the former README headings and all references inline; they need an update to accommodate the split documentation.

## Test the package without publishing

From this repository, `npm pack` runs the existing build hook and creates a local tarball. It does not publish:

```bash
npm pack
```

Use the filename printed by `npm pack` in place of `PATH_TO_TARBALL` below. Set `QUERYIO_DATABASE_URL` as described in the [quick start](../README.md#quick-start), then run:

```bash
npx -y --package PATH_TO_TARBALL queryio check
```

For an MCP client, use `command: "npx"` and `args: ["-y", "--package", "/absolute/path/to/the/tarball", "queryio"]`. Supply the connection through the client's environment. Using an absolute tarball path avoids dependence on the client's working directory.

## Report an issue or propose a change

Open a [GitHub issue](https://github.com/aradhyas8/queryio-mcp/issues) with the QueryIO, Node.js, PostgreSQL, and MCP client versions; the tool and sanitized input; expected versus actual behavior; and any structured error category/code. A small schema and synthetic reproduction help more than a database dump. Remove credentials, row data, and raw SQL literals from logs before sharing.

For a pull request, explain the user-visible behavior, keep changes focused, and run the relevant existing checks. Preserve tool contracts and document limitations when behavior changes. The project uses the [MIT license](../LICENSE).

## Benchmark evidence

Read [BENCHMARK.md](../BENCHMARK.md) before citing the original comparison. It reports a missed win condition, aggregate regressions, failed operations, and a CLI-shim methodology.

Do not combine results across different agents, graders, or experiment versions, or present local/partial runs as a published result. Benchmark execution is separate from the normal build and test suite.
