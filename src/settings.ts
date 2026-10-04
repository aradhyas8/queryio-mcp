export interface Settings {
  readonly databaseUrl: string;
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
}

/** Read configuration once at startup. The connection comes only from QUERYIO_DATABASE_URL. */
export function loadSettings(env: Record<string, string | undefined>): Settings {
  const databaseUrl = env.QUERYIO_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "QUERYIO_DATABASE_URL is not set. Set it to a PostgreSQL connection string, e.g. postgres://user:pass@localhost:5432/db",
    );
  }
  return Object.freeze({ databaseUrl, statementTimeoutMs: 5000, lockTimeoutMs: 1000 });
}
