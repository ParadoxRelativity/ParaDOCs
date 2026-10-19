-- Slides: an app for presentations, beside Docs, Sheets, Chat, Projects and Schedules.
--
-- It is an app like the others, so it can be turned off per workspace. Unlike
-- Schedules it starts out on in the workspaces that already exist, since
-- `disabled_apps` stores what is off and nothing is added to it here.
--
-- Slides gets a folder tree of its own, told apart in `folders` by `app` as
-- Sheets does (0017). The presentations table comes with the data model.

ALTER TABLE workspaces DROP CONSTRAINT workspaces_disabled_apps_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_disabled_apps_check
  CHECK (disabled_apps <@ ARRAY['docs', 'sheets', 'chat', 'projects', 'schedules', 'slides']::text[]);

ALTER TABLE folders DROP CONSTRAINT folders_app_check;
ALTER TABLE folders ADD CONSTRAINT folders_app_check
  CHECK (app IN ('docs', 'sheets', 'slides'));

-- The Editor and Viewer roles a new workspace starts with gain the Slides
-- permissions. EDITOR_PERMISSIONS and VIEWER_PERMISSIONS in the shared package
-- must say the same.
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
    'slides.view', 'slides.edit', 'slides.create', 'slides.delete', 'slides.present',
    'chat.view', 'chat.post', 'chat.direct',
    'projects.view', 'projects.comment', 'projects.items', 'projects.sprints', 'projects.create', 'projects.configure',
    'queues.view', 'queues.comment', 'queues.items', 'queues.create', 'queues.configure',
    'schedules.view', 'schedules.request', 'schedules.edit', 'schedules.approve', 'schedules.create'
  ], 2)
  RETURNING id INTO v_editor;
  INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
  VALUES (p_workspace, 'Viewer', 'Reads everything, comments on documents and talks in chat.', ARRAY[
    'docs.view', 'docs.comment', 'sheets.view', 'slides.view', 'chat.view', 'chat.post', 'chat.direct', 'projects.view', 'queues.view',
    'schedules.view', 'schedules.request'
  ], 3);
  UPDATE workspaces SET default_role_id = v_editor WHERE id = p_workspace;
END
$$;

-- Roles that already exist get what they can do with spreadsheets, for
-- presentations: the closest thing they have to a stated preference.
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['slides.view', 'slides.edit', 'slides.create', 'slides.delete', 'slides.present']
 WHERE system IS NULL AND 'sheets.delete' = ANY(permissions);
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['slides.view', 'slides.edit', 'slides.create', 'slides.present']
 WHERE system IS NULL AND 'sheets.create' = ANY(permissions) AND NOT ('slides.view' = ANY(permissions));
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['slides.view', 'slides.edit']
 WHERE system IS NULL AND 'sheets.edit' = ANY(permissions) AND NOT ('slides.view' = ANY(permissions));
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['slides.view']
 WHERE system IS NULL AND 'sheets.view' = ANY(permissions) AND NOT ('slides.view' = ANY(permissions));
