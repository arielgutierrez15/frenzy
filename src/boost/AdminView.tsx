import React, { useEffect, useState } from 'react';
import { WalletBar } from '../trading/WalletBar';
import { useWallet } from '../trading/walletStore';
import { signMessageText } from '../trading/wallet';
import { getServerConfig, adminChallenge, adminSession, adminPromotions, adminDecide, type AdminPromotion } from '../trading/api';
import { short } from '../engine';
import { useSession } from '../social/session';

const TABS = [['pending_review', 'Needs review'], ['approved', 'Approved'], ['awaiting_payment', 'Unpaid'], ['rejected', 'Rejected'], ['all', 'All']] as const;

/** BOOST review desk. Reached only at #admin. Every action is authorised server-side by an admin wallet signature. */
export function AdminView() {
  const ws = useWallet();
  const [session, setSession] = useState<{ token: string; wallet: string; expiresAt: number } | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('pending_review');
  const [rows, setRows] = useState<AdminPromotion[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [starts, setStarts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  // test copy: any signed-in BAGZ account can review (the server only allows this in the test copy)
  const ses = useSession();
  const [testCopy, setTestCopy] = useState(false);
  useEffect(() => { getServerConfig().then((c) => { if (c.testCopy && ses.token && ses.user) { setTestCopy(true); setSession({ token: ses.token, wallet: '@' + ses.user.username, expiresAt: Date.now() + 86_400_000 }); } }, () => {}); }, [ses.token]);
  // a session belongs to the wallet that signed it
  useEffect(() => { if (!testCopy && session && ws.conn?.account.address !== session.wallet) setSession(null); }, [ws.conn?.account.address]);
  const load = async () => {
    if (!session) return;
    setErr('');
    try { setRows((await adminPromotions(session.token, tab)).promotions); }
    catch (e: any) { setErr(e?.message || 'Couldn’t load'); if (e?.status === 401) setSession(null); }
  };
  useEffect(() => { load(); }, [session?.token, tab]);

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
  const decide = async (id: string, action: 'approve' | 'reject') => {
    if (!session) return;
    if (action === 'reject' && !(notes[id] || '').trim()) { setErr('Add a short reason before rejecting; the advertiser sees it.'); return; }
    setBusy(id); setErr('');
    try {
      const startsAt = starts[id] ? new Date(starts[id]).getTime() : undefined;
      await adminDecide(session.token, id, action, { startsAt, note: notes[id] });
      await load();
    } catch (e: any) { setErr(e?.message || 'Action failed'); if (e?.status === 401) setSession(null); }
    finally { setBusy(''); }
  };

  return (
    <section className="view admin">
      <header className="view-head"><div><h1>Boost review</h1><p className="muted">Approve or reject paid listings. Only wallets on the server’s admin list can sign in; nothing here moves funds.</p></div></header>
      <div className="panel">
        {testCopy ? <p className="test-copy-note small"><b>Test copy:</b> every account can review here so you can try the flow. In the real app only wallets on the admin list can.</p> : <WalletBar compact />}
        {session ? <p className="small up">Signed in as {session.wallet.startsWith('@') ? session.wallet : short(session.wallet)}{testCopy ? '' : ` until ${new Date(session.expiresAt).toLocaleTimeString()}`}.</p>
          : <button className="btn btn-accent" disabled={!ws.conn || !!busy} onClick={signIn}>{busy || (ws.conn ? 'Sign in with this wallet' : 'Connect an admin wallet')}</button>}
        {err && <p className="small warn">{err}</p>}
      </div>
      {session && (
        <div className="panel">
          <div className="seg" role="tablist" aria-label="Status">{TABS.map(([v, l]) => <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{l}</button>)}</div>
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
      )}
    </section>
  );
}
