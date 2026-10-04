#!/usr/bin/env bash
# Reset the benchmark fixture database "acme" to its seeded state and check the ground truth.
# Usage: bash fixture/reset.sh
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres >/dev/null
psql() { docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql -d postgres -c "DROP DATABASE IF EXISTS acme WITH (FORCE)" -c "CREATE DATABASE acme"
cat fixture/app/db/schema.sql fixture/seed.sql | psql -d acme
psql -d acme < fixture/verify.sql
echo "acme reset: postgres://postgres:postgres@localhost:54329/acme"
