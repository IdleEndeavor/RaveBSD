// Node entry point. Serves public/ and hands the API routes to the search core (sources.js).
//
// This file also owns everything that is saved or controlled on this machine:
//   /settings   user-agent mode and per-source logins (saved in DATA_DIR/settings.json)
//   /stats      local search and download counts (DATA_DIR/stats.json)
//   /browser/*  the Verify view for Anna's Archive (screenshots out, clicks in)
//   /health     used by the Docker healthcheck
// Environment: PORT (8080), DATA_DIR (./data), API_KEY, USER_AGENT_MODE, ZLIB_*, MOBILISM_*.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import core, { setUserAgentMode, setCreds, annasStatus, annasVerifyUrl, annasPageState, annasRecheck, zlibStatus, mobilismStatus } from './sources.js';
import { setProfileDir, ensureBrowser, startVerification, verificationFrame, verificationHtml, verificationInput, stopVerification } from './browser.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const PORT = Number(process.env.PORT) || 8080;
const SETTINGS_FILE = path.join(DATA, 'settings.json');

// Shown on the Backend page so it is clear which version is running. BUILD_ID is set by the image build.
let VERSION = '';
try { VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch (e) { /* no package.json */ }
const BUILD = (process.env.BUILD_ID || '').slice(0, 7);
setProfileDir(DATA);

// ── Settings (saved in DATA_DIR/settings.json; if that folder is read-only they stay in memory) ──
const settings = { statsEnabled: true, userAgentMode: process.env.USER_AGENT_MODE === 'rave' ? 'rave' : 'browser' };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) { /* first run */ }
setUserAgentMode(settings.userAgentMode);

// Per-source credentials: settings.json (written 0600, on this machine only) with env vars as defaults.
const SECRET_FIELDS = { annas: ['cookie', 'ua', 'mirror'], zlib: ['email', 'password', 'domain'], mobilism: ['username', 'password'] };
const ENV_CREDS = {
    zlib: { email: process.env.ZLIB_EMAIL, password: process.env.ZLIB_PASSWORD, domain: process.env.ZLIB_DOMAIN },
    mobilism: { username: process.env.MOBILISM_USER, password: process.env.MOBILISM_PASS },
};
const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
function applyCreds() {
    const out = {};
    for (const src of Object.keys(SECRET_FIELDS)) {
        const c = { ...clean(ENV_CREDS[src]), ...clean(settings.credentials && settings.credentials[src]) };
        if (Object.keys(c).length) out[src] = c;
    }
    setCreds(out);
    return out;
}
// What the UI may see: whether each source is set up, never the secrets themselves.
async function publicSettings() {
    const c = applyCreds();
    return {
        version: VERSION + (BUILD ? ' (' + BUILD + ')' : ''),
        statsEnabled: settings.statsEnabled,
        userAgentMode: settings.userAgentMode,
        sources: {
            annas: { ...(await annasStatus()), mirror: (c.annas && c.annas.mirror) || '' },
            zlib: { configured: !!(c.zlib && c.zlib.email && c.zlib.password), ...zlibStatus() },
            mobilism: { configured: !!(c.mobilism && c.mobilism.username && c.mobilism.password), ...mobilismStatus() },
        },
    };
}
applyCreds();

function writeJson(file, obj) {
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj), { mode: 0o600 }); fs.chmodSync(file, 0o600); } catch (e) { /* read-only volume: keep in memory */ }
}

// ── Local stats: counts only, stored on this machine, never sent anywhere ────
const STATS_FILE = path.join(DATA, 'stats.json');
let stats = { searches: { ebooks: 0, audiobooks: 0 }, downloadedBytes: 0, formats: {} };
try { stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); } catch (e) { /* first run */ }

function updateStats(b) {
    if (typeof b.enabled === 'boolean') {
        settings.statsEnabled = b.enabled;
        if (!b.enabled) b.reset = true; // switching off also deletes what is stored
        writeJson(SETTINGS_FILE, settings);
    }
    if (b.reset) stats = { searches: { ebooks: 0, audiobooks: 0 }, downloadedBytes: 0, formats: {} };
    else if (settings.statsEnabled && b.event === 'search' && (b.mode === 'ebooks' || b.mode === 'audiobooks')) stats.searches[b.mode]++;
    else if (settings.statsEnabled && b.event === 'download') {
        stats.downloadedBytes += Math.max(0, Number(b.size) || 0);
        const f = String(b.fmt || '').toLowerCase().slice(0, 10);
        if (/^[a-z0-9]+$/.test(f)) stats.formats[f] = (stats.formats[f] || 0) + 1;
    }
    writeJson(STATS_FILE, stats);
}

function saveSettings(patch) {
    if (patch.userAgentMode === 'browser' || patch.userAgentMode === 'rave') settings.userAgentMode = patch.userAgentMode;
    setUserAgentMode(settings.userAgentMode);
    if (patch.credentials && typeof patch.credentials === 'object') {
        settings.credentials = settings.credentials || {};
        for (const src of Object.keys(SECRET_FIELDS)) {
            if (!(src in patch.credentials)) continue;
            const v = patch.credentials[src];
            if (v === null) { delete settings.credentials[src]; continue; }
            // Only known fields, and blank fields keep their stored value so a partial form post cannot wipe a secret.
            const next = { ...(settings.credentials[src] || {}) };
            for (const f of SECRET_FIELDS[src]) if (typeof v[f] === 'string' && v[f].trim()) next[f] = v[f].trim().slice(0, 8000);
            settings.credentials[src] = next;
        }
    }
    writeJson(SETTINGS_FILE, settings);
    applyCreds();
}

// ── In-memory cache ──────────────────────────────────────────────────────────
// sources.js caches searches through caches.default (the Web Cache API). Node has no such thing, so this
// small stand-in keeps entries in memory until they expire.
const cacheStore = new Map();
const CACHE_MAX = 500;
globalThis.caches = {
    default: {
        async match(req) {
            const hit = cacheStore.get(req.url);
            if (!hit || hit.exp < Date.now()) { cacheStore.delete(req.url); return undefined; }
            return new Response(hit.body, { headers: hit.headers });
        },
        async put(req, res) {
            const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
            if (cacheStore.size >= CACHE_MAX) cacheStore.delete(cacheStore.keys().next().value);
            cacheStore.set(req.url, { body: await res.text(), headers: [...res.headers], exp: Date.now() + (m ? +m[1] : 60) * 1000 });
        },
    },
};

// ── HTTP ─────────────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const API = /^\/(search|api|resolve|dl|torrent)(\/|$)/;
const env = { API_KEY: process.env.API_KEY };
const ctx = { waitUntil: p => p.catch(() => {}), passThroughOnException() {} };

function serveStatic(urlPath, res) {
    const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
    // Keep personal instances out of search engines (public/robots.txt says the same).
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Robots-Tag': 'noindex, nofollow' });
    fs.createReadStream(file).pipe(res);
}

const body = req => new Promise(r => { let b = ''; req.on('data', c => { if (b.length < 32768) b += c; }); req.on('end', () => r(b)); });

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') { res.writeHead(200).end('ok'); return; }
    if (url.pathname === '/settings') {
        if (req.method === 'POST') { try { saveSettings(JSON.parse(await body(req))); } catch (e) { res.writeHead(400).end('bad json'); return; } }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(await publicSettings()));
        return;
    }
    // Remote verification of Anna's Archive: the user passes the site's human check themselves, from any device.
    if (url.pathname === '/browser/verify' && req.method === 'POST') {
        let b = {}; try { b = JSON.parse(await body(req) || '{}'); } catch (e) { /* default */ }
        let out;
        if (b.action === 'stop') { stopVerification(); out = { ok: true, solved: await annasRecheck() }; }
        else out = await startVerification(annasVerifyUrl());
        res.writeHead(out.ok ? 200 : 409, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
        return;
    }
    if (url.pathname === '/browser/frame') {
        const img = await verificationFrame();
        if (!img) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Check-State': annasPageState(await verificationHtml()) }).end(img);
        return;
    }
    if (url.pathname === '/browser/input' && req.method === 'POST') {
        let ok = false; try { ok = await verificationInput(JSON.parse(await body(req))); } catch (e) { /* bad json */ }
        res.writeHead(ok ? 200 : 400).end();
        return;
    }
    if (url.pathname === '/stats') {
        if (req.method === 'POST') { try { updateStats(JSON.parse(await body(req))); } catch (e) { res.writeHead(400).end('bad json'); return; } }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ enabled: settings.statsEnabled, ...stats }));
        return;
    }
    if (!API.test(url.pathname)) { serveStatic(url.pathname, res); return; }

    const r = await core.fetch(new Request(url, { method: req.method, headers: req.headers }), env, ctx);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (!r.body) { res.end(); return; }
    // Stream so the progress events of /search/all?stream=1 reach the page as they happen.
    for await (const chunk of r.body) res.write(chunk);
    res.end();
});

// A busy port is common (8080 especially), so explain how to pick another instead of crashing with a raw error.
server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Start RaveBSD with a free port, for example: PORT=${PORT + 1} npm start (with Docker, set PORT in .env).`);
    else console.error(e.message);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`RaveBSD ${VERSION} listening on :${PORT}`);
    ensureBrowser().catch(() => {}); // first run outside Docker: fetch the browser in the background
    // Everything RaveBSD saves (settings, stats, browser profile) lives in DATA_DIR. If it cannot be
    // written (for example a folder created by Docker as root), say so loudly instead of losing settings.
    try { fs.mkdirSync(DATA, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); }
    catch (e) { console.warn(`WARNING: ${DATA} is not writable, so settings and stats will not be saved. Fix the folder's owner (see README).`); }
});

// Playwright installs its own signal handlers that can keep the process alive; exit explicitly.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopVerification(); process.exit(0); });
