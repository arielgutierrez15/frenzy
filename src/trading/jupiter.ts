/**
 * Jupiter Swap API V2 (https://api.jup.ag/swap/v2):  GET /order → quote + unsigned transaction,
 * POST /execute → Jupiter lands the signed transaction.  Reached through the BAGZ proxy so the API key stays server-side.
 * Request/response fields follow developers.jup.ag/docs/swap/order-and-execute (checked 18 Oct 2026).
 *
 * Live execution is locked by flags.ts. Quotes are always allowed (no signature, no funds move).
 */
import { request, ValidationError, type Result } from '../providers/http';
import { liveTradingEnabled, TradingDisabledError } from './flags';
import { signTransactionB64, type Connected } from './wallet';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const DIGITS = /^\d+$/;
const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
const fin = (x: unknown) => { const n = typeof x === 'string' ? parseFloat(x) : typeof x === 'number' ? x : NaN; return Number.isFinite(n) ? n : undefined; };

export interface OrderResponse {
  requestId?: string;
  /** base64 unsigned transaction; null/"" when quote-only */
  transaction: string | null;
  inAmount?: string;
  outAmount: string;
  router?: string;
  mode?: string;
  feeBps?: number;
  feeMint?: string;
  /** slippage the router used, in basis points, if Jupiter reports it */
  slippageBps?: number;
  /** price impact as a percentage if Jupiter reports it (field name differs between API versions) */
  priceImpactPct?: number;
  lastValidBlockHeight?: number;
  expireAt?: string;
  errorCode?: number | string;
  errorMessage?: string;
}

export function parseOrder(j: unknown): OrderResponse {
  if (!isObj(j)) throw new ValidationError('Jupiter order: expected an object');
  const err = j.errorMessage ? String(j.errorMessage) : undefined;
  const out = typeof j.outAmount === 'string' ? j.outAmount : typeof j.outAmount === 'number' ? String(j.outAmount) : '';
  if (!DIGITS.test(out) && !err) throw new ValidationError('Jupiter order: missing outAmount');
  const tx = typeof j.transaction === 'string' ? j.transaction : null;
  const impact = fin(j.priceImpactPct) ?? fin(j.priceImpact);
  return {
    requestId: typeof j.requestId === 'string' ? j.requestId : undefined,
    transaction: tx && tx.length ? tx : null,
    inAmount: typeof j.inAmount === 'string' ? j.inAmount : typeof j.inAmount === 'number' ? String(j.inAmount) : undefined,
    outAmount: DIGITS.test(out) ? out : '0',
    router: typeof j.router === 'string' ? j.router : undefined,
    mode: typeof j.mode === 'string' ? j.mode : undefined,
    feeBps: fin(j.feeBps), feeMint: typeof j.feeMint === 'string' ? j.feeMint : undefined,
    slippageBps: fin(j.slippageBps), priceImpactPct: impact,
    lastValidBlockHeight: fin(j.lastValidBlockHeight), expireAt: typeof j.expireAt === 'string' ? j.expireAt : undefined,
    errorCode: j.errorCode, errorMessage: err,
  };
}

export interface QuoteInput { inMint: string; outMint: string; amountRaw: string; slippageBps?: number; taker?: string }
export interface SwapQuote extends OrderResponse { input: QuoteInput; fetchedAt: number }
export type QuoteResult = { ok: true; quote: SwapQuote } | { ok: false; error: string };

export function orderPath(q: QuoteInput): string {
  const p = new URLSearchParams({ inputMint: q.inMint, outputMint: q.outMint, amount: q.amountRaw });
  if (q.taker) p.set('taker', q.taker);
  if (q.slippageBps !== undefined) p.set('slippageBps', String(Math.round(q.slippageBps)));
  return `/swap/v2/order?${p.toString()}`;
}

export async function getQuote(q: QuoteInput): Promise<QuoteResult> {
  if (!DIGITS.test(q.amountRaw) || q.amountRaw === '0') return { ok: false, error: 'Enter an amount greater than zero' };
  const r: Result<OrderResponse> = await request({ source: 'jup-quote', path: orderPath(q), prio: 0, force: true, validate: parseOrder });
  if (!r.ok) return { ok: false, error: r.error.message };
  if (r.data.errorMessage && r.data.outAmount === '0') return { ok: false, error: r.data.errorMessage };
  return { ok: true, quote: { ...r.data, input: q, fetchedAt: r.fetchedAt } };
}

/** Raw integer amount from a decimal string without floating-point error (e.g. "1.5", 9 → "1500000000"). */
export function toRaw(amount: string, decimals: number): string | undefined {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  const frac = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
  const raw = ((m[1] || '0') + frac).replace(/^0+(?=\d)/, '');
  return raw;
}
export const fromRaw = (raw: string, decimals: number): number => Number(raw) / 10 ** decimals;

/**
 * How much worse the quote's effective price is than the current market price, in percent (positive = worse for you).
 * This is an ESTIMATE that includes fees, spread and impact; it is not a figure reported by Jupiter.
 */
export function estimateCostVsMarket(o: { inAmount: number; outAmount: number; marketPriceInOut: number }): number | undefined {
  const { inAmount, outAmount, marketPriceInOut } = o;
  if (!(inAmount > 0) || !(outAmount > 0) || !(marketPriceInOut > 0)) return undefined;
  // marketPriceInOut = how many OUT units one IN unit is worth at market
  return (1 - outAmount / (inAmount * marketPriceInOut)) * 100;
}

// ---------------------------------------------------------------------------
// execution (locked)
// ---------------------------------------------------------------------------
export interface ExecuteResponse { status: 'Success' | 'Failed'; signature?: string; code?: number; error?: string; totalInputAmount?: string; totalOutputAmount?: string }
export function parseExecute(j: unknown): ExecuteResponse {
  if (!isObj(j) || (j.status !== 'Success' && j.status !== 'Failed')) throw new ValidationError('Jupiter execute: unexpected status');
  return {
    status: j.status, signature: typeof j.signature === 'string' ? j.signature : undefined, code: fin(j.code), error: typeof j.error === 'string' ? j.error : undefined,
    totalInputAmount: typeof j.totalInputAmount === 'string' ? j.totalInputAmount : undefined, totalOutputAmount: typeof j.totalOutputAmount === 'string' ? j.totalOutputAmount : undefined,
  };
}

export type Confirmation = { state: 'confirmed' | 'finalized' } | { state: 'failed'; error: string } | { state: 'unknown' };
/** Polls getSignatureStatuses until the signature is confirmed/finalized, failed, or the timeout passes (then "unknown", never "success"). */
export async function confirmSignature(signature: string, o: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<Confirmation> {
  const sleep = o.sleep || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now || (() => Date.now());
  const end = now() + (o.timeoutMs ?? 60_000);
  while (now() < end) {
    const r = await request({
      source: 'sol-confirm', path: '', method: 'POST', prio: 0, force: true,
      body: { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [[signature], { searchTransactionHistory: true }] },
      validate: (j) => { if (!isObj(j) || !isObj(j.result)) throw new ValidationError('RPC: no result'); return j; },
    });
    const s = r.ok ? (r.data as any).result?.value?.[0] : undefined;
    if (s) {
      if (s.err) return { state: 'failed', error: JSON.stringify(s.err) };
      if (s.confirmationStatus === 'finalized') return { state: 'finalized' };
      if (s.confirmationStatus === 'confirmed') return { state: 'confirmed' };
    }
    await sleep(o.intervalMs ?? 2000);
  }
  return { state: 'unknown' };
}

export type SwapOutcome =
  | { ok: true; signature: string; confirmation: { state: 'confirmed' | 'finalized' }; outAmount?: string }
  | { ok: false; stage: 'quote' | 'sign' | 'execute'; error: string; signature?: string };

/** Max age of the quote that gets signed. Older quotes are refused so the user never signs a stale price. */
export const MAX_QUOTE_AGE_MS = 20_000;

/**
 * Full flow: fresh quote with the wallet as taker → wallet signs → Jupiter /execute → confirm on-chain.
 * Throws TradingDisabledError unless live trading is enabled. The execute call is never retried automatically.
 */
export async function executeSwap(input: Omit<QuoteInput, 'taker'>, wallet: Connected, hooks: { onStage?: (s: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<SwapOutcome> {
  if (!liveTradingEnabled()) throw new TradingDisabledError();
  const now = hooks.now || (() => Date.now());
  hooks.onStage?.('Getting a fresh quote');
  const q = await getQuote({ ...input, taker: wallet.account.address });
  if (!q.ok) return { ok: false, stage: 'quote', error: q.error };
  const { quote } = q;
  if (!quote.transaction || !quote.requestId) return { ok: false, stage: 'quote', error: quote.errorMessage || 'Jupiter returned a quote without a transaction' };
  if (now() - quote.fetchedAt > MAX_QUOTE_AGE_MS) return { ok: false, stage: 'quote', error: 'Quote expired, try again' };
  hooks.onStage?.('Waiting for your wallet to sign');
  let signed: string;
  try { signed = await signTransactionB64(wallet, quote.transaction); }
  catch (e: any) { return { ok: false, stage: 'sign', error: e?.message || 'Signing failed' }; }
  hooks.onStage?.('Sending through Jupiter');
  const ex = await request({ source: 'jup-execute', path: '/swap/v2/execute', method: 'POST', body: { signedTransaction: signed, requestId: quote.requestId }, prio: 0, force: true, validate: parseExecute });
  if (!ex.ok) return { ok: false, stage: 'execute', error: `${ex.error.message}. The swap may or may not have landed; check your wallet before retrying.` };
  if (ex.data.status === 'Failed' || !ex.data.signature) return { ok: false, stage: 'execute', error: ex.data.error || `Jupiter reported failure (code ${ex.data.code ?? 'unknown'})`, signature: ex.data.signature };
  hooks.onStage?.('Confirming on Solana');
  const confirmation = await confirmSignature(ex.data.signature, { sleep: hooks.sleep, now: hooks.now });
  if (confirmation.state === 'failed') return { ok: false, stage: 'execute', error: `Transaction failed on-chain: ${confirmation.error}`, signature: ex.data.signature };
  if (confirmation.state === 'unknown') return { ok: false, stage: 'execute', error: 'Sent, but not confirmed in time. Check the signature on a block explorer before trying again.', signature: ex.data.signature };
  return { ok: true, signature: ex.data.signature, confirmation, outAmount: ex.data.totalOutputAmount };
}
