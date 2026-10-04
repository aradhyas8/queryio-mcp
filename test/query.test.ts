import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core.js";
import { loadSettings } from "../src/settings.js";
import { sql, tableExists, TEST_URL } from "./db.js";

let core: Core;

beforeAll(async () => {
  await sql(`
    DROP TABLE IF EXISTS widgets;
    CREATE TABLE widgets (id int PRIMARY KEY, name text NOT NULL);
    INSERT INTO widgets VALUES (1, 'sprocket'), (2, 'gear');
  `);
  core = createCore(loadSettings({ QUERYIO_DATABASE_URL: TEST_URL }));
});

afterAll(() => core.close());

describe("query", () => {
  it("returns columns once and rows as arrays", async () => {
    const result = await core.query("SELECT id, name FROM widgets ORDER BY id");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toEqual([
      [1, "sprocket"],
      [2, "gear"],
    ]);
    expect(result.row_count).toBe(2);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("rejects multiple statements in one call", async () => {
    await expect(core.query("SELECT 1; SELECT 2")).rejects.toMatchObject({ code: "42601" });
  });

  it("cannot escape the read-only transaction with COMMIT; (security regression)", async () => {
    await expect(core.query("COMMIT; CREATE TABLE queryio_escape_test(id int)")).rejects.toMatchObject({ code: "42601" });
    expect(await tableExists("queryio_escape_test")).toBe(false);
    expect((await core.query("SELECT 1 AS ok")).rows).toEqual([[1]]);
  });

  it("does not persist DML", async () => {
    const readOnly = { code: "25006" };
    await expect(core.query("UPDATE widgets SET name = 'changed' WHERE id = 1 RETURNING id")).rejects.toMatchObject(readOnly);
    await expect(core.query("WITH d AS (DELETE FROM widgets RETURNING id) SELECT count(*) FROM d")).rejects.toMatchObject(readOnly);
    const { rows } = await sql("SELECT id, name FROM widgets ORDER BY id");
    expect(rows).toEqual([
      { id: 1, name: "sprocket" },
      { id: 2, name: "gear" },
    ]);
  });

  it("cancels a long statement server-side at statement_timeout and stays usable", async () => {
    const fast = createCore({ ...loadSettings({ QUERYIO_DATABASE_URL: TEST_URL }), statementTimeoutMs: 300 });
    try {
      const started = Date.now();
      await expect(fast.query("SELECT pg_sleep(5)")).rejects.toMatchObject({ code: "57014" });
      expect(Date.now() - started).toBeLessThan(2000);
      expect((await fast.query("SELECT 1 AS ok")).rows).toEqual([[1]]);
    } finally {
      await fast.close();
    }
  });

  it("fails within lock_timeout when a table is exclusively locked by another connection", async () => {
    const locker = new pg.Client({ connectionString: TEST_URL });
    await locker.connect();
    try {
      await locker.query("BEGIN; LOCK TABLE widgets IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await expect(core.query("SELECT * FROM widgets")).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await locker.end();
    }
    expect((await core.query("SELECT count(*)::int AS n FROM widgets")).rows).toEqual([[2]]);
  });
});
