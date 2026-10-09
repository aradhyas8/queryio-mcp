#!/usr/bin/env node
// Engineering control arm: one MCP tool that pipes SQL to psql in the benchmark container and returns
// psql's text output. It mirrors the old benchmark's raw-psql arm without giving the agent a shell.
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CONTAINER } from "./lib.mjs";

const server = new McpServer({ name: "psql", version: "1.0.0" });
server.registerTool(
  "psql",
  { description: "Run SQL (or psql meta-commands) with psql and return its output.", inputSchema: { input: z.string() } },
  ({ input }) => {
    const res = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-X", process.env.PSQL_DSN], {
      input, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
    });
    const text = `${res.stdout ?? ""}${res.stderr ?? ""}` || String(res.error ?? "");
    return { isError: res.status !== 0 || /^(ERROR|psql: error):/m.test(res.stderr ?? ""), content: [{ type: "text", text }] };
  },
);
await server.connect(new StdioServerTransport());
