// How each arm's MCP server is launched. Each server gets only a connection to the run's database
// (as the run's read-only role) plus its documented read-only setting. No tools, hints, or limits
// are customized for the benchmark; every server runs its stock tool set.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, REPO_DIR } from "../harness/lib.mjs";

const SERVERS = join(BENCH_DIR, "servers", "node_modules");

export const ARMS = {
  queryio: {
    product: "QueryIO (this repository, dist/cli.js)",
    // Production MCP server from this checkout. Audit log location is redirected into the private run
    // directory instead of ~/.queryio; QueryIO behaves identically either way.
    launch: ({ dsn, privDir }) => ({
      command: process.execPath,
      args: [join(REPO_DIR, "dist", "cli.js")],
      env: { QUERYIO_DATABASE_URL: dsn, QUERYIO_AUDIT_LOG: join(privDir, "queryio-audit.jsonl") },
    }),
  },
  dbhub: {
    product: "@bytebase/dbhub",
    // DBHub 1.x removed --readonly; read-only mode is the documented dbhub.toml tool setting. Declaring
    // any [[tools]] for a source replaces its default set, so both defaults (execute_sql, search_objects)
    // are listed explicitly; nothing else is added.
    launch: ({ dsn, privDir }) => {
      const config = join(privDir, "dbhub.toml");
      writeFileSync(
        config,
        `[[sources]]\nid = "default"\ndsn = "${dsn}"\n\n` +
          `[[tools]]\nname = "execute_sql"\nsource = "default"\nreadonly = true\n\n` +
          `[[tools]]\nname = "search_objects"\nsource = "default"\n`,
      );
      return {
        command: process.execPath,
        args: [join(SERVERS, "@bytebase", "dbhub", "dist", "index.js"), "--transport", "stdio", "--config", config],
        env: {},
      };
    },
  },
  "postgres-mcp": {
    product: "@microsoft/postgres-mcp",
    // Headless configuration documented in USAGE.md ("Connecting without a profile").
    launch: ({ dsn }) => ({
      command: process.execPath,
      args: [join(SERVERS, "@microsoft", "postgres-mcp", "bin", "postgres-mcp.js"), "run", "--no-telemetry"],
      env: { POSTGRES_MCP_CONNECTION_STRING: dsn, POSTGRES_MCP_DISABLE_CWD_ACCESS: "1" },
    }),
  },
  // Engineering control, not a competitor: a bare psql passthrough (opt in with --arms).
  "psql-control": {
    product: "psql passthrough (benchmark-owned control)",
    launch: ({ containerDsn }) => ({
      command: process.execPath,
      args: [join(BENCH_DIR, "harness", "psql-mcp.mjs")],
      env: { PSQL_DSN: containerDsn },
    }),
  },
};
