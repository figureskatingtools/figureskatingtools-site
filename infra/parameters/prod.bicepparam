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

// HOVTP listener (FS Manager push endpoint). Off in prod until it has been proven
// in test — set the GitHub environment variable HOVTP_ENABLED=true to turn it on.
param hovtpEnabled = readEnvironmentVariable('HOVTP_ENABLED', 'false') == 'true'
param hovtpEnvironment = 'Production'

// Prod is published as https://api.figureskatingtools.com — Front Door Premium
// + WAF -> API Management -> the listener, live and verified (OPTIONS answers
// 200), with FS Manager repointed at it. Measured X-Forwarded-For at the
// function:
//   <FS Manager IP>, <Front Door IP>:<port>, <Front Door IP>, <APIM outbound IP>:<port>
// Front Door appends the client, APIM v2 appends two and App Service appends
// the socket peer, so the sender is the 4th entry from the right: 3 hops. At 0
// every message was attributed to APIM's outbound IP and accepting one source
// would have trusted all of them.
param hovtpTrustedProxyHops = 3

// The value APIM injects as X-Proxy-Secret, so the raw *.azurewebsites.net
// hostname stops being a way around the proxy chain. Owned by the publishing
// layer:
//   terraform -chdir=infra output -raw fs_hovtp_proxy_secret   (../azure-publishing)
// copied into this environment's GitHub secret PROXY_SHARED_SECRET_HOVTP.
// That secret is NOT set yet, so this resolves to '' and the listener's gate
// keeps failing open exactly as it does today — wiring it up here enforces
// nothing on its own. Adding the GitHub secret is the one step that turns
// enforcement on, and the `proxyHeader` field in the listener's log record is
// how to see beforehand who would be refused.
param hovtpProxySharedSecret = readEnvironmentVariable('PROXY_SHARED_SECRET_HOVTP', '')
