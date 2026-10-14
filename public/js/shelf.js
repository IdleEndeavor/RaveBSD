// The Shelf page: what is downloading to the server, what is on it, saving to this device, and Stats.
import { $, $$, esc, api, icon, size, when, plural, toast, copy, saveToDevice, showMenu, closeMenu, confirmBox, anim, prefs,
    paletteFor, genCover, isPhone, priv, privPath, patchHtml } from './ui.js';
import { app, bus, go, isAdmin, drawNav } from './app.js';
import { applyTemplate, singleFileAudiobook } from './rename.js';

let root, data = null, lowDrawn = false, picked = new Set(), selecting = false, qb = null, statsPeriod = 'all', onBus = [];

export async function mount(el, { path }) {
    root = el;
    const listen = (t, fn) => { bus.addEventListener(t, fn); onBus.push([t, fn]); };
    root.addEventListener('click', onClick);
    if (path === '/shelf/stats') { if (isAdmin()) return renderStats(); history.replaceState(null, '', '/shelf'); drawNav('/shelf'); }
    listen('jobs', e => { if (data) { data.jobs = e.detail.jobs; drawJobs(); } });
    listen('shelf', () => load());
    listen('failed', () => load());
    // The low-space flag comes with the status; when it flips, the free-space figure is read again too.
    listen('status', () => { if (!!(app.status && app.status.lowSpace) !== lowDrawn) load(); else drawBanners(); });
    listen('settings', () => drawBanners());
    root.innerHTML = frame('books', `<div id="banners"></div></section>
        <section aria-label="On the shelf" class="sset" id="items"></section>
        <div class="shelf-grid"><section class="dlcol" aria-label="Downloading to the server" id="jobs"></section>${isAdmin() ? '<aside class="side" aria-label="Server setup at a glance" id="side"></aside>' : ''}</div>`);
    await load();
    if (isAdmin() && app.settings.qbit.enabled) api('/api/qbit/test', { body: {} }).then(r => { qb = r; drawSide(); }).catch(() => { qb = { ok: false }; drawSide(); });
}
export function unmount() { for (const [t, fn] of onBus) bus.removeEventListener(t, fn); onBus = []; selecting = false; picked.clear(); closeMenu(); }
export function relayout() { if (data) drawAll(); }

// Admins delete anything; family users what they added; visitors let go of their own copy (shared books stay
// for whoever else holds them).
const visitor = () => app.session && app.session.role === 'visitor';
const canDelete = r => isAdmin() || visitor() || !!(r.addedBy && r.addedBy.name && r.addedBy.name === app.session.username);
function frame(tab, inner) {
    const auto = app.settings.saving.auto && app.settings.saving.allow;
    return `<main class="page"><section class="shelf-top">
        <header class="ptitle">${isPhone() ? '<img src="/img/crystal-mark.png" alt="RaveBSD">' : ''}<h1 class="h-page">Your <span class="serif" style="color:#2EE6F6">shelf</span></h1></header>
        ${isAdmin() ? `<nav class="seg" aria-label="Shelf views"><a href="/shelf"${tab === 'books' ? ' aria-current="page"' : ''}>Books</a><a href="/shelf/stats"${tab === 'stats' ? ' aria-current="page"' : ''}>Stats</a></nav>` : ''}
        ${tab === 'books' && !isPhone() ? `<ol class="how" aria-label="How it works">
            <li class="step"><i style="background:#FFD54A">1</i>Downloaded to the server</li><li class="sep" aria-hidden="true">›</li>
            <li class="step"><i style="background:#FF9FE8">2</i>Renamed and filed for you</li><li class="sep" aria-hidden="true">›</li>
            <li class="step"><i style="background:#5EEAB4">3</i>Saved to this device${auto ? ', by itself for eBooks' : ''}</li></ol>` : ''}
        ${inner}</main>`;
}

async function load() {
    try { data = await api('/api/shelf'); } catch (e) { return; }
    drawAll();
}
function drawAll() { drawBanners(); drawJobs(); drawSide(); drawItems(); }

function drawBanners() {
    const el = $('#banners'); if (!el || !data) return;
    const s = app.settings, st = app.status || {};
    lowDrawn = !!st.lowSpace;
    let out = '';
    if (st.vpn && st.vpn.enabled && s.vpn.tellOnDrop && st.vpn.up === false) out += `<div class="banner coral" role="alert"><span class="grow">The VPN tunnel is down${st.vpn.blocking ? ', so searching and downloading are paused until it is back' : ''}. <span style="font-weight:500;color:var(--text2)">${esc(st.vpn.error || '')}</span></span><a class="btn outline sm" href="/admin#vpn">VPN settings</a></div>`;
    if (st.lowSpace && data.space) {
        const free = Math.min(data.space.ebook.free || Infinity, data.space.audiobook.free || Infinity);
        out += `<div class="banner coral"><span class="grow">Space is running low: ${size(free)} free. <span style="font-weight:500;color:var(--text2)">Delete books you have saved elsewhere, or raise the limit in the admin panel.</span></span><a class="btn outline sm" href="/admin#storage">Storage settings</a></div>`;
    }
    if (data.mine) {
        const m = data.mine, pct = Math.min(100, Math.round(m.used / m.quota * 100));
        out += `<div class="banner mint"><span class="grow">You are using ${size(m.used) || '0 MB'} of ${size(m.quota)} on this server. <span style="font-weight:500;color:var(--text2)">Books you fetch stay for ${m.keepDays} day${m.keepDays === 1 ? '' : 's'}, so save them to your device.</span></span><span class="track sm" style="flex:0 0 120px" role="progressbar" aria-label="Space used" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span class="live" style="width:${Math.max(2, pct)}%;background:#5EEAB4"></span></span></div>`;
    }
    if (s.saving.auto && s.saving.allow) out += `<div class="banner mint"><span aria-hidden="true" style="flex:none;width:32px;height:32px;border-radius:50%;background:#5EEAB4;color:#14123A;display:flex;align-items:center;justify-content:center">${icon('check', 16, 3.2)}</span><span class="grow">Auto-save is on. eBooks come to this device as soon as the server has filed them. <span style="font-weight:500;color:var(--text2)">Audiobooks always wait for you below.</span></span>${isAdmin() ? '<a class="btn outline sm" href="/admin#saving" style="border-width:1px;font-weight:600">Auto-save settings</a>' : ''}</div>`;
    patchHtml(el, out);
    el.style.display = out ? 'flex' : 'none';
    el.style.flexDirection = 'column'; el.style.gap = '12px';
}

// ── Downloading ──────────────────────────────────────────────────────────────
const fmtChip = j => `<span class="chip">${esc(String(j.format || '?').toUpperCase())}${j.total || j.size ? ' · ' + size(j.total || j.size) : ''}</span>`;
function srcChip(j) {
    if (j.how === 'qbit') return `<span class="chip" style="background:rgba(215,143,224,0.25);color:#F0C6F6">qBittorrent · ${esc(j.source)}</span>`;
    return `<span class="chip" style="background:rgba(94,234,180,0.22);color:#A6F7D8">direct · ${esc(j.source)}</span>`;
}
function steps(j) {
    const at = j.state === 'renaming' ? 1 : 0;
    const ring = (i, label) => {
        const cls = i < at ? 'done' : i === at ? 'now' : 'todo';
        return `<li class="${cls === 'todo' ? 'todo' : ''}"><span class="ring ${cls}">${cls === 'done' ? icon('check', 14, 3.4) : ''}</span>${label}</li>`;
    };
    return `<ol class="steps" aria-label="Steps">${ring(0, 'Download')}<li class="line ${at > 0 ? 'done' : ''}" aria-hidden="true"></li>${ring(1, 'Rename')}<li class="line" aria-hidden="true"></li>${ring(2, 'On the shelf')}</ol>`;
}
const fileAsFor = j => {
    const s = app.settings.shelves, dir = (j.kind === 'audiobook' ? s.audioDir : s.ebookDir) || '';
    const b = { author: j.author, title: j.title, year: j.year, series: j.series, narrator: j.narrator, ext: j.format };
    return (dir ? dir.replace(/\/+$/, '') + '/' : '') + (j.kind === 'audiobook' ? singleFileAudiobook(s.audioTemplate, b).replace(/\.[^.]*$/, '/') : applyTemplate(s.ebookTemplate, b, { tidy: s.tidy }));
};
// Phone: a compact card with a one-line status and the steps as words.
function phoneJob(j, x, cover) {
    const p = Math.round((j.progress || 0) * 100);
    const fmt = String(j.format || '').toUpperCase();
    if (j.state === 'queued') return `<article class="job waiting ph"><div class="job-t"><b>${esc(j.title)}</b><span class="jl1">${esc(fmt)} · ${j.wait === 'slot' ? 'waiting for a free slot' : j.wait === 'vpn' ? 'waiting for the VPN tunnel' : 'queued on the server'}</span></div>${x}</article>`;
    const ren = j.state === 'renaming';
    const line = ren ? `${fmt} · renaming now` : j.how === 'qbit' ? `${fmt} · ${size(j.speed) || '0 KB'}/s · ${p}%` : `${fmt} · ${j.total ? p + '% of ' + size(j.total) : size(j.bytes) || 'starting'}`;
    const crumbs = `<div class="crumbs"><span style="color:${ren ? '#5EEAB4' : '#FFD54A'}">Download${ren ? ' ✓' : ''}</span><i aria-hidden="true">›</i><span style="${ren ? 'color:#FFD54A' : ''}">Rename</span><i aria-hidden="true">›</i><span>On the shelf</span></div>`;
    return `<article class="job ph${ren ? ' renaming' : ''}"><div class="job-h">${cover}<div class="job-t"><b>${esc(j.title)}</b><span class="jl1">${esc(line)}</span></div>${ren ? '' : x}</div>${crumbs}
        ${ren ? `<div class="slip sm">${j.originalName ? `<s>${esc(j.originalName)}</s>` : ''}<b>${privPath(fileAsFor(j))}</b></div>`
        : `<div class="track sm" role="progressbar" aria-label="Download progress of ${esc(j.title)}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="live" style="width:${Math.max(2, p)}%;background:${j.how === 'qbit' ? 'linear-gradient(90deg,#2EE6F6,#4B63FF)' : '#FFD54A'}"></div></div>`}</article>`;
}
function jobCard(j) {
    const x = `<button type="button" class="xbtn" data-act="cancel" data-id="${esc(j.id)}" aria-label="Cancel download of ${esc(j.title)}">${icon('x', 14, 3.6)}</button>`;
    if (j.state === 'queued') {
        const why = j.wait === 'slot' ? `waiting for a free slot (${app.settings.qbit.directSlots} at a time)` : j.wait === 'vpn' ? 'waiting for the VPN tunnel' : j.how === 'qbit' ? 'handing it to qBittorrent' : 'queued on the server';
        return `<article class="job waiting"><div class="job-t"><b style="font-size:20px">${esc(j.title)}</b><span class="mono" style="font-size:13px;color:var(--text2)">${esc(String(j.format || '').toUpperCase())} · ${esc(j.source)} · ${why}</span></div>${x}</article>`;
    }
    const audio = j.kind === 'audiobook';
    const cover = `<div class="job-c${audio ? ' sq' : ''}" aria-hidden="true">${genCover(j, { small: true, fs: 9 })}${j.coverUrl && j.resultId ? `<img src="/cover?id=${encodeURIComponent(j.resultId)}" alt="" onerror="this.remove()">` : ''}</div>`;
    if (isPhone()) return phoneJob(j, x, cover);
    const head = `<div class="job-h">${cover}<div class="job-t"><b>${esc(j.title)}</b><span class="chips2">${fmtChip(j)}${srcChip(j)}</span></div>${j.state === 'renaming' ? '' : x}</div>`;
    if (j.state === 'renaming') return `<article class="job renaming">${head}${steps(j)}
        <div class="slip" style="transform:rotate(-0.6deg)">${j.originalName ? `<s>${esc(j.originalName)}</s>` : ''}<b>${privPath(fileAsFor(j))}</b></div></article>`;
    const p = Math.round((j.progress || 0) * 100);
    let line, fill = '#FFD54A';
    if (j.how === 'qbit') {
        line = `qBittorrent · ${size(j.speed) || '0 KB'}/s · ${plural(j.peers || 0, 'peer')}`;
        fill = 'linear-gradient(90deg,#2EE6F6,#4B63FF)';
    } else line = j.total ? `${size(j.bytes) || '0 KB'} of ${size(j.total)}${j.speed ? ' · ' + size(j.speed) + '/s' : ''}` : `${size(j.bytes) || 'Starting'}${j.speed ? ' · ' + size(j.speed) + '/s' : ''}`;
    return `<article class="job">${head}${steps(j)}
        <div class="prog"><div class="pl"><span>${esc(line)}</span><span>${j.total || j.how === 'qbit' ? p + '%' : ''}</span></div>
        <div class="track" role="progressbar" aria-label="Download progress of ${esc(j.title)}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="live" style="width:${Math.max(4, p)}%;background:${fill}"></div></div></div>
        ${j.qbitError ? `<span class="err">${esc(j.qbitError)}</span>` : ''}</article>`;
}
function drawJobs() {
    const el = $('#jobs'); if (!el || !data) return;
    const active = data.jobs.filter(j => j.state !== 'failed');
    patchHtml(el, `<h2 class="h2">Downloading <span class="count">${active.length}</span></h2>`
        + (active.length ? active.map(jobCard).join('') : `<div class="empty" style="padding:28px"><b style="font-size:19px">Nothing downloading</b><span>Find a book and press Download to server. It shows up here while the server fetches it.</span><a class="btn yellow sm" href="/">Find something to read</a></div>`));
}

// ── Side cards ───────────────────────────────────────────────────────────────
function drawSide() {
    const el = $('#side'); if (!el || !data) return;
    const s = app.settings, st = app.status || {};
    const host = s.qbit.url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const vpn = st.vpn && st.vpn.enabled ? (st.vpn.up ? `<span class="through">${icon('shield', 16)}Through Gluetun${st.vpn.country ? ' · ' + esc(st.vpn.country) : ''}</span>` : `<span class="through" style="color:#FF8A65">${icon('shield', 16)}Tunnel down</span>`) : '';
    const qcard = !s.qbit.enabled ? `<div class="pastel lilac qcard"><span class="label" style="color:#3B2A80">qBittorrent</span><b class="big">Not connected</b><span style="font-size:14px;line-height:1.5">Audiobook magnets need it. Without it, use Magnet link or Torrent file in your own client.</span><a class="btn outline-ink xs" href="/admin#qbittorrent" style="align-self:flex-start">Set it up</a></div>`
        : `<div class="pastel ${qb && !qb.ok ? 'yellow' : 'mint'} qcard"><span class="label">qBittorrent</span>
            <b class="big">${!qb ? 'Checking…' : qb.ok ? 'Connected and ready' : 'Could not reach it'}</b>
            <span class="mono">${priv(esc(host))}<br>category ${esc(s.qbit.category)}<br>${priv(esc(s.qbit.mapFrom) + ' ⇄ ' + esc(s.qbit.mapTo))}</span>
            ${vpn}<a class="btn outline-ink xs" href="/admin#qbittorrent" style="align-self:flex-start">Edit</a></div>`;
    const free = Math.min(data.space.ebook.free || Infinity, data.space.audiobook.free || Infinity);
    patchHtml(el, qcard + `<div class="card sidecard"><b>Filed on the server as</b>
        <span class="tpl" style="color:#5EEAB4">${priv(esc(s.shelves.ebookDir.replace(/\/+$/, '')))}/${esc(s.shelves.ebookTemplate)}</span>
        <span class="tpl" style="color:#FF9FE8">${priv(esc(s.shelves.audioDir.replace(/\/+$/, '')))}/${esc(s.shelves.audioTemplate.split('/').slice(0, -1).join('/') + '/')}</span>
        <span style="font-size:13px;color:var(--text2)">${free < Infinity ? size(free) + ' free' : ''}</span>
        <a href="/admin#shelves" class="u" style="color:var(--paper)">Change naming</a></div>`);
}

// ── On the shelf ─────────────────────────────────────────────────────────────
const recentlySaved = i => i.savedAt && Date.now() - i.savedAt < 10 * 60e3;
function itemRow(i) {
    const colour = i.kind === 'audiobook' ? '#FF9FE8' : paletteFor(i).c[0];
    const box = selecting && !i.failed ? `<button type="button" class="cbox" role="checkbox" aria-checked="${picked.has(i.id)}" aria-label="Select ${esc(i.title)}" data-act="pick" data-id="${esc(i.id)}">${icon('check', 16, 3)}</button>` : '';
    const more = `<span class="menuwrap"><button type="button" class="dots" aria-label="More for ${esc(i.title)}" title="More" aria-haspopup="menu" aria-expanded="false" data-act="menu" data-id="${esc(i.id)}">${icon('more', 18)}</button></span>`;
    if (i.failed && isPhone()) return `<div class="item ph"><div class="iph"><span class="bar14" aria-hidden="true" style="background:#FF8A65"></span><div class="it"><b>${esc(i.title)}</b><span class="failtxt">${esc(/stale/i.test(i.error || '') ? 'The link went stale before the file started. Trying again gets a fresh one.' : i.error || 'The download failed.')}</span></div>${more}</div><button type="button" class="btn outline" data-act="retry" data-id="${esc(i.id)}" style="height:48px">Try again</button></div>`;
    if (i.failed) return `<div class="item">${box}<span class="bar14" aria-hidden="true" style="background:#FF8A65"></span>
        <div class="it"><b>${esc(i.title)}</b><span class="failtxt">${esc(/stale/i.test(i.error || '') ? 'The link went stale before the file started. Trying again gets a fresh one.' : i.error || 'The download failed.')}</span></div>
        <button type="button" class="btn outline sm" data-act="retry" data-id="${esc(i.id)}">Try again</button>${more}</div>`;
    const path = i.path || '';
    let detail;
    if (i.moved) detail = `<span class="orig" style="font-size:13px">Was filed at ${esc(path)}</span><span class="moved">Moved to another app · still in your list</span>`;
    else if (i.removedAt) detail = `<span class="orig" style="font-size:13px">${esc(path)}</span><span class="moved" style="background:rgba(94,234,180,0.15);color:#A6F7D8">Saved to a device · removed from server</span>`;
    else if (i.kind === 'audiobook' && i.tracks > 1) detail = `<span class="path">${privPath(path)}/ · ${i.tracks} files</span>${i.originalName ? `<span class="orig">was ${esc(i.originalName)}</span>` : ''}`;
    else detail = `<span class="path">${privPath(path)}</span>${i.originalName && i.originalName !== path.split('/').pop() ? `<span class="orig">was ${esc(i.originalName)}</span>` : ''}`;
    let main = '';
    const canSave = app.settings.saving.allow;
    if (i.moved) main = `<button type="button" class="cant" disabled>Moved, can't save from here</button>`;
    else if (i.removedAt) main = '';
    else if (!i.available) main = `<button type="button" class="cant" disabled>Not on the server</button>`;
    else if (recentlySaved(i) && app.settings.saving.auto && i.kind === 'ebook') main = `<span class="saved">${icon('check', 16, 3.2)}Saved to this device ${esc(agoShort(i.savedAt))}</span>`;
    else if (canSave) main = `<button type="button" class="btn yellow sm" data-act="save" data-id="${esc(i.id)}">${icon('down', 18, 2.4)}${i.kind === 'audiobook' && i.tracks > 1 ? 'Save as .zip' : 'Save to this device'} · ${size(i.saveSize || i.size)}</button>`;
    if (isPhone()) return `<div class="item ph"><div class="iph">${box}<span class="bar14" aria-hidden="true" style="background:${colour}"></span>
        <div class="it"><b>${esc(i.title)}</b>${detail}<span class="when">${esc(when(i.addedAt))} · ${i.how === 'qbit' ? 'qBittorrent' : 'direct'}</span></div>${more}</div>${main.replace('this device', 'this phone')}</div>`;
    return `<div class="item">${box}<span class="bar14" aria-hidden="true" style="background:${colour}"></span>
        <div class="it"><b>${esc(i.title)}</b>${detail}</div>
        <span class="when">${esc(when(i.addedAt))} · ${i.how === 'qbit' ? 'qBittorrent' : 'direct'}</span>${main}${more}</div>`;
}
const agoShort = t => (Date.now() - t < 60e3 ? 'just now' : Math.round((Date.now() - t) / 60e3) + ' min ago');
const failedRows = () => data.jobs.filter(j => j.state === 'failed').map(j => ({ ...j, failed: true }));
const rows = () => failedRows().concat(data.items);
function drawItems() {
    const el = $('#items'); if (!el || !data) return;
    const list = data.items, failed = failedRows();
    const n = data.items.length;
    patchHtml(el, `<div class="items-h"><h2 class="h2">On the shelf <span class="count">${n}</span></h2><span class="desc">${isAdmin() ? 'Stored on your server' : 'Kept on this server'} and named for you. Save a copy to this device whenever you like.</span>
        ${n ? `<button type="button" class="btn outline xs" data-act="select" aria-pressed="${selecting}">${selecting ? 'Done' : 'Select'}</button>` : ''}</div>
        ${selecting ? `<div class="selbar"><b aria-live="polite">${picked.size} selected</b>
            <button type="button" class="btn yellow sm" data-act="bulk-save"${picked.size && app.settings.saving.allow ? '' : ' disabled'}>Save to this ${isPhone() ? 'phone' : 'device'}</button>
            <button type="button" class="btn danger sm" data-act="bulk-delete"${picked.size ? '' : ' disabled'}>Delete</button></div>` : ''}
        ${list.length ? `<div class="items">${list.map(itemRow).join('')}</div>` : `<div class="empty"><b>The shelf is empty</b><span>Books land here once the server has downloaded and filed them.</span></div>`}
        ${failed.length ? `<h3 class="h-sub" style="font-size:22px;margin-top:18px">Didn't download <span class="count">${failed.length}</span></h3><div class="items">${failed.map(itemRow).join('')}</div>` : ''}`);
}

// Whatever a click asks of the server, a failure ends as a message instead of nothing.
const onClick = e => click(e).catch(err => toast(err.message));
async function click(e) {
    const t = e.target.closest('[data-act]'); if (!t || !root.contains(t)) return;
    const id = t.dataset.id, item = data && data.items.find(i => i.id === id), job = data && data.jobs.find(j => j.id === id);
    switch (t.dataset.act) {
        case 'cancel': {
            if (job && !(await confirmBox('Cancel this download?', `“${job.title}” stops downloading and any partial file is removed.`, 'Cancel download', true, 'Keep downloading'))) return;
            await api('/api/jobs/' + id, { method: 'DELETE' }); return load();
        }
        case 'retry': try { await api(`/api/jobs/${id}/retry`, { method: 'POST' }); } catch (err) { toast(err.message); } return load();
        case 'save': saveToDevice(id); setTimeout(load, 1500); return;
        case 'select': selecting = !selecting; picked.clear(); return drawItems();
        case 'pick': picked.has(id) ? picked.delete(id) : picked.add(id); return drawItems();
        case 'bulk-save': {
            const ids = [...picked];
            ids.forEach((x, k) => setTimeout(() => saveToDevice(x), k * 700));
            toast(`Saving ${plural(ids.length, 'book')} to this device`);
            selecting = false; picked.clear(); drawItems(); setTimeout(load, ids.length * 700 + 1500);
            return;
        }
        case 'bulk-delete': {
            for (const i of data.items) if (picked.has(i.id) && !canDelete(i)) picked.delete(i.id);
            if (!picked.size) { toast('Only the person who added these, or an admin, can delete them'); return; }
            const names = data.items.filter(i => picked.has(i.id)).map(i => i.title);
            if (!(await confirmBox(`Delete ${plural(names.length, 'book')}?`, `The files are removed from the server: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' and ' + (names.length - 5) + ' more' : ''}. Copies already saved to devices stay.`))) return;
            await api('/api/shelf/delete', { body: { ids: [...picked] } });
            selecting = false; picked.clear(); return load();
        }
        case 'menu': {
            const r = item || job;
            const items = [];
            if (job) {
                if (job.pageUrl) items.push({ label: 'Open source page', run: () => window.open(job.pageUrl, '_blank', 'noopener,noreferrer') });
                items.push({ label: 'Remove from the list', danger: true, run: async () => { await api(`/api/shelf/${job.id}/forget`, { method: 'POST' }); load(); } });
            } else if (r.moved) {
                items.push({ label: 'Copy old path', run: () => copy(r.path, 'Old path copied') });
                items.push({ label: 'Remove from the list', danger: true, run: async () => { await api(`/api/shelf/${r.id}/forget`, { method: 'POST' }); load(); } });
            } else {
                if (r.savedAt && r.available && app.settings.saving.allow) items.push({ label: 'Save again to this device', run: () => saveToDevice(r.id) });
                if (!r.removedAt) items.push({ label: 'Copy server path', run: () => copy(r.path, 'Server path copied') });
                if (r.pageUrl) items.push({ label: 'Open source page', run: () => window.open(r.pageUrl, '_blank', 'noopener,noreferrer') });
                if (r.removedAt) items.push({ label: 'Remove from the list', danger: true, run: async () => { await api(`/api/shelf/${r.id}/forget`, { method: 'POST' }); load(); } });
                else if (canDelete(r)) items.push({ label: visitor() ? 'Remove from my shelf' : 'Delete files', danger: true, run: async () => {
                    if (!(await confirmBox(visitor() ? `Remove “${r.title}”?` : `Delete “${r.title}”?`, visitor() ? 'It leaves your shelf here. Save it to your device first if you want to keep it.' : `This removes ${r.path} from the server. Copies already saved to devices stay.`, visitor() ? 'Remove' : 'Delete'))) return;
                    await api('/api/shelf/delete', { body: { ids: [r.id] } }); load();
                } });
            }
            return showMenu(t, items);
        }
        case 'period': { statsPeriod = t.dataset.v; await renderStats(); const b = $(`[data-act="period"][data-v="${statsPeriod}"]`); if (b) b.focus({ preventScroll: true }); return; }
    }
}

// ── Stats ────────────────────────────────────────────────────────────────────
async function renderStats() {
    let s;
    try { s = await api('/api/stats?period=' + statsPeriod); } catch (e) { root.innerHTML = frame('stats', `<p class="err">${esc(e.message)}</p></section>`); return; }
    const intro = `<p class="lede">Counted on this server and never sent anywhere. It shows what you read most and what it costs in disk space. You can switch counting off in the <a href="/admin#privacy" class="u" style="font-size:inherit;color:inherit">admin panel, under Privacy and backup</a>.</p>`;
    if (!s.enabled) { root.innerHTML = frame('stats', intro + `</section><div class="empty"><b>Counting is off</b><span>Switch on Keep stats in the admin panel, under Privacy and backup, and RaveBSD starts counting from the next download.</span><a class="btn yellow sm" href="/admin#privacy">Privacy settings</a></div>`); return; }
    const periods = [['all', 'All time'], ['year', 'This year'], ['30d', 'Last 30 days']];
    root.innerHTML = frame('stats', intro + `</section><section aria-label="Stats" class="sset" style="gap:22px">
        <div class="seg" role="radiogroup" aria-label="Period">${periods.map(([v, l]) => `<button type="button" role="radio" aria-checked="${v === statsPeriod}" data-act="period" data-v="${v}">${l}</button>`).join('')}</div>
        <div class="stats-cards">${storageCard(s)}${downloadsCard(s)}${ebookCard(s)}${audioCard(s)}${authorsCard(s)}</div></section>`);
    playCharts();
}

const pct = (n, t) => (t ? Math.round(n / t * 100) : 0);
function pie(slices, r, sw, cx, cy) {
    let off = 0;
    return slices.map(([v, colour]) => {
        const len = Math.max(0, v * 100);
        const c = `<circle data-sweep r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="${colour}" stroke-width="${sw}" pathLength="100" stroke-dasharray="${len.toFixed(2)} ${(100 - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"></circle>`;
        off += len;
        return c;
    }).join('');
}
function storageCard(s) {
    const total = s.disk.total || 0, free = s.disk.free || 0;
    const eb = s.shelf.ebook, au = s.shelf.audiobook, other = Math.max(0, total - free - eb - au);
    const sl = total ? [[eb / total, '#4B63FF'], [au / total, '#FF4FD8'], [other / total, '#8E9BA8'], [free / total, '#FFFFFF']] : [];
    const books = s.ebook + s.audio;
    const months = s.last30Bytes > 0 ? Math.floor(free / s.last30Bytes) : 0;
    const pace = s.last30Bytes > 0 ? `At this pace the disk has room for about ${months > 120 ? 'ten years or more' : plural(months, 'more month')} of reading.` : 'Nothing was downloaded in the last 30 days.';
    const legend = [['#4B63FF', 'eBooks', eb], ['#FF4FD8', 'Audiobooks', au], ['#8E9BA8', 'Everything else', other], ['#FFFFFF', 'Free', free]];
    return `<div class="stat" style="flex:1 1 560px;background:linear-gradient(160deg,#C4F5E1,#7DDFC0);gap:16px">
        <span class="label" style="color:#0B5E43">Storage</span>
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:18px 28px">
        <svg role="img" aria-label="Hard disk: ${size(free)} free of ${size(total)}. eBooks ${size(eb) || '0'}, audiobooks ${size(au) || '0'}, everything else ${size(other)}" viewBox="0 0 220 170" width="236" height="182" style="flex:none;filter:drop-shadow(0 8px 14px rgba(11,74,54,0.35))">
          <defs><radialGradient id="platd" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#F3F5F9"/><stop offset="1" stop-color="#C3CAD6"/></radialGradient></defs>
          <rect x="2" y="2" width="216" height="166" rx="14" fill="#14123A"/><rect x="8" y="8" width="204" height="154" rx="10" fill="#1F1D4D" stroke="rgba(255,255,255,0.16)"/>
          <circle cx="17" cy="17" r="3.5" fill="#0B0A24"/><circle cx="203" cy="17" r="3.5" fill="#0B0A24"/><circle cx="17" cy="153" r="3.5" fill="#0B0A24"/><circle cx="203" cy="153" r="3.5" fill="#0B0A24"/>
          <circle cx="92" cy="85" r="68" fill="url(#platd)"/>
          <g transform="translate(92 85) rotate(-90)">${pie(sl, 29, 58, 0, 0)}</g>
          <circle cx="92" cy="85" r="58" fill="none" stroke="rgba(20,18,58,0.25)" stroke-width="1"/>
          <circle cx="92" cy="85" r="11" fill="#D8DCE6" stroke="#14123A" stroke-width="2"/><circle cx="92" cy="85" r="4" fill="#14123A"/>
          <path d="M190 136 L152 109" stroke="#C9CEDA" stroke-width="8" stroke-linecap="round"/><circle cx="190" cy="136" r="9" fill="#AEB4C2" stroke="#14123A" stroke-width="2"/><circle cx="190" cy="136" r="3" fill="#14123A"/><circle cx="151" cy="108.5" r="4" fill="#14123A"/>
          <circle cx="203" cy="28" r="3" fill="#5EEAB4"/></svg>
        <div style="flex:1 1 240px;display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px"><span style="font-size:60px;font-weight:800;letter-spacing:-0.035em;line-height:1">${size(free) || '0 GB'}</span><span style="font-size:20px;font-weight:700">free of ${size(total)}</span></div>
          <div class="legend">${legend.map(([c, l, v]) => `<span><span class="sw" style="background:${c};${c === '#FFFFFF' ? 'box-shadow:inset 0 0 0 2px rgba(20,18,58,0.3)' : ''}"></span>${l} <span class="m" style="color:#0B4A36">${size(v) || '0 KB'}</span></span>`).join('')}</div>
        </div></div>
        <span style="font-size:14px;line-height:1.5;color:#0B4A36">Your shelf takes up ${size(eb + au) || 'nothing yet'}${books ? ` across ${plural(books, 'book')} downloaded` : ''}. ${pace}</span></div>`;
}
function downloadsCard(s) {
    const total = s.ebook + s.audio, saved = Math.min(total, s.saved);
    const split = total ? 134 * (s.audio / total) : 0;
    return `<div class="stat" style="flex:1 1 300px;background:linear-gradient(160deg,#E2D8FF,#B7A4FF)">
        <span class="label" style="color:#3B2A80">Downloaded to the server</span>
        <div style="display:flex;align-items:center;gap:16px">
        <svg role="img" aria-label="Downloaded: ${plural(s.ebook, 'eBook')} and ${plural(s.audio, 'audiobook')}" viewBox="0 0 120 134" width="134" height="150" style="flex:none">
          <defs><mask id="dlmaskd" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="134"><g fill="#fff" stroke="#fff" stroke-linejoin="round" stroke-width="9"><polygon points="51,10.5 69,10.5 69,70 92.4,70 60,97 27.6,70 51,70"/><rect x="26.2" y="122.5" width="67.6" height="1" rx="0.5"/></g></mask></defs>
          <g mask="url(#dlmaskd)"><rect x="0" y="0" width="120" height="134" fill="rgba(255,255,255,0.55)"/>
          ${total ? `<rect data-rise x="0" y="${split.toFixed(1)}" width="120" height="${(134 - split).toFixed(1)}" fill="#4B63FF"/><rect data-rise x="0" y="0" width="120" height="${split.toFixed(1)}" fill="#FF4FD8"/>${s.audio && s.ebook ? `<rect data-rise x="0" y="${(split - 0.9).toFixed(1)}" width="120" height="1.8" fill="#FFFFFF"/>` : ''}` : ''}</g></svg>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:8px">
          <span class="big">${total}</span>
          <div class="legend" style="font-size:14px;gap:4px"><span><span class="sw" style="background:#4B63FF"></span>${plural(s.ebook, 'eBook')}</span><span><span class="sw" style="background:#FF4FD8"></span>${plural(s.audio, 'audiobook')}</span></div>
          <div style="height:1px;margin:4px 0;background:rgba(20,18,58,0.2)"></div>
          <div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:28px;font-weight:800;letter-spacing:-0.03em;line-height:1">${saved}</span><span style="font-size:13px;font-weight:600;color:#2E2166">saved to a device</span></div>
          <div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:28px;font-weight:800;letter-spacing:-0.03em;line-height:1">${total - saved}</span><span style="font-size:13px;font-weight:600;color:#2E2166">only on the server</span></div>
        </div></div></div>`;
}
function formatsOf(s, kind, main) {
    const counts = {};
    for (const [k, n] of Object.entries(s.fmt)) if (k.startsWith(kind + ':')) counts[k.slice(kind.length + 1)] = n;
    const list = main.map(f => [f, counts[f] || 0]);
    const other = Object.entries(counts).filter(([f]) => !main.includes(f)).reduce((a, [, n]) => a + n, 0);
    if (other) list.push(['other', other]);
    return list.filter(([, n]) => n > 0);
}
function ebookCard(s) {
    const COL = ['#14123A', '#FF4FD8', '#FFD54A', '#FFFFFF', '#4B63FF'];
    const list = formatsOf(s, 'ebook', ['epub', 'pdf', 'mobi', 'azw3']);
    const total = list.reduce((a, [, n]) => a + n, 0);
    // Bands fill the file from the bottom (y 122) up to its top (y 8).
    let y = 122;
    const bands = list.map(([f, n], i) => {
        const h = total ? 114 * n / total : 0; y -= h;
        return `<rect data-rise x="0" y="${y.toFixed(2)}" width="100" height="${h.toFixed(2)}" fill="${COL[i]}"/>${i < list.length - 1 ? `<rect data-rise x="0" y="${(y - 0.8).toFixed(2)}" width="100" height="1.6" fill="#FFFFFF"/>` : ''}`;
    }).join('');
    const avg = s.ebook ? s.bytes.ebook / s.ebook : 0;
    return `<div class="stat" style="flex:1 1 0;min-width:min(340px,100%);background:linear-gradient(160deg,#CDE8FF,#8FD0FF)">
        <span class="label" style="color:#1B4F7A">eBook file types</span>
        <div style="display:flex;align-items:center;gap:20px">
        <svg role="img" aria-label="eBook file types: ${list.map(([f, n]) => `${f.toUpperCase()} ${pct(n, total)}%`).join(', ') || 'none yet'}" viewBox="-10 0 128 134" width="161" height="169" style="flex:none;overflow:visible;filter:drop-shadow(0 6px 8px rgba(27,79,122,0.25))">
          <defs><mask id="filemaskd" maskUnits="userSpaceOnUse" x="-20" y="-10" width="150" height="150"><g fill="#fff" stroke="#fff" stroke-linejoin="round" stroke-width="9"><polygon points="16.5,12.5 60,12.5 83.5,36 83.5,117.5 16.5,117.5"/></g></mask></defs>
          <g transform="translate(15 4) rotate(9 50 65)"><polygon points="16.5,12.5 60,12.5 83.5,36 83.5,117.5 16.5,117.5" fill="#FFFFFF" stroke="#FFFFFF" stroke-width="9" stroke-linejoin="round" opacity="0.9"/><path d="M60 8 V32 a4 4 0 0 0 4 4 H88 Z" fill="rgba(20,18,58,0.1)"/><rect x="28" y="56" width="46" height="4" rx="2" fill="rgba(20,18,58,0.13)"/><rect x="28" y="68" width="46" height="4" rx="2" fill="rgba(20,18,58,0.13)"/><rect x="28" y="80" width="30" height="4" rx="2" fill="rgba(20,18,58,0.13)"/></g>
          <g transform="rotate(-7 50 65)"><g mask="url(#filemaskd)"><rect x="-10" y="0" width="120" height="130" fill="rgba(255,255,255,0.55)"/>${bands}</g><path d="M60 8 V32 a4 4 0 0 0 4 4 H88 Z" fill="rgba(255,255,255,0.9)" stroke="#CFE3F5" stroke-width="1" stroke-linejoin="round"/></g></svg>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;align-items:baseline;gap:8px"><span class="big">${s.ebook}</span><span style="font-size:17px;font-weight:700;color:#1B4F7A">eBook${s.ebook === 1 ? '' : 's'}</span></div>
          <ul class="fmts">${list.map(([f, n], i) => `<li><span class="sw" style="background:${COL[i]}"></span><span>${f === 'other' ? 'Other' : f.toUpperCase()}</span><span class="m">${pct(n, total)}% · ${n}</span></li>`).join('') || '<li style="font-weight:500">None yet</li>'}</ul>
        </div></div>
        <span style="font-size:14px;line-height:1.5;color:#1B4F7A">${avg ? `The average eBook weighs ${size(avg)}.` : 'Download an eBook and its type shows up here.'}</span></div>`;
}
function audioCard(s) {
    const COL = ['#14123A', '#4B63FF', '#FFFFFF', '#FF4FD8'];
    const list = formatsOf(s, 'audio', ['m4b', 'mp3', 'zip']);
    const total = list.reduce((a, [, n]) => a + n, 0);
    const avg = s.audio ? s.bytes.audio / s.audio : 0;
    return `<div class="stat" style="flex:1 1 0;min-width:min(340px,100%);background:linear-gradient(160deg,#FFC2D4,#FFD8B0)">
        <span class="label" style="color:#7A2A5A">Audiobook formats</span>
        <div style="display:flex;align-items:center;gap:20px">
        <svg role="img" aria-label="Audiobook formats: ${list.map(([f, n]) => `${f.toUpperCase()} ${pct(n, total)}%`).join(', ') || 'none yet'}" viewBox="0 0 100 100" width="150" height="150" style="flex:none;filter:drop-shadow(0 6px 10px rgba(90,35,66,0.25))">
          <defs><linearGradient id="cdrimd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.5" stop-color="#D9DCE8"/><stop offset="1" stop-color="#F4F5FA"/></linearGradient><mask id="cdmaskd" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="100" fill="#fff"/><circle cx="50" cy="50" r="6.5" fill="#000"/></mask></defs>
          <g data-spin mask="url(#cdmaskd)"><circle cx="50" cy="50" r="48" fill="url(#cdrimd)"/>
          <g transform="rotate(-90 50 50)">${pie(list.map(([, n], i) => [n / (total || 1), COL[i]]), 31, 26, 50, 50)}</g>
          <circle cx="50" cy="50" r="18.5" fill="url(#cdrimd)"/><circle cx="50" cy="50" r="18.5" fill="none" stroke="rgba(20,18,58,0.25)" stroke-width="0.8"/><circle cx="50" cy="50" r="12" fill="none" stroke="rgba(20,18,58,0.18)" stroke-width="0.8"/><path d="M50 50 L84 24 A43 43 0 0 1 92 40 Z" fill="rgba(255,255,255,0.16)"/><path d="M50 50 L16 76 A43 43 0 0 1 8 60 Z" fill="rgba(255,255,255,0.12)"/></g></svg>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;align-items:baseline;gap:8px"><span class="big">${s.audio}</span><span style="font-size:17px;font-weight:700;color:#7A2A5A">audiobook${s.audio === 1 ? '' : 's'}</span></div>
          <ul class="fmts">${list.map(([f, n], i) => `<li><span class="sw" style="background:${COL[i]}"></span><span>${f === 'other' ? 'Other' : f.toUpperCase()}</span><span class="m">${pct(n, total)}% · ${n}</span></li>`).join('') || '<li style="font-weight:500">None yet</li>'}</ul>
        </div></div>
        <span style="font-size:14px;line-height:1.5;color:#5A2342">${avg ? `The average audiobook weighs ${size(avg)}.` : 'Download an audiobook and its format shows up here.'}</span></div>`;
}
function authorsCard(s) {
    const top = s.topAuthors, max = top.length ? top[0].n : 1;
    return `<div class="stat" style="flex:1 1 100%;background:linear-gradient(160deg,#FFE48A,#FFC94A)">
        <span class="label" style="color:#6B4A00">Most downloaded authors</span>
        ${top.length ? `<ol class="authors">${top.map((a, i) => `<li><div class="ar"><span>${i + 1} · ${esc(a.name)}</span><span class="m">${a.n}</span></div><div class="bt"><div data-grow style="width:${Math.round(a.n / max * 100)}%"></div></div></li>`).join('')}</ol>`
        : '<span style="font-size:15px;font-weight:600">Nobody yet. Your most downloaded authors will line up here.</span>'}</div>`;
}
// Each chart plays once, when it is 40% in view.
function playCharts() {
    if (!prefs.motion) return;
    const E = 'cubic-bezier(.22,.9,.24,1)';
    const anims = [];
    $$('[data-sweep]').forEach((c, i) => anims.push(c.animate([{ strokeDasharray: '0 100' }, { strokeDasharray: c.getAttribute('stroke-dasharray') }], { duration: 900, delay: 150 + i * 140, easing: E, fill: 'backwards' })));
    $$('[data-spin]').forEach(g => { g.style.transformBox = 'view-box'; g.style.transformOrigin = '50px 50px'; anims.push(g.animate([{ transform: 'rotate(-240deg)' }, { transform: 'rotate(0deg)' }], { duration: 1500, delay: 200, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' })); });
    $$('[data-rise]').forEach(r => anims.push(r.animate([{ transform: 'translateY(134px)' }, { transform: 'translateY(0px)' }], { duration: 1200, delay: 300, easing: E, fill: 'backwards' })));
    $$('[data-grow]').forEach((b, i) => anims.push(b.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 800, delay: 350 + i * 110, easing: E, fill: 'backwards' })));
    const groups = new Map();
    anims.forEach(a => {
        a.pause();
        const el = a.effect.target, box = el.closest('svg') || el.closest('ol') || document.body;
        if (!groups.has(box)) groups.set(box, []);
        groups.get(box).push(a);
    });
    const io = new IntersectionObserver(entries => entries.forEach(en => { if (en.isIntersecting) { io.unobserve(en.target); (groups.get(en.target) || []).forEach(a => a.play()); } }), { threshold: 0.4 });
    groups.forEach((list, box) => io.observe(box));
}
