-- The least moderation the app stores ask of an app with user-generated
-- content: reporting a chat message, and blocking a person. See
-- routes/moderation.ts.

-- Someone blocked by someone else, across the whole server, so it holds on
-- every device and in every workspace the two share. The person blocking stops
-- seeing the other's messages and mentions, and the other can no longer message
-- or call them in a conversation of their own. Nobody is told.
CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
-- Asked from the other side when a pair's conversation is written to.
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

-- A chat message someone reported to the owners and admins of its workspace.
--
-- What the message said, who wrote it and where are copied in when it is
-- reported. The author can still edit or delete it, and admins cannot open a
-- direct conversation they are not part of, so the copy is what they review.
-- Names are kept for the same reason, and outlast the accounts.
CREATE TABLE message_reports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id       uuid REFERENCES channels(id) ON DELETE SET NULL,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  direct           boolean NOT NULL,
  channel_name     text NOT NULL,
  author_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  author_name      text NOT NULL,
  body             text NOT NULL,
  attachment_count integer NOT NULL DEFAULT 0,
  reporter_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  reporter_name    text NOT NULL,
  reason           text CHECK (reason IS NULL OR char_length(reason) <= 1000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Set when an owner or admin has dealt with it. Kept afterwards, as a record.
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL
);
-- One open report per person per message: reporting again updates the reason.
CREATE UNIQUE INDEX message_reports_open_unique ON message_reports (message_id, reporter_id)
  WHERE resolved_at IS NULL;
-- The admins' notifications ask for the open reports on every load.
CREATE INDEX message_reports_open_idx ON message_reports (workspace_id, created_at)
  WHERE resolved_at IS NULL;
