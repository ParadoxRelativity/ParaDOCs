-- A project can ask whoever moves work in the app to say why, in a comment
-- posted on the item with the move. Off until someone turns it on, and only
-- ever asked in the app: the API and AI connections move work without it.

ALTER TABLE projects ADD COLUMN ask_status_comment boolean NOT NULL DEFAULT false;
