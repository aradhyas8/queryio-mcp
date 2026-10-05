-- Asserts the ground truth in TASKS.md against the seeded "acme" database.
-- Fails loudly (ASSERT) if the seed drifts from the written answers.

\set ON_ERROR_STOP on

DO $$
DECLARE
  n int;
  ids int[];
BEGIN
  -- Shape ---------------------------------------------------------------------
  SELECT count(*) INTO n FROM pg_tables WHERE schemaname = 'public';
  ASSERT n = 14, format('expected 14 tables, got %s', n);
  SELECT count(*) INTO n FROM pg_stats WHERE schemaname = 'public' AND tablename = 'users' AND attname = 'status';
  ASSERT n = 1, 'planner statistics missing (ANALYZE not run?)';

  -- Task 1 (hero): user 4821 ----------------------------------------------------
  PERFORM 1 FROM users WHERE id = 4821 AND status = 'pending' AND org_id = 88
    AND email_verified_at IS NOT NULL AND activated_at IS NULL;
  ASSERT FOUND, 'hero user state';
  PERFORM 1 FROM memberships WHERE org_id = 88 AND user_id = 4821;
  ASSERT NOT FOUND, 'hero must have no membership in current org 88';
  PERFORM 1 FROM memberships WHERE org_id = 21 AND user_id = 4821 AND accepted_at IS NULL;
  ASSERT FOUND, 'hero membership must remain in old org 21';
  PERFORM 1 FROM organizations WHERE id = 88 AND status = 'active';
  ASSERT FOUND, 'org 88 must be active (membership is the only blocker)';
  SELECT count(*) INTO n FROM email_verification_tokens WHERE user_id = 4821 AND consumed_at IS NOT NULL;
  ASSERT n = 1, 'hero has exactly one consumed token';
  PERFORM 1 FROM user_events WHERE user_id = 4821 AND event_type = 'org.transferred'
    AND payload @> '{"from_org_id": 21, "to_org_id": 88}';
  ASSERT FOUND, 'hero transfer event';
  PERFORM 1 FROM user_events WHERE user_id = 4821 AND event_type = 'user.activated';
  ASSERT NOT FOUND, 'hero must have no activation event';

  -- Task 2: invoice 90017 / org 142 -------------------------------------------------
  PERFORM 1 FROM organizations WHERE id = 142 AND status = 'suspended';
  ASSERT FOUND, 'org 142 suspended';
  PERFORM 1 FROM invoices WHERE id = 90017 AND org_id = 142 AND status = 'paid';
  ASSERT FOUND, 'invoice 90017 paid';
  SELECT array_agg(id ORDER BY id) INTO ids FROM invoices
  WHERE org_id = 142 AND status = 'open' AND due_at < now() - interval '14 days';
  ASSERT ids = ARRAY[90018], format('org 142 delinquent only via 90018, got %s', ids);
  SELECT count(DISTINCT period_start) INTO n FROM invoices WHERE id IN (90017, 90018);
  ASSERT n = 1, '90017 and 90018 bill the same period';

  -- Task 3: project 7713 -----------------------------------------------------------
  PERFORM 1 FROM projects WHERE id = 7713 AND org_id = 113 AND updated_by_user_id = 3310;
  ASSERT FOUND, 'project 7713 last updated by 3310';
  PERFORM 1 FROM memberships WHERE org_id = 113 AND user_id = 3310;
  ASSERT NOT FOUND, '3310 has no membership in org 113';
  PERFORM 1 FROM project_assignments WHERE project_id = 7713 AND user_id = 3310;
  ASSERT NOT FOUND, '3310 not assigned to 7713';
  PERFORM 1 FROM api_keys WHERE id = 9001 AND user_id = 3310 AND org_id = 113 AND revoked_at IS NULL;
  ASSERT FOUND, 'CI key 9001 still active';
  PERFORM 1 FROM api_keys WHERE id = 9000 AND revoked_at IS NOT NULL;
  ASSERT FOUND, 'laptop key 9000 revoked';

  -- Task 4 (aggregate A): verified but never activated, by activateUser refusal reason
  SELECT count(*) INTO n FROM users WHERE status = 'pending' AND email_verified_at IS NOT NULL;
  ASSERT n = 63, format('verified-but-pending total, got %s', n);
  SELECT count(*) INTO n FROM users usr
  WHERE status = 'pending' AND email_verified_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = usr.org_id AND m.user_id = usr.id);
  ASSERT n = 51, format('no_membership, got %s', n);
  SELECT count(*) INTO n FROM users usr JOIN organizations o ON o.id = usr.org_id
  WHERE usr.status = 'pending' AND usr.email_verified_at IS NOT NULL AND o.status <> 'active'
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = usr.org_id AND m.user_id = usr.id);
  ASSERT n = 12, format('org_inactive, got %s', n);
  SELECT count(*) INTO n FROM users usr JOIN organizations o ON o.id = usr.org_id
  WHERE usr.status = 'pending' AND usr.email_verified_at IS NOT NULL AND o.status <> 'active';
  ASSERT n = 12, format('groups must not overlap (org-first order), got %s', n);
  PERFORM 1 FROM invoices WHERE id = 90017 AND paid_at > (SELECT due_at FROM invoices WHERE id = 90018) + interval '14 days';
  ASSERT FOUND, '90017 paid after 90018 left grace (suspension precedes payment)';
  SELECT count(*) INTO n FROM users WHERE status = 'pending';
  ASSERT n = 478, format('all pending (trap answer), got %s', n);

  -- Task 5 (aggregate B): suspended orgs, by plan, and the not-delinquent ones -------
  SELECT array_agg(c ORDER BY plan_id) INTO ids
  FROM (SELECT plan_id, count(*)::int c FROM organizations WHERE status = 'suspended' GROUP BY plan_id) t;
  ASSERT ids = ARRAY[2, 2, 6, 2], format('suspended per plan 1..4, got %s', ids);
  SELECT array_agg(o.id ORDER BY o.id) INTO ids FROM organizations o
  WHERE o.status = 'suspended' AND NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.org_id = o.id AND i.status = 'open' AND i.due_at < now() - interval '14 days');
  ASSERT ids = ARRAY[50, 150, 250], format('not delinquent, got %s', ids);
  SELECT array_agg(o.id ORDER BY o.id) INTO ids FROM organizations o
  WHERE o.status = 'suspended' AND NOT EXISTS (
    SELECT 1 FROM invoices i WHERE i.org_id = o.id AND i.status = 'open' AND i.due_at < now());
  ASSERT ids = ARRAY[50, 250], format('grace-ignoring trap answer, got %s', ids);
END $$;

\echo 'verify: all ground-truth assertions passed'
