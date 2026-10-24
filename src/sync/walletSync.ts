/**
 * Keeps a signed-in account's paper wallet the same on every device (phone, laptop, every Telegram client).
 *
 * The BAGZ server holds the wallet with a revision number. This device:
 *  - downloads it when signing in, when the app comes back to the screen, and every 15 seconds while open
 *  - uploads within a second or two of any trade, order, deposit, reset, thesis, watchlist or card change
 *  - if another device saved first, merges both (src/sync/merge.ts) and uploads the result, so no trade is lost
 * The last version agreed with the server is kept per account in localStorage, so a change made offline (or in a tab
 * that was closed before it uploaded) is merged in the next time the app opens.
 */
import { ApiErr, apiCall } from '../trading/api';
import { getState, emit, saveNow, setWalletChangeListener } from '../store';
import { docOf, applyDoc, mergeWallets, fingerprint, type WalletDoc } from './merge';

export type SyncStatus = 'off' | 'syncing' | 'synced' | 'offline' | 'error';
interface Meta { rev: number; base: WalletDoc | null }

let userId: string | null = null;
let token: string | null = null;
let meta: Meta = { rev: 0, base: null };
let status: SyncStatus = 'off';
let lastError = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<void> | null = null;
let again = false;
let lastPushAt = 0;
const subs = new Set<() => void>();

export const POLL_MS = 15_000;
const PUSH_DELAY_MS = 800;
/** equity points alone are uploaded at most this often */
const EQUITY_PUSH_MS = 3 * 60_000;

/** current sync state (a plain string, so React can compare snapshots) */
export const syncStatus = (): SyncStatus => status;
export const syncError = () => lastError;
export function onSyncStatus(f: () => void) { subs.add(f); return () => { subs.delete(f); }; }
const setStatus = (s: SyncStatus, err = '') => { status = s; lastError = err; subs.forEach((f) => f()); };

const metaKey = () => `bagz.wsync.${userId}`;
function loadMeta(): Meta {
  try { const m = JSON.parse(localStorage.getItem(metaKey()) || 'null'); if (m && Number.isInteger(m.rev)) return { rev: m.rev, base: m.base || null }; } catch { /* corrupt or blocked */ }
  return { rev: 0, base: null };
}
function saveMeta() { try { localStorage.setItem(metaKey(), JSON.stringify(meta)); } catch { /* storage full: the server copy still has everything */ } }
/** another tab may have synced since this one last looked: always work from the newest agreed version */
function freshestMeta() { const m = loadMeta(); if (m.rev > meta.rev) meta = m; }

const call = <T,>(path: string, body?: unknown) => apiCall<T>(path, { body, token: token || undefined, timeoutMs: 25_000 });

function localDoc(): WalletDoc { return docOf(getState()); }
function adopt(d: WalletDoc) {
  const st = getState();
  if (fingerprint(docOf(st)) === fingerprint(d) && st.user.equity.length >= d.user.equity.length) return;
  applyDoc(st, d);
  saveNow();
  emit();
}

/** download, merge and upload as needed; concurrent calls share one run (and one more runs after it if asked) */
export function syncWallet(): Promise<void> {
  if (running) { again = true; return running; }
  running = (async () => {
    try { do { again = false; await round(); } while (again); } finally { running = null; }
  })();
  return running;
}

async function round() {
  if (!userId || !token) return;
  freshestMeta();
  setStatus('syncing');
  try {
    const got = await call<{ rev: number; wallet?: WalletDoc | null; unchanged?: boolean }>(`/me/wallet?have=${meta.rev}`);
    if (!userId) return;
    if (!got.unchanged && got.rev !== meta.rev) {
      // someone saved since we last agreed (or this is the first sync on this device)
      const theirs = got.wallet || null;
      const mine = localDoc();
      const merged = theirs ? mergeWallets(meta.base, mine, theirs) : mine;
      adopt(merged);
      meta = { rev: got.rev, base: theirs };
      saveMeta();
    }
    await pushIfChanged();
    setStatus('synced');
  } catch (e) {
    if (e instanceof ApiErr && e.status === 401) { setStatus('error', 'Signed out'); return; }
    setStatus(e instanceof ApiErr && e.status === 0 ? 'offline' : 'error', e instanceof Error ? e.message : String(e));
  }
}

async function pushIfChanged() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const mine = localDoc();
    const changed = fingerprint(mine) !== fingerprint(meta.base);
    const equityOnly = !changed && meta.base && mine.user.equity.length !== meta.base.user.equity.length && Date.now() - lastPushAt > EQUITY_PUSH_MS;
    if (meta.rev > 0 && !changed && !equityOnly) return;
    try {
      const r = await call<{ rev: number }>('/me/wallet', { baseRev: meta.rev, wallet: mine });
      meta = { rev: r.rev, base: mine };
      lastPushAt = Date.now();
      saveMeta();
      return;
    } catch (e) {
      if (!(e instanceof ApiErr) || e.status !== 409 || !e.body) throw e;
      // another device saved first: merge its version with ours and try again
      const theirs: WalletDoc | null = e.body.wallet || null;
      adopt(theirs ? mergeWallets(meta.base, localDoc(), theirs) : localDoc());
      meta = { rev: e.body.rev, base: theirs };
      saveMeta();
    }
  }
  throw new Error('The wallet kept changing on another device; will try again');
}

/** called by the store after every save: upload soon if something real changed */
function localChanged() {
  if (!userId) return;
  if (fingerprint(localDoc()) === fingerprint(meta.base)) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; syncWallet(); }, PUSH_DELAY_MS);
}

const onVisible = () => { if (!document.hidden) syncWallet(); };
const onOnline = () => syncWallet();

export function startWalletSync(id: string, sessionToken: string) {
  if (userId === id && token === sessionToken && pollTimer) return;
  stopWalletSync();
  userId = id; token = sessionToken;
  meta = loadMeta();
  setWalletChangeListener(localChanged);
  pollTimer = setInterval(() => { if (!document.hidden) syncWallet(); }, POLL_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('online', onOnline);
  syncWallet();
}

/** upload anything pending right away (used before signing out, so nothing is left only on this device) */
export async function flushWalletSync() { if (userId) { if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; } await syncWallet(); } }

export function stopWalletSync() {
  if (pollTimer) clearInterval(pollTimer);
  if (pushTimer) clearTimeout(pushTimer);
  pollTimer = null; pushTimer = null;
  document.removeEventListener('visibilitychange', onVisible);
  window.removeEventListener('focus', onVisible);
  window.removeEventListener('online', onOnline);
  setWalletChangeListener(null);
  userId = null; token = null; meta = { rev: 0, base: null };
  setStatus('off');
}
