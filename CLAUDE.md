# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The landing page for **figureskatingtools.com** — a static marketing/launcher page that links out to separately-hosted tools (each on its own subdomain). This repo contains only the landing site plus a shared navigation package; the individual tools (e.g. `judgepapers`) live in their own repos and are deployed to subdomains.

## Workspace layout

npm workspaces monorepo (root `package.json`, workspaces: `packages/*` and `site`):

- **`packages/shared-ui`** — `@figureskatingtools/shared-ui`, the cross-tool site navigation bar. Built with `tsc` to `dist/` and **published to GitHub Packages**. Every tool in the ecosystem (this site and the external tool repos) consumes this package so the top nav stays consistent.
- **`site`** — the landing page itself. Vanilla TypeScript + Vite, no framework. Entry is `site/src/main.ts`, which builds the page's HTML as template strings and injects it into `#app`.
- **`infra`** — Bicep IaC for the Azure App Service that hosts the site.

## Common commands

Run from the repo root unless noted.

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

> Note: `site` depends on `@figureskatingtools/shared-ui: "*"`. Locally the workspace symlink resolves to the package's `dist/index.js`, so **shared-ui must be built at least once** or imports will fail. In CI, `npm ci` installs the *published* package from GitHub Packages (auth via `.npmrc` → `npm.pkg.github.com`).

## Environment-aware URL scheme

Both `site/src/main.ts` and `packages/shared-ui/src/nav.ts` independently derive tool/home URLs from `window.location.hostname`. The scheme:

- `localhost` / `127.0.0.1` → links are `#` (or `/` for home); tools aren't reachable locally.
- hostname starting with `test.` → that prefix is preserved, so `test.figureskatingtools.com` links to `test.judgepapers.figureskatingtools.com`.
- otherwise (prod) → no prefix, links to `judgepapers.figureskatingtools.com`.

When adding or toggling a tool you must update **two** lists that are intentionally duplicated: the `tools` array in `site/src/main.ts` (renders the cards) and `DEFAULT_TOOLS` in `packages/shared-ui/src/nav.ts` (renders the nav dropdown). The `enabled` flag controls "Coming Soon" vs. a live link in both.

## Deployment (Azure App Service)

Deploys are git-push driven via GitHub Actions; **branch determines environment**:

- `main` → `prod`, `test` → `test` (see `.github/workflows/deploy-site.yml`).

There are only two environments. `test` is provisioned on demand and **deleted manually** once testing is done (its Azure resource group, `rg-fs-site-test`, is torn down outside this repo).

`deploy-site.yml` runs on changes to `site/**`, `infra/**`, or the workflow itself, and does three stages: deploy Bicep (`az deployment sub create` with `infra/parameters/<env>.bicepparam`) → build the site → zip `server.js` + `site/dist/*` (into `public/`) and `az webapp deploy`. Auth is OIDC (`AZURE_CLIENT_ID` secret, `AZURE_TENANT_ID`/`AZURE_SUBSCRIPTION_ID`/`LOCATION` vars per GitHub Environment).

`publish-shared-ui.yml` runs on `main` when `packages/shared-ui/**` changes and publishes the package to GitHub Packages. **Bump `packages/shared-ui/package.json` version** when changing shared-ui, otherwise `npm publish` fails on a duplicate version (and downstream tools won't pick up changes via `*`).

The site is served in production by **`site/server.js`** — a zero-dependency Node http server (not Vite). It serves `public/` statically with SPA fallback to `index.html` and sets security headers including a strict CSP (`script-src 'self'`). Keep that CSP in mind: inline scripts and third-party origins are blocked.

## Infra notes

`infra/main.bicep` is subscription-scoped (creates the resource group). The custom-domain binding + free managed TLS certificate in `infra/modules/webapp.bicep` are conditional on `customDomain` being set (only `prod` sets it) and **require the CNAME/TXT DNS records to already exist** before deployment, or the binding fails.
