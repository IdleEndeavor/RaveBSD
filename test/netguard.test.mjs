// Checks that scraped links can never reach private addresses. Run: node test/netguard.test.mjs
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl } from '../src/netguard.js';
for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:192.168.0.1', '0.0.0.0']) assert.ok(isPrivateIp(ip), ip);
for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/'));
await assert.rejects(assertPublicUrl('http://localhost/'));
await assert.rejects(assertPublicUrl('file:///etc/passwd'));
console.log('netguard: ok');

// The address checked is the one connected to: a name that answers a public address and then a private one (DNS
// rebinding) never reaches the private one. 192.0.2.1 is public as far as the check knows, and goes nowhere.
{
    const http = await import('node:http');
    const zlib = await import('node:zlib');
    const dns = (await import('node:dns/promises')).default;
    const { fetchPublic, pinnedFetch } = await import('../src/netguard.js');
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits++;
        if (req.url === '/gz') { res.writeHead(200, { 'Content-Encoding': 'gzip', 'Set-Cookie': ['a=1', 'b=2'] }); return res.end(zlib.gzipSync('hello')); }
        if (req.url === '/moved') { res.writeHead(302, { Location: '/gz' }); return res.end('elsewhere'); }
        if (req.url === '/empty') { res.writeHead(204); return res.end(); }
        if (req.url === '/slow') { res.writeHead(200); res.write('a'); return; }
        res.end('ok');
    });
    await new Promise(ok => server.listen(0, '127.0.0.1', ok));
    const port = server.address().port;

    const real = dns.lookup;
    let lookups = 0;
    dns.lookup = async () => (++lookups === 1 ? [{ address: '192.0.2.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
    await assert.rejects(fetchPublic(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }));
    dns.lookup = real;
    assert.equal(hits, 0, 'a name that changes its answer never reaches the private address');
    assert.equal(lookups, 1, 'the name is looked up once');

    await assert.rejects(fetchPublic(`http://localhost:${port}/`), /private network/);
    await assert.rejects(fetchPublic(`http://127.0.0.1:${port}/`), /private network/);
    await assert.rejects(fetchPublic(`http://[::ffff:127.0.0.1]:${port}/`), /private network/);
    assert.equal(hits, 0, 'private names and addresses are refused before connecting');

    // The same client with every address allowed, for what it does besides checking.
    const any = () => true, base = `http://localhost:${port}`;
    const gz = await pinnedFetch(base + '/gz', { headers: { 'User-Agent': 'test' } }, any);
    assert.equal(gz.status, 200);
    assert.equal(await gz.text(), 'hello', 'compressed answers come out plain');
    assert.deepEqual(gz.headers.getSetCookie(), ['a=1', 'b=2']);
    const moved = await pinnedFetch(base + '/moved', {}, any);
    assert.equal(moved.status, 302, 'redirects are left to fetchPublic');
    assert.equal(moved.headers.get('location'), '/gz');
    await moved.body.cancel();
    assert.equal((await pinnedFetch(base + '/empty', {}, any)).body, null);
    const ctrl = new AbortController(), slow = await pinnedFetch(base + '/slow', { signal: ctrl.signal }, any);
    const reader = slow.body.getReader();
    await reader.read();
    ctrl.abort(new Error('The site stopped sending'));
    await assert.rejects(reader.read(), /stopped sending/, 'an abort mid-body rejects with its reason');
    await assert.rejects(pinnedFetch(base + '/', { signal: AbortSignal.abort(new Error('gone')) }, any), /gone/);
    // What a hostile site can answer: odd statuses, a protocol switch, a connection cut mid-body, stacked codings.
    const net = await import('node:net');
    const raw = net.createServer(sock => sock.once('data', d => {
        const path = String(d).split(' ')[1];
        if (path === '/cut') { sock.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc'); return setTimeout(() => sock.destroy(), 50); }
        if (path === '/stack') { const b = zlib.gzipSync(zlib.brotliCompressSync('two')); sock.write(`HTTP/1.1 200 OK\r\nContent-Encoding: br, gzip\r\nContent-Length: ${b.length}\r\n\r\n`); return sock.end(b); }
        sock.end({ '/205': 'HTTP/1.1 205 Reset\r\nContent-Length: 2\r\n\r\nhi', '/999': 'HTTP/1.1 999 X\r\nContent-Length: 0\r\n\r\n', '/101': 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n' }[path]);
    }));
    await new Promise(ok => raw.listen(0, '127.0.0.1', ok));
    const rb = `http://localhost:${raw.address().port}`;
    assert.equal((await pinnedFetch(rb + '/205', {}, any)).body, null, '205 has no body');
    await assert.rejects(pinnedFetch(rb + '/999', {}, any), TypeError, 'a status out of range is a failed fetch, not a crash');
    await assert.rejects(pinnedFetch(rb + '/101', { signal: AbortSignal.timeout(2000) }, any), e => e instanceof TypeError, 'a protocol switch fails');
    const cut = await pinnedFetch(rb + '/cut', {}, any);
    await assert.rejects(cut.text(), e => e instanceof TypeError && !!e.cause, 'a cut connection rejects like fetch()');
    assert.equal(await (await pinnedFetch(rb + '/stack', {}, any)).text(), 'two', 'stacked codings are undone in order');
    raw.close();
    server.close();
    await assert.rejects(pinnedFetch(base + '/', {}, any), e => e instanceof TypeError && !!e.cause.code, 'network errors look like fetch()\'s');
    console.log('netguard pinned fetch: ok');
}

// IPv6 spellings of private IPv4 addresses (as new URL() writes them) are private too.
{
    const { isPrivateIp: priv } = await import('../src/netguard.js');
    for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '::', '::1', 'fe80::1%eth0', 'fec0::1', '2001:db8::1', '2001:0:4136:e378::1'])
        assert.ok(priv(ip), ip);
    for (const ip of ['2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808', '2a00:1450:4009:81f::200e']) assert.ok(!priv(ip), ip);
    console.log('netguard ipv6: ok');
}

// Bodies are read up to a limit and no further, whether or not the site says how big they are.
{
    const { readCapped } = await import('../src/netguard.js');
    assert.equal((await readCapped(new Response('x'.repeat(100)), 100)).length, 100);
    await assert.rejects(readCapped(new Response('x'.repeat(101)), 100), /Too big/);
    await assert.rejects(readCapped(new Response('x', { headers: { 'Content-Length': '999' } }), 100), /Too big/, 'a declared size over the limit is refused unread');
    let pulled = 0;
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1000)); } });
    await assert.rejects(readCapped(new Response(endless), 5000), /Too big/);
    assert.ok(pulled < 10, 'an endless body stops being read at the limit');
    console.log('netguard readCapped: ok');
}
