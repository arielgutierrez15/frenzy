/**
 * Paper wallet sync: the three-way merge (src/sync/merge.ts) and the Worker's /v1/me/wallet endpoints
 * (real Worker entry point, real migrations, SQLite-backed D1).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
import { D1 } from './fakechain';
import { mergeWallets, fingerprint, type WalletDoc } from '../src/sync/merge';
import type { Trade } from '../src/types';

// ---------------------------------------------------------------- merge
const doc = (o: Partial<WalletDoc['user']> = {}, epoch = ''): WalletDoc => ({
  v: 1, epoch, settings: { slippage: 5, alertsMinScore: 75 }, coins: {},
  user: { cash: 10_000, deposits: 10_000, positions: {}, trades: [], orders: [], following: [], watchlist: [], theses: [], cards: [], equity: [], ...o },
});
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
let n = 0;
/** apply a market buy/sell to a wallet the way the app does */
function buy(d: WalletDoc, coin: string, usd: number, price: number, id = `x${n++}`): WalletDoc {
  const w = clone(d); const qty = usd / price;
  w.user.cash -= usd;
  const p = w.user.positions[coin] || { coinId: coin, qty: 0, cost: 0, openedAt: 1 };
  p.qty += qty; p.cost += usd; w.user.positions[coin] = p;
  w.user.trades.unshift({ id, t: 1000 + n, side: 'BUY', coinId: coin, symbol: coin, qty, price, usd, fee: 0 } as Trade);
  return w;
}
function sell(d: WalletDoc, coin: string, qty: number, price: number, id = `x${n++}`): WalletDoc {
  const w = clone(d); const p = w.user.positions[coin];
  const usd = qty * price, part = p.cost * (qty / p.qty);
  p.qty -= qty; p.cost -= part; if (p.qty <= 1e-12) delete w.user.positions[coin];
  w.user.cash += usd;
  w.user.trades.unshift({ id, t: 1000 + n, side: 'SELL', coinId: coin, symbol: coin, qty, price, usd, fee: 0, pnl: usd - part } as Trade);
  return w;
}
const ids = (d: WalletDoc) => d.user.trades.map((t) => t.id).sort();
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≠ ${b}`);

test('merge: trades made on two devices at the same time are all kept, cash and positions add up', () => {
  const base = buy(doc(), 'sol:A', 1000, 1, 'b1');
  const phone = buy(base, 'sol:B', 500, 2, 'p1');
  const tg = sell(buy(base, 'sol:C', 300, 3, 't1'), 'sol:A', 400, 1.5, 't2');
  const m = mergeWallets(base, phone, tg);
  assert.deepEqual(ids(m), ['b1', 'p1', 't1', 't2']);
  near(m.user.cash, 10_000 - 1000 - 500 - 300 + 600);
  near(m.user.positions['sol:A'].qty, 600);
  near(m.user.positions['sol:A'].cost, 600);
  near(m.user.positions['sol:B'].qty, 250);
  near(m.user.positions['sol:C'].qty, 100);
  // the other direction gives the same wallet
  const r = mergeWallets(base, tg, phone);
  assert.deepEqual(ids(r), ids(m)); near(r.user.cash, m.user.cash);
});

test('merge: selling everything on one device removes the position; an order filled on both devices counts once', () => {
  const base = buy(doc(), 'sol:A', 1000, 1, 'b1');
  const a = sell(base, 'sol:A', 1000, 2, 's1');
  const b = buy(base, 'sol:D', 200, 1, 'd1');
  const m = mergeWallets(base, a, b);
  assert.equal(m.user.positions['sol:A'], undefined);
  near(m.user.cash, 10_000 - 1000 + 2000 - 200);
  // same fill id on both sides (a limit order that both devices filled)
  const f1 = buy(base, 'sol:E', 100, 1, 'f-o1'), f2 = buy(base, 'sol:E', 100, 1, 'f-o1');
  const mm = mergeWallets(base, f1, f2);
  assert.equal(mm.user.trades.filter((t) => t.id === 'f-o1').length, 1);
  near(mm.user.cash, 10_000 - 1000 - 100);
  near(mm.user.positions['sol:E'].qty, 100);
});

test('merge: an already-synced tab saving its copy back adds nothing twice', () => {
  const base = buy(doc(), 'sol:A', 1000, 1, 'b1');
  const newer = buy(base, 'sol:B', 500, 1, 'n1');
  // tab 2 already merged tab 1's trade, then uploads against the old server base
  const tab2 = buy(newer, 'sol:C', 100, 1, 'c1');
  const m = mergeWallets(base, tab2, newer);
  assert.deepEqual(ids(m), ['b1', 'c1', 'n1']);
  near(m.user.cash, 10_000 - 1000 - 500 - 100);
  near(m.user.positions['sol:B'].qty, 500);
});

test('merge: deposits, orders, watchlist and following merge; removals stick', () => {
  const base = doc({ watchlist: ['w1', 'w2'], following: ['f1'], orders: [{ id: 'o1', coinId: 'sol:A', side: 'BUY', kind: 'limit', trigger: 1, usd: 10, createdAt: 1 }] });
  const a = clone(base); a.user.deposits += 5000; a.user.cash += 5000; a.user.watchlist = ['w1']; a.user.orders = [];
  const b = clone(base); b.user.watchlist = ['w1', 'w2', 'w3']; b.user.following = ['f1', 'f2'];
  const m = mergeWallets(base, a, b);
  near(m.user.deposits, 15_000); near(m.user.cash, 15_000);
  assert.deepEqual(m.user.watchlist, ['w1', 'w3']);
  assert.deepEqual(m.user.following, ['f1', 'f2']);
  assert.equal(m.user.orders.length, 0, 'cancelled on one device stays cancelled');
});

test('merge: a reset or restored backup on one device wins over old trades from the other', () => {
  const base = buy(doc({}, 'e0'), 'sol:A', 1000, 1, 'b1');
  const reset = doc({}, 'e1');
  const other = buy(base, 'sol:B', 100, 1, 'x9');
  assert.deepEqual(ids(mergeWallets(base, reset, other)), []);
  assert.equal(mergeWallets(base, other, reset).epoch, 'e1');
  assert.deepEqual(ids(mergeWallets(base, other, reset)), []);
});

test('merge: first sync on a device keeps both separate histories, or takes the server copy if this device is empty', () => {
  const phone = buy(doc(), 'sol:A', 1000, 1, 'p1');
  const tg = buy(doc(), 'sol:B', 500, 1, 't1');
  const m = mergeWallets(null, tg, phone);
  assert.deepEqual(ids(m), ['p1', 't1']);
  near(m.user.cash, 10_000 - 1500);
  assert.deepEqual(ids(mergeWallets(null, doc(), phone)), ['p1']);
  assert.deepEqual(ids(mergeWallets(null, phone, doc())), ['p1']);
  // the same wallet seen at two moments (shared trades): no double counting
  const later = buy(phone, 'sol:C', 100, 1, 'p2');
  const s = mergeWallets(null, later, phone);
  assert.deepEqual(ids(s), ['p1', 'p2']); near(s.user.cash, 10_000 - 1100);
  assert.equal(fingerprint(mergeWallets(null, phone, later)), fingerprint(s));
});

// ---------------------------------------------------------------- Worker endpoints
const ORIGIN = 'https://arielgutierrez15.github.io';
function setup(dropTable = false) {
  const db = new D1();
  if (dropTable) db.db.exec('DROP TABLE wallets');
  const t = 1_800_000_000_000;
  const env: any = { ALLOWED_ORIGINS: ORIGIN, Db: db, PASSWORD_ITERATIONS: '10000', RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', RATE_WALLET_PER_MIN: '100000' };
  let k = 0;
  const call = async (path: string, o: { body?: unknown; token?: string } = {}) => {
    const h: Record<string, string> = { 'cf-connecting-ip': `10.9.0.${k++ % 250}`, 'content-type': 'application/json', origin: ORIGIN };
    if (o.token) h.authorization = `Bearer ${o.token}`;
    const res = await handle(new Request(`https://api.test${path}`, { method: o.body === undefined ? 'GET' : 'POST', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, undefined, { fetch: async () => new Response('{}'), now: () => t, cache: null });
    return { status: res.status, body: await res.json() as any };
  };
  const user = async (username: string) => { const r = await call('/v1/auth/signup', { body: { username, password: 'hunter22pass' } }); assert.equal(r.status, 200); return r.body.token as string; };
  return { call, user, env, db };
}

test('wallet API: save, read back on another device, stale saves get a 409 with the current wallet', async () => {
  const s = setup();
  const tok = await s.user('ana');
  assert.equal((await s.call('/v1/me/wallet')).status, 401, 'needs an account');
  let r = await s.call('/v1/me/wallet', { token: tok });
  assert.deepEqual([r.status, r.body.rev, r.body.wallet], [200, 0, null]);
  const w1 = buy(doc(), 'sol:A', 100, 1, 'a1');
  r = await s.call('/v1/me/wallet', { token: tok, body: { baseRev: 0, wallet: w1 } });
  assert.deepEqual([r.status, r.body.rev], [200, 1]);
  // another device logs in with a second session and sees it
  const login = await s.call('/v1/auth/login', { body: { username: 'ana', password: 'hunter22pass' } });
  r = await s.call('/v1/me/wallet', { token: login.body.token });
  assert.deepEqual(ids(r.body.wallet), ['a1']);
  assert.equal((await s.call('/v1/me/wallet?have=1', { token: tok })).body.unchanged, true);
  // the second device saves on rev 1; the first device's save on rev 1 is now stale
  r = await s.call('/v1/me/wallet', { token: login.body.token, body: { baseRev: 1, wallet: buy(w1, 'sol:B', 50, 1, 'b2') } });
  assert.equal(r.body.rev, 2);
  r = await s.call('/v1/me/wallet', { token: tok, body: { baseRev: 1, wallet: buy(w1, 'sol:C', 50, 1, 'c3') } });
  assert.equal(r.status, 409);
  assert.equal(r.body.rev, 2);
  assert.deepEqual(ids(r.body.wallet), ['a1', 'b2'], '409 carries what is saved so the app can merge');
  // a second account can't see the first one's wallet
  const ben = await s.user('ben');
  assert.equal((await s.call('/v1/me/wallet', { token: ben })).body.wallet, null);
});

test('wallet API: rejects malformed or oversized wallets; creates its table when the migration was not run', async () => {
  const s = setup(true);
  const tok = await s.user('cara');
  assert.equal((await s.call('/v1/me/wallet', { token: tok })).body.rev, 0, 'works without migration 0005');
  for (const wallet of [null, { user: {} }, { user: { cash: 'x', deposits: 1, positions: {}, trades: [], orders: [], theses: [] } }, { user: { cash: 1, deposits: 1, positions: {}, trades: [{ id: 1 }], orders: [], theses: [] } }]) {
    assert.equal((await s.call('/v1/me/wallet', { token: tok, body: { baseRev: 0, wallet } })).status, 400);
  }
  assert.equal((await s.call('/v1/me/wallet', { token: tok, body: { baseRev: -1, wallet: doc() } })).status, 400);
  const big = doc(); big.user.theses = Array.from({ length: 1500 }, (_, i) => ({ id: 't' + i, t: 1, coinId: 'sol:A', bull: true, text: 'x'.repeat(800), price: 1, mcap: 1 }));
  assert.equal((await s.call('/v1/me/wallet', { token: tok, body: { baseRev: 0, wallet: big } })).status, 413);
  const ok = await s.call('/v1/me/wallet', { token: tok, body: { baseRev: 0, wallet: buy(doc(), 'sol:A', 10, 1, 'z') } });
  assert.equal(ok.body.rev, 1);
  // deleting the account deletes the wallet
  assert.equal((await s.call('/v1/me/delete', { token: tok, body: { password: 'hunter22pass' } })).status, 200);
  assert.equal(s.db.db.prepare('SELECT COUNT(*) AS n FROM wallets').get()!.n, 0);
});

test('wallet API: wallet saves have their own rate budget, separate from other posts', async () => {
  const s = setup();
  s.env.RATE_POST_PER_MIN = '3'; s.env.RATE_WALLET_PER_MIN = '100';
  const tok = await s.user('dan');
  let rev = 0;
  // every call here comes from a different IP in setup(), so use a fixed one via direct handle
  const h = { 'cf-connecting-ip': '10.1.1.1', 'content-type': 'application/json', origin: ORIGIN, authorization: `Bearer ${tok}` };
  const post = async (path: string, body: unknown) => (await handle(new Request(`https://api.test${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) }), s.env, undefined, { fetch: async () => new Response('{}'), now: () => 1_800_000_000_000, cache: null })).status;
  for (let i = 0; i < 10; i++) { assert.equal(await post('/v1/me/wallet', { baseRev: rev, wallet: buy(doc(), 'sol:A', 10 + i, 1, 'w' + i) }), 200); rev++; }
  assert.equal(await post('/v1/me/profile', { bio: 'hi' }), 200, 'other posts still have their budget');
});
