-- Pictures on slides, and telling people they have been tagged in a deck.

-- An uploaded file now belongs to a presentation as it can to a document, and
-- is served on the same terms: only to those who may open that presentation.
-- Deleting the presentation unattaches its files, as deleting a document does.
ALTER TABLE attachments ADD COLUMN presentation_id uuid REFERENCES presentations(id) ON DELETE SET NULL;
CREATE INDEX attachments_presentation_idx ON attachments(presentation_id) WHERE presentation_id IS NOT NULL;

-- document_mentions (0012) for decks: one row per person per presentation, not
-- per tag. `slide_id` is the slide that first named them, so the notification
-- opens the deck on that slide.
CREATE TABLE presentation_mentions (
  presentation_id uuid NOT NULL REFERENCES presentations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slide_id        text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  read_at         timestamptz,
  PRIMARY KEY (presentation_id, user_id)
);

CREATE INDEX presentation_mentions_unread_idx ON presentation_mentions (user_id, created_at DESC)
  WHERE read_at IS NULL;
