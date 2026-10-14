// Mirror status from SLUM, the Shadow Library Uptime Monitor (open-slum.org). It checks the shadow libraries'
// domains around the clock, so RaveBSD can try the ones that are up first and skip the ones that are down,
// instead of learning that the slow way during a search. SLUM has no API; its page is plain HTML, one card per
// site with a status per domain (up, degraded, protected = behind a bot check, down). RaveBSD only reads that
// page; nothing about searches is sent. Checked every 30 minutes; the built-in lists are the fallback.
import { settings } from './config.js';

const SLUM_URL = 'https://open-slum.org/';
const EVERY_MS = 30 * 60e3;
// Lower is better. Domains SLUM does not know sit between protected and down.
export const RANK = { up: 0, degraded: 1, protected: 2, unknown: 2.5, down: 3 };
// Which of SLUM's domains each RaveBSD source can use for searching (Anna's also lists download servers).
const USABLE = { annas: h => /^annas-archive\./.test(h), libgen: h => /^libgen\./.test(h), zlibrary: () => true };

export const slum = { at: 0, error: '', sites: {} };

// sites: { annas: [{ host, status }], libgen: [...], zlibrary: [...], scihub: [...], other: [...] }
export function parseSlum(html) {
    const sites = {};
    for (const card of String(html).split('<div class="site-card">').slice(1)) {
        const name = (card.match(/class="site-card-title">\s*([^<]+?)\s*</) || [])[1];
        if (!name) continue;
        // Each domain: an <a> with class "domain-link" (attributes in any order), then its status badge.
        const re = /<a\s([^>]*class="domain-link"[^>]*)>[\s\S]*?status-badge compact (\w+)/g;
        const list = [];
        let m;
        while ((m = re.exec(card))) {
            const href = (m[1].match(/href="(https?:\/\/[^"]+)"/) || [])[1];
            let host; try { host = new URL(href).host.toLowerCase(); } catch (e) { continue; }
            const status = m[2].toLowerCase();
            list.push({ host, status: status in RANK ? status : 'unknown' });
        }
        if (list.length) sites[name.toLowerCase()] = list;
    }
    return sites;
}

export async function refreshSlum() {
    if (!settings.sources.slum) return slum;
    try {
        const res = await fetch(SLUM_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0' }, signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error('SLUM answered ' + res.status);
        const sites = parseSlum(await res.text());
        if (!Object.keys(sites).length) throw new Error('SLUM page changed, could not read it');
        slum.sites = sites; slum.error = '';
    } catch (e) { slum.error = e.cause && e.cause.code ? 'Could not reach open-slum.org' : e.message; }
    slum.at = Date.now();
    return slum;
}

const statusOf = (service, host) => {
    const list = slum.sites[service];
    const hit = list && list.find(d => d.host === host);
    return hit ? hit.status : 'unknown';
};

// The built-in mirror list, best first by SLUM's status. Stable within a status, so the built-in order still
// breaks ties. SLUM only reorders: it never adds a domain, so a listing there can never receive a login (Z-Library
// is sent the account's email and password) or hand out download links. With SLUM off this is the built-in list.
export function slumOrder(service, staticList) {
    if (!settings.sources.slum || !slum.sites[service]) return staticList.slice();
    const urls = [...staticList];
    const host = u => u.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    return urls.map((u, i) => ({ u, i, r: RANK[statusOf(service, host(u))] }))
        .sort((a, b) => a.r - b.r || a.i - b.i)
        .map(x => x.u);
}

// What the page shows in Settings and uses to swap link-out pills to a working mirror.
export function slumSummary() {
    const groups = {};
    for (const k of ['annas', 'libgen', 'zlibrary']) if (slum.sites[k]) groups[k] = slum.sites[k].filter(d => USABLE[k](d.host));
    return { on: settings.sources.slum, at: slum.at, error: slum.error, groups };
}

setInterval(refreshSlum, EVERY_MS).unref();
