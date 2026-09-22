-- Files attached to a work item: screenshots, recordings, logs and notes.
--
-- Kept apart from document attachments, which the workspace's storage page
-- lists and offers to re-home when their document is gone. A work item's
-- files go with the item, so none is ever left without one.
--
-- They are stored under work-items/<item>/, and served to whoever can see the
-- item.

CREATE TABLE work_item_attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  uploader_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  filename     text NOT NULL,
  mime_type    text NOT NULL,
  byte_size    bigint NOT NULL,
  storage_key  text NOT NULL UNIQUE,
  -- Pixel size of an image or video, when the uploader could measure it.
  width        integer,
  height       integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_item_attachments_item_idx ON work_item_attachments (work_item_id, created_at);
