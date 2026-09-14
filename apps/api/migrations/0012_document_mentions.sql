-- Tagging people by name in a document's text or on a canvas.
--
-- The tag itself lives in the content — a link in a document, an `<@uuid>`
-- token in a canvas element's text — so this table is not where a mention is
-- stored. It is only the record of who has been told, written whenever the
-- collaboration server saves a document and finds a name in it.
--
-- One row per person per document, not per tag: being named three times in one
-- document is one thing to go and read, not three. It follows that a second tag
-- in a document you have already opened does not tell you again, which is the
-- quieter of the two wrong answers.
CREATE TABLE document_mentions (
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- The person named.
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who was saving the document when the tag first appeared. Null once that
  -- account is deleted, and for a tag written by an API client with no session.
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  PRIMARY KEY (document_id, user_id)
);

-- The notifications panel asks one question — what has this person not read —
-- so the index answers exactly that and stays small as history accumulates.
CREATE INDEX document_mentions_unread_idx ON document_mentions (user_id, created_at DESC)
  WHERE read_at IS NULL;
