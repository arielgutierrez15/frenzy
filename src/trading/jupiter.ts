/**
 * Jupiter Swap API V2 GET /order, used ONLY as a quote preview before a wallet is connected (no taker, no transaction).
 * Request/response fields follow developers.jup.ag/docs/swap/order-and-execute (checked 18 Oct 2026).
 *
 * Real swaps never use /order → /execute: those carry no BAGZ fee. They are built by the BAGZ server with Jupiter
 * /build and the 0.50% platform fee (worker/api.js) and run through bagzSwap.ts.
 */
import { request, ValidationError, type Result } from '../providers/http';

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
