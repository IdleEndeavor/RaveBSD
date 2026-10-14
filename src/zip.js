// Streams a folder as a .zip without compressing (audio is already compressed), so an audiobook folder
// can be saved to a device as one file. No dependency: the format is simple when nothing is compressed.
// ponytail: no ZIP64, so files over 4 GB (or archives over 4 GB) are not supported; add ZIP64 records if that matters.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// Same order as localeCompare(b, undefined, { numeric: true }), which builds a new collator on every call
// (about a quarter of a big shelf listing's time went there, through zipSize).
const byName = new Intl.Collator(undefined, { numeric: true }).compare;

export function listFiles(dir, base = dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...listFiles(p, base));
        else if (e.isFile()) out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
    }
    return out.sort((a, b) => byName(a.rel, b.rel));
}

// Writes the zip of `dir` to the writable `out` (an http response). `prefix` is the folder name inside the zip.
export async function zipFolder(dir, out, prefix) {
    const files = listFiles(dir);
    const central = [];
    let offset = 0;
    // Waits for the socket to take more. If the device hangs up, stop instead of waiting forever.
    const write = async buf => {
        if (out.destroyed) throw new Error('closed');
        offset += buf.length;
        if (!out.write(buf)) await new Promise(res => { const done = () => { out.off('drain', done); out.off('close', done); res(); }; out.on('drain', done); out.on('close', done); });
    };
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
        const name = Buffer.from((prefix ? prefix + '/' : '') + f.rel, 'utf8');
        const start = offset;
        // Flag 0x0808: sizes follow the data (data descriptor) and the name is UTF-8.
        await write(Buffer.concat([u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(dosTime), u16(dosDate), u32(0), u32(0), u32(0), u16(name.length), u16(0), name]));
        let crc = 0, size = 0;
        for await (const chunk of fs.createReadStream(f.abs)) { crc = zlib.crc32(chunk, crc); size += chunk.length; await write(chunk); }
        await write(Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]));
        central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(size), u32(size),
            u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(start), name]));
    }
    const cdStart = offset;
    const cd = Buffer.concat(central);
    await write(cd);
    await write(Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cd.length), u32(cdStart), u16(0)]));
}

// Size of the zip zipFolder will write, for the "Save as .zip · 412 MB" label and Content-Length.
export function zipSize(dir, prefix) {
    let total = 22;
    for (const f of listFiles(dir)) {
        const n = Buffer.byteLength((prefix ? prefix + '/' : '') + f.rel, 'utf8');
        total += 30 + n + fs.statSync(f.abs).size + 16 + 46 + n;
    }
    return total;
}

// Unpacks a downloaded .zip (LibriVox and Internet Archive hand out audiobooks as one) into `dest`. Stored
// and deflated entries; names that would land outside `dest` are skipped. Returns the paths written.
// ponytail: no ZIP64 here either, so a zip over 4 GB fails; add the ZIP64 end record if one turns up.
// maxBytes caps what it may write in total (a small zip can unpack to something huge).
export async function extractZip(file, dest, maxBytes = Infinity) {
    const fd = await fs.promises.open(file, 'r');
    try {
        const { size } = await fd.stat();
        const tailLen = Math.min(size, 65557);
        const tail = Buffer.alloc(tailLen);
        await fd.read(tail, 0, tailLen, size - tailLen);
        const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        if (eocd < 0) throw new Error('Not a zip file');
        const count = tail.readUInt16LE(eocd + 10), cdLen = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
        if (cdLen > 64e6 || cdOff + cdLen > size) throw new Error('This zip looks damaged');
        let written = 0;
        const cd = Buffer.alloc(cdLen);
        await fd.read(cd, 0, cdLen, cdOff);
        const out = [];
        for (let p = 0, n = 0; n < count && cd.readUInt32LE(p) === 0x02014b50; n++) {
            const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20);
            const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32), local = cd.readUInt32LE(p + 42);
            const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
            p += 46 + nameLen + extraLen + commentLen;
            const target = path.resolve(dest, name);
            if (name.endsWith('/') || !target.startsWith(path.resolve(dest) + path.sep) || (method !== 0 && method !== 8)) continue;
            const head = Buffer.alloc(30);
            await fd.read(head, 0, 30, local);
            const start = local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
            await fs.promises.mkdir(path.dirname(target), { recursive: true });
            const src = fs.createReadStream(null, { fd: fd.fd, autoClose: false, start, end: start + csize - 1 });
            await new Promise((ok, no) => {
                const w = fs.createWriteStream(target).on('finish', ok).on('error', no);
                const body = method === 8 ? src.pipe(zlib.createInflateRaw()).on('error', no) : src;
                body.on('data', c => { written += c.length; if (written > maxBytes) { body.destroy(); w.destroy(); no(new Error('The zip unpacks to more than there is room for')); } });
                body.pipe(w);
                src.on('error', no);
            });
            out.push(target);
        }
        return out;
    } finally { await fd.close(); }
}
