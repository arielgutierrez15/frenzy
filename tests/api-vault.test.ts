/**
 * The Vault through the real Worker entry point, with the real migrations on a SQLite-backed D1:
 * coins from challenges (claimed once a day), limited cards (30 serials each), no overspending, no real-money path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
import { D1 } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const DAY = 86_400_000;

function setup() {
  const db = new D1();
  let t = 1_800_000_000_000 + 3_600_000;
  const env: any = { ALLOWED_ORIGINS: ORIGIN, Db: db, PASSWORD_ITERATIONS: '10000', RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000' };
  let n = 0;
  const call = async (path: string, o: { body?: unknown; token?: string } = {}) => {
    const h: Record<string, string> = { 'cf-connecting-ip': `10.9.0.${n++ % 250}`, 'content-type': 'application/json', origin: ORIGIN };
    if (o.token) h.authorization = `Bearer ${o.token}`;
    const res = await handle(new Request(`https://api.test/v1${path}`, { method: o.body === undefined ? 'GET' : 'POST', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, undefined, { fetch: async () => new Response('{}'), now: () => t, cache: null });
    return { status: res.status, body: await res.json() as any };
  };
  const user = async (username: string) => {
    const r = await call('/auth/signup', { body: { username, password: 'hunter22pass' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token as string;
  };
  return { db, call, user, now: () => t, advance: (ms: number) => { t += ms; } };
}
const trade = (id: string, t: number, o: Record<string, unknown> = {}) => ({ id, kind: 'trade', side: 'BUY', mint: MINT, symbol: 'WIF', usd: 100, price: 1, t, ...o });

test('vault: needs an account', async () => {
  const s = setup();
  assert.equal((await s.call('/vault')).status, 401);
});

test('vault: welcome bonus once, challenges from synced trades, once per day', async () => {
  const s = setup();
  const tok = await s.user('ana_v');
  let v = (await s.call('/vault', { token: tok })).body;
  assert.equal(v.balance, 0);
  assert.equal(v.welcome, 100);
  assert.equal(v.realMoney, false);
  assert.equal(v.challenges.length, 4);
  v = (await s.call('/vault/claim', { body: { id: 'welcome' }, token: tok })).body;
  assert.equal(v.balance, 100);
  assert.equal(v.welcome, null);
  assert.equal((await s.call('/vault/claim', { body: { id: 'welcome' }, token: tok })).status, 400, 'welcome only once');

  assert.equal((await s.call('/vault/claim', { body: { id: 'trades3' }, token: tok })).status, 400, 'not finished');
  const t = s.now();
  await s.call('/me/activity', { body: { items: [trade('a', t), trade('b', t), trade('c', t), trade('d', t, { side: 'SELL', usd: 130, pnl: 30 })] }, token: tok });
  v = (await s.call('/vault', { token: tok })).body;
  const byId = Object.fromEntries(v.challenges.map((c: any) => [c.id, c]));
  assert.equal(byId.trades3.progress, 3);
  assert.equal(byId.profit.progress, 1);
  assert.equal(byId.big20.progress, 1, '+30 on a 100 cost is +30%');
  assert.equal(byId.thesis.progress, 0);
  v = (await s.call('/vault/claim', { body: { id: 'trades3' }, token: tok })).body;
  assert.equal(v.balance, 150);
  assert.equal((await s.call('/vault/claim', { body: { id: 'trades3' }, token: tok })).status, 400, 'once a day');
  await s.call('/vault/claim', { body: { id: 'big20' }, token: tok });
  assert.equal((await s.call('/vault', { token: tok })).body.balance, 300);

  // next day: yesterday's trades don't count, today's do
  s.advance(DAY);
  v = (await s.call('/vault', { token: tok })).body;
  assert.ok(v.challenges.every((c: any) => !c.claimed && c.progress === 0));
  const t2 = s.now();
  await s.call('/me/activity', { body: { items: [trade('e', t2), trade('f', t2), trade('g', t2)] }, token: tok });
  assert.equal((await s.call('/vault/claim', { body: { id: 'trades3' }, token: tok })).body.balance, 350);
});

test('vault: buying spends coins, gives the next serial, one copy each, never overspends', async () => {
  const s = setup();
  const tok = await s.user('ben_v');
  await s.call('/vault/claim', { body: { id: 'welcome' }, token: tok });
  assert.equal((await s.call('/vault/buy', { body: { card: 'bear-02' }, token: tok })).status, 402, 'rare costs 250');
  assert.equal((await s.call('/vault/buy', { body: { card: 'nope-01' }, token: tok })).status, 400);
  assert.equal((await s.call('/vault/buy', { body: { card: 'bull-02', pay: 'sol' }, token: tok })).status, 403, 'real money is off');
  const r = await s.call('/vault/buy', { body: { card: 'bull-02' }, token: tok });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.bought.card, r.body.bought.serial], ['bull-02', 1]);
  assert.equal(r.body.balance, 0);
  assert.equal(r.body.minted['bull-02'], 1);
  assert.deepEqual(r.body.mine.map((m: any) => m.card), ['bull-02']);
  assert.equal((await s.call('/vault/buy', { body: { card: 'bull-02' }, token: tok })).status, 400, 'one copy each');
  assert.equal((await s.call('/vault/buy', { body: { card: 'bull-04' }, token: tok })).status, 402, 'no coins left');
  assert.equal((await s.call('/vault', { token: tok })).body.balance, 0, 'a failed buy takes nothing');
});

test('vault: only 30 copies of a card ever exist', async () => {
  const s = setup();
  const serials: number[] = [];
  for (let i = 0; i < 31; i++) {
    const tok = await s.user(`u${i}_v`);
    await s.call('/vault/claim', { body: { id: 'welcome' }, token: tok });
    const r = await s.call('/vault/buy', { body: { card: 'bull-06' }, token: tok });
    if (i < 30) { assert.equal(r.status, 200, JSON.stringify(r.body)); serials.push(r.body.bought.serial); }
    else {
      assert.equal(r.status, 409, '31st buyer gets sold out');
      assert.equal((await s.call('/vault', { token: tok })).body.balance, 100, 'and keeps their coins');
    }
  }
  assert.deepEqual(serials, Array.from({ length: 30 }, (_, i) => i + 1));
});

test('vault: rarity is per card, every animal has each rarity', async () => {
  // @ts-ignore plain JS
  const { CARDS, priceOf } = await import('../worker/vault-cards.js');
  for (const series of ['ape', 'bear', 'bull']) for (const r of ['common', 'rare', 'gem']) assert.ok(CARDS.some((c: any) => c.series === series && c.rarity === r), `${series} has a ${r}`);
  assert.equal(priceOf(CARDS.find((c: any) => c.id === 'bull-01')), 600, 'Bull Trade is a Gem');
});
