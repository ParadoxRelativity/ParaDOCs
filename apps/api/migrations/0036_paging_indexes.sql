-- Lists that are read a page at a time, keyed on where the last page ended,
-- each get an index in their own order, so a page is a short walk along it
-- rather than a sort of everything there is.

-- A workspace's files in the uploads panel, newest first.
CREATE INDEX attachments_workspace_created_idx ON attachments (workspace_id, created_at DESC, id DESC);

-- A folder's documents in the sidebar, by title.
CREATE INDEX documents_folder_title_idx ON documents (folder_id, title, id) WHERE archived_at IS NULL;

-- A Sheets folder's spreadsheets, by title, and those in no folder, most recently touched first.
CREATE INDEX spreadsheets_folder_title_idx ON spreadsheets (folder_id, lower(title), id) WHERE archived_at IS NULL;
CREATE INDEX spreadsheets_workspace_updated_idx ON spreadsheets (workspace_id, updated_at DESC, id DESC);
