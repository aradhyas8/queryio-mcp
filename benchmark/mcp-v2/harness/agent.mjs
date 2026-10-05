// Headless Codex CLI invocation shared by the benchmark agent and the grader.
// Isolation: every session gets its own throwaway CODEX_HOME (only a copy of auth.json, so no user
// config, AGENTS.md, memories, rules, or history), --ignore-user-config/--ignore-rules, --ephemeral (no
// rollout persisted), an empty working directory, a read-only sandbox with the shell, file, web, browser,
// image, plugin, hook, and sub-agent features disabled, and only the arm's MCP server configured.
// Code mode stays on: in this Codex version MCP tools are reachable only through it, and its `exec`
// cannot touch files or the network. Tools that cannot be switched off (wait, request_user_input,
// collaboration) are detected from the event stream by the runner.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { BENCH_DIR, opaqueId } from "./lib.mjs";

const NPM_ROOT = spawnSync("npm root -g", { shell: true, encoding: "utf8" }).stdout.trim();
export const CODEX_JS = join(NPM_ROOT, "@openai", "codex", "bin", "codex.js");
// Must not live under %TEMP%: Codex refuses to run its helper binaries from there.
const HOMES = join(BENCH_DIR, ".codex-home");
const USER_AUTH = join(os.homedir(), ".codex", "auth.json");
const HOME_AUTH = join(HOMES, "auth.json");

export const MCP_STARTUP_TIMEOUT_SEC = 120;
const DISABLED = [
  "shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "computer_use", "image_generation", "view_image",
  "plugins", "remote_plugin", "hooks", "multi_agent", "multi_agent_v2", "goals", "skill_search", "tool_suggest",
  "skill_mcp_dependency_install", "workspace_dependencies", "sleep_tool", "in_app_browser", "shell_snapshot", "default_mode_request_user_input", "memories",
];

export function codexVersion() {
  return spawnSync(process.execPath, [CODEX_JS, "--version"], { encoding: "utf8" }).stdout.trim();
}

export function codexAuthMethod() {
  syncAuth();
  const res = spawnSync(process.execPath, [CODEX_JS, "login", "status"], { encoding: "utf8", env: { ...process.env, CODEX_HOME: HOMES } });
  return (res.stdout.trim() || res.stderr.trim()) || null; // codex prints the status on stderr
}

const toml = (v) => (Array.isArray(v) ? `[${v.map(toml).join(",")}]` : typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${k}=${toml(x)}`).join(",")}}` : JSON.stringify(v));

/** `mcp` = { command, args, env } of the single server exposed as `database`, or null for none. */
export function codexArgs({ model, effort, developerInstructions, mcp, outputSchemaPath, lastMessagePath }) {
  return [
    "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check",
    "-m", model,
    "-c", `model_reasoning_effort=${toml(effort)}`,
    "-c", "web_search=\"disabled\"",
    "-c", "approval_policy=\"never\"",
    ...(developerInstructions ? ["-c", `developer_instructions=${toml(developerInstructions)}`] : []),
    // Without "approve", every MCP call fails with "requires approval, but approval policy is never".
    // Codex silently starts the session without a server's tools if its handshake exceeds the startup
    // timeout (default 10 s; DBHub took 16 s with three servers starting at once), so it is raised for
    // every arm and the runner checks the recorded handshake time against it.
    ...(mcp ? ["-c", `mcp_servers.database=${toml({ default_tools_approval_mode: "approve", startup_timeout_sec: MCP_STARTUP_TIMEOUT_SEC, tool_timeout_sec: 600, ...mcp })}`] : []),
    "-s", "read-only",
    ...DISABLED.flatMap((f) => ["--disable", f]),
    "--json",
    ...(outputSchemaPath ? ["--output-schema", outputSchemaPath] : []),
    "-o", lastMessagePath,
    "-",
  ];
}

const lastRefresh = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")).last_refresh ?? "" : "");
/** Keep the benchmark login and the user's main login on the newest token pair (refresh tokens rotate). */
function syncAuth(sessionAuth) {
  mkdirSync(HOMES, { recursive: true });
  if (lastRefresh(USER_AUTH) > lastRefresh(HOME_AUTH)) copyFileSync(USER_AUTH, HOME_AUTH);
  if (sessionAuth && lastRefresh(sessionAuth) > lastRefresh(HOME_AUTH)) {
    copyFileSync(sessionAuth, HOME_AUTH);
    if (lastRefresh(sessionAuth) > lastRefresh(USER_AUTH)) copyFileSync(sessionAuth, USER_AUTH);
  }
}

function classifyError(text) {
  if (!text) return null;
  if (/usage limit|quota|purchase more credits|upgrade to/i.test(text)) return "usage_limit";
  // Lost connectivity (DNS, dropped streams). Codex reconnects on its own, but a disturbed run is discarded.
  if (/reconnecting|stream disconnected|os error|no such host|connection (reset|refused)/i.test(text)) return "network";
  if (/\b429\b|rate.?limit|too many requests/i.test(text)) return "rate_limit";
  return "api";
}

/**
 * Run one fresh session; the prompt goes over stdin. Resolves with a normalized result:
 * { exitCode, timedOut, wallMs, stderr, events, sessionId, answer, mcpCalls, items, usage, error }.
 */
export function runCodex({ args, prompt, cwd, timeoutMs, transcriptPath, lastMessagePath }) {
  syncAuth();
  const home = join(HOMES, "sessions", opaqueId(6));
  mkdirSync(home, { recursive: true });
  copyFileSync(HOME_AUTH, join(home, "auth.json"));
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CODEX_JS, ...args], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const transcript = transcriptPath ? createWriteStream(transcriptPath) : null;
    const events = [];
    let buf = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      transcript?.write(chunk);
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          /* non-JSON noise stays in the transcript */
        }
      }
    });
    child.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on("error", (err) => (stderr += `spawn error: ${err.message}\n`));
    child.on("close", (code) => {
      clearTimeout(timer);
      transcript?.end();
      syncAuth(join(home, "auth.json"));
      rmSync(home, { recursive: true, force: true });
      const items = events.filter((e) => e.type === "item.completed").map((e) => e.item);
      const turns = events.filter((e) => e.type === "turn.completed");
      const usage = turns.length
        ? Object.fromEntries(["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"].map((k) => [k, turns.reduce((a, t) => a + (t.usage?.[k] ?? 0), 0)]))
        : null;
      const errText = [
        ...events.filter((e) => e.type === "turn.failed").map((e) => e.error?.message ?? JSON.stringify(e.error)),
        ...events.filter((e) => e.type === "error").map((e) => e.message ?? JSON.stringify(e)),
      ].join("\n");
      const lastMessage = existsSync(lastMessagePath) ? readFileSync(lastMessagePath, "utf8") : null;
      resolve({
        exitCode: code,
        timedOut,
        wallMs: Date.now() - t0,
        stderr,
        events,
        sessionId: events.find((e) => e.type === "thread.started")?.thread_id ?? null,
        answer: lastMessage ?? items.findLast((i) => i.type === "agent_message")?.text ?? "",
        items,
        mcpCalls: items.filter((i) => i.type === "mcp_tool_call"),
        usage,
        error: errText ? { kind: classifyError(errText + stderr), message: errText.slice(0, 2000) } : null,
      });
    });
    child.stdin.end(prompt);
  });
}

function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"]);
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
  }
}
