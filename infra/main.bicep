targetScope = 'subscription'

param location string = 'swedencentral'
param resourceGroupName string = ''
param customDomain string = ''

@description('Resource group that holds the single shared DNS zone. Persistent + shared by every environment; not torn down with a test env.')
param dnsResourceGroupName string = 'rg-fs-dns'

@description('The DNS zone / apex domain name.')
param dnsZoneName string = 'figureskatingtools.com'

@description('SWA apex domain-ownership token, published as _dnsauth TXT (apex/prod only). Publicly resolvable in DNS, so safe to commit. Leave empty for non-apex environments.')
param apexValidationToken string = ''

// Per-environment site resource group + Static Web App.
resource rg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: resourceGroupName
  location: location
}

// Shared DNS resource group. Created (idempotently) by every environment so the zone
// exists regardless of which environment deploys first, and survives test teardown.
resource dnsRg 'Microsoft.Resources/resourceGroups@2021-04-01' = {
  name: dnsResourceGroupName
  location: location
}

module staticWebApp 'modules/staticwebapp.bicep' = {
  scope: rg
  name: 'staticWebAppDeployment'
  params: {
    name: 'swa-fs-site-${uniqueString(rg.id)}'
  }
}

// Single zone for the whole apex + every subdomain. Each environment declares only its
// own record set; incremental deployments leave all other records (other envs, the
// judgepapers CNAMEs, MX, etc.) untouched.
module dns 'modules/dns.bicep' = {
  scope: dnsRg
  name: 'dnsDeployment'
  params: {
    zoneName: dnsZoneName
    customDomain: customDomain
    swaResourceId: staticWebApp.outputs.id
    swaDefaultHostname: staticWebApp.outputs.defaultHostname
    apexValidationToken: apexValidationToken
  }
}

// Bind the custom domain only after the DNS records exist, so SWA validation (which
// reads public DNS) doesn't block on a missing CNAME / TXT record.
module customDomainBinding 'modules/customdomain.bicep' = if (!empty(customDomain)) {
  scope: rg
  name: 'customDomainDeployment'
  params: {
    staticWebAppName: staticWebApp.outputs.name
    customDomain: customDomain
  }
  dependsOn: [
    dns
  ]
}

output resourceGroupName string = rg.name
output swaName string = staticWebApp.outputs.name
output swaDefaultHostname string = staticWebApp.outputs.defaultHostname
output dnsZoneName string = dnsZoneName
output dnsResourceGroupName string = dnsRg.name
output dnsNameServers array = dns.outputs.nameServers
