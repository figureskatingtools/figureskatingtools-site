# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The **single host for figureskatingtools.com** — an auth-gated App Service that serves the home page **and all tool frontends path-based** on one domain (`/`, `/judgepapers/`, `/scoremodifier/`, `/protocolgenerator/`, `/tools/banner/`), proxies each tool's API to its separately-deployed Function App, and owns the **platform competition registry** (create/select a competition once, every tool operates on it). Tool *backends* stay in their own repos (`fs-judgepapers`, `fs-scoremodifier`, `fs-protocolgenerator`); their `frontend/` dirs are legacy and live here now.

## Workspace layout

npm workspaces monorepo (root `package.json`, workspaces: `packages/*` and `site`):

- **`packages/shared-ui`** — `@figureskatingtools/shared-ui` v3 (internal): path-based site nav (`DEFAULT_TOOLS` in `src/nav.ts`), plus the **competition state module** (`src/competition.ts`: `getActiveCompetition`/`setActiveCompetition`/`subscribeActiveCompetition`, localStorage key `fst:active-competition:v1`, API client for `/api/competitions`) and the nav **competition selector** (`src/competition-selector.ts`, renders into `#fst-nav-competition`; degrades to nothing if the API is unavailable). v3 is consumed via workspace symlink only; the external GitHub Packages publish (v2.x) exists solely for the tool repos' legacy frontends and dies with them.
- **`site`** — one Vite project, **five HTML entries** (`index.html`, `judgepapers/`, `scoremodifier/`, `protocolgenerator/`, `tools/banner/`). Each app is its own document with its own unscoped `style.css` (`site/src/<app>/`) — CSS never crosses documents; don't import one app's CSS from another. Shared chrome is `site/src/shell.ts` (`fetchUser()` → `GET /userinfo` flat shape, `loginUrl(appPath)`/`logoutUrl()`, `renderSignInView`, `setupUserMenu`). Per-app API base constants: `const API_BASE = '/<tool>/api'` — never root-absolute `/api/...` inside tool apps (bare `/api` is the platform registry).
- **`server`** — the zero-dependency Node router (`server.js`): static hosting of the Vite dist with per-prefix SPA fallback, `GET /userinfo`, `GET /health`, and streaming proxies `/<tool>/api/*` → `FUNCTION_APP_URL_<TOOL>` and `/api/*` → `FUNCTION_APP_URL_PLATFORM`, injecting `x-proxy-secret` (per-target `PROXY_SHARED_SECRET_*`) + `x-forwarded-user-email`. Per-prefix CSP (protocolgenerator gets pdf.js allowances). Bodies are piped, never buffered (25 MB PDF / 100 MiB ZIP uploads flow through). `redirect-server.js` is the cutover-era 301 helper for old subdomains. See `server/README.md` for the env contract.
- **`infra`** — subscription-scoped Bicep: per-env site RG (`rg-fs-site-<env>`) with the Web App (B1, Easy Auth v2 via MI federated credential), platform storage (`stfsplat*`: `competition-data` + `app-package` containers, `competitions` table), platform Function App (`func-fs-platform-*`, FC1 Python 3.13), RBAC (incl. `shared-data-access.bicep` granting tool Function Apps Blob Data Reader on platform storage via `TOOL_PRINCIPAL_ID_*`), DNS in the shared persistent `rg-fs-dns` zone (apex = plain **A record to the Web App's `inboundIpAddress`** + `asuid` TXT; `test` = CNAME + `asuid.test` TXT), custom-domain binding + managed cert + SNI. **`infra/functions/`** is the platform competition API. **`infra/MIGRATION.md`** documents the one-time manual steps (GitHub env vars/secrets, Entra grants, cutover order, teardown).

## Common commands

Run from the repo root. CI uses Node 22.

```bash
npm install
npm run build --workspace=@figureskatingtools/shared-ui   # must precede site build (TS2307 otherwise)
npm run build --workspace=site                             # tsc strict + vite, 5 entries
npm run dev --workspace=site                               # Vite MPA dev server (see proxies in vite.config.ts)

# Tests
npm test --workspace=@figureskatingtools/shared-ui         # vitest (competition state logic)
node --test server/*.test.js                               # router suite (NOT `node --test server/` — Node 22.17 quirk)
cd infra/functions && uv run --with-requirements requirements.txt \
  --with-requirements requirements-dev.txt python -m pytest tests -q   # platform API suite
```

Local full-stack: `node server/server.js` with `FUNCTION_APP_URL_*` pointing at local `func start` instances or the deployed test Function Apps, `DEV_FAKE_USER=dev@example.com` (non-production only) for `/userinfo`. Secrets unset = proxy-secret gate off (backends fail open only when their `PROXY_SHARED_SECRET` is empty).

## Auth

**App Service Easy Auth v2 (AAD)** gates the whole origin platform-side (`requireAuthentication`, `RedirectToLoginPage`; `/health` excluded). No client secret: a user-assigned MI federated credential (`OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID`), FIC + redirect URIs maintained by the deploy workflow via Graph. Frontends read identity from `GET /userinfo` (router decodes `X-MS-CLIENT-PRINCIPAL`); login links use `post_login_redirect_url` (App Service syntax — not SWA's `_uri`). Locally there is no `/.auth/*`; use `DEV_FAKE_USER`.

## Competition registry (platform API)

`infra/functions/function_app.py`. Table `competitions`, two row kinds: PK `COMPETITION`/RK GUID (the entity) and PK `CODE`/RK normalized-code → GUID (uniqueness + O(1) lookup; created first on insert, 409 `code_in_use` on conflict, freed on soft delete). Routes: `GET|POST /api/competitions`, `GET|PUT|PATCH|DELETE /api/competitions/{id}` (DELETE = soft, `status:"deleted"`), `GET /api/health`. Create accepts `date` or `startDate`. Python `normalize_code` must stay identical to TS `normalizeCompetitionCode` in shared-ui (NFD diacritic folding — there's a test). Future FSM ingest (datafeeds/PDFs over HTTP keyed by competition code) hooks in here: reserved `ingest_*` route names + `x-ingest-key` stub, blob layout `competition-data/<guid>/fsm/`.

The **active competition** is client-side state (localStorage, same origin) — tools use it to prefill/label/associate but keep their own legacy per-tool records; linking tool records to platform GUIDs is a future step.

## Changelog ("What's New" panel)

Commits are served by the **router**, not the browser: `GET /changelog-live?branch=main|test` (`server/server.js`) reads `site/public/changelog-sources.json` (incl. `fs-protocolgenerator`), fetches `/repos/<repo>/commits?sha=<branch>&per_page=20` per repo, maps/merges/sorts to the frontend entry shape, and caches per branch **in memory for 10 min** with in-flight dedup — the whole site costs GitHub four calls per 10 min instead of four per page load against the 60 req/hr-per-IP anonymous limit. All-or-nothing per refresh (one bad repo fails it, never a partial cache); on failure a previous result is served **stale**, and with nothing cached it's a 502. Invalid branch → 400.

Frontend chain (`site/src/main.ts` `loadChangelog`): `localStorage` cache (5 min, key `changelog-cache-v1`) → `/changelog-live` → direct GitHub API (`fetchLiveChangelog`, kept so `vite dev` works without the router) → build-time `/changelog.json` from `scripts/generate-changelog.sh` → "Changelog not available.". Branch-aware (`test.*` host → `test`). Tool repos must stay public and keep `main`+`test` branches. New tool in the feed = one JSON entry + a `.changelog-badge--<tool-slug>` CSS rule.

## Commit messages

Surfaced **verbatim** in the public "What's New" panel: one plain user-facing title line (sentence case, no `type(scope):`), blank line, then `-` bullets per notable change. Keep bullets tight (~150 chars collapse threshold); trailers render too, so keep bodies to the bullet summary.

## Deployment

`.github/workflows/deploy-site.yml` — push to `main` → prod; `test` only via `workflow_dispatch`. Four jobs: `set-environment` → `deploy-infra` (bicep + FIC/redirect-URI Graph step) → `deploy-platform-backend` (pytest, then zip deploy) → `deploy-frontend` (builds + router tests, stages `server/server.js` + `site/dist/*` → `public/`, async zip deploy + Kudu poll, `/health` smoke check).

Per-environment GitHub config: vars `FUNCTION_APP_URL_{JUDGEPAPERS,SCOREMODIFIER,PROTOCOLGENERATOR}`, `TOOL_PRINCIPAL_ID_{…}`, `SKIP_CUSTOM_DOMAIN` (set `true` to run on the default hostname, e.g. pre-cutover); secrets `PROXY_SHARED_SECRET_{JUDGEPAPERS,SCOREMODIFIER,PROTOCOLGENERATOR,PLATFORM}`, `AUTH_CLIENT_ID`, `AUTH_APP_OBJECT_ID`. Bicepparams read secrets via `readEnvironmentVariable()`. `deploy-infra` is **atomic**: `webapp.bicep` still replaces the whole app-settings collection, but it now writes the full set itself (`FUNCTION_APP_URL_*` — platform from the platform Function App module's output, the tools from the GitHub env config passed into the template — plus `PROXY_SHARED_SECRET_*` and `SCM_DO_BUILD_DURING_DEPLOYMENT`), so running it alone leaves the router fully configured.

`publish-shared-ui.yml` still publishes v2.x for the tool repos' legacy frontends; retire it (and mark shared-ui private) at teardown. Migration/cutover order, old-subdomain redirects and the teardown checklist live in `infra/MIGRATION.md`.

## Infra notes

- Two environments; `test` provisioned on demand, torn down manually (`rg-fs-site-test`). The DNS RG (`rg-fs-dns`) is shared and persistent; deployments are incremental and only touch their own record sets (hand-seeded MX etc. survive — `infra/seed-dns-records.sh`).
- Apex binding is a literal A record to the app's `inboundIpAddress` (alias records can't target App Service); each infra run self-heals it. Managed certs support the apex (HTTP-token validation works behind Easy Auth).
- App Service has a hard ~230 s request timeout — fine for current PDF generation, but future long-running FSM batch work needs an async/polling pattern.
- Tool Function Apps are reached **only** through the router (CORS cleared, `AllowAnonymous` + proxy-secret gate). The per-tool header contract is documented in each tool repo's `PROXY-CONTRACT.md`.
