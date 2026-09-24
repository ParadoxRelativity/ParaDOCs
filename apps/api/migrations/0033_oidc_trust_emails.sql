-- Some providers never say whether an email is verified: Microsoft Entra ID
-- sends no email_verified claim. With this on, a provider's emails are taken
-- as verified, so they can link to and create accounts. It is only allowed
-- together with allowed_domains (enforced by the API), so a provider can never
-- vouch for an address outside the domains its operator controls.
ALTER TABLE oidc_providers ADD COLUMN trust_emails boolean NOT NULL DEFAULT false;
