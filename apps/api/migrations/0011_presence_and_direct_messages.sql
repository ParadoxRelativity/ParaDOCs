-- Presence, and direct conversations between two members of a workspace.

-- The status a person chose. 'online' means "work it out for me": they show as
-- away once every window they have open goes quiet for away_after_minutes.
-- 'offline' is appearing offline while still signed in. A value of 0 for
-- away_after_minutes never goes away on its own.
ALTER TABLE users
  ADD COLUMN presence text NOT NULL DEFAULT 'online'
    CHECK (presence IN ('online', 'away', 'busy', 'offline')),
  ADD COLUMN away_after_minutes int NOT NULL DEFAULT 10
    CHECK (away_after_minutes BETWEEN 0 AND 1440);

-- A direct conversation is a channel, so messages, files, reactions, unread
-- counts and calls all work in it without a parallel set of tables. What sets
-- it apart is that only the people in channel_members can see it.
ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_kind_check;
ALTER TABLE channels ADD CONSTRAINT channels_kind_check CHECK (kind IN ('text', 'voice', 'direct'));

-- The two member ids, sorted and joined, so a pair has at most one
-- conversation per workspace even when both open it at the same moment.
ALTER TABLE channels ADD COLUMN dm_key text;
CREATE UNIQUE INDEX channels_direct_key_idx ON channels (workspace_id, dm_key) WHERE dm_key IS NOT NULL;

-- Direct conversations have no name to address them by, so only named
-- channels need to be unique.
DROP INDEX IF EXISTS channels_workspace_name_idx;
CREATE UNIQUE INDEX channels_workspace_name_idx ON channels (workspace_id, lower(name)) WHERE kind <> 'direct';

CREATE TABLE channel_members (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX channel_members_user_idx ON channel_members (user_id);
