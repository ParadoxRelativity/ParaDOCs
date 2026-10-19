-- Schedules: who is on, and when.
--
-- What is stored is the rules, never the shifts. A schedule is a stack of
-- layers — a rotation handing off between people, a pattern of shifts worked
-- by crews, or each person's regular hours — and the shifts for any stretch
-- of time are worked out from them when asked for, by resolveSchedule in the
-- shared package. So changing a rotation never means regenerating anything.
--
-- A change to a layer takes effect from a chosen moment. The layer as it was
-- is ended there and a new version carries on from it, sharing its lineage,
-- so the shifts before the change stay as they were.
--
-- Overrides are the exceptions: someone covering a stretch of time instead of
-- whoever the layers put there. They are made by hand, or by a replacement
-- request someone took.

ALTER TABLE access_entries ADD COLUMN schedule_id uuid;

CREATE TABLE schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name              text NOT NULL,
  description       text NOT NULL DEFAULT '',
  -- An IANA zone. Shifts are defined in it, so a 09:00 handoff stays at 09:00
  -- through daylight saving changes.
  time_zone         text NOT NULL,
  color             text NOT NULL DEFAULT '#3b82f6',
  -- Whether a replacement someone takes still needs a manager's approval.
  requires_approval boolean NOT NULL DEFAULT false,
  -- Like a project, a schedule has no folder: it is open, or keeps a list.
  access            text NOT NULL DEFAULT 'open' CHECK (access IN ('open', 'allow', 'deny')),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX schedules_workspace_idx ON schedules (workspace_id, lower(name));

ALTER TABLE access_entries ADD CONSTRAINT access_entries_schedule_fk
  FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE;
ALTER TABLE access_entries DROP CONSTRAINT access_entries_one_target;
ALTER TABLE access_entries ADD CONSTRAINT access_entries_one_target
  CHECK (num_nonnulls(folder_id, document_id, channel_id, spreadsheet_id, project_id, schedule_id) = 1);
ALTER TABLE access_entries DROP COLUMN target;
ALTER TABLE access_entries ADD COLUMN target uuid
  GENERATED ALWAYS AS (COALESCE(folder_id, document_id, channel_id, spreadsheet_id, project_id, schedule_id)) STORED;
CREATE UNIQUE INDEX access_entries_target_subject_idx ON access_entries (target, subject);

-- What someone may do with a schedule: see it, or change it, as their role
-- and the schedule's list allow.
CREATE FUNCTION schedule_access_level(p_user uuid, p_role uuid, p_access text, p_schedule uuid)
RETURNS smallint LANGUAGE sql STABLE AS $$
  SELECT capped_level(role_ceiling(p_role, 'schedules'), access_list_level(p_user, p_schedule, p_access))
$$;

-- Teams and people who may override this schedule's shifts, and only this
-- schedule's: the per-schedule form of schedules.override.
CREATE TABLE schedule_override_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  subject     uuid GENERATED ALWAYS AS (COALESCE(team_id, user_id)) STORED,
  CONSTRAINT schedule_override_grants_one_subject CHECK (num_nonnulls(team_id, user_id) = 1)
);
CREATE UNIQUE INDEX schedule_override_grants_idx ON schedule_override_grants (schedule_id, subject);

-- Who is on a schedule. Only they can be asked to cover, or take a shift
-- through a request. Managers run the schedule whatever their role says.
CREATE TABLE schedule_members (
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  manager     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (schedule_id, user_id)
);
CREATE INDEX schedule_members_user_idx ON schedule_members (user_id);

-- One version of a layer. `lineage_id` ties the versions of one layer
-- together; a version covers [effective_from, effective_until).
CREATE TABLE schedule_layers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id     uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  lineage_id      uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('rotation', 'pattern', 'recurring')),
  name            text NOT NULL,
  -- Higher layers win where they overlap lower ones.
  position        integer NOT NULL DEFAULT 0,
  -- The kind's own settings, as the shared package's layer schemas describe.
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from  timestamptz NOT NULL,
  effective_until timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX schedule_layers_schedule_idx ON schedule_layers (schedule_id, position);
CREATE INDEX schedule_layers_lineage_idx ON schedule_layers (lineage_id, effective_from);

-- The people in a rotation, in turn order, or on a pattern's crews.
CREATE TABLE schedule_layer_members (
  layer_id   uuid NOT NULL REFERENCES schedule_layers(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   integer NOT NULL DEFAULT 0,
  -- Which of a pattern's crews; null in a rotation.
  crew       text,
  PRIMARY KEY (layer_id, user_id)
);
CREATE INDEX schedule_layer_members_user_idx ON schedule_layer_members (user_id);

-- Someone covering [starts_at, ends_at) instead of `replaced_user_id`, or as
-- extra cover when nobody is replaced.
CREATE TABLE schedule_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id      uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  replaced_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'request')),
  request_id       uuid,
  note             text NOT NULL DEFAULT '',
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX schedule_overrides_window_idx ON schedule_overrides (schedule_id, starts_at, ends_at);
CREATE INDEX schedule_overrides_user_idx ON schedule_overrides (user_id, starts_at);

-- Someone asking the rest of their schedule to cover a shift, or to swap one.
CREATE TABLE schedule_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id      uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  requester_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('cover', 'swap')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  note             text NOT NULL DEFAULT '',
  -- Everyone else on the schedule, or only the people in
  -- schedule_request_candidates.
  ask_everyone     boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'accepted', 'approved', 'declined', 'cancelled', 'expired')),
  accepted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  accepted_at      timestamptz,
  -- For a swap, the shift the person who took it gives in return.
  swap_starts_at   timestamptz,
  swap_ends_at     timestamptz,
  decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  decision_note    text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX schedule_requests_schedule_idx ON schedule_requests (schedule_id, status, starts_at);
CREATE INDEX schedule_requests_requester_idx ON schedule_requests (requester_id, status);

ALTER TABLE schedule_overrides ADD CONSTRAINT schedule_overrides_request_fk
  FOREIGN KEY (request_id) REFERENCES schedule_requests(id) ON DELETE SET NULL;

CREATE TABLE schedule_request_candidates (
  request_id uuid NOT NULL REFERENCES schedule_requests(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX schedule_request_candidates_user_idx ON schedule_request_candidates (user_id);
