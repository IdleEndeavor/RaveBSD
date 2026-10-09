// Plain Node checks for the pure helpers (parsing, ranking, caching, mirror order). No framework.
// Run: node test/sources.test.mjs
// Each block tests one helper. When you add parsing or ranking code, add a block here.
import assert from 'node:assert/strict';
import http from 'node:http';
import worker, { parseFilesizeBytes, royallibUnitChar, get, withDeadline, withEdgeCache, rankMirrors, fetchFirstValid, scoreResult, tokenCoverage, currentUA, setUserAgentMode, BROWSER_UA, RAVE_UA, parseOpts } from '../src/sources.js';

// parseFilesizeBytes: LibGen, Anna's and AudiobookBay each write the size unit differently.
{
    // LibGen: single lowercase letter, e.g. '5.2', 'm'
    assert.equal(parseFilesizeBytes('5.2', 'm'), 5.2 * 1e6);
    assert.equal(parseFilesizeBytes('1', 'g'), 1e9);
    assert.equal(parseFilesizeBytes('500', 'k'), 500 * 1e3);

    // Anna's Archive: uppercase 2-letter unit, e.g. '0.5', 'MB'
    assert.equal(parseFilesizeBytes('0.5', 'MB'), 0.5 * 1e6);
    assert.equal(parseFilesizeBytes('2', 'GB'), 2e9);
    assert.equal(parseFilesizeBytes('10', 'KB'), 10 * 1e3);

    // AudiobookBay: lowercased full word, matched via startsWith originally
    assert.equal(parseFilesizeBytes('750', 'mb'), 750 * 1e6);
    assert.equal(parseFilesizeBytes('1.5', 'gb'), 1.5e9);

    // Unknown/missing unit falls back to KB scale, matching all 3 originals'
    // ternary default branch
    assert.equal(parseFilesizeBytes('3', ''), 3 * 1e3);

    console.log('parseFilesizeBytes: ok');
}

// royallibUnitChar: turns RoyalLib's Cyrillic size units into the k/m/g letter parseFilesizeBytes expects.
{
    assert.equal(royallibUnitChar('Кб'), 'k');
    assert.equal(royallibUnitChar('кб'), 'k');
    assert.equal(royallibUnitChar('Мб'), 'm');
    assert.equal(royallibUnitChar('мб'), 'm');
    assert.equal(royallibUnitChar('Гб'), 'g');
    assert.equal(royallibUnitChar(''), 'k'); // unknown/missing falls back to KB scale

    console.log('royallibUnitChar: ok');
}

// Sanity: sources.js still loads as a valid ES module with a fetch handler.
assert.equal(typeof worker.fetch, 'function');
console.log('sources.js module shape: ok');

// get() timeout must cover the body read: a server that sends headers and then no body must not hang text().
{
    const srv = http.createServer((req, res) => { res.writeHead(200); res.write('x'); /* never ends */ });
    await new Promise(r => srv.listen(0, r));
    const started = Date.now();
    const res = await get(`http://127.0.0.1:${srv.address().port}/`, 400);
    await assert.rejects(res.text());
    assert.ok(Date.now() - started < 3000);
    srv.closeAllConnections(); srv.close();
    console.log('get body timeout: ok');
}

// withDeadline: slow job yields fallback, fast job passes through
{
    assert.deepEqual(await withDeadline(new Promise(() => {}), 30, []), []);
    assert.equal(await withDeadline(Promise.resolve(7), 30, 0), 7);
    console.log('withDeadline: ok');
}


// withEdgeCache: no Cache API (plain Node) falls through to produce()
{
    const r = await withEdgeCache('https://x/y', { waitUntil() {} }, 60, async () => [new Response('hi'), true]);
    assert.equal(await r.text(), 'hi');
    console.log('withEdgeCache fallthrough: ok');
}

// rankMirrors
{
    const st = ['https://a.li', 'https://b.li', 'https://c.li'];
    const health = new Map();
    // no health data: list order kept
    assert.deepEqual(rankMirrors(st, health), st);
    // observed latency wins, unknown-latency hosts go last
    health.set('c.li', { fails: 0, coolUntil: 0, avgMs: 100 });
    health.set('b.li', { fails: 0, coolUntil: 0, avgMs: 900 });
    assert.deepEqual(rankMirrors(st, health), ['https://c.li', 'https://b.li', 'https://a.li']);
    // cooldown excludes, then readmits after it expires
    health.set('c.li', { fails: 0, coolUntil: Date.now() + 60000, avgMs: 100 });
    assert.ok(!rankMirrors(st, health).includes('https://c.li'));
    assert.ok(rankMirrors(st, health, Date.now() + 120000).includes('https://c.li'));
    // never empty
    st.forEach(u => health.set(u.slice(8), { fails: 0, coolUntil: Date.now() + 60000, avgMs: 1 }));
    assert.deepEqual(rankMirrors(st, health), st);
    console.log('rankMirrors: ok');
}

// fetchFirstValid: slow + challenge-page + good mirror
{
    const mk = handler => new Promise(r => { const sv = http.createServer(handler); sv.listen(0, () => r(sv)); });
    const slow = await mk((q, s) => setTimeout(() => { s.end('tablelibgen slow'); }, 1500));
    const chal = await mk((q, s) => { s.writeHead(403); s.end('<title>DDoS-Guard</title>'); });
    const good = await mk((q, s) => s.end('tablelibgen good'));
    const url = sv => `http://127.0.0.1:${sv.address().port}`;
    const validate = t => t.includes('tablelibgen') ? true : (t.includes('DDoS-Guard') ? 'challenged' : false);
    const t0 = Date.now();
    const r = await fetchFirstValid([url(slow), url(chal), url(good)], m => m + '/x', validate, { ms: 3000 });
    assert.equal(r.mirror, url(good));
    assert.ok(Date.now() - t0 < 1000, 'good mirror wins without waiting for the slow one');
    const allChal = await fetchFirstValid([url(chal)], m => m + '/x', validate, { ms: 3000 });
    assert.equal(allChal.challengedAll, true);
    assert.equal((await fetchFirstValid([], m => m, validate)).mirror, null);
    [slow, chal, good].forEach(sv => { sv.closeAllConnections(); sv.close(); });
    console.log('fetchFirstValid: ok');
}

// Ranking: punctuation-insensitive title match and title+author token coverage
{
    const q = 'Hollywood Ending John Green';
    const jg = { title: 'Hollywood, Ending', author: 'John Green', format: 'epub', source: 'Library Genesis' };
    const junk = { title: 'Pizzagate', author: '', format: 'pdf', source: 'Internet Archive', year: '2020', filesize: 99999 };
    const other = { title: 'Hollywood Ending', author: 'Charles, Kathy', format: 'epub', source: 'Library Genesis' };
    assert.ok(scoreResult(jg, q) > scoreResult(junk, q));
    assert.ok(scoreResult(jg, q) > scoreResult(other, q), 'author match outranks same-title other author');
    assert.equal(tokenCoverage(jg, q), 1);
    // title only query: comma in the stored title must not defeat the exact-match tier
    assert.ok(scoreResult(jg, 'hollywood ending') >= 60);
    console.log('scoreResult token coverage: ok');
}


// User-Agent: browser by default, honest Rave UA on request, unknown values fall back to browser.
{
    assert.equal(currentUA(), BROWSER_UA);
    setUserAgentMode('rave');
    assert.equal(currentUA(), RAVE_UA);
    setUserAgentMode('nonsense');
    assert.equal(currentUA(), BROWSER_UA);
    console.log('user agent mode: ok');
}

// Advanced search options: year or range, formats and sources are lowercased lists, junk is ignored.
{
    const o = parseOpts(new URL('http://x/?year=1990-2000&formats=EPUB, pdf&sources=libgen,,Annas'));
    assert.deepEqual(o, { formats: ['epub', 'pdf'], sources: ['libgen', 'annas'], yearFrom: 1990, yearTo: 2000 });
    assert.equal(parseOpts(new URL('http://x/?year=2019')).yearTo, 2019);
    assert.equal(parseOpts(new URL('http://x/?year=abc')).yearFrom, 0);
    assert.deepEqual(parseOpts(new URL('http://x/')), { formats: [], sources: [], yearFrom: 0, yearTo: 0 });
    console.log('parseOpts: ok');
}

console.log('All sources tests passed.');
