-- Acme Projects database schema.

CREATE TABLE plans (
  id           integer PRIMARY KEY,
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  price_cents  integer NOT NULL,
  features     jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE organizations (
  id          integer PRIMARY KEY,
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  plan_id     integer NOT NULL REFERENCES plans(id),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX organizations_status_idx ON organizations (status);

CREATE TABLE users (
  id                  integer PRIMARY KEY,
  org_id              integer NOT NULL REFERENCES organizations(id),
  invited_by_user_id  integer REFERENCES users(id),
  email               text NOT NULL UNIQUE,
  password_hash       text NOT NULL,
  display_name        text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'disabled')),
  email_verified_at   timestamptz,
  activated_at        timestamptz,
  bio                 text,
  profile             jsonb NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_org_id_idx ON users (org_id);
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_invited_by_idx ON users (invited_by_user_id);

-- A user can belong to several organizations; users.org_id is their current (primary) one.
CREATE TABLE memberships (
  org_id       integer NOT NULL REFERENCES organizations(id),
  user_id      integer NOT NULL REFERENCES users(id),
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_at   timestamptz NOT NULL DEFAULT now(),
  accepted_at  timestamptz,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX memberships_user_id_idx ON memberships (user_id);

CREATE TABLE email_verification_tokens (
  id           serial PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id),
  token        text NOT NULL UNIQUE,
  sent_to      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);
CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);

CREATE TABLE projects (
  id                  integer PRIMARY KEY,
  org_id              integer NOT NULL REFERENCES organizations(id),
  name                text NOT NULL,
  description         text,
  created_by_user_id  integer NOT NULL REFERENCES users(id),
  updated_by_user_id  integer NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_id_idx ON projects (org_id);
CREATE INDEX projects_updated_by_idx ON projects (updated_by_user_id);

-- Who can see a project. Must reference a membership in the project's org;
-- removing the membership removes the user's assignments.
CREATE TABLE project_assignments (
  project_id   integer NOT NULL REFERENCES projects(id),
  user_id      integer NOT NULL,
  org_id       integer NOT NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES memberships (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX project_assignments_member_idx ON project_assignments (org_id, user_id);

CREATE TABLE api_keys (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id),
  org_id        integer NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  api_key       text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_user_id_idx ON api_keys (user_id);

CREATE TABLE user_events (
  id          bigserial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id),
  project_id  integer REFERENCES projects(id),
  event_type  text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_events_user_id_created_at_idx ON user_events (user_id, created_at);
CREATE INDEX user_events_project_id_idx ON user_events (project_id);

CREATE TABLE subscriptions (
  id                  serial PRIMARY KEY,
  org_id              integer NOT NULL UNIQUE REFERENCES organizations(id),
  plan_id             integer NOT NULL REFERENCES plans(id),
  status              text NOT NULL CHECK (status IN ('active', 'past_due', 'canceled')),
  current_period_end  timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id               integer PRIMARY KEY,
  subscription_id  integer NOT NULL REFERENCES subscriptions(id),
  org_id           integer NOT NULL REFERENCES organizations(id),
  period_start     date NOT NULL,
  amount_cents     integer NOT NULL,
  status           text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void')),
  issued_at        timestamptz NOT NULL,
  due_at           timestamptz NOT NULL,
  paid_at          timestamptz,
  external_ref     text,
  line_items       jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX invoices_subscription_id_idx ON invoices (subscription_id);
CREATE INDEX invoices_org_status_due_idx ON invoices (org_id, status, due_at);

-- Unrelated to the scenarios below.
CREATE TABLE feature_flags (
  id          serial PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  enabled     boolean NOT NULL DEFAULT false,
  rules       jsonb NOT NULL DEFAULT '{}',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_templates (
  id          serial PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  subject     text NOT NULL,
  body_html   text NOT NULL,
  body_text   text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id             bigserial PRIMARY KEY,
  org_id         integer NOT NULL REFERENCES organizations(id),
  event_type     text NOT NULL,
  target_url     text NOT NULL,
  request_body   jsonb NOT NULL,
  response_code  integer,
  response_body  text,
  attempted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_org_id_idx ON webhook_deliveries (org_id, attempted_at);
