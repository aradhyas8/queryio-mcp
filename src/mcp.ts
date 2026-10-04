import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Core } from "./core.js";

export function createServer(core: Core): McpServer {
  const server = new McpServer({ name: "queryio", version: "0.0.1" });

  server.registerTool(
    "query",
    {
      description:
        "Run one read-only SQL statement against PostgreSQL. Runs in a read-only transaction that is always rolled back, with server-side timeouts.",
      inputSchema: { sql: z.string().describe("A single read-only SQL statement") },
      outputSchema: {
        columns: z.array(z.string()),
        rows: z.array(z.array(z.unknown())),
        row_count: z.number(),
        duration_ms: z.number(),
      },
    },
    async ({ sql }) => {
      const result = await core.query(sql);
      return { structuredContent: { ...result }, content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
