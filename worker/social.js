/**
 * BAGZ social API (/v1/…): accounts, public profiles, leaderboard, friends, friends feed, group chats.
 *
 * Security notes
 *  - Passwords: PBKDF2-SHA256, 100,000 iterations by default (the Workers maximum), 16-byte random salt. Never logged or returned.
 *  - Sessions: 32 random bytes sent as a Bearer token; only its SHA-256 is stored. 30-day expiry. No cookies (the site and
 *    the Worker are on different domains, and Telegram's webview blocks third-party cookies anyway).
 *  - Login and signup are throttled per username and per IP in D1, so the limit holds across Worker instances.
 *  - Pictures: PNG/JPEG/WebP only (checked by their first bytes, not the claimed type), ≤ 150 KB, served with nosniff.
 *  - Chats are friends-only: you can only create a chat with, or add, people who accepted your friend request.
 *  - Leaderboard numbers are paper-trading stats reported by the app. They are range-checked here, but they are not
 *    independently verified, and the app says so.
 */
import { isPaused } from './controls.js';
import { ApiError, database } from './api.js';
import { getWallet, putWallet, deleteWallet } from './wallet.js';

const DAY = 86_400_000;
const SESSION_MS = 30 * DAY;
/** Workers allow at most 100,000. On the Workers Free plan (10 ms CPU per request) set PASSWORD_ITERATIONS lower. */
const iterations = (env) => { const n = Number(env.PASSWORD_ITERATIONS); return Number.isInteger(n) && n >= 10_000 && n <= 100_000 ? n : 100_000; };
const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const RESERVED = new Set(['admin', 'administrator', 'bagz', 'bagzapp', 'support', 'help', 'mod', 'moderator', 'system', 'official', 'team', 'root', 'null', 'undefined', 'me', 'you', 'telegram']);
const CLIENT_ID = /^[\w-]{1,48}$/;
const ADDR = /^[A-Za-z0-9]{20,64}$/;
const ID = /^[1-9A-HJ-NP-Za-km-z]{16,32}$/;
const MAX_AVATAR = 150_000;
const MAX_GROUP = 50;

const bad = (m) => new ApiError(400, m);
const enc = new TextEncoder();
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => B58[b % 58]).join('');
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function pbkdf2(password, saltB64, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  return b64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256)));
}
function sameStr(a, b) { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; }
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const one = (d, sql, ...a) => d.prepare(sql).bind(...a).first();
const all = async (d, sql, ...a) => (await d.prepare(sql).bind(...a).all()).results || [];
const run = (d, sql, ...a) => d.prepare(sql).bind(...a).run();
const changes = (r) => (r && r.meta ? r.meta.changes : 0) || 0;
function db(ctx) { const d = database(ctx.env); if (!d) throw new ApiError(503, 'Accounts need the BAGZ database, which isn’t connected'); return d; }
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, max);

// ---- throttling (D1-backed so it holds across Worker instances) ---------------------------------------------------------
async function throttled(d, key, max, windowMs, now) {
  const r = await one(d, 'SELECT count, window_start FROM auth_throttle WHERE key = ?', key);
  if (!r || now - r.window_start > windowMs) return false;
  return r.count >= max;
}
async function bump(d, key, windowMs, now) {
  await run(d, `INSERT INTO auth_throttle (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN ? - window_start > ? THEN 1 ELSE count + 1 END,
                                    window_start = CASE WHEN ? - window_start > ? THEN ? ELSE window_start END`, key, now, now, windowMs, now, windowMs, now);
}

// ---- sessions -------------------------------------------------------------------------------------------------------------
async function createSession(d, userId, now) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  await run(d, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?)', await sha256hex(token), userId, now, now + SESSION_MS, now);
  if (Math.random() < 0.05) await run(d, 'DELETE FROM sessions WHERE expires_at < ?', now);
  return { token, expiresAt: now + SESSION_MS };
}
/** the signed-in user, or null. Throws 401 only when `required`. */
export async function currentUser(ctx, request, required = true) {
  const m = /^Bearer ([A-Za-z0-9_-]{40,60})$/.exec(request.headers.get('authorization') || '');
  if (!m) { if (required) throw new ApiError(401, 'Sign in first'); return null; }
  const d = db(ctx);
  const s = await one(d, 'SELECT s.token_hash, s.user_id, s.expires_at, s.last_seen, u.username, u.avatar_ver, u.bio, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', await sha256hex(m[1]));
  if (!s || s.expires_at <= ctx.now()) { if (required) throw new ApiError(401, 'Your session expired. Sign in again.'); return null; }
  if (ctx.now() - s.last_seen > 3600_000) await run(d, 'UPDATE sessions SET last_seen = ? WHERE token_hash = ?', ctx.now(), s.token_hash);
  return { id: s.user_id, username: s.username, avatarVer: s.avatar_ver, bio: s.bio, createdAt: s.created_at, tokenHash: s.token_hash };
}
const summary = (r) => ({ id: r.id, username: r.username, avatarVer: r.avatar_ver ?? r.avatarVer ?? 0 });
const me = (u) => ({ id: u.id, username: u.username, avatarVer: u.avatarVer, bio: u.bio || '', createdAt: u.createdAt, complete: u.avatarVer > 0 });

// ---- auth -----------------------------------------------------------------------------------------------------------------
function readCreds(b) {
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  return { username, password };
}
async function signup(ctx, b, ip) {
  const d = db(ctx);
  const { username, password } = readCreds(b);
  if (!USERNAME.test(username)) throw bad('Usernames are 3–20 letters, numbers or _');
  if (RESERVED.has(username.toLowerCase())) throw bad('That username is reserved. Pick another.');
  if (password.length < 8) throw bad('Use a password of at least 8 characters');
  if (password.length > 128) throw bad('Password is too long (128 characters max)');
  if (password.toLowerCase() === username.toLowerCase()) throw bad('Your password can’t be your username');
  if (await isPaused(ctx, 'signups')) throw new ApiError(403, 'New sign-ups are paused right now. Try again a bit later.');
  const now = ctx.now();
  if (await throttled(d, `signup:${ip}`, 5, 3600_000, now)) throw new ApiError(429, 'Too many new accounts from this network. Try again later.');
  if (await one(d, 'SELECT id FROM users WHERE username_lc = ?', username.toLowerCase())) throw new ApiError(409, 'That username is taken');
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const iter = iterations(ctx.env);
  const hash = await pbkdf2(password, salt, iter);
  const id = newId();
  try {
    await run(d, 'INSERT INTO users (id, username, username_lc, pass_hash, pass_salt, pass_iter, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, username, username.toLowerCase(), hash, salt, iter, now, now);
  } catch { throw new ApiError(409, 'That username is taken'); }
  await bump(d, `signup:${ip}`, 3600_000, now);
  const s = await createSession(d, id, now);
  return { ...s, user: me({ id, username, avatarVer: 0, bio: '', createdAt: now }) };
}
async function login(ctx, b, ip) {
  const d = db(ctx);
  const { username, password } = readCreds(b);
  if (!username || !password || password.length > 128) throw new ApiError(401, 'Wrong username or password');
  const now = ctx.now();
  const uk = `login:u:${username.toLowerCase()}`, ik = `login:ip:${ip}`;
  if (await throttled(d, uk, 8, 15 * 60_000, now) || await throttled(d, ik, 30, 15 * 60_000, now)) throw new ApiError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
  const u = await one(d, 'SELECT * FROM users WHERE username_lc = ?', username.toLowerCase());
  // same work whether or not the user exists, so timing doesn't reveal usernames
  const hash = await pbkdf2(password, u ? u.pass_salt : 'AAAAAAAAAAAAAAAAAAAAAA==', u ? u.pass_iter : iterations(ctx.env));
  if (!u || !sameStr(hash, u.pass_hash)) { await bump(d, uk, 15 * 60_000, now); await bump(d, ik, 15 * 60_000, now); throw new ApiError(401, 'Wrong username or password'); }
  await run(d, 'DELETE FROM auth_throttle WHERE key = ?', uk);
  const s = await createSession(d, u.id, now);
  return { ...s, user: me({ id: u.id, username: u.username, avatarVer: u.avatar_ver, bio: u.bio, createdAt: u.created_at }) };
}

// ---- profile --------------------------------------------------------------------------------------------------------------
function sniff(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}
async function setAvatar(ctx, u, b) {
  const m = typeof b.image === 'string' ? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image) : null;
  if (!m) throw bad('Upload a PNG, JPEG or WebP picture');
  let bytes; try { bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)); } catch { throw bad('That picture could not be read'); }
  if (bytes.length > MAX_AVATAR) throw new ApiError(413, 'Picture is too large (150 KB max after resizing)');
  const mime = sniff(bytes);
  if (!mime) throw bad('That file is not a PNG, JPEG or WebP picture');
  const d = db(ctx);
  await run(d, 'UPDATE users SET avatar = ?, avatar_mime = ?, avatar_ver = avatar_ver + 1, updated_at = ? WHERE id = ?', bytes, mime, ctx.now(), u.id);
  const r = await one(d, 'SELECT avatar_ver FROM users WHERE id = ?', u.id);
  return { user: me({ ...u, avatarVer: r.avatar_ver }) };
}
async function setProfile(ctx, u, b) {
  const bio = cleanText(b.bio, 160);
  await run(db(ctx), 'UPDATE users SET bio = ?, updated_at = ? WHERE id = ?', bio || null, ctx.now(), u.id);
  return { user: me({ ...u, bio }) };
}
export async function avatarResponse(ctx, id) {
  if (!ID.test(id)) return new Response('Not found', { status: 404 });
  const r = await one(db(ctx), 'SELECT avatar, avatar_mime FROM users WHERE id = ?', id);
  if (!r || !r.avatar || !r.avatar_mime) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const bytes = r.avatar instanceof Uint8Array ? r.avatar : new Uint8Array(r.avatar);
  return new Response(bytes, { status: 200, headers: { 'content-type': r.avatar_mime, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'cross-origin', 'content-security-policy': "default-src 'none'" } });
}
async function deleteAccount(ctx, u, b) {
  const d = db(ctx);
  const row = await one(d, 'SELECT pass_hash, pass_salt, pass_iter FROM users WHERE id = ?', u.id);
  if (typeof b.password !== 'string' || !sameStr(await pbkdf2(b.password, row.pass_salt, row.pass_iter), row.pass_hash)) throw new ApiError(401, 'Wrong password');
  const chats = await all(d, 'SELECT chat_id FROM chat_members WHERE user_id = ?', u.id);
  await deleteWallet(ctx, u.id);
  await run(d, 'DELETE FROM users WHERE id = ?', u.id);
  for (const c of chats) {
    const left = await one(d, 'SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', c.chat_id);
    if (!left || !left.n) await run(d, 'DELETE FROM chats WHERE id = ?', c.chat_id);
  }
  return { deleted: true };
}

// ---- stats + activity -----------------------------------------------------------------------------------------------------
async function putStats(ctx, u, b) {
  const nums = ['equity', 'deposits', 'realized', 'winRate', 'sells', 'trades'];
  for (const k of nums) if (!fin(b[k])) throw bad(`${k} must be a number`);
  if (b.deposits < 10_000 || b.deposits > 1e8) throw bad('deposits out of range');
  if (b.equity < 0 || b.equity > 1e10) throw bad('equity out of range');
  if (b.winRate < 0 || b.winRate > 100) throw bad('winRate out of range');
  if (!Number.isInteger(b.sells) || !Number.isInteger(b.trades) || b.sells < 0 || b.trades < b.sells || b.trades > 1e6) throw bad('trade counts out of range');
  const best = b.best && typeof b.best === 'object' && fin(b.best.pct) && typeof b.best.symbol === 'string' ? { s: cleanText(b.best.symbol, 20), p: Math.max(-100, Math.min(1e6, b.best.pct)) } : null;
  // PnL is derived here, never taken from the client
  const pnl = b.equity - b.deposits, pct = (pnl / b.deposits) * 100;
  await run(db(ctx), `INSERT INTO user_stats (user_id, equity, deposits, pnl, pnl_pct, realized, win_rate, sells, trades, best_symbol, best_pct, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (user_id) DO UPDATE SET equity = excluded.equity, deposits = excluded.deposits, pnl = excluded.pnl, pnl_pct = excluded.pnl_pct, realized = excluded.realized,
      win_rate = excluded.win_rate, sells = excluded.sells, trades = excluded.trades, best_symbol = excluded.best_symbol, best_pct = excluded.best_pct, updated_at = excluded.updated_at`,
  u.id, b.equity, b.deposits, pnl, pct, b.realized, b.winRate, b.sells, b.trades, best ? best.s : null, best ? best.p : null, ctx.now());
  return { ok: true };
}
function readActivity(it, now) {
  if (!it || typeof it !== 'object' || !CLIENT_ID.test(it.id || '')) throw bad('Each item needs an id');
  if (!fin(it.t) || it.t > now + 300_000 || it.t < now - 30 * DAY) throw bad('Activity time out of range');
  if (!ADDR.test(it.mint || '')) throw bad('Activity needs a token address');
  const symbol = cleanText(it.symbol, 20);
  if (!symbol) throw bad('Activity needs a symbol');
  if (it.kind === 'trade') {
    if (it.side !== 'BUY' && it.side !== 'SELL') throw bad('side must be BUY or SELL');
    if (!fin(it.usd) || it.usd <= 0 || it.usd > 1e8 || !fin(it.price) || it.price <= 0) throw bad('Trade amounts out of range');
    if (it.pnl !== undefined && !fin(it.pnl)) throw bad('pnl must be a number');
    return { kind: 'trade', data: { side: it.side, mint: it.mint, symbol, usd: it.usd, price: it.price, ...(it.pnl !== undefined ? { pnl: it.pnl } : {}) } };
  }
  if (it.kind === 'thesis') {
    const text = cleanText(it.text, 280);
    if (!text) throw bad('Thesis text is empty');
    return { kind: 'thesis', data: { mint: it.mint, symbol, bull: !!it.bull, text } };
  }
  throw bad('kind must be trade or thesis');
}
async function postActivity(ctx, u, b) {
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 25) throw bad('Send 1–25 items');
  const d = db(ctx);
  const now = ctx.now();
  let added = 0;
  for (const it of b.items) {
    const a = readActivity(it, now);
    const r = await run(d, 'INSERT OR IGNORE INTO activity (user_id, client_id, kind, data, t) VALUES (?, ?, ?, ?, ?)', u.id, it.id, a.kind, JSON.stringify(a.data), Math.round(it.t));
    added += changes(r);
  }
  // keep the newest 500 per user
  if (Math.random() < 0.1) await run(d, 'DELETE FROM activity WHERE user_id = ? AND id NOT IN (SELECT id FROM activity WHERE user_id = ? ORDER BY t DESC LIMIT 500)', u.id, u.id);
  return { added };
}
const activityView = (r) => ({ id: r.id, kind: r.kind, t: r.t, ...JSON.parse(r.data), user: r.username ? summary(r) : undefined });

// ---- friends -------------------------------------------------------------------------------------------------------------
async function relation(d, me_, other) {
  const [a, b] = pair(me_, other);
  const r = await one(d, 'SELECT status, requested_by FROM friendships WHERE user_a = ? AND user_b = ?', a, b);
  if (!r) return 'none';
  if (r.status === 'accepted') return 'friends';
  return r.requested_by === me_ ? 'requested' : 'incoming';
}
async function areFriends(d, x, y) { return (await relation(d, x, y)) === 'friends'; }
async function friendsOf(d, uid) {
  return all(d, `SELECT u.id, u.username, u.avatar_ver FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END
    WHERE (f.user_a = ? OR f.user_b = ?) AND f.status = 'accepted' ORDER BY u.username_lc`, uid, uid, uid);
}
async function listFriends(ctx, u) {
  const d = db(ctx);
  const rows = await all(d, `SELECT f.status, f.requested_by, f.updated_at, u.id, u.username, u.avatar_ver FROM friendships f
    JOIN users u ON u.id = CASE WHEN f.user_a = ? THEN f.user_b ELSE f.user_a END WHERE f.user_a = ? OR f.user_b = ? ORDER BY u.username_lc`, u.id, u.id, u.id);
  return {
    friends: rows.filter((r) => r.status === 'accepted').map(summary),
    incoming: rows.filter((r) => r.status === 'pending' && r.requested_by !== u.id).map(summary),
    outgoing: rows.filter((r) => r.status === 'pending' && r.requested_by === u.id).map(summary),
  };
}
async function requestFriend(ctx, u, b) {
  const d = db(ctx);
  const name = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  const other = await one(d, 'SELECT id, username, avatar_ver FROM users WHERE username_lc = ?', name);
  if (!other) throw new ApiError(404, 'No BAGZ user with that name');
  if (other.id === u.id) throw bad('That’s you');
  const now = ctx.now();
  if (await throttled(d, `friendreq:${u.id}`, 40, DAY, now)) throw new ApiError(429, 'You’ve sent a lot of friend requests today. Try again tomorrow.');
  const rel = await relation(d, u.id, other.id);
  if (rel === 'friends') return { status: 'friends', user: summary(other) };
  if (rel === 'requested') return { status: 'requested', user: summary(other) };
  const [a, c] = pair(u.id, other.id);
  if (rel === 'incoming') {
    // they already asked you: sending one back accepts it
    await run(d, "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE user_a = ? AND user_b = ?", now, a, c);
    return { status: 'friends', user: summary(other) };
  }
  await run(d, "INSERT INTO friendships (user_a, user_b, requested_by, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)", a, c, u.id, now, now);
  await bump(d, `friendreq:${u.id}`, DAY, now);
  return { status: 'requested', user: summary(other) };
}
async function respondFriend(ctx, u, b) {
  const d = db(ctx);
  if (!ID.test(b.userId || '')) throw bad('userId is not valid');
  if (await relation(d, u.id, b.userId) !== 'incoming') throw new ApiError(404, 'No friend request from that user');
  const [a, c] = pair(u.id, b.userId);
  if (b.accept === true) await run(d, "UPDATE friendships SET status = 'accepted', updated_at = ? WHERE user_a = ? AND user_b = ?", ctx.now(), a, c);
  else await run(d, 'DELETE FROM friendships WHERE user_a = ? AND user_b = ?', a, c);
  return { status: b.accept === true ? 'friends' : 'none' };
}
async function removeFriend(ctx, u, b) {
  if (!ID.test(b.userId || '')) throw bad('userId is not valid');
  const [a, c] = pair(u.id, b.userId);
  await run(db(ctx), 'DELETE FROM friendships WHERE user_a = ? AND user_b = ?', a, c);
  return { status: 'none' };
}
async function searchUsers(ctx, u, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,20}$/.test(s)) return { users: [] };
  const rows = await all(db(ctx), "SELECT id, username, avatar_ver FROM users WHERE username_lc LIKE ? ESCAPE '\\' AND id != ? AND avatar_ver > 0 ORDER BY length(username_lc), username_lc LIMIT 10", s.replace(/_/g, '\\_') + '%', u ? u.id : '');
  return { users: rows.map(summary) };
}

// ---- public profile + leaderboard + friends feed --------------------------------------------------------------------------
const statsView = (s) => s && ({ equity: s.equity, deposits: s.deposits, pnl: s.pnl, pnlPct: s.pnl_pct, realized: s.realized, winRate: s.win_rate, sells: s.sells, trades: s.trades, best: s.best_symbol ? { symbol: s.best_symbol, pct: s.best_pct } : null, updatedAt: s.updated_at });
async function profile(ctx, viewer, username) {
  const d = db(ctx);
  const u = await one(d, 'SELECT id, username, avatar_ver, bio, created_at FROM users WHERE username_lc = ?', String(username || '').toLowerCase());
  if (!u || !u.avatar_ver) throw new ApiError(404, 'No BAGZ profile with that name');
  const stats = await one(d, 'SELECT * FROM user_stats WHERE user_id = ?', u.id);
  const acts = await all(d, 'SELECT * FROM activity WHERE user_id = ? ORDER BY t DESC LIMIT 20', u.id);
  const friends = await one(d, "SELECT COUNT(*) AS n FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'", u.id, u.id);
  let rank = null;
  if (stats && stats.trades > 0) rank = (await one(d, 'SELECT COUNT(*) AS n FROM user_stats s JOIN users x ON x.id = s.user_id WHERE x.avatar_ver > 0 AND s.trades > 0 AND s.pnl_pct > ?', stats.pnl_pct)).n + 1;
  return {
    user: { ...summary(u), bio: u.bio || '', createdAt: u.created_at },
    stats: statsView(stats), rank, friends: friends.n,
    activity: acts.map(activityView),
    relation: viewer ? (viewer.id === u.id ? 'self' : await relation(d, viewer.id, u.id)) : 'none',
  };
}
const SORTS = { pnl_pct: 's.pnl_pct', pnl: 's.pnl', win_rate: 's.win_rate' };
async function leaderboard(ctx, viewer, q) {
  const d = db(ctx);
  const col = SORTS[q.get('sort')] || SORTS.pnl_pct;
  const friendsOnly = q.get('scope') === 'friends';
  if (friendsOnly && !viewer) throw new ApiError(401, 'Sign in to see your friends');
  let ids = null;
  if (friendsOnly) ids = [viewer.id, ...(await friendsOf(d, viewer.id)).map((f) => f.id)];
  const where = `x.avatar_ver > 0 AND s.trades > 0${ids ? ` AND x.id IN (${ids.map(() => '?').join(',')})` : ''}`;
  const rows = await all(d, `SELECT x.id, x.username, x.avatar_ver, s.* FROM user_stats s JOIN users x ON x.id = s.user_id WHERE ${where} ORDER BY ${col} DESC, s.updated_at ASC LIMIT 100`, ...(ids || []));
  const total = (await one(d, `SELECT COUNT(*) AS n FROM user_stats s JOIN users x ON x.id = s.user_id WHERE ${where}`, ...(ids || []))).n;
  let mine = null;
  if (viewer) {
    const s = await one(d, 'SELECT s.* FROM user_stats s WHERE s.user_id = ?', viewer.id);
    if (s && s.trades > 0) {
      const v = s[col.slice(2)];
      const ahead = (await one(d, `SELECT COUNT(*) AS n FROM user_stats s JOIN users x ON x.id = s.user_id WHERE ${where} AND ${col} > ?`, ...(ids || []), v)).n;
      mine = { rank: ahead + 1, stats: statsView(s) };
    }
  }
  return { rows: rows.map((r, i) => ({ rank: i + 1, user: summary(r), stats: statsView(r) })), total, mine };
}
async function friendsFeed(ctx, u, q) {
  const d = db(ctx);
  const ids = (await friendsOf(d, u.id)).map((f) => f.id);
  if (!ids.length) return { items: [], friends: 0 };
  const before = Number(q.get('before')) || 9e15;
  const rows = await all(d, `SELECT a.*, x.username, x.avatar_ver FROM activity a JOIN users x ON x.id = a.user_id WHERE a.user_id IN (${ids.map(() => '?').join(',')}) AND a.t < ? ORDER BY a.t DESC LIMIT 50`, ...ids, before);
  return { items: rows.map((r) => ({ ...activityView(r), user: summary({ id: r.user_id, username: r.username, avatar_ver: r.avatar_ver }) })), friends: ids.length };
}

// ---- group chats ----------------------------------------------------------------------------------------------------------
async function member(d, chatId, uid) {
  if (!ID.test(chatId)) throw new ApiError(404, 'Chat not found');
  const m = await one(d, 'SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, uid);
  if (!m) throw new ApiError(404, 'Chat not found');
  return m;
}
async function systemLine(d, chatId, text, now) {
  await run(d, 'INSERT INTO messages (chat_id, user_id, body, t) VALUES (?, NULL, ?, ?)', chatId, text, now);
  await run(d, 'UPDATE chats SET last_msg_at = ? WHERE id = ?', now, chatId);
}
async function listChats(ctx, u) {
  const d = db(ctx);
  const chats = await all(d, `SELECT c.*, m.last_read FROM chat_members m JOIN chats c ON c.id = m.chat_id WHERE m.user_id = ? ORDER BY c.last_msg_at DESC LIMIT 100`, u.id);
  const out = [];
  for (const c of chats) {
    const members = await all(d, 'SELECT u.id, u.username, u.avatar_ver FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY m.joined_at LIMIT 6', c.id);
    const count = (await one(d, 'SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', c.id)).n;
    const last = await one(d, 'SELECT m.*, u.username FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 1', c.id);
    const unread = (await one(d, 'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ? AND (user_id IS NULL OR user_id != ?)', c.id, c.last_read, u.id)).n;
    out.push({ id: c.id, name: c.name, members: members.map(summary), memberCount: count, unread, lastAt: c.last_msg_at, last: last ? { body: last.body, username: last.username || null, t: last.t } : null });
  }
  return { chats: out, unread: out.reduce((a, c) => a + c.unread, 0) };
}
async function createChat(ctx, u, b) {
  const d = db(ctx);
  const name = cleanText(b.name, 40);
  if (!name) throw bad('Give the group a name');
  const ids = Array.isArray(b.memberIds) ? [...new Set(b.memberIds.filter((x) => typeof x === 'string'))] : [];
  if (!ids.length) throw bad('Add at least one friend');
  if (ids.length + 1 > MAX_GROUP) throw bad(`Groups are limited to ${MAX_GROUP} people`);
  for (const id of ids) if (!ID.test(id) || !(await areFriends(d, u.id, id))) throw new ApiError(403, 'You can only add friends to a group');
  const now = ctx.now();
  if (await throttled(d, `chatcreate:${u.id}`, 20, DAY, now)) throw new ApiError(429, 'You’ve made a lot of groups today. Try again tomorrow.');
  await bump(d, `chatcreate:${u.id}`, DAY, now);
  const id = newId();
  await run(d, 'INSERT INTO chats (id, name, created_by, created_at, last_msg_at) VALUES (?, ?, ?, ?, ?)', id, name, u.id, now, now);
  for (const m of [u.id, ...ids]) await run(d, 'INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', id, m, now);
  await systemLine(d, id, `${u.username} created “${name}”`, now);
  return { id };
}
async function messages(ctx, u, chatId, q) {
  const d = db(ctx);
  await member(d, chatId, u.id);
  const after = Number(q.get('after')) || 0;
  const rows = after
    ? await all(d, 'SELECT m.*, x.username, x.avatar_ver FROM messages m LEFT JOIN users x ON x.id = m.user_id WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200', chatId, after)
    : (await all(d, 'SELECT m.*, x.username, x.avatar_ver FROM messages m LEFT JOIN users x ON x.id = m.user_id WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 60', chatId)).reverse();
  if (rows.length) await run(d, 'UPDATE chat_members SET last_read = MAX(last_read, ?) WHERE chat_id = ? AND user_id = ?', rows[rows.length - 1].id, chatId, u.id);
  const chat = await one(d, 'SELECT id, name, created_by FROM chats WHERE id = ?', chatId);
  const members = await all(d, 'SELECT u.id, u.username, u.avatar_ver FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY u.username_lc', chatId);
  return {
    chat: { id: chat.id, name: chat.name, members: members.map(summary) },
    messages: rows.map((m) => ({ id: m.id, body: m.body, t: m.t, system: m.user_id === null, user: m.user_id ? (m.username ? summary({ id: m.user_id, username: m.username, avatar_ver: m.avatar_ver }) : { id: m.user_id, username: 'deleted user', avatarVer: 0 }) : null })),
  };
}
async function sendMessage(ctx, u, chatId, b) {
  const d = db(ctx);
  await member(d, chatId, u.id);
  const body = cleanText(b.body, 1000);
  if (!body) throw bad('Message is empty');
  const now = ctx.now();
  if (await throttled(d, `msg:${u.id}`, 30, 60_000, now)) throw new ApiError(429, 'Slow down a little');
  await bump(d, `msg:${u.id}`, 60_000, now);
  const r = await run(d, 'INSERT INTO messages (chat_id, user_id, body, t) VALUES (?, ?, ?, ?)', chatId, u.id, body, now);
  await run(d, 'UPDATE chats SET last_msg_at = ? WHERE id = ?', now, chatId);
  const id = r.meta && r.meta.last_row_id;
  if (id) await run(d, 'UPDATE chat_members SET last_read = MAX(last_read, ?) WHERE chat_id = ? AND user_id = ?', id, chatId, u.id);
  return { id: id ?? null, t: now };
}
async function addMembers(ctx, u, chatId, b) {
  const d = db(ctx);
  await member(d, chatId, u.id);
  const ids = Array.isArray(b.userIds) ? [...new Set(b.userIds.filter((x) => typeof x === 'string'))] : [];
  if (!ids.length) throw bad('Pick at least one friend');
  const count = (await one(d, 'SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', chatId)).n;
  if (count + ids.length > MAX_GROUP) throw bad(`Groups are limited to ${MAX_GROUP} people`);
  const now = ctx.now();
  const added = [];
  for (const id of ids) {
    if (!ID.test(id) || !(await areFriends(d, u.id, id))) throw new ApiError(403, 'You can only add your friends');
    const r = await run(d, 'INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', chatId, id, now);
    if (changes(r)) added.push((await one(d, 'SELECT username FROM users WHERE id = ?', id)).username);
  }
  if (added.length) await systemLine(d, chatId, `${u.username} added ${added.join(', ')}`, now);
  return { added: added.length };
}
async function leaveChat(ctx, u, chatId) {
  const d = db(ctx);
  await member(d, chatId, u.id);
  await run(d, 'DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?', chatId, u.id);
  const left = (await one(d, 'SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?', chatId)).n;
  if (!left) await run(d, 'DELETE FROM chats WHERE id = ?', chatId);
  else await systemLine(d, chatId, `${u.username} left`, ctx.now());
  return { left: true };
}

// ---- router ---------------------------------------------------------------------------------------------------------------
/** Returns a result object, or undefined when the route isn't a social route. */
export async function social(ctx, request, path, body, url) {
  const m = request.method;
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  const is = (method, re) => m === method && re.exec(path);
  let p;
  if (is('POST', /^\/auth\/signup$/)) return signup(ctx, body, ip);
  if (is('POST', /^\/auth\/login$/)) return login(ctx, body, ip);
  if (is('POST', /^\/auth\/logout$/)) { const u = await currentUser(ctx, request); await run(db(ctx), 'DELETE FROM sessions WHERE token_hash = ?', u.tokenHash); return { ok: true }; }
  if (is('GET', /^\/me$/)) return { user: me(await currentUser(ctx, request)) };
  if (is('POST', /^\/me\/avatar$/)) return setAvatar(ctx, await currentUser(ctx, request), body);
  if (is('POST', /^\/me\/profile$/)) return setProfile(ctx, await currentUser(ctx, request), body);
  if (is('POST', /^\/me\/stats$/)) return putStats(ctx, await currentUser(ctx, request), body);
  if (is('GET', /^\/me\/wallet$/)) return getWallet(ctx, await currentUser(ctx, request), url.searchParams.get('have'));
  if (is('POST', /^\/me\/wallet$/)) return putWallet(ctx, await currentUser(ctx, request), body);
  if (is('POST', /^\/me\/activity$/)) return postActivity(ctx, await currentUser(ctx, request), body);
  if (is('POST', /^\/me\/delete$/)) return deleteAccount(ctx, await currentUser(ctx, request), body);
  if (is('GET', /^\/users\/search$/)) return searchUsers(ctx, await currentUser(ctx, request, false), url.searchParams.get('q'));
  if ((p = is('GET', /^\/users\/([A-Za-z0-9_]{3,20})$/))) return profile(ctx, await currentUser(ctx, request, false), p[1]);
  if (is('GET', /^\/leaderboard$/)) return leaderboard(ctx, await currentUser(ctx, request, false), url.searchParams);
  if (is('GET', /^\/friends$/)) return listFriends(ctx, await currentUser(ctx, request));
  if (is('POST', /^\/friends\/request$/)) return requestFriend(ctx, await currentUser(ctx, request), body);
  if (is('POST', /^\/friends\/respond$/)) return respondFriend(ctx, await currentUser(ctx, request), body);
  if (is('POST', /^\/friends\/remove$/)) return removeFriend(ctx, await currentUser(ctx, request), body);
  if (is('GET', /^\/feed\/friends$/)) return friendsFeed(ctx, await currentUser(ctx, request), url.searchParams);
  if (is('GET', /^\/chats$/)) return listChats(ctx, await currentUser(ctx, request));
  if (is('POST', /^\/chats$/)) return createChat(ctx, await currentUser(ctx, request), body);
  if ((p = is('GET', /^\/chats\/([A-Za-z0-9]{16,32})\/messages$/))) return messages(ctx, await currentUser(ctx, request), p[1], url.searchParams);
  if ((p = is('POST', /^\/chats\/([A-Za-z0-9]{16,32})\/messages$/))) return sendMessage(ctx, await currentUser(ctx, request), p[1], body);
  if ((p = is('POST', /^\/chats\/([A-Za-z0-9]{16,32})\/members$/))) return addMembers(ctx, await currentUser(ctx, request), p[1], body);
  if ((p = is('POST', /^\/chats\/([A-Za-z0-9]{16,32})\/leave$/))) return leaveChat(ctx, await currentUser(ctx, request), p[1]);
  return undefined;
}
