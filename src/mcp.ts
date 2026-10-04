import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
    ({ sql }) => respond(core.query(sql)),
  );

  server.registerTool(
    "list_tables",
    {
      description:
        "List tables outside system schemas: schema-qualified name, estimated_rows (planner estimate, null if never analyzed; no scans), and column count. Optional filter: case-insensitive substring matched against table and column names.",
      inputSchema: { filter: z.string().optional().describe("Substring of a table or column name") },
    },
    ({ filter }) => respond(core.listTables(filter)),
  );

  server.registerTool(
    "describe_tables",
    {
      description:
        "Describe several tables in one call: columns (name, type, nullable), primary key, outgoing and incoming foreign keys (constraint, from_table/from_columns, to_table/to_columns, paired by position), and indexes. Each column carries planner statistics (no scans): stats_available, and when true null_frac, n_distinct (negative = minus the distinct fraction of rows, -1 = unique) and, for enum-like non-sensitive columns, common_values with frequencies. Columns matching a redaction pattern get stats_available: false, redacted: true. Unknown tables get a per-table error; the rest still succeed.",
      inputSchema: {
        tables: z.array(z.string()).min(1).describe("Schema-qualified table names, e.g. public.users"),
      },
    },
    ({ tables }) => respond(core.describeTables(tables)),
  );

  server.registerTool(
    "inspect_row",
    {
      description:
        "Fetch one row by its full primary key plus its depth-1 declared foreign-key neighborhood in one call. Each relation is one FK constraint: direction outgoing (rows the root references) or incoming (rows referencing the root), the related table, constraint, source_columns (referencing) paired by position with target_columns (referenced), status, and compact rows (columns once, rows as arrays). Each relation returns up to N rows (default 5) ordered by the related table's primary key (order_by; ctid without one), never by recency; has_more means more rows existed, with no count. Values are truncated and redacted as in query, totalled in values_truncated and values_redacted. Tables without a declared primary key need query instead.",
      inputSchema: {
        table: z.string().describe("Schema-qualified table name, e.g. public.users"),
        key: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe('Every primary key column and its value, e.g. {"id": 4821}. Pass integers beyond 2^53 as strings.'),
      },
    },
    ({ table, key }) => respond(core.inspectRow(table, key)),
  );

  return server;
}

/** Shape a core result as structured plus compact text content, or a core failure as a structured tool error. */
async function respond(work: Promise<object>): Promise<CallToolResult> {
  try {
    const result = await work;
    return { structuredContent: { ...result }, content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: toQueryError(err) }) }] };
  }
}
