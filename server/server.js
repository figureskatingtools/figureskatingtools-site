// Zero-dependency router/server for figureskatingtools.com on Azure App Service.
//
// One Web App fronts the whole domain:
//   /                        → landing page (SPA)
//   /judgepapers/            → Judge Papers app        (SPA, own index.html)
//   /scoremodifier/          → Score Modifier app      (SPA, own index.html)
//   /protocolgenerator/      → Protocol Generator app  (SPA, own index.html)
//   /health                  → liveness probe (excluded from Easy Auth)
//   /userinfo                → flat user object decoded from Easy Auth headers
//   /api/*                   → platform Function App
//   /<tool>/api/*            → that tool's Function App, with /<tool> stripped
//
// Node 22 built-ins only — no npm dependencies. Bodies are never buffered:
// requests and responses are piped straight through so 100 MiB uploads and
// binary downloads stream in constant memory.
//
// See server/README.md for the env-var contract and local dev usage.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Tools ────────────────────────────────────────────────────────────────────
// Order matters only for readability; lookups are by exact first path segment.
const TOOLS = ['judgepapers', 'scoremodifier', 'protocolgenerator'];
const PLATFORM = 'platform';

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

function loadConfig(env = process.env) {
    const targets = {};
    for (const tool of [...TOOLS, PLATFORM]) {
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
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'img-src': ["'self'", 'data:', 'blob:'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
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
const EMAIL_CLAIMS = [
    'preferred_username',
    'email',
    'emails',
    'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
];

// GET /userinfo — flat, token-free view of the signed-in user for the frontends.
function handleUserInfo(req, res, config) {
    const principalName = req.headers['x-ms-client-principal-name'];
    const parsed = decodePrincipal(req);
    const json = (body) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };

    if (!parsed && !principalName) {
        if (config.devFakeUser) {
            json({
                authenticated: true,
                userId: 'dev-user',
                identityProvider: 'dev',
                userDetails: config.devFakeUser,
                userRoles: ['authenticated'],
            });
            return;
        }
        json({ authenticated: false });
        return;
    }

    if (!parsed) {
        json({ authenticated: true, userDetails: principalName || 'unknown' });
        return;
    }

    // Prefer email, then name, then userDetails, then the principal-name header.
    const displayName =
        findClaim(parsed, EMAIL_CLAIMS) ||
        findClaim(parsed, NAME_CLAIMS) ||
        parsed.userDetails ||
        principalName ||
        'unknown';

    json({
        authenticated: true,
        userId: parsed.userId,
        identityProvider: parsed.identityProvider,
        userDetails: displayName,
        userRoles: parsed.userRoles || [],
    });
}

// Email forwarded to the Function Apps. Keeps the existing contract: the
// principal's userDetails wins, exactly as the per-tool proxies did.
function forwardedUserEmail(req, config) {
    const parsed = decodePrincipal(req);
    const fromPrincipal =
        (parsed && (parsed.userDetails || findClaim(parsed, EMAIL_CLAIMS))) || '';
    return fromPrincipal || req.headers['x-ms-client-principal-name'] || config.devFakeUser || '';
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

// Streams req → upstream → res. Nothing is buffered in between.
function proxy(req, res, config, tool, targetPath) {
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

    const email = forwardedUserEmail(req, config);
    if (email) outHeaders['x-forwarded-user-email'] = email;

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

// ── Static files ─────────────────────────────────────────────────────────────
// Vite emits content-hashed filenames under /assets/, so those can be cached
// forever; HTML/JSON must always be revalidated or a browser keeps serving a
// stale page referencing bundles that no longer exist.
function cacheControlFor(urlPath) {
    return /(^|\/)assets\//.test(urlPath)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
}

function sendFile(res, filePath, urlPath, status = 200) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(status, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': cacheControlFor(urlPath),
    });
    fs.createReadStream(filePath).pipe(res);
}

function notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('Not Found');
}

// The SPA fallback is per prefix: an unmatched /judgepapers/* route must load
// that app's document, not the landing page.
function fallbackIndexFor(config, pathname) {
    const prefix = prefixFor(pathname);
    return prefix
        ? path.join(config.publicDir, prefix, 'index.html')
        : path.join(config.publicDir, 'index.html');
}

function serveStatic(req, res, config, pathname) {
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
            const search = req.url.slice(pathname.length);
            res.writeHead(301, { Location: urlPath + '/' + search, 'Cache-Control': 'no-cache' });
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

// ── Router ───────────────────────────────────────────────────────────────────
function createRequestHandler(config) {
    return function handleRequest(req, res) {
        const url = req.url || '/';
        const queryIndex = url.indexOf('?');
        const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
        const search = queryIndex === -1 ? '' : url.slice(queryIndex);

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

        // 3. Easy Auth owns /.auth/* at the platform level; if anything reaches
        //    Node it must not be swallowed by the SPA fallback.
        if (pathname === '/.auth' || pathname.startsWith('/.auth/')) {
            notFound(res);
            return;
        }

        // 4. /<tool>/api/* → that tool's Function App, /<tool> stripped so the
        //    backends keep their default /api route prefix.
        const toolApi = /^\/([^/]+)(\/api(?:\/.*)?)$/.exec(pathname);
        if (toolApi && TOOLS.includes(toolApi[1])) {
            proxy(req, res, config, toolApi[1], toolApi[2] + search);
            return;
        }

        // 5. /api/* → platform Function App (competitions registry).
        if (pathname === '/api' || pathname.startsWith('/api/')) {
            proxy(req, res, config, PLATFORM, pathname + search);
            return;
        }

        // 6. /<tool> → /<tool>/ (guaranteed even before the dist exists).
        if (TOOLS.includes(pathname.slice(1))) {
            res.writeHead(301, { Location: pathname + '/' + search, 'Cache-Control': 'no-cache' });
            res.end();
            return;
        }

        // 7. Static files + per-prefix SPA fallback.
        serveStatic(req, res, config, pathname);
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
        const configured = [...TOOLS, PLATFORM].filter((t) => config.targets[t].url);
        console.log(`Router listening on port ${config.port}`);
        console.log(`Static root: ${config.publicDir}`);
        console.log(`Proxy targets configured: ${configured.join(', ') || '(none)'}`);
        if (config.devFakeUser) console.log(`DEV_FAKE_USER active: ${config.devFakeUser}`);
    });
}

module.exports = {
    TOOLS,
    PLATFORM,
    loadConfig,
    createServer,
    createRequestHandler,
    buildCsp,
    cacheControlFor,
    urlEnvVar,
    secretEnvVar,
};
