import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCore } from "../src/core.js";
import { loadSettings } from "../src/settings.js";
import { testSettings } from "./db.js";

let dir: string;
let n = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "queryio-audit-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Run queries on a core with the given audit settings and return the audit lines written. */
async function audited(env: Record<string, string>, ...statements: string[]) {
  const path = join(dir, `nested-${++n}`, "audit.jsonl");
  const core = createCore(testSettings({ QUERYIO_AUDIT_LOG: path, ...env }));
  try {
    for (const statement of statements) await core.query(statement).catch(() => {});
  } finally {
    await core.close();
  }
  return { path, events: existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [] };
}

it("writes one line per query call with the foundation fields and no SQL or values", async () => {
  const { path, events } = await audited({ QUERYIO_MAX_ROWS: "2" }, "SELECT 'secret-value' AS v FROM generate_series(1, 3)");
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    ts: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    tool: "query",
    duration_ms: expect.any(Number),
    success: true,
    rows_returned: 2,
    bytes_returned: expect.any(Number),
    has_more: true,
    truncated_by: "rows",
    values_truncated: 0,
    sql_hash: expect.stringMatching(/^[0-9a-f]{16}$/),
  });
  expect(events[0].bytes_returned).toBeGreaterThan(0);
  const raw = readFileSync(path, "utf8");
  expect(raw).not.toContain("secret-value");
  expect(raw).not.toContain("generate_series");
});

it("gives the same SQL the same hash", async () => {
  const { events } = await audited({}, "SELECT 1", "SELECT 1", "SELECT 2");
  expect(events[0].sql_hash).toBe(events[1].sql_hash);
  expect(events[0].sql_hash).not.toBe(events[2].sql_hash);
});

it("logs failures with their error category and code", async () => {
  const { events } = await audited({}, "SELECT 1/0", "DROP TABLE x");
  expect(events).toMatchObject([
    { tool: "query", success: false, error_category: "data_exception", error_code: "22012" },
    { tool: "query", success: false, error_category: "read_oriented" },
  ]);
  expect(events[0]).not.toHaveProperty("rows_returned");
});

it("logs raw SQL only with QUERYIO_AUDIT_INCLUDE_SQL=true", async () => {
  const { events } = await audited({ QUERYIO_AUDIT_INCLUDE_SQL: "true" }, "SELECT 'secret-value' AS v");
  expect(events[0].sql).toBe("SELECT 'secret-value' AS v");
  expect(JSON.stringify(events[0])).not.toContain('"secret-value"');
});

it("is disabled by QUERYIO_AUDIT_LOG=off", () => {
  expect(loadSettings({ QUERYIO_DATABASE_URL: "postgres://x", QUERYIO_AUDIT_LOG: "off" }).auditLog).toBeNull();
});

it("defaults to ~/.queryio/audit.jsonl", () => {
  expect(loadSettings({ QUERYIO_DATABASE_URL: "postgres://x" }).auditLog).toBe(join(homedir(), ".queryio", "audit.jsonl"));
});

it("a byte-capped query logs truncated_by bytes", async () => {
  const { events } = await audited(
    { QUERYIO_MAX_RESPONSE_BYTES: "500" },
    "SELECT g, repeat('x', 150) AS pad FROM generate_series(1, 50) g",
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ tool: "query", success: true, has_more: true, truncated_by: "bytes" });
});

it("no truncated field appears anywhere in any query audit event", async () => {
  const { events } = await audited({ QUERYIO_MAX_ROWS: "2" }, "SELECT g FROM generate_series(1, 5) g");
  for (const ev of events) {
    expect(Object.keys(ev)).not.toContain("truncated");
  }
});

it("creates the audit log directory with mode 0700 and file with mode 0600 on Unix", async () => {
  const { path } = await audited({}, "SELECT 1");
  expect(existsSync(path)).toBe(true);

  if (process.platform !== "win32") {
    const fileStat = statSync(path);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const dirStat = statSync(dirname(path));
    expect(dirStat.mode & 0o777).toBe(0o700);
  }
});