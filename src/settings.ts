import { homedir } from "node:os";
import { join } from "node:path";

export interface Settings {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly maxRows: number;
  readonly maxResponseBytes: number;
  readonly maxValueLength: number;
  /** Rows returned per inspect_row relation. */
  readonly inspectRelatedRows: number;
  /** Maximum number of relations inspected in inspect_row before capping. */
  readonly inspectMaxRelations: number;
  /** Total server-side deadline for an inspect_row call in milliseconds. */
  readonly inspectDeadlineMs: number;
  /** Audit log path, or null when disabled. */
  readonly auditLog: string | null;
  readonly auditIncludeSql: boolean;
  /** Lowercase column names whose values are hidden; see isRedacted. */
  readonly redactPatterns: readonly string[];
}

const DEFAULT_REDACT_PATTERNS = [
  "password",
  "password_hash",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "private_key",
  "credential",
];

/** Read configuration once at startup. The connection comes only from QUERYIO_DATABASE_URL. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  const databaseUrl = env.QUERYIO_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "QUERYIO_DATABASE_URL is not set. Set it to a PostgreSQL connection string, e.g. postgres://user:pass@localhost:5432/db",
    );
  }
  // MCP clients leave `${VAR}` / `${env:VAR}` unexpanded when VAR is unset in their environment. Name only the placeholder, never the value.
  // A `:-default` part is dropped from the message because it can hold credentials.
  const unresolved = databaseUrl.match(/\$\{((?:env:)?[A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/);
  if (unresolved) {
    const placeholder = `\${${unresolved[1]}}`;
    throw new Error(
      `QUERYIO_DATABASE_URL contains the unresolved placeholder ${placeholder}. The MCP client did not substitute it, usually because the variable was not set in the environment that started the client. Set QUERYIO_DATABASE_URL there and restart the client.`,
    );
  }
  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer, got "${raw}"`);
    return Number(raw);
  };
  const list = (name: string): string[] =>
    (env[name] ?? "")
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
  const removed = list("QUERYIO_REDACT_REMOVE");
  const redactPatterns = [...new Set([...DEFAULT_REDACT_PATTERNS, ...list("QUERYIO_REDACT_ADD")])].filter(
    (p) => !removed.includes(p),
  );
  const auditLog = env.QUERYIO_AUDIT_LOG || join(homedir(), ".queryio", "audit.jsonl");
  return Object.freeze({
    databaseUrl,
    statementTimeoutMs: positiveInt("QUERYIO_STATEMENT_TIMEOUT_MS", 5000),
    lockTimeoutMs: positiveInt("QUERYIO_LOCK_TIMEOUT_MS", 1000),
    maxRows: positiveInt("QUERYIO_MAX_ROWS", 100),
    maxResponseBytes: positiveInt("QUERYIO_MAX_RESPONSE_BYTES", 32 * 1024),
    maxValueLength: positiveInt("QUERYIO_MAX_VALUE_LENGTH", 200),
    inspectRelatedRows: positiveInt("QUERYIO_INSPECT_RELATED_ROWS", 5),
    inspectMaxRelations: positiveInt("QUERYIO_INSPECT_MAX_RELATIONS", 25),
    inspectDeadlineMs: positiveInt("QUERYIO_INSPECT_DEADLINE_MS", 5000),
    auditLog: auditLog.toLowerCase() === "off" ? null : auditLog,
    auditIncludeSql: env.QUERYIO_AUDIT_INCLUDE_SQL === "true",
    redactPatterns: Object.freeze(redactPatterns),
  });
}
