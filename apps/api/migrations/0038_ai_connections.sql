-- AI assistants — Claude, ChatGPT, Cursor and the like — reaching ParaDOCs
-- through its MCP server at /api/mcp, as the person who connected them.
--
-- The whole thing is off until a server administrator turns on the
-- aiConnections setting. A person then connects an assistant one of two ways:
--
--   key    a personal access key made in Settings and pasted into a client
--          that takes one, such as Claude Code. Bring your own key.
--   oauth  the client signs in through the browser (OAuth 2.1 with PKCE), as
--          claude.ai and ChatGPT do for a custom connector. Nothing is copied.
--
-- Either way the assistant can do no more than the person could, and each
-- connection can be held to one workspace and to reading only, and revoked on
-- its own. Only hashes of the secrets are kept.

CREATE TABLE ai_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('key', 'oauth')),
  -- A key's name, or the name an OAuth client registered with.
  name          text NOT NULL,
  client_id     text,
  -- Null: every workspace the person is in.
  workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  can_write     boolean NOT NULL DEFAULT false,
  -- A key's own hash, or the hash of an OAuth connection's current refresh
  -- token, which changes each time it is used.
  token_hash    text NOT NULL UNIQUE,
  hint          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);

CREATE INDEX ai_connections_user_idx ON ai_connections (user_id, created_at);

-- Clients that registered themselves (RFC 7591). Anyone may register one, as
-- the protocol expects; a client can do nothing until a person signs in
-- through it and approves it.
CREATE TABLE oauth_clients (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  redirect_uris  text[] NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Approvals waiting to be exchanged for tokens: single use, and short-lived.
CREATE TABLE oauth_codes (
  code_hash       text PRIMARY KEY,
  client_id       text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  workspace_id    uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  can_write       boolean NOT NULL,
  expires_at      timestamptz NOT NULL
);

-- The short-lived tokens an OAuth connection calls with. Revoking the
-- connection takes them with it.
CREATE TABLE ai_access_tokens (
  token_hash     text PRIMARY KEY,
  connection_id  uuid NOT NULL REFERENCES ai_connections(id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL
);

CREATE INDEX ai_access_tokens_expiry_idx ON ai_access_tokens (expires_at);
