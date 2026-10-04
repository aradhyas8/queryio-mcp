import { expect, it } from "vitest";
import { loadSettings } from "../src/settings.js";

const url = { QUERYIO_DATABASE_URL: "postgres://x" };

it("defaults the limits and lets environment variables override them", () => {
  expect(loadSettings(url)).toMatchObject({ maxRows: 100, maxResponseBytes: 32768, maxValueLength: 200, auditIncludeSql: false });
  expect(loadSettings({ ...url, QUERYIO_MAX_ROWS: "7", QUERYIO_LOCK_TIMEOUT_MS: "250" })).toMatchObject({
    maxRows: 7,
    lockTimeoutMs: 250,
  });
});

it.each(["0", "-1", "1.5", "lots"])("rejects a non-positive-integer limit %j", (value) => {
  expect(() => loadSettings({ ...url, QUERYIO_MAX_ROWS: value })).toThrow(/QUERYIO_MAX_ROWS must be a positive integer/);
});
