-- Which single sign-on provider made an account, by issuer as auth_identities
-- keeps it, so the admin page can tell those accounts from the rest. Null for
-- an account made by registering or on the admin page, including one that
-- single sign-on only linked to later.
ALTER TABLE users ADD COLUMN created_by_issuer text;

-- An account single sign-on made was linked in the same transaction, so its
-- identity carries the very same now() as the account.
UPDATE users u
   SET created_by_issuer = i.provider
  FROM auth_identities i
 WHERE i.user_id = u.id AND i.created_at = u.created_at;
