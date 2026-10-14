// Checks reading SLUM's status page and ordering mirrors with it. Run: node test/slum.test.mjs
import assert from 'node:assert/strict';
import { parseSlum, slumOrder, slum } from '../src/slum.js';

const card = (name, doms) => `<div class="site-card"><div class="site-card-header"><a href="${name}.html" class="site-card-title">${name}</a></div><ul>`
    + doms.map(([h, st]) => `<li><a href="https://${h}" class="domain-link" target="_blank" title="https://${h}">${h}</a><div class="status-col"><a href="#" class="status-badge compact ${st}">${st.toUpperCase()}</a></div></li>`).join('') + '</ul></div>';
const html = card('libgen', [['libgen.bz', 'degraded'], ['libgen.vg', 'down'], ['libgen.li', 'up']])
    + card('annas', [['annas-archive.gl', 'protected'], ['yqrii5.org', 'up']]);
const sites = parseSlum(html);
assert.deepEqual(sites.libgen.map(d => d.status), ['degraded', 'down', 'up']);
assert.equal(sites.annas[1].host, 'yqrii5.org');
slum.sites = sites;
// Up first, then degraded, unknown (not watched by SLUM) before down, ties keep the built-in order.
assert.deepEqual(slumOrder('libgen', ['https://libgen.vg', 'https://libgen.bz', 'https://libgen.xx', 'https://libgen.li']),
    ['https://libgen.li', 'https://libgen.bz', 'https://libgen.xx', 'https://libgen.vg']);
// Anna's download servers are not search mirrors and are left out.
assert.deepEqual(slumOrder('annas', ['https://annas-archive.gl']), ['https://annas-archive.gl']);
console.log('slum: ok');
