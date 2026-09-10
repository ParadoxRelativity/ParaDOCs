-- Profile pictures for people and workspaces. Each holds a storage key under
-- the upload directory. A new picture is written under a new key rather than
-- over the old file, so a cached copy of the previous one is never served.
ALTER TABLE users ADD COLUMN avatar_key text;
ALTER TABLE workspaces ADD COLUMN avatar_key text;
