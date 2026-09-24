-- Single sign-on through OpenID Connect, with as many providers as the server
-- admin page sets up.
--
-- A provider's client secret is stored encrypted with a key derived from
-- SESSION_SECRET (see lib/secretBox.ts), so a database dump alone does not
-- hand it over. Changing SESSION_SECRET means entering each secret again.

CREATE TABLE oidc_providers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- In the sign-in and redirect addresses, so it cannot change once made.
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  name              text NOT NULL,
  issuer            text NOT NULL,
  client_id         text NOT NULL,
  -- Null for a public client, which has only PKCE to prove itself with.
  client_secret_enc text,
  scopes            text NOT NULL DEFAULT 'openid email profile',
  new_accounts      text NOT NULL DEFAULT 'registration'
                    CHECK (new_accounts IN ('registration', 'always', 'never')),
  -- Lower-case email domains allowed to sign in; empty allows any.
  allowed_domains   text[] NOT NULL DEFAULT '{}',
  enabled           boolean NOT NULL DEFAULT true,
  position          integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- auth_identities.provider holds the provider's issuer: a subject is unique
-- per issuer, so the link survives a provider being renamed or set up again.

-- The desktop and mobile apps sign in through the system browser, which ends
-- on a paradocs:// address carrying a one-time code. The app redeems the code
-- with a verifier only it knows, whose hash is kept here as the challenge, so
-- another app that catches the address cannot use it. Only the code's hash is
-- stored.
CREATE TABLE oidc_handoffs (
  code_hash   text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge   text NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX oidc_handoffs_expires_idx ON oidc_handoffs(expires_at);
