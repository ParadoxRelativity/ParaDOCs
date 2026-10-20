-- Comments on slides, and telling people who are named in them.
--
-- A comment is anchored to a slide by its id, and optionally to an element on
-- it. Slides live in the deck's Y.Doc and are not rows, so slide_id and
-- element_id are plain text with nothing to cascade from: deleting a slide
-- leaves its comments in place, and the editor shows them as on a removed
-- slide. Deleting the presentation takes them with it.
CREATE TABLE slide_comments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  presentation_id uuid NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  slide_id        text NOT NULL,
  element_id      text,
  parent_id       uuid REFERENCES slide_comments(id) ON DELETE CASCADE,
  author_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            text NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slide_comments_presentation_idx ON slide_comments (presentation_id, created_at);
-- Comment text is findable: a search that matches a deck by what people said about it.
CREATE INDEX slide_comments_search_idx ON slide_comments USING GIN (to_tsvector('english'::regconfig, body));

-- Who has been told they were named, and has not yet opened the slide. One row
-- per person per comment; the notifications panel shows the newest per slide.
CREATE TABLE slide_comment_mentions (
  comment_id      uuid NOT NULL REFERENCES slide_comments(id) ON DELETE CASCADE,
  presentation_id uuid NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  slide_id        text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  PRIMARY KEY (comment_id, user_id)
);
CREATE INDEX slide_comment_mentions_unread_idx ON slide_comment_mentions (user_id, created_at DESC)
  WHERE read_at IS NULL;

-- Commenting on slides is a permission of its own, as it is for documents.
-- Roles that already exist gain it where they could comment on documents and
-- see presentations. The seed below must match EDITOR_PERMISSIONS and
-- VIEWER_PERMISSIONS in the shared package.
UPDATE workspace_roles
   SET permissions = permissions || ARRAY['slides.comment']
 WHERE system IS NULL AND 'docs.comment' = ANY(permissions) AND 'slides.view' = ANY(permissions)
   AND NOT ('slides.comment' = ANY(permissions));

CREATE OR REPLACE FUNCTION seed_workspace_roles(p_workspace uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_editor uuid;
BEGIN
  INSERT INTO workspace_roles (workspace_id, name, description, system, position) VALUES
    (p_workspace, 'Owner', 'Everything, including deleting the workspace.', 'owner', 0),
    (p_workspace, 'Admin', 'Everything but deleting the workspace: people, roles, locks and settings.', 'admin', 1);
  INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
  VALUES (p_workspace, 'Editor', 'Creates and edits content in every app.', ARRAY[
    'docs.view', 'docs.comment', 'docs.edit', 'docs.create', 'docs.delete', 'docs.tags', 'docs.calendar',
    'sheets.view', 'sheets.edit', 'sheets.create', 'sheets.delete',
    'slides.view', 'slides.comment', 'slides.edit', 'slides.create', 'slides.delete', 'slides.present',
    'chat.view', 'chat.post', 'chat.direct',
    'projects.view', 'projects.comment', 'projects.items', 'projects.sprints', 'projects.create', 'projects.configure',
    'queues.view', 'queues.comment', 'queues.items', 'queues.create', 'queues.configure',
    'schedules.view', 'schedules.request', 'schedules.edit', 'schedules.approve', 'schedules.create'
  ], 2)
  RETURNING id INTO v_editor;
  INSERT INTO workspace_roles (workspace_id, name, description, permissions, position)
  VALUES (p_workspace, 'Viewer', 'Reads everything, comments on documents and talks in chat.', ARRAY[
    'docs.view', 'docs.comment', 'sheets.view', 'slides.view', 'slides.comment', 'chat.view', 'chat.post', 'chat.direct', 'projects.view', 'queues.view',
    'schedules.view', 'schedules.request'
  ], 3);
  UPDATE workspaces SET default_role_id = v_editor WHERE id = p_workspace;
END
$$;
