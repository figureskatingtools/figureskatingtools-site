param location string
param webAppName string
param appServicePlanName string
param skuName string = 'B1'
param skuTier string = 'Basic'
param customDomain string = ''
param authClientId string = ''
param authManagedIdentityClientId string = ''
param authManagedIdentityResourceId string = ''
param tenantId string = subscription().tenantId

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
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${authManagedIdentityResourceId}': {}
    }
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server.js'
    }
    httpsOnly: true
  }
}

resource authConfig 'Microsoft.Web/sites/config@2022-09-01' = if (!empty(authClientId)) {
  parent: webApp
  name: 'authsettingsV2'
  properties: {
    globalValidation: {
      requireAuthentication: false
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          clientSecretSettingName: 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID'
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            authClientId
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: false
      }
    }
  }
}

resource authAppSettings 'Microsoft.Web/sites/config@2022-09-01' = if (!empty(authClientId)) {
  parent: webApp
  name: 'appsettings'
  properties: {
    OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID: authManagedIdentityClientId
  }
}

// Step 1: Bind the custom domain (no SSL yet — cert needs this first)
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

// Step 2: Provision a managed certificate (requires the binding above)
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

// Step 3: Enable SSL on the binding via a nested module to avoid duplicate resource error
module sslBinding 'custom-domain-ssl.bicep' =
  if (!empty(customDomain)) {
    name: 'sslBindingDeployment'
    params: {
      webAppName: webApp.name
      customDomain: customDomain
      thumbprint: managedCertificate!.properties.thumbprint
    }
  }

output webAppName string = webApp.name
output webAppDefaultHostName string = webApp.properties.defaultHostName
