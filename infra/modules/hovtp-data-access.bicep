// The HOVTP listener's ONLY rights in the shared platform storage account.
//
// The listener is the platform's one anonymous, internet-facing surface, so it
// gets no account-scoped role here at all — its host state lives in its own
// account (modules/hovtp-storage.bicep). What it actually does with the
// platform account is narrow:
//
//   blob   write-only uploads into `competition-data/<guid>/fsm/` (accepted
//          sources) and `competition-data/<guid>/fsm-pending/<ip>/`
//          (quarantine). It never lists, downloads or deletes; the platform API
//          is what attaches a quarantined file to the pool. Data Contributor
//          rather than a write-only role because no such role exists, but it is
//          confined to this one container — `app-package` (the PLATFORM
//          Function App's deployment zip) is explicitly out of reach, so a
//          compromised listener cannot get code execution as the platform app.
//   table  reads the platform's PK=CODE / PK=COMPETITION rows to turn a
//          competition code into a GUID, and writes its own PK=HOVTPSESSION
//          (serial numbers) and PK=HOVTPSOURCE (per-(competition, IP) trust)
//          rows, plus one RowKey range query to count pending sources.
//          Table-scoped, so only the `competitions` table is reachable.
//
// NOTE: table-scoped role assignments do NOT show up in the portal's IAM blade
// (it only renders account- and container-scoped ones). Inspect them with:
//   az role assignment list --scope <table resource id> -o table
// where <table resource id> is
//   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Storage/
//   storageAccounts/<account>/tableServices/default/tables/competitions
//
// The assignment names are seeded from the CHILD resource ids, so they never
// collide with the old account-scoped assignments this module replaces — which
// incremental deployment does not delete. See infra/MIGRATION.md for the manual
// cleanup that actually removes them.
param storageAccountName string

@description('Shared blob container the listener writes competition files into.')
param dataContainerName string = 'competition-data'

@description('Table holding the platform CODE/COMPETITION rows and the listener own HOVTPSESSION/HOVTPSOURCE rows.')
param competitionsTableName string = 'competitions'

param functionPrincipalId string

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

    resource competitionsTable 'tables' existing = {
      name: competitionsTableName
    }
  }
}

// Storage Blob Data Contributor — scoped to `competition-data` only
var storageBlobDataContributorId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource containerBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount::blobService::dataContainer.id, functionPrincipalId, storageBlobDataContributorId)
  scope: storageAccount::blobService::dataContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Table Data Contributor — scoped to the `competitions` table only
var storageTableDataContributorId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
resource tableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount::tableService::competitionsTable.id, functionPrincipalId, storageTableDataContributorId)
  scope: storageAccount::tableService::competitionsTable
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}
