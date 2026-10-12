-- A role can be filled by whoever creates the item: the reporter of a project's
-- work, the requester of a queue's, and a watcher on both. The server fills it,
-- so work filed through the API or an AI connection gets it too, and the
-- creator hears about what happens to it without adding themselves.

ALTER TABLE project_roles ADD COLUMN fill_with_creator boolean NOT NULL DEFAULT false;

-- The web app filled a Reporter or Requester by its name until now, so the
-- roles it matched start that way, with Watcher beside them.
UPDATE project_roles
   SET fill_with_creator = true
 WHERE lower(name) IN ('reporter', 'requester', 'watcher');
