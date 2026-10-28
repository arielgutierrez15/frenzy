/**
 * BAGZ Investigate (/v1/investigate/…) — read-only Solana token research for the token page.
 *
 *   GET /v1/investigate/health                                  what the server is configured with (no RPC call)
 *   GET /v1/investigate/holders?mint=<mint>                     bounded holder snapshot, owners grouped with exact integers
 *   GET /v1/investigate/activity?mint=<mint>&account=<acct>[&before=<signature>]
 *                                                               recent token transfers of ONE token account, on demand
 *
 * Rules this module keeps (they are what the UI promises):
 *  - Read-only. It never builds, signs or sends a transaction, and never needs a wallet.
 *  - Secrets stay here: the RPC comes from rpcUrl(env) (SOLANA_RPC_URL first, then HELIUS_API_KEY), and no URL or key is
 *    ever echoed. Without either of them it answers 503 provider_not_configured instead of using the public RPC.
 *  - Exact arithmetic: token amounts are integer strings from the chain and are only added/divided as BigInt.
 *  - Bounded: at most 20 token accounts per holder snapshot (the provider's limit) and 10 signatures per activity page.
 *    Holder history is never scanned in bulk; the app asks for one token account when the user selects a holder.
 *  - Nothing is inferred: no common ownership, insiders, developers or scams. A transfer is reported only when a
 *    successful transaction contains a decoded SPL Token transfer instruction, with its instruction path.
 *  - Errors are explicit codes; no demo or fixture data is ever substituted. The test copy refuses (demo_unavailable).
 *  - Caching is per Worker instance (best effort): fresh for 60 s, and an answer up to 15 min old is served flagged
 *    `stale` when the provider fails. Identical requests in flight are shared.
 *
 * RPC methods used (Solana JSON-RPC, as documented by solana.com and Helius, checked 27 Oct 2026):
 *   getTokenLargestAccounts (≤ 20 accounts, finalized) · getMultipleAccounts (jsonParsed, minContextSlot)
 *   getAccountInfo (jsonParsed) · getSignaturesForAddress (limit, before) · getTransaction (jsonParsed, v0)
 */
import { ApiError, customRpcUrl, heliusRpcUrl, rpcUrl, isTestCopy } from './api.js';
import { b58decode, isPubkey, PROGRAMS, MINTS } from './solana.js';

export const INVESTIGATE_VERSION = 1;
const DIGITS = /^\d{1,40}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export const HOLDER_ACCOUNTS_MAX = 20;
export const ACTIVITY_LIMIT = 10;
const FRESH_MS = 60_000;
const STALE_MAX_MS = 15 * 60_000;
const TX_CONCURRENCY = 3;
const RPC_TIMEOUT_MS = 10_000;
const CACHE_MAX = 300;

// ---- well-known programs: labels describe PROGRAMS (code), never the people or wallets that use them ------------------
export const KNOWN_PROGRAMS = {
  [PROGRAMS.system]: 'System Program',
  [PROGRAMS.token]: 'SPL Token',
  [PROGRAMS.token2022]: 'SPL Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token Account program',
  [PROGRAMS.computeBudget]: 'Compute Budget',
  [PROGRAMS.memo]: 'Memo',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter Aggregator v6',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'Raydium CPMM',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpools',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun bonding curve program',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap AMM',
};
export const programLabel = (id) => (typeof id === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_PROGRAMS, id) ? KNOWN_PROGRAMS[id] : null);
const TOKEN_PROGRAMS = new Set([PROGRAMS.token, PROGRAMS.token2022]);

// Token-2022 mint extensions that change what a raw balance means for display (the raw integer is still exact)
const BALANCE_GAPS = {
  interestBearingConfig: 'Interest-bearing token: wallets may show a different (accrued) amount than the raw balance shown here.',
  scaledUiAmountConfig: 'Scaled UI amount: wallets multiply the raw balance; BAGZ shows raw-based amounts.',
  confidentialTransferMint: 'Confidential transfers: part of a balance can be encrypted and is not visible here.',
  confidentialTransferFeeConfig: 'Confidential transfer fees are not decoded.',
  confidentialMintBurn: 'Confidential mint/burn is not decoded.',
};

// ---- ed25519: is an address on the curve? (off-curve = program-derived address, no private key exists) -------------
// Same rule Solana uses for PDAs (curve25519-dalek CompressedEdwardsY::decompress): y is read little-endian with the top
// bit as the sign of x and reduced mod p; the point is on the curve when (y² − 1) / (d·y² + 1) has a square root.
const P = (1n << 255n) - 19n;
const md = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
const powmod = (b, e) => { let r = 1n; b = md(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
const ED_D = md(-121665n * powmod(121666n, P - 2n));
export function isOnCurve(address) {
  let bytes;
  try { bytes = typeof address === 'string' ? b58decode(address) : address; } catch { return false; }
  if (!bytes || bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = md(y);
  const y2 = (y * y) % P;
  const u = md(y2 - 1n);
  const v = md(ED_D * y2 + 1n);
  const v3 = (((v * v) % P) * v) % P;
  const v7 = (((v3 * v3) % P) * v) % P;
  const x = (((u * v3) % P) * powmod((u * v7) % P, (P - 5n) / 8n)) % P;
  const vx2 = (((v * x) % P) * x) % P;
  return vx2 === u || vx2 === md(-u);
}

// ---- exact percentages ------------------------------------------------------------------------------------------------
/** share of `total` as a percent string truncated (not rounded) to 4 decimals, using integers only; null when total ≤ 0 */
export function percentOf(amount, total) {
  const a = BigInt(amount), t = BigInt(total);
  if (t <= 0n) return null;
  const q = (a * 1_000_000n) / t; // percent × 10^4
  return `${q / 10_000n}.${(q % 10_000n).toString().padStart(4, '0')}`;
}

// ---- aggregation (exported for tests) ---------------------------------------------------------------------------------
/**
 * Groups the selected token accounts by owner. `selected` is getTokenLargestAccounts' value (ranking order), `accounts`
 * the jsonParsed getMultipleAccounts values for the same addresses (same order), read at one slot together with the mint.
 * Accounts that are closed, not token accounts, for another mint, or unreadable are excluded and listed with a reason.
 */
export function aggregateHolders(selected, accounts, mint, supplyRaw) {
  const owners = new Map();
  const excluded = [];
  let changed = 0;
  selected.forEach((a, i) => {
    const address = a && a.address;
    const v = accounts[i];
    if (!v) { excluded.push({ address, reason: 'closed_or_missing', detail: 'The account no longer exists at the slot the balances were read.' }); return; }
    if (!TOKEN_PROGRAMS.has(v.owner)) { excluded.push({ address, reason: 'not_token_account', detail: 'Not owned by the SPL Token or Token-2022 program.' }); return; }
    const parsed = v.data && v.data.parsed;
    const info = parsed && parsed.type === 'account' ? parsed.info : null;
    if (!info) { excluded.push({ address, reason: 'not_token_account', detail: 'The provider could not decode it as a token account.' }); return; }
    if (info.mint !== mint) { excluded.push({ address, reason: 'wrong_mint', detail: 'This token account holds a different mint.' }); return; }
    const raw = info.tokenAmount && info.tokenAmount.amount;
    if (typeof raw !== 'string' || !DIGITS.test(raw)) { excluded.push({ address, reason: 'unreadable_amount', detail: 'Balance was missing or not an integer.' }); return; }
    if (!isPubkey(info.owner)) { excluded.push({ address, reason: 'unresolved_owner', detail: 'The account owner could not be read.' }); return; }
    const amount = BigInt(raw);
    const ranked = typeof a.amount === 'string' && DIGITS.test(a.amount) ? BigInt(a.amount) : null;
    const moved = ranked !== null && ranked !== amount;
    if (moved) changed++;
    const o = owners.get(info.owner) || { owner: info.owner, amount: 0n, accounts: [] };
    o.amount += amount;
    o.accounts.push({
      address, amount: amount.toString(), rankingAmount: ranked === null ? null : ranked.toString(), changedSinceRanking: moved,
      state: typeof info.state === 'string' ? info.state : null, program: v.owner === PROGRAMS.token2022 ? 'spl-token-2022' : 'spl-token',
    });
    owners.set(info.owner, o);
  });
  const supply = typeof supplyRaw === 'string' && DIGITS.test(supplyRaw) ? BigInt(supplyRaw) : null;
  const list = [...owners.values()].sort((x, y) => (x.amount > y.amount ? -1 : x.amount < y.amount ? 1 : x.owner < y.owner ? -1 : x.owner > y.owner ? 1 : 0));
  let included = 0n;
  const holders = list.map((o, i) => {
    included += o.amount;
    o.accounts.sort((x, y) => (BigInt(x.amount) > BigInt(y.amount) ? -1 : BigInt(x.amount) < BigInt(y.amount) ? 1 : 0));
    const percent = supply !== null ? percentOf(o.amount, supply) : null;
    return { rank: i + 1, owner: o.owner, amount: o.amount.toString(), percent, percentBelowDisplay: percent === '0.0000' && o.amount > 0n, accounts: o.accounts, balanceScope: 'selected_accounts_only' };
  });
  return {
    holders, excluded, changed,
    includedRaw: included.toString(),
    includedPercent: supply !== null ? percentOf(included, supply) : null,
    accountsIncluded: holders.reduce((n, h) => n + h.accounts.length, 0),
  };
}

/** what kind of address an owner is, from facts only (curve membership and the owner account's program) */
export function classifyOwner(owner, acct) {
  const offCurve = !isOnCurve(owner);
  const prog = acct && typeof acct.owner === 'string' ? acct.owner : null;
  if (offCurve) {
    return { kind: 'pda', label: 'Program-derived address', detail: 'Off-curve address: no private key exists, so a program controls it (for example a pool, vault, bonding curve or escrow). Which program and who runs it is not identified here.', programOwner: prog, programOwnerLabel: programLabel(prog) };
  }
  if (acct === undefined) return { kind: 'unknown', label: 'Address type not checked', detail: 'On-curve address; its account could not be read this time.', programOwner: null, programOwnerLabel: null };
  if (acct === null) return { kind: 'wallet_no_sol', label: 'Key-pair address (no SOL account)', detail: 'On-curve address with no SOL balance account. It can sign with a private key; who holds that key is unknown.', programOwner: null, programOwnerLabel: null };
  if (acct.executable) return { kind: 'program', label: 'Executable program', detail: 'This address is a deployed program.', programOwner: prog, programOwnerLabel: programLabel(prog) };
  if (prog === PROGRAMS.system) return { kind: 'wallet', label: 'Key-pair wallet', detail: 'On-curve system account: it can sign with a private key. That does not say whether it is a person, an exchange or a bot.', programOwner: prog, programOwnerLabel: programLabel(prog) };
  return { kind: 'program_owned', label: 'Program-owned account', detail: 'On-curve account whose data is owned by a program other than the System Program.', programOwner: prog, programOwnerLabel: programLabel(prog) };
}

// ---- transfer decoding (exported for tests) ---------------------------------------------------------------------------
const TRANSFER_TYPES = new Set(['transfer', 'transferChecked', 'transferCheckedWithFee']);
const MINT_TYPES = new Set(['mintTo', 'mintToChecked']);
const BURN_TYPES = new Set(['burn', 'burnChecked']);
const keyOf = (k) => (typeof k === 'string' ? k : k && typeof k.pubkey === 'string' ? k.pubkey : null);

/**
 * Decodes the token events of ONE successful jsonParsed transaction that touch `account` for `mint`.
 * Keeps provenance: outer instruction index, inner index (both 0-based), the program that ran the outer instruction and,
 * when stackHeight is reported, the program that invoked the token instruction. Owners come only from the transaction's
 * own token-balance records; anything else stays null with a reason.
 */
export function parseTokenEvents(tx, signature, mint, account) {
  const out = { events: [], otherAccountTransfers: 0, otherMintTransfers: 0, unresolvedMintTransfers: 0, unreadable: 0 };
  if (!tx || !tx.meta || tx.meta.err !== null) return out;
  const msg = tx.transaction && tx.transaction.message;
  const keys = ((msg && msg.accountKeys) || []).map(keyOf);
  const bal = (list) => {
    const m = new Map();
    for (const b of list || []) {
      const a = Number.isInteger(b && b.accountIndex) ? keys[b.accountIndex] : null;
      if (a) m.set(a, { mint: typeof b.mint === 'string' ? b.mint : null, owner: isPubkey(b.owner) ? b.owner : null });
    }
    return m;
  };
  const pre = bal(tx.meta.preTokenBalances), post = bal(tx.meta.postTokenBalances);
  const mintOf = (a) => (pre.get(a) && pre.get(a).mint) || (post.get(a) && post.get(a).mint) || null;
  const ownerOf = (a) => {
    if (!a) return { owner: null, note: 'no_account' };
    const p = pre.get(a) ? pre.get(a).owner : null, q = post.get(a) ? post.get(a).owner : null;
    if (p && q && p !== q) return { owner: null, note: 'owner_changed_in_transaction' };
    const o = p || q || null;
    return { owner: o, note: o ? null : 'not_in_token_balances' };
  };
  const outer = (msg && msg.instructions) || [];
  const inner = new Map();
  for (const g of tx.meta.innerInstructions || []) if (g && Number.isInteger(g.index)) inner.set(g.index, Array.isArray(g.instructions) ? g.instructions : []);
  const slot = Number.isSafeInteger(tx.slot) ? tx.slot : null;
  const blockTime = Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null;
  const seen = new Set();

  const visit = (ix, outerIx, outerIndex, innerIndex, invokedBy, stackHeight) => {
    if (!ix || !TOKEN_PROGRAMS.has(ix.programId) || !ix.parsed || typeof ix.parsed !== 'object') return;
    const type = ix.parsed.type, info = ix.parsed.info || {};
    const path = innerIndex === null ? `${outerIndex}` : `${outerIndex}.${innerIndex}`;
    const base = {
      signature, path, outerIndex, innerIndex, instructionType: String(type), programId: ix.programId,
      outerProgramId: outerIx && typeof outerIx.programId === 'string' ? outerIx.programId : null,
      outerProgramLabel: programLabel(outerIx && outerIx.programId),
      invokedBy: invokedBy || null, invokedByLabel: programLabel(invokedBy), stackHeight: Number.isInteger(stackHeight) ? stackHeight : null,
      slot, blockTime,
    };
    let ev = null;
    if (TRANSFER_TYPES.has(type)) {
      const src = info.source, dst = info.destination;
      if (!isPubkey(src) || !isPubkey(dst)) { out.unreadable++; return; }
      const m = typeof info.mint === 'string' ? info.mint : mintOf(src) || mintOf(dst);
      if (!m) { out.unresolvedMintTransfers++; return; }
      if (m !== mint) { out.otherMintTransfers++; return; }
      const raw = info.tokenAmount && info.tokenAmount.amount !== undefined ? info.tokenAmount.amount : info.amount;
      if (!DIGITS.test(String(raw))) { out.unreadable++; return; }
      if (src !== account && dst !== account) { out.otherAccountTransfers++; return; }
      const so = ownerOf(src), dO = ownerOf(dst);
      const fee = info.feeAmount && DIGITS.test(String(info.feeAmount.amount)) ? String(info.feeAmount.amount) : null;
      ev = {
        ...base, kind: 'transfer', direction: src === dst ? 'self' : dst === account ? 'in' : 'out', amount: String(raw), feeAmount: fee,
        sourceAccount: src, destinationAccount: dst, sourceOwner: so.owner, destinationOwner: dO.owner, sourceOwnerNote: so.note, destinationOwnerNote: dO.note,
        authority: isPubkey(info.authority) ? info.authority : isPubkey(info.multisigAuthority) ? info.multisigAuthority : null,
        context: innerIndex === null ? 'top_level' : 'inner',
        interpretation: innerIndex === null
          ? 'Top-level token transfer instruction in a successful transaction. It shows tokens moving between these token accounts; it does not show who controls them or why.'
          : `Token transfer made inside ${base.outerProgramLabel ? `a ${base.outerProgramLabel}` : 'another program’s'} instruction (for example a swap or router). It is not necessarily a direct payment between these owners.`,
      };
    } else if (MINT_TYPES.has(type) || BURN_TYPES.has(type)) {
      if (info.mint !== mint) { out.otherMintTransfers++; return; }
      if (info.account !== account) { out.otherAccountTransfers++; return; }
      const raw = info.tokenAmount && info.tokenAmount.amount !== undefined ? info.tokenAmount.amount : info.amount;
      if (!DIGITS.test(String(raw))) { out.unreadable++; return; }
      const isMint = MINT_TYPES.has(type);
      const me = ownerOf(account);
      ev = {
        ...base, kind: isMint ? 'mint' : 'burn', direction: isMint ? 'in' : 'out', amount: String(raw), feeAmount: null,
        sourceAccount: isMint ? null : account, destinationAccount: isMint ? account : null,
        sourceOwner: isMint ? null : me.owner, destinationOwner: isMint ? me.owner : null,
        sourceOwnerNote: isMint ? 'minted' : me.note, destinationOwnerNote: isMint ? me.note : 'burned',
        authority: isPubkey(info.mintAuthority) ? info.mintAuthority : isPubkey(info.authority) ? info.authority : null,
        context: innerIndex === null ? 'top_level' : 'inner',
        interpretation: isMint ? 'New tokens were minted into this account by the mint authority.' : 'Tokens were burned from this account.',
      };
    } else return;
    const key = `${signature}#${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.events.push(ev);
  };

  outer.forEach((ix, i) => {
    visit(ix, ix, i, null, null, 1);
    const list = inner.get(i) || [];
    list.forEach((iix, j) => {
      // the program that invoked this instruction: nearest earlier inner instruction one level up, or the outer one
      let parent = null;
      const h = iix && Number.isInteger(iix.stackHeight) ? iix.stackHeight : null;
      if (h === 2) parent = typeof ix.programId === 'string' ? ix.programId : null;
      else if (h !== null && h > 2) { for (let k = j - 1; k >= 0; k--) { if (list[k] && list[k].stackHeight === h - 1) { parent = list[k].programId || null; break; } } }
      visit(iix, ix, i, j, parent, h);
    });
  });
  return out;
}

// ---- RPC, limits, cache ------------------------------------------------------------------------------------------------
const hits = new Map();
function over(bucket, max, now, windowMs = 60_000) {
  const e = hits.get(bucket);
  if (!e || now - e.t > windowMs) { hits.set(bucket, { t: now, n: 1 }); if (hits.size > 4000) hits.clear(); return false; }
  e.n++;
  return e.n > max;
}
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
/** provider error text, with URLs, api-key parameters and the configured secrets themselves removed */
function scrub(s, env) {
  let t = String(s || '');
  for (const secret of [env && env.HELIUS_API_KEY, env && env.SOLANA_RPC_URL, env && customRpcUrl(env)]) {
    const v = String(secret || '').trim().replace(/^["']|["']$/g, '');
    if (v.length >= 6) t = t.split(v).join('[secret]');
  }
  return t.replace(/https?:\/\/\S+/g, '[url]').replace(/api[-_]?key=[^&\s]+/gi, 'api-key=…').slice(0, 160);
}

export function providerOf(env) {
  const custom = customRpcUrl(env);
  if (custom) { let host = ''; try { host = new URL(custom).host; } catch { /* ignore */ } return { id: 'custom', label: /helius/i.test(host) ? 'Helius Solana RPC (SOLANA_RPC_URL)' : 'Custom Solana RPC (SOLANA_RPC_URL)', configured: true }; }
  if (heliusRpcUrl(env)) return { id: 'helius', label: 'Helius Solana RPC', configured: true };
  return { id: 'none', label: 'Not configured', configured: false };
}

const providerError = (status, message, code, extra = {}) => new ApiError(status, message, { code, ...extra });
const isProviderFailure = (e) => e instanceof ApiError && (e.status >= 500 || e.status === 429) && e.extra && /^provider_|^budget_/.test(e.extra.code || '');

async function rpcCall(ctx, method, params) {
  if (ctx.guard && ctx.guard('rpc')) throw providerError(429, 'The Solana RPC budget for this minute is used up. Try again shortly.', 'budget_exhausted', { retryAfter: 20 });
  if (over('inv:upstream', num(ctx.env.UPSTREAM_PER_MIN_INVESTIGATE, 150), ctx.now())) throw providerError(429, 'The investigation budget for this minute is used up. Try again shortly.', 'budget_exhausted', { retryAfter: 20 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  let res;
  try {
    res = await ctx.fetch(rpcUrl(ctx.env), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal, redirect: 'manual' });
  } catch (e) {
    const t = e && e.name === 'AbortError';
    throw providerError(t ? 504 : 502, t ? 'The Solana RPC timed out.' : 'The Solana RPC could not be reached.', t ? 'provider_timeout' : 'provider_unreachable');
  } finally { clearTimeout(timer); }
  if (res.status === 401 || res.status === 403) throw providerError(502, `The Solana RPC refused BAGZ (HTTP ${res.status}). Check that HELIUS_API_KEY or SOLANA_RPC_URL is valid and its plan allows ${method}.`, 'provider_auth', { upstreamStatus: res.status });
  if (res.status === 429) {
    const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
    throw providerError(429, 'The Solana RPC is rate limiting BAGZ right now.', 'provider_rate_limited', { retryAfter: ra && /^\d{1,4}$/.test(ra) ? Number(ra) : 20, upstreamStatus: 429 });
  }
  if (!res.ok) throw providerError(502, `The Solana RPC answered HTTP ${res.status}.`, 'provider_error', { upstreamStatus: res.status });
  let j;
  try { j = JSON.parse(await res.text()); } catch { throw providerError(502, 'The Solana RPC returned something that is not JSON.', 'provider_malformed'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw providerError(502, 'The Solana RPC returned an unexpected reply.', 'provider_malformed');
  if (j.error) {
    const code = j.error && j.error.code, m = scrub(j.error && j.error.message, ctx.env);
    if (code === -32001 || /api.?key|unauthori[sz]ed|forbidden/i.test(m)) throw providerError(502, `The Solana RPC refused BAGZ: ${m}`, 'provider_auth', { rpcCode: code });
    if (/rate.?limit|too many requests/i.test(m) || code === -32429) throw providerError(429, 'The Solana RPC is rate limiting BAGZ right now.', 'provider_rate_limited', { retryAfter: 20, rpcCode: code });
    throw new ApiError(code === -32602 ? 400 : 502, m || 'Solana RPC error', { code: code === -32602 ? 'invalid_params' : code === -32016 ? 'provider_min_context_slot' : 'provider_rpc_error', rpcCode: code });
  }
  if (!('result' in j)) throw providerError(502, 'The Solana RPC reply had no result.', 'provider_malformed');
  return j.result;
}

const cache = new Map();
const inflight = new Map();
/** test hook: forget cached answers and limits */
export function __resetInvestigate() { cache.clear(); inflight.clear(); hits.clear(); }

async function cached(ctx, key, produce) {
  const now = ctx.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_MS) return { ...hit.data, cache: { hit: true, shared: false, ageMs: now - hit.at, stale: false } };
  let p = inflight.get(key), shared = true;
  if (!p) {
    shared = false;
    p = produce().then((data) => {
      cache.delete(key); cache.set(key, { at: ctx.now(), data });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return data;
    }).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
    inflight.set(key, p);
  }
  try {
    const data = await p;
    return { ...data, cache: { hit: false, shared, ageMs: 0, stale: false } };
  } catch (e) {
    // the provider failed: an earlier answer for the SAME request may be shown, clearly flagged, if it is recent enough
    if (hit && now - hit.at < STALE_MAX_MS && isProviderFailure(e)) {
      return { ...hit.data, cache: { hit: true, shared: false, ageMs: now - hit.at, stale: true, staleCode: e.extra.code, staleReason: e.message } };
    }
    throw e;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const malformed = (what) => providerError(502, `The Solana RPC returned an unexpected ${what} reply.`, 'provider_malformed');
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const slotOf = (r, what) => { if (!isObj(r) || !isObj(r.context) || !Number.isSafeInteger(r.context.slot)) throw malformed(what); return r.context.slot; };

// ---- holders ------------------------------------------------------------------------------------------------------------
function readMint(acc, mint) {
  if (!acc) throw new ApiError(404, 'No account exists at this address, so it is not a token mint.', { code: 'invalid_mint' });
  const program = acc.owner === PROGRAMS.token ? 'spl-token' : acc.owner === PROGRAMS.token2022 ? 'spl-token-2022' : null;
  const parsed = acc.data && acc.data.parsed;
  if (!program || !parsed || parsed.type !== 'mint' || !isObj(parsed.info)) throw new ApiError(400, 'This address is not an SPL Token or Token-2022 mint.', { code: 'invalid_mint' });
  const info = parsed.info;
  if (typeof info.supply !== 'string' || !DIGITS.test(info.supply) || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 255) throw malformed('mint');
  const extensions = Array.isArray(info.extensions) ? info.extensions.map((x) => (x && typeof x.extension === 'string' ? x.extension : null)).filter(Boolean) : [];
  return {
    program, decimals: info.decimals, supply: info.supply,
    mintAuthority: isPubkey(info.mintAuthority) ? info.mintAuthority : null,
    freezeAuthority: isPubkey(info.freezeAuthority) ? info.freezeAuthority : null,
    extensions, decodingGaps: extensions.filter((e) => BALANCE_GAPS[e]).map((e) => ({ extension: e, note: BALANCE_GAPS[e] })),
    isWrappedSol: mint === MINTS.wsol,
  };
}

async function multipleAt(ctx, keys, minSlot) {
  const params = [keys, { encoding: 'jsonParsed', commitment: 'finalized', minContextSlot: minSlot }];
  try { return await rpcCall(ctx, 'getMultipleAccounts', params); } catch (e) {
    // a node that has not reached the ranking slot yet: one retry, then report it
    if (e instanceof ApiError && e.extra && e.extra.code === 'provider_min_context_slot') {
      await new Promise((r) => setTimeout(r, 400));
      return rpcCall(ctx, 'getMultipleAccounts', params);
    }
    throw e;
  }
}

export async function buildHolders(ctx, mint) {
  const provider = providerOf(ctx.env);
  let largest;
  try { largest = await rpcCall(ctx, 'getTokenLargestAccounts', [mint, { commitment: 'finalized' }]); } catch (e) {
    if (e instanceof ApiError && e.extra && e.extra.code === 'invalid_params') throw new ApiError(400, `The RPC says this is not a token mint (${e.message}).`, { code: 'invalid_mint' });
    throw e;
  }
  const rankingSlot = slotOf(largest, 'getTokenLargestAccounts');
  if (!Array.isArray(largest.value)) throw malformed('getTokenLargestAccounts');
  const selected = largest.value.filter((a) => isObj(a) && isPubkey(a.address)).slice(0, HOLDER_ACCOUNTS_MAX);
  const multi = await multipleAt(ctx, [mint, ...selected.map((a) => a.address)], rankingSlot);
  const accountsSlot = slotOf(multi, 'getMultipleAccounts');
  if (!Array.isArray(multi.value) || multi.value.length !== selected.length + 1) throw malformed('getMultipleAccounts');
  const token = readMint(multi.value[0], mint);
  const agg = aggregateHolders(selected, multi.value.slice(1), mint, token.supply);

  // owner address types: curve check (always) + one bounded read of the owner accounts (optional; failure = partial)
  let ownerAccts = null, ownersSlot = null, ownersNote = null;
  const owners = agg.holders.map((h) => h.owner);
  if (owners.length) {
    try {
      const r = await rpcCall(ctx, 'getMultipleAccounts', [owners, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'finalized' }]);
      ownersSlot = slotOf(r, 'getMultipleAccounts');
      if (!Array.isArray(r.value) || r.value.length !== owners.length) throw malformed('getMultipleAccounts');
      ownerAccts = r.value;
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      ownersNote = `Owner account types could not be read (${e.extra && e.extra.code ? e.extra.code : 'error'}); only the curve check was applied.`;
    }
  }
  const holders = agg.holders.map((h, i) => ({ ...h, ownerKind: classifyOwner(h.owner, ownerAccts ? ownerAccts[i] : undefined) }));

  const supplyZero = BigInt(token.supply) === 0n;
  const denominator = token.isWrappedSol
    ? { kind: 'wrapped_sol_token_supply', raw: token.supply, slot: accountsSlot, note: 'Wrapped SOL: the denominator is the wrapped-SOL token supply at this slot, not SOL’s circulating supply. Percentages only compare wrapped-SOL token accounts.' }
    : supplyZero ? { kind: 'none', raw: '0', slot: accountsSlot, note: 'The mint supply is zero, so no percentages are shown.' }
      : { kind: 'token_supply', raw: token.supply, slot: accountsSlot, note: 'Each percentage divides the balance by the mint’s supply read in the same request as the balances (same slot). Burned tokens are not in supply; tokens locked in pools or vaults are.' };
  const now = ctx.now();
  return {
    kind: 'bagz.investigate.holders', version: INVESTIGATE_VERSION, chain: 'solana', mint,
    provider: provider.label, commitment: 'finalized', retrievedAt: new Date(now).toISOString(), observedAt: now,
    slots: { ranking: rankingSlot, accounts: accountsSlot, owners: ownersSlot },
    token, denominator,
    holders: supplyZero ? holders.map((h) => ({ ...h, percent: null, percentBelowDisplay: false })) : holders,
    excluded: agg.excluded,
    coverage: {
      scope: 'largest_token_accounts', maxTokenAccounts: HOLDER_ACCOUNTS_MAX,
      tokenAccountsReturned: largest.value.length, tokenAccountsIncluded: agg.accountsIncluded, tokenAccountsExcluded: agg.excluded.length,
      ownerCount: holders.length, includedRaw: agg.includedRaw, includedPercent: supplyZero ? null : agg.includedPercent,
      completeOwnerRanking: false, ownersNote,
      description: `Owners grouped from the ${largest.value.length} largest token accounts the RPC returned (it returns at most ${HOLDER_ACCOUNTS_MAX}). This is not a ranking of the largest wallets: other token accounts of these owners are not counted, and a wallet spread across many smaller accounts can be missing.`,
    },
    consistency: {
      rankingSlot, accountsSlot, changedAccounts: agg.changed,
      note: accountsSlot === rankingSlot && agg.changed === 0
        ? 'Ranking and balances come from the same slot.'
        : `Ranking was read at slot ${rankingSlot}; balances, owners and supply together at slot ${accountsSlot}. ${agg.changed} account${agg.changed === 1 ? '' : 's'} changed balance in between; the later balance is shown. An account that entered the top 20 in between is not included.`,
    },
    connections: [],
    connectionStatus: 'No connections are drawn from balances. Select a holder to load sampled transfer evidence for its token account.',
  };
}

// ---- activity -----------------------------------------------------------------------------------------------------------
export async function buildActivity(ctx, mint, account, before) {
  const provider = providerOf(ctx.env);
  let info;
  try { info = await rpcCall(ctx, 'getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'finalized' }]); } catch (e) {
    if (e instanceof ApiError && e.extra && e.extra.code === 'invalid_params') throw new ApiError(400, 'The RPC rejected this token account address.', { code: 'invalid_account' });
    throw e;
  }
  const accountSlot = slotOf(info, 'getAccountInfo');
  const v = info.value;
  if (!v) throw new ApiError(404, 'This token account does not exist at finalized commitment (it may have been closed). Its history is not loaded because its mint can no longer be checked.', { code: 'account_not_found' });
  const parsed = v.data && v.data.parsed;
  const ai = TOKEN_PROGRAMS.has(v.owner) && parsed && parsed.type === 'account' && isObj(parsed.info) ? parsed.info : null;
  if (!ai) throw new ApiError(400, 'This address is not a token account.', { code: 'invalid_account' });
  if (ai.mint !== mint) throw new ApiError(400, 'This token account holds a different mint, so its history is not shown for this token.', { code: 'account_mint_mismatch' });
  const decimals = ai.tokenAmount && Number.isInteger(ai.tokenAmount.decimals) ? ai.tokenAmount.decimals : null;
  const amount = ai.tokenAmount && DIGITS.test(String(ai.tokenAmount.amount)) ? String(ai.tokenAmount.amount) : null;

  const sigs = await rpcCall(ctx, 'getSignaturesForAddress', [account, { limit: ACTIVITY_LIMIT, commitment: 'finalized', ...(before ? { before } : {}) }]);
  if (!Array.isArray(sigs)) throw malformed('getSignaturesForAddress');
  const listed = sigs.filter((s) => isObj(s) && SIG.test(s.signature || ''));
  // only signatures the RPC reports as successful (err === null) are opened; failed ones are counted, never parsed
  const ok = listed.filter((s) => s.err === null);
  const unknownStatus = listed.filter((s) => s.err === undefined).length;
  const failed = listed.length - ok.length - unknownStatus;

  let halted = null;
  const fetched = await mapLimit(ok, TX_CONCURRENCY, async (s) => {
    if (halted) return { s, skipped: true };
    try { return { s, tx: await rpcCall(ctx, 'getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) }; } catch (e) {
      if (e instanceof ApiError && e.status === 429) halted = e.extra && e.extra.code ? e.extra.code : 'rate_limited';
      if (!(e instanceof ApiError)) throw e;
      return { s, error: e.extra && e.extra.code ? e.extra.code : 'error' };
    }
  });
  const events = [];
  const counts = { otherAccountTransfers: 0, otherMintTransfers: 0, unresolvedMintTransfers: 0, unreadable: 0 };
  let parsedTx = 0, missing = 0, fetchErrors = 0, skipped = 0, failedOnRead = 0;
  for (const r of fetched) {
    if (r.skipped) { skipped++; continue; }
    if (r.error) { fetchErrors++; continue; }
    if (!r.tx) { missing++; continue; }
    if (!r.tx.meta || r.tx.meta.err !== null) { failedOnRead++; continue; }
    parsedTx++;
    const p = parseTokenEvents(r.tx, r.s.signature, mint, account);
    events.push(...p.events);
    for (const k of Object.keys(counts)) counts[k] += p[k];
  }
  events.sort((a, b) => (b.slot ?? -1) - (a.slot ?? -1) || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0) || a.outerIndex - b.outerIndex || (a.innerIndex ?? -1) - (b.innerIndex ?? -1));
  const complete = parsedTx + failedOnRead === ok.length;
  const now = ctx.now();
  const slots = listed.map((s) => s.slot).filter(Number.isSafeInteger);
  return {
    kind: 'bagz.investigate.activity', version: INVESTIGATE_VERSION, chain: 'solana', mint, account,
    provider: provider.label, commitment: 'finalized', retrievedAt: new Date(now).toISOString(), observedAt: now,
    tokenAccount: { owner: isPubkey(ai.owner) ? ai.owner : null, amount, decimals, state: typeof ai.state === 'string' ? ai.state : null, slot: accountSlot, program: v.owner === PROGRAMS.token2022 ? 'spl-token-2022' : 'spl-token' },
    transfers: events,
    slots: { account: accountSlot, newestSignature: slots.length ? Math.max(...slots) : null, oldestSignature: slots.length ? Math.min(...slots) : null },
    coverage: {
      scope: 'recent_signatures_for_token_account', limit: ACTIVITY_LIMIT, before: before || null,
      signaturesReturned: listed.length, successfulSignatures: ok.length, failedSignaturesSkipped: failed, signaturesWithUnknownStatus: unknownStatus,
      transactionsParsed: parsedTx, missingTransactionBodies: missing, transactionFetchErrors: fetchErrors, transactionsNotFetched: skipped,
      failedOnRead, eventsFound: events.length, ...counts,
      complete, haltedBy: halted,
      nextBefore: listed.length === ACTIVITY_LIMIT ? listed[listed.length - 1].signature : null,
      description: `Up to ${ACTIVITY_LIMIT} most recent finalized signatures that touch this token account${before ? ' (older page)' : ''}. Failed transactions are skipped. Only decoded SPL Token transfer, mint and burn instructions involving this account are listed; balance changes alone are not treated as transfers. This is a sample, not the full history.`,
    },
  };
}

// ---- router -------------------------------------------------------------------------------------------------------------
function readQuery(url, allowed, required) {
  const seen = new Map();
  for (const [k, v] of url.searchParams) {
    if (!allowed.includes(k)) throw new ApiError(400, `Query parameter "${String(k).slice(0, 40)}" is not allowed`, { code: 'bad_request' });
    if (seen.has(k)) throw new ApiError(400, `Query parameter "${k}" repeated`, { code: 'bad_request' });
    seen.set(k, v);
  }
  for (const k of required) if (!seen.has(k)) throw new ApiError(400, `Query parameter "${k}" is required`, { code: 'bad_request' });
  return Object.fromEntries(seen);
}

export function investigateHealth(env) {
  const p = providerOf(env);
  const demo = isTestCopy(env);
  return {
    kind: 'bagz.investigate.health', version: INVESTIGATE_VERSION, provider: p.label, rpc: p.id, configured: p.configured, available: p.configured && !demo, testCopy: demo,
    keyVerified: false, note: '"configured" only means a key or RPC URL is set. It does not prove the key works; a holders request does.',
    mode: 'read_only', commitment: 'finalized',
    historyScope: `On demand: up to ${ACTIVITY_LIMIT} most recent signatures per token account per request, older pages with before=<signature>.`,
    limits: { holderTokenAccounts: HOLDER_ACCOUNTS_MAX, activitySignatures: ACTIVITY_LIMIT, perIpPerMinute: num(env.RATE_INVESTIGATE_PER_MIN, 40), upstreamPerMinute: num(env.UPSTREAM_PER_MIN_INVESTIGATE, 150) },
  };
}

/** returns undefined for paths that are not investigation routes, so the main router can continue */
export async function investigate(ctx, request, path, url) {
  if (path !== '/investigate' && !path.startsWith('/investigate/')) return undefined;
  if (request.method !== 'GET') throw new ApiError(405, 'Investigation endpoints are read-only (GET).', { code: 'method_not_allowed' });
  const route = path.slice('/investigate'.length);
  if (route === '/health') return investigateHealth(ctx.env);
  if (route !== '/holders' && route !== '/activity') throw new ApiError(404, 'Unknown investigation route', { code: 'not_found' });
  if (isTestCopy(ctx.env)) throw new ApiError(503, 'Investigation is not available in the test copy. It needs the deployed BAGZ server with a Solana RPC key; nothing is simulated here.', { code: 'demo_unavailable' });
  const isHolders = route === '/holders';
  const q = readQuery(url, isHolders ? ['mint'] : ['mint', 'account', 'before'], isHolders ? ['mint'] : ['mint', 'account']);
  if (!isPubkey(q.mint)) throw new ApiError(400, 'mint is not a valid Solana address', { code: 'invalid_mint' });
  if (!isHolders && !isPubkey(q.account)) throw new ApiError(400, 'account is not a valid Solana address', { code: 'invalid_account' });
  if (!isHolders && q.before !== undefined && !SIG.test(q.before)) throw new ApiError(400, 'before is not a valid transaction signature', { code: 'bad_request' });
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  if (over(`inv:ip:${ip}`, num(ctx.env.RATE_INVESTIGATE_PER_MIN, 40), ctx.now())) throw new ApiError(429, 'Too many investigation requests. Try again in a minute.', { code: 'rate_limited', retryAfter: 30 });
  if (!providerOf(ctx.env).configured) throw new ApiError(503, 'Investigation needs a Solana RPC key on the server. Add HELIUS_API_KEY (or SOLANA_RPC_URL) as a Cloudflare secret. No demo data is shown instead.', { code: 'provider_not_configured' });
  if (isHolders) return cached(ctx, `h|${q.mint}`, () => buildHolders(ctx, q.mint));
  return cached(ctx, `a|${q.mint}|${q.account}|${q.before || ''}`, () => buildActivity(ctx, q.mint, q.account, q.before || null));
}
