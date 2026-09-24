# Adding single sign-on providers

This guide sets up the common OpenID Connect providers for ParaDOCs sign-in:
Google, Microsoft Entra ID, Keycloak, Authentik, Authelia, Okta, Auth0, GitLab
and Zitadel. For how sign-in works, see "OIDC single sign-on" in the
[README](../README.md#oidc-single-sign-on).

Placeholders used below: `docs.example.com` is where people reach ParaDOCs,
and `<short name>` is the short name you give the provider on the admin page,
such as `google`.

## 1. Before you start

1. **Set `PUBLIC_URL`** in `.env` to the address people use, such as
   `https://docs.example.com`, then restart ParaDOCs. The redirect URI is built
   from it. Without it, the redirect URI comes from whatever address the admin
   page was opened at, and over an SSH tunnel that is `http://localhost:4001`,
   which is the wrong one.
2. **Open the server admin page** and go to **Single sign-on**. On a Docker
   deployment it is reached over SSH; see section 5 of
   [deploying-with-docker.md](deploying-with-docker.md#5-create-your-account).
3. **Pick a short name.** It becomes part of the redirect URI and cannot change
   later:

   ```
   https://docs.example.com/api/auth/oidc/<short name>/callback
   ```

   The admin page shows the exact URI with a copy button. Register it at the
   provider exactly as shown, with the same scheme, no trailing slash, and the
   same letter case.

Every provider below is set up the same way: register a client with the
provider, then fill in the ParaDOCs form:

| Field | What to enter |
| ----- | ------------- |
| Name | The button label: "Sign in with *Name*" |
| Short name | Lower-case letters, digits and hyphens, e.g. `google` |
| Issuer URL | The provider's issuer, listed for each provider below |
| Client ID / Client secret | From the provider. Leave the secret empty for a public client (PKCE only) |
| Scopes | `openid email profile` works for every provider here |
| New accounts | Who may get an account on first sign-in (see [Choosing who gets in](#choosing-who-gets-in)) |
| Allowed email domains | Optional. Limits sign-in to these domains |

When you save, ParaDOCs fetches `<issuer>/.well-known/openid-configuration`, so
a wrong issuer fails straight away. ParaDOCs checks that the issuer in that
document matches what you typed **character for character**, trailing slash
included. For providers whose issuer ends in `/` (Authentik and Auth0), type the
slash.

### What ParaDOCs needs from every provider

- **Authorization code flow** with PKCE (S256). Every provider here supports it.
- **Client authentication by `client_secret_post`**: the secret is sent in the
  request body, not in a Basic auth header. Most providers accept either one.
  Providers that make you choose (Authelia, Zitadel) are called out below.
- **An `email` claim**, in the ID token or from the userinfo endpoint. Without
  it nobody can be matched to an account or given one.
- **`email_verified: true`** (or Entra's `xms_edov: true`) to link or create
  an account by email. When it is missing or false, the provider can only sign
  in accounts already linked to it, unless you turn on **Trust this provider's
  email addresses**.

## 2. Providers

### Google

Issuer: `https://accounts.google.com`

1. In the [Google Cloud console](https://console.cloud.google.com/), pick or
   create a project.
2. **APIs & Services → OAuth consent screen**: choose **Internal** if everyone
   is in your Google Workspace, otherwise **External**. An External app starts
   in *Testing*, which lets only listed test users sign in. **Publish** it when
   you are ready. The `openid email profile` scopes do not need Google's
   verification.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   type **Web application**.
4. Under **Authorized redirect URIs**, add the ParaDOCs redirect URI.
5. Copy the client ID and client secret into ParaDOCs.

Google sends `email_verified`, so no extra setup is needed. To limit sign-in to
your Workspace, enter your domain under **Allowed email domains**. A personal
Gmail account is then refused, even with an External consent screen.

### Microsoft Entra ID (Azure AD, Microsoft 365)

Issuer: `https://login.microsoftonline.com/<tenant id>/v2.0`

Use the tenant ID (a GUID, on the tenant's **Overview** page), not `common` or
`organizations`. The discovery document for those gives a placeholder issuer
that no real token matches, so saving fails. Sign-in from other tenants is not
supported.

1. In the [Entra admin center](https://entra.microsoft.com/), go to
   **Applications → App registrations → New registration**.
2. **Supported account types**: *Accounts in this organizational directory only*.
3. **Redirect URI**: platform **Web**, then the ParaDOCs redirect URI.
4. After it is created, copy the **Application (client) ID**.
5. **Certificates & secrets → New client secret**. Copy the **Value** (not the
   Secret ID) into ParaDOCs. Secrets expire, after at most 24 months, so note
   when it needs renewing and enter the new one on the admin page before then.
6. **API permissions**: the default *Microsoft Graph → User.Read* is enough.
   `openid`, `email` and `profile` are requested at sign-in.

**Entra never sends `email_verified`.** Unless you do one of the following, it
can sign in only accounts that are already linked to it, and it cannot create
accounts or link them by email:

- **Recommended:** **Token configuration → Add optional claim → ID**, then tick
  `email` and `xms_edov`. When the tenant has verified the domain of a user's
  email, Entra sends `xms_edov: true`, which ParaDOCs counts as a verified
  email.
- Or, in ParaDOCs, set **Allowed email domains** to the domains your tenant owns
  and turn on **Trust this provider's email addresses**. Do this only with a
  single-tenant issuer. Entra lets the `email` claim hold addresses the
  tenant does not own, such as for guest accounts, so the allowed domains are
  the only safeguard.

Users also need an email address on their Entra account (the **Mail**
attribute). Accounts without one are refused with "the provider did not share an
email address".

### Keycloak

Issuer: `https://keycloak.example.com/realms/<realm>`

Keycloak before version 17 has `/auth` in the path:
`https://keycloak.example.com/auth/realms/<realm>`.

1. In the realm, go to **Clients → Create client**, type **OpenID Connect**, and
   enter a client ID such as `paradocs`.
2. **Capability config**: turn on **Client authentication** and keep
   **Standard flow** on. Direct access grants can stay off.
3. **Login settings**: add the ParaDOCs redirect URI under **Valid redirect
   URIs**, and `https://docs.example.com` under **Web origins**.
4. Copy the secret from the **Credentials** tab.

For a public client, turn **Client authentication** off and leave the secret
empty in ParaDOCs. Under **Advanced → Proof Key for Code Exchange Code
Challenge Method**, choose `S256`.

Keycloak sends `email_verified` from each user's **Email verified** switch.
Users you create by hand have it off unless you turn it on, or unless they
verify their address through a required action. Until then they can sign in
only to accounts that are already linked.

### Authentik

Issuer: `https://authentik.example.com/application/o/<application slug>/`
(with the trailing slash)

1. **Applications → Applications → Create with provider** (or create the
   provider and the application separately).
2. Provider type **OAuth2/OpenID Provider**, **Client type** *Confidential*.
3. **Redirect URIs**: add the ParaDOCs redirect URI with matching mode *Strict*.
4. **Signing key**: pick a certificate, such as the built-in
   *authentik Self-signed Certificate*, so ID tokens are signed with RS256.
5. Keep the default scope mappings (`openid`, `email`, `profile`).
6. Copy the client ID and secret. The application's slug is part of the
   issuer, and the provider's page shows the full **OpenID Configuration
   Issuer**.

Check what the `email` scope mapping sends for `email_verified`. Recent Authentik
versions do not always send `true`. If it arrives as false, either change the
mapping to return `"email_verified": True` for users whose addresses you trust,
or set allowed domains and turn on **Trust this provider's email addresses** in
ParaDOCs.

### Authelia

Issuer: `https://auth.example.com`

Authelia clients are defined in its configuration file. Authelia requires the
authentication method to match exactly, so set `client_secret_post`:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: paradocs
        client_name: ParaDOCs
        # Generate with: authelia crypto hash generate pbkdf2 --random
        client_secret: '$pbkdf2-sha512$310000$...'
        public: false
        authorization_policy: two_factor
        require_pkce: true
        pkce_challenge_method: S256
        redirect_uris:
          - https://docs.example.com/api/auth/oidc/authelia/callback
        scopes: [openid, email, profile]
        response_types: [code]
        grant_types: [authorization_code]
        token_endpoint_auth_method: client_secret_post
```

Enter the **plain** secret in ParaDOCs, not the hash. Authelia sends
`email_verified` for its users.

### Okta

Issuer: `https://<your org>.okta.com` for the org authorization server, or
`https://<your org>.okta.com/oauth2/default` for the default custom one. Pick
one and keep it. Accounts are linked per issuer, so switching later unlinks
everyone.

1. **Applications → Create App Integration**, **OIDC - OpenID Connect**,
   application type **Web Application**.
2. **Grant type**: *Authorization Code*.
3. **Sign-in redirect URIs**: the ParaDOCs redirect URI. **Sign-out redirect
   URIs** can be left empty.
4. **Assignments**: assign the people or groups who may sign in. Okta refuses
   anyone who is not assigned.
5. Copy the client ID and client secret from the **General** tab.

Okta sends `email_verified`.

### Auth0

Issuer: `https://<tenant>.<region>.auth0.com/` (with the trailing slash), or
your custom domain with a trailing slash.

1. **Applications → Create Application**, type **Regular Web Applications**.
2. **Settings → Allowed Callback URLs**: the ParaDOCs redirect URI.
3. **Credentials → Authentication Method**: *Client Secret (Post)*. This is
   the default for regular web applications.
4. Copy the **Domain**, **Client ID** and **Client Secret**. The issuer is
   `https://` + Domain + `/`.

Auth0 sends `email_verified`. With database connections it stays false until the
user clicks the verification email.

### GitLab (gitlab.com or self-managed)

Issuer: `https://gitlab.com`, or your instance's address, such as
`https://gitlab.example.com`

1. Create an application under **User settings → Applications**, a group's
   **Settings → Applications**, or for a self-managed instance, **Admin →
   Applications**.
2. **Redirect URI**: the ParaDOCs redirect URI.
3. Tick **Confidential** and the scopes `openid`, `email` and `profile`.
4. Copy the **Application ID** (the client ID) and the **Secret**.

GitLab sends `email_verified` for the account's primary email.

GitHub is **not** supported directly. It offers OAuth 2.0 but not OpenID
Connect sign-in. To use GitHub accounts, add GitHub as a source in Keycloak,
Authentik, Zitadel or Dex, and point ParaDOCs at that provider instead. Apple
and Facebook are not supported either.

### Zitadel

Issuer: `https://<instance>.zitadel.cloud`, or your self-hosted domain

1. In a project, **New → Application**, type **Web**.
2. **Authentication method**: **POST** (client secret), or **PKCE** for a public
   client with no secret. Do not choose *CODE*: it sends the secret in a Basic
   auth header, which ParaDOCs does not use.
3. **Redirect URIs**: the ParaDOCs redirect URI. On a self-hosted instance
   with a plain-HTTP address, turn on **Development mode**.
4. Copy the client ID, and for POST, the client secret.

Zitadel leaves profile claims out of the ID token by default. ParaDOCs fetches
them from the userinfo endpoint instead, so no setting needs changing. Emails
verified in Zitadel are sent with `email_verified: true`.

### Any other provider

Any provider with OpenID Connect discovery works. You need:

- an issuer that serves `/.well-known/openid-configuration`,
- a confidential client using `client_secret_post` or a public client using
  PKCE,
- the ParaDOCs redirect URI registered exactly,
- an `email` claim, and ideally `email_verified`.

An issuer on plain `http://` is accepted, such as a provider on the same
private network. Use HTTPS for anything reachable from the internet.

## 3. Choosing who gets in

When someone signs in for the first time, **New accounts** decides whether they
get an account:

| Setting | Use it for |
| ------- | ---------- |
| Follow the registration setting | The default. New accounts only while registration is open |
| Always, even with registration closed | Your own identity provider (Entra, Okta, Keycloak and so on), which already decides who is allowed in |
| Never | Only people who already have a ParaDOCs account |

Do **not** combine *Always* with a public provider such as Google or gitlab.com
unless you also set **Allowed email domains**. Otherwise anyone with a Google
account gets an account.

Existing password accounts are linked the first time their owner signs in with
single sign-on, as long as the provider confirms the same email address. After
that, the link is to the provider's subject ID, so it survives email changes.

## 4. Setting a provider in the environment instead

You can also give one provider in `.env` instead of on the admin page. The
admin page then shows it read-only. This example is for Keycloak:

```sh
PUBLIC_URL=https://docs.example.com
OIDC_ENABLED=true
OIDC_PROVIDER_NAME=Keycloak
OIDC_SLUG=keycloak
OIDC_ISSUER=https://keycloak.example.com/realms/example
OIDC_CLIENT_ID=paradocs
OIDC_CLIENT_SECRET=...
OIDC_SCOPES=openid email profile
OIDC_NEW_ACCOUNTS=always
OIDC_ALLOWED_DOMAINS=example.com
OIDC_TRUST_EMAILS=false
```

The redirect URI is then
`https://docs.example.com/api/auth/oidc/keycloak/callback`. Leave
`OIDC_REDIRECT_URI` empty unless you need to override it.

## 5. Troubleshooting

The person signing in sees a short reason. The quoted messages below are from
the server log (`docker compose logs app`), which also names the account and
the provider.

| Symptom | Likely cause |
| ------- | ------------ |
| Saving fails with a discovery or issuer error | Wrong issuer URL. Check the trailing slash (needed for Authentik and Auth0, not for the others), the realm or tenant in the path, and that the ParaDOCs server can reach the provider over the network |
| The provider says the redirect URI is invalid or doesn't match | The URI registered at the provider differs from the one on the admin page. Check `PUBLIC_URL`, `http` vs `https`, the port, and the short name |
| `invalid_client` after signing in at the provider | Wrong secret, a secret that has expired (Entra), or the provider expects Basic auth. Set it to `client_secret_post` |
| "the provider did not share an email address" | The `email` scope is missing, or the user has no email at the provider (the Entra **Mail** attribute) |
| "the provider has not verified …" | No `email_verified: true`. See the notes for that provider, or use allowed domains and trust its emails |
| "… is outside the provider's allowed domains" | The user's email domain is not in **Allowed email domains** |
| "no account for …, and the provider may not make one" | **New accounts** is *Never*, or it follows registration and registration is closed |
| After changing `SESSION_SECRET`, sign-in fails saying the client secret can't be read | Client secrets are encrypted with a key derived from `SESSION_SECRET`. Enter them again on the admin page |
| Everyone has to link their account again | The issuer URL changed (for example, Okta org to `/oauth2/default`). Accounts are linked per issuer. Change it back |

If password sign-in is turned off and a provider breaks, the admin page still
takes a password, so you can sign in there and turn password sign-in back on
under **Server settings**.
