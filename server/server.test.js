// Tests for the router server. Run with: node --test server/
// Zero dependencies — node:test, node:assert and the built-in http client only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createServer, loadConfig, buildCsp, CHANGELOG_MAX_ENTRIES } = require('./server.js');

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
            userRoles: ['authenticated'],
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
        assert.deepEqual(json(res), { authenticated: true, userDetails: 'fallback@example.com' });
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

        // Base policy: Google Fonts allowed everywhere.
        for (const csp of [rootCsp, jpCsp, pgCsp]) {
            assert.match(csp, /default-src 'self'/);
            assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
            assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
            assert.match(csp, /frame-ancestors 'none'/);
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

        assert.equal((await request(port, '/changelog-live?branch=test')).status, 502);
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

        // A different branch is cached separately.
        const other = await request(port, '/changelog-live?branch=test');
        assert.equal(other.status, 200);
        assert.equal(github.received.length, 4);
        assert.match(github.received[2].url, /sha=test/);
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
    });
    assert.equal(config.port, 3000);
    assert.equal(config.targets.judgepapers.url, 'https://jp.example.net');
    assert.equal(config.targets.scoremodifier.secret, 'sm');
    assert.equal(config.targets.protocolgenerator.url, 'https://pg.example.net');
    assert.equal(config.targets.platform.secret, 'pf');
    assert.equal(loadConfig({}).port, 8080);
    assert.ok(loadConfig({}).publicDir.endsWith(path.join('server', 'public')));
});
