targetScope = 'subscription'

param location string = 'swedencentral'
param resourceGroupName string = ''
param customDomain string = ''

resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
}

module staticWebApp 'modules/staticwebapp.bicep' = {
  scope: rg
  name: 'staticWebAppDeployment'
  params: {
    name: 'swa-fs-site-${uniqueString(rg.id)}'
    customDomain: customDomain
  }
}

output resourceGroupName string = rg.name
output swaName string = staticWebApp.outputs.name
output swaDefaultHostname string = staticWebApp.outputs.defaultHostname
