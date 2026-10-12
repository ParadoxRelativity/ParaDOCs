-- Templates a workspace saved from its projects, to start others from. The
-- setup is kept as JSON in the shape packages/shared/src/projectTemplates.ts
-- describes, with every reference a local key, so a template outlives the
-- project it was saved from, and that project outlives it.

CREATE TABLE project_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  kind         text NOT NULL CHECK (kind IN ('project', 'queue')),
  config       jsonb NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_templates_workspace_idx ON project_templates (workspace_id, kind, lower(name));
