#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const {
  TASKS,
  MANUAL_GRADES,
  resetDatabase,
  setupRunWorkspace,
  extractMetrics,
} = require('./runner.cjs');

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

  const metrics = extractMetrics(arm, task, run, transcriptPath);
  const result = {
    arm: metrics.arm,
    task: metrics.task,
    run: metrics.run,
    interactions: metrics.interactions,
    db_output_bytes: metrics.db_output_bytes,
    failed_operations: metrics.failed_operations,
    wall_clock_seconds: metrics.wall_clock_seconds,
    grade: metrics.grade,
    grading: metrics.grading,
    grading_notes: metrics.grading_notes,
    final_answer: metrics.final_answer,
    completed_at: new Date().toISOString(),
    conversation_id: conversationId,
    transcript_path: transcriptPath,
  };

  const resultPath = path.join(runDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

  console.log(`[Run Finished] ${runKey}`);
  console.log(JSON.stringify(result, null, 2));
} else if (action === 're-extract') {
  const runsDir = path.join(__dirname, 'runs');
  const runDirs = fs.readdirSync(runsDir).sort();
  let count = 0;

  for (const dirName of runDirs) {
    const runDir = path.join(runsDir, dirName);
    const resultPath = path.join(runDir, 'result.json');
    if (!fs.existsSync(resultPath)) continue;

    const existing = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const metrics = extractMetrics(existing.arm, existing.task, existing.run, existing.transcript_path);

    const newResult = {
      arm: existing.arm,
      task: existing.task,
      run: existing.run,
      interactions: metrics.interactions,
      db_output_bytes: metrics.db_output_bytes,
      failed_operations: metrics.failed_operations,
      wall_clock_seconds: existing.wall_clock_seconds,
      grade: metrics.grade,
      grading: metrics.grading,
      grading_notes: metrics.grading_notes,
      final_answer: metrics.final_answer || existing.final_answer,
      completed_at: existing.completed_at,
      conversation_id: existing.conversation_id,
      transcript_path: existing.transcript_path,
    };

    fs.writeFileSync(resultPath, JSON.stringify(newResult, null, 2) + '\n', 'utf8');
    count++;
    console.log(`[Re-extracted] ${dirName} (${metrics.interactions} interactions, ${metrics.db_output_bytes} B, ${metrics.failed_operations} failures)`);
  }

  console.log(`Successfully re-extracted ${count} runs.`);
} else {
  console.error('Usage: node execute-run.cjs setup <arm> <task> <run>');
  console.error('       node execute-run.cjs finish <arm> <task> <run> <conversationId> <transcriptPath>');
  console.error('       node execute-run.cjs re-extract');
  process.exit(1);
}
