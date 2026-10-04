#!/usr/bin/env node
const path = require('path');

const fs = require('fs');
let projectRoot = path.resolve(__dirname, '../..');
for (const cand of [path.resolve(__dirname, '../..'), path.resolve(__dirname, '../../..'), path.resolve(__dirname, '../../../..')]) {
  if (fs.existsSync(path.join(cand, 'dist/core.js'))) {
    projectRoot = cand;
    break;
  }
}

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
      // Handle powershell-stripped quotes like {table:public.users,key:{id:4821}}
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

  const { pathToFileURL } = await import('url');
  const { createCore } = await import(pathToFileURL(path.join(projectRoot, 'dist/core.js')).href);
  const { loadSettings } = await import(pathToFileURL(path.join(projectRoot, 'dist/settings.js')).href);

  const auditLog = process.env.QUERYIO_AUDIT_LOG || path.resolve(process.cwd(), 'audit.jsonl');
  const databaseUrl = process.env.QUERYIO_DATABASE_URL || 'postgres://postgres:postgres@localhost:54329/acme';

  const settings = loadSettings({
    ...process.env,
    QUERYIO_DATABASE_URL: databaseUrl,
    QUERYIO_AUDIT_LOG: auditLog,
  });

  const core = createCore(settings);

  try {
    let result;
    if (tool === 'inspect_row') {
      const table = args.table || args.tableName;
      const key = args.key || args.primaryKey || {};
      result = await core.inspectRow(table, key);
    } else if (tool === 'describe_tables') {
      const tables = Array.isArray(args.tables) ? args.tables : [args.tables || args.table];
      result = await core.describeTables(tables);
    } else if (tool === 'list_tables') {
      result = await core.listTables();
    } else if (tool === 'query') {
      const sql = args.sql || args.query;
      const params = args.params || [];
      result = await core.query(sql, params);
    } else {
      console.error(`Unknown tool: ${tool}. Available: inspect_row, describe_tables, list_tables, query`);
      process.exit(1);
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`QueryIO Error [${err.category || 'error'}]: ${err.message}\n`);
    process.exit(1);
  } finally {
    await core.close();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
