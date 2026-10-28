import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Holder } from './types';
import { fitLayout, MIN_TAP_PX } from './layout';
import { nodeIdOwner, type Graph, type GraphEdge } from './graph';
import { compactUnits, pctText, shortAddr } from './units';

const PROGRAM_KINDS = new Set(['pda', 'program']);
const SAT_R = { owner: 11, unknown_account: 9 } as const;

/**
 * Bubble map of the holder snapshot. Area ∝ included balance (see layout.ts for the documented minimum size).
 * Lines appear only for transfers the user loaded: solid = both owners resolved, dotted = one end is a token account
 * whose owner is unknown. Every bubble and line is keyboard-focusable; the table view is the full text alternative.
 */
export function HolderMap({ holders, decimals, graph, selected, onSelect, selectedEdge, onSelectEdge }: {
  holders: Holder[]; decimals: number; graph: Graph;
  selected: string | null; onSelect: (owner: string) => void;
  selectedEdge: string | null; onSelectEdge: (id: string | null) => void;
}) {
  const sats = useMemo(() => graph.nodes.filter((n) => n.kind !== 'holder').map((n) => ({ id: n.id, r: SAT_R[n.kind as 'owner' | 'unknown_account'] })), [graph]);
  // the layout depends on the map's width so the smallest bubble stays a usable tap target on phones
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.clientWidth - 16));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout = useMemo(() => fitLayout(holders.map((h) => ({ id: nodeIdOwner(h.owner), amount: h.amount })), sats, width), [holders, sats, width]);
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number; r: number }>();
    for (const b of layout.bubbles) m.set(b.id, b);
    for (const s of layout.satellites) m.set(s.id, s);
    return m;
  }, [layout]);
  const byId = useMemo(() => new Map(holders.map((h) => [nodeIdOwner(h.owner), h])), [holders]);
  const nodeBy = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // zoom/pan: buttons + drag (drag only when zoomed in, so the page still scrolls normally on phones)
  const [z, setZ] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { box } = layout;
  const vw = box.w / z.k, vh = box.h / z.k;
  const vx = box.x + (box.w - vw) / 2 + z.x, vy = box.y + (box.h - vh) / 2 + z.y;
  const zoom = (f: number) => setZ((s) => { const k = Math.min(4, Math.max(1, s.k * f)); return k === 1 ? { k, x: 0, y: 0 } : { ...s, k }; });
  const onDown = (e: React.PointerEvent) => { if (z.k <= 1) return; drag.current = { px: e.clientX, py: e.clientY, x: z.x, y: z.y }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; const el = svgRef.current;
    if (!d || !el) return;
    const scale = vw / Math.max(1, el.clientWidth);
    setZ((s) => ({ ...s, x: d.x - (e.clientX - d.px) * scale, y: d.y - (e.clientY - d.py) * scale }));
  };
  const onUp = () => { drag.current = null; };
  const key = (f: () => void) => (e: { key: string; preventDefault: () => void }) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); f(); } };

  const edgePath = (e: GraphEdge) => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    // bend a little so a→b and b→a don't sit on top of each other; bubbles that (nearly) touch get a wide outside arc,
    // leaving and entering off the centre line, so the arrow stays visible
    const tight = len - a.r - b.r < 30;
    const al = tight ? 0.75 : 0.12, c = Math.cos(al), s = Math.sin(al);
    const sx = ux * c + nx * s, sy = uy * c + ny * s; // u turned toward the normal
    const ex = -ux * c + nx * s, ey = -uy * c + ny * s; // −u turned toward the normal
    const x1 = a.x + sx * (a.r + 2), y1 = a.y + sy * (a.r + 2), x2 = b.x + ex * (b.r + 6), y2 = b.y + ey * (b.r + 6);
    const bend = tight ? Math.max(a.r, b.r) * 0.6 + 26 : Math.min(24, len * 0.12);
    const mx = (x1 + x2) / 2 + nx * bend, my = (y1 + y2) / 2 + ny * bend;
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };
  const edgeLabel = (e: GraphEdge) => {
    const name = (id: string) => { const h = byId.get(id); if (h) return `holder #${h.rank}`; const n = nodeBy.get(id); return n?.kind === 'unknown_account' ? `unknown token account ${shortAddr(n.account || '')}` : `wallet ${shortAddr(n?.owner || '')} outside the snapshot`; };
    return `${e.events.length} transfer${e.events.length > 1 ? 's' : ''} from ${name(e.from)} to ${name(e.to)}, ${compactUnits(e.total, decimals)} tokens${e.evidence === 'account' ? ', owner of one side unresolved' : ''}${e.context !== 'top_level' ? ', inside another program' : ''}`;
  };

  return (
    <div className="inv-map" ref={wrap}>
      <div className="inv-map-tools" role="toolbar" aria-label="Map zoom">
        <button className="icon-btn icon-btn-sm" onClick={() => zoom(1.4)} aria-label="Zoom in">+</button>
        <button className="icon-btn icon-btn-sm" onClick={() => zoom(1 / 1.4)} aria-label="Zoom out" disabled={z.k <= 1}>−</button>
        <button className="chip-btn inv-fit" onClick={() => setZ({ k: 1, x: 0, y: 0 })} disabled={z.k === 1}>Fit</button>
      </div>
      <svg
        ref={svgRef} className={`inv-svg${z.k > 1 ? ' zoomed' : ''}`} viewBox={`${vx} ${vy} ${vw} ${vh}`} role="group"
        aria-label={`Holder bubble map: ${holders.length} owners from the largest token accounts. Bubble area is proportional to the included balance.`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      >
        <defs>
          <marker id="inv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="inv-arrowhead" /></marker>
          <marker id="inv-arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="inv-arrowhead-muted" /></marker>
        </defs>
        <g className="inv-edges">
          {graph.edges.map((e) => {
            const d = edgePath(e);
            if (!d) return null;
            const on = selectedEdge === e.id;
            const muted = e.evidence === 'account' || e.context !== 'top_level';
            return (
              <g key={e.id} className={`inv-edge ${e.evidence === 'account' ? 'inv-edge-acct' : e.context === 'top_level' ? 'inv-edge-direct' : 'inv-edge-inner'}${on ? ' on' : ''}`}
                role="button" tabIndex={0} aria-pressed={on} aria-label={edgeLabel(e)}
                onClick={() => onSelectEdge(on ? null : e.id)} onKeyDown={key(() => onSelectEdge(on ? null : e.id))}>
                <path d={d} className="inv-edge-hit" />
                <path d={d} className="inv-edge-line" markerEnd={`url(#${muted ? 'inv-arrow-muted' : 'inv-arrow'})`} />
              </g>
            );
          })}
        </g>
        <g className="inv-bubbles">
          {layout.bubbles.map((b) => {
            const h = byId.get(b.id);
            if (!h) return null;
            const isSel = selected === h.owner;
            const prog = PROGRAM_KINDS.has(h.ownerKind.kind);
            const label = `Holder ${h.rank}: ${h.owner}. ${pctText(h.percent, h.percentBelowDisplay)} of supply from ${h.accounts.length} token account${h.accounts.length > 1 ? 's' : ''}. ${h.ownerKind.label}.${b.minSized ? ' Drawn at minimum size, not to scale.' : ''}`;
            return (
              <g key={b.id} transform={`translate(${b.x.toFixed(1)},${b.y.toFixed(1)})`} className={`inv-bubble${isSel ? ' on' : ''}${prog ? ' prog' : ''}`}
                role="button" tabIndex={0} aria-pressed={isSel} aria-label={label} onClick={() => onSelect(h.owner)} onKeyDown={key(() => onSelect(h.owner))}>
                {b.minSized && <circle r={b.r + 3.5} className="inv-minring" />}
                <circle r={b.r} className="inv-dot" />
                {b.r >= 26 ? (
                  <>
                    <text y={b.r >= 40 ? -10 : -2} className="inv-t-rank">#{h.rank}</text>
                    <text y={b.r >= 40 ? 6 : 12} className="inv-t-pct">{pctText(h.percent, h.percentBelowDisplay, 1)}</text>
                    {b.r >= 40 && <text y={21} className="inv-t-addr">{shortAddr(h.owner)}</text>}
                  </>
                ) : <text y={4} className="inv-t-rank inv-t-sm">{h.rank}</text>}
              </g>
            );
          })}
        </g>
        <g className="inv-sats">
          {layout.satellites.map((s) => {
            const n = nodeBy.get(s.id);
            if (!n) return null;
            const unknown = n.kind === 'unknown_account';
            return (
              <g key={s.id} transform={`translate(${s.x.toFixed(1)},${s.y.toFixed(1)})`} className={`inv-sat${unknown ? ' unknown' : ''}`}>
                <title>{unknown ? `Unknown token account ${n.account} (owner not resolved)` : `Wallet ${n.owner} (not among the largest token accounts)`}</title>
                {unknown ? <rect x={-s.r} y={-s.r} width={s.r * 2} height={s.r * 2} rx={3} /> : <circle r={s.r} />}
                <text y={unknown ? 4 : 4} className="inv-t-sat">{unknown ? '?' : ''}</text>
                <text y={s.r + 12} className="inv-t-satlbl">{shortAddr(unknown ? n.account || '' : n.owner || '', 3)}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <ul className="inv-legend small muted" aria-label="Map legend">
        <li><i className="lg-dot" />Owner (key-pair or not checked)</li>
        <li><i className="lg-dot prog" />Program-controlled address</li>
        <li><i className="lg-min" />Enlarged to the minimum size (≥{MIN_TAP_PX}px), not to scale</li>
        <li><i className="lg-line" />Token transfer, both owners resolved</li>
        <li><i className="lg-line inner" />Transfer inside another program (e.g. a swap)</li>
        <li><i className="lg-line acct" />Owner of one side unresolved</li>
        <li><i className="lg-sq" />Unknown token account</li>
      </ul>
    </div>
  );
}
