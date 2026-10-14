-- Telling people about their shifts: being asked to cover, a request taken,
-- approved or declined, a shift overridden, and a reminder before a shift.
--
-- Shown in the app for now. Each way of delivering one records when it was
-- sent, so email can be turned on later without changing what is sent or when.

CREATE TABLE schedule_notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schedule_id   uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  request_id    uuid REFERENCES schedule_requests(id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (reason IN (
                  'request', 'accepted', 'approval', 'approved', 'declined', 'cancelled',
                  'override', 'override_removed', 'reminder', 'on_call', 'expiring')),
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- The stretch of time it is about.
  starts_at     timestamptz,
  ends_at       timestamptz,
  -- Who else it involves, by name when it was made: who covers, or is covered.
  detail        text NOT NULL DEFAULT '',
  -- Set for what must go out once only, such as a reminder, however many
  -- servers are sweeping: the second to try finds it there.
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  in_app_sent_at timestamptz,
  email_sent_at  timestamptz
);
CREATE INDEX schedule_notifications_unread_idx ON schedule_notifications (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE UNIQUE INDEX schedule_notifications_dedupe_idx ON schedule_notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- How long before a shift someone is reminded, in minutes. 0 is never.
CREATE TABLE schedule_user_settings (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reminder_minutes integer NOT NULL DEFAULT 60 CHECK (reminder_minutes BETWEEN 0 AND 1440)
);

-- When the people concerned were warned that a request is about to expire unanswered.
ALTER TABLE schedule_requests ADD COLUMN warned_at timestamptz;
