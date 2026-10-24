/**
 * Paper wallet sync (/v1/me/wallet): each account's paper wallet is stored here so it is the same on every device.
 *
 *  - GET  /v1/me/wallet?have=<rev>  → { rev, updatedAt, wallet } (wallet omitted, unchanged: true, when the caller has rev)
 *  - POST /v1/me/wallet { baseRev, wallet } → { rev } when nobody saved since baseRev; otherwise 409 with the current
 *    { rev, wallet } so the app can merge its changes into it and save again. A save never silently overwrites another
 *    device's trades.
 *
 * The wallet is the owner's own private data (paper money only). It is size-capped and shape-checked, never shown to
 * other people; public numbers still go through /me/stats and /me/activity.
 * The table is created on first use, so the site keeps working before migration 0005 is run.
 */
import { ApiError, database } from './api.js';

export const MAX_WALLET = 1_000_000; // characters of JSON
const SCHEMA = `CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rev INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)`;
const missing = (e) => /no such table/i.test(String(e && e.message));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const bad = (m) => new ApiError(400, m);

function db(ctx) { const d = database(ctx.env); if (!d) throw new ApiError(503, 'Saving wallets needs the BAGZ database, which isn’t connected'); return d; }
/** runs fn; if the wallets table doesn't exist yet, creates it and runs fn again */
async function withTable(d, fn) {
  try { return await fn(); } catch (e) {
    if (!missing(e)) throw e;
    await d.prepare(SCHEMA).bind().run();
    return fn();
  }
}

export function checkWallet(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw bad('wallet must be an object');
  const u = w.user;
  if (!u || typeof u !== 'object') throw bad('wallet.user is missing');
  if (!fin(u.cash) || !fin(u.deposits) || u.deposits < 0 || u.deposits > 1e9 || Math.abs(u.cash) > 1e12) throw bad('wallet cash or deposits out of range');
  if (!u.positions || typeof u.positions !== 'object' || Array.isArray(u.positions)) throw bad('wallet.user.positions must be an object');
  for (const k of ['trades', 'orders', 'theses']) if (!Array.isArray(u[k])) throw bad(`wallet.user.${k} must be a list`);
  if (u.trades.length > 5000 || u.orders.length > 500 || u.theses.length > 2000) throw bad('wallet has too many items');
  for (const t of u.trades) if (!t || typeof t.id !== 'string' || !fin(t.t) || !fin(t.usd) || !fin(t.qty)) throw bad('wallet has a malformed trade');
  for (const p of Object.values(u.positions)) if (!p || !fin(p.qty) || !fin(p.cost)) throw bad('wallet has a malformed position');
}

async function read(d, userId) {
  const r = await withTable(d, () => d.prepare('SELECT rev, data, updated_at FROM wallets WHERE user_id = ?').bind(userId).first());
  return r ? { rev: r.rev, updatedAt: r.updated_at, data: r.data } : { rev: 0, updatedAt: 0, data: null };
}

export async function getWallet(ctx, u, have) {
  const cur = await read(db(ctx), u.id);
  if (have !== null && have !== undefined && have !== '' && Number(have) === cur.rev) return { rev: cur.rev, updatedAt: cur.updatedAt, unchanged: true };
  return { rev: cur.rev, updatedAt: cur.updatedAt, wallet: cur.data ? JSON.parse(cur.data) : null };
}

export async function putWallet(ctx, u, b) {
  const base = b.baseRev;
  if (!Number.isInteger(base) || base < 0) throw bad('baseRev must be a whole number');
  checkWallet(b.wallet);
  const data = JSON.stringify(b.wallet);
  if (data.length > MAX_WALLET) throw new ApiError(413, 'This wallet is too big to save. Reset or trim old trades.');
  const d = db(ctx), now = ctx.now();
  const res = await withTable(d, () => (base === 0
    ? d.prepare('INSERT INTO wallets (user_id, rev, data, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT (user_id) DO NOTHING').bind(u.id, data, now).run()
    : d.prepare('UPDATE wallets SET rev = rev + 1, data = ?, updated_at = ? WHERE user_id = ? AND rev = ?').bind(data, now, u.id, base).run()));
  if ((res && res.meta && res.meta.changes) || 0) return { rev: base + 1, updatedAt: now };
  // someone saved first (another device or tab): hand back what is there so the app can merge and try again
  const cur = await read(d, u.id);
  throw new ApiError(409, 'This wallet changed on another device', { rev: cur.rev, updatedAt: cur.updatedAt, wallet: cur.data ? JSON.parse(cur.data) : null });
}

export async function deleteWallet(ctx, userId) {
  const d = database(ctx.env); if (!d) return;
  try { await d.prepare('DELETE FROM wallets WHERE user_id = ?').bind(userId).run(); } catch (e) { if (!missing(e)) throw e; }
}
