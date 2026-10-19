-- Presentations: the data behind the Slides app.
--
-- Modeled on spreadsheets (0013 and 0017). A deck is not a document in another
-- mode: it is fixed-size, ordered slides, not prose or an infinite board, so it
-- gets a table of its own and shares only the collaboration machinery. The
-- collaboration server tells it apart by a "slides:" prefix on the document
-- name.
CREATE TABLE presentations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Filed in a Slides folder, or in none. Deleting a folder unfiles its decks.
  folder_id    uuid REFERENCES folders(id) ON DELETE SET NULL,
  title        text NOT NULL DEFAULT 'Untitled',
  icon         text,
  -- 'inherit' from the folder, 'open', or an 'allow' or 'deny' list of its own.
  access       text NOT NULL DEFAULT 'inherit'
               CHECK (access IN ('inherit', 'open', 'allow', 'deny')),
  -- The live deck. Null until the first save, which is why a presentation
  -- opened and never edited costs nothing.
  ydoc         bytea,
  -- Slide text and speaker notes, derived on every save, so a deck is findable
  -- by what is written in it rather than only by its name.
  search_text  text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  last_edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz,
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('english'::regconfig, coalesce(search_text, '')), 'B')
               ) STORED
);

CREATE INDEX presentations_workspace_idx ON presentations(workspace_id, updated_at DESC);
CREATE INDEX presentations_folder_idx ON presentations(folder_id);
CREATE INDEX presentations_search_idx ON presentations USING GIN (search);
CREATE INDEX presentations_title_trgm_idx ON presentations USING GIN (title gin_trgm_ops);

-- A line of an allow or deny list can now belong to a presentation. `target`
-- is generated, so it is rebuilt to include the new column, and its index with it.
ALTER TABLE access_entries ADD COLUMN presentation_id uuid REFERENCES presentations(id) ON DELETE CASCADE;
ALTER TABLE access_entries DROP CONSTRAINT access_entries_one_target;
ALTER TABLE access_entries ADD CONSTRAINT access_entries_one_target
  CHECK (num_nonnulls(folder_id, document_id, channel_id, spreadsheet_id, project_id, schedule_id, presentation_id) = 1);
ALTER TABLE access_entries DROP COLUMN target;
ALTER TABLE access_entries ADD COLUMN target uuid
  GENERATED ALWAYS AS (COALESCE(folder_id, document_id, channel_id, spreadsheet_id, project_id, schedule_id, presentation_id)) STORED;
CREATE UNIQUE INDEX access_entries_target_subject_idx ON access_entries (target, subject);

-- What someone may do with a presentation: its own setting, or its folder's.
-- The rule is a document's rule, so it is that function under another name.
CREATE FUNCTION presentation_access_level(p_user uuid, p_role uuid, p_access text, p_presentation uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT document_access_level(p_user, p_role, p_access, p_presentation, p_folder)
$$;
