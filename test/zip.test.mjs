// zipFolder output unpacks with extractZip, and an entry naming a path outside the folder is skipped.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipFolder, extractZip, listFiles } from '../src/zip.js';

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rbsd-zip-'));
fs.mkdirSync(path.join(d, 'src/disc 2'), { recursive: true });
fs.writeFileSync(path.join(d, 'src/01.mp3'), 'A'.repeat(5000));
fs.writeFileSync(path.join(d, 'src/disc 2/02.mp3'), 'B'.repeat(7));
const out = fs.createWriteStream(path.join(d, 'book.zip'));
await zipFolder(path.join(d, 'src'), out, 'book');
await new Promise(r => out.end(r));
const got = (await extractZip(path.join(d, 'book.zip'), path.join(d, 'x'))).map(p => path.relative(d, p) + ':' + fs.statSync(p).size);
assert.deepEqual(got, ['x/book/01.mp3:5000', 'x/book/disc 2/02.mp3:7']);
// A stored entry named "../evil.mp3": hand-built so the name survives.
const name = Buffer.from('../evil.mp3'), data = Buffer.from('x');
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }, u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u32(0), u32(0), u32(1), u32(1), u16(name.length), u16(0), name, data]);
const cd = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u32(0), u32(0), u32(1), u32(1), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
fs.writeFileSync(path.join(d, 'evil.zip'), Buffer.concat([local, cd, u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(cd.length), u32(local.length), u16(0)]));
assert.deepEqual(await extractZip(path.join(d, 'evil.zip'), path.join(d, 'y')), []);
// Tracks in number order (2 before 10), as players expect.
fs.mkdirSync(path.join(d, 'n'));
for (const f of ['10.mp3', '2.mp3']) fs.writeFileSync(path.join(d, 'n', f), '');
assert.deepEqual(listFiles(path.join(d, 'n')).map(f => f.rel), ['2.mp3', '10.mp3']);
fs.rmSync(d, { recursive: true, force: true });
console.log('zip: ok');
