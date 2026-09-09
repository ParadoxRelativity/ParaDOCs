-- ParaDOCs initial schema.
-- Documents are stored in Postgres: `body` holds the canonical BlockNote block
-- array, `body_md` is markdown derived from it on every save, and `search` is a
-- generated tsvector over title + markdown so full-text search never touches JSON.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Emails are compared case-insensitively without pulling in citext.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  slug       text NOT NULL,
  icon       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);

CREATE TABLE folders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES folders(id) ON DELETE CASCADE,
  name         text NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX folders_workspace_idx ON folders(workspace_id);
CREATE INDEX folders_parent_idx ON folders(parent_id);

CREATE TABLE documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  folder_id    uuid REFERENCES folders(id) ON DELETE SET NULL,
  title        text NOT NULL DEFAULT 'Untitled',
  icon         text,
  body         jsonb NOT NULL DEFAULT '[]'::jsonb,
  body_md      text NOT NULL DEFAULT '',
  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_journal   boolean NOT NULL DEFAULT false,
  journal_date date,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('english'::regconfig, coalesce(body_md, '')), 'B')
               ) STORED,
  CONSTRAINT journal_needs_date CHECK (NOT is_journal OR journal_date IS NOT NULL)
);
CREATE INDEX documents_workspace_idx ON documents(workspace_id);
CREATE INDEX documents_folder_idx ON documents(folder_id);
CREATE INDEX documents_updated_idx ON documents(workspace_id, updated_at DESC);
CREATE INDEX documents_search_idx ON documents USING GIN (search);
-- Trigram index makes substring matches work where stemming does not.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX documents_title_trgm_idx ON documents USING GIN (title gin_trgm_ops);
-- One journal entry per workspace per day.
CREATE UNIQUE INDEX documents_journal_unique ON documents(workspace_id, journal_date)
  WHERE is_journal;

CREATE TABLE tags (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  color        text NOT NULL DEFAULT '#6366f1',
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE document_tags (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, tag_id)
);
CREATE INDEX document_tags_tag_idx ON document_tags(tag_id);

CREATE TABLE comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES comments(id) ON DELETE CASCADE,
  -- BlockNote block id this comment is anchored to, or NULL for a document-level note.
  block_id    text,
  body        text NOT NULL,
  resolved    boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_document_idx ON comments(document_id, created_at);

CREATE TABLE events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,
  title        text NOT NULL,
  description  text,
  start_at     timestamptz NOT NULL,
  end_at       timestamptz,
  all_day      boolean NOT NULL DEFAULT false,
  color        text NOT NULL DEFAULT '#6366f1',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_workspace_range_idx ON events(workspace_id, start_at);

CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id  uuid REFERENCES documents(id) ON DELETE SET NULL,
  filename     text NOT NULL,
  mime_type    text NOT NULL,
  byte_size    bigint NOT NULL,
  storage_key  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_workspace_idx ON attachments(workspace_id);
