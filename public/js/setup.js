// First run, in 4 steps: password, folders, qBittorrent, summary. Nothing is saved until the last step.
import { $, $$, esc, api, icon, anim, chevron, prefs, priv, privPath, size } from './ui.js';
import { setBg } from './app.js';
import { applyTemplate } from './rename.js';

const COLOURS = ['#FF8A65', '#5EEAB4', '#2EE6F6', '#FF4FD8'];
const HEIGHTS = [40, 50, 44, 56];
let st, root, done;

export async function mount(el, opts) {
    root = el; done = opts.done;
    setBg('var(--glow-home)');
    const s = await api('/api/settings');
    st = {
        // PUBLIC_INSTANCE=1 on the server: public mode is the only choice.
        forced: !!s.access.publicForced, step: 1, dir: 1, auth: s.access.publicForced ? 'public' : 'none', username: 'admin', password: '', password2: '',
        ebookDir: s.shelves.ebookDir, audioDir: s.shelves.audioDir, ebookTemplate: s.shelves.ebookTemplate, audioTemplate: s.shelves.audioTemplate,
        names: false, qb: false, qbt: 'idle', qbVersion: '', qbManual: false, qbUrl: s.qbit.url, qbUser: '', qbPass: '', folders: null, error: '',
    };
    draw(true);
    checkFolders();
}

const sample = () => '/' + [st.ebookDir.replace(/^\/+|\/+$/g, ''), applyTemplate(st.ebookTemplate, { author: 'Frank Herbert', title: 'Dune', year: '1965', ext: 'epub' })].filter(Boolean).join('/');
function folderLine() {
    const f = st.folders;
    if (!f) return '<span class="desc" id="fstat">Checking the folders…</span>';
    const bad = ['ebookDir', 'audioDir'].filter(k => !f[k].writable);
    if (bad.length) return `<span class="err" id="fstat">${bad.length > 1 ? 'The eBooks and audiobooks folders are' : bad[0] === 'ebookDir' ? 'The eBooks folder is' : 'The audiobooks folder is'} not writable. Check the volume in compose.yaml.</span>`;
    const free = Math.min(f.ebookDir.free, f.audioDir.free);
    return `<span class="ok" id="fstat">Both writable · ${size(free) || '0 KB'} free</span>`;
}
let fTimer;
function checkFolders() {
    clearTimeout(fTimer);
    fTimer = setTimeout(async () => {
        try { st.folders = await api('/api/folders', { body: { ebookDir: st.ebookDir, audioDir: st.audioDir } }); } catch (e) { st.folders = null; }
        const el = $('#fstat'); if (el) el.outerHTML = folderLine();
    }, 300);
}

function stepHtml() {
    const s = st;
    if (s.step === 1) return `<div class="sstep" data-step>
        <div><h1>Who is it <span class="serif" style="color:#FFD54A">for?</span></h1>
        <p class="lede" style="margin-top:8px">You can change this later in the admin panel, under Access.</p></div>
        <div role="radiogroup" aria-label="Who it is for" style="display:flex;flex-direction:column;gap:20px">
        ${s.forced ? '' : `<button type="button" class="opt" role="radio" aria-checked="${s.auth === 'none'}" data-act="auth" data-v="none"><b>Just me, no password</b><span>Anyone who can reach this address can use everything. Fine at home, on Tailscale, or behind a proxy that already asks.</span></button>
        <button type="button" class="opt" role="radio" aria-checked="${s.auth === 'pw'}" data-act="auth" data-v="pw"><b>Just me, with a password</b><span>One login for you, before anything is shown. Scripts can get their own API keys.</span></button>
        <button type="button" class="opt" role="radio" aria-checked="${s.auth === 'family'}" data-act="auth" data-v="family"><b>Friends and family</b><span>Everyone signs in. Make your admin account now and add the others in the admin panel. They search, download and share one shelf.</span></button>`}
        <button type="button" class="opt" role="radio" aria-checked="${s.auth === 'public'}" data-act="auth" data-v="public"><b>Open to the internet</b><span>Visitors search and keep their own downloads for a while, within a space limit. Everything else sits behind your admin sign-in.</span></button></div>
        ${s.auth !== 'none' ? `<div class="fields reveal" id="pwf">
            <label class="field">Username<input class="input" data-k="username" value="${esc(s.username)}" autocomplete="username"></label>
            <label class="field">Password<input class="input" type="password" data-k="password" value="${esc(s.password)}" autocomplete="new-password"></label>
            <label class="field">Once more<input class="input" type="password" data-k="password2" value="${esc(s.password2)}" autocomplete="new-password"></label></div>` : ''}
        </div>`;
    if (s.step === 2) return `<div class="sstep" data-step>
        <div><h1>Where do books <span class="serif" style="color:#5EEAB4">live?</span></h1>
        <p class="lede" style="margin-top:8px">Finished downloads are renamed your way and put on these shelves. Map real folders into the container in <span class="mono" style="font-size:15px;color:var(--paper)">compose.yaml</span>.</p></div>
        <div class="fields"><label class="field">eBooks<input class="input mono priv" data-k="ebookDir" value="${esc(s.ebookDir)}" spellcheck="false"></label>
            <label class="field">Audiobooks<input class="input mono priv" data-k="audioDir" value="${esc(s.audioDir)}" spellcheck="false"></label></div>
        ${folderLine()}
        <div class="slip" id="slip"><s>Dune_-_Frank_Herbert_(z-lib.org).epub</s><b>${privPath(sample())}</b></div>
        <button type="button" class="disclose" data-act="names" aria-expanded="${s.names}" aria-controls="namesf">${s.names ? 'Keep the usual names' : 'Change how files are named'}${chevron(16)}</button>
        ${s.names ? `<div class="reveal" id="namesf" style="display:flex;flex-direction:column;gap:16px">
            <label class="field">How eBooks are named<input class="input mono" data-k="ebookTemplate" value="${esc(s.ebookTemplate)}" spellcheck="false"></label>
            <label class="field">How audiobooks are named<input class="input mono" data-k="audioTemplate" value="${esc(s.audioTemplate)}" spellcheck="false"></label></div>` : ''}
        </div>`;
    if (s.step === 3) {
        const t = s.qbt, manual = s.qbManual || t === 'failed';
        const view = {
            idle: ['We will look for qBittorrent', `${s.qbUrl} · the usual address in Docker`, 'Test connection', ''],
            testing: ['Looking for it…', s.qbUrl, 'Testing…', 'disabled'],
            found: [`Found qBittorrent ${s.qbVersion}`, `${s.qbUrl} · signed in with the saved Web UI login`, 'Test again', ''],
            failed: ['Could not reach it', s.qbError || 'Enter its address and login below', 'Test again', ''],
        }[t];
        return `<div class="sstep" data-step>
        <div><h1>Got <span class="serif" style="color:#2EE6F6">qBittorrent?</span></h1>
        <p class="lede" style="margin-top:8px">Optional. eBooks download on their own. Audiobooks usually come as magnet links, and qBittorrent can fetch those. RaveBSD will rename and shelve what it brings back.</p></div>
        <button type="button" class="bigswitch" role="switch" aria-checked="${s.qb}" data-act="qb">Yes, connect qBittorrent<span class="switch" aria-checked="${s.qb}" aria-hidden="true"></span></button>
        ${s.qb ? `<div class="reveal" style="display:flex;flex-direction:column;gap:16px">
            <div class="qbstat" id="qbstat"><span class="qt"><b style="${t === 'found' ? 'color:#5EEAB4' : t === 'failed' ? 'color:#FF8A65' : ''}" aria-live="polite">${esc(view[0])}</b><span>${esc(view[1])}</span></span>
            <button type="button" class="btn cyan" data-act="qbtest" ${view[3]}>${view[2]}</button></div>
            <button type="button" class="disclose" data-act="qbmanual" aria-expanded="${manual}">${manual ? 'Hide address and login' : 'Somewhere else, or needs a login?'}${chevron(16)}</button>
            ${manual ? `<div class="reveal" style="display:flex;flex-direction:column;gap:16px">
                <label class="field">Web UI address<input class="input mono" data-k="qbUrl" value="${esc(s.qbUrl)}" spellcheck="false"></label>
                <div class="fields"><label class="field">Username<input class="input" data-k="qbUser" value="${esc(s.qbUser)}" autocomplete="off"></label>
                <label class="field">Password<input class="input" type="password" data-k="qbPass" value="${esc(s.qbPass)}" autocomplete="off"></label></div></div>` : ''}
            <p class="desc" style="margin:0;font-size:14px;line-height:1.55">RaveBSD has to see qBittorrent's finished files to rename them, so share the downloads folder between both containers, for example <span class="mono" style="font-size:13px;color:var(--paper)">/srv/downloads:/downloads</span>.</p>
        </div>` : ''}
        </div>`;
    }
    return `<div class="sstep" data-step>
        <div><h1>Shelves <span class="serif" style="color:#FF9FE8">built.</span></h1>
        <p class="lede" style="margin-top:8px">What you search for is never saved. Settings and logins stay in the data folder on this machine and go nowhere else.</p></div>
        <div class="tiles" data-tiles>
            <div><span>Access</span><b>${s.auth === 'public' ? 'Public, admin ' + esc(s.username || 'admin') : s.auth === 'family' ? 'Friends and family, admin ' + esc(s.username || 'admin') : s.auth === 'pw' ? 'Just me, user ' + esc(s.username || 'admin') : 'Just me, no password'}</b></div>
            <div><span>Shelves</span><b class="mono">${priv(esc(s.ebookDir))} · ${priv(esc(s.audioDir))}</b></div>
            <div><span>eBooks named</span><b class="mono">${esc(s.ebookTemplate)}</b></div>
            <div><span>Magnets go to</span><b>${s.qb ? 'qBittorrent' : 'Nothing yet'}</b></div></div>
        <div class="dash">${icon('shield', 22)}<span>Want searches and downloads to leave through a VPN? Route them through Gluetun any time in the admin panel, under VPN tunnel.</span></div>
        ${s.error ? `<p class="err" role="alert">${esc(s.error)}</p>` : ''}
        </div>`;
}

function draw(first) {
    const s = st;
    root.innerHTML = `<div class="setup">
        <div class="lockup"><img class="a" src="/img/lockup-happy-reading.png" alt="Happy reading!"><img class="b" src="/img/lockup-book-search.png" alt="" aria-hidden="true"></div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:12px">
            <div class="sbars" aria-hidden="true">${COLOURS.map((c, i) => `<span data-bar="${i + 1}" style="height:${HEIGHTS[i]}px;${s.step > i ? 'background:' + c : ''}"></span>`).join('')}</div>
            <span class="label" style="font-size:13px;color:var(--text2)">First run · step ${s.step} of 4</span></div>
        <section class="scard" data-card aria-live="polite">${stepHtml()}
            <div class="snav"><div>${s.step > 1 ? '<button type="button" class="btn outline lg" data-act="back" style="padding:0 28px;font-size:17px">Back</button>' : ''}</div>
            <div>${s.step < 4 ? '<button type="button" class="btn yellow lg" data-act="next">Next</button>' : '<button type="button" class="btn pink lg" data-act="finish" data-cta>Let&rsquo;s go</button>'}</div></div>
        </section></div>`;
    root.onclick = onClick;
    root.oninput = onInput;
    const E = 'cubic-bezier(.22,.9,.24,1)';
    if (first) {
        $$('[data-bar]').forEach((b, i) => anim(b, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 560, delay: 150 + i * 90, easing: 'cubic-bezier(.3,1.5,.5,1)', fill: 'backwards' }));
        anim($('[data-card]'), [{ opacity: 0, transform: 'translateY(28px)' }, { opacity: 1, transform: 'none' }], { duration: 680, delay: 260, fill: 'backwards' });
    } else {
        const step = $('[data-step]');
        anim(step, [{ opacity: 0, transform: `translateX(${48 * st.dir}px)` }, { opacity: 1, transform: 'none' }], { duration: 440 });
        [...step.children].forEach((c, i) => anim(c, [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }], { duration: 440, delay: i * 70, fill: 'backwards' }));
        if (st.dir > 0) anim($(`[data-bar="${s.step}"]`), [{ transform: 'scaleY(.3)' }, { transform: 'scaleY(1.18)' }, { transform: 'scaleY(1)' }], { duration: 560, easing: E });
        const h = $('[data-step] h1'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    }
    if (s.step === 4) {
        $$('[data-tiles] > div').forEach((t, i) => anim(t, [{ opacity: 0, transform: 'translateY(-18px)' }, { opacity: 1, transform: 'none' }], { duration: 460, delay: 320 + i * 90, fill: 'backwards' }));
        $$('[data-bar]').forEach((b, i) => anim(b, [{ transform: 'none' }, { transform: 'translateY(-14px)' }, { transform: 'none' }], { duration: 520, delay: 650 + i * 90 }));
        anim($('[data-cta]'), [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: 1100, delay: 1150 });
    }
}
const redraw = () => draw(false);
function onInput(e) {
    const k = e.target.dataset.k; if (!k) return;
    st[k] = e.target.value;
    if (k === 'ebookDir' || k === 'audioDir') checkFolders();
    if (k === 'ebookDir' || k === 'ebookTemplate') { const sl = $('#slip b'); if (sl) sl.innerHTML = privPath(sample()); }
    if (k.startsWith('qb') && st.qbt !== 'idle') { st.qbt = 'idle'; }
}
async function onClick(e) {
    const t = e.target.closest('[data-act]'); if (!t) return;
    const s = st;
    switch (t.dataset.act) {
        case 'auth': s.auth = t.dataset.v; draw(false); anim($(`[data-v="${s.auth}"]`), [{ transform: 'scale(.97)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }], { duration: 320 }); if (s.auth !== 'none') $('#pwf input').focus(); else $(`[data-v="${s.auth}"]`).focus({ preventScroll: true }); return;
        case 'names': s.names = !s.names; return partial();
        case 'qb': s.qb = !s.qb; return partial();
        case 'qbmanual': s.qbManual = !(s.qbManual || s.qbt === 'failed'); if (s.qbt === 'failed' && !s.qbManual) s.qbt = 'idle'; return partial();
        case 'qbtest': {
            s.qbt = 'testing'; partial();
            const body = { url: s.qbUrl };
            if (s.qbUser) body.username = s.qbUser;
            if (s.qbPass) body.password = s.qbPass;
            const r = await api('/api/qbit/test', { body }).catch(err => ({ ok: false, error: err.message }));
            s.qbt = r.ok ? 'found' : 'failed'; s.qbVersion = r.version || ''; s.qbError = r.ok ? '' : r.error;
            partial();
            const again = $('[data-act="qbtest"]'); if (again) again.focus({ preventScroll: true });
            if (r.ok) anim($('#qbstat'), [{ transform: 'scale(.98)' }, { transform: 'scale(1.02)' }, { transform: 'scale(1)' }], { duration: 380 });
            return;
        }
        case 'back': s.step--; s.dir = -1; return redraw();
        case 'next': {
            if (s.step === 1 && s.auth !== 'none') {
                if (s.password.length < 8) return flash('Use at least 8 characters for the password.');
                if (s.password !== s.password2) return flash('The two passwords are different.');
            }
            s.step++; s.dir = 1; return redraw();
        }
        case 'finish': {
            t.disabled = true;
            try {
                await api('/api/setup', { body: {
                    mode: s.auth === 'public' || s.auth === 'family' ? s.auth : 'private',
                    admin: s.auth !== 'none' ? { username: s.username, password: s.password } : null,
                    shelves: { ebookDir: s.ebookDir, audioDir: s.audioDir, ebookTemplate: s.ebookTemplate, audioTemplate: s.audioTemplate },
                    qbit: s.qb ? { enabled: true, url: s.qbUrl, ...(s.qbUser ? { username: s.qbUser } : {}), ...(s.qbPass ? { password: s.qbPass } : {}) } : { enabled: false },
                } });
                history.replaceState(null, '', '/');
                done();
            } catch (err) { s.error = err.message; redraw(); }
            return;
        }
    }
}
// Re-draws the step without the slide-in, for disclosures inside it.
function partial() {
    const step = $('[data-step]'), was = document.activeElement && document.activeElement.dataset.act;
    const tmp = document.createElement('div'); tmp.innerHTML = stepHtml();
    step.replaceWith(tmp.firstElementChild);
    // The pressed switch or disclosure is drawn again; keep the keyboard on it.
    const again = was && $(`[data-step] [data-act="${was}"]`); if (again) again.focus({ preventScroll: true });
}
function flash(msg) {
    let p = $('#setup-err');
    if (!p) { p = document.createElement('p'); p.id = 'setup-err'; p.className = 'err'; p.setAttribute('role', 'alert'); $('[data-step]').appendChild(p); }
    p.textContent = msg;
}
