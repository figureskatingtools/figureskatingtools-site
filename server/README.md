# Router server

Zero-dependency Node (22 LTS, built-ins only) server that fronts the whole
`figureskatingtools.com` domain from a single Azure App Service Web App.
`server.js` is staged next to the built frontend at deploy time:

```
site root/
  server.js          ← this file (App Service startup command: `node server.js`)
  build-info.json    ← {"commit": "<sha>", "builtUtc": "…"}, written by the deploy
                       (read once at startup for the admin diagnostics; not served)
  public/            ← the single Vite dist (index.html, judgepapers/, scoremodifier/,
                       protocolgenerator/, tools/banner/, tools/gdpr/, admin/, shared assets/)
```

## Routing order

| Order | Match | Behaviour |
| --- | --- | --- |
| 0 | any path with a dot segment (`.`/`..`, also `%2e`-encoded), an encoded separator (`%2F`, `%5C`, also double-encoded), a backslash, NUL or an undecodable escape | `400 Bad Request` before any routing (`isUnsafePath`). Everything below then matches only the **canonical** path — decoded, double slashes collapsed (`canonicalPath`) — and the proxy and the static server get exactly that path re-encoded segment by segment (`encodePath`), never the raw one. |
| 1 | `/health` | `200 {"ok":true}`. Assumes nothing about auth — list it in Easy Auth `globalValidation.excludedPaths`. |
| 2 | `/userinfo` | Flat user object decoded from the Easy Auth `X-MS-CLIENT-PRINCIPAL` header (no tokens are ever exposed). Every signed-in shape carries `isAdmin` (see [Admins](#admins)). A principal without `oid`/`tid` claims (or only a bare `X-MS-CLIENT-PRINCIPAL-NAME`) is `{"authenticated":false}`; one from a tenant outside `ALLOWED_TENANT_IDS` is `403 {"error":"tenant_not_allowed"}` (see [Identity](#identity)). |
| 3 | `/changelog-live?branch=main\|test` | Merged, server-cached GitHub commit feed for the home page's "What's New" panel (see below). |
| 4 | `/.auth`, `/.auth/*` | `404` — Easy Auth owns these at the platform level; the router must never swallow them into the SPA fallback. |
| 4b | `/judgepapers/download?t=<token>` | `GET`/`HEAD` proxied to `$FUNCTION_APP_URL_JUDGEPAPERS/api/download_judge_papers?t=<token>` (other methods `405`). The judges'-papers link e-mailed to recipients who have no account: listed in Easy Auth `excludedPaths`, the backend checks the token and `302`s to a short-lived blob URL. |
| 4c | `/signin[?return=/path]` | `302` → `/.auth/login/$AUTH_LOGIN_PROVIDER?post_login_redirect_url=<path>` (other methods `405`). Every "Sign in" link uses it (shared `loginUrl()`, the landing page), so a provider change (Entra External ID) is one app setting. `return` must be a same-origin path; anything else (`//host`, `https://…`, backslashes, control characters) becomes `/`. Listed in Easy Auth `excludedPaths`. |
| 4d | `/`, `/index.html` | Signed in — an Easy Auth principal header, the Easy Auth session cookie `AppServiceAuthSession*`, or `DEV_FAKE_USER` — gets the home page; anyone else the static public landing page `public/landing/index.html` (falls back to the home page if the build has none). Both carry `Vary: Cookie`. The cookie check is needed because these are Easy Auth `excludedPaths`, where the platform injects no principal headers. Only decides which document is shown: the home page's `/userinfo` and the APIs stay gated, so a stale or forged cookie ends on its sign-in view. `/`, `/index.html`, `/landing/*`, `/assets/*` (open-source bundles, no data), `/favicon.png`, `/apple-touch-icon.png`, `/robots.txt` and `/llms.txt` are `excludedPaths`. |
| 4e | `/admin/api/diagnostics` | Router-native, admins only (`403 {"error":"admin_required"}` otherwise; other `/admin/api/*` paths `404` JSON). See [Admins](#admins). |
| 4f | `/admin`, `/admin/*` | The admin panel document (`public/admin/index.html`, deep links fall back to it, `Vary: Cookie`) for admins; a plain `404` for everyone else, so the page does not advertise itself. Matched on the decoded, normalised path (`/%61dmin/`, `//admin/` are gated too). Base CSP: `admin` is a document prefix, not a tool. |
| 5 | `/<tool>/api/*` | A non-`GET`/`HEAD` request must be same-origin ([CSRF](#csrf)), else `403 {"error":"cross_site"}`, never proxied. Identity required ([Identity](#identity)): `401 {"error":"unauthorized"}` without one, `403 {"error":"tenant_not_allowed"}` for a foreign tenant, never proxied. Then proxied to that tool's Function App with the `/<tool>` prefix **stripped**: `/judgepapers/api/upload_file` → `$FUNCTION_APP_URL_JUDGEPAPERS/api/upload_file`. Backends keep their default `/api` route prefix — zero backend route changes. |
| 5b | `/tools/gdpr/api/*` | Same-origin check and identity required, like 5. Proxied to the GDPR removal tool's Function App (`fs-gdpr-tool`) with `/tools/gdpr` **stripped** (`SMALL_TOOL_APIS` in `server.js`). The page itself, `/tools/gdpr/`, is a plain static document. |
| 6a | `/api/manage/*` | Admin-only platform routes. Non-admins get `403 {"error":"admin_required"}` without any proxying. Admins are proxied like 6 (same-origin check included). Matched case-insensitively on the decoded, normalised path, like the Functions host routes. The platform checks again: secret, identity, tenant and `x-forwarded-user-admin: 1`. |
| 6 | `/api/*` | Same-origin check and identity required, like 5. Proxied to the platform Function App (competitions registry). |
| 7 | `/<tool>` | `301` → `/<tool>/` (query string preserved). |
| 8 | anything else | Static file from `public/`, else a **per-prefix** SPA fallback. This is also how the public privacy notice (`/privacy/`, Finnish translation `/tietosuoja/`), the terms of use (`/terms/`, English only) and the self-hosted fonts (`/fonts/*`) are served: plain static files, the same for everyone, reachable signed out because `/privacy`, `/privacy/*`, `/tietosuoja`, `/tietosuoja/*`, `/terms`, `/terms/*` and `/fonts/*` are Easy Auth `excludedPaths`. |

`<tool>` ∈ `judgepapers`, `scoremodifier`, `protocolgenerator`.

### Static + SPA fallback

- A real file always wins, so root statics (`/assets/*`, `/logo.png`,
  `/changelog.json`, …) resolve before any fallback.
- Unmatched `/judgepapers/*` → `public/judgepapers/index.html`;
  `/scoremodifier/*`, `/protocolgenerator/*` and (for admins) `/admin/*`
  likewise (`DOCUMENT_PREFIXES`); everything else → `public/index.html`.
- A missing file **with a non-HTML extension** returns `404` rather than HTML —
  a stale bundle URL must never come back as `index.html` labelled
  `application/javascript`.
- Requests resolving to a directory without a trailing slash `301` to the
  slashed form.
- Paths escaping `public/` are refused with `403` (unreachable in practice:
  dot segments are a `400` before routing).

### Proxy behaviour

- Fully streamed: `req.pipe(upstream)` and `upstreamRes.pipe(res)`. Bodies are
  **never buffered**, so 25 MB PDFs, 100 MiB ZIP uploads and binary
  `get_file` downloads pass through in constant memory.
- Method, `content-type`, `content-length`, `accept` and the query string are
  preserved.
- Injected on every proxied request (the outbound headers are an allow-list,
  so a browser's own `x-forwarded-user-*` / `x-proxy-secret` never pass):
  - `x-proxy-secret` — the **per-tool** shared secret; proves the call came
    through this proxy (the Function Apps are publicly reachable).
  - `x-forwarded-user-tid` / `x-forwarded-user-oid` — the Entra tenant and
    object id (lowercase GUIDs). The **identity**: backends authorise on these.
  - `x-forwarded-user-email` — the e-mail, trimmed and lowercased, from the
    principal's `userDetails` (falling back to the `preferred_username` /
    `email` claim). Display and audit only. Left out when it is not printable
    ASCII — tested **before** lowercasing, since `toLowerCase()` folds some
    non-ASCII letters into ASCII (U+212A KELVIN SIGN → `k`). A non-ASCII
    e-mail is no e-mail at all: it is never forwarded. For an identity of an
    `EXTERNAL_TENANT_IDS` tenant it comes only from the `email` claim.
  - `x-forwarded-user-name` — the `name` claim, `encodeURIComponent`-encoded
    (names are often non-ASCII); left out when there is none.
  - `x-forwarded-user-admin: 1` — only when `isAdminRequest` is true (the
    `ADMIN_ROLE` app role). The platform's admin routes trust it like the tools do.
  - `x-forwarded-user-terms-accepted: 1` — only when the principal carries the
    External ID sign-up's `termsAccepted` claim as `true`. The platform records
    the terms version it stands for on the `users` row; the tools ignore it.
  The raw Easy Auth principal header is *not* forwarded. `/judgepapers/download`
  (public, no principal) gets the secret but none of the identity headers.
- Hop-by-hop response headers (`connection`, `transfer-encoding`, …) are
  dropped; everything else from the upstream is passed through.
- Unconfigured backend → `502` with a JSON body naming the missing env var:
  `{"error":"proxy_target_not_configured","tool":"scoremodifier","message":"… set FUNCTION_APP_URL_SCOREMODIFIER."}`
- `http://` targets are supported (local `func start`), `https://` targets use
  port 443 by default.

### CSRF

Every non-`GET`/`HEAD` request to a proxied API (`/api/*`, `/<tool>/api/*`,
`/tools/gdpr/api/*` — `OPTIONS` included) must be same-origin
(`isSameOriginRequest`): `Sec-Fetch-Site: same-origin`, or — only when the
browser sends no `Sec-Fetch-Site` at all — an `Origin` whose host is the
request's `Host`. Any other `Sec-Fetch-Site` value (`cross-site`,
`same-site`, `none`) is refused even with a matching `Origin`, and so is a
request with neither header. Refused: `403 {"error":"cross_site"}` with
`Connection: close`, checked before the identity gate, nothing proxied.
`GET`/`HEAD` are never checked (reads; the other site cannot read the
answer).

### Identity

- `requestIdentity` decodes `X-MS-CLIENT-PRINCIPAL` and takes `oid`
  (`http://schemas.microsoft.com/identity/claims/objectidentifier` or `oid`)
  and `tid` (`…/claims/tenantid` or `tid`); both must be GUIDs, else there is
  no identity at all. A bare `X-MS-CLIENT-PRINCIPAL-NAME` never is one.
- `ALLOWED_TENANT_IDS` (comma-separated, compared lowercased) lists the tenants
  allowed in. **Empty = nobody** (fail closed); `webapp.bicep` sets the
  deployment tenant unless the GitHub variable overrides it.
- `DEV_FAKE_USER` (non-production only, with no principal header present)
  becomes tenant `00000000-0000-0000-0000-000000000001` and an oid derived from
  the e-mail (a uuid-shaped SHA-256), so the same dev user is the same platform
  user on every run. It is let through regardless of `ALLOWED_TENANT_IDS`; the
  local platform API needs that tenant in *its* `ALLOWED_TENANT_IDS`.

### Admins

- Admin = the **`ADMIN_ROLE`** app role (default `Site.Admin`), from the
  principal's `roles` claim (or `…/claims/role`), in both tenant modes. There
  is no e-mail list: the e-mail plays no part. The role implies the External ID
  access role (`EXTERNAL_ACCESS_ROLE`).
- `isAdminRequest` needs the same identity the APIs need (oid + tid, an allowed
  tenant, access granted — or `DEV_FAKE_USER` with `DEV_FAKE_ROLES`, both off
  under `NODE_ENV=production`) and then the role. A bare
  `X-MS-CLIENT-PRINCIPAL-NAME`, or the role from a foreign tenant, is never an
  admin.
- That one decision drives `isAdmin` in `/userinfo` (the "Admin panel" link in
  the user menu), the `/admin/*` documents, the `/api/manage/*` gate and the
  `x-forwarded-user-admin` header.

`GET /admin/api/diagnostics` answers:

```json
{
  "router": {"commit": "abc1234", "startedUtc": "…Z", "uptimeSeconds": 123, "node": "v22.x",
             "nodeEnv": "production", "changelog": {"entries": [{"branch": "main", "ageSeconds": 12, "stale": false}]}},
  "config": {"targets": {"judgepapers": {"url": true, "secret": true}, "…": {}},
             "hovtpHealthUrl": true, "adminRole": "Site.Admin", "allowedTenantCount": 1,
             "loginProvider": "aad", "authTenantMode": "workforce", "externalTenantCount": 0,
             "devFakeUser": false},
  "backends": [{"name": "platform", "status": "ok", "httpStatus": 200, "latencyMs": 42}, "…"]
}
```

- `commit` comes from `build-info.json`; `null` when the file is missing (local runs).
- Configuration is **booleans only**: no URL or secret value is ever returned.
- `backends`: a parallel `GET <FUNCTION_APP_URL_x>/api/health` per backend
  (platform, the tools, the GDPR tool) with that target's `x-proxy-secret`,
  plus `HOVTP_HEALTH_URL` with none (the listener's health route is never
  gated), each capped at 10 s (cold starts). `status` is `ok` (2xx), `no_health_route`
  (404 — a backend without `/api/health`; every backend has one today), `error`
  (other status or a network failure), `timeout` or `not_configured`.

### `/changelog-live`

The "What's New" panel used to call `api.github.com` from every browser: four
repos per page load against an unauthenticated 60 req/hr **per client IP**
budget. The router does it instead.

- Repos come from `public/changelog-sources.json` — the same file the browser
  reads — re-read on every refresh (it is a few hundred bytes).
- Per repo: `GET /repos/<repo>/commits?sha=<branch>&per_page=20` with
  `Accept: application/vnd.github+json` and a `User-Agent` (GitHub rejects calls
  without one). Commits whose message contains `#nowhatsnew` or `#nowhatnew`
  (anywhere, any case) are dropped. The rest are mapped to the entry shape the frontend renders
  (`sha` first 7, `date`, `iso`, `title`, `description`, `author`, `tool`),
  merged, sorted newest-first and sliced to 20.
- `branch` must be `main` or `test`; anything else (including a missing value)
  is `400 {"error":"invalid_branch"}` and never reaches GitHub.
- **In-memory cache per branch, TTL 10 min.** Concurrent requests during a
  refresh share one upstream round-trip, so a traffic spike is still four
  GitHub calls.
- All-or-nothing: one failing repo fails the whole refresh, so a partial feed
  (a tool silently missing) can never be cached. On failure a previous good
  result is served **stale** if there is one — staleness beats the browser
  dropping to the days-old build-time `/changelog.json`; with nothing cached
  it is `502 {"error":"changelog_upstream_failed"}`.
- Behind Easy Auth like every other route — it is **not** in the `/health`
  exclusion list.

Nothing here is env-configurable; the GitHub origin and TTL are constants on
the config object (tests override them).

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | Listen port (App Service sets this). |
| `PUBLIC_DIR` | no | `./public` next to `server.js` | Static root. Override for local dev against `site/dist`. |
| `FUNCTION_APP_URL_JUDGEPAPERS` | for `/judgepapers/api/*` | — | Base URL of `func-fs-judgepapers-*`. |
| `FUNCTION_APP_URL_SCOREMODIFIER` | for `/scoremodifier/api/*` | — | Base URL of `func-fs-scoremodifier-*`. |
| `FUNCTION_APP_URL_PROTOCOLGENERATOR` | for `/protocolgenerator/api/*` | — | Base URL of `func-fs-protocols-*`. |
| `FUNCTION_APP_URL_GDPRTOOL` | for `/tools/gdpr/api/*` | — | Base URL of `func-fs-gdpr-*`. |
| `FUNCTION_APP_URL_PLATFORM` | for `/api/*` | — | Base URL of `func-fs-platform-*`. |
| `PROXY_SHARED_SECRET_JUDGEPAPERS` | prod | — | Sent as `x-proxy-secret` to judgepapers. |
| `PROXY_SHARED_SECRET_SCOREMODIFIER` | prod | — | Sent as `x-proxy-secret` to scoremodifier. |
| `PROXY_SHARED_SECRET_PROTOCOLGENERATOR` | prod | — | Sent as `x-proxy-secret` to protocolgenerator. |
| `PROXY_SHARED_SECRET_GDPRTOOL` | prod | — | Sent as `x-proxy-secret` to the GDPR removal tool. |
| `PROXY_SHARED_SECRET_PLATFORM` | prod | — | Sent as `x-proxy-secret` to the platform API. |
| `NODE_ENV` | prod | — | `production` hard-disables `DEV_FAKE_USER` and `DEV_FAKE_ROLES` (and with them the dev admin). Set by `webapp.bicep`. Reported in the admin diagnostics. |
| `ADMIN_ROLE` | no | `Site.Admin` | App role that makes an identity an admin (`/admin/*`, `/api/manage/*`, `x-forwarded-user-admin: 1`). Bicep-owned, optional GitHub environment variable `ADMIN_ROLE`. |
| `EXTERNAL_TENANT_IDS` | no | — | Entra External ID tenant ids: their e-mail only from the `email` claim, and they need `EXTERNAL_ACCESS_ROLE` (else `/no-access/`). Bicep-owned, from `EXTERNAL_TENANT_ID`. |
| `EXTERNAL_ACCESS_ROLE` | no | `Site.Access` | App role an External ID identity needs to use the site. Bicep-owned, optional GitHub variable. |
| `AUTH_TENANT_MODE` | no | `workforce` | Which tenant Easy Auth signs in with (`workforce`/`external`); diagnostics only. Bicep-owned. |
| `ALLOWED_TENANT_IDS` | yes | — | Comma-separated Entra tenant ids (case-insensitive) whose principals may use `/userinfo` and the APIs; anyone else gets `403 tenant_not_allowed`. Empty = nobody. Bicep-owned: the deployment tenant, or the GitHub environment variable `ALLOWED_TENANT_IDS`; the platform app gets the same list. |
| `HOVTP_HEALTH_URL` | no | — | The HOVTP listener's health URL for the admin diagnostics (a bare base URL gets `/api/health` appended). Unset = `not_configured`. Bicep-owned. |
| `AUTH_LOGIN_PROVIDER` | no | `aad` | Easy Auth provider segment `/signin` redirects to (`/.auth/login/<provider>`). Bicep-owned: set the GitHub environment variable `AUTH_LOGIN_PROVIDER`, never the app setting by hand (infra deploys replace all app settings). |
| `DEV_FAKE_USER` | no | — | **Non-production only.** Email returned by `/userinfo` (and forwarded to backends, with a synthetic tid/oid — see [Identity](#identity)) when no Easy Auth headers are present. |
| `DEV_FAKE_ROLES` | no | — | **Non-production only.** Comma-separated app roles the `DEV_FAKE_USER` carries, e.g. `Site.Admin` for the admin panel. |

Trailing slashes on the `FUNCTION_APP_URL_*` values are ignored. A secret left
unset means no `x-proxy-secret` header — and the backends **fail closed**, so
every proxied call to that backend is a `401`. Set the same value on both
sides, locally too.

`redirect-server.js` (used on the old tool subdomains during cutover) takes:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TARGET_URL` | `https://figureskatingtools.com/` | Every request `301`s here. |
| `PORT` | `8080` | Listen port. |

## Security headers

Applied to every response:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Content-Security-Policy: <per-prefix, see below>
```

Base policy (all paths — the fonts are self-hosted under `/fonts/`, so no
third-party font host is allowed):

```
default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self';
connect-src 'self'; frame-ancestors 'none'
```

- Tool prefixes (`/judgepapers/*`, `/scoremodifier/*`, `/protocolgenerator/*`)
  additionally allow `https://*.blob.core.windows.net` in `connect-src` and
  `img-src` for SAS upload/download URLs.
- `/protocolgenerator/*` additionally gets `'wasm-unsafe-eval'` in `script-src`,
  `worker-src 'self' blob:` and `blob:` in `connect-src` — pdf.js runs a WASM
  decoder in a blob worker.

Caching: `assets/` paths and `/fonts/*.woff2` get `public, max-age=31536000,
immutable` (Vite emits content-hashed names; the font files carry a version
suffix, bumped whenever a font changes); everything else — HTML, CSS outside
`assets/`, JSON, images — gets `no-cache`.

## Local dev

Full stack (router + real or local backends):

```bash
# Build the frontend first, then point the router at the dist
npm run build --workspace=site

PUBLIC_DIR=site/dist \
DEV_FAKE_USER=you@example.com \
FUNCTION_APP_URL_JUDGEPAPERS=http://localhost:7071 \
PROXY_SHARED_SECRET_JUDGEPAPERS=local-dev \
FUNCTION_APP_URL_PLATFORM=http://localhost:7072 \
PROXY_SHARED_SECRET_PLATFORM=local-dev \
node server/server.js
# → http://localhost:8080
```

Give each local `func start` its own port (`func start --port 7071`). The
backends fail closed, so give each the same `PROXY_SHARED_SECRET` as the router
sends, and the platform `ALLOWED_TENANT_IDS=00000000-0000-0000-0000-000000000001`
(the `DEV_FAKE_USER` tenant).

Frontend-only work can use `vite dev` (multi-entry: `/judgepapers/` is served
natively), but it has **no** API proxies: `/userinfo` and every API call fail,
so the apps show their sign-in view. For anything signed in, build and run the
router as above. Add `DEV_FAKE_ROLES=Site.Admin` to see the admin panel at
`/admin/` (the router then sends the platform `x-forwarded-user-admin: 1`).

## Tests

```bash
node --test server/*.test.js     # from the repo root
cd server && node --test         # equivalent
```

No dependencies, no build step — `node:test` + the built-in HTTP client, with a
mock upstream and a temp `public/` fixture. Coverage: `/health`; `/userinfo`
with, without and with a malformed principal, plus `DEV_FAKE_USER`; identity
(oid/tid claim extraction, the dev identity, `401` without and `403
tenant_not_allowed` outside the allowed tenants, client-supplied
`x-forwarded-user-*` dropped, the admin header only for admins, every backend
incl. the GDPR tool getting the headers, none on `/judgepapers/download`); prefix
stripping and per-tool header injection; a 6 MiB upload / 4 MiB download
streamed through the proxy and hash-compared; root statics vs per-prefix SPA
fallback; per-prefix CSP; the `/<tool>` → `/<tool>/` redirect; the `502`
for an unconfigured backend; admins (the `Site.Admin` role, either claim form, `ADMIN_ROLE`, `isAdmin`, the
`NODE_ENV=production` dev-user guard, `/admin/` 404 vs document vs deep link,
the `/api/manage/*` gate and its cross-site check, diagnostics shape and no
secret/URL leakage); and `/changelog-live` (mapping/sorting/slice, `#nowhatsnew` filtering,
branch validation, cache hit, stale-on-failure, in-flight dedup, `502` with an
empty cache) against a stub GitHub.

> Note: `node --test server/` (bare directory argument) is not supported by the
> Node 22.17 build in use here — it tries to `require` the directory. Use one of
> the two forms above.
