// The verification view: the RaveBSD server's own browser, shown as pictures, so a person can pass
// a site's human check (Anna's Archive or Z-Library) from any device (clicks and keys go back to it). RaveBSD never solves it.
import { $, esc, isPhone } from './ui.js';

const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), credentials: 'same-origin' });

export function openVerify(onDone, site = 'annas') {
    const name = site === 'zlibrary' ? 'Z-Library' : "Anna's Archive";
    let running = true, pending = null, full = false;
    // Where the picture sits on the server's page (it is usually zoomed in on the check).
    let area = { x: 0, y: 0, width: 1, height: 1 };
    const back = document.activeElement;
    const ov = document.createElement('div');
    ov.className = 'verify';
    ov.innerHTML = `<div class="verify-box" role="dialog" aria-modal="true" aria-label="${name} check">
        <div class="verify-h"><b>${name} check</b><span class="btnrow" style="gap:8px"><button type="button" class="btn outline xs" id="v-reload">Reload</button><button type="button" class="btn outline xs" id="v-full" aria-pressed="false">Whole page</button><button type="button" class="btn outline xs" id="v-close">Close</button></span></div>
        <p class="desc" style="margin:0">This is the browser running on your RaveBSD server, zoomed in on the check. Tap the box. If it asks for more, tap the text field in the picture, type the characters below and press Verify in the picture. It closes by itself once you are through, and the pass is remembered.</p>
        <div class="v-stage"><img id="v-frame" alt="The server's browser" tabindex="0"></div>
        <form id="v-type" class="btnrow" style="flex-wrap:nowrap"><input class="input" id="v-text" placeholder="Type the characters here" aria-label="Text to type into the check" autocomplete="off"><button type="submit" class="btn yellow sm">Send</button></form>
        <p class="inline-msg" id="v-status" aria-live="polite">Starting the browser…</p></div>`;
    document.body.appendChild(ov);
    const frame = $('#v-frame', ov), status = $('#v-status', ov);
    const send = ev => post('/browser/input', ev);
    const close = solved => { running = false; clearTimeout(pending); ov.remove(); if (back) back.focus(); onDone && onDone(!!solved); };
    const finish = async () => {
        running = false;
        status.textContent = 'Checking…';
        const r = await post('/browser/verify', { action: 'stop' }).then(x => x.json()).catch(() => ({}));
        if (r.solved) close(true); else status.textContent = 'The check has not been passed yet. Close this and try again.';
    };
    const tick = async () => {
        if (!running) return;
        try {
            const r = await fetch('/browser/frame?t=' + Date.now() + (full ? '&full=1' : ''), { credentials: 'same-origin' });
            if (!r.ok) throw new Error('closed');
            const state = r.headers.get('X-Check-State');
            const a = (r.headers.get('X-Area') || '').split(',').map(Number);
            if (a.length === 4 && a[2] > 0) {
                area = { x: a[0], y: a[1], width: a[2], height: a[3] };
                // Zoomed: up to 2.4 times the check's size, never wider than the box.
                frame.style.width = full ? '100%' : `min(100%, ${Math.round(area.width * 2.4)}px)`;
            }
            const blob = await r.blob();
            if (!running) return;
            const old = frame.src;
            frame.src = URL.createObjectURL(blob);
            if (old.startsWith('blob:')) URL.revokeObjectURL(old);
            if (state === 'solved') { status.textContent = 'Check passed.'; return finish(); }
            status.textContent = state === 'captcha' ? 'Waiting for you to pass the check.' : 'Loading…';
            pending = setTimeout(tick, 700);
        } catch (e) { pending = setTimeout(tick, 1500); }
    };
    const at = e => { const r = frame.getBoundingClientRect(); return { x: area.x + (e.clientX - r.left) / r.width * area.width, y: area.y + (e.clientY - r.top) / r.height * area.height }; };
    frame.addEventListener('click', e => { send({ type: 'click', ...at(e) }); frame.focus(); });
    // The person's own pointer movement goes along too; some checks look for it.
    let lastMove = 0;
    frame.addEventListener('pointermove', e => { const now = Date.now(); if (now - lastMove > 120) { lastMove = now; send({ type: 'move', ...at(e) }); } });
    frame.addEventListener('wheel', e => { e.preventDefault(); send({ type: 'scroll', dy: e.deltaY }); }, { passive: false });
    frame.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.key === 'Tab') return;
        e.preventDefault();
        if (e.key === 'Escape') return $('#v-close', ov).click();
        if (e.key.length === 1) send({ type: 'type', text: e.key }); else send({ type: 'key', key: e.key });
    });
    $('#v-type', ov).addEventListener('submit', e => { e.preventDefault(); const t = $('#v-text', ov); if (t.value) send({ type: 'type', text: t.value }); t.value = ''; });
    $('#v-full', ov).addEventListener('click', e => { full = !full; e.currentTarget.setAttribute('aria-pressed', full); e.currentTarget.textContent = full ? 'Zoom in' : 'Whole page'; });
    // Reload the check; if the server's window timed out, open a new one.
    $('#v-reload', ov).addEventListener('click', async () => {
        status.textContent = 'Reloading…';
        const r = await post('/browser/verify', { action: 'reload' }).then(x => x.json()).catch(() => ({}));
        if (!r.ok) await post('/browser/verify', { action: 'start', site, phone: isPhone() }).catch(() => {});
        if (!running) { running = true; tick(); }
    });
    $('#v-close', ov).addEventListener('click', () => { post('/browser/verify', { action: 'stop' }).catch(() => {}); close(false); });
    $('#v-close', ov).focus();
    ov.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.defaultPrevented) $('#v-close', ov).click(); });
    post('/browser/verify', { action: 'start', site, phone: isPhone() }).then(r => r.json()).then(r => {
        if (!r.ok) { running = false; status.innerHTML = esc(r.reason || 'Could not start the background browser.'); return; }
        tick();
    }).catch(() => { running = false; status.textContent = 'Could not reach RaveBSD.'; });
}
