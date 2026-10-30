// Discover and Results: one route with a transition between them.
//
// Discover is only the search bar. Searching turns the bar into a loading bar that fills as each library
// answers, then it rises into the results page's own bar while the results are uncovered behind it.
// Results come as a shelf (spines, cassettes) or a list. Download to server works in place: the button
// becomes a progress pill driven by the server's job events.
import { $, $$, esc, api, icon, prefs, isPhone, size, toast, hideToast, toastId, copy, saveToDevice, sfx, anim, trapTab,
    paletteFor, spineFor, coverPalette, genCover, shortTitle, mix, rgba, hash, chevron, clientId, privPath } from './ui.js';
import { app, bus, go, setBg, drawNav } from './app.js';
import { tidyName } from './rename.js';

// Library names by id, from the server's source registry.
const libNames = () => (app.settings && app.settings.libraries) || {};
const SHORT_SRC = { 'Library Genesis': 'LIBGEN', "Anna's Archive": "ANNA'S", 'Internet Archive': 'ARCHIVE', 'Project Gutenberg': 'GUTENBERG', 'Memory of the World': 'MOTW', 'Z-Library': 'Z-LIBRARY', 'Standard Ebooks': 'STANDARD' };
const srcName = s => (s === 'Library Genesis' ? 'LibGen' : s || '');
const srcShort = s => SHORT_SRC[s] || String(s || '').toUpperCase();
const LINK = {
    direct: { text: 'direct file', ring: '#5EEAB4', bg: '#B9F5DC', dot: '#0E8A5B', dbg: 'rgba(94,234,180,0.2)', dfg: '#A6F7D8' },
    page: { text: 'source page only', short: 'source page', ring: '#B9B5E6', bg: '#E4E0EE', dot: '#6B66B0', dbg: 'rgba(255,255,255,0.12)', dfg: '#E4E0FF' },
    magnet: { text: 'magnet', ring: '#D68FE0', bg: '#F0D3FF', dot: '#9A3FB0', dbg: 'rgba(214,143,224,0.22)', dfg: '#F0C6F6' },
    pending: { text: 'finding the file link', short: 'checking…', ring: 'rgba(255,255,255,0.55)', bg: 'rgba(255,255,255,0.6)', dot: '#8A86A8', dbg: 'rgba(255,255,255,0.1)', dfg: '#D8D3CC' },
};
const FORMATS = { ebooks: ['epub', 'pdf', 'mobi', 'azw3'], audiobooks: ['m4b', 'mp3', 'zip'] };
const PER_SHELF = 14;

// Everything about the current search lives here, so leaving for the Shelf and coming back keeps it.
const S = {
    mode: 'ebooks', q: '', adv: null, results: [], patches: {}, sources: [], answered: [], status: {},
    searching: false, finished: false, error: '', seq: 0, view: null,
    f: { fmt: 'all', link: 'any', len: 'any', narrator: '', sort: 'best' }, sel: '', page: 0,
    resolved: 0, toResolve: 0, dl: {},
};
let root = null, onBus = [];

// ── Mount ────────────────────────────────────────────────────────────────────
export async function mount(el, { path, state }) {
    root = el;
    const listen = (t, fn) => { bus.addEventListener(t, fn); onBus.push([t, fn]); };
    listen('jobs', e => syncJobs(e.detail.jobs));
    listen('hello', e => syncJobs(e.detail.jobs));
    listen('done', e => jobDone(e.detail));
    listen('failed', e => jobFailed(e.detail.job));
    listen('shelf', syncShelf);
    syncJobs(app.jobs);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onDocKey);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointerup', onPointerUp);
    // Starting over: Discover (or the logo) pressed while Discover was already showing.
    if (state && state.reset) { Object.assign(S, { q: '', adv: null, results: [], sources: [], answered: [], searching: false, error: '' }); S.seq++; app.lastResults = null; drawNav(); }
    if (path === '/results') {
        // A shared or reloaded results link: run the search it names unless it is the one already showing.
        const want = fromUrl();
        if (want.q && (want.q !== S.q || want.mode !== S.mode || JSON.stringify(want.adv) !== JSON.stringify(S.adv))) {
            S.mode = want.mode;
            return startSearch(want.q, want.adv, false);
        }
        if (S.q) { syncShelf(); return renderResults(); } // the shelf may have changed while this page was away
        history.replaceState(null, '', '/');
    }
    renderDiscover();
}

// The results address carries the search, so it can be shared, bookmarked and reloaded. It lives only in
// the browser's address bar; the server still never writes searches down.
function resultsUrl() {
    const p = new URLSearchParams({ q: S.q });
    if (S.mode === 'audiobooks') p.set('mode', 'audiobooks');
    const a = S.adv;
    if (a) {
        for (const k of ['title', 'author', 'isbn']) if (a[k]) p.set(k, a[k]);
        if (a.formats && a.formats.length) p.set('formats', a.formats.join(','));
        if (a.from) p.set('from', a.from);
        if (a.to) p.set('to', a.to);
        if (a.lang) p.set('lang', a.lang);
    }
    return '/results?' + p;
}
function fromUrl() {
    const p = new URLSearchParams(location.search);
    const formats = (p.get('formats') || '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9]{2,5}$/.test(x));
    const t = k => (p.get(k) || '').trim().slice(0, 300);
    const adv = { title: t('title'), author: t('author'), isbn: t('isbn').replace(/[\s-]/g, ''), lang: (p.get('lang') || '').slice(0, 20), from: (p.get('from') || '').replace(/\D/g, '').slice(0, 4), to: (p.get('to') || '').replace(/\D/g, '').slice(0, 4), formats };
    const hasAdv = formats.length || adv.lang || adv.from || adv.to || adv.title || adv.author || adv.isbn;
    return { q: (p.get('q') || '').trim().slice(0, 300), mode: p.get('mode') === 'audiobooks' ? 'audiobooks' : 'ebooks', adv: hasAdv ? adv : null };
}
export function unmount() {
    document.removeEventListener('keydown', onDocKey);
    for (const [t, fn] of onBus) bus.removeEventListener(t, fn);
    onBus = [];
    cancelAnimationFrame(maskRaf);
    clearTimeout(shelfTimer);
    if (overlay) { overlay.remove(); overlay = null; }
    $('#topnav').style.visibility = '';
}
export function relayout() { if (location.pathname === '/results' && S.q) renderResults(); else renderDiscover(); }
export const lastResults = () => (S.q ? resultsUrl() : null);

// ── Discover ─────────────────────────────────────────────────────────────────
const modeSwitch = (cls = 'modeswitch') => `<div class="${cls}" role="radiogroup" aria-label="Search in">
    <button type="button" role="radio" aria-checked="${S.mode === 'ebooks'}" data-act="mode" data-v="ebooks">eBooks</button>
    <button type="button" role="radio" aria-checked="${S.mode === 'audiobooks'}" data-act="mode" data-v="audiobooks">Audiobooks</button></div>`;
const goBtn = (sz, ic) => `<button type="submit" class="gobtn" aria-label="Find it" style="width:${sz}px;height:${sz}px">${icon('search', ic, 2.6)}</button>`;

let overlay = null;
function renderDiscover() {
    setBg('var(--glow-home)');
    const phone = isPhone();
    root.innerHTML = `<div class="discover${phone ? ' phone' : ''}">
        ${phone ? '<header class="brand"><img src="/img/crystal-mark.png" alt=""><span>RaveBSD</span></header>' : ''}
        <h1 class="sr">Discover</h1>
        <div class="barwrap" id="barwrap">
          <form class="sform" id="dform" role="search">
            <div class="bar" id="bar">
              <div class="bar-ui" id="bar-ui">
                ${phone ? '' : modeSwitch()}
                <input type="text" id="q" placeholder="Search" aria-label="Search" autocomplete="off" spellcheck="false" enterkeyhint="search" value="${esc(S.q)}">
                ${phone ? '' : `<button type="button" class="advbtn" data-act="adv" aria-expanded="false" aria-controls="adv" aria-label="Advanced search">${icon('sliders')}</button>`}
                ${phone ? goBtn(48, 22) : goBtn(56, 26)}
              </div>
              <div class="bar-uif" id="bar-uif" aria-hidden="true"></div>
              <div class="loader" id="loader" aria-hidden="true"><div class="fill" id="fill"></div></div>
              <div class="blabel" id="blabel" aria-live="polite"></div>
            </div>
            ${phone ? `<div class="bar-ui2" id="bar-ui2">${modeSwitch('seg modes')}<button type="button" class="advbtn ph" data-act="adv" aria-expanded="false" aria-controls="adv" aria-label="Advanced search">${icon('sliders')}</button></div>` : ''}
            ${phone ? '' : advPanel(false)}
          </form>
        </div>
        ${phone ? advPanel(true) : ''}
        <p class="derr err" id="derr" role="alert"></p>
    </div>`;
    $('#dform').addEventListener('submit', e => { e.preventDefault(); const q = $('#q').value.trim(); if (q) startSearch(q, null, true); else $('#q').focus(); });
}

function advPanel(phone) {
    const a = S.adv || {};
    const chips = m => `<div class="chips" data-fmt="${m}" role="group" aria-label="Formats"${m !== S.mode ? ' hidden' : ''}>
        <button type="button" class="fchip" data-act="chip" data-any aria-pressed="${!(a.formats || []).length}">Any</button>
        ${FORMATS[m].map(f => `<button type="button" class="fchip" data-act="chip" data-v="${f}" aria-pressed="${(a.formats || []).includes(f)}">${f.toUpperCase()}</button>`).join('')}</div>`;
    // Every language the server's filter knows (LANGS in src/sources.js; npm test checks the two match).
    const langs = ['Any language', 'English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Russian', 'Japanese', 'Chinese', 'Dutch', 'Polish'];
    return `<div class="adv${phone ? ' sheet' : ''}" id="adv" role="${phone ? 'dialog' : 'region'}" aria-label="Advanced search" hidden>
        <div class="adv-head"><span class="adv-t">Advanced search</span>${phone ? `<button type="button" class="adv-x" data-act="adv" aria-label="Close advanced search">${icon('x', 20, 2.4)}</button>` : '<span class="adv-s">Fill in what you know. Empty boxes are ignored.</span>'}</div>
        <div class="adv-body">
        ${phone ? '<span class="adv-s">Fill in what you know. Empty boxes are ignored.</span>' : ''}
        <div class="fields"><label class="field">Title<input class="input" id="a-title" placeholder="Dune" autocomplete="off" value="${esc(a.title || '')}"></label>
            <label class="field">Author<input class="input" id="a-author" placeholder="Frank Herbert" autocomplete="off" value="${esc(a.author || '')}"></label>
            <label class="field">ISBN<input class="input" id="a-isbn" aria-label="ISBN" aria-describedby="a-isbn-hint" placeholder="978-0441013593" autocomplete="off" inputmode="numeric" value="${esc(a.isbn || '')}"><span class="adv-s" id="a-isbn-hint">With an ISBN, only the ISBN is searched.</span></label></div>
        <div class="fields"><label class="field">Language<span class="selwrap paper"><select id="a-lang">${langs.map(l => `<option${a.lang === l ? ' selected' : ''}>${l}</option>`).join('')}</select>${chevron(14)}</span></label>
            <div class="fields two"><label class="field">Published from<input class="input" id="a-from" placeholder="1965" inputmode="numeric" maxlength="4" value="${esc(a.from || '')}"></label>
            <label class="field">to<input class="input" id="a-to" placeholder="2024" inputmode="numeric" maxlength="4" value="${esc(a.to || '')}"></label></div></div>
        <div class="field">Format${chips('ebooks')}${chips('audiobooks')}</div>
        <div class="adv-btns"><button type="button" class="btn outline" data-act="adv-clear">Clear</button><button type="button" class="btn yellow" data-act="adv-go">Search with these</button></div>
        </div></div>`;
}
function toggleAdv(force) {
    const p = $('#adv'); if (!p) return;
    const open = force === undefined ? p.hidden : force;
    p.hidden = !open;
    $$('[data-act="adv"][aria-expanded]').forEach(b => b.setAttribute('aria-expanded', open));
    // The phone sheet covers the screen, so the tab bar steps aside while it is open and Tab stays inside it.
    if (isPhone()) { document.body.classList.toggle('bar-away', open); p.setAttribute('aria-modal', 'true'); }
    if (open) {
        anim(p, isPhone() ? [{ opacity: 0, transform: 'translateY(60px)' }, { opacity: 1, transform: 'none' }] : [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 280 });
        // Start from what is already in the search bar, so the panel refines the search instead of replacing it.
        const cur = ($('#q') || $('#rq') || {}).value || '';
        if (cur.trim() && !$('#a-title').value && !$('#a-author').value && !$('#a-isbn').value) $('#a-title').value = cur.trim();
        $('#a-title').focus({ preventScroll: true });
    } else { const b = $('.advbtn'); if (b && force === false && p.contains(document.activeElement)) b.focus(); }
}
function readAdv() {
    const v = id => ($('#' + id) ? $('#' + id).value.trim() : '');
    const formats = $$(`#adv [data-fmt="${S.mode}"] [data-v][aria-pressed="true"]`).map(b => b.dataset.v);
    const lang = v('a-lang');
    return { title: v('a-title'), author: v('a-author'), isbn: v('a-isbn'), lang: lang === 'Any language' ? '' : lang, from: v('a-from').replace(/\D/g, ''), to: v('a-to').replace(/\D/g, ''), formats };
}

// ── Searching ────────────────────────────────────────────────────────────────
function searchUrl(q, mode, adv) {
    const p = new URLSearchParams({ q, mode, stream: '1' });
    if (adv) {
        if (adv.formats.length) p.set('formats', adv.formats.join(','));
        const from = adv.from || adv.to, to = adv.to || adv.from;
        if (from) p.set('year', from === to ? from : `${from}-${to}`);
        // With an author too, the title alone is what the libraries are asked again with and judged against.
        if (adv.title && adv.author) p.set('title', adv.title);
        if (adv.lang) p.set('lang', adv.lang.toLowerCase());
    }
    return '/search/all?' + p;
}

function resetFilters() {
    const st = app.settings ? app.settings.searching : { links: 'direct', length: 'unabridged' };
    S.f = { fmt: 'all', link: S.mode === 'ebooks' && st.links === 'direct' ? 'direct' : 'any', len: S.mode === 'audiobooks' ? st.length : 'any', narrator: '', sort: 'best' };
    if (S.adv && S.adv.formats.length === 1) S.f.fmt = S.adv.formats[0];
}

// A new search from the results page plays the whole cycle again (bar, loading, reveal), so results do not
// shuffle about on screen while libraries answer.
function searchAgain(q, adv) {
    S.q = q;
    if (document.activeElement) document.activeElement.blur(); // lets a phone keyboard close first
    window.scrollTo(0, 0);
    renderDiscover();
    return startSearch(q, adv, true);
}
// fromDiscover: run the full animation. Otherwise (a new search from the results bar) the results page
// shows the progress in its heading and fills in as libraries answer.
async function startSearch(q, adv, fromDiscover) {
    const seq = ++S.seq;
    Object.assign(S, { q, adv, results: [], patches: {}, sources: [], answered: [], status: {}, searching: true, finished: false, error: '', sel: '', picked: '', page: 0, listN: 0, resolved: 0, toResolve: 0 });
    resolveQueue.length = 0;
    resetFilters();
    if (fromDiscover) toggleAdv(false);
    const flow = fromDiscover ? discoverFlow(seq) : null;
    app.lastResults = resultsUrl();
    if (!fromDiscover) { S.settleOnce = true; history.replaceState({ keepScroll: true }, '', app.lastResults); drawNav(); renderResults(); }
    try {
        const res = await fetch(searchUrl(q, S.mode, adv), { credentials: 'same-origin' });
        if (res.status === 401) { location.reload(); return; }
        if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'The search failed'); }
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('ndjson')) {
            const reader = res.body.getReader(), dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                let i;
                while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim() && seq === S.seq) onEvent(JSON.parse(line), flow); }
                if (seq !== S.seq) { reader.cancel(); return; }
            }
        } else {
            // A repeat search answered from memory: everything at once.
            const j = await res.json();
            if (seq !== S.seq) return; // a newer search started meanwhile: this answer is not for it
            S.sources = Object.keys(j.meta || {}).filter(k => k in libNames() && (j.meta[k] > 0));
            S.answered = S.sources.slice();
            onEvent({ final: j }, flow);
        }
    } catch (e) {
        if (seq !== S.seq) return;
        S.error = e.message || 'The search failed';
    }
    if (seq !== S.seq) return;
    S.searching = false; S.finished = true;
    if (flow) flow.allIn(); else { refreshResults(); preloadCovers(S.results.slice(0, 80).filter(r => r.coverUrl)); }
}

function onEvent(ev, flow) {
    if (ev.sources) { S.sources = ev.sources; if (flow) flow.progress(); return; }
    if (ev.done) {
        if (!S.answered.includes(ev.done)) S.answered.push(ev.done);
        S.status[ev.done] = ev.status;
        setResults(ev.results);
        if (flow) flow.progress(); else refreshSoon();
        return;
    }
    if (ev.final) { setResults(ev.final.results); S.answered = S.sources.slice(); if (flow) flow.progress(); return; }
    if (ev.error) S.error = ev.error;
}

function setResults(list) {
    S.results = (list || []).map(r => Object.assign(r, S.patches[r.id] || {}));
    // Until a book is picked by hand, the selection follows the best match as results stream in.
    if (S.sel !== S.picked || !S.results.some(r => r.id === S.sel)) S.sel = '';
    for (const r of S.results) if (r.linkType === 'pending' && !S.patches[r.id] && !resolveQueue.includes(r.id) && !resolving.has(r.id)) { resolveQueue.push(r.id); S.toResolve++; }
    pumpResolve();
}

// Asks the server for each result's real file link, 4 at a time, so link types and filters settle.
const resolveQueue = [], resolving = new Set();
function pumpResolve() {
    while (resolving.size < 4 && resolveQueue.length) {
        const id = resolveQueue.shift(), seq = S.seq;
        resolving.add(id);
        api('/resolve?id=' + encodeURIComponent(id)).then(r => {
            if (seq !== S.seq) return;
            const patch = { linkType: r.linkType || (r.directUrl ? 'direct' : r.magnet ? 'magnet' : 'page'), fileAs: r.fileAs, onShelf: r.onShelf, format: r.format || undefined, filesize: r.filesize || undefined, magnet: r.magnet || undefined, infoHash: r.infoHash || undefined, length: r.length || undefined, bitrate: r.bitrate || undefined,
                abridged: typeof r.abridged === 'boolean' ? r.abridged : undefined, narrator: r.narrator || undefined };
            for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
            S.patches[id] = patch;
            const res = S.results.find(x => x.id === id);
            if (res) Object.assign(res, patch);
        }).catch(() => {
            if (seq !== S.seq) return;
            S.patches[id] = { linkType: 'page' };
            const res = S.results.find(x => x.id === id); if (res) res.linkType = 'page';
        }).finally(() => {
            resolving.delete(id);
            // A slot freed by an older search goes to the current one's queue, which may be waiting for it.
            if (seq === S.seq) { S.resolved++; if (location.pathname === '/results') refreshSoon(); }
            pumpResolve();
        });
    }
}

// ── The Discover → Results animation ─────────────────────────────────────────
// Discover is a fixed layer over the page, so it never takes space. Whatever happens during the animation
// (a slow phone, a thrown step, the keyboard closing mid-way), done() leaves the results page showing.
const EASE_RISE = 'cubic-bezier(.45,0,.2,1)';
let maskRaf = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));
function discoverFlow(seq) {
    const motion = prefs.motion, phone = isPhone();
    const wrap = $('#barwrap'), bar = $('#bar'), ui = $('#bar-ui'), ui2 = $('#bar-ui2'), loader = $('#loader'), fill = $('#fill'), label = $('#blabel');
    const alive = () => seq === S.seq && document.body.contains(wrap);
    const A = (el, kf, dur, o = {}) => (el ? el.animate(kf, { duration: motion ? dur : 0, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'both', ...o }).finished.catch(() => {}) : Promise.resolve());
    const SH0 = phone ? '0 6px 0 rgba(0,0,0,0.25), 0 16px 40px rgba(61,90,254,0.3)' : '0 8px 0 rgba(0,0,0,0.25), 0 20px 60px rgba(61,90,254,0.35)';
    const SH1 = '0 0 0 rgba(0,0,0,0), 0 0 0 rgba(0,0,0,0)';
    const H0 = phone ? 64 : 76, H1 = phone ? 16 : 20, DY = phone ? 24 : 28;
    const BAR0 = { height: H0 + 'px', transform: 'translateY(0px)', backgroundColor: '#FBF8FF', boxShadow: SH0, borderRadius: H0 / 2 + 'px' };
    const BAR1 = { height: H1 + 'px', transform: `translateY(${DY}px)`, backgroundColor: 'rgba(255,255,255,0.16)', boxShadow: SH1, borderRadius: H1 / 2 + 'px' };
    overlay = wrap;
    let started = Date.now(), finishing = false, allInResolve, page = null, ended = false;
    const allIn = new Promise(r => { allInResolve = r; });
    // The bar has two jobs: libraries answering (85%), then the first shelf of covers (15%).
    let coverDone = 0, coverTotal = 0;
    const setFill = p => { fill.style.width = Math.min(100, Math.round(p)) + '%'; };
    const progress = () => {
        if (!alive() || finishing) return;
        const n = S.sources.length;
        const next = S.sources.find(s => !S.answered.includes(s));
        const done = S.answered.length;
        if (n) label.textContent = next ? (phone ? `${libNames()[next] || next}…  ${Math.min(done + 1, n)} of ${n}` : `Asking ${libNames()[next] || next}…   ${Math.min(done + 1, n)} of ${n}`) : `${n} of ${n}`;
        if (n) setFill(done / n * 85);
        // Stop waiting for slow libraries once most have answered and there is something to show.
        if (done >= n && n) allInResolve();
        else if (S.results.length && done / n >= 0.6 && Date.now() - started > 9000) allInResolve();
    };
    const slowTimer = setInterval(progress, 1000);
    // Whatever state the animation reached, end on the results page with nothing left over.
    const done = (instantSettle) => {
        if (ended) return; ended = true;
        cancelAnimationFrame(maskRaf);
        clearInterval(slowTimer);
        if (seq !== S.seq) return;
        if (!page || !document.body.contains(page)) {
            if (location.pathname !== '/results') { history.pushState(null, '', resultsUrl()); drawNav('/results'); }
            page = renderResults();
        }
        wrap.remove(); overlay = null;
        const d = $('.discover'); if (d) d.remove();
        page.getAnimations().forEach(a => a.cancel());
        page.style.visibility = ''; page.style.maskImage = ''; page.style.webkitMaskImage = ''; page.inert = false;
        settle(page, instantSettle);
        focusHeading();
    };
    const run = async () => {
        // The phone keyboard has to be gone before anything is measured, or every position is off.
        const q = $('#q'); if (q) q.blur();
        if (phone) await wait(window.visualViewport && visualViewport.height < innerHeight - 80 ? 350 : 60);
        scrollTo(0, 0);
        const r0 = wrap.getBoundingClientRect();
        // Narrow the bar: desktop 880 -> 520 wide, phone side insets 16 -> 56.
        const narrowW = phone ? r0.width - 80 : Math.min(520, r0.width);
        const WIDE = { left: r0.left + 'px', width: r0.width + 'px' }, NARROW = { left: (r0.left + (r0.width - narrowW) / 2) + 'px', width: narrowW + 'px' };
        Object.assign(wrap.style, { position: 'fixed', top: r0.top + 'px', left: r0.left + 'px', width: r0.width + 'px', margin: 0, transform: 'none' });
        // 1. The search bar turns into a thin loading bar.
        label.textContent = 'Asking the libraries…';
        await Promise.all([
            A(ui, [{ opacity: 1 }, { opacity: 0 }], 250),
            ui2 && A(ui2, [{ opacity: 1 }, { opacity: 0 }], 250),
            A(bar, [BAR0, BAR1], 650),
            A(wrap, [WIDE, NARROW], 650),
            A(loader, [{ opacity: 0 }, { opacity: 1 }], 300, { delay: motion ? 300 : 0 }),
            A(label, [{ opacity: 0 }, { opacity: 1 }], 300, { delay: motion ? 350 : 0 }),
        ]);
        ui.inert = true; if (ui2) ui2.inert = true;
        if (!alive()) return;
        progress();
        // 2. It fills as libraries answer (allIn resolves when they have, or when the slow ones are left).
        await allIn;
        clearInterval(slowTimer);
        if (!alive()) return;
        // 2b. Then it fetches the covers the first shelf will show, so they are there when it opens.
        const first = filtered().slice(0, PER_SHELF).filter(r => r.coverUrl);
        coverTotal = first.length;
        if (coverTotal) {
            const tick = () => { label.textContent = `Fetching covers…   ${coverDone} of ${coverTotal}`; setFill(85 + coverDone / coverTotal * 15); };
            tick();
            await Promise.race([preloadCovers(first, () => { coverDone++; tick(); }), wait(6000)]);
            if (!alive()) return;
        }
        finishing = true;
        setFill(100);
        preloadCovers(S.results.slice(0, 80).filter(r => r.coverUrl));
        // The results page is drawn now, hidden behind the bar.
        history.pushState(null, '', resultsUrl());
        drawNav('/results');
        page = renderResults({ hidden: true });
        if (!motion) return done(true);
        label.textContent = S.error ? S.error : S.results.length ? `Found ${S.results.length} result${S.results.length === 1 ? '' : 's'}` : 'Nothing found';
        label.style.color = S.error ? '#FF8A65' : '#5EEAB4';
        await wait(800);
        if (!alive()) return;
        // 3. Back into a search bar.
        await Promise.all([
            A(loader, [{ opacity: 1 }, { opacity: 0 }], 250),
            A(label, [{ opacity: 1 }, { opacity: 0 }], 250),
            A(bar, [BAR1, BAR0], 650),
            A(wrap, [NARROW, WIDE], 650),
            A(ui, [{ opacity: 0 }, { opacity: 1 }], 300, { delay: 350 }),
            ui2 && A(ui2, [{ opacity: 0 }, { opacity: 1 }], 300, { delay: 350 }),
        ]);
        await wait(120);
        if (!alive()) return;
        // 4. It rises onto the results page's real bar, uncovering the results behind it.
        const real = $('#rbar', page);
        scrollTo(0, 0);
        const rb = real.getBoundingClientRect();
        const uif = $('#bar-uif');
        uif.innerHTML = real.innerHTML;
        $$('input', uif).forEach(i => { i.value = S.q; i.tabIndex = -1; });
        $$('button', uif).forEach(b => { b.tabIndex = -1; });
        page.style.visibility = '';
        page.inert = true;
        const D = 1600;
        if (view() === 'list') stackRows(page, D * 0.55);
        const track = () => {
            const e = Math.round(bar.getBoundingClientRect().bottom - page.getBoundingClientRect().top);
            const m = `linear-gradient(to bottom, transparent ${e}px, #000 ${e + (phone ? 80 : 110)}px)`;
            page.style.maskImage = m; page.style.webkitMaskImage = m;
            maskRaf = requestAnimationFrame(track);
        };
        track();
        const brand = $('.discover .brand');
        const SH2 = phone ? '0 4px 0 rgba(0,0,0,0.25)' : '0 8px 0 rgba(0,0,0,0.25), 0 20px 60px rgba(0,0,0,0.4)';
        await Promise.race([Promise.all([
            A(wrap, [{ top: wrap.style.top, ...WIDE }, { top: rb.top + 'px', left: rb.left + 'px', width: rb.width + 'px' }], D, { easing: EASE_RISE }),
            A(bar, [{ height: H0 + 'px', borderRadius: H0 / 2 + 'px', boxShadow: SH0 }, { height: rb.height + 'px', borderRadius: rb.height / 2 + 'px', boxShadow: SH2 }], D, { easing: EASE_RISE }),
            A(page, [{ opacity: 0 }, { opacity: 1 }], D * 0.9, { easing: 'ease-in', delay: D * 0.05 }),
            A(ui, [{ opacity: 1 }, { opacity: 0 }], 600, { delay: D * 0.55 }),
            ui2 && A(ui2, [{ opacity: 1 }, { opacity: 0 }], 400),
            A(uif, [{ opacity: 0 }, { opacity: 1 }], 600, { delay: D * 0.6 }),
            brand && A(brand, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-20px)' }], 600),
        ]), wait(D + 1500)]);
        cancelAnimationFrame(maskRaf);
        if (!alive()) return;
        // 5. Hand over to the real bar, then settle the view.
        await Promise.race([A(wrap, [{ opacity: 1 }, { opacity: 0 }], 200), wait(600)]);
        done(false);
    };
    // If a step threw while Discover is still showing, finish straight onto the results.
    run().catch(() => {}).finally(() => { if (seq === S.seq && document.body.contains(wrap)) done(true); });
    return { progress, allIn: () => { allInResolve(); } };
}

// Covers come through /cover; loading them (and their colours) early means the shelf opens complete.
// Six at a time, each counted once whether it loaded or not.
function preloadCovers(list, onEach) {
    let i = 0;
    const worker = async () => { while (i < list.length) { const r = list[i++]; await coverPalette(coverSrc(r)).catch(() => null); if (onEach) onEach(); } };
    return Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
}

// Scroll so the "N results for" heading, the filters, the shelf and the card are in view. Phones stop with
// the heading just below the view switcher. Desktop starts at the heading, scrolling further only as far
// as the card's bottom needs. On phones the tab bar slides away on the way down.
function settle(page, instant) {
    const card = $('.rcard', page), filters = $('.filters', page), head = $('.rhead-wrap', page);
    if (!card || !filters) return;
    const top = el => el.getBoundingClientRect().top + scrollY;
    let target;
    if (isPhone()) {
        const row = $('.rrow', page);
        target = row ? row.getBoundingClientRect().bottom + scrollY + 6 : top(head || filters) - 8;
    } else {
        const view = window.visualViewport ? visualViewport.height : innerHeight;
        const cardBottom = card.getBoundingClientRect().bottom + scrollY;
        target = top(head || filters) - 16;
        if (cardBottom - target > view - 12) target = cardBottom + 12 - view;
    }
    if (isPhone() && target > 40) document.body.classList.add('bar-away');
    scrollTo({ top: Math.max(0, target), behavior: instant || !prefs.motion ? 'auto' : 'smooth' });
}
function focusHeading() { const h = $('#rhead'); if (h) h.focus({ preventScroll: true }); }

// ── Results ──────────────────────────────────────────────────────────────────
const view = () => S.view || prefs.view || (app.settings && app.settings.searching.view) || 'shelf';

function filtered() {
    const f = S.f;
    let list = S.results.filter(r => {
        const fmt = String(r.format || '').toLowerCase();
        if (f.fmt !== 'all' && fmt !== f.fmt) return false;
        if (S.mode === 'ebooks') {
            if (f.link === 'direct' && !['direct', 'pending'].includes(r.linkType)) return false;
        } else {
            // Length is often unknown; unknown recordings stay in.
            if (f.len === 'unabridged' && r.abridged === true) return false;
            if (f.len === 'abridged' && r.abridged === false) return false;
            if (f.narrator && !String(r.narrator || '').toLowerCase().includes(f.narrator.toLowerCase())) return false;
        }
        return true;
    });
    if (f.sort === 'size') list = list.slice().sort((a, b) => (b.filesize || 0) - (a.filesize || 0));
    if (f.sort === 'new') list = list.slice().sort((a, b) => (parseInt(b.year) || 0) - (parseInt(a.year) || 0));
    if (f.sort === 'az') list = list.slice().sort((a, b) => String(a.title).localeCompare(String(b.title)));
    return list;
}
const bestId = () => (S.results[0] || {}).id;

function current(list) {
    let r = list.find(x => x.id === S.sel);
    if (!r) { r = list[S.page * PER_SHELF] || list[0]; S.sel = r ? r.id : ''; }
    return r;
}

// The palette of the selected result (from its real cover when there is one).
async function applyPalette(r) {
    let p = paletteFor(r);
    if (r && r.coverUrl) { const cp = await coverPalette(coverSrc(r)); if (cp) p = cp; }
    if (!r || r.id !== S.sel) return;
    const c = p.c;
    const audio = S.mode === 'audiobooks';
    setBg(`radial-gradient(900px 640px at ${audio ? '100%' : '0%'} 0%, ${rgba(c[0], 0.3)}, transparent 62%), radial-gradient(800px 600px at ${audio ? '0%' : '100%'} 8%, ${rgba(c[1], 0.28)}, transparent 60%), radial-gradient(900px 700px at 50% 58%, ${rgba(c[2], 0.4)}, transparent 65%), radial-gradient(1000px 700px at 50% 100%, ${rgba(c[1], 0.2)}, transparent 62%), ${mix(c[2], '#000000', 0.86)}`);
    const card = $('.rcard');
    if (card) {
        card.style.background = `linear-gradient(135deg,${mix(c[0], '#FFFFFF', 0.62)} 0%,${mix(c[1], '#FFFFFF', 0.6)} 100%)`;
        if (!isPhone()) card.style.boxShadow = `0 24px 70px ${rgba(c[1], 0.35)}`;
    }
    $$('.cassette-body').forEach(el => { el.style.background = `linear-gradient(160deg,${c[0]},${c[1]})`; });
    $$('.cover-back').forEach(el => { el.style.background = `linear-gradient(160deg,${mix(c[2], '#FFFFFF', 0.15)},${mix(c[2], '#000000', 0.45)})`; });
}
const coverSrc = r => '/cover?id=' + encodeURIComponent(r.id);

function renderResults({ hidden = false } = {}) {
    const phone = isPhone();
    const list = filtered();
    const r = current(list);
    const audio = S.mode === 'audiobooks';
    drawn = { hd: heading(list), fl: filters(phone), nb: needsBanner(), bd: body(list, r, view(), phone) };
    const html = `<div class="results${phone ? ' phone' : ''}${audio ? ' audio' : ''}" id="results"${hidden ? ' style="visibility:hidden"' : ''}>
        <main class="page rpage">
        ${resultsBar(phone)}
        ${drawn.hd}
        ${S.error && !S.results.length ? `<div class="banner coral"><span class="grow">${esc(S.error)}</span></div>` : ''}
        ${phone ? '' : drawn.nb || NO_NEEDS}
        ${drawn.fl}
        ${phone ? drawn.nb || NO_NEEDS : ''}
        <div id="rbody">${drawn.bd}</div>
        ${moreLinks(phone)}
        </main></div>`;
    const existing = $('#results');
    if (existing) existing.outerHTML = html; else root.insertAdjacentHTML('beforeend', html);
    const page = $('#results');
    if (r) applyPalette(r); else setBg('var(--glow-home)');
    $('#rq', page).value = S.q;
    $('#rform', page).addEventListener('submit', e => { e.preventDefault(); const q = $('#rq').value.trim(); if (q) searchAgain(q, null); });
    return page;
}
// Many small updates (each library answering, each link found) are drawn together, at most every 150 ms.
let refreshTimer = null;
function refreshSoon() { if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = null; refreshResults(); }, 150); }
// Re-draws what depends on results without touching the search bar (so typing is not interrupted).
// A part is only replaced when its markup changed, so an open menu or a focused filter is not torn down by
// the next library answering. drawn holds what is on screen.
let drawn = {};
function refreshResults() {
    const page = $('#results');
    if (!page || location.pathname !== '/results') return;
    const list = filtered(), r = current(list), phone = isPhone();
    const next = { hd: heading(list), fl: filters(phone), nb: needsBanner(), bd: body(list, r, view(), phone) };
    const ae = document.activeElement;
    if (next.hd !== drawn.hd) { const h = $('.rhead-wrap', page); if (h) h.outerHTML = next.hd; if (ae && ae.id === 'rhead') $('#rhead', page).focus({ preventScroll: true }); }
    if (next.fl !== drawn.fl) {
        const keep = ae && ae.matches('.filters [data-act="filter"]') ? `[data-act="filter"][data-k="${ae.dataset.k}"][data-v="${ae.dataset.v}"]` : '';
        const fl = $('.filters', page); if (fl) fl.outerHTML = next.fl;
        if (keep) { const b = $('.filters ' + keep, page); if (b) b.focus({ preventScroll: true }); }
    }
    if (next.nb !== drawn.nb) { const nb = $('.needs', page); if (nb) nb.outerHTML = next.nb || NO_NEEDS; }
    if (next.bd !== drawn.bd) {
        const focusSel = ae && ae.closest('#rbody') ? (ae.dataset.id || '') : '';
        $('#rbody', page).innerHTML = next.bd;
        if (focusSel) { const el = $(`#rbody [data-id="${CSS.escape(focusSel)}"]`); if (el) el.focus({ preventScroll: true }); }
    }
    drawn = next;
    if (r) applyPalette(r);
    // A results address opened directly skips Discover's reveal, so it settles once the first card is there.
    if (S.settleOnce && $('.rcard', page) && scrollY < 8) { S.settleOnce = false; settle(page, true); }
}

// The same advanced search as Discover, from the results bar, so a search can be narrowed in place.
const advBtn = cls => `<button type="button" class="advbtn ${cls}" data-act="adv" aria-expanded="false" aria-controls="adv" aria-label="Advanced search" title="Advanced search">${icon('sliders', cls ? 18 : 22)}</button>`;
function resultsBar(phone) {
    if (phone) return `<form class="rform ph" id="rform" role="search">
        <div class="rtop"><img src="/img/crystal-mark.png" alt="RaveBSD" class="rlogo">
          <div class="rbar ph" id="rbar"><input type="text" id="rq" aria-label="Search" autocomplete="off" spellcheck="false" enterkeyhint="search">${advBtn('sm')}${goBtn(40, 20)}</div></div>
        <div class="rrow">${modeSwitch('seg modes sm')}
          <div class="seg icons sm" role="radiogroup" aria-label="View">${viewBtns()}</div></div></form>${advPanel(true)}`;
    return `<form class="rform" id="rform" role="search">
        <div class="rbar" id="rbar">${modeSwitch()}<input type="text" id="rq" aria-label="Search" autocomplete="off" spellcheck="false">${advBtn('')}${goBtn(52, 24)}</div>
        <div class="seg icons" role="radiogroup" aria-label="View">${viewBtns()}</div>${advPanel(false)}</form>`;
}
const viewBtns = () => [['shelf', 'Shelf view', 'shelf'], ['list', 'List view', 'list']].map(([k, l, ic]) =>
    `<button type="button" role="radio" aria-checked="${view() === k}" aria-label="${l}" title="${l}" data-act="view" data-v="${k}">${icon(ic)}</button>`).join('');

function heading(list) {
    const audio = S.mode === 'audiobooks';
    const n = S.results.length, total = S.sources.length, answered = S.answered.length;
    const qcol = audio ? '#FF9FE8' : '#FFD54A';
    let title;
    if (S.searching && !n) title = `Searching for <span class="serif" style="color:${qcol}">“${esc(S.q)}”</span>`;
    else title = `${n} result${n === 1 ? '' : 's'} for <span class="serif" style="color:${qcol}">“${esc(S.q)}”</span>`;
    const pending = S.toResolve - S.resolved;
    const parts = [];
    if (total && answered < total) parts.push(`${answered} of ${total} libraries answered`);
    if (audio && !(total && answered < total)) {
        const bySrc = {};
        for (const r of S.results) bySrc[srcName(r.source)] = (bySrc[srcName(r.source)] || 0) + 1;
        parts.push(Object.entries(bySrc).sort((a, b) => b[1] - a[1]).map(([s, k]) => `${k} from ${s}`).join(' · '));
    }
    if (S.toResolve && pending > 0) parts.push(`finding direct links ${S.resolved}/${S.toResolve}`);
    // Libraries that ran out of time or failed are named, so a thin result list has an explanation.
    const missed = Object.entries(S.status).filter(([, st]) => st === 'timeout' || st === 'error').map(([k]) => libNames()[k] || k);
    if (missed.length && !S.searching) parts.push(`${missed.join(', ')} did not answer in time`);
    const progress = total ? (answered / total) * (S.toResolve ? 0.5 + 0.5 * S.resolved / S.toResolve : 1) : 0;
    const busy = (total && answered < total) || pending > 0 || S.searching;
    if (n && list.length < n) parts.push(`${list.length} shown`);
    return `<div class="rhead-wrap"><h1 class="rhead" id="rhead" tabindex="-1">${title}</h1>
        ${parts.filter(Boolean).length ? `<span class="rmeta">${parts.filter(Boolean).join(' · ')}</span>` : ''}
        ${busy ? `<div class="rprog" role="progressbar" aria-label="Search progress" aria-valuenow="${Math.round(progress * 100)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${Math.max(4, Math.round(progress * 100))}%"></div></div>` : ''}</div>`;
}

// A hidden stand-in, so a banner that turns up while the page is open has a place to land.
const NO_NEEDS = '<span class="needs" hidden></span>';
function needsBanner() {
    const needs = (app.status && app.status.needs || []).filter(l => l.state === 'needsHuman' && (S.mode === 'ebooks' || l.id !== 'annas'));
    if (!needs.length || S.mode !== 'ebooks') return '';
    return `<a class="banner yellow needs" href="/admin#attention"><span class="grow">${esc(needs[0].name)} needs a check</span><b>Verify</b></a>`;
}

function filters(phone) {
    const f = S.f, audio = S.mode === 'audiobooks';
    const fseg = (key, label, opts) => `<div class="fseg" role="radiogroup" aria-label="${label}">${opts.map(([v, t]) => `<button type="button" role="radio" aria-checked="${f[key] === v}" data-act="filter" data-k="${key}" data-v="${v}">${t}</button>`).join('')}</div>`;
    const fmts = [['all', 'All'], ...FORMATS[S.mode].map(x => [x, x])];
    let out = fseg('fmt', 'Format', fmts);
    if (!audio) out += fseg('link', 'Link type', [['any', 'Any link'], ['direct', 'Direct']]);
    else {
        out += fseg('len', 'Length', [['any', 'Any length'], ['unabridged', 'Unabridged'], ['abridged', 'Abridged']]);
        const narrators = [...new Set(S.results.flatMap(r => String(r.narrator || '').split(/,|&| and /).map(s => s.trim()).filter(Boolean)))].sort().slice(0, 40);
        out += `<label class="fsel">NARRATOR <span class="selwrap"><select data-act="narrator" aria-label="Narrator"><option value="">ANYONE</option>${narrators.map(n => `<option value="${esc(n)}"${f.narrator === n ? ' selected' : ''}>${esc(n.toUpperCase())}</option>`).join('')}</select>${chevron(14)}</span></label>`;
    }
    if (view() === 'list') out += `<label class="fsel sort">SORT <span class="selwrap"><select data-act="sort" aria-label="Sort">${[['best', 'Best match'], ['size', 'Largest file'], ['new', 'Newest'], ['az', 'A to Z']].map(([v, t]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${t.toUpperCase()}</option>`).join('')}</select>${chevron(14)}</span></label>`;
    else if (!phone) out += `<span class="key">${(audio ? ['magnet', 'direct', 'page'] : ['direct', 'page']).map(k => `<span><i style="background:${LINK[k].ring}"></i>${LINK[k].short || LINK[k].text}</span>`).join('')}</span>`;
    return `<div class="filters${phone ? ' hscroll' : ''}">${out}</div>`;
}

function body(list, r, v, phone) {
    if (!S.results.length) {
        if (S.searching) return `<div class="empty"><b>Asking the libraries…</b><span>Results show up here as they answer.</span></div>`;
        return `<div class="empty"><b>Nothing found${S.error ? '' : ' in the libraries'}</b><span>${S.error ? esc(S.error) : 'Try other words, or one of the sites below.'}</span></div>`;
    }
    if (!list.length) return `<div class="empty"><b>Nothing matches these filters</b><span>${S.results.length} result${S.results.length === 1 ? '' : 's'} are hidden by the filters above.</span><button type="button" class="btn outline sm" data-act="clear-filters">Show everything</button></div>`;
    if (v === 'list') return listView(list, phone);
    return shelfView(list, r, phone) + card(r, list, phone);
}

// ── Shelf view ───────────────────────────────────────────────────────────────
// Spines have room for a few words: drop subtitles, series brackets and edition notes.
const spineTitle = t => String(t || '').replace(/\s*[([{].*$/, '').replace(/\s*[:;|].*$/, '').replace(/\s+-\s+.*$/, '').trim().slice(0, 34) || String(t || '').slice(0, 34);
function spineHtml(r, phone) {
    const h = hash(r.id + r.title), audio = S.mode === 'audiobooks', lt = LINK[r.linkType] || LINK.page;
    const fmt = String(r.format || '').toUpperCase().slice(0, 5);
    const label = `${r.title}, ${fmt || 'unknown format'}, from ${srcName(r.source)}, ${r.onShelf ? 'already on your shelf' : lt.text}`;
    if (audio) {
        const w = phone ? 26 + (h % 3) * 5 : 38 + (h % 3) * 6, ht = phone ? 170 + (h % 20) : 280;
        const bg = spineFor(r).bg;
        return `<button type="button" class="tape" role="option" aria-selected="false" aria-label="${esc(label)}" data-act="pick" data-id="${esc(r.id)}" tabindex="-1" style="width:${w}px;height:${ht}px;background:${bg}${r.onShelf ? ';box-shadow:inset 0 0 0 2px rgba(0,0,0,0.22),0 0 0 3px #5EEAB4' : ''}">
            <span class="sd" style="box-shadow:inset 0 0 0 2px ${lt.ring}"></span>
            <span class="tl" style="width:${w - 12}px"><span class="vt"><b>${esc(spineTitle(r.title))}</b><small>${esc(srcShort(r.source))}</small></span></span>
            <span class="sf">${r.onShelf ? 'ON SHELF' : esc(fmt)}</span></button>`;
    }
    const sp = spineFor(r);
    const w = phone ? 28 + (h % 10) : 44 + (h % 15), ht = phone ? 162 + (h % 36) : 265 + (h % 66);
    const fs = phone ? 10 : w >= 52 ? 16 : w >= 48 ? 15 : 14;
    return `<button type="button" class="spine${r.onShelf ? ' onshelf' : ''}" role="option" aria-selected="false" aria-label="${esc(label)}" data-act="pick" data-id="${esc(r.id)}" tabindex="-1" style="width:${w}px;height:${ht}px;background:${sp.bg};color:${sp.ink}">
        <span class="sd" style="background:${sp.dark ? '#0F0E2A' : '#14123A'};${r.onShelf ? '' : `box-shadow:inset 0 0 0 ${phone ? 1.5 : 2}px ${lt.ring}`}"></span>
        <span class="vt"><b style="font-size:${fs}px">${esc(spineTitle(r.title))}</b><small>${esc(srcShort(r.source))}</small></span>
        <span class="sf">${r.onShelf ? 'ON SHELF' : esc(fmt)}</span></button>`;
}

// Where the server files a result. The server sends the place inside the shelf; admins also see the folder.
const fileAsShown = r => { const sh = (app.settings && app.settings.shelves) || {}, dir = (r.kind === 'audiobook' ? sh.audioDir : sh.ebookDir) || ''; return (dir ? dir.replace(/\/+$/, '') + '/' : '') + (r.fileAs || ''); };
// The pulled-out book takes the shape of its real cover (within the usual size, standing on the shelf), so
// wide or tall covers are not cropped. The back cover follows.
window.rbsdFitCover = img => {
    const cov = img.parentElement, back = cov.parentElement.querySelector('.cover-back');
    const r = img.naturalWidth / img.naturalHeight, W = cov.offsetWidth, H = cov.offsetHeight;
    if (!r || !W || Math.abs(r - W / H) < 0.01) return;
    const w = Math.min(W, H * r), h = Math.min(H, W / r), dw = W - w, dh = H - h;
    Object.assign(cov.style, { width: w + 'px', height: h + 'px', top: cov.offsetTop + dh + 'px' });
    if (back) Object.assign(back.style, { width: back.offsetWidth - dw + 'px', height: back.offsetHeight - dh + 'px', top: back.offsetTop + dh + 'px' });
};
function coverHtml(r, phone) {
    const best = r.id === bestId();
    const audio = S.mode === 'audiobooks';
    const label = `${audio ? 'Cassette for' : 'Cover of'} ${r.title}, from ${srcName(r.source)}, ${String(r.format || '').toUpperCase()}`;
    if (audio) return cassetteHtml(r, phone, best, label);
    const img = r.coverUrl ? `<img src="${coverSrc(r)}" alt="" draggable="false" onload="rbsdFitCover(this)" onerror="this.remove()"><div class="gloss"></div>` : '';
    return `<div class="pulled${phone ? ' ph' : ''}" data-swipe role="option" aria-selected="true" tabindex="0" aria-label="${esc(label)}. Selected. Left and right arrows move along the shelf.">
        <div class="cover-back" aria-hidden="true"></div>
        <div class="cover" aria-hidden="true">${genCover(r, { fs: phone ? undefined : undefined })}${img}</div>
        ${best && !phone ? '<span class="bestmatch">Best match</span>' : ''}</div>`;
}
function cassetteHtml(r, phone, best, label) {
    const t = r.title || '', len = t.length;
    const by = String(r.author || '').split(/[,&;]/)[0] + (r.narrator ? ' · read by ' + String(r.narrator).split(/,| and /)[0] : '');
    const srcFmt = srcShort(r.source) + (r.format ? ' · ' + String(r.format).toUpperCase() : '');
    const reels = '<div class="reels"><i></i><i></i></div>';
    const label2 = r.coverUrl
        ? `<img src="${coverSrc(r)}" alt="" class="tart" onerror="this.closest('.tlabel').classList.add('noart');this.remove()"><span class="tsrc">${esc(srcFmt)}</span><span class="tttl" style="font-size:${len <= 6 ? 34 : len <= 14 ? 22 : 17}px">${esc(t)}</span><span class="tby">${esc(by)}</span>${reels}`
        : `<span class="tsrc">${esc(srcFmt)}</span><span class="tttl" style="font-size:${len <= 6 ? 46 : len <= 14 ? 36 : 28}px">${esc(t)}</span><span class="tby">${esc(by)}</span>${reels}`;
    return `<div class="pulled cass${phone ? ' ph' : ''}" data-swipe role="option" aria-selected="true" tabindex="0" aria-label="${esc(label)}. Selected. Left and right arrows move along the shelf.">
        <div class="cover-back" aria-hidden="true"></div>
        <div class="cover cassette-body" aria-hidden="true">
            <div class="tlabel${r.coverUrl ? '' : ' noart'}">${label2}</div>
            <div class="twin"></div><i class="th l"></i><i class="th r"></i><i class="sc a"></i><i class="sc b"></i><i class="sc c"></i><i class="sc d"></i>
        </div>
        ${best ? '<span class="bestmatch">Best match</span>' : ''}</div>`;
}

function shelfView(list, r, phone) {
    const pages = Math.max(1, Math.ceil(list.length / PER_SHELF));
    const idx = list.indexOf(r);
    S.page = Math.max(0, Math.floor(idx / PER_SHELF));
    const items = list.slice(S.page * PER_SHELF, S.page * PER_SHELF + PER_SHELF);
    const audio = S.mode === 'audiobooks';
    if (phone) {
        // Phone: the pulled-out book in the middle, its neighbours either side.
        const left = list.slice(Math.max(0, idx - 6), idx).map(x => spineHtml(x, true)).join('');
        const right = list.slice(idx + 1, idx + 7).map(x => spineHtml(x, true)).join('');
        return `<section class="pshelf${audio ? ' audio' : ''}" aria-label="Shelf of results">
            <div class="pside l" role="listbox" aria-label="Earlier results">${left}</div>
            ${coverHtml(r, true)}
            <div class="pside r" role="listbox" aria-label="Later results">${right}</div>
            <div class="pboard" aria-hidden="true"></div></section>`;
    }
    // Shelf order: the pulled-out book sits in its own place, so the best match is first and the rest follow.
    const spines = items.map(x => x === r ? coverHtml(r, false) : spineHtml(x, false));
    const from = S.page * PER_SHELF + 1, to = Math.min(list.length, from + PER_SHELF - 1);
    return `<section class="shelf${audio ? ' audio' : ''}" aria-label="${audio ? 'Shelf of cassettes' : 'Shelf of results'}">
        <div class="shelf-scroll"><div class="shelf-row" role="listbox" aria-label="Results on this shelf" aria-activedescendant="">${spines.join('')}</div>
        <div class="board" aria-hidden="true"></div></div>
        <div class="pager"><button type="button" class="pgbtn" aria-label="Previous book" title="Previous book (←)" data-act="step" data-v="-1"${idx > 0 ? '' : ' disabled'}>←</button>
        <span>Shelf ${S.page + 1} of ${pages} · ${to} of ${list.length}</span>
        <button type="button" class="pgbtn" aria-label="Next book" title="Next book (→)" data-act="step" data-v="1"${idx < list.length - 1 ? '' : ' disabled'}>→</button></div></section>`;
}

// ── Selected result card ─────────────────────────────────────────────────────
function metaLine(r) {
    const audio = S.mode === 'audiobooks';
    // Language only when it is not English, the usual case.
    const lang = r.language && !/^(en|eng|english)\b/i.test(r.language) ? String(r.language) : '';
    const bits = [r.author, r.series, r.year, audio && r.narrator ? 'read by ' + r.narrator : '', !audio && parseInt(r.pages) > 0 ? parseInt(r.pages) + ' pages' : '', lang].filter(Boolean);
    return bits.join(' · ');
}
function linkPill(r, small) {
    const lt = LINK[r.linkType] || LINK.page;
    return `<span class="pill${small ? ' sm' : ''}" style="background:${lt.bg}"><span class="d" style="background:${lt.dot}"></span>${esc(lt.text)}</span>`;
}
function ctaState(r) {
    const d = S.dl[r.id];
    if (d) {
        if (d.state === 'queued' || d.state === 'waiting') return { text: d.wait === 'slot' ? 'Waiting for a free slot' : d.wait === 'vpn' ? 'Waiting for the VPN tunnel' : 'Queued on the server', cls: 'st-queued' };
        if (d.state === 'downloading') { const p = Math.round((d.progress || 0) * 100); return { text: `Downloading · ${p}%`, cls: 'st-dl', style: `background:linear-gradient(90deg,#5EEAB4 ${p}%,#D9D4FF ${p}%)` }; }
        if (d.state === 'renaming') return { text: 'Renaming and filing…', cls: 'st-ren' };
        if (d.state === 'done' && d.shelfId) return app.settings && app.settings.saving.allow ? { text: d.saved ? 'Saved to this device ✓' : 'Save to this device', cls: 'st-save', act: 'save' } : { text: 'On the shelf ✓', cls: 'st-on', act: 'goshelf' };
        if (d.state === 'done') return { text: 'Already on your shelf', cls: 'st-on', act: 'goshelf' };
        if (d.state === 'failed') return { text: 'Try again', cls: 'st-fail', act: 'retry', note: d.error };
    }
    if (r.onShelf) return { text: 'On the shelf ✓', cls: 'st-on', act: 'goshelf' };
    if (r.linkType === 'page') return { text: 'Open the source page', cls: 'st-page', act: 'open' };
    return { text: 'Download to server', cls: '', act: 'dl' };
}
function ctaBtn(r, cls) {
    const c = ctaState(r);
    return `<button type="button" class="${cls} ${c.cls}" data-act="${c.act || ''}" data-id="${esc(r.id)}"${c.act ? '' : ' aria-disabled="true"'}${c.style ? ` style="${c.style}"` : ''} aria-live="polite">${esc(c.text)}</button>`;
}
function card(r, list, phone) {
    if (!r) return '';
    const audio = S.mode === 'audiobooks', best = r.id === bestId();
    const page = r.pageUrl || r.downloadUrl || r.detailUrl || r.topicUrl;
    const t = r.title || 'Untitled';
    const tsize = phone ? (t.length > 40 ? 30 : t.length > 22 ? 36 : 46) : (t.length > 48 ? 44 : t.length > 28 ? 56 : 76);
    const magnetBtns = r.linkType === 'magnet' ? `<div class="rc-mag"><button type="button" class="btn outline-ink" data-act="magnet" data-id="${esc(r.id)}">Magnet link</button><button type="button" class="btn outline-ink" data-act="torrent" data-id="${esc(r.id)}">Torrent file</button></div>` : '';
    const openBtn = page && r.linkType !== 'page' ? `<a class="iconbtn ink" href="${esc(page)}" target="_blank" rel="noopener noreferrer" aria-label="Open the source page" title="Open the source page">${icon('ext', phone ? 22 : 26, 2)}</a>` : '';
    const fail = S.dl[r.id] && S.dl[r.id].state === 'failed' ? `<span class="rc-err">${esc(S.dl[r.id].error || 'The download failed')}</span>` : '';
    const chips = audio ? [r.length, r.abridged === true ? 'abridged' : r.abridged === false ? 'unabridged' : '', r.bitrate].filter(Boolean) : [];
    if (phone) {
        const idx = list.indexOf(r), n = list.length;
        const dots = Array.from({ length: Math.min(7, n) }, (_, k) => { const start = Math.max(0, Math.min(n - 7, idx - 3)); return `<i class="${start + k === idx ? 'on' : ''}"></i>`; }).join('');
        return `<section class="rcard ph" aria-label="Selected result" data-swipe>
            <div class="rc-dots" aria-hidden="true">${dots}</div>
            <div class="rc-top"><span class="rc-tag">From ${esc(srcName(r.source))}${best ? ' · best match' : ''}</span>
              <span class="rc-nav"><button type="button" aria-label="Previous result" data-act="step" data-v="-1"${idx ? '' : ' disabled'}>${icon('left', 16, 3)}</button><button type="button" aria-label="Next result" data-act="step" data-v="1"${idx < n - 1 ? '' : ' disabled'}>${icon('right', 16, 3)}</button></span></div>
            <h2 class="rc-title" style="font-size:${tsize}px">${esc(t)}</h2>
            <span class="rc-meta">${esc(metaLine(r))}</span>
            <div class="rc-chips">${r.format || r.filesize ? `<span class="pchip">${esc(String(r.format || '').toUpperCase())}${r.format && r.filesize ? ' · ' : ''}${r.filesize ? size(r.filesize) : ''}</span>` : ''}${chips.map(c => `<span class="pchip">${esc(c)}</span>`).join('')}${linkPill(r, true)}</div>
            <span class="rc-file">Filed on the server as ${privPath(fileAsShown(r))}</span>
            ${fail}
            <div class="rc-cta">${ctaBtn(r, 'cta')}${openBtn}</div>
            ${magnetBtns}</section>`;
    }
    return `<section class="rcard" aria-label="Selected result">
        <div class="rc-l">
            <span class="rc-tag">${best ? 'Selected · best match' : 'Selected result'}</span>
            <h2 class="rc-title" style="font-size:${tsize}px">${esc(t)}</h2>
            <span class="rc-meta">${esc(metaLine(r))}</span>
            ${chips.length ? `<div class="rc-chips">${chips.map(c => `<span class="pchip">${esc(c)}</span>`).join('')}</div>` : ''}
            <div class="found"><span class="fo"><span class="label">Found on</span><b>${esc(srcName(r.source))}</b></span>
                <span class="ffmt">${esc(String(r.format || '?').toUpperCase())}</span><span class="fsz">${esc(size(r.filesize) || 'size unknown')}</span>${linkPill(r)}</div>
        </div>
        <div class="rc-r">
            <div class="fileas"><span class="label">The server will file it as</span><span>${privPath(fileAsShown(r))}</span></div>
            ${fail}
            <div class="rc-cta">${ctaBtn(r, 'cta')}${openBtn}</div>
            ${magnetBtns}
        </div></section>`;
}

// ── List view ────────────────────────────────────────────────────────────────
function thumb(r, phone) {
    const audio = S.mode === 'audiobooks';
    const img = r.coverUrl ? `<img src="${coverSrc(r)}" alt="" loading="lazy" onerror="this.remove()">` : '';
    return `<div class="thumb${audio ? ' sq' : ''}${phone ? ' ph' : ''}" role="img" aria-label="Cover of ${esc(r.title)}">${genCover(r, { fs: audio ? (phone ? 10 : 12) : phone ? 8 : 9, small: true })}${img}</div>`;
}
function rowButtons(r, phone) {
    const c = ctaState(r);
    const page = r.pageUrl || r.downloadUrl || r.detailUrl || r.topicUrl;
    const open = page && c.act !== 'open' ? `<a class="iconbtn outline" href="${esc(page)}" target="_blank" rel="noopener noreferrer" aria-label="Open the source page for ${esc(r.title)}" style="${phone ? 'width:48px;height:48px' : ''}">${icon('ext', 18, 2)}</a>` : '';
    let main;
    if (c.act === 'goshelf') main = `<a class="lbtn on" href="/shelf">On the shelf ✓</a>`;
    else if (c.act === 'open') main = `<a class="lbtn outline" href="${esc(page || '#')}" target="_blank" rel="noopener noreferrer">Open page</a>`;
    else main = `<button type="button" class="lbtn ${c.cls}" data-act="${c.act || ''}" data-id="${esc(r.id)}"${c.style ? ` style="${c.style}"` : ''}>${esc(c.text)}</button>`;
    const mag = r.linkType === 'magnet' ? `<span class="lmag"><button type="button" data-act="magnet" data-id="${esc(r.id)}">Magnet link</button><button type="button" data-act="torrent" data-id="${esc(r.id)}">Torrent file</button></span>` : '';
    return { main, open, mag };
}
function listView(list, phone) {
    const audio = S.mode === 'audiobooks', best = bestId();
    // A page of 50, with "Show more", so long result lists stay quick and short.
    const shown = S.listN || 50;
    const rows = list.slice(0, shown).map(r => {
        const lt = LINK[r.linkType] || LINK.page;
        const pill = `<span class="pill${phone ? ' sm' : ''}" style="background:${lt.dbg};color:${lt.dfg}"><span class="d" style="background:${lt.ring}"></span>${esc(lt.short || lt.text)}</span>`;
        const fmt = esc(String(r.format || '?').toUpperCase());
        const meta = esc(metaLine(r));
        const bm = r.id === best ? '<span class="bm">Best match</span>' : '';
        const b = rowButtons(r, phone);
        const cls = `lrow${r.id === best ? ' best' : ''}${r.onShelf ? ' onshelf' : ''}`;
        const onshelf = r.onShelf && r.fileAs ? `<span class="lpath">On the shelf · ${privPath(fileAsShown(r))}</span>` : '';
        if (phone) return `<article class="${cls} ph" data-row>
            <div class="lph-top">${thumb(r, true)}<div class="lbook"><b>${esc(r.title)}</b><span>${meta}</span>${bm}${onshelf}</div></div>
            <div class="lph-meta"><span class="lfmt">${fmt}</span><span class="lsz">${esc([size(r.filesize), r.length].filter(Boolean).join(' · '))}</span><span class="lsrc">${esc(srcName(r.source))}</span>${pill}</div>
            <div class="lph-btns">${b.main}${b.open}</div>${b.mag ? `<div class="lph-mag">${b.mag}</div>` : ''}</article>`;
        return `<article class="${cls}" data-row>
            ${thumb(r, false)}
            <div class="lbook"><b>${esc(r.title)}${bm}</b><span>${meta}</span>${onshelf}</div>
            <span class="lfmt">${fmt}</span><span class="lsz">${esc(size(r.filesize) || '?')}</span>
            ${audio ? `<span class="llen">${esc(r.length || '')}</span>` : ''}
            <span class="lsrc">${esc(srcName(r.source))}</span><span class="llink">${pill}</span>
            <span class="lact">${audio ? `<span class="lact-top">${b.main}${b.open}</span>${b.mag}` : b.main + b.open}</span></article>`;
    }).join('');
    const head = phone ? '' : `<div class="lhead" aria-hidden="true"><span class="c-th"></span><span class="c-book">${audio ? 'Listen' : 'Book'}</span><span class="c-fmt">Format</span><span class="c-sz">Size</span>${audio ? '<span class="c-len">Length</span>' : ''}<span class="c-src">From</span><span class="c-link">Link</span><span class="c-act"></span></div>`;
    return `<section class="list${audio ? ' audio' : ''}" aria-label="Results">${head}${rows}${list.length > shown ? `<div class="lmore"><span class="desc">${shown} of ${list.length}</span><button type="button" class="btn outline sm" data-act="listmore">Show ${Math.min(50, list.length - shown)} more</button></div>` : ''}</section>`;
}
function stackRows(page, delay = 0) {
    let n = 0;
    $$('[data-row]', page).forEach(el => anim(el, [{ opacity: 0, transform: 'translateY(-22px)' }, { opacity: 1, transform: 'none' }], { duration: 460, delay: delay + Math.min(n++, 12) * 85, fill: 'backwards' }));
}

// ── More places ──────────────────────────────────────────────────────────────
const PILL_COLOURS = ['#FFB4A2', '#8FD0FF', '#B7A4FF', '#5EEAB4', '#FFD54A', '#FF9FE8', '#FFC070', '#A8F0FF'];
// When SLUM says a link's mirror is worse than another of the same library, point the link at the better one.
const RANK = { up: 0, degraded: 1, protected: 2, unknown: 2.5, down: 3 };
function bestMirror(url) {
    const m = app.status && app.status.mirrors;
    if (!m || !m.on) return url;
    let host; try { host = new URL(url.replace('{q}', 'x')).host; } catch (e) { return url; }
    for (const list of Object.values(m.groups || {})) {
        const here = list.find(d => d.host === host);
        if (!here) continue;
        const best = list.slice().sort((a, b) => RANK[a.status] - RANK[b.status])[0];
        return best && RANK[best.status] < RANK[here.status] ? url.replace('//' + host, '//' + best.host) : url;
    }
    return url;
}
function moreLinks(phone) {
    const links = (app.settings && app.settings.justLinks[S.mode]) || [];
    if (!links.length) return '';
    const q = encodeURIComponent(S.q);
    return `<section class="more" aria-label="More places to look">
        <div class="more-h"><h2>Still hungry? Try these too</h2></div>
        <div class="linkpills">${links.map((l, i) => `<a class="linkpill" href="${esc(bestMirror(l.url).split('{q}').join(q))}" target="_blank" rel="noopener noreferrer" style="background:${PILL_COLOURS[i % 8]}">${esc(l.name)}${icon('ext', 17, 2)}</a>`).join('')}</div></section>`;
}

// ── Interaction ──────────────────────────────────────────────────────────────
function select(id, sound = true) {
    if (id === S.sel) return;
    S.sel = S.picked = id;
    if (sound) sfx(S.mode === 'audiobooks' ? 'tape' : 'book');
    const list = filtered();
    drawn.bd = body(list, current(list), view(), isPhone());
    $('#rbody').innerHTML = drawn.bd;
    const r = list.find(x => x.id === id);
    if (r) applyPalette(r);
    anim($('.pulled .cover'), [{ opacity: 0.15, transform: 'translateY(40px) rotate(-1deg) scale(0.94)' }, { opacity: 1, transform: 'rotate(-4deg)' }], { duration: 480 });
    $$('.rcard > *').forEach((el, n) => anim(el, [{ opacity: 0.2, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: n * 30 }));
}

function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const act = t.dataset.act, id = t.dataset.id;
    switch (act) {
        case 'mode': {
            if (S.mode === t.dataset.v) return;
            S.mode = t.dataset.v;
            $$('[data-act="mode"]').forEach(b => b.setAttribute('aria-checked', b.dataset.v === S.mode));
            $$('#adv [data-fmt]').forEach(g => { g.hidden = g.dataset.fmt !== S.mode; });
            // On the results page the switch is live: search again in the other kind, without the formats of the
            // kind just left (an ebook format would filter out every audiobook).
            if (location.pathname === '/results' && S.q) searchAgain(S.q, S.adv && { ...S.adv, formats: S.adv.formats.filter(f => FORMATS[S.mode].includes(f)) });
            return;
        }
        case 'adv': return toggleAdv();
        case 'chip': {
            const group = t.parentElement, any = t.hasAttribute('data-any');
            if (any) { $$('[data-act="chip"]', group).forEach(c => c.setAttribute('aria-pressed', c === t)); return; }
            t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') !== 'true');
            const picked = $$('[data-v][aria-pressed="true"]', group).length;
            $('[data-any]', group).setAttribute('aria-pressed', !picked);
            return;
        }
        case 'adv-clear':
            $$('#adv input').forEach(i => { i.value = ''; });
            $('#a-lang').selectedIndex = 0;
            $$('#adv [data-act="chip"]').forEach(c => c.setAttribute('aria-pressed', c.hasAttribute('data-any')));
            return;
        case 'adv-go': {
            const a = readAdv();
            const input = $('#q') || $('#rq');
            // An ISBN names one edition and libraries match it only on its own, so it is searched alone.
            const isbn = a.isbn.replace(/[\s-]/g, '');
            if (isbn) Object.assign(a, { isbn, title: '', author: '' });
            const words = isbn || [a.title, a.author].filter(Boolean).join(' ') || input.value.trim();
            if (!words) { $('#a-title').focus(); return; }
            input.value = words;
            toggleAdv(false);
            // From Discover it plays the full animation; from the results page it searches in place.
            return $('#q') ? startSearch(words, a, true) : searchAgain(words, a);
        }
        case 'view': {
            S.view = t.dataset.v; prefs.view = S.view;
            renderResults();
            if (S.view === 'list') stackRows($('#results'));
            const again = $(`[data-act="view"][data-v="${S.view}"]`); if (again) again.focus({ preventScroll: true });
            return;
        }
        case 'filter': S.f[t.dataset.k] = t.dataset.v; S.sel = ''; S.page = 0; return refreshResults();
        case 'clear-filters': S.f = { ...S.f, fmt: 'all', link: 'any', len: 'any', narrator: '' }; return refreshResults();
        case 'page': {
            const list = filtered();
            const p = Math.max(0, Math.min(Math.ceil(list.length / PER_SHELF) - 1, S.page + Number(t.dataset.v)));
            const r = list[p * PER_SHELF];
            if (r) select(r.id, false);
            return;
        }
        case 'step': return step(Number(t.dataset.v));
        case 'listmore': S.listN = (S.listN || 50) + 50; return refreshResults();
        case 'pick': return select(id);
        case 'dl': return download(id);
        case 'retry': return retry(id);
        case 'save': { const d = S.dl[id]; if (d && d.shelfId) { saveToDevice(d.shelfId); d.saved = true; redrawCta(id); } return; }
        case 'goshelf': return go('/shelf');
        case 'open': { const r = S.results.find(x => x.id === id); const u = r && (r.pageUrl || r.downloadUrl || r.detailUrl || r.topicUrl); if (u) window.open(u, '_blank', 'noopener,noreferrer'); return; }
        case 'magnet': return (async () => {
            const r = S.results.find(x => x.id === id);
            // AudiobookBay magnets are fetched on first use.
            if (r && !r.magnet) { const x = await api('/resolve?id=' + encodeURIComponent(id)).catch(() => ({})); if (x.magnet) r.magnet = x.magnet; }
            if (r && r.magnet) copy(r.magnet, 'Magnet link copied'); else toast('No magnet link for this one yet');
        })();
        case 'torrent': return torrent(id);
    }
}
function onChange(e) {
    const t = e.target.closest('[data-act="sort"], [data-act="narrator"]');
    if (!t) return;
    S.f[t.dataset.act] = t.value; S.sel = ''; S.page = 0;
    refreshResults();
    const again = $(`[data-act="${t.dataset.act}"]`); if (again) again.focus();
}
// Left and right move along the shelf from anywhere on the results page, unless typing or a panel is open.
function onDocKey(e) {
    if (location.pathname !== '/results' || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
    const t = e.target;
    if (t && (t.closest('input, textarea, select, [contenteditable], .menu, .adv, dialog') || t.isContentEditable)) return;
    if (($('#adv') && !$('#adv').hidden) || view() === 'list' || !S.results.length) return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
}
function onKey(e) {
    // The shelf is one tab stop; the arrow keys move between books.
    const sp = e.target.closest('.spine, .tape, .pulled');
    if (sp && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault();
        const l = filtered(); const t = e.key === 'Home' ? l[0] : l[l.length - 1]; if (t) select(t.id);
        const c = $('.pulled'); if (c) c.focus({ preventScroll: true });
    }
    if (e.key === 'Escape' && $('#adv') && !$('#adv').hidden) { toggleAdv(false); $('.advbtn') && $('.advbtn').focus(); }
    // The phone sheet covers the screen, so Tab goes round inside it.
    if (isPhone() && $('#adv') && !$('#adv').hidden) trapTab(e, $('#adv'));
    if (e.key === 'Enter' && e.target.id === 'q') { e.preventDefault(); $('#dform').requestSubmit(); }
}
function step(d) {
    const list = filtered(), i = list.findIndex(x => x.id === S.sel);
    const n = list[Math.max(0, Math.min(list.length - 1, i + d))];
    // Keep keyboard focus where it was (the arrow button that was used, or the shelf), which the redraw would
    // otherwise drop.
    const a = document.activeElement, kept = a && a.matches('[data-act="step"]') ? `[data-act="step"][data-v="${a.dataset.v}"]` : a && a.closest('.spine, .tape, .pulled') ? '.pulled' : '';
    if (n) select(n.id);
    // At either end the arrow button turns disabled and cannot hold focus, so it goes to the book instead.
    if (kept) { const b = $(kept), c = $('.pulled'); if (b && !b.disabled) b.focus({ preventScroll: true }); else if (c) c.focus({ preventScroll: true }); }
}
// Phone: swipe the cover or the card sideways for the next or previous result.
let swipe = null;
function onPointerDown(e) { if (e.target.closest('[data-swipe]') && !e.target.closest('button, a')) swipe = { x: e.clientX, y: e.clientY }; }
function onPointerUp(e) {
    if (!swipe) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3) step(dx < 0 ? 1 : -1);
}

// ── "On the shelf" marks ─────────────────────────────────────────────────────
// The marks come with the search, so a delete (here or on the Shelf page) would leave them behind. One read
// of the shelf, at most once in a while, sets them again by the key the server uses (kind, title, author).
const shelfKey = (kind, title, author) => [kind, title, author].map(x => tidyName(x).toLowerCase()).join('|');
let shelfTimer = null;
function syncShelf() {
    clearTimeout(shelfTimer);
    shelfTimer = setTimeout(async () => {
        const seq = S.seq;
        const shelf = S.results.length && location.pathname === '/results' ? await api('/api/shelf').catch(() => null) : null;
        if (!shelf || seq !== S.seq) return;
        const keys = new Set(shelf.items.filter(i => !i.removedAt && !i.moved).map(i => shelfKey(i.kind, i.title, i.author)));
        let changed = false;
        for (const r of S.results) {
            const on = keys.has(shelfKey(r.kind, r.title, r.author));
            if (!r.kind || on === !!r.onShelf) continue;
            r.onShelf = on; changed = true;
            if (S.patches[r.id]) S.patches[r.id].onShelf = on;
            // A download that finished and was then deleted is back to "Download to server".
            if (!on && S.dl[r.id] && S.dl[r.id].state === 'done') delete S.dl[r.id];
        }
        if (changed) refreshSoon();
    }, 400);
}

// ── Downloads in place ───────────────────────────────────────────────────────
async function download(id) {
    const r = S.results.find(x => x.id === id);
    if (!r) return;
    S.dl[id] = { state: 'queued', progress: 0, title: r.title };
    redrawCta(id);
    toast(`“${r.title}” is on its way to the server.`, { action: { label: 'View on Shelf', href: '/shelf' }, ms: 0, id: 'dl-' + id });
    try {
        const job = await api('/api/downloads', { body: { resultId: id, clientId } });
        // Live events may have moved the job on already; the reply only sets the state while it is still unset or queued.
        const d = S.dl[id] || {};
        S.dl[id] = { ...d, jobId: job.id, state: !d.state || d.state === 'queued' ? job.state : d.state, ...(job.shelfId ? { shelfId: job.shelfId } : {}) };
        // Someone already had it on the server (public instances): it is on this visitor's shelf straight away.
        if (job.shelfId) { hideToast('dl-' + id); toast(`“${r.title}” was already on the server, so it is on your shelf now.`, { action: { label: 'View on Shelf', href: '/shelf' } }); }
        redrawCta(id);
    } catch (e) {
        S.dl[id] = { state: 'failed', error: e.message, title: r.title };
        hideToast('dl-' + id);
        toast(e.message);
        redrawCta(id);
    }
}
async function retry(id) {
    const d = S.dl[id];
    if (d && d.jobId) { try { await api(`/api/jobs/${d.jobId}/retry`, { method: 'POST' }); d.state = 'queued'; d.error = ''; redrawCta(id); } catch (e) { toast(e.message); } }
    else download(id);
}
async function torrent(id) {
    const res = await api('/torrent?id=' + encodeURIComponent(id), { raw: true });
    if (!res.ok) { const j = await res.json().catch(() => ({})); toast(j.error || 'No torrent file was found. Use the magnet link instead.', { ms: 6000 }); return; }
    const blob = await res.blob();
    const name = (/filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '') || [])[1] || 'download.torrent';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function syncJobs(jobs) {
    for (const j of jobs || []) {
        if (!j.resultId) continue;
        const d = S.dl[j.resultId] || (S.dl[j.resultId] = { title: j.title });
        const before = d.state + '|' + Math.round((d.progress || 0) * 20);
        Object.assign(d, { jobId: j.id, state: j.state, progress: j.progress, wait: j.wait, error: j.error });
        if (before !== d.state + '|' + Math.round((d.progress || 0) * 20)) redrawCta(j.resultId);
    }
}
function jobDone(ev) {
    if (!ev.resultId) return;
    const d = S.dl[ev.resultId];
    if (!d) return;
    Object.assign(d, { state: 'done', shelfId: ev.shelfId, saved: !!ev.autoSave && ev.clientId === clientId });
    const r = S.results.find(x => x.id === ev.resultId);
    if (r && ev.shelfId) r.onShelf = true;
    redrawCta(ev.resultId);
}
function jobFailed(job) {
    if (!job || !job.resultId || !S.dl[job.resultId]) return;
    Object.assign(S.dl[job.resultId], { state: 'failed', error: job.error });
    redrawCta(job.resultId);
}
// Only the button for that result changes, so nothing else jumps around.
function redrawCta(id) {
    if (location.pathname !== '/results') return;
    const r = S.results.find(x => x.id === id);
    if (!r) return;
    drawn.bd = null; // the next full refresh redraws the body, whatever it matched before
    $$(`[data-id="${CSS.escape(id)}"].cta, [data-id="${CSS.escape(id)}"].lbtn`).forEach(b => {
        const tmp = document.createElement('div');
        tmp.innerHTML = b.classList.contains('cta') ? ctaBtn(r, 'cta') : rowButtons(r, isPhone()).main;
        const n = tmp.firstElementChild;
        if (n.tagName !== b.tagName) return b.replaceWith(n);
        // Same kind of element: change it in place, so keyboard focus and the polite announcement stay with it.
        for (const a of [...b.attributes]) if (!n.hasAttribute(a.name)) b.removeAttribute(a.name);
        for (const a of n.attributes) b.setAttribute(a.name, a.value);
        b.textContent = n.textContent;
    });
    const err = $('.rcard .rc-err');
    const d = S.dl[id];
    if (S.sel === id && d && d.state === 'failed' && !err) refreshResults();
}
