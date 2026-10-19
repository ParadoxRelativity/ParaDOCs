-- A queue can give the person in a role a time to respond, and pass work
-- nobody responded to on to other roles in turn: an escalation role filled
-- from a backup schedule, then a manager. Off unless a queue sets it.
--
-- A response is what insights counts as one: a comment from anyone but whoever
-- filed the item, a move to another status, or its being finished.
--
-- `escalation_since` is when it was turned on: work filed before then is never
-- escalated, so turning it on does not hand a backlog of old work along at once.
ALTER TABLE projects ADD COLUMN response_role_id uuid REFERENCES project_roles(id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN escalation_since timestamptz;

-- In order: each waits `after_minutes` from the step before it, the first from
-- when the item was filed. A role that is deleted takes its step with it.
CREATE TABLE project_escalation_steps (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  role_id       uuid NOT NULL REFERENCES project_roles(id) ON DELETE CASCADE,
  after_minutes integer NOT NULL CHECK (after_minutes BETWEEN 1 AND 10080),
  PRIMARY KEY (project_id, position)
);

-- Each step an item has been through, claimed before it is acted on, so no
-- step happens twice however many servers sweep at once.
CREATE TABLE work_item_escalations (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  position     integer NOT NULL,
  escalated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, position)
);

-- The people a step reaches are told why: escalated to them, or past them.
ALTER TABLE work_item_notifications DROP CONSTRAINT IF EXISTS work_item_notifications_reason_check;
ALTER TABLE work_item_notifications
  ADD CONSTRAINT work_item_notifications_reason_check CHECK (reason IN ('role', 'mention', 'comment', 'status', 'escalated'));
