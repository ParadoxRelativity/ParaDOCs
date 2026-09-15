-- Server administration: settings for the whole server rather than one
-- workspace, and the people allowed to change them.
--
-- The admin page is served on its own port, which is kept off the public
-- interface. See src/admin/app.ts.

-- Server administrators. Independent of workspace roles: owning a workspace
-- says nothing about running the server, and running it grants nothing inside
-- anyone's workspace.
ALTER TABLE users ADD COLUMN is_server_admin boolean NOT NULL DEFAULT false;

-- A disabled account keeps everything it wrote but cannot sign in, and its
-- sessions stop resolving.
ALTER TABLE users ADD COLUMN disabled_at timestamptz;

-- One row per setting that has been changed from the admin page. A setting with
-- no row takes its default, which for some comes from the environment.
CREATE TABLE server_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Sessions on the admin port. Kept apart from app sessions, so signing in to the
-- app never signs anyone in to server administration, and the reverse.
CREATE TABLE admin_sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions(user_id);
