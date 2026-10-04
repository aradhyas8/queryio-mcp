import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ADMIN_URL, TEST_DB, TEST_URL, sql } from "./db.js";

let dir: string;
let tarball: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "queryio-pack-"));
  execSync("npm run build", { stdio: "ignore" });
  const out = execSync(`npm pack --json --ignore-scripts --pack-destination "${dir}"`, { encoding: "utf8" });
  tarball = join(dir, JSON.parse(out)[0].filename);
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

it("starts the MCP stdio server from the packed tarball via npx and answers a query", async () => {
  const transport = new StdioClientTransport({
    // Equivalent of `npx -y queryio`, installing from the local tarball instead of the registry.
    command: "npx",
    args: ["-y", "--package", tarball, "queryio"],
    cwd: dir,
    env: { ...(process.env as Record<string, string>), QUERYIO_DATABASE_URL: TEST_URL, QUERYIO_AUDIT_LOG: "off" },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 42 AS answer" } });
    expect(result.structuredContent).toMatchObject({ columns: ["answer"], rows: [[42]] });
  } finally {
    await client.close();
  }
}, 120_000);

it("exits with a clear error when QUERYIO_DATABASE_URL is missing", () => {
  const env = { ...process.env };
  delete env.QUERYIO_DATABASE_URL;
  const run = spawnSync("node", ["dist/cli.js"], { env, encoding: "utf8" });
  expect(run.status).toBe(1);
  expect(run.stderr).toMatch(/QUERYIO_DATABASE_URL is not set/);
});

it("refuses command-line arguments such as a DSN", () => {
  const run = spawnSync("node", ["dist/cli.js", "postgres://u:p@localhost/db"], {
    env: { ...process.env, QUERYIO_DATABASE_URL: TEST_URL },
    encoding: "utf8",
  });
  expect(run.status).toBe(2);
  expect(run.stderr).not.toContain("u:p");
});

it("runs queryio check, reporting connectivity, role privileges, warnings, and role template", () => {
  execSync("npm run build", { stdio: "ignore" });
  const run = spawnSync("node", ["dist/cli.js", "check"], {
    env: { ...process.env, QUERYIO_DATABASE_URL: TEST_URL },
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("QueryIO Check");
  expect(run.stdout).toContain("Connectivity:            ok");
  expect(run.stdout).toContain("PostgreSQL version:");
  expect(run.stdout).toContain("Connected database:      queryio_test");
  expect(run.stdout).toContain("Connected role:          postgres");
  expect(run.stdout).toContain("Superuser:               yes");
  expect(run.stdout).toContain("Write privileges:        yes");
  expect(run.stdout).toContain("Active limits:");
  expect(run.stdout).toContain("Redaction patterns:");
  expect(run.stdout).toContain("Warnings:");
  expect(run.stdout).toContain('connected role "postgres" is highly privileged');
  expect(run.stdout).toContain("CREATE ROLE queryio_role WITH LOGIN PASSWORD");
});

it("refuses unrecognized subcommands with exit code 2", () => {
  const run = spawnSync("node", ["dist/cli.js", "unknown_subcommand"], {
    env: { ...process.env, QUERYIO_DATABASE_URL: TEST_URL },
    encoding: "utf8",
  });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain("Usage: queryio [check]");
});

it("runs queryio check against a read-only role, reporting no superuser and no warnings", async () => {
  const roRole = "queryio_cli_ro_role";
  const roPass = "cli_ro_pass_123";
  const dropRoleSafe = `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${roRole}') THEN EXECUTE 'DROP OWNED BY ' || quote_ident('${roRole}'); EXECUTE 'DROP ROLE ' || quote_ident('${roRole}'); END IF; END $$;`;

  await sql(`
    ${dropRoleSafe}
    CREATE ROLE ${roRole} WITH LOGIN PASSWORD '${roPass}';
    GRANT CONNECT ON DATABASE ${TEST_DB} TO ${roRole};
    GRANT USAGE ON SCHEMA public TO ${roRole};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roRole};
  `);

  const url = new URL(ADMIN_URL);
  url.username = roRole;
  url.password = roPass;
  url.pathname = `/${TEST_DB}`;

  try {
    const run = spawnSync("node", ["dist/cli.js", "check"], {
      env: { ...process.env, QUERYIO_DATABASE_URL: url.toString() },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Connected role:          ${roRole}`);
    expect(run.stdout).toContain("Superuser:               no");
    expect(run.stdout).toContain("Write privileges:        none");
    expect(run.stdout).toContain("none (role is least-privileged)");
  } finally {
    await sql(dropRoleSafe);
  }
});
