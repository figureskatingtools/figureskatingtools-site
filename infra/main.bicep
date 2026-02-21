targetScope = 'subscription'

param location string = 'swedencentral'
param resourceGroupName string = ''
param customDomain string = ''
param authClientId string = ''
param tenantId string = ''

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
}

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
    customDomain: customDomain
    authClientId: authClientId
    authManagedIdentityClientId: authManagedIdentity.outputs.clientId
    authManagedIdentityResourceId: authManagedIdentity.outputs.resourceId
    tenantId: !empty(tenantId) ? tenantId : subscription().tenantId
  }
}

output resourceGroupName string = rg.name
output webAppName string = webApp.outputs.webAppName
output webAppDefaultHostName string = webApp.outputs.webAppDefaultHostName
output authManagedIdentityClientId string = authManagedIdentity.outputs.clientId
output authManagedIdentityObjectId string = authManagedIdentity.outputs.principalId
