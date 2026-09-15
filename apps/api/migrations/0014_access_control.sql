-- Who can see and change what inside a workspace.
--
-- Everything is open to the whole workspace unless someone locks it. A folder,
-- document or channel can instead allow only the teams and people listed
-- ('allow'), or everyone except them ('deny'). Folders and documents start out
-- inheriting ('inherit'): they take the setting of the nearest folder above
-- them that has one of its own, so the nearest setting wins. Owners and admins
-- are never kept out, so a lock can always be undone.

CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX teams_workspace_name_idx ON teams (workspace_id, lower(name));

CREATE TABLE team_members (
  team_id    uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user_idx ON team_members (user_id);

ALTER TABLE folders ADD COLUMN access text NOT NULL DEFAULT 'inherit'
  CHECK (access IN ('inherit', 'open', 'allow', 'deny'));
ALTER TABLE documents ADD COLUMN access text NOT NULL DEFAULT 'inherit'
  CHECK (access IN ('inherit', 'open', 'allow', 'deny'));
-- A channel has no folder to inherit from.
ALTER TABLE channels ADD COLUMN access text NOT NULL DEFAULT 'open'
  CHECK (access IN ('open', 'allow', 'deny'));

-- One line of an allow or deny list: a team or a person, and what they may do.
-- Levels are 0 nothing, 1 view (read, or listen in a call), 2 edit (post, or
-- speak). Each line belongs to exactly one folder, document or channel, and
-- goes with it.
CREATE TABLE access_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id   uuid REFERENCES folders(id) ON DELETE CASCADE,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  channel_id  uuid REFERENCES channels(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  level       smallint NOT NULL CHECK (level IN (0, 1, 2)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Whichever of the three it belongs to, and whichever of the two it names,
  -- so a lookup does not have to know which column to read.
  target      uuid GENERATED ALWAYS AS (COALESCE(folder_id, document_id, channel_id)) STORED,
  subject     uuid GENERATED ALWAYS AS (COALESCE(team_id, user_id)) STORED,
  CONSTRAINT access_entries_one_target CHECK (num_nonnulls(folder_id, document_id, channel_id) = 1),
  CONSTRAINT access_entries_one_subject CHECK (num_nonnulls(team_id, user_id) = 1)
);
CREATE UNIQUE INDEX access_entries_target_subject_idx ON access_entries (target, subject);
CREATE INDEX access_entries_team_idx ON access_entries (team_id) WHERE team_id IS NOT NULL;

-- What a list gives one person: the line naming them, or else the most any of
-- their teams is given, or else what the list leaves everyone it does not name
-- — nothing on an allow list, everything on a deny list. Anything other than
-- a list is open.
CREATE FUNCTION access_list_level(p_user uuid, p_target uuid, p_mode text)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_mode IS NULL OR p_mode NOT IN ('allow', 'deny') THEN 2::smallint
    ELSE COALESCE(
      (SELECT e.level FROM access_entries e WHERE e.target = p_target AND e.user_id = p_user),
      (SELECT max(e.level) FROM access_entries e
         JOIN team_members tm ON tm.team_id = e.team_id
        WHERE e.target = p_target AND tm.user_id = p_user),
      CASE WHEN p_mode = 'allow' THEN 0::smallint ELSE 2::smallint END)
  END
$$;

-- The folder whose setting applies to what is filed in p_folder: that folder
-- if it has a setting of its own, or the nearest one above it that does. Null
-- when none does, which means open. The depth limit only guards against a
-- cycle the routes already refuse to create.
CREATE FUNCTION access_folder_governor(p_folder uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_id, access, 0 AS depth FROM folders WHERE id = p_folder
    UNION ALL
    SELECT f.id, f.parent_id, f.access, up.depth + 1
      FROM folders f JOIN up ON f.id = up.parent_id
     WHERE up.access = 'inherit' AND up.depth < 64
  )
  SELECT id FROM up WHERE access <> 'inherit' ORDER BY depth LIMIT 1
$$;

-- What someone with p_role in the workspace may do with a folder. A viewer
-- never gets past viewing, whatever a list says.
CREATE FUNCTION folder_access_level(p_user uuid, p_role text, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_role IS NULL THEN 0::smallint
    WHEN p_role IN ('owner', 'admin') THEN 2::smallint
    ELSE LEAST(
      CASE WHEN p_role = 'viewer' THEN 1 ELSE 2 END,
      COALESCE(
        (SELECT access_list_level(p_user, g.id, g.access) FROM folders g
          WHERE g.id = access_folder_governor(p_folder)),
        2))::smallint
  END
$$;

-- The same for a document: its own setting, or its folder's.
CREATE FUNCTION document_access_level(p_user uuid, p_role text, p_access text, p_document uuid, p_folder uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_role IS NULL THEN 0::smallint
    WHEN p_role IN ('owner', 'admin') THEN 2::smallint
    WHEN p_access <> 'inherit' THEN
      LEAST(CASE WHEN p_role = 'viewer' THEN 1 ELSE 2 END,
            access_list_level(p_user, p_document, p_access))::smallint
    ELSE folder_access_level(p_user, p_role, p_folder)
  END
$$;

-- The same for a named channel. Chat has always let viewers post, so the role
-- sets no ceiling here; only a list does.
CREATE FUNCTION channel_access_level(p_user uuid, p_role text, p_access text, p_channel uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_role IS NULL THEN 0::smallint
    WHEN p_role IN ('owner', 'admin') THEN 2::smallint
    ELSE access_list_level(p_user, p_channel, p_access)
  END
$$;

-- Whether a document is open to everyone in its workspace, for what is sent to
-- everyone at once, such as the link chips on a new chat message.
CREATE FUNCTION document_is_open(p_access text, p_folder uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_access <> 'inherit' THEN p_access = 'open'
    ELSE COALESCE((SELECT access FROM folders WHERE id = access_folder_governor(p_folder)), 'open') = 'open'
  END
$$;
