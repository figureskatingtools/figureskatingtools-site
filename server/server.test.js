// Tests for the router server. Run with: node --test server/*.test.js
// Zero dependencies — node:test, node:assert and the built-in http client only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    createServer,
    loadConfig,
    isAdminRequest,
    buildCsp,
    safeReturnPath,
    isHiddenFromChangelog,
    CHANGELOG_MAX_ENTRIES,
} = require('./server.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

// Minimal HTTP client: returns status, headers and the body as a Buffer.
function request(port, urlPath, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                    get text() {
                        return Buffer.concat(chunks).toString('utf-8');
                    },
                })
            );
        });
        req.on('error', reject);
        if (body && typeof body.pipe === 'function') body.pipe(req);
        else req.end(body);
    });
}

function json(res) {
    return JSON.parse(res.body.toString('utf-8'));
}

function principalHeader(obj) {
    return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

const PRINCIPAL = {
    userId: 'abc123',
    identityProvider: 'aad',
    userDetails: 'skater@example.com',
    userRoles: ['authenticated'],
    claims: [
        { typ: 'name', val: 'Skater Person' },
        { typ: 'preferred_username', val: 'skater@example.com' },
    ],
};

// Fixture public/ tree mirroring the single Vite dist layout.
function makePublicFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fst-public-'));
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.mkdirSync(path.join(dir, 'judgepapers'));
    fs.mkdirSync(path.join(dir, 'scoremodifier'));
    fs.mkdirSync(path.join(dir, 'protocolgenerator'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<html>ROOT_INDEX</html>');
    fs.writeFileSync(path.join(dir, 'judgepapers', 'index.html'), '<html>JUDGEPAPERS_INDEX</html>');
    fs.writeFileSync(path.join(dir, 'scoremodifier', 'index.html'), '<html>SCOREMODIFIER_INDEX</html>');
    fs.writeFileSync(path.join(dir, 'protocolgenerator', 'index.html'), '<html>PROTOCOLGENERATOR_INDEX</html>');
    fs.writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("bundle")');
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'changelog.json'), '[{"sha":"deadbee"}]');
    return dir;
}

// Upstream stand-in for a Function App. Records what it received.
async function startUpstream(handler) {
    const received = [];
    const server = http.createServer((req, res) => {
        const record = { method: req.method, url: req.url, headers: req.headers };
        received.push(record);
        handler(req, res, record);
    });
    const port = await listen(server);
    return { server, port, received, url: `http://127.0.0.1:${port}` };
}

async function startRouter(overrides = {}) {
    const config = { ...loadConfig({}), ...overrides };
    const server = createServer(config);
    const port = await listen(server);
    return { server, port, config };
}

function targets(map) {
    const base = loadConfig({}).targets;
    for (const [tool, value] of Object.entries(map)) {
        base[tool] = { ...base[tool], ...value };
    }
    return base;
}

// ── /health ──────────────────────────────────────────────────────────────────

test('GET /health returns 200 {"ok":true} with no auth headers and no config', async () => {
    const { server, port } = await startRouter();
    try {
        const res = await request(port, '/health');
        assert.equal(res.status, 200);
        assert.deepEqual(json(res), { ok: true });
        assert.match(res.headers['content-type'], /application\/json/);
        // Security headers apply to every response, including the probe.
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.match(res.headers['strict-transport-security'], /max-age=31536000/);
    } finally {
        await close(server);
    }
});

// ── /userinfo ────────────────────────────────────────────────────────────────

test('GET /userinfo without Easy Auth headers reports unauthenticated', async () => {
    const { server, port } = await startRouter();
    try {
        const res = await request(port, '/userinfo');
        assert.equal(res.status, 200);
        assert.deepEqual(json(res), { authenticated: false });
    } finally {
        await close(server);
    }
});

test('GET /userinfo decodes a base64 X-MS-CLIENT-PRINCIPAL', async () => {
    const { server, port } = await startRouter();
    try {
        const res = await request(port, '/userinfo', {
            headers: { 'x-ms-client-principal': principalHeader(PRINCIPAL) },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(json(res), {
            authenticated: true,
            userId: 'abc123',
            identityProvider: 'aad',
            userDetails: 'skater@example.com',
            name: 'Skater Person',
            userRoles: ['authenticated'],
            isAdmin: false,
        });
    } finally {
        await close(server);
    }
});

test('GET /userinfo falls back to the principal-name header and survives garbage principals', async () => {
    const { server, port } = await startRouter();
    try {
        const res = await request(port, '/userinfo', {
            headers: {
                'x-ms-client-principal': 'not-base64-json!!',
                'x-ms-client-principal-name': 'fallback@example.com',
            },
        });
        assert.equal(res.status, 200);
        assert.deepEqual(json(res), { authenticated: true, userDetails: 'fallback@example.com', isAdmin: false });
    } finally {
        await close(server);
    }
});

test('GET /userinfo honours DEV_FAKE_USER when Easy Auth headers are absent', async () => {
    const { server, port } = await startRouter({ devFakeUser: 'dev@example.com' });
    try {
        const res = await request(port, '/userinfo');
        assert.equal(json(res).authenticated, true);
        assert.equal(json(res).userDetails, 'dev@example.com');
    } finally {
        await close(server);
    }
});

test('DEV_FAKE_USER is ignored when NODE_ENV=production', () => {
    assert.equal(loadConfig({ NODE_ENV: 'production', DEV_FAKE_USER: 'dev@example.com' }).devFakeUser, '');
    assert.equal(loadConfig({ DEV_FAKE_USER: 'dev@example.com' }).devFakeUser, 'dev@example.com');
});

// ── /judgepapers/download (public e-mailed link) ──────────────────────────────

test('GET /judgepapers/download proxies to download_judge_papers and passes the 302 through', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(302, { Location: 'https://acct.blob.core.windows.net/c/f.pdf?sig=x', 'Cache-Control': 'no-store' });
        res.end();
    });
    const { server, port } = await startRouter({
        targets: targets({ judgepapers: { url: upstream.url, secret: 'jp-secret' } }),
    });
    try {
        const res = await request(port, '/judgepapers/download?t=abc_DEF-123');
        assert.equal(res.status, 302);
        assert.equal(res.headers['location'], 'https://acct.blob.core.windows.net/c/f.pdf?sig=x');
        const seen = upstream.received[0];
        assert.equal(seen.url, '/api/download_judge_papers?t=abc_DEF-123');
        assert.equal(seen.method, 'GET');
        assert.equal(seen.headers['x-proxy-secret'], 'jp-secret');

        const head = await request(port, '/judgepapers/download?t=abc', { method: 'HEAD' });
        assert.equal(head.status, 302);
        assert.equal(upstream.received[1].method, 'HEAD');
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('/judgepapers/download rejects other methods without calling the backend', async () => {
    const upstream = await startUpstream((req, res) => res.end());
    const { server, port } = await startRouter({
        targets: targets({ judgepapers: { url: upstream.url, secret: 'jp-secret' } }),
    });
    try {
        const res = await request(port, '/judgepapers/download?t=abc', { method: 'POST', body: 'x' });
        assert.equal(res.status, 405);
        assert.equal(res.headers['allow'], 'GET, HEAD');
        assert.equal(upstream.received.length, 0);
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

// ── Proxy: prefix strip + header injection ───────────────────────────────────

test('/<tool>/api/* strips the prefix and injects proxy secret + user email', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ seen: req.url }));
    });
    const { server, port } = await startRouter({
        targets: targets({
            judgepapers: { url: upstream.url, secret: 'jp-secret' },
        }),
    });
    try {
        const res = await request(port, '/judgepapers/api/upload_file?competition=1a2b3c4d', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'x-ms-client-principal': principalHeader(PRINCIPAL),
            },
            body: JSON.stringify({ hello: 'world' }),
        });

        assert.equal(res.status, 200);
        const seen = upstream.received[0];
        // The /judgepapers prefix is stripped; query string preserved.
        assert.equal(seen.url, '/api/upload_file?competition=1a2b3c4d');
        assert.equal(seen.method, 'POST');
        assert.equal(seen.headers['x-proxy-secret'], 'jp-secret');
        assert.equal(seen.headers['x-forwarded-user-email'], 'skater@example.com');
        assert.equal(seen.headers['content-type'], 'application/json');
        assert.equal(seen.headers['accept'], 'application/json');
        assert.equal(seen.headers['content-length'], String(Buffer.byteLength(JSON.stringify({ hello: 'world' }))));
        // The browser never sees the raw Easy Auth principal downstream.
        assert.equal(seen.headers['x-ms-client-principal'], undefined);
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('each tool gets its own secret and /api/* goes to the platform backend', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(204);
        res.end();
    });
    const { server, port } = await startRouter({
        targets: targets({
            judgepapers: { url: upstream.url, secret: 'jp-secret' },
            protocolgenerator: { url: upstream.url, secret: 'pg-secret' },
            platform: { url: upstream.url, secret: 'platform-secret' },
        }),
    });
    try {
        await request(port, '/judgepapers/api/list');
        await request(port, '/protocolgenerator/api/list');
        await request(port, '/api/competitions');

        assert.deepEqual(
            upstream.received.map((r) => [r.url, r.headers['x-proxy-secret']]),
            [
                ['/api/list', 'jp-secret'],
                ['/api/list', 'pg-secret'],
                ['/api/competitions', 'platform-secret'],
            ]
        );
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('POST /api/competitions/{id}/extend reaches the platform backend with its secret and the user', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"id":"x","deletionDate":"2026-12-19T00:00:00Z"}');
    });
    const { server, port } = await startRouter({
        targets: targets({ platform: { url: upstream.url, secret: 'platform-secret' } }),
    });
    try {
        const res = await request(port, '/api/competitions/x/extend', {
            method: 'POST',
            headers: { 'x-ms-client-principal': principalHeader(PRINCIPAL) },
        });

        assert.equal(res.status, 200);
        assert.equal(json(res).deletionDate, '2026-12-19T00:00:00Z');
        const seen = upstream.received[0];
        assert.equal(seen.url, '/api/competitions/x/extend');
        assert.equal(seen.method, 'POST');
        assert.equal(seen.headers['x-proxy-secret'], 'platform-secret');
        assert.equal(seen.headers['x-forwarded-user-email'], 'skater@example.com');
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('/tools/gdpr/api/* goes to the GDPR tool backend with its own secret and prefix stripped', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
    });
    const { server, port } = await startRouter({
        targets: targets({
            gdprtool: { url: upstream.url, secret: 'gdpr-secret' },
            platform: { url: upstream.url, secret: 'platform-secret' },
        }),
    });
    try {
        const res = await request(port, '/tools/gdpr/api/scan', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-ms-client-principal': principalHeader(PRINCIPAL),
            },
            body: JSON.stringify({ eventUrl: 'https://results.example.test/x/' }),
        });
        assert.equal(res.status, 200);
        const seen = upstream.received[0];
        assert.equal(seen.url, '/api/scan');
        assert.equal(seen.method, 'POST');
        assert.equal(seen.headers['x-proxy-secret'], 'gdpr-secret');
        assert.equal(seen.headers['x-forwarded-user-email'], 'skater@example.com');
        // The static page itself is not proxied.
        await request(port, '/tools/gdpr/');
        await request(port, '/tools/gdprx/api/scan');
        assert.equal(upstream.received.length, 1);
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('unconfigured GDPR tool backend returns 502 naming FUNCTION_APP_URL_GDPRTOOL', async () => {
    const { server, port } = await startRouter();
    try {
        const res = await request(port, '/tools/gdpr/api/scan', { method: 'POST' });
        assert.equal(res.status, 502);
        const body = json(res);
        assert.equal(body.tool, 'gdprtool');
        assert.match(body.message, /FUNCTION_APP_URL_GDPRTOOL/);
    } finally {
        await close(server);
    }
});

test('unconfigured tool backend returns 502 with a JSON error naming the env var', async () => {
    const { server, port } = await startRouter();
    try {
        const res = await request(port, '/scoremodifier/api/anything');
        assert.equal(res.status, 502);
        assert.match(res.headers['content-type'], /application\/json/);
        const body = json(res);
        assert.equal(body.error, 'proxy_target_not_configured');
        assert.equal(body.tool, 'scoremodifier');
        assert.match(body.message, /FUNCTION_APP_URL_SCOREMODIFIER/);
    } finally {
        await close(server);
    }
});

// ── Proxy: streaming ─────────────────────────────────────────────────────────

test('multi-MB request and response bodies stream through the proxy uncorrupted', async () => {
    const payload = crypto.randomBytes(6 * 1024 * 1024); // 6 MiB up
    const download = crypto.randomBytes(4 * 1024 * 1024); // 4 MiB down
    const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');

    const upstream = await startUpstream((req, res) => {
        const hash = crypto.createHash('sha256');
        req.on('data', (c) => hash.update(c));
        req.on('end', () => {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'X-Body-Sha256': hash.digest('hex'),
            });
            res.end(download);
        });
    });

    const { server, port } = await startRouter({
        targets: targets({ judgepapers: { url: upstream.url, secret: 's' } }),
    });

    try {
        const res = await request(port, '/judgepapers/api/upload_file', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) },
            body: payload,
        });

        assert.equal(res.status, 200);
        // Upload arrived byte-identical...
        assert.equal(res.headers['x-body-sha256'], payloadHash);
        // ...and so did the binary download.
        assert.equal(res.body.length, download.length);
        assert.equal(
            crypto.createHash('sha256').update(res.body).digest('hex'),
            crypto.createHash('sha256').update(download).digest('hex')
        );
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('upstream response headers are forwarded and hop-by-hop headers dropped', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(404, {
            'Content-Type': 'application/json',
            'X-Custom-Header': 'kept',
            Connection: 'close',
        });
        res.end('{"error":"not found"}');
    });
    const { server, port } = await startRouter({
        targets: targets({ platform: { url: upstream.url } }),
    });
    try {
        const res = await request(port, '/api/competitions/nope');
        assert.equal(res.status, 404);
        assert.equal(res.headers['x-custom-header'], 'kept');
        assert.equal(json(res).error, 'not found');
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

// ── Static serving, SPA fallback, redirects ──────────────────────────────────

test('static serving: root statics win, SPA fallback is per prefix', async () => {
    const publicDir = makePublicFixture();
    const { server, port } = await startRouter({ publicDir });
    try {
        // Root document.
        const root = await request(port, '/');
        assert.equal(root.status, 200);
        assert.match(root.text, /ROOT_INDEX/);
        assert.match(root.headers['content-type'], /text\/html/);
        assert.equal(root.headers['cache-control'], 'no-cache');

        // Per-prefix documents.
        assert.match((await request(port, '/judgepapers/')).text, /JUDGEPAPERS_INDEX/);
        assert.match((await request(port, '/scoremodifier/')).text, /SCOREMODIFIER_INDEX/);
        assert.match((await request(port, '/protocolgenerator/')).text, /PROTOCOLGENERATOR_INDEX/);

        // Deep links fall back to the *app's* document, not the landing page.
        const deep = await request(port, '/judgepapers/competition/1a2b3c4d');
        assert.equal(deep.status, 200);
        assert.match(deep.text, /JUDGEPAPERS_INDEX/);
        assert.match(deep.headers['content-type'], /text\/html/);

        assert.match((await request(port, '/protocolgenerator/deep/route')).text, /PROTOCOLGENERATOR_INDEX/);

        // Unknown top-level routes fall back to the landing page.
        const other = await request(port, '/something/else');
        assert.equal(other.status, 200);
        assert.match(other.text, /ROOT_INDEX/);

        // Root statics resolve as files, before any fallback.
        const asset = await request(port, '/assets/app-abc123.js');
        assert.equal(asset.status, 200);
        assert.match(asset.text, /console\.log/);
        assert.match(asset.headers['content-type'], /javascript/);
        assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

        const logo = await request(port, '/logo.png');
        assert.equal(logo.status, 200);
        assert.equal(logo.headers['content-type'], 'image/png');
        assert.equal(logo.headers['cache-control'], 'no-cache');

        const changelog = await request(port, '/changelog.json');
        assert.equal(changelog.status, 200);
        assert.match(changelog.headers['content-type'], /application\/json/);
        assert.equal(changelog.headers['cache-control'], 'no-cache');

        // A missing bundle must 404, never HTML with a JS content type.
        assert.equal((await request(port, '/assets/gone-999.js')).status, 404);
        assert.equal((await request(port, '/judgepapers/assets/gone.css')).status, 404);

        // Path traversal is refused.
        const escape = await request(port, '/../server.js');
        assert.ok(escape.status === 403 || escape.status === 404, `got ${escape.status}`);

        // /.auth/* is never handled here (Easy Auth owns it).
        assert.equal((await request(port, '/.auth/me')).status, 404);
    } finally {
        await close(server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

// ── Public landing page + /signin ────────────────────────────────────────────

function addLanding(dir) {
    fs.mkdirSync(path.join(dir, 'landing'));
    fs.writeFileSync(path.join(dir, 'landing', 'index.html'), '<html>LANDING</html>');
    fs.writeFileSync(path.join(dir, 'landing', 'landing.css'), 'body{}');
}

test('/ serves the landing page without a principal and the home page with one', async () => {
    const publicDir = makePublicFixture();
    addLanding(publicDir);
    const { server, port } = await startRouter({ publicDir });
    try {
        for (const p of ['/', '/index.html']) {
            const anon = await request(port, p);
            assert.equal(anon.status, 200);
            assert.match(anon.text, /LANDING/);
            assert.match(anon.headers['content-type'], /text\/html/);
            assert.equal(anon.headers['cache-control'], 'no-cache');
            assert.equal(anon.headers.vary, 'Cookie');
        }

        const signedIn = await request(port, '/', {
            headers: { 'x-ms-client-principal': principalHeader(PRINCIPAL) },
        });
        assert.match(signedIn.text, /ROOT_INDEX/);

        const byName = await request(port, '/', { headers: { 'x-ms-client-principal-name': 'skater@example.com' } });
        assert.match(byName.text, /ROOT_INDEX/);

        // / is an Easy Auth excluded path: the platform passes the session
        // cookie but no principal headers, so the cookie alone means home.
        for (const cookie of [
            'AppServiceAuthSession=abc123',
            'theme=light; AppServiceAuthSession=abc123; other=1',
            'AppServiceAuthSession1=part1; AppServiceAuthSession2=part2',
        ]) {
            const bySession = await request(port, '/', { headers: { cookie } });
            assert.match(bySession.text, /ROOT_INDEX/, cookie);
            assert.equal(bySession.headers.vary, 'Cookie');
        }
        for (const cookie of ['AppServiceAuthSession=', 'NotAppServiceAuthSession=abc', 'theme=light']) {
            assert.match((await request(port, '/', { headers: { cookie } })).text, /LANDING/, cookie);
        }

        // A garbage principal is no principal.
        const garbage = await request(port, '/', { headers: { 'x-ms-client-principal': '%%%' } });
        assert.match(garbage.text, /LANDING/);

        // Only the root document switches; other root routes and the landing's
        // own files are untouched.
        assert.match((await request(port, '/something/else')).text, /ROOT_INDEX/);
        const css = await request(port, '/landing/landing.css');
        assert.equal(css.status, 200);
        assert.match(css.headers['content-type'], /text\/css/);
        assert.match((await request(port, '/judgepapers/')).text, /JUDGEPAPERS_INDEX/);

        // The landing page gets the plain root CSP.
        assert.equal((await request(port, '/')).headers['content-security-policy'], buildCsp(''));
    } finally {
        await close(server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('/ shows the home page when DEV_FAKE_USER is set, or when the build has no landing page', async () => {
    const withLanding = makePublicFixture();
    addLanding(withLanding);
    const bare = makePublicFixture();
    const dev = await startRouter({ publicDir: withLanding, devFakeUser: 'dev@example.com' });
    const plain = await startRouter({ publicDir: bare });
    try {
        assert.match((await request(dev.port, '/')).text, /ROOT_INDEX/);
        assert.match((await request(plain.port, '/')).text, /ROOT_INDEX/);
    } finally {
        await close(dev.server);
        await close(plain.server);
        fs.rmSync(withLanding, { recursive: true, force: true });
        fs.rmSync(bare, { recursive: true, force: true });
    }
});

// ── Public privacy notice + self-hosted fonts ────────────────────────────────

function addPrivacyAndFonts(dir) {
    fs.mkdirSync(path.join(dir, 'privacy'));
    fs.mkdirSync(path.join(dir, 'tietosuoja'));
    fs.mkdirSync(path.join(dir, 'fonts'));
    fs.writeFileSync(path.join(dir, 'privacy', 'index.html'), '<html>PRIVACY_EN</html>');
    fs.writeFileSync(path.join(dir, 'privacy', 'privacy.css'), 'main{}');
    fs.writeFileSync(path.join(dir, 'tietosuoja', 'index.html'), '<html>PRIVACY_FI</html>');
    fs.writeFileSync(path.join(dir, 'fonts', 'fonts.css'), '@font-face{}');
    fs.writeFileSync(path.join(dir, 'fonts', 'fraunces-latin-opsz-normal.v5-3-0.woff2'), Buffer.from('wOF2'));
}

test('the privacy notice and fonts are plain static files, served the same signed in or out', async () => {
    const publicDir = makePublicFixture();
    addLanding(publicDir);
    addPrivacyAndFonts(publicDir);
    const { server, port } = await startRouter({ publicDir });
    try {
        // Easy Auth lists /privacy, /privacy/*, /tietosuoja, /tietosuoja/* and
        // /fonts/* as excluded paths, so these requests arrive without any
        // principal; the router must not need one.
        const signedIn = { headers: { 'x-ms-client-principal': principalHeader(PRINCIPAL) } };
        for (const opts of [{}, signedIn, { headers: { cookie: 'AppServiceAuthSession=abc' } }]) {
            const en = await request(port, '/privacy/', opts);
            assert.equal(en.status, 200);
            assert.match(en.text, /PRIVACY_EN/);
            assert.match(en.headers['content-type'], /text\/html/);
            assert.equal(en.headers['cache-control'], 'no-cache');
            assert.equal(en.headers['content-security-policy'], buildCsp(''));

            const fi = await request(port, '/tietosuoja/', opts);
            assert.equal(fi.status, 200);
            assert.match(fi.text, /PRIVACY_FI/);
        }

        // The bare paths redirect to the directory so relative URLs resolve.
        const bare = await request(port, '/privacy');
        assert.equal(bare.status, 301);
        assert.equal(bare.headers.location, '/privacy/');
        assert.equal((await request(port, '/tietosuoja')).headers.location, '/tietosuoja/');

        const css = await request(port, '/privacy/privacy.css');
        assert.match(css.headers['content-type'], /text\/css/);

        // fonts.css is revalidated; the versioned font files are immutable.
        const fontsCss = await request(port, '/fonts/fonts.css');
        assert.equal(fontsCss.status, 200);
        assert.match(fontsCss.headers['content-type'], /text\/css/);
        assert.equal(fontsCss.headers['cache-control'], 'no-cache');
        const font = await request(port, '/fonts/fraunces-latin-opsz-normal.v5-3-0.woff2');
        assert.equal(font.status, 200);
        assert.equal(font.headers['content-type'], 'font/woff2');
        assert.equal(font.headers['cache-control'], 'public, max-age=31536000, immutable');
        assert.equal((await request(port, '/fonts/missing.woff2')).status, 404);
    } finally {
        await close(server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('the real privacy pages and fonts.css reference only this origin', () => {
    const publicRoot = path.join(__dirname, '..', 'site', 'public');
    for (const page of ['privacy/index.html', 'tietosuoja/index.html', 'landing/index.html']) {
        const html = fs.readFileSync(path.join(publicRoot, page), 'utf8');
        assert.doesNotMatch(html, /googleapis|gstatic/, page);
        assert.match(html, /<link rel="stylesheet" href="\/fonts\/fonts\.css">/, page);
    }
    const fontsCss = fs.readFileSync(path.join(publicRoot, 'fonts', 'fonts.css'), 'utf8');
    const urls = [...fontsCss.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
    assert.ok(urls.length > 0);
    for (const url of urls) {
        assert.match(url, /^\.\/[a-z0-9-]+\.v[0-9-]+\.woff2$/, url);
        assert.ok(fs.existsSync(path.join(publicRoot, 'fonts', url)), url);
    }
});

test('GET /signin redirects to the Easy Auth login with a same-origin return path', async () => {
    const { server, port } = await startRouter();
    try {
        const root = await request(port, '/signin');
        assert.equal(root.status, 302);
        assert.equal(root.headers.location, '/.auth/login/aad?post_login_redirect_url=%2F');
        assert.equal(root.headers['cache-control'], 'no-store');

        const app = await request(port, '/signin?return=%2Fjudgepapers%2F%3Fx%3D1');
        assert.equal(app.headers.location, '/.auth/login/aad?post_login_redirect_url=%2Fjudgepapers%2F%3Fx%3D1');

        for (const evil of ['//evil.example', 'https%3A%2F%2Fevil.example', '%2F%5Cevil.example', '%2F%2Fevil', 'judgepapers', '%2Fa%0d%0aSet-Cookie:x']) {
            const res = await request(port, `/signin?return=${evil}`);
            assert.equal(res.headers.location, '/.auth/login/aad?post_login_redirect_url=%2F', evil);
        }

        const post = await request(port, '/signin', { method: 'POST' });
        assert.equal(post.status, 405);
    } finally {
        await close(server);
    }
});

test('/signin follows AUTH_LOGIN_PROVIDER', async () => {
    assert.equal(loadConfig({}).loginProvider, 'aad');
    const config = loadConfig({ AUTH_LOGIN_PROVIDER: 'externalid' });
    assert.equal(config.loginProvider, 'externalid');
    const { server, port } = await startRouter({ loginProvider: config.loginProvider });
    try {
        const res = await request(port, '/signin?return=%2Fscoremodifier%2F');
        assert.equal(res.headers.location, '/.auth/login/externalid?post_login_redirect_url=%2Fscoremodifier%2F');
    } finally {
        await close(server);
    }
});

test('safeReturnPath only lets same-origin paths through', () => {
    assert.equal(safeReturnPath('/tools/gdpr/'), '/tools/gdpr/');
    assert.equal(safeReturnPath('/'), '/');
    for (const bad of [undefined, '', 'x', '//evil', '/\\evil', 'https://evil', '/a\nb', '/a\\b']) {
        assert.equal(safeReturnPath(bad), '/', String(bad));
    }
});

test('301 redirects /<tool> to /<tool>/ preserving the query string', async () => {
    const publicDir = makePublicFixture();
    const { server, port } = await startRouter({ publicDir });
    try {
        const res = await request(port, '/judgepapers');
        assert.equal(res.status, 301);
        assert.equal(res.headers.location, '/judgepapers/');

        const withQuery = await request(port, '/scoremodifier?competition=abc');
        assert.equal(withQuery.status, 301);
        assert.equal(withQuery.headers.location, '/scoremodifier/?competition=abc');
    } finally {
        await close(server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('301 works before the dist exists (no public dir needed)', async () => {
    const { server, port } = await startRouter({ publicDir: path.join(os.tmpdir(), 'fst-does-not-exist') });
    try {
        const res = await request(port, '/protocolgenerator');
        assert.equal(res.status, 301);
        assert.equal(res.headers.location, '/protocolgenerator/');
    } finally {
        await close(server);
    }
});

// ── Content-Security-Policy ──────────────────────────────────────────────────

test('CSP differs per prefix', async () => {
    const publicDir = makePublicFixture();
    const { server, port } = await startRouter({ publicDir });
    try {
        const rootCsp = (await request(port, '/')).headers['content-security-policy'];
        const jpCsp = (await request(port, '/judgepapers/')).headers['content-security-policy'];
        const pgCsp = (await request(port, '/protocolgenerator/')).headers['content-security-policy'];

        // Base policy: fonts and styles from this origin only. The fonts are
        // self-hosted under /fonts/, so no Google host is allowed anywhere.
        for (const csp of [rootCsp, jpCsp, pgCsp]) {
            assert.match(csp, /default-src 'self'/);
            assert.match(csp, /style-src 'self' 'unsafe-inline'(;|$)/);
            assert.match(csp, /font-src 'self'(;|$)/);
            assert.match(csp, /frame-ancestors 'none'/);
            assert.doesNotMatch(csp, /googleapis|gstatic/);
        }

        // Root: no WASM, no worker-src, no blob storage.
        assert.doesNotMatch(rootCsp, /wasm-unsafe-eval/);
        assert.doesNotMatch(rootCsp, /worker-src/);
        assert.doesNotMatch(rootCsp, /blob\.core\.windows\.net/);

        // Tool prefixes: SAS URLs to blob storage.
        assert.match(jpCsp, /connect-src [^;]*https:\/\/\*\.blob\.core\.windows\.net/);
        assert.match(jpCsp, /img-src [^;]*https:\/\/\*\.blob\.core\.windows\.net/);
        assert.doesNotMatch(jpCsp, /wasm-unsafe-eval/);

        // protocolgenerator: pdf.js needs WASM + blob workers.
        assert.match(pgCsp, /script-src 'self' 'wasm-unsafe-eval'/);
        assert.match(pgCsp, /worker-src 'self' blob:/);
        assert.match(pgCsp, /connect-src [^;]*blob:/);
        assert.match(pgCsp, /img-src [^;]*blob:/);
        assert.match(pgCsp, /connect-src [^;]*https:\/\/\*\.blob\.core\.windows\.net/);

        // The header is applied to API responses and deep links too.
        const deep = await request(port, '/protocolgenerator/deep');
        assert.equal(deep.headers['content-security-policy'], pgCsp);
    } finally {
        await close(server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('buildCsp is stable and prefix-specific', () => {
    assert.equal(buildCsp(''), buildCsp('unknown-prefix'));
    assert.notEqual(buildCsp('judgepapers'), buildCsp(''));
    assert.notEqual(buildCsp('protocolgenerator'), buildCsp('judgepapers'));
    assert.equal(buildCsp('judgepapers'), buildCsp('scoremodifier'));
});

// ── /changelog-live ──────────────────────────────────────────────────────────

const SOURCES = [
    { repo: 'figureskatingtools/fs-alpha', tool: 'Alpha' },
    { repo: 'figureskatingtools/fs-beta', tool: 'Beta' },
];

// public/ tree carrying only what the changelog route reads.
function makeChangelogFixture(sources = SOURCES) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fst-changelog-'));
    fs.writeFileSync(path.join(dir, 'changelog-sources.json'), JSON.stringify(sources));
    return dir;
}

// Minimal GitHub commit object, only the fields the mapper reads.
function commitFixture(sha, iso, message, author = 'Committer Person') {
    return {
        sha,
        commit: {
            message,
            author: { name: author, date: iso },
            committer: { name: 'Ignored Committer', date: iso },
        },
    };
}

// `count` commits, one per minute, newest last. `minuteOffset` interleaves repos.
function commitsFor(prefix, count, minuteOffset) {
    return Array.from({ length: count }, (_, i) => {
        const iso = new Date(Date.UTC(2026, 7, 1, 0, i * 2 + minuteOffset)).toISOString();
        return commitFixture(`${prefix}${String(i).padStart(4, '0')}deadbeef`, iso, `${prefix} commit ${i}`);
    }).reverse(); // GitHub returns newest first
}

// Stand-in for api.github.com. `state.fail` flips it to 500s; `state.hold`
// parks responses so concurrency can be observed.
async function startFakeGitHub(commitsByRepo) {
    const state = { fail: false, hold: false, held: [] };
    const upstream = await startUpstream((req, res) => {
        const respond = () => {
            if (state.fail) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end('{"message":"API rate limit exceeded"}');
                return;
            }
            const repo = /^\/repos\/([^/]+\/[^/]+)\/commits$/.exec(req.url.split('?')[0]);
            const commits = repo && commitsByRepo[repo[1]];
            if (!commits) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end('{"message":"Not Found"}');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(commits));
        };
        if (state.hold) state.held.push(respond);
        else respond();
    });
    return {
        ...upstream,
        state,
        release() {
            const pending = state.held.splice(0);
            for (const respond of pending) respond();
            return pending.length;
        },
    };
}

async function startChangelogRouter(github, overrides = {}) {
    const publicDir = makeChangelogFixture(overrides.sources);
    delete overrides.sources;
    const started = await startRouter({ publicDir, githubApiOrigin: github.url, ...overrides });
    return { ...started, publicDir };
}

function waitFor(predicate, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (predicate()) return resolve();
            if (Date.now() > deadline) return reject(new Error('waitFor timed out'));
            setTimeout(tick, 10);
        };
        tick();
    });
}

test('GET /changelog-live merges repos, maps commit shape, sorts newest-first and caps at 20', async () => {
    const github = await startFakeGitHub({
        'figureskatingtools/fs-alpha': [
            commitFixture('abcdef1234567890', '2026-08-02T10:00:00Z', 'Alpha headline\n\n- did a thing\n- did another', 'Alpha Author'),
            ...commitsFor('alpha', 12, 0),
        ],
        'figureskatingtools/fs-beta': commitsFor('beta', 12, 1),
    });
    const { server, port, publicDir } = await startChangelogRouter(github);
    try {
        const res = await request(port, '/changelog-live?branch=main');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /application\/json/);

        const entries = json(res);
        assert.ok(Array.isArray(entries));
        assert.equal(entries.length, CHANGELOG_MAX_ENTRIES);

        // Newest commit overall, fully mapped.
        assert.deepEqual(entries[0], {
            sha: 'abcdef1',
            date: '2026-08-02',
            iso: '2026-08-02T10:00:00Z',
            title: 'Alpha headline',
            description: '- did a thing\n- did another',
            author: 'Alpha Author',
            tool: 'Alpha',
        });

        // Strictly newest-first, and both tools survive the merge.
        const isos = entries.map((e) => e.iso);
        assert.deepEqual(isos, [...isos].sort().reverse());
        assert.ok(entries.some((e) => e.tool === 'Alpha'));
        assert.ok(entries.some((e) => e.tool === 'Beta'));

        // One upstream call per source, with the branch and GitHub headers.
        assert.equal(github.received.length, 2);
        for (const seen of github.received) {
            assert.match(seen.url, /\/commits\?sha=main&per_page=20$/);
            assert.equal(seen.headers['accept'], 'application/vnd.github+json');
            assert.ok(seen.headers['user-agent']);
        }
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('commits tagged #nowhatsnew or #nowhatnew stay out of /changelog-live', async () => {
    const github = await startFakeGitHub({
        'figureskatingtools/fs-alpha': [
            commitFixture('a000000000000001', '2026-08-03T10:00:00Z', 'Bump deps\n\n- internal #nowhatsnew'),
            commitFixture('a000000000000002', '2026-08-03T09:00:00Z', 'CI tweak #NoWhatNew'),
            commitFixture('a000000000000003', '2026-08-03T08:00:00Z', 'Visible change\n\n- shown'),
        ],
        'figureskatingtools/fs-beta': [
            commitFixture('b000000000000001', '2026-08-03T07:00:00Z', '#NOWHATSNEW refactor'),
            commitFixture('b000000000000002', '2026-08-03T06:00:00Z', 'Mentions #nowhatsnewer, so it stays'),
        ],
    });
    const { server, port, publicDir } = await startChangelogRouter(github);
    try {
        const entries = json(await request(port, '/changelog-live?branch=main'));
        assert.deepEqual(entries.map((e) => e.sha), ['a000000', 'b000000']);
        assert.deepEqual(entries.map((e) => e.title), ['Visible change', 'Mentions #nowhatsnewer, so it stays']);
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('isHiddenFromChangelog matches the tag anywhere in the message, any case', () => {
    const c = (message) => ({ commit: { message } });
    assert.equal(isHiddenFromChangelog(c('Title #nowhatsnew')), true);
    assert.equal(isHiddenFromChangelog(c('Title\n\n- x\n#NoWhatNew')), true);
    assert.equal(isHiddenFromChangelog(c('Title')), false);
    assert.equal(isHiddenFromChangelog(c('#nowhatsnewer')), false);
    assert.equal(isHiddenFromChangelog({}), false);
});

test('GET /changelog-live rejects any branch other than main/test', async () => {
    const github = await startFakeGitHub({});
    const { server, port, publicDir } = await startChangelogRouter(github);
    try {
        for (const query of ['?branch=evil', '?branch=', '', '?branch=main%2Ftest']) {
            const res = await request(port, `/changelog-live${query}`);
            assert.equal(res.status, 400, `expected 400 for "${query}"`);
            assert.match(res.headers['content-type'], /application\/json/);
            assert.equal(json(res).error, 'invalid_branch');
        }
        // Nothing invalid ever reaches GitHub.
        assert.equal(github.received.length, 0);

        // `test` is still accepted (it maps to `main`), so it reaches GitHub —
        // which has nothing for it here, hence the 502.
        assert.equal((await request(port, '/changelog-live?branch=test')).status, 502);
        assert.match(github.received[0].url, /sha=main/);
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('GET /changelog-live returns 502 when GitHub fails and nothing is cached', async () => {
    const github = await startFakeGitHub({
        'figureskatingtools/fs-alpha': commitsFor('alpha', 2, 0),
        'figureskatingtools/fs-beta': commitsFor('beta', 2, 1),
    });
    github.state.fail = true;
    const { server, port, publicDir } = await startChangelogRouter(github);
    try {
        const res = await request(port, '/changelog-live?branch=main');
        assert.equal(res.status, 502);
        assert.equal(json(res).error, 'changelog_upstream_failed');
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('a single failing repo fails the whole refresh — partial feeds never get cached', async () => {
    const github = await startFakeGitHub({
        // fs-beta is missing → 404 for that repo only.
        'figureskatingtools/fs-alpha': commitsFor('alpha', 2, 0),
    });
    const { server, port, publicDir } = await startChangelogRouter(github);
    try {
        assert.equal((await request(port, '/changelog-live?branch=main')).status, 502);
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('a fresh cache entry is served without touching GitHub again', async () => {
    const github = await startFakeGitHub({
        'figureskatingtools/fs-alpha': commitsFor('alpha', 3, 0),
        'figureskatingtools/fs-beta': commitsFor('beta', 3, 1),
    });
    const { server, port, publicDir } = await startChangelogRouter(github);
    try {
        const first = await request(port, '/changelog-live?branch=main');
        assert.equal(first.status, 200);
        assert.equal(github.received.length, 2);

        const second = await request(port, '/changelog-live?branch=main');
        assert.equal(second.status, 200);
        assert.deepEqual(json(second), json(first));
        assert.equal(github.received.length, 2, 'cache hit must not re-fetch');

        // `test` (asked for by frontends built before the switch) is the same
        // `main` feed: served from the same cache entry, never sha=test upstream.
        const other = await request(port, '/changelog-live?branch=test');
        assert.equal(other.status, 200);
        assert.deepEqual(json(other), json(first));
        assert.equal(github.received.length, 2);
        for (const call of github.received) assert.match(call.url, /sha=main/);
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('an expired cache entry is served stale when the refresh fails', async () => {
    const github = await startFakeGitHub({
        'figureskatingtools/fs-alpha': commitsFor('alpha', 3, 0),
        'figureskatingtools/fs-beta': commitsFor('beta', 3, 1),
    });
    // TTL 0: every request re-fetches, so the second one exercises the stale path.
    const { server, port, publicDir } = await startChangelogRouter(github, { changelogTtlMs: 0 });
    try {
        const good = await request(port, '/changelog-live?branch=main');
        assert.equal(good.status, 200);
        assert.equal(json(good).length, 6);

        github.state.fail = true;
        const stale = await request(port, '/changelog-live?branch=main');
        assert.equal(stale.status, 200, 'stale data beats the days-old build-time snapshot');
        assert.deepEqual(json(stale), json(good));
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('concurrent requests share one refresh instead of stampeding GitHub', async () => {
    const github = await startFakeGitHub({
        'figureskatingtools/fs-alpha': commitsFor('alpha', 3, 0),
        'figureskatingtools/fs-beta': commitsFor('beta', 3, 1),
    });
    github.state.hold = true;
    // TTL 0 so no request can be answered from cache — only the in-flight
    // memoisation can keep the upstream count down.
    const { server, port, publicDir } = await startChangelogRouter(github, { changelogTtlMs: 0 });
    try {
        const inFlight = [
            request(port, '/changelog-live?branch=main'),
            request(port, '/changelog-live?branch=main'),
            request(port, '/changelog-live?branch=main'),
        ];

        // Two upstream calls (one per repo) for three client requests.
        await waitFor(() => github.state.held.length >= 2);
        await new Promise((r) => setTimeout(r, 50)); // give a stampede time to show up
        assert.equal(github.state.held.length, 2);

        github.release();
        const responses = await Promise.all(inFlight);
        for (const res of responses) {
            assert.equal(res.status, 200);
            assert.deepEqual(json(res), json(responses[0]));
        }
        assert.equal(github.received.length, 2);
    } finally {
        await close(server);
        await close(github.server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('/changelog-live 502s when the sources file is missing', async () => {
    const github = await startFakeGitHub({});
    const { server, port } = await startRouter({
        publicDir: path.join(os.tmpdir(), 'fst-no-such-dir'),
        githubApiOrigin: github.url,
    });
    try {
        const res = await request(port, '/changelog-live?branch=main');
        assert.equal(res.status, 502);
        assert.equal(json(res).error, 'changelog_upstream_failed');
        assert.equal(github.received.length, 0);
    } finally {
        await close(server);
        await close(github.server);
    }
});

// ── Admin: identity, panel, /api/manage, diagnostics ─────────────────────────

const ADMIN_EMAIL = 'admin@example.com';

function principalFor(email) {
    return principalHeader({ ...PRINCIPAL, userDetails: email, claims: [{ typ: 'preferred_username', val: email }] });
}

// Two admins, listed with stray case and whitespace.
function adminConfig(extra = {}) {
    const { adminEmails } = loadConfig({ ADMIN_EMAILS: ' Admin@Example.com , other-admin@example.com ' });
    return { adminEmails, ...extra };
}

function fakeReq(headers = {}) {
    return { headers };
}

test('ADMIN_EMAILS is parsed into a trimmed, lowercased set', () => {
    assert.deepEqual([...loadConfig({ ADMIN_EMAILS: ' A@Example.com,,b@example.com ' }).adminEmails], [
        'a@example.com',
        'b@example.com',
    ]);
    assert.equal(loadConfig({}).adminEmails.size, 0);
});

test('isAdminRequest: listed e-mail in any case, nobody else, never a bare principal-name header', () => {
    const config = { ...loadConfig({}), ...adminConfig() };
    assert.equal(isAdminRequest(fakeReq({ 'x-ms-client-principal': principalFor('ADMIN@example.COM') }), config), true);
    assert.equal(isAdminRequest(fakeReq({ 'x-ms-client-principal': principalFor('skater@example.com') }), config), false);
    assert.equal(isAdminRequest(fakeReq({ 'x-ms-client-principal-name': ADMIN_EMAIL }), config), false);
    assert.equal(isAdminRequest(fakeReq({}), config), false);
    // An empty list means nobody, whatever the identity.
    const nobody = loadConfig({});
    assert.equal(isAdminRequest(fakeReq({ 'x-ms-client-principal': principalFor(ADMIN_EMAIL) }), nobody), false);
});

test('isAdminRequest honours DEV_FAKE_USER locally but never under NODE_ENV=production', () => {
    const dev = loadConfig({ ADMIN_EMAILS: ADMIN_EMAIL, DEV_FAKE_USER: ADMIN_EMAIL });
    assert.equal(isAdminRequest(fakeReq({}), dev), true);
    // The dev stand-in does not lend admin to a principal-name header.
    assert.equal(isAdminRequest(fakeReq({ 'x-ms-client-principal-name': 'skater@example.com' }), dev), false);
    const prod = loadConfig({ ADMIN_EMAILS: ADMIN_EMAIL, DEV_FAKE_USER: ADMIN_EMAIL, NODE_ENV: 'production' });
    assert.equal(isAdminRequest(fakeReq({}), prod), false);
});

test('GET /userinfo reports isAdmin for admins only', async () => {
    const { server, port } = await startRouter(adminConfig());
    try {
        const admin = await request(port, '/userinfo', {
            headers: { 'x-ms-client-principal': principalFor('ADMIN@EXAMPLE.COM') },
        });
        assert.equal(json(admin).isAdmin, true);
        const user = await request(port, '/userinfo', {
            headers: { 'x-ms-client-principal': principalHeader(PRINCIPAL) },
        });
        assert.equal(json(user).isAdmin, false);
    } finally {
        await close(server);
    }
    const dev = await startRouter(adminConfig({ devFakeUser: ADMIN_EMAIL }));
    try {
        assert.equal(json(await request(dev.port, '/userinfo')).isAdmin, true);
    } finally {
        await close(dev.server);
    }
});

test('/admin/ is a plain 404 for non-admins and the admin document (with deep links) for admins', async () => {
    const publicDir = makePublicFixture();
    fs.mkdirSync(path.join(publicDir, 'admin'));
    fs.writeFileSync(path.join(publicDir, 'admin', 'index.html'), '<html>ADMIN_INDEX</html>');
    const { server, port } = await startRouter(adminConfig({ publicDir }));
    const adminHeaders = { 'x-ms-client-principal': principalFor(ADMIN_EMAIL) };
    const userHeaders = { 'x-ms-client-principal': principalHeader(PRINCIPAL) };
    try {
        // Encoded and non-normalised spellings are gated like the plain one.
        const spellings = ['/admin', '/admin/', '/admin/index.html', '/admin/competitions/x', '/%61dmin/', '//admin/', '/x/../admin/'];
        for (const p of spellings) {
            const res = await request(port, p, { headers: userHeaders });
            assert.equal(res.status, 404, p);
            assert.doesNotMatch(res.text, /ADMIN_INDEX/, p);
        }
        assert.equal((await request(port, '/admin/')).status, 404); // signed out

        const doc = await request(port, '/admin/', { headers: adminHeaders });
        assert.equal(doc.status, 200);
        assert.match(doc.text, /ADMIN_INDEX/);
        assert.match(doc.headers['vary'], /Cookie/);
        // Base CSP: admin is not a tool, so no blob-storage host.
        assert.doesNotMatch(doc.headers['content-security-policy'], /blob\.core\.windows\.net/);

        const deep = await request(port, '/admin/competitions/1a2b', { headers: adminHeaders });
        assert.equal(deep.status, 200);
        assert.match(deep.text, /ADMIN_INDEX/);

        const bare = await request(port, '/admin', { headers: adminHeaders });
        assert.equal(bare.status, 301);
        assert.equal(bare.headers['location'], '/admin/');

        // Unknown router-native admin API paths never fall back to the document.
        const unknownApi = await request(port, '/admin/api/nope', { headers: adminHeaders });
        assert.equal(unknownApi.status, 404);
        assert.match(unknownApi.headers['content-type'], /application\/json/);
    } finally {
        await close(server);
        fs.rmSync(publicDir, { recursive: true, force: true });
    }
});

test('/api/manage/* is refused for non-admins without reaching the platform', async () => {
    const upstream = await startUpstream((req, res) => res.end('{}'));
    const { server, port } = await startRouter(
        adminConfig({ targets: targets({ platform: { url: upstream.url, secret: 'platform-secret' } }) })
    );
    const userHeaders = { 'x-ms-client-principal': principalHeader(PRINCIPAL) };
    try {
        const spellings = [
            '/api/manage/competitions',
            '/api/Manage/competitions',
            '/api/%6Danage/audit',
            '/api/x/../manage/diagnostics',
            '/api/manage',
        ];
        for (const p of spellings) {
            const res = await request(port, p, { headers: userHeaders });
            assert.equal(res.status, 403, p);
            assert.equal(json(res).error, 'admin_required');
        }
        const signedOut = await request(port, '/api/manage/competitions', { method: 'POST' });
        assert.equal(signedOut.status, 403);
        assert.equal(upstream.received.length, 0);
        // The ordinary registry routes are untouched.
        await request(port, '/api/competitions', { headers: userHeaders });
        assert.equal(upstream.received.length, 1);
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('/api/manage/* proxies admins, and rejects cross-site state changes', async () => {
    const upstream = await startUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"competitions":[]}');
    });
    const { server, port } = await startRouter(
        adminConfig({ targets: targets({ platform: { url: upstream.url, secret: 'platform-secret' } }) })
    );
    const admin = { 'x-ms-client-principal': principalFor(ADMIN_EMAIL) };
    try {
        const list = await request(port, '/api/manage/competitions?status=all', { headers: admin });
        assert.equal(list.status, 200);
        assert.equal(upstream.received[0].url, '/api/manage/competitions?status=all');
        assert.equal(upstream.received[0].headers['x-proxy-secret'], 'platform-secret');
        assert.equal(upstream.received[0].headers['x-forwarded-user-email'], ADMIN_EMAIL);

        const body = JSON.stringify({ confirm: 'abc26' });
        const crossSite = await request(port, '/api/manage/competitions/x/purge', {
            method: 'POST',
            headers: {
                ...admin,
                'content-type': 'application/json',
                'sec-fetch-site': 'cross-site',
                origin: 'https://attacker.example.com',
            },
            body,
        });
        assert.equal(crossSite.status, 403);
        assert.equal(json(crossSite).error, 'cross_site');
        const noOrigin = await request(port, '/api/manage/competitions/x', { method: 'DELETE', headers: admin });
        assert.equal(noOrigin.status, 403);
        assert.equal(json(noOrigin).error, 'cross_site');
        assert.equal(upstream.received.length, 1);

        const sameSite = await request(port, '/api/manage/competitions/x/purge', {
            method: 'POST',
            headers: { ...admin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
            body,
        });
        assert.equal(sameSite.status, 200);
        const byOrigin = await request(port, '/api/manage/sweep/dry-run', {
            method: 'POST',
            headers: { ...admin, origin: `http://127.0.0.1:${port}` },
        });
        assert.equal(byOrigin.status, 200);
        assert.equal(upstream.received.length, 3);
        assert.equal(upstream.received[1].method, 'POST');
        assert.equal(upstream.received[1].url, '/api/manage/competitions/x/purge');
    } finally {
        await close(server);
        await close(upstream.server);
    }
});

test('GET /admin/api/diagnostics: admins only, booleans for config, health of every backend', async () => {
    const healthy = await startUpstream((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"status":"ok"}');
    });
    const noRoute = await startUpstream((req, res) => {
        res.writeHead(404);
        res.end();
    });
    const broken = await startUpstream((req, res) => {
        res.writeHead(500);
        res.end();
    });
    const hanging = await startUpstream(() => {}); // never answers

    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fst-build-'));
    const buildInfoPath = path.join(buildDir, 'build-info.json');
    fs.writeFileSync(buildInfoPath, JSON.stringify({ commit: 'abc1234def5678', builtUtc: '2026-10-15T00:00:00Z' }));

    const secrets = { platform: 'platform-SECRET-value', judgepapers: 'jp-SECRET-value', scoremodifier: 'sm-SECRET-value' };
    const { server, port } = await startRouter(
        adminConfig({
            buildInfoPath,
            healthTimeoutMs: 300,
            nodeEnv: 'production',
            hovtpHealthUrl: `${healthy.url}/api/health`,
            targets: targets({
                platform: { url: healthy.url + '/', secret: secrets.platform },
                judgepapers: { url: noRoute.url, secret: secrets.judgepapers },
                scoremodifier: { url: broken.url, secret: secrets.scoremodifier },
                protocolgenerator: { url: hanging.url, secret: '' },
                // gdprtool left unconfigured
            }),
        })
    );
    try {
        const denied = await request(port, '/admin/api/diagnostics', {
            headers: { 'x-ms-client-principal': principalHeader(PRINCIPAL) },
        });
        assert.equal(denied.status, 403);
        assert.equal(json(denied).error, 'admin_required');

        const res = await request(port, '/admin/api/diagnostics', {
            headers: { 'x-ms-client-principal': principalFor(ADMIN_EMAIL) },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers['cache-control'], 'no-store');
        const body = json(res);

        assert.equal(body.router.commit, 'abc1234def5678');
        assert.equal(body.router.nodeEnv, 'production');
        assert.equal(body.router.node, process.version);
        assert.match(body.router.startedUtc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        assert.equal(typeof body.router.uptimeSeconds, 'number');
        assert.deepEqual(body.router.changelog, { entries: [] });

        assert.deepEqual(body.config.targets.platform, { url: true, secret: true });
        assert.deepEqual(body.config.targets.protocolgenerator, { url: true, secret: false });
        assert.deepEqual(body.config.targets.gdprtool, { url: false, secret: false });
        assert.equal(body.config.hovtpHealthUrl, true);
        assert.equal(body.config.adminCount, 2);
        assert.equal(body.config.loginProvider, 'aad');
        assert.equal(body.config.devFakeUser, false);

        const byName = Object.fromEntries(body.backends.map((b) => [b.name, b]));
        assert.deepEqual(Object.keys(byName).sort(), [
            'gdprtool',
            'hovtp',
            'judgepapers',
            'platform',
            'protocolgenerator',
            'scoremodifier',
        ]);
        assert.equal(byName.platform.status, 'ok');
        assert.equal(byName.platform.httpStatus, 200);
        assert.equal(typeof byName.platform.latencyMs, 'number');
        assert.equal(byName.judgepapers.status, 'no_health_route');
        assert.equal(byName.scoremodifier.status, 'error');
        assert.equal(byName.scoremodifier.httpStatus, 500);
        assert.equal(byName.protocolgenerator.status, 'timeout');
        assert.equal(byName.protocolgenerator.latencyMs, null);
        assert.equal(byName.gdprtool.status, 'not_configured');
        assert.equal(byName.hovtp.status, 'ok');

        // Each ping carries that backend's own secret; HOVTP gets none.
        const healthyCalls = healthy.received.filter((r) => r.url === '/api/health');
        assert.equal(healthyCalls.length, 2);
        assert.deepEqual(healthyCalls.map((r) => r.headers['x-proxy-secret'] || '').sort(), ['', secrets.platform]);
        assert.equal(noRoute.received[0].headers['x-proxy-secret'], secrets.judgepapers);

        // Nothing configurable leaks: no secret values, no backend hosts or ports.
        const leaks = [...Object.values(secrets), '127.0.0.1', String(healthy.port), String(noRoute.port)];
        for (const value of leaks) {
            assert.ok(!res.text.includes(value), `diagnostics leaked ${value}`);
        }
    } finally {
        await close(server);
        hanging.server.closeAllConnections();
        await Promise.all([healthy, noRoute, broken, hanging].map((u) => close(u.server)));
        fs.rmSync(buildDir, { recursive: true, force: true });
    }
});

test('diagnostics report a null commit without build info', async () => {
    const { server, port } = await startRouter(
        adminConfig({ buildInfoPath: path.join(os.tmpdir(), 'fst-no-such-build-info.json') })
    );
    try {
        const res = await request(port, '/admin/api/diagnostics', {
            headers: { 'x-ms-client-principal': principalFor(ADMIN_EMAIL) },
        });
        assert.equal(res.status, 200);
        assert.equal(json(res).router.commit, null);
    } finally {
        await close(server);
    }
});

// ── Config contract ──────────────────────────────────────────────────────────

test('loadConfig reads the documented env-var contract', () => {
    const config = loadConfig({
        PORT: '3000',
        FUNCTION_APP_URL_JUDGEPAPERS: 'https://jp.example.net',
        PROXY_SHARED_SECRET_JUDGEPAPERS: 'jp',
        FUNCTION_APP_URL_SCOREMODIFIER: 'https://sm.example.net',
        PROXY_SHARED_SECRET_SCOREMODIFIER: 'sm',
        FUNCTION_APP_URL_PROTOCOLGENERATOR: 'https://pg.example.net',
        PROXY_SHARED_SECRET_PROTOCOLGENERATOR: 'pg',
        FUNCTION_APP_URL_PLATFORM: 'https://pf.example.net',
        PROXY_SHARED_SECRET_PLATFORM: 'pf',
        FUNCTION_APP_URL_GDPRTOOL: 'https://gdpr.example.net',
        PROXY_SHARED_SECRET_GDPRTOOL: 'gd',
    });
    assert.equal(config.port, 3000);
    assert.equal(config.targets.judgepapers.url, 'https://jp.example.net');
    assert.equal(config.targets.scoremodifier.secret, 'sm');
    assert.equal(config.targets.protocolgenerator.url, 'https://pg.example.net');
    assert.equal(config.targets.platform.secret, 'pf');
    assert.equal(config.targets.gdprtool.url, 'https://gdpr.example.net');
    assert.equal(config.targets.gdprtool.secret, 'gd');
    assert.equal(loadConfig({}).port, 8080);
    assert.ok(loadConfig({}).publicDir.endsWith(path.join('server', 'public')));
});
