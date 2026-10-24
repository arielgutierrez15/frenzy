/**
 * Chart data: ranges, candle intervals, fetching and live-tick maths.
 * Every candle on a chart comes from a GeckoTerminal OHLCV response for the coin's pool. Nothing is interpolated:
 * intervals with no trades stay missing, and the live candle only moves with a real, recent price from DexScreener/Jupiter.
 */
import type { Candle, Coin, State } from '../types';
import { ensurePool, getJSON, poolIssues } from '../engine';
import { parseOhlcv, sameToken } from '../providers/adapters';

export type RangeId = '1H' | '4H' | '24H' | '7D' | '30D' | '90D' | '180D' | '1Y' | 'ALL';
export type IntervalId = '1m' | '5m' | '15m' | '1h' | '4h' | '12h' | '1d';
export type ChartType = 'candles' | 'line' | 'area';

export interface IntervalSpec { id: IntervalId; label: string; period: 'minute' | 'hour' | 'day'; agg: number; ms: number }
export const INTERVALS: Record<IntervalId, IntervalSpec> = {
  '1m': { id: '1m', label: '1m', period: 'minute', agg: 1, ms: 60_000 },
  '5m': { id: '5m', label: '5m', period: 'minute', agg: 5, ms: 300_000 },
  '15m': { id: '15m', label: '15m', period: 'minute', agg: 15, ms: 900_000 },
  '1h': { id: '1h', label: '1h', period: 'hour', agg: 1, ms: 3_600_000 },
  '4h': { id: '4h', label: '4h', period: 'hour', agg: 4, ms: 14_400_000 },
  '12h': { id: '12h', label: '12h', period: 'hour', agg: 12, ms: 43_200_000 },
  '1d': { id: '1d', label: '1d', period: 'day', agg: 1, ms: 86_400_000 },
};

export interface RangeSpec { id: RangeId; label: string; ms: number; intervals: IntervalId[]; def: IntervalId }
export const RANGES: RangeSpec[] = [
  { id: '1H', label: '1H', ms: 3_600_000, intervals: ['1m', '5m'], def: '1m' },
  { id: '4H', label: '4H', ms: 4 * 3_600_000, intervals: ['1m', '5m', '15m'], def: '5m' },
  { id: '24H', label: '24H', ms: 24 * 3_600_000, intervals: ['5m', '15m', '1h'], def: '15m' },
  { id: '7D', label: '7D', ms: 7 * 86_400_000, intervals: ['15m', '1h', '4h'], def: '1h' },
  { id: '30D', label: '30D', ms: 30 * 86_400_000, intervals: ['1h', '4h', '1d'], def: '4h' },
];
/** longer spans; offered only when the coin is older than the span (a younger coin uses ALL instead) */
export const LONG_RANGES: RangeSpec[] = [
  { id: '90D', label: '90D', ms: 90 * 86_400_000, intervals: ['4h', '12h', '1d'], def: '12h' },
  { id: '180D', label: '180D', ms: 180 * 86_400_000, intervals: ['4h', '12h', '1d'], def: '1d' },
  { id: '1Y', label: '1Y', ms: 365 * 86_400_000, intervals: ['12h', '1d'], def: '1d' },
];
const ALL_IDS: IntervalId[] = ['1m', '5m', '15m', '1h', '4h', '12h', '1d'];
/** history fetched for ALL when the coin's age is unknown, and the most pages fetched for very old coins */
const ALL_UNKNOWN_MS = 1000 * 86_400_000;
export const ALL_MAX_PAGES = 3;

/** "300d", "14h", "2.4y": how long ago the coin was created, for the All button */
export function spanLabel(ms: number): string {
  const h = ms / 3_600_000, d = ms / 86_400_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (d < 1) return `${Math.round(h)}h`;
  if (d < 1000) return `${Math.round(d)}d`;
  return `${(d / 365).toFixed(1)}y`;
}

/**
 * The ALL range: from the coin's creation to now. Candle intervals are the ones that cover that span in at most
 * ALL_MAX_PAGES provider pages and still give a readable chart; the default aims for about 300 candles.
 */
export function allRange(createdAt: number | undefined, now = Date.now()): RangeSpec {
  const age = createdAt && createdAt < now ? Math.max(now - createdAt, 30 * 60_000) : 0;
  const ms = age || ALL_UNKNOWN_MS;
  const fits = (i: IntervalId) => Math.ceil(ms / INTERVALS[i].ms) <= MAX_CANDLES * (i === '1d' ? ALL_MAX_PAGES : 1);
  let ok = ALL_IDS.filter((i) => fits(i) && ms / INTERVALS[i].ms >= 12);
  if (!ok.length) ok = [ALL_IDS.find(fits) || '1d'];
  // at most four choices: the finest ones are pointless once a coin is weeks old
  if (ok.length > 4) ok = ok.slice(ok.length - 4);
  const def = ok.reduce((a, b) => (Math.abs(Math.log(ms / INTERVALS[b].ms / 300)) < Math.abs(Math.log(ms / INTERVALS[a].ms / 300)) ? b : a), ok[0]);
  return { id: 'ALL', label: age ? `All · ${spanLabel(age)}` : 'All', ms, intervals: ok, def };
}

/** ranges this coin can show: the fixed ones shorter than its age, then ALL (since creation) */
export function rangesFor(createdAt: number | undefined, now = Date.now()): RangeSpec[] {
  const age = createdAt && createdAt < now ? now - createdAt : Infinity;
  return [...RANGES, ...LONG_RANGES].filter((r) => r.ms < age * 0.9).concat(allRange(createdAt, now));
}

export const rangeOf = (id: RangeId, createdAt?: number, now = Date.now()): RangeSpec =>
  (id === 'ALL' ? allRange(createdAt, now) : RANGES.find((r) => r.id === id) || LONG_RANGES.find((r) => r.id === id) || RANGES[2]);

/** GeckoTerminal returns at most 1000 candles per call. */
export const MAX_CANDLES = 1000;
export function candlesNeeded(range: RangeSpec, interval: IntervalSpec): number {
  return Math.min(MAX_CANDLES, Math.ceil(range.ms / interval.ms) + 2);
}

/** a stored interval choice is only valid if the range offers it */
export function validInterval(range: RangeSpec, id: string | null | undefined): IntervalId {
  return (range.intervals as string[]).includes(id || '') ? (id as IntervalId) : range.def;
}

export interface CandleSet {
  coinId: string;
  pool: string;
  range: RangeId;
  interval: IntervalId;
  candles: Candle[];
  fetchedAt: number;
  stale: boolean;
  dropped: number;
  suspicious: number;
  /** the pool has less history than the range asks for (new token) */
  partial: boolean;
  /** time between the first and last candle */
  coverageMs: number;
  /** GeckoTerminal confirmed the candles are for this coin's token (meta.base). false = it did not say. */
  baseVerified: boolean;
}
export type CandleResult = { ok: true; set: CandleSet } | { ok: false; error: string };

const cacheTtl = (i: IntervalSpec) => Math.min(120_000, Math.max(15_000, Math.round(i.ms / 4)));
/** latest answer per coin + pool + range + interval, so switching back and forth never shows another token's candles */
const sets = new Map<string, CandleSet>();
export const setKey = (coinId: string, pool: string, range: RangeId, interval: IntervalId) => `${coinId}|${pool}|${range}|${interval}`;
export const peekCandles = (coinId: string, pool: string | undefined, range: RangeId, interval: IntervalId) => (pool ? sets.get(setKey(coinId, pool, range, interval)) : undefined);
export function __clearCandles() { sets.clear(); }

export const GT_NETWORK: Record<string, string> = { solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc' };

export async function loadCandleSet(st: State, c: Coin, rangeId: RangeId, intervalId: IntervalId, o: { force?: boolean; prio?: 0 | 1 | 2; now?: number } = {}): Promise<CandleResult> {
  await ensurePool(st, c);
  const pool = c.pairAddress;
  if (!pool) return { ok: false, error: poolIssues[c.id] ? poolIssues[c.id] : st.sources['gt-pools']?.ok === false ? `No pool found (${st.sources['gt-pools']?.error})` : 'No trading pool found for this coin yet' };
  const now = o.now ?? Date.now();
  const range = rangeOf(rangeId, c.createdAt, now);
  const iv = INTERVALS[validInterval(range, intervalId)];
  const want = Math.ceil(range.ms / iv.ms) + 2;
  const url = (limit: number, before?: number) => `/networks/${GT_NETWORK[c.chain]}/pools/${pool}/ohlcv/${iv.period}?aggregate=${iv.agg}&limit=${limit}&currency=usd&token=base${before ? `&before_timestamp=${before}` : ''}`;
  const r = await getJSON(st, 'gt-ohlcv', url(Math.min(MAX_CANDLES, want)), { validate: parseOhlcv, prio: o.prio ?? 0, force: o.force, ttlMs: cacheTtl(iv) });
  const src = st.sources['gt-ohlcv'];
  if (!r) return { ok: false, error: src?.error || 'GeckoTerminal returned no candles' };
  // never chart another token (or the quote side of the pool) under this coin's name
  if (r.baseAddress && !sameToken(c.chain, r.baseAddress, c.address)) {
    return { ok: false, error: `Chart refused: pool ${pool.slice(0, 6)}… is priced in another token (${r.baseAddress.slice(0, 6)}…), not ${c.symbol}` };
  }
  let all = r.candles;
  let dropped = r.dropped, suspicious = r.suspicious;
  // ALL on an old coin: page further back (older pages change rarely, so they are cached long)
  for (let page = 1; range.id === 'ALL' && page < ALL_MAX_PAGES && all.length >= MAX_CANDLES * page && want > all.length; page++) {
    const before = Math.floor(all[0].t / 1000);
    const more = await getJSON(st, 'gt-ohlcv', url(MAX_CANDLES, before), { validate: parseOhlcv, prio: 2, ttlMs: 30 * 60_000 });
    if (!more || !more.candles.length) break;
    const older = more.candles.filter((k) => k.t < all[0].t);
    if (!older.length) break;
    all = [...older, ...all]; dropped += more.dropped; suspicious += more.suspicious;
  }
  const cutoff = range.id === 'ALL' ? -Infinity : now - range.ms - iv.ms;
  const candles = all.filter((k) => k.t >= cutoff);
  if (candles.length === 0) return { ok: false, error: 'No trades in this pool during the selected range' };
  const set: CandleSet = {
    coinId: c.id, pool, range: range.id, interval: iv.id, candles, fetchedAt: src?.at ?? now, stale: !!src?.stale,
    dropped, suspicious,
    partial: range.id !== 'ALL' && candles[0].t > now - range.ms + 2 * iv.ms,
    coverageMs: candles[candles.length - 1].t - candles[0].t,
    baseVerified: !!r.baseAddress,
  };
  sets.set(setKey(c.id, pool, range.id, iv.id), set);
  return { ok: true, set };
}

// ---------------------------------------------------------------------------
// live tick: move the newest candle with a real, recent price
// ---------------------------------------------------------------------------
export interface Tick { price: number; at: number }
/** a tick older than this is not shown as "live" */
export const TICK_MAX_AGE_MS = 90_000;

/**
 * Returns candles with the newest one updated by the live price. Rules:
 *  - ignore ticks that are not finite/positive, older than TICK_MAX_AGE_MS, or older than the last candle's open
 *  - inside the last candle's interval: close = price, high/low widened
 *  - in a later interval: open a new candle at the interval boundary whose open is the previous close
 *    (volume 0 until the next fetch brings real volume)
 *  - never move backwards in time, never touch older candles
 */
export function applyLiveTick(candles: Candle[], tick: Tick | undefined, intervalMs: number, now: number): { candles: Candle[]; changed: boolean } {
  if (!tick || !candles.length || !(tick.price > 0) || !Number.isFinite(tick.price)) return { candles, changed: false };
  if (now - tick.at > TICK_MAX_AGE_MS) return { candles, changed: false };
  const last = candles[candles.length - 1];
  if (tick.at < last.t) return { candles, changed: false };
  const bucket = Math.floor(tick.at / intervalMs) * intervalMs;
  if (bucket <= last.t) {
    if (tick.price === last.c && tick.price <= last.h && tick.price >= last.l) return { candles, changed: false };
    const next: Candle = { ...last, c: tick.price, h: Math.max(last.h, tick.price), l: Math.min(last.l, tick.price) };
    return { candles: [...candles.slice(0, -1), next], changed: true };
  }
  // do not draw a long run of empty intervals: only open one new candle if it is the immediate next interval or close to it
  if (bucket - last.t > 3 * intervalMs) return { candles, changed: false };
  const fresh: Candle = { t: bucket, o: last.c, h: Math.max(last.c, tick.price), l: Math.min(last.c, tick.price), c: tick.price, v: 0 };
  return { candles: [...candles, fresh], changed: true };
}

/** relative difference between the chart's last close and the quoted price (the quote comes from the coin's best pair) */
export function priceGap(lastClose: number, quote: number): number {
  if (!(lastClose > 0) || !(quote > 0)) return 0;
  return Math.abs(lastClose - quote) / quote;
}
