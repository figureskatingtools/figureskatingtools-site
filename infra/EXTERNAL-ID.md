# Entra External ID — the hand-configured tenant

The site is moving its sign-in from the **workforce** tenant to a Microsoft
Entra **External ID** (customer) tenant. Nothing inside that tenant is IaC: the
ARM type for the directory is preview-only and not idempotent, and user flows,
branding, apps and groups have no Bicep surface anyway. This runbook is the
record of every hand step, so the setup stays reproducible.

Code owns everything **outside** the tenant: the credential-free `externalid`
Easy Auth provider (`modules/webapp.bicep`), `ALLOWED_TENANT_IDS`, the router's
claim handling (`server/server.js`), the platform's `migration_pending` gate
(`functions/function_app.py`), and later the Front Door route + DNS for the
custom URL domain (`azure-publishing`). The tenant and app ids reach code as
GitHub vars (below).

Phases: A = this directory (done by hand), **B = code readiness, switched off**
(this repo: provider deployed, `AUTH_LOGIN_PROVIDER` still `aad`), C = migration
(link external identities to existing users by verified e-mail, then switch).

## The rule: never add a secret to the site apps

The two site app registrations have **no client secret, no certificate and no
federated credential, ever**, and the `externalid` provider in `webapp.bicep`
has no `clientCredential`. Do not "fix" a sign-in problem by adding one.

Why this is enough:

- An app needs a credential only to redeem an authorization code for access or
  refresh tokens. The site uses neither: `tokenStore` is off and nothing calls a
  downstream API. The only thing Easy Auth needs is the **ID token**.
- Without a credential Easy Auth runs the OIDC **ID-token flow**
  (`response_type=id_token`, `response_mode=form_post` to
  `/.auth/login/externalid/callback`) and validates the signature, `iss`, `aud`
  (our client id) and the nonce itself.
- The workforce provider's managed-identity FIC can't be reused: App Service
  supports it for workforce configurations only, and Entra tokens can't be
  federated into another tenant's app. Azure/M365 Lighthouse don't take part in
  sign-ins at all.
- No secret means nothing to leak, rotate or expire on the site side.

If Easy Auth ever demands `response_type=code` (i.e. a secret), stop and
reconsider; the documented fallback is to point the `azureActiveDirectory`
provider at the external issuer, still without a secret.

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
  owner uses the site with a self-signed-up account, and `ADMIN_EMAILS`
  matches that account's e-mail.

## App registrations (single tenant)

| Env | Name | Client id | Redirect URI |
| --- | --- | --- | --- |
| test | `figureskatingtools-test` | `16c69665-3430-42b5-a789-f27bcb21f718` | `https://test.figureskatingtools.com/.auth/login/externalid/callback` |
| prod | `figureskatingtools` | `177abce3-dc07-4c94-b217-22c084f47481` | `https://figureskatingtools.com/.auth/login/externalid/callback` |

- Authentication: Web platform, exact `https` redirect URIs only; implicit/hybrid
  **"ID tokens" ticked, "Access tokens" never**.
- Certificates & secrets: **empty**, permanently (see the rule above). An
  app-management policy in the tenant may enforce it.
- Enterprise application → **Assignment required = Yes** on both:
  - test is assigned the group `fst-test-access` (add testers there);
  - prod is assigned **only the owner** until phase C goes live, which keeps the
    dark launch dark.
- Both apps are associated with the one user flow below.
- Manifest: `acceptMappedClaims: true` (needed for the mapped `termsAccepted`
  claim, since there is no custom signing key).

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
  available in external tenants, hence the checkbox. Acceptance is not versioned:
  changing the terms later needs an app-side re-acceptance gate.

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
| `EXTERNAL_TENANT_ID` | `380073b3-804e-4cc7-bfcc-843637630d04` | same, at phase C |
| `AUTH_EXTERNAL_CLIENT_ID` | `16c69665-3430-42b5-a789-f27bcb21f718` | `177abce3-dc07-4c94-b217-22c084f47481`, at phase C |
| `AUTH_EXTERNAL_AUTHORITY_HOST` | `380073b3-804e-4cc7-bfcc-843637630d04.ciamlogin.com` | same, at phase C |
| `AUTH_LOGIN_PROVIDER` | unset (`aad`) | unset (`aad`) until the switch |

Variables only — there is no External ID secret to configure. With both
`EXTERNAL_TENANT_ID` and `AUTH_EXTERNAL_CLIENT_ID` set, `deploy-site.yml`:

- adds the `externalid` custom OIDC provider to Easy Auth (no `clientCredential`;
  `nameClaimType: name`; scopes `openid profile email`);
- appends the tenant to `ALLOWED_TENANT_IDS` for the router and the platform;
- writes it to the platform as `EXTERNAL_TENANT_IDS`: a new identity of that
  tenant gets **503 `migration_pending`** and no user is created, until phase C;
- shows "External ID provider: configured" in the admin Diagnostics tab.

`AUTH_LOGIN_PROVIDER=externalid` later switches `/signin` and Easy Auth's
`redirectToProvider` together; `/.auth/login/externalid` works directly before
that for testing. The workforce provider and its Graph/FIC deploy step stay
until phase D.

## Checks after a deploy

```bash
# 302 to the ciamlogin authorize endpoint with response_type=id_token,
# response_mode=form_post and our client_id
curl -sI https://test.figureskatingtools.com/.auth/login/externalid | grep -i '^location'
# the workforce provider is unchanged
curl -sI https://test.figureskatingtools.com/.auth/login/aad | grep -i '^location'
```
