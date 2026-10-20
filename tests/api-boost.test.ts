/**
 * BOOST sponsored listings: preview, orders, USDC payment build/verify, admin sign-in and review, scheduling,
 * expiry and analytics — through the real Worker entry point with a fake chain and a real SQLite-backed D1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
import { D1, Chain, keypair, walletSign, rnd, type Kp } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SESSION_SECRET = 'S'.repeat(40);

async function setup(envExtra: Record<string, string> = {}, live = true) {
  const chain = new Chain();
  const db = new D1();
  const boostOwner = rnd(), boostUsdc = rnd();
  chain.addTokenAccount(boostUsdc, sol.MINTS.usdc, boostOwner);
  chain.addMint(TOKEN, 5);
  chain.tokens.set(TOKEN, { symbol: 'BONK', name: 'Bonk', icon: 'https://img.example/bonk.png' });
  const admin = await keypair();
  const advertiser = await keypair();
  const advUsdc = rnd();
  chain.addTokenAccount(advUsdc, sol.MINTS.usdc, advertiser.address, '500000000');
  let t = 1_800_000_000_000;
  const env: any = {
    ALLOWED_ORIGINS: ORIGIN, JUPITER_API_KEY: 'k', HELIUS_API_KEY: 'h', Db: db,
    ENABLE_LIVE_BOOST_PAYMENTS: live ? 'true' : 'false', BOOST_WALLET: boostOwner, BOOST_USDC_ACCOUNT: boostUsdc,
    ADMIN_WALLETS: admin.address, ADMIN_SESSION_SECRET: SESSION_SECRET,
    RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', UPSTREAM_PER_MIN_JUP: '100000', UPSTREAM_PER_MIN_RPC: '100000', UPSTREAM_PER_MIN_DS: '100000', ...envExtra,
  };
  let ipn = 0;
  const call = async (path: string, body?: unknown, o: { token?: string; ip?: string; ua?: string } = {}) => {
    const h: Record<string, string> = { origin: ORIGIN, 'cf-connecting-ip': o.ip || `10.2.0.${ipn++ % 250}`, 'content-type': 'application/json', 'user-agent': o.ua || 'test' };
    if (o.token) h.authorization = `Bearer ${o.token}`;
    const res = await handle(new Request(`https://api.test/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, undefined, { fetch: chain.fetch, now: () => t, cache: null });
    const text = await res.text();
    assert.ok(!text.includes(SESSION_SECRET));
    return { status: res.status, body: JSON.parse(text) };
  };
  return { chain, db, env, call, admin, advertiser, advUsdc, boostOwner, boostUsdc, advance: (ms: number) => { t += ms; }, now: () => t };
}
type S = Awaited<ReturnType<typeof setup>>;
const key = () => 'idem-' + Math.random().toString(36).slice(2).padEnd(14, '0');
const usdcTransfer = (s: S, amount: string, o: { mint?: string; dest?: string } = {}) => ({
  program: 'spl-token', programId: sol.PROGRAMS.token,
  parsed: { type: 'transferChecked', info: { source: s.advUsdc, mint: o.mint || sol.MINTS.usdc, destination: o.dest || s.boostUsdc, authority: s.advertiser.address, tokenAmount: { amount, decimals: 6 } } },
});
async function order(s: S, pkg = 'boost') {
  const r = await s.call('/boost/orders', { mint: TOKEN, package: pkg, advertiser: s.advertiser.address, idempotencyKey: key() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.order;
}
async function adminToken(s: S, kp: Kp = s.admin) {
  const c = await s.call('/admin/challenge', { wallet: kp.address });
  if (c.status !== 200) return { status: c.status, token: '' };
  const sig = await kp.sign(new TextEncoder().encode(c.body.message));
  const r = await s.call('/admin/session', { wallet: kp.address, nonce: c.body.nonce, signature: sol.b64encode(sig) });
  return { status: r.status, token: r.body.token as string };
}
/** pays an order through the in-app flow and lands it on the fake chain */
async function payInApp(s: S, o: any, amount?: string) {
  const tx = await s.call(`/boost/orders/${o.id}/transaction`, { payer: s.advertiser.address });
  assert.equal(tx.status, 200, JSON.stringify(tx.body));
  const sub = await s.call(`/boost/orders/${o.id}/submit`, { signedTransaction: await walletSign(s.advertiser, tx.body.transaction) });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  s.chain.land(sub.body.signature, { keys: [s.advertiser.address, s.advUsdc, sol.MINTS.usdc, s.boostUsdc, o.reference], instructions: [usdcTransfer(s, amount || o.priceRaw)], blockTime: Math.floor(s.now() / 1000) });
  return sub.body.signature as string;
}

test('packages and prices', async () => {
  const s = await setup();
  for (const [id, usdc, hours] of [['starter', 10, 12], ['boost', 20, 24], ['prime', 75, 72], ['spotlight', 200, 168]] as const) {
    const r = await s.call('/boost/preview', { mint: TOKEN, package: id });
    assert.equal(r.status, 200);
    assert.equal(r.body.package.usdc, usdc);
    assert.equal(r.body.package.priceRaw, String(usdc * 1_000_000));
    assert.equal(r.body.package.durationMs, hours * 3600_000);
    assert.equal(r.body.token.symbol, 'BONK');
  }
  assert.equal((await s.call('/boost/preview', { mint: TOKEN, package: 'mega' })).status, 400);
});

test('token validation: not an address, not a mint, no market data', async () => {
  const s = await setup();
  assert.equal((await s.call('/boost/preview', { mint: 'abc', package: 'boost' })).status, 400);
  const wallet = rnd(); // exists but is not a mint
  s.chain.addTokenAccount(wallet, sol.MINTS.usdc, rnd());
  const r1 = await s.call('/boost/preview', { mint: wallet, package: 'boost' });
  assert.equal(r1.status, 400); assert.match(r1.body.error, /not a Solana token mint/);
  const unknown = rnd(); s.chain.addMint(unknown);
  const r2 = await s.call('/boost/preview', { mint: unknown, package: 'boost' });
  assert.equal(r2.status, 404);
  // DexScreener fallback when Jupiter has no record
  s.chain.dsTokens.set(unknown, [{ baseToken: { address: unknown, symbol: 'NEW', name: 'New Coin' }, info: { imageUrl: 'https://img.example/n.png' } }]);
  const r3 = await s.call('/boost/preview', { mint: unknown, package: 'starter' });
  assert.equal(r3.status, 200); assert.equal(r3.body.token.symbol, 'NEW');
});

test('payments off: orders cannot be created; preview still works', async () => {
  const s = await setup({}, false);
  assert.equal((await s.call('/boost/preview', { mint: TOKEN, package: 'boost' })).body.live, false);
  const r = await s.call('/boost/orders', { mint: TOKEN, package: 'boost', advertiser: s.advertiser.address, idempotencyKey: key() });
  assert.equal(r.status, 403);
  assert.equal((s.db.db.prepare('SELECT COUNT(*) AS n FROM promotions').get() as any).n, 0);
});

test('order → USDC payment transaction is exact (mint, amount, recipient, reference, memo) → verified → pending review', async () => {
  const s = await setup();
  const o = await order(s, 'prime');
  assert.equal(o.status, 'awaiting_payment');
  assert.equal(o.priceRaw, '75000000');
  const tx = await s.call(`/boost/orders/${o.id}/transaction`, { payer: s.advertiser.address });
  assert.equal(tx.status, 200);
  const p = sol.parseTransaction(sol.b64decode(tx.body.transaction));
  const d = p.decoded;
  assert.equal(d.staticKeys[0], s.advertiser.address);
  assert.equal(d.header[0], 1);
  const [xfer, memo] = d.instructions;
  assert.equal(d.staticKeys[xfer.programIdIndex], sol.PROGRAMS.token);
  assert.deepEqual(xfer.accounts.map((i: number) => d.staticKeys[i]), [s.advUsdc, sol.MINTS.usdc, s.boostUsdc, s.advertiser.address, o.reference]);
  assert.equal(xfer.data[0], 12);
  assert.equal(new DataView(xfer.data.buffer, xfer.data.byteOffset + 1, 8).getBigUint64(0, true), 75_000_000n);
  assert.equal(xfer.data[9], 6);
  assert.equal(d.staticKeys[memo.programIdIndex], sol.PROGRAMS.memo);
  assert.equal(new TextDecoder().decode(memo.data), `BAGZ-BOOST:${o.id}`);

  const sub = await s.call(`/boost/orders/${o.id}/submit`, { signedTransaction: await walletSign(s.advertiser, tx.body.transaction) });
  assert.equal(sub.status, 200);
  // not confirmed yet → not verified, order still awaiting payment
  let v = await s.call(`/boost/orders/${o.id}/verify`, { signature: sub.body.signature });
  assert.equal(v.body.verified, false);
  assert.equal(v.body.order.status, 'awaiting_payment');
  s.chain.land(sub.body.signature, { keys: [s.advertiser.address, s.advUsdc, sol.MINTS.usdc, s.boostUsdc, o.reference], instructions: [usdcTransfer(s, '75000000')], blockTime: Math.floor(s.now() / 1000) });
  v = await s.call(`/boost/orders/${o.id}/verify`, { signature: sub.body.signature });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(v.body.verified, true);
  assert.equal(v.body.order.status, 'pending_review');
  // paid but not approved → not shown anywhere
  assert.deepEqual((await s.call('/boost/active')).body.campaigns, []);
});

test('payment checks: wrong mint, short amount, wrong recipient, missing reference, failed tx, reused signature', async () => {
  const s = await setup();
  const cases: [string, any, RegExp][] = [
    ['wrong mint', (o: any) => ({ instructions: [usdcTransfer(s, o.priceRaw, { mint: rnd() })] }), /not in USDC/],
    ['short', (o: any) => ({ instructions: [usdcTransfer(s, String(Number(o.priceRaw) - 1))] }), /costs 20 USDC/],
    ['wrong recipient', (o: any) => ({ instructions: [usdcTransfer(s, o.priceRaw, { dest: rnd() })] }), /wrong address/],
    ['no reference', (o: any) => ({ instructions: [usdcTransfer(s, o.priceRaw)], noRef: true }), /reference/],
    ['failed', (o: any) => ({ instructions: [usdcTransfer(s, o.priceRaw)], err: { InstructionError: [0, 'Custom'] } }), /failed on-chain/],
  ];
  for (const [name, mk, re] of cases) {
    const o = await order(s);
    const sig = sol.b58encode(crypto.getRandomValues(new Uint8Array(64)));
    const c = mk(o);
    s.chain.land(sig, { keys: [s.advertiser.address, s.advUsdc, sol.MINTS.usdc, s.boostUsdc, ...(c.noRef ? [] : [o.reference])], instructions: c.instructions, err: c.err, blockTime: Math.floor(s.now() / 1000) });
    const v = await s.call(`/boost/orders/${o.id}/verify`, { signature: sig });
    assert.equal(v.status, 422, `${name}: ${JSON.stringify(v.body)}`);
    assert.match(v.body.error, re, name);
    assert.equal((s.db.db.prepare('SELECT status FROM promotions WHERE id = ?').get(o.id) as any).status, 'awaiting_payment', name);
  }
  // reuse: a payment that activated order A cannot activate order B (even if B had the same reference somehow)
  const a = await order(s);
  const sig = await payInApp(s, a);
  assert.equal((await s.call(`/boost/orders/${a.id}/verify`, { signature: sig })).body.verified, true);
  const b = await order(s);
  const reuse = await s.call(`/boost/orders/${b.id}/verify`, { signature: sig });
  assert.equal(reuse.status, 409);
  assert.equal((s.db.db.prepare('SELECT COUNT(*) AS n FROM payments').get() as any).n, 1);
  // verifying A again is harmless and does not double-count
  assert.equal((await s.call(`/boost/orders/${a.id}/verify`, { signature: sig })).body.verified, true);
});

test('payment made before the order existed is refused', async () => {
  const s = await setup();
  const o = await order(s);
  const sig = sol.b58encode(crypto.getRandomValues(new Uint8Array(64)));
  s.chain.land(sig, { keys: [s.advertiser.address, s.boostUsdc, o.reference], instructions: [usdcTransfer(s, o.priceRaw)], blockTime: Math.floor((s.now() - 3600_000) / 1000) });
  const v = await s.call(`/boost/orders/${o.id}/verify`, { signature: sig });
  assert.equal(v.status, 422); assert.match(v.body.error, /before this order/);
});

test('Solana Pay: link carries recipient, amount, USDC and reference; verify finds the payment by reference', async () => {
  const s = await setup();
  const r = await s.call('/boost/orders', { mint: TOKEN, package: 'starter', advertiser: s.advertiser.address, idempotencyKey: key() });
  const u = new URL(r.body.solanaPay.replace('solana:', 'https://x/'));
  assert.equal(u.pathname.slice(1), s.boostOwner);
  assert.equal(u.searchParams.get('amount'), '10');
  assert.equal(u.searchParams.get('spl-token'), sol.MINTS.usdc);
  assert.equal(u.searchParams.get('reference'), r.body.order.reference);
  let v = await s.call(`/boost/orders/${r.body.order.id}/verify`, {});
  assert.equal(v.body.verified, false);
  const sig = sol.b58encode(crypto.getRandomValues(new Uint8Array(64)));
  s.chain.signaturesFor.set(r.body.order.reference, [{ signature: sig, err: null }]);
  s.chain.land(sig, { keys: [s.advertiser.address, s.boostUsdc, r.body.order.reference], instructions: [usdcTransfer(s, '10000000')], blockTime: Math.floor(s.now() / 1000) });
  v = await s.call(`/boost/orders/${r.body.order.id}/verify`, {});
  assert.equal(v.body.verified, true);
});

test('idempotent order creation; insufficient USDC is reported', async () => {
  const s = await setup();
  const k = key();
  const a = await s.call('/boost/orders', { mint: TOKEN, package: 'boost', advertiser: s.advertiser.address, idempotencyKey: k });
  const b = await s.call('/boost/orders', { mint: TOKEN, package: 'boost', advertiser: s.advertiser.address, idempotencyKey: k });
  assert.equal(a.body.order.id, b.body.order.id);
  assert.equal((await s.call('/boost/orders', { mint: TOKEN, package: 'prime', advertiser: s.advertiser.address, idempotencyKey: k })).status, 409);
  const poor = await keypair();
  const o = await s.call('/boost/orders', { mint: TOKEN, package: 'spotlight', advertiser: poor.address, idempotencyKey: key() });
  const tx = await s.call(`/boost/orders/${o.body.order.id}/transaction`, { payer: poor.address });
  assert.equal(tx.status, 422); assert.match(tx.body.error, /does not hold 200 USDC/);
  // someone else cannot build the payment for this order
  assert.equal((await s.call(`/boost/orders/${a.body.order.id}/transaction`, { payer: poor.address })).status, 400);
});

test('admin: wallet signature sign-in; non-admins, replays, forged tokens and expired sessions are refused', async () => {
  const s = await setup();
  const other = await keypair();
  assert.equal((await adminToken(s, other)).status, 403);
  // signing someone else's challenge
  const c = await s.call('/admin/challenge', { wallet: s.admin.address });
  const forged = await other.sign(new TextEncoder().encode(c.body.message));
  assert.equal((await s.call('/admin/session', { wallet: s.admin.address, nonce: c.body.nonce, signature: sol.b64encode(forged) })).status, 401);
  // valid sign-in, then replay of the same nonce
  const sig = await s.admin.sign(new TextEncoder().encode(c.body.message));
  const ok = await s.call('/admin/session', { wallet: s.admin.address, nonce: c.body.nonce, signature: sol.b64encode(sig) });
  assert.equal(ok.status, 200);
  assert.equal((await s.call('/admin/session', { wallet: s.admin.address, nonce: c.body.nonce, signature: sol.b64encode(sig) })).status, 401);
  // list requires a valid token
  assert.equal((await s.call('/admin/promotions')).status, 401);
  assert.equal((await s.call('/admin/promotions', undefined, { token: ok.body.token })).status, 200);
  const [p, m] = ok.body.token.split('.');
  assert.equal((await s.call('/admin/promotions', undefined, { token: `${p}.${m.slice(0, -2)}xx` })).status, 401);
  const evil = Buffer.from(JSON.stringify({ w: other.address, exp: s.now() + 1e9 })).toString('base64url');
  assert.equal((await s.call('/admin/promotions', undefined, { token: `${evil}.${m}` })).status, 401);
  s.advance(3 * 3600_000);
  assert.equal((await s.call('/admin/promotions', undefined, { token: ok.body.token })).status, 401);
  // removed from ADMIN_WALLETS → token stops working
  const again = await adminToken(s);
  s.env.ADMIN_WALLETS = '';
  assert.equal((await s.call('/admin/promotions', undefined, { token: again.token })).status, 401);
});

test('admin approval is required; scheduling, labelled active list, automatic expiry, rejection', async () => {
  const s = await setup();
  const { token } = await adminToken(s);
  const o = await order(s, 'starter');
  // cannot approve an unpaid order
  assert.equal((await s.call(`/admin/promotions/${o.id}/approve`, {}, { token })).status, 409);
  const sig = await payInApp(s, o);
  await s.call(`/boost/orders/${o.id}/verify`, { signature: sig });
  // the public cannot approve
  assert.equal((await s.call(`/admin/promotions/${o.id}/approve`, {})).status, 401);
  const list = await s.call('/admin/promotions?status=pending_review', undefined, { token });
  assert.equal(list.body.promotions.length, 1);
  assert.equal(list.body.promotions[0].payment.signature, sig);
  // schedule to start in 1 hour
  const start = s.now() + 3600_000;
  const ap = await s.call(`/admin/promotions/${o.id}/approve`, { startsAt: start }, { token });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.order.startsAt, start);
  assert.equal(ap.body.order.endsAt, start + 12 * 3600_000);
  assert.deepEqual((await s.call('/boost/active')).body.campaigns, []); // not started yet
  s.advance(3600_000 + 1);
  const act = await s.call('/boost/active');
  assert.equal(act.body.campaigns.length, 1);
  assert.equal(act.body.campaigns[0].symbol, 'BONK');
  s.advance(12 * 3600_000);
  assert.deepEqual((await s.call('/boost/active')).body.campaigns, []); // expired automatically
  // the 2-hour admin session has expired by now
  assert.equal((await s.call(`/admin/promotions/${o.id}/approve`, {}, { token })).status, 401);
  const token2 = (await adminToken(s)).token;
  // double approval refused
  assert.equal((await s.call(`/admin/promotions/${o.id}/approve`, {}, { token: token2 })).status, 409);
  // rejection
  const o2 = await order(s, 'boost');
  await s.call(`/boost/orders/${o2.id}/verify`, { signature: await payInApp(s, o2) });
  const rj = await s.call(`/admin/promotions/${o2.id}/reject`, { note: 'Impersonates another project' }, { token: token2 });
  assert.equal(rj.body.order.status, 'rejected');
  assert.equal(rj.body.order.reviewNote, 'Impersonates another project');
});

test('analytics: impressions/clicks counted once per viewer per 30 min, only for live campaigns', async () => {
  const s = await setup();
  const { token } = await adminToken(s);
  const o = await order(s, 'spotlight');
  await s.call(`/boost/orders/${o.id}/verify`, { signature: await payInApp(s, o) });
  // not live yet → not counted
  assert.equal((await s.call('/boost/events', { id: o.id, type: 'impression' }, { ip: '1.1.1.1' })).body.counted, false);
  await s.call(`/admin/promotions/${o.id}/approve`, {}, { token });
  const ev = (type: string, ip: string, ua = 'a') => s.call('/boost/events', { id: o.id, type }, { ip, ua });
  assert.equal((await ev('impression', '1.1.1.1')).body.counted, true);
  assert.equal((await ev('impression', '1.1.1.1')).body.counted, false); // same viewer, same window
  assert.equal((await ev('impression', '2.2.2.2')).body.counted, true);
  assert.equal((await ev('click', '1.1.1.1')).body.counted, true);
  assert.equal((await ev('click', '1.1.1.1')).body.counted, false);
  s.advance(31 * 60_000);
  assert.equal((await ev('impression', '1.1.1.1')).body.counted, true); // new window
  assert.equal((await s.call('/boost/events', { id: o.id, type: 'like' })).status, 400);
  const list = await s.call('/admin/promotions?status=approved', undefined, { token });
  assert.deepEqual(list.body.promotions[0].stats, { impressions: 3, clicks: 1 });
});

test('a misconfigured BOOST receiving account blocks orders instead of taking money to the wrong place', async () => {
  const s = await setup();
  s.env.BOOST_USDC_ACCOUNT = rnd(); // does not exist on-chain
  const r = await s.call('/boost/orders', { mint: TOKEN, package: 'boost', advertiser: s.advertiser.address, idempotencyKey: key() });
  assert.equal(r.status, 503);
  assert.equal((s.db.db.prepare('SELECT COUNT(*) AS n FROM promotions').get() as any).n, 0);
});
