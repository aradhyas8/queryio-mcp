# QueryIO positioning and GitHub presentation

[README](../README.md) · [Benchmark evidence](../BENCHMARK.md)

## Product language

**Tagline:** PostgreSQL MCP for debugging with AI coding agents.

**Positioning statement:** For developers debugging PostgreSQL applications with AI coding agents, QueryIO is an MCP server that gathers a record and its immediate declared foreign-key relationships in one call, helping the agent investigate failures across related tables and check its diagnosis against application code.

**Short product description:** QueryIO helps AI coding agents investigate PostgreSQL application data. Start with a user, invoice, or project: `inspect_row` returns that record and its immediate foreign-key relationships in one call. Follow up with schema inspection and targeted, bounded, read-oriented SQL from Claude Code, Codex, or Cursor.

Use **QueryIO** for the product, `queryio` for the npm package, executable, and example MCP server name, and `aradhyas8/queryio-mcp` for the repository. Prefer "related records" in introductions and "depth-1 declared foreign-key neighborhood" when explaining the contract. Use "read-only transactions" for the mechanism and "read-oriented SQL" for the supported workflow. Avoid describing QueryIO as a complete security sandbox or suggesting it reads application code itself.

## Audience, problem, and fit

| Question | Position |
| --- | --- |
| Primary users | Backend and full-stack developers investigating PostgreSQL application bugs with MCP-capable coding agents; engineers handling support escalations involving specific records. |
| Main problem | The code explains what should happen, but the evidence is scattered across database tables. An agent needs to connect a failing record to memberships, events, billing records, or other related state. |
| Strongest verified differentiator | `inspect_row`: one primary-key lookup returns the root record and bounded incoming/outgoing declared foreign-key relationships in one MCP call, with constraint labels and explicit completeness/failure signals. |
| Why choose it | The developer wants an agent to start from a concrete record and gather relationship evidence without manually constructing each lookup. SQL and batched schema inspection support the follow-up investigation. |
| Common situations | Verified user never activates; paid invoice leaves an organization suspended; project changes attributed to a user who has lost access. All three have seeded examples in the repository. |
| Poor fit | Writes, migrations, complete exports, query-plan analysis, non-PostgreSQL engines, an HTTP-hosted MCP service, or automatic traversal of undeclared relationships. Primary keys are required for `inspect_row`. |

The defensible distinction from a general-purpose SQL MCP interface is the investigation primitive. Avoid unsupported claims that competing servers lack safeguards or that QueryIO is universally faster, cheaper, or more accurate. [DBHub](https://github.com/bytebase/dbhub) documents multiple database engines, multiple simultaneous connections, and its own safeguards; QueryIO's narrower fit is PostgreSQL record investigation with `inspect_row`.

## Evidence for public claims

| Claim | Evidence and limit |
| --- | --- |
| Root row and related records in one call | [`src/core.ts`](../src/core.ts), [`src/mcp.ts`](../src/mcp.ts), and [`test/inspect.test.ts`](../test/inspect.test.ts). One MCP call executes several internal SQL statements; it is not one SQL query. |
| Declared relationships in both directions, composite keys, self-references | [`src/catalog.ts`](../src/catalog.ts), [`test/catalog.test.ts`](../test/catalog.test.ts), and row-inspection tests. Only immediate declared foreign keys are followed. |
| Bounded samples with explicit incomplete/error states | Inspection tests cover row/relation caps, per-relation failures, timeouts, and skipped relationships. Samples are ordered by key, not recency. |
| Targeted SQL and batched schema/statistics inspection | [`test/query.test.ts`](../test/query.test.ts), catalog tests, and the four registrations in `src/mcp.ts`. Statistics are planner estimates, not live profiling. |
| Read-only transactions and PostgreSQL timeouts | Query and inspection tests. Permissions, function effects, external connections, and database workload still require review; see [security](security.md). |
| Column-name redaction and metadata audit events | [`test/audit.test.ts`](../test/audit.test.ts), query/catalog/inspection tests, [`src/settings.ts`](../src/settings.ts), and [`src/audit.ts`](../src/audit.ts). Redaction is exact-name matching; logging is best-effort. |
| Installable npm executable | `package.json` maps `queryio` to `dist/cli.js`; [`test/cli.test.ts`](../test/cli.test.ts) exercises a locally packed package. Public npm metadata was checked on 2026-10-09: `queryio@0.1.0`, Node.js >=20, matching repository and executable. |
| Client setup | Claude Code syntax and scopes checked against [official documentation](https://code.claude.com/docs/en/mcp); Codex CLI syntax checked with local `codex mcp add --help` and environment forwarding against [official documentation](https://developers.openai.com/codex/mcp/). Cursor's stdio configuration is documented in its [MCP guide](https://cursor.com/docs/context/mcp). Configuration compatibility is distinct from an end-to-end test in every client. |
| Activation example | [`fixture/TASKS.md`](../fixture/TASKS.md), [`activation.ts`](../fixture/app/src/activation.ts), [`admin.ts`](../fixture/app/src/admin.ts), and the fixture schema/seed. This is synthetic evidence, not adoption or a testimonial. |
| Benchmark findings | [BENCHMARK.md](../BENCHMARK.md): 25 runs, five tasks, manual grading, CLI shims, fewer DBHub repetitions, and win condition not met. Preserve aggregate regressions and failed operations; do not infer general superiority over DBHub or attribute every change to `inspect_row` in isolation. |

## GitHub settings

The public repository's About description and topics were empty before this update. The description and all ten topics below were applied and verified on 2026-10-09.

**Description:**

> PostgreSQL MCP server for debugging with AI coding agents. Inspect a record and its related rows in one call with inspect_row, then follow up with bounded, read-oriented SQL.

**Topics:** `postgresql`, `mcp`, `mcp-server`, `model-context-protocol`, `database-debugging`, `developer-tools`, `claude-code`, `codex`, `cursor`, `read-only`.

These describe the database, protocol, use case, and documented clients. Do not add competitor names or unsupported capabilities as topics. No homepage is needed until there is a separate documentation or product site.

To reproduce these settings with GitHub CLI:

```bash
gh repo edit aradhyas8/queryio-mcp --description "PostgreSQL MCP server for debugging with AI coding agents. Inspect a record and its related rows in one call with inspect_row, then follow up with bounded, read-oriented SQL." --add-topic postgresql --add-topic mcp --add-topic mcp-server --add-topic model-context-protocol --add-topic database-debugging --add-topic developer-tools --add-topic claude-code --add-topic codex --add-topic cursor --add-topic read-only
```

Or open the repository, select the gear beside **About**, and paste the description and topics. The CLI command adds topics without removing existing ones. Verify afterward:

```bash
gh repo view aradhyas8/queryio-mcp --json description,repositoryTopics
```

### Optional social preview

A preview is useful when sharing the repository link. Keep it simple: **QueryIO**, the tagline, and **"One record. Its related rows. One MCP call."** Show `public.users · id 4821` connected to `organizations`, `memberships`, and `user_events`, with arrows labeled by foreign-key direction. Avoid a fake UI, customer logos, or performance percentages.

Use a 1280 × 640 PNG under 1 MB, with readable text and generous margins, following [GitHub's social preview guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview). Upload through **Settings → General → Social preview → Edit → Upload an image**. This is a recommendation; no asset or upload is required for the README improvement.

## Before and after

The previous introduction led with bounds and safety, called competing interfaces unsafe without comparative evidence, and buried the record-investigation workflow inside a long technical reference. The rewritten README leads with the failing-record workflow and a traceable activation example, places installation near the top, and links to focused references. It makes the benchmark's missed win condition visible and qualifies the safeguards.

The new quick start also corrects Claude Code's scope explanation and forwards credentials from the environment. The audit reference uses the actual `ts` field, describes the shortened SQL hash, and notes that logging can fail without stopping a call.

Remaining release work is separate: package metadata edits, npm publishing, directory submissions, and a website. Documentation assertions cover the README and linked reference files. Application behavior, MCP tool contracts, and package metadata are unchanged.

## Validation for this revision

- Type checking and the TypeScript build passed.
- The public `npx -y queryio check` command connected successfully to the disposable PostgreSQL test database.
- The sample activation investigation was exercised through the actual MCP server against the seeded fixture, including its ground-truth assertions. The default inspection returned the membership in organization 21 and the transfer event; the README's follow-up SQL returned zero matching memberships in organization 88.
- The complete test suite passed: **134 tests, zero failures, zero skipped**. The seven legacy README failures were traced to obsolete headings or expectations that all reference material remain inline. The assertions now check the appropriate documents while preserving tool contracts, configuration defaults, security caveats, and benchmark limitations. Additional checks cover local links/anchors, parseable JSON examples, client configuration, and the scope of `inspect_row`.
- Local documentation links and anchors, JSON/TOML snippets, and coverage of every existing environment setting were checked. Client configuration syntax was checked against official documentation; interactive sessions in Claude Code and Cursor were not run.
- The original benchmark report and raw results were preserved. No benchmark agents were launched or package published. The GitHub About description and all ten topics were applied and verified.
