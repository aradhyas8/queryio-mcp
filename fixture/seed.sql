-- Benchmark fixture seed. Run against an empty database after app/db/schema.sql.
-- Deterministic: no random(); every timestamp is relative to now() at seed time.
-- Planted scenarios are documented in TASKS.md. Do NOT ship this file to the agent.

\set ON_ERROR_STOP on
BEGIN;

-- Suspended organizations:
--   multiples of 37 -> genuinely delinquent (open invoice > 14 days past due)
--   142             -> delinquent only because of a duplicate open invoice (task 2)
--   50, 150, 250    -> suspended although not delinquent per billing.ts (aggregate task B)
CREATE TEMP TABLE suspended_orgs AS
  SELECT id FROM generate_series(1, 300) id WHERE id % 37 = 0 OR id IN (142, 50, 150, 250);

-- User classes (precedence in CASE order):
--   founder          id <= 300, owner of org <id>, active
--   transferred      moved to another org before verifying; membership left in old org (hero class)
--   stuck_suspended  recent signup in a suspended org; verified but org not active
--   abandoned        never verified
--   disabled         activated then disabled
--   active           everyone else
CREATE TEMP TABLE u AS
SELECT id,
       ((id - 1) % 300) + 1 AS home_org,
       CASE
         WHEN id = 4821 THEN 'transferred'
         WHEN id <= 300 THEN 'founder'
         WHEN id > 5700 THEN CASE WHEN ((id - 1) % 300) + 1 IN (SELECT id FROM suspended_orgs)
                                  THEN 'stuck_suspended' ELSE 'active' END
         WHEN id % 13 = 0 THEN 'abandoned'
         WHEN id % 50 = 0 THEN 'disabled'
         WHEN id % 97 = 0 THEN 'transferred'
         ELSE 'active'
       END AS class,
       CASE
         WHEN id = 4821 THEN now() - interval '3 days'
         WHEN id > 5700 THEN now() - (6001 - id) * interval '1 hour'
         ELSE now() - interval '400 days' + id * interval '1 hour'
       END AS created_at
FROM generate_series(1, 6000) id;
ALTER TABLE u ADD COLUMN org_id integer;
UPDATE u SET org_id = CASE WHEN id = 4821 THEN 88
                           -- next org, skipping suspended ones so "no membership" is the only blocker
                           WHEN class = 'transferred' THEN
                             CASE WHEN (home_org % 300) + 1 IN (SELECT id FROM suspended_orgs)
                                  THEN ((home_org + 1) % 300) + 1 ELSE (home_org % 300) + 1 END
                           ELSE home_org END;

-- Plans ---------------------------------------------------------------------
INSERT INTO plans (id, code, name, price_cents, features) VALUES
  (1, 'free',       'Free',       0,     '{"max_seats": 3,    "projects": 5,    "sso": false, "audit_log_days": 0}'),
  (2, 'starter',    'Starter',    1900,  '{"max_seats": 10,   "projects": 50,   "sso": false, "audit_log_days": 7}'),
  (3, 'team',       'Team',       4900,  '{"max_seats": 50,   "projects": null, "sso": false, "audit_log_days": 30}'),
  (4, 'enterprise', 'Enterprise', 19900, '{"max_seats": null, "projects": null, "sso": true,  "audit_log_days": 365}');

-- Organizations -------------------------------------------------------------
INSERT INTO organizations (id, name, slug, plan_id, status, settings, created_at)
SELECT id,
       'Workspace ' || id,
       'ws-' || id,
       1 + (id % 4),
       CASE WHEN id IN (SELECT id FROM suspended_orgs) THEN 'suspended' ELSE 'active' END,
       jsonb_build_object(
         'branding', jsonb_build_object('primary_color', '#' || substr(md5('c' || id), 1, 6),
                                        'logo_url', 'https://cdn.example.com/logos/' || md5('l' || id) || '.png'),
         'default_project_template', repeat('Kickoff checklist item for workspace ' || id || '. ', 12),
         'locale', (ARRAY['en-US', 'en-GB', 'de-DE', 'fr-FR'])[1 + id % 4]),
       now() - interval '500 days' + id * interval '1 hour'
FROM generate_series(1, 300) id;

-- Users ---------------------------------------------------------------------
INSERT INTO users (id, org_id, invited_by_user_id, email, password_hash, display_name, status,
                   email_verified_at, activated_at, bio, profile, created_at)
SELECT u.id,
       u.org_id,
       CASE WHEN u.class = 'founder' THEN NULL ELSE u.home_org END,
       CASE WHEN u.id = 4821 THEN 'dana.whitfield@example.com' ELSE 'user' || u.id || '@example.com' END,
       '$argon2id$v=19$m=65536,t=3,p=4$' || md5('salt' || u.id) || '$' || md5('hash' || u.id) || md5('h2' || u.id),
       CASE WHEN u.id = 4821 THEN 'Dana Whitfield' ELSE 'User ' || u.id END,
       CASE u.class WHEN 'founder' THEN 'active' WHEN 'active' THEN 'active'
                    WHEN 'disabled' THEN 'disabled' ELSE 'pending' END,
       CASE WHEN u.id = 4821 THEN now() - interval '29 hours'
            WHEN u.class = 'abandoned' THEN NULL
            ELSE u.created_at + interval '2 hours' END,
       CASE WHEN u.class IN ('founder', 'active', 'disabled') THEN u.created_at + interval '2 hours' END,
       CASE WHEN u.id % 4 = 0 THEN repeat('Engineer who enjoys long walks through legacy code and short standups. ', 9) END,
       jsonb_build_object(
         'timezone', (ARRAY['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo'])[1 + u.id % 4],
         'theme', CASE WHEN u.id % 3 = 0 THEN 'dark' ELSE 'light' END,
         'dashboard_layout', repeat('{"widget":"chart","w":4,"h":3}', 30),
         'recent_searches', (SELECT jsonb_agg('search term ' || s || ' for user ' || u.id) FROM generate_series(1, 15) s),
         'onboarding', jsonb_build_object('completed', u.class IN ('founder', 'active', 'disabled'), 'step', 1 + u.id % 5)),
       u.created_at
FROM u;

-- Memberships: one per user in their home org (the org they were invited to).
INSERT INTO memberships (org_id, user_id, role, invited_at, accepted_at)
SELECT u.home_org, u.id,
       CASE WHEN u.class = 'founder' THEN 'owner' WHEN u.id <= 600 THEN 'admin' ELSE 'member' END,
       u.created_at,
       CASE WHEN u.class IN ('founder', 'active', 'disabled') THEN u.created_at + interval '2 hours' END
FROM u;

-- Email verification tokens: one per user (the hero is planted below).
INSERT INTO email_verification_tokens (user_id, token, sent_to, created_at, expires_at, consumed_at)
SELECT u.id, 'evt_' || md5('tok' || u.id), 'user' || u.id || '@example.com',
       u.created_at, u.created_at + interval '24 hours',
       CASE WHEN u.class <> 'abandoned' THEN u.created_at + interval '2 hours' END
FROM u WHERE u.id <> 4821
ORDER BY u.id;

-- Events --------------------------------------------------------------------
INSERT INTO user_events (user_id, event_type, payload, created_at)
SELECT id, e.event_type, e.payload, e.created_at
FROM u
CROSS JOIN LATERAL (VALUES
  ('user.signed_up',    jsonb_build_object('org_id', u.home_org, 'source', 'invite'), u.created_at, true),
  ('verification.sent', '{}'::jsonb, u.created_at, true),
  ('org.transferred',   jsonb_build_object('from_org_id', u.home_org, 'to_org_id', u.org_id, 'by_user_id', u.org_id),
                        u.created_at + interval '1 hour', u.class = 'transferred'),
  ('email.verified',    '{}'::jsonb, u.created_at + interval '2 hours', u.class <> 'abandoned'),
  ('user.activated',    jsonb_build_object('org_id', u.home_org), u.created_at + interval '2 hours',
                        u.class IN ('founder', 'active', 'disabled')),
  ('user.disabled',     jsonb_build_object('reason', 'admin'), u.created_at + interval '30 days', u.class = 'disabled')
) AS e(event_type, payload, created_at, applies)
WHERE e.applies AND u.id <> 4821
ORDER BY u.id, e.created_at;

-- Session noise for a third of active users.
INSERT INTO user_events (user_id, event_type, payload, created_at)
SELECT u.id, 'session.started',
       jsonb_build_object('ip', '10.' || (u.id % 256) || '.' || s || '.7',
                          'user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15 AcmeDesktop/' || s),
       u.created_at + s * interval '3 days'
FROM u, generate_series(1, 3) s
WHERE u.class IN ('founder', 'active') AND u.id % 3 = 0
ORDER BY u.id, s;

-- Subscriptions and invoices --------------------------------------------------
INSERT INTO subscriptions (id, org_id, plan_id, status, current_period_end, created_at)
SELECT o.id, o.id, o.plan_id,
       CASE WHEN o.status = 'suspended' THEN 'past_due' ELSE 'active' END,
       now() + interval '25 days', o.created_at
FROM organizations o ORDER BY o.id;
ALTER SEQUENCE subscriptions_id_seq RESTART WITH 301;

-- Seven invoices per org: k = 0 is the current invoice (open, not yet due); k = 1..6 are past months.
INSERT INTO invoices (id, subscription_id, org_id, period_start, amount_cents, status,
                      issued_at, due_at, paid_at, external_ref, line_items)
SELECT 10000 + (o.id - 1) * 7 + k, o.id, o.id,
       (now() - k * interval '30 days')::date,
       p.price_cents,
       CASE WHEN k = 0 THEN 'open'
            WHEN k = 1 AND o.id % 37 = 0 THEN 'open'
            ELSE 'paid' END,
       now() - k * interval '30 days' - interval '5 days' * (k = 0)::int,
       now() - k * interval '30 days' - interval '5 days' * (k = 0)::int + interval '7 days',
       CASE WHEN k = 0 OR (k = 1 AND o.id % 37 = 0) THEN NULL
            ELSE now() - k * interval '30 days' + interval '3 days' END,
       CASE WHEN k = 0 OR (k = 1 AND o.id % 37 = 0) THEN NULL
            ELSE 'ch_' || md5('inv' || o.id || '-' || k) END,
       jsonb_build_array(
         jsonb_build_object('description', p.name || ' plan, monthly', 'quantity', 1, 'unit_amount_cents', p.price_cents),
         jsonb_build_object('description', 'Usage notes: ' || repeat('seats, storage, and API calls within plan limits; ', 6),
                            'quantity', 1, 'unit_amount_cents', 0))
FROM organizations o
JOIN plans p ON p.id = o.plan_id
CROSS JOIN generate_series(0, 6) k
WHERE NOT (o.id = 142 AND k = 1);

-- Org 150: current invoice is past due but still inside the 14-day grace period.
UPDATE invoices SET issued_at = now() - interval '17 days', due_at = now() - interval '10 days'
WHERE id = 10000 + (150 - 1) * 7 + 0;

-- Task 2: last month's invoice for org 142 was issued twice and neither was paid, so the nightly job
-- suspended the org. The customer then paid 90017 (5 days ago); 90018 stays open and keeps it delinquent.
INSERT INTO invoices (id, subscription_id, org_id, period_start, amount_cents, status,
                      issued_at, due_at, paid_at, external_ref, line_items)
SELECT v.id, 142, 142, (now() - interval '30 days')::date, p.price_cents, v.status,
       now() - interval '30 days' + v.offs, now() - interval '23 days' + v.offs,
       v.paid_at, v.ext,
       jsonb_build_array(jsonb_build_object('description', p.name || ' plan, monthly', 'quantity', 1,
                                            'unit_amount_cents', p.price_cents))
FROM (VALUES
  (90017, 'paid', interval '0',         now() - interval '5 days',  'ch_3QxR8sLkd2Z0aB17'),
  (90018, 'open', interval '1 minute',  NULL::timestamptz,          NULL)
) AS v(id, status, offs, paid_at, ext)
JOIN plans p ON p.id = (SELECT plan_id FROM organizations WHERE id = 142);

-- Projects ------------------------------------------------------------------
INSERT INTO projects (id, org_id, name, description, created_by_user_id, updated_by_user_id, created_at, updated_at)
SELECT p.id, p.org_id,
       'Project ' || p.id,
       'Roadmap and working notes for project ' || p.id || '. ' || repeat('Milestones, risks, owners, and open questions are tracked here. ', 30),
       p.org_id,
       CASE WHEN p.id % 2 = 1 AND (SELECT class FROM u WHERE u.id = p.org_id + 300) = 'active'
            THEN p.org_id + 300 ELSE p.org_id END,
       now() - interval '100 days' + (p.id - 7000) * interval '1 hour',
       now() - (p.id % 60) * interval '1 day' - interval '6 hours'
FROM (SELECT id, 1 + ((id - 7001) % 300) AS org_id FROM generate_series(7001, 8500) id) p;

INSERT INTO project_assignments (project_id, user_id, org_id, assigned_at)
SELECT id, created_by_user_id, org_id, created_at FROM projects
UNION
SELECT id, updated_by_user_id, org_id, created_at FROM projects;

-- One session-based update event per project.
INSERT INTO user_events (user_id, project_id, event_type, payload, created_at)
SELECT updated_by_user_id, id, 'project.updated', jsonb_build_object('project_id', id, 'via', 'session'), updated_at
FROM projects ORDER BY id;

-- API keys ------------------------------------------------------------------
INSERT INTO api_keys (id, user_id, org_id, name, api_key, created_at, last_used_at, revoked_at)
SELECT row_number() OVER (ORDER BY u.id), u.id, u.home_org,
       (ARRAY['cli', 'zapier', 'local-dev'])[1 + u.id % 3],
       'ak_live_' || md5('key' || u.id),
       u.created_at + interval '5 days',
       now() - (u.id % 40) * interval '1 day',
       CASE WHEN u.id % 30 = 1 THEN now() - interval '60 days' END
FROM u
WHERE u.class IN ('founder', 'active') AND u.id % 10 = 1;

-- Task 3: user 3310 (home org 10) was a contractor in org 113 and was offboarded 21 days ago.
-- Offboarding revoked their laptop key but missed the CI key, which still updates projects.
INSERT INTO api_keys (id, user_id, org_id, name, api_key, created_at, last_used_at, revoked_at) VALUES
  (9000, 3310, 113, 'laptop',  'ak_live_' || md5('contractor-laptop'), now() - interval '120 days', now() - interval '22 days', now() - interval '21 days'),
  (9001, 3310, 113, 'ci-sync', 'ak_live_' || md5('contractor-ci'),     now() - interval '118 days', now() - interval '2 hours', NULL);
ALTER SEQUENCE api_keys_id_seq RESTART WITH 9002;

UPDATE projects SET updated_by_user_id = 3310, updated_at = now() - interval '2 hours' WHERE id = 7713;
UPDATE projects SET updated_by_user_id = 3310, updated_at = now() - interval '5 days'  WHERE id = 7413;

INSERT INTO user_events (user_id, project_id, event_type, payload, created_at) VALUES
  (3310, 7713, 'project.updated',    '{"project_id": 7713, "via": "session"}',                     now() - interval '40 days'),
  (3310, NULL, 'membership.removed', '{"org_id": 113, "removed_by_user_id": 113}',                 now() - interval '21 days'),
  (3310, 7713, 'project.updated',    '{"project_id": 7713, "via": "api_key", "api_key_id": 9001}', now() - interval '9 days'),
  (3310, 7413, 'project.updated',    '{"project_id": 7413, "via": "api_key", "api_key_id": 9001}', now() - interval '5 days'),
  (3310, 7713, 'project.updated',    '{"project_id": 7713, "via": "api_key", "api_key_id": 9001}', now() - interval '2 hours');

-- Hero: user 4821 ---------------------------------------------------------------
-- Signed up in org 21, first email expired, support moved them to org 88 (membership stayed in 21),
-- clicked the stale link, got a new one, verified. activateUser finds no membership in org 88.
INSERT INTO email_verification_tokens (user_id, token, sent_to, created_at, expires_at, consumed_at) VALUES
  (4821, 'evt_' || md5('hero-first'),  'dana.whitfield@example.com', now() - interval '72 hours', now() - interval '48 hours', NULL),
  (4821, 'evt_' || md5('hero-second'), 'dana.whitfield@example.com', now() - interval '30 hours', now() - interval '6 hours',  now() - interval '29 hours');

INSERT INTO user_events (user_id, event_type, payload, created_at)
SELECT 4821, e.event_type,
       CASE WHEN e.tok IS NULL THEN e.payload
            ELSE e.payload || jsonb_build_object('token_id', (SELECT id FROM email_verification_tokens WHERE token = 'evt_' || md5(e.tok)))
       END,
       e.created_at
FROM (VALUES
  ('user.signed_up',      '{"org_id": 21, "source": "invite"}'::jsonb,                     NULL,          now() - interval '72 hours'),
  ('verification.sent',   '{}',                                                            'hero-first',  now() - interval '72 hours'),
  ('org.transferred',     '{"from_org_id": 21, "to_org_id": 88, "by_user_id": 88}',        NULL,          now() - interval '50 hours'),
  ('verification.failed', '{"reason": "expired"}',                                         'hero-first',  now() - interval '30 hours' - interval '2 minutes'),
  ('verification.sent',   '{}',                                                            'hero-second', now() - interval '30 hours'),
  ('email.verified',      '{}',                                                            'hero-second', now() - interval '29 hours')
) AS e(event_type, payload, tok, created_at);

INSERT INTO user_events (user_id, event_type, payload, created_at) VALUES
  (4821, 'session.started',     '{"ip": "10.21.4.7", "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}', now() - interval '20 hours'),
  (4821, 'session.started',     '{"ip": "10.21.4.7", "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}', now() - interval '2 hours');

-- Noise tables ----------------------------------------------------------------
INSERT INTO feature_flags (key, enabled, rules, updated_at)
SELECT 'flag_' || g, g % 3 = 0,
       jsonb_build_object('rollout_percent', (g * 7) % 100,
                          'allow_orgs', (SELECT jsonb_agg(o) FROM generate_series(g, 300, 17) o),
                          'notes', repeat('Gradual rollout guarded by kill switch. ', 5)),
       now() - g * interval '2 days'
FROM generate_series(1, 40) g;

INSERT INTO email_templates (key, subject, body_html, body_text, updated_at)
SELECT k, initcap(replace(k, '-', ' ')),
       '<html><body><table width="600">' || repeat('<tr><td style="font-family:Helvetica;font-size:14px;color:#333">{{content}}</td></tr>', 40) || '</table></body></html>',
       repeat('{{content}} ', 120),
       now() - interval '90 days'
FROM unnest(ARRAY['verify-email', 'welcome', 'invite', 'password-reset', 'invoice-issued', 'invoice-overdue',
                  'org-suspended', 'org-reactivated', 'weekly-digest', 'project-shared', 'api-key-created', 'farewell']) k;

INSERT INTO webhook_deliveries (org_id, event_type, target_url, request_body, response_code, response_body, attempted_at)
SELECT 1 + (g % 300),
       (ARRAY['project.updated', 'invoice.paid', 'member.added', 'member.removed'])[1 + g % 4],
       'https://hooks.example.net/acme/' || md5('url' || (g % 300)),
       jsonb_build_object('id', 'evt_' || md5('wh' || g), 'attempt', 1 + g % 3,
                          'data', jsonb_build_object('object', repeat('payload-field-value ', 60))),
       CASE WHEN g % 11 = 0 THEN 500 ELSE 200 END,
       CASE WHEN g % 11 = 0 THEN repeat('upstream error: connection reset by peer; ', 20) ELSE 'ok' END,
       now() - (g % 2000) * interval '1 hour'
FROM generate_series(1, 5000) g;

COMMIT;

ANALYZE;
