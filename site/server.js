// Zero-dependency Node.js server for Azure App Service
// Serves static files with SPA fallback, provides /userinfo for Easy Auth
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
};

// ── /userinfo endpoint ──
// Reads X-MS-CLIENT-PRINCIPAL header set by Easy Auth (no tokens exposed)
function handleUserInfo(req, res) {
    const principal = req.headers['x-ms-client-principal'];
    const principalName = req.headers['x-ms-client-principal-name'];

    if (!principal && !principalName) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authenticated: false }));
        return;
    }

    let userInfo = { authenticated: true, userDetails: principalName || 'unknown' };

    if (principal) {
        try {
            const decoded = Buffer.from(principal, 'base64').toString('utf-8');
            const parsed = JSON.parse(decoded);

            let displayName = parsed.userDetails || '';
            const claims = parsed.claims || [];
            if (Array.isArray(claims)) {
                const nameClaim = claims.find(c =>
                    c.typ === 'name' ||
                    c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'
                );
                const emailClaim = claims.find(c =>
                    c.typ === 'preferred_username' ||
                    c.typ === 'email' ||
                    c.typ === 'emails' ||
                    c.typ === 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'
                );
                displayName = (emailClaim && emailClaim.val) ||
                              (nameClaim && nameClaim.val) ||
                              parsed.userDetails ||
                              principalName ||
                              'unknown';
            }

            userInfo = {
                authenticated: true,
                userId: parsed.userId,
                identityProvider: parsed.identityProvider,
                userDetails: displayName || principalName || 'unknown',
                userRoles: parsed.userRoles || [],
            };
        } catch (e) {
            // parsing failed, use principalName fallback
        }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(userInfo));
}

// ── Static file serving with SPA fallback ──
function serveStatic(req, res) {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

    // Security: prevent path traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
            const ext = path.extname(filePath);
            const mime = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            fs.createReadStream(filePath).pipe(res);
        } else {
            // SPA fallback: serve index.html for any unmatched route
            const indexPath = path.join(PUBLIC_DIR, 'index.html');
            fs.stat(indexPath, (err2) => {
                if (err2) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                fs.createReadStream(indexPath).pipe(res);
            });
        }
    });
}

// ── Security Headers ──
const SECURITY_HEADERS = {
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

// ── Request router ──
const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];

    // Apply security headers to all responses
    for (const [key, val] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(key, val);
    }

    if (pathname === '/userinfo') {
        handleUserInfo(req, res);
    } else {
        serveStatic(req, res);
    }
});

server.listen(PORT, () => {
    console.log(`Figure Skating Tools site listening on port ${PORT}`);
});
