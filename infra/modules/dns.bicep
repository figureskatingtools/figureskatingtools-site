// Public DNS zone for figureskatingtools.com and the per-environment records that
// point each Static Web App custom domain at the right place.
//
// There is intentionally ONE zone for the whole apex + every subdomain. The test
// environment is NOT a separate `test.figureskatingtools.com` zone; it is just a
// `test` record set inside this zone. Both the test and prod site deployments target
// this same module/zone (in the shared `rg-fs-dns` resource group), so the zone is
// create-or-update idempotent and each deployment only declares ITS OWN record set.
//
// Because deployments run in incremental mode, records this module does not declare
// (e.g. the judgepapers CNAMEs, the MX record, anything added by hand) are never
// touched or deleted by a site deploy.

@description('The DNS zone / apex domain name, e.g. figureskatingtools.com')
param zoneName string

@description('The custom domain for this environment (apex for prod, test.<zone> for test). Empty = create the zone only.')
param customDomain string = ''

@description('Resource id of the Static Web App this environment serves (used for the apex ALIAS A record).')
param swaResourceId string

@description('Default *.azurestaticapps.net hostname of the Static Web App (CNAME target for subdomains).')
param swaDefaultHostname string

@description('SWA apex domain-ownership token, published as the _dnsauth TXT record. Required for apex (prod) cert validation + renewal. Not a secret (it is publicly resolvable in DNS).')
param apexValidationToken string = ''

// An apex/root domain has exactly two labels (figureskatingtools.com); anything with
// a subdomain (test.figureskatingtools.com) routes via a CNAME instead.
var isApex = !empty(customDomain) && length(split(customDomain, '.')) == 2

// Record-set name for a subdomain custom domain, relative to the zone apex.
// test.figureskatingtools.com -> 'test'
var subdomainLabel = replace(customDomain, '.${zoneName}', '')

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
}

// --- Apex (prod): figureskatingtools.com ---------------------------------------
// Apex can't be a CNAME, so route it with an ALIAS A record that targets the Static
// Web App resource directly (keeps global distribution and survives IP changes).
resource apexAlias 'Microsoft.Network/dnsZones/A@2018-05-01' = if (isApex) {
  parent: zone
  name: '@'
  properties: {
    TTL: 3600
    targetResource: {
      id: swaResourceId
    }
  }
}

// Apex ownership validation for the SWA managed certificate (dns-txt-token method).
// Must remain present for automatic certificate renewal.
resource apexValidation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (isApex && !empty(apexValidationToken)) {
  parent: zone
  name: '_dnsauth'
  properties: {
    TTL: 3600
    TXTRecords: [
      {
        value: [
          apexValidationToken
        ]
      }
    ]
  }
}

// --- Subdomain (test): test.figureskatingtools.com -----------------------------
// A single CNAME both routes traffic and validates ownership (cname-delegation).
resource subdomainCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (!isApex && !empty(customDomain)) {
  parent: zone
  name: subdomainLabel
  properties: {
    TTL: 300
    CNAMERecord: {
      cname: swaDefaultHostname
    }
  }
}

@description('Azure-assigned name servers for the zone. Delegate these at the registrar.')
output nameServers array = zone.properties.nameServers
