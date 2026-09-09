-- Canvas mode: an alternative to the page editor for the same document record.
--
-- Canvas elements live in the document's existing Y.Doc under a separate root
-- map, so collaboration, auth and persistence are unchanged. Only the derived
-- searchable text differs, since a canvas has no BlockNote blocks.
ALTER TABLE documents ADD COLUMN mode text NOT NULL DEFAULT 'page'
  CHECK (mode IN ('page', 'canvas'));

CREATE INDEX documents_mode_idx ON documents(workspace_id, mode);
