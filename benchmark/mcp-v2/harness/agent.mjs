// Headless Claude Code invocation shared by the benchmark agent and the grader.
// Isolation: --setting-sources "" (no user/project settings, so no hooks, plugins, or permissions from them),
// --disable-slash-commands (no skills),
// --tools "" (no built-in tools: no shell, no filesystem, no web), --strict-mcp-config (only the arm's
// server), a replaced system prompt, an empty working directory, and no session persistence.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";

export function claudeVersion(cli = "claude") {
  return spawnSync(cli, ["--version"], { encoding: "utf8", env: cleanEnv() }).stdout.trim();
}

/** The parent session's Claude Code variables must not leak into the child session. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|AI_AGENT$)/.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export function claudeArgs({ model, effort, maxTurns, systemPrompt, mcpConfigPath, allowedTools, jsonSchema }) {
  return [
    "-p",
    "--model", model,
    ...(effort ? ["--effort", effort] : []),
    ...(maxTurns ? ["--max-turns", String(maxTurns)] : []),
    "--setting-sources", "",
    "--disable-slash-commands",
    "--include-hook-events",
    "--tools", "",
    "--strict-mcp-config",
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    "--permission-mode", "dontAsk",
    ...(allowedTools ? ["--allowedTools", allowedTools] : []),
    "--system-prompt", systemPrompt,
    "--no-session-persistence",
    "--output-format", "stream-json",
    "--verbose",
    ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []),
  ];
}

/** Run one fresh session; the prompt goes over stdin. Resolves with the parsed stream. */
export function runClaude({ cli = "claude", args, prompt, cwd, timeoutMs, transcriptPath }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cli, args, { cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const transcript = transcriptPath ? createWriteStream(transcriptPath) : null;
    const messages = [];
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
          messages.push(JSON.parse(line));
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
      resolve({
        exitCode: code,
        timedOut,
        wallMs: Date.now() - t0,
        stderr,
        messages,
        init: messages.find((m) => m.type === "system" && m.subtype === "init") ?? null,
        result: messages.findLast((m) => m.type === "result") ?? null,
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
