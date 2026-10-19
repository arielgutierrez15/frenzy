import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Coin } from '../types';
import { useStore, getState, emit } from '../store';
import { Seg } from '../views';
import { PriceChart } from '../ui';
import { LwChart } from './LwChart';
import {
  RANGES, INTERVALS, rangeOf, validInterval, loadCandleSet, peekCandles, setKey, priceGap, GT_NETWORK,
  type RangeId, type IntervalId, type ChartType, type CandleSet,
} from './data';
import { ago, price as fmtPrice } from '../format';
import { short } from '../engine';

const LS = { range: 'bagz.range', type: 'bagz.chartType', iv: 'bagz.intervals', axis: 'bagz.axis' };
const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const readIv = (): Record<string, string> => { try { return JSON.parse(read(LS.iv) || '{}'); } catch { return {}; } };

export function ChartPanel({ c, entry, isMajor }: { c: Coin; entry?: number; isMajor: boolean }) {
  useStore();
  const [range, setRange] = useState<RangeId>(() => (RANGES.some((r) => r.id === read(LS.range)) ? (read(LS.range) as RangeId) : '24H'));
  const [ivs, setIvs] = useState<Record<string, string>>(readIv);
  const [type, setType] = useState<ChartType>(() => (['candles', 'line', 'area'].includes(read(LS.type) || '') ? (read(LS.type) as ChartType) : 'candles'));
  const [axis, setAxis] = useState<'price' | 'mcap'>(() => (read(LS.axis) as 'price' | 'mcap') || (isMajor ? 'price' : 'mcap'));
  const rangeSpec = rangeOf(range);
  const interval: IntervalId = validInterval(rangeSpec, ivs[range]);
  const iv = INTERVALS[interval];

  const key = c.pairAddress ? setKey(c.id, c.pairAddress, range, interval) : '';
  const [res, setRes] = useState<{ key: string; set?: CandleSet; error?: string }>(() => {
    const hit = peekCandles(c.id, c.pairAddress, range, interval);
    return hit ? { key, set: hit } : { key: '' };
  });
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const fetchNow = async (force: boolean) => {
    const my = ++seq.current;
    setBusy(true);
    const st = getState();
    const r = await loadCandleSet(st, c, range, interval, { force, prio: 0 });
    if (my !== seq.current) return; // the user switched coin/range/interval meanwhile: drop this answer
    const k = st.coins[c.id]?.pairAddress ? setKey(c.id, st.coins[c.id].pairAddress!, range, interval) : '';
    setRes(r.ok ? { key: k, set: r.set } : { key: k || key, error: r.error });
    setBusy(false);
    emit();
  };

  useEffect(() => {
    const hit = peekCandles(c.id, c.pairAddress, range, interval);
    setRes(hit ? { key, set: hit } : { key: '' });
    fetchNow(false);
    // short intervals refresh faster; the HTTP core serves from cache until the data is actually old
    const t = setInterval(() => fetchNow(false), Math.max(20_000, Math.min(60_000, iv.ms / 2)));
    return () => { clearInterval(t); seq.current++; };
  }, [c.id, c.pairAddress, range, interval]);

  const pickRange = (r: RangeId) => { setRange(r); write(LS.range, r); };
  const pickIv = (v: IntervalId) => { const n = { ...ivs, [range]: v }; setIvs(n); write(LS.iv, JSON.stringify(n)); };
  const pickType = (t: ChartType) => { setType(t); write(LS.type, t); };
  const pickAxis = (a: 'price' | 'mcap') => { setAxis(a); write(LS.axis, a); };

  const set = res.key === key && key ? res.set : undefined;
  const err = res.key === key ? res.error : undefined;
  const supply = c.price > 0 ? c.mcap / c.price : 0;
  const tick = useMemo(() => (c.price > 0 && c.updatedAt ? { price: c.price, at: c.updatedAt } : undefined), [c.price, c.updatedAt]);
  const lastClose = set ? set.candles[set.candles.length - 1].c : 0;
  // only compare when the candles and the quote were fetched close together, so ordinary movement isn't reported as a mismatch
  const gap = set && tick && Math.abs(set.fetchedAt - c.updatedAt) <= 25_000 ? priceGap(lastClose, c.price) : 0;
  const sampled = useMemo(() => c.spark.map((p) => ({ t: p.t, o: p.p, h: p.p, l: p.p, c: p.p, v: 0 })), [c.spark.length, c.updatedAt]);

  return (
    <div className="chart-panel">
      <div className="toolbar">
        <Seg label="Range" value={range} onChange={pickRange} options={RANGES.map((r) => ({ v: r.id, l: r.label }))} />
        <Seg label="Candle interval" value={interval} onChange={pickIv} options={rangeSpec.intervals.map((i) => ({ v: i, l: INTERVALS[i].label }))} />
        <Seg label="Chart type" value={type} onChange={pickType} options={[{ v: 'candles', l: 'Candles' }, { v: 'line', l: 'Line' }, { v: 'area', l: 'Area' }]} />
        <Seg label="Chart axis" value={axis} onChange={pickAxis} options={[{ v: 'price', l: 'Price' }, { v: 'mcap', l: 'MCap' }]} />
      </div>

      {set ? (
        <LwChart candles={set.candles} type={type} intervalMs={iv.ms} dataKey={key} tick={tick} entry={entry} supply={supply} showMcap={axis === 'mcap' && supply > 0} />
      ) : err ? (
        <div className="chart-empty">
          <p className="muted">Candles unavailable: {err}</p>
          {sampled.length > 1 && <PriceChart candles={sampled} mode="line" entry={entry} supply={supply} showMcap={axis === 'mcap' && supply > 0} stepMs={60_000} />}
          {sampled.length > 1 && <p className="muted small">Showing prices BAGZ sampled this session, not exchange candles.</p>}
          <button className="chip-btn" onClick={() => fetchNow(true)}>Retry</button>
        </div>
      ) : (
        <div className="chart-empty muted">{busy || key ? `Loading ${range} candles…` : 'Looking for this coin’s trading pool…'}</div>
      )}

      <div className="chart-meta small muted">
        {set && (
          <>
            <span>{range} · {iv.label} candles · {set.candles.length} loaded</span>
            <span>GeckoTerminal pool <a className="link" target="_blank" rel="noopener noreferrer" href={`https://www.geckoterminal.com/${GT_NETWORK[c.chain]}/pools/${set.pool}`}>{short(set.pool)}</a>{c.dexId ? ` (${c.dexId})` : ''}</span>
            <span className={set.stale ? 'warn' : ''}>{set.stale ? 'STALE · last good fetch ' : 'fetched '}{ago(set.fetchedAt)} ago</span>
          </>
        )}
        {busy && set && <span>refreshing…</span>}
      </div>
      {set?.partial && <p className="chart-note small muted">This pool is younger than {range}, so the chart shows all history that exists. Intervals with no trades have no candle.</p>}
      {set && gap > 0.03 && <p className="chart-note small warn">Chart pool price ({fmtPrice(lastClose)}) differs from the quoted price ({fmtPrice(c.price)}) by {(gap * 100).toFixed(1)}%. They come from different pools or moments.</p>}
      {set && set.dropped > 0 && <p className="chart-note small muted">{set.dropped} malformed candle{set.dropped > 1 ? 's were' : ' was'} dropped from the provider response.</p>}
      {set && set.suspicious > 0 && <p className="chart-note small warn">{set.suspicious} candle{set.suspicious > 1 ? 's have' : ' has'} an extreme wick (&gt;40×). It may be a bad print on a thin pool.</p>}
    </div>
  );
}
