/**
 * Chart data: ranges, candle intervals, fetching and live-tick maths.
 * Every candle on a chart comes from a GeckoTerminal OHLCV response for the coin's pool. Nothing is interpolated:
 * intervals with no trades stay missing, and the live candle only moves with a real, recent price from DexScreener/Jupiter.
 */
import type { Candle, Coin, State } from '../types';
import { ensurePool, getJSON } from '../engine';
import { parseOhlcv } from '../providers/adapters';

export type RangeId = '1H' | '4H' | '24H' | '7D' | '30D';
export type IntervalId = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
export type ChartType = 'candles' | 'line' | 'area';

export interface IntervalSpec { id: IntervalId; label: string; period: 'minute' | 'hour' | 'day'; agg: number; ms: number }
export const INTERVALS: Record<IntervalId, IntervalSpec> = {
  '1m': { id: '1m', label: '1m', period: 'minute', agg: 1, ms: 60_000 },
  '5m': { id: '5m', label: '5m', period: 'minute', agg: 5, ms: 300_000 },
  '15m': { id: '15m', label: '15m', period: 'minute', agg: 15, ms: 900_000 },
  '1h': { id: '1h', label: '1h', period: 'hour', agg: 1, ms: 3_600_000 },
  '4h': { id: '4h', label: '4h', period: 'hour', agg: 4, ms: 14_400_000 },
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
export const rangeOf = (id: RangeId) => RANGES.find((r) => r.id === id) || RANGES[2];

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
  if (!pool) return { ok: false, error: st.sources['gt-pools']?.ok === false ? `No pool found (${st.sources['gt-pools']?.error})` : 'No trading pool found for this coin yet' };
  const range = rangeOf(rangeId);
  const iv = INTERVALS[validInterval(range, intervalId)];
  const n = candlesNeeded(range, iv);
  const path = `/networks/${GT_NETWORK[c.chain]}/pools/${pool}/ohlcv/${iv.period}?aggregate=${iv.agg}&limit=${n}&currency=usd&token=base`;
  const r = await getJSON(st, 'gt-ohlcv', path, { validate: parseOhlcv, prio: o.prio ?? 0, force: o.force, ttlMs: cacheTtl(iv) });
  const src = st.sources['gt-ohlcv'];
  if (!r) return { ok: false, error: src?.error || 'GeckoTerminal returned no candles' };
  const now = o.now ?? Date.now();
  const cutoff = now - range.ms - iv.ms;
  const candles = r.candles.filter((k) => k.t >= cutoff);
  if (candles.length === 0) return { ok: false, error: 'No trades in this pool during the selected range' };
  const set: CandleSet = {
    coinId: c.id, pool, range: range.id, interval: iv.id, candles, fetchedAt: src?.at ?? now, stale: !!src?.stale,
    dropped: r.dropped, suspicious: r.suspicious,
    partial: candles[0].t > now - range.ms + 2 * iv.ms,
    coverageMs: candles[candles.length - 1].t - candles[0].t,
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
