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

function extractMetrics(arm, taskNum, runNum, transcriptPath, auditPath) {
  let interactions = 0;
  let dbOutputBytes = 0;
  let failedOperations = 0;
  let finalAnswer = '';
  let durationMs = 0;

  const steps = parseTranscript(transcriptPath);

  // Extract final answer from model (check send_message first, then fallback to model content)
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.tool_calls) {
      for (const call of step.tool_calls) {
        if (call.name === 'send_message' && call.args && call.args.Message) {
          finalAnswer = call.args.Message;
          break;
        }
      }
    }
    if (finalAnswer) break;
  }
  if (!finalAnswer) {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step.source === 'MODEL' && step.content) {
        finalAnswer = step.content;
        break;
      }
    }
  }

  if (arm === 'B' && fs.existsSync(auditPath)) {
    // Derive QueryIO metrics from audit JSONL
    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    interactions = auditLines.length;
    for (const line of auditLines) {
      try {
        const ev = JSON.parse(line);
        if (ev.duration_ms) durationMs += ev.duration_ms;
        if (ev.success === false) {
          failedOperations++;
        }
        if (ev.bytes_returned) {
          dbOutputBytes += ev.bytes_returned;
        }
      } catch {}
    }
  } else {
    // Derive psql or DBHub metrics from transcript steps
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.tool_calls) {
        for (const call of step.tool_calls) {
          if (call.name === 'run_command' && call.args && call.args.CommandLine) {
            const cmd = call.args.CommandLine;
            if (cmd.includes('db-tool.cjs') || cmd.includes('psql')) {
              interactions++;
              // Look ahead to generic tool result
              const nextStep = steps[i + 1];
              if (nextStep && (nextStep.type === 'GENERIC' || nextStep.type === 'TOOL_RESPONSE' || nextStep.content)) {
                const content = nextStep.content || '';
                const bytes = Buffer.byteLength(content, 'utf8');
                dbOutputBytes += bytes;
                if (content.includes('ERROR:') || content.includes('Invalid') || content.includes('"isError": true') || content.includes('Command failed')) {
                  failedOperations++;
                }
              }
            }
          }
        }
      }
    }
  }

  // Grade against ground truth
  const grading = gradeTask(taskNum, finalAnswer);

  return {
    arm,
    task: taskNum,
    run: runNum,
    interactions,
    db_output_bytes: dbOutputBytes,
    failed_operations: failedOperations,
    duration_ms: durationMs,
    grade: grading.grade,
    grading_notes: grading.notes,
    final_answer: finalAnswer,
  };
}

function gradeTask(taskNum, text) {
  const lower = text.toLowerCase();
  switch (taskNum) {
    case 1: {
      // Must name missing membership in org 88 (or still in 21). Distractor: expired token.
      const mentionsMissingMembership = (lower.includes('membership') || lower.includes('memberships')) &&
        (lower.includes('88') || lower.includes('transfer'));
      const blamedExpiredToken = lower.includes('token expired') && !mentionsMissingMembership;
      if (blamedExpiredToken) {
        return { grade: 'wrong', notes: 'Fell for distractor: blamed expired token instead of missing org 88 membership' };
      }
      if (mentionsMissingMembership) {
        const mentionsTransfer = lower.includes('transfer');
        return {
          grade: 'correct',
          notes: mentionsTransfer
            ? 'Full marks: identified missing membership in org 88 caused by transferUser'
            : 'Correct: identified missing membership in org 88',
        };
      }
      return { grade: 'wrong', notes: 'Did not identify missing membership in org 88' };
    }
    case 2: {
      // Must identify duplicate invoice 90018 as open and overdue past 14-day grace.
      const mentions90018 = lower.includes('90018');
      const mentionsDuplicate = lower.includes('duplicate') || lower.includes('same period');
      const mentionsGrace = lower.includes('grace') || lower.includes('14') || lower.includes('overdue') || lower.includes('past due');
      if (mentions90018 && (mentionsDuplicate || mentionsGrace)) {
        return { grade: 'correct', notes: 'Correct: identified duplicate invoice 90018 open and overdue past grace' };
      }
      if (mentions90018) {
        return { grade: 'partial', notes: 'Partial: identified invoice 90018 without noting duplicate period' };
      }
      return { grade: 'wrong', notes: 'Did not identify invoice 90018 as the cause' };
    }
    case 3: {
      // Must identify API key 9001 active and missing check in projects.ts, and user can't open because assignments cascaded.
      const mentionsApiKey = lower.includes('api key') || lower.includes('api_key') || lower.includes('9001') || lower.includes('ci-sync');
      const mentionsAuth = lower.includes('auth') || lower.includes('membership') || lower.includes('offboard') || lower.includes('revoked');
      const mentionsNoAccess = lower.includes('assignment') || lower.includes('cannot open') || lower.includes("can't open") || lower.includes('cascade') || lower.includes('access');
      if (mentionsApiKey && mentionsAuth) {
        return { grade: 'correct', notes: 'Correct: identified active API key (9001) surviving offboarding and lack of membership check in projects.ts' };
      }
      if (mentionsApiKey) {
        return { grade: 'partial', notes: 'Partial: identified API key but missed why user cannot open project or survival reason' };
      }
      return { grade: 'wrong', notes: 'Did not identify active API key surviving offboarding' };
    }
    case 4: {
      // Must identify 63 total verified-but-pending users, 51 no_membership, 12 org_inactive.
      const has63 = text.includes('63');
      const has51 = text.includes('51');
      const has12 = text.includes('12');
      const has478 = text.includes('478');
      if (has478 && !has63) {
        return { grade: 'wrong', notes: 'Trap answer: counted all 478 pending users including unverified ones' };
      }
      if (has63 && (has51 || has12)) {
        return { grade: 'correct', notes: 'Correct: 63 total verified-but-pending (51 no_membership, 12 org_inactive)' };
      }
      if (has63) {
        return { grade: 'partial', notes: 'Partial: found 63 total but incomplete reason breakdown' };
      }
      if (has51 && has12) {
        return { grade: 'correct', notes: 'Correct breakdown: 51 no_membership and 12 org_inactive' };
      }
      return { grade: 'wrong', notes: 'Did not find correct count (63: 51 no_membership, 12 org_inactive)' };
    }
    case 5: {
      // Must identify 12 suspended orgs by plan (free 2, starter 2, team 6, enterprise 2) and not delinquent: {50, 150, 250}.
      const mentions50 = text.includes('50');
      const mentions150 = text.includes('150');
      const mentions250 = text.includes('250');
      const hasPlanBreakdown = lower.includes('free') && lower.includes('starter') && lower.includes('team');
      if (mentions50 && mentions150 && mentions250) {
        return { grade: 'correct', notes: 'Correct: identified suspended orgs by plan and {50, 150, 250} not delinquent under 14-day grace' };
      }
      if (mentions50 && mentions250 && !mentions150) {
        return { grade: 'partial', notes: 'Trap answer: omitted org 150 by ignoring 14-day grace period' };
      }
      return { grade: 'wrong', notes: 'Did not identify non-delinquent suspended orgs {50, 150, 250}' };
    }
    default:
      return { grade: 'unspecified', notes: '' };
  }
}

module.exports = {
  TASKS,
  resetDatabase,
  setupRunWorkspace,
  extractMetrics,
  gradeTask,
};
