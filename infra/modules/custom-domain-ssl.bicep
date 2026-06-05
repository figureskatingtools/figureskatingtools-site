param webAppName string
param customDomain string
param thumbprint string

resource webApp 'Microsoft.Web/sites@2023-12-01' existing = {
  name: webAppName
}

resource sslBinding 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = {
  name: customDomain
  parent: webApp
  properties: {
    siteName: webApp.name
    hostNameType: 'Verified'
    sslState: 'SniEnabled'
    thumbprint: thumbprint
  }
}
