// Platform Function App — the competitions registry behind the router's /api/*.
//
// Unlike the tool Function Apps this one has NO Entra provider of its own: the
// site Web App owns the login and proxies here with X-Proxy-Secret +
// X-Forwarded-User-Tid/-Oid/-Email/-Name/-Admin (see
// infra/functions/function_app.py). The browser
// never talks to it directly, so CORS is explicitly empty.
param location string
param functionAppName string
param appServicePlanName string
param appInsightsName string

// Technical logs are kept 90 days (the privacy notice says so). A classic
// component's retention follows the Log Analytics workspace it is linked to, so
// both the workspace and the component say 90 explicitly. The workspace is per
// environment; the HOVTP listener writes to the same component.
@description('Log Analytics workspace behind ai-fs-platform (log-fs-platform-<env>).')
param logAnalyticsWorkspaceName string

@description('Days the technical logs are kept (workspace and App Insights). The privacy notice promises 90.')
@minValue(30)
@maxValue(90)
param logRetentionDays int = 90
param storageAccountName string
param deploymentContainerUrl string

@description('Shared blob container the registry writes competition data into.')
param dataContainerName string = 'competition-data'

// Shared secret the Web App proxy sends as X-Proxy-Secret. The app fails
// closed: empty = every user and admin route answers 401. See
// function_app.py:_proxy_secret_ok.
@secure()
param proxySharedSecret string = ''

// The nightly retention_sweep only DELETES when this is true; false = dry-run
// (it still backfills DeletionDate, reconciles the clock table and logs what it
// would purge) — a kill switch, on by default. Bicep-owned like HOVTP_ENABLED,
// so it survives redeploys.
@description('true = retention_sweep purges expired competitions; false = dry-run logging only.')
param retentionPurgeEnabled bool = true

@description('Table the platform mirrors each competition retention state into for the tools.')
param clockTableName string = 'retentionclock'

@description('Table for the admin audit log and the retention sweep history.')
param adminLogTableName string = 'adminlog'

@description('Table of the user directory (PII; this app only).')
param usersTableName string = 'users'

@description('Table linking sign-in identities (tid_oid) to platform user ids.')
param userIdentitiesTableName string = 'useridentities'

@description('Table of the competition access grants (owner/write/read).')
param competitionAccessTableName string = 'competitionaccess'

// Defence in depth behind the router's own check: principals of any other
// Entra tenant are refused. Comma-separated; main.bicep defaults it to the
// deployment tenant. Empty = nobody gets in (fail closed).
@description('Comma-separated Entra tenant ids whose users may use the API (ALLOWED_TENANT_IDS).')
param allowedTenantIds string

// The Entra External ID tenant(s). A new identity from these tenants becomes a
// new user only when externalNewUsersEnabled is on; otherwise the platform
// answers 503 migration_pending (see _resolve_user). Empty = none.
@description('Comma-separated Entra External ID tenant ids (EXTERNAL_TENANT_IDS).')
param externalTenantIds string = ''

// Lets a new identity of those tenants become a new user (EXTERNAL_NEW_USERS_ENABLED).
// On in test so testers get in as in production; off in prod until phase C.
@description('true = a new External ID identity becomes a new user; false = 503 migration_pending.')
param externalNewUsersEnabled bool = false

// Informational only: the admin diagnostics show it. The HOVTP listener has its
// own copy of the setting, and that one is what switches it.
@description('The value the HOVTP listener gets for HOVTP_ENABLED.')
param hovtpEnabled bool = true

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

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

// Workspace-based: linking it here replaces the default workspace the classic
// component was auto-migrated to. Data already in that old workspace keeps its
// retention until it ages out.
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
    RetentionInDays: logRetentionDays
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
        {
          name: 'RETENTION_PURGE_ENABLED'
          value: string(retentionPurgeEnabled)
        }
        {
          name: 'RETENTION_CLOCK_TABLE'
          value: clockTableName
        }
        {
          name: 'ADMIN_LOG_TABLE'
          value: adminLogTableName
        }
        {
          name: 'HOVTP_ENABLED'
          value: string(hovtpEnabled)
        }
        {
          name: 'USERS_TABLE'
          value: usersTableName
        }
        {
          name: 'USER_IDENTITIES_TABLE'
          value: userIdentitiesTableName
        }
        {
          name: 'COMPETITION_ACCESS_TABLE'
          value: competitionAccessTableName
        }
        {
          name: 'ALLOWED_TENANT_IDS'
          value: allowedTenantIds
        }
        {
          name: 'EXTERNAL_TENANT_IDS'
          value: externalTenantIds
        }
        {
          name: 'EXTERNAL_NEW_USERS_ENABLED'
          value: string(externalNewUsersEnabled)
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
    // the user's identity. Authorization happens in _require_user() /
    // _require_admin(), gated by the X-Proxy-Secret shared secret (fail closed).
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
// The HOVTP listener Function App shares this Application Insights component so
// both halves of an ingest land in one trace stream.
output appInsightsConnectionString string = appInsights.properties.ConnectionString
