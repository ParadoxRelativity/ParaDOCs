-- Folder icons, optional like workspace icons. Folders previously rendered a
-- hardcoded emoji; with no icon set they now render none at all.
ALTER TABLE folders ADD COLUMN icon text;
