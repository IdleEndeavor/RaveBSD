// Shared helpers for every page: escaping, icons, API calls, sizes, cover colours, sounds, toast, menus.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

// ── Per-browser preferences (localStorage, the rest lives on the server) ──────
const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
export const prefs = {
    // On unless switched off in Settings > This browser (the owner wants motion by default, whatever the OS says).
    get motion() { return ls.get('rbsd-motion') !== 'off'; },
    set motion(on) { ls.set('rbsd-motion', on ? 'on' : 'off'); applyMotion(); },
    get sound() { return ls.get('rbsd-sound') !== 'off'; },
    set sound(on) { ls.set('rbsd-sound', on ? 'on' : 'off'); if (!on && silentLoop) { silentLoop.pause(); silentLoop = null; } },
    get showPrivate() { return ls.get('rbsd-private') === 'show'; },
    set showPrivate(on) { ls.set('rbsd-private', on ? 'show' : 'hide'); applyPrivate(); },
    get view() { return ls.get('rbsd-view'); },
    set view(v) { ls.set('rbsd-view', v); },
};
// Folders, account names and server addresses are blurred until clicked, so a screen share or screenshot of an
// instance open to the internet does not give them away. Settings > This browser > "Show folders and account names" shows them.
// A public instance keeps them blurred whatever this browser prefers, and clicks do not reveal them.
let publicMode = false, viewerIsAdmin = true;
// Public instances keep private details blurred for everyone; only an admin can click one to read it.
export function setPublicMode(on, admin = true) { publicMode = !!on; viewerIsAdmin = !!admin; applyPrivate(); }
export function applyPrivate() { document.documentElement.toggleAttribute('data-show-private', prefs.showPrivate && !publicMode); }
export const priv = html => (publicMode && !viewerIsAdmin ? `<span class="priv locked">${html}</span>` : `<span class="priv" tabindex="0" title="Hidden. Click to show.">${html}</span>`);
// A path with only its folders hidden; the file name stays readable.
// Non-admins only ever get paths inside the shelf, which give nothing away, so only admins' paths are blurred.
// A trailing "/" (an audiobook's folder) does not count as the split, so the folder's own name stays readable.
export const privPath = p => {
    p = String(p || '');
    if (!viewerIsAdmin || !p.startsWith('/')) return esc(p);
    const i = p.replace(/\/$/, '').lastIndexOf('/');
    return i > 0 ? priv(esc(p.slice(0, i))) + esc(p.slice(i)) : esc(p);
};
const reveal = e => {
    const p = e.target.closest && e.target.closest('.priv:not(input)');
    if (!p || p.classList.contains('locked') || prefs.showPrivate || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); e.stopPropagation();
    p.classList.toggle('shown');
};
document.addEventListener('click', reveal, true);
document.addEventListener('keydown', reveal, true);
export function applyMotion() { document.documentElement.toggleAttribute('data-still', !prefs.motion); }
// A random id for this tab, so auto-save sends a book only to the device that asked for it.
export const clientId = (() => {
    try { let id = sessionStorage.getItem('rbsd-client'); if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('rbsd-client', id); } return id; }
    catch (e) { return Math.random().toString(36).slice(2); }
})();
export const isPhone = () => matchMedia('(max-width: 899px)').matches;

// ── API ──────────────────────────────────────────────────────────────────────
export async function api(path, { method, body, raw } = {}) {
    const res = await fetch(path, {
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
    });
    if (res.status === 401 && !path.startsWith('/api/login')) { location.reload(); throw new Error('Sign in first'); }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong (' + res.status + ')');
    return data;
}

// ── Formatting ───────────────────────────────────────────────────────────────
export function size(b) {
    b = Number(b) || 0;
    if (!b) return '';
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e11 ? 0 : 1).replace(/\.0$/, '') + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1).replace(/\.0$/, '') + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' KB';
}
export function when(t) {
    if (!t) return '';
    const d = new Date(t), now = new Date();
    const day = 864e5, start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (t >= start) return 'Today';
    if (t >= start - day) return 'Yesterday';
    if (t >= start - 6 * day) return d.toLocaleDateString(undefined, { weekday: 'short' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
export function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return s + ' seconds ago';
    if (s < 3600) return Math.round(s / 60) + (s < 120 ? ' minute ago' : ' minutes ago');
    if (s < 86400) return Math.round(s / 3600) + (s < 7200 ? ' hour ago' : ' hours ago');
    return Math.round(s / 86400) + ' days ago';
}
export const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

// ── Icons (24px viewBox strokes, currentColor) ───────────────────────────────
const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    sliders: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
    shelf: '<rect x="3" y="8" width="4" height="11" rx="1"/><rect x="9.5" y="4" width="4" height="15" rx="1"/><rect x="16" y="7" width="5" height="12" rx="1"/><path d="M2 21.5h20"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    ext: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    down: '<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    left: '<path d="M15 5l-7 7 7 7"/>',
    right: '<path d="M9 5l7 7-7 7"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    bin: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
};
export function icon(name, size = 22, width = 2.2, extra = '') {
    if (name === 'more') return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"${extra}><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${P[name]}</svg>`;
}

// ── Covers and colours ───────────────────────────────────────────────────────
// Palettes from the design: three gradient stops (light to dark), the circle and the ink of a generated cover.
export const PALETTES = [
    { c: ['#FFC070', '#E2552E', '#7A1F3D'], circle: '#2B0F3F', ink: '#FFF3DC' },
    { c: ['#6FB3C4', '#2F6F88', '#0B1C2B'], circle: '#FF8A65', ink: '#FFE6D8' },
    { c: ['#3F6FB0', '#FFE6A0', '#0F1F36'], circle: '#FFE6A0', ink: '#FFE6A0' },
    { c: ['#9BF0D2', '#FFD54A', '#1E8E6A'], circle: '#FFD54A', ink: '#0B3A2A' },
    { c: ['#2E7A5E', '#FFE6A0', '#0F2A20'], circle: '#FFE6A0', ink: '#FFE6A0' },
    { c: ['#4B63FF', '#8FD0FF', '#1B1A6B'], circle: '#8FD0FF', ink: '#FBF8FF' },
    { c: ['#8A2F40', '#FFE6A0', '#2B0F14'], circle: '#FFE6A0', ink: '#FFE6A0' },
    { c: ['#8A55C8', '#FFD54A', '#3E1A66'], circle: '#FFD54A', ink: '#FBF8FF' },
    { c: ['#FFC070', '#FF8A65', '#B04A2E'], circle: '#14123A', ink: '#14123A' },
    { c: ['#A8F0FF', '#3C7FC4', '#0B2A4A'], circle: '#FFFFFF', ink: '#0B2A4A' },
    { c: ['#FFB4C8', '#FF4FD8', '#7A2A5A'], circle: '#FFFFFF', ink: '#4A1038' },
    { c: ['#5EEAB4', '#2EE6F6', '#0B3A2A'], circle: '#FFFFFF', ink: '#0B3A2A' },
    { c: ['#9B5FD8', '#FF8A65', '#2E1250'], circle: '#FFD54A', ink: '#FFE6D8' },
    { c: ['#B7A4FF', '#4B2FB0', '#1B1A6B'], circle: '#FFE6A0', ink: '#FBF8FF' },
];
// Spine colours: solid pastels with ink text, or the palette's own gradient with its ink.
const SPINES = [['#FF8A65', '#14123A'], ['#B7A4FF', '#14123A'], ['#5EEAB4', '#14123A'], ['#FFD54A', '#14123A'], ['#4B63FF', '#FBF8FF'], ['#FF4FD8', '#14123A'], ['#FFC070', '#14123A'], ['#A8F0FF', '#14123A'], ['#FFB4C8', '#14123A'], ['#8FD0FF', '#14123A']];
export function hash(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export const bookKey = r => String(r.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function paletteFor(r) { return PALETTES[hash(bookKey(r)) % PALETTES.length]; }
export function spineFor(r) {
    const h = hash(bookKey(r) + '|s');
    if (h % 3 === 0) { const p = paletteFor(r); return { bg: `linear-gradient(180deg,${p.c[1]},${p.c[2]})`, ink: p.ink, dark: true }; }
    const [bg, ink] = SPINES[h % SPINES.length];
    return { bg, ink, dark: ink !== '#14123A' };
}
const rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const rgba = (h, a) => { const c = rgb(h); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
export const mix = (h, o, t) => { const a = rgb(h), b = rgb(o); return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',') + ')'; };
export const toHex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

// Real covers come through the server (/cover), so the page can read their colours and no third-party
// site sees the person browsing. Colours are the average of three horizontal bands, lightest first.
const coverColours = new Map();
export function coverPalette(url) {
    if (coverColours.has(url)) return coverColours.get(url);
    const p = new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            try {
                const c = document.createElement('canvas'); c.width = 12; c.height = 18;
                const g = c.getContext('2d'); g.drawImage(img, 0, 0, 12, 18);
                const d = g.getImageData(0, 0, 12, 18).data;
                const band = (y0, y1) => { const s = [0, 0, 0]; let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 12; x++) { const i = (y * 12 + x) * 4; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; n++; } return s.map(v => v / n); };
                const bands = [band(0, 6), band(6, 12), band(12, 18)];
                const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
                bands.sort((a, b) => lum(b) - lum(a));
                // Lift the light stop and darken the dark one a little so panels never go muddy.
                const light = bands[0].map(v => v + (255 - v) * 0.15), dark = bands[2].map(v => v * 0.7);
                resolve({ c: [toHex(light), toHex(bands[1]), toHex(dark)], circle: '#FFFFFF', ink: '#FFFFFF', fromImage: true });
            } catch (e) { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
    coverColours.set(url, p);
    return p;
}

// A generated cover: gradient, circle, short title.
export function shortTitle(t) {
    const words = String(t || '').replace(/^(the|a|an)\s+/i, '').replace(/[:(].*$/, '').trim().split(/\s+/);
    let s = words[0] || '?';
    if (s.length < 5 && words[1]) s += ' ' + words[1];
    return s.toUpperCase().slice(0, 14);
}
export function genCover(r, { fs, small } = {}) {
    const p = paletteFor(r), st = shortTitle(r.title);
    const f = fs || (st.length <= 6 ? 44 : st.length <= 9 ? 30 : st.length <= 12 ? 24 : 20);
    return `<div class="gc" style="background:linear-gradient(170deg,${p.c[0]} 0%,${p.c[1]} 68%,${p.c[2]} 100%)">`
        + `<div class="gc-c" style="background:${p.circle}"></div>`
        + `<div class="gc-t" style="font-size:${f}px;color:${p.ink}">${esc(st)}</div>`
        + (small ? '' : `<div class="gc-a" style="color:${p.ink}">${esc(String(r.author || '').split(/[,&;]/)[0].toUpperCase().slice(0, 24))}</div>`)
        + '</div>';
}

// ── Sounds (Web Audio, no files). One context, unlocked on the first tap. ─────
// iPhones mute Web Audio when the ring/silent switch is on silent, even at full volume. Asking for the
// "playback" audio session (iOS 17+), or on older iOS playing an inaudible loop, makes them behave like any
// other sound the person chose to play.
let ac = null, silentLoop = null;
function silentWav() {
    const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
    const str = (o, t) => [...t].forEach((c, i) => { b[o + i] = c.charCodeAt(0); });
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); str(36, 'data'); v.setUint32(40, n, true);
    b.fill(128, 44);
    let bin = ''; b.forEach(x => { bin += String.fromCharCode(x); });
    return 'data:audio/wav;base64,' + btoa(bin);
}
function audio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older browsers */ }
    if (!ac || ac.state === 'closed') ac = new AC();
    if (ac.state !== 'running') ac.resume().catch(() => {});
    if (!silentLoop && !navigator.audioSession && /iP(hone|ad|od)/.test(navigator.userAgent)) {
        silentLoop = new Audio(silentWav());
        silentLoop.loop = true; silentLoop.setAttribute('playsinline', '');
        silentLoop.play().catch(() => { silentLoop = null; });
    }
    return ac;
}
// The first click, tap or key press unlocks audio, so the first book picked is not silent. These are the
// events every browser (Safari included) accepts as permission to start sound; pointerdown is not.
const UNLOCK_EVENTS = ['click', 'touchend', 'keydown'];
const unlock = () => { if (prefs.sound) audio(); UNLOCK_EVENTS.forEach(e => removeEventListener(e, unlock, true)); };
const armUnlock = () => UNLOCK_EVENTS.forEach(e => addEventListener(e, unlock, true));
armUnlock();
// Leaving for another app can leave the audio stopped ("interrupted" on iPhones). On return, only audio that
// is not running any more is dropped, and the next tap builds it again. Desktop tabs keep theirs.
document.addEventListener('visibilitychange', () => {
    if (document.hidden || !ac || ac.state === 'running') return;
    ac.close().catch(() => {}); ac = null;
    if (silentLoop) { silentLoop.pause(); silentLoop = null; }
    armUnlock();
});

export function sfx(kind) {
    if (!prefs.sound) return;
    const ctx = audio();
    if (!ctx) return;
    // A context that is still waking up plays the sound as soon as it is running.
    if (ctx.state !== 'running') { ctx.resume().then(() => play(kind), () => {}); return; }
    play(kind);
}
function play(kind) {
    try {
        // A hair in the future, so a context that has just resumed does not skip the start.
        const t0 = ac.currentTime + 0.02;
        const master = ac.createGain(); master.gain.value = 0.55; master.connect(ac.destination);
        const noise = (dur, type, freq, q, vol, at) => {
            const n = Math.floor(ac.sampleRate * dur), buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
            for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
            const src = ac.createBufferSource(); src.buffer = buf;
            const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
            const g = ac.createGain(); g.gain.setValueAtTime(vol, t0 + at); g.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
            src.connect(f); f.connect(g); g.connect(master); src.start(t0 + at);
        };
        const tone = (type, f1, f2, dur, vol, at) => {
            const o = ac.createOscillator(), g = ac.createGain();
            o.type = type; o.frequency.setValueAtTime(f1, t0 + at); o.frequency.exponentialRampToValueAtTime(f2, t0 + at + dur);
            g.gain.setValueAtTime(vol, t0 + at); g.gain.exponentialRampToValueAtTime(0.001, t0 + at + dur);
            o.connect(g); g.connect(master); o.start(t0 + at); o.stop(t0 + at + dur + 0.02);
        };
        if (kind === 'book') {
            noise(0.16, 'bandpass', 2600, 0.7, 0.55, 0);
            noise(0.09, 'highpass', 5000, 0.5, 0.18, 0.05);
            tone('sine', 150, 55, 0.12, 0.5, 0.02);
        } else {
            noise(0.03, 'highpass', 2200, 0.8, 0.7, 0);
            tone('square', 1100, 380, 0.035, 0.12, 0);
            noise(0.05, 'bandpass', 1300, 1.2, 0.6, 0.075);
            tone('sine', 240, 110, 0.07, 0.5, 0.075);
        }
    } catch (e) { /* no audio */ }
}

// Web Animations, skipped when Animations is off.
export function anim(el, kf, opts) {
    if (!el || !prefs.motion) return null;
    return el.animate(kf, { easing: 'cubic-bezier(.22,.9,.24,1)', ...opts });
}

// ── Toast ────────────────────────────────────────────────────────────────────
// One at a time. Hides after `ms` unless hovered or focused. action: { label, href } or { label, onClick }.
let toastEl = null, toastTimer = null;
export function toast(text, { action, ms = 4000, id } = {}) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'toast';
        toastEl.setAttribute('role', 'status');
        toastEl.addEventListener('mouseenter', () => clearTimeout(toastTimer));
        toastEl.addEventListener('focusin', () => clearTimeout(toastTimer));
        toastEl.addEventListener('mouseleave', () => armToast(toastEl.__ms));
    }
    const fresh = !toastEl.isConnected;
    toastEl.__id = id || '';
    toastEl.__ms = ms;
    toastEl.innerHTML = `<span>${esc(text)}</span>` + (action ? (action.href ? `<a class="btn yellow" href="${esc(action.href)}" data-link>${esc(action.label)}</a>` : `<button type="button" class="btn yellow">${esc(action.label)}</button>`) : '');
    if (action && action.onClick) toastEl.querySelector('button').onclick = () => { hideToast(); action.onClick(); };
    if (action && action.href) toastEl.querySelector('a').addEventListener('click', () => hideToast());
    if (fresh) { document.body.appendChild(toastEl); toastEl.classList.remove('enter'); void toastEl.offsetWidth; toastEl.classList.add('enter'); }
    armToast(ms);
}
function armToast(ms) { clearTimeout(toastTimer); if (ms) toastTimer = setTimeout(hideToast, ms); }
export function hideToast(id) { if (toastEl && (!id || toastEl.__id === id)) { clearTimeout(toastTimer); toastEl.remove(); } }
export const toastId = () => (toastEl && toastEl.isConnected ? toastEl.__id : '');

// ── ⋯ menus: one open at a time, Escape or a click elsewhere closes it ───────
let openMenu = null;
export function closeMenu() { if (openMenu) { openMenu.btn.setAttribute('aria-expanded', 'false'); openMenu.el.remove(); openMenu = null; } }
export function showMenu(btn, items) {
    const wasOpen = openMenu && openMenu.btn === btn && openMenu.el.isConnected; // a redraw may have removed the menu
    closeMenu();
    if (wasOpen) return;
    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = items.map((it, i) => `<button type="button" role="menuitem" data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
    el.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (!b) return; closeMenu(); items[+b.dataset.i].run(); });
    el.addEventListener('keydown', e => {
        const all = $$('[role="menuitem"]', el), i = all.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); all[(i + 1) % all.length].focus(); }
        if (e.key === 'ArrowUp') { e.preventDefault(); all[(i - 1 + all.length) % all.length].focus(); }
    });
    btn.parentElement.appendChild(el);
    // Open upwards when there is no room below (rows near the bottom, above the phone tab bar).
    if (el.getBoundingClientRect().bottom > innerHeight - (isPhone() ? 96 : 12)) el.classList.add('up');
    btn.setAttribute('aria-expanded', 'true');
    openMenu = { btn, el };
    el.querySelector('button').focus();
}
document.addEventListener('click', e => { if (openMenu && !openMenu.el.contains(e.target) && !openMenu.btn.contains(e.target)) closeMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) { const b = openMenu.btn; closeMenu(); b.focus(); } });

export async function copy(text, done = 'Copied') {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch (e) {
        const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); toast(done); } catch (e2) { toast('Could not copy'); }
        t.remove();
    }
}

// Saves a shelf item to this device through a plain link, so the browser handles the download itself.
export function saveToDevice(id) {
    const a = document.createElement('a');
    a.href = '/files/' + encodeURIComponent(id);
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
}

// Brings el's contents to html by changing only what differs, so keyboard focus, hover and running animations
// (progress stripes, the nav's open label) survive a redraw that has little new. Typed text is kept too.
export function patchHtml(el, html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    syncKids(el, t.content);
}
function syncKids(a, b) {
    const old = [...a.childNodes], next = [...b.childNodes];
    next.forEach((n, i) => {
        const o = old[i];
        if (!o) return a.appendChild(n);
        if (o.nodeName !== n.nodeName) return o.replaceWith(n);
        if (n.nodeType !== 1) { if (o.data !== n.data) o.data = n.data; return; }
        for (const at of [...o.attributes]) if (!n.hasAttribute(at.name)) o.removeAttribute(at.name);
        for (const at of n.attributes) if (o.getAttribute(at.name) !== at.value) o.setAttribute(at.name, at.value);
        syncKids(o, n);
    });
    old.slice(next.length).forEach(o => o.remove());
}

// Builders for the common controls, as HTML strings.
export const sw = (on, label, attrs = '') => `<button type="button" class="switch" role="switch" aria-checked="${on ? 'true' : 'false'}" aria-label="${esc(label)}" ${attrs}></button>`;
export const segBtns = (opts, value, attrs = '') => opts.map(([v, label, ic]) => `<button type="button" role="radio" aria-checked="${v === value}" data-v="${esc(v)}" ${attrs}>${v === value && ic !== false ? icon('check', 16, 2.6) : ''}${esc(label)}</button>`).join('');
export const chevron = (s = 16) => icon('chev', s, 2.6);

// Keeps Tab and Shift+Tab inside an open dialog that is not a native <dialog> (those do it themselves), so
// keyboard focus cannot wander off to the page behind it. Call from the dialog's keydown listener.
export function trapTab(e, box) {
    if (e.key !== 'Tab') return;
    const all = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', box).filter(el => !el.disabled && el.getClientRects().length);
    if (!all.length) return;
    const first = all[0], last = all[all.length - 1], at = document.activeElement;
    if (!box.contains(at) || (e.shiftKey ? at === first : at === last)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
}

// A small confirm box. Resolves true when the person confirms. Escape or Cancel resolves false.
export function confirmBox(title, text, okLabel = 'Delete', danger = true, noLabel = 'Cancel') {
    return new Promise(resolve => {
        const d = document.createElement('dialog');
        d.className = 'dlg';
        d.innerHTML = `<form method="dialog"><b>${esc(title)}</b><p>${esc(text)}</p><div class="btnrow"><button value="no" class="btn outline sm">${esc(noLabel)}</button><button value="yes" class="btn sm ${danger ? 'danger' : 'yellow'}">${esc(okLabel)}</button></div></form>`;
        document.body.appendChild(d);
        d.addEventListener('close', () => { resolve(d.returnValue === 'yes'); d.remove(); });
        d.showModal();
        d.querySelector('[value=no]').focus();
    });
}
