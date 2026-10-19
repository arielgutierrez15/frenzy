import React, { useEffect, useRef, useState } from 'react';
import type { Candle } from '../types';
import { getLwc } from './lwc';
import type { Chart, LwcModule, Marker, PriceLine, Series } from './lwc-types';
import { applyLiveTick, type ChartType, type Tick } from './data';
import { compact, price as fmtPrice } from '../format';
import { PriceChart } from '../ui';

export interface LwChartProps {
  candles: Candle[];
  type: ChartType;
  intervalMs: number;
  /** identity of the data set (coin + pool + range + interval); the view re-fits when it changes */
  dataKey: string;
  tick?: Tick;
  entry?: number;
  supply?: number;
  showMcap?: boolean;
  showVolume?: boolean;
  height?: number;
}

const css = (n: string, fb: string) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb; } catch { return fb; }
};
const withAlpha = (hex: string, a: number) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
/** decimals needed to show ~4 significant digits of a small price */
export function precisionFor(p: number): number {
  if (!(p > 0)) return 4;
  return Math.min(12, Math.max(2, Math.ceil(-Math.log10(p)) + 3));
}
const sec = (ms: number) => Math.floor(ms / 1000);

interface Hover { t: number; o: number; h: number; l: number; c: number; v: number }

export function LwChart(props: LwChartProps) {
  const { candles, type, intervalMs, dataKey, tick, entry, supply, showMcap, showVolume = true, height = 360 } = props;
  const [lib, setLib] = useState<LwcModule | null | 'loading'>('loading');
  const [hover, setHover] = useState<Hover | null>(null);
  const [seriesVer, setSeriesVer] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const main = useRef<Series | null>(null);
  const vol = useRef<Series | null>(null);
  const lines = useRef<PriceLine[]>([]);
  const lastKey = useRef('');
  const live = useRef<Candle[]>(candles);
  const byTime = useRef(new Map<number, Candle>());

  const scale = showMcap && supply && supply > 0 ? supply : 1;
  const prec = showMcap ? 0 : precisionFor(candles.length ? candles[candles.length - 1].c : 0);
  const unit = (x: number) => x * scale;
  const fmt = (x: number) => (showMcap ? compact(x) : fmtPrice(x));

  useEffect(() => { let on = true; getLwc().then((m) => { if (on) setLib(m); }); return () => { on = false; }; }, []);

  // ---- chart instance --------------------------------------------------
  useEffect(() => {
    if (!lib || lib === 'loading' || !box.current) return;
    const el = box.current;
    const fg = css('--muted', '#9a9aa5'), grid = css('--line', '#26262c');
    const ch = lib.createChart(el, {
      width: el.clientWidth, height,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: fg, fontFamily: css('--f-num', 'ui-monospace, monospace'), fontSize: 11 },
      grid: { vertLines: { color: withAlpha('#ffffff', 0.04) }, horzLines: { color: withAlpha('#ffffff', 0.05) } },
      rightPriceScale: { borderColor: grid, scaleMargins: { top: 0.08, bottom: 0.06 } },
      timeScale: {
        borderColor: grid, timeVisible: true, secondsVisible: false, rightOffset: 4, minBarSpacing: 1.5,
        tickMarkFormatter: (t: number, kind: number) => {
          const d = new Date(t * 1000);
          return kind >= 3 ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        },
      },
      localization: { timeFormatter: (t: number) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) },
      crosshair: { mode: 0, vertLine: { color: css('--accent', '#ff008c'), width: 1, style: 3, labelBackgroundColor: css('--accent', '#ff008c') }, horzLine: { color: css('--accent', '#ff008c'), width: 1, style: 3, labelBackgroundColor: css('--accent', '#ff008c') } },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });
    chart.current = ch;
    const onMove = (p: { time?: number }) => setHover(p.time !== undefined ? byTime.current.get(p.time * 1000) ?? null : null);
    ch.subscribeCrosshairMove(onMove as any);
    const ro = new ResizeObserver(() => ch.resize(el.clientWidth, height));
    ro.observe(el);
    return () => { ro.disconnect(); try { ch.unsubscribeCrosshairMove(onMove as any); } catch { /* ignore */ } ch.remove(); chart.current = null; main.current = null; vol.current = null; lines.current = []; lastKey.current = ''; };
  }, [lib, height]);

  // ---- series (recreated only when the type or volume option changes) ---
  useEffect(() => {
    const ch = chart.current;
    if (!ch) return;
    if (main.current) ch.removeSeries(main.current);
    if (vol.current) ch.removeSeries(vol.current);
    main.current = vol.current = null; lines.current = [];
    const up = css('--up', '#2be38b'), down = css('--down', '#ff4466'), accent = css('--accent', '#ff008c');
    const priceFormat = showMcap
      ? { type: 'custom', formatter: (x: number) => compact(x), minMove: 1 }
      : { type: 'price', precision: prec, minMove: Math.pow(10, -prec) };
    if (type === 'candles') {
      main.current = ch.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceFormat });
    } else if (type === 'area') {
      main.current = ch.addAreaSeries({ lineColor: accent, topColor: withAlpha(accent, 0.38), bottomColor: withAlpha(accent, 0.02), lineWidth: 2, priceFormat });
    } else {
      main.current = ch.addLineSeries({ color: accent, lineWidth: 2, priceFormat });
    }
    if (showVolume) {
      vol.current = ch.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
      ch.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }
    ch.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: showVolume ? 0.24 : 0.06 } });
    setSeriesVer((v) => v + 1);
  }, [lib, type, showVolume, showMcap, height, prec]);

  // ---- data -------------------------------------------------------------
  const point = (k: Candle) => (type === 'candles'
    ? { time: sec(k.t), open: unit(k.o), high: unit(k.h), low: unit(k.l), close: unit(k.c) }
    : { time: sec(k.t), value: unit(k.c) });
  const volPoint = (k: Candle) => ({ time: sec(k.t), value: k.v, color: withAlpha(k.c >= k.o ? css('--up', '#2be38b') : css('--down', '#ff4466'), 0.45) });

  useEffect(() => {
    const ch = chart.current, s = main.current;
    if (!ch || !s) return;
    live.current = candles;
    byTime.current = new Map(candles.map((k) => [k.t, k]));
    s.setData(candles.map(point));
    vol.current?.setData(candles.map(volPoint));
    // high / low markers over the whole loaded range
    if (candles.length > 2) {
      let hi = candles[0], lo = candles[0];
      for (const k of candles) { if (k.h > hi.h) hi = k; if (k.l < lo.l) lo = k; }
      const ms: Marker[] = [];
      if (type === 'candles') {
        ms.push({ time: sec(hi.t), position: 'aboveBar', color: css('--muted', '#9a9aa5'), shape: 'arrowDown', text: `H ${fmt(unit(hi.h))}` });
        ms.push({ time: sec(lo.t), position: 'belowBar', color: css('--muted', '#9a9aa5'), shape: 'arrowUp', text: `L ${fmt(unit(lo.l))}` });
      } else {
        const hc = candles.reduce((a, k) => (k.c > a.c ? k : a), candles[0]);
        const lc = candles.reduce((a, k) => (k.c < a.c ? k : a), candles[0]);
        ms.push({ time: sec(hc.t), position: 'aboveBar', color: css('--muted', '#9a9aa5'), shape: 'arrowDown', text: `H ${fmt(unit(hc.c))}` });
        ms.push({ time: sec(lc.t), position: 'belowBar', color: css('--muted', '#9a9aa5'), shape: 'arrowUp', text: `L ${fmt(unit(lc.c))}` });
      }
      s.setMarkers(ms.sort((a, b) => a.time - b.time).filter((m, i, arr) => i === 0 || m.time !== arr[i - 1].time));
    } else s.setMarkers([]);
    // entry price line for an open paper position
    lines.current.forEach((l) => { try { s.removePriceLine(l); } catch { /* ignore */ } });
    lines.current = [];
    if (entry && entry > 0) lines.current.push(s.createPriceLine({ price: unit(entry), color: css('--accent-fg', '#ff4fae'), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Entry' }));
    const key = `${dataKey}|${showMcap ? 'm' : 'p'}`;
    if (lastKey.current !== key) { lastKey.current = key; ch.timeScale().fitContent(); }
  }, [seriesVer, candles, dataKey, entry, scale]);

  // ---- live tick: update the newest candle with a real recent price ------
  useEffect(() => {
    const s = main.current;
    if (!s || !candles.length) return;
    const r = applyLiveTick(candles, tick, intervalMs, Date.now());
    if (!r.changed) return;
    live.current = r.candles;
    const k = r.candles[r.candles.length - 1];
    byTime.current.set(k.t, k);
    s.update(point(k));
    vol.current?.update(volPoint(k));
  }, [tick?.price, tick?.at, candles, intervalMs]);

  const last = live.current[live.current.length - 1];
  const shown = hover ?? last;
  const chg = shown ? ((shown.c / shown.o - 1) * 100) : 0;

  if (lib === null) {
    return (
      <div className="lw-fallback">
        <p className="muted small">TradingView Lightweight Charts couldn’t load, so this is the basic chart.</p>
        <PriceChart candles={candles} mode={type === 'candles' ? 'candles' : 'line'} entry={entry} supply={supply ?? 0} showMcap={!!showMcap} stepMs={intervalMs} height={height} />
      </div>
    );
  }
  return (
    <div className="lw">
      <div className="lw-legend num" aria-live="off">
        {shown ? (
          <>
            <span className="muted">{new Date(shown.t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            {type === 'candles' ? (
              <>
                <span>O <b>{fmt(unit(shown.o))}</b></span><span>H <b>{fmt(unit(shown.h))}</b></span>
                <span>L <b>{fmt(unit(shown.l))}</b></span><span>C <b>{fmt(unit(shown.c))}</b></span>
              </>
            ) : <span>Close <b>{fmt(unit(shown.c))}</b></span>}
            <span className={chg >= 0 ? 'up' : 'down'}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
            <span>Vol <b>{compact(shown.v)}</b></span>
          </>
        ) : <span className="muted">Loading chart…</span>}
      </div>
      <div ref={box} className="lw-box" style={{ height }} data-testid="lw-box" />
      <div className="lw-tools">
        <button className="chip-btn" onClick={() => chart.current?.timeScale().fitContent()}>Fit</button>
        <button className="chip-btn" onClick={() => chart.current?.timeScale().scrollToRealTime()}>Latest</button>
        <span className="muted small">Scroll or pinch to zoom · drag to pan</span>
      </div>
      {lib === 'loading' && <div className="lw-loading muted small">Loading chart library…</div>}
    </div>
  );
}
