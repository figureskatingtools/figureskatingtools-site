# Entra External ID — the hand-configured tenant

The site is moving its sign-in from the **workforce** tenant to a Microsoft
Entra **External ID** (customer) tenant. Nothing inside that tenant is IaC: the
ARM type for the directory is preview-only and not idempotent, and user flows,
branding, apps and groups have no Bicep surface anyway. This runbook is the
record of every hand step, so the setup stays reproducible.

Code owns everything **outside** the tenant: the Easy Auth configuration
(`modules/webapp.bicep`, credential-free in external mode), `ALLOWED_TENANT_IDS`,
the router's claim handling (`server/server.js`), the platform's
`migration_pending` gate (`functions/function_app.py`), and later the Front Door
route + DNS for the custom URL domain (`azure-publishing`). The tenant and app
ids reach code as GitHub vars (below).

Phases: A = this directory (done by hand), **B = code readiness** (this repo:
test signs in through External ID, prod stays workforce), C = migration (link
external identities to existing users by verified e-mail, then switch prod).

## How Easy Auth reaches the tenant: one provider, two modes

There is **one** Easy Auth provider, the built-in Microsoft one
(`azureActiveDirectory`, URL segment `aad`). The GitHub var
**`AUTH_TENANT_MODE`** decides which tenant it signs in with:

| Mode | Client id | Issuer | Credential |
| --- | --- | --- | --- |
| `workforce` (default) | `AUTH_CLIENT_ID` (workforce app) | `https://login.microsoftonline.com/<workforce tenant>/v2.0` | MI federated credential (`OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID`) |
| `external` | `AUTH_EXTERNAL_CLIENT_ID` | `https://<AUTH_EXTERNAL_AUTHORITY_HOST>/<EXTERNAL_TENANT_ID>/v2.0` | **none** |

In external mode `allowedAudiences` is the external client id, and
`loginParameters` asks for `scope=openid profile email` so the `email` claim
arrives. `/signin`, `/.auth/login/aad` and `AUTH_LOGIN_PROVIDER=aad` are the same
in both modes, so the frontends never notice.

- **test** runs `external` (only members of `fst-test-access` get in, see
  [Access gate](#access-gate-the-siteaccess-app-role)).
- **prod** stays `workforce` until phase C goes live. Go-live is one var
  (`AUTH_TENANT_MODE=external`) plus a redeploy; the rollback is setting it back
  to `workforce` and redeploying.
- `EXTERNAL_TENANT_ID` is in the effective `ALLOWED_TENANT_IDS` in **both** modes,
  so sessions the other tenant issued before a switch keep working until they
  expire.

**Why there is no custom OIDC provider.** Phase B first added a second provider,
custom OIDC `externalid`, without a `clientCredential`. ARM accepted it, but
Easy Auth's custom OIDC provider always starts the **authorization code flow**
(`response_type=code`, no `form_post`), and redeeming that code needs a client
secret. The built-in Microsoft provider is the one that falls back to the
ID-token flow when it has no secret, so External ID goes through that one.

## The rule: never add a secret to the site apps

The two External ID site app registrations have **no client secret, no
certificate and no federated credential, ever**, and in external mode
`webapp.bicep` sets no `clientSecretSettingName`. Do not "fix" a sign-in problem
by adding one.

Why this is enough:

- An app needs a credential only to redeem an authorization code for access or
  refresh tokens. The site uses neither: `tokenStore` is off and nothing calls a
  downstream API. The only thing Easy Auth needs is the **ID token**.
- Without a credential Easy Auth's Microsoft provider runs the OIDC
  **ID-token flow** (`response_type=id_token`, `response_mode=form_post` to
  `/.auth/login/aad/callback`) and validates the signature, `iss`, `aud` (our
  client id) and the nonce itself.
- The workforce managed-identity FIC can't be reused: App Service supports it
  for workforce configurations only, and Entra tokens can't be federated into
  another tenant's app. Azure/M365 Lighthouse don't take part in sign-ins at all.
- No secret means nothing to leak, rotate or expire on the site side.

## Tenant

| | |
| --- | --- |
| Name | `figureskatingtools.onmicrosoft.com` (Finland/Europe region) |
| Tenant id | `380073b3-804e-4cc7-bfcc-843637630d04` |
| Resource | in the persistent RG `rg-fs-identity` (like `rg-fs-dns`, never torn down); billed per MAU via the existing subscription |
| Authority host (now) | `380073b3-804e-4cc7-bfcc-843637630d04.ciamlogin.com` |
| Metadata | `https://<host>/380073b3-804e-4cc7-bfcc-843637630d04/v2.0/.well-known/openid-configuration` |
| Issuer | `https://380073b3-804e-4cc7-bfcc-843637630d04.ciamlogin.com/380073b3-804e-4cc7-bfcc-843637630d04/v2.0` |

- **The primary domain must stay `figureskatingtools.onmicrosoft.com`.** Making
  `login.figureskatingtools.com` primary broke the user flow's *Run user flow*
  with `AADSTS500210`.
- Don't use `login.ciamlogin.com` or `login.figureskatingtools.com` as the
  authority yet. `login.figureskatingtools.com` becomes the custom URL domain
  once its Front Door route exists; then only `AUTH_EXTERNAL_AUTHORITY_HOST`
  changes.
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
  to the owner only (prod, until phase C goes live — that keeps the dark launch
  dark). Enterprise application → **Assignment required = No** on both, *after*
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
  exception. Workforce identities are unaffected.

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
the role from the ID token's `roles` claim in **both** tenant modes and tells
the platform with `X-Forwarded-User-Admin: 1`. `Site.Admin` implies
`Site.Access`, so admins need no second assignment.

Because prod runs in **workforce** mode until phase C go-live, the role is
needed in both tenants:

| Tenant | App registration | Assigned to |
| --- | --- | --- |
| External ID | test `16c69665-…`, prod `177abce3-…` | group **`fst-admins`** (create it; add the owner's customer account) |
| Workforce | the Easy Auth app of each environment (`AUTH_CLIENT_ID` of test and of prod) | the owner's workforce account (Enterprise applications → the app → Users and groups → Add, role `Site.Admin`) |

Manifest snippet for `appRoles` (next to `Site.Access` on the External ID apps;
on its own on the workforce apps). Generate a fresh GUID for `id`:

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

**Rollout order** (or prod loses its admins):

1. Add `Site.Admin` and assign it in **both** tenants: the External ID apps
   (→ `fst-admins`) and the workforce Easy Auth apps of test and prod (→ the
   owner). Sign out and in again so the new token carries `roles`.
2. Deploy to test and check the admin panel there.
3. Merge to `main` (prod deploy). Check the admin panel on prod.
4. Only then delete the `ADMIN_EMAILS` GitHub environment variables (test and
   prod); nothing reads them any more.

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
  label links the privacy notice (`https://figureskatingtools.com/privacy`,
  Finnish `…/tietosuoja`). Language customisation: a Finnish (`fi`) override of
  the page and the checkbox label. Conditional Access "Terms of use" isn't
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
| `AUTH_TENANT_MODE` | `external` | unset (`workforce`) until phase C go-live |
| `EXTERNAL_TENANT_ID` | `380073b3-804e-4cc7-bfcc-843637630d04` | same, at phase C |
| `AUTH_EXTERNAL_CLIENT_ID` | `16c69665-3430-42b5-a789-f27bcb21f718` | `177abce3-dc07-4c94-b217-22c084f47481`, at phase C |
| `AUTH_EXTERNAL_AUTHORITY_HOST` | `380073b3-804e-4cc7-bfcc-843637630d04.ciamlogin.com` | same, at phase C |
| `AUTH_LOGIN_PROVIDER` | unset (`aad`) | unset (`aad`) |
| `EXTERNAL_ACCESS_ROLE` | unset (`Site.Access`) | unset (`Site.Access`) |
| `ADMIN_ROLE` | unset (`Site.Admin`) | unset (`Site.Admin`) |

Variables only — there is no External ID secret to configure. `deploy-site.yml`:

- refuses to deploy `AUTH_TENANT_MODE=external` without both `EXTERNAL_TENANT_ID`
  and `AUTH_EXTERNAL_CLIENT_ID`, and any value other than `workforce`/`external`;
- with `EXTERNAL_TENANT_ID` set (either mode), appends the tenant to
  `ALLOWED_TENANT_IDS` for the router and the platform, and writes it to both as
  `EXTERNAL_TENANT_IDS`:
  - the router takes those identities' e-mail **only** from the `email` claim
    (their `preferred_username` / principal name need not be an e-mail), and
    requires the `EXTERNAL_ACCESS_ROLE` app role of them (else `/no-access/`);
  - the platform answers a new identity of that tenant with **503
    `migration_pending`** and creates no user, until phase C;
- shows the mode ("Sign-in tenant") and the External ID tenant count in the admin
  Diagnostics tab, and the mode in the run summary.

The workforce provider's Graph step (redirect URIs + FIC on the workforce app)
keeps running in both modes until phase D.

## Checks after a deploy

```bash
# external mode: 302 to the ciamlogin authorize endpoint with
# response_type=id_token, response_mode=form_post and the external client_id
# (workforce mode: login.microsoftonline.com, the workforce client_id)
curl -s -o /dev/null -w '%{redirect_url}\n' https://test.figureskatingtools.com/.auth/login/aad
# no credential in the deployed config
az webapp auth show -g rg-fs-site-test -n <app> \
  --query 'properties.identityProviders.azureActiveDirectory.registration'
```
