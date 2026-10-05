#!/usr/bin/env node
// npm run benchmark:mcp:smoke | benchmark:mcp:run
// setup (idempotent) -> run -> blinded grading -> report. Extra arguments go to the runner.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BENCH_DIR, RESULTS_DIR } from "./lib.mjs";

const node = (script, args) => {
  const res = spawnSync(process.execPath, [join(BENCH_DIR, "harness", script), ...args], { stdio: "inherit" });
  if (res.status !== 0) process.exit(res.status ?? 1);
};
const newestResult = () =>
  readdirSync(RESULTS_DIR).map((d) => join(RESULTS_DIR, d)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];

node("setup.mjs", []);
node("runner.mjs", process.argv.slice(2));
const dir = newestResult(); // the experiment the runner just wrote to
node("grader.mjs", [dir]);
node("report.mjs", [dir]);
