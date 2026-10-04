import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCore, type Core } from "../src/core.js";
import { createServer } from "../src/mcp.js";

import { ADMIN_URL, TEST_DB, sql, testSettings } from "./db.js";

let core: Core;
let client: Client;

beforeAll(async () => {
  core = createCore(testSettings());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(core).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await core.close();
});

it("lists the query tool with its input schema", async () => {
  const { tools } = await client.listTools();
  const query = tools.find((t) => t.name === "query");
  expect(query?.inputSchema).toMatchObject({ type: "object", properties: { sql: { type: "string" } }, required: ["sql"] });
});

it("lists list_tables and describe_tables with their input schemas", async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  expect(byName.list_tables?.inputSchema).toMatchObject({ type: "object", properties: { filter: { type: "string" } } });
  expect(byName.list_tables?.inputSchema.required ?? []).toEqual([]);
  expect(byName.describe_tables?.inputSchema).toMatchObject({
    type: "object",
    properties: { tables: { type: "array", items: { type: "string" } } },
    required: ["tables"],
  });
});

it("lists inspect_row with its input schema", async () => {
  const { tools } = await client.listTools();
  const inspect = tools.find((t) => t.name === "inspect_row");
  expect(inspect?.inputSchema).toMatchObject({
    type: "object",
    properties: { table: { type: "string" }, key: { type: "object" } },
    required: ["table", "key"],
  });
});

it("reports an inspect_row failure as a structured tool error", async () => {
  const result = await client.callTool({ name: "inspect_row", arguments: { table: "public.no_such_table", key: { id: 1 } } });
  expect(result.isError).toBe(true);
  const [text] = result.content as { type: string; text: string }[];
  expect(JSON.parse(text.text).error).toMatchObject({ category: "not_found" });
});

it("returns describe_tables per-table errors as a successful call", async () => {
  const result = await client.callTool({ name: "describe_tables", arguments: { tables: ["public.no_such_table"] } });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ tables: [{ name: "public.no_such_table", error: { category: "not_found" } }] });
});

it("returns a real Postgres result as structured and compact text content", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 1 AS n, 'a' AS s" } });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ columns: ["n", "s"], rows: [[1, "a"]], row_count: 1 });
  const [text] = result.content as { type: string; text: string }[];
  expect(text.type).toBe("text");
  expect(JSON.parse(text.text)).toEqual(result.structuredContent);
});

it("reports Postgres errors as structured tool errors", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 1; SELECT 2" } });
  expect(result.isError).toBe(true);
  const [text] = result.content as { type: string; text: string }[];
  expect(JSON.parse(text.text)).toMatchObject({
    error: { code: "42601", category: "syntax_error_or_access_rule_violation", message: expect.any(String) },
  });
});

it("reports a non-read statement as a read-oriented tool error", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "DROP TABLE x" } });
  expect(result.isError).toBe(true);
  const [text] = result.content as { type: string; text: string }[];
  expect(JSON.parse(text.text).error).toMatchObject({ category: "read_oriented" });
});

it("includes privilege warning in successful MCP tool responses when connected as superuser", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 42 AS num" } });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    warnings: [
      'connected role "postgres" is highly privileged; QueryIO is a bounded interface, not the database security boundary',
    ],
  });
  const [text] = result.content as { type: string; text: string }[];
  expect(JSON.parse(text.text)).toMatchObject({
    warnings: [
      'connected role "postgres" is highly privileged; QueryIO is a bounded interface, not the database security boundary',
    ],
  });

  const listResult = await client.callTool({ name: "list_tables", arguments: {} });
  expect(listResult.isError).toBeFalsy();
  expect(listResult.structuredContent).toMatchObject({
    warnings: [
      'connected role "postgres" is highly privileged; QueryIO is a bounded interface, not the database security boundary',
    ],
  });
});

it("includes privilege warning in failing MCP tool responses when connected as superuser", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "SELECT * FROM missing_table_123" } });
  expect(result.isError).toBe(true);
  const [text] = result.content as { type: string; text: string }[];
  const parsed = JSON.parse(text.text);
  expect(parsed.error).toBeDefined();
  expect(parsed.warnings).toEqual([
    'connected role "postgres" is highly privileged; QueryIO is a bounded interface, not the database security boundary',
  ]);
});

it("omits privilege warnings when connected as a dedicated read-only role", async () => {
  const roRole = "queryio_mcp_ro_user";
  const roPass = "mcp_ro_pass_123";
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

  const roCore = createCore(testSettings({ QUERYIO_DATABASE_URL: url.toString() }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(roCore).connect(serverTransport);
  const roClient = new Client({ name: "test-ro", version: "0" });
  await roClient.connect(clientTransport);

  try {
    // Successful call
    const successResult = await roClient.callTool({ name: "query", arguments: { sql: "SELECT 1 AS num" } });
    expect(successResult.isError).toBeFalsy();
    expect(successResult.structuredContent).not.toHaveProperty("warnings");
    const [succText] = successResult.content as { type: string; text: string }[];
    expect(JSON.parse(succText.text)).not.toHaveProperty("warnings");

    // Failing call
    const failResult = await roClient.callTool({ name: "query", arguments: { sql: "SELECT * FROM nonexistent" } });
    expect(failResult.isError).toBe(true);
    const [failText] = failResult.content as { type: string; text: string }[];
    expect(JSON.parse(failText.text)).not.toHaveProperty("warnings");
  } finally {
    await roClient.close();
    await roCore.close();
    await sql(dropRoleSafe);
  }
});
