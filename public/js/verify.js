// Remote verification modal, shared by index.html and backend.html. Shows the RaveBSD server's browser
// (screenshots in, click/key/scroll out) so a person can pass Anna's Archive's human check from any device.
// RaveBSD never solves the check itself. Needs API_URL and esc() from js/common.js.
function openVerifyModal(onDone) {
    var running = true, pending = null;
    var overlay = document.createElement('div');
    overlay.className = 'verify-overlay';
    overlay.innerHTML =
        '<div class="verify-box" role="dialog" aria-modal="true" aria-label="Anna\'s Archive check">' +
        '<div class="verify-head"><span class="access-name">Anna\'s Archive check</span>' +
        '<button type="button" class="access-btn" id="verify-close">Close</button></div>' +
        '<p class="access-help">This is the browser running on the RaveBSD machine. Complete the check below by clicking and typing in it. ' +
        'It closes by itself once you have passed.</p>' +
        '<img id="verify-frame" alt="Remote browser" tabindex="0">' +
        '<form id="verify-type" class="verify-type"><input type="text" id="verify-text" placeholder="Or type here and press Send (helpful on phones)" autocomplete="off">' +
        '<button type="submit" class="access-btn">Send</button></form>' +
        '<p class="access-state" id="verify-status" aria-live="polite">Starting the browser...</p></div>';
    document.body.appendChild(overlay);
    var frame = overlay.querySelector('#verify-frame');
    var status = overlay.querySelector('#verify-status');

    function post(path, body) {
        return fetch(API_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    }
    function send(ev) { return post('/browser/input', ev); }
    function close(solved) {
        running = false;
        document.body.removeChild(overlay);
        if (onDone) onDone(!!solved);
    }
    function finish() {
        running = false;
        status.textContent = 'Checking...';
        post('/browser/verify', { action: 'stop' }).then(function(r) { return r.json(); }).then(function(r) {
            if (r.solved) { close(true); return; }
            status.textContent = 'The check has not been passed yet. Close this and try again.';
        });
    }
    function tick() {
        if (!running) return;
        fetch(API_URL + '/browser/frame?t=' + Date.now()).then(function(r) {
            if (!r.ok) throw new Error('closed');
            var state = r.headers.get('X-Check-State');
            return r.blob().then(function(b) { return { blob: b, state: state }; });
        }).then(function(f) {
            if (!running) return;
            var old = frame.src;
            frame.src = URL.createObjectURL(f.blob);
            if (old && old.indexOf('blob:') === 0) URL.revokeObjectURL(old);
            if (f.state === 'solved') { status.textContent = 'Check passed.'; finish(); return; }
            status.textContent = f.state === 'captcha' ? 'Type the characters you see and press Verify, in the view above.' : 'Loading...';
            pending = setTimeout(tick, 700);
        }).catch(function() { pending = setTimeout(tick, 1500); });
    }

    frame.addEventListener('click', function(e) {
        var r = frame.getBoundingClientRect();
        send({ type: 'click', x: (e.clientX - r.left) / r.width * frame.naturalWidth, y: (e.clientY - r.top) / r.height * frame.naturalHeight });
        frame.focus();
    });
    frame.addEventListener('wheel', function(e) { e.preventDefault(); send({ type: 'scroll', dy: e.deltaY }); }, { passive: false });
    frame.addEventListener('keydown', function(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        if (e.key.length === 1) send({ type: 'type', text: e.key }); else send({ type: 'key', key: e.key });
    });
    overlay.querySelector('#verify-type').addEventListener('submit', function(e) {
        e.preventDefault();
        var t = overlay.querySelector('#verify-text');
        if (t.value) send({ type: 'type', text: t.value });
        t.value = '';
    });
    overlay.querySelector('#verify-close').addEventListener('click', function() {
        clearTimeout(pending);
        post('/browser/verify', { action: 'stop' }).then(function() { close(false); });
    });

    post('/browser/verify', { action: 'start' }).then(function(r) { return r.json(); }).then(function(r) {
        if (!r.ok) { running = false; status.textContent = r.reason || 'Could not start the browser.'; return; }
        tick();
    }).catch(function() { running = false; status.textContent = 'Could not reach RaveBSD.'; });
}
