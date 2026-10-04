import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, type Core, type InspectRowResult, type Relation } from "../src/core.js";
import { sql, testSettings } from "./db.js";

let core: Core;

beforeAll(async () => {
  await sql(`
    DROP SCHEMA IF EXISTS ins CASCADE;
    CREATE SCHEMA ins;
    CREATE TABLE ins.users (id int PRIMARY KEY, email text, password_hash text, bio text, manager_id int REFERENCES ins.users (id));
    CREATE TABLE ins.orgs (id int PRIMARY KEY, name text);
    CREATE TABLE ins.memberships (
      org_id int REFERENCES ins.orgs (id),
      user_id int REFERENCES ins.users (id),
      role text,
      PRIMARY KEY (org_id, user_id)
    );
    CREATE TABLE ins.grants (
      id int PRIMARY KEY, org_id int, user_id int,
      CONSTRAINT grants_membership_fk FOREIGN KEY (org_id, user_id) REFERENCES ins.memberships (org_id, user_id)
    );
    CREATE TABLE ins.transfers (
      id int PRIMARY KEY,
      sender_id int CONSTRAINT transfers_sender_fk REFERENCES ins.users (id),
      recipient_id int CONSTRAINT transfers_recipient_fk REFERENCES ins.users (id),
      api_key text
    );
    CREATE TABLE ins.notes (body text, user_id int REFERENCES ins.users (id));
    CREATE TABLE ins.tags (name text PRIMARY KEY);

    -- Reports are inserted in reverse, so physical order differs from primary-key order.
    INSERT INTO ins.users VALUES (1, 'u1@x', 'hash-1', repeat('b', 300), NULL);
    INSERT INTO ins.users SELECT g, 'u' || g || '@x', 'hash-' || g, NULL, 1 FROM generate_series(8, 2, -1) g;
    INSERT INTO ins.users SELECT g, 'u' || g || '@x', 'hash-' || g, NULL, 2 FROM generate_series(13, 9, -1) g;
    INSERT INTO ins.orgs VALUES (10, 'acme');
    INSERT INTO ins.memberships VALUES (10, 1, 'admin');
    INSERT INTO ins.grants VALUES (100, 10, 1);
    INSERT INTO ins.transfers VALUES (500, 1, 2, 'k-500'), (501, 2, 1, 'k-501');
    INSERT INTO ins.notes VALUES ('hi', 2);
    INSERT INTO ins.tags VALUES ('a''b'), ('zebra-key');
  `);
  core = createCore(testSettings());
});

afterAll(() => core.close());

function relation(result: InspectRowResult, direction: Relation["direction"], constraint: string): Relation {
  const found = result.relations.find((r) => r.direction === direction && r.constraint === constraint);
  if (!found) throw new Error(`no ${direction} relation ${constraint}`);
  return found;
}

describe("inspect_row", () => {
  it("returns the root row and its labeled outgoing and incoming relations", async () => {
    const result = await core.inspectRow("ins.users", { id: 2 });
    expect(result).toMatchObject({
      table: "ins.users",
      columns: ["id", "email", "password_hash", "bio", "manager_id"],
      row: [2, "u2@x", "[redacted]", null, 1],
    });
    // Outgoing first, then incoming; each in constraint-name order. A self-reference is both.
    expect(result.relations.map((r) => [r.direction, r.constraint])).toEqual([
      ["outgoing", "users_manager_id_fkey"],
      ["incoming", "memberships_user_id_fkey"],
      ["incoming", "notes_user_id_fkey"],
      ["incoming", "transfers_recipient_fk"],
      ["incoming", "transfers_sender_fk"],
      ["incoming", "users_manager_id_fkey"],
    ]);
    expect(relation(result, "outgoing", "users_manager_id_fkey")).toEqual({
      direction: "outgoing",
      table: "ins.users",
      constraint: "users_manager_id_fkey",
      source_columns: ["manager_id"],
      target_columns: ["id"],
      status: "ok",
      order_by: ["id"],
      columns: ["id", "email", "password_hash", "bio", "manager_id"],
      rows: [[1, "u1@x", "[redacted]", expect.stringMatching(/^b{200}…\[\+100B\]$/), null]],
      rows_returned: 1,
      has_more: false,
    });
    // Two FKs between the same pair of tables are independent relations.
    expect(relation(result, "incoming", "transfers_recipient_fk")).toMatchObject({
      table: "ins.transfers",
      source_columns: ["recipient_id"],
      target_columns: ["id"],
      rows: [[500, 1, 2, "[redacted]"]],
    });
    expect(relation(result, "incoming", "transfers_sender_fk")).toMatchObject({ rows: [[501, 2, 1, "[redacted]"]] });
    expect(relation(result, "incoming", "memberships_user_id_fkey")).toMatchObject({ rows: [], rows_returned: 0, has_more: false });
    // A table without a primary key is still ordered deterministically, by physical position.
    expect(relation(result, "incoming", "notes_user_id_fkey")).toMatchObject({ order_by: ["ctid"], rows: [["hi", 2]] });
  });

  it("returns exactly N related rows in primary-key order, without has_more when no more exist", async () => {
    const reports = relation(await core.inspectRow("ins.users", { id: 2 }), "incoming", "users_manager_id_fkey");
    expect(reports.rows.map((r) => r[0])).toEqual([9, 10, 11, 12, 13]);
    expect(reports).toMatchObject({ rows_returned: 5, has_more: false });
  });

  it("caps related rows at N and sets has_more when more exist", async () => {
    const result = await core.inspectRow("ins.users", { id: 1 });
    expect(relation(result, "incoming", "users_manager_id_fkey")).toMatchObject({ rows_returned: 5, has_more: true });
    expect(relation(result, "incoming", "users_manager_id_fkey").rows.map((r) => r[0])).toEqual([2, 3, 4, 5, 6]);
    // A NULL foreign key references nothing.
    expect(relation(result, "outgoing", "users_manager_id_fkey")).toMatchObject({ rows: [], rows_returned: 0, has_more: false });
  });

  it("takes N from QUERYIO_INSPECT_RELATED_ROWS", async () => {
    const small = createCore(testSettings({ QUERYIO_INSPECT_RELATED_ROWS: "2" }));
    try {
      const reports = relation(await small.inspectRow("ins.users", { id: 1 }), "incoming", "users_manager_id_fkey");
      expect(reports.rows.map((r) => r[0])).toEqual([2, 3]);
      expect(reports.has_more).toBe(true);
    } finally {
      await small.close();
    }
  });

  it("returns the same result across repeated calls", async () => {
    const strip = ({ duration_ms, ...rest }: InspectRowResult) => rest;
    const first = strip(await core.inspectRow("ins.users", { id: 1 }));
    expect(strip(await core.inspectRow("ins.users", { id: 1 }))).toEqual(first);
  });

  it("handles a composite primary key and a composite foreign key", async () => {
    const membership = await core.inspectRow("ins.memberships", { user_id: 1, org_id: 10 });
    expect(membership.row).toEqual([10, 1, "admin"]);
    expect(membership.relations.map((r) => [r.direction, r.table, r.constraint])).toEqual([
      ["outgoing", "ins.orgs", "memberships_org_id_fkey"],
      ["outgoing", "ins.users", "memberships_user_id_fkey"],
      ["incoming", "ins.grants", "grants_membership_fk"],
    ]);
    expect(relation(membership, "incoming", "grants_membership_fk")).toMatchObject({
      source_columns: ["org_id", "user_id"],
      target_columns: ["org_id", "user_id"],
      rows: [[100, 10, 1]],
    });

    const grant = await core.inspectRow("ins.grants", { id: 100 });
    expect(relation(grant, "outgoing", "grants_membership_fk")).toMatchObject({
      table: "ins.memberships",
      order_by: ["org_id", "user_id"],
      rows: [[10, 1, "admin"]],
    });
  });

  it("reports truncation and redaction across the root and related rows", async () => {
    const result = await core.inspectRow("ins.transfers", { id: 500 });
    expect(result.row).toEqual([500, 1, 2, "[redacted]"]);
    expect(relation(result, "outgoing", "transfers_sender_fk").rows[0][3]).toMatch(/…\[\+100B\]$/);
    // api_key on the root, password_hash on the sender and the recipient.
    expect(result).toMatchObject({ values_redacted: 3, values_truncated: 1 });
  });
});

describe("inspect_row errors", () => {
  it("requires a declared primary key", async () => {
    await expect(core.inspectRow("ins.notes", { user_id: 2 })).rejects.toMatchObject({
      category: "no_primary_key",
      message: "inspect_row requires a declared primary key; use query for this table",
    });
  });

  it("reports a missing root row with the expected key columns", async () => {
    await expect(core.inspectRow("ins.memberships", { org_id: 10, user_id: 99 })).rejects.toMatchObject({
      category: "row_not_found",
      message: expect.stringContaining("org_id, user_id"),
    });
  });

  it.each([{}, { id: 1, email: "u1@x" }, { user_id: 1 }, { ID: 1 }])("rejects key %j that is not the primary key", async (key) => {
    await expect(core.inspectRow("ins.users", key)).rejects.toMatchObject({
      category: "key_mismatch",
      message: expect.stringContaining("id"),
    });
  });

  it("reports an unknown table", async () => {
    await expect(core.inspectRow("users", { id: 1 })).rejects.toMatchObject({ category: "not_found" });
  });
});

it("resolves table names only through the catalog and binds key values (injection regression)", async () => {
  for (const table of [
    "ins.users; DROP TABLE ins.orgs; --",
    'ins."users"',
    '"ins"."users"',
    "ins.users'",
    "ins.users WHERE 1=1",
    "pg_catalog.pg_class",
    "ins.nope",
  ]) {
    await expect(core.inspectRow(table, { id: 1 }), table).rejects.toMatchObject({
      category: expect.stringMatching(/^(not_found|no_primary_key|key_mismatch)$/),
    });
  }
  await expect(core.inspectRow("ins.users", { "id = id OR true --": 1 })).rejects.toMatchObject({ category: "key_mismatch" });
  // SQL fragments are literal values: an invalid integer, or a text key that matches nothing.
  await expect(core.inspectRow("ins.users", { id: "1; DROP TABLE ins.orgs" })).rejects.toMatchObject({ code: "22P02" });
  await expect(core.inspectRow("ins.tags", { name: "x' OR '1'='1" })).rejects.toMatchObject({ category: "row_not_found" });
  expect((await core.inspectRow("ins.tags", { name: "a'b" })).row).toEqual(["a'b"]);

  const { rows } = await sql("SELECT (SELECT count(*) FROM ins.orgs)::int AS orgs, (SELECT count(*) FROM ins.users)::int AS users");
  expect(rows).toEqual([{ orgs: 1, users: 13 }]);
});

it("audits tables involved, rows and bytes, never key values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "queryio-audit-"));
  const path = join(dir, "audit.jsonl");
  const audited = createCore(testSettings({ QUERYIO_AUDIT_LOG: path }));
  try {
    await audited.inspectRow("ins.users", { id: 2 });
    await audited.inspectRow("ins.tags", { name: "zebra-key" });
    await audited.inspectRow("ins.tags", { name: "missing-key" }).catch(() => {});
  } finally {
    await audited.close();
  }
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  const events = raw.trim().split("\n").map((l) => JSON.parse(l));
  expect(events).toEqual([
    {
      ts: expect.any(String),
      tool: "inspect_row",
      duration_ms: expect.any(Number),
      success: true,
      tables: ["ins.users", "ins.memberships", "ins.notes", "ins.transfers"],
      rows_returned: 10,
      bytes_returned: expect.any(Number),
      values_truncated: 1,
    },
    expect.objectContaining({ tool: "inspect_row", success: true, tables: ["ins.tags"], rows_returned: 1 }),
    expect.objectContaining({ tool: "inspect_row", success: false, error_category: "row_not_found" }),
  ]);
  expect(raw).not.toContain("zebra-key");
  expect(raw).not.toContain("missing-key");
});
