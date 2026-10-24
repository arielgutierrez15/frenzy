/**
 * The paper wallet as one document that can be saved on the BAGZ server, and a three-way merge so changes made on two
 * devices (or two tabs) at the same time are all kept.
 *
 * merge(base, mine, theirs):
 *  - base   = the last version both sides agreed on (what this device last saved or downloaded)
 *  - mine   = this device's wallet now
 *  - theirs = the version saved elsewhere in the meantime
 * Lists (trades, orders, theses, cards, watchlist, following) keep everything either side added and drop what either side
 * removed. Cash, deposits and positions are sums, so each side's change since base is added on top of the other's.
 * A trade that both sides made with the same id (an order filled on two devices at once) counts once.
 * A reset or a restored backup starts a new "epoch": the side that did it wins outright.
 */
import type { Coin, Position, State, Trade, UserState } from '../types';

export const DOC_VERSION = 1;
export const MAX_TRADES = 2000;
const MAX_EQUITY = 600;
export const START_CASH_DOC = 10_000;

export interface WalletDoc {
  v: number;
  epoch: string;
  user: UserState;
  settings: State['settings'];
  /** the coins the wallet mentions, so another device can show them before its own data arrives */
  coins: Record<string, Coin>;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const byId = <T extends { id: string }>(xs: T[] | undefined) => new Map((xs || []).map((x) => [x.id, x] as const));

/** equity history thinned to at most MAX_EQUITY points (recent points kept densest) */
export function thinEquity(eq: { t: number; v: number }[]): { t: number; v: number }[] {
  if (eq.length <= MAX_EQUITY) return eq.slice();
  const recent = eq.slice(-Math.floor(MAX_EQUITY / 2));
  const old = eq.slice(0, eq.length - recent.length);
  const step = old.length / (MAX_EQUITY - recent.length);
  const picked: { t: number; v: number }[] = [];
  for (let i = 0; i < old.length; i += step) picked.push(old[Math.floor(i)]);
  return [...picked, ...recent];
}

const COIN_DROP = new Set(['spark', 'header', 'description', 'links', 'sources']);
function liteCoin(c: Coin): Coin {
  const o: any = {};
  for (const [k, v] of Object.entries(c)) if (!COIN_DROP.has(k) && !k.startsWith('_')) o[k] = v;
  return { ...o, spark: [], sources: [], links: [] } as Coin;
}

export function docOf(st: State): WalletDoc {
  const u = st.user;
  const refs = new Set<string>([...Object.keys(u.positions), ...u.orders.map((o) => o.coinId), ...u.trades.slice(0, 400).map((t) => t.coinId), ...u.theses.map((t) => t.coinId), ...(u.watchlist || [])]);
  const coins: Record<string, Coin> = {};
  refs.forEach((id) => { const c = st.coins[id]; if (c) coins[id] = liteCoin(c); });
  return { v: DOC_VERSION, epoch: u.epoch || '', user: clone({ ...u, equity: thinEquity(u.equity) }), settings: { ...st.settings }, coins };
}

/** put a document's wallet into the app state (market data is kept) */
export function applyDoc(st: State, d: WalletDoc) {
  const u: Partial<UserState> = clone(d.user);
  st.user = { ...u, following: u.following || [], theses: u.theses || [], orders: u.orders || [], equity: u.equity || [], epoch: d.epoch || u.epoch } as UserState;
  st.settings = { ...st.settings, ...(d.settings || {}) };
  for (const [id, c] of Object.entries(d.coins || {})) if (!st.coins[id]) st.coins[id] = { ...c, updatedAt: 0, spark: [], sources: c.sources || [], links: c.links || [] };
}

/** what counts as a real change (equity points and peak prices refresh by themselves and are not worth a save) */
export function fingerprint(d: WalletDoc | null): string {
  if (!d) return '';
  const u = d.user;
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return JSON.stringify([
    d.epoch, r(u.cash), r(u.deposits),
    Object.entries(u.positions).map(([k, p]) => [k, r(p.qty), r(p.cost)]).sort(),
    u.trades.map((t) => t.id), u.orders.map((o) => o.id + ':' + o.trigger), u.theses.map((t) => t.id), (u.cards || []).map((c) => c.id),
    u.following, u.watchlist || [], d.settings,
  ]);
}

const isEmpty = (d: WalletDoc) => !d.user.trades.length && !Object.keys(d.user.positions).length && !d.user.orders.length && !d.user.theses.length && !(d.user.cards || []).length && Math.abs(d.user.deposits - START_CASH_DOC) < 1e-6 && Math.abs(d.user.cash - START_CASH_DOC) < 1e-6;

function freshBase(epoch: string): WalletDoc {
  return { v: DOC_VERSION, epoch, user: { cash: START_CASH_DOC, deposits: START_CASH_DOC, positions: {}, trades: [], orders: [], following: [], watchlist: [], theses: [], cards: [], equity: [] }, settings: undefined as any, coins: {} };
}

/** three-way merge of an id-keyed list: theirs, plus what mine added, minus what mine removed */
function mergeList<T extends { id: string }>(base: T[] | undefined, mine: T[] | undefined, theirs: T[] | undefined, pick: (m: T, t: T) => T = (_m, t) => t): T[] {
  const b = byId(base), m = byId(mine), out = new Map<string, T>();
  for (const t of theirs || []) {
    if (b.has(t.id) && !m.has(t.id)) continue; // I removed it
    out.set(t.id, m.has(t.id) ? pick(m.get(t.id)!, t) : t);
  }
  for (const x of mine || []) if (!out.has(x.id) && !b.has(x.id)) out.set(x.id, x); // I added it
  return [...out.values()];
}
function mergeSet(base: string[] | undefined, mine: string[] | undefined, theirs: string[] | undefined): string[] {
  const b = new Set(base || []), m = new Set(mine || []);
  const out: string[] = [];
  for (const x of theirs || []) if (!(b.has(x) && !m.has(x)) && !out.includes(x)) out.push(x);
  for (const x of mine || []) if (!b.has(x) && !out.includes(x)) out.push(x);
  return out;
}

export function mergeWallets(base: WalletDoc | null, mine: WalletDoc | null, theirs: WalletDoc | null): WalletDoc {
  if (!theirs) return clone(mine!);
  if (!mine) return clone(theirs);
  if (!base) {
    // nothing in common yet (first sync on this device)
    if (isEmpty(mine)) return clone(theirs);
    if (isEmpty(theirs)) return clone(mine);
    const tIds = new Set(theirs.user.trades.map((t) => t.id));
    if (mine.user.trades.some((t) => tIds.has(t.id))) {
      // the same wallet seen at two moments: keep the one with more history, merged against nothing removed
      const [big, small] = mine.user.trades.length >= theirs.user.trades.length ? [mine, theirs] : [theirs, mine];
      return mergeWallets(small, big, small);
    }
    // two separate histories (e.g. a phone wallet and a Telegram wallet from before syncing): keep both
    base = freshBase(theirs.epoch);
    if (mine.epoch !== theirs.epoch) mine = { ...mine, epoch: theirs.epoch };
  }
  if (mine.epoch !== base.epoch) return clone(mine); // reset / restored here since the last sync
  if (theirs.epoch !== base.epoch) return clone(theirs); // reset / restored on another device

  const B = base.user, M = mine.user, T = theirs.user;
  const tradeOf = (u: UserState) => byId(u.trades);
  const bT = tradeOf(B), mT = tradeOf(M), tT = tradeOf(T);

  // sums: theirs + my change since base
  let cash = T.cash + (M.cash - B.cash);
  const deposits = T.deposits + (M.deposits - B.deposits);
  const positions: Record<string, Position> = {};
  const ids = new Set([...Object.keys(B.positions), ...Object.keys(M.positions), ...Object.keys(T.positions)]);
  const q = (u: UserState, id: string) => u.positions[id]?.qty || 0, cst = (u: UserState, id: string) => u.positions[id]?.cost || 0;
  const qty: Record<string, number> = {}, cost: Record<string, number> = {};
  for (const id of ids) { qty[id] = q(T, id) + (q(M, id) - q(B, id)); cost[id] = cst(T, id) + (cst(M, id) - cst(B, id)); }

  // a trade both sides added with the same id happened once: take its effect out one time
  for (const [id, tr] of mT) {
    if (bT.has(id) || !tT.has(id)) continue;
    if (tr.side === 'BUY') { cash += tr.usd; qty[tr.coinId] = (qty[tr.coinId] || 0) - tr.qty; cost[tr.coinId] = (cost[tr.coinId] || 0) - tr.usd; }
    else { const part = tr.usd - (tr.pnl ?? 0); cash -= tr.usd; qty[tr.coinId] = (qty[tr.coinId] || 0) + tr.qty; cost[tr.coinId] = (cost[tr.coinId] || 0) + part; }
  }
  for (const id of ids) {
    const scale = Math.max(q(B, id), q(M, id), q(T, id), 1e-300);
    if (!(qty[id] > scale * 1e-9) || !Number.isFinite(qty[id])) continue; // sold out (or dust left by rounding)
    const opened = [B, M, T].map((u) => u.positions[id]?.openedAt).filter((x): x is number => !!x);
    positions[id] = { coinId: id, qty: qty[id], cost: Math.max(0, cost[id]), openedAt: opened.length ? Math.min(...opened) : Date.now() };
  }

  const trades = mergeList<Trade>(B.trades, M.trades, T.trades, (m, t) => ({ ...t, ...(m.peakAfter !== undefined || t.peakAfter !== undefined ? { peakAfter: Math.max(m.peakAfter ?? 0, t.peakAfter ?? 0) } : {}) }))
    .sort((a, b) => b.t - a.t).slice(0, MAX_TRADES);
  const orders = mergeList(B.orders, M.orders, T.orders).filter((o) => o.side === 'BUY' || positions[o.coinId]);
  const theses = mergeList(B.theses, M.theses, T.theses).sort((a, b) => b.t - a.t);
  const cards = mergeList(B.cards, M.cards, T.cards).sort((a, b) => b.t - a.t);
  const eqMap = new Map<number, number>();
  for (const p of [...T.equity, ...M.equity]) eqMap.set(p.t, p.v);
  const equity = thinEquity([...eqMap.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ t, v })));
  const settings = JSON.stringify(mine.settings) !== JSON.stringify(base.settings) && mine.settings ? mine.settings : theirs.settings;

  return {
    v: DOC_VERSION, epoch: theirs.epoch, settings: clone(settings || mine.settings),
    coins: { ...theirs.coins, ...mine.coins },
    user: {
      ...clone(T), cash, deposits, positions, trades: clone(trades), orders: clone(orders), theses: clone(theses), cards: clone(cards), equity,
      following: mergeSet(B.following, M.following, T.following), watchlist: mergeSet(B.watchlist, M.watchlist, T.watchlist), epoch: theirs.epoch,
    },
  };
}
