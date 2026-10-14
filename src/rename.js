// How downloaded files are named on the shelf. Pure functions, no Node APIs: the server uses them to file
// downloads, and the page imports the same file (served as /js/rename.js) for live previews.
//
// A template like "{author}/{title} ({year}).{ext}" is filled from the book's details. Tokens with no
// value disappear together with their brackets and separators, so "Dune ().epub" becomes "Dune.epub".

export const TOKENS = ['author', 'title', 'series', 'year', 'narrator', 'track', 'ext'];
export const DEFAULT_TEMPLATES = {
    ebook: '{author}/{title} ({year}).{ext}',
    audiobook: '{author}/{title} ({year})/{track} - {title}.{ext}',
};

// Site tags and filler that sources add to names: "(z-lib.org)", "[libgen]", "www.example.com", underscores.
const JUNK = [
    /[([{]\s*(?:z-?lib(?:rary)?(?:\.\w+)?|libgen(?:\.\w+)?|anna'?s[ -]archive|1lib(?:\.\w+)?|b-ok(?:\.\w+)?|ebook3000|epub\.pub|oceanofpdf(?:\.com)?)\s*[)\]}]/gi,
    /\bwww\.[a-z0-9-]+(?:\.[a-z]{2,})+\b/gi,
    /\b(?:z-?lib\.org|libgen\.\w+|oceanofpdf\.com)\b/gi,
];
export function tidyName(s) {
    let out = String(s || '');
    for (const re of JUNK) out = out.replace(re, ' ');
    return out.replace(/_+/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,.;:!?)])/g, '$1').replace(/^[\s\-.,]+|[\s\-,]+$/g, '');
}

// Sources list authors in many ways: "Austen, Jane, 1775-1817, Thomson, Hugh, ill." or "Herbert, Frank & Herbert, Brian".
// The folder uses the first author, first name first, without life dates.
export function primaryAuthor(s) {
    const first = String(s || '').split(/\s*(?:;|&|\band\b|\|)\s*/i)[0].replace(/,?\s*\(?\d{3,4}\s*-\s*(?:\d{3,4})?\)?/g, '').replace(/\s*\([^)]*\)/g, '');
    const parts = first.split(',').map(x => x.trim()).filter(Boolean);
    // "Herbert, Frank" flips; "J. R. R. Tolkien, John Ronald Reuel Tolkien" is a list of names, so the first one is kept.
    if (parts.length >= 2 && !/\s/.test(parts[0]) && !/\d|\b(ed|ill|tr|trans)\.?$/i.test(parts[1])) return parts[1] + ' ' + parts[0];
    return parts[0] || '';
}

// One path segment from a value scraped off the internet: no slashes (so "../" can never climb out of the
// shelf folder), no characters Windows, macOS or Linux refuse, no leading dots, and not too long.
export function safeSegment(s) {
    const out = String(s == null ? '' : s)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/]+/g, '-')
        .replace(/[<>:"|?*]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^[.\-\s]+/, '')
        .replace(/[. ]+$/, '');
    return out.slice(0, 120).trim();
}

// Removes what an empty token leaves behind in one segment: "()", "[]", " - " at either end or doubled.
function collapse(seg) {
    let s = seg, prev;
    do {
        prev = s;
        s = s.replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '')
            .replace(/\s+-\s+-\s+/g, ' - ')
            .replace(/^\s*[-–,.]\s+/, '')
            .replace(/\s+[-–,]\s*$/, '')
            .replace(/\s+(\.[A-Za-z0-9]+)$/, '$1')
            .replace(/\s{2,}/g, ' ');
    } while (s !== prev);
    return s.trim();
}

// Fills a template. `book` holds author, title, series, year, narrator, ext, and for audiobook tracks
// track plus trackCount (track numbers are zero padded to the width of the count).
// Returns a relative path with "/" between segments, or '' if nothing usable is left.
export function applyTemplate(template, book, { tidy = true } = {}) {
    const val = k => {
        let v = book[k];
        if (k === 'track') {
            if (!v) return '';
            const width = Math.max(2, String(book.trackCount || v).length);
            return String(v).padStart(width, '0');
        }
        if (k === 'year') { const m = String(v || '').match(/\d{4}/); return m ? m[0] : ''; }
        if (k === 'author' && tidy) v = primaryAuthor(v);
        if (k === 'ext') return String(v || '').toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
        v = tidy ? tidyName(v) : String(v || '');
        return safeSegment(v);
    };
    const segs = String(template || '').split('/').map(seg => {
        const filled = seg.replace(/\{(\w+)\}/g, (m, k) => (TOKENS.includes(k) ? val(k) : ''));
        let c = collapse(filled);
        // A segment that is only ".epub" means title and friends were all empty.
        if (/^\.[a-z0-9]+$/i.test(c)) c = 'Untitled' + c;
        // Long names are cut, but the extension always survives.
        const ext = (c.match(/(\.[a-z0-9]{1,6})$/i) || [''])[0];
        if (ext && c.length > 120) return safeSegment(c.slice(0, -ext.length)).slice(0, 120 - ext.length).trim() + ext;
        return safeSegment(c);
    }).filter(Boolean);
    return segs.join('/');
}

// For a single-file audiobook (one M4B) the track folder is skipped: the last two segments of the
// template become one file named after the folder.
export function singleFileAudiobook(template, book) {
    const t = String(template || DEFAULT_TEMPLATES.audiobook);
    const parts = t.split('/');
    const dirT = parts.length > 1 ? parts.slice(0, -1).join('/') : '{title}';
    const dir = applyTemplate(dirT, book);
    if (!dir) return applyTemplate('{title}.{ext}', book);
    return dir + '.' + String(book.ext || '').toLowerCase().replace(/^\./, '');
}

// "Keep both" naming: "Dune (1965).epub" -> "Dune (1965) (2).epub", counting up until exists() says no.
export function numberedPath(p, exists) {
    if (!exists(p)) return p;
    const m = p.match(/^(.*?)(\.[A-Za-z0-9]{1,6})?$/);
    for (let i = 2; i < 1000; i++) {
        const next = m[1] + ' (' + i + ')' + (m[2] || '');
        if (!exists(next)) return next;
    }
    return m[1] + ' (' + Date.now() + ')' + (m[2] || '');
}
