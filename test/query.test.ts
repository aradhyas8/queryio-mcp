import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core.js";
import { sql, tableExists, TEST_URL, testSettings } from "./db.js";

let core: Core;

beforeAll(async () => {
  await sql(`
    DROP TABLE IF EXISTS widgets;
    CREATE TABLE widgets (id int PRIMARY KEY, name text NOT NULL);
    INSERT INTO widgets VALUES (1, 'sprocket'), (2, 'gear');
  `);
  core = createCore(testSettings());
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
    await expect(core.query("COMMIT; CREATE TABLE queryio_escape_test(id int)")).rejects.toThrow();
    // Past the leading-command gate, the extended protocol still refuses the second statement.
    await expect(core.query("SELECT 1; COMMIT; CREATE TABLE queryio_escape_test(id int)")).rejects.toMatchObject({
      code: "42601",
    });
    expect(await tableExists("queryio_escape_test")).toBe(false);
    expect((await core.query("SELECT 1 AS ok")).rows).toEqual([[1]]);
  });

  it("does not persist DML", async () => {
    await expect(core.query("UPDATE widgets SET name = 'changed' WHERE id = 1 RETURNING id")).rejects.toThrow();
    // A writable CTE passes the gate; the read-only transaction stops it.
    await expect(core.query("WITH d AS (DELETE FROM widgets RETURNING id) SELECT count(*) FROM d")).rejects.toMatchObject({
      code: "25006",
      category: "read_only",
    });
    const { rows } = await sql("SELECT id, name FROM widgets ORDER BY id");
    expect(rows).toEqual([
      { id: 1, name: "sprocket" },
      { id: 2, name: "gear" },
    ]);
  });

  it("cancels a long statement server-side at statement_timeout and stays usable", async () => {
    const fast = createCore(testSettings({ QUERYIO_STATEMENT_TIMEOUT_MS: "300" }));
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
      await expect(core.query("SELECT * FROM widgets")).rejects.toMatchObject({ code: "55P03", category: "lock_timeout" });
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await locker.end();
    }
    expect((await core.query("SELECT count(*)::int AS n FROM widgets")).rows).toEqual([[2]]);
  });

  it("releases session-level advisory locks before returning the connection to the pool", async () => {
    const lockId = 424242;
    await core.query(`SELECT pg_advisory_lock(${lockId})`);
    const inspector = new pg.Client({ connectionString: TEST_URL });
    await inspector.connect();
    try {
      const { rows } = await inspector.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockId]);
      expect(rows[0].acquired).toBe(true);
      await inspector.query("SELECT pg_advisory_unlock_all()");
    } finally {
      await inspector.end();
    }
  });

  it("returns date and timestamp as exact text strings and leaves timestamptz unchanged", async () => {
    const result = await core.query(`
      SELECT
        DATE '2026-09-04' AS d,
        TIMESTAMP '2026-09-04 10:00:00' AS ts,
        TIMESTAMPTZ '2026-09-04 10:00:00+00' AS tstz
    `);
    expect(result.rows).toEqual([
      ["2026-09-04", "2026-09-04 10:00:00", expect.any(Date)],
    ]);
  });

  it("returns date[] and timestamp[] as PostgreSQL array literal text strings", async () => {
    const result = await core.query(`
      SELECT
        ARRAY[DATE '2026-09-04', DATE '2026-09-05'] AS d_arr,
        ARRAY[TIMESTAMP '2026-09-04 10:00:00'] AS ts_arr
    `);
    expect(result.rows).toEqual([
      ["{2026-09-04,2026-09-05}", '{"2026-09-04 10:00:00"}'],
    ]);
  });

  it("does not mutate the process-global pg.types registry (pool-scoped override)", () => {
    const dateParser = pg.types.getTypeParser(pg.types.builtins.DATE, "text");
    const result = dateParser("2026-09-04");
    expect(result).toBeInstanceOf(Date);
  });

  it("truncates and redacts date values as ordinary strings", async () => {
    const limited = createCore(testSettings({ QUERYIO_MAX_VALUE_LENGTH: "10", QUERYIO_REDACT_ADD: "secret_date" }));
    try {
      const result = await limited.query(`
        SELECT
          ARRAY['2026-09-04'::date, '2026-09-05'::date, '2026-09-06'::date, '2026-09-07'::date, '2026-09-08'::date] AS long_date_arr,
          DATE '2026-09-04' AS secret_date
      `);
      expect(result.rows).toEqual([
        [expect.stringMatching(/^\{2026-09-0…\[\+\d+B\]$/), "[redacted]"],
      ]);
      expect(result.values_truncated).toBe(1);
      expect(result.values_redacted).toBe(1);
    } finally {
      await limited.close();
    }
  });
});

describe("bounded results", () => {
  async function withCore(env: Record<string, string>, run: (c: Core) => Promise<void>) {
    const c = createCore(testSettings(env));
    try {
      await run(c);
    } finally {
      await c.close();
    }
  }

  it("stops at the row cap with has_more and truncated_by rows", async () => {
    await withCore({ QUERYIO_MAX_ROWS: "5" }, async (c) => {
      const result = await c.query("SELECT g FROM generate_series(1, 6) g");
      expect(result.rows).toEqual([[1], [2], [3], [4], [5]]);
      expect(result).toMatchObject({ row_count: 5, has_more: true, truncated_by: "rows", values_truncated: 0 });
    });
  });

  it("returns exactly max_rows rows without has_more", async () => {
    await withCore({ QUERYIO_MAX_ROWS: "5" }, async (c) => {
      const result = await c.query("SELECT g FROM generate_series(1, 5) g");
      expect(result).toMatchObject({ row_count: 5, has_more: false, truncated_by: null });
    });
  });

  it("stops at the byte budget before the row cap and stays within it", async () => {
    await withCore({ QUERYIO_MAX_RESPONSE_BYTES: "2000" }, async (c) => {
      const result = await c.query("SELECT g, repeat('x', 150) AS pad FROM generate_series(1, 50) g");
      expect(result).toMatchObject({ has_more: true, truncated_by: "bytes" });
      expect(result.row_count).toBeGreaterThan(5);
      expect(result.row_count).toBeLessThan(13);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2000);
    });
  });

  it("cuts long values with an omitted-size marker and counts them", async () => {
    const result = await core.query("SELECT repeat('a', 300) AS s, repeat('b', 3476) AS t, 'short' AS u");
    expect(result.rows).toEqual([["a".repeat(200) + "…[+100B]", "b".repeat(200) + "…[+3.2KB]", "short"]]);
    expect(result.values_truncated).toBe(2);
  });

  it("keeps a value whole when the marker would make it longer", async () => {
    const result = await core.query("SELECT repeat('c', 203) AS s");
    expect(result.rows).toEqual([["c".repeat(203)]]);
    expect(result.values_truncated).toBe(0);
  });

  it("truncates long json values as text", async () => {
    const result = await core.query(`SELECT json_build_object('k', repeat('z', 500)) AS j, json_build_object('k', 1) AS small`);
    const [[big, small]] = result.rows as [string, unknown][];
    expect(big).toMatch(/^\{"k":"z+…\[\+\d+B\]$/);
    expect(big.startsWith('{"k":"' + "z".repeat(194))).toBe(true);
    expect(small).toEqual({ k: 1 });
    expect(result.values_truncated).toBe(1);
  });

  it("reads a huge streaming source only up to the cap, fast (bounded retrieval regression)", async () => {
    const started = Date.now();
    const result = await core.query("SELECT g, repeat('x', 100) FROM (SELECT generate_series(1, 50000000) AS g) s");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ row_count: 100, has_more: true, truncated_by: "rows" });
    expect((await core.query("SELECT 1 AS ok")).rows).toEqual([[1]]);
  });
});

describe("read-oriented gate", () => {
  const readOriented = { category: "read_oriented", message: expect.stringMatching(/QueryIO is read-oriented/) };

  it.each([
    "EXPLAIN SELECT 1",
    "EXPLAIN ANALYZE SELECT 1",
    "COPY widgets TO STDOUT",
    "CREATE TABLE gate_test (id int)",
    "DROP TABLE widgets",
    "INSERT INTO widgets VALUES (9, 'x')",
    "update widgets SET name = 'x'",
    "DELETE FROM widgets",
    "  -- comment\n  TRUNCATE widgets",
    "SET statement_timeout = 0",
    "",
  ])("rejects %j", async (statement) => {
    await expect(core.query(statement)).rejects.toMatchObject(readOriented);
  });

  it.each([
    ["SELECT 1 AS n", [[1]]],
    ["with t AS (SELECT 1 AS n) SELECT n FROM t", [[1]]],
    ["VALUES (1)", [[1]]],
    ["TABLE widgets", [[1, "sprocket"], [2, "gear"]]],
    ["SHOW lock_timeout", [["1s"]]],
    ["/* why */ -- note\n (SELECT 1)", [[1]]],
  ])("allows %j", async (statement, rows) => {
    expect((await core.query(statement)).rows).toEqual(rows);
  });
});

describe("structured errors", () => {
  it("returns the Postgres code, category, message and hint", async () => {
    await expect(core.query("SELECT nonexistent_fn(1)")).rejects.toMatchObject({
      code: "42883",
      category: "syntax_error_or_access_rule_violation",
      message: expect.stringMatching(/nonexistent_fn/),
      hint: expect.stringMatching(/explicit type casts/),
    });
  });

  it("reports a statement timeout under its own category", async () => {
    const fast = createCore(testSettings({ QUERYIO_STATEMENT_TIMEOUT_MS: "300" }));
    try {
      await expect(fast.query("SELECT pg_sleep(5)")).rejects.toMatchObject({ code: "57014", category: "timeout" });
    } finally {
      await fast.close();
    }
  });
});

describe("redaction", () => {
  const secrets = `SELECT 1 AS id, 'h' AS "Password_Hash", 't' AS token, 'k' AS api_key, 'a@b.c' AS email,
    now() AS token_expires_at, NULL::text AS secret`;

  it("redacts columns matching default patterns case-insensitively and counts them", async () => {
    const result = await core.query(secrets);
    expect(result.rows).toEqual([[1, "[redacted]", "[redacted]", "[redacted]", "a@b.c", expect.any(Date), "[redacted]"]]);
    expect(result).toMatchObject({ columns_redacted: 4, values_redacted: 4 });
  });

  it("applies added patterns and drops removed ones", async () => {
    const c = createCore(testSettings({ QUERYIO_REDACT_ADD: " Email ,ssn", QUERYIO_REDACT_REMOVE: "token,api_key" }));
    try {
      const result = await c.query(secrets);
      expect(result.rows).toEqual([[1, "[redacted]", "t", "k", "[redacted]", expect.any(Date), "[redacted]"]]);
      expect(result).toMatchObject({ columns_redacted: 3, values_redacted: 3 });
    } finally {
      await c.close();
    }
  });

  it("redacts before value truncation and byte accounting", async () => {
    const c = createCore(testSettings({ QUERYIO_MAX_RESPONSE_BYTES: "600" }));
    try {
      const result = await c.query("SELECT g, repeat('x', 5000) AS secret FROM generate_series(1, 5) g");
      expect(result).toMatchObject({ row_count: 5, has_more: false, values_truncated: 0, values_redacted: 5 });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(600);
    } finally {
      await c.close();
    }
  });

  it("reports redacted columns even when no rows come back", async () => {
    const result = await core.query("SELECT 1 AS id, 'x' AS password WHERE false");
    expect(result).toMatchObject({ row_count: 0, columns_redacted: 1, values_redacted: 0 });
  });
});
