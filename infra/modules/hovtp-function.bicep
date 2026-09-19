// HOVTP listener Function App — the HTTPS endpoint FS Manager pushes ODF/PDF
// messages to (see infra/hovtp/function_app.py).
//
// Deliberately a SEPARATE app from the platform Function App: it is the only
// internet-exposed, unauthenticated surface of the platform, so it must be
// stoppable, redeployable and revocable on its own (`az functionapp stop`,
// HOVTP_ENABLED=false, or dropping its RBAC) without taking the site's API down.
// Storage is split for the same reason: `storageAccountName` is the listener's
// OWN account (modules/hovtp-storage.bicep), holding nothing but Functions host
// state and its deployment package, while `dataStorageAccountName` is the
// shared platform account where the competition data actually lives. The
// listener holds account-scoped roles only on the former; on the latter it gets
// the `competition-data` container and the `competitions` table and nothing
// else (modules/hovtp-data-access.bicep). It still shares the ai-fs-platform
// Application Insights component, and has its own plan and identity.
param location string
param functionAppName string
param appServicePlanName string

@description('The listener OWN storage account: AzureWebJobsStorage host state + its one-deploy package container. NOT the platform account.')
param storageAccountName string

@description('The PLATFORM storage account holding `competition-data` and the `competitions` table. Passed to the app as COMPETITION_DATA_ACCOUNT because AzureWebJobsStorage no longer points at it.')
param dataStorageAccountName string

param deploymentContainerUrl string

@description('Connection string of the shared ai-fs-platform Application Insights component.')
param appInsightsConnectionString string

@description('Shared blob container the listener writes competition data into.')
param dataContainerName string = 'competition-data'

@description('Kill switch. false = every HOVTP request is answered 503 without touching storage. Bicep-owned, so it survives a redeploy.')
param hovtpEnabled bool = true

@description('Environment echoed in X-HOVTP-Environment and matched against the sender.')
@allowed([
  'Test'
  'Production'
])
param hovtpEnvironment string

@description('true = a serial-number gap is refused with 450 Out Of Synchro instead of accepted with a warning.')
param hovtpStrictSerial bool = false

@description('Value advertised in X-HOVTP-Keep-Alive-Interval (seconds).')
param hovtpKeepAliveSeconds int = 60

@description('Number of trusted proxy hops in front of the app; the client IP is taken that many entries back from the end of X-Forwarded-For. 0 = App Service only (direct *.azurewebsites.net). 3 = behind Front Door + WAF -> API Management, which add three entries in front of the socket peer.')
param hovtpTrustedProxyHops int = 0

@description('Value API Management injects as X-Proxy-Secret on every forwarded request. Empty = the gate is OFF and the app accepts direct callers (local dev, and any environment not published through Front Door/APIM yet). Set it and POST/OPTIONS without the header are 403 — this, not an IP allow-list, is what makes hop counting trustworthy, because APIM Basic v2 outbound IPs are not guaranteed static.')
@secure()
param hovtpProxySharedSecret string = ''

@description('Comma-separated ODF DocumentTypes that are stored. Everything else is logged and dropped with a 200.')
param hovtpAllowedDocumentTypes string = 'DT_PDF,DT_PARTIC,DT_PARTIC_TEAMS,DT_SCHEDULE,DT_SCHEDULE_UPDATE'

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
      // No browser ever calls this app: the only client is FS Manager, which
      // sends no Origin header. An empty array also clears leftovers.
      cors: {
        allowedOrigins: []
      }
      // Explicitly no inbound IP restrictions. FS Manager's public IP changes
      // (that is the whole reason for the per-competition source acceptance in
      // code), and the CI deploy's sync-triggers call must reach the app too —
      // a Deny lock 403s the GitHub runner and hangs the pipeline. Nor is APIM
      // pinned here: Basic v2 outbound IPs are not guaranteed static, so the
      // publishing layer is authenticated with hovtpProxySharedSecret instead.
      // The trust boundary is the per-(competition, IP) acceptance plus that
      // header, not the network.
      ipSecurityRestrictions: []
      ipSecurityRestrictionsDefaultAction: 'Allow'
      appSettings: [
        {
          name: 'AzureWebJobsStorage__accountName'
          value: storageAccountName
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsConnectionString
        }
        {
          name: 'COMPETITION_DATA_CONTAINER'
          value: dataContainerName
        }
        {
          // Without this the data clients would fall back to
          // AzureWebJobsStorage__accountName — i.e. the listener own, empty host
          // account — and every competition lookup would 451.
          // See _data_account_name() in infra/hovtp/function_app.py.
          name: 'COMPETITION_DATA_ACCOUNT'
          value: dataStorageAccountName
        }
        {
          name: 'HOVTP_ENABLED'
          value: string(hovtpEnabled)
        }
        {
          name: 'HOVTP_ENVIRONMENT'
          value: hovtpEnvironment
        }
        {
          name: 'HOVTP_STRICT_SERIAL'
          value: string(hovtpStrictSerial)
        }
        {
          name: 'HOVTP_KEEP_ALIVE_SECONDS'
          value: string(hovtpKeepAliveSeconds)
        }
        {
          name: 'HOVTP_TRUSTED_PROXY_HOPS'
          value: string(hovtpTrustedProxyHops)
        }
        {
          name: 'HOVTP_ALLOWED_DOCUMENT_TYPES'
          value: hovtpAllowedDocumentTypes
        }
        {
          // See _proxy_secret_ok() in infra/hovtp/function_app.py: empty fails
          // open on purpose, so deploying this before the secret exists cannot
          // lock FS Manager out.
          name: 'PROXY_SHARED_SECRET'
          value: hovtpProxySharedSecret
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
        // Far below the platform app's 100: FS Manager is a single sender and a
        // runaway fan-out here would only mean a runaway write rate on storage.
        maximumInstanceCount: 20
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
    // Anonymous by design and by necessity: FS Manager sends no credentials of
    // any kind. The listener instead trusts source IPs that an operator has
    // accepted for a specific competition; everything from an unknown IP is
    // quarantined until accepted. HOVTP_ENABLED=false is the kill switch and,
    // being Bicep-owned, survives redeploys.
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
output functionAppUrl string = 'https://${functionApp.properties.defaultHostName}'
output functionPrincipalId string = functionApp.identity.principalId
