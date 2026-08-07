using '../main.bicep'

param resourceGroupName = 'rg-fs-site-prod'
param location = 'swedencentral'

// Apex. App Service verifies ownership with the `asuid` TXT record and routes
// via a plain A record holding the Web App's inbound VIP (Azure DNS ALIAS
// records cannot target App Service). The SWA-era `apexValidationToken` /
// `_dnsauth` TXT scheme is gone — delete that record at cutover.
//
// Set the GitHub environment variable SKIP_CUSTOM_DOMAIN=true to deploy on the
// default *.azurewebsites.net hostname only (migration step 1: new stack live
// alongside the untouched Static Web App). Clear it for the DNS cutover.
param customDomain = readEnvironmentVariable('SKIP_CUSTOM_DOMAIN', '') == 'true'
  ? ''
  : 'figureskatingtools.com'

// Supplied by the deploy workflow from GitHub environment secrets + vars. Read
// from the environment rather than passed on the command line so the shared
// secret never appears in a process argument list.
param authClientId = readEnvironmentVariable('AUTH_CLIENT_ID', '')
param tenantId = readEnvironmentVariable('AZURE_TENANT_ID', '')
param proxySharedSecretPlatform = readEnvironmentVariable('PROXY_SHARED_SECRET_PLATFORM', '')

// System-assigned principal ids of the tool Function Apps, for read access to
// the shared competition-data container. Empty entries are ignored, so this
// works before the tool repos have been reduced (workstream 6).
param toolFunctionPrincipalIds = [
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_JUDGEPAPERS', '')
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_SCOREMODIFIER', '')
  readEnvironmentVariable('TOOL_PRINCIPAL_ID_PROTOCOLGENERATOR', '')
]
