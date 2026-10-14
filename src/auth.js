// Who is asking, in three modes (admin panel > Access):
// - private: one person. With no admin account, whoever reaches the page is the admin; with one, they sign in.
// - public:  open to the internet. Anyone is a visitor (search, download within a limit, own books only); the
//            admin signs in for everything else.
// - family:  everyone signs in. Users search, download and share one shelf; admins also run the server.
//
// Accounts live in settings.secrets.users with scrypt hashes. Sessions are signed cookies naming the account
// and its version, so removing an account or changing its password ends only that account's sessions.
// Visitors get a random id in a signed cookie; their shelf is whatever that id holds.
// API keys are stored as sha256 hashes and shown once. The API_KEY env var still works as a key.
import crypto from 'node:crypto';
import { settings, saveSettings, accessMode } from './config.js';

const COOKIE = 'rbsd_session', VISITOR = 'rbsd_visitor';
const SESSION_DAYS = 30, VISITOR_DAYS = 400;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const hmac = s => crypto.createHmac('sha256', secret()).update(String(s)).digest('hex');
const users = () => settings.secrets.users;

const secret = () => {
    if (!settings.secrets.sessionSecret) { settings.secrets.sessionSecret = crypto.randomBytes(32).toString('hex'); saveSettings(); }
    return settings.secrets.sessionSecret;
};
const cookieOf = (req, name) => (String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')) || [])[1] || '';

// ── Accounts ─────────────────────────────────────────────────────────────────
export const hasAdmin = () => users().some(u => u.role === 'admin');
// Private mode with no account is open; every other case asks someone to sign in for admin work.
export const passwordOn = () => hasAdmin();
export const listUsers = () => users().map(({ id, username, role, changedAt, created }) => ({ id, username, role, changedAt, created }));
const findName = name => users().find(u => u.username.toLowerCase() === String(name || '').trim().toLowerCase());

function hashInto(u, password) {
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = crypto.scryptSync(String(password), u.salt, 32).toString('hex');
    u.ver = (u.ver || 0) + 1;
    u.changedAt = Date.now();
}
export function addUser(username, password, role = 'user') {
    const name = String(username || '').trim().slice(0, 60);
    if (!name) throw new Error('Give the account a username');
    if (String(password || '').length < 8) throw new Error('Use at least 8 characters for the password');
    if (findName(name)) throw new Error('That username is taken');
    const u = { id: crypto.randomBytes(6).toString('hex'), username: name, role: role === 'admin' ? 'admin' : 'user', created: Date.now() };
    hashInto(u, password);
    users().push(u); saveSettings();
    return u;
}
export function setUserPassword(id, password) {
    const u = users().find(x => x.id === id);
    if (!u) throw new Error('No such account');
    if (String(password || '').length < 8) throw new Error('Use at least 8 characters for the password');
    hashInto(u, password); saveSettings();
    return u;
}
export function removeUser(id) {
    const u = users().find(x => x.id === id);
    if (!u) return;
    if (u.role === 'admin' && users().filter(x => x.role === 'admin').length === 1 && accessMode() !== 'private') throw new Error('Keep at least one admin');
    settings.secrets.users = users().filter(x => x !== u); saveSettings();
}
// Every account's sessions end at once (a lost phone, a shared computer). Passwords stay as they are.
export function signOutEverywhere() {
    for (const u of users()) u.ver = (u.ver || 0) + 1;
    saveSettings();
}

// Private mode's single login: replaces any admin with this one ("Ask for a password" in the admin panel).
export function setPassword(username, password) {
    const admin = users().find(u => u.role === 'admin');
    if (admin) { if (username) admin.username = String(username).trim().slice(0, 60) || admin.username; return setUserPassword(admin.id, password); }
    return addUser(username || 'admin', password, 'admin');
}
// Admin accounts only: user accounts from friends and family mode wait for it to come back.
export function clearPassword() { settings.secrets.users = users().filter(u => u.role !== 'admin'); saveSettings(); }

export function checkLogin(username, password) {
    const u = findName(username);
    // A hash is computed either way, so a wrong username takes as long as a wrong password.
    const h = crypto.scryptSync(String(password || ''), u ? u.salt : 'x', 32).toString('hex');
    return u && same(h, u.hash) ? u : null;
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export function sessionCookie(user, secure) {
    const exp = Date.now() + SESSION_DAYS * 864e5, body = `${user.id}.${user.ver}.${exp}`;
    return `${COOKIE}=${body}.${hmac(body)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
function sessionUser(req) {
    const m = cookieOf(req, COOKIE).match(/^([a-z0-9]+)\.(\d+)\.(\d+)\.([a-f0-9]{64})$/);
    if (!m || +m[3] < Date.now() || !same(hmac(`${m[1]}.${m[2]}.${m[3]}`), m[4])) return null;
    const u = users().find(x => x.id === m[1]);
    return u && String(u.ver) === m[2] ? u : null;
}

// Visitors (public mode): a random id the server signs, so nobody can pick another visitor's id.
export function visitorId(req) {
    const m = cookieOf(req, VISITOR).match(/^([a-f0-9]{24})\.([a-f0-9]{64})$/);
    return m && same(hmac('v.' + m[1]), m[2]) ? m[1] : '';
}
export function newVisitorCookie(secure) {
    const id = crypto.randomBytes(12).toString('hex');
    return { id, cookie: `${VISITOR}=${id}.${hmac('v.' + id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${VISITOR_DAYS * 86400}${secure ? '; Secure' : ''}` };
}

// { role: 'admin' | 'user' | 'visitor' | 'none', user?, vid? }
export function who(req) {
    // Before setup the person setting it up is the admin, whatever the mode (PUBLIC_INSTANCE=1 included).
    if (!settings.setupDone) return { role: 'admin' };
    const mode = accessMode();
    // A session only counts if its account fits the mode: user accounts left over from friends and family mode
    // are neither admins in private mode nor above visitors in public mode.
    let u = sessionUser(req);
    if (u && u.role !== 'admin' && mode !== 'family') u = null;
    if (u) return { role: u.role, user: u };
    if (mode === 'private') return hasAdmin() ? { role: 'none' } : { role: 'admin' };
    if (mode === 'public') return { role: 'visitor', vid: visitorId(req) };
    return { role: 'none' };
}

// ── API keys (admins make them; never on a public instance) ─────────────────
export function apiKeyOk(req) {
    const key = req.headers['x-api-key'];
    if (!key) return false;
    if (process.env.API_KEY && same(key, process.env.API_KEY)) return true;
    const h = sha256(key);
    const hit = settings.secrets.apiKeys.find(k => same(k.hash, h));
    if (!hit) return false;
    // "Used 2 hours ago" in the admin panel. Saved at most once a minute so busy scripts do not rewrite the file.
    const now = Date.now();
    if (!hit.lastUsed || now - hit.lastUsed > 60e3) { hit.lastUsed = now; saveSettings(); }
    return true;
}
// Keys are needed for /api/v1 when anyone has to sign in, or when any key exists (or API_KEY is set).
export const apiNeedsKey = () => passwordOn() || accessMode() !== 'private' || !!process.env.API_KEY || settings.secrets.apiKeys.length > 0;

export function makeApiKey(label) {
    const key = 'rbsd_' + crypto.randomBytes(20).toString('hex');
    const entry = { id: crypto.randomBytes(6).toString('hex'), label: String(label || 'Key').trim().slice(0, 60) || 'Key', hash: sha256(key), prefix: key.slice(0, 9), suffix: key.slice(-4), created: Date.now() };
    settings.secrets.apiKeys.push(entry);
    saveSettings();
    return { key, id: entry.id };
}
export function revokeApiKey(id) {
    settings.secrets.apiKeys = settings.secrets.apiKeys.filter(k => k.id !== id);
    saveSettings();
}

// Small brake on password guessing: 10 wrong tries per address per 10 minutes.
const tries = new Map();
export function loginAllowed(ip) {
    const now = Date.now(), t = tries.get(ip);
    if (!t || t.until < now) return true;
    return t.n < 10;
}
export function noteFailedLogin(ip) {
    const now = Date.now(), t = tries.get(ip);
    if (tries.size > 5000) for (const [k, v] of tries) if (v.until < now) tries.delete(k);
    if (!t || t.until < now) tries.set(ip, { n: 1, until: now + 10 * 60e3 });
    else t.n++;
}
