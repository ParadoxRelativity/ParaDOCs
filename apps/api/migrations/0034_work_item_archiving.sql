-- Finished work leaves the board and the list once nobody has touched it for a
-- while, so the done column of a busy project stays short. How long is each
-- project's own choice; null means finished work is never put away.
--
-- Nothing is written when an item is archived: whether it is follows from when
-- it was finished and last changed, read against this setting. So changing the
-- setting takes effect at once, and an archived item that is reopened or
-- commented on comes back by itself.

ALTER TABLE projects ADD COLUMN archive_after_days integer
  CONSTRAINT projects_archive_after_days_ck CHECK (archive_after_days BETWEEN 1 AND 3650);

-- A project's done work is looked back on for longer than a queue's.
UPDATE projects SET archive_after_days = CASE kind WHEN 'queue' THEN 7 ELSE 30 END;
