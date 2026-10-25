/**
 * Fee account setup (/v1/admin/fee-setup…): checks that the token accounts which receive the 0.50% swap fee and BOOST
 * payments exist on Solana, and lets a signed-in admin create any that are missing with one wallet signature.
 *
 *  GET  /admin/fee-setup         status of every configured receiving account (ready / missing / problem / unknown)
 *  POST /admin/fee-setup/build   unsigned transaction that creates the missing ones (admin wallet pays ~0.002 SOL rent each)
 *  POST /admin/fee-setup/submit  the admin-signed transaction; checked, then sent once
 *
 * Safety rules:
 *  - Only standard associated token accounts (ATAs) are created, and only for the exact owner + mint pairs in
 *    wrangler.toml. If a configured address is not that ATA, it is reported and never touched.
 *  - The instruction used is the ATA program's CreateIdempotent: it cannot move funds, and if the account already exists
 *    it does nothing. The only cost is the refundable rent deposit, paid by the signing admin wallet.
 *  - submit accepts a transaction only if every instruction is one of those creates, the fee payer is the signed-in
 *    admin, and the signature verifies. Anything else is refused before reaching the network.
 *  - This does not turn on swaps or BOOST payments; those stay behind ENABLE_LIVE_SWAPS / ENABLE_LIVE_BOOST_PAYMENTS.
 */
import { ApiError, database, config, isTestCopy, rpcUrl } from './api.js';
import { auditAt } from './controls.js';
import {
  MINTS, PROGRAMS, isPubkey, pk, b58encode, b64encode, b64decode, compileMessage, unsignedTransaction, parseTransaction, verifyEd25519,
} from './solana.js';

export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const TOKEN_ACCOUNT_RENT = 2_039_280; // lamports for a 165-byte token account (fallback if the RPC can't say)
const bad = (m) => new ApiError(400, m);

// ---- program-derived addresses ------------------------------------------------------------------------------------
// A PDA is sha256(seeds ‖ bump ‖ programId ‖ "ProgramDerivedAddress") for the highest bump whose hash is NOT a valid
// Ed25519 point. The on-curve test decompresses the point: y from the bytes, x² = (y² − 1) / (d·y² + 1) must be a square.
const P = 2n ** 255n - 19n;
const modp = (a) => ((a % P) + P) % P;
function powmod(b, e) { let r = 1n; b = modp(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
const D = modp(-121665n * powmod(121666n, P - 2n));
export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const x2 = modp((y2 - 1n) * powmod(D * y2 + 1n, P - 2n));
  if (x2 === 0n) return true;
  return powmod(x2, (P - 1n) / 2n) === 1n;
}
const enc = new TextEncoder();
export async function findProgramAddress(seeds, programId) {
  const prog = pk(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), prog, enc.encode('ProgramDerivedAddress')];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    if (!isOnCurve(h)) return b58encode(h);
  }
  throw new Error('No program address found');
}
/** the associated token account of `owner` for `mint` (classic SPL Token program) */
export const associatedTokenAddress = (owner, mint, tokenProgram = PROGRAMS.token) => findProgramAddress([pk(owner), pk(tokenProgram), pk(mint)], ATA_PROGRAM);

/** ATA CreateIdempotent: creates the account if missing, does nothing if it exists. Moves no funds besides rent. */
export const createAtaIdempotentIx = ({ payer, ata, owner, mint, tokenProgram = PROGRAMS.token }) => ({
  programId: ATA_PROGRAM,
  accounts: [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: ata, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: PROGRAMS.system, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ],
  data: Uint8Array.of(1),
});

// ---- RPC ----------------------------------------------------------------------------------------------------------
class RpcFail extends Error { constructor(m) { super(m); this.rpcRefused = true; } }
async function rpc(ctx, method, params) {
  if (ctx.guard && ctx.guard('rpc')) throw new ApiError(429, 'The Solana RPC budget for this minute is used up. Try again shortly.', { retryAfter: 20 });
  let res;
  try { res = await ctx.fetch(rpcUrl(ctx.env), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'manual' }); }
  catch { throw new ApiError(502, 'Solana RPC unreachable'); }
  const j = await res.json().catch(() => null);
  if (j && j.error) throw new RpcFail(String(j.error.message || 'RPC error').replace(/api-key=[^&\s]+/g, 'api-key=…').slice(0, 200));
  if (!res.ok || !j) throw new ApiError(502, `Solana RPC answered ${res.status}`);
  return j.result;
}

// ---- which accounts BAGZ needs ------------------------------------------------------------------------------------
async function wanted(env) {
  const cfg = config(env);
  const list = [
    { id: 'fee_wsol', label: 'Swap fees · wrapped SOL', use: 'Receives the 0.50% fee on SOL pairs', address: cfg.feeAccounts[MINTS.wsol], owner: cfg.feeOwner, mint: MINTS.wsol, for: 'swaps' },
    { id: 'fee_usdc', label: 'Swap fees · USDC', use: 'Receives the 0.50% fee on USDC pairs', address: cfg.feeAccounts[MINTS.usdc], owner: cfg.feeOwner, mint: MINTS.usdc, for: 'swaps' },
    { id: 'boost_usdc', label: 'BOOST payments · USDC', use: 'Receives BOOST listing payments', address: cfg.boostAccount, owner: cfg.boostOwner, mint: MINTS.usdc, for: 'boost' },
  ];
  for (const a of list) {
    a.configured = isPubkey(a.address) && isPubkey(a.owner);
    a.expected = isPubkey(a.owner) ? await associatedTokenAddress(a.owner, a.mint) : null;
    a.standard = a.configured && a.address === a.expected;
  }
  return list;
}

async function inspect(ctx, a) {
  const base = { id: a.id, label: a.label, use: a.use, for: a.for, address: a.address || null, owner: a.owner || null, mint: a.mint, token: a.mint === MINTS.usdc ? 'USDC' : 'wSOL', expected: a.expected };
  if (!a.configured) return { ...base, state: 'not_configured', detail: `Set the ${a.for === 'boost' ? 'BOOST wallet and account' : 'fee wallet and account'} in wrangler.toml` };
  let v;
  try { const r = await rpc(ctx, 'getAccountInfo', [a.address, { encoding: 'jsonParsed', commitment: 'confirmed' }]); v = r && r.value; }
  catch (e) { return { ...base, state: 'unknown', detail: `Couldn’t check: ${String(e && e.message || 'RPC error').slice(0, 120)}` }; }
  if (!v) {
    return a.standard
      ? { ...base, state: 'missing', creatable: true, detail: 'Not created yet. BAGZ can create it for you.' }
      : { ...base, state: 'problem', detail: `Not created yet, and it isn’t the standard ${base.token} account for this wallet (that would be ${a.expected}). Fix the address in wrangler.toml.` };
  }
  if (v.owner !== PROGRAMS.token && v.owner !== PROGRAMS.token2022) return { ...base, state: 'problem', detail: 'This address is not a token account' };
  const info = v.data && v.data.parsed && v.data.parsed.info;
  if (!info || v.data.parsed.type !== 'account') return { ...base, state: 'problem', detail: 'This address is not a token account' };
  if (info.mint !== a.mint) return { ...base, state: 'problem', detail: `This is a token account for a different coin, not ${base.token}` };
  if (info.owner !== a.owner) return { ...base, state: 'problem', detail: 'This token account belongs to a different wallet than the one configured' };
  if (info.state !== 'initialized') return { ...base, state: 'problem', detail: `This account is ${info.state || 'not initialised'}` };
  const amt = info.tokenAmount || {};
  return { ...base, state: 'ready', balance: amt.uiAmountString ?? (amt.amount !== undefined ? String(Number(amt.amount) / 10 ** (amt.decimals || 0)) : null), detail: 'Exists on Solana and is set up correctly' };
}

export async function feeSetupStatus(ctx) {
  if (isTestCopy(ctx.env)) return { at: ctx.now(), testCopy: true, accounts: [], swapsReady: false, boostReady: false, missing: 0, note: 'The test copy has no real wallets.' };
  const accounts = [];
  const seen = new Map();
  for (const a of await wanted(ctx.env)) {
    // BOOST may share the fee wallet's USDC account: check each address once
    const key = a.configured ? a.address : a.id;
    if (!seen.has(key)) seen.set(key, await inspect(ctx, a));
    const r = seen.get(key);
    accounts.push({ ...r, id: a.id, label: a.label, use: a.use, for: a.for, sharedWith: r.id !== a.id ? r.id : undefined });
  }
  const ok = (f) => accounts.filter((a) => a.for === f).every((a) => a.state === 'ready');
  const creatable = new Set(accounts.filter((a) => a.creatable).map((a) => a.address));
  return {
    at: ctx.now(), accounts, swapsReady: ok('swaps'), boostReady: ok('boost'), missing: creatable.size,
    rentPerAccountSol: TOKEN_ACCOUNT_RENT / 1e9,
  };
}

// ---- build + submit -----------------------------------------------------------------------------------------------
async function creatableList(ctx) {
  const st = await feeSetupStatus(ctx);
  const out = []; const seen = new Set();
  for (const a of st.accounts) if (a.creatable && !seen.has(a.address)) { seen.add(a.address); out.push(a); }
  return { st, list: out };
}

export async function feeSetupBuild(ctx, admin) {
  if (isTestCopy(ctx.env)) throw new ApiError(403, 'The test copy has no real wallets');
  if (!isPubkey(admin)) throw new ApiError(403, 'Sign in with an admin wallet to create accounts');
  const { list } = await creatableList(ctx);
  if (!list.length) throw new ApiError(409, 'Nothing to create: every receiving account that BAGZ can create already exists');
  const bh = await rpc(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const blockhash = bh && bh.value && bh.value.blockhash;
  if (!isPubkey(blockhash)) throw new ApiError(502, 'Solana RPC gave no recent blockhash');
  const instructions = list.map((a) => createAtaIdempotentIx({ payer: admin, ata: a.address, owner: a.owner, mint: a.mint }));
  const msg = compileMessage({ payer: admin, instructions, recentBlockhash: blockhash });
  const tx = unsignedTransaction(msg.bytes, msg.header[0]);
  let rent = TOKEN_ACCOUNT_RENT;
  try { const r = await rpc(ctx, 'getMinimumBalanceForRentExemption', [165]); if (Number.isInteger(r) && r > 0 && r < 10_000_000) rent = r; } catch { /* keep the fallback */ }
  // dry run first, so a wallet with too little SOL hears about it before signing
  try {
    const sim = await rpc(ctx, 'simulateTransaction', [b64encode(tx), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    const v = sim && sim.value;
    if (v && v.err) {
      const logs = (v.logs || []).join('\n');
      const broke = /insufficient (lamports|funds)/i.test(logs) || /InsufficientFunds|AccountNotFound/.test(JSON.stringify(v.err));
      throw new ApiError(422, broke ? `This wallet needs about ${((rent * list.length) / 1e9 + 0.0001).toFixed(4)} SOL to pay the account deposits and network fee` : 'Creating the accounts failed in a dry run, so nothing was offered for signing');
    }
  } catch (e) { if (e instanceof ApiError) throw e; /* simulation unavailable: the wallet will still show the transaction */ }
  return {
    transaction: b64encode(tx), lastValidBlockHeight: bh.value.lastValidBlockHeight ?? null,
    creates: list.map((a) => ({ id: a.id, label: a.label, address: a.address, token: a.token })),
    costSol: (rent * list.length) / 1e9, note: 'This only creates empty token accounts owned by your BAGZ wallet. The deposit (about 0.002 SOL each) stays in those accounts.',
  };
}

export async function feeSetupSubmit(ctx, admin, b) {
  if (isTestCopy(ctx.env)) throw new ApiError(403, 'The test copy has no real wallets');
  if (typeof b.signedTransaction !== 'string' || b.signedTransaction.length > 2000) throw bad('signedTransaction is required');
  let bytes; try { bytes = b64decode(b.signedTransaction); } catch { throw bad('signedTransaction must be base64'); }
  let p; try { p = parseTransaction(bytes); } catch { throw bad('signedTransaction could not be decoded'); }
  const d = p.decoded;
  if (d.version !== 'legacy' || d.lookups.length) throw bad('Unexpected transaction format');
  if (d.staticKeys[0] !== admin || p.signatures.length !== 1 || d.header[0] !== 1) throw bad('The fee payer must be the signed-in admin wallet, and only it may sign');
  if (!(await verifyEd25519(admin, p.message, p.signatures[0]))) throw bad('Wallet signature is missing or invalid');

  // every instruction must be "create this exact BAGZ receiving account", nothing else
  // (any standard configured account is allowed: CreateIdempotent is a no-op if it appeared since the build)
  const allowed = new Map((await wanted(ctx.env)).filter((a) => a.standard).map((a) => [a.address, a]));
  if (!d.instructions.length || d.instructions.length > 3) throw bad('Unexpected instructions in the transaction');
  const key = (i) => d.staticKeys[i];
  const created = [];
  for (const ix of d.instructions) {
    const prog = key(ix.programIdIndex);
    const k = ix.accounts.map(key);
    if (prog !== ATA_PROGRAM || ix.data.length !== 1 || ix.data[0] !== 1 || k.length !== 6) throw bad('Only "create account" instructions for BAGZ receiving accounts are allowed');
    const a = allowed.get(k[1]);
    if (!a || k[0] !== admin || k[2] !== a.owner || k[3] !== a.mint || k[4] !== PROGRAMS.system || k[5] !== PROGRAMS.token) throw bad('The transaction creates an account BAGZ did not ask for. Nothing was sent.');
    if (created.includes(k[1])) throw bad('Duplicate instruction');
    created.push(k[1]);
  }
  const signature = b58encode(p.signatures[0]);
  try {
    await rpc(ctx, 'sendTransaction', [b64encode(bytes), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  } catch (e) {
    if (e && e.rpcRefused) throw new ApiError(422, `The network rejected it before sending: ${e.message.slice(0, 160)}`, { signature });
    throw e;
  }
  const db = database(ctx.env);
  if (db) { try { await auditAt(ctx, db, admin, 'fees.setup', signature, { created: created.map((x) => allowed.get(x).id) }); } catch { /* audit table not created yet */ } }
  return { signature, status: 'sent', created: created.map((x) => ({ id: allowed.get(x).id, address: x })) };
}
