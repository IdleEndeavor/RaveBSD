// Links found on other websites (covers, download links) are fetched by this server. A listing could point
// one at something on the owner's own network (a router page, another container), so those fetches only go
// to public addresses, checked again on every redirect.
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import zlib from 'node:zlib';

function v4Private(ip) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT, also Tailscale's range
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
}
// An IPv6 address as its eight 16-bit groups, whatever way it was written ("::", a trailing dotted IPv4, a zone).
function v6Groups(ip) {
    let s = ip.toLowerCase().replace(/%.*$/, '');
    const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (dotted) { const [a, b, c, d] = dotted.slice(1).map(Number); s = s.slice(0, -dotted[0].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16); }
    const [head, rest] = s.split('::');
    const h = head ? head.split(':') : [], r = rest === undefined ? null : rest ? rest.split(':') : [];
    const g = r === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - r.length)).fill('0'), ...r];
    return g.map(x => parseInt(x || '0', 16) || 0);
}
const v4From = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
export function isPrivateIp(ip) {
    if (net.isIPv4(ip)) return v4Private(ip);
    const g = v6Groups(ip);
    // Addresses carrying an IPv4 address are judged by it: ::a.b.c.d, ::ffff:a.b.c.d (mapped), 64:ff9b::/96 (NAT64),
    // 2002::/16 (6to4). Teredo (2001::/32) hides one too, so it is refused outright.
    if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0 || g[5] === 0xffff)) return g[6] === 0 && g[7] <= 1 ? true : v4Private(v4From(g[6], g[7]));
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4Private(v4From(g[6], g[7]));
    if (g[0] === 0x2002) return v4Private(v4From(g[1], g[2]));
    if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return true; // Teredo, documentation
    if (g[0] === 0x100 && g.slice(1, 4).every(x => x === 0)) return true; // discard-only
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00;
}

export async function assertPublicUrl(url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Not a web link');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('That link points inside a private network');
}

// A fetch() that connects only to addresses allow() accepts. The name is looked up once and the address that was
// checked is the one connected to, so a DNS server answering differently a second time cannot slip in a private one.
// No redirects followed. Network errors look like fetch()'s (TypeError, cause.code), an abort rejects with its reason.
const UNZIP = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
// Content-Encoding lists the codings in the order they were applied; one this does not know leaves the body as sent.
function decoders(header) {
    const codings = String(header || '').toLowerCase().split(',').map(x => x.trim()).filter(x => x && x !== 'identity');
    return codings.every(c => UNZIP[c]) ? codings.reverse().map(c => UNZIP[c]()) : [];
}
export function pinnedFetch(url, init = {}, allow = ip => !isPrivateIp(ip)) {
    const u = new URL(url), { signal } = init;
    if (!/^https?:$/.test(u.protocol)) return Promise.reject(new Error('Not a web link'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const refused = () => new Error('That link points inside a private network');
    // Node connects to an address literal without calling lookup, so it is judged here.
    if (net.isIP(host) && !allow(host)) return Promise.reject(refused());
    const lookup = (name, opts, cb) => dns.lookup(name, { all: true }).then(addrs => {
        if (!addrs.length || addrs.some(a => !allow(a.address))) return cb(refused());
        if (opts.all) cb(null, addrs); else cb(null, addrs[0].address, addrs[0].family);
    }, cb);
    const headers = { 'Accept-Encoding': 'gzip, deflate, br', ...Object.fromEntries(new Headers(init.headers)) };
    return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(signal.reason);
        let res = null;
        const onAbort = () => { req.destroy(signal.reason); if (res) res.destroy(signal.reason); };
        const req = (u.protocol === 'https:' ? https : http).request(u, { method: init.method || 'GET', headers, lookup }, r => {
            res = r;
            r.on('close', () => signal && signal.removeEventListener('abort', onAbort));
            // Whatever a site answers ends in a Response or a rejection, never in an exception that takes the server down.
            try {
                if (r.statusCode < 200 || r.statusCode > 599) throw new Error('Unexpected status ' + r.statusCode);
                const hdrs = new Headers();
                for (let i = 0; i < r.rawHeaders.length; i += 2) hdrs.append(r.rawHeaders[i], r.rawHeaders[i + 1]);
                if (init.method === 'HEAD' || [204, 205, 304].includes(r.statusCode)) { r.resume(); return resolve(new Response(null, { status: r.statusCode, statusText: r.statusMessage, headers: hdrs })); }
                // The body passes through here so a connection dropped mid-way rejects like fetch()'s (TypeError, cause).
                const steps = [new PassThrough(), ...decoders(r.headers['content-encoding'])];
                const body = steps[steps.length - 1];
                // An error after the reader let go (a cancelled body, then the connection drops) has nobody left to
                // hear it; unheard, it would end the process. Whoever is still reading gets it as before.
                const fail = e => { if (!body.destroyed) body.destroy(e); };
                for (let i = 1; i < steps.length; i++) steps[i - 1].on('error', fail).pipe(steps[i]);
                r.on('error', e => fail(signal && signal.aborted ? signal.reason : new TypeError('terminated', { cause: e }))).pipe(steps[0]);
                body.on('error', () => {}).on('close', () => { r.destroy(); for (const x of steps) x.destroy(); });
                resolve(new Response(ReadableStream.from(body), { status: r.statusCode, statusText: r.statusMessage, headers: hdrs }));
            } catch (e) { r.destroy(); reject(new TypeError('fetch failed', { cause: e })); }
        });
        // fetch() does not switch protocols either.
        req.on('upgrade', (r, socket) => { socket.destroy(); reject(new TypeError('fetch failed', { cause: new Error('Unexpected protocol switch') })); });
        req.on('error', e => {
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(signal && signal.aborted ? signal.reason : e.message === refused().message ? e : new TypeError('fetch failed', { cause: e }));
        });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        req.end(init.body);
    });
}

// Follows at most 5 redirects itself, checking each address first.
export async function fetchPublic(url, init = {}) {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
        const res = await pinnedFetch(current, { ...init, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            current = new URL(res.headers.get('location'), current).href;
            if (res.body) res.body.cancel().catch(() => {});
            continue;
        }
        // Callers read res.url for file names; give it the final address.
        Object.defineProperty(res, 'url', { value: current });
        return res;
    }
    throw new Error('The site kept redirecting. Try again, or open its page.');
}

// Reads a body, giving up as soon as it passes max bytes, so an answer that never ends cannot fill memory.
export async function readCapped(res, max) {
    if (+res.headers.get('content-length') > max) { if (res.body) res.body.cancel().catch(() => {}); throw new Error('Too big'); }
    const parts = [];
    let n = 0;
    for await (const chunk of res.body || []) {
        n += chunk.length;
        if (n > max) throw new Error('Too big'); // leaving the loop cancels the rest of the body
        parts.push(chunk);
    }
    return Buffer.concat(parts);
}
