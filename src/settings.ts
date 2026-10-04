import { homedir } from "node:os";
import { join } from "node:path";

export interface Settings {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly maxRows: number;
  readonly maxResponseBytes: number;
  readonly maxValueLength: number;
  /** Audit log path, or null when disabled. */
  readonly auditLog: string | null;
  readonly auditIncludeSql: boolean;
}

/** Read configuration once at startup. The connection comes only from QUERYIO_DATABASE_URL. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  const databaseUrl = env.QUERYIO_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "QUERYIO_DATABASE_URL is not set. Set it to a PostgreSQL connection string, e.g. postgres://user:pass@localhost:5432/db",
    );
  }
  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer, got "${raw}"`);
    return Number(raw);
  };
  const auditLog = env.QUERYIO_AUDIT_LOG || join(homedir(), ".queryio", "audit.jsonl");
  return Object.freeze({
    databaseUrl,
    statementTimeoutMs: positiveInt("QUERYIO_STATEMENT_TIMEOUT_MS", 5000),
    lockTimeoutMs: positiveInt("QUERYIO_LOCK_TIMEOUT_MS", 1000),
    maxRows: positiveInt("QUERYIO_MAX_ROWS", 100),
    maxResponseBytes: positiveInt("QUERYIO_MAX_RESPONSE_BYTES", 32 * 1024),
    maxValueLength: positiveInt("QUERYIO_MAX_VALUE_LENGTH", 200),
    auditLog: auditLog.toLowerCase() === "off" ? null : auditLog,
    auditIncludeSql: env.QUERYIO_AUDIT_INCLUDE_SQL === "true",
  });
}
