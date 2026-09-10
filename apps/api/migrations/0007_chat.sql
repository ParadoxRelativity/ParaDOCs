-- Chat: per-workspace channels, in the shape of Slack or Discord.
--
-- Messages are ordinary rows rather than a Yjs document. A channel is an
-- append-only log that grows without bound and is read newest-first in pages;
-- a CRDT would have to hold the entire history in memory on every client to
-- show the last twenty lines.

CREATE TABLE channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Lowercase, no spaces, like #general. Display is the same string.
  name         text NOT NULL,
  topic        text,
  -- 'voice' channels carry no messages; they are a place to meet. The column
  -- exists now so adding calls later does not migrate the table again.
  kind         text NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'voice')),
  position     int  NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Channel names are addressed as #name, so they have to be unique per
-- workspace regardless of case.
CREATE UNIQUE INDEX channels_workspace_name_idx ON channels (workspace_id, lower(name));
CREATE INDEX channels_workspace_idx ON channels (workspace_id, position, created_at);

CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- Kept when the account goes: the message stays, the author reads as unknown.
  author_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Plain text carrying <doc:uuid> and <#uuid> reference tokens, resolved at
  -- render time so a renamed document or channel updates everywhere at once.
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at  timestamptz,
  -- Soft delete: a removed message leaves a tombstone so replies around it keep
  -- their order and clients can reconcile without refetching the page.
  deleted_at timestamptz
);

-- Every read is "the newest N in this channel, older than X".
CREATE INDEX messages_channel_created_idx ON messages (channel_id, created_at DESC, id DESC);

-- How far each person has read, for unread badges.
CREATE TABLE channel_reads (
  channel_id   uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

-- Every existing workspace gets somewhere to talk, owned by its creator.
INSERT INTO channels (workspace_id, name, topic, created_by)
SELECT id, 'general', 'Everything else', owner_id FROM workspaces;
