-- Projects: an application for tracking work.
--
-- A workspace has projects and queues. Both hold work items and are set up the
-- same way; `kind` only decides how the work is shown — a project on a board,
-- a queue as a list worked through oldest first. Each has its own statuses and
-- its own roles, since what one team calls "In review" another calls "QA",
-- and one team's items have a reviewer where another's have an approver.
--
-- Projects is an app like the others, so it can be turned off per workspace.
-- What is stored is what is off, so it starts out on everywhere.

ALTER TABLE workspaces DROP CONSTRAINT workspaces_disabled_apps_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_disabled_apps_check
  CHECK (disabled_apps <@ ARRAY['docs', 'sheets', 'chat', 'projects']::text[]);

CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'project' CHECK (kind IN ('project', 'queue')),
  -- What every item's key starts with: ENG in ENG-12.
  key          text NOT NULL CHECK (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  icon         text,
  -- A project has no folder, so like a channel it is open, or keeps a list.
  access       text NOT NULL DEFAULT 'open' CHECK (access IN ('open', 'allow', 'deny')),
  -- The number the next item gets. Numbers are never reused, so a key that
  -- was once ENG-12 never comes to mean a different item.
  next_number  integer NOT NULL DEFAULT 1,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  archived_at  timestamptz
);
CREATE UNIQUE INDEX projects_workspace_key_idx ON projects (workspace_id, key);

-- The category is what the app understands about a status, whatever it is
-- called: whether the work is queued to start at all, whether it has started,
-- and whether it is finished. Backlog statuses are kept off the board.
CREATE TABLE project_statuses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  category   text NOT NULL CHECK (category IN ('backlog', 'todo', 'active', 'done')),
  color      text NOT NULL DEFAULT '#8f8f9c',
  position   double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_statuses_project_idx ON project_statuses (project_id, position);

CREATE TABLE project_roles (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  -- Whether several people can hold it on one item at once.
  multiple   boolean NOT NULL DEFAULT false,
  position   double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX project_roles_name_idx ON project_roles (project_id, lower(name));

CREATE TABLE work_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- Repeated from the project so references can be held to a workspace
  -- without a join, as every other kind of reference is.
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  number       integer NOT NULL,
  title        text NOT NULL,
  -- Plain text with reference tokens, written the way a chat message is.
  description  text NOT NULL DEFAULT '',
  type         text NOT NULL DEFAULT 'task' CHECK (type IN ('task', 'bug', 'story', 'epic', 'request')),
  priority     text NOT NULL DEFAULT 'none' CHECK (priority IN ('none', 'low', 'medium', 'high', 'urgent')),
  -- Not cascaded: a status with items in it is emptied into another before it
  -- goes. A whole project going takes both at once, which is fine.
  status_id    uuid NOT NULL REFERENCES project_statuses(id),
  position     double precision NOT NULL DEFAULT 0,
  due_date     date,
  estimate     numeric(10, 2),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B')
               ) STORED,
  UNIQUE (project_id, number)
);
CREATE INDEX work_items_status_idx ON work_items (project_id, status_id, position);
CREATE INDEX work_items_workspace_idx ON work_items (workspace_id, updated_at DESC);
CREATE INDEX work_items_search_idx ON work_items USING GIN (search);
CREATE INDEX work_items_title_trgm_idx ON work_items USING GIN (title gin_trgm_ops);

-- Who holds which role on an item. A role that takes one person is kept to
-- one by the routes, which is where "replace the assignee" is decided.
CREATE TABLE work_item_roles (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  role_id      uuid NOT NULL REFERENCES project_roles(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, role_id, user_id)
);
CREATE INDEX work_item_roles_user_idx ON work_item_roles (user_id);

CREATE TABLE work_item_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  author_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  edited_at    timestamptz
);
CREATE INDEX work_item_comments_item_idx ON work_item_comments (work_item_id, created_at);

-- An item's history: made, moved, handed to someone. Names are written as they
-- were at the time, since a status renamed later did not rename the past.
CREATE TABLE work_item_activity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  data         jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX work_item_activity_item_idx ON work_item_activity (work_item_id, created_at);

-- Where a work item is mentioned: a document or canvas, a chat message, or
-- another item's description or comments. The mention itself lives in that
-- content; this is the index that lets an item list what points at it, kept
-- up to date whenever the content is saved.
CREATE TABLE work_item_mentions (
  work_item_id   uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  document_id    uuid REFERENCES documents(id) ON DELETE CASCADE,
  message_id     uuid REFERENCES messages(id) ON DELETE CASCADE,
  source_item_id uuid REFERENCES work_items(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  source         uuid GENERATED ALWAYS AS (COALESCE(document_id, message_id, source_item_id)) STORED,
  CONSTRAINT work_item_mentions_one_source CHECK (num_nonnulls(document_id, message_id, source_item_id) = 1)
);
CREATE UNIQUE INDEX work_item_mentions_source_idx ON work_item_mentions (source, work_item_id);
CREATE INDEX work_item_mentions_item_idx ON work_item_mentions (work_item_id);

-- Items that want someone's attention: a role they were given, or their name
-- in a description or comment. One row per person per item, like document
-- mentions, but a new reason brings it back even after it was read — being
-- made the assignee of something you once looked at is news.
CREATE TABLE work_item_notifications (
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       text NOT NULL CHECK (reason IN ('role', 'mention')),
  -- For a role, its name when it was given.
  detail       text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz,
  PRIMARY KEY (work_item_id, user_id)
);
CREATE INDEX work_item_notifications_unread_idx ON work_item_notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- A line of an allow or deny list can now belong to a project. `target` is
-- generated, so it is rebuilt to include the new column, and its index with it.
ALTER TABLE access_entries ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE access_entries DROP CONSTRAINT access_entries_one_target;
ALTER TABLE access_entries ADD CONSTRAINT access_entries_one_target
  CHECK (num_nonnulls(folder_id, document_id, channel_id, spreadsheet_id, project_id) = 1);
ALTER TABLE access_entries DROP COLUMN target;
ALTER TABLE access_entries ADD COLUMN target uuid
  GENERATED ALWAYS AS (COALESCE(folder_id, document_id, channel_id, spreadsheet_id, project_id)) STORED;
CREATE UNIQUE INDEX access_entries_target_subject_idx ON access_entries (target, subject);

-- What someone may do with a project. Like a document with a setting of its
-- own: a viewer never gets past viewing, and a list decides the rest.
CREATE FUNCTION project_access_level(p_user uuid, p_role text, p_access text, p_project uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_role IS NULL THEN 0::smallint
    WHEN p_role IN ('owner', 'admin') THEN 2::smallint
    ELSE LEAST(CASE WHEN p_role = 'viewer' THEN 1 ELSE 2 END,
               access_list_level(p_user, p_project, p_access))::smallint
  END
$$;
