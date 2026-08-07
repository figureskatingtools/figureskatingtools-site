// Public DNS zone for figureskatingtools.com and the per-environment records that
// point each custom domain at the site's App Service Web App.
//
// There is intentionally ONE zone for the whole apex + every subdomain. The test
// environment is NOT a separate `test.figureskatingtools.com` zone; it is just a
// `test` record set inside this zone. Both the test and prod site deployments target
// this same module/zone (in the shared `rg-fs-dns` resource group), so the zone is
// create-or-update idempotent and each deployment only declares ITS OWN record set.
//
// Because deployments run in incremental mode, records this module does not declare
// (the tool CNAMEs, the MX record, anything added by hand) are never touched.
//
// App Service (unlike Static Web Apps) cannot be the target of an Azure DNS ALIAS
// record, so the apex is a PLAIN A record holding the Web App's inbound VIP. That IP
// is stable for the life of the App Service plan and is re-asserted on every infra
// deploy, so a plan move self-heals on the next run. Keep the TTL low (300).
//
// Ownership verification is the App Service `asuid` TXT record (customDomainVerificationId)
// for BOTH apex and subdomain — the old SWA `_dnsauth` token scheme is gone.

@description('The DNS zone / apex domain name, e.g. figureskatingtools.com')
param zoneName string

@description('The custom domain for this environment (apex for prod, test.<zone> for test). Empty = create/keep the zone only, no records.')
param customDomain string = ''

@description('Inbound IP address of the site Web App. Used for the apex A record.')
param webAppInboundIpAddress string = ''

@description('Default *.azurewebsites.net hostname of the site Web App (CNAME target for subdomains).')
param webAppDefaultHostname string = ''

@description('App Service customDomainVerificationId, published as the `asuid` TXT record so the hostname binding can verify ownership.')
param domainVerificationId string = ''

// An apex/root domain has exactly two labels (figureskatingtools.com); anything with
// a subdomain (test.figureskatingtools.com) routes via a CNAME instead.
var isApex = !empty(customDomain) && length(split(customDomain, '.')) == 2

// Record-set name for a subdomain custom domain, relative to the zone apex.
// test.figureskatingtools.com -> 'test'
var subdomainLabel = replace(customDomain, '.${zoneName}', '')

// `asuid` at the apex, `asuid.test` for a subdomain.
var asuidRecordName = isApex ? 'asuid' : 'asuid.${subdomainLabel}'

resource zone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
}

// --- Apex (prod): figureskatingtools.com ---------------------------------------
// Apex can't be a CNAME and Azure DNS ALIAS records can't target App Service, so this
// is a literal A record pointing at the Web App's inbound VIP.
resource apexA 'Microsoft.Network/dnsZones/A@2018-05-01' = if (isApex && !empty(webAppInboundIpAddress)) {
  parent: zone
  name: '@'
  properties: {
    TTL: 300
    ARecords: [
      {
        ipv4Address: webAppInboundIpAddress
      }
    ]
  }
}

// --- Subdomain (test): test.figureskatingtools.com -----------------------------
resource subdomainCname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (!isApex && !empty(customDomain) && !empty(webAppDefaultHostname)) {
  parent: zone
  name: subdomainLabel
  properties: {
    TTL: 300
    CNAMERecord: {
      cname: webAppDefaultHostname
    }
  }
}

// --- Ownership verification (both apex and subdomain) --------------------------
// App Service reads this before it will bind the hostname. Must stay present for
// the managed certificate to renew.
resource asuidTxt 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (!empty(customDomain) && !empty(domainVerificationId)) {
  parent: zone
  name: asuidRecordName
  properties: {
    TTL: 3600
    TXTRecords: [
      {
        value: [
          domainVerificationId
        ]
      }
    ]
  }
}

@description('Azure-assigned name servers for the zone. Delegate these at the registrar.')
output nameServers array = zone.properties.nameServers
