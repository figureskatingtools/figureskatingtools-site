// Storage for the platform (competitions registry) Function App.
//
//   competition-data  shared blob container keyed by competition GUID:
//                       <guid>/uploads/...            cross-tool data reuse
//                       <guid>/fsm/...                files pushed by FS Manager,
//                                                     written by the HOVTP listener
//                                                     once their source IP is accepted
//                       <guid>/fsm-pending/<ip>/...   quarantine written by the HOVTP
//                                                     listener for a not-yet-accepted
//                                                     source IP; invisible in the pool
//                                                     until the source is accepted
//                     Tool Function Apps get Storage Blob Data READER here via
//                     shared-data-access.bicep — this is the cross-tool seam.
//   app-package       Flex Consumption one-deploy package container (platform app).
//                     The HOVTP listener has NO access to it: its own package and
//                     host state live in its own account (modules/hovtp-storage.bicep),
//                     so a compromise of the anonymous listener cannot overwrite the
//                     platform app's deployment zip.
//   competitions      table, two row kinds (see infra/functions/function_app.py):
//                       PK=COMPETITION RK=<guid>            the competition
//                       PK=CODE        RK=<normalized code> -> CompetitionId
//   retentionclock    table, the tools' read-only view of the retention clock
//   adminlog          table, the admin panel's audit trail (PK=AUDIT, kept 365 d)
//                     and retention sweep runs (PK=SWEEP, kept 30 d)
//   users             table, the user directory (PK=USER RK=<userId>: e-mail,
//                     display name, first/last seen) — platform only, holds PII
//   useridentities    table, sign-in identity -> userId (PK=IDENTITY
//                     RK=<tid>_<oid>), no PII; tools read it
//   competitionaccess table, who may use a competition (PK=<competition guid>
//                     RK=<userId>, Role owner/write/read), no PII; tools read it
param location string
param storageAccountName string

@description('Shared, cross-tool readable blob container keyed by competition GUID.')
param dataContainerName string = 'competition-data'

@description('Table holding both the COMPETITION rows and the CODE uniqueness rows.')
param competitionsTableName string = 'competitions'

// The platform retention clock as the tool Function Apps see it: PK=COMPETITION
// RK=<guid>, columns DeletionDate / Status / PurgedUtc and nothing else. A
// separate table so the tools' read grant never reaches the registry rows
// (operators' e-mail addresses, FS Manager sender IPs). Written only by the
// platform Function App (infra/functions/function_app.py, _sync_clock).
@description('Non-personal mirror of each competition deletion state, readable by the tool Function Apps.')
param clockTableName string = 'retentionclock'

// Admin actions (with the admin's e-mail) and sweep runs. Written only by the
// platform Function App, whose account-scoped Table Data Contributor covers it;
// neither the tools nor the HOVTP listener have a grant on it.
@description('Admin audit log and retention sweep history of the platform Function App.')
param adminLogTableName string = 'adminlog'

// The user directory: e-mail and display name per platform user id. PII, so
// only the platform Function App (account-scoped Table Data Contributor) can
// read it — never the tools.
@description('User directory (e-mail, display name, first/last seen) of the platform Function App.')
param usersTableName string = 'users'

// Sign-in identity (Entra tenant + object id) -> platform user id. No PII; the
// tools get Table Data Reader on it (shared-data-access.bicep) to map the
// router's x-forwarded-user-tid/-oid to a user id.
@description('Identity links (tid_oid -> userId), readable by the tool Function Apps.')
param userIdentitiesTableName string = 'useridentities'

// Who may use a competition: one row per (competition, user), Role
// owner/write/read. No PII; the tools get Table Data Reader on it.
@description('Competition access grants (owner/write/read per user), readable by the tool Function Apps.')
param competitionAccessTableName string = 'competitionaccess'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: dataContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'app-package'
  properties: {
    publicAccess: 'None'
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-01-01' = {
  parent: storageAccount
  name: 'default'
}

resource competitionsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: competitionsTableName
}

resource clockTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: clockTableName
}

resource adminLogTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: adminLogTableName
}

resource usersTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: usersTableName
}

resource userIdentitiesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: userIdentitiesTableName
}

resource competitionAccessTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-01-01' = {
  parent: tableService
  name: competitionAccessTableName
}

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output deploymentContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}app-package'
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output dataContainerName string = dataContainerName
output clockTableName string = clockTable.name
output adminLogTableName string = adminLogTable.name
output usersTableName string = usersTable.name
output userIdentitiesTableName string = userIdentitiesTable.name
output competitionAccessTableName string = competitionAccessTable.name
