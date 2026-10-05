#!/usr/bin/env node
// Harness self-check without an LLM: for each arm, start its MCP server behind the common recorder on
// a fresh sandbox, list tools, run one read query and one write attempt, then confirm both recorders saw
// the traffic and that nothing was written.
// Usage: node harness/probe.mjs [arm ...]
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ARMS } from "../configs/arms.mjs";
import { BASE_DB, BENCH_DIR, closeSandboxSessions, createSandbox, dropSandbox, sandboxWrites } from "./lib.mjs";
import { LogTail, sqlEvents, sqlMetrics } from "./postgres-recorder.mjs";

// One read and one write per arm, phrased for each server's own query tool.
const CALLS = {
  queryio: [["query", { sql: "SELECT count(*) FROM sales.salesorderheader" }], ["query", { sql: "DELETE FROM sales.salesreason" }]],
  dbhub: [["execute_sql", { sql: "SELECT count(*) FROM sales.salesorderheader" }], ["execute_sql", { sql: "DELETE FROM sales.salesreason" }]],
  "postgres-mcp": [
    ["postgres_mcp_list_connection_profiles", {}],
    ["postgres_mcp_connect", "@connect"],
    ["postgres_mcp_query", "@query:SELECT count(*) FROM sales.salesorderheader"],
    ["postgres_mcp_modify", "@modify:DELETE FROM sales.salesreason"],
  ],
  "psql-control": [["psql", { input: "SELECT count(*) FROM sales.salesorderheader;" }], ["psql", { input: "DELETE FROM sales.salesreason;" }]],
};

const arms = process.argv.slice(2).length ? process.argv.slice(2) : ["queryio", "dbhub", "postgres-mcp"];
const tail = new LogTail();
await tail.init();
let failed = false;

for (const arm of arms) {
  const sb = await createSandbox(BASE_DB);
  const privDir = mkdtempSync(join(tmpdir(), "qio-probe-"));
  const events = join(privDir, "mcp-events.jsonl");
  const launch = ARMS[arm].launch({ ...sb, privDir });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(BENCH_DIR, "harness", "mcp-recorder.mjs"), "--events", events, "--meta", JSON.stringify({ arm }), "--", launch.command, ...launch.args],
    env: { ...process.env, ...launch.env },
    cwd: mkdtempSync(join(tmpdir(), "qio-probe-cwd-")),
    stderr: "pipe",
  });
  const client = new Client({ name: "probe", version: "1" });
  console.log(`\n=== ${arm} (${sb.database})`);
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);
    let connectionId;
    for (let [name, args] of CALLS[arm]) {
      if (typeof args === "string") args = postgresMcpArgs(tools, name, args, connectionId);
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content ?? []).map((c) => c.text).join("\n");
      if (name === "postgres_mcp_connect") connectionId = JSON.parse(text).connectionId;
      console.log(`${name} ${JSON.stringify(args)} -> ${res.isError ? "ERROR " : ""}${text.slice(0, 300).replace(/\s+/g, " ")}`);
    }
  } catch (err) {
    failed = true;
    console.log(`FAILED: ${err.message}`);
  } finally {
    await client.close().catch(() => {});
  }
  await closeSandboxSessions(sb);
  await new Promise((r) => setTimeout(r, 500));
  await tail.poll();
  const sql = sqlEvents(tail.take(sb.role));
  const calls = readFileSync(events, "utf8").trim().split("\n").map(JSON.parse).filter((e) => e.kind === "tool_call");
  const writes = await sandboxWrites(sb);
  console.log(`recorder: ${calls.length} tool calls (${calls.filter((c) => !c.ok).length} failed); sql: ${JSON.stringify(sqlMetrics(sql))}; rows written: ${writes}`);
  for (const e of sql.filter((e) => e.kind !== "other").slice(0, 40)) console.log(`  [${e.kind}${e.control ? "/control" : ""}] ${(e.sql ?? e.message ?? "").slice(0, 140).replace(/\s+/g, " ")}`);
  if (!calls.length || !sql.length || writes !== 0) failed = true;
  await dropSandbox(sb);
}
process.exit(failed ? 1 : 0);

// postgres-mcp tool argument names are read from its own schemas rather than assumed.
function postgresMcpArgs(tools, name, spec, connectionId) {
  const props = Object.keys(tools.find((t) => t.name === name)?.inputSchema?.properties ?? {});
  const [kind, sql] = [spec.slice(1).split(":")[0], spec.slice(spec.indexOf(":") + 1)];
  const args = {};
  for (const p of props) {
    if (/profile/i.test(p)) args[p] = "default";
    else if (/connection/i.test(p)) args[p] = connectionId;
    else if (/^(sql|query|statement)$/i.test(p) && kind !== "connect") args[p] = sql;
  }
  return args;
}
