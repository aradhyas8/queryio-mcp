#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');

const sql = process.argv.slice(2).join(' ').trim();
if (!sql) {
  console.error('Usage: node db-query.cjs "<SQL>"');
  process.exit(1);
}

try {
  // Use psql in docker compose container
  const out = execSync('docker compose exec -T postgres psql -U postgres -d acme', {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
  });
  process.stdout.write(out);
} catch (err) {
  const errOutput = err.stderr || err.stdout || err.message;
  process.stderr.write(errOutput);
  process.exit(1);
}
