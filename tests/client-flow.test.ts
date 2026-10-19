/**
 * The app's own client code (src/trading/*) talking to the real Worker code (worker/index.js) over a fake chain.
 * The wallet is a Wallet Standard wallet backed by a real Ed25519 key, so every signature is genuinely verified.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
import { D1, Chain, keypair, rnd, type Kp } from './fakechain';
import { __setProxy } from '../src/providers/config';
import * as api from '../src/trading/api';
import { runSwap } from '../src/trading/bagzSwap';
import { __setLiveTrading, TradingDisabledError } from '../src/trading/flags';
import { connectWallet, signTransactionB64, signMessageText, type StdWallet } from '../src/trading/wallet';
import { connect, disconnect, getWalletState, __resetWalletStore, walletBrowseLinks } from '../src/trading/walletStore';

const ORIGIN = 'https://arielgutierrez15.github.io';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function stdWallet(kp: Kp, o: { reject?: 'connect' | 'sign'; name?: string } = {}) {
  const listeners: ((p: any) => void)[] = [];
  const signedInputs: Uint8Array[] = [];
  const account = { address: kp.address, publicKey: sol.b58decode(kp.address), chains: ['solana:mainnet'], features: ['solana:signTransaction'] };
  const w: StdWallet = {
    name: o.name || 'TestWallet', icon: '', chains: ['solana:mainnet'], accounts: [account],
    features: {
      'standard:connect': { connect: async () => { if (o.reject === 'connect') throw new Error('User rejected the request.'); return { accounts: [account] }; } },
      'standard:disconnect': { disconnect: async () => {} },
      'standard:events': { on: (_e: string, f: any) => { listeners.push(f); return () => { listeners.splice(listeners.indexOf(f), 1); }; } },
      'solana:signTransaction': {
        signTransaction: async (input: any) => {
          if (o.reject === 'sign') throw new Error('User rejected the request.');
          const bytes: Uint8Array = input.transaction;
          signedInputs.push(bytes);
          const p = sol.parseTransaction(bytes);
          const out = bytes.slice();
          out.set(await kp.sign(p.message), 1);
          return [{ signedTransaction: out }];
        },
      },
      'solana:signMessage': { signMessage: async (input: any) => [{ signedMessage: input.message, signature: await kp.sign(input.message) }] },
    },
  };
  return { w, signedInputs, emit: (p: any) => listeners.forEach((f) => f(p)) };
}

async function setup(envExtra: Record<string, string> = {}) {
  const chain = new Chain();
  const db = new D1();
  const feeOwner = rnd(), feeWsol = rnd(), feeUsdc = rnd(), boostOwner = rnd(), boostUsdc = rnd();
  chain.addTokenAccount(feeWsol, sol.MINTS.wsol, feeOwner);
  chain.addTokenAccount(feeUsdc, sol.MINTS.usdc, feeOwner);
  chain.addTokenAccount(boostUsdc, sol.MINTS.usdc, boostOwner);
  chain.addMint(TOKEN, 6);
  chain.tokens.set(TOKEN, { symbol: 'BONK', name: 'Bonk' });
  const user = await keypair();
  const userUsdc = rnd();
  chain.addTokenAccount(userUsdc, sol.MINTS.usdc, user.address, '50000000');
  chain.addTokenAccount(rnd(), TOKEN, user.address, '123000000');
  const env: any = {
    ALLOWED_ORIGINS: ORIGIN, JUPITER_API_KEY: 'k', HELIUS_API_KEY: 'h', Db: db,
    ENABLE_LIVE_SWAPS: 'true', ENABLE_LIVE_BOOST_PAYMENTS: 'true', BAGZ_PLATFORM_FEE_BPS: '50',
    FEE_WALLET: feeOwner, FEE_ACCOUNT_WSOL: feeWsol, FEE_ACCOUNT_USDC: feeUsdc, BOOST_WALLET: boostOwner, BOOST_USDC_ACCOUNT: boostUsdc,
    ADMIN_WALLETS: user.address, ADMIN_SESSION_SECRET: 'x'.repeat(40),
    RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', UPSTREAM_PER_MIN_JUP: '100000', UPSTREAM_PER_MIN_RPC: '100000', UPSTREAM_PER_MIN_DS: '100000', ...envExtra,
  };
  const requests: string[] = [];
  __setProxy('https://api.test');
  api.__setApiFetch(async (url, init) => {
    requests.push(`${init.method} ${new URL(url).pathname}`);
    const h = new Headers(init.headers); h.set('origin', ORIGIN); h.set('cf-connecting-ip', '10.9.9.9');
    return handle(new Request(url, { method: init.method, headers: h, body: init.body as any }), env, undefined, { fetch: chain.fetch, cache: null });
  });
  return { chain, db, env, user, userUsdc, feeWsol, boostUsdc, requests };
}
const fast = { sleep: async () => {}, pollMs: 0 };

beforeEach(() => { __setLiveTrading(undefined); __resetWalletStore(); });

test('client lock: runSwap refuses (no wallet prompt, no request) unless this build enables live trading', async () => {
  const s = await setup();
  const { w, signedInputs } = stdWallet(s.user);
  const c = await connectWallet(w);
  const p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  const before = s.requests.length;
  await assert.rejects(runSwap(p, c, fast), TradingDisabledError);
  assert.equal(signedInputs.length, 0);
  assert.equal(s.requests.length, before);
});

test('end to end: prepare → wallet signs → server sends once → confirmed with the fee read from chain', async () => {
  __setLiveTrading(true);
  const s = await setup();
  s.chain.opts.onSend = (_b, sig) => s.chain.land(sig, { feeAccount: s.feeWsol, feeMint: sol.MINTS.wsol, feeDelta: '500000', keys: [s.user.address] });
  const { w, signedInputs } = stdWallet(s.user);
  const c = await connectWallet(w);
  const p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  assert.equal(p.live, true);
  assert.equal(p.quote.feeBps, 50);
  const stages: string[] = [];
  const out = await runSwap(p, c, { ...fast, onStage: (x) => stages.push(x) });
  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(out.ok && out.feeCollected, '500000');
  assert.deepEqual(stages, ['Waiting for your wallet to sign', 'Sending', 'Confirming on Solana']);
  assert.equal(s.chain.sent.length, 1);
  assert.deepEqual([...signedInputs[0]], [...sol.b64decode(p.transaction!)], 'the wallet was shown exactly what the server built');
});

test('rejected signature: nothing is sent; the quote stays unsent', async () => {
  __setLiveTrading(true);
  const s = await setup();
  const c = await connectWallet(stdWallet(s.user, { reject: 'sign' }).w);
  const p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  const out = await runSwap(p, c, fast);
  assert.deepEqual([out.ok, !out.ok && out.stage, !out.ok && out.error], [false, 'sign', 'You declined the signature']);
  assert.equal(s.chain.sent.length, 0);
  assert.equal((await api.swapStatus(p.swapId!)).status, 'prepared');
});

test('double click: two runs of the same quote send exactly one transaction', async () => {
  __setLiveTrading(true);
  const s = await setup();
  s.chain.opts.onSend = (_b, sig) => s.chain.land(sig, { feeAccount: s.feeWsol, feeMint: sol.MINTS.wsol, feeDelta: '1', keys: [] });
  const c = await connectWallet(stdWallet(s.user).w);
  const p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  const [a, b] = await Promise.all([runSwap(p, c, fast), runSwap(p, c, fast)]);
  assert.equal(s.chain.sent.length, 1);
  assert.equal([a, b].filter((x) => x.ok).length, 1);
  const failed = [a, b].find((x) => !x.ok)!;
  assert.ok(!failed.ok && /already submitted/.test(failed.error));
});

test('slow wallet: a quote that expires while the wallet is open is not sent', async () => {
  __setLiveTrading(true);
  const s = await setup();
  const c = await connectWallet(stdWallet(s.user).w);
  const p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  let t = Date.now();
  const out = await runSwap(p, c, { ...fast, now: () => { const v = t; t += 30_000; return v; } });
  assert.ok(!out.ok && out.stage === 'sign' && /expired/.test(out.error));
  assert.equal(s.chain.sent.length, 0);
  // an already-stale quote never even opens the wallet
  const { w, signedInputs } = stdWallet(s.user);
  const c2 = await connectWallet(w);
  const out2 = await runSwap(p, c2, { ...fast, now: () => p.expiresAt! });
  assert.ok(!out2.ok && out2.stage === 'prepare');
  assert.equal(signedInputs.length, 0);
});

test('never claims success without confirmation: timeout and on-chain failure', async () => {
  __setLiveTrading(true);
  let s = await setup();
  let c = await connectWallet(stdWallet(s.user).w);
  let p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  let t = Date.now();
  let out = await runSwap(p, c, { pollMs: 0, sleep: async () => { t += 10_000; }, now: () => t, timeoutMs: 60_000 });
  assert.ok(!out.ok && out.stage === 'confirm' && /not confirmed yet/.test(out.error) && !!out.signature);

  s = await setup();
  s.chain.opts.onSend = (_b, sig) => s.chain.land(sig, { err: { InstructionError: [3, { Custom: 6001 }] }, keys: [] });
  c = await connectWallet(stdWallet(s.user).w);
  p = await api.prepareSwap({ taker: s.user.address, inputMint: sol.MINTS.wsol, outputMint: TOKEN, amount: '100000000', slippageBps: 300, idempotencyKey: api.newKey() });
  out = await runSwap(p, c, fast);
  assert.ok(!out.ok && out.stage === 'confirm' && /Failed on-chain/.test(out.error));
});

test('wallet store: connect, rejected connection, account switch and disconnect inside the wallet', async () => {
  const s = await setup();
  const other = await keypair();
  const rej = stdWallet(s.user, { reject: 'connect', name: 'Rejecty' });
  await connect(rej.w);
  assert.equal(getWalletState().conn, null);
  assert.equal(getWalletState().error, 'Connection was cancelled in the wallet');
  const good = stdWallet(s.user);
  await connect(good.w);
  assert.equal(getWalletState().conn?.account.address, s.user.address);
  good.emit({ accounts: [{ address: other.address, publicKey: sol.b58decode(other.address), chains: ['solana:mainnet'], features: [] }] });
  assert.equal(getWalletState().conn?.account.address, other.address, 'switching account in the wallet switches it in BAGZ');
  good.emit({ accounts: [] });
  assert.equal(getWalletState().conn, null, 'disconnecting in the wallet disconnects BAGZ');
  await connect(good.w);
  await disconnect();
  assert.equal(getWalletState().conn, null);
});

test('mobile handoff links follow the wallets’ documented browse formats', () => {
  const links = walletBrowseLinks('https://arielgutierrez15.github.io/frenzy/#home');
  assert.deepEqual(links.map((l) => l.name), ['Phantom', 'Solflare']);
  assert.equal(links[0].url, 'https://phantom.com/ul/browse/https%3A%2F%2Farielgutierrez15.github.io%2Ffrenzy%2F%23home?ref=https%3A%2F%2Farielgutierrez15.github.io');
  assert.equal(links[1].url, 'https://solflare.com/ul/v1/browse/https%3A%2F%2Farielgutierrez15.github.io%2Ffrenzy%2F%23home?ref=https%3A%2F%2Farielgutierrez15.github.io');
});

test('verified balances come from the chain via the server', async () => {
  const s = await setup();
  const b = await api.getBalances(s.user.address);
  assert.equal(b.lamports, '2500000000');
  assert.deepEqual(b.tokens.map((t) => [t.mint, t.amount]).sort(), [[sol.MINTS.usdc, '50000000'], [TOKEN, '123000000']].sort());
});

test('Boost from the app: order → wallet pays USDC → verified → admin signs in with the wallet and approves → live', async () => {
  const s = await setup();
  const { w } = stdWallet(s.user);
  const c = await connectWallet(w);
  const prev = await api.boostPreview(TOKEN, 'starter');
  assert.equal(prev.token.symbol, 'BONK');
  const { order } = await api.createOrder({ mint: TOKEN, package: 'starter', advertiser: s.user.address, idempotencyKey: api.newKey() });
  const tx = await api.orderTransaction(order.id, s.user.address);
  const signed = await signTransactionB64(c, tx.transaction);
  const sub = await api.submitOrderPayment(order.id, signed);
  s.chain.land(sub.signature, { keys: [s.user.address, s.userUsdc, s.boostUsdc, order.reference], instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { mint: sol.MINTS.usdc, destination: s.boostUsdc, authority: s.user.address, tokenAmount: { amount: '10000000' } } } }], blockTime: Math.floor(Date.now() / 1000) });
  const v = await api.verifyOrder(order.id, sub.signature);
  assert.equal(v.order.status, 'pending_review');
  // admin sign-in with the same wallet (it is in ADMIN_WALLETS here)
  const ch = await api.adminChallenge(s.user.address);
  const sig = await signMessageText(c, ch.message);
  const sess = await api.adminSession(s.user.address, ch.nonce, sig);
  const list = await api.adminPromotions(sess.token, 'pending_review');
  assert.equal(list.promotions.length, 1);
  await api.adminDecide(sess.token, order.id, 'approve', {});
  const act = await api.activeCampaigns();
  assert.deepEqual(act.campaigns.map((x) => x.symbol), ['BONK']);
});

test('without a configured server the features say so', async () => {
  __setProxy(null);
  await assert.rejects(api.getServerConfig(true), (e: any) => e instanceof api.ApiErr && e.message === api.NO_SERVER);
});
