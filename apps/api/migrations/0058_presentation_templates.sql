-- Presentation templates (PARA-110): a deck's look, saved in a workspace for
-- anyone in it to start a presentation from or put on one.
--
-- The template is a small deck of its own (theme, master, layouts and one
-- Title slide), stored the way a presentation's slides are. A presentation
-- made from it is a copy, so renaming or deleting a template changes no deck.
CREATE TABLE presentation_templates (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- Null while an imported template's pictures are still uploading; such a
  -- template is listed to nobody and cannot be used.
  ydoc         bytea,
  -- The Title slide as a thumbnail draws it, derived when the deck is stored.
  preview      jsonb,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX presentation_templates_workspace_idx ON presentation_templates (workspace_id, lower(name));

-- The pictures a template's master and layouts show. Recorded so they are
-- served to everyone in the workspace (as the template is), and are not
-- "unattached" once the deck they came from is deleted.
CREATE TABLE presentation_template_attachments (
  template_id   uuid NOT NULL REFERENCES presentation_templates(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  PRIMARY KEY (template_id, attachment_id)
);
CREATE INDEX presentation_template_attachments_attachment_idx ON presentation_template_attachments (attachment_id);
