// Links found on other websites (covers, download links) are fetched by this server. A listing could point
// one at something on the owner's own network (a router page, another container), so those fetches only go
// to public addresses, checked again on every redirect.
import dns from 'node:dns/promises';
import net from 'node:net';

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

// fetch() that follows at most 5 redirects itself, checking each address first.
// ponytail: the name is looked up here and again by fetch, so a DNS server answering differently the second time
// could still reach a private address; pin the checked address with an undici Agent (connect.lookup) to close it.
export async function fetchPublic(url, init = {}) {
    let current = url;
    for (let hop = 0; hop <= 5; hop++) {
        await assertPublicUrl(current);
        const res = await fetch(current, { ...init, redirect: 'manual' });
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
