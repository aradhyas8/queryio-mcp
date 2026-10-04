import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCore, type Core } from "../src/core.js";
import { ADMIN_URL, sql, TEST_DB, testSettings } from "./db.js";

describe("core.check() with superuser connection", () => {
  let core: Core;

  beforeAll(async () => {
    core = createCore(testSettings());
  });

  afterAll(async () => {
    await core.close();
  });

  it("reports superuser status, write privileges, warnings, and SQL template", async () => {
    const result = await core.check();

    expect(result.connectivity).toBe(true);
    expect(result.version).toMatch(/PostgreSQL/);
    expect(result.database).toBe("queryio_test");
    expect(result.role).toBe("postgres");
    expect(result.superuser).toBe(true);
    expect(result.write_privileges).toBe(true);
    expect(result.warnings).toContain(
      'connected role "postgres" is highly privileged; QueryIO is a bounded interface, not the database security boundary',
    );
    expect(result.limits).toMatchObject({
      statement_timeout_ms: 5000,
      lock_timeout_ms: 1000,
      max_rows: 100,
      max_response_bytes: 32768,
      max_value_length: 200,
      inspect_related_rows: 5,
      inspect_max_relations: 25,
      inspect_deadline_ms: 5000,
    });
    expect(result.redact_patterns).toContain("password");
    expect(result.audit_log).toBeNull(); // disabled by testSettings
    expect(result.role_template).toContain("CREATE ROLE queryio_role WITH LOGIN PASSWORD");
    expect(result.role_template).toContain('GRANT CONNECT ON DATABASE "queryio_test" TO queryio_role;');
    expect(result.role_template).toContain("GRANT USAGE ON SCHEMA public TO queryio_role;");
    expect(result.role_template).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA public TO queryio_role;");
    expect(result.role_template).toContain("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO queryio_role;");
  });
});

function dropRoleSql(role: string): string {
  return `DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN EXECUTE 'DROP OWNED BY ' || quote_ident('${role}'); EXECUTE 'DROP ROLE ' || quote_ident('${role}'); END IF; END $$;`;
}

describe("core.check() with dedicated read-only role", () => {
  const roRole = "queryio_test_ro_role";
  const roPassword = "ro_password_123";
  let roCore: Core;

  beforeAll(async () => {
    await sql(`
      ${dropRoleSql(roRole)}
      CREATE ROLE ${roRole} WITH LOGIN PASSWORD '${roPassword}';
      GRANT CONNECT ON DATABASE ${TEST_DB} TO ${roRole};
      GRANT USAGE ON SCHEMA public TO ${roRole};
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roRole};
    `);

    const url = new URL(ADMIN_URL);
    url.username = roRole;
    url.password = roPassword;
    url.pathname = `/${TEST_DB}`;

    roCore = createCore(testSettings({ QUERYIO_DATABASE_URL: url.toString() }));
  });

  afterAll(async () => {
    await roCore.close();
    await sql(dropRoleSql(roRole));
  });

  it("reports non-superuser, no write privileges, no dangerous roles, and no warnings", async () => {
    const result = await roCore.check();

    expect(result.connectivity).toBe(true);
    expect(result.role).toBe(roRole);
    expect(result.superuser).toBe(false);
    expect(result.write_privileges).toBe(false);
    expect(result.dangerous_roles).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.role_template).toContain("CREATE ROLE queryio_role");
  });
});

describe("core.check() planner statistics availability", () => {
  it("detects when planner statistics are available after analyze", async () => {
    await sql(`
      DROP TABLE IF EXISTS check_stats_test;
      CREATE TABLE check_stats_test (id int, name text);
      INSERT INTO check_stats_test SELECT g, 'item ' || g FROM generate_series(1, 50) g;
      ANALYZE check_stats_test;
    `);

    const core = createCore(testSettings());
    try {
      const result = await core.check();
      expect(result.stats_available).toBe(true);
    } finally {
      await core.close();
    }
  });
});

describe("core.check() with non-superuser holding dangerous role or write privileges", () => {
  const dangRole = "queryio_test_dangerous_role";
  const dangPassword = "dang_password_123";

  afterAll(async () => {
    await sql(dropRoleSql(dangRole));
  });

  it("detects membership in dangerous predefined roles and warns", async () => {
    await sql(`
      ${dropRoleSql(dangRole)}
      CREATE ROLE ${dangRole} WITH LOGIN PASSWORD '${dangPassword}';
      GRANT CONNECT ON DATABASE ${TEST_DB} TO ${dangRole};
      GRANT pg_read_server_files TO ${dangRole};
    `);

    const url = new URL(ADMIN_URL);
    url.username = dangRole;
    url.password = dangPassword;
    url.pathname = `/${TEST_DB}`;

    const core = createCore(testSettings({ QUERYIO_DATABASE_URL: url.toString() }));
    try {
      const result = await core.check();
      expect(result.superuser).toBe(false);
      expect(result.dangerous_roles).toContain("pg_read_server_files");
      expect(result.warnings).toContain(
        `connected role "${dangRole}" is highly privileged; QueryIO is a bounded interface, not the database security boundary`,
      );
    } finally {
      await core.close();
    }
  });

  it("detects table write privileges on non-superuser and warns", async () => {
    const rwRole = "queryio_test_table_rw_role";
    const rwPassword = "rw_password_123";

    await sql(`
      DROP TABLE IF EXISTS check_rw_test;
      CREATE TABLE check_rw_test (id int);
      ${dropRoleSql(rwRole)}
      CREATE ROLE ${rwRole} WITH LOGIN PASSWORD '${rwPassword}';
      GRANT CONNECT ON DATABASE ${TEST_DB} TO ${rwRole};
      GRANT USAGE ON SCHEMA public TO ${rwRole};
      GRANT INSERT ON check_rw_test TO ${rwRole};
    `);

    const url = new URL(ADMIN_URL);
    url.username = rwRole;
    url.password = rwPassword;
    url.pathname = `/${TEST_DB}`;

    const core = createCore(testSettings({ QUERYIO_DATABASE_URL: url.toString() }));
    try {
      const result = await core.check();
      expect(result.superuser).toBe(false);
      expect(result.write_privileges).toBe(true);
      expect(result.warnings).toContain(
        `connected role "${rwRole}" is highly privileged; QueryIO is a bounded interface, not the database security boundary`,
      );
    } finally {
      await core.close();
      await sql(dropRoleSql(rwRole));
    }
  });
});
