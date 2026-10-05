#!/usr/bin/env node
// npm run benchmark:mcp:validate [task ...]
// For every incident: apply the mutation to a clean snapshot, check that the anomaly exists and was
// absent from the base data, check the ground-truth facts and that no other record shows the same
// anomaly, then rebuild from scratch and confirm the database content is identical (reproducible).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_DB, BENCH_DIR, dropDatabase, fingerprint } from "./lib.mjs";
import { buildTemplate, loadPrivateManifest, loadPublicTasks, runCheck, suiteHash, validationChecks } from "./tasks.mjs";

const only = process.argv.slice(2);
const publicTasks = loadPublicTasks();
const manifest = loadPrivateManifest();
const ids = publicTasks.map((t) => t.id).filter((id) => !only.length || only.includes(id));
const base = await fingerprint(BASE_DB);
const report = { suite_hash: suiteHash(), base_digest: base.digest, tasks: {} };
let failed = 0;

for (const id of ids) {
  const problems = [];
  if (!manifest[id]) problems.push("missing from manifest.private.json");
  const checks = validationChecks(id);
  if (!checks.some((c) => c.kind === "anomaly")) problems.push("no anomaly check");
  if (!checks.some((c) => c.kind === "unique")) problems.push("no uniqueness check");

  const first = await buildTemplate(id);
  const results = [];
  for (const check of checks) {
    const onIncident = await runCheck(first, check.sql);
    const onBase = check.kind === "anomaly" ? await runCheck(BASE_DB, check.sql) : null;
    results.push({ kind: check.kind, description: check.description, incident: onIncident, base: onBase });
    if (!onIncident) problems.push(`${check.kind} failed on incident db: ${check.description}`);
    if (onBase) problems.push(`anomaly already present in base data: ${check.description}`);
  }
  const fp1 = await fingerprint(first);
  await dropDatabase(first);
  const second = await buildTemplate(id);
  const fp2 = await fingerprint(second);
  await dropDatabase(second);
  if (fp1.digest !== fp2.digest) problems.push("rebuild produced different content (not reproducible)");
  const changed = Object.keys(fp1.tables).filter((t) => fp1.tables[t].md5 !== base.tables[t]?.md5);
  if (!changed.length) problems.push("mutation changed nothing");

  report.tasks[id] = { ok: problems.length === 0, digest: fp1.digest, changed_tables: changed, checks: results, problems };
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${id}  changed: ${changed.join(", ")}${problems.length ? `\n      ${problems.join("\n      ")}` : ""}`);
}

if (!only.length) writeFileSync(join(BENCH_DIR, "incidents", "validation", "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(`\n${ids.length - failed}/${ids.length} incidents valid`);
process.exit(failed ? 1 : 0);
