import pg from "pg";

// Shared Docker Postgres from docker-compose.yml; tests use their own database.
export const ADMIN_URL = process.env.QUERYIO_TEST_ADMIN_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";
export const TEST_DB = "queryio_test";
export const TEST_URL = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
})();

/** Run statements against the test database outside QueryIO (fixture setup and state checks). */
export async function sql(text: string): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: TEST_URL });
  await client.connect();
  try {
    return await client.query(text);
  } finally {
    await client.end();
  }
}

export async function tableExists(name: string): Promise<boolean> {
  const { rows } = await sql(`SELECT to_regclass('public.${name}') IS NOT NULL AS exists`);
  return rows[0].exists;
}
