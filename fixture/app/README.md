# Acme Projects

Multi-tenant project tracker. Users belong to organizations, verify their email to activate,
work on projects, and organizations pay monthly invoices.

- `db/schema.sql`: PostgreSQL schema.
- `src/activation.ts`: email verification and user activation.
- `src/admin.ts`: support/admin operations (user transfers, offboarding).
- `src/billing.ts`: invoice delinquency and org suspension.
- `src/projects.ts`: project access, API-key authentication, project updates.

This repository is an excerpt: shared helpers (`db`, `events`, `mail`) are not included.

The database is reachable as `postgres://postgres:postgres@localhost:54329/acme`.
