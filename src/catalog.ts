import type pg from "pg";

/**
 * QueryIO's one model of tables, keys and foreign-key constraints, read from the PostgreSQL catalog.
 * A table's identity is its TableId. The schema-qualified name (qualifiedName) is only how agents see and pass it.
 */

/** A table's identity: its catalog OID, with schema and table name exactly as stored. */
export interface TableId {
  oid: number;
  schema: string;
  table: string;
}

/**
 * The name agents see and pass: `schema.table` as stored, with a part double-quoted (quotes doubled) only when it
 * holds a dot or a double quote. Distinct tables never share a name: `"a.b".c` and `a."b.c"` differ.
 */
export function qualifiedName(schema: string, table: string): string {
  const part = (p: string) => (/[."]/.test(p) ? `"${p.replaceAll('"', '""')}"` : p);
  return `${part(schema)}.${part(table)}`;
}

/** Inverse of qualifiedName: null for any string it would not produce, such as `"public"."users"` or `a.b.c`. */
export function parseQualifiedName(name: string): [schema: string, table: string] | null {
  const m = /^("(?:[^"]|"")*"|[^."]*)\.("(?:[^"]|"")*"|[^."]*)$/.exec(name);
  if (!m) return null;
  const unquote = (p: string) => (p.startsWith('"') ? p.slice(1, -1).replaceAll('""', '"') : p);
  const [schema, table] = [unquote(m[1]), unquote(m[2])];
  return qualifiedName(schema, table) === name ? [schema, table] : null;
}

export interface TableSummary {
  name: string;
  /** Planner estimate from pg_class.reltuples; null when the table was never analyzed. */
  estimated_rows: number | null;
  columns: number;
}

export type Column = { name: string; type: string; nullable: boolean } & ColumnStats;

/** Planner statistics from pg_stats; never computed by scanning. Absent statistics are reported, never zeroed. */
export type ColumnStats =
  /** `redacted`: statistics exist but are hidden because the column matches a redaction pattern. */
  | { stats_available: false; redacted?: true }
  | {
      stats_available: true;
      null_frac: number;
      /** Positive: estimated distinct count. Negative: minus the distinct fraction of rows (-1 means unique). */
      n_distinct: number;
      /** Most common values, most frequent first; only fetched for enum-like columns. */
      common_values?: { value: unknown; frequency: number }[];
    };

/** Columns with at most this many estimated distinct values count as enum-like. */
const ENUM_LIKE_MAX_DISTINCT = 20;

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

/** A ForeignKey with the identities of both its tables. */
export interface ForeignKeyRef extends ForeignKey {
  from: TableId;
  to: TableId;
}

/** A TableStructure with the identities of it and its related tables; present() turns it into what agents see. */
export interface Table extends TableStructure {
  id: TableId;
  foreign_keys_out: ForeignKeyRef[];
  foreign_keys_in: ForeignKeyRef[];
}

export function present({ id, foreign_keys_out, foreign_keys_in, ...rest }: Table): TableStructure {
  const strip = ({ from, to, ...fk }: ForeignKeyRef): ForeignKey => fk;
  return { ...rest, foreign_keys_out: foreign_keys_out.map(strip), foreign_keys_in: foreign_keys_in.map(strip) };
}

const LIVE_COLUMN = "a.attnum > 0 AND NOT a.attisdropped";

export async function listTables(client: pg.ClientBase, filter?: string): Promise<TableSummary[]> {
  const { rows } = await client.query<Omit<TableSummary, "name"> & { schema: string; table: string }>(
    `SELECT n.nspname AS schema, c.relname AS table,
            CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::float8 END AS estimated_rows,
            (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = c.oid AND ${LIVE_COLUMN}) AS columns
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
       AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
       AND ($1::text IS NULL
            OR strpos(lower(c.relname), lower($1)) > 0
            OR EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND ${LIVE_COLUMN} AND strpos(lower(a.attname), lower($1)) > 0))
     ORDER BY n.nspname || '.' || c.relname -- sort order only, never identity`,
    [filter ?? null],
  );
  return rows.map(({ schema, table, ...summary }) => ({ name: qualifiedName(schema, table), ...summary }));
}

/**
 * Resolve schema-qualified names to table identities. A name is parsed, never interpolated, and matched exactly
 * against the catalog, so any string is safe to pass. Unknown or non-canonical names are absent from the map.
 */
export async function resolveTables(client: pg.ClientBase, names: string[]): Promise<Map<string, TableId>> {
  const parsed = names.map(parseQualifiedName).filter((p) => p !== null);
  const { rows } = await client.query<TableId>(
    `SELECT c.oid, n.nspname AS schema, c.relname AS table
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND (n.nspname::text, c.relname::text) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
    [parsed.map(([schema]) => schema), parsed.map(([, table]) => table)],
  );
  return new Map(rows.map((id) => [qualifiedName(id.schema, id.table), id]));
}

/** Describe resolved tables, keyed by OID. */
export async function describeTables(client: pg.ClientBase, ids: TableId[]): Promise<Map<number, Table>> {
  const byOid = new Map<number, Table>();
  for (const id of ids) {
    byOid.set(id.oid, {
      id,
      name: qualifiedName(id.schema, id.table),
      columns: [],
      primary_key: null,
      foreign_keys_out: [],
      foreign_keys_in: [],
      indexes: [],
    });
  }
  const oids = [...byOid.keys()];
  if (oids.length > 0) {
    // A negative n_distinct is a fraction of rows, common on small tables; scale it by the row estimate.
    // A partitioned table only has statistics over its partitions (inherited); a plain table's own are not.
    const columns = await client.query<{
      oid: number;
      name: string;
      type: string;
      nullable: boolean;
      null_frac: number | null;
      n_distinct: number | null;
      common_vals: unknown[] | null;
      common_freqs: number[] | null;
    }>(
      `SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              s.null_frac, s.n_distinct,
              CASE WHEN (CASE WHEN s.n_distinct < 0 THEN -s.n_distinct * c.reltuples ELSE s.n_distinct END)
                          BETWEEN 1 AND ${ENUM_LIKE_MAX_DISTINCT}
                   -- As text for bigint and numeric, like query returns them: JSON numbers would lose precision.
                   THEN CASE WHEN a.atttypid IN ('int8'::regtype, 'numeric'::regtype)
                             THEN to_json(s.most_common_vals::text::text[]) ELSE array_to_json(s.most_common_vals) END
              END AS common_vals,
              s.most_common_freqs AS common_freqs
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
                            AND s.inherited = (c.relkind = 'p')
       WHERE a.attrelid = ANY($1::oid[]) AND ${LIVE_COLUMN}
       ORDER BY a.attnum`,
      [oids],
    );
    // Skip the per-partition clones Postgres adds to the same table for an FK to a partitioned table. Constraints a
    // partition inherits from its parent belong to the partition and stay.
    const constraints = await client.query<{
      constraint: string;
      kind: "p" | "f";
      from_oid: number;
      from_schema: string;
      from_rel: string;
      from_columns: string[];
      to_oid: number;
      to_schema: string;
      to_rel: string;
      to_columns: string[];
    }>(
      `SELECT con.conname AS constraint, con.contype AS kind,
              con.conrelid AS from_oid, fn.nspname AS from_schema, fc.relname AS from_rel,
              ${attnames("con.conrelid", "con.conkey")} AS from_columns,
              con.confrelid AS to_oid, tn.nspname AS to_schema, tc.relname AS to_rel,
              ${attnames("con.confrelid", "con.confkey")} AS to_columns
       FROM pg_constraint con
       JOIN pg_class fc ON fc.oid = con.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       LEFT JOIN pg_class tc ON tc.oid = con.confrelid LEFT JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       WHERE NOT EXISTS (SELECT 1 FROM pg_constraint p WHERE p.oid = con.conparentid AND p.conrelid = con.conrelid)
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
    for (const { oid, name, type, nullable, null_frac, n_distinct, common_vals, common_freqs } of columns.rows) {
      const column: Column =
        null_frac === null || n_distinct === null
          ? { name, type, nullable, stats_available: false }
          : { name, type, nullable, stats_available: true, null_frac, n_distinct };
      if (column.stats_available && common_vals && common_freqs) {
        column.common_values = common_vals.map((value, i) => ({ value, frequency: Math.round(common_freqs[i] * 1000) / 1000 }));
      }
      byOid.get(oid)!.columns.push(column);
    }
    for (const c of constraints.rows) {
      if (c.kind === "p") {
        byOid.get(c.from_oid)!.primary_key = c.from_columns;
        continue;
      }
      const from = { oid: c.from_oid, schema: c.from_schema, table: c.from_rel };
      const to = { oid: c.to_oid, schema: c.to_schema, table: c.to_rel };
      const fk: ForeignKeyRef = {
        constraint: c.constraint,
        from_table: qualifiedName(from.schema, from.table),
        from_columns: c.from_columns,
        to_table: qualifiedName(to.schema, to.table),
        to_columns: c.to_columns,
        from,
        to,
      };
      byOid.get(from.oid)?.foreign_keys_out.push(fk);
      byOid.get(to.oid)?.foreign_keys_in.push(fk);
    }
    for (const { oid, ...index } of indexes.rows) byOid.get(oid)!.indexes.push(index);
  }
  return byOid;
}

/** Column names for a constraint's attnum array, in constraint order. */
function attnames(rel: string, keys: string): string {
  return `ARRAY(SELECT a.attname::text FROM unnest(${keys}) WITH ORDINALITY k(attnum, i)
                JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.attnum ORDER BY k.i)`;
}

/** Fetch primary-key columns for tables without reading indexes or stats, avoiding locks. */
export async function primaryKeys(client: pg.ClientBase, ids: TableId[]): Promise<Map<number, string[]>> {
  const oids = ids.map((id) => id.oid);
  if (oids.length === 0) return new Map();
  const { rows } = await client.query<{ oid: number; pk: string[] }>(
    `SELECT con.conrelid AS oid, ${attnames("con.conrelid", "con.conkey")} AS pk
     FROM pg_constraint con
     WHERE con.contype = 'p' AND con.conrelid = ANY($1::oid[])`,
    [oids],
  );
  return new Map(rows.map((r) => [r.oid, r.pk]));
}
