-- A role can be filled from a schedule: whoever is on it when an item is filed
-- is put in the role, as a queue's on-call assignee and an escalation role
-- beside it each follow their own rotation. The server fills it, so work that
-- comes in through the API, an AI connection or an intake form gets it too.
--
-- A schedule that is deleted leaves the role as an ordinary one.

ALTER TABLE project_roles ADD COLUMN fill_from_schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL;
CREATE INDEX project_roles_schedule_idx ON project_roles (fill_from_schedule_id) WHERE fill_from_schedule_id IS NOT NULL;
