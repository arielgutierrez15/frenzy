import { useSyncExternalStore } from 'react';
import type { State } from './types';
import { load, save, freshState, clearSave, discover, refreshPrices, refreshLiveTape, armAlerts, loadSnapshot, leaveSnapshot, PRICE_REFRESH_MS, DISCOVERY_REFRESH_MS, TAPE_REFRESH_MS } from './engine';

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
  try { await fn(); } finally { busy[key] = false; emit(); }
}

export function start() {
  if (started) return;
  started = true;
  (async () => {
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
  setInterval(() => guarded('discovery', async () => { await discover(state); if (state.snapshotAt && anySourceOk()) leaveSnapshot(state); }), DISCOVERY_REFRESH_MS);
  setInterval(() => guarded('tape', () => refreshLiveTape(state, focusCoin)), TAPE_REFRESH_MS);
  // relative times ("12s ago") keep moving between data refreshes
  setInterval(emit, 5000);
  window.addEventListener('beforeunload', () => save(state));
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(state); });
}
