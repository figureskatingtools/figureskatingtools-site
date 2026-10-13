# Figure Skating Tools — site

The single web host for **[figureskatingtools.com](https://figureskatingtools.com)**: open-source tools that help figure skating result services, competition organisers and officials with competition paperwork, built from Figure Skating Manager (FS Manager) data.

*Supporting the figure skating community* ❤️

This repo serves the public landing page, the signed-in home page and **every tool's frontend** on one domain, proxies each tool's API to its own backend, and owns the shared **competition registry**: create or select a competition once and every tool works on it.

## Tools

| Tool | Path | What it does | Backend |
|---|---|---|---|
| Judge Paper Creator | `/judgepapers/` | Builds each judge's papers from FS Manager PDF exports, Finnish or English, and e-mails them with a download link | [fs-judgepapers](https://github.com/figureskatingtools/fs-judgepapers) |
| Protocol Generator | `/protocolgenerator/` | The complete official protocol book: cover, competition info, schedule, podiums, results, judges' details, team pages | [fs-protocolgenerator](https://github.com/figureskatingtools/fs-protocolgenerator) |
| Score Modifier | `/scoremodifier/` | Splits the "Judges Details per Skater" export into one readable page per skater or team | [fs-scoremodifier](https://github.com/figureskatingtools/fs-scoremodifier) |
| GDPR Removal Tool | `/tools/gdpr/` | Removes a skater's name and club from published FS Manager result pages and PDFs, keeping placements and scores | `fs-gdpr-tool` (private) |
| Competition Banner Generator | `/tools/banner/` | Branded competition banner with name, dates, venue and federation/club logos | this repo (frontend only) |
| Live FS Manager link | — | FS Manager pushes schedules, entries and PDFs to the platform while the event runs | this repo (`infra/hovtp`) |

Only the landing page is public; the tools require sign-in and access is by invitation. Request access: [markus@lintuala.fi](mailto:markus@lintuala.fi).

## Architecture

```
browser ──► figureskatingtools.com  (Azure App Service, Easy Auth sign-in)
              │  server/server.js — zero-dependency Node router
              ├─ /                     landing page (signed out) or home page (signed in)
              ├─ /<tool>/              tool frontends (one Vite build, six HTML entries)
              ├─ /<tool>/api/*   ──►   that tool's Function App   (fs-judgepapers, …)
              ├─ /tools/gdpr/api/* ──► GDPR tool Function App
              └─ /api/*          ──►   platform Function App      (competition registry, infra/functions)

FS Manager ──► /api/v1/hovtp  ──►   HOVTP listener Function App (infra/hovtp, separate and independently stoppable)
```

| Layer | Technology |
|---|---|
| Frontend | TypeScript + Vite, one multi-page build (`site/`), shared nav and competition selector (`packages/shared-ui`) |
| Router | Node 22, no npm dependencies: static hosting, per-path CSP, streaming API proxies (`server/`) |
| Auth | App Service Easy Auth (Microsoft Entra ID); backends are reached only through the router, which forwards the user and a shared secret |
| Platform API | Python Azure Functions + Table/Blob Storage (`infra/functions/`) |
| FS Manager ingest | Python Azure Functions HOVTP listener with per-source approval (`infra/hovtp/`) |
| Infrastructure | Azure Bicep, deployed by GitHub Actions (`infra/`, `.github/workflows/`) |

## Repository layout

```
packages/shared-ui/   site nav, competition state + selector, shared competition dialog
site/                 Vite project: index.html + judgepapers/ scoremodifier/ protocolgenerator/ tools/banner/ tools/gdpr/
site/public/landing/  the public landing page (static HTML/CSS, no JS)
server/               router (server.js), its tests and env-var contract (server/README.md)
infra/                Bicep templates, platform API (functions/), HOVTP listener (hovtp/), MIGRATION.md
scripts/              build helpers (changelog fallback)
```

## Development

Requires Node 22 (and [uv](https://docs.astral.sh/uv/) for the Python suites).

```bash
npm install
npm run build --workspace=@figureskatingtools/shared-ui   # build before the site
npm run build --workspace=site                             # type-check + build all six entries
npm run dev --workspace=site                               # Vite dev server (no API proxies)
```

Full stack locally: build the site, then run the router against the dist with a fake signed-in user:

```bash
PUBLIC_DIR=site/dist DEV_FAKE_USER=you@example.com \
FUNCTION_APP_URL_PLATFORM=http://localhost:7071 \
node server/server.js            # → http://localhost:8080
```

Leave `DEV_FAKE_USER` unset to see the public landing page. See [server/README.md](server/README.md) for every environment variable.

### Tests

```bash
npm test --workspace=@figureskatingtools/shared-ui         # vitest
node --test server/*.test.js                               # router
cd infra/functions && uv run --with-requirements requirements.txt \
  --with-requirements requirements-dev.txt python -m pytest tests -q   # platform API
cd infra/hovtp && uv run --with-requirements requirements.txt \
  --with-requirements requirements-dev.txt python -m pytest tests -q   # HOVTP listener
```

CI (`.github/workflows/ci.yml`) runs these on every pull request.

## Deployment

`main` is production. Work happens on a branch, which is deployed to the test environment with a manual run of `deploy-site.yml` (`environment=test`), then merged to `main` through a pull request; the push to `main` deploys prod. The workflow deploys the infrastructure, the platform API, the HOVTP listener and finally the router plus the built frontend.

Commit messages on `main` appear verbatim in the site's **What's New** panel, so they are written for users: a plain title line and short `-` bullets.

## Related repositories

All in the [figureskatingtools](https://github.com/figureskatingtools) organisation:
[fs-judgepapers](https://github.com/figureskatingtools/fs-judgepapers) ·
[fs-protocolgenerator](https://github.com/figureskatingtools/fs-protocolgenerator) ·
[fs-scoremodifier](https://github.com/figureskatingtools/fs-scoremodifier)
