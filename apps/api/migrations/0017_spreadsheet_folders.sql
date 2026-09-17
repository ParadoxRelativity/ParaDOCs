-- Folders and permissions for spreadsheets.
--
-- Spreadsheets get a folder tree of their own, kept apart from the documents
-- tree: the two apps are shown one at a time, and a workspace can turn either
-- one off. Both trees live in `folders`, told apart by `app`, so a folder of
-- spreadsheets is locked, inherited from and deleted exactly as a folder of
-- documents is, by the functions migration 0014 added.
--
-- A spreadsheet takes the same settings a document does: 'inherit' from its
-- folder, 'open', or an 'allow' or 'deny' list of its own.

ALTER TABLE folders ADD COLUMN app text NOT NULL DEFAULT 'docs'
  CHECK (app IN ('docs', 'sheets'));
CREATE INDEX folders_workspace_app_idx ON folders(workspace_id, app);

ALTER TABLE spreadsheets ADD COLUMN folder_id uuid REFERENCES folders(id) ON DELETE SET NULL;
ALTER TABLE spreadsheets ADD COLUMN access text NOT NULL DEFAULT 'inherit'
  CHECK (access IN ('inherit', 'open', 'allow', 'deny'));
CREATE INDEX spreadsheets_folder_idx ON spreadsheets(folder_id);

-- A line of an allow or deny list can now belong to a spreadsheet. `target` is
-- generated, so it is rebuilt to include the new column, and its index with it.
ALTER TABLE access_entries ADD COLUMN spreadsheet_id uuid REFERENCES spreadsheets(id) ON DELETE CASCADE;
ALTER TABLE access_entries DROP CONSTRAINT access_entries_one_target;
ALTER TABLE access_entries ADD CONSTRAINT access_entries_one_target
  CHECK (num_nonnulls(folder_id, document_id, channel_id, spreadsheet_id) = 1);
ALTER TABLE access_entries DROP COLUMN target;
ALTER TABLE access_entries ADD COLUMN target uuid
  GENERATED ALWAYS AS (COALESCE(folder_id, document_id, channel_id, spreadsheet_id)) STORED;
CREATE UNIQUE INDEX access_entries_target_subject_idx ON access_entries (target, subject);

-- What someone may do with a spreadsheet: its own setting, or its folder's.
-- The rule is a document's rule, so it is that function under another name.
CREATE FUNCTION spreadsheet_access_level(p_user uuid, p_role text, p_access text, p_spreadsheet uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT document_access_level(p_user, p_role, p_access, p_spreadsheet, p_folder)
$$;
