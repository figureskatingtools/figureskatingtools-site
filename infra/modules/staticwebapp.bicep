param name string
param location string = 'westeurope' // SWA management plane; content served from global CDN
param customDomain string = ''

// Apex/root domains (e.g. figureskatingtools.com) must validate via dns-txt-token;
// subdomains (e.g. test.figureskatingtools.com) use the default cname-delegation.
// Azure rejects cname-delegation for apex with: "Apex Domains must use dns-txt-token".
var isApexDomain = !empty(customDomain) && length(split(customDomain, '.')) == 2

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' = {
  name: name
  location: location
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {}
}

resource domain 'Microsoft.Web/staticSites/customDomains@2023-12-01' = if (!empty(customDomain)) {
  parent: staticWebApp
  name: customDomain
  properties: {
    validationMethod: isApexDomain ? 'dns-txt-token' : 'cname-delegation'
  }
}

output name string = staticWebApp.name
output defaultHostname string = staticWebApp.properties.defaultHostname
