-- Requests to the server's administrators about an account, and team leads
-- suspending people from a workspace.
--
-- Anyone can ask for their own account to be deleted, from the app's settings
-- or /account/delete. A team lead (a role with `teams.accounts`) can ask for
-- someone on their team to be disabled or deleted. Either reaches the whole
-- server, which is the administrators' call, so the request is recorded here
-- and they are told; see routes/account.ts and routes/teamAccounts.ts.
--
-- One request stands at a time. It is cleared when the person withdraws their
-- own, an administrator dismisses it or carries out a request to disable, and
-- goes with the row when the account is deleted.
ALTER TABLE users ADD COLUMN account_request text CHECK (account_request IN ('delete', 'disable'));
ALTER TABLE users ADD COLUMN account_requested_at timestamptz;
ALTER TABLE users ADD COLUMN account_request_note text
  CHECK (account_request_note IS NULL OR char_length(account_request_note) <= 1000);
ALTER TABLE users ADD CONSTRAINT users_account_request_complete
  CHECK ((account_request IS NULL) = (account_requested_at IS NULL));

-- A team lead's request. `account_requested_by_lead` says so even after the
-- lead's own account is gone and `account_requested_by` has been cleared, so a
-- request never comes to look like the person's own; the names are kept for the
-- same reason, and because a workspace may be renamed or deleted.
ALTER TABLE users ADD COLUMN account_requested_by_lead boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN account_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN account_requested_by_name text;
ALTER TABLE users ADD COLUMN account_requested_workspace_name text;
-- What the person said about a team lead's request.
ALTER TABLE users ADD COLUMN account_member_note text
  CHECK (account_member_note IS NULL OR char_length(account_member_note) <= 1000);

-- The administrators' notifications ask for the open requests on every load.
CREATE INDEX users_account_requested_idx ON users (account_requested_at)
  WHERE account_requested_at IS NOT NULL;

-- Someone suspended from a workspace by a team lead, owner or admin. Their
-- membership row moves here, out of workspace_members, so every check of who
-- is in the workspace leaves them out without being told about suspensions;
-- lifting it moves the row back. Their teams and places on access lists stay
-- where they are, so they come back to what they had.
CREATE TABLE workspace_suspensions (
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  -- Null if the role is deleted meanwhile; they come back with the default role.
  role_id           uuid REFERENCES workspace_roles(id) ON DELETE SET NULL,
  joined_at         timestamptz NOT NULL,
  suspended_at      timestamptz NOT NULL DEFAULT now(),
  suspended_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  suspended_by_name text NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_suspensions_user_idx ON workspace_suspensions (user_id);
