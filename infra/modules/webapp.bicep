// The single figureskatingtools.com Web App: a dependency-free Node router
// (server/server.js) that serves the combined Vite dist from public/ and
// proxies /<tool>/api/* + /api/* to the per-tool and platform Function Apps.
//
// Replaces the former Static Web App and the per-tool Web Apps: one B1 Linux
// plan, one Easy Auth (AAD) gate, one custom domain.
param location string
param webAppName string
param appServicePlanName string
param skuName string = 'B1'
param skuTier string = 'Basic'
param authClientId string = ''
param authManagedIdentityClientId string = ''
param authManagedIdentityResourceId string = ''
param tenantId string = subscription().tenantId

@description('Paths served without an Easy Auth login redirect. /health must stay open so Azure/uptime probes get a 200 instead of a 302.')
param authExcludedPaths array = [
  '/health'
]

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
      // B1 is a dedicated plan: keep the router warm so the first request after
      // an idle period doesn't pay a cold start on top of the Function App's.
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
    }
    httpsOnly: true
  }
}

resource authConfig 'Microsoft.Web/sites/config@2022-09-01' = if (!empty(authClientId)) {
  parent: webApp
  name: 'authsettingsV2'
  properties: {
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: authExcludedPaths
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: authClientId
          // Sentinel value: Easy Auth uses the federated managed identity named
          // by the app setting of this name instead of a client secret.
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

// NOTE: `Microsoft.Web/sites/config@.../appsettings` REPLACES the whole app
// settings collection. This deployment therefore owns only the FIC sentinel;
// the runtime settings that change independently of infra
// (FUNCTION_APP_URL_*, PROXY_SHARED_SECRET_*, SCM_DO_BUILD_DURING_DEPLOYMENT)
// are (re)applied by the deploy-frontend job, which always runs after
// deploy-infra in the same workflow. Never deploy infra alone against a live
// environment without re-running deploy-frontend.
resource authAppSettings 'Microsoft.Web/sites/config@2022-09-01' = if (!empty(authClientId)) {
  parent: webApp
  name: 'appsettings'
  properties: {
    OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID: authManagedIdentityClientId
  }
}

output webAppName string = webApp.name
output webAppDefaultHostName string = webApp.properties.defaultHostName
output customDomainVerificationId string = webApp.properties.customDomainVerificationId
// `inboundIpAddress` is returned by the ARM GET (it is what
// `az webapp show --query inboundIpAddress` reads) but is missing from the
// generated Bicep type for Microsoft.Web/sites, hence the suppression.
@description('Inbound VIP of the App Service. The apex A record points at this literal IP (Azure DNS alias records cannot target App Service).')
#disable-next-line BCP053
output inboundIpAddress string = webApp.properties.inboundIpAddress
output appServicePlanId string = appServicePlan.id
