import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core.js";
import { sql, testSettings } from "./db.js";

let core: Core;

// Own schema, so tables from other test files don't leak into list results.
beforeAll(async () => {
  await sql(`
    DROP SCHEMA IF EXISTS cat CASCADE;
    CREATE SCHEMA cat;
    CREATE TABLE cat.orbit_users (id int PRIMARY KEY, email text NOT NULL UNIQUE, manager_id int REFERENCES cat.orbit_users (id));
    CREATE TABLE cat.transfers (
      id int PRIMARY KEY,
      sender_id int NOT NULL CONSTRAINT transfers_sender_fk REFERENCES cat.orbit_users (id),
      recipient_id int NOT NULL CONSTRAINT transfers_recipient_fk REFERENCES cat.orbit_users (id),
      galaxy_note text
    );
    CREATE TABLE cat.memberships (
      org_id int,
      user_id int REFERENCES cat.orbit_users (id),
      role text,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE INDEX memberships_role_idx ON cat.memberships (lower(role)) WHERE role IS NOT NULL;
    CREATE TABLE cat.grants (
      id int PRIMARY KEY,
      org_id int NOT NULL,
      user_id int NOT NULL,
      CONSTRAINT grants_membership_fk FOREIGN KEY (org_id, user_id) REFERENCES cat.memberships (org_id, user_id)
    );
    INSERT INTO cat.orbit_users SELECT g, 'u' || g || '@x', NULL FROM generate_series(1, 30) g;
    ANALYZE cat.orbit_users;
  `);
  core = createCore(testSettings());
});

afterAll(() => core.close());

describe("list_tables", () => {
  it("returns schema-qualified names, catalog row estimates and column counts", async () => {
    const { tables } = await core.listTables();
    expect(tables).toContainEqual({ name: "cat.orbit_users", estimated_rows: 30, columns: 3 });
    // Never analyzed: the estimate is unknown, not zero.
    expect(tables).toContainEqual({ name: "cat.grants", estimated_rows: null, columns: 3 });
    expect(tables.some((t) => /^(pg_catalog|information_schema)\./.test(t.name))).toBe(false);
  });

  it("filters by table name, case-insensitively", async () => {
    const { tables } = await core.listTables("ORBIT");
    expect(tables.map((t) => t.name)).toEqual(["cat.orbit_users"]);
  });

  it("filters by column name", async () => {
    const { tables } = await core.listTables("Galaxy");
    expect(tables.map((t) => t.name)).toEqual(["cat.transfers"]);
  });
});

describe("describe_tables", () => {
  it("describes columns, primary key, foreign keys in and out, and indexes", async () => {
    const { tables } = await core.describeTables(["cat.orbit_users"]);
    expect(tables).toEqual([
      {
        name: "cat.orbit_users",
        columns: [
          { name: "id", type: "integer", nullable: false, stats_available: true, null_frac: 0, n_distinct: -1 },
          { name: "email", type: "text", nullable: false, stats_available: true, null_frac: 0, n_distinct: -1 },
          { name: "manager_id", type: "integer", nullable: true, stats_available: true, null_frac: 1, n_distinct: 0 },
        ],
        primary_key: ["id"],
        foreign_keys_out: [
          // Self-reference: appears both out and in.
          {
            constraint: "orbit_users_manager_id_fkey",
            from_table: "cat.orbit_users",
            from_columns: ["manager_id"],
            to_table: "cat.orbit_users",
            to_columns: ["id"],
          },
        ],
        foreign_keys_in: expect.any(Array),
        indexes: [
          { name: "orbit_users_email_key", columns: ["email"], unique: true, primary: false, predicate: null },
          { name: "orbit_users_pkey", columns: ["id"], unique: true, primary: true, predicate: null },
        ],
      },
    ]);
    // Two FKs from the same table stay separate relations.
    expect(tables[0]).toMatchObject({
      foreign_keys_in: [
        { constraint: "memberships_user_id_fkey", from_table: "cat.memberships", from_columns: ["user_id"], to_columns: ["id"] },
        { constraint: "orbit_users_manager_id_fkey", from_table: "cat.orbit_users" },
        { constraint: "transfers_recipient_fk", from_table: "cat.transfers", from_columns: ["recipient_id"] },
        { constraint: "transfers_sender_fk", from_table: "cat.transfers", from_columns: ["sender_id"] },
      ],
    });
  });

  it("represents composite keys in column order, and returns a batch in request order", async () => {
    const { tables } = await core.describeTables(["cat.grants", "cat.memberships"]);
    expect(tables.map((t) => t.name)).toEqual(["cat.grants", "cat.memberships"]);
    expect(tables[0]).toMatchObject({
      foreign_keys_out: [
        {
          constraint: "grants_membership_fk",
          from_table: "cat.grants",
          from_columns: ["org_id", "user_id"],
          to_table: "cat.memberships",
          to_columns: ["org_id", "user_id"],
        },
      ],
    });
    expect(tables[1]).toMatchObject({
      primary_key: ["org_id", "user_id"],
      foreign_keys_in: [{ constraint: "grants_membership_fk", from_columns: ["org_id", "user_id"] }],
      indexes: [
        { name: "memberships_pkey", columns: ["org_id", "user_id"], primary: true },
        { name: "memberships_role_idx", columns: ["lower(role)"], unique: false, predicate: "role IS NOT NULL" },
      ],
    });
  });

  it("reports unknown tables per table without failing the batch", async () => {
    const { tables } = await core.describeTables(["cat.nope", "orbit_users", "cat.transfers", "x'; DROP TABLE cat.grants; --"]);
    expect(tables).toMatchObject([
      { name: "cat.nope", error: { category: "not_found" } },
      { name: "orbit_users", error: { category: "not_found" } },
      { name: "cat.transfers", primary_key: ["id"] },
      { name: "x'; DROP TABLE cat.grants; --", error: { category: "not_found" } },
    ]);
    expect((await core.describeTables(["cat.grants"])).tables[0]).not.toHaveProperty("error");
  });

  it("gives a partition its inherited keys, without per-partition clones of FKs to a partitioned table", async () => {
    await sql(`
      CREATE TABLE cat.events (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
      CREATE TABLE cat.events_2026 PARTITION OF cat.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      CREATE TABLE cat.event_refs (id int PRIMARY KEY, event_id int, event_at date,
        CONSTRAINT event_refs_event_fk FOREIGN KEY (event_id, event_at) REFERENCES cat.events (id, at));
    `);
    const { tables } = await core.describeTables(["cat.events_2026", "cat.event_refs", "cat.events"]);
    expect(tables[0]).toMatchObject({ primary_key: ["id", "at"] });
    expect(tables[1]).toMatchObject({ foreign_keys_out: [{ constraint: "event_refs_event_fk", to_table: "cat.events" }] });
    expect((tables[1] as { foreign_keys_out: unknown[] }).foreign_keys_out).toHaveLength(1);
    expect(tables[2]).toMatchObject({ foreign_keys_in: [{ constraint: "event_refs_event_fk" }] });
  });

  it("reports planner statistics per column, with common values only for enum-like, non-redacted columns", async () => {
    await sql(`
      DROP TABLE IF EXISTS cat.accounts;
      -- Autovacuum must not analyze it before the never-analyzed assertion.
      CREATE TABLE cat.accounts (id int PRIMARY KEY, status text, email text, token text, note text, label text)
        WITH (autovacuum_enabled = off);
      INSERT INTO cat.accounts
        SELECT g, CASE WHEN g <= 720 THEN 'active' WHEN g <= 930 THEN 'pending' ELSE 'disabled' END,
               'u' || g || '@x', CASE WHEN g % 2 = 0 THEN 'tok-a' ELSE 'tok-b' END,
               CASE WHEN g % 4 = 0 THEN repeat('n', 300) END, repeat(chr(97 + g % 10), 150)
        FROM generate_series(1, 1000) g;
    `);
    // Never analyzed: no statistics, and no zeros made up in their place.
    const before = await core.describeTables(["cat.accounts"]);
    expect((before.tables[0] as { columns: unknown[] }).columns).toContainEqual({
      name: "status",
      type: "text",
      nullable: true,
      stats_available: false,
    });

    await sql("ANALYZE cat.accounts");
    const { tables } = await core.describeTables(["cat.accounts"]);
    const columns = Object.fromEntries((tables[0] as { columns: { name: string }[] }).columns.map((c) => [c.name, c]));
    expect(columns.status).toEqual({
      name: "status",
      type: "text",
      nullable: true,
      stats_available: true,
      null_frac: 0,
      n_distinct: 3,
      common_values: [
        { value: "active", frequency: 0.72 },
        { value: "pending", frequency: 0.21 },
        { value: "disabled", frequency: 0.07 },
      ],
    });
    // High cardinality: shape only, no values.
    expect(columns.email).toEqual({ name: "email", type: "text", nullable: true, stats_available: true, null_frac: 0, n_distinct: -1 });
    // Matches a redaction pattern: enum-like, yet no statistics at all, marked as hidden rather than missing.
    expect(columns.token).toEqual({ name: "token", type: "text", nullable: true, stats_available: false, redacted: true });
    // Enum-like, but ten long values exceed the cap: shape only.
    expect(columns.label).toEqual({ name: "label", type: "text", nullable: true, stats_available: true, null_frac: 0, n_distinct: 10 });
    // Common values are truncated like any other value.
    expect(columns.note).toMatchObject({ null_frac: 0.75, n_distinct: 1, common_values: [{ value: expect.stringMatching(/^n{200}…\[\+100B\]$/), frequency: 0.25 }] });
  });

  it("treats a small table's fractional n_distinct as enum-like", async () => {
    await sql(`
      DROP TABLE IF EXISTS cat.seeds;
      CREATE TABLE cat.seeds (id int, status text);
      INSERT INTO cat.seeds SELECT g, (ARRAY['a', 'b', 'c'])[g % 3 + 1] FROM generate_series(1, 20) g;
      ANALYZE cat.seeds;
    `);
    const { tables } = await core.describeTables(["cat.seeds"]);
    const status = (tables[0] as { columns: { name: string }[] }).columns.find((c) => c.name === "status");
    expect(status).toMatchObject({ n_distinct: -0.15, common_values: expect.arrayContaining([{ value: "a", frequency: 0.3 }]) });
  });

  it("returns bigint and numeric common values as exact strings, like query does", async () => {
    await sql(`
      DROP TABLE IF EXISTS cat.ledger;
      CREATE TABLE cat.ledger (big bigint, amount numeric, n int);
      INSERT INTO cat.ledger SELECT 9007199254740993, 0.10000000000000000001, 7 FROM generate_series(1, 50);
      ANALYZE cat.ledger;
    `);
    const { tables } = await core.describeTables(["cat.ledger"]);
    expect((tables[0] as { columns: unknown[] }).columns).toMatchObject([
      { name: "big", common_values: [{ value: "9007199254740993", frequency: 1 }] },
      { name: "amount", common_values: [{ value: "0.10000000000000000001", frequency: 1 }] },
      { name: "n", common_values: [{ value: 7, frequency: 1 }] },
    ]);
  });

  it("returns no primary key for a table without one", async () => {
    await sql("DROP TABLE IF EXISTS cat.loose; CREATE TABLE cat.loose (v text)");
    const { tables } = await core.describeTables(["cat.loose"]);
    expect(tables[0]).toMatchObject({ primary_key: null, foreign_keys_out: [], foreign_keys_in: [], indexes: [] });
  });
});

it("audits both tools with tables involved and bytes, never the filter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queryio-audit-"));
  const path = join(dir, "audit.jsonl");
  const audited = createCore(testSettings({ QUERYIO_AUDIT_LOG: path }));
  try {
    await audited.listTables("galaxy");
    await audited.describeTables(["cat.transfers", "cat.nope"]);
  } finally {
    await audited.close();
  }
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  const events = raw.trim().split("\n").map((l) => JSON.parse(l));
  expect(events).toEqual([
    {
      ts: expect.any(String),
      tool: "list_tables",
      duration_ms: expect.any(Number),
      success: true,
      tables_returned: 1,
      bytes_returned: expect.any(Number),
    },
    {
      ts: expect.any(String),
      tool: "describe_tables",
      duration_ms: expect.any(Number),
      success: true,
      tables: ["cat.transfers"],
      tables_failed: 1,
      bytes_returned: expect.any(Number),
    },
  ]);
  expect(raw).not.toContain("galaxy");
  expect(raw).not.toContain("cat.nope");
});
