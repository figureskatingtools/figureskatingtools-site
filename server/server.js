// Zero-dependency router/server for figureskatingtools.com on Azure App Service.
//
// One Web App fronts the whole domain:
//   /                        → signed in: home page (SPA); signed out: the
//                              static public landing page (excluded from Easy Auth)
//   /signin                  → 302 to the identity provider's login (excluded from Easy Auth)
//   /judgepapers/            → Judge Papers app        (SPA, own index.html)
//   /scoremodifier/          → Score Modifier app      (SPA, own index.html)
//   /protocolgenerator/      → Protocol Generator app  (SPA, own index.html)
//   /tools/<name>/           → small in-site tools (static pages)
//   /admin/                  → admin panel (SPA; plain 404 unless the user is an admin)
//   /admin/api/diagnostics   → router-native diagnostics (admins only)
//   /privacy/, /tietosuoja/  → public privacy notice, English and Finnish (static, excluded from Easy Auth)
//   /terms/                  → public terms of use, English only (static, excluded from Easy Auth)
//   /no-access/              → public "no access yet" page for External ID users without the app role
//   /fonts/*                 → self-hosted web fonts (static, excluded from Easy Auth)
//   /health                  → liveness probe (excluded from Easy Auth)
//   /judgepapers/download    → e-mailed judges'-papers link (excluded from Easy Auth)
//   /userinfo                → flat user object decoded from Easy Auth headers
//   /changelog-live          → merged GitHub commits for "What's New" (cached)
//   /api/manage/*            → platform Function App, admins only (403 otherwise)
//   /api/*                   → platform Function App
//   /<tool>/api/*            → that tool's Function App, with /<tool> stripped
//   /tools/gdpr/api/*        → GDPR removal tool's Function App, /tools/gdpr stripped
//
// Node 22 built-ins only — no npm dependencies. Bodies are never buffered:
// requests and responses are piped straight through so 100 MiB uploads and
// binary downloads stream in constant memory.
//
// See server/README.md for the env-var contract and local dev usage.

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Tools ────────────────────────────────────────────────────────────────────
// Order matters only for readability; lookups are by exact first path segment.
const TOOLS = ['judgepapers', 'scoremodifier', 'protocolgenerator'];
const PLATFORM = 'platform';

// Small tools under /tools/<name>/ that have a backend of their own. Their page
// is a plain static document (no SPA prefix, no blob-storage CSP); only the API
// path is proxied: /tools/gdpr/api/* → $FUNCTION_APP_URL_GDPRTOOL/api/*.
const SMALL_TOOL_APIS = { gdprtool: '/tools/gdpr' };
const PROXY_TARGETS = [...TOOLS, ...Object.keys(SMALL_TOOL_APIS), PLATFORM];

// Path prefixes that own an SPA document of their own: the tools plus the
// admin panel. Only the deep-link fallback uses it; admin is deliberately not
// in TOOLS, which would make it a proxy target and give it the blob-host CSP.
const ADMIN_PREFIX = 'admin';
const DOCUMENT_PREFIXES = [...TOOLS, ADMIN_PREFIX];

// Admin-only platform routes. The platform checks the admin again with its own
// allow-list (its hostname is public); this gate is the first of the two.
const MANAGE_API_PREFIX = '/api/manage';
const ADMIN_DIAGNOSTICS_PATH = '/admin/api/diagnostics';

// Written next to server.js by the deploy workflow (never under public/, so it
// is not served): {"commit": "<sha>", "builtUtc": "…"}. Missing locally.
const BUILD_INFO_FILE = 'build-info.json';
// Generous: a Flex Consumption app answering its first request after idling
// can take several seconds (judgepapers measured ~3.7 s for a cold 404).
const HEALTH_TIMEOUT_MS = 10000;

// Public (no sign-in) route for the link e-mailed by judgepapers' send dialog.
// Must match the Easy Auth excludedPaths entry in infra/modules/webapp.bicep.
const JUDGEPAPERS_DOWNLOAD_PATH = '/judgepapers/download';

// The public landing page: a static document served at / to visitors who are
// not signed in. / is an Easy Auth excluded path, and Easy Auth does not inject
// X-MS-CLIENT-PRINCIPAL there, so a signed-in browser is recognised by its
// session cookie (see hasSignedInSession).
// LANDING_DOCUMENT_PATHS, SIGNIN_PATH and the landing files must all be listed
// in the Easy Auth excludedPaths in infra/modules/webapp.bicep. So must the
// public privacy notice (/privacy/ and its Finnish translation /tietosuoja/),
// the terms of use (/terms/) and the self-hosted fonts (/fonts/*): those need
// no router logic, serveStatic serves them to everyone.
const LANDING_DIR = 'landing';
const LANDING_DOCUMENT_PATHS = ['/', '/index.html'];

// Every sign-in link goes through /signin, so a change of identity provider
// (e.g. Entra External ID) is one app setting instead of a frontend change.
const SIGNIN_PATH = '/signin';

const DEFAULT_LOGIN_PROVIDER = 'aad';

// Entra External ID access gate: an identity of an EXTERNAL_TENANT_IDS tenant
// must carry this app role (EXTERNAL_ACCESS_ROLE) or it gets the public
// "no access yet" page instead of the site. /no-access/ is a static document
// like the privacy notice, so it must be in the Easy Auth excludedPaths too
// (/no-access, /no-access/*), and in PUBLIC_PATH_PREFIXES below.
const DEFAULT_EXTERNAL_ACCESS_ROLE = 'Site.Access';
// Admins are whoever carries this app role (ADMIN_ROLE); nothing else makes one.
const DEFAULT_ADMIN_ROLE = 'Site.Admin';
const NO_ACCESS_PATH = '/no-access/';

// Mirror of the static part of authExcludedPaths in webapp.bicep: what a
// signed-in user without access may still load (the no-access page itself,
// its styles, fonts and icons, the privacy notice in both languages and the
// terms).
const PUBLIC_PATH_PREFIXES = ['/no-access', '/privacy', '/terms', '/tietosuoja', '/landing', '/assets', '/fonts'];
const PUBLIC_FILES = ['/favicon.png', '/apple-touch-icon.png', '/robots.txt', '/llms.txt'];

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.zip': 'application/zip',
    '.map': 'application/json',
};

// ── Configuration ────────────────────────────────────────────────────────────
// Every knob comes from the environment so the same file runs locally, on the
// test Web App and on prod with only app settings differing.
function envKeySuffix(tool) {
    return tool.toUpperCase();
}

function urlEnvVar(tool) {
    return `FUNCTION_APP_URL_${envKeySuffix(tool)}`;
}

function secretEnvVar(tool) {
    return `PROXY_SHARED_SECRET_${envKeySuffix(tool)}`;
}

// ALLOWED_TENANT_IDS: comma-separated Entra tenant ids, compared lowercased.
function parseTenantIds(raw) {
    return new Set(
        String(raw || '')
            .split(',')
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean)
    );
}

// An e-mail as the router compares and forwards it: printable ASCII only,
// tested BEFORE lowercasing — toLowerCase() folds some non-ASCII letters into
// ASCII ones (U+212A KELVIN SIGN becomes 'k'), which would let a look-alike
// address match someone else's. Anything else is no e-mail at all ('').
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

function normalizeEmail(value) {
    const text = String(value || '').trim();
    return PRINTABLE_ASCII.test(text) ? text.toLowerCase() : '';
}

// DEV_FAKE_ROLES: comma-separated app roles for the DEV_FAKE_USER stand-in.
function parseList(raw) {
    return String(raw || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
}

function loadConfig(env = process.env) {
    const targets = {};
    for (const tool of PROXY_TARGETS) {
        targets[tool] = {
            urlEnvVar: urlEnvVar(tool),
            secretEnvVar: secretEnvVar(tool),
            url: (env[urlEnvVar(tool)] || '').trim(),
            secret: (env[secretEnvVar(tool)] || '').trim(),
        };
    }

    const isProduction = env.NODE_ENV === 'production';

    return {
        port: Number(env.PORT) || 8080,
        publicDir: env.PUBLIC_DIR
            ? path.resolve(env.PUBLIC_DIR)
            : path.join(__dirname, 'public'),
        // Local dev only: pretend a user is signed in when Easy Auth headers are
        // absent. Hard-disabled in production so it can never leak into a real env.
        devFakeUser: isProduction ? '' : (env.DEV_FAKE_USER || '').trim(),
        // Local dev only: the app roles DEV_FAKE_USER carries (e.g. Site.Admin
        // for the admin panel). Blanked in production like DEV_FAKE_USER.
        devFakeRoles: isProduction ? [] : parseList(env.DEV_FAKE_ROLES),
        // Easy Auth provider segment of /.auth/login/<provider> used by /signin.
        loginProvider: (env.AUTH_LOGIN_PROVIDER || '').trim() || DEFAULT_LOGIN_PROVIDER,
        // Which tenant Easy Auth signs in with (webapp.bicep). Diagnostics only;
        // Easy Auth itself decides.
        authTenantMode: (env.AUTH_TENANT_MODE || '').trim().toLowerCase() === 'external' ? 'external' : 'workforce',
        // Entra External ID tenants: their identities' e-mail comes only from
        // the `email` claim.
        externalTenantIds: parseTenantIds(env.EXTERNAL_TENANT_IDS),
        // The app role an External ID identity needs to use the site.
        externalAccessRole: (env.EXTERNAL_ACCESS_ROLE || '').trim() || DEFAULT_EXTERNAL_ACCESS_ROLE,
        nodeEnv: (env.NODE_ENV || '').trim(),
        // The app role that makes an identity an admin (the admin panel and
        // /api/manage/*), in both tenant modes. Implies access.
        adminRole: (env.ADMIN_ROLE || '').trim() || DEFAULT_ADMIN_ROLE,
        // Entra tenants whose principals may use the site's APIs. Empty =
        // none (fail closed); webapp.bicep sets the deployment tenant.
        allowedTenantIds: parseTenantIds(env.ALLOWED_TENANT_IDS),
        // The HOVTP listener is not proxied, so diagnostics need its URL apart.
        hovtpHealthUrl: (env.HOVTP_HEALTH_URL || '').trim(),
        buildInfoPath: path.join(__dirname, BUILD_INFO_FILE),
        healthTimeoutMs: HEALTH_TIMEOUT_MS,
        // Changelog knobs. Not env-driven — they exist as config so tests can
        // point the fetch at a stub GitHub and shrink the cache window.
        githubApiOrigin: GITHUB_API_ORIGIN,
        changelogTtlMs: CHANGELOG_TTL_MS,
        targets,
    };
}

// ── Content-Security-Policy ──────────────────────────────────────────────────
// Built per path prefix from a directive map so each app gets exactly the
// capabilities it needs and nothing more.
function baseDirectives() {
    return {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        // Fonts are self-hosted under /fonts/ (no third-party font host).
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
    };
}

const DIRECTIVE_ORDER = [
    'default-src',
    'script-src',
    'worker-src',
    'style-src',
    'img-src',
    'font-src',
    'connect-src',
    'frame-ancestors',
];

function add(directives, name, ...values) {
    const list = directives[name] || (directives[name] = []);
    for (const value of values) {
        if (!list.includes(value)) list.push(value);
    }
}

function serializeCsp(directives) {
    const names = [
        ...DIRECTIVE_ORDER.filter((n) => directives[n]),
        ...Object.keys(directives).filter((n) => !DIRECTIVE_ORDER.includes(n)),
    ];
    return names.map((n) => `${n} ${directives[n].join(' ')}`).join('; ');
}

// Blob SAS URLs are handed to the browser for direct upload/download, so the
// tool prefixes must be allowed to talk to (and render images from) storage.
const BLOB_HOST = 'https://*.blob.core.windows.net';

function buildCsp(prefix) {
    const d = baseDirectives();

    if (TOOLS.includes(prefix)) {
        add(d, 'connect-src', BLOB_HOST);
        add(d, 'img-src', BLOB_HOST);
    }

    if (prefix === 'protocolgenerator') {
        // pdf.js ships a WASM image decoder and runs its parser in a blob worker.
        add(d, 'script-src', "'wasm-unsafe-eval'");
        add(d, 'worker-src', "'self'", 'blob:');
        add(d, 'connect-src', 'blob:');
        add(d, 'img-src', 'blob:');
    }

    return serializeCsp(d);
}

// Precomputed: the policy never changes at runtime.
const CSP_BY_PREFIX = { '': buildCsp('') };
for (const tool of TOOLS) CSP_BY_PREFIX[tool] = buildCsp(tool);

// First path segment, but only when it names one of the SPA prefixes.
function prefixFor(pathname) {
    const segment = pathname.split('/')[1] || '';
    return TOOLS.includes(segment) ? segment : '';
}

const BASE_SECURITY_HEADERS = {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function applySecurityHeaders(res, pathname) {
    for (const [key, val] of Object.entries(BASE_SECURITY_HEADERS)) {
        res.setHeader(key, val);
    }
    res.setHeader('Content-Security-Policy', CSP_BY_PREFIX[prefixFor(pathname)]);
}

// ── Easy Auth identity ───────────────────────────────────────────────────────
function decodePrincipal(req) {
    const raw = req.headers['x-ms-client-principal'];
    if (!raw) return null;
    try {
        return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
    } catch (_e) {
        return null; // malformed header — treat as absent
    }
}

function findClaim(parsed, types) {
    const claims = (parsed && parsed.claims) || [];
    if (!Array.isArray(claims)) return '';
    const hit = claims.find((c) => c && types.includes(c.typ));
    return (hit && hit.val) || '';
}

const NAME_CLAIMS = ['name', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];
// Entra External ID identities arrive through the same `aad` Easy Auth provider
// (AUTH_TENANT_MODE=external) and are told apart by their tid being in
// EXTERNAL_TENANT_IDS. Their e-mail comes from the `email` claim and nothing
// else: preferred_username / the principal name need not be an e-mail there.
// App Service may hand `email` on under its long schema name.
const EXTERNAL_EMAIL_CLAIMS = ['email', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
const EMAIL_CLAIMS = [
    'preferred_username',
    'email',
    'emails',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];

// The two claims that identify a user for authorisation: the Entra object id
// (stable, never reassigned) and the tenant it belongs to. The e-mail is
// mutable and only ever forwarded for display and audit.
// App roles: Easy Auth emits one claim per role, short or long form.
const ROLE_CLAIMS = ['roles', 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'];
const OID_CLAIMS = ['http://schemas.microsoft.com/identity/claims/objectidentifier', 'oid'];
const TID_CLAIMS = ['http://schemas.microsoft.com/identity/claims/tenantid', 'tid'];
// The External ID sign-up's required "I accept the terms of use" checkbox
// (infra/EXTERNAL-ID.md), a Boolean claim. Forwarded as
// x-forwarded-user-terms-accepted: 1 so the platform can record which terms
// version was current; nothing is ever refused without it (workforce sign-ins
// never carry it).
const TERMS_ACCEPTED_CLAIMS = ['termsAccepted'];
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// DEV_FAKE_USER's synthetic identity (never in production): a fixed tenant
// and an object id derived from the e-mail, so the same dev user is the same
// platform user on every run. Add DEV_TENANT_ID to the local platform's
// ALLOWED_TENANT_IDS.
const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

function devObjectId(email) {
    const hex = crypto.createHash('sha256').update(`fst-dev-user:${email}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// True for an identity of an Entra External ID tenant (EXTERNAL_TENANT_IDS).
function isExternalTenant(tid, config) {
    return Boolean(tid) && Boolean(config.externalTenantIds) && config.externalTenantIds.has(tid);
}

// The raw (not yet normalised) e-mail of a principal. Workforce: userDetails,
// then the e-mail claims, then the principal-name header. External ID tenant:
// only the `email` claim.
function principalEmail(parsed, req, external) {
    if (external) return findClaim(parsed, EXTERNAL_EMAIL_CLAIMS);
    return parsed.userDetails || findClaim(parsed, EMAIL_CLAIMS) || req.headers['x-ms-client-principal-name'] || '';
}

function claimValues(parsed, types) {
    const claims = (parsed && parsed.claims) || [];
    if (!Array.isArray(claims)) return [];
    return claims.filter((c) => c && types.includes(c.typ) && typeof c.val === 'string').map((c) => c.val.trim());
}

// True only for a claim value of boolean true or the string "true" (any case).
function termsAcceptedClaim(parsed) {
    const claims = (parsed && parsed.claims) || [];
    if (!Array.isArray(claims)) return false;
    return claims.some((c) => c && TERMS_ACCEPTED_CLAIMS.includes(c.typ)
        && (c.val === true || (typeof c.val === 'string' && c.val.trim().toLowerCase() === 'true')));
}

function guidClaim(parsed, types) {
    const value = String(findClaim(parsed, types) || '').trim().toLowerCase();
    return GUID_PATTERN.test(value) ? value : '';
}

// The signed-in user as the backends get to see them:
// {tid, oid, email (lowercased), name, roles, termsAccepted, dev} — or null when there is no usable
// identity. Only a decodable Easy Auth principal that carries both oid and tid
// counts (a bare X-MS-CLIENT-PRINCIPAL-NAME never does), or DEV_FAKE_USER
// locally when no principal header is present at all.
function requestIdentity(req, config) {
    const parsed = decodePrincipal(req);
    if (parsed) {
        const tid = guidClaim(parsed, TID_CLAIMS);
        const oid = guidClaim(parsed, OID_CLAIMS);
        if (!tid || !oid) return null;
        return {
            tid,
            oid,
            email: normalizeEmail(principalEmail(parsed, req, isExternalTenant(tid, config))),
            name: String(findClaim(parsed, NAME_CLAIMS) || '').trim(),
            roles: claimValues(parsed, ROLE_CLAIMS),
            termsAccepted: termsAcceptedClaim(parsed),
            dev: false,
        };
    }
    if (config.devFakeUser && !req.headers['x-ms-client-principal-name']) {
        const email = normalizeEmail(config.devFakeUser);
        const roles = Array.isArray(config.devFakeRoles) ? [...config.devFakeRoles] : [];
        return { tid: DEV_TENANT_ID, oid: devObjectId(email), email, name: config.devFakeUser, roles, termsAccepted: false, dev: true };
    }
    return null;
}

// ALLOWED_TENANT_IDS decides which Entra tenants may use the APIs. The dev
// stand-in exists only outside production and is always let through here.
function tenantAllowed(identity, config) {
    if (identity.dev) return true;
    return Boolean(config.allowedTenantIds) && config.allowedTenantIds.has(identity.tid);
}

// The External ID access gate: identities of an EXTERNAL_TENANT_IDS tenant need
// the EXTERNAL_ACCESS_ROLE app role. Workforce identities (and the dev stand-in)
// are unaffected. No admin exception: the role is the single source of truth.
function accessGranted(identity, config) {
    if (identity.dev || !isExternalTenant(identity.tid, config)) return true;
    // The admin role implies access.
    return hasRole(identity, config.externalAccessRole) || hasRole(identity, config.adminRole);
}

function hasRole(identity, role) {
    return Boolean(role) && Array.isArray(identity.roles) && identity.roles.includes(role);
}

// True for a signed-in identity of an allowed tenant that lacks the access
// role: what gets /no-access/ and 403 access_not_granted.
function accessDenied(req, config) {
    const identity = requestIdentity(req, config);
    return Boolean(identity) && tenantAllowed(identity, config) && !accessGranted(identity, config);
}

function sendAccessNotGranted(res) {
    sendJson(res, 403, { error: 'access_not_granted' });
}

function isPublicPath(pathname) {
    return PUBLIC_FILES.includes(pathname) || PUBLIC_PATH_PREFIXES.some((prefix) => isUnder(pathname, prefix));
}

// Gate for every proxied API and /userinfo: the identity, or null after a
// 401 (no usable identity) / 403 tenant_not_allowed / 403 access_not_granted
// has been sent.
function requireIdentity(req, res, config) {
    const identity = requestIdentity(req, config);
    if (!identity) {
        sendJson(res, 401, { error: 'unauthorized', message: 'Sign-in required.' });
        return null;
    }
    if (!tenantAllowed(identity, config)) {
        sendJson(res, 403, {
            error: 'tenant_not_allowed',
            message: 'Accounts of your organisation cannot use this site.',
        });
        return null;
    }
    if (!accessGranted(identity, config)) {
        sendAccessNotGranted(res);
        return null;
    }
    return identity;
}

// GET /userinfo — flat, token-free view of the signed-in user for the frontends.
function handleUserInfo(req, res, config) {
    const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };

    // No principal, or one without oid/tid: signed out as far as the APIs go.
    if (!requestIdentity(req, config)) {
        json({ authenticated: false });
        return;
    }
    // Signed in but without the access role: the no-access page shows who
    // they are signed in as — the display name and the validated e-mail only,
    // never tid or oid.
    if (accessDenied(req, config)) {
        const denied = requestIdentity(req, config);
        sendJson(res, 403, { error: 'access_not_granted', name: denied.name, email: denied.email });
        return;
    }
    const identity = requireIdentity(req, res, config);
    if (!identity) return;

    if (identity.dev) {
        json({
            authenticated: true,
            userId: 'dev-user',
            identityProvider: 'dev',
            userDetails: config.devFakeUser,
            userRoles: ['authenticated'],
            isAdmin: isAdminRequest(req, config),
        });
        return;
    }

    const parsed = decodePrincipal(req);
    const principalName = req.headers['x-ms-client-principal-name'];
    // Prefer email, then name, then userDetails, then the principal-name header.
    // External ID tenant: its `email` claim only (preferred_username need not be an e-mail).
    const displayName =
        findClaim(parsed, isExternalTenant(identity.tid, config) ? EXTERNAL_EMAIL_CLAIMS : EMAIL_CLAIMS) ||
        findClaim(parsed, NAME_CLAIMS) ||
        parsed.userDetails ||
        principalName ||
        'unknown';

    json({
        authenticated: true,
        userId: parsed.userId,
        identityProvider: parsed.identityProvider,
        userDetails: displayName,
        // Display name ('' when the principal has no name claim), e.g. the
        // judgepapers send dialog's default sender name.
        name: findClaim(parsed, NAME_CLAIMS),
        userRoles: parsed.userRoles || [],
        isAdmin: isAdminRequest(req, config),
    });
}

// Easy Auth's session cookie (chunked as AppServiceAuthSession1, 2, … when large).
const EASY_AUTH_SESSION_COOKIE = /(?:^|;\s*)AppServiceAuthSession\d*=[^;\s]/;

// Whether / should get the signed-in home page: an Easy Auth principal, the
// Easy Auth session cookie (excluded paths get the cookie but no principal
// headers), or DEV_FAKE_USER locally. Only picks a document, never gates data:
// the home page's /userinfo and every API stay behind Easy Auth, so a stale or
// forged cookie just ends on the home page's own sign-in view.
function hasSignedInSession(req, config) {
    return Boolean(
        decodePrincipal(req) ||
            req.headers['x-ms-client-principal-name'] ||
            EASY_AUTH_SESSION_COOKIE.test(req.headers.cookie || '') ||
            config.devFakeUser
    );
}

// Where /signin may send the user back to: a same-origin absolute path only.
// Anything else (//evil.example, /\evil, https://…, control characters) → '/'.
function safeReturnPath(value) {
    if (typeof value !== 'string' || !value.startsWith('/')) return '/';
    if (value.startsWith('//') || value.startsWith('/\\')) return '/';
    if (/[\u0000-\u001f\u007f\\]/.test(value)) return '/';
    return value;
}

// GET /signin[?return=/path] → the provider's login, returning to that path.
function handleSignIn(req, res, config, search) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
        res.end();
        return;
    }
    const returnPath = safeReturnPath(new URLSearchParams(search).get('return') || '/');
    const provider = encodeURIComponent(config.loginProvider);
    res.writeHead(302, {
        Location: `/.auth/login/${provider}?post_login_redirect_url=${encodeURIComponent(returnPath)}`,
        'Cache-Control': 'no-store',
    });
    res.end();
}

// Whether the request comes from an admin: the identity carries the ADMIN_ROLE
// app role (`roles` claim, either form) and is from an allowed tenant — in both
// tenant modes; the e-mail plays no part. Needs the same identity the APIs need
// — a decodable Easy Auth principal with oid and tid, or DEV_FAKE_USER with
// DEV_FAKE_ROLES locally (both blank under NODE_ENV=production); a bare
// X-MS-CLIENT-PRINCIPAL-NAME is never enough.
function isAdminRequest(req, config) {
    const identity = requestIdentity(req, config);
    if (!identity || !tenantAllowed(identity, config) || !accessGranted(identity, config)) return false;
    return hasRole(identity, config.adminRole);
}

// CSRF guard for every state-changing API call on top of the session cookie:
// the browser must say the call is same-origin (Sec-Fetch-Site, sent by every
// current browser), or — only when it sends no Sec-Fetch-Site at all — an
// Origin whose host is this host. A Sec-Fetch-Site other than same-origin is
// never overruled by a matching Origin.
function isSameOriginRequest(req) {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined) return site === 'same-origin';
    const origin = req.headers.origin;
    if (!origin || !req.headers.host) return false;
    try {
        return new URL(origin).host === req.headers.host;
    } catch (_e) {
        return false;
    }
}

// GET and HEAD are the only methods proxied without the same-origin check.
function isSafeMethod(method) {
    return method === 'GET' || method === 'HEAD';
}

// Refused with 400 before any routing: a path whose meaning depends on who
// decodes or normalises it. Dot segments ('.', '..', also percent-encoded),
// encoded slashes or backslashes (%2F, %5C), raw backslashes, NUL and
// undecodable escapes. Nothing the site's own pages request looks like this,
// so the gates below never have to reason about two readings of one URL.
const ENCODED_SEPARATOR = /%(2f|5c|2e|00)/i;

function isUnsafePath(pathname) {
    if (!pathname.startsWith('/')) return true;
    if (pathname.includes('\\') || ENCODED_SEPARATOR.test(pathname)) return true;
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch (_e) {
        return true;
    }
    if (/[\\\u0000]/.test(decoded) || ENCODED_SEPARATOR.test(decoded)) return true;
    return decoded.split('/').some((segment) => segment === '.' || segment === '..');
}

// The path as the static server and the backends will interpret it: decoded
// and double-slash normalised (dot segments never get this far — see
// isUnsafePath). Every route matches on this, so /%61dmin/ or //admin/
// cannot slip past a gate.
function canonicalPath(pathname) {
    let decoded = pathname;
    try {
        decoded = decodeURIComponent(pathname);
    } catch (_e) {
        // isUnsafePath refused it already
    }
    return path.posix.normalize(decoded);
}

// A canonical (decoded) path re-encoded for the wire: each segment through
// encodeURIComponent — exactly how the site's own pages encode a path
// parameter, so what they send is forwarded byte for byte.
function encodePath(canonical) {
    return canonical.split('/').map(encodeURIComponent).join('/');
}

function isUnder(pathname, prefix) {
    return pathname === prefix || pathname.startsWith(prefix + '/');
}

// ── Proxy ────────────────────────────────────────────────────────────────────
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
]);

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

// Streams req → upstream → res. Nothing is buffered in between. `identity`
// (from requireIdentity) becomes the x-forwarded-user-* headers; null for the
// public /judgepapers/download link, which Easy Auth does not gate.
function proxy(req, res, config, tool, targetPath, identity) {
    const target = config.targets[tool];

    if (!target || !target.url) {
        sendJson(res, 502, {
            error: 'proxy_target_not_configured',
            tool,
            message: `No backend configured for "${tool}": set ${target ? target.urlEnvVar : urlEnvVar(tool)}.`,
        });
        return;
    }

    let targetUrl;
    try {
        targetUrl = new URL(target.url.replace(/\/+$/, '') + targetPath);
    } catch (_e) {
        sendJson(res, 502, {
            error: 'proxy_target_invalid',
            tool,
            message: `${target.urlEnvVar} is not a valid URL.`,
        });
        return;
    }

    const secure = targetUrl.protocol === 'https:';
    const transport = secure ? https : http;

    const outHeaders = {
        host: targetUrl.host,
        accept: req.headers['accept'] || '*/*',
    };
    if (req.headers['content-type']) outHeaders['content-type'] = req.headers['content-type'];
    if (req.headers['content-length']) outHeaders['content-length'] = req.headers['content-length'];

    // Proves the call came through this proxy — the Function Apps are public,
    // so without it anyone could spoof the user-email header.
    if (target.secret) outHeaders['x-proxy-secret'] = target.secret;

    // The identity headers. Built here from the decoded principal only: the
    // outbound headers are an allow-list, so a browser's own copies of these
    // names never reach a backend.
    if (identity) {
        outHeaders['x-forwarded-user-tid'] = identity.tid;
        outHeaders['x-forwarded-user-oid'] = identity.oid;
        // Display/audit only. requestIdentity already dropped anything that
        // is not printable ASCII (header values must be).
        if (identity.email && PRINTABLE_ASCII.test(identity.email)) {
            outHeaders['x-forwarded-user-email'] = identity.email;
        }
        // Names are non-ASCII more often than not; headers must be ASCII.
        if (identity.name) outHeaders['x-forwarded-user-name'] = encodeURIComponent(identity.name);
        if (isAdminRequest(req, config)) outHeaders['x-forwarded-user-admin'] = '1';
        if (identity.termsAccepted) outHeaders['x-forwarded-user-terms-accepted'] = '1';
    }

    const proxyReq = transport.request(
        {
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetUrl.port || (secure ? 443 : 80),
            path: targetUrl.pathname + (targetUrl.search || ''),
            method: req.method,
            headers: outHeaders,
        },
        (proxyRes) => {
            const respHeaders = {};
            for (const [key, val] of Object.entries(proxyRes.headers)) {
                if (HOP_BY_HOP.has(key.toLowerCase())) continue;
                respHeaders[key] = val;
            }
            res.writeHead(proxyRes.statusCode, respHeaders);
            proxyRes.pipe(res);
        }
    );

    proxyReq.on('error', (e) => {
        console.error(`Proxy error (${tool} ${targetPath}):`, e.message);
        if (!res.headersSent) {
            sendJson(res, 502, { error: 'proxy_request_failed', tool, message: 'Bad Gateway' });
        } else {
            res.destroy();
        }
    });

    // Abort the upstream call if the client hangs up mid-upload.
    res.on('close', () => {
        if (!res.writableFinished) proxyReq.destroy();
    });

    req.pipe(proxyReq);
}

// ── Changelog ────────────────────────────────────────────────────────────────
// The "What's New" panel used to call api.github.com from every browser, so the
// unauthenticated 60 req/hr-per-IP budget (4 repos per page load) ran out fast
// and the panel fell back to the build-time snapshot. The router now fetches the
// commits once per branch and keeps them in memory, so the whole site costs
// GitHub four requests per ten minutes.

const GITHUB_API_ORIGIN = 'https://api.github.com';
const CHANGELOG_TTL_MS = 10 * 60 * 1000;
// Accepted for compatibility with frontends built while the test site still
// asked for `test`; every tool repo now ships from `main` only (feature branches,
// no long-lived `test` branch), so all of them are served the `main` feed.
const CHANGELOG_BRANCHES = ['main', 'test'];
const CHANGELOG_FEED_BRANCH = 'main';
const CHANGELOG_SOURCES_FILE = 'changelog-sources.json';
const CHANGELOG_PER_PAGE = 20; // commits requested per repo
const CHANGELOG_MAX_ENTRIES = 20; // entries returned after merging
const CHANGELOG_TIMEOUT_MS = 10000;
// GitHub rejects API calls without one.
const CHANGELOG_USER_AGENT = 'figureskatingtools-site-router';
// Guards the interpolation into the upstream URL; the source list is ours, but
// a typo must not turn into a path escape.
// A commit whose message carries #nowhatsnew (or the #nowhatnew typo) anywhere,
// any case, stays out of "What's New". Keep in sync with HIDDEN_COMMIT_TAG in
// site/src/main.ts and the jq filter in scripts/generate-changelog.sh.
const CHANGELOG_HIDE_TAG = /#nowhats?new\b/i;

function isHiddenFromChangelog(commit) {
    const message = (commit && commit.commit && commit.commit.message) || '';
    return CHANGELOG_HIDE_TAG.test(message);
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

// GET returning parsed JSON. Uses the same http/https modules as the proxy so
// the file keeps a single outbound-request style.
function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        let target;
        try {
            target = new URL(url);
        } catch (_e) {
            reject(new Error(`Invalid upstream URL: ${url}`));
            return;
        }

        const secure = target.protocol === 'https:';
        const transport = secure ? https : http;

        const req = transport.request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (secure ? 443 : 80),
                path: target.pathname + (target.search || ''),
                method: 'GET',
                headers,
            },
            (upstream) => {
                const chunks = [];
                upstream.on('data', (c) => chunks.push(c));
                upstream.on('error', reject);
                upstream.on('end', () => {
                    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
                        reject(new Error(`HTTP ${upstream.statusCode} from ${url}`));
                        return;
                    }
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
                    } catch (_e) {
                        reject(new Error(`Malformed JSON from ${url}`));
                    }
                });
            }
        );

        req.setTimeout(CHANGELOG_TIMEOUT_MS, () => {
            req.destroy(new Error(`Timed out fetching ${url}`));
        });
        req.on('error', reject);
        req.end();
    });
}

// Read from the deployed static file on every refresh: it is a few hundred
// bytes, and re-reading keeps the list in lockstep with what the browser sees.
function readChangelogSources(config) {
    const file = path.join(config.publicDir, CHANGELOG_SOURCES_FILE);
    return fs.promises.readFile(file, 'utf-8').then((raw) => {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error(`${CHANGELOG_SOURCES_FILE} is not an array`);
        const sources = parsed.filter(
            (s) => s && typeof s.repo === 'string' && REPO_PATTERN.test(s.repo)
        );
        if (sources.length === 0) throw new Error(`${CHANGELOG_SOURCES_FILE} lists no usable repos`);
        return sources;
    });
}

// Exactly the shape the frontend renders — mirrors fetchRepoCommits in main.ts.
function toChangelogEntry(commit, tool) {
    const message = (commit && commit.commit && commit.commit.message) || '';
    const lines = message.split('\n');
    const committer = (commit && commit.commit && commit.commit.committer) || {};
    const author = (commit && commit.commit && commit.commit.author) || {};
    const iso = committer.date || author.date || '';
    return {
        sha: ((commit && commit.sha) || '').substring(0, 7),
        date: iso.substring(0, 10),
        iso,
        title: lines[0] || '',
        description: lines.slice(1).join('\n').replace(/^\n+/, '').trim(),
        author: author.name || '',
        tool: (tool || '').toString(),
    };
}

async function fetchRepoCommits(config, source, branch) {
    const url =
        `${config.githubApiOrigin.replace(/\/+$/, '')}/repos/${source.repo}/commits` +
        `?sha=${encodeURIComponent(branch)}&per_page=${CHANGELOG_PER_PAGE}`;
    const commits = await fetchJson(url, {
        accept: 'application/vnd.github+json',
        'user-agent': CHANGELOG_USER_AGENT,
    });
    // Rate-limit and error payloads are objects ({message, ...}), not arrays.
    if (!Array.isArray(commits)) throw new Error(`Unexpected GitHub payload for ${source.repo}`);
    return commits.filter((c) => !isHiddenFromChangelog(c)).map((c) => toChangelogEntry(c, source.tool));
}

// All-or-nothing: one failing repo fails the whole refresh, so a partial feed
// (a tool silently missing) can never reach the cache.
async function fetchChangelog(config, branch) {
    const sources = await readChangelogSources(config);
    const perRepo = await Promise.all(sources.map((s) => fetchRepoCommits(config, s, branch)));
    const merged = perRepo.flat();
    merged.sort((a, b) => {
        const byIso = (b.iso || '').localeCompare(a.iso || ''); // newest first
        if (byIso !== 0) return byIso;
        const byTool = a.tool.localeCompare(b.tool); // deterministic same-timestamp tiebreak
        return byTool !== 0 ? byTool : a.sha.localeCompare(b.sha);
    });
    return merged.slice(0, CHANGELOG_MAX_ENTRIES);
}

// Per-server state: one cache entry and at most one in-flight refresh per branch.
function createChangelogState() {
    return { cache: new Map(), inFlight: new Map() };
}

function refreshChangelog(config, state, branch) {
    const existing = state.inFlight.get(branch);
    if (existing) return existing; // concurrent requests share one upstream round-trip

    const pending = fetchChangelog(config, branch)
        .then((entries) => {
            state.cache.set(branch, { entries, ts: Date.now() });
            return entries;
        })
        .finally(() => {
            state.inFlight.delete(branch);
        });

    state.inFlight.set(branch, pending);
    return pending;
}

// GET /changelog-live?branch=main|test — merged commit feed for the home page.
// Both values get the `main` feed (one cache entry, never `sha=test` upstream).
// Sits behind Easy Auth like every other route; nothing here assumes anonymity.
async function handleChangelog(res, config, state, search) {
    const requested = new URLSearchParams(search).get('branch') || '';

    if (!CHANGELOG_BRANCHES.includes(requested)) {
        sendJson(res, 400, {
            error: 'invalid_branch',
            message: `branch must be one of: ${CHANGELOG_BRANCHES.join(', ')}.`,
        });
        return;
    }
    const branch = CHANGELOG_FEED_BRANCH;

    const cached = state.cache.get(branch);
    if (cached && Date.now() - cached.ts < config.changelogTtlMs) {
        sendJson(res, 200, cached.entries);
        return;
    }

    try {
        sendJson(res, 200, await refreshChangelog(config, state, branch));
    } catch (e) {
        console.error(`Changelog refresh failed (${branch}):`, e.message);
        // Stale beats the days-old build-time snapshot the browser would use next.
        if (cached) {
            sendJson(res, 200, cached.entries);
            return;
        }
        sendJson(res, 502, {
            error: 'changelog_upstream_failed',
            message: 'Could not reach the GitHub commit API.',
        });
    }
}

// ── Admin diagnostics ────────────────────────────────────────────────────────
// GET /admin/api/diagnostics: what the router itself knows — build, uptime,
// changelog cache, which backends are configured, and a health ping of each.
// Configuration is reported as booleans only: no URL or secret ever leaves.

const HEALTH_PATH = '/api/health';

// {"commit": …} from the deploy package, or null when absent/unreadable.
function readBuildInfo(file) {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const commit = parsed && typeof parsed.commit === 'string' ? parsed.commit.trim() : '';
        return { commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null };
    } catch (_e) {
        return { commit: null };
    }
}

// A base URL gets /api/health appended; one that already names a path is used as is.
function healthUrlFor(base) {
    const url = new URL(base);
    if (url.pathname === '' || url.pathname === '/') url.pathname = HEALTH_PATH;
    else if (!/\/api\/health\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/+$/, '') + HEALTH_PATH;
    return url;
}

// One capped GET. Never rejects: every outcome is a status for the table.
function pingHealth(name, base, secret, timeoutMs) {
    if (!base) return Promise.resolve({ name, status: 'not_configured', httpStatus: null, latencyMs: null });
    let target;
    try {
        target = healthUrlFor(base);
    } catch (_e) {
        return Promise.resolve({ name, status: 'error', httpStatus: null, latencyMs: null });
    }

    return new Promise((resolve) => {
        const started = Date.now();
        let settled = false;
        const finish = (status, httpStatus) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ name, status, httpStatus, latencyMs: httpStatus === null ? null : Date.now() - started });
        };

        const secure = target.protocol === 'https:';
        const headers = { accept: 'application/json', 'user-agent': CHANGELOG_USER_AGENT };
        if (secret) headers['x-proxy-secret'] = secret;
        const req = (secure ? https : http).request(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (secure ? 443 : 80),
                path: target.pathname + (target.search || ''),
                method: 'GET',
                headers,
            },
            (upstream) => {
                upstream.resume(); // drain; only the status matters
                const code = upstream.statusCode;
                if (code >= 200 && code < 300) finish('ok', code);
                else if (code === 404) finish('no_health_route', code);
                else finish('error', code);
            }
        );
        const timer = setTimeout(() => {
            finish('timeout', null);
            req.destroy();
        }, timeoutMs);
        req.on('error', () => finish('error', null));
        req.end();
    });
}

function changelogDiagnostics(config, state) {
    const now = Date.now();
    return {
        entries: [...state.cache.entries()].map(([branch, entry]) => ({
            branch,
            ageSeconds: Math.round((now - entry.ts) / 1000),
            stale: now - entry.ts >= config.changelogTtlMs,
        })),
    };
}

// Backends in display order; HOVTP is not a proxy target, so it has no secret
// here (its /api/health is never gated).
const DIAGNOSTIC_BACKENDS = [PLATFORM, ...TOOLS, ...Object.keys(SMALL_TOOL_APIS)];

async function handleDiagnostics(res, config, runtime) {
    const targets = {};
    for (const tool of PROXY_TARGETS) {
        targets[tool] = { url: Boolean(config.targets[tool].url), secret: Boolean(config.targets[tool].secret) };
    }
    const backends = await Promise.all([
        ...DIAGNOSTIC_BACKENDS.map((tool) =>
            pingHealth(tool, config.targets[tool].url, config.targets[tool].secret, config.healthTimeoutMs)
        ),
        pingHealth('hovtp', config.hovtpHealthUrl, '', config.healthTimeoutMs),
    ]);
    sendJson(res, 200, {
        router: {
            commit: runtime.buildInfo.commit,
            startedUtc: new Date(runtime.startedMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            uptimeSeconds: Math.round((Date.now() - runtime.startedMs) / 1000),
            node: process.version,
            nodeEnv: config.nodeEnv,
            changelog: changelogDiagnostics(config, runtime.changelogState),
        },
        config: {
            targets,
            hovtpHealthUrl: Boolean(config.hovtpHealthUrl),
            adminRole: config.adminRole,
            allowedTenantCount: config.allowedTenantIds.size,
            loginProvider: config.loginProvider,
            authTenantMode: config.authTenantMode || 'workforce',
            externalTenantCount: config.externalTenantIds ? config.externalTenantIds.size : 0,
            devFakeUser: Boolean(config.devFakeUser),
        },
        backends,
    });
}

// ── Static files ─────────────────────────────────────────────────────────────
// Vite emits content-hashed filenames under /assets/, so those can be cached
// forever, and so can the self-hosted /fonts/*.woff2 files, whose names carry
// a version suffix (site/public/fonts/fonts.css); HTML/JSON/CSS must always be
// revalidated or a browser keeps serving a stale page referencing bundles
// that no longer exist.
function cacheControlFor(urlPath) {
    return /(^|\/)assets\//.test(urlPath) || /^\/fonts\/[^/]+\.woff2$/.test(urlPath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
}

function sendFile(res, filePath, urlPath, status = 200, extraHeaders = {}) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(status, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': cacheControlFor(urlPath),
        ...extraHeaders,
    });
    fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
}

// The SPA fallback is per prefix: an unmatched /judgepapers/* route must load
// that app's document, not the landing page (likewise /admin/*).
function documentPrefixFor(pathname) {
    const segment = pathname.split('/')[1] || '';
    return DOCUMENT_PREFIXES.includes(segment) ? segment : '';
}

function fallbackIndexFor(config, pathname) {
    const prefix = documentPrefixFor(pathname);
    return prefix
        ? path.join(config.publicDir, prefix, 'index.html')
        : path.join(config.publicDir, 'index.html');
}

function serveStatic(req, res, config, pathname, search = '') {
    let urlPath;
    try {
        urlPath = decodeURIComponent(pathname);
    } catch (_e) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
    }

    if (urlPath.includes('\0')) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
    }

    const relative = urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath;
    const filePath = path.resolve(path.join(config.publicDir, relative));

    // Path traversal guard: everything served must live under publicDir.
    if (filePath !== config.publicDir && !filePath.startsWith(config.publicDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
            // Real file wins — this is what keeps root statics (/assets/*,
            // /logo.png, /changelog.json) ahead of any SPA fallback.
            sendFile(res, filePath, urlPath);
            return;
        }

        if (!err && stats.isDirectory()) {
            // /judgepapers → /judgepapers/ so relative asset URLs resolve.
            res.writeHead(301, { Location: pathname + '/' + search, 'Cache-Control': 'no-cache' });
            res.end();
            return;
        }

        // Only route-like requests fall back to a document; a missing bundle or
        // image must 404 rather than return HTML with a JS content type.
        const ext = path.extname(filePath).toLowerCase();
        if (ext && ext !== '.html') {
            notFound(res);
            return;
        }

        const indexPath = fallbackIndexFor(config, urlPath);
        fs.stat(indexPath, (err2, indexStats) => {
            if (err2 || !indexStats.isFile()) {
                notFound(res);
                return;
            }
            sendFile(res, indexPath, '/index.html');
        });
    });
}

// / for a visitor without a session → the public landing page. The answer
// depends on the session, so shared caches must not hand one to the other.
function serveRootDocument(req, res, config, pathname, search = '') {
    res.setHeader('Vary', 'Cookie');
    if (hasSignedInSession(req, config)) {
        serveStatic(req, res, config, pathname, search);
        return;
    }
    const landingPath = path.join(config.publicDir, LANDING_DIR, 'index.html');
    fs.stat(landingPath, (err, stats) => {
        if (err || !stats.isFile()) {
            // No landing page in this build: the home page's own sign-in view.
            serveStatic(req, res, config, pathname, search);
            return;
        }
        sendFile(res, landingPath, '/landing/index.html');
    });
}

// ── Router ───────────────────────────────────────────────────────────────────
function createRequestHandler(config) {
    const changelogState = createChangelogState();
    // Read once: the deploy package never changes under a running process.
    const runtime = { changelogState, startedMs: Date.now(), buildInfo: readBuildInfo(config.buildInfoPath) };

    return function handleRequest(req, res) {
        const url = req.url || '/';
        const queryIndex = url.indexOf('?');
        const rawPath = queryIndex === -1 ? url : url.slice(0, queryIndex);
        const search = queryIndex === -1 ? '' : url.slice(queryIndex);

        // 0. Paths with two readings are refused before any routing, then
        //    every route below sees only the canonical (decoded, normalised)
        //    form, and the proxy and the static server get exactly that form
        //    re-encoded — never the raw path the browser sent.
        if (isUnsafePath(rawPath)) {
            applySecurityHeaders(res, '/');
            res.writeHead(400, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
                Connection: 'close',
            });
            res.end('Bad Request');
            return;
        }
        const pathname = canonicalPath(rawPath);
        const wirePath = encodePath(pathname);

        applySecurityHeaders(res, pathname);

        // 1. Health probe — deliberately assumes nothing about auth; Easy Auth
        //    lists it in globalValidation.excludedPaths.
        if (pathname === '/health') {
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        // 2. Signed-in user.
        if (pathname === '/userinfo') {
            handleUserInfo(req, res, config);
            return;
        }

        // 3. Cached GitHub commit feed for the "What's New" panel.
        if (pathname === '/changelog-live') {
            handleChangelog(res, config, changelogState, search).catch((e) => {
                console.error('Changelog handler error:', e.message);
                if (!res.headersSent) {
                    sendJson(res, 500, { error: 'changelog_failed', message: 'Internal Server Error' });
                }
            });
            return;
        }

        // 4. Easy Auth owns /.auth/* at the platform level; if anything reaches
        //    Node it must not be swallowed by the SPA fallback.
        if (isUnder(pathname, '/.auth')) {
            notFound(res);
            return;
        }

        // 4b. The judges'-papers link e-mailed to a recipient who has no
        //     account (?t=<token>). Easy Auth excludes this exact path; the
        //     backend checks the token and 302s to a short-lived blob URL.
        if (pathname === JUDGEPAPERS_DOWNLOAD_PATH) {
            if (!isSafeMethod(req.method)) {
                res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
                res.end();
                return;
            }
            proxy(req, res, config, 'judgepapers', '/api/download_judge_papers' + search, null);
            return;
        }

        // 4c. Sign-in entry point used by every "Sign in" link.
        if (pathname === SIGNIN_PATH) {
            handleSignIn(req, res, config, search);
            return;
        }

        // A signed-in External ID user without the access role: documents
        // send them to the public no-access page; /admin/* and every API
        // below answer 403 access_not_granted (never proxied). The public
        // paths (the no-access page itself, privacy notice, assets) stay open.
        const noAccess = !isPublicPath(pathname) && accessDenied(req, config);
        const lowerPath = pathname.toLowerCase();
        const isApiPath =
            isUnder(lowerPath, '/api') ||
            isUnder(lowerPath, '/' + ADMIN_PREFIX) ||
            /^\/[^/]+\/api(?:\/|$)/.test(pathname) ||
            Object.values(SMALL_TOOL_APIS).some((prefix) => isUnder(pathname, prefix + '/api'));
        if (noAccess) {
            if (isApiPath) {
                sendAccessNotGranted(res);
            } else {
                res.writeHead(302, { Location: NO_ACCESS_PATH, 'Cache-Control': 'no-store' });
                res.end();
            }
            return;
        }

        // 4d. The root document: home page or public landing page.
        if (LANDING_DOCUMENT_PATHS.includes(pathname)) {
            serveRootDocument(req, res, config, wirePath, search);
            return;
        }

        // 4e. Admin panel. /admin/api/* is router-native JSON; the documents are
        //     a plain 404 for everyone but admins, so the page does not even
        //     advertise itself (its bundle under /assets/* is public anyway —
        //     the real gates are this check and the platform's own).
        if (isUnder(pathname, '/' + ADMIN_PREFIX)) {
            const admin = isAdminRequest(req, config);
            if (isUnder(pathname, '/' + ADMIN_PREFIX + '/api')) {
                if (pathname !== ADMIN_DIAGNOSTICS_PATH) {
                    sendJson(res, 404, { error: 'not_found' });
                } else if (!admin) {
                    sendJson(res, 403, { error: 'admin_required' });
                } else if (!isSafeMethod(req.method)) {
                    res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
                    res.end();
                } else {
                    handleDiagnostics(res, config, runtime).catch((e) => {
                        console.error('Diagnostics handler error:', e.message);
                        if (!res.headersSent) sendJson(res, 500, { error: 'diagnostics_failed' });
                    });
                }
                return;
            }
            if (!admin) {
                notFound(res);
                return;
            }
            // Same URL, different answer per user: shared caches must not mix them.
            res.setHeader('Vary', 'Cookie');
            serveStatic(req, res, config, wirePath, search);
            return;
        }

        // Every proxied API call: a state change must be same-origin (CSRF),
        // refused before anything is proxied; then the identity gate.
        const proxyApi = (tool, targetPath) => {
            if (!isSafeMethod(req.method) && !isSameOriginRequest(req)) {
                // The body is never read: close the connection rather than
                // leave the client's keep-alive socket half-consumed.
                res.setHeader('Connection', 'close');
                sendJson(res, 403, { error: 'cross_site', message: 'Cross-site requests are not allowed.' });
                return;
            }
            const identity = requireIdentity(req, res, config);
            if (identity) proxy(req, res, config, tool, targetPath + search, identity);
        };

        // 5. /<tool>/api/* → that tool's Function App, /<tool> stripped so the
        //    backends keep their default /api route prefix.
        const toolApi = /^\/([^/]+)(\/api(?:\/.*)?)$/.exec(pathname);
        if (toolApi && TOOLS.includes(toolApi[1])) {
            proxyApi(toolApi[1], wirePath.slice(toolApi[1].length + 1));
            return;
        }

        // 5b. /tools/<name>/api/* → that small tool's Function App, its
        //     /tools/<name> prefix stripped.
        for (const [tool, prefix] of Object.entries(SMALL_TOOL_APIS)) {
            if (isUnder(pathname, prefix + '/api')) {
                proxyApi(tool, wirePath.slice(prefix.length));
                return;
            }
        }

        // 6. /api/* → platform Function App (competitions registry).
        //    /api/manage/* is admin-only: refused here without proxying. The
        //    match is case-insensitive like the Functions host's routing.
        if (isUnder(pathname.toLowerCase(), MANAGE_API_PREFIX)) {
            if (!isAdminRequest(req, config)) {
                sendJson(res, 403, { error: 'admin_required', message: 'This action needs an administrator.' });
                return;
            }
            proxyApi(PLATFORM, wirePath);
            return;
        }
        if (isUnder(pathname, '/api')) {
            proxyApi(PLATFORM, wirePath);
            return;
        }

        // 7. /<tool> → /<tool>/ (guaranteed even before the dist exists).
        if (TOOLS.includes(pathname.slice(1))) {
            res.writeHead(301, { Location: wirePath + '/' + search, 'Cache-Control': 'no-cache' });
            res.end();
            return;
        }

        // 8. Static files + per-prefix SPA fallback.
        serveStatic(req, res, config, wirePath, search);
    };
}

function createServer(config = loadConfig()) {
    const server = http.createServer(createRequestHandler(config));
    server.config = config;
    return server;
}

if (require.main === module) {
    const config = loadConfig();
    const server = createServer(config);
    server.listen(config.port, () => {
        const configured = PROXY_TARGETS.filter((t) => config.targets[t].url);
        console.log(`Router listening on port ${config.port}`);
        console.log(`Static root: ${config.publicDir}`);
        console.log(`Proxy targets configured: ${configured.join(', ') || '(none)'}`);
        if (config.devFakeUser) console.log(`DEV_FAKE_USER active: ${config.devFakeUser}`);
        console.log(`Admin role: ${config.adminRole}`);
        if (config.devFakeRoles.length) console.log(`DEV_FAKE_ROLES active: ${config.devFakeRoles.join(', ')}`);
        if (config.allowedTenantIds.size === 0) {
            console.warn('ALLOWED_TENANT_IDS is empty: every signed-in API call is refused (403 tenant_not_allowed).');
        }
    });
}

module.exports = {
    TOOLS,
    DOCUMENT_PREFIXES,
    PLATFORM,
    SMALL_TOOL_APIS,
    loadConfig,
    isAdminRequest,
    requestIdentity,
    devObjectId,
    DEV_TENANT_ID,
    createServer,
    createRequestHandler,
    buildCsp,
    cacheControlFor,
    safeReturnPath,
    isHiddenFromChangelog,
    urlEnvVar,
    secretEnvVar,
    CHANGELOG_BRANCHES,
    CHANGELOG_MAX_ENTRIES,
};
