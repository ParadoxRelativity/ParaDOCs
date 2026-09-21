-- Work item types a project sets up for itself.
--
-- Until now every project had the same five types, fixed in the code. Now each
-- project has its own: it starts with those five — Task, Bug, Story, Epic and
-- Request — and can rename, recolour or delete any of them, and add its own.
--
-- What the app understands about a type is carried as a flag rather than a
-- name: an epic-kind type holds other work, is kept off the board and out of
-- sprints, and is followed in the Epics view, whatever it is called. Everything
-- else about a type is the project's to choose: its name, icon and colour, the
-- workflow its items follow (which used to be kept in project_type_workflows),
-- and which of the project's roles apply to its items.

CREATE TABLE project_item_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- A Bootstrap Icons name, from the set the app offers.
  icon        text NOT NULL,
  color       text NOT NULL,
  epic        boolean NOT NULL DEFAULT false,
  -- Null: its items move freely between statuses.
  workflow_id uuid REFERENCES project_workflows(id) ON DELETE SET NULL,
  position    double precision NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  legacy      text
);
CREATE INDEX project_item_types_project_idx ON project_item_types (project_id, position);
CREATE UNIQUE INDEX project_item_types_name_idx ON project_item_types (project_id, lower(name));

-- The roles that apply to a type's items. A role not listed is not offered on
-- them. New roles apply to every type, and new types take every role.
CREATE TABLE project_item_type_roles (
  type_id uuid NOT NULL REFERENCES project_item_types(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES project_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (type_id, role_id)
);
CREATE INDEX project_item_type_roles_role_idx ON project_item_type_roles (role_id);

-- The five standard types, for every project there already is.
INSERT INTO project_item_types (project_id, name, icon, color, epic, position, legacy)
SELECT p.id, t.name, t.icon, t.color, t.epic, t.position, t.legacy
  FROM projects p
 CROSS JOIN (VALUES
   ('task',    'Task',    'check2-square',    '#0ea5e9', false, 1),
   ('bug',     'Bug',     'bug',              '#ef4444', false, 2),
   ('story',   'Story',   'bookmark',         '#10b981', false, 3),
   ('epic',    'Epic',    'lightning-charge', '#8b5cf6', true,  4),
   ('request', 'Request', 'chat-square-text', '#f59e0b', false, 5)
 ) AS t(legacy, name, icon, color, epic, position);

UPDATE project_item_types it SET workflow_id = tw.workflow_id
  FROM project_type_workflows tw
 WHERE tw.project_id = it.project_id AND tw.type = it.legacy;
DROP TABLE project_type_workflows;

INSERT INTO project_item_type_roles (type_id, role_id)
SELECT it.id, r.id FROM project_item_types it JOIN project_roles r ON r.project_id = it.project_id;

ALTER TABLE work_items ADD COLUMN type_id uuid REFERENCES project_item_types(id);
UPDATE work_items i SET type_id = it.id
  FROM project_item_types it
 WHERE it.project_id = i.project_id AND it.legacy = i.type;
ALTER TABLE work_items ALTER COLUMN type_id SET NOT NULL;
ALTER TABLE work_items DROP COLUMN type;
CREATE INDEX work_items_type_idx ON work_items (type_id);

-- The default is now one of the project's own types. Never an epic-kind one,
-- which the app makes sure of; the database only makes sure it exists.
ALTER TABLE projects ADD COLUMN default_type_id uuid REFERENCES project_item_types(id) ON DELETE SET NULL;
UPDATE projects p SET default_type_id = it.id
  FROM project_item_types it
 WHERE it.project_id = p.id AND it.legacy = p.default_item_type;
ALTER TABLE projects DROP COLUMN default_item_type;

ALTER TABLE project_item_types DROP COLUMN legacy;
