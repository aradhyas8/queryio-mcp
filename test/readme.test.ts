import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DANGEROUS_PREDEFINED_ROLES } from "../src/role.js";
import { loadSettings } from "../src/settings.js";
import { TEST_URL, sql } from "./db.js";

describe("README specification coverage", () => {
  const root = join(__dirname, "..");
  const paths = ["README.md", "docs/reference.md", "docs/security.md", "docs/contributing.md", "docs/positioning.md"];
  let documents: Record<string, string>;
  let readme: string;
  let reference: string;
  let security: string;
  const defaults = loadSettings({ QUERYIO_DATABASE_URL: TEST_URL });

  beforeAll(() => {
    documents = Object.fromEntries(paths.map((path) => {
      const absolute = join(root, path);
      expect(existsSync(absolute), path).toBe(true);
      return [path, readFileSync(absolute, "utf8").replaceAll("\r\n", "\n")];
    }));
    readme = documents["README.md"];
    reference = documents["docs/reference.md"];
    security = documents["docs/security.md"];
  });

  function toolDoc(name: string): string {
    const heading = `### \`${name}\``;
    expect(reference).toContain(heading);
    return reference.split(heading)[1].split("\n### ")[0];
  }

  it("documents first run in four steps with client examples", () => {
    for (const heading of [
      "## Quick start",
      "### 1. Set the database connection",
      "### 2. Check the connection",
      "### 3. Connect your coding agent",
      "### 4. Ask a debugging question",
    ]) expect(readme).toContain(heading);
    expect(readme).toContain("npx -y queryio check");
    expect(readme).toContain("npx -y queryio setup");
    expect(readme).toContain("#### Manual configuration");
    expect(readme).toContain("never writes it to a file");
    expect(reference).toContain("## Setup wizard");
    for (const file of [".mcp.json", "~/.claude.json", ".codex/config.toml", "~/.codex/config.toml", ".cursor/mcp.json", "~/.cursor/mcp.json"]) {
      expect(reference).toContain(`\`${file}\``);
    }
    expect(readme).toContain("export QUERYIO_DATABASE_URL=");
    expect(readme).toContain("$env:QUERYIO_DATABASE_URL =");
    expect(readme).toContain("Node.js 20+");
    expect(readme).toContain("Claude Code");
    expect(readme).toContain(".mcp.json");
    expect(readme).toContain('"QUERYIO_DATABASE_URL": "${QUERYIO_DATABASE_URL}"');
    expect(reference).toContain("claude mcp add queryio --transport stdio --scope user");
    expect(reference).toContain("~/.claude.json");
    expect(reference).toContain("--scope project");
    expect(readme + reference).not.toContain(".claude/mcp.json");
    expect(readme).toContain("##### Codex");
    expect(readme).toContain("~/.codex/config.toml");
    expect(readme).toContain("[mcp_servers.queryio]");
    expect(readme).toContain('env_vars = ["QUERYIO_DATABASE_URL"]');
    expect(reference).toContain("codex mcp add queryio --env QUERYIO_DATABASE_URL=");
    expect(reference).toContain("Run from source");
    expect(documents["docs/contributing.md"]).toContain("npx -y --package PATH_TO_TARBALL queryio check");
    expect(readme + reference).not.toMatch(/queryio-\d+\.\d+\.\d+\.tgz/);
    expect(readme).not.toContain("Under 2 Minutes");
  });

  it("describes the four tools and their input/output contracts", () => {
    for (const name of ["inspect_row", "describe_tables", "list_tables", "query"]) {
      expect(readme).toContain(`| \`${name}\` |`);
      toolDoc(name);
    }
    const inspect = toolDoc("inspect_row");
    for (const field of [
      "table", "key", "columns", "row", "relations", "relations_not_attempted", "values_truncated",
      "values_redacted", "duration_ms", "direction", "constraint", "source_columns", "target_columns",
      "status", "order_by", "rows", "rows_returned", "has_more", "ok", "timeout", "error",
      "outgoing", "incoming", "max_relations", "deadline",
    ]) expect(inspect).toContain(`\`${field}\``);
    const query = toolDoc("query");
    for (const field of [
      "columns", "rows", "row_count", "has_more", "truncated_by", "values_truncated",
      "columns_redacted", "values_redacted", "duration_ms",
    ]) expect(query).toContain(`\`${field}\``);
    expect(query).toContain('"rows"');
    expect(query).toContain('"bytes"');
    expect(query).toContain("`null` when retrieval completed");
    expect(query).toContain("no continuation token");
    expect(toolDoc("list_tables")).toContain("{ tables: [{ name, estimated_rows, columns }] }");
    const describe = toolDoc("describe_tables");
    for (const field of ["primary_key", "foreign_keys_out", "foreign_keys_in", "indexes", "stats_available", "null_frac", "n_distinct", "common_values"]) {
      expect(describe).toContain(`\`${field}\``);
    }
    expect(describe).toContain("per-table `{ name, error }`");
  });

  it("documents the structured error contract and payload shape matching code", () => {
    const errors = reference.split("## Structured errors")[1].split("\n## ")[0];
    for (const category of [
      "timeout", "lock_timeout", "read_only", "syntax_error_or_access_rule_violation",
      "integrity_constraint_violation", "connection_exception", "postgres_error", "client_error",
      "read_oriented", "not_found", "no_primary_key", "key_mismatch", "row_not_found",
    ]) expect(errors).toContain(`\`${category}\``);
    expect(errors).toMatch(/\{\s*error:\s*\{\s*category,\s*code,\s*message,\s*hint\s*\}/);
    expect(errors).toContain("`isError: true`");
    expect(errors).toContain("`code` and `hint` are omitted when unavailable");
    const example = JSON.parse(errors.match(/```json\n([\s\S]*?)\n```/)![1]);
    expect(example).toEqual({ error: { category: "timeout", code: "57014", message: "canceling statement due to statement timeout" } });
  });

  it("lists all configuration knobs, defaults, byte-cap scope, and explains CLI flags policy", () => {
    const rows = [...reference.matchAll(/^\| `(QUERYIO_[A-Z_]+)` \| ([^|]+) \|/gm)];
    const documented = Object.fromEntries(rows.map((row) => [row[1], row[2].trim().replaceAll("`", "")]));
    expect(documented).toEqual({
      QUERYIO_DATABASE_URL: "Required",
      QUERYIO_STATEMENT_TIMEOUT_MS: String(defaults.statementTimeoutMs),
      QUERYIO_LOCK_TIMEOUT_MS: String(defaults.lockTimeoutMs),
      QUERYIO_MAX_ROWS: String(defaults.maxRows),
      QUERYIO_MAX_RESPONSE_BYTES: String(defaults.maxResponseBytes),
      QUERYIO_MAX_VALUE_LENGTH: String(defaults.maxValueLength),
      QUERYIO_INSPECT_RELATED_ROWS: String(defaults.inspectRelatedRows),
      QUERYIO_INSPECT_MAX_RELATIONS: String(defaults.inspectMaxRelations),
      QUERYIO_INSPECT_DEADLINE_MS: String(defaults.inspectDeadlineMs),
      QUERYIO_AUDIT_LOG: "~/.queryio/audit.jsonl",
      QUERYIO_AUDIT_INCLUDE_SQL: String(defaults.auditIncludeSql),
      QUERYIO_REDACT_ADD: "Empty",
      QUERYIO_REDACT_REMOVE: "Empty",
    });
    expect(reference).toContain("other command-line arguments, including connection strings, are rejected with exit code 2");
    expect(reference).toContain("bounds `query` only");
    for (const name of defaults.redactPatterns) expect(reference).toContain(`\`${name}\``);
    expect(reference).toContain("exact and case-insensitive, not a substring or content scan");
  });

  it("states honest security posture, superuser warning, dedicated role template, and security caveats", () => {
    expect(readme).toContain("QueryIO is not a complete security sandbox");
    for (const mechanism of ["BEGIN READ ONLY", "ROLLBACK", "statement_timeout", "lock_timeout", "extended-protocol cursor"]) {
      expect(security).toContain(mechanism);
    }
    expect(security).toContain("mistake catcher, not a security boundary");
    expect(security).toContain("side-effecting function");
    expect(security).toContain("QueryIO reports warnings but does not refuse privileged roles");
    expect(security).toContain("CREATE ROLE queryio_role WITH LOGIN PASSWORD");
    expect(security).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO queryio_role");
    expect(security).toContain("default_transaction_read_only = on");
    expect(security).toMatch(/ALTER DEFAULT PRIVILEGES.*created by the role that runs it/i);
    for (const role of DANGEROUS_PREDEFINED_ROLES) expect(security).toContain(role);
    expect(security).toMatch(/role shared with the application.*terminate.*application's backends/i);
    expect(security).toMatch(/dblink.*FDWs.*beyond the local read-only transaction/i);
    expect(security).toContain("exact column names, case-insensitively");
    expect(security).toContain("does not inspect content or nested JSON");
    expect(security).toContain("SELECT password_hash AS another_name");
    expect(security).toContain("do not rely on QueryIO redaction for access control");
    expect(security).toContain("shell access and alternative credentials can bypass QueryIO entirely");
    expect(security).toContain("client's policies");
  });

  it("documents resource-bound tradeoffs", () => {
    expect(security).toContain("Returned rows do not bound PostgreSQL work");
    expect(security).toContain("Wide values are received before truncation");
    expect(security).toContain("no equivalent total byte cap");
    expect(security).toContain("Catalog results are not globally capped");
    expect(toolDoc("inspect_row")).toContain("without an exact omitted count");
    expect(toolDoc("query")).toContain("Use an explicit `COUNT(*)` when you need a total count");
    expect(reference).toContain("column metadata alone can exceed a very small budget");
    expect(reference).toContain("MCP wrapping and role warnings add bytes");
  });

  it("summarizes benchmark findings from BENCHMARK.md without duplicating tables", () => {
    const benchmark = readFileSync(join(root, "BENCHMARK.md"), "utf8");
    expect(readme).toContain("## Benchmarks");
    expect(readme).toContain("BENCHMARK.md");
    expect(readme).not.toMatch(/\|.*Forensic Tasks.*\|/);
    expect(readme).not.toMatch(/\|.*Task Category.*\|/);
    expect(readme).not.toMatch(/\|.*Arm A \(Raw `psql`\).*\|/);
    expect(readme).toMatch(/25(-|\s+)run/i);
    expect(readme).toContain("forensic");
    expect(readme).toContain("did not meet the pre-declared win condition");
    for (const result of ["38.5%", "20.7%", "27.9%", "14.0%", "23 failed operations"]) {
      expect(readme).toContain(result);
      expect(benchmark).toContain(result);
    }
    expect(readme).toContain("CLI shim rather than QueryIO's MCP transport");
    expect(readme).toContain("two runs per task");
    expect(readme).toContain("one for DBHub");
    expect(readme).toContain("does not establish that QueryIO outperforms DBHub");
  });

  it("uses npm-portable README links and resolves repository files and anchors", () => {
    const repositoryFiles = "https://github.com/aradhyas8/queryio-mcp/blob/main/";
    expect(readme).toContain(`[BENCHMARK.md](${repositoryFiles}BENCHMARK.md)`);
    for (const path of paths.slice(1)) expect(readme).toContain(`](${repositoryFiles}${path})`);
    for (const [path, document] of Object.entries(documents)) {
      expect(document).not.toContain("file:///");
      for (const [, target] of document.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (path === "README.md") expect(target, target).toMatch(/^(https:\/\/|#)/);
        const repositoryLink = target.startsWith(repositoryFiles);
        if (/^[a-z]+:/i.test(target) && !repositoryLink) continue;
        const [relative, fragment] = decodeURIComponent(repositoryLink ? target.slice(repositoryFiles.length) : target).split("#");
        const absolute = repositoryLink ? resolve(root, relative)
          : relative ? resolve(dirname(join(root, path)), relative) : join(root, path);
        expect(existsSync(absolute), `${path}: ${target}`).toBe(true);
        if (!fragment) continue;
        const linked = readFileSync(absolute, "utf8");
        const headings = [...linked.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
          match[1].trim().toLowerCase().replace(/[^\w -]/g, "").replaceAll(" ", "-"),
        );
        const aliases = [...linked.matchAll(/<a id="([^"]+)"/g)].map((match) => match[1]);
        expect([...headings, ...aliases], `${path}: ${target}`).toContain(fragment);
      }
    }
  });

  it("keeps inspect_row positioning explicit about its value and relationship limits", () => {
    const hero = readme.split("## Example:")[0];
    expect(hero).toContain("PostgreSQL MCP server for debugging with AI coding agents");
    expect(hero).toContain("`inspect_row`");
    expect(hero).toContain("bounded samples of its immediate declared foreign-key relationships");
    expect(hero).toContain("in both directions, in one call");
    expect(readme).toContain("requires a declared primary key");
    expect(readme).toContain("only declared foreign keys, one level deep");
    expect(readme).toContain(`${defaults.inspectRelatedRows} rows per relation, ${defaults.inspectMaxRelations} relations`);
    expect(readme).toContain(`${defaults.inspectDeadlineMs / 1000}-second inspection budget`);
    expect(readme).toContain("**not by recency**");
    expect(readme).toContain("bounded sample of immediate relationships");
    const inspect = toolDoc("inspect_row");
    expect(inspect).toContain("exactly every primary key column");
    expect(inspect).toContain("outside JavaScript's safe integer range as strings");
    expect(inspect).toContain("Relationships without declared foreign keys need `query`");
    expect(inspect).toContain("A failed relation is not evidence that no related records exist");
    expect(inspect).toContain("not a hard wall-clock limit on pool connection acquisition");
    expect(documents["docs/positioning.md"]).toContain("One MCP call executes several internal SQL statements");
  });

  it("provides parseable JSON examples and the documented stdio client configurations", () => {
    for (const document of Object.values(documents)) {
      expect(document.match(/```/g)!.length % 2).toBe(0);
      for (const [, snippet] of document.matchAll(/^\s*```json\n([\s\S]*?)^\s*```/gm)) {
        const parsed = JSON.parse(snippet);
        if (!parsed.mcpServers) continue;
        expect(parsed.mcpServers.queryio).toMatchObject({ type: "stdio", command: "npx", args: ["-y", "queryio"] });
        expect(parsed.mcpServers.queryio.env.QUERYIO_DATABASE_URL).toBe(
          document === readme ? "${QUERYIO_DATABASE_URL}" : "${env:QUERYIO_DATABASE_URL}",
        );
      }
    }
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

  it("packages the current README and npm discovery metadata", () => {
    const root = join(__dirname, "..");
    const packedReadme = execFileSync("tar", ["-xOf", tarballPath, "package/README.md"], { encoding: "utf8" });
    expect(packedReadme.replaceAll("\r\n", "\n")).toBe(readFileSync(join(root, "README.md"), "utf8").replaceAll("\r\n", "\n"));
    const packedManifest = JSON.parse(execFileSync("tar", ["-xOf", tarballPath, "package/package.json"], { encoding: "utf8" }));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    expect(lockfile.version).toBe(manifest.version);
    expect(lockfile.packages[""].version).toBe(manifest.version);
    expect(packedManifest).toMatchObject({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      keywords: manifest.keywords,
      bin: manifest.bin,
      engines: manifest.engines,
    });
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
