// Checks that scraped links can never reach private addresses. Run: node test/netguard.test.mjs
import assert from 'node:assert/strict';
import { isPrivateIp, assertPublicUrl } from '../src/netguard.js';
for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:192.168.0.1', '0.0.0.0']) assert.ok(isPrivateIp(ip), ip);
for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.ok(!isPrivateIp(ip), ip);
await assert.rejects(assertPublicUrl('http://127.0.0.1:8080/'));
await assert.rejects(assertPublicUrl('http://localhost/'));
await assert.rejects(assertPublicUrl('file:///etc/passwd'));
console.log('netguard: ok');

// IPv6 spellings of private IPv4 addresses (as new URL() writes them) are private too.
{
    const { isPrivateIp: priv } = await import('../src/netguard.js');
    for (const ip of ['::ffff:7f00:1', '::ffff:a00:1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '::', '::1', 'fe80::1%eth0', 'fec0::1', '2001:db8::1', '2001:0:4136:e378::1'])
        assert.ok(priv(ip), ip);
    for (const ip of ['2606:4700:4700::1111', '::ffff:808:808', '64:ff9b::808:808', '2a00:1450:4009:81f::200e']) assert.ok(!priv(ip), ip);
    console.log('netguard ipv6: ok');
}
