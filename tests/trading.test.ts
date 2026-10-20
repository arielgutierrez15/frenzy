import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getQuote, parseOrder, orderPath, toRaw, fromRaw, estimateCostVsMarket, SOL_MINT } from '../src/trading/jupiter';
import { __setLiveTrading, liveTradingEnabled } from '../src/trading/flags';
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

function swapRoutes(over: { order?: () => Response } = {}) {
  const seen: { url: string; body?: any }[] = [];
  const handler = (u: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url: u, body });
    if (u.includes('/swap/v2/order')) return over.order ? over.order() : jsonRes({ requestId: 'req-1', transaction: UNSIGNED, inAmount: '1000000000', outAmount: '5000000000', router: 'metis', feeBps: 10, feeMint: SOL_MINT, mode: 'manual' });
    return jsonRes({}, 404);
  };
  return { seen, handler };
}

beforeEach(() => { __setLiveTrading(undefined); __resetWallets(); });

test('live trading is OFF by default in this build', () => { assert.equal(liveTradingEnabled(), false); });

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

