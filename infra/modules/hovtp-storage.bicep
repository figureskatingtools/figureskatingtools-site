// Storage for the HOVTP listener Function App — its OWN account, on purpose.
//
// The listener is anonymous and internet-facing, so it must not be able to
// reach anything on the platform storage account beyond the competition data
// it writes. It cannot simply be given container-scoped RBAC there: Flex
// Consumption uses identity-based AzureWebJobsStorage and the Functions host
// CREATES `azure-webjobs-hosts` / `azure-webjobs-secrets` itself at runtime,
// which container-scoped RBAC cannot do. So the host state moves here, where an
// account-scoped grant is harmless, and the platform account only ever grants
// the listener the `competition-data` container + the `competitions` table
// (modules/hovtp-data-access.bicep).
//
//   app-package  Flex Consumption one-deploy package container (HOVTP listener)
//   plus the azure-webjobs-* containers the host creates for itself
//
// Nothing else belongs in this account. In particular the platform Function
// App's own deployment package stays in the platform account, out of the
// listener's reach — a compromised listener overwriting it would have been code
// execution as the more privileged identity.
param location string
param storageAccountName string

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

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'app-package'
  properties: {
    publicAccess: 'None'
  }
}

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output deploymentContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}${deploymentContainer.name}'
