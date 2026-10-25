/**
 * BAGZ admin controls: kill switches, revenue, token blocklist, user stats, Vault controls and the admin audit log.
 * Every change is made and checked by the Worker (admin session required) and written to the audit log there.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  adminSwitches, adminSetSwitch, adminRevenue, adminWallets, adminBlocklist, adminBlockToken, adminUnblockToken, adminUserStats,
  adminVault, adminSetCard, adminAdjustCoins, adminSetRewards, adminAudit, adminFeeSetup, adminFeeSetupBuild, adminFeeSetupSubmit,
  type Switches, type FeeSetup, type AdminRevenue, type WalletBalance, type Blocklist, type AdminUserStats, type AdminVault, type AdminCard, type AuditEntry,
} from '../trading/api';
import { Kpi, Bars, downloadCsv } from './Console';
import { short } from '../engine';
import { ago, pct } from '../format';
import { demo } from '../demo/hook';
import { refreshBlocklist } from '../store';
import { useWallet } from '../trading/walletStore';
import { signTransactionB64 } from '../trading/wallet';

type P = { token: string; onAuthError: (e: any) => void };
const n0 = (n: number) => n.toLocaleString('en-US');
const amt = (n: number, d = 4) => n.toLocaleString('en-US', { maximumFractionDigits: d });
const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const errText = (e: any, fallback: string) => e?.message || fallback;

/** shared loader: keeps the last good data on screen if a refresh fails */
function useLoad<T>(fn: () => Promise<T>, deps: unknown[], onAuthError: (e: any) => void) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = async () => {
    const my = ++seq.current;
    setLoading(true);
    try { const v = await fn(); if (my === seq.current) { setData(v); setErr(''); } }
    catch (e: any) { if (my === seq.current) { setErr(errText(e, 'Couldn’t load')); onAuthError(e); } }
    finally { if (my === seq.current) setLoading(false); }
  };
  useEffect(() => { load(); }, deps);
  return { data, err, loading, load, setErr };
}
const Migration = ({ text }: { text?: string | null }) => (text ? <p className="admin-callout warn small"><b>Database update needed.</b> {text}</p> : null);

// ---- kill switches --------------------------------------------------------------------------------------------------
export function SwitchesPanel({ token, onAuthError, onChange }: P & { onChange?: (s: Switches) => void }) {
  const { data, err, setErr, load } = useLoad(() => adminSwitches(token), [token], onAuthError);
  const [arming, setArming] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => { if (data) onChange?.(data); }, [data]);
  const set = async (id: string, paused: boolean) => {
    if (paused && !reason.trim()) { setErr('Add a short reason for pausing; it goes in the audit log.'); return; }
    setBusy(id); setErr('');
    try { const r = await adminSetSwitch(token, id, paused, reason.trim()); onChange?.(r); setArming(null); setReason(''); await load(); }
    catch (e: any) { setErr(errText(e, 'Couldn’t change the switch')); onAuthError(e); }
    finally { setBusy(''); }
  };
  if (!data) return <div className="panel"><p className="muted small">{err || 'Loading switches…'}</p></div>;
  return (
    <div className="panel">
      <div>
        <h2 className="admin-h">Kill switches</h2>
        <p className="small muted">Pause a feature for everyone in about 10 seconds. Pausing never turns live money on: live swaps and BOOST payments also need their server switch in wrangler.toml.</p>
      </div>
      <Migration text={data.migration} />
      {err && <p className="small warn">{err}</p>}
      <ul className="switch-list">
        {data.switches.map((s) => (
          <li key={s.id} className={`switch-row${s.paused ? ' is-paused' : ''}`}>
            <div className="switch-main">
              <div className="row gap-s wrap">
                <b>{s.label}</b>
                <span className={`pill ${s.running ? 'pill-up' : s.paused ? 'pill-down' : 'pill-warn'}`}>{s.running ? 'Running' : s.paused ? 'Paused' : 'Off on the server'}</span>
              </div>
              <div className="small muted">{s.help}</div>
              {s.updatedAt && <div className="small muted">Last changed {when(s.updatedAt)} by {s.updatedBy?.startsWith('@') ? s.updatedBy : short(s.updatedBy || '')}</div>}
              {arming === s.id && (
                <div className="row gap-s wrap switch-confirm">
                  <input className="admin-input grow" autoFocus placeholder="Reason (required)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') set(s.id, true); }} aria-label={`Reason for pausing ${s.label}`} />
                  <button className="btn btn-down-solid btn-sm" disabled={!!busy} onClick={() => set(s.id, true)}>{busy === s.id ? 'Pausing…' : 'Confirm pause'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setArming(null); setReason(''); setErr(''); }}>Cancel</button>
                </div>
              )}
            </div>
            {arming !== s.id && (s.paused
              ? <button className="btn btn-accent btn-sm" disabled={!!busy || !data.ready} onClick={() => set(s.id, false)}>{busy === s.id ? 'Resuming…' : 'Resume'}</button>
              : <button className="btn btn-ghost btn-sm switch-pause" disabled={!!busy || !data.ready} onClick={() => { setArming(s.id); setReason(''); setErr(''); }}>Pause</button>)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- revenue --------------------------------------------------------------------------------------------------------
export function RevenuePanel({ token, onAuthError }: P) {
  const [days, setDays] = useState(30);
  const { data: r, err, loading, load } = useLoad(() => adminRevenue(token, days), [token, days], onAuthError);
  const [wallets, setWallets] = useState<{ accounts: WalletBalance[]; at: number; note?: string } | null>(null);
  const [wErr, setWErr] = useState('');
  const [wBusy, setWBusy] = useState(false);
  const checkWallets = async () => {
    setWBusy(true); setWErr('');
    try { setWallets(await adminWallets(token)); } catch (e: any) { setWErr(errText(e, 'Couldn’t read the wallets')); onAuthError(e); } finally { setWBusy(false); }
  };
  if (!r) return <div className="panel"><p className="muted small">{err || 'Loading revenue…'}</p></div>;
  const fmt = (n: number) => amt(n, 4);
  const exportCsv = () => downloadCsv(`bagz-revenue-${new Date().toISOString().slice(0, 10)}.csv`, ['day', 'swap_fees_sol', 'swap_fees_usdc', 'boost_usdc'],
    r.dailyBoostUsdc.map((d, i) => [d.day, r.dailySwapFeesSol[i]?.n ?? 0, r.dailySwapFeesUsdc[i]?.n ?? 0, d.n]));
  return (
    <div className="admin-stack">
      <div className="row gap-s wrap admin-bar">
        <div className="seg seg-sm" role="tablist" aria-label="Range">
          {[7, 14, 30, 90].map((d) => <button key={d} role="tab" aria-selected={days === d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d}d</button>)}
        </div>
        <span className="grow" />
        <span className="small muted">Updated {ago(r.generatedAt)} ago</span>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
        <button className="btn btn-ghost btn-sm" onClick={exportCsv}>Export CSV</button>
      </div>
      {err && <p className="small warn">{err}</p>}
      {!r.live.swaps && !r.live.boost && <p className="admin-callout small muted">Live swaps and BOOST payments are switched off on the server, so these numbers stay at zero until they’re turned on. Only payments verified on-chain are counted.</p>}

      <div className="panel">
        <h2 className="admin-h">Earned</h2>
        <div className="kpis">
          <Kpi label="Today" value={`${fmt(r.boost.usdc.today + r.swapFees.usdc.today)} USDC`} sub={`+ ${fmt(r.swapFees.sol.today)} SOL in swap fees`} />
          <Kpi label="Last 7 days" value={`${fmt(r.boost.usdc.d7 + r.swapFees.usdc.d7)} USDC`} sub={`+ ${fmt(r.swapFees.sol.d7)} SOL`} />
          <Kpi label="Last 30 days" value={`${fmt(r.boost.usdc.d30 + r.swapFees.usdc.d30)} USDC`} sub={`+ ${fmt(r.swapFees.sol.d30)} SOL`} />
          <Kpi label="All time" value={`${fmt(r.boost.usdc.all + r.swapFees.usdc.all)} USDC`} sub={`+ ${fmt(r.swapFees.sol.all)} SOL`} tone={r.boost.usdc.all + r.swapFees.usdc.all > 0 ? 'up' : undefined} />
        </div>
      </div>

      <div className="admin-grid-2">
        <div className="panel">
          <h2 className="admin-h">Swap fees <span className="pill pill-unofficial">0.50% · read from the chain</span></h2>
          <div className="kpis kpis-2">
            <Kpi label="SOL fees · all time" value={`${fmt(r.swapFees.sol.all)} SOL`} sub={`${fmt(r.swapFees.sol.d30)} in 30 days`} />
            <Kpi label="USDC fees · all time" value={`${fmt(r.swapFees.usdc.all)} USDC`} sub={`${n0(r.swapFees.swaps)} confirmed swaps`} />
          </div>
          <Bars data={r.dailySwapFeesSol} label={`SOL fees per day · ${r.days}d`} unit=" SOL" fmt={fmt} floor={0.000001} />
          <Bars data={r.dailySwapFeesUsdc} label={`USDC fees per day · ${r.days}d`} unit=" USDC" fmt={fmt} floor={0.000001} />
        </div>
        <div className="panel">
          <h2 className="admin-h">BOOST <span className="pill pill-unofficial">USDC · verified payments</span></h2>
          <div className="kpis kpis-2">
            <Kpi label="BOOST · all time" value={`${fmt(r.boost.usdc.all)} USDC`} sub={`${n0(r.boost.orders)} paid orders`} />
            <Kpi label="Refunds owed" value={`${fmt(r.refundsOwed.usdc)} USDC`} sub={`${n0(r.refundsOwed.orders)} rejected after paying`} tone={r.refundsOwed.orders ? 'down' : undefined} />
          </div>
          <Bars data={r.dailyBoostUsdc} label={`BOOST per day · ${r.days}d`} unit=" USDC" fmt={fmt} floor={0.000001} />
          {r.byPackage.length > 0 && (
            <div className="table-wrap">
              <table className="mkt admin-table">
                <thead><tr><th>Package</th><th className="r">Orders</th><th className="r">USDC</th></tr></thead>
                <tbody>{r.byPackage.map((p) => <tr key={p.package}><td className="cap">{p.package}</td><td className="r num">{n0(p.orders)}</td><td className="r num">{fmt(p.usdc)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          {r.testPayments > 0 && <p className="small muted">{n0(r.testPayments)} test-copy payment{r.testPayments === 1 ? '' : 's'} left out (not real money).</p>}
        </div>
      </div>

      <div className="panel">
        <div className="row gap-s wrap">
          <div className="grow"><h2 className="admin-h">Wallet balances now</h2><p className="small muted">Reads the fee and BOOST accounts straight from Solana (uses a few RPC calls, so it only runs when you ask).</p></div>
          <button className="btn btn-ghost btn-sm" onClick={checkWallets} disabled={wBusy}>{wBusy ? 'Checking…' : wallets ? 'Check again' : 'Check balances'}</button>
        </div>
        {wErr && <p className="small warn">{wErr}</p>}
        {wallets?.note && <p className="small muted">{wallets.note}</p>}
        {wallets && wallets.accounts.length > 0 && (
          <ul className="admin-kv">
            {wallets.accounts.map((a) => (
              <li key={a.address + a.kind}>
                <span><span className="small muted">{a.label}</span><br /><a className="link small" href={`https://solscan.io/account/${a.address}`} target="_blank" rel="noopener noreferrer">{short(a.address)}</a></span>
                <b className="num">{a.amount === null ? <span className="warn small">{a.error || 'unavailable'}</span> : `${amt(a.amount, 6)} ${a.symbol}`}</b>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---- fee accounts ---------------------------------------------------------------------------------------------------
const STATE_LABEL: Record<string, { text: string; tone: string }> = {
  ready: { text: 'Ready', tone: 'up' }, missing: { text: 'Not created yet', tone: 'warn' }, problem: { text: 'Needs fixing', tone: 'down' },
  unknown: { text: 'Couldn’t check', tone: 'muted' }, not_configured: { text: 'Not set', tone: 'muted' },
};
/**
 * Are the token accounts that receive the 0.50% swap fee and BOOST payments on Solana? If not, create them with one
 * signature from the signed-in admin wallet. Creating them moves no money except the refundable ~0.002 SOL deposit
 * each, and does not switch swaps or BOOST payments on.
 */
export function FeeSetupPanel({ token, onAuthError, adminWallet }: P & { adminWallet: string }) {
  const ws = useWallet();
  const { data, err, setErr, loading, load } = useLoad(() => adminFeeSetup(token), [token], onAuthError);
  const [step, setStep] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const sameWallet = ws.conn?.account.address === adminWallet;

  const create = async () => {
    if (!ws.conn || !sameWallet) return;
    setErr(''); setSent(null);
    try {
      setStep('Preparing…');
      const b = await adminFeeSetupBuild(token);
      setStep(`Approve in your wallet: create ${b.creates.length} account${b.creates.length === 1 ? '' : 's'} (about ${amt(b.costSol + 0.0001, 4)} SOL deposit + fee)`);
      const signed = await signTransactionB64(ws.conn, b.transaction);
      setStep('Sending…');
      const r = await adminFeeSetupSubmit(token, signed);
      setSent(r.signature);
      // Solana usually confirms within a few seconds; re-check until everything shows ready (up to ~1 minute)
      for (let i = 0; i < 12 && live.current; i++) {
        setStep('Waiting for Solana to confirm…');
        await new Promise((res) => setTimeout(res, 5000));
        const st = await adminFeeSetup(token).catch(() => null);
        if (st && st.missing === 0) break;
      }
      if (live.current) await load();
    } catch (e: any) { if (live.current) { setErr(errText(e, 'Couldn’t create the accounts')); onAuthError(e); } }
    finally { if (live.current) setStep(''); }
  };

  if (!data) return <div className="panel"><p className="muted small">{err || 'Checking the fee accounts on Solana…'}</p></div>;
  if (data.testCopy) return <div className="panel"><h2 className="admin-h">Fee accounts</h2><p className="small muted">{data.note}</p></div>;
  const anyProblem = data.accounts.some((a) => a.state === 'problem' || a.state === 'not_configured');
  return (
    <div className="admin-stack">
      <div className="panel">
        <div className="row gap-s wrap">
          <div className="grow">
            <h2 className="admin-h">Fee accounts</h2>
            <p className="small muted">The accounts that receive the 0.50% swap fee and BOOST payments. They must exist on Solana before live swaps or BOOST payments are switched on. Checked {ago(data.at)} ago.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading || !!step}>{loading ? 'Checking…' : 'Check again'}</button>
        </div>
        <div className="kpis kpis-2">
          <Kpi label="Swap fees" value={data.swapsReady ? 'Ready' : 'Not ready'} sub="wSOL + USDC accounts" tone={data.swapsReady ? 'up' : 'down'} />
          <Kpi label="BOOST payments" value={data.boostReady ? 'Ready' : 'Not ready'} sub="USDC account" tone={data.boostReady ? 'up' : 'down'} />
        </div>
        <ul className="admin-kv">
          {data.accounts.map((a) => {
            const st = STATE_LABEL[a.state] || STATE_LABEL.unknown;
            return (
              <li key={a.id}>
                <span>
                  <span className="small">{a.label}</span><br />
                  <span className="small muted">{a.sharedWith ? 'Same account as the swap-fee USDC account' : a.use}</span><br />
                  {a.address && <a className="link small" href={`https://solscan.io/account/${a.address}`} target="_blank" rel="noopener noreferrer">{short(a.address)}</a>}
                  {a.state !== 'ready' && <><br /><span className="small muted">{a.detail}</span></>}
                </span>
                <b className={`small ${st.tone}`}>{st.text}{a.state === 'ready' && a.balance != null ? ` · ${a.balance} ${a.token}` : ''}</b>
              </li>
            );
          })}
        </ul>
        {err && <p className="small warn">{err}</p>}
        {sent && <p className="small">Sent. <a className="link" href={`https://solscan.io/tx/${sent}`} target="_blank" rel="noopener noreferrer">View on Solscan</a></p>}
        {data.missing > 0 && (
          <div className="admin-callout small">
            <p><b>{data.missing} account{data.missing === 1 ? '' : 's'} to create.</b> Your admin wallet pays a refundable deposit of about {amt((data.rentPerAccountSol || 0.00204) * data.missing, 4)} SOL plus a tiny network fee. Nothing else moves, and swaps stay switched off.</p>
            {!sameWallet && <p className="warn">Connect the admin wallet you signed in with ({short(adminWallet)}) to continue.</p>}
            <button className="btn btn-accent" onClick={create} disabled={!sameWallet || !!step}>{step || `Create ${data.missing === 1 ? 'it' : 'them'} now`}</button>
          </div>
        )}
        {data.missing === 0 && data.swapsReady && data.boostReady && <p className="small up">All set. Next step: the security review, then a tiny mainnet test swap.</p>}
        {anyProblem && <p className="small muted">Accounts marked “Needs fixing” or “Not set” are never created automatically. Correct the addresses in worker/wrangler.toml and redeploy the Worker.</p>}
      </div>
    </div>
  );
}

// ---- token blocklist ------------------------------------------------------------------------------------------------
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function BlocklistPanel({ token, onAuthError }: P) {
  const { data, err, setErr, load } = useLoad<Blocklist>(() => adminBlocklist(token), [token], onAuthError);
  const [mint, setMint] = useState('');
  const [symbol, setSymbol] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [confirmMint, setConfirmMint] = useState<string | null>(null);
  const add = async () => {
    const m = mint.trim();
    if (!MINT_RE.test(m)) { setErr('Paste a valid Solana token address.'); return; }
    if (!reason.trim()) { setErr('Add a reason (for example “rug pull”).'); return; }
    setBusy('add'); setErr(''); setMsg('');
    try {
      const r = await adminBlockToken(token, { mint: m, symbol: symbol.trim(), reason: reason.trim() });
      setMint(''); setSymbol(''); setReason('');
      const a = r.affectedBoosts || [];
      refreshBlocklist(); // this screen right away; everyone else within a minute
      setMsg(`Blocked. It disappears from the app within a minute.${a.length ? ` ${a.length} BOOST order${a.length === 1 ? '' : 's'} for it still need a look in the BOOST queue.` : ''}`);
      await load();
    } catch (e: any) { setErr(errText(e, 'Couldn’t block it')); onAuthError(e); } finally { setBusy(''); }
  };
  const remove = async (m: string) => {
    setBusy(m); setErr(''); setMsg('');
    try { await adminUnblockToken(token, m); setConfirmMint(null); refreshBlocklist(); setMsg('Unblocked. It comes back with the next market refresh.'); await load(); }
    catch (e: any) { setErr(errText(e, 'Couldn’t unblock it')); onAuthError(e); } finally { setBusy(''); }
  };
  const rows = useMemo(() => {
    const t = (data?.tokens || []);
    const s = q.trim().toLowerCase();
    return s ? t.filter((x) => x.mint.toLowerCase().includes(s) || (x.symbol || '').toLowerCase().includes(s) || x.reason.toLowerCase().includes(s)) : t;
  }, [data, q]);
  return (
    <div className="admin-stack">
      <div className="panel">
        <div>
          <h2 className="admin-h">Block a token</h2>
          <p className="small muted">Hides it from lists, search and trending in the app, and refuses BOOST orders for it. People who already hold it in paper trading keep their position.</p>
        </div>
        <Migration text={data?.migration} />
        <div className="admin-form">
          <label className="field-s grow-2"><span className="small muted">Token address</span><input className="admin-input num" placeholder="Mint address" value={mint} onChange={(e) => setMint(e.target.value)} spellCheck={false} autoComplete="off" /></label>
          <label className="field-s"><span className="small muted">Ticker (optional)</span><input className="admin-input" placeholder="$WIF" value={symbol} maxLength={20} onChange={(e) => setSymbol(e.target.value)} /></label>
          <label className="field-s grow-2"><span className="small muted">Reason</span><input className="admin-input" placeholder="Rug pull, scam copy, …" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} /></label>
          <button className="btn btn-down-solid btn-sm admin-form-btn" disabled={!!busy || data?.ready === false} onClick={add}>{busy === 'add' ? 'Blocking…' : 'Block token'}</button>
        </div>
        {err && <p className="small warn">{err}</p>}
        {msg && <p className="small up">{msg}</p>}
      </div>
      <div className="panel">
        <div className="row gap-s wrap">
          <h2 className="admin-h grow">Blocked tokens <span className="pill pill-plain">{n0(data?.tokens.length || 0)}</span></h2>
          {(data?.tokens.length || 0) > 5 && <input className="search-input admin-search" type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter blocked tokens" />}
        </div>
        {!data && <p className="muted small">Loading…</p>}
        {data && !rows.length && <p className="muted small">{q ? 'No match.' : 'Nothing is blocked.'}</p>}
        <ul className="log-list">
          {rows.map((t) => (
            <li key={t.mint} className="log-row">
              <span className="log-ico t-blocked" aria-hidden>⦸</span>
              <div className="log-main">
                <div className="log-text"><b>{t.symbol ? `$${t.symbol}` : short(t.mint)}</b> <span className="muted">· {t.reason}</span></div>
                <div className="small muted"><a className="link" href={`https://solscan.io/token/${t.mint}`} target="_blank" rel="noopener noreferrer">{short(t.mint)}</a> · {when(t.createdAt)} by {t.createdBy.startsWith('@') ? t.createdBy : short(t.createdBy)}</div>
              </div>
              {confirmMint === t.mint
                ? <span className="row gap-s"><button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => remove(t.mint)}>{busy === t.mint ? '…' : 'Unblock'}</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirmMint(null)}>Keep</button></span>
                : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmMint(t.mint)}>Unblock…</button>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---- user stats -----------------------------------------------------------------------------------------------------
function Leaders({ title, rows, fmtValue }: { title: string; rows: AdminUserStats['leaders']['pnl']; fmtValue: (v: number, extra: number | null) => string }) {
  return (
    <div className="leaders">
      <div className="kpi-label">{title}</div>
      {!rows.length ? <p className="small muted">No one yet.</p> : (
        <ol className="leaders-list">
          {rows.slice(0, 5).map((r, i) => <li key={r.username + i}><span className="muted num">{i + 1}</span><b className="grow">@{r.username}</b><span className="num">{fmtValue(r.value, r.extra)}</span></li>)}
        </ol>
      )}
    </div>
  );
}
export function UserStatsPanel({ token, onAuthError }: P) {
  const { data: u, err, loading, load } = useLoad<AdminUserStats>(() => adminUserStats(token), [token], onAuthError);
  if (!u) return <div className="panel"><p className="muted small">{err || 'Loading user stats…'}</p></div>;
  const ret = (k: 'd1' | 'd7' | 'd30') => (u.retention[k].pct === null ? '—' : `${u.retention[k].pct}%`);
  const retSub = (k: 'd1' | 'd7' | 'd30', label: string) => (u.retention[k].base ? `of ${n0(u.retention[k].base)} accounts older than ${label}` : `no accounts older than ${label} yet`);
  const e = u.engagement;
  const eTotal = Math.max(1, e.none + e.some + e.regular + e.heavy);
  const peakHour = Math.max(1, ...u.activeHoursUtc);
  const localOffset = -new Date().getTimezoneOffset() / 60;
  return (
    <div className="panel">
      <div className="row gap-s wrap">
        <h2 className="admin-h grow">User stats</h2>
        <span className="small muted">Updated {ago(u.generatedAt)} ago</span>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {err && <p className="small warn">{err}</p>}
      <div className="kpis">
        <Kpi label="Active today" value={n0(u.dau)} sub={`${n0(u.wau)} this week · ${n0(u.mau)} this month`} />
        <Kpi label="Stickiness" value={u.stickiness === null ? '—' : `${u.stickiness}%`} sub="daily ÷ monthly active" />
        <Kpi label="Came back next day" value={ret('d1')} sub={retSub('d1', '1 day')} />
        <Kpi label="Came back after a week" value={ret('d7')} sub={retSub('d7', '7 days')} />
      </div>

      <div className="admin-grid-2">
        <div>
          <div className="kpi-label">How much people paper trade</div>
          <div className="stack-bar" role="img" aria-label={`No trades ${e.none}, 1 to 9 trades ${e.some}, 10 to 49 trades ${e.regular}, 50 or more ${e.heavy}`}>
            {([['none', e.none, 'No trades'], ['some', e.some, '1–9'], ['regular', e.regular, '10–49'], ['heavy', e.heavy, '50+']] as const).map(([k, v]) => v > 0 && <span key={k} className={`seg-${k}`} style={{ flex: v / eTotal }} />)}
          </div>
          <ul className="stack-legend small">
            <li><i className="seg-none" />No trades <b className="num">{n0(e.none)}</b></li>
            <li><i className="seg-some" />1–9 <b className="num">{n0(e.some)}</b></li>
            <li><i className="seg-regular" />10–49 <b className="num">{n0(e.regular)}</b></li>
            <li><i className="seg-heavy" />50+ <b className="num">{n0(e.heavy)}</b></li>
          </ul>
          <p className="small muted">{n0(u.profiles.withPicture)} of {n0(u.total)} accounts have a picture · {n0(u.profiles.withBio)} have a bio</p>
        </div>
        <div>
          <div className="kpi-label">When people trade · your time (last 30 days)</div>
          <div className="hours" role="img" aria-label="Paper trades by hour of day">
            {Array.from({ length: 24 }, (_, h) => {
              const v = u.activeHoursUtc[(((h - localOffset) % 24) + 24) % 24] || 0;
              return <span key={h} title={`${h}:00 · ${v} trades`} style={{ height: `${Math.max(v ? 8 : 2, (v / peakHour) * 100)}%` }} className={v ? 'on' : ''} />;
            })}
          </div>
          <div className="bars-axis small muted"><span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span></div>
        </div>
      </div>

      <div className="leaders-grid">
        <Leaders title="Best paper PnL (3+ trades)" rows={u.leaders.pnl} fmtValue={(v) => pct(v)} />
        <Leaders title="Most trades · 30 days" rows={u.leaders.trades30d} fmtValue={(v) => n0(v)} />
        <Leaders title="Most BAGZ Coins" rows={u.leaders.coins} fmtValue={(v) => n0(v)} />
        <Leaders title="Most friends" rows={u.leaders.friends} fmtValue={(v) => n0(v)} />
      </div>
    </div>
  );
}

// ---- vault controls -------------------------------------------------------------------------------------------------
const artUrl = (id: string) => `${demo() ? '../' : './'}vault/art/${id}.webp`;
const STATUS_LABEL: Record<AdminCard['status'], [string, string]> = { on_sale: ['On sale', 'pill-up'], paused: ['Paused', 'pill-down'], scheduled: ['Scheduled', 'pill-warn'], sold_out: ['Sold out', 'pill-plain'] };
/** value for <input type="datetime-local"> in the viewer's time zone */
const localInput = (t: number) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); };

export function VaultPanel({ token, onAuthError }: P) {
  const { data: v, err, setErr, load } = useLoad<AdminVault>(() => adminVault(token), [token], onAuthError);
  const [series, setSeries] = useState('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [drop, setDrop] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [who, setWho] = useState(''); const [delta, setDelta] = useState(''); const [why, setWhy] = useState('');
  const [rewards, setRewards] = useState<Record<string, string>>({});
  useEffect(() => { if (v) setRewards(Object.fromEntries(v.challenges.map((c) => [c.id, String(c.reward)]))); }, [v]);

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key); setErr(''); setMsg('');
    try { await fn(); setMsg(ok); await load(); return true; } catch (e: any) { setErr(errText(e, 'That didn’t work')); onAuthError(e); return false; } finally { setBusy(''); }
  };
  if (!v) return <div className="panel"><p className="muted small">{err || 'Loading the Vault…'}</p></div>;
  const cards = v.cards.filter((c) => series === 'all' || c.series === series);
  const sold = v.cards.reduce((s, c) => s + c.minted, 0);
  const rewardsChanged = v.challenges.some((c) => String(c.reward) !== (rewards[c.id] ?? String(c.reward)));
  return (
    <div className="admin-stack">
      <Migration text={v.migration} />
      <div className="panel">
        <h2 className="admin-h">Vault economy</h2>
        <div className="kpis">
          <Kpi label="Cards sold" value={`${n0(sold)} / ${n0(v.cards.length * v.supply)}`} sub={`${v.cards.filter((c) => c.status === 'sold_out').length} sold out`} />
          <Kpi label="Coins in wallets" value={n0(v.coins.circulating)} sub="not spent yet" />
          <Kpi label="Coins earned" value={n0(v.coins.issued)} sub={`${n0(v.coins.spent)} spent on cards`} />
          <Kpi label="Admin adjustments" value={`${v.coins.adjusted > 0 ? '+' : ''}${n0(v.coins.adjusted)}`} sub="net, all time" />
        </div>
        {err && <p className="small warn">{err}</p>}
        {msg && <p className="small up">{msg}</p>}
      </div>

      <div className="panel">
        <div className="row gap-s wrap">
          <h2 className="admin-h grow">Cards</h2>
          <div className="seg seg-sm" role="tablist" aria-label="Series">
            {[['all', 'All'], ...Object.entries(v.series).map(([k, s]) => [k, s.label])].map(([k, l]) => <button key={k} role="tab" aria-selected={series === k} className={series === k ? 'on' : ''} onClick={() => setSeries(k)}>{l}</button>)}
          </div>
        </div>
        <ul className="vault-admin-list">
          {cards.map((c) => {
            const [label, cls] = STATUS_LABEL[c.status];
            return (
              <li key={c.id} className="vault-admin-row">
                <img className={`vault-thumb r-${c.rarity}`} src={artUrl(c.id)} alt="" width={44} height={60} loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                <div className="log-main">
                  <div className="row gap-s wrap"><b>{v.series[c.series]?.label} · {c.mode}</b><span className={`pill ${cls}`}>{label}</span></div>
                  <div className="small muted">
                    {v.rarities[c.rarity]?.label} · {n0(c.price)} coins · <b className="num">{c.minted}/{v.supply}</b> sold{c.lastSale ? ` · last ${ago(c.lastSale)} ago` : ''}
                    {c.status === 'scheduled' && c.dropAt && <> · drops {when(c.dropAt)}</>}
                  </div>
                  <div className="meter" aria-hidden><span style={{ width: `${(c.minted / v.supply) * 100}%` }} /></div>
                  {editing === c.id && (
                    <div className="row gap-s wrap switch-confirm">
                      <label className="small muted row gap-s">Drop at <input className="admin-input" type="datetime-local" value={drop} onChange={(e) => setDrop(e.target.value)} /></label>
                      <button className="btn btn-accent btn-sm" disabled={!!busy || !drop} onClick={() => act(c.id, () => adminSetCard(token, c.id, false, new Date(drop).getTime()), `${c.mode} scheduled.`).then((ok) => { if (ok) setEditing(null); })}>Schedule</button>
                      {c.dropAt && <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => act(c.id, () => adminSetCard(token, c.id, c.paused, null), 'Schedule removed; it’s on sale now.').then((ok) => { if (ok) setEditing(null); })}>Clear schedule</button>}
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  )}
                </div>
                {c.status !== 'sold_out' && editing !== c.id && (
                  <div className="vault-admin-actions">
                    {c.paused
                      ? <button className="btn btn-accent btn-sm" disabled={!!busy || !v.ready} onClick={() => act(c.id, () => adminSetCard(token, c.id, false, c.dropAt), `${c.mode} is back on sale.`)}>Resume</button>
                      : <button className="btn btn-ghost btn-sm" disabled={!!busy || !v.ready} onClick={() => act(c.id, () => adminSetCard(token, c.id, true, c.dropAt), `${c.mode} paused.`)}>Pause</button>}
                    <button className="btn btn-ghost btn-sm" disabled={!!busy || !v.ready} onClick={() => { setEditing(c.id); setDrop(localInput(c.dropAt && c.dropAt > Date.now() ? c.dropAt : Date.now() + 3600_000)); }}>Drop time…</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="admin-grid-2">
        <div className="panel">
          <h2 className="admin-h">Challenge rewards</h2>
          <p className="small muted">Coins paid for each daily challenge. Changes apply to claims from now on.</p>
          <ul className="admin-kv">
            {v.challenges.map((c) => (
              <li key={c.id}>
                <span>{c.title}{c.reward !== c.defaultReward && <span className="small muted"> · default {c.defaultReward}</span>}</span>
                <input className="admin-input reward-input num" type="number" min={0} max={1000} step={1} inputMode="numeric" value={rewards[c.id] ?? ''} onChange={(e) => setRewards({ ...rewards, [c.id]: e.target.value })} aria-label={`Reward for ${c.title}`} />
              </li>
            ))}
          </ul>
          <div className="row gap-s">
            <button className="btn btn-accent btn-sm" disabled={!!busy || !rewardsChanged || !v.ready} onClick={() => act('rewards', () => adminSetRewards(token, Object.fromEntries(Object.entries(rewards).map(([k, x]) => [k, Number(x)]))), 'Rewards saved.')}>{busy === 'rewards' ? 'Saving…' : 'Save rewards'}</button>
            {rewardsChanged && <button className="btn btn-ghost btn-sm" onClick={() => setRewards(Object.fromEntries(v.challenges.map((c) => [c.id, String(c.reward)])))}>Undo</button>}
            <span className="grow" />
            <button className="btn btn-ghost btn-sm" disabled={!!busy || !v.ready || v.challenges.every((c) => c.reward === c.defaultReward)} onClick={() => act('rewards', () => adminSetRewards(token, Object.fromEntries(v.challenges.map((c) => [c.id, c.defaultReward]))), 'Rewards reset to defaults.')}>Reset to defaults</button>
          </div>
        </div>
        <div className="panel">
          <h2 className="admin-h">Adjust coins</h2>
          <p className="small muted">Fix a mistake or reward someone. A balance can’t go below 0. Logged with your reason.</p>
          <div className="admin-form">
            <label className="field-s grow-2"><span className="small muted">Username</span><input className="admin-input" placeholder="@username" value={who} onChange={(e) => setWho(e.target.value)} autoComplete="off" /></label>
            <label className="field-s"><span className="small muted">Coins (+/−)</span><input className="admin-input num" type="number" step={1} inputMode="numeric" placeholder="50 or -50" value={delta} onChange={(e) => setDelta(e.target.value)} /></label>
            <label className="field-s grow-2"><span className="small muted">Reason</span><input className="admin-input" placeholder="Bug refund, contest prize…" value={why} maxLength={200} onChange={(e) => setWhy(e.target.value)} /></label>
            <button className="btn btn-accent btn-sm admin-form-btn" disabled={!!busy || !who.trim() || !delta || !why.trim() || !v.ready}
              onClick={() => act('coins', async () => { const r = await adminAdjustCoins(token, who.trim(), Number(delta), why.trim()); setWho(''); setDelta(''); setWhy(''); return r; }, 'Coins updated.')}>{busy === 'coins' ? 'Saving…' : 'Apply'}</button>
          </div>
          {v.adjustments.length > 0 && (
            <ul className="log-list">
              {v.adjustments.slice(0, 6).map((a, i) => (
                <li key={i} className="log-row"><span className="log-main small"><b>@{a.username || 'deleted'}</b> <span className="muted">· {when(a.t)}</span></span><span className={`log-amt num ${a.delta > 0 ? 'up' : 'down'}`}>{a.delta > 0 ? '+' : ''}{n0(a.delta)}</span></li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- audit log ------------------------------------------------------------------------------------------------------
const AUDIT_FILTERS = [['all', 'Everything'], ['switch', 'Switches'], ['boost', 'BOOST'], ['blocklist', 'Blocklist'], ['vault', 'Vault & coins'], ['signin', 'Sign-ins']] as const;
const SWITCH_NAME: Record<string, string> = { swaps: 'live swaps', boost: 'BOOST payments', signups: 'new sign-ups', vault: 'the Vault' };
const swName = (id: string | null) => (id && SWITCH_NAME[id]) || id || '?';
const AUDIT_TEXT: Record<string, (e: AuditEntry) => string> = {
  'switch.pause': (e) => `Paused ${swName(e.target)}${e.detail?.reason ? ` — “${e.detail.reason}”` : ''}`,
  'switch.resume': (e) => `Resumed ${swName(e.target)}`,
  'boost.approve': (e) => `Approved BOOST for $${e.detail?.symbol || '?'} (${e.detail?.package || ''})`,
  'boost.reject': (e) => `Rejected BOOST for $${e.detail?.symbol || '?'}${e.detail?.note ? ` — “${e.detail.note}”` : ''}`,
  'boost.end': (e) => `Ended BOOST for $${e.detail?.symbol || '?'} early — “${e.detail?.note || ''}”`,
  'blocklist.add': (e) => `Blocked ${e.detail?.symbol ? '$' + e.detail.symbol : short(e.target || '')} — “${e.detail?.reason || ''}”`,
  'blocklist.remove': (e) => `Unblocked ${short(e.target || '')}`,
  'vault.card': (e) => `Card ${e.target}: ${e.detail?.paused ? 'paused' : e.detail?.dropAt ? `drops ${when(e.detail.dropAt)}` : 'on sale'}`,
  'vault.rewards': (e) => { const k = Object.entries(e.detail || {}); return k.length ? `Changed rewards: ${k.map(([id, n]) => `${id} → ${n}`).join(', ')}` : 'Reset challenge rewards to defaults'; },
  'coins.adjust': (e) => `${(e.detail?.delta || 0) > 0 ? 'Gave' : 'Took'} ${n0(Math.abs(e.detail?.delta || 0))} coins ${(e.detail?.delta || 0) > 0 ? 'to' : 'from'} ${e.target} — “${e.detail?.reason || ''}”`,
  signin: () => 'Signed in to the admin console',
};
const AUDIT_ICON = (a: string) => (a.startsWith('switch') ? '⏻' : a.startsWith('boost') ? '▲' : a.startsWith('blocklist') ? '⦸' : a === 'signin' ? '⇥' : '●');

export function AuditPanel({ token, onAuthError }: P) {
  const [group, setGroup] = useState<string>('all');
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [migration, setMigration] = useState<string | undefined>();
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = async (before?: number) => {
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await adminAudit(token, group, before);
      if (my !== seq.current) return;
      setRows(before ? (p) => [...p, ...r.entries] : r.entries); setNext(r.next); setMigration(r.migration); setErr('');
    } catch (e: any) { setErr(errText(e, 'Couldn’t load the audit log')); onAuthError(e); }
    finally { if (my === seq.current) setLoading(false); }
  };
  useEffect(() => { load(); }, [token, group]);
  const text = (e: AuditEntry) => (AUDIT_TEXT[e.action] || ((x: AuditEntry) => `${x.action} ${x.target || ''}`))(e);
  const exportCsv = () => downloadCsv(`bagz-audit-${new Date().toISOString().slice(0, 10)}.csv`, ['time', 'admin', 'action', 'target', 'what', 'detail'],
    rows.map((e) => [new Date(e.t).toISOString(), e.admin, e.action, e.target || '', text(e), e.detail ? JSON.stringify(e.detail) : '']));
  return (
    <div className="panel">
      <div>
        <h2 className="admin-h">Audit log</h2>
        <p className="small muted">Every change made in this console: who, what and when. Entries can’t be edited or deleted from the app.</p>
      </div>
      <Migration text={migration} />
      <div className="row gap-s wrap">
        <div className="seg seg-sm" role="tablist" aria-label="Filter">{AUDIT_FILTERS.map(([k, l]) => <button key={k} role="tab" aria-selected={group === k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{l}</button>)}</div>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={() => load()} disabled={loading}>Refresh</button>
        <button className="btn btn-ghost btn-sm" disabled={!rows.length} onClick={exportCsv}>Export CSV</button>
      </div>
      {err && <p className="small warn">{err}</p>}
      {!rows.length && !loading && !migration && <p className="muted small">Nothing logged yet.</p>}
      <ul className="log-list">
        {rows.map((e) => (
          <li key={e.id} className="log-row">
            <span className={`log-ico t-audit-${e.action.split('.')[0]}`} aria-hidden>{AUDIT_ICON(e.action)}</span>
            <div className="log-main">
              <div className="log-text">{text(e)}</div>
              <div className="small muted">{when(e.t)} · {e.admin.startsWith('@') ? e.admin : <span className="num" title={e.admin}>{short(e.admin)}</span>}</div>
            </div>
          </li>
        ))}
      </ul>
      {next && <button className="btn btn-ghost" disabled={loading} onClick={() => load(next)}>{loading ? 'Loading…' : 'Load older'}</button>}
    </div>
  );
}
