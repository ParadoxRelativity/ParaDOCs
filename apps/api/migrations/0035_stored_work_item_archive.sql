-- Archiving finished work is now recorded rather than worked out on every read.
--
-- An hourly sweep sets `archived_at` on done items that have sat untouched for
-- their project's `archive_after_days`. Once set, it stays set until someone
-- reopens the item, comments on it or restores it; tidying the project up —
-- merging statuses, deleting a type or an epic — leaves it where it is. Only a
-- done item is ever archived: whatever takes an item out of done clears it.
--
-- The board and the list load only what is not archived, so a project's
-- archive can grow into the thousands without costing them anything.

ALTER TABLE work_items ADD COLUMN archived_at timestamptz;

-- What was already dormant is archived as of when it would have been, with the
-- same history entry the sweep writes.
WITH dormant AS (
  UPDATE work_items i
     SET archived_at = GREATEST(i.completed_at, i.updated_at) + make_interval(days => p.archive_after_days)
    FROM projects p
   WHERE p.id = i.project_id
     AND p.archive_after_days IS NOT NULL
     AND i.completed_at IS NOT NULL
     AND GREATEST(i.completed_at, i.updated_at) < now() - make_interval(days => p.archive_after_days)
  RETURNING i.id, i.archived_at
)
INSERT INTO work_item_activity (work_item_id, actor_id, data, created_at)
SELECT id, NULL, '{"kind": "archived"}'::jsonb, archived_at FROM dormant;

-- What the board and the list read: a project's work that is not archived.
CREATE INDEX work_items_current_idx ON work_items (project_id, position) WHERE archived_at IS NULL;
-- What the archive reads, newest first.
CREATE INDEX work_items_archived_idx ON work_items (project_id, archived_at DESC) WHERE archived_at IS NOT NULL;
-- What the sweep looks through: finished work not yet archived, which stays small.
CREATE INDEX work_items_archivable_idx ON work_items (project_id, completed_at)
  WHERE archived_at IS NULL AND completed_at IS NOT NULL;
