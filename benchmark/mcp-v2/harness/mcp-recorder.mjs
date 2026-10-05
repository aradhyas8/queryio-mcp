#!/usr/bin/env node
// Transparent stdio MCP proxy. Every benchmark arm runs its server behind this one process, so MCP
// metrics come from the same code for every product. Bytes are forwarded unchanged and immediately;
// newline-delimited JSON-RPC is parsed on the side to log every message and one summary per tools/call.
//
// Usage: node mcp-recorder.mjs --events <file.jsonl> --meta '<json>' -- <command> [args...]
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i < sep ? argv[i + 1] : undefined;
};
if (sep < 0 || !opt("--events")) {
  console.error("usage: mcp-recorder.mjs --events <file> [--meta <json>] -- <command> [args...]");
  process.exit(2);
}
const eventsFile = opt("--events");
const meta = JSON.parse(opt("--meta") ?? "{}");
const [command, ...args] = argv.slice(sep + 1);

const log = (event) => appendFileSync(eventsFile, JSON.stringify({ ...meta, ts: new Date().toISOString(), ...event }) + "\n");
const pending = new Map(); // JSON-RPC id -> tools/call request info

const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
log({ kind: "proxy_start", command, args, pid: child.pid });

child.on("error", (err) => {
  log({ kind: "proxy_error", message: err.message });
  process.exit(1);
});
child.stderr.on("data", (chunk) => log({ kind: "server_stderr", text: chunk.toString("utf8") }));

process.stdin.on("data", (chunk) => child.stdin.write(chunk));
process.stdin.on("end", () => child.stdin.end());
child.stdout.on("data", (chunk) => process.stdout.write(chunk));

lines(process.stdin, (line) => onMessage("client_to_server", line));
lines(child.stdout, (line) => onMessage("server_to_client", line));

child.on("exit", (code, signal) => {
  for (const [id, call] of pending) finishCall(id, call, { ok: false, error_category: "no_response", error_message: "server exited before responding" });
  log({ kind: "proxy_exit", code, signal });
  process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));

function lines(stream, onLine) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
}

function onMessage(direction, line) {
  const bytes = Buffer.byteLength(line, "utf8");
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log({ kind: "message", direction, bytes, unparsable: line.slice(0, 2000) });
    return;
  }
  log({ kind: "message", direction, bytes, method: msg.method, id: msg.id, message: msg });

  if (direction === "client_to_server") {
    if (msg.method === "tools/call") {
      pending.set(msg.id, { tool: msg.params?.name, t0: Date.now(), request_ts: new Date().toISOString(), request_bytes: bytes });
    } else if (msg.method === "notifications/cancelled" && pending.has(msg.params?.requestId)) {
      const id = msg.params.requestId;
      finishCall(id, pending.get(id), { ok: false, error_category: "cancelled", error_message: msg.params?.reason ?? null });
    }
    return;
  }
  if (msg.id !== undefined && msg.method === undefined) {
    if (msg.result?.serverInfo) log({ kind: "server_info", server_info: msg.result.serverInfo, protocol_version: msg.result.protocolVersion });
    const call = pending.get(msg.id);
    if (!call) return;
    if (msg.error) {
      finishCall(msg.id, call, { ok: false, response_bytes: bytes, error_category: "protocol_error", error_message: `${msg.error.code}: ${msg.error.message}` });
    } else if (msg.result?.isError) {
      const text = (msg.result.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      finishCall(msg.id, call, { ok: false, response_bytes: bytes, error_category: "tool_error", error_message: text.slice(0, 1000) });
    } else {
      finishCall(msg.id, call, { ok: true, response_bytes: bytes });
    }
  }
}

function finishCall(id, call, outcome) {
  pending.delete(id);
  log({
    kind: "tool_call",
    id,
    tool: call.tool,
    request_ts: call.request_ts,
    response_ts: new Date().toISOString(),
    duration_ms: Date.now() - call.t0,
    request_bytes: call.request_bytes,
    response_bytes: outcome.response_bytes ?? 0,
    ok: outcome.ok,
    error_category: outcome.error_category ?? null,
    error_message: outcome.error_message ?? null,
  });
}
