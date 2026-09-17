-- Which apps a workspace uses.
--
-- A workspace used only for chat has no use for Docs or Sheets, and one used
-- only as a knowledge base has no use for Chat. Owners and admins turn apps off
-- per workspace; Access is always on, since it is where membership is managed.
--
-- What is stored is what has been turned off, so an app added in a later
-- release starts out on everywhere rather than off.
ALTER TABLE workspaces ADD COLUMN disabled_apps text[] NOT NULL DEFAULT '{}'
  CHECK (disabled_apps <@ ARRAY['docs', 'sheets', 'chat']::text[]);

-- Whether a workspace has an app turned on. False for a workspace that does not
-- exist, like any other question about one.
CREATE FUNCTION workspace_app_enabled(p_workspace uuid, p_app text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT NOT (p_app = ANY(disabled_apps)) FROM workspaces WHERE id = p_workspace), false)
$$;
