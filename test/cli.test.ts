import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TEST_URL } from "./db.js";

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
    env: { ...(process.env as Record<string, string>), QUERYIO_DATABASE_URL: TEST_URL },
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
