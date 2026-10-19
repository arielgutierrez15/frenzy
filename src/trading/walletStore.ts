/**
 * One shared wallet connection for the whole app (live swap, Boost, admin, balances).
 * Follows account switches and disconnects made inside the wallet. Only the public address is kept, in memory.
 */
import { useSyncExternalStore } from 'react';
import { startWalletDiscovery, subscribeWallets, solanaWallets, connectWallet, disconnectWallet, onWalletChange, type Connected, type StdWallet } from './wallet';

interface WalletState { conn: Connected | null; connecting: string | null; error: string; wallets: StdWallet[]; changedAt: number }
let state: WalletState = { conn: null, connecting: null, error: '', wallets: [], changedAt: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<WalletState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
let offChange: (() => void) | null = null;
let started = false;

export function initWallets() {
  if (started) return;
  started = true;
  subscribeWallets(() => set({ wallets: solanaWallets() }));
  startWalletDiscovery();
  set({ wallets: solanaWallets() });
}
export const getWalletState = () => state;
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useWallet() {
  initWallets();
  return useSyncExternalStore(subscribe, getWalletState, getWalletState);
}

export async function connect(w: StdWallet) {
  if (state.connecting) return;
  set({ connecting: w.name, error: '' });
  try {
    const conn = await connectWallet(w);
    offChange?.();
    offChange = onWalletChange(w, (accounts) => {
      if (!state.conn || state.conn.wallet !== w) return;
      if (!accounts || !accounts.length) { offChange?.(); offChange = null; set({ conn: null, changedAt: Date.now(), error: 'The wallet disconnected.' }); return; }
      if (accounts[0].address !== state.conn.account.address) set({ conn: { wallet: w, account: accounts[0] }, changedAt: Date.now() });
    });
    set({ conn, connecting: null, changedAt: Date.now() });
  } catch (e: any) {
    set({ connecting: null, error: e?.message || 'Couldn’t connect' });
  }
}
export async function disconnect() {
  const c = state.conn;
  offChange?.(); offChange = null;
  set({ conn: null, changedAt: Date.now(), error: '' });
  if (c) await disconnectWallet(c.wallet);
}
/** tests only */
export function __resetWalletStore() { offChange?.(); offChange = null; state = { conn: null, connecting: null, error: '', wallets: [], changedAt: 0 }; started = false; }

// ---- phones ------------------------------------------------------------------------------------------------------------
export const isMobile = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
/**
 * On a phone browser no wallet extension can inject itself; the page has to open inside the wallet app's own browser.
 * Formats from docs.phantom.com/phantom-deeplinks/other-methods/browse and docs.solflare.com (…/deeplinks/other-methods/browse).
 */
export function walletBrowseLinks(pageUrl: string): { name: string; url: string }[] {
  let origin = pageUrl;
  try { origin = new URL(pageUrl).origin; } catch { /* keep */ }
  const u = encodeURIComponent(pageUrl), r = encodeURIComponent(origin);
  return [
    { name: 'Phantom', url: `https://phantom.com/ul/browse/${u}?ref=${r}` },
    { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${u}?ref=${r}` },
  ];
}
