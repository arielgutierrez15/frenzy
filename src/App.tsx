import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, act, start } from './store';
import { NavCtx, useNav, Nav, Route, Tab, TradeIntent } from './nav';
import { HomeView, FeedView, RadarView, WalletView, LeadersView, CoinView, TraderView, FollowButton } from './views';
import { TradeSheet } from './TradeSheet';
import { CardSheet, type CardSpec } from './card/CardSheet';
import { Avatar, CoinBadge, Icon, ScoreRing } from './ui';
import { toastQueue, userStats, scoreCoin, topWallets, short } from './engine';
import { ago, compact, pct, usd, signedUsd } from './format';
import type { Notif } from './types';
import { Wordmark, BRAND_TAGLINE } from './brand';
import { PromoteView } from './boost/PromoteView';
import { AdminView } from './boost/AdminView';
import { inTelegram, syncBackButton, startMint, haptic } from './telegram';

const TABS: { id: Tab; label: string; icon: keyof typeof Icon }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'feed', label: 'Live', icon: 'feed' },
  { id: 'radar', label: 'Gem Radar', icon: 'radar' },
  { id: 'wallet', label: 'Wallet', icon: 'wallet' },
  { id: 'leaders', label: 'Wallets', icon: 'users' },
];

function readHash(): Route {
  const h = (typeof location !== 'undefined' ? location.hash.slice(1) : '') as Tab;
  // promote and admin are pages without a tab-bar button
  return { tab: TABS.some((t) => t.id === h) || h === 'promote' || h === 'admin' ? h : 'home' };
}

interface Toast { id: string; tone: Notif['tone']; title: string; body?: string; coinId?: string }

export default function App() {
  const st = useStore();
  const [stack, setStack] = useState<Route[]>([readHash()]);
  const route = stack[stack.length - 1];
  const [intent, setIntent] = useState<TradeIntent | null>(null);
  const [sharing, setSharing] = useState<CardSpec | null>(null);
  const [bellOpen, setBellOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => { start(); }, []);
  // typing a page address (#promote, #admin, #wallet…) into an open tab navigates there
  useEffect(() => {
    const on = () => { const r = readHash(); setStack((s) => (s.length === 1 && s[0].tab === r.tab ? s : [r])); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const pushToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((x) => [...x.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4800);
  }, []);

  // drain engine notifications into toasts (throttled to keep the screen calm)
  const lastToastAt = useRef(0);
  useEffect(() => {
    if (!toastQueue.length) return;
    const items = toastQueue.splice(0, toastQueue.length);
    const now = Date.now();
    const important = items.filter((n) => n.tone !== 'info' || n.title.includes('order') || n.title.includes('filled'));
    const pickOne = important[0] || (now - lastToastAt.current > 7000 ? items[0] : undefined);
    if (pickOne) { lastToastAt.current = now; pushToast({ tone: pickOne.tone, title: pickOne.title, body: pickOne.body, coinId: pickOne.coinId }); }
  });

  const nav: Nav = useMemo(() => ({
    route,
    go: (tab) => { setStack([{ tab }]); try { history.replaceState(null, '', '#' + tab); } catch { /* sandboxed */ } mainRef.current?.scrollTo?.(0, 0); window.scrollTo(0, 0); },
    openCoin: (id) => { setStack((s) => [...s, { tab: s[s.length - 1].tab, coin: id }]); window.scrollTo(0, 0); },
    openTrader: (id) => { setStack((s) => [...s, { tab: s[s.length - 1].tab, trader: id }]); window.scrollTo(0, 0); },
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    trade: (t) => setIntent(t),
    share: (card) => setSharing(card || { kind: 'wallet' }),
    toast: (tone, title, body) => pushToast({ tone, title, body }),
  }), [route, pushToast]);

  // Telegram: its own back button mirrors BAGZ back navigation
  const canBack = stack.length > 1 || route.tab === 'promote' || route.tab === 'admin';
  useEffect(() => syncBackButton(canBack, () => { haptic.tap(); if (stack.length > 1) nav.back(); else nav.go('home'); }), [canBack, stack.length, nav]);
  // Telegram: t.me/<bot>?startapp=<mint> opens that coin once it has loaded
  const startRef = useRef<{ mint: string | null; at: number; done: boolean }>({ mint: startMint(), at: Date.now(), done: false });
  useEffect(() => {
    const sr = startRef.current;
    if (!sr.mint || sr.done) return;
    const id = `solana:${sr.mint}`;
    if (st.coins[id]) { sr.done = true; nav.openCoin(id); return; }
    if (st.loaded && Date.now() - sr.at > 30_000) { sr.done = true; pushToast({ tone: 'info', title: 'Coin not found', body: 'That shared coin isn’t in BAGZ’s live data right now.' }); }
  });

  const s = userStats(st);
  const unread = st.notifs.filter((n) => !n.read).length;
  const view = route.coin ? <CoinView key={route.coin} id={route.coin} /> : route.trader ? <TraderView key={route.trader} id={route.trader} /> :
    route.tab === 'home' ? <HomeView /> : route.tab === 'feed' ? <FeedView /> : route.tab === 'radar' ? <RadarView /> : route.tab === 'wallet' ? <WalletView /> :
    route.tab === 'promote' ? <PromoteView /> : route.tab === 'admin' ? <AdminView /> : <LeadersView />;
  const showAside = !route.coin && !route.trader && (route.tab === 'feed' || route.tab === 'leaders');

  return (
    <NavCtx.Provider value={nav}>
      <div className={`app${inTelegram() ? ' app-tg' : ''}`}>
        <aside className="rail">
          <button className="brand" onClick={() => nav.go('home')} aria-label="BAGZ home">
            <Wordmark />
            <span className="brand-sub">{BRAND_TAGLINE}</span>
          </button>
          <nav className="rail-nav" aria-label="Main">
            {TABS.map((t) => {
              const Ico = Icon[t.icon];
              return (
                <button key={t.id} className={route.tab === t.id && !route.coin && !route.trader ? 'on' : ''} onClick={() => nav.go(t.id)}>
                  <Ico size={20} /><span>{t.label}</span>
                </button>
              );
            })}
          </nav>
          <button className="rail-wallet" onClick={() => nav.go('wallet')}>
            <span className="eyebrow">Paper wallet</span>
            <b className="num">{usd(s.equity)}</b>
            <span className={`num small ${s.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(s.pnl)} · {pct(s.pnlPct, 2)}</span>
          </button>
          <SourceBadge />
        </aside>

        <header className="topbar">
          <button className="brand" onClick={() => nav.go('home')} aria-label="BAGZ home"><Wordmark /></button>
          <span className="grow" />
          <button className="topbar-cash" onClick={() => nav.go('wallet')}>
            <b className="num">{compact(s.equity)}</b>
            <span className={`num small ${s.pnl >= 0 ? 'up' : 'down'}`}>{pct(s.pnlPct, 1)}</span>
          </button>
          <button className="icon-btn bell" aria-label={`Alerts, ${unread} unread`} onClick={() => setBellOpen((b) => !b)}>
            <Icon.bell size={20} />{unread > 0 && <span className="dot-count num">{unread > 9 ? '9+' : unread}</span>}
          </button>
        </header>

        <main className="main" ref={mainRef}>
          <div className="desk-bell">
            <SourceBadge />
            <button className="icon-btn bell" aria-label={`Alerts, ${unread} unread`} onClick={() => setBellOpen((b) => !b)}>
              <Icon.bell size={20} />{unread > 0 && <span className="dot-count num">{unread > 9 ? '9+' : unread}</span>}
            </button>
          </div>
          {view}
        </main>

        {showAside && <Aside />}

        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => {
            const Ico = Icon[t.icon];
            return (
              <button key={t.id} className={route.tab === t.id ? 'on' : ''} onClick={() => { haptic.tap(); nav.go(t.id); }} aria-current={route.tab === t.id}>
                <Ico size={22} /><span>{t.label === 'Gem Radar' ? 'Radar' : t.label}</span>
              </button>
            );
          })}
        </nav>

        {bellOpen && <AlertsPanel onClose={() => setBellOpen(false)} />}
        {intent && <TradeSheet key={intent.coinId + intent.side} intent={intent} onClose={() => setIntent(null)} />}
        {sharing && <CardSheet key={JSON.stringify(sharing)} spec={sharing} onClose={() => setSharing(null)} />}

        <div className="toasts" aria-live="polite">
          {toasts.map((t) => (
            <button key={t.id} className={`toast toast-${t.tone}`} onClick={() => { if (t.coinId && st.coins[t.coinId]) nav.openCoin(t.coinId); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>
              <b>{t.title}</b>{t.body && <span>{t.body}</span>}
            </button>
          ))}
        </div>
      </div>
    </NavCtx.Provider>
  );
}

function SourceBadge() {
  const st = useStore();
  const nav = useNav();
  const list = Object.values(st.sources);
  const ok = list.filter((x) => x.ok).length;
  const label = st.snapshotAt ? `Snapshot · ${new Date(st.snapshotAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : !list.length || list.every((x) => x.ok === null) ? 'Connecting…' : ok === 0 ? 'Offline' : `Live · ${ok}/${list.length} sources`;
  return (
    <button className={`source ${ok === list.length && ok > 0 ? 'source-live' : ok === 0 && list.some((x) => x.ok === false) ? 'source-off' : ''}`} title={list.map((x) => `${x.label}: ${x.ok ? (x.stale ? 'stale' : 'ok') + (x.at ? ' · ' + ago(x.at) + ' ago' : '') : x.ok === false ? x.error : 'waiting'}`).join('\n')}
      onClick={() => { nav.go('home'); setTimeout(() => document.getElementById('data-health')?.scrollIntoView({ behavior: 'smooth' }), 80); }}>
      <span className="pulse" />{label}
    </button>
  );
}

function Aside() {
  const st = useStore();
  const nav = useNav();
  const gems = Object.values(st.coins).filter((c) => !st.majors.includes(c.id) && c.price > 0 && !c.rugged).map((c) => ({ c, s: scoreCoin(c) })).filter((x) => x.s.score >= 50 && x.s.known >= 5).sort((a, b) => b.s.score - a.s.score).slice(0, 5);
  const wallets = topWallets(st).slice(0, 4);
  return (
    <aside className="aside">
      <div className="panel">
        <div className="row"><h2>Top gems now</h2><span className="grow" /><button className="link small" onClick={() => nav.go('radar')}>Radar</button></div>
        <ul className="mini-list">
          {!gems.length && <li className="muted small">{st.loaded ? 'Nothing scores 50+ with enough checks right now.' : 'Loading…'}</li>}
          {gems.map(({ c, s }) => (
            <li key={c.id}>
              <button className="bare row gap-s full" onClick={() => nav.openCoin(c.id)}>
                <ScoreRing score={s.score} size={34} />
                <span className="stack"><b>${c.symbol}</b><span className="muted small num">{compact(c.mcap)} · {s.risk} risk</span></span>
                <span className="grow" />
                {c.change.h1 !== undefined && <span className={`num small ${c.change.h1 >= 0 ? 'up' : 'down'}`}>{pct(c.change.h1, Math.abs(c.change.h1) < 10 ? 1 : 0)} 1h</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="panel">
        <div className="row"><h2>Busiest wallets</h2><span className="grow" /><button className="link small" onClick={() => nav.go('leaders')}>All</button></div>
        <ul className="mini-list">
          {wallets.map((w) => (
            <li key={w.address} className="row gap-s">
              <button className="bare row gap-s grow" onClick={() => nav.openTrader(w.address)}>
                <Avatar wallet={w.address} size={32} />
                <span className="stack"><b className="num">{short(w.address)}</b><span className="muted small num">{compact(w.vol)} · {w.buys + w.sells} swaps</span></span>
              </button>
              <FollowButton id={w.address} small />
            </li>
          ))}
          {!wallets.length && <li className="muted small">Real wallets show up here as swaps come in.</li>}
        </ul>
      </div>
    </aside>
  );
}

function AlertsPanel({ onClose }: { onClose: () => void }) {
  const st = useStore();
  const nav = useNav();
  useEffect(() => () => { act((s) => { s.notifs.forEach((n) => (n.read = true)); }); }, []);
  return (
    <div className="sheet-backdrop alerts-backdrop" onClick={onClose}>
      <div className="alerts" role="dialog" aria-label="Alerts" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2>Alerts</h2><span className="grow" /><button className="icon-btn" onClick={onClose} aria-label="Close alerts"><Icon.close /></button></div>
        <p className="muted small">Swaps from wallets you follow, new coins scoring {st.settings.alertsMinScore}+, order fills, and rugs in coins you hold.</p>
        <ul className="alert-list">
          {st.notifs.length ? st.notifs.slice(0, 40).map((n) => {
            const c = n.coinId ? st.coins[n.coinId] : undefined;
            return (
              <li key={n.id} className={n.read ? '' : 'unread'}>
                <button className="bare row gap-s full" onClick={() => { onClose(); if (c) nav.openCoin(c.id); }}>
                  {c ? <CoinBadge coin={c} size={30} /> : <span className="coin-badge" />}
                  <span className="stack grow"><b className={`t-${n.tone}`}>{n.title}</b><span className="muted small">{n.body}</span></span>
                  <span className="muted small">{ago(n.t)}</span>
                </button>
              </li>
            );
          }) : <li className="muted">No alerts yet. Follow a wallet or wait for a high-scoring coin.</li>}
        </ul>
      </div>
    </div>
  );
}
