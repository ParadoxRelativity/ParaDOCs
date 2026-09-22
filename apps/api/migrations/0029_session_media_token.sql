-- A second, narrower token per session, good only for reading uploaded files.
--
-- Files are served only to those who may see what they belong to. A browser
-- proves that with its session cookie, which goes along with every <img> and
-- <video> by itself. The mobile app signs in with a bearer token instead, which
-- a picture cannot send, so it puts this in the file's address. It reads files
-- and nothing else, and it ends with the session it belongs to.

ALTER TABLE sessions
  ADD COLUMN media_token text NOT NULL
  DEFAULT (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));

CREATE UNIQUE INDEX sessions_media_token_idx ON sessions (media_token);
