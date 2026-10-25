/**
 * BAGZ API (/v1/…) — swaps with the BAGZ platform fee, BOOST sponsored listings, admin review, analytics, balances.
 *
 * Money rules enforced here, not in the browser:
 *  - Live swaps and live BOOST payments are OFF unless ENABLE_LIVE_SWAPS / ENABLE_LIVE_BOOST_PAYMENTS are exactly "true".
 *  - The platform fee (BAGZ_PLATFORM_FEE_BPS, 50 = 0.50%) is never dropped: if the fee account is missing, wrong or not
 *    wired into Jupiter's swap instruction, the swap is refused.
 *  - The wallet must sign the exact message BAGZ built (sha256 match), so nobody can strip the fee or change amounts.
 *  - A swap is submitted at most once; a payment signature can activate at most one order (database constraints).
 *  - "Confirmed" is only ever reported after the RPC says so, and the collected fee is read from the chain.
 *
 * Jupiter Swap API V2 /build reference: developers.jup.ag/docs/api-reference/swap/build (checked 19 Oct 2026):
 *   GET https://api.jup.ag/swap/v2/build — inputMint, outputMint, amount, taker (required), slippageBps, platformFeeBps,
 *   feeAccount (required when platformFeeBps > 0; for ExactIn its mint may be the input or output mint).
 *   Response: computeBudgetInstructions (price only), setupInstructions, swapInstruction, cleanupInstruction,
 *   otherInstructions, addressesByLookupTableAddress, blockhashWithMetadata{blockhash[], lastValidBlockHeight}, outAmount,
 *   otherAmountThreshold, priceImpactPct (decimal ratio), routePlan. /build transactions cannot use /execute.
 */
import {
  isPubkey, b58encode, b58decode, b64decode, b64encode, compileMessage, unsignedTransaction, parseTransaction, parseLookupTable,
  fromApiInstruction, setComputeUnitLimitIx, setComputeUnitPriceIx, transferCheckedIx, memoIx, verifyEd25519, sha256hex, randomBytes,
  PROGRAMS, MINTS, eqBytes,
} from './solana.js';
import { social, currentUser } from './social.js';
import { vault } from './vault.js';
import { adminOverview, adminUsers, adminLog } from './admin.js';
import {
  isPaused, isBlocked, blockedSet, auditAt, boostCounts, getSwitches, setSwitch, revenue, walletBalances, listBlocklist, blockToken,
  unblockToken, userStats, vaultAdmin, setCard, adjustCoins, setRewards, auditLog, publicBlocklist,
} from './controls.js';
import { CHALLENGES } from './vault.js';
import { feeSetupStatus, feeSetupBuild, feeSetupSubmit, associatedTokenAddress, ATA_PROGRAM } from './feesetup.js';

export const PACKAGES = {
  starter: { label: 'Starter', usdc: 10, hours: 12, rank: 1 },
  boost: { label: 'Boost', usdc: 20, hours: 24, rank: 2 },
  prime: { label: 'Prime', usdc: 75, hours: 72, rank: 3 },
  spotlight: { label: 'Spotlight', usdc: 200, hours: 168, rank: 4 },
};
const USDC_DECIMALS = 6;
const CU_MAX = 1_400_000;
const QUOTE_TTL_MS = 25_000;
const ORDER_PAY_WINDOW_MS = 30 * 60_000;
const EVENT_WINDOW_MS = 30 * 60_000;
const ADMIN_SESSION_MS = 2 * 3600_000;
const DIGITS = /^\d{1,24}$/;
const ID = /^[A-Za-z0-9_-]{16,64}$/;

export class ApiError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (m, extra) => new ApiError(400, m, extra);

// ---- config -------------------------------------------------------------------------------------------------------
export function config(env) {
  const raw = env.BAGZ_PLATFORM_FEE_BPS ?? '50';
  const bps = /^\d{1,4}$/.test(String(raw)) ? Number(raw) : NaN;
  return {
    liveSwaps: env.ENABLE_LIVE_SWAPS === 'true',
    liveBoostPayments: env.ENABLE_LIVE_BOOST_PAYMENTS === 'true',
    // a fee of 0 or a malformed value is treated as misconfiguration, never as "no fee"
    feeBps: bps >= 1 && bps <= 255 ? bps : null,
    feeAccounts: { [MINTS.wsol]: env.FEE_ACCOUNT_WSOL || '', [MINTS.usdc]: env.FEE_ACCOUNT_USDC || '' },
    feeOwner: env.FEE_WALLET || '',
    boostAccount: env.BOOST_USDC_ACCOUNT || '',
    boostOwner: env.BOOST_WALLET || '',
    admins: (env.ADMIN_WALLETS || '').split(',').map((s) => s.trim()).filter(isPubkey),
    maxCuPrice: /^\d{1,12}$/.test(env.MAX_CU_PRICE_MICROLAMPORTS || '') ? Number(env.MAX_CU_PRICE_MICROLAMPORTS) : 1_000_000,
  };
}
export const database = (env) => env.Db || env.DB || null;
/**
 * TEST COPY ONLY. Set by src/demo/server.ts inside the browser test copy, never in wrangler.toml. It allows a fake
 * "test payment" for BOOST orders and lets any signed-in BAGZ account use the review desk. No money is involved.
 */
export const isTestCopy = (env) => env.TEST_COPY === '1';
/** SOLANA_RPC_URL as pasted into Cloudflare, tidied: surrounding spaces/quotes removed, https:// added if missing. */
export function customRpcUrl(env) {
  let s = String(env.SOLANA_RPC_URL || '').trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : ''; } catch { return ''; }
}
export const heliusRpcUrl = (env) => {
  const k = String(env.HELIUS_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  return k ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}` : '';
};
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
export function rpcUrl(env) {
  return customRpcUrl(env) || heliusRpcUrl(env) || PUBLIC_RPC;
}
/** every RPC this Worker can use, best first (used where falling back is safe, e.g. fee-account checks) */
export function rpcCandidates(env) {
  const out = [];
  const add = (label, url) => { if (url && !out.some((c) => c.url === url)) out.push({ label, url }); };
  if (env.SOLANA_RPC_URL) add('SOLANA_RPC_URL', customRpcUrl(env) || 'invalid');
  add('Helius (HELIUS_API_KEY)', heliusRpcUrl(env));
  add('public Solana RPC', PUBLIC_RPC);
  return out;
}

// ---- upstream helpers ---------------------------------------------------------------------------------------------
async function upstream(ctx, id, url, init = {}) {
  if (ctx.guard && ctx.guard(id)) throw new ApiError(429, `The ${id === 'jup' ? 'Jupiter' : id === 'rpc' ? 'Solana RPC' : id} budget for this minute is used up. Try again shortly.`, { retryAfter: 20 });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), init.timeout || 10_000);
  try { return await ctx.fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' }); }
  catch (e) { throw new ApiError(e && e.name === 'AbortError' ? 504 : 502, `${id === 'rpc' ? 'Solana RPC' : 'Upstream'} ${e && e.name === 'AbortError' ? 'timed out' : 'unreachable'}`); }
  finally { clearTimeout(t); }
}
export class RpcError extends Error { constructor(message, code, data) { super(message); this.code = code; this.data = data; } }
async function rpc(ctx, method, params) {
  const res = await upstream(ctx, 'rpc', rpcUrl(ctx.env), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!res.ok) throw new ApiError(502, `Solana RPC answered ${res.status}`);
  let j; try { j = await res.json(); } catch { throw new ApiError(502, 'Solana RPC returned invalid JSON'); }
  if (j && j.error) throw new RpcError(String(j.error.message || 'RPC error').slice(0, 300), j.error.code, j.error.data);
  return j ? j.result : undefined;
}
async function jupiter(ctx, path, params) {
  if (!ctx.env.JUPITER_API_KEY) throw new ApiError(503, 'Jupiter API key is not configured on the server');
  const res = await upstream(ctx, 'jup', `https://api.jup.ag${path}?${new URLSearchParams(params)}`, { headers: { accept: 'application/json', 'x-api-key': ctx.env.JUPITER_API_KEY } });
  let j = null; try { j = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    const msg = j && typeof j.error === 'string' ? j.error.slice(0, 200) : `Jupiter answered ${res.status}`;
    throw new ApiError(res.status === 429 ? 429 : res.status === 400 ? 422 : 502, /no routes/i.test(msg) ? 'No route found for this token right now' : msg);
  }
  if (!j || typeof j !== 'object') throw new ApiError(502, 'Jupiter returned invalid JSON');
  return j;
}

// a token account must exist, be an initialised SPL/Token-2022 account for `mint`, and (optionally) belong to `owner`
const accountCache = new Map();
async function checkTokenAccount(ctx, account, mint, owner, what) {
  if (!isPubkey(account)) throw new ApiError(503, `${what} is not configured`);
  const key = `${account}|${mint}|${owner}`;
  const hit = accountCache.get(key);
  if (hit && ctx.now() - hit < 10 * 60_000) return;
  const r = await rpc(ctx, 'getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = r && r.value;
  if (!v) throw new ApiError(503, `${what} does not exist on-chain`);
  if (v.owner !== PROGRAMS.token && v.owner !== PROGRAMS.token2022) throw new ApiError(503, `${what} is not a token account`);
  const info = v.data && v.data.parsed && v.data.parsed.info;
  if (!info || v.data.parsed.type !== 'account' || info.mint !== mint) throw new ApiError(503, `${what} is not a ${mint === MINTS.usdc ? 'USDC' : mint === MINTS.wsol ? 'wrapped SOL' : 'matching'} token account`);
  if (info.state !== 'initialized') throw new ApiError(503, `${what} is ${info.state || 'not initialised'}`);
  if (owner && info.owner !== owner) throw new ApiError(503, `${what} belongs to a different wallet than configured`);
  accountCache.set(key, ctx.now());
}

// ---- small utilities ----------------------------------------------------------------------------------------------
const newId = () => b58encode(randomBytes(16));
const nowIso = (t) => new Date(t).toISOString();
function needDb(ctx) { const d = database(ctx.env); if (!d) throw new ApiError(503, 'Database (D1 binding "Db") is not connected'); return d; }
const one = (d, sql, ...a) => d.prepare(sql).bind(...a).first();
const all = async (d, sql, ...a) => (await d.prepare(sql).bind(...a).all()).results || [];
const run = (d, sql, ...a) => d.prepare(sql).bind(...a).run();
const changes = (r) => (r && r.meta ? r.meta.changes : 0) || 0;
const bigMax = (a, b) => (a > b ? a : b);
function signedTxBytes(s) {
  if (typeof s !== 'string' || s.length < 100 || s.length > 2400 || !/^[A-Za-z0-9+/=]+$/.test(s)) throw bad('signedTransaction is not valid base64');
  try { return b64decode(s); } catch { throw bad('signedTransaction is not valid base64'); }
}
function feeLegFor(input, output) {
  if (input === MINTS.wsol || output === MINTS.wsol) return MINTS.wsol;
  if (input === MINTS.usdc || output === MINTS.usdc) return MINTS.usdc;
  return null;
}
const priceFromIx = (ixs) => {
  for (const ix of ixs || []) {
    try { const d = b64decode(ix.data); if (ix.programId === PROGRAMS.computeBudget && d[0] === 3 && d.length >= 9) { let v = 0n; for (let i = 8; i >= 1; i--) v = (v << 8n) | BigInt(d[i]); return Number(v); } } catch { /* ignore */ }
  }
  return 0;
};

async function loadLookupTables(ctx, map) {
  const keys = Object.keys(map || {});
  if (!keys.length) return [];
  if (keys.length > 8 || !keys.every(isPubkey)) throw new ApiError(502, 'Jupiter returned unexpected lookup tables');
  const r = await rpc(ctx, 'getMultipleAccounts', [keys, { encoding: 'base64', commitment: 'confirmed' }]);
  const vals = (r && r.value) || [];
  return keys.map((key, i) => {
    const v = vals[i];
    if (!v || v.owner !== 'AddressLookupTab1e1111111111111111111111111') throw new ApiError(502, 'A lookup table Jupiter named does not exist');
    // the on-chain table is authoritative; Jupiter's copy is only used as a consistency check
    const addresses = parseLookupTable(b64decode(v.data[0]));
    const claimed = map[key] || [];
    if (claimed.some((a, j) => addresses[j] !== a)) throw new ApiError(502, 'Jupiter lookup table data does not match the chain');
    return { key, addresses };
  });
}

// ---- swaps ----------------------------------------------------------------------------------------------------------
function readSwapInput(b) {
  const { taker, inputMint, outputMint, amount } = b || {};
  if (!isPubkey(taker)) throw bad('Connect a wallet first (taker is not a valid address)');
  if (!isPubkey(inputMint) || !isPubkey(outputMint)) throw bad('Invalid token address');
  if (inputMint === outputMint) throw bad('Pick two different tokens');
  if (typeof amount !== 'string' || !DIGITS.test(amount) || BigInt(amount) <= 0n) throw bad('Enter an amount greater than zero');
  const slippageBps = Number(b.slippageBps ?? 300);
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 5000) throw bad('Slippage must be between 0.1% and 50%');
  const feeMint = feeLegFor(inputMint, outputMint);
  if (!feeMint) throw bad('BAGZ swaps pair a token with SOL or USDC');
  const side = inputMint === feeMint ? 'BUY' : 'SELL';
  return { taker, inputMint, outputMint, amount, slippageBps, feeMint, side };
}

/**
 * Jupiter's setup / cleanup / other instructions run with the user's signature, so they are limited to the harmless
 * kinds a swap needs: create the user's own token accounts, wrap SOL into the user's own wSOL account, sync it, close the
 * user's account back to the user, and memos. Anything else (a token transfer or approval, a SOL transfer to another
 * address, an unknown program) is refused, so a compromised or misbehaving API can't slip one in next to the swap.
 */
async function checkAuxInstructions(ixs, taker) {
  const wsolAta = await associatedTokenAddress(taker, MINTS.wsol);
  const k = (ix, i) => ix.accounts[i] && ix.accounts[i].pubkey;
  for (const ix of ixs) {
    const tag = ix.data.length ? ix.data[0] : -1;
    let ok = false;
    if (ix.programId === ATA_PROGRAM) ok = (tag === -1 || tag === 0 || tag === 1) && k(ix, 0) === taker && k(ix, 2) === taker;
    else if (ix.programId === PROGRAMS.token || ix.programId === PROGRAMS.token2022) {
      ok = tag === 17 // SyncNative
        || ((tag === 1 || tag === 16 || tag === 18) && ix.accounts.every((a) => !a.isSigner || a.pubkey === taker)) // InitializeAccount*
        || (tag === 9 && k(ix, 1) === taker && k(ix, 2) === taker); // CloseAccount back to the user
    } else if (ix.programId === PROGRAMS.system) {
      const kind = ix.data.length >= 4 ? new DataView(ix.data.buffer, ix.data.byteOffset, 4).getUint32(0, true) : -1;
      ok = kind === 2 && k(ix, 0) === taker && k(ix, 1) === wsolAta; // wrap SOL into the user's own wSOL account
    } else if (ix.programId === PROGRAMS.memo) ok = true;
    if (!ok) {
      const name = ix.programId === PROGRAMS.system ? 'System' : ix.programId === PROGRAMS.token || ix.programId === PROGRAMS.token2022 ? 'Token' : ix.programId === ATA_PROGRAM ? 'Associated Token' : ix.programId === PROGRAMS.computeBudget ? 'Compute Budget' : ix.programId.slice(0, 8) + '…';
      throw new ApiError(502, `Jupiter's swap included an instruction BAGZ doesn't allow (${name} program, instruction ${tag}). Nothing was offered for signing.`);
    }
  }
}

async function buildSwap(ctx, inp, cfg, { simulate }) {
  if (cfg.feeBps === null) throw new ApiError(503, 'BAGZ_PLATFORM_FEE_BPS is not set to a valid fee. Swaps are refused rather than run without the fee.');
  const feeAccount = cfg.feeAccounts[inp.feeMint];
  await checkTokenAccount(ctx, feeAccount, inp.feeMint, cfg.feeOwner || null, `The BAGZ ${inp.feeMint === MINTS.usdc ? 'USDC' : 'wSOL'} fee account`);

  const j = await jupiter(ctx, '/swap/v2/build', {
    inputMint: inp.inputMint, outputMint: inp.outputMint, amount: inp.amount, taker: inp.taker,
    slippageBps: String(inp.slippageBps), platformFeeBps: String(cfg.feeBps), feeAccount,
  });
  // the answer must describe exactly the swap that was asked for
  if (j.inputMint !== inp.inputMint || j.outputMint !== inp.outputMint) throw new ApiError(502, 'Jupiter returned a different token pair');
  if (String(j.inAmount) !== inp.amount) throw new ApiError(502, 'Jupiter returned a different input amount');
  if (!DIGITS.test(String(j.outAmount)) || !DIGITS.test(String(j.otherAmountThreshold))) throw new ApiError(502, 'Jupiter returned no output amount');
  if (BigInt(j.otherAmountThreshold) > BigInt(j.outAmount)) throw new ApiError(502, 'Jupiter minimum is above its quote');
  if (j.swapMode && j.swapMode !== 'ExactIn') throw new ApiError(502, 'Unexpected swap mode');
  if (!j.swapInstruction) throw new ApiError(502, 'Jupiter returned no swap instruction');
  if (j.transactionVersion !== undefined && Number(j.transactionVersion) !== 0) throw new ApiError(502, 'Unexpected transaction version');
  const swapIx = fromApiInstruction(j.swapInstruction);
  if (!swapIx.accounts.some((a) => a.pubkey === feeAccount && a.isWritable)) throw new ApiError(502, 'Jupiter did not include the BAGZ fee account in the swap. Refusing to build a swap without the fee.');
  if (swapIx.accounts.some((a) => a.isSigner && a.pubkey !== inp.taker)) throw new ApiError(502, 'Swap needs an unexpected signer');
  const bh = j.blockhashWithMetadata;
  if (!bh || !Array.isArray(bh.blockhash) || bh.blockhash.length !== 32 || !Number.isFinite(bh.lastValidBlockHeight)) throw new ApiError(502, 'Jupiter returned no blockhash');

  const cuPrice = Math.min(priceFromIx(j.computeBudgetInstructions), cfg.maxCuPrice);
  const body = [
    ...(j.setupInstructions || []).map(fromApiInstruction),
    swapIx,
    ...(j.cleanupInstruction ? [fromApiInstruction(j.cleanupInstruction)] : []),
    ...(j.otherInstructions || []).map(fromApiInstruction),
  ];
  for (const ix of body) if (ix.accounts.some((a) => a.isSigner && a.pubkey !== inp.taker)) throw new ApiError(502, 'Swap needs an unexpected signer');
  await checkAuxInstructions(body.filter((ix) => ix !== swapIx), inp.taker);
  const lookupTables = await loadLookupTables(ctx, j.addressesByLookupTableAddress);
  const compile = (limit) => compileMessage({ payer: inp.taker, recentBlockhash: bh.blockhash, lookupTables, instructions: [setComputeUnitLimitIx(limit), ...(cuPrice > 0 ? [setComputeUnitPriceIx(cuPrice)] : []), ...body] });

  let limit = CU_MAX, sim = null;
  if (simulate) {
    const draft = compile(CU_MAX);
    const r = await rpc(ctx, 'simulateTransaction', [b64encode(unsignedTransaction(draft.bytes, 1)), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
    sim = r && r.value;
    if (!sim) throw new ApiError(502, 'Simulation returned nothing');
    if (sim.err) throw new ApiError(422, explainSimError(sim), { simulation: { err: sim.err, logs: (sim.logs || []).slice(-8) } });
    if (Number.isFinite(sim.unitsConsumed) && sim.unitsConsumed > 0) limit = Math.min(Math.ceil(sim.unitsConsumed * 1.2), CU_MAX);
  }
  const msg = compile(limit);
  const networkFeeLamports = 5000 + Math.ceil((cuPrice * limit) / 1_000_000);
  const routes = Array.isArray(j.routePlan) ? [...new Set(j.routePlan.map((s) => s && s.swapInfo && s.swapInfo.label).filter((x) => typeof x === 'string'))] : [];
  const impact = parseFloat(j.priceImpactPct);
  // fee estimate: in input units when the fee leg is the input, otherwise on the quoted output. The exact amount is read
  // from the chain after the swap confirms.
  const feeEstimateRaw = inp.side === 'BUY'
    ? (BigInt(inp.amount) * BigInt(cfg.feeBps) / 10000n).toString()
    : (BigInt(j.outAmount) * BigInt(cfg.feeBps) / BigInt(10000 - cfg.feeBps)).toString();
  return {
    msg, lastValidBlockHeight: bh.lastValidBlockHeight,
    quote: {
      side: inp.side, inputMint: inp.inputMint, outputMint: inp.outputMint, inAmount: inp.amount, outAmount: String(j.outAmount),
      minOut: String(j.otherAmountThreshold), slippageBps: Number(j.slippageBps ?? inp.slippageBps),
      priceImpactPct: Number.isFinite(impact) ? impact * 100 : null, routes,
      feeBps: cfg.feeBps, feeMint: inp.feeMint, feeAccount, feeEstimateRaw,
      networkFeeLamports, networkFeeIsMax: !simulate, computeUnitLimit: limit, computeUnitPrice: cuPrice,
      simulated: !!simulate,
    },
  };
}
function explainSimError(sim) {
  const logs = (sim.logs || []).join('\n');
  if (/insufficient (lamports|funds)/i.test(logs) || /InsufficientFunds/.test(JSON.stringify(sim.err))) return 'Insufficient balance for this swap (including network fees)';
  if (/slippage|0x1771/i.test(logs)) return 'Price moved beyond your slippage limit in simulation';
  if (/AccountNotFound/.test(JSON.stringify(sim.err))) return 'Your wallet has no SOL to pay network fees';
  return 'The swap failed in simulation, so it was not offered for signing';
}

async function swapPrepare(ctx, b) {
  const cfg = config(ctx.env);
  const inp = readSwapInput(b);
  const paused = cfg.liveSwaps && await isPaused(ctx, 'swaps');
  if (!cfg.liveSwaps || paused) {
    // preview only: exact Jupiter /build quote with the BAGZ fee, no transaction, nothing stored
    const built = await buildSwap(ctx, inp, cfg, { simulate: false });
    return { live: false, quote: built.quote, note: paused ? 'Live swaps are paused right now. This is a quote only; nothing can be signed.' : 'Live swaps are switched off. This is a quote only; nothing can be signed.' };
  }
  const d = needDb(ctx);
  const key = b.idempotencyKey;
  if (typeof key !== 'string' || !ID.test(key)) throw bad('idempotencyKey is required (16–64 letters, digits, _ or -)');
  const prior = await one(d, 'SELECT * FROM swaps WHERE idempotency_key = ?', key);
  if (prior) {
    if (prior.taker !== inp.taker || prior.input_mint !== inp.inputMint || prior.output_mint !== inp.outputMint || prior.in_amount !== inp.amount) throw new ApiError(409, 'idempotencyKey was already used for a different swap');
    if (prior.status !== 'prepared' || prior.expires_at <= ctx.now()) throw new ApiError(409, 'That quote was already used or has expired. Get a new quote.');
    return { live: true, swapId: prior.id, transaction: prior.tx_b64, expiresAt: prior.expires_at, quote: JSON.parse(prior.quote_json), replay: true };
  }
  const built = await buildSwap(ctx, inp, cfg, { simulate: true });
  const tx = b64encode(unsignedTransaction(built.msg.bytes, built.msg.header[0]));
  const id = newId(), t = ctx.now();
  await run(d, `INSERT INTO swaps (id, idempotency_key, taker, side, input_mint, output_mint, in_amount, quoted_out, min_out, slippage_bps, fee_bps, fee_mint, fee_account,
      message_hash, tx_b64, quote_json, last_valid_height, status, created_at, expires_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)`,
  id, key, inp.taker, inp.side, inp.inputMint, inp.outputMint, inp.amount, built.quote.outAmount, built.quote.minOut, built.quote.slippageBps, built.quote.feeBps,
  built.quote.feeMint, built.quote.feeAccount, await sha256hex(built.msg.bytes), tx, JSON.stringify(built.quote), built.lastValidBlockHeight, t, t + QUOTE_TTL_MS, t);
  return { live: true, swapId: id, transaction: tx, expiresAt: t + QUOTE_TTL_MS, quote: built.quote };
}

async function swapSubmit(ctx, b) {
  const cfg = config(ctx.env);
  if (!cfg.liveSwaps) throw new ApiError(403, 'Live swaps are switched off');
  if (await isPaused(ctx, 'swaps')) throw new ApiError(403, 'Live swaps are paused right now. Nothing was sent.');
  const d = needDb(ctx);
  if (typeof b.swapId !== 'string' || !ID.test(b.swapId)) throw bad('swapId is not valid');
  const row = await one(d, 'SELECT * FROM swaps WHERE id = ?', b.swapId);
  if (!row) throw new ApiError(404, 'Unknown swap');
  if (row.status !== 'prepared') throw new ApiError(409, 'This swap was already submitted', { status: row.status, signature: row.signature });
  if (row.expires_at <= ctx.now()) {
    await run(d, "UPDATE swaps SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'prepared'", ctx.now(), row.id);
    throw new ApiError(410, 'Quote expired before it was signed. Get a new quote.');
  }
  const bytes = signedTxBytes(b.signedTransaction);
  let parsed; try { parsed = parseTransaction(bytes); } catch { throw bad('signedTransaction could not be decoded'); }
  if (await sha256hex(parsed.message) !== row.message_hash) throw bad('The signed transaction is not the one BAGZ built (amounts, fee or accounts changed). Nothing was sent.');
  if (parsed.decoded.staticKeys[0] !== row.taker || parsed.signatures.length !== 1) throw bad('Transaction fee payer is not the connected wallet');
  if (!(await verifyEd25519(row.taker, parsed.message, parsed.signatures[0]))) throw bad('Wallet signature is missing or invalid');
  const signature = b58encode(parsed.signatures[0]);
  // claim the row: only one request can move it out of "prepared"
  const claim = await run(d, "UPDATE swaps SET status = 'submitting', signature = ?, updated_at = ? WHERE id = ? AND status = 'prepared'", signature, ctx.now(), row.id);
  if (changes(claim) !== 1) throw new ApiError(409, 'This swap was already submitted');
  try {
    await rpc(ctx, 'sendTransaction', [b64encode(bytes), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]);
  } catch (e) {
    if (e instanceof RpcError) {
      // the RPC refused it (preflight failed): it was not broadcast
      await run(d, "UPDATE swaps SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", `Rejected before sending: ${e.message}`, ctx.now(), row.id);
      throw new ApiError(422, `The network rejected the swap before sending: ${e.message.slice(0, 160)}`, { signature });
    }
    // timeout/network trouble: it may or may not have been broadcast; status polling decides
    await run(d, "UPDATE swaps SET status = 'sent', error = ?, updated_at = ? WHERE id = ?", 'Send result unknown', ctx.now(), row.id);
    return { signature, status: 'sent', note: 'The network did not answer in time. BAGZ is checking whether it landed.' };
  }
  await run(d, "UPDATE swaps SET status = 'sent', updated_at = ? WHERE id = ?", ctx.now(), row.id);
  return { signature, status: 'sent' };
}

const tokenDelta = (meta, accountIndex, mint) => {
  const f = (arr) => (arr || []).find((x) => x.accountIndex === accountIndex && (!mint || x.mint === mint));
  const pre = f(meta.preTokenBalances), post = f(meta.postTokenBalances);
  return BigInt(post ? post.uiTokenAmount.amount : '0') - BigInt(pre ? pre.uiTokenAmount.amount : '0');
};
const keysOf = (tx) => (tx.transaction.message.accountKeys || []).map((k) => (typeof k === 'string' ? k : k.pubkey));

async function swapStatus(ctx, id) {
  const d = needDb(ctx);
  if (!ID.test(id || '')) throw bad('id is not valid');
  const row = await one(d, 'SELECT * FROM swaps WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown swap');
  const out = (r) => ({ id: r.id, status: r.status, signature: r.signature || null, feeCollected: r.fee_collected || null, feeMint: r.fee_mint, error: r.status === 'failed' || r.status === 'expired' ? r.error : null, warning: r.status === 'confirmed' ? r.error || null : null });
  if (row.status !== 'sent' && row.status !== 'submitting') return out(row);
  const st = await rpc(ctx, 'getSignatureStatuses', [[row.signature], { searchTransactionHistory: true }]);
  const s = st && st.value && st.value[0];
  const set = async (status, extra = {}) => {
    await run(d, 'UPDATE swaps SET status = ?, fee_collected = ?, error = ?, updated_at = ? WHERE id = ?', status, extra.fee ?? null, extra.error ?? null, ctx.now(), row.id);
    return out({ ...row, status, fee_collected: extra.fee ?? null, error: extra.error ?? null });
  };
  if (s && s.err) return set('failed', { error: `Failed on-chain: ${JSON.stringify(s.err).slice(0, 200)}` });
  if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
    const tx = await rpc(ctx, 'getTransaction', [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    if (!tx || !tx.meta) return out(row); // indexed shortly; poll again
    if (tx.meta.err) return set('failed', { error: `Failed on-chain: ${JSON.stringify(tx.meta.err).slice(0, 200)}` });
    const idx = keysOf(tx).indexOf(row.fee_account);
    const fee = idx >= 0 ? tokenDelta(tx.meta, idx, row.fee_mint) : 0n;
    return set('confirmed', { fee: bigMax(fee, 0n).toString(), error: fee > 0n ? null : 'Confirmed, but no platform fee reached the fee account. Check the fee configuration.' });
  }
  if (!s) {
    const height = await rpc(ctx, 'getBlockHeight', [{ commitment: 'confirmed' }]);
    if (Number.isFinite(height) && height > row.last_valid_height) return set('expired', { error: 'Not included before the blockhash expired. No funds moved.' });
  }
  return out(row);
}

// ---- wallet balances ------------------------------------------------------------------------------------------------
async function balances(ctx, owner) {
  if (!isPubkey(owner)) throw bad('owner is not a valid address');
  const [sol, a, b] = await Promise.all([
    rpc(ctx, 'getBalance', [owner, { commitment: 'confirmed' }]),
    rpc(ctx, 'getTokenAccountsByOwner', [owner, { programId: PROGRAMS.token }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
    rpc(ctx, 'getTokenAccountsByOwner', [owner, { programId: PROGRAMS.token2022 }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
  ]);
  const by = new Map();
  for (const v of [...((a && a.value) || []), ...((b && b.value) || [])]) {
    const info = v.account && v.account.data && v.account.data.parsed && v.account.data.parsed.info;
    if (!info || !info.tokenAmount || !DIGITS.test(info.tokenAmount.amount)) continue;
    const cur = by.get(info.mint) || { mint: info.mint, amount: 0n, decimals: info.tokenAmount.decimals };
    cur.amount += BigInt(info.tokenAmount.amount);
    by.set(info.mint, cur);
  }
  const tokens = [...by.values()].filter((t) => t.amount > 0n).map((t) => ({ mint: t.mint, amount: t.amount.toString(), decimals: t.decimals }));
  return { owner, lamports: String((sol && sol.value) ?? 0), tokens, at: ctx.now() };
}

// ---- BOOST ----------------------------------------------------------------------------------------------------------
async function tokenInfo(ctx, mint) {
  const r = await rpc(ctx, 'getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const v = r && r.value;
  if (!v || (v.owner !== PROGRAMS.token && v.owner !== PROGRAMS.token2022) || !v.data || !v.data.parsed || v.data.parsed.type !== 'mint') throw bad('That address is not a Solana token mint');
  let meta = null;
  try {
    if (!ctx.env.JUPITER_API_KEY) throw new ApiError(0, 'no key');
    const j = await jupiter(ctx, '/tokens/v2/search', { query: mint });
    const list = Array.isArray(j) ? j : [];
    const t = list.find((x) => x && x.id === mint);
    if (t) meta = { symbol: String(t.symbol || '').slice(0, 20), name: String(t.name || '').slice(0, 60), icon: /^https:\/\//.test(t.icon || '') ? String(t.icon).slice(0, 300) : null };
  } catch (e) { if (e instanceof ApiError && e.status === 503 && ctx.env.JUPITER_API_KEY) throw e; }
  if (!meta) {
    const res = await upstream(ctx, 'ds', `https://api.dexscreener.com/tokens/v1/solana/${mint}`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      const arr = await res.json().catch(() => null);
      const p = Array.isArray(arr) ? arr.find((x) => x && x.baseToken && x.baseToken.address === mint) : null;
      if (p) meta = { symbol: String(p.baseToken.symbol || '').slice(0, 20), name: String(p.baseToken.name || '').slice(0, 60), icon: p.info && /^https:\/\//.test(p.info.imageUrl || '') ? String(p.info.imageUrl).slice(0, 300) : null };
    }
  }
  if (!meta || !meta.symbol) throw new ApiError(404, 'No market data found for this token yet (Jupiter and DexScreener both came back empty)');
  return { mint, decimals: v.data.parsed.info.decimals, supply: v.data.parsed.info.supply, ...meta };
}
const pkgOf = (p) => { if (!Object.prototype.hasOwnProperty.call(PACKAGES, p)) throw bad('Unknown package'); return { id: p, ...PACKAGES[p], priceRaw: String(PACKAGES[p].usdc * 10 ** USDC_DECIMALS), durationMs: PACKAGES[p].hours * 3600_000 }; };
const orderView = (r) => r && ({
  id: r.id, mint: r.mint, symbol: r.symbol, name: r.name, icon: r.icon, package: r.package, priceRaw: r.price_raw, priceUsdc: Number(r.price_raw) / 10 ** USDC_DECIMALS,
  durationMs: r.duration_ms, advertiser: r.advertiser, reference: r.reference, status: r.status, startsAt: r.starts_at, endsAt: r.ends_at, payBy: r.pay_by, createdAt: r.created_at, reviewNote: r.review_note || null,
});
function solanaPayUrl(cfg, order) {
  const p = new URLSearchParams({ amount: String(Number(order.price_raw) / 10 ** USDC_DECIMALS), 'spl-token': MINTS.usdc, reference: order.reference, label: 'BAGZ Boost', message: `BAGZ ${PACKAGES[order.package].label} for $${order.symbol}`, memo: `BAGZ-BOOST:${order.id}` });
  // Solana Pay recipients are wallet addresses; the wallet derives the USDC account itself
  return cfg.boostOwner ? `solana:${cfg.boostOwner}?${p}` : null;
}

async function boostPreview(ctx, b) {
  if (!isPubkey(b.mint)) throw bad('Enter a valid Solana token address');
  const pkg = pkgOf(b.package);
  if (await isBlocked(ctx, b.mint)) throw new ApiError(403, 'This token can’t be promoted on BAGZ');
  const token = await tokenInfo(ctx, b.mint);
  return { token, package: pkg, live: config(ctx.env).liveBoostPayments && !(await isPaused(ctx, 'boost')) };
}

async function boostCreate(ctx, b) {
  const cfg = config(ctx.env);
  if (!cfg.liveBoostPayments) throw new ApiError(403, 'BOOST payments are switched off');
  if (await isPaused(ctx, 'boost')) throw new ApiError(403, 'BOOST is paused right now. Try again later.');
  const d = needDb(ctx);
  if (!isPubkey(b.mint)) throw bad('Enter a valid Solana token address');
  if (await isBlocked(ctx, b.mint)) throw new ApiError(403, 'This token can’t be promoted on BAGZ');
  if (!isPubkey(b.advertiser)) throw bad('Connect the wallet that will pay');
  if (typeof b.idempotencyKey !== 'string' || !ID.test(b.idempotencyKey)) throw bad('idempotencyKey is required');
  const pkg = pkgOf(b.package);
  const prior = await one(d, 'SELECT * FROM promotions WHERE idempotency_key = ?', b.idempotencyKey);
  if (prior) {
    if (prior.mint !== b.mint || prior.package !== pkg.id || prior.advertiser !== b.advertiser) throw new ApiError(409, 'idempotencyKey was already used for a different order');
    return { order: orderView(prior), solanaPay: solanaPayUrl(cfg, prior) };
  }
  if (!isTestCopy(ctx.env)) await checkTokenAccount(ctx, cfg.boostAccount, MINTS.usdc, cfg.boostOwner || null, 'The BOOST USDC receiving account');
  const token = await tokenInfo(ctx, b.mint);
  const t = ctx.now(), id = newId(), reference = b58encode(randomBytes(32));
  await run(d, `INSERT INTO promotions (id, idempotency_key, mint, symbol, name, icon, package, price_raw, duration_ms, advertiser, reference, status, created_at, pay_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'awaiting_payment',?,?,?)`, id, b.idempotencyKey, b.mint, token.symbol, token.name, token.icon, pkg.id, pkg.priceRaw, pkg.durationMs, b.advertiser, reference, t, t + ORDER_PAY_WINDOW_MS, t);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  return { order: orderView(row), solanaPay: solanaPayUrl(cfg, row) };
}

async function boostPaymentTx(ctx, id, b) {
  const cfg = config(ctx.env);
  if (!cfg.liveBoostPayments) throw new ApiError(403, 'BOOST payments are switched off');
  if (await isPaused(ctx, 'boost')) throw new ApiError(403, 'BOOST is paused right now. Nothing was charged.');
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  if (row.status !== 'awaiting_payment') throw new ApiError(409, 'This order is already paid or closed');
  if (b.payer !== row.advertiser) throw bad('Pay with the wallet that created the order');
  await checkTokenAccount(ctx, cfg.boostAccount, MINTS.usdc, cfg.boostOwner || null, 'The BOOST USDC receiving account');
  const accts = await rpc(ctx, 'getTokenAccountsByOwner', [row.advertiser, { mint: MINTS.usdc }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const price = BigInt(row.price_raw);
  const src = ((accts && accts.value) || []).map((v) => ({ pubkey: v.pubkey, info: v.account.data.parsed.info, program: v.account.owner }))
    .filter((x) => x.info && x.info.state === 'initialized' && BigInt(x.info.tokenAmount.amount) >= price)
    .sort((x, y) => (BigInt(y.info.tokenAmount.amount) > BigInt(x.info.tokenAmount.amount) ? 1 : -1))[0];
  if (!src) throw new ApiError(422, `This wallet does not hold ${Number(price) / 1e6} USDC`);
  const bh = await rpc(ctx, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  if (!bh || !bh.value || !isPubkey(bh.value.blockhash)) throw new ApiError(502, 'Could not get a recent blockhash');
  const msg = compileMessage({
    payer: row.advertiser, recentBlockhash: bh.value.blockhash,
    instructions: [
      transferCheckedIx({ source: src.pubkey, mint: MINTS.usdc, destination: cfg.boostAccount, owner: row.advertiser, amount: price, decimals: USDC_DECIMALS, tokenProgram: src.program === PROGRAMS.token2022 ? PROGRAMS.token2022 : PROGRAMS.token, references: [row.reference] }),
      memoIx(`BAGZ-BOOST:${row.id}`),
    ],
  });
  await run(d, 'UPDATE promotions SET message_hash = ?, updated_at = ? WHERE id = ? AND status = ?', await sha256hex(msg.bytes), ctx.now(), row.id, 'awaiting_payment');
  return { transaction: b64encode(unsignedTransaction(msg.bytes, 1)), lastValidBlockHeight: bh.value.lastValidBlockHeight };
}

async function boostSubmit(ctx, id, b) {
  const cfg = config(ctx.env);
  if (!cfg.liveBoostPayments) throw new ApiError(403, 'BOOST payments are switched off');
  if (await isPaused(ctx, 'boost')) throw new ApiError(403, 'BOOST is paused right now. Nothing was sent.');
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  if (row.status !== 'awaiting_payment' || !row.message_hash) throw new ApiError(409, 'This order has no open payment');
  const bytes = signedTxBytes(b.signedTransaction);
  let parsed; try { parsed = parseTransaction(bytes); } catch { throw bad('signedTransaction could not be decoded'); }
  if (await sha256hex(parsed.message) !== row.message_hash) throw bad('The signed payment is not the one BAGZ built. Nothing was sent.');
  if (!(await verifyEd25519(row.advertiser, parsed.message, parsed.signatures[0]))) throw bad('Wallet signature is missing or invalid');
  const signature = b58encode(parsed.signatures[0]);
  try { await rpc(ctx, 'sendTransaction', [b64encode(bytes), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]); }
  catch (e) { if (e instanceof RpcError) throw new ApiError(422, `The network rejected the payment before sending: ${e.message.slice(0, 160)}`); return { signature, status: 'sent', note: 'Send result unknown; verifying will tell.' }; }
  return { signature, status: 'sent' };
}

/** Checks a transaction against an order. Returns {ok:true, …} or {ok:false, reason, final}. */
export async function checkPayment(ctx, row, signature, cfg) {
  const tx = await rpc(ctx, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
  if (!tx || !tx.meta) return { ok: false, reason: 'Payment not confirmed yet', final: false };
  if (tx.meta.err) return { ok: false, reason: 'That payment transaction failed on-chain', final: true };
  const keys = keysOf(tx);
  if (!keys.includes(row.reference)) return { ok: false, reason: 'That transaction does not carry this order’s reference', final: true };
  if (tx.blockTime && tx.blockTime * 1000 < row.created_at - 120_000) return { ok: false, reason: 'That payment was made before this order existed', final: true };
  const ixs = [...(tx.transaction.message.instructions || []), ...((tx.meta.innerInstructions || []).flatMap((x) => x.instructions || []))];
  const mintOf = (acct) => { const i = keys.indexOf(acct); const tb = [...(tx.meta.postTokenBalances || []), ...(tx.meta.preTokenBalances || [])].find((x) => x.accountIndex === i); return tb ? tb.mint : null; };
  let paid = 0n, wrongMint = false, wrongDest = false, payer = null;
  for (const ix of ixs) {
    if (!ix.parsed || (ix.program !== 'spl-token' && ix.program !== 'spl-token-2022')) continue;
    const { type, info } = ix.parsed;
    if (type !== 'transfer' && type !== 'transferChecked') continue;
    const mint = type === 'transferChecked' ? info.mint : mintOf(info.destination);
    const amt = type === 'transferChecked' ? info.tokenAmount && info.tokenAmount.amount : info.amount;
    if (!DIGITS.test(String(amt))) continue;
    if (mint !== MINTS.usdc) { wrongMint = true; continue; }
    if (info.destination !== cfg.boostAccount) { wrongDest = true; continue; }
    paid += BigInt(amt); payer = info.authority || info.multisigAuthority || payer;
  }
  if (paid === 0n) return { ok: false, reason: wrongMint ? 'Payment was not in USDC' : wrongDest ? 'Payment went to the wrong address' : 'No USDC transfer found in that transaction', final: true };
  if (paid < BigInt(row.price_raw)) return { ok: false, reason: `Payment was ${Number(paid) / 1e6} USDC; this package costs ${Number(row.price_raw) / 1e6} USDC`, final: true };
  return { ok: true, paid: paid.toString(), payer: payer || keys[0], slot: tx.slot ?? null, blockTime: tx.blockTime ?? null };
}

async function boostVerify(ctx, id, b) {
  const cfg = config(ctx.env);
  if (!cfg.liveBoostPayments) throw new ApiError(403, 'BOOST payments are switched off');
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  if (row.status !== 'awaiting_payment') return { order: orderView(row), verified: row.status !== 'cancelled' && row.status !== 'expired_unpaid' };
  let candidates;
  if (b && b.signature !== undefined) {
    if (typeof b.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.signature)) throw bad('signature is not valid');
    candidates = [b.signature];
  } else {
    // Solana Pay: find payments that carry this order's reference key
    const sigs = await rpc(ctx, 'getSignaturesForAddress', [row.reference, { limit: 10, commitment: 'confirmed' }]);
    candidates = ((sigs || []).filter((s) => !s.err).map((s) => s.signature));
    if (!candidates.length) return { order: orderView(row), verified: false, reason: 'No payment found for this order yet' };
  }
  let last = null;
  for (const sig of candidates) {
    const used = await one(d, 'SELECT promotion_id FROM payments WHERE signature = ?', sig);
    if (used) { last = { ok: false, reason: 'That transaction was already used for an order', final: true }; continue; }
    const r = await checkPayment(ctx, row, sig, cfg);
    if (!r.ok) { last = r; continue; }
    const t = ctx.now();
    try {
      const res = await d.batch([
        d.prepare('INSERT INTO payments (signature, promotion_id, payer, mint, amount_raw, destination, slot, block_time, verified_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(sig, row.id, r.payer, MINTS.usdc, r.paid, cfg.boostAccount, r.slot, r.blockTime, t),
        d.prepare("UPDATE promotions SET status = 'pending_review', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'").bind(t, row.id),
      ]);
      if (changes(res[1]) !== 1) throw new Error('status changed');
    } catch {
      const now = await one(d, 'SELECT * FROM promotions WHERE id = ?', row.id);
      if (now && now.status !== 'awaiting_payment') return { order: orderView(now), verified: true };
      throw new ApiError(409, 'That transaction was already used for an order');
    }
    return { order: orderView(await one(d, 'SELECT * FROM promotions WHERE id = ?', row.id)), verified: true, signature: sig };
  }
  if (last && last.reason === 'That transaction was already used for an order') throw new ApiError(409, last.reason);
  if (last && last.final) throw new ApiError(422, last.reason);
  return { order: orderView(row), verified: false, reason: (last && last.reason) || 'Payment not confirmed yet' };
}

/** TEST COPY ONLY: marks an order paid with a fake, clearly labelled payment so the review flow can be tried. */
async function boostTestPay(ctx, id) {
  if (!isTestCopy(ctx.env)) throw new ApiError(404, 'Unknown route');
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  if (row.status !== 'awaiting_payment') return { order: orderView(row), verified: true };
  const t = ctx.now();
  await d.batch([
    d.prepare('INSERT INTO payments (signature, promotion_id, payer, mint, amount_raw, destination, slot, block_time, verified_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(`TEST-PAYMENT-${row.id}`, row.id, row.advertiser, MINTS.usdc, row.price_raw, 'test-copy', null, null, t),
    d.prepare("UPDATE promotions SET status = 'pending_review', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'").bind(t, row.id),
  ]);
  return { order: orderView(await one(d, 'SELECT * FROM promotions WHERE id = ?', row.id)), verified: true, test: true };
}

async function boostActive(ctx) {
  const d = database(ctx.env);
  if (!d) return { campaigns: [] };
  const t = ctx.now();
  const blocked = await blockedSet(ctx);
  const rows = (await all(d, "SELECT * FROM promotions WHERE status = 'approved' AND starts_at <= ? AND ends_at > ? LIMIT 50", t, t)).filter((r) => !blocked.has(r.mint));
  rows.sort((a, b) => PACKAGES[b.package].rank - PACKAGES[a.package].rank || a.starts_at - b.starts_at);
  return { campaigns: rows.slice(0, 12).map((r) => ({ id: r.id, mint: r.mint, symbol: r.symbol, name: r.name, icon: r.icon, package: r.package, endsAt: r.ends_at })), at: t };
}

async function boostEvent(ctx, b, request) {
  const d = needDb(ctx);
  if (typeof b.id !== 'string' || !ID.test(b.id)) throw bad('id is not valid');
  if (b.type !== 'impression' && b.type !== 'click') throw bad('type must be impression or click');
  const t = ctx.now();
  const row = await one(d, "SELECT id FROM promotions WHERE id = ? AND status = 'approved' AND starts_at <= ? AND ends_at > ?", b.id, t, t);
  if (!row) return { counted: false };
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  const viewer = (await sha256hex(new TextEncoder().encode(`${ip}|${request.headers.get('user-agent') || ''}|${ctx.env.ANALYTICS_SALT || 'bagz'}`))).slice(0, 24);
  const key = `${b.id}|${b.type}|${viewer}|${Math.floor(t / EVENT_WINDOW_MS)}`;
  const ins = await run(d, 'INSERT OR IGNORE INTO campaign_event_seen (key, created_at) VALUES (?, ?)', key, t);
  if (changes(ins) !== 1) return { counted: false };
  const day = nowIso(t).slice(0, 10);
  await run(d, `INSERT INTO campaign_stats (promotion_id, day, impressions, clicks) VALUES (?, ?, ?, ?)
      ON CONFLICT (promotion_id, day) DO UPDATE SET impressions = impressions + excluded.impressions, clicks = clicks + excluded.clicks`, b.id, day, b.type === 'impression' ? 1 : 0, b.type === 'click' ? 1 : 0);
  if (Math.random() < 0.02) await run(d, 'DELETE FROM campaign_event_seen WHERE created_at < ?', t - 2 * EVENT_WINDOW_MS);
  return { counted: true };
}

async function boostOrder(ctx, id) {
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  return { order: orderView(row), solanaPay: row.status === 'awaiting_payment' ? solanaPayUrl(config(ctx.env), row) : null };
}

// ---- admin ------------------------------------------------------------------------------------------------------------
const enc = new TextEncoder();
const b64url = (bytes) => b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data))));
}
const challengeText = (wallet, nonce, exp) => `BAGZ admin sign-in\n\nWallet: ${wallet}\nNonce: ${nonce}\nExpires: ${nowIso(exp)}\n\nSigning this message does not move funds.`;
function adminSecret(env) { if (!env.ADMIN_SESSION_SECRET || env.ADMIN_SESSION_SECRET.length < 32) throw new ApiError(503, 'ADMIN_SESSION_SECRET is not configured (32+ characters)'); return env.ADMIN_SESSION_SECRET; }

async function adminChallenge(ctx, b) {
  const cfg = config(ctx.env); adminSecret(ctx.env);
  if (!isPubkey(b.wallet) || !cfg.admins.includes(b.wallet)) throw new ApiError(403, 'This wallet is not a BAGZ admin');
  const d = needDb(ctx);
  const nonce = b58encode(randomBytes(16)), exp = ctx.now() + 5 * 60_000;
  await run(d, 'INSERT INTO admin_challenges (nonce, wallet, expires_at) VALUES (?, ?, ?)', nonce, b.wallet, exp);
  return { nonce, message: challengeText(b.wallet, nonce, exp) };
}
async function adminSession(ctx, b) {
  const cfg = config(ctx.env); const secret = adminSecret(ctx.env);
  const d = needDb(ctx);
  if (!isPubkey(b.wallet) || !cfg.admins.includes(b.wallet)) throw new ApiError(403, 'This wallet is not a BAGZ admin');
  if (typeof b.nonce !== 'string' || typeof b.signature !== 'string') throw bad('nonce and signature are required');
  const c = await one(d, 'SELECT * FROM admin_challenges WHERE nonce = ?', b.nonce);
  if (!c || c.wallet !== b.wallet || c.used || c.expires_at <= ctx.now()) throw new ApiError(401, 'Sign-in challenge is invalid or expired');
  let sig; try { sig = b64decode(b.signature); } catch { throw bad('signature must be base64'); }
  if (sig.length !== 64 || !(await verifyEd25519(b.wallet, enc.encode(challengeText(b.wallet, b.nonce, c.expires_at)), sig))) throw new ApiError(401, 'Signature does not match');
  const use = await run(d, 'UPDATE admin_challenges SET used = 1 WHERE nonce = ? AND used = 0', b.nonce);
  if (changes(use) !== 1) throw new ApiError(401, 'Sign-in challenge was already used');
  const exp = ctx.now() + ADMIN_SESSION_MS;
  try { await auditAt(ctx, d, b.wallet, 'signin', null); } catch { /* audit table not created yet: sign-in still works */ }
  const payload = b64url(enc.encode(JSON.stringify({ w: b.wallet, exp })));
  return { token: `${payload}.${await hmac(secret, payload)}`, wallet: b.wallet, expiresAt: exp };
}
export async function requireAdmin(ctx, request) {
  if (isTestCopy(ctx.env)) { const u = await currentUser(ctx, request); return `@${u.username}`; }
  const secret = adminSecret(ctx.env);
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(request.headers.get('authorization') || '');
  if (!m) throw new ApiError(401, 'Admin sign-in required');
  const expect = await hmac(secret, m[1]);
  let diff = expect.length ^ m[2].length;
  for (let i = 0; i < Math.max(expect.length, m[2].length); i++) diff |= (expect.charCodeAt(i) || 0) ^ (m[2].charCodeAt(i) || 0);
  if (diff) throw new ApiError(401, 'Admin session is invalid');
  let p; try { p = JSON.parse(atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { throw new ApiError(401, 'Admin session is invalid'); }
  if (!p || p.exp <= ctx.now() || !config(ctx.env).admins.includes(p.w)) throw new ApiError(401, 'Admin session expired');
  return p.w;
}
async function adminList(ctx, status) {
  const d = needDb(ctx);
  const ok = ['awaiting_payment', 'pending_review', 'approved', 'running', 'rejected', 'cancelled', 'all'];
  const s = ok.includes(status) ? status : 'pending_review';
  const t = ctx.now();
  const rows = s === 'all' ? await all(d, 'SELECT * FROM promotions ORDER BY created_at DESC LIMIT 200')
    : s === 'running' ? await all(d, "SELECT * FROM promotions WHERE status = 'approved' AND starts_at <= ? AND ends_at > ? ORDER BY ends_at ASC LIMIT 200", t, t)
      : await all(d, 'SELECT * FROM promotions WHERE status = ? ORDER BY created_at DESC LIMIT 200', s);
  const blocked = await blockedSet(ctx);
  const out = [];
  for (const r of rows) {
    const pay = await one(d, 'SELECT signature, payer, amount_raw, block_time FROM payments WHERE promotion_id = ?', r.id);
    const st = await one(d, 'SELECT COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks FROM campaign_stats WHERE promotion_id = ?', r.id);
    out.push({ ...orderView(r), payment: pay || null, stats: { impressions: Number(st.impressions), clicks: Number(st.clicks) }, reviewedBy: r.reviewed_by || null,
      blocked: blocked.has(r.mint), running: r.status === 'approved' && r.starts_at <= t && r.ends_at > t, refundOwed: r.status === 'rejected' && !!pay && !String(pay.signature).startsWith('TEST-PAYMENT-') });
  }
  return { promotions: out, counts: await boostCounts(ctx, d) };
}
async function adminDecide(ctx, admin, id, action, b) {
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  if (row.status !== 'pending_review') throw new ApiError(409, `Only paid orders waiting for review can be ${action}d (this one is ${row.status})`);
  const t = ctx.now();
  if (action === 'approve') {
    if (await isBlocked(ctx, row.mint)) throw new ApiError(409, 'This token is on the blocklist. Reject the order instead (and refund it), or unblock the token first.');
    const want = Number(b.startsAt || 0);
    if (want && (!Number.isFinite(want) || want > t + 30 * 86400_000)) throw bad('startsAt must be within 30 days');
    const start = Math.max(t, want || 0);
    const r = await run(d, "UPDATE promotions SET status = 'approved', starts_at = ?, ends_at = ?, reviewed_by = ?, review_note = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'", start, start + row.duration_ms, admin, String(b.note || '').slice(0, 300) || null, t, id);
    if (changes(r) !== 1) throw new ApiError(409, 'Order changed while reviewing');
  } else {
    const r = await run(d, "UPDATE promotions SET status = 'rejected', reviewed_by = ?, review_note = ?, updated_at = ? WHERE id = ? AND status = 'pending_review'", admin, String(b.note || 'Rejected').slice(0, 300), t, id);
    if (changes(r) !== 1) throw new ApiError(409, 'Order changed while reviewing');
  }
  try { await auditAt(ctx, d, admin, `boost.${action}`, id, { symbol: row.symbol, package: row.package, note: String(b.note || '').slice(0, 300) || undefined }); } catch { /* audit table not created yet */ }
  return { order: orderView(await one(d, 'SELECT * FROM promotions WHERE id = ?', id)) };
}
/** stop an approved campaign now (it stops showing at once). The advertiser sees the note. Refunds are done by hand. */
async function adminEnd(ctx, admin, id, b) {
  const d = needDb(ctx);
  const row = await one(d, 'SELECT * FROM promotions WHERE id = ?', id);
  if (!row) throw new ApiError(404, 'Unknown order');
  if (row.status !== 'approved') throw new ApiError(409, `Only approved campaigns can be ended (this one is ${row.status.replace(/_/g, ' ')})`);
  const why = String(b.note || '').trim().slice(0, 300);
  if (!why) throw bad('Add a short reason for ending it; the advertiser sees it');
  const t = ctx.now();
  const r = await run(d, "UPDATE promotions SET status = 'cancelled', ends_at = MIN(COALESCE(ends_at, ?), ?), review_note = ?, reviewed_by = ?, updated_at = ? WHERE id = ? AND status = 'approved'", t, t, `Ended early: ${why}`, admin, t, id);
  if (changes(r) !== 1) throw new ApiError(409, 'Order changed while ending it');
  try { await auditAt(ctx, d, admin, 'boost.end', id, { symbol: row.symbol, package: row.package, note: why }); } catch { /* audit table not created yet */ }
  return { order: orderView(await one(d, 'SELECT * FROM promotions WHERE id = ?', id)) };
}

// ---- router -------------------------------------------------------------------------------------------------------------
export function publicConfig(env) {
  const c = config(env);
  return {
    liveSwaps: c.liveSwaps, liveBoostPayments: c.liveBoostPayments, feeBps: c.feeBps, testCopy: isTestCopy(env),
    feeAccounts: { wsol: isPubkey(c.feeAccounts[MINTS.wsol]), usdc: isPubkey(c.feeAccounts[MINTS.usdc]) },
    boostConfigured: isPubkey(c.boostAccount), adminConfigured: c.admins.length > 0, database: !!database(env),
    accounts: !!database(env),
    jupiterKey: !!env.JUPITER_API_KEY, rpc: env.SOLANA_RPC_URL ? 'custom' : env.HELIUS_API_KEY ? 'helius' : 'public',
    packages: Object.entries(PACKAGES).map(([id, p]) => ({ id, label: p.label, usdc: p.usdc, hours: p.hours })),
  };
}

export async function api(request, env, deps) {
  const ctx = { env, fetch: deps.fetch, now: deps.now, guard: deps.guard };
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/v1/, '');
  const method = request.method;
  let body = {};
  if (method === 'POST') {
    const text = await request.text();
    if (text.length > (path === '/me/avatar' ? 220_000 : path === '/me/wallet' ? 1_050_000 : 8000)) throw new ApiError(413, 'Body too large');
    if (text) { try { body = JSON.parse(text); } catch { throw bad('Invalid JSON'); } }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be a JSON object');
  }
  const route = (m, re) => method === m && re.exec(path);
  let p;
  const s = await social(ctx, request, path, body, url);
  if (s !== undefined) return s;
  const v = await vault(ctx, request, path, body);
  if (v !== undefined) return v;
  if (route('GET', /^\/config$/)) {
    // the app hides live swaps / BOOST checkout while an admin has them paused
    const c = publicConfig(env);
    const [ps, pb, pu, pv] = await Promise.all([isPaused(ctx, 'swaps'), isPaused(ctx, 'boost'), isPaused(ctx, 'signups'), isPaused(ctx, 'vault')]);
    return { ...c, liveSwaps: c.liveSwaps && !ps, liveBoostPayments: c.liveBoostPayments && !pb, paused: { swaps: ps, boost: pb, signups: pu, vault: pv } };
  }
  if (route('GET', /^\/blocklist$/)) return publicBlocklist(ctx);
  if (route('GET', /^\/wallet\/balances$/)) return balances(ctx, url.searchParams.get('owner'));
  if (route('POST', /^\/swap\/prepare$/)) return swapPrepare(ctx, body);
  if (route('POST', /^\/swap\/submit$/)) return swapSubmit(ctx, body);
  if (route('GET', /^\/swap\/status$/)) return swapStatus(ctx, url.searchParams.get('id'));
  if (route('POST', /^\/boost\/preview$/)) return boostPreview(ctx, body);
  if (route('POST', /^\/boost\/orders$/)) return boostCreate(ctx, body);
  if ((p = route('GET', /^\/boost\/orders\/([A-Za-z0-9_-]{16,64})$/))) return boostOrder(ctx, p[1]);
  if ((p = route('POST', /^\/boost\/orders\/([A-Za-z0-9_-]{16,64})\/transaction$/))) return boostPaymentTx(ctx, p[1], body);
  if ((p = route('POST', /^\/boost\/orders\/([A-Za-z0-9_-]{16,64})\/submit$/))) return boostSubmit(ctx, p[1], body);
  if ((p = route('POST', /^\/boost\/orders\/([A-Za-z0-9_-]{16,64})\/verify$/))) return boostVerify(ctx, p[1], body);
  if ((p = route('POST', /^\/boost\/orders\/([A-Za-z0-9_-]{16,64})\/test-pay$/))) return boostTestPay(ctx, p[1]);
  if (route('GET', /^\/boost\/active$/)) return boostActive(ctx);
  if (route('POST', /^\/boost\/events$/)) return boostEvent(ctx, body, request);
  if (route('POST', /^\/admin\/challenge$/)) return adminChallenge(ctx, body);
  if (route('POST', /^\/admin\/session$/)) return adminSession(ctx, body);
  if (route('GET', /^\/admin\/promotions$/)) { await requireAdmin(ctx, request); return adminList(ctx, url.searchParams.get('status') || 'pending_review'); }
  if (route('GET', /^\/admin\/overview$/)) { await requireAdmin(ctx, request); return adminOverview(ctx, needDb(ctx), url.searchParams.get('days')); }
  if (route('GET', /^\/admin\/users$/)) { await requireAdmin(ctx, request); return adminUsers(ctx, needDb(ctx), url); }
  if (route('GET', /^\/admin\/log$/)) { await requireAdmin(ctx, request); return adminLog(ctx, needDb(ctx), url); }
  if ((p = route('POST', /^\/admin\/promotions\/([A-Za-z0-9_-]{16,64})\/(approve|reject)$/))) { const who = await requireAdmin(ctx, request); return adminDecide(ctx, who, p[1], p[2], body); }
  if ((p = route('POST', /^\/admin\/promotions\/([A-Za-z0-9_-]{16,64})\/end$/))) { const who = await requireAdmin(ctx, request); return adminEnd(ctx, who, p[1], body); }
  if (route('GET', /^\/admin\/switches$/)) { await requireAdmin(ctx, request); return getSwitches(ctx); }
  if (route('POST', /^\/admin\/switches$/)) { const who = await requireAdmin(ctx, request); return setSwitch(ctx, who, body); }
  if (route('GET', /^\/admin\/revenue$/)) { await requireAdmin(ctx, request); return revenue(ctx, url.searchParams.get('days')); }
  if (route('GET', /^\/admin\/revenue\/wallets$/)) { await requireAdmin(ctx, request); return walletBalances(ctx); }
  if (route('GET', /^\/admin\/fee-setup$/)) { await requireAdmin(ctx, request); return feeSetupStatus(ctx); }
  if (route('POST', /^\/admin\/fee-setup\/build$/)) { const who = await requireAdmin(ctx, request); return feeSetupBuild(ctx, who); }
  if (route('POST', /^\/admin\/fee-setup\/submit$/)) { const who = await requireAdmin(ctx, request); return feeSetupSubmit(ctx, who, body); }
  if (route('GET', /^\/admin\/blocklist$/)) { await requireAdmin(ctx, request); return listBlocklist(ctx); }
  if (route('POST', /^\/admin\/blocklist$/)) { const who = await requireAdmin(ctx, request); return blockToken(ctx, who, body); }
  if (route('POST', /^\/admin\/blocklist\/remove$/)) { const who = await requireAdmin(ctx, request); return unblockToken(ctx, who, body); }
  if (route('GET', /^\/admin\/user-stats$/)) { await requireAdmin(ctx, request); return userStats(ctx); }
  if (route('GET', /^\/admin\/vault$/)) { await requireAdmin(ctx, request); return vaultAdmin(ctx, CHALLENGES); }
  if (route('POST', /^\/admin\/vault\/card$/)) { const who = await requireAdmin(ctx, request); return setCard(ctx, who, body); }
  if (route('POST', /^\/admin\/vault\/coins$/)) { const who = await requireAdmin(ctx, request); return adjustCoins(ctx, who, body); }
  if (route('POST', /^\/admin\/vault\/rewards$/)) { const who = await requireAdmin(ctx, request); return setRewards(ctx, who, body, CHALLENGES); }
  if (route('GET', /^\/admin\/audit$/)) { await requireAdmin(ctx, request); return auditLog(ctx, url); }
  throw new ApiError(404, 'Unknown route');
}
