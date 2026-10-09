// RaveBSD search core. Runs on plain Node and is called by src/server.js.
//
// What is in this file, top to bottom:
//   helpers         fetch with a timeout, mirror ranking, result scoring
//   sources         one section each (LibGen, Anna's Archive, ...) with a searchX() and often a resolveX()
//   merge and rank  combines every source's results into one list
//   runFullSearch   runs all sources at once and reports progress
//   router          the HTTP routes (the default export)
//
// HTTP routes:
//   /search/<source>?q=&mode=ebooks|audiobooks   one source
//   /search/all?q=&mode=...                      every source, merged and ranked (stream=1 for live progress)
//   /api/v1/search                               same as /search/all, with an optional X-API-Key
//   /resolve?id=                                 find the direct download link for one result
//   /dl/zlib?id=&hash=                           redirect to a Z-Library file (counts toward the account's daily limit)
//   /torrent?id=                                 the .torrent file for a resolved magnet result, from public torrent caches
//
// Adding a source:
//   1. Write searchX(query, mode) that returns an array of results. Use get() for requests, and catch
//      errors and return [] so one broken site never breaks a search.
//   2. A result has: title, author, year, format, filesize (bytes), language, source (display name),
//      downloadUrl, coverUrl. Optional: directUrl (a real file link), pageUrl (the source's own page, when
//      downloadUrl is the file itself), magnet, infoHash, md5.
//   3. If the real file link needs another request, add a case to resolveOne() so the page can fetch it later.
//   4. Add it to runFullSearch() and its meta counts, and to the source lists in public/index.html
//      (META_SOURCE_LABELS, sourceLabel, ADV_SOURCES). Add a test for any parsing you wrote.
// RaveBSD never hosts or stores files. It searches public sites and passes on the links they publish.

import { browserGet, browserAvailable, verifyWindowOpen } from './browser.js';

const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // X-API-Key is a non-simple header, so cross-origin callers need it allowed for the preflight.
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Content-Type':                 'application/json',
    // nosniff blocks a JSON response ever being reinterpreted as HTML/script.
    // no-referrer keeps query text out of any Referer header.
    'X-Content-Type-Options':       'nosniff',
    'Referrer-Policy':              'no-referrer',
};

// ── API key ─────────────────────────────────────────────────────────────────
// Constant-time compare for the optional API key.
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// Optional. When API_KEY is set, /api/v1/search requires it as X-API-Key.
const apiKeyOk = (request, env) => !env.API_KEY || timingSafeEqual(request.headers.get('X-API-Key') || '', env.API_KEY);

// Cover images and links scraped from other sites are only used if they are http(s) URLs.
// Otherwise a listing could point a cover at an attacker's host and track the person searching.
function isHttpUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u);
}

// Mirror lists. Domains change often, so these are fixed lists that rankMirrors() reorders by health.
// Last checked 2026-10-02: every LibGen mirror answered. annas-archive.li is a parked page and the other
// Anna's mirrors show a bot check (see searchAnnas).
const LIBGEN_MIRRORS = ['https://libgen.li', 'https://libgen.bz', 'https://libgen.gl', 'https://libgen.la', 'https://libgen.vg'];
const ANNAS_MIRRORS  = ['https://annas-archive.gl', 'https://annas-archive.pk', 'https://annas-archive.gd'];

// Remembers which hosts have been failing. After 3 failures in a row a host is skipped for 5 minutes.
// avgMs is a running average of response time, so faster hosts are tried first.
const hostHealth = new Map(); // host -> { fails, coolUntil, avgMs }
const HOST_COOLDOWN_MS = 5 * 60 * 1000;
function noteHost(host, ok, ms, reason) {
    const h = hostHealth.get(host) || { fails: 0, coolUntil: 0, avgMs: null };
    if (ok) { h.fails = 0; h.avgMs = h.avgMs == null ? ms : h.avgMs * 0.7 + ms * 0.3; }
    else {
        if (reason) h.lastFailure = reason; // shown by mirrorDebug()
        if (++h.fails >= 3) { h.coolUntil = Date.now() + HOST_COOLDOWN_MS; h.fails = 0; }
    }
    hostHealth.set(host, h);
}

// Takes a mirror list and returns it best first: hosts on cooldown are dropped, hosts with known fast
// responses go first, and ties keep the list order. Never returns an empty list.
export function rankMirrors(staticList, health, now = Date.now()) {
    const ok = staticList
        .map((u, i) => ({ host: u.replace(/^https:\/\//, ''), i }))
        .filter(({ host }) => { const h = health.get(host); return !(h && h.coolUntil > now); });
    if (!ok.length) return staticList.slice();
    ok.sort((a, b) => {
        const la = (health.get(a.host) || {}).avgMs, lb = (health.get(b.host) || {}).avgMs;
        if ((la == null) !== (lb == null)) return la == null ? 1 : -1;
        if (la != null && la !== lb) return la - lb;
        return a.i - b.i;
    });
    return ok.map(({ host }) => 'https://' + host);
}

async function orderedMirrors(service, staticList) {
    return rankMirrors(staticList, hostHealth);
}

// Asks mirrors for the same page, `hedge` at a time, best first, and returns the first good response.
// validate(text) returns true (good), 'challenged' (a bot check page, not an outage) or false.
// Slower requests are not cancelled, they just time out. Resolves { mirror, text }, or
// { mirror: null, challengedAll } when none worked.
export function fetchFirstValid(mirrors, buildUrl, validate, { ms = 7000, hedge = 2, headers = {} } = {}) {
    const attempt = async m => {
        const t0 = Date.now(), host = m.replace(/^https:\/\//, '');
        try {
            const res = await get(buildUrl(m), ms, headers);
            const text = await res.text();
            const v = validate(text, res);
            if (v === true) noteHost(host, true, Date.now() - t0);
            else if (v !== 'challenged') noteHost(host, false, 0, `HTTP ${res.status}, ${text.length} bytes: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
            return { v, text };
        } catch (e) { noteHost(host, false, 0, `${e && e.name || 'error'} after ${Date.now() - t0}ms: ${String(e && e.message || e).slice(0, 80)}`); return { v: false }; }
    };
    return new Promise(resolve => {
        let next = 0, active = 0, tried = 0, challenged = 0, done = false;
        const launch = () => {
            if (next >= mirrors.length) return false;
            const m = mirrors[next++];
            active++; tried++;
            attempt(m).then(r => {
                active--;
                if (done) return;
                if (r.v === true) { done = true; return resolve({ mirror: m, text: r.text }); }
                if (r.v === 'challenged') challenged++;
                if (!launch() && active === 0) { done = true; resolve({ mirror: null, challengedAll: tried > 0 && challenged === tried }); }
            });
            return true;
        };
        if (!mirrors.length) return resolve({ mirror: null, challengedAll: false });
        for (let i = 0; i < hedge && launch(); i++);
    });
}

export function mirrorDebug() {
    return {
        health: Object.fromEntries(hostHealth),
        annasBlockedUntil: annasBlockedUntil ? new Date(annasBlockedUntil).toISOString() : null,
    };
}

const FORMAT_SCORE = {
    epub: 40, mobi: 30, fb2: 25, azw3: 25,
    djvu: 15, pdf: 10, cbz: 5, cbr: 5,
    doc: 2, docx: 2, txt: 1,
    m4b: 35, mp3: 20, m4a: 20, flac: 15, aac: 15,
};

// ── Helpers ────────────────────────────────────────────────────────────────

const ok  = d    => new Response(JSON.stringify(d), { headers: CORS });
const err = (m,s)=> new Response(JSON.stringify({ error: m, results: [] }), { status: s||500, headers: CORS });

// Browser User-Agent by default, because many sources refuse unknown ones. USER_AGENT_MODE=rave (or the
// setting on the Backend page) switches every request to an honest RaveBSD identifier.
export const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
export const RAVE_UA = 'RaveBSD/0.1 (+https://github.com/IdleEndeavor/RaveBSD)';
let uaMode = 'browser';
export const setUserAgentMode = m => { uaMode = m === 'rave' ? 'rave' : 'browser'; };
export const currentUA = () => (uaMode === 'rave' ? RAVE_UA : BROWSER_UA);

// Per-source access the user supplies in settings or env: { annas: {cookie, ua, mirror},
// zlib: {email, password, domain}, mobilism: {username, password} }. Only ever sent to that source.
export const creds = {};
export const setCreds = c => { for (const k of Object.keys(creds)) delete creds[k]; Object.assign(creds, c || {}); };

export async function get(url, ms = 7000, extra = {}, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const r = await fetch(url, {
            signal: ctrl.signal,
            headers: {
                'User-Agent': currentUA(),
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                'Accept-Language': 'en-US,en;q=0.5',
                ...extra,
            },
            ...init,
        });
        // Keep the timer running while the body is read. Clearing it at the headers let a mirror that sends
        // its body slowly hang text()/json() forever.
        ['text', 'json', 'arrayBuffer'].forEach(m => {
            const orig = r[m].bind(r);
            r[m] = () => orig().finally(() => clearTimeout(t));
        });
        return r;
    } catch(e) { clearTimeout(t); throw e; }
}

// Resolves to fallback if p hasn't settled in ms, so one slow source drops
// out of a merged result instead of holding up the rest.
export const withDeadline = (p, ms, fallback) =>
    Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

// Cache in front of expensive routes. produce() returns [response, cacheable]. Failed or empty results are
// never cached, so a temporary outage does not stick. edgeGet/edgePut use the caches.default shim that
// src/server.js defines.
const edgeCache = () => (typeof caches !== 'undefined' ? caches.default : null);

async function edgeGet(keyUrl) {
    const cache = edgeCache();
    if (!cache) return null;
    try { return (await cache.match(new Request(keyUrl))) || null; } catch (e) { return null; }
}

function edgePut(keyUrl, ctx, ttlSec, res) {
    const cache = edgeCache();
    if (!cache) return;
    const copy = new Response(res.clone().body, { headers: res.headers });
    copy.headers.set('Cache-Control', 'public, max-age=' + ttlSec);
    ctx.waitUntil(cache.put(new Request(keyUrl), copy).catch(() => {}));
}

export async function withEdgeCache(keyUrl, ctx, ttlSec, produce) {
    const hit = await edgeGet(keyUrl);
    if (hit) return hit;
    const [res, cacheable] = await produce();
    // cacheable can be a number: a shorter lifetime in seconds for a weaker result
    if (cacheable) edgePut(keyUrl, ctx, typeof cacheable === 'number' ? cacheable : ttlSec, res);
    return res;
}

function strip(s) {
    return (s || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&#39;/g,  "'")
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
        .replace(/\s+/g, ' ')
        .trim();
}

// Turns a number and unit (KB, MB, GB, or k, m, g) into bytes. LibGen, Anna's and AudiobookBay each write
// the unit a little differently. Unknown units are treated as KB.
export function parseFilesizeBytes(numStr, unitStr) {
    const n = parseFloat(numStr);
    const u = (unitStr || '').trim().toLowerCase().charAt(0);
    return u === 'g' ? n * 1e9 : u === 'm' ? n * 1e6 : n * 1e3;
}

// LibGen's title cell packs the series, edition, ISBNs, a format badge and (for comics) image sizes into one
// <td>. This pulls the ISBN out (it is shown in the description line), drops the badge and size noise,
// splits the rest on <br> and removes repeats (the series and the title often say the same thing).
// title="..." attributes are stripped first because they can contain a literal "<br>".
function parseLibgenTitleCell(titleCell) {
    let isbn = '';
    const isbnMatch = titleCell.match(/<font color="green">\s*([^<]+)<\/font>/i);
    if (isbnMatch) isbn = isbnMatch[1].split(';')[0].trim();

    const cleaned = titleCell
        .replace(/\stitle="[^"]*"/gi, '')
        .replace(/<nobr>[\s\S]*?<\/nobr>/gi, '')
        .replace(/<font size=1[^>]*>[\s\S]*?<\/font>/gi, '')
        .replace(/<font color="green">[\s\S]*?<\/font>/gi, '');

    const segments = [];
    cleaned.split(/<br\s*\/?>/i).forEach(seg => {
        const t = strip(seg);
        if (!t) return;
        const lower = t.toLowerCase();
        for (let j = segments.length - 1; j >= 0; j--) {
            const kLower = segments[j].toLowerCase();
            if (lower.includes(kLower))      segments.splice(j, 1); // seg supersedes a shorter kept one
            else if (kLower.includes(lower)) return;                // seg is redundant, skip it
        }
        segments.push(t);
    });

    return { title: segments.join(' · '), isbn };
}

// Lowercase, punctuation stripped, spaces collapsed, so "Hollywood, Ending"
// and "hollywood ending" compare equal.
const normText = t => (t || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Share of the query's words found in the title or author. It lets "hollywood ending john green" rank
// the real match above loosely related results.
export function tokenCoverage(r, q) {
    const words = normText(q).split(' ').filter(w => w.length > 1);
    if (!words.length) return 0;
    const hay = ' ' + normText((r.title || '') + ' ' + (r.author || '')) + ' ';
    return words.filter(w => hay.includes(' ' + w + ' ')).length / words.length;
}

export function scoreResult(r, q) {
    let s = 0;
    const fmt  = (r.format   || '').toLowerCase();
    const ttl  = normText(r.title);
    const qn   = normText(q);
    s += FORMAT_SCORE[fmt] || 0;
    // No language bonus: an English bonus used to push English editions up even for foreign-language
    // searches (for example "storia follia"). Title match, format and year already rank well.
    if (ttl === qn)              s += 60;
    else if (ttl.startsWith(qn)) s += 40;
    else if (ttl.includes(qn))   s += 20;
    else {
        const cov = tokenCoverage(r, q);
        s += Math.round(cov * 50);
        if (cov === 1) s += 15;
    }
    if (parseInt(r.filesize || 0) > 50000) s += 5;
    if (r.year && parseInt(r.year) > 0)    s += 3;
    // +8 makes up for the filesize and year bonuses above, which these sources do not supply.
    // +6 nudges openly licensed sources above shadow libraries when scores tie. It is small next to the
    // 20-60 point title-match bonuses.
    if (r.source === 'Project Gutenberg' || r.source === 'OpenStax' || r.source === 'LibreTexts') s += 14;
    return s;
}

// ── LibGen ──────────────────────────────────────────────────────────────────
// ── LibGen ──────────────────────────────────────────────────────────────────
// Searches libgen.li's /index.php. Results are in <table id="tablelibgen"> with row cells:
// [cover] title, author, publisher, year, language, pages, size, extension, mirror links.
// The download page is /ads.php?md5=HASH (resolveLibgenLinks reads the real link from it).

async function searchLibgen(query, mode) {
    const params = new URLSearchParams();
    params.append('req', query);
    params.append('columns[]', 't'); // title
    params.append('columns[]', 'a'); // author
    // f=file e=edition s=series a=author p=publisher w=work
    ['f','e','s','a','p','w'].forEach(o => params.append('objects[]', o));
    // l=libgen c=comics f=fiction a=articles m=magazines r=fictionRUS s=standards
    const topics = mode === 'audiobooks' ? ['a','m'] : ['l','c','f','a','m','r','s'];
    topics.forEach(t => params.append('topics[]', t));
    // 50 not 25: a new or common-titled book (e.g. "Hollywood, Ending", 2026) can sit
    // past LibGen's first 25 rows for its own exact title; 50 is one request still.
    params.append('res', '50');
    params.append('filesuns', 'all');

    const found = await fetchFirstValid(
        await orderedMirrors('libgen', LIBGEN_MIRRORS),
        m => `${m}/index.php?${params}`,
        text => text.includes('tablelibgen'),
        { headers: { 'Cookie': 'covers=on' }, hedge: 3, ms: 15000 }
    );
    const html = found.text;
    const mirror = found.mirror;

    if (!html) return [];

    const tStart = html.indexOf('id="tablelibgen"');
    const tEnd   = html.indexOf('</table>', tStart);
    if (tStart === -1 || tEnd === -1) return [];
    const table = html.slice(tStart, tEnd + 8);

    const results = [];

    // rows[0] is the table's own opening tag, rows[1] is the <th> header row
    const rows = table.split(/<tr[\s>]/i);

    for (let i = 2; i < rows.length; i++) {
        const row = rows[i];
        if (!row.includes('<td')) continue;

        // cells[0] is whatever precedes the first <td>, discard it
        const cells = row.split(/<td[^>]*>/i);
        if (cells.length < 9) continue;

        const firstCell = cells[1] || '';
        const hasCover  = /covers/.test(firstCell);
        const o = hasCover ? 1 : 0;

        // Relative thumbnail path, e.g. /covers/0/MD5-s.jpg or
        // /fictioncovers/1234000/MD5.jpg. Made absolute, used as-is.
        let coverUrl = '';
        if (hasCover) {
            const imgMatch = firstCell.match(/src="([^"]+)"/i);
            if (imgMatch) {
                const src = imgMatch[1];
                const absolute = /^https?:\/\//i.test(src) ? src : mirror + src;
                coverUrl = isHttpUrl(absolute) ? absolute : '';
            }
        }

        const titleCell = cells[1 + o] || '';
        const idMatch = titleCell.match(/href="[^"]*\?id=(\d+)/);
        if (!idMatch) continue;
        const bookId = idMatch[1];

        const { title: rawTitle, isbn } = parseLibgenTitleCell(titleCell);
        if (!rawTitle) continue;

        const author    = strip(cells[2 + o] || '');
        const publisher = strip(cells[3 + o] || '');
        const year      = strip(cells[4 + o] || '').replace(/\D/g, '');
        const language  = strip(cells[5 + o] || '');
        const pages     = strip(cells[6 + o] || '').replace(/\D/g, '');
        const size      = strip(cells[7 + o] || '');
        const ext       = strip(cells[8 + o] || '').toLowerCase();

        const mirrorCell = cells[9 + o] || '';
        const md5Match   = mirrorCell.match(/[?&]md5=([a-fA-F0-9]{32})/i);
        const md5 = md5Match ? md5Match[1].toUpperCase() : '';

        let filesize = 0;
        const szM = size.match(/([\d.]+)\s*(k|m|g)b?/i);
        if (szM) filesize = parseFilesizeBytes(szM[1], szM[2]);

        if (!md5 && !bookId) continue;

        // No fallback cover guess: fictioncovers/ vs covers/ path can't be
        // known without extra metadata, so coverUrl only comes from the table.

        results.push({
            title:       rawTitle,
            author:      author.slice(0, 100),
            publisher,
            year:        year.slice(0, 4),
            language,
            pages:       pages === '0' ? '' : pages,
            isbn,
            filesize,
            format:      ext,
            source:      'Library Genesis',
            downloadUrl: md5
                ? `${mirror}/ads.php?md5=${md5}`
                : `${mirror}/index.php?id=${bookId}`,
            md5,
            coverUrl,
        });
    }

    return results;
}

// The ads.php page has a button linking to get.php?md5=HASH&key=KEY. We fetch ads.php for a result, read
// the key and build the direct URL. It tries a few mirrors, separate from the search mirror, because any
// mirror that serves ads.php will do.
async function resolveLibgenLinks(results, topN = 8) {
    const adsMirrors = (await orderedMirrors('libgen', LIBGEN_MIRRORS)).slice(0, 3);

    const toResolve = results.slice(0, topN).filter(r => r.md5);
    await Promise.allSettled(toResolve.map(async r => {
        for (const adsMirror of adsMirrors) {
            try {
                const adsUrl = `${adsMirror}/ads.php?md5=${r.md5.toLowerCase()}`;
                const res = await get(adsUrl, 5000);
                if (!res.ok) continue;
                const html = await res.text();
                const keyMatch = html.match(/get\.php\?md5=[a-f0-9]+&(?:amp;)?key=([A-Za-z0-9]+)/i);
                if (keyMatch) {
                    r.directUrl   = `${adsMirror}/get.php?md5=${r.md5.toLowerCase()}&key=${keyMatch[1]}`;
                    r.directReady = true;
                    break;
                }
            } catch(e) { /* try next mirror */ }
        }
    }));
    return results;
}

// ── RoyalLib ────────────────────────────────────────────────────────────────
// The site's live search only matches the start of a title (the query "hobbit" misses "The Hobbit"), so we
// POST the real search page instead. It lists titles and authors but no downloads, so
// resolveRoyalLibLinks() opens each book page for its formats, sizes and cover (same two steps as LibGen).
async function searchRoyalLib(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const res = await get('https://royallib.com/search/', 7000, {
            'Content-Type': 'application/x-www-form-urlencoded',
        }, {
            method: 'POST',
            body: `to=result&q=${encodeURIComponent(query)}`,
        });
        if (!res.ok) return [];
        const html = await res.text();

        // Books card: <li> rows of pp-btitle (link) + pp-bauthor (title attr or link text)
        const secStart = html.indexOf('id="pp-books"');
        if (secStart === -1) return [];
        const secEnd = html.indexOf('</ul>', secStart);
        if (secEnd === -1) return [];
        const section = html.slice(secStart, secEnd);

        const results = [];
        const rowRe = /href="(?:\/\/royallib\.com)?(\/book\/[^"]+)\.html"[^>]*data-rl-id="(\d+)"[^>]*>([^<]+)<\/a>[\s\S]*?class="pp-bauthor"[^>]*>(?:<a[^>]*>)?([^<]*)/g;
        let m;
        while ((m = rowRe.exec(section)) && results.length < 20) {
            const [, bookPath, , rawTitle, rawAuthor] = m;
            const title = strip(rawTitle);
            if (!title) continue;
            results.push({
                title,
                author:      strip(rawAuthor),
                format:      '',
                filesize:    0,
                source:      'RoyalLib',
                downloadUrl: `https://royallib.com${bookPath}.html`,
                coverUrl:    '',
                _bookPath:   bookPath,
            });
        }
        return results;
    } catch(e) { return []; }
}

const ROYALLIB_FORMAT_PREFS = ['epub', 'fb2', 'doc', 'rtf', 'txt', 'html'];

// "Кб"/"кб"/"Мб"/"мб" -> parseFilesizeBytes's expected k/m unit char.
export function royallibUnitChar(cyrillic) {
    const c = (cyrillic || '').trim().charAt(0).toLowerCase();
    return c === 'м' ? 'm' : c === 'г' ? 'g' : 'k';
}

// Every format link on a book page answers 200, even for formats that do not exist (the "error" is an
// HTML page). So directUrl is only set from formats actually listed on the book's page, never guessed.
async function resolveRoyalLibLinks(results, topN = 8) {
    const toResolve = results.slice(0, topN).filter(r => r._bookPath);
    await Promise.allSettled(toResolve.map(async r => {
        try {
            const res = await get(`https://royallib.com${r._bookPath}.html`, 7000);
            if (!res.ok) return;
            const html = await res.text();

            // The format spans come after the bv-dl-h label (not inside it), so the block ends at the
            // next section, bv-side, instead of the first </div>.
            const dlStart = html.indexOf('bv-dl-h');
            if (dlStart !== -1) {
                let dlEnd = html.indexOf('bv-side', dlStart);
                if (dlEnd === -1) dlEnd = dlStart + 3000;
                const dlBlock = html.slice(dlStart, dlEnd);
                const found = {};
                const fmtRe = /href="(?:\/\/royallib\.com)?(\/get\/([a-z0-9]+)\/[^"]+\.zip)"[^>]*>[^<]*<\/a><span class="bv-sz">\(([\d.]+)\s*([^)]+)\)/g;
                let fm;
                while ((fm = fmtRe.exec(dlBlock))) {
                    const [, href, fmt, sizeNum, unit] = fm;
                    found[fmt] = { href, sizeNum, unit };
                }
                for (const fmt of ROYALLIB_FORMAT_PREFS) {
                    if (found[fmt]) {
                        r.directUrl   = `https://royallib.com${found[fmt].href}`;
                        r.format      = fmt;
                        r.directReady = true;
                        r.filesize    = parseFilesizeBytes(found[fmt].sizeNum, royallibUnitChar(found[fmt].unit));
                        break;
                    }
                }
            }

            const coverMatch = html.match(/class="bv-cover"[^>]*src="(\/\/[^"]+)"/);
            if (coverMatch) {
                const absolute = 'https:' + coverMatch[1];
                if (isHttpUrl(absolute)) r.coverUrl = absolute;
            }
        } catch(e) { /* leave unresolved, downloadUrl still works */ }
    }));
    return results;
}

// ── Anna's Archive ──────────────────────────────────────────────────────────
// Each result: <div class="flex pt-3 pb-3 border-b ...">, containing a cover
// link, a title link (<a href="/md5/HASH" class="...js-vim-focus...">), an
// author link, and a metadata line "English [en] · EPUB · 0.5MB · 2008 · ...".

// Anna's mirrors show a DDoS-Guard bot check, even from home connections, and it can escalate to a human
// check that RaveBSD never tries to solve. Ways past it, in order: the background browser (it remembers a
// check you passed in the Verify view), or a Cookie header pasted into settings (tied to the mirror, IP
// and User-Agent, and it expires). When nothing works Anna's is skipped for 10 minutes and shown as unavailable.
let annasBlockedUntil = 0;
let annasExpired = false;
const ANNAS_BLOCK_MS = 10 * 60 * 1000;
const ANNAS_PROBE_MS = 30 * 1000;
const isDdosGuard = t => /<title>DDoS-Guard|\/\.well-known\/ddos-guard\//i.test(t);
let annasNeedsVerify = false;
export const annasStatus = async () => ({
    configured: !!(creds.annas && creds.annas.cookie),
    expired: annasExpired && !!(creds.annas && creds.annas.cookie),
    needsVerify: annasNeedsVerify,
    browser: await browserAvailable(),
    verifyOpen: verifyWindowOpen(),
});
// Verification starts on a search page: that is where the site's check appears, the home page is not gated.
export const annasVerifyUrl = () => ((creds.annas && creds.annas.mirror) || ANNAS_MIRRORS[0]).replace(/\/+$/, '') + '/search?q=dune';
// 'solved' (real results), 'captcha' (a human check is showing), or 'loading'.
export const annasPageState = html =>
    html.includes('ddg-captcha') ? 'captcha'
    : ((html.includes('js-vim-focus') || html.includes('/md5/')) && !isDdosGuard(html)) ? 'solved' : 'loading';

// Called when the user finishes remote verification: did the check actually pass?
export async function annasRecheck() {
    const html = await browserGet(annasVerifyUrl(), {
        timeoutMs: 15000,
        isReady: t => (t.includes('js-vim-focus') || t.includes('/md5/')) && !isDdosGuard(t) || t.includes('ddg-captcha'),
    });
    const solved = !!html && !html.includes('ddg-captcha') && !isDdosGuard(html);
    annasNeedsVerify = !solved;
    if (solved) annasBlockedUntil = 0;
    return solved;
}

async function searchAnnas(query, mode) {
    const unavailable = () => Object.assign([], { unavailable: true });
    if (Date.now() < annasBlockedUntil) return unavailable();
    // Claim the probe slot so concurrent searches don't all probe at once.
    if (annasBlockedUntil) annasBlockedUntil = Date.now() + ANNAS_PROBE_MS;

    const a = creds.annas && creds.annas.cookie ? creds.annas : null;
    const mirrors = a ? [(a.mirror || ANNAS_MIRRORS[0]).replace(/\/+$/, '')] : await orderedMirrors('annas', ANNAS_MIRRORS);
    const headers = a ? { Cookie: a.cookie, ...(a.ua ? { 'User-Agent': a.ua } : {}) } : {};
    const extra = mode === 'audiobooks' ? '&ext=mp3&ext=m4b&ext=aac' : '';
    const found = await fetchFirstValid(
        mirrors,
        m => `${m}/search?q=${encodeURIComponent(query)}${extra}`,
        // Absence of the result markers on a non-challenge page means a parked
        // or error page, not zero results.
        text => (text.includes('js-vim-focus') || text.includes('/md5/')) ? true : (isDdosGuard(text) ? 'challenged' : false),
        { ms: 8000, headers }
    );
    if (found.mirror) { annasBlockedUntil = 0; annasExpired = false; annasNeedsVerify = false; return parseAnnasHtml(found.text, found.mirror); }
    if (found.challengedAll && !verifyWindowOpen()) {
        // Plain fetch is challenged: try the background browser, whose profile remembers a check the user
        // already passed. The code never tries to solve a human check itself.
        const mirror = mirrors[0];
        const html = await browserGet(`${mirror}/search?q=${encodeURIComponent(query)}${extra}`, {
            timeoutMs: 15000,
            isReady: t => (t.includes('js-vim-focus') || t.includes('/md5/')) && !isDdosGuard(t) || t.includes('ddg-captcha'),
        });
        if (html && !html.includes('ddg-captcha') && !isDdosGuard(html)) { annasBlockedUntil = 0; annasExpired = false; annasNeedsVerify = false; return parseAnnasHtml(html, mirror); }
        annasNeedsVerify = !!html;
    }
    if (found.challengedAll) { if (a) annasExpired = true; annasBlockedUntil = Date.now() + ANNAS_BLOCK_MS; return unavailable(); }
    annasBlockedUntil = 0; // plain outage, not a challenge: try again next search
    return [];
}

function parseAnnasHtml(html, mirror) {
    const results = [];

    // Pattern for title anchor:
    // <a href="/md5/HASH" class="...js-vim-focus...">TITLE TEXT</a>
    const titlePattern = /<a\s[^>]*href="(\/md5\/[a-f0-9]+)"[^>]*class="[^"]*js-vim-focus[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

    let m;
    while ((m = titlePattern.exec(html)) !== null) {
        const href  = m[1]; // /md5/HASH
        const title = strip(m[2]);
        if (!title || title.length < 2) continue;

        const md5 = href.replace('/md5/', '').toUpperCase();

        // Cover <img> sits in an <a href="/md5/HASH"> just before the title
        // link, so look back up to 1200 chars to catch it.
        const preContext = html.slice(Math.max(0, m.index - 1200), m.index);
        let coverUrl = '';
        // libgen.li's fictioncovers CDN is what Anna's Archive actually uses
        const coverImgMatch = preContext.match(/src="(https?:\/\/libgen\.li\/fictioncovers\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
        if (coverImgMatch) {
            coverUrl = coverImgMatch[1];
        } else {
            const fallbackCover = preContext.match(/src="(https?:\/\/[^"]*(?:covers|thumb)[^"]*\.(?:jpg|jpeg|png|webp))"/i);
            if (fallbackCover) coverUrl = fallbackCover[1];
        }

        const context = html.slice(m.index + m[0].length, m.index + m[0].length + 1200);

        // Author link is tagged with an icon-[mdi--user-edit] span
        let author = '';
        const authorMatch = context.match(/<a[^>]*href="\/search\?q=[^"]*"[^>]*>[\s\S]*?icon-\[mdi--user-edit\][\s\S]*?<\/a>/i);
        if (authorMatch) {
            author = strip(authorMatch[0]);
        } else {
            const fallbackAuthor = context.match(/<a[^>]*href="\/search\?q=([^"]*)"[^>]*>([^<]*)<\/a>/i);
            if (fallbackAuthor) author = strip(fallbackAuthor[2]);
        }

        // "text-gray-800" div holds e.g. "English [en] · EPUB · 0.5MB · 2008 · ..."
        let format = '', language = '', year = '', filesize = 0;
        const metaMatch = context.match(/<div[^>]*text-gray-800[^>]*>([\s\S]*?)<\/div>/i);
        if (metaMatch) {
            const metaText = strip(metaMatch[1]);
            const langM = metaText.match(/([A-Za-z]+)\s*\[([a-z]{2})\]/);
            if (langM) language = langM[1];

            const fmtM = metaText.match(/\b(epub|mobi|fb2|azw3|pdf|djvu|cbz|cbr|doc|docx|txt|mp3|m4b)\b/i);
            if (fmtM) format = fmtM[1].toLowerCase();

            const szM = metaText.match(/([\d.]+)\s*(KB|MB|GB)/i);
            if (szM) filesize = parseFilesizeBytes(szM[1], szM[2]);

            const yearM = metaText.match(/\b(1[89]\d{2}|20[012]\d)\b/);
            if (yearM) year = yearM[1];
        }

        results.push({
            title,
            author,
            year,
            format,
            filesize,
            language,
            source:      "Anna's Archive",
            downloadUrl: `${mirror}${href}`,
            md5,
            coverUrl,
        });
    }

    return results.slice(0, 20);
}

// ── Internet Archive ────────────────────────────────────────────────────────

async function searchArchive(query, mode) {
    const mediaType = mode === 'audiobooks' ? 'audio' : 'texts';
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+AND+mediatype:${mediaType}+AND+NOT+collection:(inlibrary+OR+printdisabled)+AND+NOT+access-restricted-item:true&fl[]=identifier,title,creator,year,format,downloads,language&sort[]=downloads+desc&rows=10&page=1&output=json`;
    try {
        const res = await get(url, 6000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const docs = (data.response && data.response.docs) || [];
        // No fallback to formats[0]: the format field lists every file in the item (liner notes,
        // torrents, thumbnails), so the first entry often showed the wrong type. Leave it blank and
        // resolveArchiveLinks() below fills in the real one.
        const preferred = mode === 'audiobooks'
            ? ['MP3', 'VBR MP3', '128Kbps MP3', '64Kbps MP3', 'Ogg Vorbis', 'FLAC']
            : ['EPUB', 'MOBI', 'PDF', 'Text', 'DjVu'];
        return docs.map(doc => {
            const formats = Array.isArray(doc.format) ? doc.format : [doc.format].filter(Boolean);
            const best = preferred.find(f => formats.some(df => df && df.toLowerCase().includes(f.toLowerCase())));
            return {
                title:       doc.title || 'Unknown Title',
                author:      Array.isArray(doc.creator) ? doc.creator.join(', ') : (doc.creator || ''),
                year:        String(doc.year || ''),
                format:      best ? best.toLowerCase() : '',
                filesize:    0,
                language:    Array.isArray(doc.language) ? doc.language[0] : (doc.language || ''),
                source:      'Internet Archive',
                downloadUrl: `https://archive.org/details/${doc.identifier || ''}`,
                // Archive.org provides book covers via their thumbnail API
                coverUrl: doc.identifier ? `https://archive.org/services/img/${doc.identifier}` : '',
                identifier: doc.identifier || '',
            };
        });
    } catch(e) { return []; }
}

// Turns an Internet Archive /details/ item into a direct /download/ file URL. The metadata endpoint
// lists every file in the item, and we pick the best one for the mode (ebook or audio formats).
const IA_EBOOK_EXTS = ['epub', 'pdf', 'mobi', 'azw3', 'djvu', 'txt'];
const IA_AUDIO_EXTS = ['mp3', 'm4b', 'm4a', 'flac'];

async function resolveArchiveLinks(results, mode, topN = 10) {
    const exts = mode === 'audiobooks' ? IA_AUDIO_EXTS : IA_EBOOK_EXTS;
    const toResolve = results.slice(0, topN).filter(r => r.identifier);
    await Promise.allSettled(toResolve.map(async r => {
        try {
            const res = await get(`https://archive.org/metadata/${r.identifier}`, 7000, { 'Accept': 'application/json' });
            if (!res.ok) return;
            const meta = await res.json();
            const files = Array.isArray(meta.files) ? meta.files : [];
            let best = null;
            for (const ext of exts) {
                best = files.find(f => (f.name || '').toLowerCase().endsWith('.' + ext));
                if (best) break;
            }
            if (best) {
                r.directUrl   = `https://archive.org/download/${r.identifier}/${encodeURIComponent(best.name)}`;
                r.directReady = true;
                if (!r.format) r.format = best.name.split('.').pop().toLowerCase();
                const size = parseInt(best.size);
                if (size > 0) r.filesize = size;
            }
        } catch(e) { /* leave downloadUrl pointing at the /details/ page */ }
    }));
    return results;
}

// ── Project Gutenberg (via Gutendex) ──────────────────────────────────────────
// gutenberg.org has no search API. Gutendex (gutendex.com) mirrors the catalog and already gives direct
// file URLs, so the search response is the direct link and there is no resolve step. Ebooks only.
const GUTENBERG_FORMAT_PREFS = [
    { mime: 'application/epub+zip',           ext: 'epub' },
    { mime: 'application/x-mobipocket-ebook',  ext: 'mobi' },
    { mime: 'application/pdf',                 ext: 'pdf'  },
    { mime: 'text/plain; charset=utf-8',       ext: 'txt'  },
    { mime: 'text/plain; charset=us-ascii',    ext: 'txt'  },
    { mime: 'text/plain',                      ext: 'txt'  },
];

async function searchGutenberg(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}`;
        // Gutendex is intermittently slow or erroring; one retry beats a silent empty result.
        let data = null;
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
            try {
                const res = await get(url, 10000, { 'Accept': 'application/json' });
                if (res.ok) data = await res.json();
            } catch (e) { /* retry */ }
        }
        if (!data) return [];
        const books = Array.isArray(data.results) ? data.results : [];
        const out = [];
        for (const b of books.slice(0, 10)) {
            const formats = b.formats || {};
            let picked = null;
            for (const pref of GUTENBERG_FORMAT_PREFS) {
                if (formats[pref.mime]) { picked = { url: formats[pref.mime], ext: pref.ext }; break; }
            }
            if (!picked) continue; // nothing directly downloadable for this entry
            const coverMime = Object.keys(formats).find(k => k.startsWith('image/'));
            out.push({
                title:       b.title || 'Unknown Title',
                author:      Array.isArray(b.authors) ? b.authors.map(a => a.name).join(', ') : '',
                year:        '',
                format:      picked.ext,
                filesize:    0,
                language:    Array.isArray(b.languages) ? b.languages[0] : '',
                source:      'Project Gutenberg',
                downloadUrl: picked.url,
                directUrl:   picked.url,
                pageUrl:     `https://www.gutenberg.org/ebooks/${b.id}`,
                coverUrl:    coverMime ? formats[coverMime] : '',
            });
        }
        return out;
    } catch(e) { return []; }
}

// ── OpenStax ──────────────────────────────────────────────────────────────────
// A small list (about 130 titles) of English textbooks. There is no search endpoint, but the whole list is
// one request, so titles are matched locally. Each match needs one more request to its detail page for
// the real PDF link (pdf_url).
async function searchOpenStax(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const listRes = await get('https://openstax.org/apps/cms/api/v2/pages/?type=books.Book&limit=250', 6000, { 'Accept': 'application/json' });
        if (!listRes.ok) return [];
        const listData = await listRes.json();
        const books = Array.isArray(listData.items) ? listData.items : [];
        const qn = query.toLowerCase().trim();
        const matches = books.filter(b => (b.title || '').toLowerCase().includes(qn)).slice(0, 5);
        if (!matches.length) return [];

        const details = await Promise.all(matches.map(async b => {
            try {
                const detailUrl = b.meta && b.meta.detail_url;
                if (!detailUrl) return null;
                const res = await get(detailUrl, 6000, { 'Accept': 'application/json' });
                return res.ok ? await res.json() : null;
            } catch(e) { return null; }
        }));

        const out = [];
        for (const d of details) {
            if (!d || !d.pdf_url) continue; // no downloadable file for this title
            out.push({
                title:       d.title || 'Unknown Title',
                author:      Array.isArray(d.authors) ? d.authors.map(a => (a.value && a.value.name) || '').filter(Boolean).join(', ') : '',
                year:        d.publish_date ? String(d.publish_date).slice(0, 4) : '',
                format:      'pdf',
                filesize:    0,
                language:    'en',
                source:      'OpenStax',
                downloadUrl: d.pdf_url,
                directUrl:   d.pdf_url,
                pageUrl:     (d.meta && d.meta.html_url) || '',
                directReady: true,
                coverUrl:    d.cover_url || '',
            });
        }
        return out;
    } catch(e) { return []; }
}

// ── LibreTexts (via the LibreCommons catalog) ─────────────────────────────────
// LibreTexts has no public API, but its catalog site commons.libretexts.org does (found by watching the
// site's own search requests). Use ?searchQuery=; ?search= is silently ignored and returns the whole
// catalog. Each entry links to a ready-made full-book PDF on batch.libretexts.org.
async function searchLibreTexts(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const url = `https://commons.libretexts.org/api/v1/search/books-v2?searchQuery=${encodeURIComponent(query)}&limit=10&page=1`;
        const res = await get(url, 7000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const books = Array.isArray(data.results) ? data.results : [];
        const out = [];
        for (const b of books) {
            const pdfUrl = b.links && b.links.pdf;
            if (!pdfUrl) continue; // not yet batch-generated for this title
            out.push({
                title:       b.title || 'Unknown Title',
                author:      b.author || '',
                year:        '',
                format:      'pdf',
                filesize:    0,
                language:    '',
                source:      'LibreTexts',
                downloadUrl: pdfUrl,
                directUrl:   pdfUrl,
                pageUrl:     (b.links && b.links.online) || '',
                directReady: true,
                coverUrl:    b.thumbnail || '',
            });
        }
        return out;
    } catch(e) { return []; }
}

// ── Memory of the World ────────────────────────────────────────────────────
// library.memoryoftheworld.org is a public Calibre library (about 160k books) with a JSON search at
// /search?q=, no login and no bot check. It is mostly modern books, not public domain, so it does not get
// the open-licence score bonus in scoreResult(). File URLs are built from the JSON
// (library_url + dir_path + file_name), so no extra resolve request is needed.
const MOTW_FORMAT_PREFS = ['epub', 'pdf', 'mobi', 'azw3'];

// Encode each path segment separately so the slashes stay as separators.
function motwEncodePath(path) {
    return path.split('/').map(seg => seg ? encodeURIComponent(seg) : '').join('/');
}

async function searchMemoryOfTheWorld(query, mode) {
    if (mode === 'audiobooks') return [];
    try {
        const url = `https://library.memoryoftheworld.org/search?q=${encodeURIComponent(query)}`;
        const res = await get(url, 7000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const books = Array.isArray(data._items) ? data._items : [];
        const out = [];
        for (const b of books.slice(0, 10)) {
            const formats = Array.isArray(b.formats) ? b.formats : [];
            let picked = null;
            for (const pref of MOTW_FORMAT_PREFS) {
                picked = formats.find(f => f.format === pref);
                if (picked) break;
            }
            if (!picked) continue; // nothing in a downloadable format
            const base = 'https://library.memoryoftheworld.org';
            const fileUrl = base + motwEncodePath((b.library_url || '') + (picked.dir_path || '') + picked.file_name);
            const coverUrl = b.cover_url ? base + motwEncodePath((b.library_url || '') + b.cover_url) : '';
            out.push({
                title:       b.title || 'Unknown Title',
                author:      Array.isArray(b.authors) ? b.authors.join(', ') : '',
                year:        b.pubdate ? String(b.pubdate).slice(0, 4) : '',
                format:      picked.format,
                filesize:    picked.size || 0,
                language:    Array.isArray(b.languages) ? b.languages[0] : '',
                source:      'Memory of the World',
                downloadUrl: fileUrl,
                directUrl:   fileUrl,
                directReady: true,
                coverUrl,
            });
        }
        return out;
    } catch(e) { return []; }
}

// ── LibriVox ────────────────────────────────────────────────────────────────
// Public domain audiobooks read by volunteers. It has a JSON API (librivox.org/api/info), but title search
// only matches the START of a title, so we send ^query. Each result's url_zip_file is a real direct
// download (a zip of the chapter MP3s).
async function searchLibriVox(query, mode) {
    if (mode !== 'audiobooks') return [];
    try {
        const url = 'https://librivox.org/api/feed/audiobooks/?' + new URLSearchParams({
            title: '^' + query,
            format: 'json',
            extended: '1',
            limit: '10',
        });
        const res = await get(url, 7000, { 'Accept': 'application/json' });
        if (!res.ok) return [];
        const data = await res.json();
        const books = Array.isArray(data.books) ? data.books : [];
        const out = [];
        for (const b of books) {
            if (!b.url_zip_file) continue; // not yet packaged for download
            out.push({
                title:       b.title || 'Unknown Title',
                author:      Array.isArray(b.authors) ? b.authors.map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', ') : '',
                year:        b.copyright_year || '',
                format:      'zip',
                filesize:    0,
                language:    b.language || '',
                source:      'LibriVox',
                downloadUrl: b.url_zip_file,
                directUrl:   b.url_zip_file,
                pageUrl:     b.url_librivox || '',
                directReady: true,
                coverUrl:    '',
            });
        }
        return out;
    } catch(e) { return []; }
}

// ── AudiobookBay (magnet links) ──────────────────────────────────────────────
// A torrent index, not a file host. Detail pages show an Info Hash and tracker URLs but no magnet link,
// so we build one: magnet:?xt=urn:btih:HASH&dn=NAME&tr=TRACKER1&tr=TRACKER2
// audiobookbay.nl does not answer, only .lu does. Add new mirrors to ABB_MIRRORS.
const ABB_MIRRORS = ['https://audiobookbay.lu'];

async function searchAudiobookBay(query) {
    // A query with uppercase letters is redirected to the homepage (the site treats it as a bot).
    // Search is case-insensitive, so lowercase it.
    const lowerQuery = query.toLowerCase();

    for (const mirror of ABB_MIRRORS) {
        try {
            // cat=undefined,undefined matches what the site's own search box sends
            const url = `${mirror}/?s=${encodeURIComponent(lowerQuery)}&cat=undefined%2Cundefined`;
            const res = await get(url, 8000);
            if (!res.ok) continue;
            const html = await res.text();
            // The homepage's "latest uploads" list uses the same class="post" markup as search results, so
            // that cannot tell a real result from a redirect. The archiveTitle heading only appears on
            // real results, so require that.
            if (!html.includes('archiveTitle')) {
                console.warn('[AudiobookBay] response had no archiveTitle heading, likely blocked or redirected');
                continue;
            }
            const results = parseAbbSearchHtml(html, mirror);
            if (results.length > 0) return results;
        } catch(e) {
            console.warn('[AudiobookBay] mirror request failed:', e && e.message ? e.message : e);
        }
    }
    return [];
}

function parseAbbSearchHtml(html, mirror) {
    const results = [];
    const blocks = html.split('<div class="post">').slice(1);

    for (const block of blocks) {
        const titleMatch = block.match(/<div class="postTitle"><h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!titleMatch) continue;

        let href = titleMatch[1];
        if (href.startsWith('/')) href = mirror + href;
        const title = strip(titleMatch[2]);
        if (!title) continue;

        let language = '';
        const categories = [];
        const infoMatch = block.match(/<div class="postInfo">([\s\S]*?)<\/div>/i);
        if (infoMatch) {
            // Matched on the raw HTML: stripping the tags first would run "English" and "Keywords" together.
            const langM = infoMatch[1].match(/Language:\s*([A-Za-z]+)/i);
            if (langM) language = langM[1];

            // Categories are separated by &nbsp;. Split on that, not on spaces, because some names
            // contain a space (for example "Misc. Non-fiction").
            const catMatch = infoMatch[1].match(/Category:\s*([\s\S]*?)<br/i);
            if (catMatch) {
                catMatch[1].split('&nbsp;').map(s => strip(s)).filter(Boolean).forEach(c => {
                    if (!categories.includes(c)) categories.push(c);
                });
            }
        }

        // Unlike LibGen there is no fallback cover here, so this is where the isHttpUrl check matters.
        const coverMatch = block.match(/<img src="([^"]+)"/i);
        const coverUrl = coverMatch && isHttpUrl(coverMatch[1]) ? coverMatch[1] : '';

        results.push({ title, detailUrl: href, language, categories, coverUrl });
    }

    return results.slice(0, 15);
}

// Opens each result's detail page to get the Info Hash and trackers, then builds the magnet link.
// Done in small batches: many requests at once look like abuse to the site and all time out.
const ABB_RESOLVE_BATCH_SIZE = 4;

async function resolveAbbMagnets(results, topN = 8) {
    const toResolve = results.slice(0, topN);

    for (let i = 0; i < toResolve.length; i += ABB_RESOLVE_BATCH_SIZE) {
        const batch = toResolve.slice(i, i + ABB_RESOLVE_BATCH_SIZE);
        await Promise.allSettled(batch.map(async r => {
            try {
                const res = await get(r.detailUrl, 7000);
                if (!res.ok) {
                    console.warn(`[AudiobookBay] detail page returned HTTP ${res.status}`);
                    return;
                }
                const html = await res.text();

                const hashMatch = html.match(/Info Hash:<\/td>\s*<td>([a-fA-F0-9]{40})<\/td>/i);
                if (!hashMatch) {
                    console.warn('[AudiobookBay] no Info Hash found on a detail page');
                    return;
                }
                const hash = hashMatch[1];

                const trackers = [];
                const announceMatch = html.match(/Announce URL:<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
                if (announceMatch) trackers.push(announceMatch[1].trim());
                const trackerRe = /Tracker:<\/td>\s*<td>([^<]+)<\/td>/gi;
                let tm;
                while ((tm = trackerRe.exec(html)) !== null) trackers.push(tm[1].trim());
                const uniqTrackers = [...new Set(trackers)];

                let magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(r.title)}`;
                uniqTrackers.forEach(t => { magnet += `&tr=${encodeURIComponent(t)}`; });

                const fmtMatch = html.match(/class=['"]format['"][^>]*>([^<]+)</i);
                const format = fmtMatch ? fmtMatch[1].trim().toLowerCase() : '';

                let filesize = 0;
                const sizeMatch = html.match(/(?:Combined File Size|File Size):<\/td>\s*<td>[\s\S]*?<span[^>]*>([\d.]+)<\/span>\s*(\w+)/i);
                if (sizeMatch) filesize = parseFilesizeBytes(sizeMatch[1], sizeMatch[2]);

                // "Written by", author span
                const authorMatch = html.match(/<span class=['"]author['"][^>]*>([^<]+)<\/span>/i);
                const author = authorMatch ? strip(authorMatch[1]) : '';

                // "Read by", one or more narrator spans
                const narrators = [];
                const narratorRe = /<span class=['"]narrator['"][^>]*>([^<]+)<\/span>/gi;
                let nm;
                while ((nm = narratorRe.exec(html)) !== null) {
                    const n = strip(nm[1]);
                    if (n && !narrators.includes(n)) narrators.push(n);
                }
                const narrator = narrators.join(', ');

                // Bitrate appears in two different template variants across postings:
                // a classed span (e.g. "Mixed") or plain text "Bit Rate: 125 kbps".
                let bitrate = '';
                const bitrateSpanMatch = html.match(/<span class=['"]bitrate['"][^>]*>([^<]+)<\/span>/i);
                if (bitrateSpanMatch) {
                    bitrate = strip(bitrateSpanMatch[1]);
                } else {
                    const bitrateTextMatch = html.match(/Bit Rate:\s*([^<\n]+?)(?:<br|\s*<\/p>)/i);
                    if (bitrateTextMatch) bitrate = strip(bitrateTextMatch[1]);
                }

                const abridgedMatch = html.match(/<span class=['"]is_abridged['"][^>]*>([^<]+)<\/span>/i);
                const abridged = abridgedMatch ? strip(abridgedMatch[1]) : '';

                r.magnet   = magnet;
                r.infoHash = hash;
                r.format   = format;
                r.filesize = filesize;
                r.author   = author;
                r.narrator = narrator;
                r.bitrate  = bitrate;
                r.abridged = abridged;
            } catch(e) {
                console.warn('[AudiobookBay] detail request failed:', e && e.message ? e.message : e);
            }
        }));
    }

    const resolved = results.filter(r => r.magnet);
    return resolved;
}

function mapAbbResults(results) {
    return results.map(r => ({
        title:       r.title,
        author:      r.author || '',
        year:        '',
        format:      r.format || '',
        filesize:    r.filesize || 0,
        language:    r.language || '',
        source:      'AudiobookBay',
        downloadUrl: r.detailUrl,
        detailUrl:   r.detailUrl,
        magnet:      r.magnet,
        infoHash:    r.infoHash,
        coverUrl:    r.coverUrl || '',
        narrator:    r.narrator || '',
        bitrate:     r.bitrate || '',
        abridged:    r.abridged || '',
        categories:  r.categories || [],
    }));
}

// ── AudiobooksBee ────────────────────────────────────────────────────────────
// A WordPress site. ?s= is its built-in search and also matches post text and tags, so some results are
// off-topic; scoreResult() ranks those down. The search page has no download link, so
// resolveAudiobooksBeeLinks() reads each post for its file-host link (usually rg.to, Rapidgator).

async function searchAudiobooksBee(query) {
    const url = `https://audiobooksbee.com/?s=${encodeURIComponent(query)}`;
    const res = await get(url, 8000);
    if (!res.ok) return [];
    const html = await res.text();
    return parseAudiobooksBeeSearchHtml(html);
}

function parseAudiobooksBeeSearchHtml(html) {
    const results = [];
    const blocks = html.split('<article class="col_item').slice(1);

    for (const block of blocks) {
        const titleMatch = block.match(/<h2[^>]*><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
        if (!titleMatch) continue;

        const href = titleMatch[1];
        let title = strip(titleMatch[2]);
        if (!title) continue;

        // Post titles look like "<Title> By <Author>". Split them so the author gets its own field,
        // like every other source (the dedup in mergeAndRank uses the author too).
        let author = '';
        const byMatch = title.match(/^(.*?)\s+By\s+(.+)$/);
        if (byMatch) { title = byMatch[1].trim(); author = byMatch[2].trim(); }

        const coverMatch = block.match(/data-src="([^"]+)"/i);
        const coverUrl = coverMatch && isHttpUrl(coverMatch[1]) ? coverMatch[1] : '';

        results.push({ title, author, detailUrl: href, downloadUrl: href, coverUrl });
    }

    return results.slice(0, 15);
}

const ABB_BEE_RESOLVE_BATCH_SIZE = 4;

async function resolveAudiobooksBeeLinks(results, topN = 5) {
    const toResolve = results.slice(0, topN);

    for (let i = 0; i < toResolve.length; i += ABB_BEE_RESOLVE_BATCH_SIZE) {
        const batch = toResolve.slice(i, i + ABB_BEE_RESOLVE_BATCH_SIZE);
        await Promise.allSettled(batch.map(async r => {
            try {
                const res = await get(r.detailUrl, 7000);
                if (!res.ok) return;
                const html = await res.text();

                // rg.to is Rapidgator's short domain: one link per post, after a "Download" label.
                // Rapidgator's free download has its own wait timer, so this is a link to a file page,
                // not a direct file.
                const linkMatch = html.match(/href="(https:\/\/rg\.to\/file\/[^"]+)"/i);
                if (!linkMatch) return;
                r.downloadUrl = linkMatch[1];

                const fmtMatch = r.downloadUrl.match(/\.(m4b|mp3|zip|flac)\.html/i);
                if (fmtMatch) r.format = fmtMatch[1].toLowerCase();
            } catch(e) {
                console.warn('[AudiobooksBee] detail request failed:', e && e.message ? e.message : e);
            }
        }));
    }

    return results;
}

function mapAudiobooksBeeResults(results) {
    return results.map(r => ({
        title:       r.title,
        author:      r.author || '',
        year:        '',
        format:      r.format || '',
        filesize:    0,
        language:    '',
        source:      'AudiobooksBee',
        downloadUrl: r.downloadUrl,
        detailUrl:   r.detailUrl,
        coverUrl:    r.coverUrl || '',
    }));
}

// Per-source routes return their results unchanged.
const okR = async (env, source, results) => ok({ source, results });

// ── Z-Library (your own account, via its app API) ───────────────────────────
// Domains rotate; the first that answers the login wins. Downloads count against the account's daily
// limit, so /dl/zlib resolves a book's file link only when the user clicks it, never for every result.
const ZLIB_DOMAINS = ['https://z-lib.gd', 'https://z-lib.gl', 'https://libb.la', 'https://zlib.li'];
const ZLIB_SESSION_MS = 6 * 3600 * 1000;
let zlibSession = null; // { domain, cookie, at }
let zlibError = '';
export const zlibStatus = () => ({ error: zlibError });
const zlibConfigured = () => !!(creds.zlib && creds.zlib.email && creds.zlib.password);

async function zlibCall(domain, path, form, cookie, method = 'POST') {
    const res = await get(domain + path, 15000,
        { ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
        { method, ...(method === 'POST' ? { body: form.toString() } : {}) });
    return res.json();
}

async function zlibLogin() {
    const c = creds.zlib;
    const domains = c.domain ? [c.domain.replace(/\/+$/, '')] : ZLIB_DOMAINS;
    for (const d of domains) {
        try {
            const j = await zlibCall(d, '/eapi/user/login', new URLSearchParams({ email: c.email, password: c.password }));
            if (j && j.success && j.user) {
                zlibError = '';
                return (zlibSession = { domain: d, cookie: `remix_userid=${j.user.id}; remix_userkey=${j.user.remix_userkey}`, at: Date.now() });
            }
            if (j && j.error) { zlibError = String(j.error).slice(0, 120); return null; } // bad login: other domains will say the same
        } catch (e) { /* domain down, try the next */ }
    }
    zlibError = 'No Z-Library domain reachable';
    return null;
}

async function zlibEnsureSession() {
    if (zlibSession && Date.now() - zlibSession.at < ZLIB_SESSION_MS) return zlibSession;
    return zlibLogin();
}

// No account: the site's own search page in the background browser (its proof-of-work script runs by
// itself). Same cards a visitor sees; downloads then need the site's guest quota or a login.
export function parseZlibCards(html, domain) {
    const out = [];
    const cardRe = /<z-bookcard\s([^>]*)>([\s\S]*?)<\/z-bookcard>/g;
    let m;
    while ((m = cardRe.exec(html))) {
        const attr = n => ((m[1].match(new RegExp('\\b' + n + '="([^"]*)"')) || [])[1] || '');
        const slot = n => strip((m[2].match(new RegExp('<div slot="' + n + '">([\\s\\S]*?)</div>')) || [])[1] || '');
        const title = slot('title');
        if (!title || !attr('href') || attr('deleted') === '1') continue;
        const size = attr('filesize').match(/([\d.]+)\s*(KB|MB|GB)/i);
        out.push({
            title, author: slot('author'), year: attr('year'), language: attr('language'),
            format: attr('extension').toLowerCase(), filesize: size ? parseFilesizeBytes(size[1], size[2].toUpperCase()) : 0,
            source: 'Z-Library', downloadUrl: domain + attr('href'),
            ...(attr('download') ? { directUrl: domain + attr('download') } : {}),
            coverUrl: (isHttpUrl((m[2].match(/<img data-src="([^"]+)"/) || [])[1]) ? m[2].match(/<img data-src="([^"]+)"/)[1] : ''),
        });
    }
    return out;
}

async function searchZlibraryGuest(query) {
    for (const d of ZLIB_DOMAINS) {
        const html = await browserGet(`${d}/s/${encodeURIComponent(query)}`, { timeoutMs: 15000, isReady: h => h.includes('<z-bookcard') });
        if (html) return parseZlibCards(html, d).slice(0, 50);
    }
    return Object.assign([], { unavailable: true });
}

async function searchZlibrary(query, mode) {
    if (mode === 'audiobooks') return [];
    if (!zlibConfigured()) return searchZlibraryGuest(query);
    const unavailable = () => Object.assign([], { unavailable: true });
    const run = async s => zlibCall(s.domain, '/eapi/book/search', new URLSearchParams({ message: query, limit: '50', page: '1' }), s.cookie);
    try {
        let s = await zlibEnsureSession();
        if (!s) return searchZlibraryGuest(query);
        let j = await run(s);
        if (!j || !j.success) { // session expired or revoked: log in once more
            zlibSession = null;
            s = await zlibLogin();
            if (!s) return searchZlibraryGuest(query);
            j = await run(s);
        }
        if (!j || !Array.isArray(j.books)) return searchZlibraryGuest(query);
        return j.books.map(b => ({
            title:       strip(b.title),
            author:      strip(b.author),
            year:        b.year ? String(b.year) : '',
            language:    b.language || '',
            format:      String(b.extension || '').toLowerCase(),
            filesize:    Number(b.filesize) || 0,
            source:      'Z-Library',
            downloadUrl: s.domain + (b.href || ''),
            directUrl:   `/dl/zlib?id=${encodeURIComponent(b.id)}&hash=${encodeURIComponent(b.hash)}`,
            coverUrl:    isHttpUrl(b.cover) ? b.cover : '',
        })).filter(r => r.title);
    } catch (e) { return searchZlibraryGuest(query); }
}

// Redirects to the file link for one book; counts against the account's daily limit.
async function zlibDownload(id, hash) {
    if (!/^\d+$/.test(id) || !/^[a-z0-9]+$/i.test(hash) || !zlibConfigured()) return err('Z-Library is not set up', 404);
    try {
        const s = await zlibEnsureSession();
        if (!s) return err('Z-Library login failed: ' + zlibError, 502);
        const j = await zlibCall(s.domain, `/eapi/book/${id}/${hash}/file`, null, s.cookie, 'GET');
        const link = j && j.file && j.file.downloadLink;
        if (!isHttpUrl(link)) return err((j && j.error) ? String(j.error).slice(0, 160) : 'No download link (daily limit reached?)', 502);
        return new Response(null, { status: 302, headers: { Location: link, 'Referrer-Policy': 'no-referrer' } });
    } catch (e) { return err('Z-Library request failed', 502); }
}

// ── Torrent files ───────────────────────────────────────────────────────────
// For a resolved magnet result, fetches its .torrent from public torrent caches on request and passes it
// through. RaveBSD does not store it. Not every torrent is cached, so this can answer 404.
const torrentCaches = hash => [`https://itorrents.org/torrent/${hash}.torrent`, `https://itorrents.net/torrent/${hash}.torrent`];

async function torrentFile(id) {
    const r = resultStore.get(id);
    const hash = String((r && r.infoHash) || '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(hash)) return err('No torrent information for this result', 404);
    for (const url of torrentCaches(hash)) {
        try {
            const res = await get(url, 20000);
            if (!res.ok) continue;
            const bytes = new Uint8Array(await res.arrayBuffer());
            // A real .torrent is a bencoded dictionary, which starts with "d". Anything else is an error page.
            if (bytes.length < 50 || bytes.length > 5e6 || bytes[0] !== 0x64) continue;
            const name = String(r.title || '').replace(/[^\w .()-]+/g, '').trim().slice(0, 80) || hash;
            return new Response(bytes, { headers: {
                'Content-Type': 'application/x-bittorrent',
                'Content-Disposition': `attachment; filename="${name}.torrent"`,
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            } });
        } catch (e) { /* try the next cache */ }
    }
    return err('No cached torrent file was found for this result. Use the magnet link instead.', 404);
}

// ── Mobilism (your own forum account) ───────────────────────────────────────
// phpBB forum: search is members-only. Results are topic links, no direct file (the Forum badge in the UI).
const MOBILISM_BASE = 'https://forum.mobilism.org';
const MOBILISM_FORUMS = {
    audiobooks: [124],
    ebooks: [1285, 122, 1345, 1328, 545, 1346, 892, 126, 1292, 1340, 1293, 1294, 121, 1295],
};
const MOBILISM_SESSION_MS = 3600 * 1000;
let mobilismSession = null; // { cookie, at }
let mobilismError = '';
export const mobilismStatus = () => ({ error: mobilismError });
const mobilismConfigured = () => !!(creds.mobilism && creds.mobilism.username && creds.mobilism.password);

// Folds a response's Set-Cookie headers into a cookie string.
function mergeCookies(prev, res) {
    const jar = new Map((prev ? prev.split('; ') : []).filter(Boolean).map(p => [p.split('=')[0], p]));
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const pair = c.split(';')[0];
        jar.set(pair.split('=')[0], pair);
    }
    return [...jar.values()].join('; ');
}

async function mobilismLogin() {
    const c = creds.mobilism;
    try {
        const page = await get(`${MOBILISM_BASE}/ucp.php?mode=login`, 15000);
        let cookie = mergeCookies('', page);
        const html = await page.text();
        const sid = (html.match(/name="sid" value="([a-f0-9]+)"/) || [])[1];
        if (!sid) { mobilismError = 'Login page not recognised'; return null; }
        const res = await get(`${MOBILISM_BASE}/ucp.php?mode=login&sid=${sid}`, 15000,
            { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
            { method: 'POST', redirect: 'manual', body: new URLSearchParams({ username: c.username, password: c.password, login: 'Login', redirect: 'index.php', sid, autologin: 'on' }).toString() });
        cookie = mergeCookies(cookie, res);
        // phpBB sets the user-id cookie (..._u) to a real id on success, and leaves it at 1 (guest) on failure.
        const uid = (cookie.match(/_u=(\d+)/) || [])[1];
        if (!uid || uid === '1') {
            const err = ((await res.text()).match(/class="error"[^>]*>([\s\S]*?)<\/(?:div|p)>/) || [])[1];
            mobilismError = strip(err || 'Login failed').slice(0, 140);
            return null;
        }
        mobilismError = '';
        return (mobilismSession = { cookie, at: Date.now() });
    } catch (e) { mobilismError = 'Mobilism unreachable'; return null; }
}

export function parseMobilismResults(html) {
    const out = [], seen = new Set();
    const tagRe = /<a\s[^>]*class="topictitle"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = tagRe.exec(html))) {
        const href = (m[0].match(/href="([^"]+)"/) || [])[1] || '';
        const ids = href.match(/[?&;]f=(\d+)(?:&amp;|&)t=(\d+)/) || href.match(/[?&;]t=(\d+)/) && [null, '', href.match(/[?&;]t=(\d+)/)[1]];
        if (!ids || seen.has(ids[2])) continue;
        seen.add(ids[2]);
        const raw = strip(m[1]);
        // Uploaders tag the format at the end of the title, e.g. "... (.M4B)"
        const f = raw.match(/\s*\(\.([A-Za-z0-9/+, ]+)\)\s*$/);
        const topicUrl = `${MOBILISM_BASE}/viewtopic.php?${ids[1] ? `f=${ids[1]}&` : ''}t=${ids[2]}`;
        out.push({
            title: f ? raw.slice(0, f.index).trim() : raw, author: '', year: '',
            format: f ? f[1].trim().toLowerCase() : '', filesize: 0, language: '',
            source: 'Mobilism', topicUrl, downloadUrl: topicUrl, coverUrl: '',
        });
    }
    return out;
}

async function searchMobilism(query, mode) {
    if (!mobilismConfigured()) return [];
    const unavailable = () => Object.assign([], { unavailable: true });
    const forums = MOBILISM_FORUMS[mode];
    if (!forums) return [];
    const run = async s => {
        const qs = new URLSearchParams({ keywords: query, terms: 'all', sr: 'topics', sf: 'titleonly' });
        forums.forEach(f => qs.append('fid[]', String(f)));
        const res = await get(`${MOBILISM_BASE}/search.php?${qs}`, 20000, { Cookie: s.cookie });
        return res.text();
    };
    try {
        let s = mobilismSession && Date.now() - mobilismSession.at < MOBILISM_SESSION_MS ? mobilismSession : await mobilismLogin();
        if (!s) return unavailable();
        let html = await run(s);
        if (/not permitted to use the search system/i.test(html)) { // session expired
            mobilismSession = null;
            s = await mobilismLogin();
            if (!s) return unavailable();
            html = await run(s);
        }
        if (/cannot make another search so soon/i.test(html)) return unavailable(); // phpBB flood control
        return parseMobilismResults(html).slice(0, 25);
    } catch (e) { return unavailable(); }
}

// ── Merge, rank, deduplicate ────────────────────────────────────────────────

// Result ids and the server-side store let the page ask for one result's direct link later
// (/resolve) without ever sending a URL for the server to fetch.
const resultStore = new Map();
const RESULT_STORE_MAX = 5000;
let idSeq = 0;
const registerResult = (r, mode) => {
    if (!r.id) r.id = Date.now().toString(36) + (idSeq++).toString(36);
    if (mode) r._mode = mode;
    resultStore.delete(r.id);
    resultStore.set(r.id, r);
    if (resultStore.size > RESULT_STORE_MAX) resultStore.delete(resultStore.keys().next().value);
};

// Direct downloads first, then magnets, then the rest; score decides within each tier.
const linkTier = r => (r.directUrl ? 2 : r.magnet ? 1 : 0);
// Audiobook searches put AudiobookBay above everything else (its torrents are the best audiobook source).
const rankTier = (r, mode) => (mode === 'audiobooks' && r.source === 'AudiobookBay' ? 3 : linkTier(r));

// Within each link tier, take one result per source in turn (each source keeps its own score order),
// so one source with many direct links cannot fill the whole first page. The page repeats this rule
// when links resolve (public/index.html, rankResults).
function interleaveByTier(sorted, mode) {
    const out = [];
    for (const tier of [3, 2, 1, 0]) {
        const queues = new Map();
        for (const r of sorted) if (rankTier(r, mode) === tier) { if (!queues.has(r.source)) queues.set(r.source, []); queues.get(r.source).push(r); }
        const lists = [...queues.values()];
        for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    }
    return out;
}

// Advanced search filters. Results with no year or format are kept, they may just not say.
const keepResult = (r, o) =>
    (!o.formats.length || !r.format || o.formats.includes(String(r.format).toLowerCase().replace(/^\./, '')))
    && (!o.yearFrom || !(parseInt(r.year) > 0) || (parseInt(r.year) >= o.yearFrom && parseInt(r.year) <= o.yearTo));

export function parseOpts(url) {
    const list = k => (url.searchParams.get(k) || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    const y = (url.searchParams.get('year') || '').match(/^\s*(\d{4})(?:\s*-\s*(\d{4}))?\s*$/);
    return { formats: list('formats'), sources: list('sources'), yearFrom: y ? +y[1] : 0, yearTo: y ? +(y[2] || y[1]) : 0 };
}
const optsKey = o => (o && (o.formats.length || o.sources.length || o.yearFrom)) ? JSON.stringify(o) : '';

function mergeAndRank(all, query, mode, opts) {
    if (opts) all = all.filter(r => keepResult(r, opts));
    all.forEach(r => { r._score = scoreResult(r, query); });
    all.sort((a, b) => rankTier(b, mode) - rankTier(a, mode) || b._score - a._score);
    const seen = new Set();
    const out = interleaveByTier(all, mode).filter(r => {
        // Source and format are part of the key so other sources and formats of the same book stay visible.
        const key = ((r.title||'') + '|' + (r.author||'') + '|' + (r.source||'') + '|' + (r.format||'')).toLowerCase().replace(/\s+/g,' ').trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    out.forEach(r => registerResult(r, mode));
    return out;
}

// Finds one result's direct link. The page calls this for each result through /resolve.
const resolving = new Map();
async function resolveOne(id) {
    const r = resultStore.get(id);
    if (!r) return null;
    if (r.directUrl || r.magnet) return r;
    if (!resolving.has(id)) {
        resolving.set(id, (async () => {
            const mode = r._mode || 'ebooks';
            switch (r.source) {
                case 'Library Genesis': if (r.md5) await resolveLibgenLinks([r], 1); break;
                case "Anna's Archive": // most Anna's files are also on LibGen, which has instant links
                    if (r.md5) { const t = { md5: r.md5 }; await resolveLibgenLinks([t], 1); if (t.directUrl) { r.directUrl = t.directUrl; r.directFrom = 'LibGen'; } }
                    break;
                case 'RoyalLib': await resolveRoyalLibLinks([r], 1); break;
                case 'Internet Archive': await resolveArchiveLinks([r], mode, 1); break;
                case 'AudiobookBay': {
                    const raw = { ...r, detailUrl: r.detailUrl || r.downloadUrl };
                    await resolveAbbMagnets([raw], 1);
                    if (raw.magnet) { r.magnet = raw.magnet; r.infoHash = raw.infoHash; }
                    break;
                }
                case 'AudiobooksBee': {
                    const raw = { ...r, detailUrl: r.detailUrl };
                    if (raw.detailUrl) { await resolveAudiobooksBeeLinks([raw], 1); if (raw.downloadUrl) { r.downloadUrl = raw.downloadUrl; if (raw.format) r.format = raw.format; } }
                    break;
                }
            }
            resolving.delete(id);
        })().catch(() => resolving.delete(id)));
    }
    await resolving.get(id);
    return r;
}

// resolveTopN limits how many results get a direct link in non-streaming searches (each costs a request).
// The page gives up after 45s, so the deadlines below stay under that. Partial results beat none.
const SEARCH_DEADLINE_MS = 30000;
const RESOLVE_DEADLINE_MS = 12000;

// onProgress is optional. The streaming route passes it and receives {sources:[names]} once, then
// {done, count, status, results} each time a source finishes (results is the merged list so far).
async function runFullSearch(query, mode, resolveTopN, env, onProgress, opts) {
    opts = opts || { formats: [], sources: [], yearFrom: 0, yearTo: 0 };
    // Each source is a named job, so adding or skipping one never shifts positions.
    // With advanced search the user can pick sources, and unchosen ones never run.
    const jobs = [];
    const add = (name, applies, run) => { if (applies && (!opts.sources.length || opts.sources.includes(name))) jobs.push({ name, run: run() }); };
    const ebooks = mode !== 'audiobooks', audio = !ebooks;
    add('libgen', true, () => searchLibgen(query, mode));
    add('annas', ebooks, () => searchAnnas(query, mode));
    add('archive', true, () => searchArchive(query, mode));
    add('gutenberg', ebooks, () => searchGutenberg(query, mode));
    add('openstax', ebooks, () => searchOpenStax(query, mode));
    add('libretexts', ebooks, () => searchLibreTexts(query, mode));
    add('memoryoftheworld', ebooks, () => searchMemoryOfTheWorld(query, mode));
    add('royallib', ebooks, () => searchRoyalLib(query, mode));
    add('zlibrary', ebooks, () => searchZlibrary(query, mode));
    add('mobilism', mobilismConfigured(), () => searchMobilism(query, mode));
    add('audiobookbay', audio, () => searchAudiobookBay(query));
    add('librivox', audio, () => searchLibriVox(query, mode));
    add('audiobooksbee', audio, () => searchAudiobooksBee(query));

    // Streaming callers (the page) get results as each source finishes and ask for direct links
    // afterwards through /resolve. Plain callers (the JSON API) wait for direct links before the reply.
    const streaming = !!onProgress;
    const norm = (name, v) => name === 'audiobookbay' ? mapAbbResults(v) : name === 'audiobooksbee' ? mapAudiobooksBeeResults(v) : v;
    const got = {};
    let finished = false;
    const snapshot = () => mergeAndRank([].concat(...Object.values(got).map(v => v.slice())), query, mode, opts);

    if (onProgress) onProgress({ sources: jobs.map(j => j.name) });
    const settled = await Promise.allSettled(jobs.map(j => {
        let reported = false;
        const report = (v, count, status) => {
            if (reported) return;
            reported = true;
            if (!streaming || finished) return;
            got[j.name] = norm(j.name, v);
            onProgress({ done: j.name, count, status, results: snapshot() });
        };
        j.run.then(v => report(v, v.length, v.unavailable ? 'unavailable' : 'ok'), () => report([], 0, 'error'));
        return withDeadline(j.run, SEARCH_DEADLINE_MS, []).then(v => { report([], 0, 'timeout'); return v; });
    }));
    const byName = {};
    jobs.forEach((j, i) => { byName[j.name] = settled[i].status === 'fulfilled' ? settled[i].value : []; });
    const count = n => (byName[n] || []).length;
    const meta = () => ({
        libgen: count('libgen'), annas: count('annas'), archive: count('archive'), gutenberg: count('gutenberg'),
        openstax: count('openstax'), libretexts: count('libretexts'), memoryoftheworld: count('memoryoftheworld'),
        royallib: count('royallib'), audiobookbay: count('audiobookbay'), librivox: count('librivox'),
        audiobooksbee: count('audiobooksbee'), zlibrary: count('zlibrary'), mobilism: count('mobilism'),
    });

    if (streaming) {
        finished = true;
        jobs.forEach(j => { if (!got[j.name]) got[j.name] = norm(j.name, byName[j.name] || []); });
        return { results: snapshot(), meta: meta() };
    }

    // Resolve links for all sources at the same time. Doing them one by one adds up the delays.
    const resolveJobs = [];
    if (count('libgen')) resolveJobs.push(resolveLibgenLinks(byName.libgen, resolveTopN));
    if (count('royallib')) resolveJobs.push(resolveRoyalLibLinks(byName.royallib, resolveTopN));
    if (count('archive')) resolveJobs.push(resolveArchiveLinks(byName.archive, mode, resolveTopN));
    if (count('audiobookbay')) resolveJobs.push(resolveAbbMagnets(byName.audiobookbay));
    if (count('audiobooksbee')) resolveJobs.push(resolveAudiobooksBeeLinks(byName.audiobooksbee));
    await withDeadline(Promise.allSettled(resolveJobs), RESOLVE_DEADLINE_MS, null);
    jobs.forEach(j => { got[j.name] = norm(j.name, byName[j.name] || []); });
    return { results: snapshot(), meta: meta() };
}

// ── Search cache ────────────────────────────────────────────────────────────
// /search/all answers are kept in memory for 10 minutes (see the caches shim in src/server.js).
const SEARCH_EDGE_TTL_S = 600;
// LibGen is the main source and sometimes fails for a moment. If it returned nothing, cache for 1 minute only.
const degradedTtl = meta => (meta && meta.libgen > 0 ? SEARCH_EDGE_TTL_S : 60);
const searchCacheKey = (mode, query, opts) =>
    'https://edge-cache.internal/search/all?mode=' + encodeURIComponent(mode) + '&q=' + encodeURIComponent((query || '').trim().toLowerCase().slice(0, 200))
    + (optsKey(opts) ? '&o=' + encodeURIComponent(optsKey(opts)) : '');

// ── Router ──────────────────────────────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

        const url   = new URL(request.url);
        const path  = url.pathname;

        if (path === '/torrent') return torrentFile(url.searchParams.get('id') || '');

        if (path === '/resolve') {
            const r = await resolveOne(url.searchParams.get('id') || '');
            if (!r) return err('Unknown or expired result', 404);
            return ok({ id: r.id, directUrl: r.directUrl || '', magnet: r.magnet || '', infoHash: r.infoHash || '', downloadUrl: r.downloadUrl, format: r.format || '', filesize: r.filesize || 0, directFrom: r.directFrom || '' });
        }
        if (path === '/dl/zlib') return zlibDownload(url.searchParams.get('id') || '', url.searchParams.get('hash') || '');

        // q, or title and author given separately (advanced search / API callers)
        const query = (url.searchParams.get('q') || [url.searchParams.get('title'), url.searchParams.get('author')].filter(Boolean).join(' ')).trim().slice(0, 300);
        const mode  = url.searchParams.get('mode') === 'audiobooks' ? 'audiobooks' : 'ebooks';
        const opts  = parseOpts(url);

        if (!query) return err('No query provided', 400);

        try {
            if (path === '/search/libgen') {
                let results = await searchLibgen(query, mode);
                // Only the first few results get a direct link here (resolveLibgenLinks' default).
                // Resolving every result at once sent bursts of requests and made searches hang.
                if (results.length > 0) await resolveLibgenLinks(results);
                return okR(env, 'libgen', results);
            }
            if (path === '/search/royallib') {
                let results = await searchRoyalLib(query, mode);
                if (results.length > 0) await resolveRoyalLibLinks(results);
                return okR(env, 'royallib', results);
            }
            // Anna's `ext` filter has no audio values, so an audiobook search would only return ebooks.
            // Skip Anna's in audiobook mode.
            if (path === '/search/annas') {
                if (mode === 'audiobooks') return okR(env, 'annas', []);
                return okR(env, 'annas', await searchAnnas(query, mode));
            }

            if (path === '/search/archive') {
                let results = await searchArchive(query, mode);
                if (results.length > 0) await resolveArchiveLinks(results, mode);
                return okR(env, 'archive', results);
            }

            if (path === '/search/audiobookbay') {
                let results = await searchAudiobookBay(query);
                results = await resolveAbbMagnets(results);
                return okR(env, 'audiobookbay', mapAbbResults(results));
            }

            if (path === '/search/gutenberg') {
                return okR(env, 'gutenberg', await searchGutenberg(query, mode));
            }

            if (path === '/search/openstax') {
                return okR(env, 'openstax', await searchOpenStax(query, mode));
            }

            if (path === '/search/libretexts') {
                return okR(env, 'libretexts', await searchLibreTexts(query, mode));
            }

            if (path === '/search/memoryoftheworld') {
                return okR(env, 'memoryoftheworld', await searchMemoryOfTheWorld(query, mode));
            }

            if (path === '/search/librivox') {
                return okR(env, 'librivox', await searchLibriVox(query, mode));
            }

            if (path === '/search/audiobooksbee') {
                let results = await searchAudiobooksBee(query);
                results = await resolveAudiobooksBeeLinks(results);
                return okR(env, 'audiobooksbee', mapAudiobooksBeeResults(results));
            }

            if (path === '/search/zlibrary') return okR(env, 'zlibrary', await searchZlibrary(query, mode));
            if (path === '/search/mobilism') return okR(env, 'mobilism', await searchMobilism(query, mode));

            if (path === '/search/all') {
                // stream=1 sends one JSON object per line: progress events, then a final {final: {...}} line
                // with the full result. The page uses it to show results as each source finishes.
                // A cached answer is sent as plain JSON instead.
                if (url.searchParams.get('stream') === '1') {
                    const key = searchCacheKey(mode, query, opts);
                    const hit = await edgeGet(key);
                    if (hit) return hit;
                    const ts = new TransformStream();
                    const writer = ts.writable.getWriter();
                    const enc = new TextEncoder();
                    const send = o => writer.write(enc.encode(JSON.stringify(o) + '\n')).catch(() => {});
                    ctx.waitUntil((async () => {
                        try {
                            const { results, meta } = await runFullSearch(query, mode, undefined, env, send, opts);
                            await send({ final: { source: 'all', results, meta } });
                            if (results.length > 0) edgePut(key, ctx, degradedTtl(meta), ok({ source: 'all', results, meta }));
                        } catch (e) {
                            await send({ error: String(e && e.message || e) });
                        } finally { writer.close().catch(() => {}); }
                    })());
                    return new Response(ts.readable, { headers: Object.assign({}, CORS, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' }) });
                }

                return withEdgeCache(searchCacheKey(mode, query, opts), ctx, SEARCH_EDGE_TTL_S, async () => {
                    const { results, meta } = await runFullSearch(query, mode, undefined, env, undefined, opts);
                    return [ok({ source: 'all', results, meta }), results.length > 0 && degradedTtl(meta)];
                });
            }

            if (path === '/api/v1/search') {
                if (!apiKeyOk(request, env)) return err('Missing or invalid X-API-Key', 401);

                return withEdgeCache(searchCacheKey(mode, query, opts), ctx, SEARCH_EDGE_TTL_S, async () => {
                    const { results, meta } = await runFullSearch(query, mode, undefined, env, undefined, opts);
                    return [ok({ source: 'all', results, meta }), results.length > 0 && degradedTtl(meta)];
                });
            }

            return err('Unknown endpoint', 404);
        } catch(e) {
            return err('Search error: ' + e.message);
        }
    },
};
