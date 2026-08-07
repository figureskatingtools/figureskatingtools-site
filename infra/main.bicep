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

@description('Shared secret the router sends to the platform Function App as X-Proxy-Secret.')
@secure()
param proxySharedSecretPlatform string = ''

@description('System-assigned principal ids of the tool Function Apps that need read access to competition-data. May be empty on a first deploy.')
param toolFunctionPrincipalIds array = []

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
output toolPrincipalsGranted int = sharedDataAccess.outputs.grantedCount
output customDomain string = customDomain
output dnsZoneName string = dnsZoneName
output dnsResourceGroupName string = dnsRg.name
output dnsNameServers array = dns.outputs.nameServers
