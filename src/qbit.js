// qBittorrent Web API (v2) client: log in, add a magnet with RaveBSD's category, read progress, remove.
// The Web UI wants Referer/Origin to match its own address, so both are sent.
import { settings } from './config.js';

let sid = '', sidFor = '';
const base = (q = settings.qbit) => String(q.url || '').replace(/\/+$/, '');

async function login(q = settings.qbit) {
    const url = base(q);
    const res = await fetch(url + '/api/v2/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: url, Origin: url },
        body: new URLSearchParams({ username: q.username || '', password: q.password || '' }),
        signal: AbortSignal.timeout(8000),
    });
    const text = (await res.text()).trim();
    if (res.status === 403) throw new Error('qBittorrent refused the login (too many failed tries, wait a while)');
    if (text === 'Fails.' || res.status === 401) throw new Error('Wrong qBittorrent username or password');
    if (!res.ok) throw new Error('qBittorrent login failed (' + res.status + ')');
    // qBittorrent 4 calls the cookie SID, 5 calls it QBT_SID_<port>. With "bypass authentication" there is none.
    const m = (res.headers.get('set-cookie') || '').match(/((?:QBT_)?SID(?:_\d+)?)=([^;]+)/);
    sid = m ? m[1] + '=' + m[2] : ''; sidFor = url;
}

async function call(p, { form, method = form ? 'POST' : 'GET' } = {}, retry = true, q = settings.qbit) {
    const url = base(q);
    if (!url) throw new Error('No qBittorrent address set');
    if (sidFor !== url) await login(q);
    const res = await fetch(url + p, {
        method,
        headers: { Referer: url, Origin: url, ...(sid ? { Cookie: sid } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        body: form ? new URLSearchParams(form) : undefined,
        signal: AbortSignal.timeout(10000),
    });
    if (res.status === 403 && retry) { sidFor = ''; await login(q); return call(p, { form, method }, false, q); }
    if (!res.ok) throw new Error('qBittorrent answered ' + res.status);
    const t = await res.text();
    try { return JSON.parse(t); } catch (e) { return t; }
}

export const forgetSession = () => { sidFor = ''; sid = ''; };

// "Found qBittorrent 4.6.5" or throws. over: { url, username, password } to try instead of the saved ones.
export async function testConnection(over) {
    forgetSession();
    try {
        const v = await call('/api/v2/app/version', {}, true, over || settings.qbit);
        return { version: String(v).replace(/^v/, '').trim() };
    } finally { if (over) forgetSession(); } // later calls log in with the saved values again
}

export async function addMagnet(magnet) {
    const category = settings.qbit.category || 'ravebsd';
    // Creating a category that exists answers 409; that is fine.
    await call('/api/v2/torrents/createCategory', { form: { category, savePath: '' } }).catch(() => {});
    let r;
    // 409: qBittorrent already has this torrent. That is fine, RaveBSD will follow it.
    try { r = await call('/api/v2/torrents/add', { form: { urls: magnet, category } }); }
    catch (e) { if (/ 409$/.test(e.message)) return; throw e; }
    if (typeof r === 'string' && /fail/i.test(r)) throw new Error('qBittorrent did not accept the magnet');
}

export async function torrentInfo(hash) {
    const list = await call('/api/v2/torrents/info?hashes=' + encodeURIComponent(hash));
    return Array.isArray(list) ? list[0] || null : null;
}

export const removeTorrent = (hash, deleteFiles) =>
    call('/api/v2/torrents/delete', { form: { hashes: hash, deleteFiles: deleteFiles ? 'true' : 'false' } });

// States where every piece is there (qBittorrent 4 says paused, 5 says stopped).
export const isComplete = t => !!t && (t.progress >= 1 || /^(uploading|stalledUP|pausedUP|stoppedUP|queuedUP|forcedUP|checkingUP)$/.test(t.state));

// qBittorrent's path for the files, as RaveBSD sees it (the two containers may mount the disk differently).
export function mapPath(p) {
    const from = String(settings.qbit.mapFrom || '').replace(/\/+$/, ''), to = String(settings.qbit.mapTo || '').replace(/\/+$/, '');
    if (from && (p === from || p.startsWith(from + '/'))) return to + p.slice(from.length);
    return p;
}
