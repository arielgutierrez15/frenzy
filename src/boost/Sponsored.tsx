import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { useNav } from '../nav';
import { activeCampaigns, sendCampaignEvent, type Campaign } from '../trading/api';
import { apiBase } from '../trading/api';
import { setPromoteMint } from './PromoteView';

/**
 * Sponsored row. Always labelled, kept apart from organic lists, and never feeds Gem Score or risk checks.
 * An impression is counted only when at least half the card is on screen for one second; the server de-duplicates
 * per viewer every 30 minutes.
 */
export function SponsoredStrip() {
  const [list, setList] = useState<Campaign[]>([]);
  const nav = useNav();
  useEffect(() => {
    if (!apiBase()) return;
    let live = true;
    const load = () => activeCampaigns().then((r) => { if (live) setList(r.campaigns.filter((c) => !c.endsAt || c.endsAt > Date.now())); }, () => {});
    load();
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  if (!list.length) return null;
  return (
    <section className="panel sponsored" aria-label="Sponsored tokens">
      <div className="row gap-s wrap">
        <h2>Sponsored</h2>
        <span className="pill pill-sponsored">Paid placement</span>
        <span className="grow" />
        <button className="link small" onClick={() => { setPromoteMint(''); nav.go('promote'); }}>Promote yours</button>
      </div>
      <p className="muted small">Advertisers paid for these spots. They are not BAGZ picks, rankings or risk ratings. Do your own research.</p>
      <div className="sponsored-row">{list.map((c) => <SponsoredCard key={c.id} c={c} />)}</div>
    </section>
  );
}

function SponsoredCard({ c }: { c: Campaign }) {
  const st = useStore();
  const nav = useNav();
  const ref = useRef<HTMLButtonElement>(null);
  const seen = useRef(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && e.intersectionRatio >= 0.5 && !seen.current) {
        timer = setTimeout(() => { if (!seen.current && document.visibilityState === 'visible') { seen.current = true; sendCampaignEvent(c.id, 'impression'); } }, 1000);
      } else if (timer) { clearTimeout(timer); timer = null; }
    }, { threshold: [0, 0.5, 1] });
    io.observe(el);
    return () => { io.disconnect(); if (timer) clearTimeout(timer); };
  }, [c.id]);
  const coin = st.coins[`solana:${c.mint}`];
  const open = () => {
    sendCampaignEvent(c.id, 'click');
    if (coin) nav.openCoin(coin.id);
    else window.open(`https://dexscreener.com/solana/${c.mint}`, '_blank', 'noopener,noreferrer');
  };
  return (
    <button ref={ref} className="sponsored-card" onClick={open} aria-label={`Sponsored: ${c.symbol}`}>
      {c.icon && !broken ? <img src={c.icon} alt="" width={36} height={36} referrerPolicy="no-referrer" className="promo-ico" onError={() => setBroken(true)} /> : <span className="promo-ico sponsored-letter" aria-hidden="true">{(c.symbol || '?').slice(0, 2).toUpperCase()}</span>}
      <span className="stack"><b>${c.symbol}</b><span className="muted small">{c.name}</span></span>
      <span className="ad-tag">Ad</span>
    </button>
  );
}
