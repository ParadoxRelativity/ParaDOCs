-- Roles a workspace defines for itself.
--
-- Until now a member was an owner, admin, editor or viewer, and what each could
-- do was written into the code. Now a workspace has roles of its own, each a
-- set of permissions (packages/shared/src/permissions.ts) that owners and
-- admins choose: one that can write documents but not touch chat, one that
-- works on project items but cannot change how the project is set up, one that
-- never sees Sheets.
--
-- Owner and Admin stay built in. They can do everything, get past every lock,
-- and cannot be changed, so a workspace can always be put right. Editor and
-- Viewer become ordinary roles with today's permissions, to be changed,
-- renamed or deleted like any other.
--
-- A role is how far someone may go anywhere in the workspace. Locks, which
-- name teams and people, can narrow that for one folder, document, channel or
-- project, never widen it — so teams say whose things are whose, and roles say
-- what kind of work someone does.

CREATE TABLE workspace_roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- 'owner' or 'admin' for the built-in roles, which hold every permission
  -- whatever `permissions` says.
  system       text CHECK (system IN ('owner', 'admin')),
  permissions  text[] NOT NULL DEFAULT '{}',
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX workspace_roles_name_idx ON workspace_roles (workspace_id, lower(name));
CREATE UNIQUE INDEX workspace_roles_system_idx ON workspace_roles (workspace_id, system) WHERE system IS NOT NULL;

-- The role new invites start with.
ALTER TABLE workspaces ADD COLUMN default_role_id uuid REFERENCES workspace_roles(id) ON DELETE SET NULL;

-- Every workspace starts with the four roles it has always had. The Editor and
-- Viewer permissions are EDITOR_PERMISSIONS and VIEWER_PERMISSIONS in the
-- shared package, which must say the same.
CREATE FUNCTION seed_workspace_roles(p_workspace uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_editor uuid;
BEGIN
  INSERT INTO workspace_roles (workspace_id, name, description, system, position) VALUES
    (p_workspace, 'Owner', 'Everything, including deleting the workspace.', 'owner', 0),
    (p_workspace, 'Admin', 'Everything but deleting the workspace: people, roles, locks and settings.', 'admin', 1);
  INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
  VALUES (p_workspace, 'Editor', 'Creates and edits content in every app.', ARRAY[
    'docs.view', 'docs.comment', 'docs.edit', 'docs.create', 'docs.delete', 'docs.tags', 'docs.calendar',
    'sheets.view', 'sheets.edit', 'sheets.create', 'sheets.delete',
    'chat.view', 'chat.post', 'chat.direct',
    'projects.view', 'projects.comment', 'projects.items', 'projects.sprints', 'projects.create', 'projects.configure',
    'queues.view', 'queues.comment', 'queues.items', 'queues.create', 'queues.configure'
  ], 2)
  RETURNING id INTO v_editor;
  INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
  VALUES (p_workspace, 'Viewer', 'Reads everything, comments on documents and talks in chat.', ARRAY[
    'docs.view', 'docs.comment', 'sheets.view', 'chat.view', 'chat.post', 'chat.direct', 'projects.view', 'queues.view'
  ], 3);
  UPDATE workspaces SET default_role_id = v_editor WHERE id = p_workspace;
END
$$;

DO $$
DECLARE
  v_workspace uuid;
BEGIN
  FOR v_workspace IN SELECT id FROM workspaces LOOP
    PERFORM seed_workspace_roles(v_workspace);
  END LOOP;
END
$$;

CREATE FUNCTION workspaces_seed_roles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_workspace_roles(NEW.id);
  RETURN NULL;
END
$$;
CREATE TRIGGER workspaces_seed_roles AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION workspaces_seed_roles();

-- A member holds one role. `role` stays beside it as 'owner', 'admin' or
-- 'member', kept in step by the trigger below, since so much only asks whether
-- someone is an owner or an admin.
ALTER TABLE workspace_members ADD COLUMN role_id uuid REFERENCES workspace_roles(id);
UPDATE workspace_members m
   SET role_id = r.id
  FROM workspace_roles r
 WHERE r.workspace_id = m.workspace_id
   AND CASE m.role
         WHEN 'owner' THEN r.system = 'owner'
         WHEN 'admin' THEN r.system = 'admin'
         WHEN 'editor' THEN r.system IS NULL AND r.name = 'Editor'
         ELSE r.system IS NULL AND r.name = 'Viewer'
       END;
ALTER TABLE workspace_members ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
UPDATE workspace_members SET role = 'member' WHERE role NOT IN ('owner', 'admin');
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'admin', 'member'));
CREATE INDEX workspace_members_role_idx ON workspace_members (role_id);

-- Sets `role` from `role_id`. A row written with only `role` ('owner' or
-- 'admin', or 'member' for the workspace's default role) is given the role it
-- names, so creating a workspace needs to know nothing about roles.
CREATE FUNCTION workspace_members_role() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_workspace uuid;
  v_system text;
BEGIN
  IF NEW.role_id IS NULL THEN
    IF NEW.role IN ('owner', 'admin') THEN
      SELECT id INTO NEW.role_id FROM workspace_roles WHERE workspace_id = NEW.workspace_id AND system = NEW.role;
    ELSE
      SELECT default_role_id INTO NEW.role_id FROM workspaces WHERE id = NEW.workspace_id;
    END IF;
  END IF;
  SELECT workspace_id, system INTO v_workspace, v_system FROM workspace_roles WHERE id = NEW.role_id;
  IF v_workspace IS DISTINCT FROM NEW.workspace_id THEN
    RAISE EXCEPTION 'role % does not belong to workspace %', NEW.role_id, NEW.workspace_id;
  END IF;
  NEW.role := COALESCE(v_system, 'member');
  RETURN NEW;
END
$$;
CREATE TRIGGER workspace_members_role BEFORE INSERT OR UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION workspace_members_role();

-- An invite names the role it joins with. Never Owner, which is only reached
-- by an owner handing it on.
ALTER TABLE workspace_invites ADD COLUMN role_id uuid REFERENCES workspace_roles(id);
UPDATE workspace_invites i
   SET role_id = r.id
  FROM workspace_roles r
 WHERE r.workspace_id = i.workspace_id
   AND CASE i.role
         WHEN 'admin' THEN r.system = 'admin'
         WHEN 'editor' THEN r.system IS NULL AND r.name = 'Editor'
         ELSE r.system IS NULL AND r.name = 'Viewer'
       END;
ALTER TABLE workspace_invites ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE workspace_invites DROP COLUMN role;
CREATE INDEX workspace_invites_role_idx ON workspace_invites (role_id);

-- What follows replaces the role checks in the access functions of
-- migrations 0014, 0017 and 0019, which took the role's name, with ones that
-- take the role and read its permissions.

-- Whether a role grants a permission. Owner and Admin grant every one.
CREATE FUNCTION role_grants(p_role uuid, p_permission text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT r.system IS NOT NULL OR p_permission = ANY(r.permissions) FROM workspace_roles r WHERE r.id = p_role),
    false)
$$;

-- How far a role reaches in one area before any lock: 0 not at all, 1 view,
-- 2 edit, 3 everything, past every lock. Areas are 'docs', 'sheets', 'chat',
-- 'projects' and 'queues'. Editing is posting in chat and working on items in
-- projects and queues.
CREATE FUNCTION role_ceiling(p_role uuid, p_area text)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT CASE
       WHEN r.system IS NOT NULL THEN 3
       WHEN p_area || CASE p_area WHEN 'chat' THEN '.post' WHEN 'projects' THEN '.items' WHEN 'queues' THEN '.items'
                                  ELSE '.edit' END = ANY(r.permissions) THEN 2
       WHEN p_area || '.view' = ANY(r.permissions) THEN 1
       ELSE 0
     END FROM workspace_roles r WHERE r.id = p_role),
    0)::smallint
$$;

-- What a lock leaves someone whose role reaches `p_ceiling`.
CREATE FUNCTION capped_level(p_ceiling smallint, p_list smallint)
RETURNS smallint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_ceiling >= 3 THEN 2 WHEN p_ceiling <= 0 THEN 0 ELSE LEAST(p_ceiling, p_list) END::smallint
$$;

-- What the lock over a folder's contents gives someone: that of the nearest
-- folder with a setting of its own, or everything when none has one.
CREATE FUNCTION folder_list_level(p_user uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT access_list_level(p_user, g.id, g.access) FROM folders g WHERE g.id = access_folder_governor(p_folder)),
    2)::smallint
$$;

-- A document or spreadsheet: its own setting, or its folder's.
CREATE FUNCTION filed_list_level(p_user uuid, p_access text, p_item uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_access <> 'inherit' THEN access_list_level(p_user, p_item, p_access)
    ELSE folder_list_level(p_user, p_folder)
  END
$$;

DROP FUNCTION spreadsheet_access_level(uuid, text, text, uuid, uuid);
DROP FUNCTION document_access_level(uuid, text, text, uuid, uuid);
DROP FUNCTION folder_access_level(uuid, text, uuid);
DROP FUNCTION channel_access_level(uuid, text, text, uuid);
DROP FUNCTION project_access_level(uuid, text, text, uuid);

-- What someone holding p_role may do in a folder, in whichever app it is in.
-- A null role is someone outside the workspace, who may do nothing.
CREATE FUNCTION folder_access_level(p_user uuid, p_role uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(role_ceiling(p_role, (SELECT app FROM folders WHERE id = p_folder)),
                      folder_list_level(p_user, p_folder))
$$;

CREATE FUNCTION document_access_level(p_user uuid, p_role uuid, p_access text, p_document uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(role_ceiling(p_role, 'docs'), filed_list_level(p_user, p_access, p_document, p_folder))
$$;

CREATE FUNCTION spreadsheet_access_level(p_user uuid, p_role uuid, p_access text, p_spreadsheet uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(role_ceiling(p_role, 'sheets'), filed_list_level(p_user, p_access, p_spreadsheet, p_folder))
$$;

-- A named channel. Viewing is reading and listening; editing is posting and speaking.
CREATE FUNCTION channel_access_level(p_user uuid, p_role uuid, p_access text, p_channel uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(role_ceiling(p_role, 'chat'), access_list_level(p_user, p_channel, p_access))
$$;

-- A project or a queue, which a role reaches separately.
CREATE FUNCTION project_access_level(p_user uuid, p_role uuid, p_access text, p_project uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(
    role_ceiling(p_role, (SELECT CASE kind WHEN 'queue' THEN 'queues' ELSE 'projects' END FROM projects WHERE id = p_project)),
    access_list_level(p_user, p_project, p_access))
$$;
