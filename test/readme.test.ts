import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_URL, sql } from "./db.js";

describe("README specification coverage", () => {
  const readmePath = join(__dirname, "..", "README.md");
  let readme: string;

  beforeAll(() => {
    expect(existsSync(readmePath)).toBe(true);
    readme = readFileSync(readmePath, "utf8");
  });

  it("documents first run in four steps with client examples", () => {
    expect(readme).toContain("First Run (Under 2 Minutes)");
    expect(readme).toContain("1. Set `QUERYIO_DATABASE_URL`");
    expect(readme).toContain("2. Verify with `queryio check`");
    expect(readme).toContain("3. Add QueryIO to Your MCP Client");
    expect(readme).toContain("4. Ask the Agent a Debugging Question");

    // Client integration examples
    expect(readme).toContain("Claude Code");
    expect(readme).toContain("claude mcp add queryio");
    expect(readme).toContain("Codex (OpenAI Codex / Codex CLI)");
    expect(readme).toContain("codex mcp add queryio");
    expect(readme).toContain("[mcp_servers.queryio]");
  });

  it("describes the four tools and their input/output contracts", () => {
    expect(readme).toContain("### 1. `inspect_row`");
    expect(readme).toContain("### 2. `describe_tables`");
    expect(readme).toContain("### 3. `list_tables`");
    expect(readme).toContain("### 4. `query`");

    // has_more / truncated_by semantics
    expect(readme).toContain("`has_more`");
    expect(readme).toContain("`truncated_by`");
    expect(readme).toContain('"rows"');
    expect(readme).toContain('"bytes"');

    // inspect_row relation statuses and not-attempted reasons
    expect(readme).toContain('"ok"');
    expect(readme).toContain('"timeout"');
    expect(readme).toContain('"error"');
    expect(readme).toContain("`relations_not_attempted`");
    expect(readme).toContain('"max_relations"');
    expect(readme).toContain('"deadline"');
  });

  it("lists all configuration knobs, defaults, and explains CLI flags policy", () => {
    const expectedKnobs = [
      "QUERYIO_DATABASE_URL",
      "QUERYIO_STATEMENT_TIMEOUT_MS",
      "QUERYIO_LOCK_TIMEOUT_MS",
      "QUERYIO_MAX_ROWS",
      "QUERYIO_MAX_RESPONSE_BYTES",
      "QUERYIO_MAX_VALUE_LENGTH",
      "QUERYIO_INSPECT_RELATED_ROWS",
      "QUERYIO_INSPECT_MAX_RELATIONS",
      "QUERYIO_INSPECT_DEADLINE_MS",
      "QUERYIO_AUDIT_LOG",
      "QUERYIO_AUDIT_INCLUDE_SQL",
      "QUERYIO_REDACT_ADD",
      "QUERYIO_REDACT_REMOVE",
    ];

    for (const knob of expectedKnobs) {
      expect(readme).toContain(knob);
    }

    expect(readme).toContain("Configuration & Defaults");
    expect(readme).toContain("Command-line flags and parameters are deliberately rejected");
  });

  it("states honest security posture, superuser warning, and least-privilege role template", () => {
    expect(readme).toContain("Security Posture (Stated Honestly)");
    expect(readme).toContain("What QueryIO Enforces");
    expect(readme).toContain("What Is Best-Effort");
    expect(readme).toContain("What Is Not Guaranteed");
    expect(readme).toContain("Name-Based Redaction");

    // Superuser warning & least-privilege template
    expect(readme).toContain("Connecting as a PostgreSQL superuser destroys the meaningful security boundary");
    expect(readme).toContain("CREATE ROLE queryio_role WITH LOGIN PASSWORD");
    expect(readme).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO queryio_role");

    // Safe default path vs sandbox
    expect(readme).toContain("QueryIO is the safe default path, not a sandbox");
    expect(readme).toContain("can read `DATABASE_URL` from `.env`");

    // Read-oriented gate as mistake catcher
    expect(readme).toContain("The Read-Oriented Gate Is a Mistake Catcher, Not Security");
  });

  it("documents resource-bound tradeoffs", () => {
    expect(readme).toContain("Resource-Bound Tradeoffs");
    expect(readme).toContain("Bounded retrieval limits QueryIO's memory, not Postgres's work");
    expect(readme).toContain("Single wide rows are fetched whole");
    expect(readme).toContain("`has_more` replaces exact omitted counts");
  });

  it("defers benchmark claims until issue 12 produces results", () => {
    expect(readme).toContain("Evaluation & Benchmarks");
    expect(readme).not.toMatch(/\b30%\s+faster\b/i);
    expect(readme).not.toMatch(/\bbenchmark claims\b/i);
  });
});

describe("Clean first-run flow against real Postgres (in under 2 minutes)", () => {
  let tempDir: string;
  let tarballPath: string;

  async function dropTestTables(): Promise<void> {
    await sql(`
      DROP TABLE IF EXISTS readme_orders;
      DROP TABLE IF EXISTS readme_users;
    `);
  }

  async function assertCompletesUnder(limitMs: number, operation: () => Promise<void> | void): Promise<void> {
    const startTime = Date.now();
    await operation();
    const elapsedMs = Date.now() - startTime;
    expect(elapsedMs).toBeLessThan(limitMs);
  }

  beforeAll(async () => {
    await dropTestTables();

    await sql(`
      CREATE TABLE readme_users (
        id INT PRIMARY KEY,
        email TEXT NOT NULL,
        status TEXT NOT NULL,
        token TEXT NOT NULL
      );

      CREATE TABLE readme_orders (
        id INT PRIMARY KEY,
        user_id INT NOT NULL REFERENCES readme_users(id),
        total NUMERIC(10, 2) NOT NULL
      );

      INSERT INTO readme_users (id, email, status, token)
      VALUES (4821, 'user4821@example.com', 'pending', 'super_secret_xyz');

      INSERT INTO readme_orders (id, user_id, total)
      VALUES (101, 4821, 99.95), (102, 4821, 14.50);

      ANALYZE readme_users;
      ANALYZE readme_orders;
    `);

    tempDir = mkdtempSync(join(tmpdir(), "queryio-readme-firstrun-"));
    execSync("npm run build", { stdio: "ignore" });
    const packOutput = execSync(`npm pack --json --ignore-scripts --pack-destination "${tempDir}"`, {
      encoding: "utf8",
    });
    const [packageInfo] = JSON.parse(packOutput);
    tarballPath = join(tempDir, packageInfo.filename);
  }, 60_000);

  afterAll(async () => {
    await dropTestTables();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it("runs queryio check and completes in under two minutes", async () => {
    await assertCompletesUnder(120_000, () => {
      const checkProcess = spawnSync("npx", ["-y", "--package", tarballPath, "queryio", "check"], {
        cwd: tempDir,
        env: { ...process.env, QUERYIO_DATABASE_URL: TEST_URL },
        encoding: "utf8",
        shell: process.platform === "win32",
        timeout: 30_000,
      });

      expect(checkProcess.status).toBe(0);
      expect(checkProcess.stdout).toContain("QueryIO Check");
      expect(checkProcess.stdout).toContain("Connectivity:            ok");
      expect(checkProcess.stdout).toContain("CREATE ROLE queryio_role WITH LOGIN PASSWORD");
    });
  });

  it("runs MCP stdio server and answers agent queries in under two minutes", async () => {
    const auditLogPath = join(tempDir, "first_run_audit.jsonl");

    await assertCompletesUnder(120_000, async () => {
      const transport = new StdioClientTransport({
        command: "npx",
        args: ["-y", "--package", tarballPath, "queryio"],
        cwd: tempDir,
        env: {
          ...(process.env as Record<string, string>),
          QUERYIO_DATABASE_URL: TEST_URL,
          QUERYIO_AUDIT_LOG: auditLogPath,
        },
      });

      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(transport);

      try {
        // Step 4 hero flow: agent inspects row and foreign key relations
        const callResult = await client.callTool({
          name: "inspect_row",
          arguments: {
            table: "public.readme_users",
            key: { id: 4821 },
          },
        });

        const inspectResult = callResult.structuredContent as any;
        expect(inspectResult).toBeDefined();
        expect(inspectResult.table).toBe("public.readme_users");
        expect(inspectResult.row).toContain(4821);
        expect(inspectResult.row).toContain("pending");
        // Secret token column is redacted
        expect(inspectResult.row).toContain("[redacted]");

        // Relations include incoming FK from readme_orders
        expect(inspectResult.relations).toHaveLength(1);
        const orderRelation = inspectResult.relations[0];
        expect(orderRelation.table).toBe("public.readme_orders");
        expect(orderRelation.direction).toBe("incoming");
        expect(orderRelation.rows_returned).toBe(2);
        expect(orderRelation.has_more).toBe(false);

        // Verify audit log received an operational event
        expect(existsSync(auditLogPath)).toBe(true);
        const auditLines = readFileSync(auditLogPath, "utf8").trim().split("\n");
        expect(auditLines.length).toBeGreaterThanOrEqual(1);
        const auditEvent = JSON.parse(auditLines[0]);
        expect(auditEvent.tool).toBe("inspect_row");
        expect(auditEvent.success).toBe(true);
      } finally {
        await client.close();
      }
    });
  });
});
