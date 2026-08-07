# Migration: Static Web App → single App Service router

Everything CI cannot do for itself, in the order it has to happen. Rehearse the
whole list on `test` before touching `prod`.

The target: one Web App per environment (`app-fs-site-*` on `asp-fs-site-web`,
B1 Linux) running `server/server.js`, serving the combined Vite dist from
`public/` and proxying `/api/*` to a new platform Function App plus
`/<tool>/api/*` to the existing per-tool Function Apps. The Static Web App and
the three tool Web Apps go away.

---

## 1. GitHub configuration (per environment: `test`, `prod`)

The workflow fails fast if `AUTH_APP_OBJECT_ID` is missing; everything else
degrades quietly, so check the names carefully.

### Secrets — exact names

| Secret | Value | Notes |
| --- | --- | --- |
| `AZURE_CLIENT_ID` | deploy service principal (OIDC) | already exists |
| `AUTH_CLIENT_ID` | Entra app registration **client id** used by Easy Auth | already exists |
| `AUTH_APP_OBJECT_ID` | that app registration's **object id** (not the client id) | **new** — `az ad app show --id <client-id> --query id -o tsv` |
| `PROXY_SHARED_SECRET_PLATFORM` | new random secret for the platform Function App | **new** — e.g. `openssl rand -hex 32` |
| `PROXY_SHARED_SECRET_JUDGEPAPERS` | copy of that tool's existing `PROXY_SHARED_SECRET` | **new here**, same value as in the tool repo |
| `PROXY_SHARED_SECRET_SCOREMODIFIER` | ditto | **new here** |
| `PROXY_SHARED_SECRET_PROTOCOLGENERATOR` | ditto | **new here** |
| `AUTH_CLIENT_SECRET` | SWA-era client secret | **delete after cutover** — the FIC replaces it |

Reusing each tool's *existing* proxy secret is deliberate: the old tool Web Apps
and the new router then work in parallel during the migration. Rotate all four
after teardown (step 7).

### Variables — exact names

| Variable | Value | Notes |
| --- | --- | --- |
| `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `LOCATION` | — | already exist |
| `FUNCTION_APP_URL_JUDGEPAPERS` | `https://func-fs-judgepapers-<suffix>.azurewebsites.net` | **new** |
| `FUNCTION_APP_URL_SCOREMODIFIER` | `https://func-fs-scoremodifier-<suffix>.azurewebsites.net` | **new** |
| `FUNCTION_APP_URL_PROTOCOLGENERATOR` | `https://func-fs-protocols-<suffix>.azurewebsites.net` | **new** |
| `TOOL_PRINCIPAL_ID_JUDGEPAPERS` | that Function App's **system-assigned principal id** | **new**, optional at first |
| `TOOL_PRINCIPAL_ID_SCOREMODIFIER` | ditto | **new**, optional at first |
| `TOOL_PRINCIPAL_ID_PROTOCOLGENERATOR` | ditto | **new**, optional at first |
| `SKIP_CUSTOM_DOMAIN` | `true` during step 3, unset/empty afterwards | **new** |

The URLs and principal ids come from each tool repo's own deployment:

```bash
az functionapp show -g <tool-rg> -n <func-app> \
  --query "{url:defaultHostName, principalId:identity.principalId}" -o json
```

`TOOL_PRINCIPAL_ID_*` may be left unset on the first deploys —
`shared-data-access.bicep` filters empty entries, so the role assignments simply
aren't created yet. Fill them in and re-run once the tool repos are reduced.

`RESOURCE_GROUP_NAME` / `CUSTOM_DOMAIN` are **not** used by this repo; both live
in `infra/parameters/<env>.bicepparam`.

---

## 2. One-time Azure / Entra grants

Both are things the deploy principal cannot grant itself.

### a. Entra: deploy SP must own the auth app registration

The workflow PATCHes redirect URIs and creates a federated identity credential
via Microsoft Graph. Mirror how the tool repos' SPs are set up — make the deploy
SP an **owner** of the app registration (or grant it
`Application.ReadWrite.OwnedBy` plus ownership):

```bash
DEPLOY_SP_OBJECT_ID=$(az ad sp show --id <AZURE_CLIENT_ID> --query id -o tsv)
az ad app owner add --id <AUTH_APP_OBJECT_ID> --owner-object-id "$DEPLOY_SP_OBJECT_ID"
```

Verify before the first run:

```bash
az ad app owner list --id <AUTH_APP_OBJECT_ID> --query "[].id" -o tsv
```

**Fallback if this grant can't be obtained:** delete the
`Update auth app registration (redirect URIs + FIC)` step from
`deploy-site.yml`, keep managing redirect URIs by hand, and re-create the FIC
manually after every test-environment rebuild (the managed identity's principal
id changes when `rg-fs-site-test` is torn down):

```bash
az ad app federated-credential create --id <AUTH_APP_OBJECT_ID> --parameters '{
  "name": "easyauth-managed-identity-fic",
  "issuer": "https://login.microsoftonline.com/<tenant-id>/v2.0",
  "subject": "<mi-principal-id>",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

### b. Azure RBAC: deploy SP must be able to write role assignments

`platform-roleassignment.bicep` and `shared-data-access.bicep` create
`Microsoft.Authorization/roleAssignments`. **Contributor cannot do this.** Check:

```bash
az role assignment list --assignee <AZURE_CLIENT_ID> --all \
  --query "[].{role:roleDefinitionName, scope:scope}" -o table
```

If the SP only has Contributor, upgrade it at the subscription (or site
resource-group) scope to **User Access Administrator** — or, least-privilege,
**Role Based Access Control Administrator**:

```bash
az role assignment create \
  --assignee <AZURE_CLIENT_ID> \
  --role "Role Based Access Control Administrator" \
  --scope /subscriptions/<sub-id>
```

Symptom if you skip this: the bicep deployment fails with
`AuthorizationFailed` on `Microsoft.Authorization/roleAssignments/write`.

---

## 3. Prep — zero user impact

1. Set `SKIP_CUSTOM_DOMAIN=true` in the target GitHub environment.
2. Run `deploy-site.yml` (workflow_dispatch → `test`). This creates the new Web
   App, platform Function App + storage, and the DNS zone records it owns
   (none, while `customDomain` is empty). The Static Web App and the tool Web
   Apps are untouched and still serving users.
3. Add the new Web App's default hostname callback to the app registration —
   the workflow does this automatically once the Entra grant from §2a is in
   place.

> The bicep `appsettings` resource REPLACES the whole collection, so it owns
> every setting the router needs: the FIC sentinel, `FUNCTION_APP_URL_*`
> (platform from the platform Function App module's output, the tools from the
> GitHub environment vars passed into the template) and `PROXY_SHARED_SECRET_*`.
> `deploy-infra` is therefore atomic — running it alone no longer leaves the
> router without proxy targets while it waits for `deploy-frontend`.

## 4. Verify on the default hostname

Against `https://app-fs-site-<suffix>.azurewebsites.net`:

- [ ] `/health` returns 200 **without** a login redirect (Easy Auth `excludedPaths`)
- [ ] `/` redirects to Entra login and comes back signed in; `/userinfo` returns the user
- [ ] `/api/competitions` — create, list, get, rename code, delete; duplicate code → 409
- [ ] selector persists across reload and syncs across tabs
- [ ] each tool path deep-links + hard-refreshes correctly; per-prefix CSP; `/assets/*` all 200
- [ ] per-tool E2E: 25 MB PDF upload, 100 MiB ZIP, `get_file` as `<img>` / pdf.js input
- [ ] Application Insights `ai-fs-platform` is receiving traces

## 5. DNS cutover (off-peak)

1. **A day ahead**: lower the apex/`test` record TTL to 300 in the Azure zone.
2. Delete the Static Web App's custom-domain binding first — a hostname can be
   bound to only one Azure resource at a time and App Service will refuse the
   binding otherwise:
   ```bash
   az staticwebapp hostname delete -n <swa-name> -g rg-fs-site-<env> --hostname <domain> --yes
   ```
3. Delete the obsolete SWA validation record:
   ```bash
   az network dns record-set txt delete -g rg-fs-dns -z figureskatingtools.com -n _dnsauth --yes
   ```
   (`test` env: the old `test` CNAME target is simply overwritten by the deploy.)
4. Clear `SKIP_CUSTOM_DOMAIN` and re-run the workflow. It writes the apex A
   record (Web App inbound IP) / `test` CNAME plus the `asuid` TXT, then binds
   the hostname, issues the managed certificate and enables SNI.
5. Expect a few minutes of certificate-issuance window. Re-run the workflow if
   the binding raced ahead of DNS propagation — it is idempotent.
6. Confirm redirect URIs on the app registration now include the custom domain,
   then **delete the app registration's client secret** (`AUTH_CLIENT_SECRET`);
   the federated credential has replaced it.

> The apex A record holds a literal IP. It is re-asserted on every infra deploy,
> so an App Service plan move self-heals on the next run — but keep the TTL at
> 300 and re-deploy if the site ever goes dark after an Azure-side move.

## 6. Old subdomain redirects (keep 2–4 weeks)

For each old tool Web App: drop the Easy Auth requirement so the redirect works
for signed-out visitors, then deploy a ~15-line 301 server pointing at
`https://figureskatingtools.com/<tool>/`.

```bash
az rest --method GET --uri "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Web/sites/<app>/config/authsettingsV2?api-version=2022-09-01" > auth.json
# set properties.globalValidation.requireAuthentication=false,
#     properties.globalValidation.unauthenticatedClientAction="AllowAnonymous"
az rest --method PUT --uri "<same-uri>" --body @auth.json
```

## 7. Teardown

- [ ] Static Web Apps `swa-fs-site-test` + `swa-fs-site-prod`
- [ ] tool Web Apps `app-fs-{judgepapers,scoremodifier,protocols}-*` and their
      `asp-*-web` plans (both envs)
- [ ] tool auth managed identities `mi-fs-*-auth-*`
- [ ] tool Entra app registrations + their federated credentials
- [ ] DNS: `judgepapers` / `test.judgepapers` / `scoremodifier` /
      `protocolgenerator` CNAMEs + matching `asuid.*` TXT records
- [ ] rotate all four `PROXY_SHARED_SECRET_*` values (site repo secret +
      the Function App setting in each tool repo, in that order)
- [ ] delete `frontend/` from the three tool repos
- [ ] mark `packages/shared-ui` private, drop `publishConfig`, retire
      `publish-shared-ui.yml`
- [ ] delete `site/public/staticwebapp.config.json`
- [ ] `rg-fs-dns` is **shared and persistent** — never torn down with an env

Nothing is migrated data-wise. The per-tool competition tables keep their legacy
8-hex ids; a `platformCompetitionId` column is a later seam, not part of this
cutover.
