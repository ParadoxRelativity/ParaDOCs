-- Calendar feeds: an address a phone or desktop calendar subscribes to, to
-- show someone's shifts, or a whole schedule. The address carries a secret,
-- kept only as a hash like an intake token, so a leaked database does not
-- leak feeds; resetting it replaces the secret and the old address stops.
CREATE TABLE schedule_feed_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- A whole schedule's feed; null for the person's own shifts.
  schedule_id  uuid REFERENCES schedules(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  hint         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE UNIQUE INDEX schedule_feed_tokens_owner_idx
  ON schedule_feed_tokens (user_id, workspace_id, COALESCE(schedule_id, '00000000-0000-0000-0000-000000000000'::uuid));
