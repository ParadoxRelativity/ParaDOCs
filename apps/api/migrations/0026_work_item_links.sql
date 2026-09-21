-- Links between work items: one blocks another, duplicates it, caused it,
-- or is simply related to it.
--
-- A link is stored once, pointing one way: the source "blocks" the target,
-- and the target reads it the other way round as "is blocked by". A related-to
-- link reads the same both ways and is stored with the lesser id as source.
--
-- Two items can be linked in several ways, but only once in each: the unique
-- index ignores direction, so A blocking B and B blocking A cannot both be
-- said. Items in different projects of a workspace can be linked; each reader
-- is shown only the linked items they may see.

CREATE TABLE work_item_links (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  target_id  uuid NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('blocks', 'relates', 'duplicates', 'causes', 'clones')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_links_not_self_ck CHECK (source_id <> target_id)
);
CREATE UNIQUE INDEX work_item_links_pair_idx
  ON work_item_links (LEAST(source_id, target_id), GREATEST(source_id, target_id), type);
CREATE INDEX work_item_links_source_idx ON work_item_links (source_id);
CREATE INDEX work_item_links_target_idx ON work_item_links (target_id);
