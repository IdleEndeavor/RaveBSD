// Torrents across a restart, against a stand-in qBittorrent on a spare local port: jobs caught mid-hand-over
// or mid-filing carry on, and the watcher never runs two rounds at once.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsd-torrents-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = c => c.repeat(40);
const seeded = path.join(root, 'seeded');
fs.mkdirSync(seeded);
for (const n of ['Slow', 'Filing']) fs.writeFileSync(path.join(seeded, n + '.epub'), n.repeat(100));
const torrents = {
    [hash('a')]: { name: 'Slow.epub', progress: 1, state: 'uploading', delay: 3500 }, // slower than one round
    [hash('b')]: { name: 'Filing.epub', progress: 1, state: 'uploading' },
    [hash('c')]: { name: 'Handed.epub', progress: 0.5, state: 'downloading' },
};
let inFlight = 0, most = 0, added = 0;
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=t'); return res.end('Ok.'); }
    if (url.pathname === '/api/v2/torrents/add') { added++; return res.end('Ok.'); }
    if (url.pathname !== '/api/v2/torrents/info') return res.end('');
    const t = torrents[url.searchParams.get('hashes')];
    inFlight++; most = Math.max(most, inFlight);
    if (t && t.delay) await sleep(t.delay);
    inFlight--;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(t ? [{ ...t, save_path: seeded, content_path: path.join(seeded, t.name), size: 400 }] : []));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));

process.env.DATA_DIR = path.join(root, 'data');
fs.mkdirSync(path.join(process.env.DATA_DIR, 'books'), { recursive: true });
fs.writeFileSync(path.join(process.env.DATA_DIR, 'settings.json'), JSON.stringify({
    setupDone: true, qbit: { enabled: true, url: 'http://127.0.0.1:' + server.address().port }, shelves: { duplicate: 'both' } }));
const job = (c, title, state) => ({ id: 'job' + c, how: 'qbit', hash: hash(c), link: 'magnet:?xt=urn:btih:' + hash(c), kind: 'ebook', title, author: 'Q',
    state, progress: 0, bytes: 0, total: 400, owners: [], owner: { type: 'admin' }, addedToQbit: Date.now() });
// As a restart left them: one downloading, one being filed, one being handed to qBittorrent (already there).
fs.writeFileSync(path.join(process.env.DATA_DIR, 'shelf.json'), JSON.stringify({ items: [], jobs: [
    job('a', 'Slow', 'downloading'), job('b', 'Filing', 'renaming'), job('c', 'Handed', 'queued')] }));

const jobs = await import('../src/jobs.js');
await sleep(8000);
const admin = { role: 'admin' };
const titles = jobs.listShelf(admin).map(i => i.title).sort();
assert.deepEqual(titles, ['Filing', 'Slow'], 'both finished torrents are on the shelf, once each: ' + titles);
const left = jobs.listJobs(admin);
assert.equal(left.length, 1);
assert.equal(left[0].state, 'downloading', 'the job caught being handed over is watched again');
assert.equal(added, 0, 'a torrent qBittorrent already has is not added twice');
assert.equal(most, 1, 'the watcher never runs two rounds at once');
const filed = fs.readdirSync(path.join(process.env.DATA_DIR, 'books'), { recursive: true }).filter(f => /\.epub$/.test(f));
assert.equal(filed.length, 2, 'no second copy of a book: ' + filed);
console.log('torrents carry on after a restart: ok');

server.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
