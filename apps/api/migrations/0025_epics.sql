-- Epics, and the type new work starts as.
--
-- An epic is a larger objective the rest of a project's work is organised
-- under: stories, tasks and bugs each belong to at most one. It is not worked
-- on its own, so it is never put in a sprint and is kept off the board; how
-- far along it is comes from the work under it.
--
-- Deleting an epic leaves its work where it was, belonging to no epic.

ALTER TABLE work_items ADD COLUMN epic_id uuid REFERENCES work_items(id) ON DELETE SET NULL;
CREATE INDEX work_items_epic_idx ON work_items (epic_id) WHERE epic_id IS NOT NULL;

-- An epic in a sprint from before this is taken back out.
UPDATE work_items SET sprint_id = NULL WHERE type = 'epic' AND sprint_id IS NOT NULL;

-- What a new work item is when nobody picks otherwise. Never an epic, since
-- new work is often filed straight into a sprint or onto the board.
ALTER TABLE projects
  ADD COLUMN default_item_type text NOT NULL DEFAULT 'task'
  CHECK (default_item_type IN ('task', 'bug', 'story', 'request'));
UPDATE projects SET default_item_type = 'request' WHERE kind = 'queue';
