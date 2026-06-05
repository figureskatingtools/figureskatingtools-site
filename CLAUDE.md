# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The landing page for **figureskatingtools.com** — an **auth-gated** launcher/home page that links out to separately-hosted tools (each on its own subdomain). This repo contains only the landing site plus a shared navigation package; the individual tools (e.g. `judgepapers`) live in their own repos and are deployed to subdomains.

## Workspace layout

npm workspaces monorepo (root `package.json`, workspaces: `packages/*` and `site`):

- **`packages/shared-ui`** — `@figureskatingtools/shared-ui`, the cross-tool site navigation bar. Built with `tsc` to `dist/` and **published to GitHub Packages**. Every tool in the ecosystem (this site and the external tool repos) consumes this package so the top nav stays consistent.
- **`site`** — the landing page itself. Vanilla TypeScript + Vite, no framework. Entry is `site/src/main.ts`, which builds the page's HTML as template strings and injects it into `#app`.
- **`infra`** — Bicep IaC for the Azure **Static Web App** that hosts the site, plus the shared public DNS zone for the whole domain.

## Common commands

Run from the repo root unless noted. CI uses Node 22.

```bash
# First-time / after changing shared-ui: build it so `site` can import dist/
npm install
npm run build --workspace=@figureskatingtools/shared-ui

# Local dev server for the landing page (Vite)
npm run dev --workspace=site         # or: cd site && npm run dev

# Production build of the site (type-check + bundle to site/dist/)
npm run build --workspace=site

# Build the shared-ui package
npm run build --workspace=@figureskatingtools/shared-ui
```

There is **no test suite or linter** configured. Type-checking is the only static check: `site` build runs `tsc` (noEmit, strict, noUnused*) before `vite build`; `shared-ui` build runs `tsc` to emit `dist/`.

> **shared-ui must be built before `site`.** `site` depends on `@figureskatingtools/shared-ui: "*"`. Because it's a workspace, npm resolves that to the in-repo package via symlink **both locally and in CI** — so `dist/` must exist (`npm run build --workspace=@figureskatingtools/shared-ui`) or `site`'s `tsc` fails with `TS2307`. Publishing to GitHub Packages is for the *external* tool repos that aren't part of this workspace; `.npmrc` (`@figureskatingtools:registry=npm.pkg.github.com`) + `NODE_AUTH_TOKEN` exist for publishing and for those downstream consumers.

## Auth-gated SPA

The site is gated behind **Azure Static Web Apps' built-in AAD (Entra) authentication** — there is no app-level auth code, it's all SWA platform plumbing:

- `site/public/staticwebapp.config.json` registers the `azureActiveDirectory` provider (`clientIdSettingName: AZURE_CLIENT_ID`, `clientSecretSettingName: AZURE_CLIENT_SECRET`, a hard-coded tenant `openIdIssuer`), sets `navigationFallback` → `/index.html` (SPA fallback), and emits the security headers (HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`). **This file is the source of security headers and SPA routing — not a Node server** (there is no `server.js`; SWA serves `site/dist/` from its global CDN).
- `main.ts` calls `fetch('/.auth/me')` on load. No `clientPrincipal` → **unauthenticated view** (a sign-in page linking to `/.auth/login/aad`). Authenticated → renders the shared nav, a welcome card, a "What's New" changelog panel, and a user menu whose "Sign Out" hits `/.auth/logout`.
- **Locally `npm run dev` always shows the unauthenticated view** — `/.auth/*` only exists on the deployed SWA, so the `/.auth/me` fetch returns no principal. That's expected; auth can only be exercised against the live Static Web App.
- The auth app registration's secret is pushed to SWA app settings by the deploy workflow (from `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` secrets → `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` settings). **Redirect URIs and other Entra config are provisioned manually** — the deploy principal has no Microsoft Graph rights to PATCH the app registration. The per-environment callbacks (`https://<host>/.auth/login/aad/callback`) are documented in `deploy-site.yml` and are stable for the life of the SWA + custom domain.

## Environment-aware URL scheme

The tool/home URLs are derived from `window.location.hostname` in `packages/shared-ui/src/nav.ts` (`getEnvPrefix`, `buildToolUrl`, `buildHomeUrl`). The scheme:

- `localhost` / `127.0.0.1` → tool links are `#`, home is `/` (tools aren't reachable locally).
- hostname starting with `test.` → that prefix is preserved, so `test.figureskatingtools.com` links to `test.judgepapers.figureskatingtools.com`.
- otherwise (prod) → no prefix, links to `judgepapers.figureskatingtools.com`.

**Adding or toggling a tool is a single-list change:** edit `DEFAULT_TOOLS` in `packages/shared-ui/src/nav.ts` (id, label, subdomain, `enabled`). `enabled: false` renders "coming soon"; `true` renders a live link to the tool's subdomain. (`main.ts` no longer carries its own tool-card list — it only renders the shared nav.) After editing, **bump `packages/shared-ui/package.json` version** so the change publishes and downstream tool repos pick it up.

## Changelog generation

`scripts/generate-changelog.sh [output] [branch]` is run during deploy (not committed output). It uses `gh api` to pull recent commits from `figureskatingtools/figureskatingtools-site` and `figureskatingtools/fs-judgepapers`, merges/sorts them, and writes `site/public/changelog.json` (consumed by `loadChangelog()` in `main.ts`). The "What's New" panel is **environment-aware**: the deploy workflow passes the branch per environment — **`main` for prod, `test` for the test env** — and the script keeps only the **latest 4** entries across both repos (a repo without the requested branch is skipped with a warning). To add a repo to the feed, extend the `REPOS` map in the script.

## Commit messages

Commit subjects and bodies are surfaced **verbatim** in the public "What's New" panel, so write them for end users, not just for `git log`. The changelog script maps each commit into two fields: the **title** is the first line of the message; the **description** is everything after it. Structure every commit as a one-line title, a blank line, then a bulleted body:

```
What's new section updated

- What's new section updated to show 4 latest updates
- Another update
```

- **Title** — a short, plain, user-facing sentence (sentence case, no trailing period). It is shown as the entry heading, so skip `type(scope):` prefixes and internal jargon (this differs from the older Conventional-Commits style seen earlier in `git log`).
- **Body** — one `-` bullet per notable change. Keep each tight; the panel collapses descriptions longer than ~150 chars behind a "Read more" toggle.
- The body is rendered in full, including trailers (e.g. `Co-Authored-By:`), so keep it to the bullet summary.

## Deployment (Azure Static Web Apps)

Deploys run via GitHub Actions (`.github/workflows/deploy-site.yml`), triggered by changes to `site/**`, `infra/**`, or the workflow itself.

- **Push to `main` → `prod` automatically.** **`test` is deployed only via manual `workflow_dispatch`** (pick `test` or `prod`). There is no `test`-branch trigger; "branch determines environment" only applies to `main`.
- Two jobs: **deploy-infra** (`az deployment sub create` with `infra/parameters/<env>.bicepparam`, then sets the SWA auth app settings) → **deploy-frontend** (`npm ci`, build shared-ui, generate changelog, build site, fetch the SWA deployment token via `az staticwebapp secrets list`, then `Azure/static-web-apps-deploy@v1` with `app_location: site/dist`, `skip_app_build: true`).
- Auth is OIDC for the deploy principal (`AZURE_CLIENT_ID` secret; `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` / `LOCATION` vars per GitHub Environment). The Entra **auth-app** secret is separate (`AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` secrets).

`publish-shared-ui.yml` runs on `main` when `packages/shared-ui/**` changes and publishes to GitHub Packages. **Bump the version in `packages/shared-ui/package.json`** or `npm publish` fails on a duplicate version (and downstream tools won't pick up changes via `*`).

There are only two environments. `test` is provisioned on demand and **deleted manually** once testing is done (its site resource group, `rg-fs-site-test`, is torn down outside this repo). The shared DNS resource group (`rg-fs-dns`) is **not** torn down with it.

## Infra notes

`infra/main.bicep` is subscription-scoped and creates two resource groups: the per-environment site RG (`rg-fs-site-<env>`) and the **shared, persistent** DNS RG (`rg-fs-dns`). It deploys the Static Web App (`modules/staticwebapp.bicep`, Standard SKU), the DNS records (`modules/dns.bicep`), and — only when `customDomain` is set — the custom-domain binding (`modules/customdomain.bicep`).

- **Single DNS zone for the whole domain.** `figureskatingtools.com` lives in one zone in `rg-fs-dns`. Both `test` and `prod` deploy the same `dns.bicep`, each declaring **only its own** record set. Deployments run incrementally, so records other environments / hand-added records (the `judgepapers` CNAMEs, the MX record) are never touched. The "test environment" is a `test` record set in this zone, **not** a separate zone.
- **`customDomain` is set for both environments**, but validation differs: apex (`prod`, `figureskatingtools.com`) must use **`dns-txt-token`** (an ALIAS A record to the SWA + a `_dnsauth` TXT token); a subdomain (`test.figureskatingtools.com`) uses **`cname-delegation`** (a single CNAME both routes and validates). The apex token is committed in `prod.bicepparam` (publicly resolvable, not a secret).
- The custom-domain binding is split into its own module and `dependsOn` the DNS module, because SWA validation reads **public DNS** — the CNAME / TXT records must exist before the binding, or it blocks.
- **Name-server delegation at the registrar (Joker) is a one-time manual step.** The deploy surfaces the zone's Azure name servers in the job summary. `infra/seed-dns-records.sh` idempotently seeds the non-site records (MX, `judgepapers` CNAMEs) into the Azure zone **before** the NS cutover; run it once, it never deletes anything.
