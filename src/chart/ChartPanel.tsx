import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Coin } from '../types';
import { useStore, getState, emit } from '../store';
import { Seg } from '../views';
import { PriceChart } from '../ui';
import { LwChart } from './LwChart';
import {
  INTERVALS, rangeOf, rangesFor, validInterval, loadCandleSet, peekCandles, setKey, priceGap, GT_NETWORK,
  type RangeId, type IntervalId, type ChartType, type CandleSet,
} from './data';
import { ago, compact, price as fmtPrice } from '../format';
import { Icon } from '../ui';
import { short } from '../engine';

const LS = { range: 'bagz.range', type: 'bagz.chartType', iv: 'bagz.intervals', axis: 'bagz.axis' };
const read = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
const readIv = (): Record<string, string> => { try { return JSON.parse(read(LS.iv) || '{}'); } catch { return {}; } };

const LIVE = { range: '1H' as RangeId, iv: '1m' as IntervalId };
const ALL_RANGE_IDS = ['1H', '4H', '24H', '7D', '30D', '90D', '180D', '1Y', 'ALL'];

export interface ChartInfo { high: number; low: number; first: number }

export function ChartPanel({ c, entry, isMajor, holders, onHolders, onInfo, height = 400 }: { c: Coin; entry?: number; isMajor: boolean; holders?: number; onHolders?: () => void; onInfo?: (i: ChartInfo | null) => void; height?: number }) {
  useStore();
  const [rangeRaw, setRange] = useState<RangeId>(() => (ALL_RANGE_IDS.includes(read(LS.range) || '') ? (read(LS.range) as RangeId) : '24H'));
  const [ivs, setIvs] = useState<Record<string, string>>(() => ({ '24H': '5m', ...readIv() }));
  const [type, setType] = useState<ChartType>(() => (['candles', 'line', 'area'].includes(read(LS.type) || '') ? (read(LS.type) as ChartType) : 'candles'));
  const [axis, setAxis] = useState<'price' | 'mcap'>(() => { const a = read(LS.axis); return a === 'price' || a === 'mcap' ? a : isMajor ? 'price' : 'mcap'; });
  // ranges this coin can show (a 3-hour-old coin gets 1H and All, a 300-day-old one goes up to 180D and All · 300d)
  const ranges = useMemo(() => rangesFor(c.createdAt), [c.createdAt, Math.floor(Date.now() / 60_000)]);
  const range: RangeId = ranges.some((r) => r.id === rangeRaw) ? rangeRaw : 'ALL';
  const rangeSpec = ranges.find((r) => r.id === range) || rangeOf(range, c.createdAt);
  const interval: IntervalId = validInterval(rangeSpec, ivs[range]);
  const iv = INTERVALS[interval];
  const isLive = range === LIVE.range && interval === LIVE.iv;

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
    // short pause before fetching, so tapping a range and then its candle size costs one provider call, not two
    const first = setTimeout(() => fetchNow(false), hit ? 0 : 250);
    // short intervals refresh faster; the HTTP core serves from cache until the data is actually old
    const t = setInterval(() => fetchNow(false), Math.max(20_000, Math.min(60_000, iv.ms / 2)));
    return () => { clearTimeout(first); clearInterval(t); seq.current++; };
  }, [c.id, c.pairAddress, range, interval]);

  const pickRange = (r: RangeId) => { setRange(r); write(LS.range, r); };
  const pickIv = (v: IntervalId) => { const n = { ...ivs, [range]: v }; setIvs(n); write(LS.iv, JSON.stringify(n)); };
  const pickType = (t: ChartType) => { setType(t); write(LS.type, t); };
  const goLive = () => { setRange(LIVE.range); write(LS.range, LIVE.range); const n = { ...ivs, [LIVE.range]: LIVE.iv }; setIvs(n); write(LS.iv, JSON.stringify(n)); setTf(false); };
  const [settings, setSettings] = useState(false);
  const [tf, setTf] = useState(false);
  const pickAxis = (a: 'price' | 'mcap') => { setAxis(a); write(LS.axis, a); };
  // the timeframe menu closes on Escape or a tap outside it
  const tfRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tf) return;
    const out = (e: Event) => { if (tfRef.current && !tfRef.current.contains(e.target as Node)) setTf(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setTf(false); };
    document.addEventListener('pointerdown', out);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', out); document.removeEventListener('keydown', esc); };
  }, [tf]);

  const set = res.key === key && key ? res.set : undefined;
  // while a new timeframe loads, keep the last chart of this coin on screen (dimmed) instead of flashing an empty box
  const lastSet = useRef<CandleSet | undefined>(undefined);
  if (set) lastSet.current = set;
  const shown = set ?? (lastSet.current?.coinId === c.id ? lastSet.current : undefined);
  const shownIv = shown ? INTERVALS[shown.interval] : iv;
  const err = res.key === key ? res.error : undefined;
  const supply = c.price > 0 ? c.mcap / c.price : 0;
  const tick = useMemo(() => (c.price > 0 && c.updatedAt ? { price: c.price, at: c.updatedAt } : undefined), [c.price, c.updatedAt]);
  const loading = !set && !err;
  const lastClose = set ? set.candles[set.candles.length - 1].c : 0;
  // only compare when the candles and the quote were fetched close together, so ordinary movement isn't reported as a mismatch
  const gap = set && tick && Math.abs(set.fetchedAt - c.updatedAt) <= 25_000 ? priceGap(lastClose, c.price) : 0;
  useEffect(() => {
    if (!onInfo) return;
    if (!set || !set.candles.length) { onInfo(null); return; }
    let high = 0, low = Infinity;
    for (const k of set.candles) { if (k.h > high) high = k.h; if (k.l > 0 && k.l < low) low = k.l; }
    onInfo({ high, low: low === Infinity ? 0 : low, first: set.candles[0].o });
  }, [set]);
  const sampled = useMemo(() => c.spark.map((p) => ({ t: p.t, o: p.p, h: p.p, l: p.p, c: p.p, v: 0 })), [c.spark.length, c.updatedAt]);

  return (
    <div className="chart-panel">
      {shown && (set || !err) ? (
        <div className={`chart-stage${loading ? ' is-loading' : ''}`}>
          <LwChart candles={shown.candles} type={type} intervalMs={shownIv.ms} dataKey={setKey(shown.coinId, shown.pool, shown.range, shown.interval)} tick={tick} entry={entry} supply={supply} showMcap={axis === 'mcap' && supply > 0} height={height} />
          {loading && <div className="chart-loading" role="status"><span className="spin" />{rangeSpec.label} · {iv.label}</div>}
        </div>
      ) : err ? (
        <div className="chart-empty" style={{ minHeight: height }}>
          <p className="muted">Candles unavailable: {err}</p>
          {sampled.length > 1 && <PriceChart candles={sampled} mode="line" entry={entry} supply={supply} showMcap={axis === 'mcap' && supply > 0} stepMs={60_000} />}
          {sampled.length > 1 && <p className="muted small">Showing prices BAGZ sampled this session, not exchange candles.</p>}
          <button className="chip-btn" onClick={() => fetchNow(true)}>Retry</button>
        </div>
      ) : (
        <div className="chart-empty muted" style={{ minHeight: height }}><span className="spin" />{busy || key ? `Loading ${rangeSpec.label} candles…` : 'Looking for this coin’s trading pool…'}</div>
      )}

      <div className="chart-pills" ref={tfRef}>
        <button className={`cpill cpill-live${isLive ? ' on' : ''}`} aria-pressed={isLive} onClick={goLive}><span className="live-dot" />Live</button>
        <button className={`cpill tf-btn${tf ? ' open' : ''}${!isLive ? ' on' : ''}`} aria-expanded={tf} aria-haspopup="true" aria-label={`Timeframe ${rangeSpec.label}, ${iv.label} candles`} onClick={() => { setTf((x) => !x); setSettings(false); }}>
          <span className="tf-range">{rangeSpec.label}</span><span className="tf-iv">{iv.label}</span><Icon.chevDown size={14} className="tf-caret" />
        </button>
        <span className="grow" />
        {holders !== undefined && <button className="cpill cpill-plain num" onClick={onHolders} aria-label={`Holders ${holders.toLocaleString()}`}>Holders {holders >= 10_000 ? compact(holders).replace('$', '') : holders.toLocaleString()}</button>}
        <button className={`icon-btn icon-btn-sm chart-gear${settings ? ' on' : ''}`} aria-label="Chart settings" aria-expanded={settings} onClick={() => { setSettings((x) => !x); setTf(false); }}><Icon.tune size={18} /></button>
        {tf && (
          <div className="tf-menu" role="dialog" aria-label="Choose timeframe">
            <div className="tf-label small muted">Timeframe</div>
            <div className="tf-grid">
              {ranges.map((r) => (
                <button key={r.id} className={`tf-chip${r.id === range ? ' on' : ''}${r.id === 'ALL' ? ' tf-all' : ''}`} aria-pressed={r.id === range} onClick={() => pickRange(r.id)}>{r.label}</button>
              ))}
            </div>
            <div className="tf-label small muted">Candles</div>
            <div className="tf-grid">
              {rangeSpec.intervals.map((i) => (
                <button key={i} className={`tf-chip${i === interval ? ' on' : ''}`} aria-pressed={i === interval} onClick={() => { pickIv(i); setTf(false); }}>{INTERVALS[i].label}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      {settings && (
        <div className="toolbar chart-settings">
          <Seg label="Chart type" value={type} onChange={pickType} options={[{ v: 'candles', l: 'Candles' }, { v: 'line', l: 'Line' }, { v: 'area', l: 'Area' }]} />
          <Seg label="Chart axis" value={axis === 'mcap' && supply > 0 ? 'mcap' : 'price'} onChange={pickAxis} options={[{ v: 'price', l: 'Price' }, { v: 'mcap', l: 'MCap' }]} />
        </div>
      )}

      <div className="chart-meta small muted">
        {set && (
          <>
            <span>{rangeSpec.label} · {iv.label} candles · {set.candles.length} loaded</span>
            <span>GeckoTerminal pool <a className="link" target="_blank" rel="noopener noreferrer" href={`https://www.geckoterminal.com/${GT_NETWORK[c.chain]}/pools/${set.pool}`}>{short(set.pool)}</a>{c.dexId ? ` (${c.dexId})` : ''}</span>
            <span className={set.stale ? 'warn' : ''}>{set.stale ? 'STALE · last good fetch ' : 'fetched '}{ago(set.fetchedAt)} ago</span>
          </>
        )}
        {busy && set && <span>refreshing…</span>}
      </div>
      {set?.partial && <p className="chart-note small muted">This pool is younger than {rangeSpec.label}, so the chart shows all history that exists. Intervals with no trades have no candle.</p>}
      {set && gap > 0.03 && <p className="chart-note small warn">Chart pool price ({fmtPrice(lastClose)}) differs from the quoted price ({fmtPrice(c.price)}) by {(gap * 100).toFixed(1)}%. They come from different pools or moments.</p>}
      {set && set.dropped > 0 && <p className="chart-note small muted">{set.dropped} malformed candle{set.dropped > 1 ? 's were' : ' was'} dropped from the provider response.</p>}
      {set && !set.baseVerified && <p className="chart-note small muted">GeckoTerminal did not confirm which token these candles are priced in.</p>}
      {set && set.suspicious > 0 && <p className="chart-note small warn">{set.suspicious} candle{set.suspicious > 1 ? 's have' : ' has'} an extreme wick (&gt;40×). It may be a bad print on a thin pool.</p>}
    </div>
  );
}
