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

// --- Router proxy targets -------------------------------------------------------
// The router resolves /api/* and /<tool>/api/* against these. They are part of the
// template (not a post-deploy az CLI step) so a deployment never leaves the site
// running with no proxy targets — see the appsettings note below.

@description('Base URL of the platform Function App (competitions registry) — the /api/* proxy target.')
param functionAppUrlPlatform string = ''

@description('Base URL of the judgepapers Function App — the /judgepapers/api/* proxy target.')
param functionAppUrlJudgepapers string = ''

@description('Base URL of the scoremodifier Function App — the /scoremodifier/api/* proxy target.')
param functionAppUrlScoremodifier string = ''

@description('Base URL of the protocolgenerator Function App — the /protocolgenerator/api/* proxy target.')
param functionAppUrlProtocolgenerator string = ''

@description('X-Proxy-Secret the router sends to the platform Function App. Intentionally empty by default — the backend fails open when its own secret is unset.')
@secure()
param proxySharedSecretPlatform string = ''

@description('X-Proxy-Secret the router sends to the judgepapers Function App.')
@secure()
param proxySharedSecretJudgepapers string = ''

@description('X-Proxy-Secret the router sends to the scoremodifier Function App.')
@secure()
param proxySharedSecretScoremodifier string = ''

@description('X-Proxy-Secret the router sends to the protocolgenerator Function App.')
@secure()
param proxySharedSecretProtocolgenerator string = ''

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
// settings collection, so EVERY setting the router needs must be listed here.
// The proxy targets and their shared secrets used to be applied afterwards by
// the deploy-frontend job's az CLI step; any run that failed in between left the
// router with no proxy targets and every /api call 502'd. They are now part of
// the same deployment as the Web App itself, which makes infra atomic.
// Empty values are written deliberately (PROXY_SHARED_SECRET_PLATFORM is
// normally empty — the backend fails open when its own secret is unset).
resource siteAppSettings 'Microsoft.Web/sites/config@2022-09-01' = {
  parent: webApp
  name: 'appsettings'
  properties: union(
    {
      FUNCTION_APP_URL_PLATFORM: functionAppUrlPlatform
      FUNCTION_APP_URL_JUDGEPAPERS: functionAppUrlJudgepapers
      FUNCTION_APP_URL_SCOREMODIFIER: functionAppUrlScoremodifier
      FUNCTION_APP_URL_PROTOCOLGENERATOR: functionAppUrlProtocolgenerator
      PROXY_SHARED_SECRET_PLATFORM: proxySharedSecretPlatform
      PROXY_SHARED_SECRET_JUDGEPAPERS: proxySharedSecretJudgepapers
      PROXY_SHARED_SECRET_SCOREMODIFIER: proxySharedSecretScoremodifier
      PROXY_SHARED_SECRET_PROTOCOLGENERATOR: proxySharedSecretProtocolgenerator
      // The zip already contains the built dist; Oryx must not try to build it.
      SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
    },
    // Sentinel read by the authsettingsV2 clientSecretSettingName above; only
    // meaningful when Easy Auth is configured.
    empty(authClientId)
      ? {}
      : {
          OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID: authManagedIdentityClientId
        }
  )
}

output webAppName string = webApp.name
output webAppDefaultHostName string = webApp.properties.defaultHostName
output customDomainVerificationId string = webApp.properties.customDomainVerificationId
// `inboundIpAddress` is returned by the ARM GET (it is what
// `az webapp show --query inboundIpAddress` reads) but is missing from the
// generated Bicep type for Microsoft.Web/sites, hence the suppression.
// During binding/scale operations ARM can transiently report a comma-separated
// PAIR of IPs ('51.x,51.y'); writing that into the apex A record fails the DNS
// deployment AND deletes the record — always take the first address.
@description('Inbound VIP of the App Service. The apex A record points at this literal IP (Azure DNS alias records cannot target App Service).')
#disable-next-line BCP053
output inboundIpAddress string = split(webApp.properties.inboundIpAddress, ',')[0]
output appServicePlanId string = appServicePlan.id
