import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { executeSwap, getQuote, parseOrder, orderPath, toRaw, fromRaw, estimateCostVsMarket, confirmSignature, SOL_MINT, MAX_QUOTE_AGE_MS } from '../src/trading/jupiter';
import { __setLiveTrading, TradingDisabledError, liveTradingEnabled } from '../src/trading/flags';
import { startWalletDiscovery, __resetWallets, solanaWallets, connectWallet, signTransactionB64, bytesToB64, b64ToBytes, type StdWallet } from '../src/trading/wallet';
import { harness, jsonRes } from './helpers';

const TOKEN = 'Aov3BtQvrGXM5V9oiHu8PKJWeV8a2rFnr24fwWcNpump';
const TAKER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const UNSIGNED = bytesToB64(new Uint8Array([1, 2, 3, 4]));

function fakeWallet(opts: { reject?: boolean } = {}) {
  const signed: Uint8Array[] = [];
  const w: StdWallet = {
    name: 'FakeWallet', icon: 'data:image/svg+xml;base64,', chains: ['solana:mainnet'], accounts: [],
    features: {
      'standard:connect': { connect: async () => ({ accounts: [{ address: TAKER, publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] }] }) },
      'solana:signTransaction': {
        signTransaction: async (...inputs: any[]) => {
          if (opts.reject) throw new Error('User rejected the request');
          signed.push(inputs[0].transaction);
          return [{ signedTransaction: new Uint8Array([...inputs[0].transaction, 9, 9]) }];
        },
      },
    },
  };
  return { w, signed };
}

function swapRoutes(over: { order?: () => Response; execute?: () => Response; status?: () => Response } = {}) {
  const seen: { url: string; body?: any }[] = [];
  const handler = (u: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body });
    if (u.includes('/swap/v2/order')) return over.order ? over.order() : jsonRes({ requestId: 'req-1', transaction: UNSIGNED, inAmount: '1000000000', outAmount: '5000000000', router: 'metis', feeBps: 10, feeMint: SOL_MINT, mode: 'manual' });
    if (u.includes('/swap/v2/execute')) return over.execute ? over.execute() : jsonRes({ status: 'Success', signature: 'SIG123', code: 0, totalOutputAmount: '4990000000' });
    if (body?.method === 'getSignatureStatuses') return over.status ? over.status() : jsonRes({ result: { value: [{ confirmationStatus: 'confirmed', err: null }] } });
    return jsonRes({}, 404);
  };
  return { seen, handler };
}

beforeEach(() => { __setLiveTrading(undefined); __resetWallets(); });

test('live trading is OFF by default and executeSwap refuses before touching the network or the wallet', async () => {
  assert.equal(liveTradingEnabled(), false);
  const r = swapRoutes();
  const h = harness(r.handler);
  const { w, signed } = fakeWallet();
  const c = await connectWallet(w);
  await assert.rejects(executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1000000000' }, c), TradingDisabledError);
  assert.equal(h.calls.length, 0);
  assert.equal(signed.length, 0);
});

test('quotes work while trading is off, need no wallet, and send no taker', async () => {
  const r = swapRoutes();
  const h = harness(r.handler);
  const q = await getQuote({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1000000000', slippageBps: 300 });
  assert.ok(q.ok);
  assert.equal(q.ok && q.quote.outAmount, '5000000000');
  const url = new URL(h.calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.jup.ag/swap/v2/order');
  assert.equal(url.searchParams.get('taker'), null);
  assert.equal(url.searchParams.get('slippageBps'), '300');
  assert.equal(url.searchParams.get('amount'), '1000000000');
});

test('full flow when enabled: fresh quote with taker → wallet signs → execute → confirmed on-chain', async () => {
  __setLiveTrading(true);
  const r = swapRoutes();
  const h = harness(r.handler, { autoAdvance: true });
  const { w, signed } = fakeWallet();
  const c = await connectWallet(w);
  const stages: string[] = [];
  const out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1000000000', slippageBps: 300 }, c, { onStage: (s) => stages.push(s), sleep: async () => {} });
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.ok && out.signature, 'SIG123');
  assert.equal(out.ok && out.confirmation.state, 'confirmed');
  assert.equal(new URL(r.seen[0].url).searchParams.get('taker'), TAKER);
  assert.deepEqual(Array.from(signed[0]), [1, 2, 3, 4], 'the wallet signed exactly the bytes Jupiter returned');
  const exec = r.seen.find((x) => x.url.includes('/execute'))!;
  assert.equal(exec.body.requestId, 'req-1');
  assert.deepEqual(Array.from(b64ToBytes(exec.body.signedTransaction)), [1, 2, 3, 4, 9, 9]);
  assert.deepEqual(stages, ['Getting a fresh quote', 'Waiting for your wallet to sign', 'Sending through Jupiter', 'Confirming on Solana']);
  void h;
});

test('declining the signature stops the flow before anything is sent', async () => {
  __setLiveTrading(true);
  const r = swapRoutes();
  harness(r.handler, { autoAdvance: true });
  const c = await connectWallet(fakeWallet({ reject: true }).w);
  const out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1' }, c);
  assert.deepEqual([out.ok, !out.ok && out.stage, !out.ok && out.error], [false, 'sign', 'You declined the signature']);
  assert.ok(!r.seen.some((x) => x.url.includes('/execute')));
});

test('a failed or unclear execute is reported as a failure, never as success, and is not retried', async () => {
  __setLiveTrading(true);
  let r = swapRoutes({ execute: () => jsonRes({ status: 'Failed', code: -1005, error: 'Transaction expired' }) });
  harness(r.handler, { autoAdvance: true });
  const c = await connectWallet(fakeWallet().w);
  let out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1' }, c, { sleep: async () => {} });
  assert.ok(!out.ok && out.stage === 'execute' && /expired/.test(out.error));

  r = swapRoutes({ execute: () => jsonRes({}, 500) });
  harness(r.handler, { autoAdvance: true });
  out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1' }, c, { sleep: async () => {} });
  assert.ok(!out.ok && /may or may not have landed/.test(out.error));
  assert.equal(r.seen.filter((x) => x.url.includes('/execute')).length, 1, 'execute is never retried automatically');
});

test('on-chain failure and unconfirmed transactions are not success', async () => {
  __setLiveTrading(true);
  const c = await connectWallet(fakeWallet().w);
  let r = swapRoutes({ status: () => jsonRes({ result: { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }] } }) });
  harness(r.handler, { autoAdvance: true });
  let out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1' }, c, { sleep: async () => {} });
  assert.ok(!out.ok && /failed on-chain/.test(out.error) && out.signature === 'SIG123');

  r = swapRoutes({ status: () => jsonRes({ result: { value: [null] } }) });
  const h = harness(r.handler, { autoAdvance: true });
  let t = 0;
  out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1' }, c, { sleep: async () => { t += 30_000; h.advance(30_000); }, now: () => h.now() });
  assert.ok(!out.ok && /not confirmed in time/.test(out.error) && out.signature === 'SIG123');
  void t;
});

test('an expired quote is refused before signing', async () => {
  __setLiveTrading(true);
  const r = swapRoutes();
  const h = harness(r.handler, { autoAdvance: true });
  const { w, signed } = fakeWallet();
  const c = await connectWallet(w);
  const out = await executeSwap({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '1' }, c, { now: () => h.now() + MAX_QUOTE_AGE_MS + 1 });
  assert.ok(!out.ok && out.stage === 'quote' && /expired/.test(out.error));
  assert.equal(signed.length, 0);
});

test('order parsing: validates, reads optional fields, surfaces router errors', async () => {
  assert.throws(() => parseOrder([]), /object/);
  assert.throws(() => parseOrder({ requestId: 'x' }), /outAmount/);
  const o = parseOrder({ outAmount: 123, transaction: '', priceImpact: '0.42', slippageBps: 50, feeBps: 5 });
  assert.deepEqual([o.outAmount, o.transaction, o.priceImpactPct, o.slippageBps, o.feeBps], ['123', null, 0.42, 50, 5]);
  harness(() => jsonRes({ transaction: '', errorCode: 1, errorMessage: 'Insufficient liquidity' }));
  const q = await getQuote({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '5' });
  assert.deepEqual(q, { ok: false, error: 'Insufficient liquidity' });
  assert.deepEqual(await getQuote({ inMint: SOL_MINT, outMint: TOKEN, amountRaw: '0' }), { ok: false, error: 'Enter an amount greater than zero' });
});

test('amount maths has no floating point drift', () => {
  assert.equal(toRaw('1.5', 9), '1500000000');
  assert.equal(toRaw('0.000001', 6), '1');
  assert.equal(toRaw('0.1', 9), '100000000');
  assert.equal(toRaw('123456789.123456', 6), '123456789123456');
  assert.equal(toRaw('0.0000001', 6), '0', 'digits beyond the token precision are cut, not rounded up');
  assert.equal(toRaw('abc', 6), undefined);
  assert.equal(toRaw('', 6), undefined);
  assert.equal(fromRaw('1500000000', 9), 1.5);
  assert.equal(orderPath({ inMint: 'A', outMint: 'B', amountRaw: '7', slippageBps: 49.6 }), '/swap/v2/order?inputMint=A&outputMint=B&amount=7&slippageBps=50');
});

test('cost-vs-market estimate', () => {
  // 1 SOL buys 5000 tokens, but market says 1 SOL = 5100 tokens: 1.96% worse
  const c = estimateCostVsMarket({ inAmount: 1, outAmount: 5000, marketPriceInOut: 5100 })!;
  assert.ok(Math.abs(c - 1.9608) < 0.001);
  assert.equal(estimateCostVsMarket({ inAmount: 0, outAmount: 1, marketPriceInOut: 1 }), undefined);
});

test('wallet standard: discovers registered wallets, offers only Solana signers, never stores keys', async () => {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const fakeWin: any = {
    addEventListener: (n: string, f: any) => { (listeners[n] ||= []).push(f); },
    dispatchEvent: (e: any) => { (listeners[e.type] || []).forEach((f) => f(e)); return true; },
  };
  (globalThis as any).CustomEvent ||= class { constructor(public type: string, public init: any) { Object.assign(this, { detail: init?.detail }); } };
  startWalletDiscovery(fakeWin);
  const { w } = fakeWallet();
  const evmOnly: StdWallet = { ...w, name: 'EvmOnly', chains: ['eip155:1'] };
  const noSign: StdWallet = { ...w, name: 'NoSign', features: { 'standard:connect': w.features['standard:connect'] } };
  // a wallet loading after the app announces itself through the register event
  fakeWin.dispatchEvent(Object.assign(new (globalThis as any).CustomEvent('wallet-standard:register-wallet', { detail: (api: any) => api.register(w, evmOnly, noSign) }), {}));
  assert.deepEqual(solanaWallets().map((x) => x.name), ['FakeWallet']);
  const c = await connectWallet(solanaWallets()[0]);
  assert.equal(c.account.address, TAKER);
  const signed = await signTransactionB64(c, UNSIGNED);
  assert.deepEqual(Array.from(b64ToBytes(signed)), [1, 2, 3, 4, 9, 9]);
  assert.ok(!JSON.stringify(c).toLowerCase().includes('secret'));
});

test('confirmSignature returns unknown, never confirmed, when the RPC cannot find it', async () => {
  const h = harness(() => jsonRes({ result: { value: [null] } }), { autoAdvance: true });
  const r = await confirmSignature('SIG', { timeoutMs: 5000, intervalMs: 1000, sleep: async () => { h.advance(1000); }, now: () => h.now() });
  assert.deepEqual(r, { state: 'unknown' });
});
