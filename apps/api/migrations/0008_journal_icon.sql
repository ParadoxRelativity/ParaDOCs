-- Journals were created with a hardcoded emoji. Stored on the document, it
-- reads as an icon someone chose and outranks the client's own journal glyph,
-- so clear it. A journal whose icon was since changed by hand keeps it.
UPDATE documents SET icon = NULL WHERE is_journal AND icon = '📔';
