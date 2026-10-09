#!/usr/bin/env node
// npm run benchmark:mcp:setup
// Fetch and verify the pinned AdventureWorks inputs, install the pinned MCP servers, build QueryIO,
// start PostgreSQL, load AdventureWorks into aw_base, configure read-only access, and verify everything.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AW_SCHEMAS, BASE_DB, BENCH_DIR, CACHE_DIR, READER_GROUP, REPO_DIR,
  composeUp, databaseExists, fileSha256, fingerprint, ident, psqlInContainer, readJson, run, withClient,
} from "./lib.mjs";

const source = readJson(join(BENCH_DIR, "adventureworks", "source.json"));
const expected = readJson(join(BENCH_DIR, "adventureworks", "expected.json"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export async function setup({ quiet = false } = {}) {
  const say = (m) => quiet || console.log(`[setup] ${m}`);

  // 1. Pinned inputs, cached locally and checked by hash.
  mkdirSync(CACHE_DIR, { recursive: true });
  const inputs = [
    ...Object.entries(source.conversion.files).map(([name, hash]) => ({
      name, hash, url: `https://raw.githubusercontent.com/lorint/AdventureWorks-for-Postgres/${source.conversion.commit}/${name}`,
    })),
    { name: "AdventureWorks-oltp-install-script.zip", hash: source.data.sha256, url: source.data.url },
  ];
  for (const input of inputs) {
    const path = join(CACHE_DIR, input.name);
    if (!existsSync(path)) {
      say(`downloading ${input.url}`);
      const res = await fetch(input.url);
      if (!res.ok) throw new Error(`download failed ${res.status}: ${input.url}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    const got = fileSha256(path);
    if (got !== input.hash) throw new Error(`${input.name}: sha256 ${got} != pinned ${input.hash}. Delete it from .cache and retry.`);
  }
  say("inputs verified against pinned sha256");

  // 2. Pinned third-party MCP servers and the QueryIO build under test.
  const servers = join(BENCH_DIR, "servers");
  const lock = readJson(join(servers, "package-lock.json")).packages;
  const installed = Object.keys(readJson(join(servers, "package.json")).dependencies).every((name) => {
    const path = join(servers, "node_modules", name, "package.json");
    return existsSync(path) && readJson(path).version === lock[`node_modules/${name}`].version;
  });
  if (!installed) run(npm, ["ci", "--no-audit", "--no-fund"], { cwd: servers, shell: process.platform === "win32" });
  run(npm, ["run", "build"], { cwd: REPO_DIR, shell: process.platform === "win32" });
  say("MCP servers installed (lockfile) and QueryIO built");

  // 3. PostgreSQL.
  composeUp();

  // 4. AdventureWorks base database, loaded once; the rename marks a complete load.
  if (!(await databaseExists(BASE_DB))) {
    const loading = `${BASE_DB}_loading`;
    await withClient("postgres", async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${ident(loading)} WITH (FORCE)`);
      await c.query(`CREATE DATABASE ${ident(loading)}`);
    });
    say("loading AdventureWorks (install.sql)");
    const res = psqlInContainer(loading, ["-q", "-f", "install.sql"], { workdir: "/data" });
    if (/ERROR/.test(res.stderr)) throw new Error(`install.sql reported errors:\n${res.stderr}`);
    await withClient(loading, (c) => c.query("VACUUM ANALYZE"));
    await withClient("postgres", (c) => c.query(`ALTER DATABASE ${ident(loading)} RENAME TO ${ident(BASE_DB)}`));
  }

  // 5. Read-only access: a NOLOGIN group with SELECT only. Run roles are created per run and join it.
  await withClient("postgres", async (c) => {
    await c.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${READER_GROUP}') THEN CREATE ROLE ${READER_GROUP} NOLOGIN; END IF; END $$`);
    await c.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    // Data is static and templates are analyzed explicitly; autovacuum would rewrite planner statistics
    // (pg_statistic) in fresh clones while an agent is investigating.
    await c.query("ALTER SYSTEM SET autovacuum = off");
    await c.query("SELECT pg_reload_conf()");
    for (const db of ["postgres", "template1", BASE_DB]) await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(db)} FROM PUBLIC`);
  });
  await withClient(BASE_DB, async (c) => {
    const schemas = (await c.query("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'")).rows.map((r) => r.nspname);
    for (const s of schemas) {
      await c.query(`REVOKE CREATE ON SCHEMA ${ident(s)} FROM PUBLIC`);
      await c.query(`GRANT USAGE ON SCHEMA ${ident(s)} TO ${READER_GROUP}`);
      await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${ident(s)} TO ${READER_GROUP}`);
    }
  });

  // 6. Verify.
  await verifyBase(say);
  return true;
}

export async function verifyBase(say = console.log) {
  const problems = [];
  await withClient(BASE_DB, async (c) => {
    const schemas = (await c.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)", [AW_SCHEMAS])).rows.map((r) => r.nspname);
    for (const s of AW_SCHEMAS) if (!schemas.includes(s)) problems.push(`missing schema ${s}`);
    const fks = (await c.query("SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE contype = 'f' AND n.nspname = ANY($1)", [AW_SCHEMAS])).rows[0].n;
    if (fks !== expected.foreign_keys) problems.push(`foreign keys ${fks} != ${expected.foreign_keys}`);
  });
  const fp = await fingerprint(BASE_DB);
  const tables = Object.keys(fp.tables);
  if (tables.length !== Object.keys(expected.row_counts).length) problems.push(`tables ${tables.length} != ${Object.keys(expected.row_counts).length}`);
  for (const [t, n] of Object.entries(expected.row_counts)) {
    if (fp.tables[t]?.rows !== n) problems.push(`${t}: ${fp.tables[t]?.rows} rows != ${n}`);
  }
  if (expected.digest && fp.digest !== expected.digest) problems.push(`content digest ${fp.digest} != pinned ${expected.digest}`);
  if (problems.length) throw new Error(`AdventureWorks verification failed:\n  ${problems.join("\n  ")}`);
  say(`verified ${BASE_DB}: ${AW_SCHEMAS.length} schemas, ${tables.length} tables, ${expected.foreign_keys} foreign keys, row counts exact, digest ${fp.digest.slice(0, 16)}`);
  return fp;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  setup().catch((err) => {
    console.error(`[setup] FAILED: ${err.message}`);
    process.exit(1);
  });
}
