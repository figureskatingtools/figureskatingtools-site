targetScope = 'subscription'

// figureskatingtools.com — one domain, one Web App.
//
// The site resource group holds:
//   * the router Web App (asp-fs-site-web B1 Linux + app-fs-site-*) behind
//     Easy Auth (AAD) using a federated managed identity instead of a secret
//   * the platform Function App (competitions registry) + its storage
// The shared DNS zone lives in its own persistent resource group and is
// create-or-update idempotent across environments.

param location string = 'swedencentral'
param resourceGroupName string = ''

@description('Custom domain for this environment. Empty = deploy on the default *.azurewebsites.net hostname only (used during migration, before the DNS cutover).')
param customDomain string = ''

@description('Resource group that holds the single shared DNS zone. Persistent + shared by every environment; not torn down with a test env.')
param dnsResourceGroupName string = 'rg-fs-dns'

@description('The DNS zone / apex domain name.')
param dnsZoneName string = 'figureskatingtools.com'

@description('Client id of the per-environment Entra app registration used by Easy Auth.')
param authClientId string = ''

@description('Entra tenant id. Defaults to the deployment subscription tenant.')
param tenantId string = ''

@description('Shared secret the router sends to the platform Function App as X-Proxy-Secret. Also written to the Web App so the router and the backend agree.')
@secure()
param proxySharedSecretPlatform string = ''

// Router proxy targets. The tool Function Apps live in their own repos, so their
// URLs come in as GitHub environment vars; the platform Function App's URL is
// taken from its module output below (same deployment). Carried in the template
// so the Web App is never deployed without them — see modules/webapp.bicep.

@description('Base URL of the judgepapers Function App (fs-judgepapers repo). Empty = that tool\'s API proxies 502 until it is set.')
param functionAppUrlJudgepapers string = ''

@description('Base URL of the scoremodifier Function App (fs-scoremodifier repo).')
param functionAppUrlScoremodifier string = ''

@description('Base URL of the protocolgenerator Function App (fs-protocolgenerator repo).')
param functionAppUrlProtocolgenerator string = ''

@description('Shared secret the router sends to the judgepapers Function App.')
@secure()
param proxySharedSecretJudgepapers string = ''

@description('Shared secret the router sends to the scoremodifier Function App.')
@secure()
param proxySharedSecretScoremodifier string = ''

@description('Shared secret the router sends to the protocolgenerator Function App.')
@secure()
param proxySharedSecretProtocolgenerator string = ''

@description('System-assigned principal ids of the tool Function Apps that need read access to competition-data. May be empty on a first deploy.')
param toolFunctionPrincipalIds array = []

@description('Kill switch for the HOVTP listener. false = the app is still deployed but answers every request 503 (see modules/hovtp-function.bicep).')
param hovtpEnabled bool = true

@description('Environment the HOVTP listener reports to FS Manager.')
@allowed([
  'Test'
  'Production'
])
param hovtpEnvironment string = 'Test'

@description('Reverse proxies we own in front of the HOVTP listener. 3 when it is published through Front Door + WAF -> API Management (test), 0 when FS Manager posts straight at the Function App (prod, for now). See modules/hovtp-function.bicep.')
param hovtpTrustedProxyHops int = 0

@description('Shared secret API Management injects as X-Proxy-Secret on forwarded HOVTP requests. Empty = the listener accepts direct callers (gate off).')
@secure()
param hovtpProxySharedSecret string = ''

// Per-environment site resource group.
resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
}

// Shared DNS resource group. Created (idempotently) by every environment so the zone
// exists regardless of which environment deploys first, and survives test teardown.
resource dnsRg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: dnsResourceGroupName
  location: location
}

// --- Router Web App -------------------------------------------------------------

module authManagedIdentity 'modules/auth-identity.bicep' = {
  scope: rg
  name: 'authIdentityDeployment'
  params: {
    location: location
    managedIdentityName: 'mi-fs-site-auth-${uniqueString(rg.id)}'
  }
}

module webApp 'modules/webapp.bicep' = {
  scope: rg
  name: 'webAppDeployment'
  params: {
    location: location
    webAppName: 'app-fs-site-${uniqueString(rg.id)}'
    appServicePlanName: 'asp-fs-site-web'
    authClientId: authClientId
    authManagedIdentityClientId: authManagedIdentity.outputs.clientId
    authManagedIdentityResourceId: authManagedIdentity.outputs.resourceId
    tenantId: !empty(tenantId) ? tenantId : subscription().tenantId
    // The platform Function App is created by this same deployment, so its URL
    // comes straight from the module output (forward reference — Bicep orders
    // the modules by this dependency). The tool Function Apps are deployed from
    // their own repos and are passed in as parameters.
    functionAppUrlPlatform: platformFunction.outputs.functionAppUrl
    functionAppUrlJudgepapers: functionAppUrlJudgepapers
    functionAppUrlScoremodifier: functionAppUrlScoremodifier
    functionAppUrlProtocolgenerator: functionAppUrlProtocolgenerator
    proxySharedSecretPlatform: proxySharedSecretPlatform
    proxySharedSecretJudgepapers: proxySharedSecretJudgepapers
    proxySharedSecretScoremodifier: proxySharedSecretScoremodifier
    proxySharedSecretProtocolgenerator: proxySharedSecretProtocolgenerator
  }
}

// --- Platform backend (competitions registry) -----------------------------------

module platformStorage 'modules/platform-storage.bicep' = {
  scope: rg
  name: 'platformStorageDeployment'
  params: {
    location: location
    storageAccountName: 'stfsplat${uniqueString(rg.id)}'
  }
}

// The listener's own storage account. It is anonymous and internet-facing, so
// its Functions host state must not sit next to the platform app's deployment
// package — see modules/hovtp-storage.bicep.
module hovtpStorage 'modules/hovtp-storage.bicep' = {
  scope: rg
  name: 'hovtpStorageDeployment'
  params: {
    location: location
    storageAccountName: 'stfshovtp${uniqueString(rg.id)}'
  }
}

module platformFunction 'modules/platform-function.bicep' = {
  scope: rg
  name: 'platformFunctionDeployment'
  params: {
    location: location
    functionAppName: 'func-fs-platform-${uniqueString(rg.id)}'
    appServicePlanName: 'asp-fs-platform'
    appInsightsName: 'ai-fs-platform'
    storageAccountName: platformStorage.outputs.storageAccountName
    deploymentContainerUrl: platformStorage.outputs.deploymentContainerUrl
    dataContainerName: platformStorage.outputs.dataContainerName
    proxySharedSecret: proxySharedSecretPlatform
  }
}

module platformRoleAssignment 'modules/platform-roleassignment.bicep' = {
  scope: rg
  name: 'platformRoleAssignmentDeployment'
  params: {
    storageAccountName: platformStorage.outputs.storageAccountName
    functionPrincipalId: platformFunction.outputs.functionPrincipalId
  }
}

// --- HOVTP listener (FS Manager push endpoint) ----------------------------------

// Separate Function App on purpose: the only anonymous, internet-facing surface
// of the platform, so it can be stopped or revoked without touching the site API.
// Own storage account, own plan, own identity; shares only the ai-fs-platform
// App Insights component and — through narrowly scoped RBAC below — the
// competition-data container and competitions table of the platform account.
module hovtpFunction 'modules/hovtp-function.bicep' = {
  scope: rg
  name: 'hovtpFunctionDeployment'
  params: {
    location: location
    functionAppName: 'func-fs-hovtp-${uniqueString(rg.id)}'
    appServicePlanName: 'asp-fs-hovtp'
    storageAccountName: hovtpStorage.outputs.storageAccountName
    deploymentContainerUrl: hovtpStorage.outputs.deploymentContainerUrl
    dataStorageAccountName: platformStorage.outputs.storageAccountName
    appInsightsConnectionString: platformFunction.outputs.appInsightsConnectionString
    dataContainerName: platformStorage.outputs.dataContainerName
    hovtpEnabled: hovtpEnabled
    hovtpEnvironment: hovtpEnvironment
    hovtpTrustedProxyHops: hovtpTrustedProxyHops
    hovtpProxySharedSecret: hovtpProxySharedSecret
  }
}

// Account-scoped Blob Data Contributor on the listener's OWN account only: the
// Functions host creates azure-webjobs-hosts/-secrets itself, which
// container-scoped RBAC cannot do. That account holds nothing but host state
// and the listener's deployment package, so the wide scope costs nothing.
module hovtpHostRoleAssignment 'modules/hovtp-host-roleassignment.bicep' = {
  scope: rg
  name: 'hovtpHostRoleAssignmentDeployment'
  params: {
    storageAccountName: hovtpStorage.outputs.storageAccountName
    functionPrincipalId: hovtpFunction.outputs.functionPrincipalId
  }
}

// Everything the listener may touch in the PLATFORM account: the
// `competition-data` container and the `competitions` table, each scoped to the
// child resource — no account-scoped role, so `app-package` (the platform app's
// deployment zip) is out of reach. Replaces the old account-scoped
// hovtpRoleAssignment; incremental deployment does not delete that one, so see
// infra/MIGRATION.md for the manual removal.
module hovtpDataAccess 'modules/hovtp-data-access.bicep' = {
  scope: rg
  name: 'hovtpDataAccessDeployment'
  params: {
    storageAccountName: platformStorage.outputs.storageAccountName
    dataContainerName: platformStorage.outputs.dataContainerName
    functionPrincipalId: hovtpFunction.outputs.functionPrincipalId
  }
}

// Cross-tool read access to the shared competition-data container. No-op until
// the TOOL_PRINCIPAL_ID_* GitHub env vars are populated.
module sharedDataAccess 'modules/shared-data-access.bicep' = {
  scope: rg
  name: 'sharedDataAccessDeployment'
  params: {
    storageAccountName: platformStorage.outputs.storageAccountName
    toolPrincipalIds: toolFunctionPrincipalIds
  }
}

// --- DNS + custom domain --------------------------------------------------------

// Single zone for the whole apex + every subdomain. Each environment declares only its
// own record set; incremental deployments leave all other records (other envs, the
// tool CNAMEs, MX, etc.) untouched.
module dns 'modules/dns.bicep' = {
  scope: dnsRg
  name: 'dnsDeployment'
  params: {
    zoneName: dnsZoneName
    customDomain: customDomain
    webAppInboundIpAddress: webApp.outputs.inboundIpAddress
    webAppDefaultHostname: webApp.outputs.webAppDefaultHostName
    domainVerificationId: webApp.outputs.customDomainVerificationId
  }
}

// Bind the custom domain only after the DNS records exist: App Service validation
// reads public DNS, so the A/CNAME + asuid TXT records must already resolve.
module webAppCustomDomain 'modules/webapp-customdomain.bicep' = if (!empty(customDomain)) {
  scope: rg
  name: 'customDomainDeployment'
  params: {
    webAppName: webApp.outputs.webAppName
    customDomain: customDomain
    appServicePlanId: webApp.outputs.appServicePlanId
    location: location
  }
  dependsOn: [
    dns
  ]
}

output resourceGroupName string = rg.name
output webAppName string = webApp.outputs.webAppName
output webAppDefaultHostName string = webApp.outputs.webAppDefaultHostName
output webAppInboundIpAddress string = webApp.outputs.inboundIpAddress
output authManagedIdentityClientId string = authManagedIdentity.outputs.clientId
output authManagedIdentityObjectId string = authManagedIdentity.outputs.principalId
output platformFunctionAppName string = platformFunction.outputs.functionAppName
output platformFunctionAppUrl string = platformFunction.outputs.functionAppUrl
output platformFunctionPrincipalId string = platformFunction.outputs.functionPrincipalId
output platformStorageAccountName string = platformStorage.outputs.storageAccountName
output hovtpStorageAccountName string = hovtpStorage.outputs.storageAccountName
output hovtpFunctionAppName string = hovtpFunction.outputs.functionAppName
output hovtpFunctionAppUrl string = hovtpFunction.outputs.functionAppUrl
output hovtpFunctionPrincipalId string = hovtpFunction.outputs.functionPrincipalId
// Surfaced so CI can run the listener smoke check (and stamp its
// X-HOVTP-Environment header) from what was actually deployed, instead of
// re-deriving the per-environment bicepparam defaults in shell.
output hovtpEnabled bool = hovtpEnabled
output hovtpEnvironment string = hovtpEnvironment
output toolPrincipalsGranted int = sharedDataAccess.outputs.grantedCount
output customDomain string = customDomain
output dnsZoneName string = dnsZoneName
output dnsResourceGroupName string = dnsRg.name
output dnsNameServers array = dns.outputs.nameServers
