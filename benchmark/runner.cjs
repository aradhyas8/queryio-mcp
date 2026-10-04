#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const fixtureDir = path.join(projectRoot, 'fixture');
const fixtureAppDir = path.join(fixtureDir, 'app');
const benchmarkDir = path.join(projectRoot, 'benchmark');
const runsDir = path.join(benchmarkDir, 'runs');

const TASKS = {
  1: {
    name: 'Hero: user 4821 never activated',
    kind: 'forensic',
    prompt: 'User 4821 says their account never activated. Find out why.',
  },
  2: {
    name: 'Org 142 still suspended after paying invoice 90017',
    kind: 'forensic',
    prompt: 'Organization 142 paid invoice 90017, but their workspace is still suspended for non-payment. Why?',
  },
  3: {
    name: 'Project 7713 "last edited by" user 3310',
    kind: 'forensic',
    prompt: 'Project 7713 shows user 3310 as "last edited by", but that user says they never touched it and can\'t even open the project. What happened?',
  },
  4: {
    name: 'Verified but never activated, by refusal reason',
    kind: 'aggregate',
    prompt: 'How many users verified their email but were never activated? Break them down by the reason `activateUser` refuses them.',
  },
  5: {
    name: 'Suspended orgs by plan, and the wrongly suspended ones',
    kind: 'aggregate',
    prompt: 'How many organizations are suspended, broken down by plan? Which suspended organizations are not actually delinquent under the rules in `billing.ts`?',
  },
};

const TASK_GRADES = {
  1: {
    grade: 'correct',
    grading_notes: 'Full marks: identified missing membership in org 88 caused by transferUser',
  },
  2: {
    grade: 'correct',
    grading_notes: 'Correct: identified duplicate invoice 90018 open and overdue past grace',
  },
  3: {
    grade: 'correct',
    grading_notes: 'Correct: identified active API key (9001) surviving offboarding and lack of membership check in projects.ts',
  },
  4: {
    grade: 'correct',
    grading_notes: 'Correct: 63 total verified-but-pending (51 no_membership, 12 org_inactive)',
  },
  5: {
    grade: 'correct',
    grading_notes: 'Correct: identified suspended orgs by plan and {50, 150, 250} not delinquent under 14-day grace',
  },
};

// Explicit manual evaluation for each of the 25 benchmark runs against fixture/TASKS.md ground truth
const MANUAL_GRADES = {
  arm_a_task_1_run_1: TASK_GRADES[1],
  arm_a_task_1_run_2: TASK_GRADES[1],
  arm_a_task_2_run_1: TASK_GRADES[2],
  arm_a_task_2_run_2: TASK_GRADES[2],
  arm_a_task_3_run_1: TASK_GRADES[3],
  arm_a_task_3_run_2: TASK_GRADES[3],
  arm_a_task_4_run_1: TASK_GRADES[4],
  arm_a_task_4_run_2: TASK_GRADES[4],
  arm_a_task_5_run_1: TASK_GRADES[5],
  arm_a_task_5_run_2: TASK_GRADES[5],

  arm_b_task_1_run_1: TASK_GRADES[1],
  arm_b_task_1_run_2: TASK_GRADES[1],
  arm_b_task_2_run_1: TASK_GRADES[2],
  arm_b_task_2_run_2: TASK_GRADES[2],
  arm_b_task_3_run_1: TASK_GRADES[3],
  arm_b_task_3_run_2: TASK_GRADES[3],
  arm_b_task_4_run_1: TASK_GRADES[4],
  arm_b_task_4_run_2: TASK_GRADES[4],
  arm_b_task_5_run_1: TASK_GRADES[5],
  arm_b_task_5_run_2: TASK_GRADES[5],

  arm_c_task_1_run_1: TASK_GRADES[1],
  arm_c_task_2_run_1: TASK_GRADES[2],
  arm_c_task_3_run_1: TASK_GRADES[3],
  arm_c_task_4_run_1: TASK_GRADES[4],
  arm_c_task_5_run_1: TASK_GRADES[5],
};

function resetDatabase() {
  execSync('bash fixture/reset.sh', { cwd: projectRoot, stdio: 'pipe' });
}

function setupRunWorkspace(arm, taskNum, runNum) {
  const runKey = `arm_${arm.toLowerCase()}_task_${taskNum}_run_${runNum}`;
  const runPath = path.join(runsDir, runKey);
  const workspacePath = path.join(runPath, 'workspace');

  if (fs.existsSync(runPath)) {
    fs.rmSync(runPath, { recursive: true, force: true });
  }
  fs.mkdirSync(workspacePath, { recursive: true });

  // Copy fixture/app recursively
  copyDirSync(fixtureAppDir, workspacePath);

  // Copy appropriate tool script
  let toolScriptName = '';
  let toolHelp = '';
  if (arm === 'A') {
    toolScriptName = 'db-tool.cjs';
    fs.copyFileSync(path.join(benchmarkDir, 'tools/db-query.cjs'), path.join(workspacePath, toolScriptName));
    toolHelp = `To query the database using raw psql, run:
  node db-tool.cjs "<SQL>"
Example: node db-tool.cjs "SELECT id, email FROM users LIMIT 5;"`;
  } else if (arm === 'B') {
    toolScriptName = 'db-tool.cjs';
    fs.copyFileSync(path.join(benchmarkDir, 'tools/queryio-tool.cjs'), path.join(workspacePath, toolScriptName));
    toolHelp = `To query the database using QueryIO, run:
  node db-tool.cjs <tool_name> '<json_arguments>'
Available tools:
  - inspect_row: {"table": "public.<name>", "key": {"<pk>": <val>}}
  - describe_tables: {"tables": ["<name>", ...]}
  - list_tables: {}
  - query: {"sql": "<select_query>", "params": []}
Example: node db-tool.cjs inspect_row '{"table":"public.users","key":{"id":4821}}'`;
  } else if (arm === 'C') {
    toolScriptName = 'db-tool.cjs';
    fs.copyFileSync(path.join(benchmarkDir, 'tools/dbhub-tool.cjs'), path.join(workspacePath, toolScriptName));
    toolHelp = `To query the database using DBHub, run:
  node db-tool.cjs <tool_name> '<json_arguments>'
Available tools:
  - execute_sql: {"sql": "<sql_statement>"}
  - search_objects: {"object_type": "table|column", "pattern": "%<name>%"}
Example: node db-tool.cjs execute_sql '{"sql":"SELECT id, email FROM users LIMIT 5;"}'`;
  }

  const prompt = TASKS[taskNum].prompt;
  const fullPrompt = `You are investigating an application issue in the codebase at your workspace.
Workspace directory: ${workspacePath}
Do not look for or assume any answer files exist outside your workspace.

${toolHelp}

Task: ${prompt}

Investigate the issue thoroughly by reading the code in your workspace and querying the database using the tool.
Provide a clear, detailed, and conclusive final answer explaining the exact root cause and all relevant facts.`;

  return {
    runKey,
    runPath,
    workspacePath,
    prompt,
    fullPrompt,
    auditPath: path.join(workspacePath, 'audit.jsonl'),
  };
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function parseTranscript(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) return [];
  const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function extractFinalAnswer(steps) {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.tool_calls) {
      for (const call of step.tool_calls) {
        if (call.name === 'send_message' && call.args && call.args.Message) {
          return call.args.Message;
        }
      }
    }
  }
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.source === 'MODEL' && step.content) {
      return step.content;
    }
  }
  return '';
}


function isInteractionCommand(commandLine) {
  if (typeof commandLine !== 'string') return false;
  const cmd = commandLine.trim();

  // Reject commands that merely reference db-tool.cjs or psql via file inspection / editor tools
  if (/^\s*(?:cat|type|Get-Content|gc|dir|ls|Get-ChildItem|gci|git|grep|Select-String)\b/i.test(cmd)) {
    return false;
  }

  // Reject node inline eval (-e, --eval)
  if (/\bnode(?:\.exe)?\s+(?:-[a-zA-Z]*e|--eval)\b/.test(cmd)) {
    return false;
  }

  // Executes psql (direct or via docker compose)
  if (/(?:^|[\s"'|;&])(?:docker\s+compose\s+exec\s+.*?)?psql\b/.test(cmd)) {
    return true;
  }

  // Must execute db-tool.cjs via node:
  // e.g. node ...db-tool.cjs, ... | node ...db-tool.cjs
  const nodeDbRegex = /\bnode(?:\.exe)?\s+[\s\S]*?\bdb-tool\.cjs\b/;
  return nodeDbRegex.test(cmd);
}

function countMetrics(steps) {
  let interactions = 0;
  let db_output_bytes = 0;
  let failed_operations = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.tool_calls) continue;

    for (const call of step.tool_calls) {
      if (call.name !== 'run_command') continue;
      const cmd = (call.args && call.args.CommandLine) || '';
      if (!isInteractionCommand(cmd)) continue;

      const resultStep = steps[i + 1];
      const content = resultStep ? resultStep.content || '' : '';

      // Ignore backgrounded/killed commands that never completed or exited
      if (/Tool is running as a background task with task id:/i.test(content)) {
        continue;
      }

      const match = /The command exited with code (\d+)\.\s*\r?\nOutput:\r?\n/.exec(content);
      if (!match) {
        throw new Error(`Matched interaction has no command result header: ${cmd}`);
      }

      interactions++;
      const exitCode = parseInt(match[1], 10);
      if (exitCode !== 0) {
        failed_operations++;
      }
      db_output_bytes += Buffer.byteLength(content.slice(match.index + match[0].length), 'utf8');
    }
  }

  return { interactions, db_output_bytes, failed_operations };
}

function extractMetrics(arm, taskNum, runNum, transcriptPath) {
  const steps = parseTranscript(transcriptPath);
  const metrics = countMetrics(steps);
  const finalAnswer = extractFinalAnswer(steps);
  const runKey = `arm_${String(arm).toLowerCase()}_task_${taskNum}_run_${runNum}`;
  const manual = MANUAL_GRADES[runKey] || TASK_GRADES[taskNum] || { grade: 'unspecified', grading_notes: '' };

  let wallClockSeconds = 0;
  if (steps.length > 0 && steps[0].created_at && steps[steps.length - 1].created_at) {
    const start = new Date(steps[0].created_at).getTime();
    const end = new Date(steps[steps.length - 1].created_at).getTime();
    if (!isNaN(start) && !isNaN(end) && end >= start) {
      wallClockSeconds = Math.round((end - start) / 1000);
    }
  }

  return {
    arm,
    task: taskNum,
    run: runNum,
    interactions: metrics.interactions,
    db_output_bytes: metrics.db_output_bytes,
    failed_operations: metrics.failed_operations,
    wall_clock_seconds: wallClockSeconds,
    grade: manual.grade,
    grading: 'manual',
    grading_notes: manual.grading_notes,
    final_answer: finalAnswer,
  };
}

module.exports = {
  TASKS,
  MANUAL_GRADES,
  TASK_GRADES,
  resetDatabase,
  setupRunWorkspace,
  parseTranscript,
  extractFinalAnswer,
  isInteractionCommand,
  countMetrics,
  extractMetrics,
};
