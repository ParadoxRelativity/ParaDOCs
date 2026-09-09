-- Repairs workspaces whose owner was never recorded as a member.
--
-- Registration created a starter workspace but, unlike every other path that
-- creates one, never inserted the workspace_members row that grants access.
-- Any account registered after 0003 therefore owned a workspace it could not
-- open. The route now inserts the row; this backfills the ones already made.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, owner_id, 'owner' FROM workspaces
ON CONFLICT DO NOTHING;
