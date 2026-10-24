import { useSyncExternalStore } from 'react';
import type { State } from './types';
import { load, save, freshState, clearSave, setWalletOwner, discover, refreshPrices, refreshLiveTape, armAlerts, loadSnapshot, leaveSnapshot, setBlockedMints, pruneBlocked, PRICE_REFRESH_MS, DISCOVERY_REFRESH_MS, TAPE_REFRESH_MS } from './engine';
import { getBlocklist } from './trading/api';

const anySourceOk = () => Object.values(state.sources).some((s) => s.ok);

let state: State = load();
let version = 0;
const listeners = new Set<() => void>();
let focusCoin: string | undefined;

export function getState() { return state; }

/** Run a mutation against the store and re-render subscribers. */
export function act<T>(fn: (s: State) => T): T {
  const r = fn(state);
  emit();
  save(state);
  return r;
}

export function emit() {
  version++;
  listeners.forEach((l) => l());
}

export function useStore(): State {
  useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => version,
  );
  return state;
}

/** The coin page tells the store which coin is open so it gets refreshed first. */
export function setFocus(id?: string) { focusCoin = id; }

/** switch to an account's own paper wallet (null = the device wallet); live market data is kept */
let owner: string | null = null;
export function switchWallet(userId: string | null) {
  if (userId === owner) return;
  save(state);
  owner = userId;
  setWalletOwner(userId);
  const next = load();
  state.user = next.user;
  state.settings = next.settings;
  for (const [id, c] of Object.entries(next.coins)) if (!state.coins[id]) state.coins[id] = c;
  state.notifs = [];
  emit();
}

export function resetAll() {
  clearSave();
  state = freshState();
  emit();
}

let started = false;
const busy = { prices: false, discovery: false, tape: false };
async function guarded(key: keyof typeof busy, fn: () => Promise<void>) {
  if (busy[key]) return;
  busy[key] = true;
  try { await fn(); } finally { busy[key] = false; pruneBlocked(state); emit(); }
}
/** tokens the BAGZ admins blocked; without a BAGZ server (or if it can't be reached) nothing is hidden */
export async function refreshBlocklist() {
  try { setBlockedMints((await getBlocklist()).mints || []); if (pruneBlocked(state)) emit(); } catch { /* keep the last list */ }
}

export function start() {
  if (started) return;
  started = true;
  (async () => {
    refreshBlocklist(); // not awaited: a slow server never delays the first prices
    await guarded('discovery', () => discover(state));
    await guarded('prices', () => refreshPrices(state, focusCoin));
    // every request failed (e.g. inside a sandbox that blocks outside requests): show the bundled real snapshot
    if (!anySourceOk()) loadSnapshot(state);
    state.loaded = true;
    armAlerts();
    emit();
    await guarded('tape', () => refreshLiveTape(state, focusCoin));
  })();
  setInterval(() => guarded('prices', async () => { await refreshPrices(state, focusCoin); save(state); }), PRICE_REFRESH_MS);
  setInterval(refreshBlocklist, DISCOVERY_REFRESH_MS);
  setInterval(() => guarded('discovery', async () => { await discover(state); if (state.snapshotAt && anySourceOk()) leaveSnapshot(state); }), DISCOVERY_REFRESH_MS);
  setInterval(() => guarded('tape', () => refreshLiveTape(state, focusCoin)), TAPE_REFRESH_MS);
  // relative times ("12s ago") keep moving between data refreshes
  setInterval(emit, 5000);
  window.addEventListener('beforeunload', () => save(state));
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(state); });
}
