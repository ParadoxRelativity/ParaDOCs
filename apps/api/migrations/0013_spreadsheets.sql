-- Spreadsheets: an application of its own, beside documents rather than inside
-- them.
--
-- A spreadsheet is not a document in another mode. It has no blocks, no
-- folders, no tags and no comments; what it has is a grid, and the things
-- people want to do to a grid are not the things they want to do to prose. So
-- it gets its own table rather than another value in documents.mode, which
-- would have meant every document query carrying a kind it has no use for.
--
-- What it shares with documents is the collaboration machinery: the Y.Doc is
-- the live truth and is persisted here the same way. The collaboration server
-- tells the two apart by a "sheet:" prefix on the document name, so one socket
-- serves both without either having to know about the other.
CREATE TABLE spreadsheets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        text NOT NULL DEFAULT 'Untitled',
  icon         text,
  -- The live grid. Null until the first save, which is why a sheet opened and
  -- never typed in costs nothing.
  ydoc         bytea,
  -- The cells as text, derived on every save, so a spreadsheet is findable by
  -- what is written in it rather than only by its name.
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

CREATE INDEX spreadsheets_workspace_idx ON spreadsheets(workspace_id, updated_at DESC);
CREATE INDEX spreadsheets_search_idx ON spreadsheets USING GIN (search);
CREATE INDEX spreadsheets_title_trgm_idx ON spreadsheets USING GIN (title gin_trgm_ops);
