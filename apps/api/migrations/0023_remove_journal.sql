-- The daily journal is gone. Its entries were ordinary documents with a date
-- attached, so they stay where they are, filed in the Journal folder, and are
-- simply pages now. Only the markers that made them journal entries go.
DROP INDEX documents_journal_unique;
ALTER TABLE documents
  DROP CONSTRAINT journal_needs_date,
  DROP COLUMN journal_date,
  DROP COLUMN is_journal;
