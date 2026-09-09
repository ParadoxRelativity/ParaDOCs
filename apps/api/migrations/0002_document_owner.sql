-- Documents record who created them. Until now ownership was only implied by the
-- workspace, which cannot survive the move to multiple users per workspace.

ALTER TABLE documents ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Existing documents belong to whoever owns their workspace.
UPDATE documents d
   SET created_by = w.owner_id
  FROM workspaces w
 WHERE w.id = d.workspace_id AND d.created_by IS NULL;

CREATE INDEX documents_created_by_idx ON documents(created_by);
