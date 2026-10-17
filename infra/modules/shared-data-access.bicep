// Cross-tool READ access to the platform storage account.
//
// Each tool Function App (fs-judgepapers, fs-scoremodifier, fs-protocolgenerator)
// lives in its own resource group and its own repo, but needs to read two things
// the platform owns. Their system-assigned principal ids are supplied as GitHub
// environment vars (TOOL_PRINCIPAL_ID_*) and assigned here, in the site resource
// group, so nothing has to be scoped cross-RG:
//
//   blob   the shared file pool, `competition-data/<guid>/…` — Storage Blob
//          Data Reader on that ONE container (not the account: `app-package`
//          holds the platform app's deployment zip).
//   table  the platform retention clock — each tool reads the PK=COMPETITION
//          row (DeletionDate, Status, PurgedUtc) of the competitions it is
//          linked to and deletes its own records on the platform's verdict.
//          Storage Table Data Reader on the `retentionclock` table only: that
//          table holds nothing else, while the registry's `competitions` table
//          (operators' e-mails, FS Manager sender IPs) stays out of reach.
//   table  the access model — `useridentities` (tid_oid -> userId) and
//          `competitionaccess` (PK=<competition guid>, RK=<userId>, Role), so
//          each tool can answer "may this caller read / write this
//          competition?" (platform_access.py). Storage Table Data Reader on
//          those two tables only. Neither holds personal data; the `users`
//          table (e-mails, names) is NEVER granted to the tools.
//
// Read-only on purpose: the platform Function App is the only writer.
//
// Same child-resource pattern as hovtp-data-access.bicep. The assignment names
// are seeded from the CHILD resource ids, so they never collide with older
// assignments this module used to create (account-scoped Blob Data Reader, and
// briefly a Table Data Reader on `competitions`) — which incremental deployment
// does NOT delete. See infra/MIGRATION.md §2d for the manual cleanup.
//
// NOTE: table-scoped role assignments do NOT show up in the portal's IAM blade.
// Inspect them with:
//   az role assignment list --scope <table resource id> -o table
//
// Tolerates an empty / partially-filled list so the very first deploy works
// before the TOOL_PRINCIPAL_ID_* vars exist (they can only be read from the tool
// repos' deployments, which happen later in the migration).
param storageAccountName string

@description('Shared blob container holding the per-competition file pool.')
param dataContainerName string = 'competition-data'

@description('Table holding the platform retention clock (DeletionDate / Status / PurgedUtc only).')
param clockTableName string = 'retentionclock'

@description('Table linking sign-in identities (tid_oid) to platform user ids.')
param userIdentitiesTableName string = 'useridentities'

@description('Table of the competition access grants (owner/write/read).')
param competitionAccessTableName string = 'competitionaccess'

@description('System-assigned principal ids of the tool Function Apps. Empty strings are ignored.')
param toolPrincipalIds array = []

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName

  resource blobService 'blobServices' existing = {
    name: 'default'

    resource dataContainer 'containers' existing = {
      name: dataContainerName
    }
  }

  resource tableService 'tableServices' existing = {
    name: 'default'

    resource clockTable 'tables' existing = {
      name: clockTableName
    }

    resource userIdentitiesTable 'tables' existing = {
      name: userIdentitiesTableName
    }

    resource competitionAccessTable 'tables' existing = {
      name: competitionAccessTableName
    }
  }
}

// Storage Blob Data Reader
var storageBlobDataReaderId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
// Storage Table Data Reader
var storageTableDataReaderId = '76199698-9eea-4c19-bc75-cec21354c6b6'

var validPrincipalIds = filter(toolPrincipalIds, id => !empty(trim(string(id))))

resource toolContainerBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in validPrincipalIds: {
    name: guid(storageAccount::blobService::dataContainer.id, string(principalId), storageBlobDataReaderId)
    scope: storageAccount::blobService::dataContainer
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderId)
      principalId: string(principalId)
      principalType: 'ServicePrincipal'
    }
  }
]

resource toolTableReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in validPrincipalIds: {
    name: guid(storageAccount::tableService::clockTable.id, string(principalId), storageTableDataReaderId)
    scope: storageAccount::tableService::clockTable
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderId)
      principalId: string(principalId)
      principalType: 'ServicePrincipal'
    }
  }
]

resource toolIdentitiesReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in validPrincipalIds: {
    name: guid(storageAccount::tableService::userIdentitiesTable.id, string(principalId), storageTableDataReaderId)
    scope: storageAccount::tableService::userIdentitiesTable
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderId)
      principalId: string(principalId)
      principalType: 'ServicePrincipal'
    }
  }
]

resource toolAccessReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in validPrincipalIds: {
    name: guid(storageAccount::tableService::competitionAccessTable.id, string(principalId), storageTableDataReaderId)
    scope: storageAccount::tableService::competitionAccessTable
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataReaderId)
      principalId: string(principalId)
      principalType: 'ServicePrincipal'
    }
  }
]

@description('Number of tool principals granted read access (0 on a first deploy).')
output grantedCount int = length(validPrincipalIds)
