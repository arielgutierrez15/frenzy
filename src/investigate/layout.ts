/**
 * Bubble layout for the holder map. Bubble AREA is proportional to the owner's included balance (radius ∝ √amount),
 * computed from the exact integers. Documented minimum: a bubble is never drawn smaller than MIN_R drawing units, and
 * fitLayout keeps that at ≥ MIN_TAP_PX (24 px, WCAG 2.5.8) on screen; bubbles enlarged to the minimum are flagged so the
 * map can mark them as "not to scale".
 * Placement is deterministic (same input → same picture): largest first, each on an outward spiral at the first spot
 * that overlaps nothing.
 */
export const MIN_R = 14;
export const MAX_R = 64;
const GAP = 4;

export interface Bubble { id: string; x: number; y: number; r: number; minSized: boolean }
export interface Satellite { id: string; x: number; y: number; r: number }
export interface Layout { bubbles: Bubble[]; satellites: Satellite[]; box: { x: number; y: number; w: number; h: number } }

/** √(amount / max) using integer division first, so huge raw amounts don't lose precision before the ratio */
export function radiusFor(amount: string, max: string, maxR = MAX_R): { r: number; minSized: boolean } {
  const a = BigInt(amount), m = BigInt(max);
  if (m <= 0n || a <= 0n) return { r: MIN_R, minSized: true };
  const ratio = Number((a * 1_000_000_000n) / m) / 1e9;
  const r = maxR * Math.sqrt(ratio);
  return r < MIN_R ? { r: MIN_R, minSized: true } : { r, minSized: false };
}

export function packBubbles(items: { id: string; amount: string }[], satelliteIds: { id: string; r: number }[] = [], maxR = MAX_R): Layout {
  const max = items.reduce((m, x) => (BigInt(x.amount) > m ? BigInt(x.amount) : m), 0n).toString();
  const placed: Bubble[] = [];
  const free = (x: number, y: number, r: number) => placed.every((b) => Math.hypot(b.x - x, b.y - y) >= b.r + r + GAP);
  for (const it of items) {
    const { r, minSized } = radiusFor(it.amount, max, maxR);
    let x = 0, y = 0;
    if (placed.length) {
      // golden-angle spiral: even coverage, deterministic
      for (let i = 1; i < 20000; i++) {
        const t = i * 0.35, d = 2.2 * Math.sqrt(i) * 4;
        x = Math.cos(t) * d; y = Math.sin(t) * d;
        if (free(x, y, r)) break;
      }
    }
    placed.push({ id: it.id, x, y, r, minSized });
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of placed) { x0 = Math.min(x0, b.x - b.r); y0 = Math.min(y0, b.y - b.r); x1 = Math.max(x1, b.x + b.r); y1 = Math.max(y1, b.y + b.r); }
  if (!placed.length) { x0 = -60; y0 = -60; x1 = 60; y1 = 60; }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // nodes outside the snapshot (counterparties) sit on a ring around the cluster
  const ring = Math.max(x1 - cx, y1 - cy, cx - x0, cy - y0) + 46;
  const satellites = satelliteIds.map((s, i) => {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, satelliteIds.length);
    return { id: s.id, r: s.r, x: cx + Math.cos(t) * ring, y: cy + Math.sin(t) * ring };
  });
  for (const s of satellites) { x0 = Math.min(x0, s.x - s.r - 30); y0 = Math.min(y0, s.y - s.r - 18); x1 = Math.max(x1, s.x + s.r + 30); y1 = Math.max(y1, s.y + s.r + 18); }
  const pad = 12;
  return { bubbles: placed, satellites, box: { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 } };
}

/** smallest on-screen bubble diameter the map allows (WCAG 2.5.8 target size minimum) */
export const MIN_TAP_PX = 24;
/** how much the browser shrinks the drawing to fit a box of width × maxHeight (SVG viewBox, "meet") */
export const renderScale = (box: Layout['box'], width: number, maxHeight: number) => Math.min(width / box.w, maxHeight / box.h);

/**
 * Lays the bubbles out for a map `width` CSS px wide (at most `maxHeight` tall). On narrow screens the biggest bubbles get
 * smaller (areas stay proportional among bubbles above the minimum) until the minimum bubble is still ≥ MIN_TAP_PX on screen.
 * Limit: below roughly 300 px of map width (very small phones) the biggest bubbles reach their floor (2 × MIN_R) and the
 * smallest can render a little under 24 px; the zoom buttons and the table view (30 px row buttons) remain available.
 */
export function fitLayout(items: { id: string; amount: string }[], satelliteIds: { id: string; r: number }[], width: number, maxHeight = 460): Layout & { scale: number } {
  let maxR = MAX_R;
  let L = packBubbles(items, satelliteIds, maxR);
  if (!(width > 0)) return { ...L, scale: 1 };
  let s = renderScale(L.box, width, maxHeight);
  while (s * 2 * MIN_R < MIN_TAP_PX && maxR > MIN_R * 2) {
    maxR -= 4;
    L = packBubbles(items, satelliteIds, maxR);
    s = renderScale(L.box, width, maxHeight);
  }
  return { ...L, scale: s };
}
