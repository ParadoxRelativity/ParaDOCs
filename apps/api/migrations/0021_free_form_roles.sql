-- A role can be free-form: as well as workspace members, it holds names typed
-- straight onto the item. A queue's Requester is usually a customer, and a
-- customer rarely has an account here — the name is all the queue needs.

ALTER TABLE project_roles ADD COLUMN free_form boolean NOT NULL DEFAULT false;

-- Which is what the Requester on every queue already is, so it starts that way.
UPDATE project_roles r
   SET free_form = true
  FROM projects p
 WHERE p.id = r.project_id AND p.kind = 'queue' AND lower(r.name) = 'requester';

-- A row now holds either a member or a typed name, never both and never
-- neither, so the primary key across the three columns gives way to one
-- partial unique index per kind of holder.
ALTER TABLE work_item_roles DROP CONSTRAINT work_item_roles_pkey;
ALTER TABLE work_item_roles ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE work_item_roles ADD COLUMN name text;
ALTER TABLE work_item_roles
  ADD CONSTRAINT work_item_roles_holder_ck CHECK ((user_id IS NULL) <> (name IS NULL));

CREATE UNIQUE INDEX work_item_roles_member_idx
  ON work_item_roles (work_item_id, role_id, user_id) WHERE user_id IS NOT NULL;
-- Names are matched the way role and status names are: one Acme Corp per role,
-- however it was capitalised the second time.
CREATE UNIQUE INDEX work_item_roles_name_idx
  ON work_item_roles (work_item_id, role_id, lower(name)) WHERE name IS NOT NULL;
