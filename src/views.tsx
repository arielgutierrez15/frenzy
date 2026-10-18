import React, { useEffect, useMemo, useState } from 'react';
import type { ChainTrade, Coin, Thesis } from './types';
import { useStore, act, emit, getState, setFocus } from './store';
import { useNav } from './nav';
import { Avatar, Change, CoinBadge, Icon, PriceChart, ScoreRing, Spark, EquityChart } from './ui';
import { ago, compact, pct, price as fmtPrice, qty as fmtQty, usd, signedUsd } from './format';
import {
  change24, userStats, fumbles, cancelOrder, uid, scoreCoin, categoriesOf, CATEGORIES, SOURCE_SHORT, START_CASH,
  detail, loadCandles, loadTrades, loadHolders, loadDetails, topWallets, short, isPumpFun, TIMEFRAMES, Timeframe, exportWallet, importWallet,
} from './engine';

function BannerImg({ src }: { src: string }) {
  const [ok, setOk] = useState(true);
  if (!ok) return null;
  return <div className="coin-banner"><img src={src} alt="" referrerPolicy="no-referrer" onError={() => setOk(false)} /></div>;
}
import { tradeLinks, walletLink } from './seed';

// ======================================================================
// shared bits
// ======================================================================
export function FollowButton({ id, small = false }: { id: string; small?: boolean }) {
  const st = useStore();
  const on = st.user.following.includes(id);
  return (
    <button
      className={`btn ${on ? 'btn-ghost' : 'btn-soft'} ${small ? 'btn-sm' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        act((s) => { s.user.following = on ? s.user.following.filter((x) => x !== id) : [...s.user.following, id]; });
      }}
      aria-pressed={on}
    >
      {on ? 'Following' : 'Follow'}
    </button>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} role="tab" aria-selected={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.l}</button>
      ))}
    </div>
  );
}

function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      <p>{body}</p>
      {action}
    </div>
  );
}

/** Shown while the first round of requests is in flight, or when every source failed. */
function DataGate({ children }: { children: React.ReactNode }) {
  const st = useStore();
  const src = Object.values(st.sources);
  const anyOk = src.some((s) => s.ok);
  if (!st.loaded && !anyOk) return <div className="loading"><span className="spinner" />Loading live markets from DexScreener, Jupiter, GeckoTerminal and pump.fun…</div>;
  if (st.snapshotAt) return (
    <>
      <div className="banner banner-warn small" role="status">
        <Icon.warn size={16} />
        <span>Live requests are blocked here, so this is a real snapshot from Jupiter, pump.fun and DexScreener taken {new Date(st.snapshotAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Prices are frozen and trading is off. Open frenzy.html in a browser or run npm run dev for live data.</span>
      </div>
      {children}
    </>
  );
  if (st.loaded && !anyOk) return (
    <Empty
      title="Couldn’t reach any data source"
      body="Every request was blocked. Pages published inside claude.ai can’t make outside requests. Open frenzy.html directly in your browser, run npm run dev, or host the build, and live data loads."
    />
  );
  return <>{children}</>;
}

const sparkOf = (c: Coin) => c.spark.map((s) => s.p);
const ageOf = (c: Coin) => (c.createdAt ? ago(c.createdAt) : '—');

// ======================================================================
// LIVE FEED (real on-chain trades + your own activity)
// ======================================================================
function TapeCard({ t }: { t: ChainTrade }) {
  const st = useStore();
  const nav = useNav();
  const c = st.coins[t.coinId];
  if (!c) return null;
  const since = c.price > 0 && t.price > 0 ? (c.price / t.price - 1) * 100 : 0;
  const supply = c.price > 0 ? c.mcap / c.price : 0;
  const followed = st.user.following.includes(t.wallet);
  return (
    <article className="post">
      <div className="post-av"><button className="bare" onClick={() => nav.openTrader(t.wallet)} aria-label={`Open wallet ${short(t.wallet)}`}><Avatar wallet={t.wallet} /></button></div>
      <div className="post-body">
        <div className="post-head">
          <button className="handle link num" onClick={() => nav.openTrader(t.wallet)}>{short(t.wallet)}</button>
          {followed && <span className="tag tag-plain">Following</span>}
          <span className="muted">· {ago(t.t)}</span>
          <span className={`tag ${t.side === 'BUY' ? 'tag-up' : 'tag-down'}`}>{t.side === 'BUY' ? 'Bought' : 'Sold'}</span>
        </div>
        <button className="post-coin" onClick={() => nav.openCoin(c.id)}>
          <CoinBadge coin={c} size={30} />
          <span className="post-coin-text">
            <b className="num">{compact(t.usd)}</b> of <b>${c.symbol}</b>{supply > 0 && <> at <span className="num">{compact(t.price * supply)}</span> mcap</>}
          </span>
          <Spark points={sparkOf(c)} width={64} height={24} />
        </button>
        <div className="post-foot">
          {t.side === 'BUY' && <span className={`pill ${since >= 0 ? 'pill-up' : 'pill-down'}`} title="Price change since this trade">{pct(since)} since</span>}
          <span className="muted small">on-chain</span>
          <span className="grow" />
          {!c.rugged && <button className="btn btn-accent btn-sm" onClick={() => nav.trade({ coinId: c.id, side: 'BUY', usd: 100, via: 'copy' })}><Icon.bolt size={14} /> {t.side === 'BUY' ? 'Copy buy' : 'Buy'}</button>}
        </div>
      </div>
    </article>
  );
}

function ThesisCard({ th }: { th: Thesis }) {
  const st = useStore();
  const nav = useNav();
  const c = st.coins[th.coinId];
  if (!c) return null;
  return (
    <article className="post">
      <div className="post-av"><Avatar you /></div>
      <div className="post-body">
        <div className="post-head"><b className="handle">You</b><span className="muted">· {ago(th.t)}</span><span className={`tag ${th.bull ? 'tag-up' : 'tag-down'}`}>{th.bull ? 'Bullish' : 'Bearish'}</span></div>
        <button className="post-coin" onClick={() => nav.openCoin(c.id)}>
          <CoinBadge coin={c} size={30} />
          <span className="post-coin-text">on <b>${c.symbol}</b> at <span className="num">{compact(th.mcap)}</span> mcap</span>
        </button>
        <p className="post-text">{th.text}</p>
        {c.price > 0 && th.price > 0 && <div className="post-foot"><span className={`pill ${c.price >= th.price ? 'pill-up' : 'pill-down'}`}>{pct((c.price / th.price - 1) * 100)} since</span></div>}
      </div>
    </article>
  );
}

type FeedFilter = 'all' | 'big' | 'following' | 'you';
export function FeedView() {
  const st = useStore();
  const nav = useNav();
  const [f, setF] = useState<FeedFilter>('all');
  const tape = st.tape.filter((t) => (f === 'big' ? t.usd >= 1000 : f === 'following' ? st.user.following.includes(t.wallet) : true)).slice(0, 60);
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Live</h1>
          <p className="muted">Real swaps from real wallets, pulled from GeckoTerminal for the most active pools and the coins you hold. Follow a wallet to get alerts when it trades.</p>
        </div>
      </header>
      <Seg label="Feed filter" value={f} onChange={setF} options={[{ v: 'all', l: 'All swaps' }, { v: 'big', l: '≥ $1K' }, { v: 'following', l: `Following · ${st.user.following.length}` }, { v: 'you', l: 'You' }]} />
      <DataGate>
        {f === 'you' ? (
          st.user.theses.length || st.user.trades.length ? (
            <div className="post-list">
              {st.user.theses.slice(0, 20).map((th) => <ThesisCard key={th.id} th={th} />)}
              <ActivityList limit={40} />
            </div>
          ) : <Empty title="Nothing from you yet" body="Your paper trades and theses show up here." action={<button className="btn btn-soft" onClick={() => nav.go('radar')}>Find a coin</button>} />
        ) : tape.length ? (
          <div className="post-list">{tape.map((t) => <TapeCard key={t.id + t.wallet} t={t} />)}</div>
        ) : (
          <Empty
            title={f === 'following' ? 'No swaps from wallets you follow yet' : 'Waiting for swaps'}
            body={f === 'following' ? 'Open a wallet from the feed or the Wallets tab and follow it. Its next swap lands here.' : st.snapshotAt ? 'Real-time swaps need live data, which this page can’t reach. Gem Radar shows the snapshot.' : st.sources['gt-trades']?.ok === false ? `GeckoTerminal trades didn’t load (${st.sources['gt-trades']?.error}). It retries every 30 seconds.` : 'The first batch of real swaps arrives within 30 seconds.'}
          />
        )}
      </DataGate>
    </section>
  );
}

// ======================================================================
// GEM RADAR (combined discovery) + BLUE CHIPS
// ======================================================================
function SignalChips({ c, max = 99 }: { c: Coin; max?: number }) {
  const a = c.audit;
  const chips: { ok: boolean | null; l: string }[] = [
    { ok: a.mintRevoked ?? null, l: a.mintRevoked === undefined ? 'Mint ?' : a.mintRevoked ? 'Mint revoked' : 'Mint live' },
    { ok: a.freezeRevoked ?? null, l: a.freezeRevoked === undefined ? 'Freeze ?' : a.freezeRevoked ? 'Freeze revoked' : 'Freeze live' },
    { ok: a.topHolders === undefined ? null : a.topHolders <= 40, l: a.topHolders === undefined ? 'Top holders ?' : `Top holders ${a.topHolders.toFixed(0)}%` },
    { ok: a.devPct === undefined ? null : a.devPct <= 5, l: a.devPct === undefined ? 'Dev ?' : `Dev ${a.devPct.toFixed(1)}%` },
    { ok: c.liq ? c.liq >= 10_000 : null, l: c.liq ? `Liq ${compact(c.liq)}` : 'Liq ?' },
    { ok: c.socials > 0, l: c.socials ? `${c.socials} link${c.socials > 1 ? 's' : ''}` : 'No socials' },
  ];
  return (
    <div className="chips">
      {chips.slice(0, max).map((x) => (
        <span key={x.l} className={`chip ${x.ok === null ? 'chip-unknown' : x.ok ? 'chip-ok' : 'chip-bad'}`}>{x.ok === null ? null : x.ok ? <Icon.check size={12} /> : <Icon.warn size={12} />}{x.l}</span>
      ))}
    </div>
  );
}

function RiskPill({ c }: { c: Coin }) {
  if (c.rugged) return <span className="pill pill-down">{c.rugged === 'liquidity' ? 'Liquidity pulled' : 'Crashed'}</span>;
  const r = scoreCoin(c).risk;
  return <span className={`pill ${r === 'low' ? 'pill-up' : r === 'medium' ? 'pill-warn' : 'pill-down'}`}>{r === 'low' ? 'Low' : r === 'medium' ? 'Medium' : 'High'} rug risk</span>;
}

function SourceChips({ c }: { c: Coin }) {
  const list = c.sources.filter((s) => s !== 'major');
  if (!list.length) return null;
  return <div className="src-chips">{list.map((s) => <span key={s} className="src-chip">{SOURCE_SHORT[s]}</span>)}</div>;
}

function LaunchCard({ c }: { c: Coin }) {
  const nav = useNav();
  const s = scoreCoin(c);
  const venue = c.launchpad || (c.dexId ? c.dexId.replace(/^pumpfun$/, 'pump.fun') : c.chain);
  return (
    <article className={`launch ${c.rugged ? 'is-rugged' : ''}`}>
      <button className="launch-main" onClick={() => nav.openCoin(c.id)}>
        <ScoreRing score={s.score} />
        <div className="launch-id">
          <div className="row gap-s"><CoinBadge coin={c} size={22} /><b className="launch-sym">${c.symbol}</b><span className="muted small ellipsis">{c.name}</span></div>
          <div className="muted small">{venue} · {ageOf(c)} old{c.holders !== undefined ? ` · ${c.holders.toLocaleString()} holders` : ''}</div>
        </div>
        <div className="launch-num">
          <b className="num">{c.mcap ? compact(c.mcap) : '—'}</b>
          {c.change.h1 !== undefined ? <span className="row gap-s"><Change v={c.change.h1} /><span className="muted small">1h</span></span> : <span className="muted small">no price yet</span>}
        </div>
      </button>
      <SignalChips c={c} max={6} />
      <SourceChips c={c} />
      <div className="launch-foot">
        <RiskPill c={c} />
        <span className="muted small">{s.known}/{s.total} checks known</span>
        <span className="grow" />
        {!c.rugged && c.price > 0 && <button className="btn btn-accent btn-sm" onClick={() => nav.trade({ coinId: c.id, side: 'BUY', usd: 50 })}><Icon.bolt size={14} /> Ape $50</button>}
      </div>
    </article>
  );
}

export function SourceBar() {
  const st = useStore();
  const [open, setOpen] = useState(false);
  const list = Object.values(st.sources);
  const ok = list.filter((s) => s.ok).length;
  return (
    <div className="srcbar">
      <button className="srcbar-sum" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={`pulse ${ok === list.length && ok > 0 ? 'pulse-ok' : ok ? 'pulse-part' : 'pulse-bad'}`} />
        <b>{ok}/{list.length || 0}</b> data sources answering
        <span className="muted small">{open ? 'Hide' : 'Details'}</span>
      </button>
      {open && (
        <ul className="srcbar-list">
          {list.map((s) => (
            <li key={s.id}>
              <span className={`dot ${s.ok ? 'dot-ok' : s.ok === false ? 'dot-bad' : ''}`} />
              <span className="grow">{s.label}</span>
              <span className="muted small num">{s.ok ? `${s.count ?? '—'} items · ${s.at ? ago(s.at) : ''} ago` : s.error || 'waiting'}</span>
            </li>
          ))}
          <li className="muted small">Axiom, GMGN and Photon have no public data API. Each coin page links out to them.</li>
        </ul>
      )}
    </div>
  );
}

type Sort = 'score' | 'new' | 'volume' | 'mcap';
export function RadarView() {
  const st = useStore();
  const [mode, setMode] = useState<'radar' | 'blue'>('radar');
  const [cat, setCat] = useState<string>('all');
  const [chain, setChain] = useState<string>('all');
  const [min, setMin] = useState<string>('0');
  const [sort, setSort] = useState<Sort>('score');
  const [hideRisky, setHideRisky] = useState(false);
  const all = Object.values(st.coins).filter((c) => !st.majors.includes(c.id) && c.price > 0);
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: all.length };
    for (const c of all) for (const k of categoriesOf(st, c)) m[k] = (m[k] || 0) + 1;
    return m;
  }, [all.length, st.sources['ds-pairs']?.at]);
  const scored = all.map((c) => ({ c, s: scoreCoin(c) }));
  const list = scored
    .filter(({ c, s }) => (cat === 'all' || categoriesOf(st, c).includes(cat)) && (chain === 'all' || c.chain === chain) && s.score >= Number(min) && (!hideRisky || (s.risk !== 'high' && !c.rugged)))
    .sort((a, b) => sort === 'score' ? b.s.score - a.s.score : sort === 'new' ? (b.c.createdAt ?? 0) - (a.c.createdAt ?? 0) : sort === 'volume' ? (b.c.vol24 ?? 0) - (a.c.vol24 ?? 0) : b.c.mcap - a.c.mcap)
    .slice(0, 60);
  const rugs = all.filter((c) => c.rugged).length;
  const majors = st.majors.map((id) => st.coins[id]).filter((c) => c && c.price > 0).sort((a, b) => b.mcap - a.mcap);
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>{mode === 'radar' ? 'Gem Radar' : 'Blue chips'}</h1>
          <p className="muted">{mode === 'radar' ? 'Coins found on DexScreener, Jupiter, GeckoTerminal and pump.fun, merged by contract address and scored 0–100 on the contract and holder checks those sites report. Unknown checks count as unknown, not as passes.' : 'Established memecoins with live prices from DexScreener.'}</p>
        </div>
      </header>
      <Seg label="Discover" value={mode} onChange={setMode} options={[{ v: 'radar', l: 'Gem Radar' }, { v: 'blue', l: 'Blue chips' }]} />
      <SourceBar />
      <DataGate>
        {mode === 'radar' ? (
          <>
            <div className="radar-stats">
              <div><b className="num">{all.length}</b><span>coins tracked</span></div>
              <div><b className="num">{counts.hot || 0}</b><span>hot on 2+ sites</span></div>
              <div><b className="num">{counts.pumpfun || 0}</b><span>from pump.fun</span></div>
              <div><b className="num">{rugs}</b><span>rugs caught live</span></div>
            </div>
            <div className="cat-row" role="tablist" aria-label="Category">
              <button role="tab" aria-selected={cat === 'all'} className={`cat ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>All <span className="num">{counts.all}</span></button>
              {CATEGORIES.filter((k) => k.id !== 'blue').map((k) => (
                <button key={k.id} role="tab" aria-selected={cat === k.id} className={`cat ${cat === k.id ? 'on' : ''}`} onClick={() => setCat(k.id)} disabled={!counts[k.id]}>{k.label} <span className="num">{counts[k.id] || 0}</span></button>
              ))}
            </div>
            <div className="toolbar">
              <Seg label="Sort" value={sort} onChange={setSort} options={[{ v: 'score', l: 'Top score' }, { v: 'new', l: 'Newest' }, { v: 'volume', l: 'Volume' }, { v: 'mcap', l: 'Mcap' }]} />
              <label className="select-wrap"><span className="sr-only">Chain</span>
                <select id="radar-chain" value={chain} onChange={(e) => setChain(e.target.value)}>
                  <option value="all">All chains</option><option value="solana">Solana</option><option value="base">Base</option><option value="ethereum">Ethereum</option><option value="bsc">BSC</option>
                </select>
              </label>
              <label className="select-wrap"><span className="sr-only">Minimum score</span>
                <select id="radar-min" value={min} onChange={(e) => setMin(e.target.value)}>
                  <option value="0">Any score</option><option value="50">Score 50+</option><option value="70">Score 70+</option><option value="85">Score 85+</option>
                </select>
              </label>
              <label className="switch"><input id="hide-risky" type="checkbox" checked={hideRisky} onChange={(e) => setHideRisky(e.target.checked)} /><span>Hide high risk</span></label>
            </div>
            <div className="launch-grid">
              {list.length ? list.map(({ c }) => <LaunchCard key={c.id} c={c} />) : <Empty title="Nothing matches" body={all.length ? 'Loosen a filter. New coins arrive every minute.' : 'Coins appear once a source answers and DexScreener prices them.'} />}
            </div>
          </>
        ) : (
          majors.length ? <MarketTable coins={majors} /> : <Empty title="Prices haven’t loaded" body="DexScreener prices refresh every 20 seconds." />
        )}
      </DataGate>
    </section>
  );
}

function MarketTable({ coins }: { coins: Coin[] }) {
  const nav = useNav();
  return (
    <div className="table-wrap">
      <table className="mkt">
        <thead><tr><th>Coin</th><th className="r">Price</th><th className="r">24h</th><th className="r hide-s">Mcap</th><th className="r hide-m">Volume</th><th className="hide-s">Session</th><th></th></tr></thead>
        <tbody>
          {coins.map((c) => (
            <tr key={c.id} onClick={() => nav.openCoin(c.id)}>
              <td><div className="row gap-s"><CoinBadge coin={c} size={30} /><div className="stack"><b>{c.symbol}</b><span className="muted small">{c.name} · {c.chain}</span></div></div></td>
              <td className="r num">{fmtPrice(c.price)}</td>
              <td className="r"><Change v={change24(c)} /></td>
              <td className="r num hide-s">{compact(c.mcap)}</td>
              <td className="r num hide-m">{compact(c.vol24)}</td>
              <td className="hide-s"><Spark points={sparkOf(c)} /></td>
              <td className="r"><button className="btn btn-soft btn-sm" onClick={(e) => { e.stopPropagation(); nav.trade({ coinId: c.id, side: 'BUY', usd: 100 }); }}>Buy</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ======================================================================
// COIN PAGE
// ======================================================================
export function CoinView({ id }: { id: string }) {
  const st = useStore();
  const nav = useNav();
  const c = st.coins[id];
  const [mode, setMode] = useState<'candles' | 'line'>('candles');
  const [axis, setAxis] = useState<'price' | 'mcap'>(c && !st.majors.includes(c.id) ? 'mcap' : 'price');
  const [tab, setTab] = useState<'trades' | 'holders' | 'thesis'>('trades');
  const [draft, setDraft] = useState('');
  const [bull, setBull] = useState(true);
  const [tf, setTf] = useState<Timeframe>(() => { try { return (localStorage.getItem('frenzy.tf') as Timeframe) || '5m'; } catch { return '5m'; } });
  const [chartBusy, setChartBusy] = useState(false);

  useEffect(() => {
    setFocus(id);
    let alive = true;
    const run = async (force = false) => {
      const s = getState();
      const coin = s.coins[id];
      if (!coin) return;
      await Promise.all([loadCandles(s, coin, tf, force), loadTrades(s, coin), loadDetails(s, coin)]);
      if (alive) { setChartBusy(false); emit(); }
    };
    setChartBusy(true);
    run(true);
    const t = setInterval(() => run(true), 30_000);
    return () => { alive = false; clearInterval(t); setFocus(undefined); };
  }, [id, c?.pairAddress, tf]);
  const pickTf = (v: Timeframe) => { setTf(v); try { localStorage.setItem('frenzy.tf', v); } catch { /* ignore */ } };

  useEffect(() => {
    if (tab !== 'holders' || !c) return;
    loadHolders(getState(), c).then(emit);
  }, [tab, id]);

  if (!c) return <section className="view"><button className="back" onClick={nav.back}><Icon.back /> Back</button><Empty title="This coin is gone" body="It dropped off every source." /></section>;
  const d = detail[c.id] || {};
  const pos = st.user.positions[c.id];
  const orders = st.user.orders.filter((o) => o.coinId === c.id);
  const theses = st.user.theses.filter((t) => t.coinId === c.id);
  const s = scoreCoin(c);
  const supply = c.price > 0 ? c.mcap / c.price : 0;
  const tfInfo = TIMEFRAMES.find((x) => x.id === tf)!;
  const haveCandles = !!(d.candles && d.candles.length > 1 && d.candlesTf === tf);
  // keep the newest candle moving with the live price between GeckoTerminal refreshes
  const liveCandles = (() => {
    if (!haveCandles) return [];
    const ks = d.candles!.slice();
    const lastK = ks[ks.length - 1];
    if (c.price > 0 && Date.now() - c.updatedAt < 90_000 && Date.now() - lastK.t < tfInfo.ms * 2) {
      if (Date.now() - lastK.t < tfInfo.ms) ks[ks.length - 1] = { ...lastK, c: c.price, h: Math.max(lastK.h, c.price), l: Math.min(lastK.l, c.price) };
      else ks.push({ t: lastK.t + tfInfo.ms, o: lastK.c, h: Math.max(lastK.c, c.price), l: Math.min(lastK.c, c.price), c: c.price, v: 0 });
    }
    return ks;
  })();
  const candles = haveCandles ? liveCandles : c.spark.map((p) => ({ t: p.t, o: p.p, h: p.p, l: p.p, c: p.p, v: 0 }));
  const cats = categoriesOf(st, c).map((k) => CATEGORIES.find((x) => x.id === k)?.label).filter(Boolean);
  const copyAddr = () => {
    navigator.clipboard?.writeText(c.address).then(() => nav.toast('info', 'Address copied'), () => nav.toast('info', 'Copy blocked', c.address));
  };
  return (
    <section className="view coin-view">
      <button className="back" onClick={nav.back}><Icon.back /> Back</button>
      {c.header && <BannerImg src={c.header} />}
      <header className="coin-head">
        <CoinBadge coin={c} size={72} />
        <div className="coin-title">
          <h1>${c.symbol} <span className="muted coin-name">{c.name}</span></h1>
          <div className="row gap-s wrap small muted">
            <span className="tag tag-plain">{c.chain}</span>
            {(c.launchpad || c.dexId) && <span>{c.launchpad || c.dexId}</span>}
            <button className="link num" onClick={copyAddr}>{short(c.address)} <Icon.copy size={12} /></button>
          </div>
        </div>
        <div className="coin-price">
          <b className="num big">{c.price > 0 ? fmtPrice(c.price) : '—'}</b>
          <div className="row gap-s">{c.change.h24 !== undefined && <><Change v={c.change.h24} /><span className="muted small">24h</span></>}<span className="muted small">· updated {c.updatedAt ? ago(c.updatedAt) + ' ago' : 'never'}</span></div>
        </div>
      </header>
      {c.rugged && <div className="banner banner-down"><Icon.warn /> {c.rugged === 'liquidity' ? 'Most of this pool’s liquidity was pulled while you were watching.' : 'Price fell more than 90% from its peak this session.'} Selling returns very little.</div>}
      {cats.length > 0 && <div className="chips">{cats.map((l) => <span key={l} className="chip chip-cat">{l}</span>)}</div>}
      <div className="panel">
        <div className="toolbar">
          <Seg label="Timeframe" value={tf} onChange={pickTf} options={TIMEFRAMES.map((x) => ({ v: x.id, l: x.label }))} />
          <Seg label="Chart axis" value={axis} onChange={setAxis} options={[{ v: 'price', l: 'Price' }, { v: 'mcap', l: 'MCap' }]} />
          <Seg label="Chart type" value={haveCandles ? mode : 'line'} onChange={setMode} options={haveCandles ? [{ v: 'candles', l: 'Candles' }, { v: 'line', l: 'Line' }] : [{ v: 'line', l: 'Line' }]} />
          <span className="muted small">{chartBusy ? 'Loading candles…' : haveCandles ? `${tfInfo.label} candles · GeckoTerminal · live` : d.candlesError ? `Candles unavailable (${d.candlesError}). Showing prices sampled this session.` : candles.length > 1 ? 'Prices sampled this session' : 'Waiting for chart data'}</span>
        </div>
        {candles.length > 1 ? (
          <PriceChart candles={candles} mode={haveCandles ? mode : 'line'} entry={pos ? pos.cost / pos.qty : undefined} supply={supply} showMcap={axis === 'mcap' && supply > 0} stepMs={haveCandles ? tfInfo.ms : 60_000} />
        ) : <div className="chart-empty muted">{st.snapshotAt ? 'Charts need live data. This view is a frozen snapshot.' : 'Chart fills in as prices arrive.'}</div>}
        <dl className="stats">
          <div><dt>Market cap</dt><dd className="num">{c.mcap ? compact(c.mcap) : '—'}</dd></div>
          <div><dt>Liquidity</dt><dd className="num">{c.liq ? compact(c.liq) : '—'}</dd></div>
          <div><dt>24h volume</dt><dd className="num">{c.vol24 ? compact(c.vol24) : '—'}</dd></div>
          <div><dt>Holders</dt><dd className="num">{c.holders !== undefined ? c.holders.toLocaleString() : '—'}</dd></div>
          <div><dt>24h buys / sells</dt><dd className="num">{c.buys24 !== undefined ? `${compact(c.buys24, '')} / ${compact(c.sells24 ?? 0, '')}` : '—'}</dd></div>
          <div><dt>Age</dt><dd className="num">{ageOf(c)}</dd></div>
          <div><dt>1h volume</dt><dd className="num">{c.vol1h ? compact(c.vol1h) : '—'}</dd></div>
          <div><dt>Top holders</dt><dd className="num">{c.audit.topHolders !== undefined ? `${c.audit.topHolders.toFixed(1)}%` : '—'}</dd></div>
          <div><dt>Deployer</dt><dd className="num">{c.audit.devPct !== undefined ? `${c.audit.devPct.toFixed(2)}%` : '—'}</dd></div>
          <div><dt>Organic score</dt><dd className="num">{c.organic ? `${c.organic.score.toFixed(0)} · ${c.organic.label}` : '—'}</dd></div>
          <div><dt>Venue</dt><dd>{c.dexId || c.launchpad || '—'}</dd></div>
          <div><dt>Price in SOL</dt><dd className="num">{st.solPrice && c.price > 0 ? `${(c.price / st.solPrice).toPrecision(4)} SOL` : '—'}</dd></div>
        </dl>
        <div className="changes">
          {([['5m', c.change.m5], ['1h', c.change.h1], ['6h', c.change.h6], ['24h', c.change.h24]] as [string, number | undefined][]).map(([k, v]) => (
            <div key={k}><span className="muted small">{k}</span>{v !== undefined ? <Change v={v} /> : <span className="muted">—</span>}</div>
          ))}
        </div>
      </div>

      <div className="coin-cols">
        <div className="stack gap">
          <div className="panel gem-panel">
            <div className="row gap">
              <ScoreRing score={s.score} size={64} />
              <div className="stack">
                <b>Gem Score {s.score}</b>
                <span className="muted small">{s.reasons.length ? s.reasons.join(' · ') : 'No red flags in the checks we could read.'}</span>
                <div className="row gap-s wrap"><RiskPill c={c} /><span className="muted small">{s.known} of {s.total} checks reported</span></div>
              </div>
            </div>
            <SignalChips c={c} />
            <SourceChips c={c} />
            {c.organic && <p className="muted small">Jupiter organic score {c.organic.score.toFixed(0)} ({c.organic.label}).</p>}
            {c.description && <p className="small">{c.description}</p>}
          </div>
          {c.chain === 'solana' && (
            <div className="panel">
              <div className="row gap-s"><h2>RugCheck report</h2><span className="grow" />{d.rug?.score !== undefined && <span className={`pill ${d.rug.score <= 20 ? 'pill-up' : d.rug.score <= 60 ? 'pill-warn' : 'pill-down'}`}>Risk {d.rug.score}/100</span>}</div>
              {d.rug ? (
                d.rug.risks.length ? (
                  <ul className="risks">
                    {d.rug.risks.slice(0, 8).map((r) => (
                      <li key={r.name}><span className={`dot ${r.level === 'danger' ? 'dot-bad' : r.level === 'warn' ? 'dot-warn' : ''}`} /><span><b>{r.name}</b>{r.description ? <span className="muted small"> · {r.description}</span> : null}</span></li>
                    ))}
                  </ul>
                ) : <p className="muted small">RugCheck found no risks for this token.</p>
              ) : <p className="muted small">{d.rugError ? `RugCheck didn’t answer (${d.rugError}).` : 'Loading from rugcheck.xyz…'}</p>}
              <a className="link small" href={`https://rugcheck.xyz/tokens/${c.address}`} target="_blank" rel="noopener noreferrer">Full report on RugCheck <Icon.external size={12} /></a>
            </div>
          )}
          <div className="panel">
            <h2>Trade or check it elsewhere</h2>
            <div className="ext-links">
              {tradeLinks(c.chain, c.address, c.pairAddress).map((l) => <a key={l.label} className="ext" href={l.url} target="_blank" rel="noopener noreferrer">{l.label} <Icon.external size={12} /></a>)}
              {c.links.slice(0, 4).map((l) => <a key={l.url} className="ext ext-plain" href={l.url} target="_blank" rel="noopener noreferrer">{l.type} <Icon.external size={12} /></a>)}
            </div>
          </div>
          <div className="panel">
            <h2>Your paper position</h2>
            {pos ? (
              <>
                <dl className="stats stats-3">
                  <div><dt>Value</dt><dd className="num">{usd(pos.qty * c.price)}</dd></div>
                  <div><dt>Avg entry</dt><dd className="num">{fmtPrice(pos.cost / pos.qty)}</dd></div>
                  <div><dt>PnL</dt><dd className={`num ${pos.qty * c.price >= pos.cost ? 'up' : 'down'}`}>{signedUsd(pos.qty * c.price - pos.cost)} <small>{pct((pos.qty * c.price / pos.cost - 1) * 100)}</small></dd></div>
                </dl>
                <p className="muted small num">{fmtQty(pos.qty)} {c.symbol}</p>
              </>
            ) : <p className="muted">You don’t hold ${c.symbol}. Paper buys fill at the live price using your cash of {usd(st.user.cash)}.</p>}
            {orders.length > 0 && (
              <ul className="orders">
                {orders.map((o) => (
                  <li key={o.id}>
                    <span className={`tag ${o.kind === 'sl' ? 'tag-down' : 'tag-up'}`}>{o.kind === 'sl' ? 'Stop' : o.kind === 'tp' ? 'Take profit' : 'Limit buy'}</span>
                    <span className="num">{o.side === 'BUY' ? `${usd(o.usd || 0)} at ` : `${o.pct}% at `}{fmtPrice(o.trigger)}</span>
                    <span className="grow" />
                    <button className="link small" onClick={() => act((x) => cancelOrder(x, o.id))}>Cancel</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="panel">
          <Seg label="Coin activity" value={tab} onChange={setTab} options={[{ v: 'trades', l: 'Live trades' }, { v: 'holders', l: 'Holders' }, { v: 'thesis', l: `Your thesis · ${theses.length}` }]} />
          {tab === 'trades' && (
            !c.pairAddress ? <p className="muted">No pool found for this coin yet.</p> :
            d.trades === undefined ? <p className="muted">Loading swaps from GeckoTerminal…</p> :
            d.trades.length === 0 ? <p className="muted">{st.sources['gt-trades']?.ok === false ? `Couldn’t load swaps (${st.sources['gt-trades']?.error}).` : 'No swaps in this pool recently.'}</p> : (
              <ul className="tape">
                {d.trades.slice(0, 40).map((t) => (
                  <li key={t.id + t.wallet}>
                    <span className={`tag ${t.side === 'BUY' ? 'tag-up' : 'tag-down'}`}>{t.side === 'BUY' ? 'Buy' : 'Sell'}</span>
                    <button className="link num" onClick={() => nav.openTrader(t.wallet)}>{short(t.wallet)}</button>
                    <span className="grow" />
                    <span className="num">{compact(t.usd)}</span>
                    <span className="num muted hide-s">{fmtPrice(t.price)}</span>
                    <span className="muted small">{ago(t.t)}</span>
                  </li>
                ))}
              </ul>
            )
          )}
          {tab === 'holders' && (
            <div className="stack gap">
              <dl className="stats stats-3">
                <div><dt>Holders</dt><dd className="num">{c.holders !== undefined ? c.holders.toLocaleString() : '—'}</dd></div>
                <div><dt>Top holders</dt><dd className="num">{c.audit.topHolders !== undefined ? `${c.audit.topHolders.toFixed(1)}%` : '—'}</dd></div>
                <div><dt>Deployer</dt><dd className="num">{c.audit.devPct !== undefined ? `${c.audit.devPct.toFixed(2)}%` : '—'}</dd></div>
              </dl>
              {c.chain !== 'solana' ? <p className="muted small">Wallet-level holders are only loaded for Solana coins. Use the explorer link for this chain.</p> :
                d.holders ? (
                  <div className="table-wrap">
                    <table className="mkt holders">
                      <thead><tr><th>Token account</th><th className="r">Supply</th><th className="r">Value</th></tr></thead>
                      <tbody>
                        {d.holders.map((h, i) => (
                          <tr key={h.address}>
                            <td className="num">{i + 1}. <a className="link" href={`https://solscan.io/account/${h.address}`} target="_blank" rel="noopener noreferrer">{short(h.address)}</a>{i === 0 && isPumpFun(c) && c.dexId === 'pumpfun' ? <span className="tag tag-plain">bonding curve</span> : null}</td>
                            <td className="r num">{h.pct < 0.01 ? '<0.01' : h.pct.toFixed(2)}%</td>
                            <td className="r num">{compact((h.pct / 100) * c.mcap)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted small">{d.holdersError ? `Couldn’t load the holder list: ${d.holdersError}` : 'Loading the 20 largest token accounts from Solana…'}</p>}
            </div>
          )}
          {tab === 'thesis' && (
            <div className="stack gap">
              <form className="composer" onSubmit={(e) => {
                e.preventDefault();
                const text = draft.trim();
                if (!text) return;
                act((x) => { x.user.theses.unshift({ id: uid('th'), t: Date.now(), coinId: c.id, bull, text, price: c.price, mcap: c.mcap }); });
                setDraft('');
                nav.toast('info', 'Thesis saved', 'It tracks the price from now on, so you can see if you were right.');
              }}>
                <div className="row gap-s">
                  <button type="button" className={`chip-btn ${bull ? 'on-up' : ''}`} onClick={() => setBull(true)}>Bullish</button>
                  <button type="button" className={`chip-btn ${!bull ? 'on-down' : ''}`} onClick={() => setBull(false)}>Bearish</button>
                </div>
                <label htmlFor={`thesis-${c.id}`} className="sr-only">Your thesis</label>
                <textarea id={`thesis-${c.id}`} rows={2} maxLength={240} placeholder={`Why are you ${bull ? 'in' : 'out of'} $${c.symbol}?`} value={draft} onChange={(e) => setDraft(e.target.value)} />
                <div className="row"><span className="muted small num">{draft.length}/240</span><span className="grow" /><button className="btn btn-soft btn-sm" disabled={!draft.trim()}>Save thesis</button></div>
              </form>
              {theses.length ? theses.map((th) => <ThesisCard key={th.id} th={th} />) : <p className="muted small">Only you see your theses. Nobody else uses this app yet, so there are no other people’s posts to show.</p>}
            </div>
          )}
        </div>
      </div>

      <div className="trade-bar">
        <button className="btn btn-down-solid" disabled={!pos} onClick={() => nav.trade({ coinId: c.id, side: 'SELL' })}>Sell</button>
        <button className="btn btn-accent" disabled={!!c.rugged || !(c.price > 0)} onClick={() => nav.trade({ coinId: c.id, side: 'BUY', usd: 100 })}>Buy ${c.symbol}</button>
      </div>
    </section>
  );
}

// ======================================================================
// WALLET / PORTFOLIO
// ======================================================================
function ActivityList({ limit = 80 }: { limit?: number }) {
  const st = useStore();
  const nav = useNav();
  return (
    <ul className="tape activity">
      {st.user.trades.slice(0, limit).map((t) => (
        <li key={t.id} onClick={() => st.coins[t.coinId] && nav.openCoin(t.coinId)}>
          <span className={`tag ${t.side === 'BUY' ? 'tag-up' : 'tag-down'}`}>{t.side === 'BUY' ? 'Buy' : 'Sell'}</span>
          <b>${t.symbol}</b>
          {t.via && t.via !== 'market' && <span className="tag tag-plain">{t.via === 'tp' ? 'take profit' : t.via === 'sl' ? 'stop' : t.via}</span>}
          <span className="grow" />
          <span className="num">{usd(t.usd)}</span>
          <span className="num muted hide-s">@ {fmtPrice(t.price)}</span>
          {t.pnl !== undefined && <span className={`num ${t.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(t.pnl)}</span>}
          <span className="muted small">{ago(t.t)}</span>
        </li>
      ))}
    </ul>
  );
}

export function WalletView() {
  const st = useStore();
  const nav = useNav();
  const s = userStats(st);
  const [confirmReset, setConfirmReset] = useState(false);
  const [hist, setHist] = useState<'positions' | 'activity'>('positions');
  const positions = Object.values(st.user.positions).map((p) => ({ p, c: st.coins[p.coinId] })).filter((x) => x.c).sort((a, b) => b.p.qty * b.c.price - a.p.qty * a.c.price);
  const fum = fumbles(st);
  const topFum = fum[0];
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Wallet</h1>
          <p className="muted">Paper money on live prices. You started with {usd(START_CASH, 0)}{st.user.deposits > START_CASH ? ` and added ${usd(st.user.deposits - START_CASH, 0)}` : ''}. Every buy, sell and order saves automatically in this browser; back it up to move it to another device.</p>
        </div>
        <button className="btn btn-soft" onClick={nav.share}><Icon.share size={16} /> Share PnL</button>
      </header>
      <div className="panel wallet-hero">
        <div className="wallet-top">
          <div>
            <span className="eyebrow">Total value</span>
            <b className="num huge">{usd(s.equity)}</b>
            <span className={`num ${s.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(s.pnl)} · {pct(s.pnlPct, 2)} all time</span>
          </div>
          <dl className="stats stats-4">
            <div><dt>Cash</dt><dd className="num">{usd(st.user.cash)}</dd></div>
            <div><dt>Realized</dt><dd className={`num ${s.realized >= 0 ? 'up' : 'down'}`}>{signedUsd(s.realized)}</dd></div>
            <div><dt>Unrealized</dt><dd className={`num ${s.unreal >= 0 ? 'up' : 'down'}`}>{signedUsd(s.unreal)}</dd></div>
            <div><dt>Win rate</dt><dd className="num">{s.sells ? `${s.winRate.toFixed(0)}%` : '—'}</dd></div>
          </dl>
        </div>
        <EquityChart points={st.user.equity.slice(-720)} base={st.user.deposits} />
        <div className="row gap-s wrap">
          <button className="btn btn-ghost btn-sm" onClick={() => { act((x) => { x.user.cash += 5000; x.user.deposits += 5000; }); nav.toast('info', 'Added $5,000 paper cash', 'Deposits are tracked, so this doesn’t count as profit.'); }}><Icon.plus size={14} /> Add $5K paper cash</button>
          <button className="btn btn-ghost btn-sm" onClick={() => {
            const blob = new Blob([exportWallet(getState())], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `frenzy-wallet-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
            nav.toast('info', 'Wallet backup saved', `${st.user.trades.length} trades and ${Object.keys(st.user.positions).length} positions.`);
          }}><Icon.share size={14} /> Back up wallet</button>
          <label className="btn btn-ghost btn-sm file-btn" htmlFor="wallet-import"><Icon.reset size={14} /> Restore backup
            <input id="wallet-import" type="file" accept="application/json,.json" onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              f.text().then((txt) => { const r = act((x) => importWallet(x, txt)); nav.toast(r.ok ? 'up' : 'down', r.ok ? 'Wallet restored' : 'Restore failed', r.message); });
              e.target.value = '';
            }} />
          </label>
          {!confirmReset ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(true)}><Icon.reset size={14} /> Reset wallet</button>
          ) : (
            <span className="confirm">Reset to {usd(START_CASH, 0)} and clear all trades?
              <button className="btn btn-down-solid btn-sm" onClick={() => {
                act((x) => { x.user.cash = START_CASH; x.user.deposits = START_CASH; x.user.positions = {}; x.user.trades = []; x.user.orders = []; x.user.theses = []; x.user.equity = [{ t: Date.now(), v: START_CASH }]; });
                setConfirmReset(false); nav.toast('info', 'Wallet reset');
              }}>Reset</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(false)}>Keep</button>
            </span>
          )}
        </div>
      </div>

      {topFum && topFum.missed > 1 && topFum.mult >= 1.05 && (
        <div className="panel fumble">
          <div className="fumble-l">
            <span className="eyebrow">Fumbled</span>
            <b className="num big">{compact(topFum.missed)}</b>
            <span className="muted small">You sold ${topFum.trade.symbol} at {fmtPrice(topFum.trade.price)}. It ran to {fmtPrice(topFum.trade.peakAfter!)} after ({topFum.mult.toFixed(2)}x).</span>
          </div>
          <div className="fumble-r muted small">Total left on the table across {fum.length} sell{fum.length > 1 ? 's' : ''}: <b className="num">{compact(fum.reduce((a, f) => a + f.missed, 0))}</b></div>
        </div>
      )}

      <Seg label="Wallet section" value={hist} onChange={setHist} options={[{ v: 'positions', l: `Positions · ${positions.length}` }, { v: 'activity', l: `Activity · ${st.user.trades.length}` }]} />
      {hist === 'positions' ? (
        positions.length ? (
          <div className="pos-list">
            {positions.map(({ p, c }) => {
              const val = p.qty * c.price;
              const pnl = val - p.cost;
              const o = st.user.orders.filter((x) => x.coinId === c.id);
              return (
                <article key={c.id} className="pos" onClick={() => nav.openCoin(c.id)}>
                  <CoinBadge coin={c} />
                  <div className="stack">
                    <b>${c.symbol}{c.rugged && <span className="tag tag-down">Rugged</span>}</b>
                    <span className="muted small num">{fmtQty(p.qty)} · avg {fmtPrice(p.cost / p.qty)}{o.length ? ` · ${o.length} order${o.length > 1 ? 's' : ''}` : ''}</span>
                  </div>
                  <span className="grow" />
                  <div className="stack r">
                    <b className="num">{usd(val)}</b>
                    <span className={`num small ${pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(pnl)} · {pct((val / p.cost - 1) * 100)}</span>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); nav.trade({ coinId: c.id, side: 'SELL' }); }}>Sell</button>
                </article>
              );
            })}
          </div>
        ) : <Empty title="No open positions" body="Find something on Gem Radar or copy a real swap from the Live feed." action={<button className="btn btn-accent" onClick={() => nav.go('radar')}>Open Gem Radar</button>} />
      ) : (
        st.user.trades.length ? <ActivityList /> : <Empty title="No trades yet" body="Your buys and sells show up here with fees and realized PnL." />
      )}
    </section>
  );
}

// ======================================================================
// WALLETS (real wallets seen on-chain) + WALLET PAGE
// ======================================================================
export function LeadersView() {
  const st = useStore();
  const nav = useNav();
  const [by, setBy] = useState<'vol' | 'trades' | 'following'>('vol');
  const s = userStats(st);
  let rows = topWallets(st);
  if (by === 'trades') rows = rows.sort((a, b) => b.buys + b.sells - (a.buys + a.sells));
  if (by === 'following') rows = rows.filter((w) => st.user.following.includes(w.address));
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Wallets</h1>
          <p className="muted">Real wallets seen swapping in the pools Frenzy watches, ranked by volume this session. Nobody else uses Frenzy yet, so there’s no user leaderboard. Your paper wallet is shown on its own.</p>
        </div>
      </header>
      <button className="you-row" onClick={() => nav.go('wallet')}>
        <Avatar you />
        <div className="stack"><b>Your paper wallet</b><span className="muted small num">{st.user.trades.length} trades · {s.sells ? `${s.winRate.toFixed(0)}% wins` : 'no closed trades'}</span></div>
        <span className="grow" />
        <div className="stack r"><b className="num">{usd(s.equity)}</b><span className={`num small ${s.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(s.pnl)} · {pct(s.pnlPct, 2)}</span></div>
      </button>
      <Seg label="Rank by" value={by} onChange={setBy} options={[{ v: 'vol', l: 'Volume' }, { v: 'trades', l: 'Swaps' }, { v: 'following', l: `Following · ${st.user.following.length}` }]} />
      <DataGate>
        {rows.length ? (
          <ol className="leaders">
            {rows.slice(0, 50).map((w, i) => (
              <li key={w.address} onClick={() => nav.openTrader(w.address)}>
                <span className={`rank num ${i < 3 ? 'rank-top' : ''}`}>{i + 1}</span>
                <Avatar wallet={w.address} />
                <div className="stack">
                  <b className="num">{short(w.address)}</b>
                  <span className="muted small num">{w.buys} buys · {w.sells} sells · {w.coins.length} coin{w.coins.length > 1 ? 's' : ''} · {ago(w.lastSeen)} ago</span>
                </div>
                <span className="grow" />
                <b className="num">{compact(w.vol)}</b>
                <FollowButton id={w.address} small />
              </li>
            ))}
          </ol>
        ) : <Empty title={by === 'following' ? 'You don’t follow any wallets' : 'No wallets seen yet'} body={by === 'following' ? 'Tap a wallet in the Live feed to follow it.' : 'Wallets appear as real swaps come in, within about 30 seconds.'} />}
      </DataGate>
    </section>
  );
}

export function TraderView({ id }: { id: string }) {
  const st = useStore();
  const nav = useNav();
  const w = st.wallets[id];
  const trades = st.tape.filter((t) => t.wallet === id);
  const chain = w?.chain || 'solana';
  const copy = () => navigator.clipboard?.writeText(id).then(() => nav.toast('info', 'Address copied'), () => nav.toast('info', 'Copy blocked', id));
  return (
    <section className="view">
      <button className="back" onClick={nav.back}><Icon.back /> Back</button>
      <header className="trader-head panel">
        <Avatar wallet={id} size={64} />
        <div className="stack">
          <h1 className="num wallet-title">{short(id)}</h1>
          <div className="row gap-s wrap small">
            <button className="link" onClick={copy}>Copy address <Icon.copy size={12} /></button>
            <a className="link" href={walletLink(chain, id)} target="_blank" rel="noopener noreferrer">Explorer <Icon.external size={12} /></a>
            {chain === 'solana' && <a className="link" href={`https://gmgn.ai/sol/address/${id}`} target="_blank" rel="noopener noreferrer">GMGN <Icon.external size={12} /></a>}
          </div>
          <span className="muted small">Only swaps Frenzy saw this session are listed. The explorer has the full history.</span>
        </div>
        <span className="grow" />
        <FollowButton id={id} />
      </header>
      {w && (
        <dl className="stats stats-4 panel">
          <div><dt>Volume seen</dt><dd className="num">{compact(w.vol)}</dd></div>
          <div><dt>Buys</dt><dd className="num">{w.buys}</dd></div>
          <div><dt>Sells</dt><dd className="num">{w.sells}</dd></div>
          <div><dt>Last swap</dt><dd className="num">{ago(w.lastSeen)} ago</dd></div>
        </dl>
      )}
      <h2>Swaps seen</h2>
      <div className="post-list">{trades.length ? trades.slice(0, 40).map((t) => <TapeCard key={t.id + t.wallet} t={t} />) : <p className="muted">No swaps from this wallet in the current session.</p>}</div>
    </section>
  );
}


// ======================================================================
// HOME
// ======================================================================
function CoinRow({ c, right }: { c: Coin; right?: React.ReactNode }) {
  const nav = useNav();
  return (
    <li>
      <button className="coin-row" onClick={() => nav.openCoin(c.id)}>
        <CoinBadge coin={c} size={40} />
        <span className="stack grow">
          <b className="ellipsis">${c.symbol} <span className="muted small">{c.name}</span></b>
          <span className="muted small num">{fmtPrice(c.price)} · {c.mcap ? compact(c.mcap) : '—'} mcap</span>
        </span>
        {right}
      </button>
    </li>
  );
}

function MoverTile({ c }: { c: Coin }) {
  const nav = useNav();
  const ch = c.change.h1 ?? 0;
  return (
    <button className="mover" onClick={() => nav.openCoin(c.id)}>
      <div className="row gap-s"><CoinBadge coin={c} size={44} /><span className="stack"><b className="ellipsis">${c.symbol}</b><span className="muted small ellipsis">{c.name}</span></span></div>
      <b className="num mover-price">{fmtPrice(c.price)}</b>
      <div className="row gap-s"><Change v={ch} /><span className="muted small">1h</span><span className="grow" /><Spark points={sparkOf(c)} width={70} height={26} /></div>
    </button>
  );
}

export function HomeView() {
  const st = useStore();
  const nav = useNav();
  const s = userStats(st);
  const priced = Object.values(st.coins).filter((c) => c.price > 0 && !c.rugged);
  const memes = priced.filter((c) => !st.majors.includes(c.id));
  const movers = memes.filter((c) => c.change.h1 !== undefined && c.liq >= 10_000).sort((a, b) => Math.abs(b.change.h1!) - Math.abs(a.change.h1!)).slice(0, 10);
  const gainers = memes.filter((c) => (c.change.h24 ?? 0) > 0 && c.liq >= 10_000).sort((a, b) => (b.change.h24 ?? 0) - (a.change.h24 ?? 0)).slice(0, 6);
  const trending = memes.filter((c) => categoriesOf(st, c).includes('hot') || c.sources.includes('jup-trending')).sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0)).slice(0, 8);
  const fresh = memes.filter((c) => c.createdAt && Date.now() - c.createdAt < 864e5).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 8);
  const live = memes.filter((c) => c.pumpLive).sort((a, b) => b.mcap - a.mcap).slice(0, 8);
  const blue = st.majors.map((id) => st.coins[id]).filter((c) => c && c.price > 0).sort((a, b) => b.mcap - a.mcap);
  const vol = memes.reduce((a, c) => a + (c.vol24 || 0), 0);
  const srcs = Object.values(st.sources);
  const okSrc = srcs.filter((x) => x.ok).length;
  const tape = st.tape.slice(0, 6);
  return (
    <section className="view home">
      <header className="home-hero">
        <div className="stack">
          <span className="eyebrow">{st.snapshotAt ? 'Snapshot' : 'Live'} · Solana memecoin market</span>
          <h1>What’s moving right now</h1>
          <p className="muted">Real prices from Jupiter, DexScreener, GeckoTerminal and pump.fun, refreshed every 20 seconds. Paper trades fill at those prices.</p>
        </div>
        <dl className="hero-stats">
          <div><dt>SOL</dt><dd className="num">{st.solPrice ? usd(st.solPrice) : '—'}</dd></div>
          <div><dt>Coins tracked</dt><dd className="num">{memes.length}</dd></div>
          <div><dt>Their 24h volume</dt><dd className="num">{vol ? compact(vol) : '—'}</dd></div>
          <div><dt>Sources answering</dt><dd className="num">{okSrc}/{srcs.length || 0}</dd></div>
        </dl>
      </header>
      <DataGate>
        <div className="stack gap">
          <section className="home-sec">
            <div className="row"><h2>Biggest movers · 1h</h2><span className="grow" /><button className="link small" onClick={() => nav.go('radar')}>Gem Radar</button></div>
            {movers.length ? <div className="movers">{movers.map((c) => <MoverTile key={c.id} c={c} />)}</div> : <p className="muted small">Movers appear once prices load.</p>}
          </section>

          <div className="home-grid">
            <section className="panel">
              <h2>Trending now</h2>
              <p className="muted small">Hot on Jupiter, DexScreener and GeckoTerminal, by 24h volume.</p>
              <ul className="coin-list">
                {trending.map((c) => <CoinRow key={c.id} c={c} right={<span className="stack r"><b className="num small">{c.vol24 ? compact(c.vol24) : '—'}</b>{c.change.h24 !== undefined && <Change v={c.change.h24} />}</span>} />)}
                {!trending.length && <li className="muted small">Nothing trending on 2+ sites yet.</li>}
              </ul>
            </section>
            <section className="panel">
              <h2>Fresh launches</h2>
              <p className="muted small">Under 24 hours old, newest first, with Gem Score.</p>
              <ul className="coin-list">
                {fresh.map((c) => { const sc = scoreCoin(c); return <CoinRow key={c.id} c={c} right={<span className="row gap-s"><span className="muted small num">{ageOf(c)}</span><ScoreRing score={sc.score} size={34} /></span>} />; })}
                {!fresh.length && <li className="muted small">No new launches loaded yet.</li>}
              </ul>
            </section>
          </div>

          {live.length > 0 && (
            <section className="home-sec">
              <div className="row"><h2>Live on pump.fun</h2><span className="grow" /><span className="muted small">Creators streaming now</span></div>
              <div className="movers">{live.map((c) => <MoverTile key={c.id} c={c} />)}</div>
            </section>
          )}

          <div className="home-grid">
            <section className="panel">
              <h2>Top gainers · 24h</h2>
              <ul className="coin-list">
                {gainers.map((c) => <CoinRow key={c.id} c={c} right={<Change v={c.change.h24 ?? 0} />} />)}
                {!gainers.length && <li className="muted small">No gainers with $10K+ liquidity right now.</li>}
              </ul>
            </section>
            <section className="panel">
              <h2>Blue chips</h2>
              <ul className="coin-list">
                {blue.slice(0, 8).map((c) => <CoinRow key={c.id} c={c} right={c.change.h24 !== undefined ? <Change v={c.change.h24} /> : undefined} />)}
                {!blue.length && <li className="muted small">Loading prices…</li>}
              </ul>
            </section>
          </div>

          <div className="home-grid">
            <section className="panel">
              <div className="row"><h2>Your paper wallet</h2><span className="grow" /><button className="link small" onClick={() => nav.go('wallet')}>Open</button></div>
              <b className="num huge">{usd(s.equity)}</b>
              <span className={`num ${s.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(s.pnl)} · {pct(s.pnlPct, 2)} all time</span>
              <span className="muted small">{Object.keys(st.user.positions).length} open positions · {st.user.trades.length} trades saved</span>
            </section>
            <section className="panel">
              <div className="row"><h2>Latest real swaps</h2><span className="grow" /><button className="link small" onClick={() => nav.go('feed')}>Live feed</button></div>
              <ul className="tape">
                {tape.map((t) => { const c = st.coins[t.coinId]; return c ? (
                  <li key={t.id + t.wallet} onClick={() => nav.openCoin(c.id)}>
                    <CoinBadge coin={c} size={24} />
                    <span className={`tag ${t.side === 'BUY' ? 'tag-up' : 'tag-down'}`}>{t.side === 'BUY' ? 'Buy' : 'Sell'}</span>
                    <b>${c.symbol}</b><span className="grow" /><span className="num">{compact(t.usd)}</span><span className="muted small">{ago(t.t)}</span>
                  </li>
                ) : null; })}
                {!tape.length && <li className="muted small">{st.snapshotAt ? 'Swaps need live data.' : 'The first real swaps arrive within 30 seconds.'}</li>}
              </ul>
            </section>
          </div>
        </div>
      </DataGate>
    </section>
  );
}
