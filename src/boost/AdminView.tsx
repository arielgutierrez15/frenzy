import React, { useEffect, useState } from 'react';
import { WalletBar } from '../trading/WalletBar';
import { useWallet } from '../trading/walletStore';
import { signMessageText } from '../trading/wallet';
import { getServerConfig, adminChallenge, adminSession, adminPromotions, adminDecide, adminEndCampaign, adminSwitches, type AdminPromotion, type BoostCounts, type Switches } from '../trading/api';
import { short } from '../engine';
import { useSession } from '../social/session';
import { OverviewPanel, AccountsPanel, LogPanel } from '../admin/Console';
import { SwitchesPanel, FeeSetupPanel, RevenuePanel, BlocklistPanel, UserStatsPanel, VaultPanel, AuditPanel } from '../admin/Controls';

type Session = { token: string; wallet: string; expiresAt: number };
/** the console's sections, grouped so related tools sit together */
const GROUPS = [
  { label: 'Insights', items: [['overview', 'Overview'], ['users', 'Users'], ['revenue', 'Revenue']] },
  { label: 'Controls', items: [['switches', 'Kill switches'], ['fees', 'Fee accounts'], ['boost', 'BOOST queue'], ['blocklist', 'Blocklist'], ['vault', 'Vault']] },
  { label: 'Records', items: [['transactions', 'Transactions'], ['log', 'Activity'], ['audit', 'Audit log']] },
] as const;
type Section = (typeof GROUPS)[number]['items'][number][0];
const itemsOf = (g: (typeof GROUPS)[number]) => g.items as ReadonlyArray<readonly [Section, string]>;
const ALL: Section[] = GROUPS.flatMap((g) => itemsOf(g).map((it) => it[0]));
const readSection = (): Section => {
  try {
    const s = sessionStorage.getItem('bagz-admin-section');
    if (s === 'accounts') return 'users'; // older name for the same section
    return (ALL.includes(s as Section) ? s : 'overview') as Section;
  } catch { return 'overview'; }
};

/** BAGZ admin console. Reached only at #admin. Every request is authorised server-side by an admin wallet signature. */
export function AdminView() {
  const ws = useWallet();
  const [session, setSession] = useState<Session | null>(null);
  const [section, setSection] = useState<Section>(readSection);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [switches, setSwitches] = useState<Switches | null>(null);
  const [pending, setPending] = useState<number | null>(null);

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

  // what needs attention: paused features and BOOST orders waiting for review (refreshed every minute)
  useEffect(() => {
    if (!session) return;
    let live = true;
    const tick = () => {
      adminSwitches(session.token).then((s) => { if (live) setSwitches(s); }, onAuthError);
      adminPromotions(session.token, 'pending_review').then((r) => { if (live) setPending(r.counts?.pending_review ?? r.promotions.length); }, () => {});
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [session?.token]);
  const paused = (switches?.switches || []).filter((s) => s.paused);
  const badge = (v: Section): { n: number; tone: string } | null =>
    v === 'switches' && paused.length ? { n: paused.length, tone: 'down' } : v === 'boost' && pending ? { n: pending, tone: 'accent' } : null;

  return (
    <section className="view admin">
      <header className="view-head"><div><h1>Admin</h1><p className="muted small">Insights, controls and records for BAGZ</p></div></header>
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
          <nav className="admin-nav" aria-label="Admin sections">
            {GROUPS.map((g) => (
              <div key={g.label} className="admin-nav-group">
                <span className="admin-nav-label">{g.label}</span>
                <div className="seg seg-sm admin-tabs" role="tablist" aria-label={g.label}>
                  {itemsOf(g).map(([v, l]) => {
                    const b = badge(v);
                    return (
                      <button key={v} role="tab" aria-selected={section === v} className={section === v ? 'on' : ''} onClick={() => setSection(v)}>
                        {l}{b && <span className={`admin-badge ${b.tone}`} aria-label={`${b.n} need attention`}>{b.n}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          {paused.length > 0 && section !== 'switches' && (
            <button className="admin-alert" onClick={() => setSection('switches')}>
              <b>Paused:</b> {paused.map((s) => s.label).join(', ')} <span className="link">Open kill switches →</span>
            </button>
          )}
          {section === 'overview' && <OverviewPanel token={session.token} onAuthError={onAuthError} />}
          {section === 'users' && <div className="admin-stack"><UserStatsPanel token={session.token} onAuthError={onAuthError} /><AccountsPanel token={session.token} onAuthError={onAuthError} /></div>}
          {section === 'revenue' && <RevenuePanel token={session.token} onAuthError={onAuthError} />}
          {section === 'switches' && <SwitchesPanel token={session.token} onAuthError={onAuthError} onChange={setSwitches} />}
          {section === 'fees' && <FeeSetupPanel token={session.token} onAuthError={onAuthError} adminWallet={session.wallet} />}
          {section === 'boost' && <BoostReview session={session} onAuthError={onAuthError} onCounts={(c) => setPending(c.pending_review ?? 0)} />}
          {section === 'blocklist' && <BlocklistPanel token={session.token} onAuthError={onAuthError} />}
          {section === 'vault' && <VaultPanel token={session.token} onAuthError={onAuthError} />}
          {section === 'transactions' && <LogPanel key="tx" mode="transactions" token={session.token} onAuthError={onAuthError} />}
          {section === 'log' && <LogPanel key="log" mode="log" token={session.token} onAuthError={onAuthError} />}
          {section === 'audit' && <AuditPanel token={session.token} onAuthError={onAuthError} />}
        </>
      )}
    </section>
  );
}

const TABS = [['pending_review', 'Needs review'], ['running', 'Running now'], ['approved', 'Approved'], ['awaiting_payment', 'Unpaid'], ['rejected', 'Rejected'], ['cancelled', 'Ended early'], ['all', 'All']] as const;
type Tab = (typeof TABS)[number][0];
const fmtUsdc = (raw: string) => (Number(raw) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 });

/** BOOST queue: review paid sponsored listings, watch running campaigns, end one early. */
function BoostReview({ session, onAuthError, onCounts }: { session: Session; onAuthError: (e: any) => void; onCounts?: (c: BoostCounts) => void }) {
  const [tab, setTab] = useState<Tab>('pending_review');
  const [rows, setRows] = useState<AdminPromotion[]>([]);
  const [counts, setCounts] = useState<BoostCounts>({});
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [starts, setStarts] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [ending, setEnding] = useState<string | null>(null);
  const load = async () => {
    try {
      const r = await adminPromotions(session.token, tab);
      setRows(r.promotions); setLoaded(true); setErr('');
      if (r.counts) { setCounts(r.counts); onCounts?.(r.counts); }
    } catch (e: any) { setErr(e?.message || 'Couldn’t load'); onAuthError(e); }
  };
  useEffect(() => { setLoaded(false); load(); }, [session.token, tab]);
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
  const endNow = async (id: string) => {
    if (!(notes[id] || '').trim()) { setErr('Add a short reason for ending it; the advertiser sees it.'); return; }
    setBusy(id); setErr('');
    try { await adminEndCampaign(session.token, id, notes[id]); setEnding(null); await load(); }
    catch (e: any) { setErr(e?.message || 'Couldn’t end it'); onAuthError(e); }
    finally { setBusy(''); }
  };
  const countOf = (v: Tab) => (v === 'all' ? null : counts[v as keyof BoostCounts] ?? null);
  return (
    <div className="panel">
      <div className="seg seg-sm" role="tablist" aria-label="Status">
        {TABS.map(([v, l]) => { const n = countOf(v); return <button key={v} role="tab" aria-selected={tab === v} className={tab === v ? 'on' : ''} onClick={() => setTab(v)}>{l}{n ? <span className="seg-count num">{n}</span> : null}</button>; })}
      </div>
      {!!counts.refunds && <p className="admin-callout small warn"><b>{counts.refunds} rejected order{counts.refunds === 1 ? '' : 's'} were paid.</b> Refund the USDC by hand from the BOOST wallet; see the Rejected tab.</p>}
      {err && <p className="small warn">{err}</p>}
      {loaded && !rows.length && <p className="muted small">{tab === 'pending_review' ? 'Nothing waiting for review.' : 'Nothing here.'}</p>}
      <ul className="admin-list">
        {rows.map((r) => (
          <li key={r.id} className={`admin-row${r.blocked ? ' is-blocked' : ''}`}>
            <div className="row gap-s wrap">
              {r.icon ? <img src={r.icon} alt="" width={28} height={28} referrerPolicy="no-referrer" className="promo-ico" /> : null}
              <b>${r.symbol}</b><span className="muted small">{r.name}</span><span className="grow" />
              {r.running && <span className="pill pill-up">Live now</span>}
              {r.blocked && <span className="pill pill-down">Blocked token</span>}
              {r.refundOwed && <span className="pill pill-warn">Refund owed</span>}
              <span className="pill pill-unofficial">{r.package} · ${r.priceUsdc}</span>
            </div>
            <div className="small muted num">
              Mint <a className="link" href={`https://solscan.io/token/${r.mint}`} target="_blank" rel="noopener noreferrer">{short(r.mint)}</a> · advertiser {short(r.advertiser)} · ordered {new Date(r.createdAt).toLocaleString()}
              {r.payment && <> · paid <a className="link" href={`https://solscan.io/tx/${r.payment.signature}`} target="_blank" rel="noopener noreferrer">{short(r.payment.signature)}</a> ({fmtUsdc(r.payment.amount_raw)} USDC)</>}
              {r.startsAt && r.endsAt && <> · runs {new Date(r.startsAt).toLocaleString()} → {new Date(r.endsAt).toLocaleString()}</>}
              {(r.status === 'approved' || r.status === 'cancelled') && <> · {r.stats.impressions} impressions · {r.stats.clicks} clicks{r.stats.impressions ? ` (${((r.stats.clicks / r.stats.impressions) * 100).toFixed(1)}% CTR)` : ''}</>}
              {r.reviewNote && <> · note: {r.reviewNote}</>}
              {r.reviewedBy && <> · by {r.reviewedBy.startsWith('@') ? r.reviewedBy : short(r.reviewedBy)}</>}
            </div>
            {r.status === 'pending_review' && (
              <div className="row gap-s wrap">
                {!r.blocked && <label className="small muted">Start <input type="datetime-local" value={starts[r.id] || ''} onChange={(e) => setStarts({ ...starts, [r.id]: e.target.value })} /></label>}
                <input className="admin-note" placeholder={r.blocked ? 'Reason (required)' : 'Note (required to reject)'} value={notes[r.id] || ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} maxLength={300} />
                {!r.blocked && <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => decide(r.id, 'approve')}>Approve</button>}
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => decide(r.id, 'reject')}>Reject</button>
              </div>
            )}
            {r.status === 'approved' && (ending === r.id ? (
              <div className="row gap-s wrap">
                <input className="admin-note" autoFocus placeholder="Reason (the advertiser sees it)" value={notes[r.id] || ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} maxLength={300} />
                <button className="btn btn-down-solid btn-sm" disabled={!!busy} onClick={() => endNow(r.id)}>{busy === r.id ? 'Ending…' : 'End campaign now'}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEnding(null)}>Cancel</button>
              </div>
            ) : (
              <div className="row gap-s"><button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => { setEnding(r.id); setErr(''); }}>End early…</button></div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
