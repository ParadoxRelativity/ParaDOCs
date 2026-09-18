-- Sprints: an option a project's board can be run with.
--
-- A sprint is a stretch of time the team commits a set of work to. With
-- sprints on, the board shows the running sprint's work and nothing else, and
-- the backlog is where the next sprints are planned. With them off — as every
-- project starts, and as a queue always is — nothing here is read at all, so a
-- project can try sprints and go back without losing what it had.
--
-- A sprint is planned, then running, then complete. Only one runs at a time in
-- a project. A completed sprint keeps the work that was finished in it, so what
-- each sprint got done can be told afterwards; what was not finished is moved
-- on when it completes.

ALTER TABLE projects ADD COLUMN sprints_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE project_sprints (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         text NOT NULL,
  goal         text NOT NULL DEFAULT '',
  state        text NOT NULL DEFAULT 'planned' CHECK (state IN ('planned', 'active', 'completed')),
  -- Planned dates. Either can be left open until the sprint is started.
  start_date   date,
  end_date     date,
  -- What actually happened, which need not match what was planned.
  started_at   timestamptz,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_sprints_dates_ck CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX project_sprints_project_idx ON project_sprints (project_id, created_at);
CREATE UNIQUE INDEX project_sprints_one_active_idx ON project_sprints (project_id) WHERE state = 'active';

-- Deleting a sprint sends its work back to the backlog rather than with it.
ALTER TABLE work_items ADD COLUMN sprint_id uuid REFERENCES project_sprints(id) ON DELETE SET NULL;
CREATE INDEX work_items_sprint_idx ON work_items (sprint_id) WHERE sprint_id IS NOT NULL;
