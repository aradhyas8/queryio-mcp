#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCore } from "./core.js";
import { createServer } from "./mcp.js";
import { loadSettings, type Settings } from "./settings.js";

// No arguments are accepted yet (`check` and limit flags come later): the connection comes only from
// QUERYIO_DATABASE_URL, never argv, so a DSN never lands in process listings.
if (process.argv.length > 2) {
  console.error("Usage: queryio   (set QUERYIO_DATABASE_URL; command-line arguments are not accepted)");
  process.exit(2);
}

let settings: Settings;
try {
  settings = loadSettings(process.env);
} catch (err) {
  console.error(`queryio: ${(err as Error).message}`);
  process.exit(1);
}

const core = createCore(settings);
const server = createServer(core);
server.server.onclose = () => void core.close();
// The stdio transport doesn't notice the client going away; without this, idle pool connections keep the process alive.
process.stdin.on("end", () => void server.close());
await server.connect(new StdioServerTransport());
