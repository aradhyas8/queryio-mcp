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

/** One FK constraint's rows at depth 1 from an inspected row. */
export interface Relation {
  /** outgoing: the root row references these rows. incoming: these rows reference the root row. */
  direction: "outgoing" | "incoming";
  /** The related table, schema-qualified. */
  table: string;
  constraint: string;
  /** Referencing columns, paired by position with the referenced target_columns, whatever the direction. */
  source_columns: string[];
  target_columns: string[];
  status: "ok";
  /** The related table's primary key, or ctid (physical position) without one. Never recency. */
  order_by: string[];
  columns: string[];
  rows: unknown[][];
  rows_returned: number;
  has_more: boolean;
}

export interface InspectRowResult {
  table: string;
  columns: string[];
  row: unknown[];
  relations: Relation[];
  values_truncated: number;
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
  /** One row by its full primary key, plus up to N rows per declared FK constraint at depth 1. */
  inspectRow(table: string, key: Record<string, unknown>): Promise<InspectRowResult>;
  close(): Promise<void>;
}

const BATCH_SIZE = 100;

/** A column's common values are dropped whole when their serialized form exceeds this. */
const MAX_COMMON_VALUES_BYTES = 1024;

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
    const { maxRows, maxResponseBytes } = settings;
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
          const { row, cuts, hidden } = shapeRow(raw, redacted);
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

  /** Redact, then truncate: a hidden value is never truncated, and only its marker is charged to a byte budget. */
  function shapeRow(raw: unknown[], redacted: boolean[]): { row: unknown[]; cuts: number; hidden: number } {
    let cuts = 0;
    let hidden = 0;
    const row = raw.map((value, i) => {
      if (redacted[i]) {
        hidden++;
        return REDACTED;
      }
      const shaped = truncateValue(value, settings.maxValueLength);
      if (shaped !== value) cuts++;
      return shaped;
    });
    return { row, cuts, hidden };
  }

  async function runInspectRow(table: string, key: Record<string, unknown>): Promise<InspectRowResult> {
    const started = performance.now();
    const limit = settings.inspectRelatedRows;
    return await readOnly(async (client) => {
      const rootId = (await catalog.resolveTables(client, [table])).get(table);
      if (!rootId) throw tableNotFound(table);
      const root = (await catalog.describeTables(client, [rootId])).get(rootId.oid)!;
      const pk = root.primary_key;
      if (!pk) throw new QueryError("no_primary_key", "inspect_row requires a declared primary key; use query for this table");
      const given = Object.keys(key);
      if (given.length !== pk.length || !pk.every((c) => Object.hasOwn(key, c))) {
        throw new QueryError(
          "key_mismatch",
          `key must name exactly the primary key columns of ${table}: ${pk.join(", ")}; got ${given.join(", ") || "none"}.`,
        );
      }

      const fks = [
        ...root.foreign_keys_out.map((fk) => ({ direction: "outgoing" as const, fk, related: fk.to })),
        ...root.foreign_keys_in.map((fk) => ({ direction: "incoming" as const, fk, related: fk.from })),
      ];
      const relatedIds = [...new Map(fks.map((f) => [f.related.oid, f.related])).values()].filter((id) => id.oid !== rootId.oid);
      const structures = new Map([[rootId.oid, root], ...(await catalog.describeTables(client, relatedIds))]);
      // Every identifier in generated SQL comes from the catalog; every value is a bind parameter.
      const from = (id: catalog.TableId) => `${ident(id.schema)}.${ident(id.table)}`;
      const where = (columns: string[]) => columns.map((c, i) => `${ident(c)} = $${i + 1}`).join(" AND ");

      // Fetched as raw text, so FK lookups bind exactly what Postgres printed; parsed for output as query does.
      const found = await client.query<unknown[]>({
        text: `SELECT * FROM ${from(rootId)} WHERE ${where(pk)}`,
        values: pk.map((c) => key[c]),
        rowMode: "array",
        types: { getTypeParser: () => (text: string) => text },
      } as pg.QueryArrayConfig);
      if (found.rows.length === 0) {
        throw new QueryError("row_not_found", `No row in ${table} has that key. Primary key columns: ${pk.join(", ")}.`);
      }
      const columns = found.fields.map((f) => f.name);
      const text = new Map(columns.map((c, i) => [c, found.rows[0][i] as string | null]));
      const parsed = found.rows[0].map((v, i) =>
        v === null ? null : pg.types.getTypeParser(found.fields[i].dataTypeID, "text")(v as string),
      );

      let valuesTruncated = 0;
      let valuesRedacted = 0;
      const shape = (fields: pg.FieldDef[], rows: unknown[][]) => {
        const redacted = fields.map((f) => isRedacted(f.name, settings.redactPatterns));
        return rows.map((raw) => {
          const { row, cuts, hidden } = shapeRow(raw, redacted);
          valuesTruncated += cuts;
          valuesRedacted += hidden;
          return row;
        });
      };

      const relations: Relation[] = [];
      for (const { direction, fk, related } of fks) {
        // Match the related table's side of the constraint against the root row's side.
        const [match, rootColumns] = direction === "outgoing" ? [fk.to_columns, fk.from_columns] : [fk.from_columns, fk.to_columns];
        const values = rootColumns.map((c) => text.get(c) ?? null);
        // Without a primary key, physical position: stable within the snapshot, not across writes.
        const orderBy = structures.get(related.oid)?.primary_key ?? ["ctid"];
        const entry: Relation = {
          direction,
          table: catalog.qualifiedName(related.schema, related.table),
          constraint: fk.constraint,
          source_columns: fk.from_columns,
          target_columns: fk.to_columns,
          status: "ok",
          order_by: orderBy,
          columns: [],
          rows: [],
          rows_returned: 0,
          has_more: false,
        };
        relations.push(entry);
        // A NULL in the key references nothing, as the FK itself treats it.
        if (values.includes(null)) continue;
        // N + 1 rows: the extra one only proves has_more. No COUNT(*).
        const result = await client.query<unknown[]>({
          text: `SELECT * FROM ${from(related)} WHERE ${where(match)}
                 ORDER BY ${orderBy.map(ident).join(", ")} LIMIT ${limit + 1}`,
          values,
          rowMode: "array",
        });
        entry.columns = result.fields.map((f) => f.name);
        entry.rows = shape(result.fields, result.rows.slice(0, limit));
        entry.rows_returned = entry.rows.length;
        entry.has_more = result.rows.length > limit;
      }

      return {
        table,
        columns,
        row: shape(found.fields, [parsed])[0],
        relations,
        values_truncated: valuesTruncated,
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
        {},
        async () => {
          const [ids, found] = await readOnly(async (client) => {
            const ids = await catalog.resolveTables(client, tables);
            return [ids, await catalog.describeTables(client, [...ids.values()])] as const;
          });
          for (const table of found.values()) {
            table.columns = table.columns.map(shapeStats);
          }
          return {
            tables: tables.map((name) => {
              const id = ids.get(name);
              return id ? catalog.present(found.get(id.oid)!) : { name, error: tableNotFound(name) };
            }),
          };
        },
        // Resolved tables only: requested names are tool arguments.
        (result) => ({
          tables: result.tables.filter((t) => !("error" in t)).map((t) => t.name),
          tables_failed: result.tables.filter((t) => "error" in t).length,
          bytes_returned: Buffer.byteLength(JSON.stringify(result)),
        }),
      );
    },
    inspectRow(table, key) {
      return audited(
        "inspect_row",
        {},
        () => runInspectRow(table, key),
        // Never the key: its values are row data.
        (result) => ({
          tables: [...new Set([result.table, ...result.relations.map((r) => r.table)])],
          rows_returned: 1 + result.relations.reduce((n, r) => n + r.rows_returned, 0),
          bytes_returned: Buffer.byteLength(JSON.stringify(result)),
          values_truncated: result.values_truncated,
        }),
      );
    },
    close: () => pool.end(),
  };

  /** Hide all statistics of redacted columns; truncate common values, and drop them all when over the cap. */
  function shapeStats(column: catalog.Column): catalog.Column {
    if (!column.stats_available) return column;
    if (isRedacted(column.name, settings.redactPatterns)) {
      const { name, type, nullable } = column;
      return { name, type, nullable, stats_available: false, redacted: true };
    }
    if (!column.common_values) return column;
    for (const cv of column.common_values) cv.value = truncateValue(cv.value, settings.maxValueLength);
    if (Buffer.byteLength(JSON.stringify(column.common_values)) > MAX_COMMON_VALUES_BYTES) delete column.common_values;
    return column;
  }

}

function tableNotFound(name: string): QueryError {
  return new QueryError(
    "not_found",
    `Table ${JSON.stringify(name)} not found. Pass a schema-qualified name as list_tables returns it, e.g. public.users.`,
  );
}

/** Quote an identifier taken from the catalog. */
function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
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
