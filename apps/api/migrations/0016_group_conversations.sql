-- Group conversations: a direct conversation started with more than one other
-- person. A group can be renamed, have people added and removed, and be left.
--
-- It stays a group however many people are left in it, so two people remaining
-- in one never turns it into their private conversation, with other people's
-- history in it.
ALTER TABLE channels ADD COLUMN direct_group boolean NOT NULL DEFAULT false;

UPDATE channels c
   SET direct_group = true
 WHERE c.kind = 'direct'
   AND (SELECT count(*) FROM channel_members m WHERE m.channel_id = c.id) > 2;

-- A group's key is marked as one, so a group that shrinks to two people can
-- never claim the key of those two people's own conversation.
UPDATE channels SET dm_key = 'group:' || dm_key WHERE direct_group AND dm_key IS NOT NULL;
