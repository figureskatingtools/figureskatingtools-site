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
param proxySharedSecretJudgepapers = readEnvironmentVariable('PROXY_SHARED_SECRET_JUDGEPAPERS', '')
param proxySharedSecretScoremodifier = readEnvironmentVariable('PROXY_SHARED_SECRET_SCOREMODIFIER', '')
param proxySharedSecretProtocolgenerator = readEnvironmentVariable('PROXY_SHARED_SECRET_PROTOCOLGENERATOR', '')

// System-assigned principal ids of the tool Function Apps, for read access to
// the shared competition-data container. Empty entries are ignored, so this
// works before the tool repos have been reduced (workstream 6).
param toolFunctionPrincipalIds = [
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_JUDGEPAPERS', '')
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_SCOREMODIFIER', '')
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_PROTOCOLGENERATOR', '')
]
