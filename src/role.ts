import type pg from "pg";

export interface RoleInspection {
  readonly role: string;
  readonly database: string;
  readonly version: string;
  readonly superuser: boolean;
  readonly write_privileges: boolean;
  readonly dangerous_roles: readonly string[];
  readonly stats_available: boolean;
  readonly warnings: readonly string[];
}

export const DANGEROUS_PREDEFINED_ROLES = [
  "pg_execute_server_program",
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_write_all_data",
] as const;

/** Generate a ready-to-edit SQL template for creating a dedicated read-only role. */
export function generateRoleTemplate(database: string): string {
  const quotedDb = `"${database.replaceAll('"', '""')}"`;
  return [
    `-- Create dedicated read-only role for QueryIO:`,
    `CREATE ROLE queryio_role WITH LOGIN PASSWORD 'CHANGE_ME_PASSWORD';`,
    `GRANT CONNECT ON DATABASE ${quotedDb} TO queryio_role;`,
    `GRANT USAGE ON SCHEMA public TO queryio_role;`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO queryio_role;`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO queryio_role;`,
  ].join("\n");
}

/**
 * Inspect the connected PostgreSQL role: classifies superuser, write privileges, dangerous predefined
 * role memberships, and whether planner statistics exist. Generates warnings when privileged.
 */
export async function inspectRole(client: pg.ClientBase): Promise<RoleInspection> {
  const [roleInfo, dangerous] = await Promise.all([
    client.query<{
      role: string;
      database: string;
      version: string;
      superuser: boolean;
      stats_available: boolean;
      has_table_writes: boolean;
    }>(`
      SELECT
        current_user AS role,
        current_database() AS database,
        version() AS version,
        (current_setting('is_superuser') = 'on') AS superuser,
        EXISTS (
          SELECT 1 FROM pg_stats
          WHERE schemaname !~ '^pg_' AND schemaname <> 'information_schema'
        ) AS stats_available,
        EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p')
            AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
            AND (
              has_table_privilege(current_user, c.oid, 'INSERT')
              OR has_table_privilege(current_user, c.oid, 'UPDATE')
              OR has_table_privilege(current_user, c.oid, 'DELETE')
              OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
            )
        ) AS has_table_writes
    `),
    client.query<{ rolname: string }>(
      `
      SELECT rolname FROM pg_roles
      WHERE rolname = ANY($1::text[])
        AND pg_has_role(current_user, oid, 'member')
      ORDER BY rolname
    `,
      [[...DANGEROUS_PREDEFINED_ROLES]],
    ),
  ]);

  const row = roleInfo.rows[0];
  const dangerousRoles = dangerous.rows.map((r) => r.rolname);
  const writePrivileges = row.superuser || dangerousRoles.includes("pg_write_all_data") || row.has_table_writes;
  const isPrivileged = row.superuser || writePrivileges || dangerousRoles.length > 0;

  const warnings: string[] = [];
  if (isPrivileged) {
    warnings.push(
      `connected role "${row.role}" is highly privileged; QueryIO is a bounded interface, not the database security boundary`,
    );
  }

  return Object.freeze({
    role: row.role,
    database: row.database,
    version: row.version,
    superuser: row.superuser,
    write_privileges: writePrivileges,
    dangerous_roles: Object.freeze(dangerousRoles),
    stats_available: row.stats_available,
    warnings: Object.freeze(warnings),
  });
}
