param name string
param location string = 'westeurope' // SWA management plane; content served from global CDN

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {}
}

output name string = staticWebApp.name
output id string = staticWebApp.id
output defaultHostname string = staticWebApp.properties.defaultHostname
