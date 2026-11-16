-- Sprint 9 / step 1: accounts, roles, sessions. Reverses the earlier "no consumer sign-up" decision
-- (see middleware/auth.js): travellers can sign up directly, and agency staff sign in with email too.
-- Every user still acts inside exactly one agency per session, so the tenant boundary is unchanged:
-- direct sign-ups belong to the built-in house agency ("TAPI Direct").

ALTER TABLE agencies ADD COLUMN kind TEXT NOT NULL DEFAULT 'agency' CHECK (kind IN ('agency','house'));
ALTER TABLE agencies ADD COLUMN traveller_self_booking BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX uq_agencies_one_house ON agencies(kind) WHERE kind = 'house';
INSERT INTO agencies (id, name, kind) VALUES ('00000000-0000-4000-8000-000000000001', 'TAPI Direct', 'house');

CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT NOT NULL,
  password_hash     TEXT,                              -- NULL until an invited user sets one
  full_name         TEXT NOT NULL,
  email_verified_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_logins     INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_users_email ON users (lower(email));

-- A user's role inside one agency. 'traveller' memberships point at that person's travelers row.
CREATE TABLE memberships (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  agency_id    UUID NOT NULL REFERENCES agencies(id),
  role         TEXT NOT NULL CHECK (role IN ('traveller','agent','admin')),
  traveler_id  UUID REFERENCES travelers(id),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, agency_id),
  CONSTRAINT ck_membership_traveller CHECK ((role = 'traveller') = (traveler_id IS NOT NULL))
);
CREATE INDEX idx_memberships_agency ON memberships(agency_id, role);

-- Opaque session tokens. Only the SHA-256 of the token is stored, like API keys.
CREATE TABLE user_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id),
  membership_id  UUID NOT NULL REFERENCES memberships(id),
  token_hash     TEXT NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  ip             TEXT,
  user_agent     TEXT
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id) WHERE revoked_at IS NULL;

-- Single-use emailed tokens (verify email, reset password, staff invite). Hashed at rest.
CREATE TABLE user_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  purpose     TEXT NOT NULL CHECK (purpose IN ('verify_email','reset_password','invite')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_tokens_user ON user_tokens(user_id, purpose);

-- Who approved a booking, in what role, and whether an agent attested the client's consent.
ALTER TABLE agent_trip_approvals ADD COLUMN approved_by_user_id UUID REFERENCES users(id);
ALTER TABLE agent_trip_approvals ADD COLUMN approved_by_role TEXT;
ALTER TABLE agent_trip_approvals ADD COLUMN consent_attested BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_trips ADD COLUMN created_by_user_id UUID REFERENCES users(id);
