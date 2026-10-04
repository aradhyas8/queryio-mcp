import type pg from "pg";

/**
 * QueryIO's one model of tables, keys and foreign-key constraints, read from the PostgreSQL catalog.
 * Table names are always schema-qualified as `schema.table`, exactly as stored (no quoting).
 */

export interface TableSummary {
  name: string;
  /** Planner estimate from pg_class.reltuples; null when the table was never analyzed. */
  estimated_rows: number | null;
  columns: number;
}

export interface Column {
  name: string;
  type: string;
  nullable: boolean;
}

/** One FK constraint. Columns pair up by position: from_columns[i] references to_columns[i]. */
export interface ForeignKey {
  constraint: string;
  from_table: string;
  from_columns: string[];
  to_table: string;
  to_columns: string[];
}

export interface Index {
  name: string;
  /** Column names, or expression text for expression keys. */
  columns: string[];
  unique: boolean;
  primary: boolean;
  /** WHERE clause of a partial index. */
  predicate: string | null;
}

export interface TableStructure {
  name: string;
  columns: Column[];
  primary_key: string[] | null;
  foreign_keys_out: ForeignKey[];
  /** Includes self-references, which also appear in foreign_keys_out. */
  foreign_keys_in: ForeignKey[];
  indexes: Index[];
}

const QUALIFIED = "n.nspname || '.' || c.relname";
const LIVE_COLUMN = "a.attnum > 0 AND NOT a.attisdropped";

export async function listTables(client: pg.ClientBase, filter?: string): Promise<TableSummary[]> {
  const { rows } = await client.query<TableSummary>(
    `SELECT ${QUALIFIED} AS name,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS estimated_rows,
            (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND ${LIVE_COLUMN}) AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND ($1::text IS NULL
            OR strpos(lower(c.relname), lower($1)) > 0
            OR EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND ${LIVE_COLUMN} AND strpos(lower(a.attname), lower($1)) > 0))
     ORDER BY 1`,
    [filter ?? null],
  );
  return rows;
}

/**
 * Describe tables by schema-qualified name. Names are matched exactly against the catalog, never parsed or
 * interpolated, so any string is safe to pass. Unknown names are absent from the returned map.
 */
export async function describeTables(client: pg.ClientBase, names: string[]): Promise<Map<string, TableStructure>> {
  const { rows: found } = await client.query<{ oid: number; name: string }>(
    `SELECT c.oid, ${QUALIFIED} AS name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND ${QUALIFIED} = ANY($1::text[])`,
    [names],
  );
  const byOid = new Map<number, TableStructure>();
  for (const { oid, name } of found) {
    byOid.set(oid, { name, columns: [], primary_key: null, foreign_keys_out: [], foreign_keys_in: [], indexes: [] });
  }
  const oids = [...byOid.keys()];
  if (oids.length > 0) {
    const columns = await client.query<Column & { oid: number }>(
      `SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable
       FROM pg_attribute a WHERE a.attrelid = ANY($1::oid[]) AND ${LIVE_COLUMN}
       ORDER BY a.attnum`,
      [oids],
    );
    // conparentid = 0 skips the clones Postgres adds on partitions.
    const constraints = await client.query<ForeignKey & { kind: "p" | "f"; from_oid: number; to_oid: number }>(
      `SELECT con.conname AS constraint, con.contype AS kind,
              con.conrelid AS from_oid, fn.nspname || '.' || fc.relname AS from_table,
              ${attnames("con.conrelid", "con.conkey")} AS from_columns,
              con.confrelid AS to_oid, tn.nspname || '.' || tc.relname AS to_table,
              ${attnames("con.confrelid", "con.confkey")} AS to_columns
       FROM pg_constraint con
       JOIN pg_class fc ON fc.oid = con.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       LEFT JOIN pg_class tc ON tc.oid = con.confrelid LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       WHERE con.conparentid = 0
         AND ((con.contype = 'p' AND con.conrelid = ANY($1::oid[]))
              OR (con.contype = 'f' AND (con.conrelid = ANY($1::oid[]) OR con.confrelid = ANY($1::oid[]))))
       ORDER BY con.conname, fn.nspname, fc.relname`,
      [oids],
    );
    const indexes = await client.query<Index & { oid: number }>(
      `SELECT i.indrelid AS oid, ic.relname AS name, i.indisunique AS unique, i.indisprimary AS primary,
              ARRAY(SELECT pg_get_indexdef(i.indexrelid, k, true) FROM generate_series(1, i.indnkeyatts) k ORDER BY k) AS columns,
              pg_get_expr(i.indpred, i.indrelid, true) AS predicate
       FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
       WHERE i.indrelid = ANY($1::oid[])
       ORDER BY ic.relname`,
      [oids],
    );
    for (const { oid, ...column } of columns.rows) byOid.get(oid)!.columns.push(column);
    for (const { kind, from_oid, to_oid, ...fk } of constraints.rows) {
      if (kind === "p") {
        byOid.get(from_oid)!.primary_key = fk.from_columns;
        continue;
      }
      byOid.get(from_oid)?.foreign_keys_out.push(fk);
      byOid.get(to_oid)?.foreign_keys_in.push(fk);
    }
    for (const { oid, ...index } of indexes.rows) byOid.get(oid)!.indexes.push(index);
  }
  return new Map([...byOid.values()].map((t) => [t.name, t]));
}

/** Column names for a constraint's attnum array, in constraint order. */
function attnames(rel: string, keys: string): string {
  return `ARRAY(SELECT a.attname::text FROM unnest(${keys}) WITH ORDINALITY k(attnum, i)
                JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum ORDER BY k.i)`;
}
