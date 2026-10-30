// Node entry point. Serves public/ (one page app), the search routes from sources.js, and the app API.
//
//   /health                     Docker healthcheck (always open)
//   /api/session, /api/login, /api/logout, /api/setup   who is signed in, first-run setup
//   /api/settings, /api/status  settings (secrets never returned) and live status for badges
//   /api/downloads, /api/jobs/*, /api/shelf/*, /files/<id>   downloads, the shelf, saving to a device
//   /api/stats, /api/backup, /api/restore, /api/keys, /api/password, /api/creds, /api/qbit/*, /api/vpn/*
//   /events                     server-sent events: jobs, shelf changes, notices
//   /search/*, /resolve, /torrent, /dl/*, /api/v1/search   search (sources.js)
//   /browser/*                  the Verify view for Anna's Archive
// With a password on, everything except /health, the session routes and the page files needs a session
// cookie; /api/v1/search takes an X-API-Key instead.
// Environment: PORT (8080), DATA_DIR (./data), BOOKS_DIR, AUDIOBOOKS_DIR, API_KEY, USER_AGENT_MODE, ZLIB_*, MOBILISM_*.
import http from 'node:http';
import zlib from 'node:zlib';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import core, { setUserAgentMode, setCreds, annasStatus, annasVerifyUrl, annasPageState, annasRecheck, zlibStatus, zlibVerifyUrl, zlibPageState, zlibRecheck, mobilismStatus,
    setResultDecorator, setSourcesOff, setSearchGate, sourceHealth, getResult, currentUA } from './sources.js';
import { setProfileDir, ensureBrowser, browserAvailable, restartBrowser, startVerification, verificationFrame, verificationHtml, verificationInput, stopVerification, reloadVerification, browserSandboxed } from './browser.js';
import { DATA, settings, saveSettings, patchSettings, publicSettings, isPublic, publicForced, accessMode, statsFor, clearStats, stats, restoreStats } from './config.js';
import * as auth from './auth.js';
import * as jobs from './jobs.js';
import * as qbit from './qbit.js';
import { vpn, checkVpn, switchExit, vpnBlocks, onVpnChange } from './vpn.js';
import { zipFolder, zipSize } from './zip.js';
import { refreshSlum, slumSummary } from './slum.js';
import { fetchPublic } from './netguard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const RENAME_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rename.js');
const PORT = Number(process.env.PORT) || 8080;

let VERSION = '';
try { VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch (e) { /* no package.json */ }
const BUILD = (process.env.BUILD_ID || '').slice(0, 7);
setProfileDir(DATA);

// ── Wiring settings into the search core ─────────────────────────────────────
const SECRET_FIELDS = { annas: ['cookie', 'ua', 'mirror'], zlib: ['email', 'password', 'domain'], mobilism: ['username', 'password'] };
const ENV_CREDS = {
    zlib: { email: process.env.ZLIB_EMAIL, password: process.env.ZLIB_PASSWORD, domain: process.env.ZLIB_DOMAIN },
    mobilism: { username: process.env.MOBILISM_USER, password: process.env.MOBILISM_PASS },
};
const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
function applyCreds() {
    const out = {};
    for (const src of Object.keys(SECRET_FIELDS)) {
        const c = { ...clean(ENV_CREDS[src]), ...clean(settings.credentials[src]) };
        if (Object.keys(c).length) out[src] = c;
    }
    setCreds(out);
    return out;
}
function applySettings() {
    setUserAgentMode(settings.userAgentMode);
    setSourcesOff(settings.sources.off);
    applyCreds();
}
applySettings();
setResultDecorator(jobs.decorateResult);
setSearchGate(() => (vpnBlocks() ? 'The VPN tunnel is down, so searching is paused until it is back' : ''));

// ── Libraries ────────────────────────────────────────────────────────────────
// The sources RaveBSD asks itself. kinds says which searches each one answers.
const LIBRARIES = [
    { id: 'libgen', name: 'LibGen', kinds: ['ebooks'] },
    { id: 'archive', name: 'Internet Archive', kinds: ['ebooks', 'audiobooks'] },
    { id: 'gutenberg', name: 'Project Gutenberg', kinds: ['ebooks'] },
    { id: 'openstax', name: 'OpenStax', kinds: ['ebooks'] },
    { id: 'libretexts', name: 'LibreTexts', kinds: ['ebooks'] },
    { id: 'memoryoftheworld', name: 'Memory of the World', kinds: ['ebooks'] },
    { id: 'royallib', name: 'RoyalLib', kinds: ['ebooks'] },
    { id: 'zlibrary', name: 'Z-Library', kinds: ['ebooks'] },
    { id: 'annas', name: "Anna's Archive", kinds: ['ebooks'] },
    { id: 'mobilism', name: 'Mobilism', kinds: ['ebooks', 'audiobooks'] },
    { id: 'audiobookbay', name: 'AudiobookBay', kinds: ['audiobooks'] },
    { id: 'librivox', name: 'LibriVox', kinds: ['audiobooks'] },
    { id: 'audiobooksbee', name: 'AudiobooksBee', kinds: ['audiobooks'] },
];

async function libraryStatus() {
    const c = applyCreds();
    const annas = await annasStatus();
    const zlib = zlibStatus(), mob = mobilismStatus();
    const zlibLogin = !!(c.zlib && c.zlib.email && c.zlib.password);
    const mobLogin = !!(c.mobilism && c.mobilism.username && c.mobilism.password);
    const off = new Set(settings.sources.off);
    const list = LIBRARIES.map(l => {
        let state = off.has(l.id) ? 'off' : 'ok';
        const h = sourceHealth[l.id];
        if (state === 'ok' && h) state = h.status === 'ok' ? 'ok' : h.status === 'timeout' ? 'slow' : h.status === 'unavailable' ? 'needsHuman' : 'error';
        if (l.id === 'annas' && state !== 'off' && annas.needsVerify) state = 'needsHuman';
        if (l.id === 'zlibrary' && state !== 'off') state = zlib.needsVerify ? 'needsHuman' : zlib.error && zlibLogin ? 'error' : zlibLogin ? state : 'guest';
        if (l.id === 'mobilism') state = !mobLogin ? 'off' : mob.error ? 'error' : off.has('mobilism') ? 'off' : state;
        return { ...l, state, ms: h ? h.ms : null };
    });
    return {
        list,
        annas: { needsVerify: annas.needsVerify, browser: annas.browser, cookie: annas.configured, expired: annas.expired, mirror: (c.annas && c.annas.mirror) || '' },
        zlib: { login: zlibLogin, email: (c.zlib && c.zlib.email) || '', error: zlib.error || '', needsVerify: zlib.needsVerify },
        mobilism: { login: mobLogin, username: (c.mobilism && c.mobilism.username) || '', error: mob.error || '' },
    };
}

// Everything the nav badges and banners need, in one small object.
// Non-admins get what their page needs and nothing about the server's libraries, folders or network.
async function status(me) {
    if (me && me.role !== 'admin') return {
        version: VERSION, mode: accessMode(), active: jobs.activeCount(me), attention: 0, needs: [], lowSpace: false,
        vpn: { enabled: settings.vpn.enabled, blocking: vpnBlocks() }, passwordOn: auth.passwordOn(), mirrors: slumSummary(),
    };
    const libs = await libraryStatus();
    const needs = libs.list.filter(l => l.state === 'needsHuman' || l.state === 'error');
    return {
        version: VERSION + (BUILD ? ' (' + BUILD + ')' : ''), mode: accessMode(),
        active: jobs.activeCount(me),
        attention: needs.length + (settings.vpn.enabled && settings.vpn.tellOnDrop && vpn.up === false ? 1 : 0),
        needs: needs.map(l => ({ id: l.id, name: l.name, state: l.state })),
        lowSpace: jobs.lowSpace,
        vpn: { enabled: settings.vpn.enabled, ...vpn, blocking: vpnBlocks() },
        passwordOn: auth.passwordOn(),
        mirrors: slumSummary(),
    };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const SECURITY = { 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const SEARCH = /^\/(search|resolve|dl|torrent)(\/|$)|^\/api\/v1\//;
const isStaticPage = (p, req) => req.method === 'GET' && !SEARCH.test(p) && !p.startsWith('/api/') && !p.startsWith('/files/') && !p.startsWith('/browser/') && p !== '/events' && p !== '/cover';
// What visitors and family users may reach. Everything else (settings changes, logins to libraries, folders,
// qBittorrent, VPN, backups, the server's browser, Z-Library's own download route) is for admins.
const OPEN = [
    [/^\/api\/(settings|status)$/, 'GET'], [/^\/api\/downloads$/, 'POST'], [/^\/api\/jobs\/[a-f0-9]+$/, 'DELETE'],
    [/^\/api\/jobs\/[a-f0-9]+\/retry$/, 'POST'], [/^\/api\/shelf$/, 'GET'], [/^\/api\/shelf\/delete$/, 'POST'],
    [/^\/api\/shelf\/[a-f0-9]+\/forget$/, 'POST'], [/^\/api\/me\/password$/, 'POST'], [/^\/api\/logout$/, 'POST'],
    [/^\/events$/, 'GET'], [/^\/files\/[a-f0-9]+$/, 'GET'], [/^\/cover$/, 'GET'],
    [/^\/search\/[a-z]+$/, 'GET'], [/^\/resolve$/, 'GET'], [/^\/torrent$/, 'GET'],
];
// Before setup whoever is here is the admin, so only what the setup page calls answers. An upgraded 1.x
// install's logins, backups and libraries stay out of reach until "Let's go".
const SETUP_OPEN = [[/^\/api\/settings$/, 'GET'], [/^\/api\/folders$/, 'POST'], [/^\/api\/qbit\/test$/, 'POST']];
// Scripts on other websites may call /api/v1 with a key.
const API_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-API-Key', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };

function serveStatic(urlPath, res, req) {
    if (urlPath === '/js/rename.js') return sendFile(RENAME_JS, res, req);
    let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
    // Page routes (/shelf, /settings, ...) all load the one page; it reads the address itself.
    if (!rel || !path.extname(rel)) rel = 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, SECURITY).end('Not found'); return; }
    sendFile(file, res, req);
}
// Page files are small: kept in memory with an ETag and a gzipped copy. Code and pages are revalidated on each
// load (cheap 304s, so updates show at once); fonts and images are cached for a week.
const fileCache = new Map();
function sendFile(file, res, req) {
    const st = fs.statSync(file);
    let hit = fileCache.get(file);
    if (!hit || hit.mtime !== st.mtimeMs) {
        const buf = fs.readFileSync(file);
        const type = TYPES[path.extname(file)] || 'application/octet-stream';
        const text = /^(text|application\/json)|javascript|svg/.test(type);
        hit = { mtime: st.mtimeMs, buf, gz: text && buf.length > 1024 ? zlib.gzipSync(buf) : null, type,
            etag: '"' + crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 20) + '"' };
        fileCache.set(file, hit);
    }
    const long = /\.(woff2|png|jpe?g|svg|ico)$/.test(file);
    const headers = { 'Content-Type': hit.type, ETag: hit.etag, 'Cache-Control': long ? 'public, max-age=604800' : 'no-cache', Vary: 'Accept-Encoding', ...SECURITY };
    if (req && req.headers['if-none-match'] === hit.etag) { res.writeHead(304, headers).end(); return; }
    const gzip = hit.gz && req && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { ...headers, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': (gzip ? hit.gz : hit.buf).length });
    res.end(gzip ? hit.gz : hit.buf);
}
const body = (req, max = 65536) => new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
});
const json = async (req, max) => { const t = await body(req, max); return t ? JSON.parse(t) : {}; };
const send = (res, code, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    const gzip = body.length > 2048 && res.req && /\bgzip\b/.test(res.req.headers['accept-encoding'] || '');
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...SECURITY, ...headers, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) }).end(gzip ? zlib.gzipSync(body) : body);
};
// Behind a reverse proxy every client shares the proxy's address; TRUST_PROXY=1 reads the client's from X-Forwarded-For.
// The last entry is the one the proxy added; earlier ones come from the client and can say anything.
const ipOf = req => (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',').pop().trim()) || req.socket.remoteAddress || '';
// Counts per key in a sliding window; true once the key went over its allowance.
const windows = new Map();
function limited(key, max, ms) {
    const now = Date.now(), w = windows.get(key);
    if (!w || w.until < now) { if (windows.size > 20000) for (const [k, v] of windows) if (v.until < now) windows.delete(k); windows.set(key, { n: 1, until: now + ms }); return false; }
    return ++w.n > max;
}
// DNS rebinding: a website points its own name at this server's address, and the browser then treats it as the
// same site. Where nobody signs in (private mode without a password, or before setup) only names a person would
// use here count: IP addresses, localhost, one-word and local names, and ALLOWED_HOSTS.
function hostTrusted(req) {
    const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!h || net.isIP(h) || h === 'localhost' || !h.includes('.')) return true;
    if (/\.(local|lan|home|home\.arpa|internal|localdomain|localhost|ts\.net)$/.test(h)) return true;
    return String(process.env.ALLOWED_HOSTS || '').toLowerCase().split(',').map(x => x.trim()).includes(h);
}
const secure = req => req.headers['x-forwarded-proto'] === 'https';
const fail = (res, e, code = 400) => send(res, code, { error: (e && e.message) || String(e) });

// ── Server-sent events ───────────────────────────────────────────────────────
// Each open page gets the events meant for it: its own jobs and finished downloads (visitors), and server
// warnings only for admins.
const clients = new Map(); // response -> { me, req }
// A page keeps its stream only while it is still the same person: a removed account, a new password, "sign out
// everywhere", an expired session or a mode change ends it, and the page reconnects as whoever it is now.
const sameAs = (req, me) => { const now = auth.who(req); return now.role === me.role && (now.user || {}).id === (me.user || {}).id && (now.vid || '') === (me.vid || ''); };
function dropStale() { for (const [c, { me, req }] of clients) if (!sameAs(req, me)) { clients.delete(c); c.end(); } }
jobs.events.on('event', ev => {
    for (const [c, { me }] of clients) {
        let out = ev;
        if (ev.type === 'jobs') out = { type: 'jobs', jobs: jobs.listJobs(me), active: jobs.activeCount(me) };
        else if (me.role === 'visitor' && (ev.type === 'done' || ev.type === 'failed') && !(ev.owners || []).includes(me.vid)) continue;
        else if (me.role !== 'admin' && ev.type === 'lowSpace') continue;
        const { owners, ...rest } = out;
        c.write(`data: ${JSON.stringify(rest)}\n\n`);
    }
});
// Downloads queued while the tunnel was down start once it is back.
onVpnChange(v => { jobs.events.emit('event', { type: 'vpn', up: v.up, error: v.error }); jobs.pump(); });
setInterval(() => { dropStale(); for (const c of clients.keys()) c.write(': ping\n\n'); }, 25e3).unref();

// What a non-admin's page may know of the settings: how searching and saving behave, never folders,
// addresses, logins or keys.
function viewSettings(me) {
    const all = publicSettings();
    // Setup only needs the folders, templates and qBittorrent's address.
    if (!settings.setupDone) {
        const { ebookDir, audioDir, ebookTemplate, audioTemplate } = all.shelves;
        return { access: { mode: all.access.mode, publicForced: all.access.publicForced }, shelves: { ebookDir, audioDir, ebookTemplate, audioTemplate }, qbit: { url: all.qbit.url } };
    }
    if (me.role === 'admin') return all;
    const { ebookTemplate, audioTemplate, rename, tidy } = all.shelves;
    return {
        access: { mode: all.access.mode }, searching: all.searching, saving: all.saving, notify: all.notify, justLinks: all.justLinks,
        visitors: all.visitors, qbit: { enabled: all.qbit.enabled, directSlots: all.qbit.directSlots }, sources: { slum: all.sources.slum },
        system: { badges: all.system.badges }, vpn: { enabled: all.vpn.enabled, tellOnDrop: all.vpn.tellOnDrop }, storage: { lowSpaceGB: all.storage.lowSpaceGB },
        shelves: { ebookTemplate, audioTemplate, rename, tidy },
    };
}
// A shelf item as a non-admin sees it: its place inside the shelf, not on the disk.
function viewItem(i, me) {
    const { owners, fp, ...rest } = i;
    const out = { ...rest };
    if (me.role !== 'admin') {
        const root = path.resolve(i.kind === 'audiobook' ? settings.shelves.audioDir : settings.shelves.ebookDir);
        out.path = path.relative(root, path.resolve(i.path));
        // Family users see who added a book; visitors never see account names.
        if (out.addedBy) out.addedBy = me.role === 'visitor' ? { type: out.addedBy.type } : { type: out.addedBy.type, name: out.addedBy.name || '' };
        if (me.role === 'visitor') { const o = (owners || []).find(x => x.id === me.vid); out.savedAt = o ? o.savedAt : 0; out.heldSince = o ? o.at : 0; }
    }
    return out;
}

// ── Routes ───────────────────────────────────────────────────────────────────
async function api(req, res, url, me) {
    const p = url.pathname, m = req.method;
    let mm;

    if (p === '/api/settings') {
        if (m === 'POST') {
            const changed = patchSettings(await json(req));
            applySettings();
            if (changed.some(c => c.startsWith('qbit.'))) qbit.forgetSession();
            // More slots, or the VPN no longer holding them back, start waiting downloads now.
            if (changed.includes('qbit.directSlots') || changed.some(c => c.startsWith('vpn.'))) jobs.pump();
            if (changed.includes('statsEnabled') && !settings.statsEnabled) clearStats(); // "deletes what was counted"
            if (changed.includes('vpn.enabled') && settings.vpn.enabled) checkVpn();
            if (changed.includes('sources.slum') && settings.sources.slum) await refreshSlum();
            if (changed.some(c => c === 'storage.lowSpaceGB' || c.endsWith('Dir'))) await jobs.checkSpace();
        }
        return send(res, 200, viewSettings(me));
    }
    if (p === '/api/status') return send(res, 200, await status(me));
    if (p === '/api/libraries') return send(res, 200, await libraryStatus());
    if (p === '/api/slum' && m === 'POST') { await refreshSlum(); return send(res, 200, slumSummary()); }

    // Private mode's single login ("Ask for a password"). The other modes manage accounts below.
    if (p === '/api/password' && m === 'POST') {
        const b = await json(req);
        if (b.on === false && accessMode() !== 'private') return fail(res, 'Public and friends and family modes need an admin account');
        if (b.on === false) { auth.clearPassword(); return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() }); }
        try { const u = auth.setPassword(b.username, b.password); return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(u, secure(req)) }); }
        catch (e) { return fail(res, e); }
    }
    if (p === '/api/mode' && m === 'POST') {
        const b = await json(req);
        if (publicForced()) return fail(res, 'PUBLIC_INSTANCE=1 is set on the server, so it stays public');
        if (!['private', 'public', 'family'].includes(b.mode)) return fail(res, 'Unknown mode');
        if (b.mode !== 'private' && !auth.hasAdmin()) return fail(res, 'Make an admin account first');
        settings.access.mode = b.mode; saveSettings();
        return send(res, 200, publicSettings());
    }
    if (p === '/api/users' && m === 'POST') {
        const b = await json(req);
        try { auth.addUser(b.username, b.password, b.role); return send(res, 200, publicSettings()); } catch (e) { return fail(res, e); }
    }
    if ((mm = p.match(/^\/api\/users\/([a-z0-9]+)$/)) && m === 'DELETE') {
        try { auth.removeUser(mm[1]); return send(res, 200, publicSettings()); } catch (e) { return fail(res, e); }
    }
    if ((mm = p.match(/^\/api\/users\/([a-z0-9]+)\/password$/)) && m === 'POST') {
        const b = await json(req);
        try { auth.setUserPassword(mm[1], b.password); return send(res, 200, publicSettings()); } catch (e) { return fail(res, e); }
    }
    // Anyone with an account changes their own password; their other sessions end, this one carries on.
    if (p === '/api/me/password' && m === 'POST') {
        if (!me.user) return fail(res, 'Sign in first', 401);
        const b = await json(req);
        if (!auth.checkLogin(me.user.username, b.current)) return fail(res, 'The current password is not right', 403);
        try { const u = auth.setUserPassword(me.user.id, b.password); return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(u, secure(req)) }); }
        catch (e) { return fail(res, e); }
    }
    // Admins only (not in OPEN). This browser gets a fresh session so the admin who asked stays signed in.
    if (p === '/api/sessions/end' && m === 'POST') {
        auth.signOutEverywhere();
        const u = me.user && settings.secrets.users.find(x => x.id === me.user.id);
        return send(res, 200, { ok: true }, u ? { 'Set-Cookie': auth.sessionCookie(u, secure(req)) } : {});
    }
    if (p === '/api/keys' && m === 'POST' && isPublic()) return fail(res, 'API keys are off on a public instance', 403);
    if (p === '/api/keys' && m === 'POST') { const b = await json(req); return send(res, 200, auth.makeApiKey(b.label)); }
    if (p.startsWith('/api/keys/') && m === 'DELETE') { auth.revokeApiKey(p.slice(10)); return send(res, 200, { ok: true }); }

    // Per-source logins. Blank fields keep their stored value, null removes the login.
    if (p === '/api/creds' && m === 'POST') {
        const b = await json(req);
        for (const src of Object.keys(SECRET_FIELDS)) {
            if (!(src in b)) continue;
            if (b[src] === null) { delete settings.credentials[src]; continue; }
            const next = { ...(settings.credentials[src] || {}) };
            for (const f of SECRET_FIELDS[src]) if (typeof b[src][f] === 'string' && b[src][f].trim()) next[f] = b[src][f].trim().slice(0, 8000);
            settings.credentials[src] = next;
        }
        saveSettings(); applyCreds();
        return send(res, 200, await libraryStatus());
    }

    if (p === '/api/folders' && m === 'POST') {
        const b = await json(req);
        const out = {};
        for (const k of ['ebookDir', 'audioDir']) out[k] = await jobs.freeSpace(path.resolve(String(b[k] || settings.shelves[k])));
        return send(res, 200, out);
    }

    if (p === '/api/qbit/test' && m === 'POST') {
        const b = await json(req);
        // Setup tests the values it was given without saving them; an empty body tests the saved ones.
        // The saved login is only sent to the saved address.
        let over = null;
        if (b && typeof b === 'object' && Object.keys(b).length) {
            const q = settings.qbit, str = v => (typeof v === 'string' ? v.trim() : '');
            const url = str(b.url) || q.url, same = url === q.url;
            over = { url, username: str(b.username) || (same ? q.username : ''), password: str(b.password) || (same ? q.password : '') };
        }
        try { return send(res, 200, { ok: true, ...(await qbit.testConnection(over)) }); }
        catch (e) { return send(res, 200, { ok: false, error: e.cause && e.cause.code ? 'Could not reach it' : e.message }); }
    }
    if (p === '/api/vpn/check' && m === 'POST') return send(res, 200, await checkVpn());
    if (p === '/api/vpn/switch' && m === 'POST') { try { return send(res, 200, await switchExit()); } catch (e) { return fail(res, e, 502); } }

    if (p === '/api/downloads' && m === 'POST') {
        const b = await json(req);
        try { return send(res, 200, await jobs.startDownload(String(b.resultId || ''), b.clientId, me)); } catch (e) { return fail(res, e); }
    }
    if ((mm = p.match(/^\/api\/jobs\/([a-f0-9]+)$/)) && m === 'DELETE') { await jobs.cancel(mm[1], me); return send(res, 200, { ok: true }); }
    if ((mm = p.match(/^\/api\/jobs\/([a-f0-9]+)\/retry$/)) && m === 'POST') { try { return send(res, 200, jobs.retry(mm[1], me)); } catch (e) { return fail(res, e); } }

    if (p === '/api/shelf') {
        jobs.checkMoved();
        const items = jobs.listShelf(me).map(i => {
            const f = jobs.fileFor(i);
            return { ...viewItem(i, me), available: !!f, saveSize: f && f.isDir ? zipSize(f.path, path.basename(f.path)) : i.size };
        });
        // Visitors see their own room; everyone else the disk's.
        if (me.role === 'visitor') return send(res, 200, { items, jobs: jobs.listJobs(me), mine: { used: jobs.visitorUsage(me.vid), quota: settings.visitors.quotaMB * 1e6, keepDays: settings.visitors.keepDays } });
        const [e, a] = await Promise.all([jobs.freeSpace(path.resolve(settings.shelves.ebookDir)), jobs.freeSpace(path.resolve(settings.shelves.audioDir))]);
        return send(res, 200, { items, jobs: jobs.listJobs(me), space: { ebook: e, audiobook: a }, lowSpace: me.role === 'admin' && jobs.lowSpace });
    }
    if (p === '/api/shelf/delete' && m === 'POST') { const b = await json(req); return send(res, 200, { deleted: await jobs.deleteItems((b.ids || []).map(String), me) }); }
    if ((mm = p.match(/^\/api\/shelf\/([a-f0-9]+)\/forget$/)) && m === 'POST') { jobs.forget(mm[1], me); return send(res, 200, { ok: true }); }

    if (p === '/api/stats') {
        if (m === 'DELETE') { clearStats(); return send(res, 200, { ok: true }); }
        const period = ['all', 'year', '30d'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'all';
        const [e, a] = await Promise.all([jobs.freeSpace(path.resolve(settings.shelves.ebookDir)), jobs.freeSpace(path.resolve(settings.shelves.audioDir))]);
        return send(res, 200, { enabled: settings.statsEnabled, period, ...statsFor(period), shelf: jobs.shelfBytes(), disk: e.total >= a.total ? e : a, sameDisk: e.total === a.total && Math.abs(e.free - a.free) < 1e9 });
    }

    if (p === '/api/backup') {
        const data = { app: 'RaveBSD', version: VERSION, at: new Date().toISOString(), settings, stats, shelf: jobs.shelfBackup() };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="ravebsd-backup-${new Date().toISOString().slice(0, 10)}.json"`, ...SECURITY });
        return res.end(JSON.stringify(data, null, 1));
    }
    if (p === '/api/restore' && m === 'POST') {
        const b = await json(req, 20e6);
        if (b.app !== 'RaveBSD' || !b.settings) return fail(res, 'That is not a RaveBSD backup');
        const { secrets, credentials, ...rest } = b.settings;
        // The shelf list is checked against the folders as they were before this restore, so a backup cannot
        // point the shelf (and so downloads and deletes) at a folder of its own choosing.
        jobs.shelfRestore(b.shelf);
        patchSettings(rest);
        if (credentials) settings.credentials = credentials;
        if (secrets) Object.assign(settings.secrets, secrets);
        // The access mode is not a plain setting (patchSettings skips it). Public and family need an admin.
        const mode = rest.access && rest.access.mode;
        if (!publicForced() && ['private', 'public', 'family'].includes(mode) && (mode === 'private' || auth.hasAdmin())) settings.access.mode = mode;
        settings.setupDone = true;
        saveSettings(); applySettings();
        restoreStats(b.stats);
        return send(res, 200, { ok: true });
    }

    if (p === '/api/update') {
        const num = (a, b) => a.localeCompare(b, undefined, { numeric: true });
        try {
            const gh = async p => { const r = await fetch('https://api.github.com/repos/IdleEndeavor/RaveBSD/' + p, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; };
            // No releases yet (404): the highest version tag says it instead.
            let tag = String(((await gh('releases/latest')) || {}).tag_name || '');
            if (!tag) tag = ((await gh('tags')) || []).map(t => String(t.name || '')).filter(n => /^v?\d+(\.\d+)*$/.test(n)).sort((a, b) => num(b.replace(/^v/, ''), a.replace(/^v/, '')))[0] || '';
            const latest = tag.replace(/^v/, '');
            if (!latest) return send(res, 200, { current: VERSION, error: 'Could not tell which version is the latest' });
            return send(res, 200, { current: VERSION, latest, newer: latest !== VERSION && num(latest, VERSION) > 0 });
        } catch (e) { return send(res, 200, { current: VERSION, error: 'Could not reach GitHub' }); }
    }
    if (p === '/api/connection') {
        const t0 = Date.now();
        try { await fetch('https://www.gutenberg.org/robots.txt', { method: 'HEAD', signal: AbortSignal.timeout(6000) }); return send(res, 200, { online: true, ms: Date.now() - t0 }); }
        catch (e) { return send(res, 200, { online: false }); }
    }
    if (p === '/api/browser' && m === 'GET') return send(res, 200, { ready: await browserAvailable(), sandboxed: browserSandboxed() });
    if (p === '/api/browser/restart' && m === 'POST') return send(res, 200, { ready: await restartBrowser() });

    return send(res, 404, { error: 'Unknown endpoint' });
}

// The one verification view can show either site's check.
const CHECK_SITES = { annas: { url: annasVerifyUrl, state: annasPageState, recheck: annasRecheck }, zlibrary: { url: zlibVerifyUrl, state: zlibPageState, recheck: zlibRecheck } };
let checkSite = CHECK_SITES.annas;
async function browserRoutes(req, res, url) {
    if (url.pathname === '/browser/verify' && req.method === 'POST') {
        let b = {}; try { b = await json(req); } catch (e) { /* default */ }
        if (b.action === 'reload') return send(res, 200, { ok: await reloadVerification() });
        if (b.action !== 'stop') checkSite = CHECK_SITES[b.site] || CHECK_SITES.annas;
        const out = b.action === 'stop' ? (stopVerification(), { ok: true, solved: await checkSite.recheck() }) : await startVerification(await checkSite.url(), { phone: !!b.phone });
        return send(res, out.ok ? 200 : 409, out);
    }
    if (url.pathname === '/browser/frame') {
        const f = await verificationFrame({ full: url.searchParams.get('full') === '1' });
        if (!f) { res.writeHead(404).end(); return; }
        const a = f.area;
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Check-State': checkSite.state(await verificationHtml()), 'X-Area': `${a.x},${a.y},${a.width},${a.height}` }).end(f.img);
        return;
    }
    if (url.pathname === '/browser/input' && req.method === 'POST') {
        let ok = false; try { ok = await verificationInput(await json(req)); } catch (e) { /* bad json */ }
        res.writeHead(ok ? 200 : 400).end();
        return;
    }
    res.writeHead(404).end();
}

// Covers are fetched by the server and passed on, so the page can read their colours and the sites never
// see who is browsing. Only result or shelf ids come in, never a URL. Kept in memory, a few hundred at most.
const covers = new Map();
let coverBytes = 0;
const COVER_BYTES_MAX = 40e6;
async function sendCover(res, url, me) {
    const id = url.searchParams.get('id') || '', sid = url.searchParams.get('shelf') || '';
    const item = sid && jobs.getItem(sid);
    if (item && !jobs.canSee(me, item)) { res.writeHead(404).end(); return; }
    const src = sid ? (item || {}).coverUrl : (getResult(id) || {}).coverUrl;
    if (!src || !/^https?:\/\//i.test(src)) { res.writeHead(404).end(); return; }
    let hit = covers.get(src);
    if (!hit) {
        try {
            const r = await fetchPublic(src, { headers: { 'User-Agent': currentUA(), Accept: 'image/*' }, signal: AbortSignal.timeout(8000) });
            const type = r.headers.get('content-type') || '';
            const buf = Buffer.from(await r.arrayBuffer());
            if (!r.ok || !/^image\/(jpeg|png|webp|gif|avif)/.test(type) || buf.length > 3e6) throw new Error('not an image');
            hit = { type, buf };
        } catch (e) { hit = { missing: true }; }
        covers.set(src, hit);
        coverBytes += hit.buf ? hit.buf.length : 0;
        // Oldest first, until under the size limit (about 40 MB) and 300 covers.
        while (covers.size > 300 || coverBytes > COVER_BYTES_MAX) {
            const [k, v] = covers.entries().next().value;
            covers.delete(k); coverBytes -= v.buf ? v.buf.length : 0;
        }
    }
    if (hit.missing) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'private, max-age=3600', ...SECURITY }).end(hit.buf);
}

// Sends a shelf item to the device: the file itself, or a zip for an audiobook folder.
function sendShelfFile(req, res, id, url, me) {
    if (!settings.saving.allow) return fail(res, 'Saving to devices is switched off in the admin panel', 403);
    const item = jobs.getItem(id);
    if (item && !jobs.canSee(me, item)) return fail(res, 'That file is not on the server any more', 404);
    const f = jobs.fileFor(item);
    if (!f) return fail(res, 'That file is not on the server any more', 404);
    const base = path.basename(f.path);
    const name = f.isDir ? base + '.zip' : base;
    const disp = `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
    const done = () => { if (!res.destroyed || res.writableFinished) jobs.markSaved(item, me); };
    if (f.isDir) {
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': zipSize(f.path, base), 'Content-Disposition': disp, ...SECURITY });
        zipFolder(f.path, res, base).then(() => { res.end(); done(); }, () => res.destroy());
        return;
    }
    const size = fs.statSync(f.path).size;
    // Ranges let a phone resume a big download instead of starting over.
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
        let start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}`, ...SECURITY }).end(); return; }
        res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Disposition': disp, ...SECURITY });
        fs.createReadStream(f.path, { start, end }).on('end', () => { if (end === size - 1) done(); }).pipe(res);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Content-Disposition': disp, ...SECURITY });
    fs.createReadStream(f.path).on('end', done).pipe(res);
}

// Without a password, the only thing stopping another website from changing settings or deleting books is
// that browsers say where a request comes from. Anything that changes something must come from this page.
function crossSite(req) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return false;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return true;
    const origin = req.headers.origin;
    if (!origin) return false;
    let host; try { host = new URL(origin).host; } catch (e) { return true; }
    const own = [req.headers.host, process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-host']].filter(Boolean).map(h => String(h).split(',')[0].trim());
    return !own.includes(host);
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
        if (p === '/health') { res.writeHead(200).end('ok'); return; }
        if (crossSite(req)) return fail(res, 'Requests from other sites are not allowed', 403);

        const me = auth.who(req);
        if (me.role === 'visitor') me.ip = ipOf(req);
        if (me.role === 'admin' && !me.user && !hostTrusted(req) && !isStaticPage(p, req))
            return fail(res, `RaveBSD only answers to "${String(req.headers.host).replace(/:\d+$/, '')}" once a password is on. Open it by its IP address or local name, or add the name to ALLOWED_HOSTS.`, 403);
        // Who is here, and is setup done. Always open so the page can show setup or the sign-in box.
        // A visitor on a public instance gets their id here, on their first visit.
        if (p === '/api/session') {
            const headers = {};
            // At most 10 new visitor ids per address an hour, so a fresh cookie is not a fresh space allowance.
            if (me.role === 'visitor' && !me.vid && limited(`id|${me.ip}`, 10, 3600e3)) return fail(res, 'Too many new visits from this address. Try again later.', 429);
            if (me.role === 'visitor' && !me.vid) headers['Set-Cookie'] = auth.newVisitorCookie(secure(req)).cookie;
            return send(res, 200, { setupDone: settings.setupDone, mode: accessMode(), role: me.role, signedIn: me.role !== 'none',
                passwordOn: auth.passwordOn(), username: me.user ? me.user.username : '' }, headers);
        }
        if (p === '/api/login' && req.method === 'POST') {
            const ip = ipOf(req);
            const b = await json(req);
            const who = ip + '|' + String(b.username || '').trim().toLowerCase();
            if (!auth.loginAllowed(who)) return fail(res, 'Too many tries. Wait a few minutes.', 429);
            const u = auth.checkLogin(b.username, b.password);
            if (!u) { auth.noteFailedLogin(who); return fail(res, 'That username and password do not match', 401); }
            if (u.role !== 'admin' && accessMode() !== 'family') return fail(res, 'That account is for friends and family mode, which is off right now', 403);
            return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(u, secure(req)) });
        }
        if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });

        // First run: only possible while setup has not been done, so nobody can redo it later to take over.
        if (p === '/api/setup' && req.method === 'POST') {
            if (settings.setupDone) return fail(res, 'Setup is already done', 409);
            const b = await json(req);
            const headers = {};
            const mode = publicForced() ? 'public' : ['private', 'public', 'family'].includes(b.mode) ? b.mode : 'private';
            const admin = b.admin || (b.password && b.password.on ? b.password : null);
            if (mode !== 'private' && !admin) return fail(res, 'This mode needs an admin account');
            if (admin) {
                try { headers['Set-Cookie'] = auth.sessionCookie(auth.setPassword(admin.username, admin.password), secure(req)); } catch (e) { return fail(res, e); }
            } else auth.clearPassword();
            patchSettings({ shelves: b.shelves || {}, qbit: b.qbit || {} });
            settings.access.mode = mode;
            settings.setupDone = true;
            saveSettings(); applySettings();
            dropStale();
            return send(res, 200, { ok: true }, headers);
        }
        if (!settings.setupDone && !isStaticPage(p, req) && !SETUP_OPEN.some(([re, meth]) => re.test(p) && meth === req.method)) return fail(res, 'Finish setting up RaveBSD first', 403);

        if (p.startsWith('/api/v1/')) {
            if (isPublic()) return fail(res, 'The API is off on a public instance', 404);
            // The browser's check before a script on another website sends its key.
            if (req.method === 'OPTIONS') { res.writeHead(204, { ...API_CORS, ...SECURITY }).end(); return; }
            // A key is needed whenever keys are in use, unless someone is signed in. Private mode without a
            // password makes everyone an admin, so the role alone does not say a key was given.
            if (auth.apiNeedsKey() && !me.user && !auth.apiKeyOk(req)) return send(res, 401, { error: 'Missing or invalid X-API-Key' }, API_CORS);
        }
        if (isStaticPage(p, req)) { serveStatic(p, res, req); return; }
        if (!p.startsWith('/api/v1/') && me.role === 'none') return fail(res, 'Sign in first', 401);
        if (me.role !== 'admin' && !p.startsWith('/api/v1/') && !OPEN.some(([re, meth]) => re.test(p) && (!meth || meth === req.method))) return fail(res, 'Only an admin can do that', 403);

        // Visitors share the server's libraries and its address's standing with them: 30 searches per 5 minutes each.
        if (me.role === 'visitor' && p.startsWith('/search/') && limited(`s|${me.ip}`, 30, 300e3)) return fail(res, 'That is a lot of searching. Wait a few minutes.', 429);
        if (p === '/events') {
            if (me.role === 'visitor' && [...clients.values()].filter(c => c.me.vid === me.vid).length >= 4) return fail(res, 'Too many open pages', 429);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY });
            res.write(`data: ${JSON.stringify({ type: 'hello', jobs: jobs.listJobs(me), active: jobs.activeCount(me) })}\n\n`);
            clients.set(res, { me, req });
            req.on('close', () => clients.delete(res));
            return;
        }
        if (p.startsWith('/files/')) return sendShelfFile(req, res, p.slice(7), url, me);
        if (p === '/cover') return sendCover(res, url, me);
        if (p.startsWith('/browser/')) return browserRoutes(req, res, url);
        if (p.startsWith('/api/') && !p.startsWith('/api/v1/')) {
            // Changes to accounts, sessions or the mode come through here; open pages catch up at once, even when
            // the change failed halfway (a restore).
            try { await api(req, res, url, me); } finally { if (req.method !== 'GET') dropStale(); }
            return;
        }

        const r = await core.fetch(new Request(url, { method: req.method, headers: req.headers }), {}, { waitUntil: q => q.catch(() => {}), passThroughOnException() {} });
        // Other websites may read the scripting API (/api/v1, key-protected), not the page's own search routes.
        const hdrs = Object.fromEntries(r.headers);
        if (!p.startsWith('/api/v1/')) for (const k of Object.keys(hdrs)) if (k.startsWith('access-control-')) delete hdrs[k];
        res.writeHead(r.status, { ...hdrs, ...SECURITY });
        if (!r.body) { res.end(); return; }
        // Streamed so the progress events of /search/all?stream=1 reach the page as they happen. Answers are cached
        // for 10 minutes and for everyone, so "On the shelf" (a visitor's own), running downloads and file names
        // are put right on the way out. Files (/torrent) pass through untouched.
        if (!/json/.test(hdrs['content-type'] || '')) { for await (const chunk of r.body) res.write(chunk); res.end(); return; }
        const fix = line => {
            if (!line.trim()) return line;
            try {
                const o = JSON.parse(line);
                const mark = x => { if (x && x.id) Object.assign(x, jobs.liveMarks(me, getResult(x.id) || x)); };
                for (const list of [o.results, o.final && o.final.results]) if (Array.isArray(list)) list.forEach(mark);
                if (p === '/resolve') mark(o);
                return JSON.stringify(o);
            } catch (e) { return line; }
        };
        let buf = '';
        const dec = new TextDecoder(); // a character split between two chunks stays whole
        for await (const chunk of r.body) {
            buf += dec.decode(chunk, { stream: true });
            let i;
            while ((i = buf.indexOf('\n')) >= 0) { res.write(fix(buf.slice(0, i)) + '\n'); buf = buf.slice(i + 1); }
        }
        buf += dec.decode();
        if (buf) res.write(fix(buf));
        res.end();
    } catch (e) {
        if (!res.headersSent) fail(res, e.message === 'too big' ? 'Too much data' : e instanceof SyntaxError ? 'Bad JSON' : e, 400);
        else res.end();
    }
});

// ── In-memory cache ──────────────────────────────────────────────────────────
// sources.js caches searches through caches.default (the Web Cache API). Node has none, so this stand-in
// keeps entries in memory until they expire. Searches are never written to disk.
const cacheStore = new Map();
const CACHE_MAX = 500, CACHE_BYTES_MAX = 60e6;
let cacheBytes = 0;
globalThis.caches = {
    default: {
        async match(req) {
            const hit = cacheStore.get(req.url);
            if (!hit || hit.exp < Date.now()) { if (hit) { cacheBytes -= hit.body.length; cacheStore.delete(req.url); } return undefined; }
            return new Response(hit.body, { headers: hit.headers });
        },
        async put(req, res) {
            const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
            const body = await res.text();
            const old = cacheStore.get(req.url); if (old) { cacheBytes -= old.body.length; cacheStore.delete(req.url); }
            cacheStore.set(req.url, { body, headers: [...res.headers], exp: Date.now() + (m ? +m[1] : 60) * 1000 });
            cacheBytes += body.length;
            while (cacheStore.size > CACHE_MAX || cacheBytes > CACHE_BYTES_MAX) {
                const [k, v] = cacheStore.entries().next().value;
                cacheStore.delete(k); cacheBytes -= v.body.length;
            }
        },
    },
};

server.on('error', e => {
    if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Start RaveBSD with a free port, for example: PORT=${PORT + 1} npm start (with Docker, set PORT in .env).`);
    else console.error(e.message);
    process.exit(1);
});

server.listen(PORT, () => {
    console.log(`RaveBSD ${VERSION} listening on :${PORT}`);
    ensureBrowser().catch(() => {});
    if (settings.vpn.enabled) checkVpn();
    refreshSlum();
    try { fs.mkdirSync(DATA, { recursive: true }); fs.accessSync(DATA, fs.constants.W_OK); }
    catch (e) { console.warn(`WARNING: ${DATA} is not writable, so settings and the shelf will not be saved. Fix the folder's owner (see README).`); }
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopVerification(); process.exit(0); });
