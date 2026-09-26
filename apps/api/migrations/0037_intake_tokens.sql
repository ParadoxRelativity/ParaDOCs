-- Work sent in from outside: a web form, a monitoring alert, another system.
--
-- The server has one intake address, POST /api/intake, and it is off until a
-- server administrator turns on the intakeWebhooks setting. What arrives there
-- is filed in whichever queue the token it carries belongs to, so a queue can
-- have several — one per form or sender — and each can be revoked alone.
--
-- Only a token's hash is kept. It is shown once, when it is made; `hint` is
-- its last few characters, so the list can say which is which.

CREATE TABLE intake_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  hint          text NOT NULL,
  -- The type what it sends in is filed as. Null: the queue's default type.
  type_id       uuid REFERENCES project_item_types(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  use_count     integer NOT NULL DEFAULT 0
);

CREATE INDEX intake_tokens_project_idx ON intake_tokens (project_id, created_at);
