// Data-plane RBAC for the platform Function App's system-assigned identity on
// the platform storage account. Flex Consumption also uses this identity for
// AzureWebJobsStorage and the one-deploy package container, so Blob Data
// Contributor is required for the host itself, not just app code.
param storageAccountName string
param functionPrincipalId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = {
  name: storageAccountName
}

// Storage Table Data Contributor — the `competitions` table
var storageTableDataContributorId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
resource storageTableDataContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionPrincipalId, storageTableDataContributorId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Blob Data Contributor — competition-data + app-package containers
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

// Storage Blob Delegator — needed to mint user-delegation SAS for downloads
var storageBlobDelegatorId = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
resource storageBlobDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, functionPrincipalId, storageBlobDelegatorId)
  scope: storageAccount
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDelegatorId)
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
  }
}
