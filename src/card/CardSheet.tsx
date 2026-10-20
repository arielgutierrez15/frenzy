import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../nav';
import { Icon } from '../ui';
import { userStats } from '../engine';
import { ago, compact, price as fmtPrice } from '../format';
import { renderCard, cardText, CARD_W, CARD_H, type CardData } from './tradingCard';
import { cleanPageUrl, inTelegram, openExternal } from '../telegram';

export type CardSpec = { kind: 'wallet' } | { kind: 'position'; coinId: string } | { kind: 'trade'; tradeId: string };

/** the app's public address (never Telegram launch data, never a page hash) */
export function appLink(): string {
  try { const u = new URL(cleanPageUrl()); u.hash = ''; u.search = ''; return u.toString(); } catch { return 'https://arielgutierrez15.github.io/frenzy/'; }
}

function useCardData(spec: CardSpec): CardData | null {
  const st = useStore();
  const s = userStats(st);
  return useMemo(() => {
    const link = appLink();
    if (spec.kind === 'wallet') {
      const sells = st.user.trades.filter((t) => t.side === 'SELL' && t.pnl !== undefined && t.usd - t.pnl! > 0);
      const best = sells.map((t) => ({ sym: t.symbol, r: t.pnl! / (t.usd - t.pnl!) })).sort((a, b) => b.r - a.r)[0];
      return {
        kind: 'wallet', symbol: null, pnlPct: s.pnlPct, pnlUsd: s.pnl, link,
        caption: `on ${compact(st.user.deposits)} paper cash`,
        stats: [
          { label: 'Value', value: compact(s.equity) },
          { label: 'Win rate', value: s.sells ? `${s.winRate.toFixed(0)}%` : '—' },
          { label: 'Best trade', value: best ? `$${best.sym} ${best.r >= 0 ? '+' : ''}${(best.r * 100).toFixed(0)}%` : '—' },
        ],
      };
    }
    if (spec.kind === 'position') {
      const p = st.user.positions[spec.coinId], c = st.coins[spec.coinId];
      if (!p || !c || !(p.cost > 0)) return null;
      const val = p.qty * c.price;
      return {
        kind: 'position', symbol: c.symbol, name: c.name, pnlPct: (val / p.cost - 1) * 100, pnlUsd: val - p.cost, link,
        caption: `unrealized · held ${ago(p.openedAt)}`,
        stats: [{ label: 'Entry', value: fmtPrice(p.cost / p.qty) }, { label: 'Now', value: fmtPrice(c.price) }, { label: 'Value', value: compact(val) }],
      };
    }
    const t = st.user.trades.find((x) => x.id === spec.tradeId);
    if (!t || t.side !== 'SELL' || t.pnl === undefined) return null;
    const cost = t.usd - t.pnl;
    if (!(cost > 0) || !(t.qty > 0)) return null;
    return {
      kind: 'trade', symbol: t.symbol, name: st.coins[t.coinId]?.name, pnlPct: (t.pnl / cost) * 100, pnlUsd: t.pnl, link,
      caption: `realized · ${new Date(t.t).toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
      stats: [{ label: 'Bought at', value: fmtPrice(cost / t.qty) }, { label: 'Sold at', value: fmtPrice(t.price) }, { label: 'Size', value: compact(cost) }],
    };
  // prices tick every few seconds; the card is drawn once per open
  }, [spec.kind, (spec as any).coinId, (spec as any).tradeId]);
}

/** The trading card sheet: shows the PNG and lets people share it, save it, or copy a summary. */
export function CardSheet({ spec, onClose }: { spec: CardSpec; onClose: () => void }) {
  const nav = useNav();
  const data = useCardData(spec);
  const [url, setUrl] = useState('');
  const [blob, setBlob] = useState<Blob | null>(null);
  const [err, setErr] = useState('');
  const tg = inTelegram();

  useEffect(() => {
    if (!data) return;
    let live = true, made = '';
    renderCard(data, 1).then((b) => { if (!live) return; setBlob(b); made = URL.createObjectURL(b); setUrl(made); }, (e) => setErr(e?.message || 'Couldn’t draw the card'));
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [data]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);

  if (!data) return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet share" role="dialog" aria-modal="true" aria-label="Trading card" onClick={(e) => e.stopPropagation()}>
        <p className="muted">There’s nothing to put on a card here yet.</p>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
    </div>
  );
  const text = cardText(data);
  const file = blob ? new File([blob], `bagz-${data.symbol ? data.symbol.toLowerCase() : 'wallet'}-card.png`, { type: 'image/png' }) : null;
  const canShareFile = !!file && typeof navigator !== 'undefined' && !!navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch { return false; } })();

  const share = async () => {
    if (!file) return;
    try { await navigator.share({ files: [file], text }); }
    catch (e: any) { if (e?.name !== 'AbortError') nav.toast('info', 'Sharing didn’t work', 'Save the image instead.'); }
  };
  const save = () => {
    if (!url || !file) return;
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
  };
  const copy = () => navigator.clipboard?.writeText(text).then(() => nav.toast('info', 'Copied to clipboard'), () => nav.toast('info', 'Copy blocked', text));
  const toTelegram = () => openExternal(`https://t.me/share/url?url=${encodeURIComponent(data.link)}&text=${encodeURIComponent(text.replace(` ${data.link}`, ''))}`);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet share" role="dialog" aria-modal="true" aria-label="Trading card" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2>Trading card</h2><span className="grow" /><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button></div>
        <div className="card-frame" style={{ aspectRatio: `${CARD_W} / ${CARD_H}` }}>
          {url ? <img className="card-img" src={url} alt={text} /> : <span className="spinner" />}
        </div>
        {err && <p className="small warn">{err}</p>}
        {tg && <p className="muted small">Press and hold the card to save it, or send it to a chat.</p>}
        <div className="row gap-s wrap">
          {canShareFile && <button className="btn btn-accent grow" onClick={share} disabled={!blob}><Icon.share size={16} /> Share card</button>}
          {tg ? <button className={`btn ${canShareFile ? 'btn-ghost' : 'btn-accent grow'}`} onClick={toTelegram}>Send in Telegram</button>
            : <button className={`btn ${canShareFile ? 'btn-ghost' : 'btn-accent grow'}`} onClick={save} disabled={!blob}>Save image</button>}
          <button className="btn btn-ghost" onClick={copy}><Icon.copy size={16} /> Copy text</button>
        </div>
        <p className="muted small">Paper trading results on live prices. No real money was used.</p>
      </div>
    </div>
  );
}
