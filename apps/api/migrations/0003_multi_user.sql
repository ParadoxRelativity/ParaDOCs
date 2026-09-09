-- Phase 1: multiple users per workspace.
--
-- Access was previously "you own the workspace". It becomes a membership with a
-- role. workspaces.owner_id is kept as the record of who created it and as the
-- guarantee that a workspace always has at least one owner.

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- owner: full control including deleting the workspace
  -- admin: manage members and content
  -- editor: create and edit content
  -- viewer: read only, may still comment
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);

-- Every existing workspace owner becomes an owner-role member.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, owner_id, 'owner' FROM workspaces
ON CONFLICT DO NOTHING;

CREATE TABLE workspace_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Null email means a shareable link anyone with the token may redeem.
  email        text,
  role         text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token        text NOT NULL UNIQUE,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_invites_workspace_idx ON workspace_invites(workspace_id);

-- Collaborative editing state. The Y.Doc is the live source of truth while a
-- document is open; documents.body and body_md are derived from it on save so
-- search and export keep working.
ALTER TABLE documents ADD COLUMN ydoc bytea;
ALTER TABLE documents ADD COLUMN last_edited_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- External identity providers. Nothing writes here until OIDC lands, but the
-- table exists so an OIDC login can be linked to an existing account.
CREATE TABLE auth_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    text NOT NULL,
  subject     text NOT NULL,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subject)
);
CREATE INDEX auth_identities_user_idx ON auth_identities(user_id);

-- Password may be null for accounts that only ever sign in through a provider.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
