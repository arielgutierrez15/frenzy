/**
 * Admin console data: /v1/admin/overview, /admin/users, /admin/log — counts, daily series, merged log, privacy, auth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
import { D1 } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const DAY = 86_400_000;

function setup(extra: Record<string, string> = {}) {
  const db = new D1();
  let t = 1_800_000_000_000;
  const env: any = { ALLOWED_ORIGINS: ORIGIN, Db: db, PASSWORD_ITERATIONS: '10000', RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', ...extra };
  let n = 0;
  const call = async (path: string, o: { body?: unknown; token?: string } = {}) => {
    const h: Record<string, string> = { 'cf-connecting-ip': `10.9.0.${n++ % 250}`, 'content-type': 'application/json', origin: ORIGIN };
    if (o.token) h.authorization = `Bearer ${o.token}`;
    const res = await handle(new Request(`https://api.test${path}`, { method: o.body === undefined ? 'GET' : 'POST', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, undefined, { fetch: async () => new Response('{}'), now: () => t, cache: null });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const user = async (username: string) => {
    const r = await call('/v1/auth/signup', { body: { username, password: 'hunter22pass' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token as string;
  };
  return { db, env, call, user, advance: (ms: number) => { t += ms; }, now: () => t };
}

test('admin overview, users and log report real counts and never leak secrets', async () => {
  const s = setup({ TEST_COPY: '1' }); // test copy: a signed-in account may use the admin desk
  const ana = await s.user('anna');
  s.advance(DAY + 60_000);
  const ben = await s.user('ben');
  await s.user('cyd');
  const trade = (id: string, side: string, usd: number) => ({ id, kind: 'trade', t: s.now(), mint: MINT, symbol: 'WIF', side, usd, price: 1.5 });
  assert.equal((await s.call('/v1/me/activity', { token: ana, body: { items: [trade('t-000001', 'BUY', 100), trade('t-000002', 'SELL', 140)] } })).status, 200);
  assert.equal((await s.call('/v1/me/activity', { token: ben, body: { items: [trade('t-000003', 'BUY', 50)] } })).status, 200);

  const o = await s.call('/v1/admin/overview?days=7', { token: ana });
  assert.equal(o.status, 200, o.text);
  assert.equal(o.body.users.total, 3);
  assert.equal(o.body.users.new24h, 2);
  assert.equal(o.body.users.new7d, 3);
  assert.equal(o.body.signups.length, 7);
  assert.deepEqual(o.body.signups.slice(-2).map((x: any) => x.n), [1, 2]);
  assert.equal(o.body.paper.trades, 3);
  assert.equal(o.body.paper.traders, 2);
  assert.equal(o.body.paper.buys, 2);
  assert.equal(o.body.paper.volumeUsd, 290);
  assert.equal(o.body.tradesDaily.at(-1).n, 3);
  assert.equal(o.body.topTokens[0].symbol, 'WIF');
  assert.equal(o.body.swaps.total, 0);
  assert.equal(o.body.boost.paidOrders, 0);

  const u = await s.call('/v1/admin/users?sort=trades', { token: ana });
  assert.equal(u.status, 200);
  assert.equal(u.body.total, 3);
  assert.equal(u.body.users[0].username, 'anna');
  assert.equal(u.body.users[0].trades, 2);
  assert.equal((await s.call('/v1/admin/users?q=BE', { token: ana })).body.users.map((x: any) => x.username).join(), 'ben');
  assert.ok(!/pass_hash|pass_salt|token_hash/.test(u.text));

  const log = await s.call('/v1/admin/log', { token: ana });
  assert.equal(log.status, 200);
  assert.equal(log.body.events.filter((e: any) => e.type === 'signup').length, 3);
  assert.equal(log.body.events.filter((e: any) => e.type === 'trade').length, 3);
  for (let i = 1; i < log.body.events.length; i++) assert.ok(log.body.events[i - 1].t >= log.body.events[i].t, 'newest first');
  const only = await s.call('/v1/admin/log?type=signup', { token: ana });
  assert.ok(only.body.events.every((e: any) => e.type === 'signup'));
});

test('admin data needs an admin session outside the test copy', async () => {
  const s = setup({ ADMIN_SESSION_SECRET: 'x'.repeat(40), ADMIN_WALLETS: '' });
  const tok = await s.user('dee');
  for (const p of ['/v1/admin/overview', '/v1/admin/users', '/v1/admin/log']) {
    assert.equal((await s.call(p)).status, 401);
    assert.equal((await s.call(p, { token: tok })).status, 401, 'a normal account token is not an admin session');
  }
});
