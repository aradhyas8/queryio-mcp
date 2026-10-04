import { describe, expect, it } from "vitest";
// @ts-expect-error runner.cjs is CommonJS without declaration file
import { countMetrics } from "../benchmark/runner.cjs";

describe("benchmark metrics counter", () => {
  it("counts a DB tool command with bytes measured after Output:\\n", () => {
    const steps = [
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: 'node "C:/path/to/workspace/db-tool.cjs" "SELECT 1;"',
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: "Created At: 2026-10-04T12:00:00Z\nCompleted At: 2026-10-04T12:00:01Z\n\nThe command exited with code 0.\nOutput:\n?column?\n--------\n       1\n(1 row)\n",
      },
    ];

    const metrics = countMetrics(steps);
    // Verified independent literal byte count for "?column?\n--------\n       1\n(1 row)\n" is 35 bytes
    expect(metrics).toEqual({
      interactions: 1,
      db_output_bytes: 35,
      failed_operations: 0,
    });

  });

  it("does not count unrelated commands, including those referencing db-tool.cjs without executing it", () => {
    const steps = [
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: "Get-ChildItem -Path ./workspace",
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: "The command exited with code 0.\nOutput:\ndb-tool.cjs\nREADME.md\n",
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: "cat db-tool.cjs",
            },
          },
        ],
      },
      {
        step_index: 4,
        source: "MODEL",
        type: "GENERIC",
        content: "The command exited with code 0.\nOutput:\nconsole.log('hello');\n",
      },
      {
        step_index: 5,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: 'node -e "console.log(\'db-tool.cjs\')"',
            },
          },
        ],
      },
      {
        step_index: 6,
        source: "MODEL",
        type: "GENERIC",
        content: "The command exited with code 0.\nOutput:\ndb-tool.cjs\n",
      },
      {
        step_index: 7,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: "cat schema.psql",
            },
          },
        ],
      },
      {
        step_index: 8,
        source: "MODEL",
        type: "GENERIC",
        content: "The command exited with code 0.\nOutput:\n-- psql schema\n",
      },
    ];

    const metrics = countMetrics(steps);
    expect(metrics).toEqual({
      interactions: 0,
      db_output_bytes: 0,
      failed_operations: 0,
    });
  });

  it("counts a non-zero exit code as a failure", () => {
    const steps = [
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: 'node db-tool.cjs query \'{"sql":"SELECT * FROM"}\'',
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: "The command exited with code 1.\nOutput:\nQueryIO Error [syntax_error]: syntax error at end of input\n",
      },
    ];

    const metrics = countMetrics(steps);
    // Verified independent literal byte count for "QueryIO Error [syntax_error]: syntax error at end of input\n" is 59 bytes
    expect(metrics).toEqual({
      interactions: 1,
      db_output_bytes: 59,
      failed_operations: 1,
    });

  });

  it("throws when a matched command has no result header", () => {
    const steps = [
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: "node db-tool.cjs list_tables",
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: "Something unexpected happened without exit code header",
      },
    ];

    expect(() => countMetrics(steps)).toThrow(/no command result header/i);
  });

  it("ignores backgrounded tasks that never completed or exited", () => {
    const steps = [
      {
        step_index: 1,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "run_command",
            args: {
              CommandLine: "node db-tool.cjs list_tables",
            },
          },
        ],
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "GENERIC",
        content: "Created At: 2026-10-04T12:10:03Z\nTool is running as a background task with task id: test/task-1\nTask Description: list tables",
      },
    ];

    expect(countMetrics(steps)).toEqual({
      interactions: 0,
      db_output_bytes: 0,
      failed_operations: 0,
    });
  });
});
