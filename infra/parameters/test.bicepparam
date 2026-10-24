using '../main.bicep'

param resourceGroupName = 'rg-fs-site-test'
param location = 'swedencentral'

// Set the GitHub environment variable SKIP_CUSTOM_DOMAIN=true to deploy the new
// Web App on its default *.azurewebsites.net hostname only — that is migration
// step 1 (new stack live alongside the untouched Static Web App). Clear it for
// the DNS cutover.
param customDomain = readEnvironmentVariable('SKIP_CUSTOM_DOMAIN', '') == 'true'
  ? ''
  : 'test.figureskatingtools.com'

// Supplied by the deploy workflow from GitHub environment secrets + vars. Read
// from the environment rather than passed on the command line so the shared
// secret never appears in a process argument list.
param authClientId = readEnvironmentVariable('AUTH_CLIENT_ID', '')
param tenantId = readEnvironmentVariable('AZURE_TENANT_ID', '')
param proxySharedSecretPlatform = readEnvironmentVariable('PROXY_SHARED_SECRET_PLATFORM', '')

// Router proxy targets + their shared secrets. Part of the template so the Web
// App is never deployed without them (FUNCTION_APP_URL_PLATFORM comes from the
// platform Function App module inside the deployment, not from here). Empty
// defaults keep a first deploy working before the tool repos publish their URLs.
param functionAppUrlJudgepapers = readEnvironmentVariable('FUNCTION_APP_URL_JUDGEPAPERS', '')
param functionAppUrlScoremodifier = readEnvironmentVariable('FUNCTION_APP_URL_SCOREMODIFIER', '')
param functionAppUrlProtocolgenerator = readEnvironmentVariable('FUNCTION_APP_URL_PROTOCOLGENERATOR', '')
param functionAppUrlGdprtool = readEnvironmentVariable('FUNCTION_APP_URL_GDPRTOOL', '')

// Easy Auth provider the router's /signin redirects to. Unset GitHub var arrives
// as '' and means aad; change it together with the auth config (Entra External ID).
param authLoginProvider = readEnvironmentVariable('AUTH_LOGIN_PROVIDER', 'aad')
param proxySharedSecretJudgepapers = readEnvironmentVariable('PROXY_SHARED_SECRET_JUDGEPAPERS', '')
param proxySharedSecretScoremodifier = readEnvironmentVariable('PROXY_SHARED_SECRET_SCOREMODIFIER', '')
param proxySharedSecretProtocolgenerator = readEnvironmentVariable('PROXY_SHARED_SECRET_PROTOCOLGENERATOR', '')
param proxySharedSecretGdprtool = readEnvironmentVariable('PROXY_SHARED_SECRET_GDPRTOOL', '')

// Admins are whoever carries this app role (GitHub environment variable
// ADMIN_ROLE; unset = Site.Admin). There is no e-mail list.
param adminRole = readEnvironmentVariable('ADMIN_ROLE', '')

// Entra tenants whose users may use the site (comma-separated), from the GitHub
// environment variable ALLOWED_TENANT_IDS. Unset = the deployment tenant only.
param allowedTenantIds = readEnvironmentVariable('ALLOWED_TENANT_IDS', '')

// Entra External ID (customer tenant), from the GitHub environment variables
// AUTH_TENANT_MODE, EXTERNAL_TENANT_ID, AUTH_EXTERNAL_CLIENT_ID and
// AUTH_EXTERNAL_AUTHORITY_HOST. AUTH_TENANT_MODE=external points Easy Auth at
// the External ID tenant; anything else (unset arrives as '') = workforce.
// EXTERNAL_TENANT_ID alone only adds the tenant to the allowed ones. There is no
// secret here and there never will be: external mode is credential-free
// (ID-token flow) — see infra/EXTERNAL-ID.md.
param authTenantMode = readEnvironmentVariable('AUTH_TENANT_MODE', '') == 'external' ? 'external' : 'workforce'
param externalTenantId = readEnvironmentVariable('EXTERNAL_TENANT_ID', '')
param externalClientId = readEnvironmentVariable('AUTH_EXTERNAL_CLIENT_ID', '')
param externalAuthorityHost = readEnvironmentVariable('AUTH_EXTERNAL_AUTHORITY_HOST', '')
// App role External ID users need (else the /no-access/ page). Unset = Site.Access.
param externalAccessRole = readEnvironmentVariable('EXTERNAL_ACCESS_ROLE', '')
// New External ID users are created as in production (EXTERNAL_NEW_USERS_ENABLED;
// only the literal 'false' turns it off), so testers get in without linking.
param externalNewUsersEnabled = readEnvironmentVariable('EXTERNAL_NEW_USERS_ENABLED', 'true') != 'false'

// System-assigned principal ids of the tool Function Apps, for read access to
// the shared competition-data container. Empty entries are ignored, so this
// works before the tool repos have been reduced (workstream 6).
param toolFunctionPrincipalIds = [
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_JUDGEPAPERS', '')
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_SCOREMODIFIER', '')
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_PROTOCOLGENERATOR', '')
]

// HOVTP listener (FS Manager push endpoint). Enabled in test by default; set the
// GitHub environment variable HOVTP_ENABLED=false to kill it without a code change
// (the app stays deployed and answers 503).
// The workflow always exports the variable, so an unset GitHub var arrives as ''
// — anything but the literal 'false' keeps the listener on.
param hovtpEnabled = readEnvironmentVariable('HOVTP_ENABLED', 'true') != 'false'

// Platform retention sweep: purges for real by default (same as prod); set the
// GitHub environment variable RETENTION_PURGE_ENABLED=false as the kill switch
// (dry-run logging only).
param retentionPurgeEnabled = readEnvironmentVariable('RETENTION_PURGE_ENABLED', 'true') != 'false'
param hovtpEnvironment = 'Test'

// Test is published as https://test-api.figureskatingtools.com — Front Door
// Premium + WAF -> API Management (Basic v2) -> the listener. Measured
// X-Forwarded-For at the function:
//   <FS Manager>, <Front Door>:<port>, <Front Door>, <APIM outbound>:<port>
// so FS Manager is the 4th entry from the right. At 0 every message is
// attributed to APIM's outbound IP and one accepted source would trust all.
param hovtpTrustedProxyHops = 3

// The value APIM injects as X-Proxy-Secret, so the raw *.azurewebsites.net
// hostname stops being a way around the proxy chain. It is owned by the
// publishing layer:
//   terraform -chdir=infra output -raw fs_test_hovtp_proxy_secret   (../azure-publishing)
// copied into this environment's GitHub secret PROXY_SHARED_SECRET_HOVTP.
// Empty (unset) leaves the gate off rather than locking FS Manager out.
param hovtpProxySharedSecret = readEnvironmentVariable('PROXY_SHARED_SECRET_HOVTP', '')
