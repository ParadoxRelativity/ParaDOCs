-- Schedules: an app for on-call rotations, rotating shifts and work schedules.
--
-- It is an app like the others, so it can be turned off per workspace. Unlike
-- the apps before it, it starts out off in the workspaces that already exist:
-- an owner turns it on when they want it. New workspaces have it on.

ALTER TABLE workspaces DROP CONSTRAINT workspaces_disabled_apps_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_disabled_apps_check
  CHECK (disabled_apps <@ ARRAY['docs', 'sheets', 'chat', 'projects', 'schedules']::text[]);

UPDATE workspaces SET disabled_apps = array_append(disabled_apps, 'schedules')
 WHERE NOT ('schedules' = ANY(disabled_apps));

-- The Editor and Viewer roles a new workspace starts with gain the Schedules
-- permissions. EDITOR_PERMISSIONS and VIEWER_PERMISSIONS in the shared package
-- must say the same. Overriding a shift is never a default: it puts people
-- onto a schedule they are not on, so it is given on purpose.
CREATE OR REPLACE FUNCTION seed_workspace_roles(p_workspace uuid) RETURNS void LANGUAGE plpgsql AS $$
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
    'queues.view', 'queues.comment', 'queues.items', 'queues.create', 'queues.configure',
    'schedules.view', 'schedules.request', 'schedules.edit', 'schedules.approve', 'schedules.create'
  ], 2)
  RETURNING id INTO v_editor;
  INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
  VALUES (p_workspace, 'Viewer', 'Reads everything, comments on documents and talks in chat.', ARRAY[
    'docs.view', 'docs.comment', 'sheets.view', 'chat.view', 'chat.post', 'chat.direct', 'projects.view', 'queues.view',
    'schedules.view', 'schedules.request'
  ], 3);
  UPDATE workspaces SET default_role_id = v_editor WHERE id = p_workspace;
END
$$;

-- Roles that already exist get what their equivalent would start with: one
-- that can start projects can build schedules, and one that can see projects
-- can see schedules and ask for cover on their own shifts. Owners can change
-- either before turning the app on.
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['schedules.view', 'schedules.request', 'schedules.edit', 'schedules.approve', 'schedules.create']
 WHERE system IS NULL AND 'projects.create' = ANY(permissions);
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['schedules.view', 'schedules.request']
 WHERE system IS NULL AND 'projects.view' = ANY(permissions) AND NOT ('schedules.view' = ANY(permissions));
