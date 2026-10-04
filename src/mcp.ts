import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Core } from "./core.js";
import { toQueryError } from "./errors.js";

export function createServer(core: Core): McpServer {
  const server = new McpServer({ name: "queryio", version: "0.0.1" });

  server.registerTool(
    "query",
    {
      description:
        "Run one read-only SQL statement (SELECT, WITH, VALUES, TABLE, SHOW) against PostgreSQL. Runs in a read-only transaction that is always rolled back, with server-side timeouts. Results are bounded: has_more means more rows existed (truncated_by says whether the row cap or byte budget stopped retrieval), and long values are cut with a …[+size] marker. Columns with sensitive-looking names (password, token, api_key, ...) come back as [redacted], counted in columns_redacted and values_redacted.",
      inputSchema: { sql: z.string().describe("A single read-only SQL statement") },
      outputSchema: {
        columns: z.array(z.string()),
        rows: z.array(z.array(z.unknown())),
        row_count: z.number(),
        has_more: z.boolean(),
        truncated_by: z.enum(["rows", "bytes"]).nullable(),
        values_truncated: z.number(),
        columns_redacted: z.number(),
        values_redacted: z.number(),
        duration_ms: z.number(),
      },
    },
    async ({ sql }) => {
      try {
        const result = await core.query(sql);
        return { structuredContent: { ...result }, content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: toQueryError(err) }) }] };
      }
    },
  );

  return server;
}
