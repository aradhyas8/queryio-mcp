import pg from "pg";
import Cursor from "pg-cursor";
import type { Settings } from "./settings.js";

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  duration_ms: number;
}

export interface Core {
  query(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
}

const BATCH_SIZE = 100;

export function createCore(settings: Settings): Core {
  const pool = new pg.Pool({ connectionString: settings.databaseUrl, max: 2 });
  // An idle client losing its connection must not crash the server; the pool replaces it.
  pool.on("error", () => {});

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

  return {
    query(sql) {
      const started = performance.now();
      return readOnly(async (client) => {
        // pg-cursor runs the statement as an extended-protocol portal, which rejects multiple statements.
        const cursor = client.query(new Cursor(sql, undefined, { rowMode: "array" }));
        const rows: unknown[][] = [];
        let fields: pg.FieldDef[] = [];
        for (;;) {
          const batch = await new Promise<unknown[][]>((resolve, reject) =>
            cursor.read(BATCH_SIZE, (err, rows, result) => {
              if (err) return reject(err);
              // Once the portal is done, pg-cursor calls back without a result.
              if (result) fields = result.fields;
              resolve(rows);
            }),
          );
          if (batch.length === 0) break;
          rows.push(...batch);
        }
        // No close on error: pg-cursor already synced, and closing then would wait for a readyForQuery that has passed.
        await cursor.close();
        return {
          columns: fields.map((f) => f.name),
          rows,
          row_count: rows.length,
          duration_ms: Math.round(performance.now() - started),
        };
      });
    },
    close: () => pool.end(),
  };
}
