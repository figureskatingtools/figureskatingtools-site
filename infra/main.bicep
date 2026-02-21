targetScope = 'subscription'

param location string = 'swedencentral'
param resourceGroupName string = ''
param customDomain string = ''

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
}

module webApp 'modules/webapp.bicep' = {
  scope: rg
  name: 'webAppDeployment'
  params: {
    location: location
    webAppName: 'app-fs-site-${uniqueString(rg.id)}'
    appServicePlanName: 'asp-fs-site-web'
    customDomain: customDomain
  }
}

output resourceGroupName string = rg.name
output webAppName string = webApp.outputs.webAppName
output webAppDefaultHostName string = webApp.outputs.webAppDefaultHostName
