// Host-state RBAC for the HOVTP listener on its OWN storage account.
//
// Account scope is unavoidable here: the listener runs on Flex Consumption with
// identity-based AzureWebJobsStorage, and the Functions host creates its own
// `azure-webjobs-hosts` / `azure-webjobs-secrets` containers at runtime plus
// reads the one-deploy package out of `app-package`. Container-scoped RBAC
// cannot create a container, so a container-scoped grant leaves the host unable
// to start.
//
// It is safe now precisely because this account holds NOTHING but that host
// state and the listener's own deployment package (see hovtp-storage.bicep).
// The listener's rights in the shared platform account — the only place real
// data lives — are narrow and scoped per container/table in
// modules/hovtp-data-access.bicep.
param storageAccountName string
param functionPrincipalId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// Storage Blob Data Contributor — AzureWebJobsStorage + the app-package container
var storageBlobDataContributorId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource storageBlobDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionPrincipalId, storageBlobDataContributorId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}
