# Router server

Zero-dependency Node (22 LTS, built-ins only) server that fronts the whole
`figureskatingtools.com` domain from a single Azure App Service Web App.
`server.js` is staged next to the built frontend at deploy time:

```
site root/
  server.js          ← this file (App Service startup command: `node server.js`)
  public/            ← the single Vite dist (index.html, judgepapers/, scoremodifier/,
                       protocolgenerator/, tools/banner/, shared assets/)
```

## Routing order

| Order | Match | Behaviour |
| --- | --- | --- |
| 1 | `/health` | `200 {"ok":true}`. Assumes nothing about auth — list it in Easy Auth `globalValidation.excludedPaths`. |
| 2 | `/userinfo` | Flat user object decoded from the Easy Auth `X-MS-CLIENT-PRINCIPAL` header (no tokens are ever exposed). |
| 3 | `/.auth`, `/.auth/*` | `404` — Easy Auth owns these at the platform level; the router must never swallow them into the SPA fallback. |
| 4 | `/<tool>/api/*` | Proxied to that tool's Function App with the `/<tool>` prefix **stripped**: `/judgepapers/api/upload_file` → `$FUNCTION_APP_URL_JUDGEPAPERS/api/upload_file`. Backends keep their default `/api` route prefix — zero backend route changes. |
| 5 | `/api/*` | Proxied to the platform Function App (competitions registry). |
| 6 | `/<tool>` | `301` → `/<tool>/` (query string preserved). |
| 7 | anything else | Static file from `public/`, else a **per-prefix** SPA fallback. |

`<tool>` ∈ `judgepapers`, `scoremodifier`, `protocolgenerator`.

### Static + SPA fallback

- A real file always wins, so root statics (`/assets/*`, `/logo.png`,
  `/changelog.json`, …) resolve before any fallback.
- Unmatched `/judgepapers/*` → `public/judgepapers/index.html`;
  `/scoremodifier/*` and `/protocolgenerator/*` likewise; everything else →
  `public/index.html`.
- A missing file **with a non-HTML extension** returns `404` rather than HTML —
  a stale bundle URL must never come back as `index.html` labelled
  `application/javascript`.
- Requests resolving to a directory without a trailing slash `301` to the
  slashed form.
- Paths escaping `public/` are refused with `403`.

### Proxy behaviour

- Fully streamed: `req.pipe(upstream)` and `upstreamRes.pipe(res)`. Bodies are
  **never buffered**, so 25 MB PDFs, 100 MiB ZIP uploads and binary
  `get_file` downloads pass through in constant memory.
- Method, `content-type`, `content-length`, `accept` and the query string are
  preserved.
- Injected on every proxied request:
  - `x-proxy-secret` — the **per-tool** shared secret; proves the call came
    through this proxy (the Function Apps are publicly reachable).
  - `x-forwarded-user-email` — the signed-in user's email, taken from the
    principal's `userDetails` (falling back to the `preferred_username` /
    `email` claim, then `X-MS-CLIENT-PRINCIPAL-NAME`, then `DEV_FAKE_USER`).
  The raw Easy Auth principal header is *not* forwarded.
- Hop-by-hop response headers (`connection`, `transfer-encoding`, …) are
  dropped; everything else from the upstream is passed through.
- Unconfigured backend → `502` with a JSON body naming the missing env var:
  `{"error":"proxy_target_not_configured","tool":"scoremodifier","message":"… set FUNCTION_APP_URL_SCOREMODIFIER."}`
- `http://` targets are supported (local `func start`), `https://` targets use
  port 443 by default.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | Listen port (App Service sets this). |
| `PUBLIC_DIR` | no | `./public` next to `server.js` | Static root. Override for local dev against `site/dist`. |
| `FUNCTION_APP_URL_JUDGEPAPERS` | for `/judgepapers/api/*` | — | Base URL of `func-fs-judgepapers-*`. |
| `FUNCTION_APP_URL_SCOREMODIFIER` | for `/scoremodifier/api/*` | — | Base URL of `func-fs-scoremodifier-*`. |
| `FUNCTION_APP_URL_PROTOCOLGENERATOR` | for `/protocolgenerator/api/*` | — | Base URL of `func-fs-protocols-*`. |
| `FUNCTION_APP_URL_PLATFORM` | for `/api/*` | — | Base URL of `func-fs-platform-*`. |
| `PROXY_SHARED_SECRET_JUDGEPAPERS` | prod | — | Sent as `x-proxy-secret` to judgepapers. |
| `PROXY_SHARED_SECRET_SCOREMODIFIER` | prod | — | Sent as `x-proxy-secret` to scoremodifier. |
| `PROXY_SHARED_SECRET_PROTOCOLGENERATOR` | prod | — | Sent as `x-proxy-secret` to protocolgenerator. |
| `PROXY_SHARED_SECRET_PLATFORM` | prod | — | Sent as `x-proxy-secret` to the platform API. |
| `NODE_ENV` | no | — | `production` hard-disables `DEV_FAKE_USER`. |
| `DEV_FAKE_USER` | no | — | **Non-production only.** Email returned by `/userinfo` (and forwarded to backends) when no Easy Auth headers are present. |

Trailing slashes on the `FUNCTION_APP_URL_*` values are ignored. A secret left
unset simply means no `x-proxy-secret` header — matching the backends'
`_proxy_secret_ok()`, which only enforces the check when *it* has a secret
configured.

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

Base policy (all paths — Google Fonts is allowed everywhere so the
protocolgenerator document's font links work):

```
default-src 'self'; script-src 'self';
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com;
connect-src 'self'; frame-ancestors 'none'
```

- Tool prefixes (`/judgepapers/*`, `/scoremodifier/*`, `/protocolgenerator/*`)
  additionally allow `https://*.blob.core.windows.net` in `connect-src` and
  `img-src` for SAS upload/download URLs.
- `/protocolgenerator/*` additionally gets `'wasm-unsafe-eval'` in `script-src`,
  `worker-src 'self' blob:` and `blob:` in `connect-src` — pdf.js runs a WASM
  decoder in a blob worker.

Caching: `assets/` paths get `public, max-age=31536000, immutable` (Vite emits
content-hashed names); everything else — HTML, JSON, images — gets `no-cache`.

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
node server/server.js
# → http://localhost:8080
```

Give each local `func start` its own port (`func start --port 7071`). Backends
that have no `PROXY_SHARED_SECRET` set skip the check, so the secret env vars
are optional locally.

Frontend-only work uses `vite dev` (multi-entry: `/judgepapers/` is served
natively) with dev-server proxies for `/api`, `/<tool>/api` and `/userinfo` —
the router is not needed for that loop.

## Tests

```bash
node --test server/*.test.js     # from the repo root
cd server && node --test         # equivalent
```

No dependencies, no build step — `node:test` + the built-in HTTP client, with a
mock upstream and a temp `public/` fixture. Coverage: `/health`; `/userinfo`
with, without and with a malformed principal, plus `DEV_FAKE_USER`; prefix
stripping and per-tool header injection; a 6 MiB upload / 4 MiB download
streamed through the proxy and hash-compared; root statics vs per-prefix SPA
fallback; per-prefix CSP; the `/<tool>` → `/<tool>/` redirect; and the `502`
for an unconfigured backend.

> Note: `node --test server/` (bare directory argument) is not supported by the
> Node 22.17 build in use here — it tries to `require` the directory. Use one of
> the two forms above.
