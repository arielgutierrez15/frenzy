/**
 * The Vault: buy limited BAGZ cards with BAGZ Coins, earn coins from daily paper-trading challenges,
 * see your collection. Avatar and Arcade are placeholders for the next stages.
 * Prices, supply and serials come from the Worker; this page never decides who owns what.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
// @ts-ignore plain JS shared with the Worker
import { CARDS, CARD_BY_ID, RARITY, SERIES, SUPPLY, priceOf } from '../../worker/vault-cards.js';
import { getVault, claimReward, buyCard, type VaultState, type Owned } from './api';
import { Seg } from '../views';
import { Icon } from '../ui';
import { useNav } from '../nav';
import { demo } from '../demo/hook';
import { haptic } from '../telegram';
import navEmblem from '../assets/bagz-nav-emblem.png';

type Series = 'ape' | 'bear' | 'bull';
type Rarity = 'common' | 'rare' | 'gem';
export interface Card { id: string; series: Series; no: number; mode: string; rarity: Rarity }
const cards = CARDS as Card[];
const byId = CARD_BY_ID as Record<string, Card>;

/** card art is served next to the page (docs/vault/art); the test copy lives one folder down */
const artUrl = (id: string) => `${demo() ? '../' : './'}vault/art/${id}.webp`;
const pad = (n: number) => String(n).padStart(2, '0');

function SeriesIcon({ s }: { s: Series }) {
  if (s === 'ape') return <img src={navEmblem} alt="" />;
  if (s === 'bear') return (
    <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="8" cy="9" r="5" fill="currentColor" /><circle cx="24" cy="9" r="5" fill="currentColor" /><circle cx="16" cy="18" r="11" fill="currentColor" /><ellipse cx="16" cy="22" rx="5.5" ry="4.5" fill="var(--ink)" /><circle cx="16" cy="20.5" r="1.8" fill="currentColor" /></svg>
  );
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 6c1 5 4 8 8 8M29 6c-1 5-4 8-8 8" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" /><circle cx="16" cy="18" r="10" fill="currentColor" /><ellipse cx="16" cy="23" rx="6" ry="4" fill="var(--ink)" /><circle cx="13.5" cy="23" r="1.2" fill="currentColor" /><circle cx="18.5" cy="23" r="1.2" fill="currentColor" /></svg>
  );
}
const Globe = () => <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" /></svg>;
export const Coin = ({ n, big }: { n: number; big?: boolean }) => <span className={`bz-coin${big ? ' big' : ''}`}><span className="bz-coin-ico" aria-hidden="true">B</span><b className="num">{n.toLocaleString()}</b></span>;

/** the BAGZ card frame drawn around the art: name, number, serial, mode, series icon */
export function CardFace({ card, serial, note, big }: { card: Card; serial?: number; note?: string; big?: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`bz-card r-${card.rarity}${big ? ' big' : ''}`}>
      <div className="bz-card-head">
        <span className="bz-card-name">{SERIES[card.series].label.toUpperCase()}<i>//</i></span>
        <span className="bz-card-no num">{pad(card.no)}</span>
        <span className="bz-card-serial num">{serial ? `${serial}/${SUPPLY}` : note ?? `–/${SUPPLY}`}</span>
      </div>
      <div className="bz-card-art">
        {broken ? <div className="bz-card-art-missing"><SeriesIcon s={card.series} /></div> : <img src={artUrl(card.id)} alt={`${SERIES[card.series].label} ${card.mode}`} loading="lazy" onError={() => setBroken(true)} />}
        <span className="bz-card-rarity">{RARITY[card.rarity].label}</span>
      </div>
      <div className="bz-card-foot">
        <span className="bz-card-icon"><SeriesIcon s={card.series} /></span>
        <span className="bz-card-mode">{card.mode.toUpperCase()}<i>//</i></span>
        <span className="bz-card-globe"><Globe /></span>
      </div>
    </div>
  );
}

type TabId = 'shop' | 'earn' | 'mine' | 'avatar' | 'arcade';

export function VaultView() {
  const nav = useNav();
  const [tab, setTab] = useState<TabId>('shop');
  const [v, setV] = useState<VaultState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [got, setGot] = useState<Owned | null>(null);

  const load = useCallback(async () => {
    try { setV(await getVault()); setErr(null); } catch (e: any) { setErr(e?.message || 'Couldn’t load the Vault'); }
  }, []);
  useEffect(() => { load(); const on = () => { if (!document.hidden) load(); }; document.addEventListener('visibilitychange', on); return () => document.removeEventListener('visibilitychange', on); }, [load]);
  useEffect(() => { if (tab === 'earn') load(); }, [tab, load]);

  const owned = useMemo(() => new Map((v?.mine ?? []).map((m) => [m.card, m])), [v]);
  const toClaim = v ? (v.welcome ? 1 : 0) + v.challenges.filter((c) => !c.claimed && c.progress >= c.goal).length : 0;

  const claim = async (id: string) => {
    setBusy(id);
    try { const r = await claimReward(id); setV(r); haptic.tap(); nav.toast('gem', 'Coins added', `Balance: ${r.balance.toLocaleString()} BAGZ Coins`); }
    catch (e: any) { nav.toast('down', 'Couldn’t claim', e?.message); load(); }
    finally { setBusy(null); }
  };
  const buy = async (id: string) => {
    setBusy(id);
    try { const r = await buyCard(id); setV(r); setOpen(null); setGot(r.bought); haptic.tap(); }
    catch (e: any) { nav.toast('down', 'Couldn’t buy', e?.message); load(); }
    finally { setBusy(null); }
  };

  return (
    <section className="view vault">
      <header className="view-head vault-head">
        <div>
          <span className="eyebrow">BAGZ</span>
          <h1>The Vault</h1>
        </div>
        {v && <Coin n={v.balance} big />}
      </header>
      <Seg label="Vault" value={tab} onChange={setTab} options={[{ v: 'shop', l: 'Shop' }, { v: 'earn', l: toClaim ? `Earn · ${toClaim}` : 'Earn' }, { v: 'mine', l: `My cards${v ? ` · ${v.mine.length}` : ''}` }, { v: 'avatar', l: 'Avatar' }, { v: 'arcade', l: 'Arcade' }]} />

      {err && !v && <div className="panel"><b>Couldn’t open the Vault</b><span className="muted small">{err}</span><button className="btn btn-soft" onClick={load}>Try again</button></div>}
      {!v && !err && <div className="panel muted">Opening the Vault…</div>}

      {v && tab === 'shop' && <Shop v={v} owned={owned} onOpen={setOpen} />}
      {v && tab === 'earn' && <Earn v={v} busy={busy} onClaim={claim} />}
      {v && tab === 'mine' && (v.mine.length ? (
        <div className="bz-grid">{v.mine.map((m) => byId[m.card] && <button key={m.card} className="bz-tile" onClick={() => setGot(m)}><CardFace card={byId[m.card]} serial={m.serial} /></button>)}</div>
      ) : (
        <div className="panel vault-empty"><b>No cards yet</b><span className="muted">Finish a challenge in Earn, then pick your first card in the Shop. Common cards cost {RARITY.common.price} coins.</span><button className="btn btn-accent" onClick={() => setTab('earn')}>Earn coins</button></div>
      ))}
      {v && (tab === 'avatar' || tab === 'arcade') && (
        <div className="panel vault-soon">
          <span className="pill pill-warn">Coming next</span>
          <b>{tab === 'avatar' ? 'Avatar customizer' : 'Mini arcade'}</b>
          <span className="muted">{tab === 'avatar' ? 'Dress up your BAGZ character with items you unlock, and show it on your profile, chats and Ranks.' : 'Quick games with a daily play limit that pay out BAGZ Coins.'}</span>
        </div>
      )}

      {open && v && byId[open] && <BuySheet card={byId[open]} v={v} owned={owned.get(open)} busy={busy === open} onBuy={() => buy(open)} onClose={() => setOpen(null)} onEarn={() => { setOpen(null); setTab('earn'); }} />}
      {got && byId[got.card] && <RevealSheet card={byId[got.card]} owned={got} onClose={() => setGot(null)} />}
    </section>
  );
}

function Shop({ v, owned, onOpen }: { v: VaultState; owned: Map<string, Owned>; onOpen: (id: string) => void }) {
  type F = 'all' | Rarity | Series;
  const [f, setF] = useState<F>('all');
  const list = cards.filter((c) => f === 'all' || c.rarity === f || c.series === f);
  const filters: F[] = ['all', 'gem', 'rare', 'common', 'ape', 'bear', 'bull'];
  return (
    <>
      <div className="cat-row">
        {filters.map((x) => (
          <button key={x} className={`chip-btn${f === x ? ' on' : ''}${x in RARITY ? ` chip-r chip-${x}` : ''}`} onClick={() => setF(x)}>
            {x === 'all' ? 'All' : x in RARITY ? RARITY[x].label : SERIES[x].label}
          </button>
        ))}
      </div>
      <div className="bz-grid">
        {list.map((c) => {
          const left = SUPPLY - (v.minted[c.id] ?? 0);
          const mine = owned.get(c.id);
          return (
            <button key={c.id} className={`bz-tile${left <= 0 && !mine ? ' sold' : ''}`} onClick={() => onOpen(c.id)}>
              <CardFace card={c} serial={mine?.serial} />
              <span className="bz-tile-meta">
                {mine ? <span className="pill pill-up">Owned · #{mine.serial}</span> : left <= 0 ? <span className="pill pill-down">Sold out</span> : <Coin n={priceOf(c)} />}
                <span className="muted small num">{left}/{SUPPLY} left</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function Earn({ v, busy, onClaim }: { v: VaultState; busy: string | null; onClaim: (id: string) => void }) {
  const hrs = Math.max(0, Math.ceil((v.resetsAt - Date.now()) / 3_600_000));
  return (
    <div className="stack gap">
      {v.welcome && (
        <div className="panel bz-welcome">
          <div className="row gap-s"><b className="grow">Welcome bonus</b><Coin n={v.welcome} /></div>
          <span className="muted small">A one-time gift to start your collection: enough for your first Common card.</span>
          <button className="btn btn-accent" disabled={busy === 'welcome'} onClick={() => onClaim('welcome')}>Claim {v.welcome} coins</button>
        </div>
      )}
      <div className="panel">
        <div className="row"><h2 className="grow">Daily challenges</h2><span className="muted small">New in {hrs}h</span></div>
        <ul className="bz-challenges">
          {v.challenges.map((c) => {
            const done = c.progress >= c.goal;
            return (
              <li key={c.id} className={c.claimed ? 'claimed' : ''}>
                <div className="stack grow">
                  <b>{c.title}</b>
                  <span className="bz-bar" aria-hidden="true"><span style={{ width: `${(c.progress / c.goal) * 100}%` }} /></span>
                  <span className="muted small num">{c.progress}/{c.goal}</span>
                </div>
                {c.claimed ? <span className="pill pill-up"><Icon.check size={14} /> Claimed</span>
                  : <button className={`btn ${done ? 'btn-accent' : 'btn-ghost'} bz-claim`} disabled={!done || busy === c.id} onClick={() => onClaim(c.id)}>+{c.reward}</button>}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="muted small">BAGZ Coins have no cash value and can’t be withdrawn. Paper trades are reported by the app, so daily rewards are capped.</p>
    </div>
  );
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet bz-sheet" role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head"><b className="grow">{label}</b><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button></div>
        {children}
      </div>
    </div>
  );
}

function BuySheet({ card, v, owned, busy, onBuy, onClose, onEarn }: { card: Card; v: VaultState; owned?: Owned; busy: boolean; onBuy: () => void; onClose: () => void; onEarn: () => void }) {
  const price = priceOf(card);
  const left = SUPPLY - (v.minted[card.id] ?? 0);
  const short = price - v.balance;
  return (
    <Sheet label={`${SERIES[card.series].label} · ${card.mode}`} onClose={onClose}>
      <div className="bz-sheet-card"><CardFace card={card} serial={owned?.serial} big /></div>
      <div className="bz-facts">
        <div><span className="eyebrow">Rarity</span><b>{RARITY[card.rarity].label}</b></div>
        <div><span className="eyebrow">Left</span><b className="num">{left}/{SUPPLY}</b></div>
        <div><span className="eyebrow">Price</span><Coin n={price} /></div>
      </div>
      {owned ? <p className="muted">You own copy <b className="num">#{owned.serial}/{SUPPLY}</b>. One copy per card per account.</p>
        : left <= 0 ? <p className="muted">All {SUPPLY} copies are claimed.</p>
        : short > 0 ? <>
            <button className="btn btn-accent" disabled>Need {short.toLocaleString()} more coins</button>
            <button className="btn btn-soft" onClick={onEarn}>Earn coins</button>
          </>
        : <button className="btn btn-accent" disabled={busy} onClick={onBuy}>{busy ? 'Buying…' : <>Buy for {price.toLocaleString()} coins · you get #{SUPPLY - left + 1}</>}</button>}
      {!owned && left > 0 && <button className="btn btn-ghost" disabled title="Not available yet">Buy with SOL · coming soon</button>}
    </Sheet>
  );
}

function RevealSheet({ card, owned, onClose }: { card: Card; owned: Owned; onClose: () => void }) {
  return (
    <Sheet label="In your Vault" onClose={onClose}>
      <div className="bz-sheet-card bz-reveal"><CardFace card={card} serial={owned.serial} big /></div>
      <p className="center"><b>{SERIES[card.series].label} · {card.mode}</b><br /><span className="muted">Copy <b className="num">#{owned.serial}</b> of {SUPPLY} · {RARITY[card.rarity].label}</span></p>
      <button className="btn btn-accent" onClick={onClose}>Nice</button>
    </Sheet>
  );
}
