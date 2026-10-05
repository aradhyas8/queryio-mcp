#!/usr/bin/env node
// npm run benchmark:mcp:smoke | benchmark:mcp:run
// setup (idempotent) -> run -> blinded grading -> report. Extra arguments go to the runner.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { BENCH_DIR } from "./lib.mjs";

const node = (script, args, capture = false) => {
  const res = spawnSync(process.execPath, [join(BENCH_DIR, "harness", script), ...args], { stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (capture) process.stdout.write(res.stdout);
  if (res.status !== 0) process.exit(res.status ?? 1);
  return res.stdout;
};

node("setup.mjs", []);
const out = node("runner.mjs", process.argv.slice(2), true);
const dir = /\[run\] done: (.+)$/m.exec(out)?.[1]?.trim();
if (!dir) throw new Error("runner did not report a results directory");
node("grader.mjs", [dir]);
node("report.mjs", [dir]);
