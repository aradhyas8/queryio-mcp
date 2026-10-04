import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCore, type Core } from "../src/core.js";
import { createServer } from "../src/mcp.js";
import { loadSettings } from "../src/settings.js";
import { TEST_URL } from "./db.js";

let core: Core;
let client: Client;

beforeAll(async () => {
  core = createCore(loadSettings({ QUERYIO_DATABASE_URL: TEST_URL }));
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

it("returns a real Postgres result as structured and compact text content", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 1 AS n, 'a' AS s" } });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ columns: ["n", "s"], rows: [[1, "a"]], row_count: 1 });
  const [text] = result.content as { type: string; text: string }[];
  expect(text.type).toBe("text");
  expect(JSON.parse(text.text)).toEqual(result.structuredContent);
});

it("reports Postgres errors as tool errors", async () => {
  const result = await client.callTool({ name: "query", arguments: { sql: "SELECT 1; SELECT 2" } });
  expect(result.isError).toBe(true);
});
