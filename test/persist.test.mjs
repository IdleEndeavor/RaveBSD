// Saved files: a damaged settings.json or shelf.json must never look like a first run. Each case loads the
// modules in a fresh process with its own data folder, since they read their files once, on import.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsd-persist-'));
const src = new URL('../src/', import.meta.url).href;
const run = (dir, code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
const folder = name => { const d = path.join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };

// A save leaves the previous copy as .bak, and a damaged file falls back to it.
{
    const dir = folder('bak');
    let r = run(dir, `const c = await import('${src}config.js'); c.settings.setupDone = true; c.saveSettings(); c.settings.statsEnabled = false; c.saveSettings();`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8')).setupDone, true, 'the previous copy is kept');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"setupDone": tr');
    r = run(dir, `const c = await import('${src}config.js'); console.log(JSON.stringify({ done: c.settings.setupDone }));`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).done, true, 'settings come back from the .bak');
    assert.ok(fs.readdirSync(dir).some(f => f.startsWith('settings.json.corrupt-')), 'the damaged file is set aside');
    // The good copy is back under its own name, so the next start (before any save) is not a first run.
    r = run(dir, `const c = await import('${src}config.js'); console.log(JSON.stringify({ done: c.settings.setupDone }));`);
    assert.equal(JSON.parse(r.stdout.trim().split('\n').pop()).done, true, 'a second start after a recovery still has the settings');
    console.log('damaged settings fall back to the last good copy: ok');
}

// No good copy at all: the server refuses to start rather than offer the first-run setup to whoever comes.
{
    const dir = folder('nobak');
    fs.writeFileSync(path.join(dir, 'settings.json'), '');
    const r = run(dir, `const c = await import('${src}config.js'); console.log('started', c.settings.setupDone);`);
    assert.notEqual(r.status, 0, 'does not start');
    assert.ok(!/started/.test(r.stdout), 'never reaches the first-run state');
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '', 'the file is left for the owner to look at');
    console.log('unreadable settings stop the server: ok');
}

// A damaged shelf.json is set aside, not overwritten by the next save.
{
    const dir = folder('shelf');
    fs.mkdirSync(path.join(dir, 'books'));
    fs.writeFileSync(path.join(dir, 'shelf.json'), '{"items": [');
    const r = run(dir, `const j = await import('${src}jobs.js'); console.log(JSON.stringify({ n: j.listShelf({ role: 'admin' }).length })); process.exit(0);`);
    assert.equal(r.status, 0, r.stderr);
    const aside = fs.readdirSync(dir).find(f => f.startsWith('shelf.json.corrupt-'));
    assert.ok(aside, 'the damaged shelf is set aside');
    assert.equal(fs.readFileSync(path.join(dir, aside), 'utf8'), '{"items": [');
    console.log('damaged shelf is kept aside: ok');
}

// A shelf that cannot be read (wrong owner after a volume change) is not damaged: it is left alone, not emptied.
if (process.getuid && process.getuid() !== 0) {
    const dir = folder('perm');
    fs.mkdirSync(path.join(dir, 'books'));
    fs.writeFileSync(path.join(dir, 'shelf.json'), '{"items": []}', { mode: 0 });
    const r = run(dir, `await import('${src}jobs.js'); console.log('started'); process.exit(0);`);
    fs.chmodSync(path.join(dir, 'shelf.json'), 0o600);
    assert.notEqual(r.status, 0, 'does not start');
    assert.equal(fs.readFileSync(path.join(dir, 'shelf.json'), 'utf8'), '{"items": []}', 'the file is untouched');
    assert.ok(!fs.readdirSync(dir).some(f => f.includes('.corrupt-')), 'nothing set aside');
    console.log('unreadable shelf stops the server: ok');
}

fs.rmSync(root, { recursive: true, force: true });
