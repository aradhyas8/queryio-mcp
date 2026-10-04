import { createHash } from "node:crypto";
import pg from "pg";
import Cursor from "pg-cursor";
import { createAuditLog } from "./audit.js";
import * as catalog from "./catalog.js";
import { QueryError, toQueryError } from "./errors.js";
import type { Settings } from "./settings.js";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  /** At least one more row existed beyond those returned; how many is unknown by design. */
  has_more: boolean;
  truncated_by: "rows" | "bytes" | null;
  values_truncated: number;
  /** Returned columns hidden by redaction; reported even when no rows come back. */
  columns_redacted: number;
  values_redacted: number;
  duration_ms: number;
}

export interface TableNotFound {
  name: string;
  error: QueryError;
}

export interface Core {
  query(sql: string): Promise<QueryResult>;
  /** Tables outside system schemas; `filter` is a case-insensitive substring of a table or column name. */
  listTables(filter?: string): Promise<{ tables: catalog.TableSummary[] }>;
  /** Structure per requested schema-qualified name, in request order; unknown names get a per-table error. */
  describeTables(tables: string[]): Promise<{ tables: (catalog.TableStructure | TableNotFound)[] }>;
  close(): Promise<void>;
}

const BATCH_SIZE = 100;

export const REDACTED = "[redacted]";

/**
 * Whether a column's values are hidden: its name equals a pattern, ignoring case. The one place matching lives;
 * tools must redact through it. Accidental-exposure prevention, not access control: `query` can rename columns.
 */
export function isRedacted(column: string, patterns: readonly string[]): boolean {
  return patterns.includes(column.toLowerCase());
}

const READ_COMMANDS = ["SELECT", "WITH", "VALUES", "TABLE", "SHOW"];

/**
 * Reject statements that don't lead with a read command. A mistake catcher, not security: writable CTEs and
 * side-effecting functions pass it; the read-only transaction is what holds the line.
 */
function assertReadOriented(sql: string): void {
  // Skip leading whitespace, comments and opening parentheses.
  const head = sql.replace(/^(?:\s+|--.*|\/\*[\s\S]*?\*\/|\()*/, "");
  const command = /^[a-z]+/i.exec(head)?.[0].toUpperCase() ?? "";
  if (!READ_COMMANDS.includes(command)) {
    throw new QueryError(
      "read_oriented",
      `QueryIO is read-oriented: statements must start with ${READ_COMMANDS.join(", ")}; got ${command || "no command"}.`,
    );
  }
}

export function createCore(settings: Settings): Core {
  const pool = new pg.Pool({ connectionString: settings.databaseUrl, max: 2 });
  // An idle client losing its connection must not crash the server; the pool replaces it.
  pool.on("error", () => {});
  const audit = createAuditLog(settings.auditLog);

  /** Run one tool call and write its audit event: `fields` up front, plus `summarize(result)` on success. */
  async function audited<T>(
    tool: string,
    fields: Record<string, unknown>,
    run: () => Promise<T>,
    summarize: (result: T) => Record<string, unknown>,
  ): Promise<T> {
    const ts = new Date().toISOString();
    const started = performance.now();
    let outcome: { success: boolean } & Record<string, unknown> = { success: false };
    try {
      const result = await run();
      outcome = { success: true, ...summarize(result) };
      return result;
    } catch (err) {
      const error = toQueryError(err);
      outcome = { success: false, error_category: error.category, error_code: error.code };
      throw error;
    } finally {
      audit({ ts, tool, ...fields, duration_ms: Math.round(performance.now() - started), ...outcome });
    }
  }

  /** Run work in a read-only transaction with Postgres-side timeouts that always rolls back. */
  async function readOnly<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      // Integers from Settings, never user input.
      await client.query(
        `BEGIN READ ONLY; SET LOCAL statement_timeout = ${settings.statementTimeoutMs}; SET LOCAL lock_timeout = ${settings.lockTimeoutMs}`,
      );
      return await work(client);
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch (err) {
        broken = err as Error;
      }
      // Destroy the connection instead of returning it if it can't be rolled back.
      client.release(broken);
    }
  }

  async function runQuery(sql: string): Promise<QueryResult> {
    const started = performance.now();
    const { maxRows, maxResponseBytes, maxValueLength } = settings;
    assertReadOriented(sql);
    return await readOnly(async (client) => {
      // pg-cursor runs the statement as an extended-protocol portal, which rejects multiple statements.
      const cursor = client.query(new Cursor(sql, undefined, { rowMode: "array" }));
      const rows: unknown[][] = [];
      let fields: pg.FieldDef[] = [];
      let bytes = 0;
      let valuesTruncated = 0;
      let valuesRedacted = 0;
      let redacted: boolean[] = [];
      let truncatedBy: QueryResult["truncated_by"] = null;
      // Never request more than max_rows + 1 rows in total: the extra row only proves has_more.
      read: for (;;) {
        const batch = await new Promise<unknown[][]>((resolve, reject) =>
          cursor.read(Math.min(BATCH_SIZE, maxRows + 1 - rows.length), (err, rows, result) => {
            if (err) return reject(err);
            // Once the portal is done, pg-cursor calls back without a result.
            if (result) {
              fields = result.fields;
              redacted = fields.map((f) => isRedacted(f.name, settings.redactPatterns));
            }
            resolve(rows);
          }),
        );
        if (batch.length === 0) break;
        // The envelope, with its numbers at their widest, is charged before the first row.
        bytes ||= envelopeBytes(fields, maxRows);
        for (const raw of batch) {
          if (rows.length === maxRows) {
            truncatedBy = "rows";
            break read;
          }
          let cuts = 0;
          let hidden = 0;
          // Redact first, so a hidden value is never truncated and only its marker is charged to the byte budget.
          const row = raw.map((value, i) => {
            if (redacted[i]) {
              hidden++;
              return REDACTED;
            }
            const shaped = truncateValue(value, maxValueLength);
            if (shaped !== value) cuts++;
            return shaped;
          });
          const size = Buffer.byteLength(JSON.stringify(row)) + 1; // + separating comma
          if (bytes + size > maxResponseBytes) {
            truncatedBy = "bytes";
            break read;
          }
          bytes += size;
          valuesTruncated += cuts;
          valuesRedacted += hidden;
          rows.push(row);
        }
      }
      // No close on error: pg-cursor already synced, and closing then would wait for a readyForQuery that has passed.
      await cursor.close();
      return {
        columns: fields.map((f) => f.name),
        rows,
        row_count: rows.length,
        has_more: truncatedBy !== null,
        truncated_by: truncatedBy,
        values_truncated: valuesTruncated,
        columns_redacted: redacted.filter(Boolean).length,
        values_redacted: valuesRedacted,
        duration_ms: Math.round(performance.now() - started),
      };
    });
  }

  return {
    query(sql) {
      const sqlFields = {
        sql_hash: createHash("sha256").update(sql).digest("hex").slice(0, 16),
        ...(settings.auditIncludeSql && { sql }),
      };
      return audited(
        "query",
        sqlFields,
        () => runQuery(sql),
        (result) => ({
          rows_returned: result.row_count,
          bytes_returned: Buffer.byteLength(JSON.stringify(result)),
          has_more: result.has_more,
          truncated_by: result.truncated_by,
          values_truncated: result.values_truncated,
        }),
      );
    },
    listTables(filter) {
      return audited(
        "list_tables",
        {},
        async () => ({ tables: await readOnly((client) => catalog.listTables(client, filter)) }),
        (result) => ({ tables_returned: result.tables.length, bytes_returned: Buffer.byteLength(JSON.stringify(result)) }),
      );
    },
    describeTables(tables) {
      return audited(
        "describe_tables",
        { tables },
        async () => {
          const found = await readOnly((client) => catalog.describeTables(client, tables));
          return {
            tables: tables.map(
              (name) =>
                found.get(name) ?? {
                  name,
                  error: new QueryError(
                    "not_found",
                    `Table ${JSON.stringify(name)} not found. Pass a schema-qualified name as list_tables returns it, e.g. public.users.`,
                  ),
                },
            ),
          };
        },
        (result) => ({
          tables_failed: result.tables.filter((t) => "error" in t).length,
          bytes_returned: Buffer.byteLength(JSON.stringify(result)),
        }),
      );
    },
    close: () => pool.end(),
  };

}

function envelopeBytes(fields: pg.FieldDef[], maxRows: number): number {
  const widest: QueryResult = {
    columns: fields.map((f) => f.name),
    rows: [],
    row_count: maxRows,
    has_more: false,
    truncated_by: "bytes",
    values_truncated: maxRows * fields.length,
    columns_redacted: fields.length,
    values_redacted: maxRows * fields.length,
    duration_ms: 1e9,
  };
  return Buffer.byteLength(JSON.stringify(widest));
}

/**
 * Cut a value whose text form is longer than `max` characters, marking how much was omitted.
 * Returns the value itself when it is kept whole. JSON, arrays and bytea are cut as text.
 */
function truncateValue(value: unknown, max: number): unknown {
  if (typeof value !== "string" && (value === null || typeof value !== "object" || value instanceof Date)) return value;
  const text =
    typeof value === "string" ? value : Buffer.isBuffer(value) ? `\\x${value.toString("hex")}` : JSON.stringify(value);
  if (text.length <= max) return value;
  // Don't split a surrogate pair.
  const kept = text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max);
  const cut = `${kept}…[+${formatSize(Buffer.byteLength(text) - Buffer.byteLength(kept))}]`;
  // A value barely over the limit is kept whole rather than made longer by the marker.
  return cut.length < text.length ? cut : value;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
