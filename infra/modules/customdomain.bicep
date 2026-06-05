// Binds a custom domain to the Static Web App.
//
// This is split out from staticwebapp.bicep so it can be deployed AFTER the DNS
// records (see main.bicep `dependsOn`). The binding validates against public DNS,
// so the routing/validation records must already exist or the resource blocks:
//   - subdomain (cname-delegation): needs its CNAME record
//   - apex (dns-txt-token): needs the _dnsauth TXT token record
//
// Apex/root domains (figureskatingtools.com) must validate via dns-txt-token;
// subdomains (test.figureskatingtools.com) use cname-delegation. Azure rejects
// cname-delegation for an apex with: "Apex Domains must use dns-txt-token".

param staticWebAppName string
param customDomain string

var isApexDomain = length(split(customDomain, '.')) == 2

resource staticWebApp 'Microsoft.Web/staticSites@2023-12-01' existing = {
  name: staticWebAppName
}

resource domain 'Microsoft.Web/staticSites/customDomains@2023-12-01' = {
  parent: staticWebApp
  name: customDomain
  properties: {
    validationMethod: isApexDomain ? 'dns-txt-token' : 'cname-delegation'
  }
}
