param location string
param webAppName string
param appServicePlanName string
param skuName string = 'B1'
param skuTier string = 'Basic'
param customDomain string = ''

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server.js'
    }
    httpsOnly: true
  }
}

// Custom domain binding — requires CNAME/TXT records to exist BEFORE deployment
resource customHostNameBinding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' =
  if (!empty(customDomain)) {
    name: customDomain
    parent: webApp
    properties: {
      siteName: webApp.name
      hostNameType: 'Verified'
      sslState: 'Disabled'
    }
  }

// App Service Managed Certificate (free TLS) — depends on hostname binding
resource managedCertificate 'Microsoft.Web/certificates@2023-12-01' =
  if (!empty(customDomain)) {
    name: '${customDomain}-cert'
    location: location
    properties: {
      serverFarmId: appServicePlan.id
      canonicalName: customDomain
    }
    dependsOn: [
      customHostNameBinding
    ]
  }

// Enable SNI SSL binding after certificate is provisioned
resource sslBinding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' =
  if (!empty(customDomain)) {
    name: customDomain
    parent: webApp
    properties: {
      siteName: webApp.name
      hostNameType: 'Verified'
      sslState: 'SniEnabled'
      thumbprint: managedCertificate!.properties.thumbprint
    }
  }

output webAppName string = webApp.name
output webAppDefaultHostName string = webApp.properties.defaultHostName
