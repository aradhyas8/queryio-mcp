import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectClients, redactEntry, runSetup, targetFor, type Context } from "../src/setup.js";
import { ADMIN_URL, TEST_DB, sql } from "./db.js";

let root: string;
let ctx: Context;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "queryio-setup-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "proj"));
  // Empty PATH: no real client CLI is detected or run, and no real user config is touched.
  ctx = { cwd: join(root, "proj"), home: join(root, "home"), platform: process.platform, env: { PATH: "" } };
});

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));

async function setup(answers: string[], overrides: Partial<Context> & { serverEntry?: string } = {}) {
  let output = "";
  const code = await runSetup({
    ...ctx,
    ...overrides,
    io: { lines: (async function* () { yield* answers; })(), write: (text) => { output += text; } },
  });
  return { code, output };
}

const proj = (...p: string[]) => join(root, "proj", ...p);
const home = (...p: string[]) => join(root, "home", ...p);
const json = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const backupDir = () => home(".queryio", "backups");
const backups = () => (existsSync(backupDir()) ? readdirSync(backupDir()) : []);
const { command, args } = process.platform === "win32"
  ? { command: "cmd", args: ["/c", "npx", "-y", "queryio"] }
  : { command: "npx", args: ["-y", "queryio"] };

describe("client selection", () => {
  it("defaults to detected clients and explains undetected ones", async () => {
    mkdirSync(home(".cursor"));
    expect(detectClients(ctx)).toMatchObject({ claude: null, codex: null, cursor: home(".cursor") });
    const { code, output } = await setup(["", "", "y"]);
    expect(output).toMatch(/3\) Cursor\s+detected/);
    expect(output).toContain("Select clients (comma-separated numbers) [3]");
    expect(code).toBe(1); // configured, but no connection variable
    expect(existsSync(proj(".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(proj(".mcp.json"))).toBe(false);
  });

  it("re-prompts on invalid input and configures several clients", async () => {
    const { output } = await setup(["9", "1, 2,3", "", "y"]);
    expect(output).toContain("No supported client was detected");
    expect(output).toContain("Enter numbers between 1 and 3");
    expect(output).toContain("Claude Code was not detected");
    for (const file of [proj(".mcp.json"), proj(".codex", "config.toml"), proj(".cursor", "mcp.json")]) {
      expect(existsSync(file), file).toBe(true);
    }
  });
});

describe("configuration formats and scopes", () => {
  it("writes project configs that reference the variable instead of its value", async () => {
    await setup(["1,2,3", "1", "y"]);
    expect(json(proj(".mcp.json"))).toEqual({
      mcpServers: { queryio: { type: "stdio", command, args, env: { QUERYIO_DATABASE_URL: "${QUERYIO_DATABASE_URL}" } } },
    });
    expect(json(proj(".cursor", "mcp.json"))).toEqual({
      mcpServers: { queryio: { type: "stdio", command, args, env: { QUERYIO_DATABASE_URL: "${env:QUERYIO_DATABASE_URL}" } } },
    });
    expect(parseToml(readFileSync(proj(".codex", "config.toml"), "utf8"))).toEqual({
      mcp_servers: { queryio: { command, args, env_vars: ["QUERYIO_DATABASE_URL"] } },
    });
    expect(existsSync(home(".claude.json"))).toBe(false);
  });

  it("writes global configs only after explicit approval, honoring CLAUDE_CONFIG_DIR and CODEX_HOME", async () => {
    const env = { PATH: "", CLAUDE_CONFIG_DIR: home("claude-dir"), CODEX_HOME: home("codex-dir") };
    const declined = await setup(["1,2,3", "2", "n"], { env });
    expect(declined.code).toBe(130);
    expect(readdirSync(home())).toEqual([]);

    const { output } = await setup(["1,2,3", "2", "y", "y"], { env });
    expect(output).toContain("every project");
    expect(json(home("claude-dir", ".claude.json")).mcpServers.queryio.env).toEqual({ QUERYIO_DATABASE_URL: "${QUERYIO_DATABASE_URL}" });
    expect(parseToml(readFileSync(home("codex-dir", "config.toml"), "utf8"))).toHaveProperty("mcp_servers.queryio.env_vars");
    expect(existsSync(home(".cursor", "mcp.json"))).toBe(true);
    expect(readdirSync(proj())).toEqual([]);
  });

  it("computes Windows paths and wraps npx with cmd /c", () => {
    const win: Context = {
      cwd: "C:\\work\\app", home: "C:\\Users\\dev", platform: "win32",
      env: { Path: "C:\\Windows", codex_home: "D:\\codex" },
    };
    expect(targetFor("claude", "project", win).file).toBe("C:\\work\\app\\.mcp.json");
    expect(targetFor("claude", "global", win).file).toBe("C:\\Users\\dev\\.claude.json");
    expect(targetFor("cursor", "project", win).file).toBe("C:\\work\\app\\.cursor\\mcp.json");
    expect(targetFor("cursor", "global", win).file).toBe("C:\\Users\\dev\\.cursor\\mcp.json");
    expect(targetFor("codex", "project", win).file).toBe("C:\\work\\app\\.codex\\config.toml");
    expect(targetFor("codex", "global", win).file).toBe("D:\\codex\\config.toml"); // case-insensitive variable
    expect(targetFor("claude", "project", win).entry).toMatchObject({ command: "cmd", args: ["/c", "npx", "-y", "queryio"] });
    expect(targetFor("codex", "global", { ...win, platform: "linux", home: "/home/dev", env: {} }).file).toBe("/home/dev/.codex/config.toml");
  });
});

describe("existing configuration", () => {
  it("preserves other servers, unrelated settings, indentation, and line endings", async () => {
    writeFileSync(proj(".mcp.json"), '{\r\n    "mcpServers": {\r\n        "other": { "command": "x" }\r\n    },\r\n    "extra": [1, 2]\r\n}\r\n');
    mkdirSync(proj(".codex"));
    writeFileSync(proj(".codex", "config.toml"), '# keep me\nmodel = "m"\n\n[mcp_servers.other]\ncommand = "x"\n\n[profiles.fast]\nmodel = "n"\n');
    const { output } = await setup(["1,2", "1", "y"]);
    expect(output).toContain("Other settings in this file are preserved");

    const mcp = readFileSync(proj(".mcp.json"), "utf8");
    expect(mcp).toContain('\r\n    "mcpServers": {\r\n        "other"');
    expect(JSON.parse(mcp)).toMatchObject({ mcpServers: { other: { command: "x" }, queryio: { command } }, extra: [1, 2] });
    const toml = readFileSync(proj(".codex", "config.toml"), "utf8");
    expect(toml.startsWith('# keep me\nmodel = "m"\n')).toBe(true);
    expect(parseToml(toml)).toMatchObject({ model: "m", mcp_servers: { other: { command: "x" }, queryio: { command } }, profiles: { fast: { model: "n" } } });
    // Backups live outside the project so they cannot be committed with it.
    expect(backups()).toHaveLength(2);
    expect(readdirSync(proj()).sort()).toEqual([".codex", ".mcp.json"]);
    expect(readdirSync(proj(".codex"))).toEqual(["config.toml"]);
  });

  it("is a no-op on repeated runs", async () => {
    await setup(["1,2,3", "1", "y"]);
    const before = ["", ".cursor", ".codex"].map((d) => readdirSync(proj(d)).sort());
    const files = [proj(".mcp.json"), proj(".codex", "config.toml"), proj(".cursor", "mcp.json")].map((f) => readFileSync(f, "utf8"));
    const { output } = await setup(["1,2,3", "1"]); // no write confirmation is asked
    expect(output.match(/already configured here/g)).toHaveLength(3);
    expect(output).not.toContain("Write ");
    expect(["", ".cursor", ".codex"].map((d) => readdirSync(proj(d)).sort())).toEqual(before);
    expect([proj(".mcp.json"), proj(".codex", "config.toml"), proj(".cursor", "mcp.json")].map((f) => readFileSync(f, "utf8"))).toEqual(files);
  });

  it("asks before replacing a different QueryIO entry, hiding stored credentials", async () => {
    const stored = "postgres://admin:hunter2-secret@db.internal:5432/prod";
    const original = JSON.stringify({ mcpServers: { queryio: { command: "node", args: ["old.js"], env: { QUERYIO_DATABASE_URL: stored } } } });
    writeFileSync(proj(".mcp.json"), original);

    const kept = await setup(["1", "1", "n"]);
    expect(kept.output).toContain("<hidden connection string>");
    expect(kept.output).not.toContain("hunter2");
    expect(kept.output).toContain("Skipped; existing entry kept.");
    expect(readFileSync(proj(".mcp.json"), "utf8")).toBe(original);

    const replaced = await setup(["1", "1", "y", "y"]);
    expect(replaced.output).not.toContain("hunter2");
    expect(replaced.output).toContain("the backup keeps a copy");
    expect(json(proj(".mcp.json")).mcpServers.queryio.env.QUERYIO_DATABASE_URL).toBe("${QUERYIO_DATABASE_URL}");
    const [backup] = backups();
    expect(readFileSync(join(backupDir(), backup), "utf8")).toBe(original);
    expect(replaced.output).toContain(join(backupDir(), backup));
    expect(replaced.output).toContain("This backup contains the previous stored connection value");
    if (process.platform !== "win32") expect(statSync(join(backupDir(), backup)).mode & 0o777).toBe(0o600);
    expect(readdirSync(proj())).toEqual([".mcp.json"]);
  });

  it("replaces an existing Codex table and its subtables", async () => {
    mkdirSync(proj(".codex"));
    writeFileSync(proj(".codex", "config.toml"), '[mcp_servers.queryio]\ncommand = "old"\n\n[mcp_servers.queryio.env]\nQUERYIO_DATABASE_URL = "postgres://u:pw@h/db"\n\n[mcp_servers.other]\ncommand = "x"\n');
    const { output } = await setup(["2", "1", "y", "y"]);
    expect(output).not.toContain("pw@");
    expect(parseToml(readFileSync(proj(".codex", "config.toml"), "utf8"))).toEqual({
      mcp_servers: { queryio: { command, args, env_vars: ["QUERYIO_DATABASE_URL"] }, other: { command: "x" } },
    });
  });

  it("leaves malformed files untouched and still configures other clients", async () => {
    writeFileSync(proj(".mcp.json"), "{ // comment\n  \"mcpServers\": {");
    mkdirSync(proj(".codex"));
    writeFileSync(proj(".codex", "config.toml"), "[mcp_servers.queryio\ncommand =");
    const { code, output } = await setup(["1,2,3", "1", "y"]);
    expect(output).toContain("Left unchanged: not valid JSON");
    expect(output).toContain("Left unchanged: not valid TOML");
    expect(output).toContain("To configure it manually, add:");
    expect(readFileSync(proj(".mcp.json"), "utf8")).toBe("{ // comment\n  \"mcpServers\": {");
    expect(readFileSync(proj(".codex", "config.toml"), "utf8")).toBe("[mcp_servers.queryio\ncommand =");
    expect(existsSync(proj(".cursor", "mcp.json"))).toBe(true);
    expect(code).toBe(1);
  });

  it("refuses a non-object mcpServers value", async () => {
    writeFileSync(proj(".mcp.json"), '{"mcpServers": []}');
    const { output } = await setup(["1", "1"]);
    expect(output).toContain('"mcpServers" is not an object');
  });
});

describe("cancellation", () => {
  it("writes nothing when input ends or the write is declined", async () => {
    expect((await setup(["1,3"])).code).toBe(130);
    const declined = await setup(["1,3", "1", "n"]);
    expect(declined.code).toBe(130);
    expect(declined.output).toContain("Setup cancelled. No files were changed.");
    expect(readdirSync(proj())).toEqual([]);
  });
});

describe("credentials", () => {
  it("explains how to provide a missing connection variable and does not claim completion", async () => {
    const { code, output } = await setup(["3", "1", "y"]);
    expect(code).toBe(1);
    expect(output).toContain("QUERYIO_DATABASE_URL is not set in this terminal");
    expect(output).toContain("read -rs QUERYIO_DATABASE_URL");
    expect(output).toContain("setup is not complete");
    expect(output).toContain("Cursor opened from the Dock");
    expect(output).not.toContain("PostgreSQL is reachable");
  });

  it("checks the database, starts the server, and never prints or stores the connection string", async () => {
    const role = "queryio_setup_role";
    const password = "s3tup-Pa55word-unique";
    const dropRole = `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN EXECUTE 'DROP OWNED BY ${role}'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`;
    await sql(`${dropRole} CREATE ROLE ${role} WITH LOGIN PASSWORD '${password}'; GRANT CONNECT ON DATABASE ${TEST_DB} TO ${role};`);
    const url = new URL(ADMIN_URL);
    url.username = role;
    url.password = password;
    url.pathname = `/${TEST_DB}`;
    execSync("npm run build", { stdio: "ignore" });
    try {
      const { code, output } = await setup(["1,2,3", "1", "y"], {
        env: { ...process.env, PATH: "", QUERYIO_DATABASE_URL: url.toString(), QUERYIO_AUDIT_LOG: "off" },
        serverEntry: join(__dirname, "..", "dist", "cli.js"),
      });
      expect(output).toContain(`as role "${role}"`);
      expect(output).toContain("superuser: no");
      expect(output).toMatch(/QueryIO MCP server: started; tools: .*inspect_row/);
      expect(output).toContain("PostgreSQL is reachable from this terminal");
      expect(code).toBe(0);
      const written = [proj(".mcp.json"), proj(".codex", "config.toml"), proj(".cursor", "mcp.json")].map((f) => readFileSync(f, "utf8")).join("");
      for (const text of [output, written]) {
        expect(text).not.toContain(password);
        expect(text).not.toContain(url.toString());
      }
    } finally {
      await sql(dropRole);
    }
  }, 60_000);

  it("reports a failed connection without leaking the password", async () => {
    const { code, output } = await setup(["3", "1", "y"], {
      env: { PATH: "", QUERYIO_DATABASE_URL: "postgres://nobody:leak-me-pw@127.0.0.1:1/none", QUERYIO_AUDIT_LOG: "off" },
    });
    expect(code).toBe(1);
    expect(output).toContain("could not connect to PostgreSQL");
    expect(output).not.toContain("leak-me-pw");
  });

  it("redacts literal values in existing entries", () => {
    expect(redactEntry({ args: ["postgres://a:b@h/d"], env: { QUERYIO_DATABASE_URL: "plain", OTHER: "${OTHER}" } })).toEqual({
      args: ["<hidden connection string>"], env: { QUERYIO_DATABASE_URL: "<hidden>", OTHER: "${OTHER}" },
    });
  });
});
