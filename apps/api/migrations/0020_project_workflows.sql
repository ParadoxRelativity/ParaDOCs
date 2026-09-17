-- Workflows: the routes work items may take through a project's board.
--
-- A status says where an item is. A workflow says where it may go next: for
-- each status, the statuses an item sitting in it may move to. That is also
-- what decides how work leaves the backlog, since the moves out of a backlog
-- status are the board statuses an item may enter at.
--
-- Which workflow an item follows is decided by its type, so a bug can take a
-- different route than a story without anyone setting it per item. A type with
-- no workflow moves freely, which is how every project that exists today
-- behaves and how a new one starts: nothing is seeded, so a project is only
-- ever constrained once someone sets a workflow up.

CREATE TABLE project_workflows (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_workflows_name_idx ON project_workflows (project_id, lower(name));
CREATE INDEX project_workflows_project_idx ON project_workflows (project_id, position);

-- One allowed move. Deleting a status takes its moves with it, unlike a work
-- item, which is emptied into another status first: a route through a status
-- that no longer exists is not worth keeping.
CREATE TABLE project_workflow_transitions (
  workflow_id uuid NOT NULL REFERENCES project_workflows(id) ON DELETE CASCADE,
  from_status uuid NOT NULL REFERENCES project_statuses(id) ON DELETE CASCADE,
  to_status   uuid NOT NULL REFERENCES project_statuses(id) ON DELETE CASCADE,
  PRIMARY KEY (workflow_id, from_status, to_status),
  CONSTRAINT project_workflow_transitions_not_self CHECK (from_status <> to_status)
);

-- Which workflow each item type follows. A type with no row moves freely.
CREATE TABLE project_type_workflows (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('task', 'bug', 'story', 'epic', 'request')),
  workflow_id uuid NOT NULL REFERENCES project_workflows(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, type)
);
