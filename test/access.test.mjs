// Access modes: who may reach what, and how visitors share and lose books. Starts throwaway servers on spare
// ports with their own data folders; nothing here touches the network except Gutenberg-free local routes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsd-access-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Part 1: visitors in one process (no server): sharing, privacy, expiry ────
{
    process.env.DATA_DIR = path.join(root, 'jobs');
    fs.mkdirSync(path.join(process.env.DATA_DIR, 'books'), { recursive: true });
    const { settings } = await import('../src/config.js');
    const jobs = await import('../src/jobs.js');
    const { registerResult } = await import('../src/sources.js');
    settings.access.mode = 'public';
    const file = path.join(settings.shelves.ebookDir, 'A - Book.epub');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1000));
    const A = { role: 'visitor', vid: 'a'.repeat(24) }, B = { role: 'visitor', vid: 'b'.repeat(24) }, C = { role: 'visitor', vid: 'c'.repeat(24) };
    jobs.shelfRestore({ items: [{ id: 'aaaa0001', kind: 'ebook', title: 'Book', author: 'A', format: 'epub', size: 1000, path: file, fp: 'md5:' + 'f'.repeat(32),
        visitorsOnly: true, owners: [{ id: A.vid, at: Date.now(), savedAt: 0 }], addedAt: Date.now(), savedAt: 0, removedAt: 0 }] });
    const r = { title: 'Book', author: 'A', format: 'epub', source: 'Library Genesis', md5: 'F'.repeat(32), directUrl: 'https://libgen.example/get.php?md5=x' };
    registerResult(r, 'ebooks');
    assert.equal(jobs.listShelf(B).length, 0, 'B cannot see A\'s book');
    const got = await jobs.startDownload(r.id, '', B);
    assert.equal(got.shelfId, 'aaaa0001', 'B is handed the copy already on the server');
    assert.equal(jobs.listShelf(B).length, 1);
    assert.equal(jobs.listShelf(C).length, 0, 'C still sees nothing');
    await jobs.deleteItems(['aaaa0001'], A);
    assert.ok(fs.existsSync(file), 'A letting go keeps the file while B holds it');
    await jobs.tidy(Date.now() + (settings.visitors.keepDays + 1) * 864e5);
    assert.ok(!fs.existsSync(file), 'once B\'s copy expires the file goes');
    assert.equal(jobs.listShelf({ role: 'admin' }).length, 0);
    console.log('visitors share and expire: ok');
}
// Saves, "On the shelf" and tidying, in the same process.
{
    const { settings, statsFor } = await import('../src/config.js');
    const jobs = await import('../src/jobs.js');
    const saved = () => statsFor('all').saved;
    const file = path.join(settings.shelves.ebookDir, 'B', 'Saved.epub');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x'.repeat(1000));
    const V = { role: 'visitor', vid: 'd'.repeat(24) }, W = { role: 'visitor', vid: 'e'.repeat(24) }, admin = { role: 'admin' };
    jobs.shelfRestore({ items: [{ id: 'bbbb0001', kind: 'ebook', title: 'Saved', author: 'B', format: 'epub', size: 1000, path: file, addedAt: Date.now(), savedAt: 0, removedAt: 0,
        owners: [{ id: V.vid, at: Date.now(), savedAt: 0 }] }] });
    const item = jobs.getItem('bbbb0001'), n = saved();
    jobs.markSaved(item, admin); jobs.markSaved(item, admin);
    assert.equal(saved(), n + 1, 'saving a book again does not count again');
    jobs.markSaved(item, V); jobs.markSaved(item, V);
    assert.equal(saved(), n + 2, 'a visitor\'s first save of their copy counts once');
    // A cached search answer said "not on the shelf"; the shelf as it is now decides.
    const r = { id: 'stale', kind: 'ebook', title: 'Saved', author: 'B', onShelf: false };
    assert.equal(jobs.liveMarks(admin, r).onShelf, true, 'on the shelf now, whatever the cache said');
    assert.equal(jobs.liveMarks(V, r).onShelf, true, 'the visitor holds it');
    assert.equal(jobs.liveMarks(W, r).onShelf, false, 'another visitor does not');
    fs.rmSync(file); jobs.checkMoved();
    assert.equal(jobs.onShelfFor(admin, { ...r, onShelf: true }), false, 'a moved book is not on the shelf');
    // "Remove from the server once saved" takes the empty author folder with the file, like Delete does.
    const old = path.join(settings.shelves.ebookDir, 'C', 'Gone.epub');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, 'x'.repeat(1000));
    jobs.shelfRestore({ items: [{ id: 'cccc0001', kind: 'ebook', title: 'Gone', author: 'C', format: 'epub', size: 1000, path: old, addedAt: 0, savedAt: Date.now() - 2 * 864e5, removedAt: 0 }] });
    settings.storage.removeAfterSaved = true;
    await jobs.tidy();
    settings.storage.removeAfterSaved = false;
    assert.ok(!fs.existsSync(path.dirname(old)), 'no empty author folder left behind');
    console.log('saves, shelf marks, tidy: ok');
}
// Letting go of a download stops it; only its owner may; Z-Library stays the owner's.
{
    const { settings } = await import('../src/config.js');
    const jobs = await import('../src/jobs.js');
    const { registerResult } = await import('../src/sources.js');
    settings.qbit.directSlots = 0; // nothing starts, so nothing reaches the network
    const admin = { role: 'admin' }, V = { role: 'visitor', vid: 'f'.repeat(24) };
    const U1 = { role: 'user', user: { id: 'u1' } }, U2 = { role: 'user', user: { id: 'u2' } };
    const result = (title, directUrl) => { const r = { title, author: 'T', format: 'epub', filesize: 1000, source: 'Test', directUrl }; registerResult(r, 'ebooks'); return r; };
    const ids = () => jobs.listJobs(admin).map(j => j.id);

    const a = await jobs.startDownload(result('Forgotten', 'https://files.example/a.epub').id, '', V);
    assert.ok(ids().includes(a.id), 'the visitor\'s download is queued');
    jobs.forget(a.id, V);
    assert.ok(!ids().includes(a.id), 'forgetting it stops it instead of leaving it to finish with no owner');

    const shared = result('Shared', 'https://files.example/s.epub');
    const s = await jobs.startDownload(shared.id, '', admin);
    assert.equal((await jobs.startDownload(shared.id, '', V)).id, s.id, 'the visitor joins the admin\'s download');
    jobs.forget(s.id, V);
    assert.ok(ids().includes(s.id), 'a visitor letting go does not stop the admin\'s download');
    jobs.forget(s.id, admin);

    await assert.rejects(jobs.startDownload(result('Zlib','/dl/zlib?id=1&hash=x').id, '', V), /for the owner/, 'visitors cannot spend the owner\'s Z-Library limit');

    const b = await jobs.startDownload(result('Theirs', 'https://files.example/b.epub').id, '', U1);
    jobs.forget(b.id, U2);
    assert.ok(ids().includes(b.id), 'a family user cannot forget someone else\'s download');
    jobs.forget(b.id, U1);
    assert.ok(!ids().includes(b.id), 'its owner can');
    settings.qbit.directSlots = 2;
    console.log('forget stops downloads: ok');
}
// Two downloads at once never land on the same file.
{
    const { settings } = await import('../src/config.js');
    const jobs = await import('../src/jobs.js');
    const { registerResult } = await import('../src/sources.js');
    settings.qbit.directSlots = 0;
    const admin = { role: 'admin' };
    const r = { title: 'Twice', author: 'T', format: 'epub', source: 'Test', directUrl: 'https://files.example/t.epub' };
    registerResult(r, 'ebooks');
    const [x, y] = await Promise.all([jobs.startDownload(r.id, '', admin), jobs.startDownload(r.id, '', admin)]);
    assert.equal(x.id, y.id, 'a double click starts one download');
    jobs.forget(x.id, admin);
    settings.qbit.directSlots = 2;

    const tmp = fs.mkdtempSync(path.join(root, 'filing-'));
    const job = n => ({ id: 'race' + n, kind: 'ebook', title: 'Race', author: 'R', format: 'epub', how: 'direct', owners: [] });
    const part = n => { const f = path.join(tmp, n + '.part'); fs.writeFileSync(f, String(n).repeat(500)); return f; };
    settings.shelves.duplicate = 'both';
    await Promise.all([jobs.fileIt(job(1), [part(1)]), jobs.fileIt(job(2), [part(2)])]);
    const filed = fs.readdirSync(path.join(settings.shelves.ebookDir, 'R')).filter(f => f.startsWith('Race'));
    assert.equal(filed.length, 2, '"keep both" keeps both, not one written over the other: ' + filed);
    settings.shelves.duplicate = 'skip';
    console.log('downloads never share a file: ok');
}

// ── Part 2: every route, per mode and role ───────────────────────────────────
// seed: a settings.json to start from; setup: false leaves first-run setup undone.
async function start(mode, { name = mode, env: extra = {}, seed, setup: doSetup = true } = {}) {
    const dir = path.join(root, name);
    if (seed) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(seed)); }
    const port = 18000 + Math.floor(Math.random() * 2000);
    const env = { ...process.env, DATA_DIR: dir, BOOKS_DIR: path.join(dir, 'books'), AUDIOBOOKS_DIR: path.join(dir, 'audio'), PORT: String(port), ZLIB_EMAIL: '', ZLIB_PASSWORD: '', PUBLIC_INSTANCE: '', TRUST_PROXY: '', API_KEY: '', USER_AGENT_MODE: '', ...extra };
    const proc = spawn(process.execPath, ['src/server.js'], { env, stdio: 'ignore' });
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch (e) { /* not up */ } await sleep(100); }
    const call = async (method, p, { body, cookie, headers = {} } = {}) => {
        const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
        return { status: res.status, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0], json: await res.json().catch(() => null) };
    };
    // /events as a page opens it: ended() says whether the server closed it within a second.
    const events = async cookie => {
        const ctrl = new AbortController();
        const res = await fetch(base + '/events', { headers: { Cookie: cookie }, signal: ctrl.signal });
        assert.equal(res.status, 200, 'events open');
        const reader = res.body.getReader();
        await reader.read(); // hello
        const ended = () => Promise.race([reader.read().then(r => r.done, () => true), sleep(1000).then(() => false)]);
        return { ended, close: () => ctrl.abort() };
    };
    if (!doSetup) return { proc, call, port, events };
    const setup = await call('POST', '/api/setup', { body: { mode, admin: { username: 'boss', password: 'secret123' }, shelves: {}, qbit: { enabled: false } } });
    assert.equal(setup.status, 200, mode + ' setup');
    return { proc, call, events, admin: setup.cookie, port };
}

const ADMIN_ONLY = [
    ['POST', '/api/settings', { searching: { view: 'list' } }], ['GET', '/api/libraries'], ['POST', '/api/creds', {}], ['POST', '/api/folders', {}],
    ['POST', '/api/qbit/test', {}], ['POST', '/api/keys', { label: 'x' }], ['GET', '/api/backup'], ['POST', '/api/restore', {}], ['GET', '/api/stats'],
    ['POST', '/api/mode', { mode: 'private' }], ['POST', '/api/users', { username: 'x', password: 'xxxx' }], ['POST', '/browser/verify', {}],
    ['GET', '/dl/zlib?id=1&hash=a'], ['POST', '/api/slum'], ['GET', '/api/update'], ['GET', '/api/connection'],
];
const OPEN = [['GET', '/api/settings'], ['GET', '/api/status'], ['GET', '/api/shelf'], ['GET', '/resolve?id=nope']];

for (const mode of ['public', 'family']) {
    const s = await start(mode, { env: mode === 'public' ? { TRUST_PROXY: '1' } : {} });
    try {
        const roles = {};
        if (mode === 'public') roles.visitor = (await s.call('GET', '/api/session')).cookie;
        else {
            await s.call('POST', '/api/users', { body: { username: 'kid', password: 'password1' }, cookie: s.admin });
            roles.user = (await s.call('POST', '/api/login', { body: { username: 'kid', password: 'password1' } })).cookie;
            roles.none = '';
        }
        for (const [role, cookie] of Object.entries(roles)) {
            const denied = role === 'none' ? 401 : 403;
            for (const [m, p, body] of ADMIN_ONLY) assert.equal((await s.call(m, p, { body, cookie })).status, denied, `${mode} ${role} ${m} ${p}`);
            for (const [m, p] of OPEN) {
                const r = await s.call(m, p, { cookie });
                if (role === 'none') assert.equal(r.status, 401, `${mode} none ${p}`);
                else assert.ok(r.status !== 401 && r.status !== 403, `${mode} ${role} ${p} -> ${r.status}`);
            }
            if (role !== 'none') {
                const st = (await s.call('GET', '/api/settings', { cookie })).json;
                assert.ok(!st.shelves.ebookDir && !st.qbit.url && !st.access.apiKeys, `${mode} ${role} sees no folders, addresses or keys`);
            }
        }
        // Admins reach the admin routes.
        assert.equal((await s.call('GET', '/api/libraries', { cookie: s.admin })).status, 200, mode + ' admin');
        assert.ok((await s.call('GET', '/api/settings', { cookie: s.admin })).json.shelves.ebookDir, mode + ' admin sees folders');
        // A settings patch cannot reopen setup (which would make everyone the admin).
        await s.call('POST', '/api/settings', { body: { setupDone: false }, cookie: s.admin });
        assert.equal((await s.call('GET', '/api/session')).json.setupDone, true, mode + ' setupDone is not a setting');
        if (mode === 'public') {
            assert.equal((await s.call('POST', '/api/keys', { body: { label: 'x' }, cookie: s.admin })).status, 403, 'no API keys on a public instance');
            assert.equal((await s.call('GET', '/api/v1/search?q=x')).status, 404, 'no API on a public instance');
            assert.equal((await s.call('POST', '/api/password', { body: { on: false }, cookie: s.admin })).status, 400, 'public keeps its admin');
            // Behind a proxy the address is the last X-Forwarded-For entry; the ones before it are the client's to make up.
            const fresh = i => s.call('GET', '/api/session', { headers: { 'X-Forwarded-For': `10.9.${i}.1, 203.0.113.9` } });
            for (let i = 0; i < 10; i++) assert.equal((await fresh(i)).status, 200);
            assert.equal((await fresh(10)).status, 429, 'a made-up first X-Forwarded-For entry is not a new address');
        } else {
            // API keys: a signed-in account needs none, nobody else gets in without one.
            assert.equal((await s.call('GET', '/api/v1/search')).status, 401, 'family: no key, no session');
            assert.equal((await s.call('GET', '/api/v1/search', { cookie: roles.user })).status, 400, 'family: a signed-in user needs no key');
            // Leftover user accounts gain nothing when the mode changes, even with a session from before.
            await s.call('POST', '/api/mode', { body: { mode: 'private' }, cookie: s.admin });
            assert.equal((await s.call('GET', '/api/libraries', { cookie: roles.user })).status, 401, 'family user is not an admin in private mode');
            assert.equal((await s.call('POST', '/api/login', { body: { username: 'kid', password: 'password1' } })).status, 403, 'user accounts cannot sign in outside family mode');
            await s.call('POST', '/api/mode', { body: { mode: 'public' }, cookie: s.admin });
            assert.equal((await s.call('GET', '/api/libraries', { cookie: roles.user })).status, 403, 'family user is only a visitor in public mode');
            assert.equal((await s.call('GET', '/api/session', { cookie: roles.user })).json.role, 'visitor');
            await s.call('POST', '/api/mode', { body: { mode: 'family' }, cookie: s.admin });
            assert.equal((await s.call('GET', '/api/session', { cookie: roles.user })).json.role, 'user', 'back in family mode the account works again');
            // Sign out everywhere: the kid's session ends, the admin who asked stays in.
            const sw = await s.call('POST', '/api/sessions/end', { cookie: s.admin });
            assert.equal(sw.status, 200);
            assert.equal((await s.call('GET', '/api/shelf', { cookie: roles.user })).status, 401, 'other sessions end');
            assert.equal((await s.call('GET', '/api/shelf', { cookie: s.admin })).status, 401, 'the old admin cookie ends too');
            assert.equal((await s.call('GET', '/api/libraries', { cookie: sw.cookie })).status, 200, 'the fresh cookie works');
            s.admin = sw.cookie;
            roles.user = (await s.call('POST', '/api/login', { body: { username: 'kid', password: 'password1' } })).cookie;
            assert.equal((await s.call('POST', '/api/sessions/end', { cookie: roles.user })).status, 403, 'users cannot');
            // Removing an account ends its sessions, and its open page's live events with them.
            const stream = await s.events(roles.user), adminStream = await s.events(s.admin);
            const kid = (await s.call('GET', '/api/settings', { cookie: s.admin })).json.access.users.find(u => u.username === 'kid');
            await s.call('DELETE', '/api/users/' + kid.id, { cookie: s.admin });
            assert.equal((await s.call('GET', '/api/shelf', { cookie: roles.user })).status, 401, 'removed account signed out');
            assert.equal(await stream.ended(), true, 'the removed account\'s events stop');
            assert.equal(await adminStream.ended(), false, 'the admin\'s carry on');
            adminStream.close();
            // A restore brings back the access mode.
            const backup = (await s.call('GET', '/api/backup', { cookie: s.admin })).json;
            await s.call('POST', '/api/mode', { body: { mode: 'private' }, cookie: s.admin });
            assert.equal((await s.call('POST', '/api/restore', { body: backup, cookie: s.admin })).status, 200);
            assert.equal((await s.call('GET', '/api/session', { cookie: s.admin })).json.mode, 'family', 'restore sets the mode from the backup');
        }
        console.log(mode + ' routes: ok');
    } finally { s.proc.kill(); }
}
// Private mode with no password answers only to names a person would use (DNS rebinding).
{
    const http = await import('node:http');
    const s = await start('private');
    try {
        assert.equal((await s.call('POST', '/api/password', { body: { on: false }, cookie: s.admin })).status, 200);
        const asHost = host => new Promise(ok => http.get({ port: s.port, path: '/api/status', headers: { Host: host, Origin: 'http://' + host } }, r => { r.resume(); ok(r.statusCode); }));
        assert.equal(await asHost('evil.example:' + s.port), 403, 'a rebinding name is refused');
        assert.equal(await asHost('localhost:' + s.port), 200);
        assert.equal(await asHost('nas.local'), 200);
        console.log('private host check: ok');
        // No password, no keys: the API is open. Once a key exists, it is needed, though everyone here is the admin.
        const open = await s.call('GET', '/api/v1/search');
        assert.equal(open.status, 400, 'open API (400: no query)');
        assert.equal(open.headers.get('access-control-allow-origin'), null, 'without a key, other websites cannot read the answers');
        const { key } = (await s.call('POST', '/api/keys', { body: { label: 'script' } })).json;
        assert.equal((await s.call('GET', '/api/v1/search')).status, 401, 'key needed once one exists');
        assert.equal((await s.call('GET', '/api/v1/search', { headers: { 'X-API-Key': 'rbsd_wrong' } })).status, 401, 'wrong key');
        const keyed = await s.call('GET', '/api/v1/search', { headers: { 'X-API-Key': key } });
        assert.equal(keyed.status, 400, 'right key');
        assert.equal(keyed.headers.get('access-control-allow-origin'), '*', 'with a key, scripts on other websites can read them');
        // Scripts on other websites: the preflight answers without a key; the page's own routes stay same-site.
        const pre = await s.call('OPTIONS', '/api/v1/search', { headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-api-key' } });
        assert.equal(pre.status, 204, 'preflight');
        assert.equal(pre.headers.get('access-control-allow-origin'), '*');
        assert.match(pre.headers.get('access-control-allow-headers'), /X-API-Key/i);
        assert.equal((await s.call('OPTIONS', '/search/all')).headers.get('access-control-allow-origin'), null, 'no CORS on the page\'s routes');
        // A restore without an admin cannot switch to a mode that needs one.
        await s.call('POST', '/api/restore', { body: { app: 'RaveBSD', settings: { access: { mode: 'family' } } } });
        assert.equal((await s.call('GET', '/api/session')).json.mode, 'private', 'family needs an admin');
        console.log('API keys and restore: ok');
    } finally { s.proc.kill(); }
}
// Password guessing: a new name for every try does not get past the per-address limit.
{
    const s = await start('family', { name: 'login-limit' });
    try {
        const statuses = [];
        for (let i = 0; i < 31; i++) statuses.push((await s.call('POST', '/api/login', { body: { username: 'guess' + i, password: 'x' } })).status);
        assert.deepEqual([...new Set(statuses.slice(0, 30))], [401], 'wrong guesses are refused');
        assert.equal(statuses[30], 429, 'the 31st try from one address waits, whatever the name');
        const b = await s.call('GET', '/api/backup', { cookie: s.admin });
        assert.equal(b.headers.get('cache-control'), 'no-store', 'the backup, with every secret, is never cached');
        assert.notEqual((await s.call('POST', '/api/backup', { cookie: s.admin })).status, 200, 'and only answers GET');
        console.log('login limit and backup: ok');
    } finally { s.proc.kill(); }
}
// Before setup: an upgraded 1.x install's logins and the server's other routes are out of reach; setup's own work.
{
    const s = await start('private', { name: 'v1', setup: false, seed: { statsEnabled: true, credentials: { zlib: { email: 'someone@example.invalid', password: 'hunter22' } } } });
    try {
        for (const [m, p, body] of [['GET', '/api/backup'], ['GET', '/api/libraries'], ['POST', '/api/creds', {}], ['POST', '/api/settings', {}], ['GET', '/api/stats'],
            ['GET', '/api/status'], ['GET', '/search/all?q=x'], ['GET', '/api/v1/search?q=x'], ['POST', '/api/restore', {}]])
            assert.equal((await s.call(m, p, { body })).status, 403, `before setup ${m} ${p}`);
        assert.equal((await s.call('GET', '/')).status, 200, 'the page loads');
        assert.equal((await s.call('GET', '/api/session')).json.setupDone, false);
        const st = (await s.call('GET', '/api/settings')).json;
        assert.ok(st.shelves.ebookDir && !st.credentials && !st.access.users && !st.qbit.username, 'setup sees folders, nothing else');
        assert.equal((await s.call('POST', '/api/folders', { body: {} })).status, 200);
        const t = await s.call('POST', '/api/qbit/test', { body: { url: 'http://127.0.0.1:9', username: 'x', password: 'y' } });
        assert.equal(t.json.ok, false);
        assert.equal((await s.call('GET', '/api/settings')).json.qbit.url, st.qbit.url, 'testing qBittorrent saves nothing');
        assert.equal((await s.call('POST', '/api/setup', { body: { mode: 'private', shelves: {}, qbit: { enabled: false } } })).status, 200);
        assert.equal((await s.call('GET', '/api/libraries')).status, 200, 'after setup the admin gets in');
        console.log('before setup: ok');
    } finally { s.proc.kill(); }
}
fs.rmSync(root, { recursive: true, force: true });
