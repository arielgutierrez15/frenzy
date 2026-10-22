/**
 * BAGZ trading cards: a shareable PNG for the paper wallet, an open position, or a closed trade.
 * Drawn on a canvas from BAGZ's own data and brand art only (no remote images, so the canvas is never tainted and the
 * card can always be exported). Every card says PAPER TRADING: these are simulated results, not real gains.
 */
import wordmarkSrc from '../assets/bagz-wordmark.png';
import markSrc from '../assets/bagz-mark.png';
import badgeSrc from '../assets/bagz-badge.png';

export interface CardData {
  kind: 'wallet' | 'position' | 'trade';
  /** $SYMBOL for coin cards, null for the wallet card */
  symbol: string | null;
  name?: string;
  pnlPct: number;
  pnlUsd: number;
  stats: { label: string; value: string }[];
  /** small line under the PnL, e.g. "Unrealized · held 3h" */
  caption: string;
  /** where the card points people (clean app URL, no Telegram launch data) */
  link: string;
}

export const CARD_W = 1200;
export const CARD_H = 750;
const PINK = '#FF008C', BLACK = '#090909', UP = '#2BE38B', DOWN = '#FF4466', MUTED = '#9A9AA5';
const DISPLAY = "'Bricolage Grotesque', 'Avenir Next', 'Segoe UI', system-ui, sans-serif";
const BODY = "'Figtree', 'Segoe UI', system-ui, sans-serif";
const NUM = "'Martian Mono', ui-monospace, Menlo, Consolas, monospace";

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImg(src: string) {
  if (!imgCache.has(src)) imgCache.set(src, new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }));
  return imgCache.get(src)!;
}
async function fontsReady() {
  try {
    await Promise.race([
      Promise.all([`800 120px ${DISPLAY}`, `600 40px ${NUM}`, `600 30px ${BODY}`].map((f) => document.fonts.load(f))),
      new Promise((r) => setTimeout(r, 1500)),
    ]);
  } catch { /* system fonts are fine */ }
}

export function fmtPct(v: number) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  const s = a >= 1000 ? `${(a / 1000).toFixed(1)}K` : a >= 100 ? a.toFixed(0) : a >= 1 ? a.toFixed(1) : a.toFixed(2);
  return `${v >= 0 ? '+' : '−'}${s}%`;
}
export function fmtUsd(v: number, signed = true) {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e4 ? `$${(a / 1e3).toFixed(1)}K` : `$${a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return signed ? `${v >= 0 ? '+' : '−'}${s}` : s;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, font: (px: number) => string, start: number, maxW: number) {
  let px = start;
  ctx.font = font(px);
  while (px > 24 && ctx.measureText(text).width > maxW) { px -= 4; ctx.font = font(px); }
  return px;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the card and returns it as a PNG blob. */
export async function renderCard(d: CardData, scale = 1): Promise<Blob> {
  await fontsReady();
  const [wordmark, mark, badge] = await Promise.all([loadImg(wordmarkSrc), loadImg(markSrc), loadImg(badgeSrc)]);
  const cv = document.createElement('canvas');
  cv.width = CARD_W * scale; cv.height = CARD_H * scale;
  const ctx = cv.getContext('2d')!;
  ctx.scale(scale, scale);
  const up = d.pnlUsd >= 0;
  const tone = up ? UP : DOWN;

  // background: black with a pink glow (red-tinted when down)
  ctx.fillStyle = BLACK; ctx.fillRect(0, 0, CARD_W, CARD_H);
  const g = ctx.createRadialGradient(CARD_W * 0.92, -60, 40, CARD_W * 0.92, -60, CARD_W * 0.85);
  g.addColorStop(0, up ? 'rgba(255,0,140,0.75)' : 'rgba(255,68,102,0.6)'); g.addColorStop(0.55, 'rgba(255,0,140,0.10)'); g.addColorStop(1, 'rgba(9,9,9,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, CARD_W, CARD_H);
  // the gorilla, big and faint, bottom right
  if (mark) { ctx.save(); ctx.globalAlpha = 0.16; ctx.drawImage(mark, CARD_W - 470, CARD_H - 450, 560, 560); ctx.restore(); }
  // frame
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 2; roundRect(ctx, 14, 14, CARD_W - 28, CARD_H - 28, 34); ctx.stroke();

  // header: wordmark + PAPER TRADING pill
  if (wordmark) { const h = 64; ctx.drawImage(wordmark, 64, 58, (wordmark.width / wordmark.height) * h, h); }
  else { ctx.fillStyle = PINK; ctx.font = `800 64px ${DISPLAY}`; ctx.fillText('bagz', 64, 112); }
  ctx.font = `700 22px ${NUM}`;
  const pill = 'PAPER TRADING';
  const pw = ctx.measureText(pill).width + 44;
  roundRect(ctx, CARD_W - 64 - pw, 66, pw, 48, 24); ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.textBaseline = 'middle'; ctx.fillText(pill, CARD_W - 64 - pw + 22, 91); ctx.textBaseline = 'alphabetic';

  // subject
  const subject = d.symbol ? `$${d.symbol}` : 'My paper wallet';
  const kindLabel = d.kind === 'trade' ? 'CLOSED TRADE' : d.kind === 'position' ? 'OPEN POSITION' : 'ALL TIME';
  ctx.fillStyle = MUTED; ctx.font = `600 24px ${NUM}`; ctx.fillText(kindLabel, 64, 196);
  ctx.fillStyle = '#FFFFFF';
  fitText(ctx, subject, (px) => `800 ${px}px ${DISPLAY}`, 58, 760);
  ctx.fillText(subject, 64, 256);
  if (d.name && d.symbol) {
    const w = ctx.measureText(subject).width;
    ctx.fillStyle = MUTED; ctx.font = `500 30px ${BODY}`;
    const nm = d.name.length > 26 ? d.name.slice(0, 25) + '…' : d.name;
    if (64 + w + 20 + ctx.measureText(nm).width < CARD_W - 80) ctx.fillText(nm, 64 + w + 20, 254);
  }

  // the number
  const big = fmtPct(d.pnlPct);
  ctx.fillStyle = tone;
  fitText(ctx, big, (px) => `800 ${px}px ${DISPLAY}`, 190, CARD_W - 128);
  ctx.fillText(big, 58, 440);
  ctx.font = `600 40px ${NUM}`; ctx.fillStyle = tone;
  const usdTxt = fmtUsd(d.pnlUsd);
  ctx.fillText(usdTxt, 64, 504);
  const usdW = ctx.measureText(usdTxt).width; // measured in the amount's own font, so the caption never overlaps it
  ctx.fillStyle = MUTED; ctx.font = `500 28px ${BODY}`;
  ctx.fillText(d.caption, 64 + usdW + 28, 502);

  // stats row
  const stats = d.stats.slice(0, 3);
  const colW = (CARD_W - 128 - 340) / Math.max(1, stats.length);
  stats.forEach((s, i) => {
    const x = 64 + i * colW;
    ctx.fillStyle = MUTED; ctx.font = `600 20px ${NUM}`; ctx.fillText(s.label.toUpperCase(), x, 582);
    ctx.fillStyle = '#FFFFFF';
    fitText(ctx, s.value, (px) => `600 ${px}px ${NUM}`, 34, colW - 24);
    ctx.fillText(s.value, x, 626);
  });

  // footer
  if (badge) ctx.drawImage(badge, 64, 660, 44, 44);
  ctx.fillStyle = '#FFFFFF'; ctx.font = `700 24px ${BODY}`; ctx.fillText('Trade memecoins on BAGZ', 122, 690);
  // no website address on the card image

  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t draw the card'))), 'image/png'));
}

export function cardText(d: CardData): string {
  const what = d.kind === 'wallet' ? 'My BAGZ paper wallet' : d.kind === 'trade' ? `Closed $${d.symbol} on BAGZ (paper)` : `Holding $${d.symbol} on BAGZ (paper)`;
  return `${what}: ${fmtPct(d.pnlPct)} (${fmtUsd(d.pnlUsd)}).`;
}
