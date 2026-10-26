-- A duplicated deck shows the same pictures as its original, but each upload
-- belongs to one presentation (attachments.presentation_id). This records the
-- other decks that use an upload, so a copy's readers can see its pictures and
-- the upload is not "unattached" while any copy still uses it.
CREATE TABLE presentation_attachments (
  presentation_id uuid NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (presentation_id, attachment_id)
);
CREATE INDEX presentation_attachments_attachment_idx ON presentation_attachments(attachment_id);
