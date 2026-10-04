#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCore, type CheckResult } from "./core.js";
import { createServer } from "./mcp.js";
import { loadSettings, type Settings } from "./settings.js";

const isCheck = process.argv.length === 3 && process.argv[2] === "check";
if (process.argv.length > 2 && !isCheck) {
  console.error("Usage: queryio [check]   (set QUERYIO_DATABASE_URL; command-line arguments are not accepted)");
  process.exit(2);
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
    lines.push("  none (role is least-privileged)");
  } else {
    for (const warning of result.warnings) {
      lines.push(`  ⚠ ${warning}`);
    }
  }

  lines.push("", "Dedicated least-privilege role SQL template:", "--------------------------------------------", result.role_template);

  return lines.join("\n");
}
