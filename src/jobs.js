// Downloads to the server, renaming, and the shelf (the list of what is on the server, in shelf.json).
//
// A job goes queued -> downloading -> renaming -> done (or failed). Direct files are fetched here, at most
// "Direct downloads at once" at a time. Magnets go to qBittorrent and are watched until they finish, then
// copied or moved onto the shelf. Every change is announced through `events` (server.js sends them to
// open pages over SSE), so the results page, the Shelf and the nav badge move together.
//
// The page only ever sends a result id (from a search) or a shelf id. Links stay on the server.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { DATA, settings, readJson, writeJson, setAside, countDownload, countSaved } from './config.js';
import { applyTemplate, singleFileAudiobook, numberedPath, tidyName, safeSegment } from './rename.js';
import { getResult, resolveOne, zlibFileLink, freshLibgenLink, currentUA, RESOLVABLE } from './sources.js';
import * as qbit from './qbit.js';
import { vpnBlocks } from './vpn.js';
import { listFiles, extractZip } from './zip.js';
import { fetchPublic, readCapped } from './netguard.js';

export const events = new EventEmitter();
events.setMaxListeners(200);
const emit = (type, data) => events.emit('event', { type, ...data });

const SHELF_FILE = path.join(DATA, 'shelf.json');
const AUDIO_EXT = /\.(mp3|m4b|m4a|aac|flac|ogg|opus|wma|wav)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const newId = () => crypto.randomBytes(8).toString('hex');

// items: what is on the shelf. jobs: downloads not finished yet (failed ones stay until retried or removed).
let shelf = { items: [], jobs: [] };
// A damaged list with no good copy is set aside (the files on disk are untouched) rather than saved over.
try { shelf = { items: [], jobs: [], ...readJson(SHELF_FILE) }; } catch (e) { setAside(SHELF_FILE); }
// A direct download cannot continue after a restart; a torrent can (qBittorrent kept going).
for (const j of shelf.jobs) if (j.how === 'direct' && !/^(failed)$/.test(j.state)) { j.state = 'failed'; j.error = 'RaveBSD restarted during the download'; }
// Older versions saved a job's AbortController, which comes back as {} and cannot abort anything.
for (const j of shelf.jobs) delete j.ctrl;
const save = () => writeJson(SHELF_FILE, shelf);

const dirFor = kind => path.resolve(kind === 'audiobook' ? settings.shelves.audioDir : settings.shelves.ebookDir);
const templateFor = kind => (kind === 'audiobook' ? settings.shelves.audioTemplate : settings.shelves.ebookTemplate);
const key = (kind, title, author) => [kind, title, author].map(s => tidyName(s).toLowerCase()).join('|');
const bookOf = r => ({ author: r.author, title: r.title, year: r.year, series: r.series, narrator: r.narrator, ext: r.format });

// ── Who owns what ────────────────────────────────────────────────────────────
// me = { role: 'admin' | 'user' | 'visitor', user?, vid? } (from auth.who). Visitors (public mode) only see and
// keep what they fetched: jobs list their visitor ids in `owners`, books hold { id, at, savedAt } per visitor and
// go when the last visitor's copy expires. Everyone else shares one shelf.
const isVisitor = me => !!(me && me.role === 'visitor');
const ownerOf = me => isVisitor(me) ? { type: 'visitor' } : me && me.user ? { type: me.role, id: me.user.id, name: me.user.username } : { type: 'admin' };
const holds = (item, vid) => !!(item.owners && item.owners.some(o => o.id === vid));
export const canSee = (me, x) => !isVisitor(me) || (x.owners || []).some(o => (o.id || o) === me.vid);
// Changing a job (cancel, retry, forget): admins any; family users their own; visitors only step away from it.
const canChange = (me, j) => !me || me.role === 'admin' || (me.role === 'user' && j.owner && j.owner.id === me.user.id) || (isVisitor(me) && canSee(me, j));
// The exact file a result points at, so a second request for it is handed the copy already on the server.
const fingerprint = r => r.md5 ? 'md5:' + String(r.md5).toLowerCase() : r.infoHash ? 'bt:' + String(r.infoHash).toLowerCase()
    : r.identifier ? 'ia:' + r.identifier + ':' + (r.format || '') : 'url:' + (r.directUrl || r.downloadUrl || r.id);

// What the page sees of a job (never the link, nor which visitors share it).
const pub = j => { const { link, hash, md5, ctrl, part, owners, fp, ip, ...rest } = j; return rest; };
export const listJobs = me => shelf.jobs.filter(j => canSee(me, j)).map(pub);
export const listShelf = me => shelf.items.filter(i => canSee(me, i));
export const activeCount = me => shelf.jobs.filter(j => j.state !== 'failed' && canSee(me, j)).length;
const announceJobs = () => emit('jobs', {});
let jobsTimer = null;
const announceJobsSoon = () => { if (!jobsTimer) jobsTimer = setTimeout(() => { jobsTimer = null; announceJobs(); }, 400); };

// Space a visitor holds on the server: their books plus what they are fetching.
export function visitorUsage(vid, except) {
    let n = 0;
    for (const i of shelf.items) if (!i.removedAt && holds(i, vid)) n += i.size || 0;
    for (const j of shelf.jobs) if (j !== except && j.state !== 'failed' && (j.owners || []).includes(vid)) n += Math.max(j.total || 0, j.bytes || 0);
    return n;
}
const quota = () => settings.visitors.quotaMB * 1e6;
// Everything visitors hold together, so many visitors (or one with many cookies) cannot fill the disk.
export function visitorsTotal(except) {
    let n = 0;
    for (const i of shelf.items) if (i.visitorsOnly && !i.removedAt) n += i.size || 0;
    for (const j of shelf.jobs) if (j !== except && j.state !== 'failed' && j.owner && j.owner.type === 'visitor') n += Math.max(j.total || 0, j.bytes || 0);
    return n;
}
const totalCap = () => settings.visitors.totalMB * 1e6;
const VISITOR_JOBS_PER_IP = 2;
const mb = n => (n / 1e6 >= 1000 ? (n / 1e9).toFixed(1) + ' GB' : Math.round(n / 1e6) + ' MB');
function attach(item, vid) {
    item.owners = item.owners || [];
    const o = item.owners.find(x => x.id === vid);
    if (o) o.at = Date.now(); else item.owners.push({ id: vid, at: Date.now(), savedAt: 0 });
}

// ── Results: what the page needs to know about each search result ────────────
const onShelfKeys = () => new Set(shelf.items.filter(i => !i.removedAt && !i.moved).map(i => key(i.kind, i.title, i.author)));
let shelfKeys = onShelfKeys();
export function decorateResult(r) {
    r.kind = r._mode === 'audiobooks' ? 'audiobook' : 'ebook';
    // AudiobookBay results are always magnets. Their links are read from the post only when used (download,
    // copy, torrent file): reading every post per search got this server's address refused by the site.
    r.linkType = r.magnet || r.source === 'AudiobookBay' ? 'magnet' : r.directUrl ? 'direct' : RESOLVABLE.has(r.source) && !r._resolved ? 'pending' : 'page';
    return Object.assign(r, liveMarks(null, r));
}
// What changes after a search is cached (server.js puts it right on every answer): whether the book is on the
// shelf (for a visitor, their own), a download already running for it, and where today's template files it.
export function liveMarks(me, r) {
    const kind = r.kind || (r._mode === 'audiobooks' ? 'audiobook' : 'ebook');
    const t = templateFor(kind);
    const job = shelf.jobs.find(j => j.resultId === r.id && canSee(me, j));
    return {
        onShelf: onShelfFor(me, { ...r, kind }),
        // Relative to the shelf folder: the folder itself is the admin's business (their page adds it).
        fileAs: kind === 'audiobook' && /\{track\}/.test(t)
            ? singleFileAudiobook(t, bookOf(r)).replace(/\.[^.]*$/, '') + '/'
            : applyTemplate(t, bookOf(r), { tidy: settings.shelves.tidy }),
        jobId: job ? job.id : '',
    };
}

// ── Starting a download ──────────────────────────────────────────────────────
// From the shelf as it is now. A visitor sees "On the shelf" only for books they hold.
export function onShelfFor(me, r) {
    const k = key(r.kind, r.title, r.author);
    if (!isVisitor(me)) return shelfKeys.has(k);
    return shelf.items.some(i => !i.removedAt && !i.moved && holds(i, me.vid) && key(i.kind, i.title, i.author) === k);
}

export async function startDownload(resultId, clientId, me) {
    if (vpnBlocks()) throw new Error('The VPN tunnel is down, so downloads are paused');
    const visitor = isVisitor(me);
    if (visitor && !settings.visitors.downloads) throw new Error('Downloads to this server are switched off');
    if (visitor && !me.vid) throw new Error('Reload the page and try again');
    const existing = () => shelf.jobs.find(j => j.resultId === resultId && j.state !== 'failed' && canSee(me, j));
    if (existing()) return pub(existing());
    const r = getResult(resultId);
    if (!r) throw new Error('That result has expired. Search again.');
    await resolveOne(resultId);
    // Asked twice at once (a double click): the second is handed the job the first just made.
    if (existing()) return pub(existing());
    const fp = fingerprint(r);
    if (visitor) {
        // Already on the server, or on its way: this visitor shares it instead of fetching it again.
        const have = shelf.items.find(i => i.fp === fp && !i.removedAt && !i.moved && fileFor(i));
        if (have) {
            attach(have, me.vid); save(); emit('shelf', {});
            emit('done', { jobId: '', resultId, clientId: String(clientId || ''), owners: [me.vid], kind: have.kind, title: have.title, shelfId: have.id, note: '', autoSave: false });
            return { shelfId: have.id, title: have.title, resultId, state: 'done' };
        }
        // The limit is per visitor cookie; the server-wide total, new ids per address (server.js) and running
        // downloads per address keep fresh cookies from adding up.
        const used = visitorUsage(me.vid);
        const going = shelf.jobs.find(j => j.fp === fp && j.state !== 'failed');
        if (used + Math.max(r.filesize || 0, going ? going.total || 0 : 0) > quota()) throw new Error(`That would go over your space here (${mb(used)} of ${mb(quota())} used). Remove something from your shelf first.`);
        if (going) { if (!going.owners.includes(me.vid)) going.owners.push(me.vid); save(); announceJobs(); return pub(going); }
        if (visitorsTotal() + (r.filesize || 0) > totalCap()) throw new Error('This server is full for now. Try again in a few days, when older downloads are cleared.');
        if (shelf.jobs.filter(j => j.ip && j.ip === me.ip && j.state !== 'failed').length >= VISITOR_JOBS_PER_IP) throw new Error(`Wait for your ${VISITOR_JOBS_PER_IP} downloads to finish first.`);
    }
    const kind = r._mode === 'audiobooks' ? 'audiobook' : 'ebook';
    const job = {
        id: newId(), resultId, clientId: String(clientId || '').slice(0, 64), kind,
        title: r.title || 'Untitled', author: r.author || '', year: r.year || '', series: r.series || '', narrator: r.narrator || '',
        format: String(r.format || '').toLowerCase(), size: r.filesize || 0, source: r.source || '', pageUrl: r.pageUrl || r.downloadUrl || r.detailUrl || '',
        coverUrl: r.coverUrl || '', state: 'queued', progress: 0, bytes: 0, total: r.filesize || 0, speed: 0, peers: 0, createdAt: Date.now(),
        fp, owner: ownerOf(me), owners: visitor ? [me.vid] : [], ...(visitor ? { ip: me.ip || '' } : {}),
    };
    if (r.magnet) {
        if (!settings.qbit.enabled) throw new Error('qBittorrent is switched off in the admin panel');
        job.how = 'qbit'; job.link = r.magnet;
        job.hash = String(r.infoHash || (r.magnet.match(/btih:([a-f0-9]{40})/i) || [])[1] || '').toLowerCase();
    } else if (r.directUrl) {
        job.how = 'direct'; job.link = r.directUrl;
        if (/\/get\.php\?md5=/.test(r.directUrl) && r.md5) job.md5 = String(r.md5).toLowerCase();
    } else throw new Error('This one has no file link. Open the source page instead.');
    // Z-Library files come through the owner's account and count against its daily limit.
    if (visitor && job.link.startsWith('/dl/zlib')) throw new Error('Z-Library downloads here are for the owner. Open the source page instead.');
    shelf.jobs.push(job);
    save();
    announceJobs();
    if (job.how === 'qbit') addToQbit(job); else pump();
    return pub(job);
}

export function retry(jobId, me) {
    const j = shelf.jobs.find(x => x.id === jobId && x.state === 'failed' && canSee(me, x) && canChange(me, x));
    if (!j) throw new Error('Nothing to retry');
    if (vpnBlocks()) throw new Error('The VPN tunnel is down, so downloads are paused');
    // The search result may still hold a fresher link (LibGen keys expire).
    const r = getResult(j.resultId);
    if (r && j.how === 'direct' && r.directUrl) j.link = r.directUrl;
    Object.assign(j, { state: 'queued', error: '', progress: 0, bytes: 0, createdAt: Date.now() });
    save(); announceJobs();
    if (j.how === 'qbit') addToQbit(j); else pump();
    return pub(j);
}

export async function cancel(jobId, me) {
    const j = shelf.jobs.find(x => x.id === jobId && canSee(me, x) && canChange(me, x));
    if (!j) return;
    // Started by someone else, or shared: a visitor just steps away from it.
    if (isVisitor(me) && (j.owners.length > 1 || !(j.owner && j.owner.type === 'visitor'))) { j.owners = j.owners.filter(v => v !== me.vid); save(); announceJobs(); return; }
    await drop(j);
    save(); announceJobs();
    pump();
}

// Stops a job for good: off the list first (runDirect then gives up quietly), then the download, its temp
// file and its torrent.
async function drop(j) {
    shelf.jobs = shelf.jobs.filter(x => x !== j);
    if (j.ctrl) j.ctrl.abort();
    if (j.part) fs.rm(j.part, { force: true }, () => {});
    if (j.how === 'qbit' && j.hash && j.state !== 'failed') await qbit.removeTorrent(j.hash, true).catch(() => {});
}

function fail(j, msg) {
    if (!shelf.jobs.includes(j)) return; // already cancelled or forgotten: nobody to tell
    j.state = 'failed'; j.error = msg; delete j.ctrl;
    if (j.part) fs.rm(j.part, { force: true }, () => {});
    save(); announceJobs();
    emit('failed', { job: pub(j), owners: j.owners || [] });
}

// ── Direct downloads ─────────────────────────────────────────────────────────
let running = 0;
// Nothing new starts while the VPN tunnel is down; server.js pumps again when it is back.
export function pump() {
    while (running < settings.qbit.directSlots && !vpnBlocks()) {
        const j = shelf.jobs.find(x => x.how === 'direct' && x.state === 'queued');
        if (!j) break;
        running++;
        runDirect(j).finally(() => {
            running--;
            // The last download out removes the temp folders, when empty.
            if (!running) for (const k of ['ebook', 'audiobook']) fs.rmdir(path.join(dirFor(k), '.incoming'), () => {});
            pump();
        });
    }
    // Jobs left waiting say so ("Waiting for a free slot (2 at a time)", or for the tunnel).
    for (const j of shelf.jobs) if (j.how === 'direct' && j.state === 'queued') j.wait = vpnBlocks() ? 'vpn' : 'slot';
    announceJobsSoon();
}

const filenameFrom = (res, url) => {
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    let name = '';
    try { name = m ? decodeURIComponent(m[1]) : decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch (e) { name = m ? m[1] : ''; }
    return path.basename(name.replace(/\\/g, '/'));
};

async function runDirect(j) {
    j.state = 'downloading'; j.wait = ''; j.progress = 0;
    // Not enumerable, so shelf.json never holds it.
    const ctrl = new AbortController();
    Object.defineProperty(j, 'ctrl', { value: ctrl, writable: true, configurable: true });
    let idle = null;
    // Give up if nothing arrives for a minute; big files may take as long as they need otherwise.
    const stall = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('The site stopped sending')), 60e3); };
    announceJobs();
    const dir = dirFor(j.kind);
    const incoming = path.join(dir, '.incoming');
    let out = null;
    try {
        let url = j.link;
        if (j.md5) url = (await freshLibgenLink(j.md5)) || url;
        // Z-Library's account links are made on demand and count against the daily limit.
        if (url.startsWith('/dl/zlib')) { const u = new URL(url, 'http://x'); url = await zlibFileLink(u.searchParams.get('id') || '', u.searchParams.get('hash') || ''); }
        if (!/^https?:\/\//i.test(url)) throw new Error('Not a web link');
        stall();
        let res; const failed = []; let rounds = 0;
        for (;;) {
            res = await fetchPublic(url, { signal: ctrl.signal, headers: { 'User-Agent': currentUA(), Accept: '*/*' } });
            stall();
            if (res.status < 500 || !j.md5) break;
            if (res.body) res.body.cancel().catch(() => {});
            // A LibGen mirror erroring: another mirror's link to the same file usually works.
            failed.push(new URL(url).origin);
            let next = await freshLibgenLink(j.md5, failed);
            // When LibGen's database is overloaded every mirror fails at once: wait, then go round again.
            if (!next && rounds < 2) {
                await new Promise(ok => setTimeout(ok, ++rounds * 8000));
                if (ctrl.signal.aborted) throw ctrl.signal.reason || new Error('Cancelled');
                stall(); failed.length = 0;
                next = await freshLibgenLink(j.md5);
            }
            if (!next) break;
            url = next;
        }
        if (!res.ok && j.md5 && res.status >= 500) throw new Error('LibGen is overloaded right now. Try again in a few minutes.');
        if (!res.ok) throw new Error(res.status === 404 || res.status === 410 ? 'Stale link' : 'The site answered ' + res.status);
        if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new Error('Stale link: the site sent a page instead of the file');
        j.total = Number(res.headers.get('content-length')) || j.total || 0;
        const original = filenameFrom(res, res.url || url);
        j.originalName = original;
        const extFromName = (original.match(/\.([a-z0-9]{2,5})$/i) || [])[1];
        if (extFromName && !/^(php|html?|aspx?)$/i.test(extFromName)) j.format = extFromName.toLowerCase();
        // A visitor's download stops at their space limit, sizes the site did not say up front included.
        const vid = j.owner && j.owner.type === 'visitor' && (j.owners || [])[0];
        const room = vid ? Math.min(quota() - visitorUsage(vid, j), totalCap() - visitorsTotal(j)) : Infinity;
        if (j.total > room) throw new Error(`That would go over your space here (${mb(quota())} each)`);
        // Made here, after the site answered, so a temp folder removed as another download ended is back.
        await fsp.mkdir(incoming, { recursive: true });
        j.part = path.join(incoming, j.id + '.part');
        out = fs.createWriteStream(j.part);
        // A full or failing disk ends this download instead of the whole server.
        out.on('error', e => ctrl.abort(e));
        let last = 0, lastBytes = 0, lastT = Date.now();
        for await (const chunk of res.body) {
            stall();
            if (!out.write(chunk)) await once(out, 'drain', { signal: ctrl.signal }); // rejects if the write fails or the job stops
            j.bytes += chunk.length;
            if (j.bytes > room) { out.destroy(); throw new Error(`That went over your space here (${mb(quota())} each)`); }
            const now = Date.now();
            if (now - last > 500) {
                j.speed = Math.round((j.bytes - lastBytes) / ((now - lastT) / 1000)); lastBytes = j.bytes; lastT = now; last = now;
                j.progress = j.total ? Math.min(0.99, j.bytes / j.total) : 0;
                announceJobsSoon();
            }
        }
        clearTimeout(idle);
        await new Promise((r, e) => out.end(err => (err ? e(err) : r())));
        if (j.bytes < 200) throw new Error('Stale link: the file was empty');
        j.size = j.bytes;
        if (j.kind === 'audiobook' && (j.format === 'zip' || /\.zip$/i.test(j.originalName || ''))) {
            // LibriVox and Internet Archive send a whole audiobook as one zip: file its tracks, not the zip.
            const unpacked = path.join(incoming, j.id);
            try {
                // Unpacked size counts like downloaded size: within a visitor's room, and at most 20 times the zip otherwise.
                const tracks = await extractZip(j.part, unpacked, Math.min(room, j.bytes * 20 + 50e6));
                if (!tracks.some(f => AUDIO_EXT.test(f))) throw new Error('The zip held no audio');
                await fileIt(j, tracks, { srcRoot: unpacked });
            } finally { await fsp.rm(unpacked, { recursive: true, force: true }); await fsp.rm(j.part, { force: true }); }
        } else await fileIt(j, [j.part]);
    } catch (e) {
        clearTimeout(idle);
        if (out) out.destroy();
        if (!shelf.jobs.includes(j)) return; // cancelled
        const reason = ctrl.signal.aborted && ctrl.signal.reason;
        fail(j, (reason && reason.message) || (e.cause && e.cause.code ? 'Could not reach the site' : e.message) || 'Download failed');
    }
}

// ── qBittorrent ──────────────────────────────────────────────────────────────
async function addToQbit(j) {
    try {
        // One qBittorrent already has (handed over before a restart, or added by hand) is followed, not added again.
        if (!(j.hash && await qbit.torrentInfo(j.hash))) await qbit.addMagnet(j.link);
        j.state = 'downloading'; j.addedToQbit = Date.now();
        save(); announceJobs();
        watchTorrents();
    } catch (e) { fail(j, e.cause && e.cause.code ? 'Could not reach qBittorrent' : e.message); }
}

let watching = null, round = false;
function watchTorrents() {
    if (watching) return;
    watching = setInterval(async () => {
        // A round slower than the interval (a slow qBittorrent, a big copy) is not joined by the next one.
        if (round) return;
        const list = shelf.jobs.filter(j => j.how === 'qbit' && j.state === 'downloading');
        if (!list.length) { clearInterval(watching); watching = null; return; }
        round = true;
        try { for (const j of list) {
            try {
                const t = await qbit.torrentInfo(j.hash);
                if (!shelf.jobs.includes(j) || j.state !== 'downloading') continue; // cancelled or forgotten meanwhile
                delete j.qbitError;
                if (!t) { if (Date.now() - (j.addedToQbit || 0) > 120e3) fail(j, 'qBittorrent lost this torrent'); continue; }
                j.progress = Math.min(1, t.progress || 0); j.speed = t.dlspeed || 0; j.peers = (t.num_seeds || 0) + (t.num_leechs || 0);
                j.total = t.size || t.total_size || j.total; j.bytes = Math.round(j.total * j.progress); j.eta = t.eta;
                const vid = j.owner && j.owner.type === 'visitor' && (j.owners || [])[0];
                if (vid && j.total > quota() - visitorUsage(vid, j)) { await qbit.removeTorrent(j.hash, true).catch(() => {}); fail(j, `That would go over your space here (${mb(quota())} each)`); continue; }
                if (qbit.isComplete(t)) { j.state = 'renaming'; announceJobs(); await finishTorrent(j, t); }
            } catch (e) { j.qbitError = 'Could not reach qBittorrent'; }
        } } finally { round = false; }
        announceJobsSoon();
    }, 3000);
}
// After a restart, torrents carry on: qBittorrent kept going. One caught being handed over is handed over again
// (or found there), and one caught being filed is filed again once the watcher sees it complete.
for (const j of shelf.jobs) if (j.how === 'qbit' && j.state === 'renaming') j.state = 'downloading';
for (const j of shelf.jobs) if (j.how === 'qbit' && j.state === 'queued') addToQbit(j);
if (shelf.jobs.some(j => j.how === 'qbit' && j.state === 'downloading')) watchTorrents();

async function finishTorrent(j, t) {
    const src = qbit.mapPath(t.content_path || path.join(t.save_path || '', t.name || ''));
    try {
        const st = await fsp.stat(src).catch(() => null);
        if (!st) throw new Error(`RaveBSD cannot see qBittorrent's files at ${src}. Check the folder mapping in the admin panel, under qBittorrent.`);
        const files = st.isDirectory() ? listFiles(src).map(f => f.abs) : [src];
        j.originalName = path.basename(src);
        await fileIt(j, files, { copy: true, srcRoot: st.isDirectory() ? src : '' });
        if (settings.qbit.onFinish === 'move') await qbit.removeTorrent(j.hash, true).catch(() => {});
    } catch (e) { fail(j, e.message); }
}

// ── Renaming and filing ──────────────────────────────────────────────────────
const exists = p => fs.existsSync(p);
// Names being filed right now count as taken, so two downloads of the same book never pick the same one.
const filing = new Set();
const taken = p => filing.has(p) || exists(p);
async function place(from, to, copy) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    if (!copy) try { await fsp.rename(from, to); return; } catch (e) { /* another disk: copy it */ }
    // Under a temporary name until complete, so a copy cut short (a restart) never passes for the book.
    const tmp = to + '.incoming';
    try { await fsp.copyFile(from, tmp); await fsp.rename(tmp, to); } catch (e) { await fsp.rm(tmp, { force: true }); throw e; }
    if (!copy) await fsp.rm(from, { force: true });
}
// Every target must stay inside the shelf folder, whatever the template or the source said.
const inside = (dir, p) => { const r = path.resolve(dir, p); if (r !== dir && !r.startsWith(dir + path.sep)) throw new Error('Bad file name'); return r; };

// Exported for the tests.
export async function fileIt(j, files, { copy = false, srcRoot = '' } = {}) {
    j.state = 'renaming'; j.progress = 1; announceJobs();
    const dir = dirFor(j.kind);
    const book = { author: j.author, title: j.title, year: j.year, series: j.series, narrator: j.narrator };
    const rename = settings.shelves.rename;
    const dup = settings.shelves.duplicate;
    let mainPath, placed = [];

    const audio = files.filter(f => AUDIO_EXT.test(f));
    const multi = j.kind === 'audiobook' && audio.length > 1;
    if (!multi) {
        // One file: the book itself (for torrents, the biggest matching file).
        const pick = files.length === 1 ? files[0]
            : (j.kind === 'audiobook' ? audio : files.filter(f => /\.(epub|pdf|mobi|azw3?|fb2|djvu|cbz|cbr|txt|rtf|docx?)$/i.test(f)))
                .concat(files).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
        const ext = (pick.match(/\.([a-z0-9]{2,5})$/i) || [])[1] && !pick.endsWith('.part') ? pick.match(/\.([a-z0-9]{2,5})$/i)[1] : j.format || 'bin';
        j.format = ext.toLowerCase();
        let rel;
        if (!rename) rel = safeSegment(settings.shelves.tidy ? tidyName(j.originalName || path.basename(pick)) : (j.originalName || path.basename(pick))) || j.id + '.' + j.format;
        else rel = j.kind === 'audiobook' ? singleFileAudiobook(templateFor(j.kind), { ...book, ext: j.format })
            : applyTemplate(templateFor(j.kind), { ...book, ext: j.format }, { tidy: settings.shelves.tidy });
        let target = inside(dir, rel);
        if (taken(target)) {
            if (dup === 'skip') return finish(j, null, 'Already on your shelf, so it was skipped', target);
            // "Replace it" never replaces a file another download is still writing.
            if (dup === 'both' || filing.has(target)) target = numberedPath(target, taken);
        }
        filing.add(target);
        try { await place(pick, target, copy); } finally { filing.delete(target); }
        mainPath = target; placed = [target];
    } else {
        // Many tracks: a folder named from the template, tracks numbered in order, cover alongside.
        audio.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        let folder;
        if (!rename) folder = inside(dir, safeSegment(path.basename(srcRoot || j.title)) || j.id);
        else folder = inside(dir, applyTemplate(templateFor(j.kind), { ...book, track: 1, trackCount: audio.length, ext: 'x' }).split('/').slice(0, -1).join('/') || safeSegment(j.title) || j.id);
        if (taken(folder)) {
            if (dup === 'skip') return finish(j, null, 'Already on your shelf, so it was skipped', folder);
            if (dup === 'both' || filing.has(folder)) folder = numberedPath(folder, taken);
        }
        filing.add(folder);
        // Built under a temporary name and renamed when complete, so a folder cut short never passes for the book.
        const building = folder + '.incoming';
        try {
            await fsp.rm(building, { recursive: true, force: true });
            const tpl = templateFor(j.kind);
            for (let i = 0; i < audio.length; i++) {
                const ext = audio[i].match(/\.([a-z0-9]+)$/i)[1].toLowerCase();
                const name = rename ? applyTemplate(tpl, { ...book, track: i + 1, trackCount: audio.length, ext }).split('/').pop() : path.relative(srcRoot, audio[i]);
                const target = inside(building, name);
                await place(audio[i], target, copy);
                placed.push(path.join(folder, path.relative(building, target)));
            }
            const cover = files.find(f => IMAGE_EXT.test(f));
            if (cover) await place(cover, path.join(building, 'cover' + path.extname(cover).toLowerCase().replace('jpeg', 'jpg')), copy).catch(() => {});
            else if (/^https?:\/\//.test(j.coverUrl || '')) await saveCover(j.coverUrl, path.join(building, 'cover.jpg')).catch(() => {});
            if (exists(folder)) await fsp.rm(folder, { recursive: true, force: true }); // "Replace it"
            await fsp.rename(building, folder);
        } catch (e) { await fsp.rm(building, { recursive: true, force: true }); throw e; }
        finally { filing.delete(folder); }
        j.format = (audio[0].match(/\.([a-z0-9]+)$/i)[1] || '').toLowerCase();
        mainPath = folder;
        j.tracks = audio.length;
    }
    let size = 0;
    for (const p of placed) size += (await fsp.stat(p)).size;
    return finish(j, { path: mainPath, size, tracks: j.tracks || 1 });
}

// The result's cover next to an audiobook's tracks, for players that show folder art. At most 5 MB.
async function saveCover(url, to) {
    const res = await fetchPublic(url, { headers: { 'User-Agent': currentUA() }, signal: AbortSignal.timeout(15000) });
    if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) { if (res.body) res.body.cancel().catch(() => {}); return; }
    await fsp.writeFile(to, await readCapped(res, 5e6));
}

// skipped: the path of a book already on disk under the same name (duplicate set to "skip").
function finish(j, filed, note, skipped) {
    // A visitor's job let go of while its files were being placed still lands, but as a visitors' book nobody
    // holds, so tidy() removes it instead of it staying on the shelf with no owner and no quota.
    const orphan = !shelf.jobs.includes(j) && !!(j.owner && j.owner.type === 'visitor');
    shelf.jobs = shelf.jobs.filter(x => x !== j);
    if (j.part) fs.rm(j.part, { force: true }, () => {});
    const owners = j.owners || [];
    let item = null;
    if (filed) {
        item = {
            id: newId(), kind: j.kind, title: j.title, author: j.author, year: j.year, series: j.series, narrator: j.narrator,
            format: j.format, size: filed.size, tracks: filed.tracks, source: j.source, pageUrl: j.pageUrl, coverUrl: j.coverUrl,
            how: j.how, path: filed.path, originalName: j.originalName || '', addedAt: Date.now(), savedAt: 0, removedAt: 0, moved: false,
            fp: j.fp || '', addedBy: j.owner || { type: 'admin' },
            // Fetched for visitors: theirs until it expires, then removed from the server.
            ...(owners.length ? { visitorsOnly: !!(j.owner && j.owner.type === 'visitor'), owners: owners.map(id => ({ id, at: Date.now(), savedAt: 0 })) } : {}),
            ...(orphan ? { visitorsOnly: true, owners: [] } : {}),
        };
        // "Replace it": the old row for this file goes, and whoever held it keeps it.
        const old = shelf.items.filter(i => path.resolve(i.path) === path.resolve(filed.path));
        for (const o of old) for (const w of o.owners || []) attach(item, w.id);
        if (old.length) shelf.items = shelf.items.filter(i => !old.includes(i));
        shelf.items.unshift(item);
        if (orphan) setImmediate(() => tidy().catch(() => {}));
        shelfKeys = onShelfKeys();
        countDownload({ kind: j.kind, format: j.format, bytes: filed.size, author: j.author });
    } else if (skipped && owners.length) {
        // The same book was already on disk: the visitors share that copy.
        item = shelf.items.find(i => !i.removedAt && path.resolve(i.path) === path.resolve(skipped)) || null;
        if (item) { for (const v of owners) attach(item, v); note = ''; }
    }
    save();
    announceJobs();
    emit('shelf', {});
    emit('done', { jobId: j.id, resultId: j.resultId, clientId: j.clientId, owners, kind: j.kind, title: j.title, shelfId: item ? item.id : '', note: note || '',
        autoSave: !!(item && j.kind === 'ebook' && settings.saving.allow && settings.saving.auto) });
    checkSpace();
}

// ── Shelf actions ────────────────────────────────────────────────────────────
export const getItem = id => shelf.items.find(i => i.id === id);

// The file to send to a device, checked to still be inside a shelf folder.
export function fileFor(item) {
    if (!item || item.removedAt || item.moved) return null;
    const p = path.resolve(item.path);
    const okDir = [dirFor('ebook'), dirFor('audiobook')].some(d => p.startsWith(d + path.sep));
    if (!okDir || !exists(p)) return null;
    return { path: p, isDir: fs.statSync(p).isDirectory() };
}

// Stats count a book's first save (a visitor's: the first save of their copy), not every save after.
export function markSaved(item, me) {
    const o = isVisitor(me) && (item.owners || []).find(x => x.id === me.vid);
    const first = !(o || item).savedAt;
    if (o) o.savedAt = Date.now(); else item.savedAt = Date.now();
    save(); if (first) countSaved(); emit('shelf', {});
}

// Visitors only let go of their own copy (the file goes once nobody holds it). Family users remove what they
// added; admins anything.
export async function deleteItems(ids, me) {
    const gone = [];
    for (const id of ids) {
        const item = getItem(id);
        if (!item || !canSee(me, item)) continue;
        if (isVisitor(me)) {
            item.owners = item.owners.filter(o => o.id !== me.vid);
            if (!item.visitorsOnly || item.owners.length) { save(); emit('shelf', {}); continue; }
        } else if (me && me.role === 'user' && !(item.addedBy && item.addedBy.id === me.user.id)) continue;
        const f = fileFor(item);
        if (f) await fsp.rm(f.path, { recursive: true, force: true });
        await pruneDirs(item);
        gone.push(id);
    }
    shelf.items = shelf.items.filter(i => !gone.includes(i.id));
    shelfKeys = onShelfKeys();
    save(); emit('shelf', {});
    return gone.length;
}
export function forget(id, me) {
    if (isVisitor(me)) {
        const i = getItem(id); if (i && holds(i, me.vid)) i.owners = i.owners.filter(o => o.id !== me.vid);
        const j = shelf.jobs.find(x => x.id === id && (x.owners || []).includes(me.vid));
        // The last visitor to let go of a visitor's job stops it, or it would keep downloading onto the shelf with
        // no owner. One the admin or a family user started keeps going for them.
        if (j) { j.owners = j.owners.filter(v => v !== me.vid); if (!j.owners.length && j.owner && j.owner.type === 'visitor') drop(j).then(pump, () => {}); }
        save(); emit('shelf', {}); announceJobs();
        return;
    }
    const j = shelf.jobs.find(x => x.id === id);
    if (j && !canChange(me, j)) return;
    if (me && me.role === 'user') { const i = getItem(id); if (i && !(i.addedBy && i.addedBy.id === me.user.id)) return; }
    shelf.items = shelf.items.filter(i => i.id !== id);
    if (j) drop(j).then(pump, () => {});
    shelfKeys = onShelfKeys();
    save(); emit('shelf', {}); announceJobs();
}

// Removes folders the template made that are now empty (the author folder, for example).
async function pruneDirs(item) {
    let d = path.dirname(path.resolve(item.path));
    const root = dirFor(item.kind);
    while (d.startsWith(root + path.sep)) { try { await fsp.rmdir(d); } catch (e) { break; } d = path.dirname(d); }
}

// Files moved or deleted by another app: mark them "Moved" (or drop them, per the admin panel).
export function checkMoved() {
    let changed = false;
    for (const i of shelf.items) {
        if (i.removedAt || i.moved) continue;
        if (!exists(i.path)) { i.moved = true; changed = true; }
    }
    if (changed && !settings.shelves.keepMoved) shelf.items = shelf.items.filter(i => !i.moved);
    if (changed) { shelfKeys = onShelfKeys(); save(); emit('shelf', {}); }
}

// ── Space and tidy-up ────────────────────────────────────────────────────────
// Checking a folder never creates it (the admin panel checks as you type): an unmade folder is measured at its
// nearest existing parent, and counts as writable if that parent is.
export async function freeSpace(dir) {
    try {
        while (!exists(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
        const s = await fsp.statfs(dir);
        let writable = true;
        try { await fsp.access(dir, fs.constants.W_OK); } catch (e) { writable = false; }
        return { free: s.bavail * s.bsize, total: s.blocks * s.bsize, writable };
    } catch (e) { return { free: 0, total: 0, writable: false, error: e.code || e.message }; }
}

export let lowSpace = false;
export async function checkSpace() {
    const limit = settings.storage.lowSpaceGB * 1e9;
    const [a, b] = limit ? await Promise.all([freeSpace(dirFor('ebook')), freeSpace(dirFor('audiobook'))]) : [{}, {}];
    const low = !!limit && !!((a.total && a.free < limit) || (b.total && b.free < limit));
    if (low && !lowSpace) emit('lowSpace', { free: Math.min(a.free || Infinity, b.free || Infinity), dir: a.free <= b.free ? dirFor('ebook') : dirFor('audiobook') });
    if (low !== lowSpace) { lowSpace = low; emit('status', {}); }
}

// Visitors' copies expire after "keep for" days; a book only visitors held goes from the server with the last.
// "Remove from the server once saved to a device": a day after saving, the server copy goes.
export async function tidy(now = Date.now()) {
    let changed = false;
    const keep = settings.visitors.keepDays * 864e5;
    for (const i of shelf.items) {
        if (!i.owners || !i.owners.length) continue;
        const left = i.owners.filter(o => now - o.at < keep);
        if (left.length !== i.owners.length) { i.owners = left; changed = true; }
    }
    for (const i of shelf.items.filter(x => x.visitorsOnly && !x.owners.length && !x.removedAt)) {
        const f = fileFor(i);
        if (f) { await fsp.rm(f.path, { recursive: true, force: true }).catch(() => {}); await pruneDirs(i); }
        shelf.items = shelf.items.filter(x => x !== i); changed = true;
    }
    if (!settings.storage.removeAfterSaved) { if (changed) { shelfKeys = onShelfKeys(); save(); emit('shelf', {}); } return; }
    for (const i of shelf.items) {
        if (i.visitorsOnly || !i.savedAt || i.removedAt || i.moved || now - i.savedAt < 864e5) continue;
        const f = fileFor(i);
        if (f) { await fsp.rm(f.path, { recursive: true, force: true }).catch(() => {}); await pruneDirs(i); }
        i.removedAt = Date.now(); changed = true;
    }
    if (changed) { shelfKeys = onShelfKeys(); save(); emit('shelf', {}); }
}

setInterval(() => { checkMoved(); checkSpace(); }, 60e3).unref();
setInterval(tidy, 3600e3).unref();
setTimeout(() => { checkMoved(); checkSpace(); tidy(); }, 2000).unref();

// Sizes on the shelf per kind, for the Stats storage card.
export function shelfBytes() {
    const out = { ebook: 0, audiobook: 0 };
    for (const i of shelf.items) if (!i.removedAt && !i.moved) out[i.kind] += i.size || 0;
    return out;
}

// Backup and restore of the shelf list (not the files).
export const shelfBackup = () => JSON.parse(JSON.stringify({ items: shelf.items }));
export function shelfRestore(data) {
    if (!data || !Array.isArray(data.items)) return;
    // A restored list may only point inside the shelf folders, so a crafted backup cannot aim Delete elsewhere.
    const roots = [dirFor('ebook'), dirFor('audiobook')];
    shelf.items = data.items.filter(i => i && typeof i.id === 'string' && typeof i.path === 'string'
        && roots.some(d => path.resolve(i.path).startsWith(d + path.sep)));
    shelfKeys = onShelfKeys();
    save(); emit('shelf', {});
}
