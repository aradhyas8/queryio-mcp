// Shared helpers for the MCP v2 benchmark harness: paths, admin database access, docker, hashing.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(BENCH_DIR, "../..");
export const CACHE_DIR = join(BENCH_DIR, ".cache");
export const RESULTS_DIR = join(BENCH_DIR, "results");

export const PG = { host: "127.0.0.1", port: 54330, user: "postgres", password: "postgres" };
export const CONTAINER = "queryio-bench-aw";
export const BASE_DB = "aw_base";
/** NOLOGIN group role that owns the read grants; each run logs in as its own opaque member role. */
export const READER_GROUP = "aw_readers";
export const AW_SCHEMAS = ["humanresources", "person", "production", "purchasing", "sales"];

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const fileSha256 = (path) => sha256(readFileSync(path));
export const opaqueId = (bytes = 6) => randomBytes(bytes).toString("hex");
export const ident = (name) => `"${name.replace(/"/g, '""')}"`;

export async function withClient(database, fn) {
  const client = new pg.Client({ ...PG, database, application_name: "bench-harness" });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}\n${res.stderr || res.stdout}`);
  }
  return res;
}

/** Run psql inside the benchmark container (no host psql required). */
export function psqlInContainer(database, args, opts = {}) {
  return run("docker", ["exec", "-i", ...(opts.workdir ? ["-w", opts.workdir] : []), CONTAINER, "psql", "-X", "-U", "postgres", "-d", database, "-v", "ON_ERROR_STOP=1", ...args], opts);
}

export function composeUp() {
  run("docker", ["compose", "-f", join(BENCH_DIR, "docker-compose.yml"), "up", "-d", "--build", "--wait"], { stdio: "inherit" });
}

export async function databaseExists(name) {
  return withClient("postgres", async (c) => (await c.query("SELECT 1 FROM pg_database WHERE datname = $1", [name])).rowCount > 0);
}

export async function dropDatabase(name) {
  await withClient("postgres", (c) => c.query(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`));
}

/** Clone a database file-by-file. The source must have no other connections. */
export async function cloneDatabase(source, target) {
  await withClient("postgres", async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(target)} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${ident(target)} TEMPLATE ${ident(source)} STRATEGY FILE_COPY`);
    // Nobody but the per-run role (granted later) may connect.
    await c.query(`REVOKE CONNECT, TEMPORARY ON DATABASE ${ident(target)} FROM PUBLIC`);
  });
}

/**
 * A fresh, isolated database for one run: an opaque-named clone of the task template plus an opaque
 * login role that can connect only to that clone, read everything, and write nothing.
 * Names carry no task or arm information because the agent can see them.
 */
export async function createSandbox(template) {
  const id = opaqueId();
  const sb = { database: `awr_${id}`, role: `bench_${id}`, password: opaqueId(12) };
  await cloneDatabase(template, sb.database);
  await withClient("postgres", async (c) => {
    await c.query(`CREATE ROLE ${ident(sb.role)} LOGIN PASSWORD '${sb.password}' IN ROLE ${READER_GROUP}`);
    await c.query(`ALTER ROLE ${ident(sb.role)} SET default_transaction_read_only = on`);
    await c.query(`GRANT CONNECT ON DATABASE ${ident(sb.database)} TO ${ident(sb.role)}`);
  });
  sb.dsn = `postgres://${sb.role}:${sb.password}@${PG.host}:${PG.port}/${sb.database}`;
  sb.containerDsn = `postgres://${sb.role}:${sb.password}@127.0.0.1:5432/${sb.database}`;
  return sb;
}

/** Wait for the run role's sessions to end (terminating stragglers), returning how many were killed. */
export async function closeSandboxSessions(sb, waitMs = 10_000) {
  return withClient("postgres", async (c) => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const n = (await c.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1", [sb.role])).rows[0].n;
      if (n === 0) return 0;
      if (Date.now() > deadline) {
        await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1", [sb.role]);
        return n;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  });
}

/** Rows inserted/updated/deleted in user tables of the sandbox (should be 0). Catalog activity is excluded. */
export async function sandboxWrites(sb) {
  return withClient(sb.database, async (c) => {
    const { rows } = await c.query("SELECT coalesce(sum(n_tup_ins + n_tup_upd + n_tup_del), 0)::bigint AS w FROM pg_stat_user_tables");
    return Number(rows[0].w);
  });
}

/** Drop sandboxes, templates, and run roles left behind by an interrupted run (all harness-owned names). */
export async function dropStaleSandboxes() {
  await withClient("postgres", async (c) => {
    for (const { datname } of (await c.query("SELECT datname FROM pg_database WHERE datname ~ '^aw[rt]_[0-9a-f]+$'")).rows) {
      await c.query(`DROP DATABASE IF EXISTS ${ident(datname)} WITH (FORCE)`);
    }
    for (const { rolname } of (await c.query("SELECT rolname FROM pg_roles WHERE rolname ~ '^bench_[0-9a-f]+$'")).rows) {
      await c.query(`DROP ROLE IF EXISTS ${ident(rolname)}`);
    }
  });
}

export async function dropSandbox(sb) {
  await withClient("postgres", async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${ident(sb.database)} WITH (FORCE)`);
    await c.query(`DROP ROLE IF EXISTS ${ident(sb.role)}`);
  });
}

/**
 * Content fingerprint of every AdventureWorks table: row count plus an order-independent hash of row text.
 * Two databases with equal digests hold identical data in every benchmark table.
 */
export async function fingerprint(database) {
  return withClient(database, async (c) => {
    const tables = (
      await c.query(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'r' AND n.nspname = ANY($1) ORDER BY 1`,
        [AW_SCHEMAS],
      )
    ).rows.map((r) => r.t);
    const out = {};
    for (const t of tables) {
      const { rows } = await c.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS h FROM (SELECT md5(x::text) AS h FROM ${t} x) s`);
      out[t] = { rows: rows[0].n, md5: rows[0].h };
    }
    return { digest: sha256(JSON.stringify(out)), tables: out };
  });
}

/** Commit plus whether the given paths (default: the whole tree) have uncommitted changes. */
export function gitInfo(paths = []) {
  const sha = run("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR }).stdout.trim();
  const dirty = run("git", ["status", "--porcelain", "--", ...paths], { cwd: REPO_DIR }).stdout.trim() !== "";
  return { sha, dirty };
}

export function serverVersions() {
  const lock = join(BENCH_DIR, "servers", "package-lock.json");
  if (!existsSync(lock)) throw new Error("benchmark/mcp-v2/servers is not installed; run npm run benchmark:mcp:setup");
  const pkgs = readJson(lock).packages;
  return {
    dbhub: pkgs["node_modules/@bytebase/dbhub"]?.version,
    postgres_mcp: pkgs["node_modules/@microsoft/postgres-mcp"]?.version,
    queryio: readJson(join(REPO_DIR, "package.json")).version,
  };
}

/** Deterministic PRNG (mulberry32) so run order is reproducible from the recorded seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, rand) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function median(xs) {
  return quantile(xs, 0.5);
}

export function quantile(xs, q) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}
