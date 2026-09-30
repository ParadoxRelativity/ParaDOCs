-- Work items tell the people holding any role on them when they move on: a
-- new comment, or a new status. These join being given a role and being named
-- as reasons for a notification, and rank below both, so an unread "you were
-- made assignee" is not replaced by the comment that follows it.
--
-- For a status change, `detail` holds the status it moved to.
ALTER TABLE work_item_notifications DROP CONSTRAINT IF EXISTS work_item_notifications_reason_check;
ALTER TABLE work_item_notifications
  ADD CONSTRAINT work_item_notifications_reason_check CHECK (reason IN ('role', 'mention', 'comment', 'status'));
