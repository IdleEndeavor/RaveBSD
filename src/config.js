// Everything RaveBSD saves about itself: settings (settings.json) and counts (stats.json), both in DATA_DIR.
// Files are written 0600 because settings hold logins. If the folder is read-only they stay in memory.
//
// Settings are one object of sections. DEFAULTS is the schema: a patch may only set keys that exist
// there, with the same type. SECRET keys are write-only, the page never gets them back.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TEMPLATES, primaryAuthor } from './rename.js';

export const DATA = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const STATS_FILE = path.join(DATA, 'stats.json');

const enc = encodeURIComponent;
// The "Still hungry? Try these too" sites. {q} is replaced by the search words.
export const DEFAULT_LINKS = {
    ebooks: [
        ['Z-Library', 'https://z-lib.gd/s/{q}'],
        ['Ocean of PDF', 'https://oceanofpdf.com/?s={q}'],
        ['Liber3', 'https://liber3.eth.limo/#/search?q={q}'],
        ['Standard Ebooks', 'https://standardebooks.org/ebooks?query={q}'],
        ['PDF Drive', 'https://www.pdfdrive.com/search?q={q}'],
        ['Manybooks', 'https://manybooks.net/search-book?search={q}'],
        ['Open Library', 'https://openlibrary.org/search?q={q}'],
        ['HathiTrust', 'https://babel.hathitrust.org/cgi/ls?q1={q};anyall1=phrase;lmt=ft'],
        ['Wikisource', 'https://en.wikisource.org/w/index.php?search={q}'],
        ['Feedbooks', 'https://www.feedbooks.com/search?query={q}'],
        ['Smashwords', 'https://www.smashwords.com/books/search?query={q}'],
        ['Faded Page', 'https://www.fadedpage.com/csearch.php?title={q}'],
        ['Planet eBook', 'https://www.planetebook.com/?s={q}'],
        ['Free-Ebooks.net', 'https://www.free-ebooks.net/search/{q}'],
        ['Bookshare', 'https://www.bookshare.org/search?keyword={q}'],
        ['DOAB', 'https://directory.doabooks.org/discover?query={q}'],
        ['Unglue.it', 'https://unglue.it/search/?q={q}'],
        ['Libby', 'https://libbyapp.com/search/query-{q}/page-1'],
        ['Hoopla', 'https://www.hoopladigital.com/search?q={q}'],
        ['BookBub', 'https://www.bookbub.com/search?search={q}'],
        ['Kobo', 'https://www.kobo.com/search?query={q}'],
        ['Google Books', 'https://www.google.com/search?tbm=bks&q={q}'],
        ['Baen Free Library', 'https://www.baen.com/catalogsearch/result/?q={q}'],
        ['Wattpad', 'https://www.wattpad.com/search/{q}'],
    ],
    audiobooks: [
        ['AudioAZ', 'https://audioaz.com/en/search?q={q}'],
        ['Tokybook', 'https://tokybook.com/?s={q}'],
        ['GoldenAudiobook', 'https://goldenaudiobook.net/?s={q}'],
        ['Fulllengthaudiobooks', 'https://fulllengthaudiobooks.net/?s={q}'],
        ['Hdaudiobooks', 'https://hdaudiobooks.net/?s={q}'],
        ['Archive.org audio', 'https://archive.org/search?query={q}&and[]=mediatype%3A%22audio%22'],
        ['Loyal Books', 'https://www.loyalbooks.com/search?q={q}'],
        ['Lit2Go', 'https://etc.usf.edu/lit2go/search/?q={q}'],
        ['Open Culture', 'https://www.openculture.com/?s={q}'],
        ['Libby', 'https://libbyapp.com/search/query-{q}/page-1'],
        ['Hoopla', 'https://www.hoopladigital.com/search?q={q}'],
        ['Audible', 'https://www.audible.com/search?keywords={q}'],
    ],
};
const toLinks = list => list.map(([name, url]) => ({ name, url }));

// Docker sets these to /books and /audiobooks. Outside Docker the shelves live next to the data.
const BOOKS_DIR = process.env.BOOKS_DIR || path.join(DATA, 'books');
const AUDIO_DIR = process.env.AUDIOBOOKS_DIR || path.join(DATA, 'audiobooks');

export const DEFAULTS = {
    setupDone: false,
    statsEnabled: true,
    userAgentMode: process.env.USER_AGENT_MODE === 'rave' ? 'rave' : 'browser',
    // mode: 'private' (one person, password optional), 'public' (open to the internet, the admin signs in for
    // anything beyond this browser's own settings), 'family' (everyone signs in; users and admins).
    access: { mode: 'private' },
    // Public instances: what one visitor may keep on the server, and for how long.
    visitors: { downloads: true, quotaMB: 2048, keepDays: 7, totalMB: 20000 },
    searching: { view: 'shelf', links: 'direct', length: 'unabridged' },
    saving: { allow: true, auto: false },
    storage: { removeAfterSaved: false, lowSpaceGB: 5 },
    notify: { onShelf: true, lowSpace: true },
    shelves: {
        ebookDir: BOOKS_DIR, audioDir: AUDIO_DIR,
        ebookTemplate: DEFAULT_TEMPLATES.ebook, audioTemplate: DEFAULT_TEMPLATES.audiobook,
        rename: true, tidy: true, keepMoved: true, duplicate: 'skip',
    },
    qbit: {
        enabled: true, url: 'http://qbittorrent:8080', username: '', password: '', category: 'ravebsd',
        mapFrom: '/downloads', mapTo: '/downloads', onFinish: 'copy', directSlots: 2,
    },
    vpn: { enabled: false, stopOnDrop: true, tellOnDrop: true, controlUrl: 'http://localhost:8000', apiKey: '' },
    system: { badges: true },
    sources: { off: [], slum: true },
    justLinks: { ebooks: toLinks(DEFAULT_LINKS.ebooks), audiobooks: toLinks(DEFAULT_LINKS.audiobooks) },
};
// Allowed values for the keys that are a choice.
const CHOICES = {
    'searching.view': ['shelf', 'list'], 'searching.links': ['any', 'direct'], 'searching.length': ['any', 'unabridged', 'abridged'],
    'shelves.duplicate': ['skip', 'both', 'replace'], 'qbit.onFinish': ['copy', 'move'], userAgentMode: ['browser', 'rave'],
};
const SECRET = { 'qbit.password': 1, 'vpn.apiKey': 1 };

const clone = o => JSON.parse(JSON.stringify(o));
export const settings = clone(DEFAULTS);
// Kept outside the schema: password hash, session secret, API keys and per-source logins.
// They are only changed through their own functions, never by a settings patch.
settings.secrets = { users: [], sessionSecret: '', apiKeys: [] };
settings.credentials = {};

// A saved file, or null on a first run. A damaged file is set aside as .corrupt-<time> and the last good copy
// (.bak) takes its name again, so the next start finds it too. Throws, leaving the file as it is, when it cannot
// be read at all (wrong owner, say) or is damaged with no good copy; e.damaged tells the two apart.
export function readJson(file) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return JSON.parse(text); } catch (e) {
        let bak;
        try { bak = JSON.parse(fs.readFileSync(file + '.bak', 'utf8')); } catch (e2) { throw Object.assign(new Error('the file is damaged'), { damaged: true }); }
        setAside(file);
        fs.copyFileSync(file + '.bak', file);
        console.warn(`${file} was damaged, so the previous copy (${path.basename(file)}.bak) is used.`);
        return bak;
    }
}
export function setAside(file) {
    const to = file + '.corrupt-' + Date.now();
    try { fs.renameSync(file, to); console.warn(`${file} could not be read and was moved to ${to}.`); } catch (e) { /* already gone */ }
}
// A saved file the server may not start without (it would start empty and then save over it).
export function cannotRead(file, e) {
    console.error(`${file} cannot be read (${e.message}). Fix or remove it, then start RaveBSD again.`);
    process.exit(1);
}

function load() {
    let saved;
    // Starting with the defaults would offer the first-run setup, and with it the admin account, to anyone.
    try { saved = readJson(SETTINGS_FILE); } catch (e) { cannotRead(SETTINGS_FILE, e); }
    if (!saved) return;
    // v1 files had statsEnabled, userAgentMode and credentials at the top. They carry over as they are.
    for (const k of Object.keys(DEFAULTS)) {
        if (!(k in saved)) continue;
        if (DEFAULTS[k] && typeof DEFAULTS[k] === 'object' && !Array.isArray(DEFAULTS[k])) Object.assign(settings[k], saved[k]);
        else settings[k] = saved[k];
    }
    if (saved.secrets) Object.assign(settings.secrets, saved.secrets);
    if (saved.credentials) settings.credentials = saved.credentials;
    // Earlier v2 files: one password (secrets.hash) becomes the admin account; access.public becomes public mode.
    const a = saved.access || {}, sec = settings.secrets;
    if (sec.hash && !sec.users.length && a.password !== false)
        sec.users.push({ id: 'admin', username: a.username || 'admin', role: 'admin', salt: sec.salt, hash: sec.hash, ver: 1, changedAt: sec.passwordChangedAt || 0, created: Date.now() });
    delete sec.hash; delete sec.salt; delete sec.passwordChangedAt;
    if (a.public) settings.access.mode = 'public';
    delete settings.access.public; delete settings.access.password; delete settings.access.username;
}
load();
// USER_AGENT_MODE, when set, wins over the saved choice (like PUBLIC_INSTANCE does for the mode).
export const userAgentForced = () => CHOICES.userAgentMode.includes(process.env.USER_AGENT_MODE);
if (userAgentForced()) settings.userAgentMode = process.env.USER_AGENT_MODE;

// Written to a temp file and flushed to disk before it replaces the old one, so a crash or power cut leaves the
// old file or the new one, never half of one. The old one stays as .bak (a hard link, so no copying).
const unsaved = new Set();
export function writeJson(file, obj) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        const fd = fs.openSync(tmp, 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (fs.existsSync(file)) {
            fs.rmSync(file + '.bak', { force: true });
            try { fs.linkSync(file, file + '.bak'); } catch (e) { fs.copyFileSync(file, file + '.bak'); } // no hard links on this volume
        }
        fs.renameSync(tmp, file);
        fs.chmodSync(file, 0o600);
        unsaved.delete(file);
    } catch (e) {
        // Read-only volume or full disk: kept in memory. Said once, not on every save.
        if (!unsaved.has(file)) console.warn(`Could not save ${file} (${e.code || e.message}). Changes stay in memory until it can be.`);
        unsaved.add(file);
    }
}
export const saveSettings = () => writeJson(SETTINGS_FILE, settings);

// PUBLIC_INSTANCE=1 fixes the mode to public, whatever is saved.
export const publicForced = () => process.env.PUBLIC_INSTANCE === '1';
export const accessMode = () => (publicForced() ? 'public' : ['private', 'public', 'family'].includes(settings.access.mode) ? settings.access.mode : 'private');
export const isPublic = () => accessMode() === 'public';

// Applies {section: {key: value}} from the page. Unknown keys, wrong types and bad choices are ignored.
// Returns the list of "section.key" names that changed.
export function patchSettings(patch) {
    const changed = [];
    if (!patch || typeof patch !== 'object') return changed;
    const setOne = (name, target, key, def, v) => {
        if (typeof v !== typeof def || (Array.isArray(def) !== Array.isArray(v))) return;
        if (CHOICES[name] && !CHOICES[name].includes(v)) return;
        if (typeof v === 'string') { v = v.trim().slice(0, 2000); if (SECRET[name] && !v) return; }
        if (typeof v === 'number' && !Number.isFinite(v)) return;
        if (name === 'qbit.directSlots') v = Math.min(6, Math.max(1, Math.round(v)));
        if (name === 'storage.lowSpaceGB') v = Math.min(100000, Math.max(0, Math.round(v)));
        if (name === 'visitors.quotaMB') v = Math.min(1e7, Math.max(1, Math.round(v)));
        if (name === 'visitors.keepDays') v = Math.min(365, Math.max(1, Math.round(v)));
        if (name === 'visitors.totalMB') v = Math.min(1e8, Math.max(1, Math.round(v)));
        if (name === 'sources.off') v = v.filter(x => typeof x === 'string').slice(0, 50);
        if (name.startsWith('justLinks.')) v = v.filter(l => l && typeof l.name === 'string' && /^https?:\/\/[^\s]+$/i.test(l.url || '') && l.url.includes('{q}'))
            .slice(0, 100).map(l => ({ name: l.name.trim().slice(0, 60), url: l.url.trim().slice(0, 1000) }));
        if (JSON.stringify(target[key]) === JSON.stringify(v)) return;
        target[key] = v;
        changed.push(name);
    };
    for (const [k, v] of Object.entries(patch)) {
        // setupDone only changes through /api/setup and restore: false would make everyone the admin again.
        if (!(k in DEFAULTS) || k === 'access' || k === 'setupDone' || (k === 'userAgentMode' && userAgentForced())) continue;
        const def = DEFAULTS[k];
        if (def && typeof def === 'object' && !Array.isArray(def)) {
            if (!v || typeof v !== 'object') continue;
            for (const [kk, vv] of Object.entries(v)) if (kk in def) setOne(k + '.' + kk, settings[k], kk, def[kk], vv);
        } else setOne(k, settings, k, def, v);
    }
    if (changed.length) saveSettings();
    return changed;
}

// What the page may see: everything except secrets, which become "is it set" flags.
export function publicSettings() {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = clone(settings[k]);
    out.qbit.password = ''; out.qbit.hasPassword = !!settings.qbit.password;
    out.vpn.apiKey = ''; out.vpn.hasApiKey = !!settings.vpn.apiKey;
    out.access.apiKeys = settings.secrets.apiKeys.map(({ id, label, prefix, suffix, created, lastUsed }) => ({ id, label, prefix, suffix, created, lastUsed: lastUsed || 0 }));
    out.access.mode = accessMode(); out.access.publicForced = publicForced();
    out.access.users = settings.secrets.users.map(({ id, username, role, changedAt, created }) => ({ id, username, role, changedAt: changedAt || 0, created }));
    out.userAgentForced = userAgentForced();
    out.defaults = { justLinks: DEFAULTS.justLinks }; // for "Reset to the original list"
    return out;
}

// ── Stats: counts only, per day, never sent anywhere ─────────────────────────
// days["2026-10-12"] = { ebook, audio, saved, bytes: {ebook, audio}, fmt: {epub: n}, authors: {name: n} }
export let stats = { days: {} };
try {
    const s = readJson(STATS_FILE);
    if (s && s.days) stats = s; // v1 stats (search counts) are not carried over: v2 counts downloads
} catch (e) { if (e.damaged) setAside(STATS_FILE); else cannotRead(STATS_FILE, e); } // damaged counts start again
const saveStats = () => writeJson(STATS_FILE, stats);

export function countDownload({ kind, format, bytes, author }) {
    if (!settings.statsEnabled) return;
    const day = new Date().toISOString().slice(0, 10);
    const d = stats.days[day] || (stats.days[day] = { ebook: 0, audio: 0, saved: 0, bytes: { ebook: 0, audio: 0 }, fmt: {}, authors: {} });
    const k = kind === 'audiobook' ? 'audio' : 'ebook';
    d[k]++;
    d.bytes[k] += Math.max(0, Number(bytes) || 0);
    const f = String(format || '').toLowerCase();
    if (/^[a-z0-9]{1,8}$/.test(f)) d.fmt[k + ':' + f] = (d.fmt[k + ':' + f] || 0) + 1;
    const a = primaryAuthor(author).trim().slice(0, 80);
    if (a) d.authors[a] = (d.authors[a] || 0) + 1;
    saveStats();
}
export function countSaved() {
    if (!settings.statsEnabled) return;
    const day = new Date().toISOString().slice(0, 10);
    const d = stats.days[day] || (stats.days[day] = { ebook: 0, audio: 0, saved: 0, bytes: { ebook: 0, audio: 0 }, fmt: {}, authors: {} });
    d.saved++; saveStats();
}
export function clearStats() { stats = { days: {} }; saveStats(); }
export function restoreStats(s) { if (s && s.days && typeof s.days === 'object') { stats = { days: s.days }; saveStats(); } }

// Totals for a period: 'all', 'year' or '30d'.
export function statsFor(period) {
    const since = period === 'year' ? new Date().getFullYear() + '-01-01'
        : period === '30d' ? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10) : '';
    const t = { ebook: 0, audio: 0, saved: 0, bytes: { ebook: 0, audio: 0 }, fmt: {}, authors: {} };
    for (const [day, d] of Object.entries(stats.days)) {
        if (day < since) continue;
        t.ebook += d.ebook; t.audio += d.audio; t.saved += d.saved;
        t.bytes.ebook += d.bytes.ebook; t.bytes.audio += d.bytes.audio;
        for (const [k, n] of Object.entries(d.fmt)) t.fmt[k] = (t.fmt[k] || 0) + n;
        for (const [k, n] of Object.entries(d.authors)) t.authors[k] = (t.authors[k] || 0) + n;
    }
    t.topAuthors = Object.entries(t.authors).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, n }));
    delete t.authors;
    // Bytes per day over the last 30 days, for the "at this pace" note on the storage card.
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    t.last30Bytes = Object.entries(stats.days).filter(([day]) => day >= monthAgo).reduce((s, [, d]) => s + d.bytes.ebook + d.bytes.audio, 0);
    return t;
}
