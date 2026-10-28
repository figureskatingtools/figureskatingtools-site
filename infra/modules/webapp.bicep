// The single figureskatingtools.com Web App: a dependency-free Node router
// (server/server.js) that serves the combined Vite dist from public/ and
// proxies /<tool>/api/* + /api/* to the per-tool and platform Function Apps.
//
// Replaces the former Static Web App and the per-tool Web Apps: one B1 Linux
// plan, one Easy Auth gate (Entra External ID), one custom domain.
param location string
param webAppName string
param appServicePlanName string
param skuName string = 'B1'
param skuTier string = 'Basic'

// --- Entra External ID (customer tenant) ---------------------------------------
// The ONE Easy Auth provider (azureActiveDirectory, segment `aad`) signs users in
// through the External ID tenant, CREDENTIAL-FREE: no clientSecretSettingName, so
// Easy Auth runs the ID-token flow (response_type=id_token, form_post) and
// validates the ID token itself. The site never needs access or refresh tokens.
// Never add a secret here — see infra/EXTERNAL-ID.md (also for why there is no
// custom OIDC provider).

@description('Client id of the Entra External ID app registration (GitHub var AUTH_EXTERNAL_CLIENT_ID).')
@minLength(1)
param externalClientId string

@description('External tenant id (GitHub var EXTERNAL_TENANT_ID).')
@minLength(1)
param externalTenantId string

@description('Authority host of the external tenant (GitHub var AUTH_EXTERNAL_AUTHORITY_HOST), e.g. <tenantId>.ciamlogin.com. Empty = <externalTenantId>.ciamlogin.com.')
param externalAuthorityHost string = ''

@description('Comma-separated External ID tenant ids (EXTERNAL_TENANT_IDS) for the router, which reads the e-mail of those identities only from their email claim and requires externalAccessRole of them.')
param externalTenantIds string = ''

@description('App role (EXTERNAL_ACCESS_ROLE) an External ID identity needs to use the site; without it the router sends them to /no-access/. Empty = Site.Access.')
param externalAccessRole string = 'Site.Access'

// --- Router proxy targets -------------------------------------------------------
// The router resolves /api/* and /<tool>/api/* against these. They are part of the
// template (not a post-deploy az CLI step) so a deployment never leaves the site
// running with no proxy targets — see the appsettings note below.

@description('Base URL of the platform Function App (competitions registry) — the /api/* proxy target.')
param functionAppUrlPlatform string = ''

@description('Base URL of the judgepapers Function App — the /judgepapers/api/* proxy target.')
param functionAppUrlJudgepapers string = ''

@description('Base URL of the scoremodifier Function App — the /scoremodifier/api/* proxy target.')
param functionAppUrlScoremodifier string = ''

@description('Base URL of the protocolgenerator Function App — the /protocolgenerator/api/* proxy target.')
param functionAppUrlProtocolgenerator string = ''

@description('Base URL of the GDPR removal tool Function App — the /tools/gdpr/api/* proxy target.')
param functionAppUrlGdprtool string = ''

@description('X-Proxy-Secret the router sends to the platform Function App. Intentionally empty by default — the backend fails open when its own secret is unset.')
@secure()
param proxySharedSecretPlatform string = ''

@description('X-Proxy-Secret the router sends to the judgepapers Function App.')
@secure()
param proxySharedSecretJudgepapers string = ''

@description('X-Proxy-Secret the router sends to the scoremodifier Function App.')
@secure()
param proxySharedSecretScoremodifier string = ''

@description('X-Proxy-Secret the router sends to the protocolgenerator Function App.')
@secure()
param proxySharedSecretProtocolgenerator string = ''

@description('X-Proxy-Secret the router sends to the GDPR removal tool Function App.')
@secure()
param proxySharedSecretGdprtool string = ''

@description('App role that makes a user an admin (ADMIN_ROLE). The router serves /admin/ and proxies /api/manage/* only for identities carrying it, and tells the backends with X-Forwarded-User-Admin: 1. Empty = Site.Admin.')
param adminRole string = 'Site.Admin'

@description('Comma-separated Entra tenant ids whose principals may use the APIs (ALLOWED_TENANT_IDS); any other tenant gets 403 tenant_not_allowed from the router. Empty = nobody (fail closed).')
param allowedTenantIds string

@description('Health URL of the HOVTP listener, probed by the admin diagnostics (HOVTP_HEALTH_URL).')
param hovtpHealthUrl string = ''

@description('Easy Auth provider segment the router\'s /signin redirects to (/.auth/login/<provider>). Written to the AUTH_LOGIN_PROVIDER app setting; empty means aad. Changes together with the authsettingsV2 identity provider (e.g. the move to Entra External ID).')
param authLoginProvider string = 'aad'

@description('Paths served without an Easy Auth login redirect. /health must stay open so Azure/uptime probes get a 200 instead of a 302; /judgepapers/download is the judges\'-papers link e-mailed to recipients without an account (the token is checked by the judgepapers backend); /, /index.html, /signin, /landing/* and the icons, robots.txt and llms.txt make up the public landing page, which the router serves at / unless the request carries an Easy Auth session (keep in sync with LANDING_DOCUMENT_PATHS and SIGNIN_PATH in server/server.js); /assets/* holds the Vite bundles (open-source code, no data), public so the home page served at / by session cookie can always load and fall back to its sign-in view when the session has expired; /privacy (+ /*) is the privacy notice and /tietosuoja (+ /*) its Finnish translation, which everyone must be able to read before signing in; /terms (+ /*) are the terms of use, which the sign-up page links to; /fonts/* holds the self-hosted web fonts every page uses, including the public ones; /no-access and /no-access/* are the page an External ID user without the access app role is sent to (keep in sync with NO_ACCESS_PATH and PUBLIC_PATH_PREFIXES in server/server.js).')
param authExcludedPaths array = [
  '/health'
  '/judgepapers/download'
  '/'
  '/index.html'
  '/signin'
  '/landing/*'
  '/assets/*'
  '/favicon.png'
  '/apple-touch-icon.png'
  '/robots.txt'
  '/llms.txt'
  '/privacy'
  '/privacy/*'
  '/tietosuoja'
  '/tietosuoja/*'
  '/terms'
  '/terms/*'
  '/fonts/*'
  '/no-access'
  '/no-access/*'
]

resource appServicePlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  // The router needs no identity. 'None' detaches the user-assigned identity the
  // former workforce sign-in used (mi-fs-site-auth-*), which can then be deleted.
  identity: {
    type: 'None'
  }
  properties: {
    serverFarmId: appServicePlan.id
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server.js'
      // B1 is a dedicated plan: keep the router warm so the first request after
      // an idle period doesn't pay a cold start on top of the Function App's.
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
    }
    httpsOnly: true
  }
}

// App Service logs: the router's console output (Linux "Application logging
// (File System)", which App Service stores as the file-system HTTP logs config)
// is kept at most 90 days and 35 MB, whichever comes first. The privacy notice
// promises 90 days for technical logs; 0 would mean "never deleted".
resource siteLogs 'Microsoft.Web/sites/config@2022-09-01' = {
  parent: webApp
  name: 'logs'
  properties: {
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInDays: 90
        retentionInMb: 35
      }
    }
    detailedErrorMessages: {
      enabled: false
    }
    failedRequestsTracing: {
      enabled: false
    }
  }
}

var effectiveExternalAuthorityHost = !empty(externalAuthorityHost)
  ? externalAuthorityHost
  : '${externalTenantId}.ciamlogin.com'

resource authConfig 'Microsoft.Web/sites/config@2022-09-01' = {
  parent: webApp
  name: 'authsettingsV2'
  properties: {
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: authExcludedPaths
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        // No credential at all (ID-token flow).
        registration: {
          clientId: externalClientId
          openIdIssuer: 'https://${effectiveExternalAuthorityHost}/${externalTenantId}/v2.0'
        }
        validation: {
          allowedAudiences: [
            externalClientId
          ]
        }
        // The External ID ID token carries `email` only when it is asked for.
        login: {
          loginParameters: [
            'scope=openid profile email'
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: false
      }
    }
  }
}

// NOTE: `Microsoft.Web/sites/config@.../appsettings` REPLACES the whole app
// settings collection, so EVERY setting the router needs must be listed here.
// The proxy targets and their shared secrets used to be applied afterwards by
// the deploy-frontend job's az CLI step; any run that failed in between left the
// router with no proxy targets and every /api call 502'd. They are now part of
// the same deployment as the Web App itself, which makes infra atomic.
// Empty values are written as they come, but the backends fail CLOSED: an
// empty PROXY_SHARED_SECRET_* means every call to that backend is a 401.
resource siteAppSettings 'Microsoft.Web/sites/config@2022-09-01' = {
  parent: webApp
  name: 'appsettings'
  properties: {
    FUNCTION_APP_URL_PLATFORM: functionAppUrlPlatform
    FUNCTION_APP_URL_JUDGEPAPERS: functionAppUrlJudgepapers
    FUNCTION_APP_URL_SCOREMODIFIER: functionAppUrlScoremodifier
    FUNCTION_APP_URL_PROTOCOLGENERATOR: functionAppUrlProtocolgenerator
    FUNCTION_APP_URL_GDPRTOOL: functionAppUrlGdprtool
    PROXY_SHARED_SECRET_PLATFORM: proxySharedSecretPlatform
    PROXY_SHARED_SECRET_JUDGEPAPERS: proxySharedSecretJudgepapers
    PROXY_SHARED_SECRET_SCOREMODIFIER: proxySharedSecretScoremodifier
    PROXY_SHARED_SECRET_PROTOCOLGENERATOR: proxySharedSecretProtocolgenerator
    PROXY_SHARED_SECRET_GDPRTOOL: proxySharedSecretGdprtool
    AUTH_LOGIN_PROVIDER: empty(authLoginProvider) ? 'aad' : authLoginProvider
    // External ID tenants: the router takes those identities' e-mail only
    // from their email claim.
    EXTERNAL_TENANT_IDS: externalTenantIds
    // The app role those identities need (else /no-access/).
    EXTERNAL_ACCESS_ROLE: empty(trim(externalAccessRole)) ? 'Site.Access' : trim(externalAccessRole)
    ADMIN_ROLE: empty(trim(adminRole)) ? 'Site.Admin' : trim(adminRole)
    ALLOWED_TENANT_IDS: allowedTenantIds
    HOVTP_HEALTH_URL: hovtpHealthUrl
    // Hard-disables DEV_FAKE_USER and DEV_FAKE_ROLES in the router, which the admin check relies on.
    NODE_ENV: 'production'
    // The zip already contains the built dist; Oryx must not try to build it.
    SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'
  }
}

output webAppName string = webApp.name
output webAppDefaultHostName string = webApp.properties.defaultHostName
output customDomainVerificationId string = webApp.properties.customDomainVerificationId
// `inboundIpAddress` is returned by the ARM GET (it is what
// `az webapp show --query inboundIpAddress` reads) but is missing from the
// generated Bicep type for Microsoft.Web/sites, hence the suppression.
// During binding/scale operations ARM can transiently report a comma-separated
// PAIR of IPs ('51.x,51.y'); writing that into the apex A record fails the DNS
// deployment AND deletes the record — always take the first address.
@description('Inbound VIP of the App Service. The apex A record points at this literal IP (Azure DNS alias records cannot target App Service).')
#disable-next-line BCP053
output inboundIpAddress string = split(webApp.properties.inboundIpAddress, ',')[0]
output appServicePlanId string = appServicePlan.id
