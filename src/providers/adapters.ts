/**
 * Typed response adapters. Each one checks the shape of a provider response and either returns clean typed data or
 * throws ValidationError (which the HTTP core reports as an "invalid" error in the health panel instead of letting
 * a half-parsed response leak into the UI). Items that fail validation are dropped, never repaired or invented.
 */
import { ValidationError } from './http';
import type { Candle } from '../types';

export const isObj = (x: unknown): x is Record<string, any> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const fin = (x: unknown): number | undefined => {
  const n = typeof x === 'string' ? parseFloat(x) : typeof x === 'number' ? x : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.length ? x : undefined);
const url = (x: unknown): string | undefined => (typeof x === 'string' && /^https?:\/\//i.test(x) ? x : undefined);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** array of objects that each carry a string field; throws if the response is not that, drops malformed rows */
function rows(j: unknown, what: string, field: string): Record<string, any>[] {
  if (!Array.isArray(j)) throw new ValidationError(`${what}: expected a list`);
  const ok = j.filter((x) => isObj(x) && typeof x[field] === 'string' && x[field]);
  if (j.length > 0 && ok.length === 0) throw new ValidationError(`${what}: no row had a "${field}"`);
  return ok;
}

// ------------------------------------------------------------------ Jupiter
export const parseJupiterTokens = (j: unknown) => rows(j, 'Jupiter tokens', 'id');
export function parseJupiterPrice(j: unknown): Record<string, { usdPrice: number }> {
  if (!isObj(j)) throw new ValidationError('Jupiter price: expected an object');
  const out: Record<string, { usdPrice: number }> = {};
  for (const [k, v] of Object.entries(j)) { const p = isObj(v) ? fin(v.usdPrice) : undefined; if (p !== undefined && p > 0) out[k] = { usdPrice: p }; }
  return out;
}

// ------------------------------------------------------------------ DexScreener
export const parseDexProfiles = (j: unknown) => rows(j, 'DexScreener list', 'tokenAddress');
export const parseDexPairs = (j: unknown) => {
  if (!Array.isArray(j)) throw new ValidationError('DexScreener pairs: expected a list');
  return j.filter((p) => isObj(p) && isObj(p.baseToken) && typeof p.baseToken.address === 'string') as Record<string, any>[];
};

// ------------------------------------------------------------------ GeckoTerminal
export interface GtList { data: Record<string, any>[]; included: Record<string, any>[] }
/**
 * GeckoTerminal lists pools where the token is the base OR the quote. A chart and a USD price for "the token" are only
 * comparable when the token is the base of the pool, so only those pools are usable.
 */
export function poolHasBase(pool: any, network: string, address: string): boolean {
  const id = pool?.relationships?.base_token?.data?.id;
  if (typeof id !== 'string') return false;
  const a = id.slice(id.indexOf('_') + 1);
  return id.startsWith(network + '_') && (network === 'solana' ? a === address : a.toLowerCase() === address.toLowerCase());
}
export function sameToken(chain: string, a: string, b: string): boolean { return chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase(); }

export function parseGtPools(j: unknown): GtList {
  if (!isObj(j) || !Array.isArray(j.data)) throw new ValidationError('GeckoTerminal pools: missing "data" list');
  const data = j.data.filter((p: unknown) => isObj(p) && typeof p.id === 'string' && isObj(p.attributes));
  if (j.data.length > 0 && data.length === 0) throw new ValidationError('GeckoTerminal pools: no usable pool rows');
  return { data, included: Array.isArray(j.included) ? j.included.filter(isObj) : [] };
}

export interface ChainTradeRow { id: string; tsMs: number; wallet: string; side: 'BUY' | 'SELL'; usd: number; priceUsd?: number }
export function parseGtTrades(j: unknown): ChainTradeRow[] {
  if (!isObj(j) || !Array.isArray(j.data)) throw new ValidationError('GeckoTerminal trades: missing "data" list');
  const out: ChainTradeRow[] = [];
  for (const x of j.data) {
    const a = isObj(x) && isObj(x.attributes) ? x.attributes : null;
    if (!a) continue;
    const kind = a.kind === 'sell' ? 'SELL' : a.kind === 'buy' ? 'BUY' : null;
    const usd = fin(a.volume_in_usd);
    const ts = Date.parse(String(a.block_timestamp));
    const wallet = str(a.tx_from_address);
    if (!kind || !usd || usd <= 0 || !Number.isFinite(ts) || !wallet) continue;
    const price = kind === 'BUY' ? fin(a.price_to_in_usd) : fin(a.price_from_in_usd);
    out.push({ id: str(a.tx_hash) || String(x.id), tsMs: ts, wallet, side: kind, usd, priceUsd: price && price > 0 ? price : undefined });
  }
  if (j.data.length > 0 && out.length === 0) throw new ValidationError('GeckoTerminal trades: no row passed validation');
  return out;
}

export interface OhlcvResult { candles: Candle[]; dropped: number; suspicious: number; /** token addresses GeckoTerminal says the candles are for (meta.base / meta.quote), when it says */ baseAddress?: string; quoteAddress?: string }
/**
 * Validates [ts, o, h, l, c, v] rows. A row is dropped when any value is not a finite number, any price is <= 0,
 * volume is negative, high < low, or high/low do not contain open and close. Duplicate timestamps keep the last row.
 * `suspicious` counts candles whose wick is >40x the body's price (a likely bad print) so the UI can say so.
 */
export function parseOhlcv(j: unknown): OhlcvResult {
  const list = isObj(j) && isObj(j.data) && isObj(j.data.attributes) ? j.data.attributes.ohlcv_list : undefined;
  if (!Array.isArray(list)) throw new ValidationError('GeckoTerminal candles: missing "ohlcv_list"');
  const byT = new Map<number, Candle>();
  let dropped = 0, suspicious = 0;
  for (const r of list) {
    if (!Array.isArray(r) || r.length < 6) { dropped++; continue; }
    const [ts, o, h, l, c, v] = r.map((x: unknown) => fin(x));
    if ([ts, o, h, l, c, v].some((x) => x === undefined) || ts! <= 0 || o! <= 0 || h! <= 0 || l! <= 0 || c! <= 0 || v! < 0) { dropped++; continue; }
    const eps = 1e-12;
    if (h! < l! || h! < Math.max(o!, c!) * (1 - eps) || l! > Math.min(o!, c!) * (1 + eps)) { dropped++; continue; }
    if (h! / Math.max(o!, c!) > 40 || Math.min(o!, c!) / l! > 40) suspicious++;
    byT.set(ts!, { t: ts! * 1000, o: o!, h: h!, l: l!, c: c!, v: v! });
  }
  if (list.length > 0 && byT.size === 0) throw new ValidationError('GeckoTerminal candles: every row was invalid');
  const meta = isObj(j) && isObj((j as any).meta) ? (j as any).meta : undefined;
  const addr = (x: unknown) => (isObj(x) && typeof x.address === 'string' && x.address ? x.address : undefined);
  return { candles: [...byT.values()].sort((a, b) => a.t - b.t), dropped, suspicious, baseAddress: addr(meta?.base), quoteAddress: addr(meta?.quote) };
}

// ------------------------------------------------------------------ pump.fun (unofficial)
export interface PumpCoin {
  mint: string; symbol: string; name: string; description?: string; image?: string;
  marketCapUsd?: number; createdAtMs?: number; complete?: boolean; isLive?: boolean;
  website?: string; twitter?: string; telegram?: string; liquidityUsd?: number;
}
export function parsePumpCoins(j: unknown): PumpCoin[] {
  const list = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.coins) ? j.coins : isObj(j) && Array.isArray(j.data) ? j.data : undefined;
  if (!list) throw new ValidationError('pump.fun: expected a list of coins');
  const out: PumpCoin[] = [];
  for (const t of list) {
    if (!isObj(t) || typeof t.mint !== 'string' || !B58.test(t.mint)) continue;
    out.push({
      mint: t.mint, symbol: str(t.symbol) || '???', name: str(t.name) || str(t.symbol) || 'Unknown', description: str(t.description), image: url(t.image_uri),
      marketCapUsd: fin(t.usd_market_cap), createdAtMs: fin(t.created_timestamp), complete: typeof t.complete === 'boolean' ? t.complete : undefined,
      isLive: typeof t.is_currently_live === 'boolean' ? t.is_currently_live : undefined,
      website: url(t.website), twitter: url(t.twitter), telegram: url(t.telegram), liquidityUsd: fin(t.canonical_pool_liquidity_usd),
    });
  }
  if (list.length > 0 && out.length === 0) throw new ValidationError('pump.fun: no coin had a valid mint address');
  return out;
}

// ------------------------------------------------------------------ RugCheck / RPC
export function parseRugSummary(j: unknown): Record<string, any> {
  if (!isObj(j) || !Array.isArray(j.risks)) throw new ValidationError('RugCheck: missing "risks"');
  return j;
}
export function parseRpc(j: unknown): Record<string, any> {
  if (!isObj(j) || (!('result' in j) && !('error' in j))) throw new ValidationError('Solana RPC: not a JSON-RPC reply');
  if (isObj(j.error)) throw new ValidationError(`Solana RPC error: ${String(j.error.message || j.error.code)}`);
  return j;
}
