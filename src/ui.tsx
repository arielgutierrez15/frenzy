import { BADGE_SRC } from './brand';
import React, { useEffect, useRef, useState } from 'react';
import type { Candle, Coin } from './types';
import { price as fmtPrice, compact, clock } from './format';

// ---------- icons (inline, stroke-based) ----------
type IP = { size?: number; className?: string };
const I = (d: React.ReactNode) => ({ size = 18, className }: IP) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{d}</svg>
);
export const Icon = {
  home: I(<><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" /></>),
  feed: I(<><path d="M4 6h16M4 12h10M4 18h7" /><circle cx="18" cy="16" r="3" /></>),
  radar: I(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><path d="M12 12l6-6" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /></>),
  wallet: I(<><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18M16 14.5h2" /></>),
  trophy: I(<><path d="M8 4h8v5a4 4 0 0 1-8 0V4z" /><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8" /></>),
  bell: I(<><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></>),
  back: I(<path d="M15 5l-7 7 7 7" />),
  close: I(<path d="M6 6l12 12M18 6L6 18" />),
  heart: I(<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />),
  copy: I(<><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>),
  bolt: I(<path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z" />),
  shield: I(<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z" />),
  warn: I(<><path d="M12 4l9 16H3l9-16z" /><path d="M12 10v4M12 17.2v.1" /></>),
  check: I(<path d="M5 12.5l4.5 4.5L19 7.5" />),
  plus: I(<path d="M12 5v14M5 12h14" />),
  share: I(<><path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></>),
  filter: I(<path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5z" />),
  card: I(<><rect x="3" y="5" width="14" height="16" rx="2.5" /><path d="M7 3h11a3 3 0 0 1 3 3v12" /><path d="M6.5 16l3-4 2.5 2 3-4.5" /></>),
  chat: I(<><path d="M4 5h16v11H9l-5 4V5z" /><path d="M8 9.5h8M8 12.5h5" /></>),
  users: I(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 4 6" /></>),
  chart: I(<><path d="M4 19V5M4 19h16" /><path d="M8 15l4-5 3 3 5-7" /></>),
  flame: I(<path d="M12 21c4 0 7-2.7 7-6.6 0-3.4-2.3-5.5-3.6-7.4-.4 2-1.5 3.2-2.6 3.4.3-2.6-.6-5.7-3.3-7.4.2 3-1.8 5-3.3 7A7 7 0 0 0 5 14.4C5 18.3 8 21 12 21z" />),
  reset: I(<><path d="M4 12a8 8 0 1 0 2.3-5.7" /><path d="M4 4v4.5h4.5" /></>),
  external: I(<><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>),
};

// ---------- avatars & coin badges ----------
function hueOf(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export function CoinBadge({ coin, size = 36 }: { coin: Coin; size?: number }) {
  const [broken, setBroken] = useState(false);
  const h = hueOf(coin.address);
  const letters = coin.symbol.replace(/[^A-Z0-9]/gi, '').slice(0, coin.symbol.length > 4 ? 2 : 3).toUpperCase() || '?';
  return (
    <span
      className="coin-badge"
      style={{ width: size, height: size, fontSize: size * (letters.length > 2 ? 0.3 : 0.36), background: `linear-gradient(140deg, hsl(${h} 70% 58%), hsl(${(h + 40) % 360} 65% 42%))` }}
      aria-hidden="true"
    >
      {coin.icon && !broken ? <img src={coin.icon} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : letters}
      {coin.rugged && <span className="coin-badge-x" />}
    </span>
  );
}

export function Avatar({ wallet, size = 36, you = false }: { wallet?: string; size?: number; you?: boolean }) {
  const hue = you ? 0 : hueOf(wallet || '?');
  const initial = you ? 'Y' : (wallet || '?').slice(0, 2);
  return (
    you
      ? <img className="avatar avatar-you" src={BADGE_SRC} width={size} height={size} style={{ width: size, height: size }} alt="" aria-hidden="true" />
      : <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.32, ['--h' as any]: hue }} aria-hidden="true">{initial}</span>
  );
}

export function Change({ v, className = '' }: { v: number; className?: string }) {
  const t = v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : 'flat';
  const s = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}K%` : `${v > 0 ? '+' : ''}${v.toFixed(Math.abs(v) >= 100 ? 0 : 1)}%`;
  return <span className={`chg chg-${t} num ${className}`}>{s}</span>;
}

export function ScoreRing({ score, size = 44 }: { score: number; size?: number }) {
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const tier = score >= 75 ? 'up' : score >= 50 ? 'warn' : 'down';
  return (
    <span className={`score score-${tier}`} style={{ width: size, height: size }} title={`Gem Score ${score} of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={3.5} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={3.5} strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <b className="num">{score}</b>
    </span>
  );
}

export function Spark({ points, width = 84, height = 30 }: { points: number[]; width?: number; height?: number }) {
  const pts = points.slice(-40);
  if (pts.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...pts), hi = Math.max(...pts);
  const span = hi - lo || hi * 0.01 || 1;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * width).toFixed(1)},${(height - 2 - ((p - lo) / span) * (height - 4)).toFixed(1)}`).join('');
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={up ? 'spark spark-up' : 'spark spark-down'} aria-hidden="true">
      <path d={`${d}L${width},${height}L0,${height}Z`} className="spark-fill" />
      <path d={d} fill="none" className="spark-line" strokeWidth={1.6} />
    </svg>
  );
}

// ---------- responsive width hook ----------
export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((e) => setW(Math.max(200, Math.floor(e[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref as React.RefObject<T>, w];
}

// ---------- price chart ----------
function axisTime(t: number, stepMs: number) {
  const d = new Date(t);
  if (stepMs >= 86_400_000) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  if (stepMs >= 3_600_000) return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric' });
  return clock(t);
}

export function PriceChart({ candles, mode, entry, height = 340, supply, showMcap, stepMs = 60_000 }: { candles: Candle[]; mode: 'candles' | 'line'; entry?: number; height?: number; supply: number; showMcap: boolean; stepMs?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const data = candles.slice(-Math.max(20, Math.floor(width / 6)));
  const padR = 78, padB = 24, padT = 12;
  const W = width, H = height;
  const plotW = W - padR, plotH = H - padB - padT;
  const volH = plotH * 0.2;
  const priceH = plotH - volH - 6;
  let lo = Math.min(...data.map((c) => c.l)), hi = Math.max(...data.map((c) => c.h));
  const rangeLo = lo, rangeHi = hi;
  if (entry && entry > 0 && entry > lo * 0.5 && entry < hi * 2) { lo = Math.min(lo, entry); hi = Math.max(hi, entry); }
  if (hi === lo) { hi *= 1.01; lo *= 0.99; }
  const pad = (hi - lo) * 0.08; hi += pad; lo -= pad;
  const y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * priceH;
  const slot = plotW / data.length;
  const x = (i: number) => i * slot + slot / 2;
  const vmax = Math.max(...data.map((c) => c.v), 1);
  const ticks = 5;
  const last = data[data.length - 1];
  const label = (p: number) => (showMcap ? compact(p * supply) : fmtPrice(p));
  const lineD = data.map((c, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(c.c).toFixed(1)}`).join('');
  const up = last && data[0] ? last.c >= data[0].o : true;
  // 20-period simple moving average of closes
  const maN = 20;
  const ma = data.map((_, i) => (i + 1 >= maN ? data.slice(i + 1 - maN, i + 1).reduce((a, k) => a + k.c, 0) / maN : null));
  const maD = ma.map((v, i) => (v === null ? '' : `${ma[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`)).join('');
  const hiIdx = data.findIndex((c) => c.h === rangeHi), loIdx = data.findIndex((c) => c.l === rangeLo);
  const change = data.length ? (last.c / data[0].o - 1) * 100 : 0;
  const hv = hover !== null ? data[hover] : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    if (px > plotW) return setHover(null);
    setHover(Math.max(0, Math.min(data.length - 1, Math.floor(px / slot))));
  };
  const every = Math.ceil(data.length / Math.max(2, Math.floor(plotW / 110)));
  return (
    <div ref={ref} className="chart">
      <div className="chart-legend num">
        {hv ? (
          <>
            <span className="muted">{stepMs >= 86_400_000 ? axisTime(hv.t, stepMs) : stepMs >= 3_600_000 ? `${new Date(hv.t).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(hv.t)}` : clock(hv.t)}</span>
            <span>O <b>{label(hv.o)}</b></span><span>H <b>{label(hv.h)}</b></span><span>L <b>{label(hv.l)}</b></span>
            <span>C <b className={hv.c >= hv.o ? 'up' : 'down'}>{label(hv.c)}</b></span><span>Vol <b>{compact(hv.v)}</b></span>
          </>
        ) : (
          <>
            <span>Range <b className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '+' : ''}{change.toFixed(2)}%</b></span>
            <span>High <b>{label(rangeHi)}</b></span><span>Low <b>{label(rangeLo)}</b></span>
            <span>Vol <b>{compact(data.reduce((a, k) => a + k.v, 0))}</b></span>
            <span className="ma-key">MA20</span>
          </>
        )}
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price chart" onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const p = lo + ((hi - lo) * i) / ticks;
          return (
            <g key={i}>
              <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} className="grid" />
              <text x={plotW + 8} y={y(p) + 4} className="axis num">{label(p)}</text>
            </g>
          );
        })}
        {data.map((c, i) => (i % every === 0 && i > 0 ? (
          <g key={'t' + i}>
            <line x1={x(i)} x2={x(i)} y1={padT} y2={padT + plotH} className="grid grid-v" />
            <text x={x(i)} y={H - 6} className="axis num" textAnchor="middle">{axisTime(c.t, stepMs)}</text>
          </g>
        ) : null))}
        {data.map((c, i) => (
          <rect key={'v' + i} x={x(i) - slot * 0.35} width={Math.max(1, slot * 0.7)} y={padT + plotH - (c.v / vmax) * volH} height={(c.v / vmax) * volH} className={c.c >= c.o ? 'vol vol-up' : 'vol vol-down'} />
        ))}
        {mode === 'candles' ? data.map((c, i) => {
          const upC = c.c >= c.o;
          const top = y(Math.max(c.o, c.c)), bot = y(Math.min(c.o, c.c));
          return (
            <g key={i} className={upC ? 'cdl cdl-up' : 'cdl cdl-down'}>
              <line x1={x(i)} x2={x(i)} y1={y(c.h)} y2={y(c.l)} strokeWidth={1} />
              <rect x={x(i) - Math.max(1, slot * 0.32)} width={Math.max(2, slot * 0.64)} y={top} height={Math.max(1, bot - top)} />
            </g>
          );
        }) : (
          <g className={up ? 'line-up' : 'line-down'}>
            <path d={`${lineD}L${x(data.length - 1)},${padT + priceH}L${x(0)},${padT + priceH}Z`} className="area" />
            <path d={lineD} fill="none" strokeWidth={2} className="stroke" />
          </g>
        )}
        {maD && <path d={maD} fill="none" className="ma" strokeWidth={1.4} />}
        {hiIdx >= 0 && <text x={Math.min(plotW - 4, Math.max(4, x(hiIdx)))} y={y(rangeHi) - 6} className="axis hl" textAnchor="middle">H {label(rangeHi)}</text>}
        {loIdx >= 0 && <text x={Math.min(plotW - 4, Math.max(4, x(loIdx)))} y={y(rangeLo) + 14} className="axis hl" textAnchor="middle">L {label(rangeLo)}</text>}
        {entry && entry > 0 && entry >= lo && entry <= hi && (
          <g className="entry">
            <line x1={0} x2={plotW} y1={y(entry)} y2={y(entry)} strokeDasharray="4 4" />
            <text x={6} y={y(entry) - 5} className="axis-strong">Your entry {label(entry)}</text>
          </g>
        )}
        {last && (
          <g className="lastp">
            <line x1={0} x2={plotW} y1={y(last.c)} y2={y(last.c)} strokeDasharray="2 3" />
            <rect x={plotW + 2} y={y(last.c) - 10} width={padR - 4} height={20} rx={4} />
            <text x={plotW + 8} y={y(last.c) + 4} className="num">{label(last.c)}</text>
          </g>
        )}
        {hv && hover !== null && (
          <g className="xhair">
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} />
            <line x1={0} x2={plotW} y1={y(hv.c)} y2={y(hv.c)} />
            <rect x={plotW + 2} y={y(hv.c) - 10} width={padR - 4} height={20} rx={4} />
            <text x={plotW + 8} y={y(hv.c) + 4} className="num">{label(hv.c)}</text>
          </g>
        )}
      </svg>
    </div>
  );
}

// ---------- equity chart ----------
export function EquityChart({ points, base, height = 180 }: { points: { t: number; v: number }[]; base: number; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const data = points.length > 1 ? points : [{ t: Date.now() - 60000, v: base }, ...(points.length ? points : [{ t: Date.now(), v: base }])];
  const padR = 64, padB = 20, padT = 8;
  const W = width, H = height, plotW = W - padR, plotH = H - padB - padT;
  let lo = Math.min(base, ...data.map((p) => p.v)), hi = Math.max(base, ...data.map((p) => p.v));
  if (hi - lo < base * 0.002) { hi += base * 0.002; lo -= base * 0.002; }
  const pad = (hi - lo) * 0.1; hi += pad; lo -= pad;
  const t0 = data[0].t, t1 = data[data.length - 1].t || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  const d = data.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const up = data[data.length - 1].v >= base;
  const lastP = data[data.length - 1];
  return (
    <div ref={ref} className="chart">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Portfolio value over time" className={up ? 'line-up' : 'line-down'}>
        {[lo + (hi - lo) * 0.15, (lo + hi) / 2, hi - (hi - lo) * 0.15].map((v, i) => (
          <g key={i}><line x1={0} x2={plotW} y1={y(v)} y2={y(v)} className="grid" /><text x={plotW + 8} y={y(v) + 4} className="axis num">{hi - lo < 2000 ? '$' + Math.round(v).toLocaleString('en-US') : compact(v)}</text></g>
        ))}
        <line x1={0} x2={plotW} y1={y(base)} y2={y(base)} className="baseline" strokeDasharray="4 4" />
        <text x={4} y={y(base) - 5} className="axis">Deposited</text>
        <path d={`${d}L${x(t1)},${padT + plotH}L0,${padT + plotH}Z`} className="area" />
        <path d={d} fill="none" strokeWidth={2} className="stroke" />
        <circle cx={x(lastP.t)} cy={y(lastP.v)} r={4} className="dot" />
        <text x={2} y={H - 4} className="axis num">{clock(t0)}</text>
        <text x={plotW} y={H - 4} className="axis num" textAnchor="end">{clock(t1)}</text>
      </svg>
    </div>
  );
}
