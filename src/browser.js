// Optional background browser (Playwright, Chromium). One persistent profile in the data directory
// so a site's verification, once passed by the user (see Remote verification), is remembered for later
// searches. Fails soft everywhere: without Playwright/Chromium every function returns null/false.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// A desktop browser UA with the installed Chromium's real major version. A fixed older version contradicted
// what the browser itself reports, and bot checks (Z-Library's DiamWall) failed even a person's click for it.
// Sites tie cookies to the UA, so it only changes when Chromium is updated.
const uaFor = version => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version).split('.')[0]}.0.0.0 Safari/537.36`;
let chromeUa = '';
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let profileDir = path.join(process.cwd(), 'data', 'browser-profile');
export const setProfileDir = d => { profileDir = path.join(d, 'browser-profile'); };

let ctx = null;        // headless context, kept open between searches and closed when idle
let idleTimer = null;
let chain = Promise.resolve(); // one browser job at a time: a profile can only be opened once

const playwright = () => import('playwright').catch(() => null);
// page.content() waits for a navigation in progress, forever if the page never finishes loading.
const htmlOf = page => Promise.race([page.content().catch(() => ''), new Promise(ok => setTimeout(() => ok(''), 5000).unref())]);
// A job that hangs (a page that never settles) must not block every later one, so each gets at most 60 s
// and then answers with fallback. ponytail: the stuck page stays open until the browser idles out.
const queue = (fn, fallback = null) => {
    const run = () => Promise.race([fn(), new Promise(ok => setTimeout(() => { console.warn('Background browser job took over 60 s, skipped'); ok(fallback); }, 60e3).unref())]);
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
};

// True when Playwright is installed AND its Chromium has been downloaded.
export const browserAvailable = async () => {
    const pw = await playwright();
    try { return !!pw && fs.existsSync(pw.chromium.executablePath()); } catch (e) { return false; }
};

// Downloads Chromium the first time it is missing, so a plain `npm start` install gets the full feature set
// without extra steps. Docker images already contain it, so this does nothing there. Safe to call at startup.
export async function ensureBrowser() {
    const pw = await playwright();
    if (!pw) return false;
    if (await browserAvailable()) return true;
    console.log('Setting up the background browser (one time, about 150 MB)...');
    try {
        // The CLI file is not an exported subpath, so find it next to package.json.
        const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
        await new Promise((done, fail) => spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' }).on('exit', done).on('error', fail));
    } catch (e) {
        console.warn('Could not set up the background browser automatically. Run: npx playwright install chromium');
    }
    return browserAvailable();
}

// Chromium runs sandboxed (a page it opens cannot reach the rest of the server). Some hosts block the kernel
// features the sandbox needs inside containers (user namespaces); there it runs unsandboxed rather than not at
// all, says so in the log, and the admin panel shows it under System.
let sandboxed = null; // null until the first launch
export const browserSandboxed = () => sandboxed;
const sandboxRefused = e => /sandbox|namespace|clone|Operation not permitted|setuid/i.test(String(e && e.message));
async function launchBoth(pw, args, sandbox) {
    // The full Chromium build, not Playwright's stripped headless shell, which sites can tell apart from a browser.
    // Playwright turns Chromium's sandbox off unless asked (chromiumSandbox).
    const opts = { headless: true, channel: 'chromium', chromiumSandbox: sandbox, args, ignoreDefaultArgs: ['--enable-automation'] };
    if (!chromeUa) { const b = await pw.chromium.launch(opts); chromeUa = uaFor(b.version()); await b.close(); }
    return pw.chromium.launchPersistentContext(profileDir, { ...opts, userAgent: chromeUa });
}
async function headlessContext() {
    if (!ctx) {
        const pw = await playwright();
        if (!pw) return null;
        // A container's /dev/shm is small. Without the Blink flag the browser reports itself as automated, and bot
        // checks then fail even a real person's click.
        const args = [...(process.env.BROWSER_IN_CONTAINER ? ['--disable-dev-shm-usage'] : []), '--disable-blink-features=AutomationControlled'];
        if (sandboxed !== false) {
            try { ctx = await launchBoth(pw, args, true); sandboxed = true; }
            catch (e) {
                if (!sandboxRefused(e)) throw e;
                sandboxed = false;
                console.warn('The background browser cannot use its sandbox here, so it runs without it. In Docker, run the container with security_opt seccomp=seccomp-chromium.json (as compose.yaml does).');
            }
        }
        if (!ctx) ctx = await launchBoth(pw, args, false);
        ctx.on('close', () => { ctx = null; });
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (ctx && !verify) ctx.close().catch(() => {}); }, IDLE_CLOSE_MS);
    return ctx;
}

// Loads a page and waits until isReady(html) is true (e.g. a JS challenge or client-side search has
// finished). Returns the HTML, or null if the browser is unavailable or the page never got ready.
export function browserGet(url, { isReady = () => true, timeoutMs = 20000 } = {}) {
    return queue(async () => {
        let page;
        try {
            const c = await headlessContext();
            if (!c) return null;
            page = await c.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch(() => {});
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                const html = await htmlOf(page);
                if (isReady(html)) return html;
                await page.waitForTimeout(500);
            }
            return null;
        } catch (e) { return null; } finally { if (page) await page.close().catch(() => {}); }
    });
}

// fetch() run inside a page on that site, so it carries the browser's cookies, including a bot check the user
// passed. Null when the page itself is still behind the check (blocked(html) says so). cookie: "a=1; b=2" to add.
let apiPage = null;
export function browserFetch(origin, path, init, blocked, cookie = '') {
    return queue(async () => {
        try {
            const c = await headlessContext();
            if (!c) return null;
            if (!apiPage || apiPage.isClosed() || !apiPage.url().startsWith(origin)) {
                if (apiPage && !apiPage.isClosed()) await apiPage.close().catch(() => {});
                apiPage = await c.newPage();
                await apiPage.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            }
            // A check that waves browsers through shows itself for a few seconds first.
            const until = Date.now() + 12000;
            while (blocked(await htmlOf(apiPage)) && Date.now() < until) await apiPage.waitForTimeout(500);
            if (blocked(await htmlOf(apiPage))) { await apiPage.close().catch(() => {}); apiPage = null; return null; }
            const jar = cookie.split(/;\s*/).map(kv => kv.split('=')).filter(([n, v]) => n && v);
            if (jar.length) await c.addCookies(jar.map(([name, value]) => ({ name, value, url: origin })));
            return await apiPage.evaluate(([u, i]) => fetch(u, { ...i, signal: AbortSignal.timeout(15000) }).then(async r => ({ status: r.status, text: await r.text() })), [path, init]);
        } catch (e) { return null; }
    });
}

// ── Remote verification ─────────────────────────────────────────────────────
// The browser runs on the server, so the user may be on another device. This exposes one page of it as
// screenshots plus click/type/scroll input (no address bar), so a person can pass a site's check
// themselves from any device. Navigation is limited to the starting host.
export const VIEWPORT = { width: 1000, height: 860 };
const VERIFY_MAX_MS = 10 * 60 * 1000;
let verify = null; // { page, timer }
export const verifyWindowOpen = () => !!verify;

// phone: the person is on a phone, so the page is laid out for one. Either way it renders at twice the pixels,
// so the zoomed-in picture of the check stays sharp.
export function startVerification(url, { phone = false } = {}) {
    return queue(async () => {
        if (verify) return { ok: true };
        try {
            const c = await headlessContext();
            if (!c) return { ok: false, reason: 'Playwright/Chromium is not installed.' };
            const host = new URL(url).hostname;
            const page = await c.newPage();
            const size = phone ? { width: 420, height: 760 } : VIEWPORT;
            await page.setViewportSize(size);
            try {
                const cdp = await c.newCDPSession(page);
                await cdp.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: phone });
            } catch (e) { /* fine at 1x */ }
            await page.route('**/*', route => {
                const r = route.request();
                if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).hostname !== host) return route.abort();
                return route.continue();
            });
            // A check that opens a new window or tab gets it closed: the view only ever shows this one page.
            if (!c.popupGuard) { c.popupGuard = true; c.on('page', p => { if (verify && p !== verify.page) p.close().catch(() => {}); }); }
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            const stop = () => { if (verify && verify.page === page) { clearTimeout(verify.timer); verify = null; } page.close().catch(() => {}); };
            verify = { page, timer: setTimeout(stop, VERIFY_MAX_MS) };
            page.on('close', () => { if (verify && verify.page === page) { clearTimeout(verify.timer); verify = null; } });
            return { ok: true };
        } catch (e) { return { ok: false, reason: 'Could not start the browser: ' + String(e.message).split('\n')[0].slice(0, 120) }; }
    }, { ok: false, reason: 'The background browser is busy or stuck. Try again, or restart it in the admin panel, under System.' });
}

// Current HTML of the verification page, so the caller can tell whether the check has been passed.
export async function verificationHtml() {
    if (!verify) return '';
    return htmlOf(verify.page);
}

// The part of the page worth looking at: the "I'm not a robot" box, or its challenge (picture, text box, button)
// once that opens inside the box's frame. DDoS-Guard (Anna's Archive) or DiamWall (Z-Library). Null means the whole page.
const CHECKS = [['#ddg-captcha iframe', ['#ddg-challenge', '.ddg-captcha']], ['iframe#verification', ['.dw-captcha-root']]];
async function checkArea(page) {
    try {
        let host = null, sels;
        for (const [h, inner] of CHECKS) { host = await page.$(h); if (host) { sels = inner; break; } }
        if (!host) return null;
        const outer = await host.boundingBox();
        const frame = await host.contentFrame();
        if (!outer || !frame) return null;
        const inner = await frame.evaluate(sels => {
            const shown = el => el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
            const el = sels.map(q => document.querySelector(q)).find(shown);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
        }, sels);
        if (!inner) return null;
        const vp = page.viewportSize(), pad = 20;
        const x = Math.max(0, outer.x + inner.x - pad), y = Math.max(0, outer.y + inner.y - pad);
        const width = Math.min(vp.width - x, inner.width + pad * 2), height = Math.min(vp.height - y, inner.height + pad * 2);
        return width > 40 && height > 30 ? { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) } : null;
    } catch (e) { return null; }
}

// A picture of the check (zoomed to it when it can be found) and where that picture sits on the page,
// so taps on it can be turned back into page positions.
export async function verificationFrame({ full = false } = {}) {
    if (!verify) return null;
    try {
        const page = verify.page, vp = page.viewportSize();
        const clip = full ? null : await checkArea(page);
        const img = await page.screenshot({ type: 'jpeg', quality: 70, ...(clip ? { clip } : {}) });
        return { img, area: clip || { x: 0, y: 0, width: vp.width, height: vp.height } };
    } catch (e) { return null; }
}

export async function verificationInput(ev) {
    if (!verify) return false;
    const { page } = verify, num = v => Math.max(0, Math.min(5000, Number(v) || 0));
    try {
        if (ev.type === 'click') { await page.mouse.move(num(ev.x), num(ev.y), { steps: 4 }); await page.mouse.click(num(ev.x), num(ev.y), { delay: 60 }); }
        else if (ev.type === 'move') await page.mouse.move(num(ev.x), num(ev.y));
        else if (ev.type === 'type') await page.keyboard.type(String(ev.text || '').slice(0, 200));
        else if (ev.type === 'key') await page.keyboard.press(String(ev.key || '').slice(0, 30));
        else if (ev.type === 'scroll') await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0)));
        else return false;
        return true;
    } catch (e) { return false; }
}

// Reload: the check sometimes stalls or times out, and a fresh one is the only way on.
export async function reloadVerification() {
    if (!verify) return false;
    try { await verify.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); return true; } catch (e) { return false; }
}

export function stopVerification() {
    if (!verify) return;
    clearTimeout(verify.timer);
    const { page } = verify;
    verify = null;
    page.close().catch(() => {});
}

// Admin panel > System > Advanced > Background browser > Restart.
export async function restartBrowser() {
    stopVerification();
    if (ctx) await ctx.close().catch(() => {});
    ctx = null;
    return browserAvailable();
}
