import { expect, it } from "vitest";
import { loadSettings } from "../src/settings.js";

const url = { QUERYIO_DATABASE_URL: "postgres://x" };

it("defaults the limits and lets environment variables override them", () => {
  expect(loadSettings(url)).toMatchObject({
    maxRows: 100,
    maxResponseBytes: 32768,
    maxValueLength: 200,
    inspectRelatedRows: 5,
    inspectMaxRelations: 25,
    inspectDeadlineMs: 5000,
    auditIncludeSql: false,
  });
  expect(
    loadSettings({
      ...url,
      QUERYIO_MAX_ROWS: "7",
      QUERYIO_LOCK_TIMEOUT_MS: "250",
      QUERYIO_INSPECT_MAX_RELATIONS: "10",
      QUERYIO_INSPECT_DEADLINE_MS: "3000",
    }),
  ).toMatchObject({
    maxRows: 7,
    lockTimeoutMs: 250,
    inspectMaxRelations: 10,
    inspectDeadlineMs: 3000,
  });
});

it.each(["0", "-1", "1.5", "lots"])("rejects a non-positive-integer limit %j", (value) => {
  expect(() => loadSettings({ ...url, QUERYIO_MAX_ROWS: value })).toThrow(/QUERYIO_MAX_ROWS must be a positive integer/);
  expect(() => loadSettings({ ...url, QUERYIO_INSPECT_MAX_RELATIONS: value })).toThrow(
    /QUERYIO_INSPECT_MAX_RELATIONS must be a positive integer/,
  );
  expect(() => loadSettings({ ...url, QUERYIO_INSPECT_DEADLINE_MS: value })).toThrow(
    /QUERYIO_INSPECT_DEADLINE_MS must be a positive integer/,
  );
});

it("defaults the redaction patterns and applies additions and removals", () => {
  expect(loadSettings(url).redactPatterns).toEqual([
    "password",
    "password_hash",
    "secret",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "private_key",
    "credential",
  ]);
  const patterns = loadSettings({ ...url, QUERYIO_REDACT_ADD: "SSN, email,,", QUERYIO_REDACT_REMOVE: "Token, secret" }).redactPatterns;
  expect(patterns).toEqual(["password", "password_hash", "access_token", "refresh_token", "api_key", "private_key", "credential", "ssn", "email"]);
});

it.each([
  "${QUERYIO_DATABASE_URL}",
  "${env:QUERYIO_DATABASE_URL}",
  "${QUERYIO_DATABASE_URL:-}",
  "${QUERYIO_DATABASE_URL:-postgres://u:secret-pw@db/app}",
  "postgres://${DB_USER}:secret-pw@db:5432/app",
])("rejects the unresolved client placeholder in %j without echoing the value", (value) => {
  let message = "";
  try {
    loadSettings({ QUERYIO_DATABASE_URL: value });
  } catch (err) {
    message = (err as Error).message;
  }
  expect(message).toMatch(/QUERYIO_DATABASE_URL contains the unresolved placeholder \$\{/);
  expect(message).toContain("restart the client");
  expect(message).not.toContain("secret-pw");
});

it.each([
  "postgres://queryio_role:pa$$word@localhost:5432/app",
  "postgresql://u:p%24%7Bx%7D@db.internal/app?sslmode=require",
  "host=localhost dbname=app",
])("accepts a resolved connection string %j", (value) => {
  expect(loadSettings({ QUERYIO_DATABASE_URL: value }).databaseUrl).toBe(value);
});

it("still rejects a missing connection string", () => {
  expect(() => loadSettings({})).toThrow(/QUERYIO_DATABASE_URL is not set/);
  expect(() => loadSettings({ QUERYIO_DATABASE_URL: "" })).toThrow(/QUERYIO_DATABASE_URL is not set/);
});
