import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNav } from '../nav';
import { useStore } from '../store';
import { Icon } from '../ui';
import { Wordmark, Badge } from '../brand';
import { ago, compact, pct, signedUsd, usd, price as fmtPrice } from '../format';
import { haptic } from '../telegram';
import { useSession, signedIn, updateMe, logout, accountDeleted, getSession, syncNow } from './session';
import * as api from './api';
import { demo } from '../demo/hook';
import type { UserSummary, Activity, Profile, ChatSummary, Message, Relation } from './api';

const errMsg = (e: any) => (e && e.message) || 'Something went wrong';

// ======================================================================
// avatar
// ======================================================================
const noSub = () => () => {};
const zero = () => 0;
export function UserAvatar({ u, size = 36 }: { u: UserSummary | null | undefined; size?: number }) {
  const d = demo();
  useSyncExternalStore(d ? d.subscribe : noSub, d ? d.version : zero, d ? d.version : zero);
  const [broken, setBroken] = useState(false);
  const src = broken ? null : api.avatarUrl(u);
  if (src) return <img className="uavatar" src={src} width={size} height={size} style={{ width: size, height: size }} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <span className="uavatar uavatar-empty" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">{(u?.username || '?').slice(0, 1).toUpperCase()}</span>;
}

/** center-crops and shrinks a picked photo to a 320×320 JPEG data URL (always well under the 150 KB limit) */
export async function shrinkImage(file: File): Promise<string> {
  if (!/^image\//.test(file.type) && !/\.(png|jpe?g|webp|heic|heif|gif)$/i.test(file.name)) throw new Error('Pick a picture file');
  if (file.size > 25_000_000) throw new Error('That picture is too big (25 MB max)');
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That picture couldn’t be opened. Try a JPEG or PNG.')); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    if (!side) throw new Error('That picture is empty');
    const cv = document.createElement('canvas');
    cv.width = cv.height = 320;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#090909'; ctx.fillRect(0, 0, 320, 320);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 320, 320);
    for (const q of [0.86, 0.75, 0.6, 0.45]) {
      const d = cv.toDataURL('image/jpeg', q);
      if (d.length * 0.75 < 140_000) return d;
    }
    throw new Error('Couldn’t make that picture small enough');
  } finally { URL.revokeObjectURL(url); }
}

// ======================================================================
// first visit: create a public profile (username, password, picture)
// ======================================================================
export function Onboarding() {
  const ses = useSession();
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const step = ses.status === 'incomplete' ? 'picture' : 'account';
  return (
    <div className="onboard">
      <div className="onboard-card">
        <div className="onboard-brand"><Badge className="brand-badge onboard-badge" /><Wordmark /></div>
        {demo() && <TestCopyNote />}
        <ol className="onboard-steps" aria-label="Steps">
          <li className={step === 'account' ? 'on' : 'done'}>1 · Account</li>
          <li className={step === 'picture' ? 'on' : ''}>2 · Picture</li>
          <li>3 · Trade</li>
        </ol>
        {step === 'picture' ? <PictureStep /> : mode === 'signup' ? <SignupForm onLogin={() => setMode('login')} /> : <LoginForm onSignup={() => setMode('signup')} />}
      </div>
    </div>
  );
}

function SignupForm({ onLogin }: { onLogin: () => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [confirm, setC] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nameOk = /^[A-Za-z0-9_]{3,20}$/.test(username);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameOk) return setErr('Usernames are 3–20 letters, numbers or _');
    if (password.length < 8) return setErr('Use a password of at least 8 characters');
    if (password !== confirm) return setErr('The passwords don’t match');
    setBusy(true); setErr('');
    try { const r = await api.signup(username, password); haptic.ok(); signedIn(r.token, r.user); }
    catch (e2) { haptic.fail(); setErr(errMsg(e2)); }
    finally { setBusy(false); }
  };
  return (
    <form className="stack gap" onSubmit={submit}>
      <div><h1>Create your profile</h1><p className="muted">You need a public profile to trade on BAGZ, join the leaderboard and chat with friends.</p></div>
      <label className="field"><span>Username</span><input value={username} onChange={(e) => setU(e.target.value.replace(/\s/g, ''))} autoComplete="username" autoCapitalize="off" spellCheck={false} maxLength={20} placeholder="e.g. gorilla_gains" aria-invalid={!!username && !nameOk} /></label>
      {username && !nameOk && <span className="small warn">3–20 letters, numbers or _</span>}
      <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="new-password" minLength={8} maxLength={128} placeholder="8+ characters" /></label>
      <label className="field"><span>Confirm password</span><input type="password" value={confirm} onChange={(e) => setC(e.target.value)} autoComplete="new-password" maxLength={128} /></label>
      {err && <p className="small warn" role="alert">{err}</p>}
      <button className="btn btn-accent btn-lg" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button>
      <p className="muted small">Your username, picture and paper-trading results are public. Your password is never shown to anyone.</p>
      <button type="button" className="link" onClick={onLogin}>I already have an account</button>
    </form>
  );
}

function LoginForm({ onSignup }: { onSignup: () => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { const r = await api.login(username.trim(), password); haptic.ok(); signedIn(r.token, r.user); }
    catch (e2) { haptic.fail(); setErr(errMsg(e2)); }
    finally { setBusy(false); }
  };
  return (
    <form className="stack gap" onSubmit={submit}>
      <div><h1>Welcome back</h1><p className="muted">Sign in to your BAGZ profile.</p></div>
      <label className="field"><span>Username</span><input value={username} onChange={(e) => setU(e.target.value)} autoComplete="username" autoCapitalize="off" spellCheck={false} /></label>
      <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
      {err && <p className="small warn" role="alert">{err}</p>}
      <button className="btn btn-accent btn-lg" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <button type="button" className="link" onClick={onSignup}>New here? Create a profile</button>
    </form>
  );
}

function PictureStep() {
  const ses = useSession();
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr('');
    try { setPreview(await shrinkImage(f)); } catch (e) { setErr(errMsg(e)); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { const r = await api.uploadAvatar(preview); haptic.ok(); updateMe(r.user); }
    catch (e) { haptic.fail(); setErr(errMsg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="stack gap">
      <div><h1>Add a profile picture</h1><p className="muted">Hi @{ses.user?.username}. Pick a picture for your public profile. It shows on the leaderboard, in chats and to friends.</p></div>
      <label className="pfp-pick">
        {preview ? <img src={preview} alt="Your new profile picture" className="pfp-preview" /> : <span className="pfp-empty"><Icon.plus size={28} /><span>Choose a photo</span></span>}
        <input type="file" accept="image/*" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} aria-label="Choose a profile picture" />
      </label>
      {err && <p className="small warn" role="alert">{err}</p>}
      <button className="btn btn-accent btn-lg" disabled={!preview || busy} onClick={save}>{busy ? 'Uploading…' : 'Save and start trading'}</button>
      <button type="button" className="link small" onClick={() => logout()}>Use a different account</button>
    </div>
  );
}

// ======================================================================
// public profile (anyone) and your own profile (#me)
// ======================================================================
export function ProfileView({ username }: { username?: string }) {
  const nav = useNav();
  const ses = useSession();
  const name = username || ses.user?.username || '';
  const self = !!ses.user && ses.user.username.toLowerCase() === name.toLowerCase();
  const [p, setP] = useState<Profile | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => { let live = true; setErr(''); api.getProfile(name).then((x) => live && setP(x), (e) => live && setErr(errMsg(e))); return () => { live = false; }; }, [name, n, ses.user?.avatarVer]);

  if (ses.status === 'unavailable') return <section className="view"><BackBtn /><div className="empty"><Badge className="brand-badge empty-badge" /><b>Profiles are offline</b><p>Accounts need the BAGZ server, which isn’t connected to this page yet.</p></div></section>;
  if (err) return <section className="view"><BackBtn /><div className="empty"><b>Couldn’t open @{name}</b><p>{err}</p></div></section>;
  if (!p) return <section className="view"><BackBtn /><div className="loading"><span className="spinner" />Loading @{name}…</div></section>;

  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); haptic.tap(); setN((x) => x + 1); } catch (e) { nav.toast('down', 'That didn’t work', errMsg(e)); } finally { setBusy(false); } };
  const s = p.stats;
  return (
    <section className="view profile">
      <BackBtn />
      <header className="profile-head panel">
        <UserAvatar u={p.user} size={88} />
        <div className="stack grow">
          <h1>@{p.user.username}</h1>
          {p.user.bio && <p className="profile-bio">{p.user.bio}</p>}
          <span className="muted small">Joined {new Date(p.user.createdAt).toLocaleDateString([], { month: 'short', year: 'numeric' })} · {p.friends} friend{p.friends === 1 ? '' : 's'}{p.rank ? ` · #${p.rank} on the leaderboard` : ''}</span>
        </div>
        {!self && <RelationButton rel={p.relation} busy={busy} onAdd={() => act(() => api.requestFriend(p.user.username))} onAccept={() => act(() => api.respondFriend(p.user.id, true))} onRemove={() => act(() => api.removeFriend(p.user.id))} />}
      </header>
      {self && <SelfTools onChanged={() => setN((x) => x + 1)} bio={p.user.bio} />}
      <div className="panel">
        <div className="row gap-s wrap"><h2>Paper trading</h2><span className="pill pill-unofficial">Reported by the BAGZ app</span></div>
        {s && s.trades > 0 ? (
          <dl className="stats stats-3">
            <div><dt>All-time PnL</dt><dd className={`num ${s.pnl >= 0 ? 'up' : 'down'}`}>{pct(s.pnlPct, 2)}</dd></div>
            <div><dt>Profit</dt><dd className={`num ${s.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(s.pnl)}</dd></div>
            <div><dt>Value</dt><dd className="num">{usd(s.equity)}</dd></div>
            <div><dt>Win rate</dt><dd className="num">{s.sells ? `${s.winRate.toFixed(0)}%` : '—'}</dd></div>
            <div><dt>Trades</dt><dd className="num">{s.trades}</dd></div>
            <div><dt>Best trade</dt><dd className="num">{s.best ? `$${s.best.symbol} ${pct(s.best.pct, 0)}` : '—'}</dd></div>
          </dl>
        ) : <p className="muted small">{self ? 'Make your first paper trade and your stats show up here and on the leaderboard.' : 'No paper trades yet.'}</p>}
      </div>
      <div className="panel">
        <h2>Recent activity</h2>
        {p.activity.length ? <ul className="tape activity social-acts">{p.activity.map((a) => <ActivityRow key={a.id} a={a} />)}</ul> : <p className="muted small">Nothing yet.</p>}
      </div>
    </section>
  );
}
function BackBtn() { const nav = useNav(); return <button className="back" onClick={() => nav.back()}><Icon.back /> Back</button>; }

function RelationButton({ rel, busy, onAdd, onAccept, onRemove }: { rel: Relation; busy: boolean; onAdd: () => void; onAccept: () => void; onRemove: () => void }) {
  const [confirm, setConfirm] = useState(false);
  if (rel === 'friends') return confirm
    ? <span className="row gap-s"><button className="btn btn-down-solid btn-sm" disabled={busy} onClick={onRemove}>Remove</button><button className="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>Keep</button></span>
    : <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(true)}><Icon.check size={14} /> Friends</button>;
  if (rel === 'requested') return <button className="btn btn-ghost btn-sm" disabled={busy} onClick={onRemove}>Requested · cancel</button>;
  if (rel === 'incoming') return <button className="btn btn-accent btn-sm" disabled={busy} onClick={onAccept}>Accept request</button>;
  return <button className="btn btn-accent btn-sm" disabled={busy} onClick={onAdd}><Icon.plus size={14} /> Add friend</button>;
}

function SelfTools({ onChanged, bio }: { onChanged: () => void; bio: string }) {
  const nav = useNav();
  const [editBio, setEditBio] = useState(false);
  const [text, setText] = useState(bio);
  const [del, setDel] = useState(false);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { const d = await shrinkImage(f); const r = await api.uploadAvatar(d); updateMe(r.user); onChanged(); nav.toast('info', 'Picture updated'); }
    catch (e) { nav.toast('down', 'Picture not saved', errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div className="panel">
      <div className="row gap-s wrap">
        <label className="btn btn-ghost btn-sm file-btn">Change picture<input type="file" accept="image/*" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} disabled={busy} /></label>
        <button className="btn btn-ghost btn-sm" onClick={() => setEditBio((x) => !x)}>{bio ? 'Edit bio' : 'Add a bio'}</button>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm" onClick={() => logout()}>Log out</button>
      </div>
      {editBio && (
        <div className="stack gap-xs">
          <textarea className="bio-input" value={text} maxLength={160} rows={2} onChange={(e) => setText(e.target.value)} placeholder="Say something about your trading style" aria-label="Bio" />
          <div className="row gap-s"><span className="muted small">{text.length}/160</span><span className="grow" /><button className="btn btn-accent btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { const r = await api.saveBio(text); updateMe(r.user); setEditBio(false); onChanged(); } catch (e) { nav.toast('down', 'Bio not saved', errMsg(e)); } finally { setBusy(false); } }}>Save bio</button></div>
        </div>
      )}
      {!del ? <button className="link small danger-link" onClick={() => setDel(true)}>Delete my account</button> : (
        <div className="stack gap-xs danger-box">
          <b>Delete your BAGZ account?</b>
          <span className="small muted">Your profile, friends, leaderboard spot and sign-in are removed for good. Your paper wallet stays on this device.</span>
          <input type="password" placeholder="Your password" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Password to confirm" />
          <div className="row gap-s"><button className="btn btn-down-solid btn-sm" disabled={!pw || busy} onClick={async () => { setBusy(true); try { await api.deleteAccount(pw); accountDeleted(); } catch (e) { nav.toast('down', 'Not deleted', errMsg(e)); } finally { setBusy(false); } }}>Delete forever</button><button className="btn btn-ghost btn-sm" onClick={() => { setDel(false); setPw(''); }}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}

function ActivityRow({ a, withUser = false }: { a: Activity; withUser?: boolean }) {
  const nav = useNav();
  const st = useStore();
  const coinId = `solana:${a.mint}`;
  const openCoin = () => { if (st.coins[coinId]) nav.openCoin(coinId); };
  return (
    <li className="social-act" onClick={openCoin}>
      {withUser && a.user && <button className="bare" onClick={(e) => { e.stopPropagation(); nav.openUser(a.user!.username); }} aria-label={`Open @${a.user.username}`}><UserAvatar u={a.user} size={30} /></button>}
      {withUser && a.user && <button className="bare handle" onClick={(e) => { e.stopPropagation(); nav.openUser(a.user!.username); }}>@{a.user.username}</button>}
      {a.kind === 'trade' ? (
        <>
          <span className={`tag ${a.side === 'BUY' ? 'tag-up' : 'tag-down'}`}>{a.side === 'BUY' ? 'Bought' : 'Sold'}</span>
          <b>${a.symbol}</b><span className="grow" />
          <span className="num">{usd(a.usd)}</span>
          <span className="num muted hide-s">@ {fmtPrice(a.price)}</span>
          {a.pnl !== undefined && <span className={`num ${a.pnl >= 0 ? 'up' : 'down'}`}>{signedUsd(a.pnl)}</span>}
        </>
      ) : (
        <>
          <span className={`tag ${a.bull ? 'tag-up' : 'tag-down'}`}>{a.bull ? 'Bullish' : 'Bearish'}</span>
          <b>${a.symbol}</b><span className="grow thesis-text">“{a.text}”</span>
        </>
      )}
      <span className="muted small">{ago(a.t)}</span>
    </li>
  );
}

// ======================================================================
// friends' activity (Live tab → Friends filter)
// ======================================================================
export function FriendsFeed() {
  const nav = useNav();
  const ses = useSession();
  const [data, setData] = useState<{ items: Activity[]; friends: number } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (ses.status !== 'ready') return;
    let live = true;
    const load = () => api.friendsFeed().then((d) => { if (live) { setData(d); setErr(''); } }, (e) => live && setErr(errMsg(e)));
    load();
    const t = setInterval(load, 20_000);
    return () => { live = false; clearInterval(t); };
  }, [ses.status]);
  if (ses.status !== 'ready') return <div className="empty"><b>Friends need an account</b><p>Accounts need the BAGZ server, which isn’t connected to this page yet.</p></div>;
  if (err && !data) return <div className="empty"><b>Couldn’t load your friends’ trades</b><p>{err}</p></div>;
  if (!data) return <div className="loading"><span className="spinner" />Loading your friends’ trades…</div>;
  if (!data.friends) return <div className="empty"><Badge className="brand-badge empty-badge" /><b>No friends yet</b><p>Add friends to see their paper trades and calls here.</p><button className="btn btn-accent" onClick={() => nav.go('chats', { section: 'friends' })}>Find friends</button></div>;
  if (!data.items.length) return <div className="empty"><b>Quiet so far</b><p>Your friends haven’t traded yet. Their buys, sells and calls show up here.</p></div>;
  return <ul className="tape activity social-acts friends-feed">{data.items.map((a) => <ActivityRow key={a.id} a={a} withUser />)}</ul>;
}

// ======================================================================
// Ranks tab: public leaderboard (global / friends) + on-chain wallets
// ======================================================================
export function RanksView({ onchain }: { onchain: React.ReactNode }) {
  const nav = useNav();
  const ses = useSession();
  const [scope, setScope] = useState<'global' | 'friends' | 'onchain'>('global');
  const [sort, setSort] = useState<'pnl_pct' | 'pnl' | 'win_rate'>('pnl_pct');
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getLeaderboard>> | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (scope === 'onchain' || ses.status !== 'ready') return;
    let live = true;
    setData(null); setErr('');
    const load = () => api.getLeaderboard(scope, sort).then((d) => live && setData(d), (e) => live && setErr(errMsg(e)));
    // your own latest numbers first, so your row is current
    syncNow().finally(load);
    const t = setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, [scope, sort, ses.status]);
  const val = (s: api.Stats) => (sort === 'win_rate' ? `${s.winRate.toFixed(0)}%` : sort === 'pnl' ? signedUsd(s.pnl) : pct(s.pnlPct, 2));
  return (
    <section className="view">
      <header className="view-head"><div><h1>Leaderboard</h1><p className="muted">BAGZ traders ranked by their paper-trading results on live prices. Results are reported by the BAGZ app.</p></div></header>
      <div className="seg" role="tablist" aria-label="Leaderboard">
        {([['global', 'Everyone'], ['friends', 'Friends'], ['onchain', 'On-chain wallets']] as const).map(([v, l]) => <button key={v} role="tab" aria-selected={scope === v} className={scope === v ? 'on' : ''} onClick={() => { haptic.tap(); setScope(v); }}>{l}</button>)}
      </div>
      {scope === 'onchain' ? onchain : ses.status !== 'ready' ? (
        <div className="empty"><Badge className="brand-badge empty-badge" /><b>The leaderboard is offline</b><p>It needs the BAGZ server, which isn’t connected to this page yet. On-chain wallets still work.</p></div>
      ) : (
        <>
          <div className="seg seg-sm" role="tablist" aria-label="Rank by">
            {([['pnl_pct', 'PnL %'], ['pnl', 'Profit $'], ['win_rate', 'Win rate']] as const).map(([v, l]) => <button key={v} role="tab" aria-selected={sort === v} className={sort === v ? 'on' : ''} onClick={() => setSort(v)}>{l}</button>)}
          </div>
          {data?.mine && (
            <button className="you-row" onClick={() => nav.go('me')}>
              <span className="rank num rank-top">#{data.mine.rank}</span>
              <UserAvatar u={ses.user} size={36} />
              <div className="stack"><b>You · @{ses.user?.username}</b><span className="muted small num">{data.mine.stats.trades} trades · {data.mine.stats.sells ? `${data.mine.stats.winRate.toFixed(0)}% wins` : 'no closed trades'}</span></div>
              <span className="grow" /><b className={`num ${data.mine.stats.pnl >= 0 ? 'up' : 'down'}`}>{val(data.mine.stats)}</b>
            </button>
          )}
          {err && <p className="small warn">{err}</p>}
          {!data && !err && <div className="loading"><span className="spinner" />Loading the leaderboard…</div>}
          {data && (data.rows.length ? (
            <ol className="leaders">
              {data.rows.map((r) => (
                <li key={r.user.id} onClick={() => nav.openUser(r.user.username)} className={r.user.id === ses.user?.id ? 'is-me' : ''}>
                  <span className={`rank num ${r.rank <= 3 ? 'rank-top' : ''}`}>{r.rank}</span>
                  <UserAvatar u={r.user} />
                  <div className="stack"><b>@{r.user.username}</b><span className="muted small num">{r.stats.trades} trades · value {compact(r.stats.equity)}</span></div>
                  <span className="grow" />
                  <b className={`num ${sort === 'win_rate' ? '' : r.stats.pnl >= 0 ? 'up' : 'down'}`}>{val(r.stats)}</b>
                </li>
              ))}
            </ol>
          ) : <div className="empty"><b>{scope === 'friends' ? 'No ranked friends yet' : 'Nobody is ranked yet'}</b><p>{scope === 'friends' ? 'Add friends from the Chats tab. They show up once they’ve made a paper trade.' : 'Make a paper trade and be the first on the board.'}</p></div>)}
          {data && data.total > data.rows.length && <p className="muted small">Showing the top {data.rows.length} of {data.total}.</p>}
        </>
      )}
    </section>
  );
}

// ======================================================================
// Chats tab: group chats + friends (requests, search)
// ======================================================================
const countsSubs = new Set<() => void>();
let counts = { unread: 0, requests: 0 };
const getCounts = () => counts;
export const useSocialCounts = () => useSyncExternalStore((f) => { countsSubs.add(f); return () => { countsSubs.delete(f); }; }, getCounts, getCounts);
export async function refreshCounts() {
  if (getSession().status !== 'ready') return;
  try {
    const [c, f] = await Promise.all([api.listChats(), api.getFriends()]);
    const next = { unread: c.unread, requests: f.incoming.length };
    if (next.unread !== counts.unread || next.requests !== counts.requests) { counts = next; countsSubs.forEach((x) => x()); }
  } catch { /* next round */ }
}

export function ChatsView({ section }: { section?: 'chats' | 'friends' }) {
  const ses = useSession();
  const c = useSocialCounts();
  const [tab, setTab] = useState<'chats' | 'friends'>(section || 'chats');
  useEffect(() => { if (section) setTab(section); }, [section]);
  if (ses.status !== 'ready') return <section className="view"><header className="view-head"><div><h1>Chats</h1></div></header><div className="empty"><Badge className="brand-badge empty-badge" /><b>Chats are offline</b><p>Friends and group chats need the BAGZ server, which isn’t connected to this page yet.</p></div></section>;
  return (
    <section className="view">
      <header className="view-head"><div><h1>{tab === 'chats' ? 'Chats' : 'Friends'}</h1><p className="muted">{tab === 'chats' ? 'Group chats with your BAGZ friends.' : 'Add friends to see their trades and start group chats.'}</p></div></header>
      <div className="seg" role="tablist" aria-label="Chats or friends">
        <button role="tab" aria-selected={tab === 'chats'} className={tab === 'chats' ? 'on' : ''} onClick={() => setTab('chats')}>Chats{c.unread ? ` · ${c.unread}` : ''}</button>
        <button role="tab" aria-selected={tab === 'friends'} className={tab === 'friends' ? 'on' : ''} onClick={() => setTab('friends')}>Friends{c.requests ? ` · ${c.requests} new` : ''}</button>
      </div>
      {tab === 'chats' ? <ChatList /> : <FriendsPanel />}
    </section>
  );
}

function ChatList() {
  const nav = useNav();
  const [chats, setChats] = useState<ChatSummary[] | null>(null);
  const [err, setErr] = useState('');
  const [making, setMaking] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api.listChats().then((d) => { if (live) { setChats(d.chats); setErr(''); } }, (e) => live && setErr(errMsg(e)));
    load(); refreshCounts();
    const t = setInterval(load, 10_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  return (
    <>
      <button className="btn btn-accent" onClick={() => setMaking(true)}><Icon.plus size={16} /> New group</button>
      {err && !chats && <p className="small warn">{err}</p>}
      {!chats && !err && <div className="loading"><span className="spinner" />Loading chats…</div>}
      {chats && (chats.length ? (
        <ul className="chat-list">
          {chats.map((c) => (
            <li key={c.id}>
              <button className="bare row gap-s full" onClick={() => nav.openChat(c.id)}>
                <span className="chat-avs">{c.members.slice(0, 3).map((m) => <UserAvatar key={m.id} u={m} size={30} />)}</span>
                <span className="stack grow"><b>{c.name}</b><span className="muted small chat-last">{c.last ? `${c.last.username ? c.last.username + ': ' : ''}${c.last.body}` : `${c.memberCount} members`}</span></span>
                <span className="stack r"><span className="muted small">{c.last ? ago(c.last.t) : ''}</span>{c.unread > 0 && <span className="dot-count num chat-unread">{c.unread > 99 ? '99+' : c.unread}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="empty"><Badge className="brand-badge empty-badge" /><b>No chats yet</b><p>Start a group with your friends to talk calls and plays.</p></div>)}
      {making && <NewGroup onClose={() => setMaking(false)} onMade={(id) => { setMaking(false); nav.openChat(id); }} />}
    </>
  );
}

function FriendPicker({ exclude = [], picked, setPicked }: { exclude?: string[]; picked: string[]; setPicked: (x: string[]) => void }) {
  const [friends, setFriends] = useState<UserSummary[] | null>(null);
  useEffect(() => { api.getFriends().then((f) => setFriends(f.friends), () => setFriends([])); }, []);
  if (!friends) return <div className="loading"><span className="spinner" />Loading friends…</div>;
  const list = friends.filter((f) => !exclude.includes(f.id));
  if (!list.length) return <p className="muted small">{friends.length ? 'All your friends are already here.' : 'Add friends first, from the Friends tab.'}</p>;
  return (
    <ul className="pick-list">
      {list.map((f) => {
        const on = picked.includes(f.id);
        return <li key={f.id}><label className="row gap-s"><input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((x) => x !== f.id) : [...picked, f.id])} /><UserAvatar u={f} size={30} /><b>@{f.username}</b></label></li>;
      })}
    </ul>
  );
}

function NewGroup({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="New group" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2>New group</h2><span className="grow" /><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button></div>
        <label className="field"><span>Group name</span><input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gorilla Gang" /></label>
        <span className="muted small">Add friends</span>
        <FriendPicker picked={picked} setPicked={setPicked} />
        {err && <p className="small warn">{err}</p>}
        <button className="btn btn-accent btn-lg" disabled={!name.trim() || !picked.length || busy} onClick={async () => { setBusy(true); setErr(''); try { const r = await api.createChat(name.trim(), picked); haptic.ok(); onMade(r.id); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>{busy ? 'Creating…' : `Create group${picked.length ? ` with ${picked.length}` : ''}`}</button>
      </div>
    </div>
  );
}

export function ChatRoom({ id }: { id: string }) {
  const nav = useNav();
  const ses = useSession();
  const [chat, setChat] = useState<{ id: string; name: string; members: UserSummary[] } | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [err, setErr] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const lastId = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const load = async (initial = false) => {
    try {
      const d = await api.getMessages(id, initial ? undefined : lastId.current || undefined);
      setChat(d.chat);
      if (d.messages.length) {
        lastId.current = d.messages[d.messages.length - 1].id;
        setMsgs((m) => { const seen = new Set(m.map((x) => x.id)); return [...m, ...d.messages.filter((x) => !seen.has(x.id))]; });
      }
      setErr('');
    } catch (e) { setErr(errMsg(e)); }
  };
  useEffect(() => {
    lastId.current = 0; setMsgs([]); setChat(null);
    load(true).then(refreshCounts);
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 3000);
    return () => clearInterval(t);
  }, [id]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end' }); }, [msgs.length]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try { await api.sendMessage(id, body); setText(''); haptic.tap(); await load(); }
    catch (e2) { nav.toast('down', 'Message not sent', errMsg(e2)); }
    finally { setSending(false); }
  };
  if (err && !chat) return <section className="view"><BackBtn /><div className="empty"><b>Couldn’t open this chat</b><p>{err}</p></div></section>;
  return (
    <section className="view chat-room">
      <BackBtn />
      <header className="row gap-s chat-head">
        <span className="chat-avs">{(chat?.members || []).slice(0, 4).map((m) => <UserAvatar key={m.id} u={m} size={30} />)}</span>
        <div className="stack grow"><h1 className="chat-title">{chat?.name || 'Chat'}</h1><span className="muted small">{chat ? chat.members.map((m) => '@' + m.username).join(', ') : ''}</span></div>
        <button className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}><Icon.plus size={14} /> Add</button>
        {leaving ? <><button className="btn btn-down-solid btn-sm" onClick={async () => { try { await api.leaveChat(id); nav.back(); refreshCounts(); } catch (e) { nav.toast('down', 'Couldn’t leave', errMsg(e)); } }}>Leave</button><button className="btn btn-ghost btn-sm" onClick={() => setLeaving(false)}>Stay</button></>
          : <button className="btn btn-ghost btn-sm" onClick={() => setLeaving(true)}>Leave</button>}
      </header>
      <div className="msgs" aria-live="polite">
        {msgs.map((m) => m.system ? <div key={m.id} className="msg-sys">{m.body}</div> : (
          <div key={m.id} className={`msg ${m.user?.id === ses.user?.id ? 'msg-me' : ''}`}>
            {m.user?.id !== ses.user?.id && <button className="bare" onClick={() => m.user && m.user.username !== 'deleted user' && nav.openUser(m.user.username)}><UserAvatar u={m.user} size={28} /></button>}
            <div className="msg-bubble">
              {m.user?.id !== ses.user?.id && <b className="msg-name">@{m.user?.username}</b>}
              <span className="msg-text">{m.body}</span>
              <span className="msg-time">{new Date(m.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form className="msg-form" onSubmit={send}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder="Message" aria-label="Message" enterKeyHint="send" />
        <button className="btn btn-accent" disabled={!text.trim() || sending}>Send</button>
      </form>
      {adding && chat && <AddMembers chatId={id} members={chat.members.map((m) => m.id)} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </section>
  );
}

function AddMembers({ chatId, members, onClose, onDone }: { chatId: string; members: string[]; onClose: () => void; onDone: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Add to group" onClick={(e) => e.stopPropagation()}>
        <div className="row"><h2>Add friends</h2><span className="grow" /><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon.close /></button></div>
        <FriendPicker exclude={members} picked={picked} setPicked={setPicked} />
        {err && <p className="small warn">{err}</p>}
        <button className="btn btn-accent btn-lg" disabled={!picked.length || busy} onClick={async () => { setBusy(true); try { await api.addMembers(chatId, picked); onDone(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } }}>Add {picked.length || ''}</button>
      </div>
    </div>
  );
}

function FriendsPanel() {
  const nav = useNav();
  const [f, setF] = useState<Awaited<ReturnType<typeof api.getFriends>> | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserSummary[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api.getFriends().then((x) => { setF(x); refreshCounts(); }, (e) => setMsg(errMsg(e)));
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(() => api.searchUsers(s).then((r) => live && setResults(r.users), () => {}), 300);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  const doit = async (key: string, fn: () => Promise<unknown>, note?: string) => { setBusy(key); setMsg(''); try { await fn(); haptic.tap(); if (note) setMsg(note); await load(); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(''); } };
  const known = new Set([...(f?.friends || []), ...(f?.incoming || []), ...(f?.outgoing || [])].map((x) => x.id));
  return (
    <div className="stack gap">
      <div className="panel">
        <h2>Add a friend</h2>
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value.replace(/\s/g, ''))} placeholder="Search usernames" aria-label="Search usernames" autoCapitalize="off" spellCheck={false} />
        {results.length > 0 && (
          <ul className="pick-list">
            {results.map((u) => (
              <li key={u.id} className="row gap-s">
                <button className="bare row gap-s grow" onClick={() => nav.openUser(u.username)}><UserAvatar u={u} size={30} /><b>@{u.username}</b></button>
                {known.has(u.id) ? <span className="muted small">{f?.friends.some((x) => x.id === u.id) ? 'Friends' : 'Pending'}</span>
                  : <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => doit('add' + u.id, () => api.requestFriend(u.username), `Request sent to @${u.username}`)}>Add</button>}
              </li>
            ))}
          </ul>
        )}
        {q.trim().length >= 2 && !results.length && <p className="muted small">No profiles start with “{q.trim()}”.</p>}
        {msg && <p className="small" role="status">{msg}</p>}
      </div>
      {f && f.incoming.length > 0 && (
        <div className="panel">
          <h2>Friend requests · {f.incoming.length}</h2>
          <ul className="pick-list">
            {f.incoming.map((u) => (
              <li key={u.id} className="row gap-s">
                <button className="bare row gap-s grow" onClick={() => nav.openUser(u.username)}><UserAvatar u={u} size={30} /><b>@{u.username}</b></button>
                <button className="btn btn-accent btn-sm" disabled={!!busy} onClick={() => doit('acc' + u.id, () => api.respondFriend(u.id, true))}>Accept</button>
                <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => doit('dec' + u.id, () => api.respondFriend(u.id, false))}>Decline</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="panel">
        <h2>Friends{f ? ` · ${f.friends.length}` : ''}</h2>
        {!f ? <div className="loading"><span className="spinner" />Loading…</div> : f.friends.length ? (
          <ul className="pick-list">{f.friends.map((u) => <li key={u.id}><button className="bare row gap-s full" onClick={() => nav.openUser(u.username)}><UserAvatar u={u} size={30} /><b>@{u.username}</b></button></li>)}</ul>
        ) : <p className="muted small">No friends yet. Search for a username above.</p>}
        {f && f.outgoing.length > 0 && <p className="muted small">Waiting on: {f.outgoing.map((u) => '@' + u.username).join(', ')}</p>}
      </div>
    </div>
  );
}

/** shown only in the test copy */
export function TestCopyNote() {
  const [sure, setSure] = useState(false);
  const d = demo();
  if (!d) return null;
  return (
    <div className="test-copy-note small">
      <b>Test copy.</b> Accounts, chats and the leaderboard are saved only in this browser. To test friends and chats, make a second account: log out, sign up again, then switch back.
      {' '}{sure ? <><button className="link small" onClick={async () => { await d.reset(); location.reload(); }}>Yes, erase test data</button> · <button className="link small" onClick={() => setSure(false)}>Cancel</button></> : <button className="link small" onClick={() => setSure(true)}>Erase test data</button>}
    </div>
  );
}
