// Optional background browser (Playwright, Chromium). One persistent profile in the data directory
// so a site's verification, once passed by the user (see Remote verification), is remembered for later
// searches. Fails soft everywhere: without Playwright/Chromium every function returns null/false.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// One fixed UA for every run: sites tie their cookies to it.
export const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let profileDir = path.join(process.cwd(), 'data', 'browser-profile');
export const setProfileDir = d => { profileDir = path.join(d, 'browser-profile'); };

let ctx = null;        // headless context, kept open between searches and closed when idle
let idleTimer = null;
let chain = Promise.resolve(); // one browser job at a time: a profile can only be opened once

const playwright = () => import('playwright').catch(() => null);
const queue = fn => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

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

async function headlessContext() {
    if (!ctx) {
        const pw = await playwright();
        if (!pw) return null;
        // Chromium inside a container needs these two flags (no user namespaces, small /dev/shm).
        const args = process.env.BROWSER_IN_CONTAINER ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
        ctx = await pw.chromium.launchPersistentContext(profileDir, { headless: true, userAgent: CHROME_UA, args });
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
                const html = await page.content().catch(() => '');
                if (isReady(html)) return html;
                await page.waitForTimeout(500);
            }
            return null;
        } catch (e) { return null; } finally { if (page) await page.close().catch(() => {}); }
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

export function startVerification(url) {
    return queue(async () => {
        if (verify) return { ok: true };
        try {
            const c = await headlessContext();
            if (!c) return { ok: false, reason: 'Playwright/Chromium is not installed.' };
            const host = new URL(url).hostname;
            const page = await c.newPage();
            await page.setViewportSize(VIEWPORT);
            await page.route('**/*', route => {
                const r = route.request();
                if (r.isNavigationRequest() && r.frame() === page.mainFrame() && new URL(r.url()).hostname !== host) return route.abort();
                return route.continue();
            });
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            const stop = () => { if (verify && verify.page === page) { clearTimeout(verify.timer); verify = null; } page.close().catch(() => {}); };
            verify = { page, timer: setTimeout(stop, VERIFY_MAX_MS) };
            page.on('close', () => { if (verify && verify.page === page) { clearTimeout(verify.timer); verify = null; } });
            return { ok: true };
        } catch (e) { return { ok: false, reason: 'Could not start the browser: ' + String(e.message).split('\n')[0].slice(0, 120) }; }
    });
}

// Current HTML of the verification page, so the caller can tell whether the check has been passed.
export async function verificationHtml() {
    if (!verify) return '';
    try { return await verify.page.content(); } catch (e) { return ''; }
}

export async function verificationFrame() {
    if (!verify) return null;
    try { return await verify.page.screenshot({ type: 'jpeg', quality: 60 }); } catch (e) { return null; }
}

export async function verificationInput(ev) {
    if (!verify) return false;
    const { page } = verify, num = v => Math.max(0, Math.min(5000, Number(v) || 0));
    try {
        if (ev.type === 'click') await page.mouse.click(num(ev.x), num(ev.y));
        else if (ev.type === 'move') await page.mouse.move(num(ev.x), num(ev.y));
        else if (ev.type === 'type') await page.keyboard.type(String(ev.text || '').slice(0, 200));
        else if (ev.type === 'key') await page.keyboard.press(String(ev.key || '').slice(0, 30));
        else if (ev.type === 'scroll') await page.mouse.wheel(0, Math.max(-2000, Math.min(2000, Number(ev.dy) || 0)));
        else return false;
        return true;
    } catch (e) { return false; }
}

export function stopVerification() {
    if (!verify) return;
    clearTimeout(verify.timer);
    const { page } = verify;
    verify = null;
    page.close().catch(() => {});
}
