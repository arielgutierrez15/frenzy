/**
 * Fee account setup (/v1/admin/fee-setup…): status of the accounts that receive swap fees and BOOST payments, and the
 * one-signature flow that creates the missing ones — real Worker code, fake chain, real Ed25519 admin wallet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
// @ts-ignore plain JS
import { associatedTokenAddress, createAtaIdempotentIx, ATA_PROGRAM, isOnCurve } from '../worker/feesetup.js';
import { D1, Chain, keypair, walletSign, rnd, type Kp } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
const SECRET = 'F'.repeat(40);

async function setup(o: { feeWsol?: string; feeUsdc?: string; boostUsdc?: string; separateBoost?: boolean } = {}) {
  const chain = new Chain();
  const db = new D1();
  const admin = await keypair();
  // like the real setup: one BAGZ wallet owns the fee accounts, receives BOOST payments and is the admin
  const owner = admin.address;
  const boostOwner = o.separateBoost ? rnd() : owner;
  const wsolAta: string = await associatedTokenAddress(owner, sol.MINTS.wsol);
  const usdcAta: string = await associatedTokenAddress(owner, sol.MINTS.usdc);
  const boostAta: string = await associatedTokenAddress(boostOwner, sol.MINTS.usdc);
  let t = 1_800_000_000_000;
  const env: any = {
    ALLOWED_ORIGINS: ORIGIN, HELIUS_API_KEY: 'h', Db: db, ADMIN_WALLETS: admin.address, ADMIN_SESSION_SECRET: SECRET,
    FEE_WALLET: owner, FEE_ACCOUNT_WSOL: o.feeWsol ?? wsolAta, FEE_ACCOUNT_USDC: o.feeUsdc ?? usdcAta,
    BOOST_WALLET: boostOwner, BOOST_USDC_ACCOUNT: o.boostUsdc ?? boostAta,
    RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', UPSTREAM_PER_MIN_RPC: '100000',
  };
  let ipn = 0;
  const call = async (path: string, body?: unknown, token?: string) => {
    const h: Record<string, string> = { origin: ORIGIN, 'cf-connecting-ip': `10.9.0.${ipn++ % 250}`, 'content-type': 'application/json' };
    if (token) h.authorization = `Bearer ${token}`;
    const res = await handle(new Request(`https://api.test/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, undefined, { fetch: chain.fetch, now: () => t, cache: null });
    const text = await res.text();
    assert.ok(!text.includes(SECRET));
    return { status: res.status, body: JSON.parse(text) };
  };
  const signIn = async (kp: Kp = admin) => {
    const c = await call('/admin/challenge', { wallet: kp.address });
    const sig = await kp.sign(new TextEncoder().encode(c.body.message));
    const r = await call('/admin/session', { wallet: kp.address, nonce: c.body.nonce, signature: sol.b64encode(sig) });
    return r.body.token as string;
  };
  return { chain, db, env, call, admin, owner, boostOwner, wsolAta, usdcAta, boostAta, signIn, advance: (ms: number) => { t += ms; } };
}
const byId = (r: any, id: string) => r.body.accounts.find((a: any) => a.id === id);

test('address derivation matches the known BAGZ fee accounts', async () => {
  // the addresses configured in worker/wrangler.toml for the BAGZ wallet
  const owner = '3uyXamq9PACB7Qsc1gCmQWqrBDKKrUYvfhcB4tqX2H9p';
  assert.equal(await associatedTokenAddress(owner, sol.MINTS.wsol), 'FtYb8HPN6vfTLLh2mRccnc6dGDg8JozBn9FrRmKpZHiW');
  assert.equal(await associatedTokenAddress(owner, sol.MINTS.usdc), 'Ff7bLsLdj38ZLRe4815ZNUyMNdtfY2CRLb9iPyUjML9o');
  // a real wallet address is a curve point; a PDA is not
  assert.equal(isOnCurve(sol.b58decode(owner)), true);
  assert.equal(isOnCurve(sol.b58decode('Ff7bLsLdj38ZLRe4815ZNUyMNdtfY2CRLb9iPyUjML9o')), false);
});

test('status needs an admin session and reports missing accounts as creatable', async () => {
  const s = await setup();
  assert.equal((await s.call('/admin/fee-setup')).status, 401);
  const token = await s.signIn();
  const r = await s.call('/admin/fee-setup', undefined, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.swapsReady, false);
  assert.equal(r.body.boostReady, false);
  assert.equal(byId(r, 'fee_wsol').state, 'missing');
  assert.equal(byId(r, 'fee_wsol').creatable, true);
  assert.equal(byId(r, 'fee_usdc').state, 'missing');
  // BOOST uses the same USDC account here, so only two need creating
  assert.equal(byId(r, 'boost_usdc').sharedWith, 'fee_usdc');
  assert.equal(r.body.missing, 2);
});

test('build → admin signs → submit sends one transaction that only creates the two accounts', async () => {
  const s = await setup();
  const token = await s.signIn();
  const b = await s.call('/admin/fee-setup/build', {}, token);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.deepEqual(b.body.creates.map((c: any) => c.id).sort(), ['fee_usdc', 'fee_wsol']);
  // inspect what the wallet will be asked to sign
  const p = sol.parseTransaction(sol.b64decode(b.body.transaction));
  assert.equal(p.decoded.version, 'legacy');
  assert.equal(p.decoded.staticKeys[0], s.admin.address);
  assert.equal(p.decoded.header[0], 1, 'only the admin signs');
  assert.equal(p.decoded.instructions.length, 2);
  for (const ix of p.decoded.instructions) {
    assert.equal(p.decoded.staticKeys[ix.programIdIndex], ATA_PROGRAM);
    assert.deepEqual(Array.from(ix.data), [1], 'CreateIdempotent');
  }
  const signed = await walletSign(s.admin, b.body.transaction);
  const sub = await s.call('/admin/fee-setup/submit', { signedTransaction: signed }, token);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  assert.equal(s.chain.sent.length, 1);
  assert.equal(sub.body.signature, s.chain.sent[0].signature);
  // audit log entry
  const row: any = await s.db.prepare("SELECT * FROM admin_audit WHERE action = 'fees.setup'").first();
  assert.ok(row && row.admin === s.admin.address);
  // once the chain has them, everything is ready and there is nothing left to build
  s.chain.addTokenAccount(s.wsolAta, sol.MINTS.wsol, s.owner);
  s.chain.addTokenAccount(s.usdcAta, sol.MINTS.usdc, s.owner, '1500000');
  const r = await s.call('/admin/fee-setup', undefined, token);
  assert.equal(r.body.swapsReady, true);
  assert.equal(r.body.boostReady, true);
  assert.equal(r.body.missing, 0);
  assert.equal(byId(r, 'fee_usdc').balance, '1.5');
  assert.equal((await s.call('/admin/fee-setup/build', {}, token)).status, 409);
});

test('submit refuses anything that is not exactly "create a BAGZ receiving account"', async () => {
  const s = await setup();
  const token = await s.signIn();
  const bh = rnd();
  const sign = async (instructions: any[], kp: Kp = s.admin) => {
    const m = sol.compileMessage({ payer: kp.address, instructions, recentBlockhash: bh });
    return walletSign(kp, sol.b64encode(sol.unsignedTransaction(m.bytes, m.header[0])));
  };
  const good = createAtaIdempotentIx({ payer: s.admin.address, ata: s.wsolAta, owner: s.owner, mint: sol.MINTS.wsol });
  // an account BAGZ didn't ask for (someone else's ATA)
  const stranger = rnd();
  const other = createAtaIdempotentIx({ payer: s.admin.address, ata: await associatedTokenAddress(stranger, sol.MINTS.usdc), owner: stranger, mint: sol.MINTS.usdc });
  assert.equal((await s.call('/admin/fee-setup/submit', { signedTransaction: await sign([other]) }, token)).status, 400);
  // a sneaky token transfer next to a good create
  const drain = sol.transferCheckedIx({ source: rnd(), mint: sol.MINTS.usdc, destination: rnd(), owner: s.admin.address, amount: 5_000_000, decimals: 6 });
  assert.equal((await s.call('/admin/fee-setup/submit', { signedTransaction: await sign([good, drain]) }, token)).status, 400);
  // right account, wrong mint in the instruction
  const wrongMint = { ...good, accounts: good.accounts.map((a: any, i: number) => (i === 3 ? { ...a, pubkey: sol.MINTS.usdc } : a)) };
  assert.equal((await s.call('/admin/fee-setup/submit', { signedTransaction: await sign([wrongMint]) }, token)).status, 400);
  // someone else pays and signs
  const mallory = await keypair();
  const viaMallory = createAtaIdempotentIx({ payer: mallory.address, ata: s.wsolAta, owner: s.owner, mint: sol.MINTS.wsol });
  assert.equal((await s.call('/admin/fee-setup/submit', { signedTransaction: await sign([viaMallory], mallory) }, token)).status, 400);
  // bad signature
  const m = sol.compileMessage({ payer: s.admin.address, instructions: [good], recentBlockhash: bh });
  const unsigned = sol.b64encode(sol.unsignedTransaction(m.bytes, m.header[0]));
  assert.equal((await s.call('/admin/fee-setup/submit', { signedTransaction: unsigned }, token)).status, 400);
  assert.equal(s.chain.sent.length, 0, 'nothing reached the network');
  // the plain create on its own is accepted
  assert.equal((await s.call('/admin/fee-setup/submit', { signedTransaction: await sign([good]) }, token)).status, 200);
  assert.equal(s.chain.sent.length, 1);
});

test('non-standard or wrong accounts are reported, never created', async () => {
  // configured wSOL address is not the wallet's standard account
  const odd = rnd();
  const s = await setup({ feeWsol: odd });
  const token = await s.signIn();
  let r = await s.call('/admin/fee-setup', undefined, token);
  assert.equal(byId(r, 'fee_wsol').state, 'problem');
  assert.ok(!byId(r, 'fee_wsol').creatable);
  assert.match(byId(r, 'fee_wsol').detail, /wrangler\.toml/);
  // exists but for the wrong coin
  s.chain.addTokenAccount(s.usdcAta, sol.MINTS.wsol, s.owner);
  r = await s.call('/admin/fee-setup', undefined, token);
  assert.equal(byId(r, 'fee_usdc').state, 'problem');
  assert.equal(r.body.missing, 0);
  assert.equal((await s.call('/admin/fee-setup/build', {}, token)).status, 409);
});

test('a wallet without enough SOL hears about it before signing', async () => {
  const s = await setup();
  const token = await s.signIn();
  s.chain.opts.simulate = () => ({ err: { InstructionError: [0, { Custom: 1 }] }, logs: ['Program log: Error: insufficient lamports 0, need 2039280'] });
  const b = await s.call('/admin/fee-setup/build', {}, token);
  assert.equal(b.status, 422);
  assert.match(b.body.error, /needs about 0\.004\d SOL/);
});

test('separate BOOST wallet: its USDC account is checked and created too', async () => {
  const s = await setup({ separateBoost: true });
  const token = await s.signIn();
  const r = await s.call('/admin/fee-setup', undefined, token);
  assert.equal(r.body.missing, 3);
  const b = await s.call('/admin/fee-setup/build', {}, token);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.creates.length, 3);
  const sub = await s.call('/admin/fee-setup/submit', { signedTransaction: await walletSign(s.admin, b.body.transaction) }, token);
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
});
