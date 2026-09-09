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
//   app-package       Flex Consumption one-deploy package container (platform app)
//   app-package-hovtp Flex Consumption one-deploy package container (HOVTP listener;
//                     the two apps share this storage account but never the package)
//   competitions      table, two row kinds (see infra/functions/function_app.py):
//                       PK=COMPETITION RK=<guid>            the competition
//                       PK=CODE        RK=<normalized code> -> CompetitionId
param location string
param storageAccountName string

@description('Shared, cross-tool readable blob container keyed by competition GUID.')
param dataContainerName string = 'competition-data'

@description('Table holding both the COMPETITION rows and the CODE uniqueness rows.')
param competitionsTableName string = 'competitions'

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

// The HOVTP listener is a separate Function App (so it can be stopped alone) but
// shares this storage account; Flex Consumption host state is keyed by app name,
// so only the deployment package needs a container of its own.
resource hovtpDeploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: blobService
  name: 'app-package-hovtp'
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

output storageAccountName string = storageAccount.name
output storageAccountId string = storageAccount.id
output deploymentContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}app-package'
output hovtpDeploymentContainerUrl string = '${storageAccount.properties.primaryEndpoints.blob}${hovtpDeploymentContainer.name}'
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob
output dataContainerName string = dataContainerName
