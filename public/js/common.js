// Small helpers shared by index.html and backend.html. Loaded with a plain <script src> (no build
// step, no modules) before each page's own script.

var API_URL = location.origin; // same-origin: the RaveBSD server serves both the page and the API

// Escapes & < > " ' before scraped or typed text goes into innerHTML.
// null and undefined become '' (not the words "null" or "undefined").
function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// Local stats live on the RaveBSD server (GET/POST /stats), not in the browser.
function loadStats() {
    return fetch(API_URL + '/stats').then(function (r) { return r.json(); }).catch(function () { return {}; });
}
function postStats(body) {
    return fetch(API_URL + '/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .catch(function () {});
}
