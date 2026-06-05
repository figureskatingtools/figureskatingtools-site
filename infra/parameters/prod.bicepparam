using '../main.bicep'

param resourceGroupName = 'rg-fs-site-prod'
param location = 'swedencentral'
param customDomain = 'figureskatingtools.com'

// SWA apex domain-ownership token, published as the _dnsauth TXT record so the managed
// certificate can validate + auto-renew. Publicly resolvable in DNS (not a secret).
// If the apex binding is ever recreated from scratch, refresh this from:
//   az staticwebapp hostname show -n <swa> -g rg-fs-site-prod --hostname figureskatingtools.com --query validationToken -o tsv
param apexValidationToken = '_uxne0sed1kp8orshb691igr9m74gjeb'
