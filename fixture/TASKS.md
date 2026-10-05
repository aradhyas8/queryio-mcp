# Benchmark tasks and ground truth

The agent sees only `fixture/app/` (copy it to a fresh directory for each run). This file,
`seed.sql`, and `verify.sql` are the answer key; never expose them to the agent.

Reset before every run: `bash fixture/reset.sh` (needs Docker). It recreates database `acme` on
`localhost:54329`, seeds it, runs `ANALYZE`, and asserts every answer below (`verify.sql`).
All timestamps are relative to seed time, and the answers hold only shortly after a reset.
Org 150's invoice leaves the grace period about 4 days after seeding, and every current invoice
becomes overdue after about 16 days. Reset immediately before every run.

Hand-check any answer with plain psql:
`docker compose exec postgres psql -U postgres -d acme`

| # | Kind | Prompt |
|---|---|---|
| 1 | forensic (hero) | User 4821 says their account never activated. Find out why. |
| 2 | forensic | Organization 142 paid invoice 90017, but their workspace is still suspended for non-payment. Why? |
| 3 | forensic | Project 7713 shows user 3310 as "last edited by", but that user says they never touched it and can't even open the project. What happened? |
| 4 | aggregate | How many users verified their email but were never activated? Break them down by the reason `activateUser` refuses them. |
| 5 | aggregate | How many organizations are suspended, broken down by plan? Which suspended organizations are not actually delinquent under the rules in `billing.ts`? |

---

## 1. Hero: user 4821 never activated

**Ground truth.** User 4821 (Dana Whitfield) verified their email but is stuck in `pending`
because `activateUser` requires a membership in the user's *current* org (`users.org_id = 88`),
and no `memberships (88, 4821)` row exists. Their only membership is in org 21, where they
originally signed up. Support moved them with `transferUser` (`org.transferred` event, 21 → 88),
and `transferUser` updates `users.org_id` without moving or creating the membership.
`activateUser` returns `no_membership` silently on verify and on every login, so no event records it.

Facts:
- `users` 4821: `status = 'pending'`, `org_id = 88`, `email_verified_at` set, `activated_at` NULL.
- `memberships`: only `(21, 4821)`, `accepted_at` NULL. Nothing for org 88.
- Org 88 is `active`, so membership is the only blocker.
- Tokens: the first (created ~72 h before seed) expired unconsumed; the second was consumed
  ~29 h before seed. `email.verified` event exists. No `user.activated` event.
- Events: `user.signed_up` (org 21), `verification.sent`, `org.transferred` {21 → 88},
  `verification.failed` {expired}, `verification.sent`, `email.verified`, two `session.started`.

**Grading.**
- Correct: names the missing membership in org 88 (or "membership still in org 21 after the transfer")
  as the reason, tied to `activateUser`'s membership check. Full marks also note `transferUser` as the root cause.
- Wrong: "the verification token expired". The first token expired, but the second was consumed
  and the email *is* verified. This is the planted distractor.
- Wrong: org suspended or inactive (org 88 is active).

```sql
SELECT id, org_id, status, email_verified_at, activated_at FROM users WHERE id = 4821;
SELECT * FROM memberships WHERE user_id = 4821;
SELECT id, expires_at, consumed_at FROM email_verification_tokens WHERE user_id = 4821;
SELECT event_type, payload, created_at FROM user_events WHERE user_id = 4821 ORDER BY created_at;
```

## 2. Org 142 still suspended after paying invoice 90017

**Ground truth.** Last month's invoice for org 142 was issued twice: 90017 and 90018 bill the same
`period_start` for the same amount, one minute apart. Neither was paid within the 14-day grace
period, so `enforceDelinquency` suspended the org. The customer later paid 90017 (~5 days before
seed). Invoice 90018 is still `open` and more than 14 days past due. `isDelinquent` counts *any*
open invoice past the grace period, so `onInvoicePaid(90017)` re-checked, found 90018, and left the
org suspended. Fix: void 90018 (the duplicate) and reactivate the org and subscription by hand.
Nothing in `billing.ts` reactivates the org on its own: `enforceDelinquency` only looks at active
orgs, and only `onInvoicePaid` reactivates.

Facts:
- `organizations` 142: `status = 'suspended'`; subscription 142 `past_due`.
- 90017: `paid` ~5 days before seed, `external_ref = 'ch_3QxR8sLkd2Z0aB17'`.
  90018: `open`, `due_at` ~23 days before seed.
- The org's current invoice (10987) is open but not yet due; it is not the cause.

**Grading.**
- Correct: identifies duplicate invoice 90018 as open and overdue past grace, causing delinquency.
- Partial: says "another open invoice" without noting that 90018 duplicates 90017's period.
- Wrong: blames 10987 (not due), or says the payment webhook failed.

```sql
SELECT id, status, period_start, amount_cents, due_at, paid_at FROM invoices
WHERE org_id = 142 ORDER BY period_start DESC, id;
```

## 3. Project 7713 "last edited by" user 3310

**Ground truth.** User 3310 was a contractor in org 113, the project's org. They were offboarded
~21 days before seed (`membership.removed` event {org_id 113}). Offboarding deleted the membership,
and with it their `project_assignments` (`ON DELETE CASCADE`), so they can't open the project.
Offboarding revoked their `laptop` API key (9000) but missed the `ci-sync` key (9001,
org 113, `revoked_at` NULL). That key is still in use (`last_used_at` ~2 h before seed).
`projects.ts` authenticates API keys as their creator and checks only `key.org_id = project.org_id`,
never current membership, so every CI update stamps `updated_by_user_id = 3310`.
Events show `project.updated` via `api_key_id 9001` on 7713 (twice) and 7413 after the removal.
Fix: revoke key 9001. Better: make API-key auth check membership.

Facts:
- `projects` 7713: `org_id = 113`, `updated_by_user_id = 3310`, `created_by_user_id = 113`.
- `memberships` for 3310: only `(10, 3310)`. No row for org 113.
- `project_assignments` for 7713: users 113 and 413 only.
- `api_keys` 9000 (`laptop`, revoked) and 9001 (`ci-sync`, active), both user 3310, org 113.

**Grading.**
- Correct: active API key 9001 owned by 3310 is still updating the project after 3310's removal
  from org 113, because API-key auth doesn't check membership.
- Partial: says "an API key" without identifying that it survived offboarding, or misses the
  "can't open" half (no membership, so no assignment).
- Wrong: claims 3310 edited it through the UI or session, or that the data is corrupt.

```sql
SELECT id, org_id, created_by_user_id, updated_by_user_id, updated_at FROM projects WHERE id = 7713;
SELECT * FROM memberships WHERE user_id = 3310;
SELECT * FROM project_assignments WHERE project_id = 7713;
SELECT id, org_id, name, last_used_at, revoked_at FROM api_keys WHERE user_id = 3310;
SELECT event_type, project_id, payload, created_at FROM user_events WHERE user_id = 3310 ORDER BY created_at;
```

## 4. Verified but never activated, by refusal reason

**Ground truth.** 63 users (`status = 'pending' AND email_verified_at IS NOT NULL`).
`activateUser` checks the membership first, then the org status:
- `no_membership` (no membership in `users.org_id`): **51**. All were transferred; includes user 4821.
- `org_inactive` (membership OK, org not active): **12**. Recent signups in suspended orgs.

**Grading.**
- Correct: 63 total, split 51 / 12, attributed to the two checks in `activateUser`.
- Trap: "478 pending users" counts the 415 users who never verified at all.
- Partial: correct total with no breakdown. The two groups don't overlap: every transferred user
  was moved to an active org, so either check order gives 51 / 12.

```sql
SELECT CASE WHEN m.user_id IS NULL THEN 'no_membership'
            WHEN o.status <> 'active' THEN 'org_inactive' ELSE 'other' END AS reason,
       count(*)
FROM users u
JOIN organizations o ON o.id = u.org_id
LEFT JOIN memberships m ON m.org_id = u.org_id AND m.user_id = u.id
WHERE u.status = 'pending' AND u.email_verified_at IS NOT NULL
GROUP BY 1;
```

## 5. Suspended orgs by plan, and the wrongly suspended ones

**Ground truth.** 12 suspended orgs: free 2, starter 2, team 6, enterprise 2.
Under `isDelinquent` (an open invoice with `due_at < now() - 14 days`), 3 are **not**
delinquent: **50, 150, 250**. The other 9 (37, 74, 111, 142, 148, 185, 222, 259, 296) are delinquent.

**Grading.**
- Correct: per-plan counts and the set {50, 150, 250}.
- Trap: ignoring the 14-day grace period gives {50, 250}. Org 150's current invoice is 10 days
  past due, which is still inside grace.
- Trap: treating any open invoice as delinquent gives an empty set (every org has a current open invoice).

```sql
SELECT p.code, count(*) FROM organizations o JOIN plans p ON p.id = o.plan_id
WHERE o.status = 'suspended' GROUP BY p.code ORDER BY p.code;

SELECT o.id FROM organizations o
WHERE o.status = 'suspended' AND NOT EXISTS (
  SELECT 1 FROM invoices i WHERE i.org_id = o.id AND i.status = 'open'
    AND i.due_at < now() - interval '14 days')
ORDER BY o.id;
```

---

## Fixture shape (for reference)

14 tables. Noise: `feature_flags`, `email_templates`, `webhook_deliveries`.
- Composite FK: `project_assignments (org_id, user_id)` → `memberships`.
- Self-reference: `users.invited_by_user_id` → `users`.
- Two FKs to the same parent: `projects.created_by_user_id` and `projects.updated_by_user_id` → `users`.
- Redaction targets: `users.password_hash`, `email_verification_tokens.token`, `api_keys.api_key`.
- Wide columns: `users.profile` / `users.bio`, `projects.description`, `invoices.line_items`,
  `organizations.settings`, `email_templates.body_html`, `webhook_deliveries.request_body` / `response_body`.
