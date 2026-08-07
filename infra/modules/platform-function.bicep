// Platform Function App — the competitions registry behind the router's /api/*.
//
// Unlike the tool Function Apps this one has NO Entra provider of its own: the
// site Web App owns the login and proxies here with X-Proxy-Secret +
// X-Forwarded-User-Email (see infra/functions/function_app.py). The browser
// never talks to it directly, so CORS is explicitly empty.
param location string
param functionAppName string
param appServicePlanName string
param appInsightsName string
param storageAccountName string
param deploymentContainerUrl string

@description('Shared blob container the registry writes competition data into.')
param dataContainerName string = 'competition-data'

// Shared secret the Web App proxy sends as X-Proxy-Secret. Empty = the
// function doesn't enforce it (local/dev). See function_app.py:_proxy_secret_ok.
@secure()
param proxySharedSecret string = ''

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      // The browser never calls this app directly — everything goes through the
      // site Web App proxy, so no origin needs to be allowed. An empty array
      // also clears anything left over from a previous deploy.
      cors: {
        allowedOrigins: []
      }
      // Explicitly no inbound IP restrictions. The endpoint must stay reachable
      // by the Web App proxy AND by the CI deploy's sync-triggers/health-check
      // (a Deny lock 403s the GitHub runner and hangs the pipeline).
      ipSecurityRestrictions: []
      ipSecurityRestrictionsDefaultAction: 'Allow'
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageAccountName
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsights.properties.ConnectionString
        }
        {
          name: 'PROXY_SHARED_SECRET'
          value: proxySharedSecret
        }
        {
          name: 'COMPETITION_DATA_CONTAINER'
          value: dataContainerName
        }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: deploymentContainerUrl
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      runtime: {
        name: 'python'
        version: '3.13'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    }
    httpsOnly: true
  }
}

resource authSettings 'Microsoft.Web/sites/config@2022-03-01' = {
  parent: functionApp
  name: 'authsettingsV2'
  properties: {
    // Anonymous by design: the site Web App does the Entra login and forwards
    // the user's email. Authorization happens in get_user_email_from_header(),
    // gated by the X-Proxy-Secret shared secret.
    globalValidation: {
      requireAuthentication: false
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    login: {
      tokenStore: {
        enabled: false
      }
    }
  }
}

output functionAppName string = functionApp.name
output functionAppId string = functionApp.id
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output functionPrincipalId string = functionApp.identity.principalId
