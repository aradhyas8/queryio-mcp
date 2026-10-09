import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { createCore } from "./core.js";
import { loadSettings } from "./settings.js";

export type ClientId = "claude" | "codex" | "cursor";
export type Scope = "project" | "global";

const CLIENTS: Record<ClientId, { name: string; bin: string }> = {
  claude: { name: "Claude Code", bin: "claude" },
  codex: { name: "Codex", bin: "codex" },
  cursor: { name: "Cursor", bin: "cursor" },
};
const ORDER: ClientId[] = ["claude", "codex", "cursor"];
const VAR = "QUERYIO_DATABASE_URL";

export interface Context {
  readonly cwd: string;
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly env: Record<string, string | undefined>;
}

export interface SetupIO {
  /** Answers, one per line. Exhaustion (EOF, Ctrl+C) cancels setup. */
  readonly lines: AsyncIterator<string>;
  write(text: string): void;
}

export interface SetupOptions extends Context {
  readonly io: SetupIO;
  /** Path of this package's cli.js; when set and the connection is available, setup starts it to confirm the server runs. */
  readonly serverEntry?: string;
}

export interface Target {
  readonly client: ClientId;
  readonly scope: Scope;
  readonly file: string;
  readonly format: "json" | "toml";
  readonly entry: Record<string, unknown>;
}

export interface Plan {
  readonly target: Target;
  readonly status: "create" | "add" | "unchanged" | "replace" | "error";
  readonly original: string | null;
  readonly next?: string;
  readonly existing?: unknown;
  readonly message?: string;
}

class Cancelled extends Error {}

/** Environment lookup that matches Windows' case-insensitive variable names. */
function envGet(ctx: Context, name: string): string | undefined {
  if (ctx.platform !== "win32") return ctx.env[name];
  const key = Object.keys(ctx.env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : ctx.env[key];
}

/** npx is a .cmd shim on Windows, which some clients cannot spawn directly. */
export function launchCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  return platform === "win32"
    ? { command: "cmd", args: ["/c", "npx", "-y", "queryio"] }
    : { command: "npx", args: ["-y", "queryio"] };
}

/** Where each client reads MCP servers, and the QueryIO entry it should contain. Entries reference the variable, never its value. */
export function targetFor(client: ClientId, scope: Scope, ctx: Context): Target {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const { command, args } = launchCommand(ctx.platform);
  const project = scope === "project";
  switch (client) {
    case "claude":
      return {
        client, scope, format: "json",
        file: project ? p.join(ctx.cwd, ".mcp.json") : p.join(envGet(ctx, "CLAUDE_CONFIG_DIR") || ctx.home, ".claude.json"),
        entry: { type: "stdio", command, args, env: { [VAR]: `\${${VAR}}` } },
      };
    case "codex":
      return {
        client, scope, format: "toml",
        file: project ? p.join(ctx.cwd, ".codex", "config.toml") : p.join(envGet(ctx, "CODEX_HOME") || p.join(ctx.home, ".codex"), "config.toml"),
        entry: { command, args, env_vars: [VAR] },
      };
    case "cursor":
      return {
        client, scope, format: "json",
        file: p.join(project ? ctx.cwd : ctx.home, ".cursor", "mcp.json"),
        entry: { type: "stdio", command, args, env: { [VAR]: `\${env:${VAR}}` } },
      };
  }
}

function which(bin: string, ctx: Context): boolean {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const exts = ctx.platform === "win32" ? ["", ...(envGet(ctx, "PATHEXT") ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  return (envGet(ctx, "PATH") ?? "").split(p.delimiter).filter(Boolean)
    .some((dir) => exts.some((ext) => existsSync(p.join(dir, bin + ext.toLowerCase())) || existsSync(p.join(dir, bin + ext))));
}

export function detectClients(ctx: Context): Record<ClientId, string | null> {
  const p = ctx.platform === "win32" ? path.win32 : path.posix;
  const found = (client: ClientId, dirs: string[]): string | null => {
    if (which(CLIENTS[client].bin, ctx)) return `\`${CLIENTS[client].bin}\` on PATH`;
    const dir = dirs.find((d) => existsSync(d));
    return dir ? dir : null;
  };
  return {
    claude: found("claude", [p.join(envGet(ctx, "CLAUDE_CONFIG_DIR") || ctx.home, ".claude.json"), p.join(ctx.home, ".claude")]),
    codex: found("codex", [envGet(ctx, "CODEX_HOME") || p.join(ctx.home, ".codex")]),
    cursor: found("cursor", [p.join(ctx.home, ".cursor")]),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Split a config into its QueryIO entry and everything else. Throws on malformed files. */
function parseConfig(format: Target["format"], text: string | null): { rest: Record<string, unknown>; entry: unknown } {
  const clean = (text ?? "").replace(/^﻿/, "");
  let doc: unknown = {};
  if (clean.trim() !== "") {
    try {
      // Round-trip TOML through JSON so tables compare as plain objects.
      doc = format === "json" ? JSON.parse(clean) : JSON.parse(JSON.stringify(parseToml(clean)));
    } catch (err) {
      throw new Error(`not valid ${format.toUpperCase()} (${(err as Error).message.split("\n")[0]})`);
    }
  }
  const key = format === "json" ? "mcpServers" : "mcp_servers";
  if (!isObject(doc)) throw new Error("top-level value is not an object");
  const servers = doc[key];
  if (servers !== undefined && !isObject(servers)) throw new Error(`"${key}" is not an object`);
  const { queryio: entry, ...others } = servers ?? {};
  const rest = { ...doc };
  delete rest[key];
  if (Object.keys(others).length > 0) rest[key] = others;
  return { rest, entry };
}

function mergeJson(original: string | null, entry: Record<string, unknown>): string {
  const text = (original ?? "").replace(/^﻿/, "");
  const doc = text.trim() === "" ? {} : JSON.parse(text);
  const updated = { ...doc, mcpServers: { ...doc.mcpServers, queryio: entry } };
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = text.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
  const next = JSON.stringify(updated, null, indent).replaceAll("\n", eol) + eol;
  return original?.startsWith("﻿") ? `﻿${next}` : next;
}

function tomlBlock(entry: Record<string, unknown>): string[] {
  const value = (v: unknown): string => (Array.isArray(v) ? `[${v.map(value).join(", ")}]` : JSON.stringify(v));
  return ["[mcp_servers.queryio]", ...Object.entries(entry).map(([k, v]) => `${k} = ${value(v)}`)];
}

/** Text edit that keeps comments and formatting elsewhere; planTarget verifies the result semantically. */
function mergeToml(original: string | null, entry: Record<string, unknown>): string {
  const text = original ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const block = tomlBlock(entry);
  const lines = text.split(/\r?\n/);
  const ours = (l: string) => /^\s*\[\s*mcp_servers\s*\.\s*(?:queryio|"queryio"|'queryio')\s*[\].]/.test(l);
  const start = lines.findIndex(ours);
  if (start === -1) {
    const body = text.replace(/(\r?\n)+$/, "");
    return (body ? body + eol + eol : "") + block.join(eol) + eol;
  }
  let end = start + 1;
  while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !ours(lines[end]))) end++;
  const after = lines.slice(end);
  return [...lines.slice(0, start), ...block, ...(after.length > 0 ? ["", ...after] : [""])].join(eol);
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function planTarget(target: Target): Plan {
  let original: string | null = null;
  try {
    original = readOrNull(target.file);
    const before = parseConfig(target.format, original);
    const next = target.format === "json" ? mergeJson(original, target.entry) : mergeToml(original, target.entry);
    const after = parseConfig(target.format, next);
    if (!isDeepStrictEqual(after.entry, target.entry) || !isDeepStrictEqual(after.rest, before.rest)) {
      throw new Error("the existing QueryIO entry cannot be replaced automatically without touching other settings");
    }
    const status = original === null ? "create"
      : before.entry === undefined ? "add"
      : isDeepStrictEqual(before.entry, target.entry) ? "unchanged" : "replace";
    return { target, status, original, next, existing: before.entry };
  } catch (err) {
    return { target, status: "error", original, message: (err as Error).message };
  }
}

/**
 * Atomic write with a backup of any existing file, then re-read to confirm the entry landed.
 * Backups go to a private directory outside the project, so they cannot be committed with it.
 */
export function applyPlan(plan: Plan, backupDir: string, now = new Date()): { backup?: string } {
  const { file, format, entry, scope } = plan.target;
  if (readOrNull(file) !== plan.original) throw new Error("the file changed while setup was running; nothing was written, rerun setup");
  mkdirSync(path.dirname(file), { recursive: true });
  let backup: string | undefined;
  let mode = scope === "global" ? 0o600 : 0o644;
  if (plan.original !== null) {
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    backup = path.join(backupDir, `${now.toISOString().replace(/[:.]/g, "-")}_${file.replace(/[:\\/]+/g, "_")}`);
    copyFileSync(file, backup, constants.COPYFILE_EXCL);
    chmodSync(backup, 0o600); // may hold credentials from an old entry
    mode = statSync(file).mode & 0o777;
  }
  const tmp = `${file}.queryio-${process.pid}.tmp`;
  writeFileSync(tmp, plan.next!, { mode, flag: "wx" });
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (!isDeepStrictEqual(parseConfig(format, readFileSync(file, "utf8")).entry, entry)) {
    throw new Error("the file was written but the QueryIO entry could not be read back");
  }
  return { backup };
}

/** Hide stored connection strings and literal env values when showing an existing entry. */
export function redactEntry(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (/:\/\/[^\s/]*@/.test(value)) return "<hidden connection string>";
    return key === "env-value" && !/^\$\{[^}]+\}$/.test(value) ? "<hidden>" : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactEntry(v));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, k === "env" && isObject(v) ? Object.fromEntries(Object.entries(v).map(([ek, ev]) => [ek, redactEntry(ev, "env-value")])) : redactEntry(v)]));
  }
  return value;
}

function containsCredential(value: unknown): boolean {
  return JSON.stringify(redactEntry(value)) !== JSON.stringify(value);
}

/** Remove the connection string and its password from any text shown to the user. */
function scrub(text: string, ctx: Context): string {
  const url = envGet(ctx, VAR);
  if (!url) return text;
  let out = text.replaceAll(url, "<QUERYIO_DATABASE_URL>");
  try {
    const password = decodeURIComponent(new URL(url).password);
    if (password) out = out.replaceAll(password, "<password>");
  } catch {
    // Not a URL; nothing more to hide.
  }
  return out;
}

function snippet(target: Target): string {
  return target.format === "json"
    ? JSON.stringify({ mcpServers: { queryio: target.entry } }, null, 2)
    : tomlBlock(target.entry).join("\n");
}

function clientCheck(client: ClientId, scope: Scope, ctx: Context): string {
  if (client === "cursor") return "not checked by setup; in Cursor, open Settings > MCP and confirm queryio is listed and enabled";
  const { bin } = CLIENTS[client];
  if (!which(bin, ctx)) return `not checked: \`${bin}\` is not on PATH`;
  // Windows CLIs are often .cmd shims, which need a shell; the command line is a fixed string.
  const opts = { cwd: ctx.cwd, env: ctx.env, encoding: "utf8", timeout: 90_000, windowsHide: true } as const;
  const run = ctx.platform === "win32"
    ? spawnSync(`${bin} mcp get queryio`, { ...opts, shell: true })
    : spawnSync(bin, ["mcp", "get", "queryio"], opts);
  if (run.status === 0) {
    // Only status lines: `mcp get` can print environment values.
    const details = `${run.stdout}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^(Scope|Status):/i.test(l));
    return scrub([`found by \`${bin} mcp get queryio\``, ...details].join("; "), ctx);
  }
  const hint = client === "codex" && scope === "project" ? " (Codex loads .codex/config.toml only for trusted projects)" : "";
  return `\`${bin} mcp get queryio\` did not report it (${run.error ? run.error.message : `exit ${run.status}`})${hint}`;
}

async function withTimeout<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkDatabase(ctx: Context): Promise<{ ok: boolean; lines: string[] }> {
  let core;
  try {
    core = createCore(loadSettings({ ...ctx.env, [VAR]: envGet(ctx, VAR) }));
    const r = await withTimeout(15_000, core.check());
    return {
      ok: true,
      lines: [
        `connected to database "${r.database}" as role "${r.role}" (${r.version.split(",")[0]})`,
        `superuser: ${r.superuser ? "yes" : "no"}; write privileges: ${r.write_privileges ? "yes" : "none"}`,
        ...(r.warnings.length === 0 ? ["role warnings: none detected"] : r.warnings.map((w) => `warning: ${w}`)),
      ].map((l) => scrub(l, ctx)),
    };
  } catch (err) {
    return { ok: false, lines: [`failed: ${scrub((err as Error).message, ctx)}`] };
  } finally {
    await core?.close().catch(() => {});
  }
}

async function startServer(entry: string, ctx: Context): Promise<string> {
  const env = Object.fromEntries(Object.entries(ctx.env).filter((e): e is [string, string] => e[1] !== undefined));
  const client = new Client({ name: "queryio-setup", version: "0" });
  try {
    await withTimeout(20_000, client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, cwd: ctx.cwd, stderr: "ignore" })));
    const { tools } = await withTimeout(20_000, client.listTools());
    return `started; tools: ${tools.map((t) => t.name).join(", ")}`;
  } catch (err) {
    return `failed to start: ${scrub((err as Error).message, ctx)}`;
  } finally {
    await client.close().catch(() => {});
  }
}

function credentialGuidance(platform: NodeJS.Platform): string[] {
  const lines = [
    `${VAR} is not set in this terminal. Setup does not ask for it, store it, or read .env files.`,
    "Set it for the current terminal without saving it in shell history:",
  ];
  if (platform === "win32") {
    lines.push(`  PowerShell 7+:  $env:${VAR} = Read-Host -MaskInput "${VAR}"`);
  }
  lines.push(`  bash/zsh:       read -rs ${VAR} && export ${VAR}`);
  lines.push(`Then run \`npx -y queryio check\`, and start your client from that terminal.`);
  return lines;
}

const LAUNCH: Record<ClientId, string> = {
  claude: "start `claude` from a terminal where QUERYIO_DATABASE_URL is set, approve the queryio project server if prompted, then run /mcp",
  codex: "start `codex` from a terminal where QUERYIO_DATABASE_URL is set, then run /mcp",
  cursor: "start Cursor from a terminal where QUERYIO_DATABASE_URL is set (for example `cursor .`); Cursor opened from the Dock, Start menu, or an existing window may not see the variable. Then enable queryio in Settings > MCP",
};

export async function runSetup(o: SetupOptions): Promise<number> {
  const { io } = o;
  const say = (...lines: string[]) => io.write(lines.join("\n") + "\n");
  const ask = async (question: string): Promise<string> => {
    io.write(question);
    const next = await io.lines.next();
    if (next.done) throw new Cancelled();
    return next.value.trim();
  };
  const yes = async (question: string): Promise<boolean> => /^y(es)?$/i.test(await ask(`${question} [y/N] `));

  try {
    say("QueryIO setup", "", "Adds the QueryIO PostgreSQL MCP server to your coding agent. Nothing is written until you confirm.", "");

    // 1. Clients
    const detected = detectClients(o);
    ORDER.forEach((c, i) => say(`  ${i + 1}) ${CLIENTS[c].name.padEnd(12)} ${detected[c] ? `detected (${detected[c]})` : "not detected"}`));
    const defaults = ORDER.filter((c) => detected[c]);
    if (defaults.length === 0) {
      say("", "No supported client was detected. You can still select one; install it or check that it is on PATH before using QueryIO.");
    }
    let clients: ClientId[] = [];
    while (clients.length === 0) {
      const answer = await ask(`Select clients (comma-separated numbers)${defaults.length ? ` [${defaults.map((c) => ORDER.indexOf(c) + 1).join(",")}]` : ""}: `);
      const picks = answer === "" ? defaults.map((c) => ORDER.indexOf(c) + 1) : answer.split(/[\s,]+/).filter(Boolean).map(Number);
      if (picks.length > 0 && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= ORDER.length)) {
        clients = [...new Set(picks)].sort().map((n) => ORDER[n - 1]);
      } else {
        say(`Enter numbers between 1 and ${ORDER.length}, for example 1,3.`);
      }
    }
    for (const c of clients.filter((c) => !detected[c])) {
      say(`Note: ${CLIENTS[c].name} was not detected. The configuration will be written, but install ${CLIENTS[c].name} before using it.`);
    }

    // 2. Scope
    say("", "Scope:", `  1) Project: this directory only (${o.cwd}) [recommended]`, "  2) Global: every project you open with the selected clients");
    let scope: Scope | undefined;
    while (!scope) {
      const answer = await ask("Choose scope [1]: ");
      scope = answer === "" || answer === "1" ? "project" : answer === "2" ? "global" : undefined;
      if (!scope) say("Enter 1 or 2.");
    }
    if (scope === "global" && !(await yes("Global setup lets QueryIO reach your database from every project these clients open. Continue?"))) {
      throw new Cancelled();
    }

    // 3. Plan and preview
    const plans = clients.map((c) => planTarget(targetFor(c, scope, o)));
    const writes: Plan[] = [];
    say("", "Proposed changes:");
    for (const plan of plans) {
      const { client, file } = plan.target;
      const label = `${CLIENTS[client].name} (${scope}): ${file}`;
      if (plan.status === "error") {
        say("", `✗ ${label}`, `  Left unchanged: ${plan.message}.`, "  To configure it manually, add:", snippet(plan.target).replace(/^/gm, "    "));
        continue;
      }
      if (plan.status === "unchanged") {
        say("", `= ${label}`, "  QueryIO is already configured here; no change needed.");
        continue;
      }
      say("", `${plan.status === "create" ? "+ create" : plan.status === "add" ? "+ add queryio to" : "~ replace queryio in"} ${label}`);
      if (plan.status === "replace") {
        say("  Current entry:", JSON.stringify(redactEntry(plan.existing), null, 2).replace(/^/gm, "    "), "  New entry:");
      }
      say(snippet(plan.target).replace(/^/gm, "    "));
      if (plan.status === "add" || plan.status === "replace") say(`  Other settings in this file are preserved; a backup is saved first to ${path.join(o.home, ".queryio", "backups")}.`);
      if (client === "claude" && scope === "global") say("  Claude Code also writes this file: restart running Claude Code sessions after setup.");
      if (plan.status === "replace") {
        if (containsCredential(plan.existing)) {
          say("  The current entry stores a connection value in this file. Replacing it removes it from the file, but the backup keeps a copy.");
        }
        if (!(await yes(`  Replace the existing queryio entry in ${file}?`))) {
          say("  Skipped; existing entry kept.");
          continue;
        }
      }
      writes.push(plan);
    }

    if (writes.length > 0 && !(await yes(`\nWrite ${writes.length} file${writes.length === 1 ? "" : "s"}?`))) {
      throw new Cancelled();
    }

    // 4. Write
    const results: string[] = [];
    let failed = plans.some((p) => p.status === "error");
    const configured: ClientId[] = plans.filter((p) => p.status === "unchanged").map((p) => p.target.client);
    for (const plan of writes) {
      const { client, file } = plan.target;
      try {
        const { backup } = applyPlan(plan, path.join(o.home, ".queryio", "backups"));
        configured.push(client);
        results.push(`${CLIENTS[client].name}: wrote ${file}${backup ? ` (backup: ${backup})` : ""}`);
        if (backup && containsCredential(plan.existing)) {
          results.push(`  This backup contains the previous stored connection value; delete it once QueryIO works.`);
        }
      } catch (err) {
        failed = true;
        results.push(`${CLIENTS[client].name}: not written: ${(err as Error).message}`);
      }
    }
    for (const plan of plans) {
      if (plan.status === "unchanged") results.push(`${CLIENTS[plan.target.client].name}: already configured in ${plan.target.file}`);
      if (plan.status === "error") results.push(`${CLIENTS[plan.target.client].name}: not configured (${plan.message})`);
      if (plan.status === "replace" && !writes.includes(plan)) results.push(`${CLIENTS[plan.target.client].name}: existing entry kept in ${plan.target.file}`);
    }
    configured.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

    say("", "Configuration", ...results.map((r) => `  ${r}`));

    // 5. Verify
    if (configured.length > 0) {
      say("", "Client discovery");
      for (const c of configured) say(`  ${CLIENTS[c].name}: ${clientCheck(c, scope, o)}`);
    }
    const hasUrl = Boolean(envGet(o, VAR));
    say("", "Database connection");
    let dbOk = false;
    if (hasUrl) {
      const db = await checkDatabase(o);
      dbOk = db.ok;
      say(...db.lines.map((l) => `  ${l}`));
      if (o.serverEntry) say(`  QueryIO MCP server: ${await startServer(o.serverEntry, o)}`);
    } else {
      say(...credentialGuidance(o.platform).map((l) => `  ${l}`));
    }

    // 6. Outcome
    say("");
    if (configured.length === 0) {
      say("No client is configured for QueryIO.");
      return 1;
    }
    if (!hasUrl) {
      say(`Configuration is in place, but setup is not complete: ${VAR} must be set where your client starts.`);
    } else if (!dbOk) {
      say("Configuration is in place, but QueryIO could not connect to PostgreSQL. Fix the connection, then run `npx -y queryio check`.");
    } else {
      say(`Configuration is in place and PostgreSQL is reachable from this terminal. ${VAR} is not stored in any file, so each client must also start with it set.`);
    }
    say("Next:", ...configured.map((c) => `  ${CLIENTS[c].name}: ${LAUNCH[c]}.`));
    if (configured.includes("codex") && scope === "project") say("  Codex reads .codex/config.toml only after you trust this project.");
    return failed || !hasUrl || !dbOk ? 1 : 0;
  } catch (err) {
    if (err instanceof Cancelled) {
      say("", "Setup cancelled. No files were changed.");
      return 130;
    }
    throw err;
  }
}
