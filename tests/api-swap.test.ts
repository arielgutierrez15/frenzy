/**
 * /v1 swap endpoints through the real Worker entry point, with a fake chain/Jupiter and a real SQLite-backed D1.
 * The wallet is a real Ed25519 key that signs exactly the bytes BAGZ returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
import { D1, Chain, keypair, walletSign, rnd } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SECRET_JUP = 'SECRET-JUP-KEY-abc', SECRET_HEL = 'SECRET-HELIUS-xyz';

async function setup(envExtra: Record<string, string> = {}, live = true) {
  const chain = new Chain();
  const db = new D1();
  const feeOwner = rnd(), feeWsol = rnd(), feeUsdc = rnd();
  chain.addTokenAccount(feeWsol, sol.MINTS.wsol, feeOwner);
  chain.addTokenAccount(feeUsdc, sol.MINTS.usdc, feeOwner);
  chain.addMint(TOKEN, 6);
  let t = 1_800_000_000_000;
  const env: any = {
    ALLOWED_ORIGINS: ORIGIN, JUPITER_API_KEY: SECRET_JUP, HELIUS_API_KEY: SECRET_HEL, Db: db,
    ENABLE_LIVE_SWAPS: live ? 'true' : 'false', BAGZ_PLATFORM_FEE_BPS: '50',
    FEE_WALLET: feeOwner, FEE_ACCOUNT_WSOL: feeWsol, FEE_ACCOUNT_USDC: feeUsdc,
    // every test shares one fake minute; lift the per-minute budgets so they don't interfere (they're tested elsewhere)
    RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', UPSTREAM_PER_MIN_JUP: '100000', UPSTREAM_PER_MIN_RPC: '100000', UPSTREAM_PER_MIN_DS: '100000', ...envExtra,
  };
  let ipn = 0;
  const call = async (path: string, body?: unknown, o: { method?: string } = {}) => {
    const req = new Request(`https://api.test/v1${path}`, { method: o.method || (body === undefined ? 'GET' : 'POST'), headers: { origin: ORIGIN, 'cf-connecting-ip': `10.0.0.${ipn++ % 250}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handle(req, env, undefined, { fetch: chain.fetch, now: () => t, cache: null });
    const text = await res.text();
    assert.ok(!text.includes(SECRET_JUP) && !text.includes(SECRET_HEL), 'no secret in any response');
    return { status: res.status, body: JSON.parse(text), headers: res.headers };
  };
  const taker = await keypair();
  return { chain, db, env, call, taker, feeWsol, feeUsdc, feeOwner, advance: (ms: number) => { t += ms; }, now: () => t };
}
const buyBody = (taker: string, key = 'k-' + Math.random().toString(36).slice(2, 18).padEnd(16, 'x')) => ({ taker, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: key });

/** resolve every instruction of a compiled v0 message back to addresses, using the on-chain lookup tables */
function resolve(bytes: Uint8Array, chain: Chain) {
  const d = sol.decodeMessage(bytes);
  const lw: string[] = [], lr: string[] = [];
  for (const l of d.lookups) { const t = sol.parseLookupTable(chain.accounts.get(l.key)!.raw!); l.writable.forEach((i: number) => lw.push(t[i])); }
  for (const l of d.lookups) { const t = sol.parseLookupTable(chain.accounts.get(l.key)!.raw!); l.readonly.forEach((i: number) => lr.push(t[i])); }
  const all = [...d.staticKeys, ...lw, ...lr];
  const [ns, nrs, nrn] = d.header;
  const writable = (i: number) => (i < d.staticKeys.length ? (i < ns ? i < ns - nrs : i < d.staticKeys.length - nrn) : i < d.staticKeys.length + lw.length);
  return { d, ix: d.instructions.map((x: any) => ({ program: all[x.programIdIndex], accounts: x.accounts.map((i: number) => ({ address: all[i], writable: writable(i), signer: i < ns })), data: x.data })) };
}

test('config: money switches default to off; fee is 50 bps', async () => {
  const s = await setup({}, false);
  delete s.env.ENABLE_LIVE_SWAPS;
  const r = await s.call('/config');
  assert.equal(r.status, 200);
  assert.equal(r.body.liveSwaps, false);
  assert.equal(r.body.liveBoostPayments, false);
  assert.equal(r.body.feeBps, 50);
  assert.deepEqual(r.body.packages.map((p: any) => [p.id, p.usdc, p.hours]), [['starter', 10, 12], ['boost', 20, 24], ['prime', 75, 72], ['spotlight', 200, 168]]);
  assert.equal(r.body.rpc, 'helius');
});

test('swaps off: quote only (with the fee), no transaction, nothing stored, submit refused', async () => {
  const s = await setup({}, false);
  const r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.live, false);
  assert.equal(r.body.transaction, undefined);
  assert.equal(r.body.quote.feeBps, 50);
  const build = s.chain.calls.find((c) => c.url.includes('/swap/v2/build'))!;
  const q = new URL(build.url).searchParams;
  assert.equal(q.get('platformFeeBps'), '50');
  assert.equal(q.get('feeAccount'), s.feeWsol);
  assert.equal(build.headers.get('x-api-key'), SECRET_JUP);
  assert.equal((s.db.db.prepare('SELECT COUNT(*) AS n FROM swaps').get() as any).n, 0);
  const sub = await s.call('/swap/submit', { swapId: 'x'.repeat(22), signedTransaction: 'A'.repeat(200) });
  assert.equal(sub.status, 403);
  assert.equal(s.chain.calls.filter((c) => c.rpc === 'sendTransaction').length, 0);
});

test('live: builds a valid fee-carrying transaction, wallet signs, BAGZ sends once, confirms and reads the fee from chain', async () => {
  const s = await setup();
  const r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const { quote } = r.body;
  assert.equal(quote.side, 'BUY');
  assert.equal(quote.feeBps, 50);
  assert.equal(quote.feeMint, sol.MINTS.wsol);
  assert.equal(quote.feeEstimateRaw, String(100000000n * 50n / 10000n)); // 0.50% of 0.1 SOL = 500,000 lamports
  assert.equal(quote.minOut, s.chain.lastBuild.otherAmountThreshold);
  assert.equal(quote.priceImpactPct, 0.42);
  assert.equal(quote.computeUnitLimit, 180_000); // 150,000 simulated × 1.2
  assert.equal(quote.networkFeeLamports, 5000 + Math.ceil(1_000_000 * 180_000 / 1e6));
  assert.ok(s.chain.calls.some((c) => c.rpc === 'simulateTransaction'));

  // the transaction: taker pays and is the only signer, fee account is writable inside the Jupiter swap instruction
  const tx = sol.b64decode(r.body.transaction);
  const p = sol.parseTransaction(tx);
  assert.equal(p.signatures.length, 1);
  assert.equal(p.decoded.staticKeys[0], s.taker.address);
  assert.equal(p.decoded.version, 0);
  const { ix } = resolve(p.message, s.chain);
  assert.equal(ix[0].program, sol.PROGRAMS.computeBudget);
  assert.deepEqual([...ix[0].data], [2, ...new Uint8Array(new Uint32Array([180_000]).buffer)]);
  const swap = ix.find((x: any) => x.program === 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')!;
  assert.ok(swap.accounts.some((a: any) => a.address === s.feeWsol && a.writable), 'fee account is writable in the swap');
  assert.deepEqual(swap.accounts.map((a: any) => a.address), JSON.parse(JSON.stringify(s.chain.lastBuild.swapInstruction.accounts)).map((a: any) => a.pubkey));
  assert.ok(ix.every((x: any) => x.accounts.every((a: any) => !a.signer || a.address === s.taker.address)));

  const signed = await walletSign(s.taker, r.body.transaction);
  const sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: signed });
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(sub.body.status, 'sent');
  assert.equal(s.chain.sent.length, 1);
  assert.deepEqual([...s.chain.sent[0].bytes], [...sol.b64decode(signed)]);
  assert.equal(sub.body.signature, s.chain.sent[0].signature);

  // duplicate submit (double click, retry) is refused and sends nothing
  const dup = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: signed });
  assert.equal(dup.status, 409);
  assert.equal(s.chain.sent.length, 1);

  // before the chain confirms, status stays "sent" — never "confirmed"
  let st = await s.call(`/swap/status?id=${r.body.swapId}`);
  assert.equal(st.body.status, 'sent');
  s.chain.land(sub.body.signature, { feeAccount: s.feeWsol, feeMint: sol.MINTS.wsol, feeDelta: '500000', keys: [s.taker.address] });
  st = await s.call(`/swap/status?id=${r.body.swapId}`);
  assert.equal(st.body.status, 'confirmed');
  assert.equal(st.body.feeCollected, '500000');
  assert.equal(st.body.error, null);
  assert.equal(st.body.warning, null);
});

test('tampered transaction (fee or amounts changed after signing) is refused and never sent', async () => {
  const s = await setup();
  const r = await s.call('/swap/prepare', buyBody(s.taker.address));
  const bytes = sol.b64decode(r.body.transaction);
  const p = sol.parseTransaction(bytes);
  const msg = p.message.slice(); msg[msg.length - 3] ^= 0xff; // change one byte of the message
  const forged = new Uint8Array(1 + 64 + msg.length); forged[0] = 1; forged.set(await s.taker.sign(msg), 1); forged.set(msg, 65);
  const sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: sol.b64encode(forged) });
  assert.equal(sub.status, 400);
  assert.match(sub.body.error, /not the one BAGZ built/);
  assert.equal(s.chain.sent.length, 0);
});

test('signature from a different wallet, or unsigned, is refused', async () => {
  const s = await setup();
  const r = await s.call('/swap/prepare', buyBody(s.taker.address));
  const other = await keypair();
  const bytes = sol.b64decode(r.body.transaction);
  const p = sol.parseTransaction(bytes);
  const wrong = bytes.slice(); wrong.set(await other.sign(p.message), 1);
  assert.equal((await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: sol.b64encode(wrong) })).status, 400);
  assert.equal((await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: r.body.transaction })).status, 400);
  assert.equal(s.chain.sent.length, 0);
  // the row is still usable after bad attempts
  const ok = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: await walletSign(s.taker, r.body.transaction) });
  assert.equal(ok.status, 200);
});

test('stale quote: signing after 25 s is refused; nothing sent', async () => {
  const s = await setup();
  const r = await s.call('/swap/prepare', buyBody(s.taker.address));
  s.advance(26_000);
  const sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: await walletSign(s.taker, r.body.transaction) });
  assert.equal(sub.status, 410);
  assert.equal(s.chain.sent.length, 0);
  assert.equal((await s.call(`/swap/status?id=${r.body.swapId}`)).body.status, 'expired');
});

test('idempotency: same key replays the same prepared swap; reuse for another swap is refused', async () => {
  const s = await setup();
  const body = buyBody(s.taker.address, 'same-key-1234567890');
  const a = await s.call('/swap/prepare', body);
  const b = await s.call('/swap/prepare', body);
  assert.equal(b.status, 200);
  assert.equal(b.body.swapId, a.body.swapId);
  assert.equal(b.body.transaction, a.body.transaction);
  assert.equal(b.body.replay, true);
  assert.equal(s.chain.calls.filter((c) => c.url.includes('/swap/v2/build')).length, 1);
  const c = await s.call('/swap/prepare', { ...body, amount: '200000000' });
  assert.equal(c.status, 409);
});

test('the fee is never dropped: missing, wrong or unwired fee accounts refuse the swap', async () => {
  // Jupiter leaves the fee account out of the swap instruction
  let s = await setup();
  s.chain.opts.buildOverride = (q, def) => { const swap = def.swapInstruction; swap.accounts = swap.accounts.filter((a: any) => a.pubkey !== q.get('feeAccount')); return def; };
  let r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 502); assert.match(r.body.error, /fee/i);
  // fee account not configured
  s = await setup({ FEE_ACCOUNT_WSOL: '' });
  r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 503); assert.match(r.body.error, /fee account/i);
  // fee account exists but is a USDC account
  s = await setup();
  s.env.FEE_ACCOUNT_WSOL = s.feeUsdc;
  r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 503); assert.match(r.body.error, /wrapped SOL/);
  // fee account owned by someone else
  s = await setup({ FEE_WALLET: rnd() });
  r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 503); assert.match(r.body.error, /different wallet/);
  // fee switched to 0 or garbage → refused, not run fee-free
  for (const v of ['0', 'abc', '5000']) {
    s = await setup({ BAGZ_PLATFORM_FEE_BPS: v });
    r = await s.call('/swap/prepare', buyBody(s.taker.address));
    assert.equal(r.status, 503, v);
  }
  // no Jupiter call was made with a fee of 0
  assert.ok(!s.chain.calls.some((c) => c.url.includes('platformFeeBps=0')));
});

test('sell: USDC pair uses the USDC fee account; SOL sell uses wSOL', async () => {
  const s = await setup();
  const r = await s.call('/swap/prepare', { taker: s.taker.address, inputMint: TOKEN, outputMint: sol.MINTS.usdc, amount: '5000000', slippageBps: 100, idempotencyKey: 'sell-usdc-1234567890' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.quote.side, 'SELL');
  assert.equal(r.body.quote.feeMint, sol.MINTS.usdc);
  assert.equal(new URL(s.chain.calls.find((c) => c.url.includes('/build'))!.url).searchParams.get('feeAccount'), s.feeUsdc);
});

test('input validation: bad token, zero amount, same mint, no SOL/USDC leg, bad slippage, no wallet', async () => {
  const s = await setup();
  const base = buyBody(s.taker.address);
  const cases: [any, RegExp][] = [
    [{ ...base, outputMint: 'not-a-mint' }, /Invalid token/],
    [{ ...base, amount: '0' }, /greater than zero/],
    [{ ...base, amount: '1.5' }, /greater than zero/],
    [{ ...base, outputMint: sol.MINTS.wsol }, /different/],
    [{ ...base, inputMint: TOKEN, outputMint: rnd() }, /SOL or USDC/],
    [{ ...base, slippageBps: 9000 }, /Slippage/],
    [{ ...base, taker: 'x' }, /Connect a wallet/],
  ];
  for (const [b, re] of cases) { const r = await s.call('/swap/prepare', b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.body.error, re); }
  assert.equal(s.chain.calls.filter((c) => c.url.includes('/build')).length, 0);
});

test('insufficient balance and no route are explained, nothing is offered for signing', async () => {
  let s = await setup();
  s.chain.opts.simulate = () => ({ err: { InstructionError: [3, { Custom: 1 }] }, logs: ['Program log: Error: insufficient lamports 100, need 2039280'], unitsConsumed: 0 });
  let r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 422); assert.match(r.body.error, /Insufficient balance/);
  assert.equal((s.db.db.prepare('SELECT COUNT(*) AS n FROM swaps').get() as any).n, 0);
  s = await setup();
  s.chain.opts.buildOverride = () => new Response(JSON.stringify({ error: 'No routes found' }), { status: 400 });
  r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.status, 422); assert.match(r.body.error, /No route/);
});

test('send rejected by the network → failed; unknown send result → expires when the blockhash does', async () => {
  let s = await setup();
  s.chain.opts.sendError = { message: 'Transaction simulation failed: Blockhash not found' };
  let r = await s.call('/swap/prepare', buyBody(s.taker.address));
  let sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: await walletSign(s.taker, r.body.transaction) });
  assert.equal(sub.status, 422);
  assert.equal((await s.call(`/swap/status?id=${r.body.swapId}`)).body.status, 'failed');

  s = await setup();
  s.chain.opts.sendError = 'network';
  r = await s.call('/swap/prepare', buyBody(s.taker.address));
  sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: await walletSign(s.taker, r.body.transaction) });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'sent');
  assert.equal((await s.call(`/swap/status?id=${r.body.swapId}`)).body.status, 'sent');
  s.chain.height += 1000; // past lastValidBlockHeight, never seen on-chain
  const st = await s.call(`/swap/status?id=${r.body.swapId}`);
  assert.equal(st.body.status, 'expired');
  assert.match(st.body.error, /No funds moved/);
});

test('on-chain failure is reported as failed; confirmed-without-fee is flagged', async () => {
  let s = await setup();
  let r = await s.call('/swap/prepare', buyBody(s.taker.address));
  let sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: await walletSign(s.taker, r.body.transaction) });
  s.chain.statuses.set(sub.body.signature, { confirmationStatus: 'confirmed', err: { InstructionError: [4, { Custom: 6001 }] } });
  let st = await s.call(`/swap/status?id=${r.body.swapId}`);
  assert.equal(st.body.status, 'failed');

  s = await setup();
  r = await s.call('/swap/prepare', buyBody(s.taker.address));
  sub = await s.call('/swap/submit', { swapId: r.body.swapId, signedTransaction: await walletSign(s.taker, r.body.transaction) });
  s.chain.land(sub.body.signature, { keys: [s.taker.address] });
  st = await s.call(`/swap/status?id=${r.body.swapId}`);
  assert.equal(st.body.status, 'confirmed');
  assert.equal(st.body.feeCollected, '0');
  assert.equal(st.body.error, null);
  assert.match(st.body.warning, /no platform fee/);
});

test('priority fee from Jupiter is capped', async () => {
  const s = await setup({ MAX_CU_PRICE_MICROLAMPORTS: '1000' });
  const r = await s.call('/swap/prepare', buyBody(s.taker.address));
  assert.equal(r.body.quote.computeUnitPrice, 1000);
});

test('API refuses other origins and scripts without an origin', async () => {
  const s = await setup();
  const res = await handle(new Request('https://api.test/v1/config', { headers: { origin: 'https://evil.example' } }), s.env, undefined, { fetch: s.chain.fetch, cache: null });
  assert.equal(res.status, 403);
  const res2 = await handle(new Request('https://api.test/v1/config'), s.env, undefined, { fetch: s.chain.fetch, cache: null });
  assert.equal(res2.status, 403);
});
