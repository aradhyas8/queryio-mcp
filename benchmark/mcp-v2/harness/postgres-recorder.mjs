// Database-level instrumentation, identical for every arm. PostgreSQL logs every statement
// (log_statement=all, jsonlog); each run connects as its own opaque login role, so a run's SQL is
// exactly the log entries whose user is that role. Harness/setup SQL runs as postgres and is excluded.
import { withClient } from "./lib.mjs";

// Transaction control, session settings, and empty statements (connection pings) are counted
// separately from statements that actually read data or catalogs.
const CONTROL = /^\s*(;\s*)*$|^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SET|RESET|SAVEPOINT|RELEASE|DISCARD|DEALLOCATE)\b/i;

export class LogTail {
  #offsets = new Map(); // log file -> bytes consumed
  #byUser = new Map();
  #chain = Promise.resolve();

  /** Skip everything already in the logs. */
  async init() {
    for (const f of await this.#files()) this.#offsets.set(f.name, f.size);
  }

  /** Read new complete lines from every jsonlog file and bucket them by user. Serialized. */
  poll() {
    this.#chain = this.#chain.then(() => this.#poll());
    return this.#chain;
  }

  /** Remove and return the raw log entries recorded for one role. */
  take(user) {
    const events = this.#byUser.get(user) ?? [];
    this.#byUser.delete(user);
    return events;
  }

  async #files() {
    return withClient("postgres", async (c) =>
      (await c.query("SELECT name, size::bigint AS size FROM pg_ls_logdir() WHERE name LIKE '%.json' ORDER BY name")).rows.map((r) => ({ name: r.name, size: Number(r.size) })),
    );
  }

  async #poll() {
    const files = await this.#files();
    await withClient("postgres", async (c) => {
      for (const f of files) {
        const from = this.#offsets.get(f.name) ?? 0;
        if (f.size <= from) continue;
        const { rows } = await c.query("SELECT pg_read_binary_file($1, $2, $3) AS b", [`log/${f.name}`, from, f.size - from]);
        const buf = rows[0].b;
        const end = buf.lastIndexOf(0x0a);
        if (end < 0) continue;
        this.#offsets.set(f.name, from + end + 1);
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          let e;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          if (!e.user) continue;
          if (!this.#byUser.has(e.user)) this.#byUser.set(e.user, []);
          this.#byUser.get(e.user).push(e);
        }
      }
    });
  }
}

/** Normalize raw jsonlog entries into sql events (statement / error / other). */
export function sqlEvents(raw) {
  return raw.map((e) => {
    const base = { log_ts: e.timestamp, pid: e.pid, session_id: e.session_id, dbname: e.dbname, application_name: e.application_name || null };
    const m = /^(statement|execute [^:]*): ([\s\S]*)$/.exec(e.message ?? "");
    if (m && e.error_severity === "LOG") {
      return { ...base, kind: "statement", protocol: m[1].startsWith("execute") ? "extended" : "simple", control: CONTROL.test(m[2]), sql: m[2] };
    }
    if (["ERROR", "FATAL", "PANIC"].includes(e.error_severity)) {
      return { ...base, kind: "error", severity: e.error_severity, state_code: e.state_code, message: e.message, sql: e.statement ?? null };
    }
    return { ...base, kind: "other", severity: e.error_severity, message: e.message };
  });
}

export function sqlMetrics(events) {
  const statements = events.filter((e) => e.kind === "statement");
  const errors = events.filter((e) => e.kind === "error");
  return {
    sql_statements: statements.length,
    sql_statements_excl_control: statements.filter((e) => !e.control).length,
    sql_errors: errors.length,
    sql_sessions: new Set(events.map((e) => e.session_id)).size,
    sql_databases: [...new Set(events.map((e) => e.dbname).filter(Boolean))].sort(),
  };
}

/** Rows and calls per role from pg_stat_statements (optional secondary measure). */
export async function statStatements(role) {
  return withClient("postgres", async (c) => {
    const { rows } = await c.query(
      `SELECT coalesce(sum(s.calls), 0)::bigint AS calls, coalesce(sum(s.rows), 0)::bigint AS rows
       FROM pg_stat_statements s JOIN pg_roles r ON r.oid = s.userid WHERE r.rolname = $1`,
      [role],
    );
    return { pgss_calls: Number(rows[0].calls), pgss_rows: Number(rows[0].rows) };
  });
}
