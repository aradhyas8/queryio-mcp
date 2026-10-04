import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One line in the audit log. Holds operational metadata only, never result values. */
export interface AuditEvent {
  ts: string;
  tool: string;
  duration_ms: number;
  success: boolean;
  [field: string]: unknown;
}

/** Returns a writer that appends events to the JSONL file at `path`, or ignores them when `path` is null. */
export function createAuditLog(path: string | null): (event: AuditEvent) => void {
  if (!path) return () => {};
  let ready = false;
  let warned = false;
  return (event) => {
    try {
      if (!ready) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      ready = true;
      appendFileSync(path, JSON.stringify(event) + "\n", { mode: 0o600 });
    } catch (err) {
      // An unwritable log must not fail the tool call. stderr is safe: stdout carries the MCP protocol.
      if (!warned) console.error(`queryio: cannot write audit log ${path}: ${(err as Error).message}`);
      warned = true;
    }
  };
}
