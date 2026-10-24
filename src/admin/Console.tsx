/**
 * BAGZ admin console panels: Overview (KPIs + daily charts), Accounts (every sign-up), Transactions and Activity log.
 * All data comes from /v1/admin/* on the Worker, which requires an admin session. Read-only.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { adminOverview, adminUsers, adminLog, type AdminOverview, type AdminUser, type AdminEvent, type Daily } from '../trading/api';
import { avatarUrl } from '../social/api';
import { compact, pct, ago } from '../format';
import { short } from '../engine';

type P = { token: string; onAuthError: (e: any) => void };
const n0 = (n: number) => n.toLocaleString('en-US');
const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** download rows as a CSV file (opens in Excel / Google Sheets) */
export function downloadCsv(name: string, head: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: unknown) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'up' | 'down' }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value num${tone ? ' ' + tone : ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

/** daily bar chart; tap or hover a bar to read its day */
export function Bars({ data, label, unit = '', fmt = n0, floor = 1 }: { data: Daily[]; label: string; unit?: string; fmt?: (n: number) => string; floor?: number }) {
  const [hi, setHi] = useState<number | null>(null);
  const peak = Math.max(0, ...data.map((d) => d.n));
  const max = Math.max(floor, peak); // bar scale; the caption shows the real peak
  const total = data.reduce((s, d) => s + d.n, 0);
  const W = 600, H = 150, gap = data.length > 40 ? 1 : 3, bw = (W - gap * (data.length - 1)) / data.length;
  const pick = hi === null ? null : data[hi];
  const fmtDay = (k: string) => new Date(k + 'T12:00:00Z').toLocaleDateString([], { month: 'short', day: 'numeric' });
  return (
    <figure className="bars">
      <figcaption className="row gap-s">
        <span className="kpi-label">{label}</span><span className="grow" />
        <span className="small num">{pick ? <><b>{fmt(pick.n)}</b>{unit} · {fmtDay(pick.day)}</> : <><b>{fmt(total)}</b>{unit} total · peak {fmt(peak)}</>}</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${label}: ${total} over ${data.length} days`} onMouseLeave={() => setHi(null)}>
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="bars-base" />
        {data.map((d, i) => {
          const h = d.n ? Math.max(3, (d.n / max) * (H - 8)) : 0;
          return (
            <g key={d.day} onMouseEnter={() => setHi(i)} onClick={() => setHi(i)}>
              <rect x={i * (bw + gap)} y={0} width={bw} height={H} fill="transparent" />
              <rect x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={Math.min(3, bw / 3)} className={hi === i ? 'bar on' : 'bar'} />
            </g>
          );
        })}
      </svg>
      <div className="bars-axis small muted"><span>{fmtDay(data[0]?.day || '')}</span><span>Today</span></div>
    </figure>
  );
}

// ---- overview ---------------------------------------------------------------------------------------------------
export function OverviewPanel({ token, onAuthError }: P) {
  const [days, setDays] = useState(30);
  const [o, setO] = useState<AdminOverview | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { setO(await adminOverview(token, days)); setErr(''); }
    catch (e: any) { setErr(e?.message || 'Couldn’t load stats'); onAuthError(e); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const id = setInterval(load, 60_000); return () => clearInterval(id); }, [token, days]);

  if (!o) return <div className="panel"><p className="muted small">{err || 'Loading stats…'}</p></div>;
  const u = o.users, p = o.paper, b = o.boost;
  const sw = o.swaps.byStatus;
  const ctr = b.impressions ? (b.clicks / b.impressions) * 100 : 0;
  return (
    <div className="admin-stack">
      <div className="row gap-s wrap admin-bar">
        <div className="seg seg-sm" role="tablist" aria-label="Range">
          {[7, 14, 30, 90].map((d) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>)}
        </div>
        <span className="grow" />
        <span className="small muted">Updated {ago(o.generatedAt)} ago · refreshes every minute</span>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {err && <p className="small warn">{err}</p>}

      <div className="panel">
        <h2 className="admin-h">Sign-ups & users</h2>
        <div className="kpis">
          <Kpi label="Accounts" value={n0(u.total)} sub={`${n0(u.withAvatar)} with a picture`} />
          <Kpi label="New today" value={n0(u.new24h)} sub="last 24 hours" tone={u.new24h ? 'up' : undefined} />
          <Kpi label="New this week" value={n0(u.new7d)} sub={`${n0(u.new30d)} in 30 days`} />
          <Kpi label="Active today" value={n0(u.dau)} sub={`${n0(u.wau)} this week · ${n0(u.mau)} this month`} />
        </div>
        <Bars data={o.signups} label={`Sign-ups per day · last ${o.days} days`} />
        <Bars data={o.activeDaily} label="People trading or posting per day" />
      </div>

      <div className="panel">
        <h2 className="admin-h">Paper trading <span className="pill pill-unofficial">reported by the app · not real money</span></h2>
        <div className="kpis">
          <Kpi label="Paper trades" value={n0(p.trades)} sub={`${n0(p.trades24h)} today`} />
          <Kpi label="Traders" value={n0(p.traders)} sub={`${n0(p.buys)} buys · ${n0(p.sells)} sells`} />
          <Kpi label="Paper volume" value={compact(p.volumeUsd)} sub={`${compact(p.volume24hUsd)} today`} />
          <Kpi label="Avg PnL" value={p.avgPnlPct === null ? '—' : pct(p.avgPnlPct)} tone={p.avgPnlPct === null ? undefined : p.avgPnlPct >= 0 ? 'up' : 'down'} sub={`${n0(p.inProfit)} of ${n0(p.reporting)} in profit`} />
        </div>
        <Bars data={o.tradesDaily} label="Paper trades per day" />
        {o.topTokens.length > 0 && (
          <div className="table-wrap">
            <table className="mkt admin-table">
              <thead><tr><th>Most traded token · {o.days}d</th><th className="r">Trades</th><th className="r">Paper volume</th></tr></thead>
              <tbody>{o.topTokens.map((t) => <tr key={t.mint}><td><b>${t.symbol}</b> <span className="muted small">{short(t.mint)}</span></td><td className="r num">{n0(t.trades)}</td><td className="r num">{compact(t.volume)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <h2 className="admin-h">Real money</h2>
        <div className="kpis">
          <Kpi label="Live swaps" value={n0(o.swaps.total)} sub={`${n0(sw.confirmed || 0)} confirmed · ${n0(sw.failed || 0)} failed`} />
          <Kpi label="Swap fees earned" value={o.swaps.fees.length ? o.swaps.fees.map((f) => `${f.amount ?? f.raw} ${f.symbol || short(f.mint)}`).join(' + ') : '0'} sub="verified on-chain" />
          <Kpi label="BOOST revenue" value={`${(b.revenueUsdc || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`} sub={`${n0(b.paidOrders)} paid orders · ${(b.revenue30dUsdc || 0).toLocaleString('en-US')} in 30d`} />
          <Kpi label="BOOST waiting" value={n0(b.byStatus.pending_review || 0)} sub={`${n0(b.byStatus.approved || 0)} approved · ${n0(b.impressions)} views · ${ctr.toFixed(1)}% CTR`} />
        </div>
        {o.swaps.total > 0 && <Bars data={o.swapsDaily} label="Live swaps per day" />}
      </div>

      <div className="panel">
        <h2 className="admin-h">Vault & social</h2>
        <div className="kpis">
          <Kpi label="Coins earned" value={n0(o.vault.coinsIssued)} sub={`${n0(o.vault.coinsSpent)} spent`} />
          <Kpi label="Cards bought" value={n0(o.vault.cardsMinted)} sub={`${n0(o.vault.collectors)} collectors`} />
          <Kpi label="Friendships" value={n0(o.social.friendships)} sub={`${n0(o.social.pendingRequests)} pending requests`} />
          <Kpi label="Chat messages" value={n0(o.social.messages)} sub={`${n0(o.social.messages24h)} today · ${n0(o.social.chats)} chats`} />
        </div>
      </div>
    </div>
  );
}

// ---- accounts ---------------------------------------------------------------------------------------------------
const SORTS = [['new', 'Newest'], ['active', 'Last active'], ['trades', 'Most trades'], ['pnl', 'Best PnL'], ['name', 'A–Z']] as const;
export function AccountsPanel({ token, onAuthError }: P) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<string>('new');
  const [rows, setRows] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = async (offset = 0) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await adminUsers(token, { q, sort, offset });
      if (my !== seq.current) return;
      setTotal(r.total); setRows(offset ? (prev) => [...prev, ...r.users] : r.users); setErr('');
    } catch (e: any) { setErr(e?.message || 'Couldn’t load accounts'); onAuthError(e); }
    finally { if (my === seq.current) setLoading(false); }
  };
  useEffect(() => { const id = setTimeout(() => load(0), q ? 250 : 0); return () => clearTimeout(id); }, [token, q, sort]);
  const exportCsv = () => downloadCsv(`bagz-accounts-${new Date().toISOString().slice(0, 10)}.csv`,
    ['username', 'joined', 'last_seen', 'paper_trades', 'paper_equity', 'pnl_pct', 'win_rate', 'coins', 'cards', 'friends'],
    rows.map((r) => [r.username, new Date(r.createdAt).toISOString(), r.lastSeen ? new Date(r.lastSeen).toISOString() : '', r.trades, r.equity, r.pnlPct, r.winRate, r.coins, r.cards, r.friends]));

  return (
    <div className="panel">
      <div className="row gap-s wrap">
        <input className="search-input admin-search" type="search" placeholder="Search usernames" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search usernames" />
        <div className="seg seg-sm" role="tablist" aria-label="Sort">{SORTS.map(([v, l]) => <button key={v} role="tab" aria-selected={sort === v} className={sort === v ? 'on' : ''} onClick={() => setSort(v)}>{l}</button>)}</div>
      </div>
      <div className="row gap-s"><span className="small muted">{n0(total)} account{total === 1 ? '' : 's'}{q ? ` matching “${q}”` : ''} · showing {n0(rows.length)}</span><span className="grow" /><button className="btn btn-ghost btn-sm" disabled={!rows.length} onClick={exportCsv}>Export CSV</button></div>
      {err && <p className="small warn">{err}</p>}
      <div className="table-wrap">
        <table className="mkt admin-table">
          <thead><tr><th>Account</th><th>Joined</th><th>Last active</th><th className="r">Trades</th><th className="r">Paper equity</th><th className="r">PnL</th><th className="r">Coins</th><th className="r">Cards</th><th className="r">Friends</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const pic = avatarUrl(r);
              return (
                <tr key={r.id}>
                  <td><span className="row gap-s">{pic ? <img className="admin-pfp" src={pic} alt="" width={24} height={24} /> : <span className="admin-pfp ph">{r.username[0]?.toUpperCase()}</span>}<b>@{r.username}</b></span></td>
                  <td className="small" title={new Date(r.createdAt).toLocaleString()}>{when(r.createdAt)}</td>
                  <td className="small muted">{r.lastSeen ? `${ago(r.lastSeen)} ago` : '—'}</td>
                  <td className="r num">{n0(r.trades)}</td>
                  <td className="r num">{r.equity === null ? '—' : compact(r.equity)}</td>
                  <td className={`r num ${r.pnlPct === null ? '' : r.pnlPct >= 0 ? 'up' : 'down'}`}>{r.pnlPct === null ? '—' : pct(r.pnlPct)}</td>
                  <td className="r num">{n0(r.coins)}</td>
                  <td className="r num">{n0(r.cards)}</td>
                  <td className="r num">{n0(r.friends)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!rows.length && !loading && <p className="muted small">No accounts yet.</p>}
      {rows.length < total && <button className="btn btn-ghost" disabled={loading} onClick={() => load(rows.length)}>{loading ? 'Loading…' : 'Load more'}</button>}
    </div>
  );
}

// ---- transactions + activity log ----------------------------------------------------------------------------------
const FILTERS: Record<'transactions' | 'log', ReadonlyArray<readonly [string, string]>> = {
  transactions: [['trade', 'Paper trades'], ['swap', 'Live swaps'], ['boost', 'BOOST orders'], ['payment', 'Payments'], ['card', 'Card buys'], ['coins', 'Coins']],
  log: [['all', 'Everything'], ['signup', 'Sign-ups'], ['trade', 'Paper trades'], ['thesis', 'Theses'], ['card', 'Cards'], ['coins', 'Coins'], ['swap', 'Swaps'], ['boost', 'BOOST']],
};
const ICON: Record<AdminEvent['type'], string> = { signup: '＋', trade: '⇄', thesis: '✎', swap: '◎', boost: '▲', payment: '$', card: '▣', coins: '●' };

function amountOf(e: AdminEvent): { text: string; tone?: 'up' | 'down' } | null {
  if (e.type === 'trade') return { text: `${e.side === 'SELL' ? '−' : '+'}${compact(e.usd || 0)}${e.pnl !== null && e.pnl !== undefined ? ` · PnL ${e.pnl >= 0 ? '+' : '−'}${compact(Math.abs(e.pnl))}` : ''}`, tone: e.pnl !== null && e.pnl !== undefined ? (e.pnl >= 0 ? 'up' : 'down') : undefined };
  if (e.type === 'swap') return { text: `${e.inAmount ?? '?'}${e.fee !== null && e.fee !== undefined ? ` · fee ${e.fee} ${e.feeSymbol || ''}` : ''}` };
  if (e.type === 'boost' || e.type === 'payment') return { text: `${e.usdc ?? '?'} USDC`, tone: e.type === 'payment' ? 'up' : undefined };
  if (e.type === 'coins') return { text: `${(e.delta || 0) > 0 ? '+' : ''}${n0(e.delta || 0)}`, tone: (e.delta || 0) > 0 ? 'up' : 'down' };
  return null;
}

export function LogPanel({ token, onAuthError, mode }: P & { mode: 'transactions' | 'log' }) {
  const filters = FILTERS[mode];
  const [type, setType] = useState<string>(filters[0][0]);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [live, setLive] = useState(true);
  const seq = useRef(0);
  const load = async (before?: number) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await adminLog(token, type, before);
      if (my !== seq.current) return;
      setEvents(before ? (prev) => [...prev, ...r.events] : r.events); setNext(r.next); setErr('');
    } catch (e: any) { setErr(e?.message || 'Couldn’t load the log'); onAuthError(e); }
    finally { if (my === seq.current) setLoading(false); }
  };
  useEffect(() => { load(); }, [token, type]);
  // live mode: refresh the newest page every 20 s (only while nothing older has been loaded)
  useEffect(() => { if (!live) return; const id = setInterval(() => { if (events.length <= 80) load(); }, 20_000); return () => clearInterval(id); }, [live, token, type, events.length]);

  const byDay = useMemo(() => {
    const g: { day: string; items: AdminEvent[] }[] = [];
    for (const e of events) {
      const d = new Date(e.t).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
      if (!g.length || g[g.length - 1].day !== d) g.push({ day: d, items: [] });
      g[g.length - 1].items.push(e);
    }
    return g;
  }, [events]);
  const exportCsv = () => downloadCsv(`bagz-${mode}-${type}-${new Date().toISOString().slice(0, 10)}.csv`,
    ['time', 'type', 'who', 'what', 'symbol', 'side', 'usd', 'usdc', 'status', 'signature'],
    events.map((e) => [new Date(e.t).toISOString(), e.type, e.user ? '@' + e.user : e.wallet || '', e.text, e.symbol || '', e.side || '', e.usd ?? '', e.usdc ?? '', e.status || '', e.signature || '']));

  return (
    <div className="panel">
      <div className="row gap-s wrap">
        <div className="seg seg-sm" role="tablist" aria-label="Filter">{filters.map(([v, l]) => <button key={v} role="tab" aria-selected={type === v} className={type === v ? 'on' : ''} onClick={() => setType(v)}>{l}</button>)}</div>
      </div>
      <div className="row gap-s">
        <label className="switch small"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live</label>
        <span className="small muted">{n0(events.length)} shown</span>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm" disabled={!events.length} onClick={exportCsv}>Export CSV</button>
      </div>
      {mode === 'transactions' && (type === 'swap' || type === 'payment') && !events.length && !loading && <p className="small muted">Real-money features are switched off on the server, so there’s nothing here yet. Rows appear once live swaps or BOOST payments are turned on.</p>}
      {err && <p className="small warn">{err}</p>}
      {byDay.map((g) => (
        <div key={g.day} className="log-day">
          <div className="log-day-h small muted">{g.day}</div>
          <ul className="log-list">
            {g.items.map((e, i) => {
              const amt = amountOf(e);
              const who = e.user ? `@${e.user}` : e.wallet ? short(e.wallet) : e.type === 'card' || e.type === 'coins' ? 'deleted account' : '';
              return (
                <li key={`${e.type}-${e.t}-${i}`} className="log-row">
                  <span className={`log-ico t-${e.type}`} aria-hidden>{ICON[e.type]}</span>
                  <div className="log-main">
                    <div className="log-text"><b>{who}</b> {e.text}{e.status && e.type !== 'boost' && e.type !== 'swap' ? ` · ${e.status}` : ''}</div>
                    <div className="small muted">
                      {new Date(e.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      {e.signature && <> · <a className="link" href={`https://solscan.io/tx/${e.signature}`} target="_blank" rel="noopener noreferrer">{short(e.signature)}</a></>}
                      {e.error && <span className="warn"> · {e.error}</span>}
                    </div>
                  </div>
                  {amt && <span className={`log-amt num${amt.tone ? ' ' + amt.tone : ''}`}>{amt.text}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {!events.length && !loading && !(mode === 'transactions' && (type === 'swap' || type === 'payment')) && <p className="muted small">Nothing here yet.</p>}
      {loading && !events.length && <p className="muted small">Loading…</p>}
      {next && <button className="btn btn-ghost" disabled={loading} onClick={() => { setLive(false); load(next); }}>{loading ? 'Loading…' : 'Load older'}</button>}
    </div>
  );
}
