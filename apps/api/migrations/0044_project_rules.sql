-- What a project fills in when work reaches a status: set, add to or clear a
-- role, or set the priority. See packages/shared/src/projectRules.ts.
--
-- A rule goes with the status that sets it off. Its types are a list, null for
-- every type; its actions are kept as JSON, since what they hold differs by
-- kind, and are pruned by the routes when a role they name is deleted.

CREATE TABLE project_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name       text NOT NULL,
  enabled    boolean NOT NULL DEFAULT true,
  position   double precision NOT NULL,
  status_id  uuid NOT NULL REFERENCES project_statuses(id) ON DELETE CASCADE,
  type_ids   uuid[],
  actions    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_rules_project_idx ON project_rules (project_id, position);
