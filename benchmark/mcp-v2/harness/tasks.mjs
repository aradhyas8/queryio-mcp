// Task suite: public questions, private ground truth, deterministic incident templates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_DB, BENCH_DIR, cloneDatabase, dropDatabase, opaqueId, readJson, sha256, withClient } from "./lib.mjs";

export const PUBLIC_TASKS = join(BENCH_DIR, "tasks", "public-tasks.json");
export const PRIVATE_MANIFEST = join(BENCH_DIR, "incidents", "manifest.private.json");
const mutationPath = (id) => join(BENCH_DIR, "incidents", "mutations", `${id}.sql`);
const validationPath = (id) => join(BENCH_DIR, "incidents", "validation", `${id}.sql`);

export function loadPublicTasks() {
  return readJson(PUBLIC_TASKS).tasks;
}

/** Ground truth for the grader and the validator. Never handed to the benchmarked agent. */
export function loadPrivateManifest() {
  return readJson(PRIVATE_MANIFEST).tasks;
}

/** Hash of everything that defines the suite: questions, ground truth, mutations, validations. */
export function suiteHash() {
  const parts = [readFileSync(PUBLIC_TASKS), readFileSync(PRIVATE_MANIFEST)];
  for (const t of loadPublicTasks()) parts.push(readFileSync(mutationPath(t.id)), readFileSync(validationPath(t.id)));
  return sha256(Buffer.concat(parts));
}

export function mutationSql(id) {
  return readFileSync(mutationPath(id), "utf8");
}

/** Build an opaque-named template: base snapshot + the task's mutation, analyzed, ready to clone. */
export async function buildTemplate(id) {
  const name = `awt_${opaqueId()}`;
  await cloneDatabase(BASE_DB, name);
  try {
    await withClient(name, async (c) => {
      await c.query("BEGIN");
      await c.query(mutationSql(id));
      await c.query("COMMIT");
      await c.query("ANALYZE");
    });
  } catch (err) {
    await dropDatabase(name);
    throw new Error(`${id}: mutation failed: ${err.message}`);
  }
  return name;
}

/** Parse "-- kind: description" blocks from a validation file. kinds: anomaly, check, unique. */
export function validationChecks(id) {
  const checks = [];
  for (const line of readFileSync(validationPath(id), "utf8").split("\n")) {
    const m = /^--\s*(anomaly|check|unique):\s*(.*)$/.exec(line);
    if (m) checks.push({ kind: m[1], description: m[2].trim(), sql: "" });
    else if (checks.length) checks.at(-1).sql += line + "\n";
  }
  return checks;
}

/** True only when the query returns ok = true; a query error counts as a failed check. */
export async function runCheck(database, sql) {
  try {
    return await withClient(database, async (c) => (await c.query(sql)).rows[0]?.ok === true);
  } catch (err) {
    console.error(`    check error: ${err.message}`);
    return false;
  }
}
