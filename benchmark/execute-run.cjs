#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { TASKS, resetDatabase, setupRunWorkspace, extractMetrics } = require('./runner.cjs');

const action = process.argv[2];

if (action === 'setup') {
  const arm = process.argv[3];
  const task = parseInt(process.argv[4], 10);
  const run = parseInt(process.argv[5], 10);

  console.log(`[Resetting Database] for Arm ${arm}, Task ${task}, Run ${run}...`);
  resetDatabase();

  const setup = setupRunWorkspace(arm, task, run);
  console.log(`[Workspace Created] ${setup.workspacePath}`);
  console.log(JSON.stringify(setup));
} else if (action === 'finish') {
  const arm = process.argv[3];
  const task = parseInt(process.argv[4], 10);
  const run = parseInt(process.argv[5], 10);
  const conversationId = process.argv[6];
  const transcriptPath = process.argv[7];

  const runKey = `arm_${arm.toLowerCase()}_task_${task}_run_${run}`;
  const runDir = path.join(__dirname, 'runs', runKey);
  const auditPath = path.join(runDir, 'workspace', 'audit.jsonl');

  const metrics = extractMetrics(arm, task, run, transcriptPath, auditPath);
  metrics.conversation_id = conversationId;
  metrics.transcript_path = transcriptPath;
  metrics.completed_at = new Date().toISOString();

  const resultPath = path.join(runDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(metrics, null, 2), 'utf8');

  console.log(`[Run Finished] ${runKey}`);
  console.log(JSON.stringify(metrics, null, 2));
} else {
  console.error('Usage: node execute-run.cjs setup <arm> <task> <run>');
  console.error('       node execute-run.cjs finish <arm> <task> <run> <conversationId> <transcriptPath>');
  process.exit(1);
}
