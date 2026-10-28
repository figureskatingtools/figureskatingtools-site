# Entra External ID — the hand-configured tenant

The site signs in through a Microsoft Entra **External ID** (customer) tenant,
the only sign-in since the move from the workforce tenant (2026-10). Nothing
inside that tenant is IaC: the ARM type for the directory is preview-only and
not idempotent, and user flows, branding, apps and groups have no Bicep surface
anyway. This runbook is the
record of every hand step, so the setup stays reproducible.

Code owns everything **outside** the tenant: the Easy Auth configuration
(`modules/webapp.bicep`, credential-free), `ALLOWED_TENANT_IDS`, the router's
claim handling (`server/server.js`), the platform's `migration_pending` switch
(`functions/function_app.py`), and the Front Door route + DNS for the custom URL
domain `login.figureskatingtools.com` (`azure-publishing`). The tenant and app
ids reach code as GitHub vars (below).

Phases: A = this directory (done by hand), B = code readiness, C = migration
(existing users linked by hand, prod switched 2026-10-27), D = the workforce
sign-in removed (see [Workforce clean-up](#workforce-clean-up-phase-d)).

## How Easy Auth reaches the tenant

There is **one** Easy Auth provider, the built-in Microsoft one
(`azureActiveDirectory`, URL segment `aad`):

| Client id | Issuer | Credential |
| --- | --- | --- |
| `AUTH_EXTERNAL_CLIENT_ID` | `https://<AUTH_EXTERNAL_AUTHORITY_HOST>/<EXTERNAL_TENANT_ID>/v2.0` | **none** |

`allowedAudiences` is that client id, and `loginParameters` asks for
`scope=openid profile email` so the `email` claim arrives. The router's
`/signin` sends users to `/.auth/login/aad` (`AUTH_LOGIN_PROVIDER=aad`). Only
members of `fst-test-access` get into test, see
[Access gate](#access-gate-the-siteaccess-app-role).

**Why there is no custom OIDC provider.** Phase B first added a second provider,
custom OIDC `externalid`, without a `clientCredential`. ARM accepted it, but
Easy Auth's custom OIDC provider always starts the **authorization code flow**
(`response_type=code`, no `form_post`), and redeeming that code needs a client
secret. The built-in Microsoft provider is the one that falls back to the
ID-token flow when it has no secret, so External ID goes through that one.

## The rule: never add a secret to the site apps

The two External ID site app registrations have **no client secret, no
certificate and no federated credential, ever**, and `webapp.bicep` sets no
`clientSecretSettingName`. Do not "fix" a sign-in problem
by adding one.

Why this is enough:

- An app needs a credential only to redeem an authorization code for access or
  refresh tokens. The site uses neither: `tokenStore` is off and nothing calls a
  downstream API. The only thing Easy Auth needs is the **ID token**.
- Without a credential Easy Auth's Microsoft provider runs the OIDC
  **ID-token flow** (`response_type=id_token`, `response_mode=form_post` to
  `/.auth/login/aad/callback`) and validates the signature, `iss`, `aud` (our
  client id) and the nonce itself.
- The managed-identity FIC the former workforce sign-in used can't work here:
  App Service supports it for workforce configurations only, and Entra tokens
  can't be federated into another tenant's app. Azure/M365 Lighthouse don't take part in sign-ins at all.
- No secret means nothing to leak, rotate or expire on the site side.

## Tenant

| | |
| --- | --- |
| Name | `figureskatingtools.onmicrosoft.com` (Finland/Europe region) |
| Tenant id | `380073b3-804e-4cc7-bfcc-843637630d04` |
| Resource | in the persistent RG `rg-fs-identity` (like `rg-fs-dns`, never torn down); billed per MAU via the existing subscription |
| Authority host | `login.figureskatingtools.com` (custom URL domain through Front Door; `380073b3-804e-4cc7-bfcc-843637630d04.ciamlogin.com` works too) |
| Metadata | `https://<host>/380073b3-804e-4cc7-bfcc-843637630d04/v2.0/.well-known/openid-configuration` |
| Issuer | `https://380073b3-804e-4cc7-bfcc-843637630d04.ciamlogin.com/380073b3-804e-4cc7-bfcc-843637630d04/v2.0` |

- **The primary domain must stay `figureskatingtools.onmicrosoft.com`.** Making
  `login.figureskatingtools.com` primary broke the user flow's *Run user flow*
  with `AADSTS500210`.
- `login.figureskatingtools.com` must stay listed under **Custom URL domains**
  (else `AADSTS399280`). Don't use `login.ciamlogin.com` as the authority.
- Admins: the creating workforce account is Global Admin, plus a cloud-only
  break-glass GA. Directory admins are separate from customer identities: the
  owner uses the site with a self-signed-up account, which is in the
  `fst-admins` group (site admin = the `Site.Admin` app role, see
  [Admins](#admins-the-siteadmin-app-role)).

## App registrations (single tenant)

| Env | Name | Client id | Redirect URI |
| --- | --- | --- | --- |
| test | `figureskatingtools-test` | `16c69665-3430-42b5-a789-f27bcb21f718` | `https://test.figureskatingtools.com/.auth/login/aad/callback` |
| prod | `figureskatingtools` | `177abce3-dc07-4c94-b217-22c084f47481` | `https://figureskatingtools.com/.auth/login/aad/callback` |

The redirect URI is the **`/.auth/login/aad/callback`** of the built-in provider.
The earlier `/.auth/login/externalid/callback` entries (from the dropped custom
OIDC provider) can be removed.

- Authentication: Web platform, exact `https` redirect URIs only; implicit/hybrid
  **"ID tokens" ticked, "Access tokens" never**.
- Certificates & secrets: **empty**, permanently (see the rule above). An
  app-management policy in the tenant may enforce it.
- App role **`Site.Access`** on both, assigned to `fst-test-access` (test) and
  to the prod access group (prod). Enterprise application → **Assignment required = No** on both, *after*
  the access gate is deployed; see [Access gate](#access-gate-the-siteaccess-app-role).
- Both apps are associated with the one user flow below.
- Manifest: `acceptMappedClaims: true` (needed for the mapped `termsAccepted`
  claim, since there is no custom signing key).

## Access gate: the `Site.Access` app role

Who may use the site is an **app role**, not Entra's "Assignment required":
with assignment required, everyone else ends on Entra's AADSTS50105 error
page, which can't be customised. Instead:

- Each External ID app has the app role `Site.Access`, assigned to the people
  (or group) who may use the site. Entra puts it in the ID token's `roles` claim.
- **Assignment required = No**, so anyone can finish signing in.
- The router (`EXTERNAL_ACCESS_ROLE`, default `Site.Access`; GitHub var
  `EXTERNAL_ACCESS_ROLE` overrides) requires the role of every identity of an
  `EXTERNAL_TENANT_IDS` tenant. Without it: documents 302 to the public
  **`/no-access/`** page ("Sign-in successful … you don't have access yet,
  contact …", English, with a mailto and Sign out), `/userinfo` is 403
  `access_not_granted` with just the name and e-mail, and every API and
  `/admin/*` is 403 `access_not_granted`, never proxied. Admins get no
  exception. Identities of other allowed tenants are unaffected.

**Order matters** (tenant side, by hand):

1. Add the app role to both apps (manifest below) and assign it: test → the
   group `fst-test-access`, prod → the owner only.
2. Deploy this code to the environment (the gate must be live first).
3. Only then set **Assignment required = No** on that enterprise app. Before
   step 2 it would let everyone in.

Manifest snippet (App registrations → the app → Manifest → `appRoles`; generate
a fresh GUID for `id`):

```json
"appRoles": [
  {
    "allowedMemberTypes": ["User"],
    "description": "May use figureskatingtools.com",
    "displayName": "Site access",
    "id": "<new GUID, e.g. from uuidgen>",
    "isEnabled": true,
    "value": "Site.Access"
  }
]
```

Assigning a **group** to the role may not be offered in the external tenant's
portal; do it with Microsoft Graph instead (signed in to the external tenant):

```bash
TENANT=380073b3-804e-4cc7-bfcc-843637630d04
APP_ID=16c69665-3430-42b5-a789-f27bcb21f718          # prod: 177abce3-dc07-4c94-b217-22c084f47481
az login --tenant "$TENANT" --allow-no-subscriptions
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
ROLE_ID=$(az ad sp show --id "$APP_ID" --query "appRoles[?value=='Site.Access'].id | [0]" -o tsv)
GROUP_ID=$(az ad group show --group fst-test-access --query id -o tsv)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
  --headers 'Content-Type=application/json' \
  --body "{\"principalId\":\"$GROUP_ID\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"$ROLE_ID\"}"
```

For a single user, use the user's object id as `principalId`.

## Admins: the `Site.Admin` app role

Site admins (the `/admin/` panel and `/api/manage/*`) are whoever carries the
app role **`Site.Admin`** (`ADMIN_ROLE` overrides the name). There is no admin
e-mail list and no break-glass e-mail: `ADMIN_EMAILS` is gone. The router reads
the role from the ID token's `roles` claim and tells the platform with `X-Forwarded-User-Admin: 1`. `Site.Admin` implies
`Site.Access`, so admins need no second assignment.

It is defined on both External ID apps (test `16c69665-…`, prod `177abce3-…`)
and assigned to the group **`fst-admins`** (the owner's customer account).

Manifest snippet for `appRoles` (next to `Site.Access`). Generate a fresh GUID
for `id`:

```json
{
  "allowedMemberTypes": ["User"],
  "description": "Administers figureskatingtools.com",
  "displayName": "Site admin",
  "id": "<new GUID, e.g. from uuidgen>",
  "isEnabled": true,
  "value": "Site.Admin"
}
```

Group assignment in the external tenant, with Graph (as for `Site.Access`):

```bash
TENANT=380073b3-804e-4cc7-bfcc-843637630d04
APP_ID=16c69665-3430-42b5-a789-f27bcb21f718          # prod: 177abce3-dc07-4c94-b217-22c084f47481
az login --tenant "$TENANT" --allow-no-subscriptions
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
ROLE_ID=$(az ad sp show --id "$APP_ID" --query "appRoles[?value=='Site.Admin'].id | [0]" -o tsv)
GROUP_ID=$(az ad group show --group fst-admins --query id -o tsv)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
  --headers 'Content-Type=application/json' \
  --body "{\"principalId\":\"$GROUP_ID\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"$ROLE_ID\"}"
```

## User flow (sign-up and sign-in, shared by both apps)

Identity providers — only ones that give a **verified e-mail**, because phase C
links accounts by e-mail:

- **Email one-time passcode** (local accounts).
- **Google** (built-in provider; its OAuth client id + secret live only in the
  tenant's provider config).
- **Personal Microsoft account** as a custom OIDC provider: metadata from the
  `consumers` endpoint (`https://login.microsoftonline.com/consumers/v2.0/.well-known/openid-configuration`),
  issuer `https://login.live.com`, scopes `openid profile email`, backed by
  its **own** app registration (personal accounts only). Its client secret is
  stored only in the tenant's identity-provider config, never in GitHub or the
  site.

User attributes collected at sign-up:

- Display Name, Given Name, Surname.
- Custom Boolean **`TermsAccepted`**, **required**, shown as a checkbox whose
  label reads `I have read and agree to the [terms of use](https://figureskatingtools.com/terms/)
  and the [privacy notice](https://figureskatingtools.com/privacy/)`. The user
  flow is English only (no language overrides). Conditional Access "Terms of use" isn't
  available in external tenants, hence the checkbox. The claim is not versioned,
  so the platform records the version: the router forwards the claim as
  `X-Forwarded-User-Terms-Accepted: 1`, and the platform writes `TermsVersion`,
  `PrivacyVersion` and `TermsAcceptedUtc` on the `users` row the first time it
  sees it (never overwritten; nobody is refused without it).
  `terms_outdated()` is the check a later re-acceptance step will use.

Token claims (ID token): `tid`, `oid`, `email`, `name`, and **`termsAccepted`**
— added under the enterprise app's **Single sign-on → Attributes & Claims** as a
mapping of the `TermsAccepted` extension attribute (requires
`acceptMappedClaims: true` in the app manifest). The platform will require the
claim for external identities in phase C.

## Branding (Company branding)

The sign-in and sign-up pages wear the landing page's look: the greyscale
judges'-papers photo under the ink-to-rink shade, a white card with the FSTools
wordmark, a gold pill **Next** button, and links to the privacy notice, the
Finnish notice and the terms. The kit is in [`branding/`](branding/): the images
(each inside Microsoft's size limit), `custom.css` (colour and style only, none of
the layout properties Microsoft is retiring) and `make_assets.py`, which rebuilds
the images from `site/public`. [`branding/README.md`](branding/README.md) lists
every value per Company branding tab (Basics, Layout, Header, Footer, Sign-in
form, Text) plus Tenant properties › Name `figureskatingtools.com`. Applied
2026-10-23. One tenant serves test and prod, so a change shows on both sign-in
pages at once.

- The personal Microsoft account button shows a generic blue circle: External ID
  has no icon setting for custom OIDC providers. Its display name is kept short,
  `Microsoft account`, because a longer one wraps onto two lines.
- The sign-in page can't load the site's web fonts; `custom.css` falls back to
  Georgia and the system UI font.

## Conditional Access

- Customer MFA: **off** (the sign-in methods are the customers' own providers /
  e-mail OTP).
- MFA for every admin directory role: **on**.
- The break-glass account is excluded from every policy.

## Why not (yet)

- **No Entra work-account federation.** Every organisation's tenant would be a
  separate federation to set up and maintain, and its e-mail claim must be
  verified for the phase C linking. People with a work address sign in with
  e-mail OTP on that address instead. Revisit on demand.
- **No native passkeys yet.** Deferred: they are not part of the user flow
  today. Google and Microsoft accounts already offer passkeys on their side, and
  e-mail OTP covers everyone else.

## Secret rotation reminders (tenant-side only)

The only secrets in the whole setup belong to the **upstream identity
providers**, not to the site:

- Google OAuth client secret (in the tenant's Google provider config).
- The personal-Microsoft-account app's client secret (in the custom OIDC
  provider config).

Create both with **at most 24 months** validity, put a calendar reminder a
month before expiry, and rotate by adding the new secret to the tenant's
provider config first, then deleting the old one.

## GitHub configuration (per environment)

| Variable | test | prod |
| --- | --- | --- |
| `EXTERNAL_TENANT_ID` | `380073b3-804e-4cc7-bfcc-843637630d04` | same |
| `AUTH_EXTERNAL_CLIENT_ID` | `16c69665-3430-42b5-a789-f27bcb21f718` | `177abce3-dc07-4c94-b217-22c084f47481` |
| `AUTH_EXTERNAL_AUTHORITY_HOST` | `login.figureskatingtools.com` | same |
| `ALLOWED_TENANT_IDS` | unset (the External ID tenant only) | unset (same) |
| `AUTH_LOGIN_PROVIDER` | unset (`aad`) | unset (`aad`) |
| `EXTERNAL_ACCESS_ROLE` | unset (`Site.Access`) | unset (`Site.Access`) |
| `EXTERNAL_NEW_USERS_ENABLED` | unset (`true`: new users are created) | unset (`true`) |
| `ADMIN_ROLE` | unset (`Site.Admin`) | unset (`Site.Admin`) |

Variables only — there is no External ID secret to configure. `deploy-site.yml`:

- refuses to deploy without both `EXTERNAL_TENANT_ID` and
  `AUTH_EXTERNAL_CLIENT_ID` (and `webapp.bicep` refuses an empty one);
- adds the tenant to `ALLOWED_TENANT_IDS` (always allowed; the variable only
  adds other tenants) for the router and the platform, and writes it to both as
  `EXTERNAL_TENANT_IDS`:
  - the router takes those identities' e-mail **only** from the `email` claim
    (their `preferred_username` / principal name need not be an e-mail), and
    requires the `EXTERNAL_ACCESS_ROLE` app role of them (else `/no-access/`);
  - the platform answers a new identity of that tenant with **503
    `migration_pending`** and creates no user when `EXTERNAL_NEW_USERS_ENABLED`
    is `false` (the switch for linking users by hand first); by default it
    becomes a new user with `Provider` `entra-external`, with no legacy e-mail
    claim;
- shows the External ID tenant count in the admin Diagnostics tab.

The redirect URIs of the External ID apps are kept by hand (no Graph step).

## Checks after a deploy

```bash
# 302 to the login.figureskatingtools.com authorize endpoint with
# response_type=id_token, response_mode=form_post and the external client_id
curl -s -o /dev/null -w '%{redirect_url}\n' https://test.figureskatingtools.com/.auth/login/aad
# no credential in the deployed config
az webapp auth show -g rg-fs-site-test -n <app> \
  --query 'properties.identityProviders.azureActiveDirectory.registration'
```

## Workforce clean-up (phase D)

The workforce sign-in (the workforce app registrations, the managed-identity
federated credential and the deploy workflow's Graph step) is gone from the code:
`webapp.bicep` configures only External ID and sets the Web App's identity to
`None`, and `ALLOWED_TENANT_IDS` no longer includes the workforce tenant. Left
over by hand, **after** that code is in prod (there is no rollback to the
workforce sign-in afterwards):

1. GitHub: delete the secrets `AUTH_CLIENT_ID` and `AUTH_APP_OBJECT_ID` (test and
   prod) and the variable `AUTH_TENANT_MODE` (test and prod). Nothing reads them.
2. Azure: delete the user-assigned managed identities `mi-fs-site-auth-*` in
   `rg-fs-site-prod` and `rg-fs-site-test` (Bicep never deletes resources).
3. Workforce tenant: delete the two Easy Auth app registrations of test and prod
   (their enterprise apps, `Site.Admin` assignments, federated credentials and
   the deploy principal's ownership go with them); groups and Conditional
   Access policies that only served them; any Graph permission the deploy
   principal held only for the removed step (check the tool repos don't use it).
4. Optional: the platform's `useridentities` rows with `Provider` `entra` (the
   workforce identities). Nobody can sign in with them any more; they are kept
   as history otherwise.
