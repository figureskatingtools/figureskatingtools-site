// Cross-tool read access to the shared `competition-data` blob container.
//
// Each tool Function App (fs-judgepapers, fs-scoremodifier, fs-protocolgenerator)
// lives in its own resource group and its own repo, but needs to READ the
// platform's per-competition blobs. Their system-assigned principal ids are
// supplied as GitHub environment vars (TOOL_PRINCIPAL_ID_*) and assigned here,
// in the site resource group, so nothing has to be scoped cross-RG.
//
// Read-only on purpose: the platform Function App is the only writer.
//
// Tolerates an empty / partially-filled list so the very first deploy works
// before the TOOL_PRINCIPAL_ID_* vars exist (they can only be read from the tool
// repos' deployments, which happen later in the migration).
param storageAccountName string

@description('System-assigned principal ids of the tool Function Apps. Empty strings are ignored.')
param toolPrincipalIds array = []

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// Storage Blob Data Reader
var storageBlobDataReaderId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'

var validPrincipalIds = filter(toolPrincipalIds, id => !empty(trim(string(id))))

resource toolBlobReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in validPrincipalIds: {
    name: guid(storageAccount.id, string(principalId), storageBlobDataReaderId)
    scope: storageAccount
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataReaderId)
      principalId: string(principalId)
      principalType: 'ServicePrincipal'
    }
  }
]

@description('Number of tool principals actually granted read access (0 on a first deploy).')
output grantedCount int = length(validPrincipalIds)
