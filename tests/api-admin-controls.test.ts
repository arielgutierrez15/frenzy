/**
 * Admin controls through the real Worker entry point on the real migrations (SQLite-backed D1):
 * kill switches (and that the server obeys them), BOOST queue, revenue, token blocklist, user stats, Vault controls,
 * audit log, and that every new route needs an admin session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
import { D1 } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const MINT2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const DAY = 86_400_000;

function setup(extra: Record<string, string> = {}) {
  const db = new D1();
  let t = 1_800_000_000_000 + 3_600_000;
  const env: any = { ALLOWED_ORIGINS: ORIGIN, Db: db, PASSWORD_ITERATIONS: '10000', RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', TEST_COPY: '1', ...extra };
  let n = 0;
  const call = async (path: string, o: { body?: unknown; token?: string } = {}) => {
    const h: Record<string, string> = { 'cf-connecting-ip': `10.8.0.${n++ % 250}`, 'content-type': 'application/json', origin: ORIGIN };
    if (o.token) h.authorization = `Bearer ${o.token}`;
    const res = await handle(new Request(`https://api.test/v1${path}`, { method: o.body === undefined ? 'GET' : 'POST', headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, undefined, { fetch: async () => new Response('{}'), now: () => t, cache: null });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  const user = async (username: string) => {
    const r = await call('/auth/signup', { body: { username, password: 'hunter22pass' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.token as string;
  };
  const sql = (q: string, ...a: unknown[]) => db.db.prepare(q).run(...(a as any[]));
  const promo = (id: string, o: { mint?: string; status?: string; pkg?: string; price?: string; starts?: number | null; ends?: number | null } = {}) =>
    sql(`INSERT INTO promotions (id, idempotency_key, mint, symbol, name, package, price_raw, duration_ms, advertiser, reference, status, starts_at, ends_at, created_at, pay_by, updated_at)
      VALUES (?, ?, ?, 'WIF', 'dogwifhat', ?, ?, 86400000, 'Adv1111111111111111111111111111111111111111', ?, ?, ?, ?, ?, ?, ?)`,
    id, 'idem-' + id, o.mint || MINT, o.pkg || 'boost', o.price || '20000000', 'ref-' + id, o.status || 'pending_review', o.starts ?? null, o.ends ?? null, t, t + 1800_000, t);
  const pay = (id: string, sig: string, raw = '20000000', at = t) => sql(`INSERT INTO payments (signature, promotion_id, payer, mint, amount_raw, destination, verified_at) VALUES (?, ?, 'Adv1111111111111111111111111111111111111111', ?, ?, 'dest', ?)`, sig, id, USDC, raw, at);
  return { db, env, call, user, sql, promo, pay, now: () => t, advance: (ms: number) => { t += ms; } };
}

test('kill switches: pause and resume, enforced by the server, shown in /config, logged', async () => {
  const s = setup({ ENABLE_LIVE_SWAPS: 'true', ENABLE_LIVE_BOOST_PAYMENTS: 'true' });
  const adm = await s.user('boss');
  let sw = await s.call('/admin/switches', { token: adm });
  assert.equal(sw.status, 200, sw.text);
  assert.deepEqual(sw.body.switches.map((x: any) => x.id), ['swaps', 'boost', 'signups', 'vault']);
  assert.ok(sw.body.switches.every((x: any) => !x.paused && x.running));

  assert.equal((await s.call('/admin/switches', { token: adm, body: { id: 'signups', paused: true } })).status, 400, 'a reason is required to pause');
  assert.equal((await s.call('/admin/switches', { token: adm, body: { id: 'nope', paused: true, reason: 'x' } })).status, 400);
  for (const id of ['swaps', 'boost', 'signups', 'vault']) {
    const r = await s.call('/admin/switches', { token: adm, body: { id, paused: true, reason: 'maintenance' } });
    assert.equal(r.status, 200, r.text);
  }
  sw = await s.call('/admin/switches', { token: adm });
  assert.ok(sw.body.switches.every((x: any) => x.paused && !x.running && x.updatedBy === '@boss'));

  // the server refuses paused features
  const su = await s.call('/auth/signup', { body: { username: 'late', password: 'hunter22pass' } });
  assert.equal(su.status, 403);
  assert.match(su.body.error, /sign-ups are paused/);
  assert.equal((await s.call('/auth/login', { body: { username: 'boss', password: 'hunter22pass' } })).status, 200, 'existing accounts can still log in');
  assert.equal((await s.call('/vault/claim', { token: adm, body: { id: 'welcome' } })).status, 403);
  assert.equal((await s.call('/vault/buy', { token: adm, body: { card: 'ape-02' } })).status, 403);
  const v = await s.call('/vault', { token: adm });
  assert.equal(v.status, 200, 'collections stay visible');
  assert.equal(v.body.paused, true);
  const sub = await s.call('/swap/submit', { body: { swapId: 'x'.repeat(20), signedTransaction: 'A'.repeat(200) } });
  assert.equal(sub.status, 403);
  assert.match(sub.body.error, /paused/);
  assert.equal((await s.call('/boost/orders', { body: { mint: MINT, package: 'boost', advertiser: MINT2, idempotencyKey: 'k'.repeat(20) } })).status, 403);
  const cfg = (await s.call('/config')).body;
  assert.equal(cfg.liveSwaps, false, 'app sees swaps as off while paused');
  assert.equal(cfg.liveBoostPayments, false);
  assert.deepEqual(cfg.paused, { swaps: true, boost: true, signups: true, vault: true });

  // resume
  for (const id of ['signups', 'vault']) assert.equal((await s.call('/admin/switches', { token: adm, body: { id, paused: false } })).status, 200);
  assert.equal((await s.call('/auth/signup', { body: { username: 'late', password: 'hunter22pass' } })).status, 200);
  assert.equal((await s.call('/vault/claim', { token: adm, body: { id: 'welcome' } })).status, 200);

  const log = await s.call('/admin/audit?group=switch', { token: adm });
  assert.equal(log.body.entries.length, 6);
  assert.equal(log.body.entries[0].action, 'switch.resume');
  assert.equal(log.body.entries.at(-1).detail.reason, 'maintenance');
});

test('kill switch can never turn live money on when wrangler.toml has it off', async () => {
  const s = setup(); // ENABLE_LIVE_SWAPS not set
  const adm = await s.user('boss');
  const sw = (await s.call('/admin/switches', { token: adm })).body.switches;
  const swaps = sw.find((x: any) => x.id === 'swaps');
  assert.equal(swaps.serverSwitch, 'off');
  assert.equal(swaps.running, false);
  assert.equal((await s.call('/config')).body.liveSwaps, false);
});

test('boost queue: counts, running tab, end early, blocked token cannot be approved, refunds flagged', async () => {
  const s = setup();
  const adm = await s.user('boss');
  const t = s.now();
  s.promo('p'.repeat(20), { status: 'pending_review' }); s.pay('p'.repeat(20), 'sigA');
  s.promo('q'.repeat(20), { status: 'approved', starts: t - 1000, ends: t + DAY }); s.pay('q'.repeat(20), 'sigB');
  s.promo('r'.repeat(20), { status: 'rejected' }); s.pay('r'.repeat(20), 'sigC');
  s.promo('s'.repeat(20), { status: 'pending_review', mint: MINT2 }); s.pay('s'.repeat(20), 'sigD');

  let q = await s.call('/admin/promotions?status=running', { token: adm });
  assert.equal(q.status, 200, q.text);
  assert.equal(q.body.promotions.length, 1);
  assert.equal(q.body.promotions[0].running, true);
  assert.equal(q.body.counts.pending_review, 2);
  assert.equal(q.body.counts.running, 1);
  assert.equal(q.body.counts.refunds, 1);
  q = await s.call('/admin/promotions?status=rejected', { token: adm });
  assert.equal(q.body.promotions[0].refundOwed, true);

  // the running campaign shows publicly, then is ended early
  assert.equal((await s.call('/boost/active')).body.campaigns.length, 1);
  assert.equal((await s.call(`/admin/promotions/${'q'.repeat(20)}/end`, { token: adm, body: {} })).status, 400, 'reason needed');
  const end = await s.call(`/admin/promotions/${'q'.repeat(20)}/end`, { token: adm, body: { note: 'misleading ticker' } });
  assert.equal(end.status, 200, end.text);
  assert.equal(end.body.order.status, 'cancelled');
  assert.match(end.body.order.reviewNote, /Ended early: misleading ticker/);
  assert.equal((await s.call('/boost/active')).body.campaigns.length, 0);
  assert.equal((await s.call(`/admin/promotions/${'q'.repeat(20)}/end`, { token: adm, body: { note: 'again' } })).status, 409);

  // block MINT2: its order can't be approved, only rejected
  const bl = await s.call('/admin/blocklist', { token: adm, body: { mint: MINT2, symbol: '$FAKE', reason: 'scam copy' } });
  assert.equal(bl.status, 200, bl.text);
  assert.equal(bl.body.affectedBoosts.length, 1);
  q = await s.call('/admin/promotions?status=pending_review', { token: adm });
  assert.equal(q.body.promotions.find((x: any) => x.mint === MINT2).blocked, true);
  assert.equal((await s.call(`/admin/promotions/${'s'.repeat(20)}/approve`, { token: adm, body: {} })).status, 409);
  assert.equal((await s.call(`/admin/promotions/${'s'.repeat(20)}/reject`, { token: adm, body: { note: 'blocked token' } })).status, 200);
  assert.equal((await s.call(`/admin/promotions/${'p'.repeat(20)}/approve`, { token: adm, body: {} })).status, 200);

  const log = (await s.call('/admin/audit?group=boost', { token: adm })).body.entries.map((e: any) => e.action);
  assert.deepEqual(log.sort(), ['boost.approve', 'boost.end', 'boost.reject']);
});

test('token blocklist: add, public list, hidden from BOOST, validation, remove', async () => {
  const s = setup({ ENABLE_LIVE_BOOST_PAYMENTS: 'true' });
  const adm = await s.user('boss');
  assert.equal((await s.call('/admin/blocklist', { token: adm, body: { mint: 'nope', reason: 'x' } })).status, 400);
  assert.equal((await s.call('/admin/blocklist', { token: adm, body: { mint: MINT } })).status, 400, 'reason required');
  assert.equal((await s.call('/admin/blocklist', { token: adm, body: { mint: USDC, reason: 'x' } })).status, 400, 'USDC cannot be blocked');
  assert.equal((await s.call('/admin/blocklist', { token: adm, body: { mint: MINT, reason: 'rug pull' } })).status, 200);
  assert.equal((await s.call('/admin/blocklist', { token: adm, body: { mint: MINT, reason: 'rug pull' } })).status, 409, 'no duplicates');
  const pub = await s.call('/blocklist');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.body.mints, [MINT]);
  assert.ok(!/rug pull/.test(pub.text), 'reasons stay admin-only');
  assert.equal((await s.call('/boost/preview', { body: { mint: MINT, package: 'boost' } })).status, 403);
  assert.equal((await s.call('/boost/orders', { body: { mint: MINT, package: 'boost', advertiser: MINT2, idempotencyKey: 'k'.repeat(20) } })).status, 403);
  const list = (await s.call('/admin/blocklist', { token: adm })).body.tokens;
  assert.equal(list[0].reason, 'rug pull');
  assert.equal(list[0].createdBy, '@boss');
  assert.equal((await s.call('/admin/blocklist/remove', { token: adm, body: { mint: MINT } })).status, 200);
  assert.deepEqual((await s.call('/blocklist')).body.mints, []);
  assert.equal((await s.call('/admin/blocklist/remove', { token: adm, body: { mint: MINT } })).status, 404);
  const actions = (await s.call('/admin/audit?group=blocklist', { token: adm })).body.entries.map((e: any) => e.action);
  assert.deepEqual(actions, ['blocklist.remove', 'blocklist.add']);
});

test('revenue: swap fees by mint, BOOST by package, daily series, refunds owed, test payments excluded', async () => {
  const s = setup();
  const adm = await s.user('boss');
  const t = s.now();
  const swap = (id: string, mint: string, fee: string, at: number) => s.sql(`INSERT INTO swaps (id, idempotency_key, taker, side, input_mint, output_mint, in_amount, quoted_out, min_out, slippage_bps, fee_bps, fee_mint, fee_account,
      message_hash, tx_b64, quote_json, last_valid_height, status, signature, fee_collected, created_at, expires_at, updated_at) VALUES (?, ?, 'T', 'BUY', ?, ?, '1', '1', '1', 50, 50, ?, 'F', 'h', 'x', '{}', 1, 'confirmed', ?, ?, ?, ?, ?)`,
  id, 'k' + id, mint, MINT, mint, 'sig' + id, fee, at, at, at);
  swap('s1', WSOL, '5000000', t);            // 0.005 SOL today
  swap('s2', WSOL, '10000000', t - 3 * DAY); // 0.01 SOL 3 days ago
  swap('s3', USDC, '1500000', t - 40 * DAY); // 1.5 USDC long ago
  s.promo('a'.repeat(20), { status: 'approved', pkg: 'prime', price: '75000000' }); s.pay('a'.repeat(20), 'paidA', '75000000', t);
  s.promo('b'.repeat(20), { status: 'rejected', pkg: 'boost' }); s.pay('b'.repeat(20), 'paidB', '20000000', t - 2 * DAY);
  s.promo('c'.repeat(20), { status: 'approved' }); s.pay('c'.repeat(20), 'TEST-PAYMENT-' + 'c'.repeat(20), '20000000', t);

  const r = await s.call('/admin/revenue?days=7', { token: adm });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.swapFees.sol.today, 0.005);
  assert.ok(Math.abs(r.body.swapFees.sol.d7 - 0.015) < 1e-9);
  assert.equal(r.body.swapFees.usdc.d30, 0);
  assert.equal(r.body.swapFees.usdc.all, 1.5);
  assert.equal(r.body.boost.usdc.all, 95, 'test payment not counted');
  assert.equal(r.body.boost.orders, 2);
  assert.equal(r.body.testPayments, 1);
  assert.equal(r.body.dailyBoostUsdc.length, 7);
  assert.equal(r.body.dailyBoostUsdc.at(-1).n, 75);
  assert.equal(r.body.dailySwapFeesSol.at(-1).n, 0.005);
  assert.deepEqual(r.body.byPackage.map((x: any) => x.package), ['prime', 'boost']);
  assert.deepEqual(r.body.refundsOwed, { orders: 1, usdc: 20 });
  const w = await s.call('/admin/revenue/wallets', { token: adm });
  assert.equal(w.status, 200);
  assert.deepEqual(w.body.accounts, [], 'the test copy has no real wallets');
});

test('user stats: retention, engagement, leaders, active hours', async () => {
  const s = setup();
  const a = await s.user('anna');
  const b = await s.user('benj');
  s.advance(2 * DAY);
  await s.call('/me', { token: a }); // anna comes back two days later
  const t = s.now();
  const tr = (id: string, extra = {}) => ({ id, kind: 'trade', t, mint: MINT, symbol: 'WIF', side: 'BUY', usd: 10, price: 1, ...extra });
  await s.call('/me/activity', { token: a, body: { items: [tr('t-0000001'), tr('t-0000002'), tr('t-0000003')] } });
  const r = await s.call('/admin/user-stats', { token: a });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.total, 2);
  assert.equal(r.body.retention.d1.base, 2);
  assert.equal(r.body.retention.d1.pct, 50);
  assert.equal(r.body.retention.d7.pct, null, 'nobody is a week old yet');
  assert.equal(r.body.engagement.none, 1);
  assert.equal(r.body.engagement.some, 1);
  assert.equal(r.body.leaders.trades30d[0].username, 'anna');
  assert.equal(r.body.leaders.trades30d[0].value, 3);
  assert.equal(r.body.activeHoursUtc.length, 24);
  assert.equal(r.body.activeHoursUtc.reduce((x: number, y: number) => x + y, 0), 3);
  assert.ok(!/pass_hash|token_hash/.test(r.text));
  void b;
});

test('vault controls: card pause + scheduled drop, reward changes, coin adjustments (never below 0)', async () => {
  const s = setup();
  const adm = await s.user('boss');
  const kid = await s.user('kiddo');
  await s.call('/vault/claim', { token: kid, body: { id: 'welcome' } }); // 100 coins

  let v = await s.call('/admin/vault', { token: adm });
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.ready, true);
  assert.equal(v.body.cards.length, 29);
  assert.ok(v.body.cards.every((c: any) => c.status === 'on_sale'));

  // pause a common card: it can't be bought
  assert.equal((await s.call('/admin/vault/card', { token: adm, body: { card: 'ape-02', paused: true } })).status, 200);
  let buy = await s.call('/vault/buy', { token: kid, body: { card: 'ape-02' } });
  assert.equal(buy.status, 403);
  assert.match(buy.body.error, /isn’t for sale/);
  assert.equal((await s.call('/vault', { token: kid })).body.cardControls['ape-02'].paused, true);
  // schedule it to drop in an hour instead
  assert.equal((await s.call('/admin/vault/card', { token: adm, body: { card: 'ape-02', paused: false, dropAt: s.now() + 3600_000 } })).status, 200);
  buy = await s.call('/vault/buy', { token: kid, body: { card: 'ape-02' } });
  assert.equal(buy.status, 403);
  assert.match(buy.body.error, /drops/);
  assert.equal((await s.call('/admin/vault', { token: adm })).body.cards.find((c: any) => c.id === 'ape-02').status, 'scheduled');
  s.advance(3600_001);
  buy = await s.call('/vault/buy', { token: kid, body: { card: 'ape-02' } });
  assert.equal(buy.status, 200, buy.text);
  assert.equal((await s.call('/admin/vault', { token: adm })).body.cards.find((c: any) => c.id === 'ape-02').minted, 1);
  assert.equal((await s.call('/admin/vault/card', { token: adm, body: { card: 'nope', paused: true } })).status, 400);
  assert.equal((await s.call('/admin/vault/card', { token: adm, body: { card: 'ape-01', dropAt: s.now() - 10 * DAY } })).status, 400);

  // rewards: change "thesis" from 25 to 40; claim pays the new amount
  assert.equal((await s.call('/admin/vault/rewards', { token: adm, body: { rewards: { thesis: 5000 } } })).status, 400);
  assert.equal((await s.call('/admin/vault/rewards', { token: adm, body: { rewards: { thesis: 40 } } })).status, 200);
  const ch = (await s.call('/admin/vault', { token: adm })).body.challenges.find((c: any) => c.id === 'thesis');
  assert.deepEqual([ch.defaultReward, ch.reward], [25, 40]);
  await s.call('/me/activity', { token: kid, body: { items: [{ id: 'th-000001', kind: 'thesis', t: s.now(), mint: MINT, symbol: 'WIF', bull: true, text: 'to the moon and back' }] } });
  const before = (await s.call('/vault', { token: kid })).body.balance;
  const cl = await s.call('/vault/claim', { token: kid, body: { id: 'thesis' } });
  assert.equal(cl.status, 200, cl.text);
  assert.equal(cl.body.balance - before, 40);

  // coin adjustments
  assert.equal((await s.call('/admin/vault/coins', { token: adm, body: { username: 'kiddo', delta: 50 } })).status, 400, 'reason required');
  assert.equal((await s.call('/admin/vault/coins', { token: adm, body: { username: 'ghost', delta: 50, reason: 'x' } })).status, 404);
  assert.equal((await s.call('/admin/vault/coins', { token: adm, body: { username: '@Kiddo', delta: 1.5, reason: 'x' } })).status, 400);
  const add = await s.call('/admin/vault/coins', { token: adm, body: { username: '@Kiddo', delta: 50, reason: 'bug refund' } });
  assert.equal(add.status, 200, add.text);
  assert.equal(add.body.balance, before + 40 + 50);
  const tooMuch = await s.call('/admin/vault/coins', { token: adm, body: { username: 'kiddo', delta: -100000, reason: 'oops' } });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error, /below 0/);
  v = await s.call('/admin/vault', { token: adm });
  assert.equal(v.body.adjustments[0].delta, 50);
  assert.equal(v.body.coins.adjusted, 50);

  const actions = (await s.call('/admin/audit?group=vault', { token: adm })).body.entries.map((e: any) => e.action);
  assert.deepEqual(actions.filter((a: string) => a === 'vault.card').length, 2);
  assert.ok(actions.includes('vault.rewards') && actions.includes('coins.adjust'));
  // the log shows the adjustment as a coin movement too
  const coinsLog = (await s.call('/admin/log?type=coins', { token: adm })).body.events;
  assert.ok(coinsLog.some((e: any) => /admin/.test(e.text) && e.delta === 50));
});

test('audit log: everything newest first, filter by group, paging', async () => {
  const s = setup();
  const adm = await s.user('boss');
  for (let i = 0; i < 65; i++) {
    s.advance(1000);
    await s.call('/admin/switches', { token: adm, body: { id: 'vault', paused: i % 2 === 0, reason: `r${i}` } });
  }
  const p1 = await s.call('/admin/audit', { token: adm });
  assert.equal(p1.body.entries.length, 60);
  assert.ok(p1.body.next);
  for (let i = 1; i < p1.body.entries.length; i++) assert.ok(p1.body.entries[i - 1].t >= p1.body.entries[i].t);
  const p2 = await s.call(`/admin/audit?before=${p1.body.next}`, { token: adm });
  assert.equal(p2.body.entries.length, 5);
  assert.equal(p2.body.next, null);
  assert.equal((await s.call('/admin/audit?group=boost', { token: adm })).body.entries.length, 0);
});

test('admin sign-in is written to the audit log', async () => {
  // a real admin wallet signs the challenge (not the test copy)
  const { keypair } = await import('./fakechain');
  const kp = await keypair();
  const s = setup({ TEST_COPY: '', ADMIN_SESSION_SECRET: 'z'.repeat(40), ADMIN_WALLETS: kp.address });
  const c = await s.call('/admin/challenge', { body: { wallet: kp.address } });
  assert.equal(c.status, 200, c.text);
  const sig = Buffer.from(await kp.sign(new TextEncoder().encode(c.body.message))).toString('base64');
  const ses = await s.call('/admin/session', { body: { wallet: kp.address, nonce: c.body.nonce, signature: sig } });
  assert.equal(ses.status, 200, ses.text);
  const log = await s.call('/admin/audit?group=signin', { token: ses.body.token });
  assert.equal(log.status, 200, log.text);
  assert.equal(log.body.entries[0].admin, kp.address);
  // the switch is written with the wallet as the author
  assert.equal((await s.call('/admin/switches', { token: ses.body.token, body: { id: 'signups', paused: true, reason: 'spam wave' } })).status, 200);
  assert.equal((await s.call('/admin/switches', { token: ses.body.token })).body.switches.find((x: any) => x.id === 'signups').updatedBy, kp.address);
});

test('every new admin route needs an admin session outside the test copy', async () => {
  const s = setup({ TEST_COPY: '', ADMIN_SESSION_SECRET: 'x'.repeat(40), ADMIN_WALLETS: '' });
  const tok = await s.user('dee');
  const gets = ['/admin/switches', '/admin/revenue', '/admin/revenue/wallets', '/admin/blocklist', '/admin/user-stats', '/admin/vault', '/admin/audit'];
  const posts = ['/admin/switches', '/admin/blocklist', '/admin/blocklist/remove', '/admin/vault/card', '/admin/vault/coins', '/admin/vault/rewards', `/admin/promotions/${'p'.repeat(20)}/end`];
  for (const p of gets) { assert.equal((await s.call(p)).status, 401, p); assert.equal((await s.call(p, { token: tok })).status, 401, p); }
  for (const p of posts) { assert.equal((await s.call(p, { body: {} })).status, 401, p); assert.equal((await s.call(p, { body: {}, token: tok })).status, 401, p); }
  assert.equal((await s.call('/blocklist')).status, 200, 'the public list needs no sign-in');
});

test('without the 0004 tables the app keeps working and admin changes explain the migration', async () => {
  const s = setup();
  s.db.db.exec('DROP TABLE admin_settings; DROP TABLE token_blocklist; DROP TABLE card_controls; DROP TABLE admin_audit;');
  const tok = await s.user('ana');
  assert.equal((await s.call('/vault/claim', { token: tok, body: { id: 'welcome' } })).status, 200);
  assert.deepEqual((await s.call('/blocklist')).body.mints, []);
  assert.equal((await s.call('/config')).status, 200);
  const sw = await s.call('/admin/switches', { token: tok });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.ready, false);
  const set = await s.call('/admin/switches', { token: tok, body: { id: 'vault', paused: true, reason: 'x' } });
  assert.equal(set.status, 503);
  assert.match(set.body.error, /0004_admin_controls\.sql/);
  assert.equal((await s.call('/admin/audit', { token: tok })).body.ready, false);
  assert.equal((await s.call('/admin/vault/coins', { token: tok, body: { username: 'ana', delta: 5, reason: 'x' } })).status, 503, 'no unlogged coin changes');
});
