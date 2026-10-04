#!/usr/bin/env node
const path = require('path');

async function main() {
  const tool = process.argv[2];
  function parseInput() {
    let raw = process.argv.slice(3).join(' ').trim();
    if (!raw || raw === '-') {
      try {
        raw = require('fs').readFileSync(0, 'utf8').trim();
      } catch {}
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      try {
        const quoted = raw.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
                          .replace(/:\s*([a-zA-Z0-9_\.\-]+)(?=[,}])/g, ':"$1"');
        return JSON.parse(quoted);
      } catch {
        throw new Error(`Invalid JSON input: ${raw}`);
      }
    }
  }

  let args = {};
  try {
    args = parseInput();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const dsn = process.env.DSN || 'postgres://postgres:postgres@localhost:54329/acme';

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@bytebase/dbhub@1.4.0', `--dsn=${dsn}`],
    stderr: 'pipe',
  });

  const client = new Client({ name: 'dbhub-cli-client', version: '1.0' });

  try {
    await client.connect(transport);

    let result;
    if (tool === 'execute_sql') {
      const sql = args.sql || args.query;
      result = await client.callTool({ name: 'execute_sql', arguments: { sql } });
    } else if (tool === 'search_objects') {
      const objectType = args.object_type || args.type || 'table';
      const pattern = args.pattern || args.search_text || args.text || '%';
      const searchArgs = {
        object_type: objectType,
        pattern,
        detail_level: args.detail_level || 'summary',
        ...(args.schema ? { schema: args.schema } : {}),
        ...(args.table ? { table: args.table } : {}),
      };
      result = await client.callTool({ name: 'search_objects', arguments: searchArgs });
    } else {
      console.error(`Unknown tool: ${tool}. Available: execute_sql, search_objects`);
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`DBHub Error: ${err.message}\n`);
    process.exit(1);
  } finally {
    try {
      await client.close();
    } catch {}
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
