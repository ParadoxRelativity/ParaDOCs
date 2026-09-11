-- Files shared in chat, and emoji reactions on messages.

-- Chat files are kept apart from document attachments. Those belong to a
-- workspace's documents and are managed from Settings → Uploads; these belong
-- to a message and are removed with it.
CREATE TABLE message_attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- Null between upload and send. A file is uploaded as soon as it is added to
  -- the message box, so it is ready by the time the message goes out; one that
  -- is never sent is swept up after a day.
  message_id  uuid REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id uuid REFERENCES users(id) ON DELETE SET NULL,
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  byte_size   bigint NOT NULL,
  storage_key text NOT NULL,
  -- Pixel size of an image or video, so the message list can reserve its space
  -- before the file loads instead of jumping as it arrives.
  width       int,
  height      int,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX message_attachments_message_idx ON message_attachments (message_id, position);
CREATE INDEX message_attachments_channel_idx ON message_attachments (channel_id);
CREATE INDEX message_attachments_pending_idx ON message_attachments (created_at) WHERE message_id IS NULL;

-- One row per person per emoji: reacting twice with the same emoji is a no-op,
-- and different emoji from the same person are separate reactions.
CREATE TABLE message_reactions (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
