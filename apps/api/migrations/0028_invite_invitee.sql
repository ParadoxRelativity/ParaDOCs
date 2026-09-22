-- Which account an email invitation is for.
--
-- An address is not proof of anything: nobody confirms they own the address on
-- their account, and anyone could register one, or change theirs to one, that
-- an invitation was sent to. So an invitation is tied to the account that had
-- the address when it was sent, and only that account is shown it in the app.
-- An invitation to an address with no account yet stays unbound; it can only be
-- accepted through its link, which whoever sent it passes on themselves.

ALTER TABLE workspace_invites ADD COLUMN invitee_id uuid REFERENCES users(id) ON DELETE CASCADE;

-- Pending invitations go to whoever has the address now, as they were shown until today.
UPDATE workspace_invites i
   SET invitee_id = u.id
  FROM users u
 WHERE i.email IS NOT NULL
   AND i.accepted_at IS NULL
   AND lower(u.email) = lower(i.email);

CREATE INDEX workspace_invites_invitee_idx ON workspace_invites (invitee_id) WHERE invitee_id IS NOT NULL;
