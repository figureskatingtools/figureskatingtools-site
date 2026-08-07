// User-assigned managed identity used by App Service Easy Auth instead of a
// client secret. The deploy workflow federates this identity's principal id
// onto the Entra app registration (FIC), and webapp.bicep points
// `clientSecretSettingName` at OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID.
param location string
param managedIdentityName string

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
}

output clientId string = managedIdentity.properties.clientId
output principalId string = managedIdentity.properties.principalId
output resourceId string = managedIdentity.id
