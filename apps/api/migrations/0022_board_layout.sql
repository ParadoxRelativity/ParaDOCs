-- How a project's board is laid out, beyond the order its statuses are in:
-- which statuses are merged into one column, which columns are stacked over
-- and under each other in a single lane, and what a merged column is called.
--
-- It is the project's, not the reader's, so everyone works from the same board.
-- Which lanes a reader has folded up is theirs alone and is kept in the browser,
-- since it says nothing about the work and changes several times an hour.
--
-- Stored as a wish rather than a rule. Nothing here references project_statuses,
-- so deleting a status never has to rewrite a layout: the board drops ids it
-- cannot find and gives any status the layout forgot a lane of its own. A
-- project that has never been arranged stores the empty layout and is drawn
-- exactly as it is today.

ALTER TABLE projects
  ADD COLUMN board_layout jsonb NOT NULL DEFAULT '{"lanes": []}'::jsonb
  CHECK (jsonb_typeof(board_layout -> 'lanes') = 'array');
