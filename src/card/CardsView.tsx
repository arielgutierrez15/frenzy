import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../nav';
import { Badge } from '../brand';
import { renderCard, fmtPct, fmtUsd } from './tradingCard';
import type { SavedCard } from '../types';

/** thumbnails are drawn once per card and kept for the session */
const thumbs = new Map<string, Promise<string>>();
function thumb(c: SavedCard) {
  if (!thumbs.has(c.id)) thumbs.set(c.id, renderCard(c.data, 0.5).then((b) => URL.createObjectURL(b)));
  return thumbs.get(c.id)!;
}

function Thumb({ c }: { c: SavedCard }) {
  const nav = useNav();
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const go = () => thumb(c).then((u) => live && setSrc(u), () => {});
    if (typeof IntersectionObserver === 'undefined') { go(); return () => { live = false; }; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { go(); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [c.id]);
  const up = c.data.pnlUsd >= 0;
  const label = c.data.symbol ? `$${c.data.symbol}` : 'Wallet';
  return (
    <button ref={ref} className="card-thumb" onClick={() => nav.share({ kind: 'saved', id: c.id })} aria-label={`${label} card, ${fmtPct(c.data.pnlPct)}`}>
      <span className="card-thumb-img">{src ? <img src={src} alt="" /> : <span className="spinner" />}</span>
      <span className="row gap-s card-thumb-meta">
        <b>{label}</b>
        <span className={`num small ${up ? 'up' : 'down'}`}>{fmtPct(c.data.pnlPct)}</span>
        <span className="grow" />
        <span className="muted small">{new Date(c.t).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
      </span>
    </button>
  );
}

/** Cards tab: every trading card you've made, kept with your paper wallet */
export function CardsView() {
  const st = useStore();
  const nav = useNav();
  const [f, setF] = useState<'all' | 'wins' | 'losses' | 'trade' | 'position' | 'wallet'>('all');
  const [sort, setSort] = useState<'new' | 'best'>('new');
  const all = st.user.cards || [];
  const list = useMemo(() => {
    let l = all.filter((c) => (f === 'all' ? true : f === 'wins' ? c.data.pnlUsd > 0 : f === 'losses' ? c.data.pnlUsd < 0 : c.data.kind === f));
    if (sort === 'best') l = [...l].sort((a, b) => b.data.pnlPct - a.data.pnlPct);
    return l;
  }, [all, f, sort]);
  const trades = all.filter((c) => c.data.kind === 'trade');
  const wins = trades.filter((c) => c.data.pnlUsd > 0).length;
  const best = trades.reduce<SavedCard | null>((b, c) => (!b || c.data.pnlPct > b.data.pnlPct ? c : b), null);
  const total = trades.reduce((a, c) => a + c.data.pnlUsd, 0);
  return (
    <section className="view">
      <header className="view-head">
        <div><h1>Cards</h1></div>
      </header>
      {all.length > 0 && (
        <dl className="stats stats-4 cards-stats">
          <div><dt>Cards</dt><dd className="num">{all.length}</dd></div>
          <div><dt>Closed trades</dt><dd className="num">{trades.length}{trades.length ? ` · ${Math.round((wins / trades.length) * 100)}% wins` : ''}</dd></div>
          <div><dt>Best trade</dt><dd className={`num ${best && best.data.pnlUsd < 0 ? 'down' : 'up'}`}>{best ? `$${best.data.symbol} ${fmtPct(best.data.pnlPct)}` : '—'}</dd></div>
          <div><dt>Profit on cards</dt><dd className={`num ${total >= 0 ? 'up' : 'down'}`}>{trades.length ? fmtUsd(total) : '—'}</dd></div>
        </dl>
      )}
      <div className="seg" role="tablist" aria-label="Show">
        {([['all', 'All'], ['wins', 'Wins'], ['losses', 'Losses'], ['trade', 'Trades'], ['position', 'Positions'], ['wallet', 'Wallet']] as const).map(([v, l]) => <button key={v} role="tab" aria-selected={f === v} className={f === v ? 'on' : ''} onClick={() => setF(v)}>{l}</button>)}
      </div>
      <div className="seg seg-sm" role="tablist" aria-label="Sort">
        {([['new', 'Newest'], ['best', 'Biggest gain']] as const).map(([v, l]) => <button key={v} role="tab" aria-selected={sort === v} className={sort === v ? 'on' : ''} onClick={() => setSort(v)}>{l}</button>)}
      </div>
      {list.length ? <div className="card-grid">{list.map((c) => <Thumb key={c.id} c={c} />)}</div> : (
        <div className="empty">
          <Badge className="brand-badge empty-badge" />
          <b>{all.length ? 'No cards match' : 'No cards yet'}</b>
          <p>{all.length ? 'Try another filter.' : 'Close a paper trade and its card shows up here. You can also save your wallet card from the Wallet tab.'}</p>
          {!all.length && <div className="row gap-s wrap"><button className="btn btn-accent" onClick={() => nav.go('radar')}>Find a coin</button><button className="btn btn-ghost" onClick={() => nav.share({ kind: 'wallet' })}>Make a wallet card</button></div>}
        </div>
      )}
    </section>
  );
}
