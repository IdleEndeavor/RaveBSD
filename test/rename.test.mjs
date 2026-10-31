// Checks for the naming templates (src/rename.js). Run: node test/rename.test.mjs
import assert from 'node:assert/strict';
import { applyTemplate, tidyName, safeSegment, numberedPath, singleFileAudiobook, primaryAuthor, DEFAULT_TEMPLATES } from '../src/rename.js';

const dune = { author: 'Frank Herbert', title: 'Dune', year: '1965', ext: 'EPUB' };
assert.equal(applyTemplate(DEFAULT_TEMPLATES.ebook, dune), 'Frank Herbert/Dune (1965).epub');
// Empty tokens collapse with their brackets and separators.
assert.equal(applyTemplate(DEFAULT_TEMPLATES.ebook, { ...dune, year: '' }), 'Frank Herbert/Dune.epub');
assert.equal(applyTemplate('{series} - {title}.{ext}', dune), 'Dune.epub');
assert.equal(applyTemplate('{author}/{series}/{title}.{ext}', dune), 'Frank Herbert/Dune.epub');
assert.equal(applyTemplate('{author}/{title}.{ext}', { title: '', author: '', ext: 'pdf' }), 'Untitled.pdf');
// Audiobook tracks pad to the width of the count.
const ab = { author: 'Frank Herbert', title: 'Dune', year: '1965', ext: 'mp3', track: 3, trackCount: 120 };
assert.equal(applyTemplate(DEFAULT_TEMPLATES.audiobook, ab), 'Frank Herbert/Dune (1965)/003 - Dune.mp3');
assert.equal(applyTemplate(DEFAULT_TEMPLATES.audiobook, { ...ab, trackCount: 9, track: 1 }), 'Frank Herbert/Dune (1965)/01 - Dune.mp3');
assert.equal(singleFileAudiobook(DEFAULT_TEMPLATES.audiobook, { ...ab, ext: 'm4b' }), 'Frank Herbert/Dune (1965).m4b');
// Scraped values can never climb out of the folder or carry illegal characters.
assert.equal(applyTemplate(DEFAULT_TEMPLATES.ebook, { author: '../../etc', title: 'a/b:c*?', ext: 'epub' }), 'etc/a-bc.epub');
assert.equal(safeSegment('..'), '');
assert.equal(safeSegment('  .hidden  '), 'hidden');
// Junk from sources.
assert.equal(tidyName('Dune_-_Frank_Herbert_(z-lib.org)'), 'Dune - Frank Herbert');
assert.equal(tidyName('Dune [libgen]  www.ebook3000.com'), 'Dune');
assert.equal(applyTemplate('{title}.{ext}', { title: 'Dune (z-lib.org)', ext: 'epub' }), 'Dune.epub');
assert.equal(applyTemplate('{title}.{ext}', { title: 'Dune (z-lib.org)', ext: 'epub' }, { tidy: false }), 'Dune (z-lib.org).epub');
// Keep both.
const taken = new Set(['a/Dune.epub', 'a/Dune (2).epub']);
assert.equal(numberedPath('a/Dune.epub', p => taken.has(p)), 'a/Dune (3).epub');
assert.equal(numberedPath('a/New.epub', p => taken.has(p)), 'a/New.epub');
assert.equal(primaryAuthor('Austen, Jane, 1775-1817, Thomson, Hugh, 1860-1920, ill'), 'Jane Austen');
assert.equal(primaryAuthor('Austen, Jane & Brown, Em'), 'Jane Austen');
assert.equal(primaryAuthor('Frank Herbert'), 'Frank Herbert');
assert.equal(primaryAuthor('Herbert, Frank; Anderson, Kevin J.'), 'Frank Herbert');
assert.equal(primaryAuthor('Tolkien, J. R. R. (John Ronald Reuel), 1892-1973'), 'J. R. R. Tolkien');
assert.equal(primaryAuthor('J. R. R. Tolkien, John Ronald Reuel Tolkien'), 'J. R. R. Tolkien');
const long = applyTemplate('{title}.{ext}', { title: 'A'.repeat(200), ext: 'epub' });
assert.ok(long.endsWith('.epub') && long.length <= 120);
// File systems count bytes (255 at most), not characters: a long title in Chinese is cut by its bytes, and
// never inside a character.
const bytes = s => new TextEncoder().encode(s).length;
const cjk = applyTemplate('{title}.{ext}', { title: '書'.repeat(150), ext: 'epub' });
assert.ok(cjk.endsWith('.epub') && bytes(cjk) <= 200, 'cut by bytes: ' + bytes(cjk));
const emoji = safeSegment('x' + '😀'.repeat(150));
assert.ok(bytes(emoji) <= 200 && !/[\ud800-\udfff]/u.test(emoji.replace(/\p{Extended_Pictographic}/gu, '')), 'no half emoji');
assert.equal([...emoji].every(c => c === 'x' || c === '😀'), true);
assert.ok(!safeSegment('a'.repeat(119) + '. b').endsWith('.'), 'a cut name never ends in a dot');
console.log('rename: ok');
