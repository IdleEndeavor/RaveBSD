// The page shell: decides between setup, sign-in and the app, draws the nav, routes between pages and
// keeps a live connection (/events) so downloads, the shelf and the nav badges move together.
import { $, esc, api, icon, prefs, applyMotion, applyPrivate, setPublicMode, toast, hideToast, toastId, isPhone, clientId, saveToDevice, patchHtml } from './ui.js';

applyMotion();
applyPrivate();
export const bus = new EventTarget();
// lastResults: the address of the latest search, so the Discover tab returns to it from other pages.
export const app = { session: null, settings: null, status: null, jobs: [], lastResults: null };
const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

const ROUTES = {
    '/': () => import('./search.js'),
    '/results': () => import('./search.js'),
    '/shelf': () => import('./shelf.js'),
    '/shelf/stats': () => import('./shelf.js'),
    '/settings': () => import('./settings.js'),
    '/admin': () => import('./settings.js'),
};
const root = $('#app');
let current = null;

export async function go(path, { replace = false, state = null } = {}) {
    if (replace) history.replaceState(state, '', path); else history.pushState(state, '', path);
    await render();
}
addEventListener('popstate', render);
// Every same-origin link marked data-link (and the nav) goes through the router.
document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !(url.pathname in ROUTES)) return;
    e.preventDefault();
    // Discover or the logo pressed while Discover is already showing: back to the empty search bar.
    if (a.dataset.nav === 'discover' && tabOn(location.pathname, '/')) { app.lastResults = null; go('/', { state: { reset: true } }); return; }
    if (url.pathname === location.pathname && url.hash) { const t = document.getElementById(url.hash.slice(1)); if (t) t.scrollIntoView({ behavior: prefs.motion ? 'smooth' : 'auto' }); history.replaceState(history.state, '', url.pathname + url.hash); bus.dispatchEvent(new CustomEvent('hash', { detail: url.hash })); return; }
    go(url.pathname + url.search + url.hash);
});

const PAGE_BG = { '/': 'var(--glow-home)', '/results': null, '/shelf': 'var(--glow-shelf)', '/shelf/stats': 'var(--glow-shelf)', '/settings': 'var(--glow-settings)', '/admin': 'var(--glow-settings)' };
export function setBg(css) { $('#bg').style.background = css; }

async function render() {
    const path = location.pathname in ROUTES ? location.pathname : '/';
    if (current && current.unmount) current.unmount();
    document.body.classList.remove('bar-away');
    const mod = await ROUTES[path]();
    current = mod;
    if (PAGE_BG[path]) setBg(PAGE_BG[path]);
    drawNav(path);
    // Each page gets a fresh element, so listeners from the previous page cannot fire here.
    const el = document.createElement('div');
    root.replaceChildren(el);
    await mod.mount(el, { path, state: history.state });
    if (location.hash) { const t = document.getElementById(location.hash.slice(1)); if (t) setTimeout(() => t.scrollIntoView(), 50); }
    else if (!history.state || !history.state.keepScroll) scrollTo(0, 0);
}

// ── Nav ──────────────────────────────────────────────────────────────────────
const TABS = [['/', 'Discover', 'search'], ['/shelf', 'Shelf', 'shelf'], ['/settings', 'Settings', 'sliders']];
// The admin panel lives under the Settings tab.
const tabOn = (path, href) => (href === '/' ? path === '/' || path === '/results' : href === '/settings' ? path.startsWith('/settings') || path === '/admin' : path.startsWith(href));
function badges() {
    const s = app.status || {}, on = app.settings ? app.settings.system.badges : true;
    return { shelf: on && s.active ? s.active : 0, settings: on && s.attention ? s.attention : 0 };
}
const TITLES = { '/results': 'Results', '/shelf': 'Shelf', '/shelf/stats': 'Stats', '/settings': 'Settings', '/admin': 'Admin panel' };
export function drawNav(path = location.pathname) {
    document.title = (TITLES[path] ? TITLES[path] + ' · ' : '') + 'RaveBSD';
    const b = badges();
    const top = $('#topnav'), bar = $('#tabbar');
    patchHtml(top, `<nav aria-label="Main">
        <a class="nv lg" href="${esc(app.lastResults || '/')}" data-nav="discover" title="RaveBSD, back to Discover" aria-label="RaveBSD, back to Discover"><img src="/img/crystal-mark.png" alt=""><span class="nl">RaveBSD</span></a>
        <span class="navsep" aria-hidden="true"></span>
        ${TABS.map(([href, label, ic]) => {
            const on = tabOn(path, href);
            const badge = href === '/shelf' && b.shelf ? `<span class="nb" style="background:var(--yellow)">${b.shelf}</span>`
                : href === '/settings' && b.settings ? `<span class="nb" style="background:var(--coral)">${b.settings}</span>` : '';
            const title = href === '/shelf' && b.shelf ? `Shelf, ${b.shelf} downloading` : href === '/settings' && b.settings ? `Settings, ${b.settings} need${b.settings === 1 ? 's' : ''} attention` : label;
            return `<a class="nv${on ? ' on' : ''}" href="${esc(href === '/' ? app.lastResults || '/' : href === '/settings' && b.settings ? '/admin#attention' : href)}"${href === '/' ? ' data-nav="discover"' : ''} title="${esc(title)}" aria-label="${esc(title)}"${on ? ' aria-current="page"' : ''}>${icon(ic)}<span class="nl">${label}</span>${badge}</a>`;
        }).join('')}
    </nav>`);
    // Patched, not replaced: the status refresh must not drop keyboard focus from a nav link or restart its hover.
    patchHtml(bar, TABS.map(([href, label, ic]) => {
        const on = tabOn(path, href);
        const badge = href === '/shelf' && b.shelf ? `<span class="nb" style="background:var(--yellow)">${b.shelf}</span>`
            : href === '/settings' && b.settings ? '<span class="nb dot" style="background:var(--coral)"></span>' : '';
        return `<a href="${esc(href === '/' ? app.lastResults || '/' : href === '/settings' && b.settings ? '/admin#attention' : href)}"${href === '/' ? ' data-nav="discover"' : ''} class="${on ? 'on' : ''}"${on ? ' aria-current="page"' : ''}>${icon(ic, 20, on ? 2.2 : 2)}${label}${badge}</a>`;
    }).join(''));
}
export function showChrome(show) { $('#topnav').hidden = !show; $('#tabbar').style.visibility = show ? '' : 'hidden'; }

// ── Status and live events ───────────────────────────────────────────────────
export async function refreshStatus() {
    try { app.status = await api('/api/status'); drawNav(); emit('status', app.status); } catch (e) { /* offline */ }
}
export async function refreshSettings() { app.settings = await api('/api/settings'); emit('settings', app.settings); return app.settings; }
// Public mode follows the settings, however they were refreshed.
bus.addEventListener('settings', e => setPublicMode(e.detail && e.detail.access && e.detail.access.mode === 'public', isAdmin()));
// Admins run the server; users (friends and family) and visitors (public) get their own browser's settings.
export const isAdmin = () => !!(app.session && app.session.role === 'admin');

let es = null;
function connect() {
    if (es) es.close();
    es = new EventSource('/events');
    es.onmessage = m => {
        let ev; try { ev = JSON.parse(m.data); } catch (e) { return; }
        if (ev.type === 'hello' || ev.type === 'jobs') {
            app.jobs = ev.jobs || [];
            if (app.status && app.status.active !== ev.active) { app.status.active = ev.active; drawNav(); }
        }
        if (ev.type === 'vpn' || ev.type === 'status' || ev.type === 'lowSpace') refreshStatus();
        notify(ev);
        if (ev.type === 'done') finished(ev);
        if (ev.type === 'failed' && ev.job && ev.job.clientId === clientId) { hideToast('dl-' + ev.job.resultId); toast(`“${ev.job.title}” did not download: ${ev.job.error || 'the site refused'}`, { action: { label: 'View on Shelf', href: '/shelf' }, ms: 6000 }); }
        emit(ev.type, ev);
    };
    // The browser reconnects by itself; after a server restart, refresh what may have changed.
    es.onopen = () => refreshStatus();
}

// A download this browser started has finished. Works on any page, not only the results.
function finished(ev) {
    if (ev.clientId !== clientId) return;
    if (ev.autoSave && ev.shelfId) {
        saveToDevice(ev.shelfId);
        toast(`${ev.title} is on this ${isPhone() ? 'phone' : 'device'}`, { action: { label: 'Open', href: '/shelf' }, ms: 4000 });
        return;
    }
    if (toastId() === 'dl-' + ev.resultId || !toastId()) toast(ev.note || `“${ev.title}” is on the shelf.`, { action: { label: 'View on Shelf', href: '/shelf' }, ms: 4000, id: 'dl-' + ev.resultId });
}

// Browser notifications, only with permission and only for the kinds switched on in Settings.
function notify(ev) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !app.settings) return;
    const n = app.settings.notify;
    let text = '';
    if (ev.type === 'done' && ev.shelfId && n.onShelf) text = `${ev.title} is on the shelf`;
    if (ev.type === 'lowSpace' && n.lowSpace) text = `Under ${app.settings.storage.lowSpaceGB} GB free on ${ev.dir}`;
    if (ev.type === 'vpn' && ev.up === false && app.settings.vpn.enabled && app.settings.vpn.tellOnDrop) text = 'The VPN tunnel dropped · downloads paused';
    if (!text || (!document.hidden && ev.type === 'done')) return;
    const opts = { body: text, icon: '/img/crystal-mark.png', tag: ev.type + (ev.jobId || '') };
    // Phones only show notifications through the service worker; desktops can use either.
    if (swReg) { swReg.showNotification('RaveBSD', opts).catch(() => {}); return; }
    try { const note = new Notification('RaveBSD', opts); note.onclick = () => { focus(); go('/shelf'); note.close(); }; }
    catch (e) { /* no notifications here */ }
}

// ── Sign-in ──────────────────────────────────────────────────────────────────
// Private with a password, and friends and family, ask first. On a public instance the admin comes here from
// Settings (asAdmin), and can go back.
export function login({ asAdmin = false } = {}) {
    showChrome(false);
    setBg('var(--glow-home)');
    const mode = app.session.mode;
    const lede = asAdmin ? 'For the person who runs this RaveBSD.' : mode === 'family' ? 'Use the account you were given.' : 'This RaveBSD asks for a password.';
    root.innerHTML = `<div class="gate">
        <div class="lockup"><img class="a" src="/img/lockup-happy-reading.png" alt="Happy reading!"><img class="b" src="/img/lockup-book-search.png" alt="" aria-hidden="true"></div>
        <form class="gate-card" id="login">
            <h1 class="h-sec">${asAdmin ? 'Admin' : 'Sign'} <span class="serif" style="color:var(--yellow)">${asAdmin ? 'sign-in' : 'in'}</span></h1>
            <p class="lede">${lede}</p>
            <div class="fields">
                <label class="field">Username<input class="input" name="username" autocomplete="username" required value="${asAdmin ? '' : esc(app.session.username || '')}"></label>
                <label class="field">Password<input class="input" name="password" type="password" autocomplete="current-password" required></label>
            </div>
            <p class="err" id="login-err" role="alert"></p>
            <button class="btn yellow lg" type="submit">Sign in</button>
            ${asAdmin ? '<button class="btn outline lg" type="button" id="login-back">Back</button>' : ''}
        </form></div>`;
    if (asAdmin) $('#login-back').onclick = () => { location.href = '/settings'; };
    $('#login [name=' + (app.session.username && !asAdmin ? 'password' : 'username') + ']').focus();
    $('#login').onsubmit = async e => {
        e.preventDefault();
        const f = new FormData(e.target);
        try { await api('/api/login', { body: { username: f.get('username'), password: f.get('password') } }); location.reload(); }
        catch (err) { $('#login-err').textContent = err.message; }
    };
}

async function boot() {
    try { app.session = await api('/api/session'); }
    catch (e) { root.innerHTML = `<div class="gate"><p class="lede">${esc(/fetch|network/i.test(e.message) ? 'RaveBSD is not answering. Is the server running?' : e.message)}</p></div>`; return; }
    if (!app.session.signedIn) return login();
    if (!app.session.setupDone) {
        showChrome(false);
        const m = await import('./setup.js');
        return m.mount(root, { done: () => { root.onclick = root.oninput = null; showChrome(true); start(); } });
    }
    start();
}
let swReg = null;
async function start() {
    showChrome(true);
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').then(r => { swReg = r; }).catch(() => {});
    await Promise.all([refreshSettings(), refreshStatus()]);
    connect();
    // A hidden tab does not poll; it catches up when it is shown again.
    setInterval(() => { if (!document.hidden) refreshStatus(); }, 60e3);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
    if (location.pathname === '/setup') history.replaceState(null, '', '/');
    await render();
}
matchMedia('(max-width: 899px)').addEventListener('change', () => { if (current && current.relayout) current.relayout(); });
// Phone: the tab bar slides away while scrolling down and comes back on the way up or at the very end,
// like Safari's toolbar, so the page gets the whole screen while reading.
{
    let lastY = scrollY, acc = 0;
    addEventListener('scroll', () => {
        const y = scrollY, dy = y - lastY; lastY = y;
        if (!isPhone()) return;
        acc = Math.sign(dy) === Math.sign(acc) ? acc + dy : dy;
        const atEnd = innerHeight + y >= document.documentElement.scrollHeight - 4;
        if (y < 40 || atEnd || acc < -24) document.body.classList.remove('bar-away');
        else if (acc > 24) document.body.classList.add('bar-away');
    }, { passive: true });
}
export { isPhone, toast };
boot();
