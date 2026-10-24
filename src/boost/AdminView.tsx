import React, { useEffect, useState } from 'react';
import { WalletBar } from '../trading/WalletBar';
import { useWallet } from '../trading/walletStore';
import { signMessageText } from '../trading/wallet';
import { getServerConfig, adminChallenge, adminSession, adminPromotions, adminDecide, type AdminPromotion } from '../trading/api';
import { short } from '../engine';
import { useSession } from '../social/session';
import { OverviewPanel, AccountsPanel, LogPanel } from '../admin/Console';

type Session = { token: string; wallet: string; expiresAt: number };
const SECTIONS = [['overview', 'Overview'], ['accounts', 'Accounts'], ['transactions', 'Transactions'], ['log', 'Activity log'], ['boost', 'Boost review']] as const;
type Section = (typeof SECTIONS)[number][0];
const readSection = (): Section => { try { const s = sessionStorage.getItem('bagz-admin-section'); return (SECTIONS.some(([v]) => v === s) ? s : 'overview') as Section; } catch { return 'overview'; } };

/** BAGZ admin console. Reached only at #admin. Every request is authorised server-side by an admin wallet signature. */
export function AdminView() {
  const ws = useWallet();
  const [session, setSession] = useState<Session | null>(null);
  const [section, setSection] = useState<Section>(readSection);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  // test copy: any signed-in BAGZ account can use the desk (the server only allows this in the test copy)
  const ses = useSession();
  const [testCopy, setTestCopy] = useState(false);
  useEffect(() => { getServerConfig().then((c) => { if (c.testCopy && ses.token && ses.user) { setTestCopy(true); setSession({ token: ses.token, wallet: '@' + ses.user.username, expiresAt: Date.now() + 86_400_000 }); } }, () => {}); }, [ses.token]);
  // a session belongs to the wallet that signed it
  useEffect(() => { if (!testCopy && session && ws.conn?.account.address !== session.wallet) setSession(null); }, [ws.conn?.account.address]);
  useEffect(() => { try { sessionStorage.setItem('bagz-admin-section', section); } catch { /* storage off */ } }, [section]);

  const signIn = async () => {
    if (!ws.conn) return;
    setBusy('Sign the message in your wallet'); setErr('');
    try {
      const c = await adminChallenge(ws.conn.account.address);
      const sig = await signMessageText(ws.conn, c.message);
      setSession(await adminSession(ws.conn.account.address, c.nonce, sig));
    } catch (e: any) { setErr(e?.message || 'Sign-in failed'); }
    finally { setBusy(''); }
  };
  const onAuthError = (e: any) => { if (e?.status === 401) { setSession(null); setErr('Admin session ended. Sign in again.'); } };

  return (
    <section className="view admin">
      <header className="view-head"><div><h1>Admin</h1><p className="muted small">App activity, accounts, transactions and Boost review</p></div></header>
      {!session || testCopy ? (
        <div className="panel">
          {testCopy ? <p className="test-copy-note small"><b>Test copy:</b> every account can open the admin desk here so you can try it. In the real app only wallets on the admin list can.</p> : <WalletBar compact />}
          {!session && <button className="btn btn-accent" disabled={!ws.conn || !!busy} onClick={signIn}>{busy || (ws.conn ? 'Sign in with this wallet' : 'Connect an admin wallet')}</button>}
          {err && <p className="small warn">{err}</p>}
        </div>
      ) : (
        <p className="small muted admin-who">Signed in as {short(session.wallet)} until {new Date(session.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{err && <span className="warn"> · {err}</span>}</p>
      )}
      {session && (
        <>
          <div className="seg admin-tabs" role="tablist" aria-label="Admin sections">
            {SECTIONS.map(([v, l]) => <button key={v} role="tab" aria-selected={section === v} className={section === v ? 'on' : ''} onClick={() => setSection(v)}>{l}</button>)}
          </div>
          {section === 'overview' && <OverviewPanel token={session.token} onAuthError={onAuthError} />}
          {section === 'accounts' && <AccountsPanel token={session.token} onAuthError={onAuthError} />}
          {section === 'transactions' && <LogPanel key="tx" mode="transactions" token={session.token} onAuthError={onAuthError} />}
          {section === 'log' && <LogPanel key="log" mode="log" token={session.token} onAuthError={onAuthError} />}
          {section === 'boost' && <BoostReview session={session} onAuthError={onAuthError} />}
        </>
      )}
    </section>
  );
}

const TABS = [['pending_review', 'Needs review'], ['approved', 'Approved'], ['awaiting_payment', 'Unpaid'], ['rejected', 'Rejected'], ['all', 'All']] as const;

/** BOOST review desk: approve or reject paid sponsored listings. */
function BoostReview({ session, onAuthError }: { session: Session; onAuthError: (e: any) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('pending_review');
  const [rows, setRows] = useState<AdminPromotion[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [starts, setStarts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = async () => {
    setErr('');
    try { setRows((await adminPromotions(session.token, tab)).promotions); }
    catch (e: any) { setErr(e?.message || 'Couldn’t load'); onAuthError(e); }
  };
  useEffect(() => { load(); }, [session.token, tab]);
  const decide = async (id: string, action: 'approve' | 'reject') => {
    if (action === 'reject' && !(notes[id] || '').trim()) { setErr('Add a short reason before rejecting; the advertiser sees it.'); return; }
    setBusy(id); setErr('');
    try {
      const startsAt = starts[id] ? new Date(starts[id]).getTime() : undefined;
      await adminDecide(session.token, id, action, { startsAt, note: notes[id] });
      await load();
    } catch (e: any) { setErr(e?.message || 'Action failed'); onAuthError(e); }
    finally { setBusy(''); }
  };
  return (
    <div className="panel">
      <div className="seg seg-sm" role="tablist" aria-label="Status">{TABS.map(([v, l]) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{l}</button>)}</div>
      {err && <p className="small warn">{err}</p>}
      {!rows.length && <p className="muted small">Nothing here.</p>}
      <ul className="admin-list">
        {rows.map((r) => (
          <li key={r.id} className="admin-row">
            <div className="row gap-s wrap">
              {r.icon ? <img src={r.icon} alt="" width={28} height={28} referrerPolicy="no-referrer" className="promo-ico" /> : null}
              <b>${r.symbol}</b><span className="muted small">{r.name}</span><span className="grow" />
              <span className="pill pill-unofficial">{r.package} · ${r.priceUsdc}</span>
            </div>
            <div className="small muted num">
              Mint <a className="link" href={`https://solscan.io/token/${r.mint}`} target="_blank" rel="noopener noreferrer">{short(r.mint)}</a> · advertiser {short(r.advertiser)} · ordered {new Date(r.createdAt).toLocaleString()}
              {r.payment && <> · paid <a className="link" href={`https://solscan.io/tx/${r.payment.signature}`} target="_blank" rel="noopener noreferrer">{short(r.payment.signature)}</a> ({Number(r.payment.amount_raw) / 1e6} USDC)</>}
              {r.startsAt && r.endsAt && <> · runs {new Date(r.startsAt).toLocaleString()} → {new Date(r.endsAt).toLocaleString()}</>}
              {r.status === 'approved' && <> · {r.stats.impressions} impressions · {r.stats.clicks} clicks{r.stats.impressions ? ` (${((r.stats.clicks / r.stats.impressions) * 100).toFixed(1)}% CTR)` : ''}</>}
              {r.reviewNote && <> · note: {r.reviewNote}</>}
            </div>
            {r.status === 'pending_review' && (
              <div className="row gap-s wrap">
                <label className="small muted">Start <input type="datetime-local" value={starts[r.id] || ''} onChange={(e) => setStarts({ ...starts, [r.id]: e.target.value })} /></label>
                <input className="admin-note" placeholder="Note (required to reject)" value={notes[r.id] || ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} maxLength={300} />
                <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => decide(r.id, 'approve')}>Approve</button>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => decide(r.id, 'reject')}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
