/**
 * Who is signed in, and keeping their public profile in sync.
 *
 * status:
 *  - checking     – looking for a saved session / asking the server
 *  - unavailable  – no BAGZ server on this page (or it has no database): the app runs without accounts
 *  - signed-out   – first visit or logged out: the sign-up screen is shown before the app
 *  - incomplete   – account exists but has no picture yet: the picture step is shown
 *  - ready        – signed in with a public profile
 *
 * The session token is kept in localStorage and, inside Telegram, also in Telegram Cloud Storage (Telegram can clear a
 * Mini App's localStorage). The password is never stored.
 */
import { useSyncExternalStore } from 'react';
import { apiBase } from '../trading/api';
import { getServerConfig, ApiErr } from '../trading/api';
import { tgCloud } from '../telegram';
import { getState, switchWallet } from '../store';
import { userStats } from '../engine';
import * as api from './api';
import type { Me } from './api';

export type Status = 'checking' | 'unavailable' | 'signed-out' | 'incomplete' | 'ready';
interface Session { status: Status; user: Me | null; token: string | null; note: string }
const KEY = 'bagz.session';
let s: Session = { status: 'checking', user: null, token: null, note: '' };
const subs = new Set<() => void>();
const set = (p: Partial<Session>) => { s = { ...s, ...p }; subs.forEach((f) => f()); };
export const getSession = () => s;
export const useSession = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, getSession, getSession);

const readLocal = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
const writeLocal = (v: string | null) => { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } };

const fetchMe = (token: string) => api.fetchMe(token);

let started = false;
export async function initSession() {
  if (started) return;
  started = true;
  if (!apiBase()) { set({ status: 'unavailable', note: 'no-server' }); return; }
  try {
    const cfg = await getServerConfig();
    if (!(cfg as any).accounts) { set({ status: 'unavailable', note: 'no-database' }); return; }
  } catch { set({ status: 'unavailable', note: 'unreachable' }); return; }
  const token = readLocal() || (await tgCloud.get(KEY));
  if (!token) { set({ status: 'signed-out' }); return; }
  try {
    const { user } = await fetchMe(token);
    signedIn(token, user);
  } catch (e) {
    if (e instanceof ApiErr && e.status === 401) { forget(); set({ status: 'signed-out' }); }
    // server trouble: let them in without social features rather than locking them out
    else set({ status: 'unavailable', note: 'unreachable' });
  }
}
export function signedIn(token: string, user: Me) {
  switchWallet(user.id);
  writeLocal(token);
  tgCloud.set(KEY, token);
  set({ token, user, status: user.complete ? 'ready' : 'incomplete' });
  if (user.complete) startSync();
}
export function updateMe(user: Me) { set({ user, status: user.complete ? 'ready' : 'incomplete' }); if (user.complete) startSync(); }
function forget() { writeLocal(null); tgCloud.remove(KEY); }
export async function logout() {
  try { await api.logoutApi(); } catch { /* already gone */ }
  forget(); stopSync(); switchWallet(null);
  set({ status: 'signed-out', token: null, user: null });
}
export function accountDeleted() { forget(); stopSync(); switchWallet(null); set({ status: 'signed-out', token: null, user: null }); }

// ---- keeping the public profile in sync with the paper wallet ---------------------------------------------------------
let timer: ReturnType<typeof setInterval> | null = null;
let lastStats = '';
const postedKey = () => `bagz.social.posted.${s.user?.id}`;
function posted(): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(postedKey()) || '[]')); } catch { return new Set(); } }
function savePosted(x: Set<string>) { try { localStorage.setItem(postedKey(), JSON.stringify([...x].slice(-800))); } catch { /* ignore */ } }

let running: Promise<void> | null = null;
/** pushes stats and new trades/theses; concurrent calls share one run */
export function syncNow(): Promise<void> {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}
async function doSync() {
  if (s.status !== 'ready' || !s.token) return;
  const st = getState();
  const u = userStats(st);
  const sells = st.user.trades.filter((t) => t.side === 'SELL' && t.pnl !== undefined && t.usd - t.pnl! > 0);
  const best = sells.map((t) => ({ symbol: t.symbol, pct: (t.pnl! / (t.usd - t.pnl!)) * 100 })).sort((a, b) => b.pct - a.pct)[0] || null;
  const body = { equity: Math.round(u.equity * 100) / 100, deposits: st.user.deposits, realized: Math.round(u.realized * 100) / 100, winRate: Math.round(u.winRate * 10) / 10, sells: u.sells, trades: st.user.trades.length, best };
  const key = JSON.stringify(body);
  try { if (key !== lastStats) { await api.putStats(body); lastStats = key; } } catch { /* next round */ }
  // trades and theses from the last 30 days that the server hasn't seen yet
  const done = posted();
  const month = Date.now() - 29 * 86_400_000;
  const mintOf = (coinId: string) => coinId.split(':')[1] || '';
  const items: any[] = [];
  for (const t of st.user.trades) {
    if (t.t < month || done.has(t.id) || !mintOf(t.coinId)) continue;
    items.push({ id: t.id, kind: 'trade', side: t.side, mint: mintOf(t.coinId), symbol: t.symbol, usd: t.usd, price: t.price, ...(t.pnl !== undefined ? { pnl: t.pnl } : {}), t: t.t });
  }
  for (const th of st.user.theses) {
    if (th.t < month || done.has(th.id) || !mintOf(th.coinId)) continue;
    items.push({ id: th.id, kind: 'thesis', mint: mintOf(th.coinId), symbol: st.coins[th.coinId]?.symbol || '?', bull: th.bull, text: th.text, t: th.t });
  }
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    try { await api.putActivity(chunk); chunk.forEach((x) => done.add(x.id)); savePosted(done); } catch { break; }
  }
}
function startSync() {
  if (timer) return;
  syncNow();
  timer = setInterval(syncNow, 20_000);
}
function stopSync() { if (timer) clearInterval(timer); timer = null; lastStats = ''; }

/** tests only */
export function __resetSession() { stopSync(); started = false; s = { status: 'checking', user: null, token: null, note: '' }; }
