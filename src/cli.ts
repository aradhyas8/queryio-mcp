#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCore, type CheckResult } from "./core.js";
import { createServer } from "./mcp.js";
import { loadSettings, type Settings } from "./settings.js";
import type { ClientId } from "./setup.js";

const setupFlags: Record<string, ClientId> = { "--claude": "claude", "--codex": "codex", "--cursor": "cursor" };
const setupArgs = process.argv.slice(3);
const isCheck = process.argv.length === 3 && process.argv[2] === "check";
const isSetup = process.argv[2] === "setup" && setupArgs.every((arg) => Object.hasOwn(setupFlags, arg));
if (process.argv.length > 2 && !isCheck && !isSetup) {
  // Name an unknown flag only when it looks like a flag: other arguments may be connection strings.
  const unknown = process.argv[2] === "setup" ? setupArgs.find((arg) => !Object.hasOwn(setupFlags, arg)) : undefined;
  if (unknown !== undefined) {
    console.error(/^--[a-z][a-z0-9-]{0,30}$/.test(unknown) ? `queryio: unsupported setup option ${unknown}` : "queryio: setup accepts only --claude, --codex, and --cursor");
  }
  console.error("Usage: queryio [check|setup]\n       queryio setup [--claude] [--codex] [--cursor]\nSet QUERYIO_DATABASE_URL; other command-line arguments are not accepted.");
  process.exit(2);
}

if (isSetup) {
  // Setup never takes the connection string; it runs before settings are loaded so it can guide users without one.
  const { createInterface } = await import("node:readline");
  const { homedir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { runSetup } = await import("./setup.js");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  rl.on("SIGINT", () => rl.close()); // Ctrl+C ends input, which cancels setup before anything is written.
  const code = await runSetup({
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    env: { ...process.env },
    io: { lines: rl[Symbol.asyncIterator](), write: (text) => process.stdout.write(text) },
    serverEntry: fileURLToPath(import.meta.url),
    preselectedClients: setupArgs.map((arg) => setupFlags[arg]),
  });
  rl.close();
  await new Promise((resolve) => process.stdout.write("", resolve)); // flush piped output before exiting
  process.exit(code);
}

let settings: Settings;
try {
  settings = loadSettings(process.env);
} catch (err) {
  console.error(`queryio: ${(err as Error).message}`);
  process.exit(1);
}

const core = createCore(settings);

if (isCheck) {
  try {
    const result = await core.check();
    console.log(formatCheckReport(result));
  } catch (err) {
    console.error(`queryio check: ${(err as Error).message}`);
    process.exit(1);
  } finally {
    await core.close();
  }
} else {
  const server = createServer(core);
  server.server.onclose = () => void core.close();
  // The stdio transport doesn't notice the client going away; without this, idle pool connections keep the process alive.
  process.stdin.on("end", () => void server.close());
  await server.connect(new StdioServerTransport());
}

function formatCheckReport(result: CheckResult): string {
  const lines: string[] = [
    "QueryIO Check",
    "=============",
    `Connectivity:            ${result.connectivity ? "ok" : "failed"}`,
    `PostgreSQL version:      ${result.version}`,
    `Connected database:      ${result.database}`,
    `Connected role:          ${result.role}`,
    `Superuser:               ${result.superuser ? "yes" : "no"}`,
    `Write privileges:        ${result.write_privileges ? "yes" : "none"}`,
    `Dangerous roles:         ${result.dangerous_roles.length > 0 ? result.dangerous_roles.join(", ") : "none"}`,
    `Planner statistics:      ${result.stats_available ? "available" : "not available (run ANALYZE for table statistics)"}`,
    `Audit log:               ${result.audit_log ?? "disabled"}`,
    "",
    "Active limits:",
    `  statement_timeout_ms:  ${result.limits.statement_timeout_ms}`,
    `  lock_timeout_ms:       ${result.limits.lock_timeout_ms}`,
    `  max_rows:              ${result.limits.max_rows}`,
    `  max_response_bytes:    ${result.limits.max_response_bytes}`,
    `  max_value_length:      ${result.limits.max_value_length}`,
    `  inspect_related_rows:  ${result.limits.inspect_related_rows}`,
    `  inspect_max_relations: ${result.limits.inspect_max_relations}`,
    `  inspect_deadline_ms:   ${result.limits.inspect_deadline_ms}`,
    "",
    "Redaction patterns:",
    `  ${result.redact_patterns.join(", ")}`,
    "",
    "Warnings:",
  ];

  if (result.warnings.length === 0) {
    lines.push("  none detected");
  } else {
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  lines.push("", "Dedicated read-only role SQL template:", "---------------------------------------", result.role_template);

  return lines.join("\n");
}
