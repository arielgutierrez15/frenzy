import type {
  Audit, Chain, ChainTrade, Coin, Notif, Order, Side, SourceId, SourceStatus, State, Trade, WalletSeen,
} from './types';
import { MAJORS, NARRATIVES } from './seed';
import { SNAPSHOT_AT, JUPITER as SNAP_JUP, PUMP_LIVE as SNAP_PUMP, DEXSCREENER as SNAP_DS, BOOSTS as SNAP_BOOSTS } from './snapshot';
import { compact, pct, price as fmtPrice } from './format';
import { request, queueDepth } from './providers/http';
import { SOURCE_LABELS as LABELS, type SourceId as ProviderSource } from './providers/registry';
import {
  parseJupiterTokens, parseJupiterPrice, parseDexProfiles, parseDexPairs, parseGtPools, parseGtTrades as parseGtTradeRows,
  parsePumpCoins, parseRugSummary, parseRpc, type PumpCoin,
} from './providers/adapters';

export const START_CASH = 10_000;
export const FEE_RATE = 0.005; // 0.5% simulated swap fee on paper trades
export const PRICE_REFRESH_MS = 20_000;
export const DISCOVERY_REFRESH_MS = 60_000;
export const TAPE_REFRESH_MS = 45_000;
const STALE_MS = 60_000; // paper trades only fill on a price fetched in the last minute
const STORAGE_KEY = 'frenzy.live.v1'; // key kept from the Frenzy era so existing paper wallets survive the BAGZ rename
const STATE_VERSION = 10;

let idSeq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export const mcapOf = (c: Coin) => c.mcap;
export const change24 = (c: Coin) => c.change.h24 ?? 0;
export const keyOf = (chain: Chain, address: string) => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
const num = (x: unknown): number | undefined => { const n = typeof x === 'string' ? parseFloat(x) : typeof x === 'number' ? x : NaN; return isFinite(n) ? n : undefined; };
const DS_CHAIN: Record<string, Chain> = { solana: 'solana', ethereum: 'ethereum', base: 'base', bsc: 'bsc' };
const GT_NET: Record<Chain, string> = { solana: 'solana', ethereum: 'eth', base: 'base', bsc: 'bsc' };
const GT_TO_CHAIN: Record<string, Chain> = { solana: 'solana', eth: 'ethereum', base: 'base', bsc: 'bsc' };

// ======================================================================
// sources
// ======================================================================
export const SOURCE_LABELS = LABELS;

interface CallOpts<T> { method?: 'GET' | 'POST'; body?: unknown; prio?: 0 | 1 | 2; force?: boolean; ttlMs?: number; validate?: (j: unknown) => T }
/**
 * One provider call through the shared HTTP core (cache, de-dupe, rate limit, retry, validation).
 * Updates the visible source status with the real fetch time, so "updated Ns ago" is the provider's data age.
 */
export async function getJSON<T = any>(st: State, id: ProviderSource, path: string, o: CallOpts<T> = {}): Promise<T | undefined> {
  const s = (st.sources[id] ||= { id, label: SOURCE_LABELS[id], ok: null });
  const r = await request<T>({ source: id, path, ...o });
  if (r.ok) {
    s.ok = true; s.at = r.fetchedAt; s.error = undefined; s.stale = r.stale; s.via = r.via; s.ms = r.ms || s.ms;
    return r.data;
  }
  s.ok = false; s.at = Date.now(); s.stale = false; s.kind = r.error.kind;
  s.error = r.error.message;
  return undefined;
}
function countSource(st: State, id: SourceStatus['id'], n: number) {
  const s = st.sources[id];
  if (s) s.count = n;
}

// ======================================================================
// coin merge
// ======================================================================
type Patch = Partial<Omit<Coin, 'id' | 'chain' | 'address' | 'sources' | 'audit' | 'change'>> & {
  chain: Chain; address: string; audit?: Audit; change?: Coin['change'];
};

function upsert(st: State, p: Patch, source?: SourceId): Coin {
  const id = keyOf(p.chain, p.address);
  const now = Date.now();
  let c = st.coins[id];
  if (!c) {
    c = st.coins[id] = {
      id, chain: p.chain, address: p.address, symbol: p.symbol || '???', name: p.name || p.symbol || 'Unknown', price: 0,
      change: {}, mcap: 0, liq: 0, vol24: 0, audit: {}, socials: 0, links: [], sources: [], spark: [], peakPrice: 0, peakLiq: 0,
      firstSeen: now, updatedAt: 0,
    };
  }
  const { audit, change, chain: _c, address: _a, links, ...rest } = p;
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' && !isFinite(v)) continue;
    (c as any)[k] = v;
  }
  if (p.symbol) c.symbol = p.symbol.replace(/^\$/, '');
  if (audit) for (const [k, v] of Object.entries(audit)) if (v !== undefined) (c.audit as any)[k] = v;
  if (change) for (const [k, v] of Object.entries(change)) if (v !== undefined && isFinite(v as number)) (c.change as any)[k] = v;
  if (links && links.length) {
    c.links = links;
    c.socials = Math.max(c.socials, links.length);
  }
  if (source && !c.sources.includes(source)) c.sources.push(source);
  return c;
}

function recordPrice(st: State, c: Coin, price: number, liq: number, at = Date.now()) {
  const now = Date.now();
  c.price = price;
  c.updatedAt = at; // when the provider produced this price, so cached answers never look fresher than they are
  const last = c.spark[c.spark.length - 1];
  if (!last || at - last.t > 5000) c.spark.push({ t: at, p: price });
  if (c.spark.length > 180) c.spark.splice(0, c.spark.length - 180);
  if (price > c.peakPrice) c.peakPrice = price;
  if (liq > c.peakLiq) c.peakLiq = liq;
  if (!c.rugged && !st.majors.includes(c.id)) {
    const pulled = c.peakLiq >= 5_000 && liq > 0 && liq < c.peakLiq * 0.12;
    const crashed = c.peakPrice > 0 && price < c.peakPrice * 0.1 && c.spark.length > 3;
    if (pulled || crashed) {
      c.rugged = pulled ? 'liquidity' : 'crash';
      const held = st.user.positions[c.id];
      if (held) notify(st, { tone: 'down', title: `$${c.symbol} ${pulled ? 'lost its liquidity' : 'crashed 90%'}`, body: `Your bag is ${pct((held.qty * price / held.cost - 1) * 100, 0)}. Selling now returns very little.`, coinId: c.id });
    }
  }
}

// ======================================================================
// Gem score from real signals
// ======================================================================
export interface ScoreResult { score: number; risk: 'low' | 'medium' | 'high'; reasons: string[]; known: number; total: number }

export function scoreCoin(c: Coin): ScoreResult {
  const a = c.audit;
  // base 35: a coin has to pass most checks to reach the 80s, so 99 stays rare and the ranking means something
  let s = 35, known = 0;
  const total = 9;
  const reasons: string[] = [];
  let red = 0;
  if (a.mintRevoked !== undefined) { known++; s += a.mintRevoked ? 10 : -20; if (!a.mintRevoked) { reasons.push('Mint authority live'); red++; } }
  if (a.freezeRevoked !== undefined) { known++; s += a.freezeRevoked ? 5 : -10; if (!a.freezeRevoked) { reasons.push('Freeze authority live'); red++; } }
  if (a.topHolders !== undefined) {
    known++;
    if (a.topHolders > 60) { s -= 14; reasons.push(`Top holders own ${a.topHolders.toFixed(0)}%`); red++; } else if (a.topHolders > 40) s -= 6; else if (a.topHolders < 25) s += 6;
  }
  if (a.devPct !== undefined) {
    known++;
    if (a.devPct > 10) { s -= 14; reasons.push(`Dev holds ${a.devPct.toFixed(1)}%`); red++; } else if (a.devPct > 5) s -= 5; else if (a.devPct < 1) s += 4;
  }
  if (a.devMints !== undefined) { known++; if (a.devMints > 20) { s -= 8; reasons.push(`Deployer launched ${a.devMints} coins`); } }
  if (c.holders !== undefined) { known++; s += c.holders < 50 ? -8 : c.holders > 2000 ? 10 : c.holders > 500 ? 6 : 0; }
  if (c.liq > 0) { known++; if (c.liq < 5_000) { s -= 10; reasons.push(`Only ${compact(c.liq)} liquidity`); red++; } else if (c.liq > 50_000) s += 6; }
  known++; // socials always known (0 if none reported)
  s += c.socials === 0 ? -6 : c.socials >= 2 ? 5 : 0;
  if (c.socials === 0) reasons.push('No socials listed');
  if (c.organic) { known++; s += c.organic.label === 'high' ? 10 : c.organic.label === 'medium' ? 4 : -4; }
  if (c.buys24 !== undefined && c.sells24 !== undefined && c.buys24 + c.sells24 > 20) s += c.buys24 > c.sells24 * 1.2 ? 4 : c.sells24 > c.buys24 * 1.5 ? -6 : 0;
  const listed = c.sources.filter((x) => x !== 'major').length;
  s += Math.min(9, Math.max(0, listed - 1) * 3);
  if (c.rugged) { s = 0; reasons.unshift(c.rugged === 'liquidity' ? 'Liquidity pulled' : 'Crashed 90% from peak'); red += 2; }
  const score = Math.round(Math.max(0, Math.min(99, s)));
  const risk = red >= 2 ? 'high' : red === 1 ? 'medium' : 'low';
  return { score, risk, reasons, known, total };
}

// ======================================================================
// categories built from the combined sources
// ======================================================================
export const CATEGORIES: { id: string; label: string }[] = [
  { id: 'hot', label: 'Hot on 2+ sites' },
  { id: 'new', label: 'New (24h)' },
  { id: 'pumpfun', label: 'pump.fun' },
  { id: 'live', label: 'Live on pump.fun' },
  { id: 'graduated', label: 'Graduated' },
  { id: 'traded', label: 'Most traded' },
  { id: 'boosted', label: 'Boosted' },
  { id: 'organic', label: 'Organic flow' },
  ...NARRATIVES.map((n) => ({ id: n.id, label: n.label })),
  { id: 'blue', label: 'Blue chips' },
];

const TRENDING_SOURCES: SourceId[] = ['ds-boosts', 'jup-trending', 'jup-organic', 'jup-traded', 'gt-trending', 'pump-live'];

/** Stablecoins, wrapped majors, LSTs and tokenized stocks show up in the trending feeds but aren't memecoins. */
const NOT_MEME_TAGS = ['stable', 'lst', 'xstocks', 'stocks', 'rwa', 'equities', 'defi', 'infra', 'major', 'backpack'];
const NOT_MEME_ADDRESSES = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '0x4200000000000000000000000000000000000006', // WETH on Base
  '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
]);
function notMeme(st: State, chain: Chain, address: string, tags?: unknown): boolean {
  if (st.majors.includes(keyOf(chain, address))) return false;
  if (NOT_MEME_ADDRESSES.has(address)) return true;
  return Array.isArray(tags) && tags.some((t) => NOT_MEME_TAGS.includes(String(t)));
}

export function isPumpFun(c: Coin) {
  return c.launchpad === 'pump.fun' || !!c.dexId?.startsWith('pump') || (c.chain === 'solana' && c.address.endsWith('pump'));
}

export function categoriesOf(st: State, c: Coin): string[] {
  const out: string[] = [];
  if (c.sources.filter((s) => TRENDING_SOURCES.includes(s)).length >= 2) out.push('hot');
  if (c.createdAt && Date.now() - c.createdAt < 864e5) out.push('new');
  if (isPumpFun(c)) {
    out.push('pumpfun');
    // pump.fun's own flag wins; the DEX name is only a fallback for coins pump.fun didn't report
    if (c.pumpComplete ?? (!!c.dexId && c.dexId !== 'pumpfun')) out.push('graduated');
  }
  if (c.pumpLive) out.push('live');
  if (c.sources.includes('jup-traded')) out.push('traded');
  if (c.sources.includes('ds-boosts') || (c.boost ?? 0) > 0) out.push('boosted');
  if (c.organic && c.organic.label !== 'low') out.push('organic');
  const text = `${c.name} ${c.symbol} ${c.description || ''}`;
  for (const n of NARRATIVES) if (n.re.test(text)) out.push(n.id);
  if (st.majors.includes(c.id)) out.push('blue');
  return out;
}

export const SOURCE_SHORT: Record<SourceId, string> = {
  'ds-profiles': 'DexScreener', 'ds-boosts': 'DS boost', 'jup-recent': 'Jupiter', 'jup-trending': 'Jup trending', 'jup-organic': 'Jup organic',
  'jup-traded': 'Jup most traded', 'gt-new': 'GeckoTerminal', 'gt-trending': 'GT trending', pumpfun: 'pump.fun', 'pump-live': 'pump.fun live', major: 'Blue chip',
};

// ======================================================================
// fetchers
// ======================================================================
function linksFrom(arr: any[] | undefined): { type: string; url: string }[] {
  if (!Array.isArray(arr)) return [];
  return arr.filter((l) => l && typeof l.url === 'string').map((l) => ({ type: String(l.type || l.label || 'website').toLowerCase(), url: l.url }));
}

async function fetchDsProfiles(st: State) {
  const j = await getJSON(st, 'ds-profiles', '/token-profiles/latest/v1', { validate: parseDexProfiles, prio: 2 });
  if (!Array.isArray(j)) return;
  let n = 0;
  for (const t of j) {
    const chain = DS_CHAIN[t.chainId];
    if (!chain || !t.tokenAddress) continue;
    upsert(st, { chain, address: t.tokenAddress, description: t.description, icon: typeof t.icon === 'string' && t.icon.startsWith('http') ? t.icon : undefined, header: typeof t.header === 'string' && t.header.startsWith('http') ? t.header : undefined, links: linksFrom(t.links) }, 'ds-profiles');
    n++;
  }
  countSource(st, 'ds-profiles', n);
}

async function fetchDsBoosts(st: State) {
  const j = await getJSON(st, 'ds-boosts', '/token-boosts/top/v1', { validate: parseDexProfiles, prio: 2 });
  if (!Array.isArray(j)) return;
  let n = 0;
  for (const t of j) {
    const chain = DS_CHAIN[t.chainId];
    if (!chain || !t.tokenAddress) continue;
    upsert(st, { chain, address: t.tokenAddress, description: t.description, boost: num(t.totalAmount) ?? num(t.amount), links: linksFrom(t.links) }, 'ds-boosts');
    n++;
  }
  countSource(st, 'ds-boosts', n);
}

function fromJupiter(st: State, t: any, source?: SourceId, at = Date.now()) {
  if (!t?.id || notMeme(st, 'solana', t.id, t.tags)) return;
  const s24 = t.stats24h || {}, s1 = t.stats1h || {}, s5 = t.stats5m || {}, s6 = t.stats6h || {};
  const a = t.audit || {};
  const links: { type: string; url: string }[] = [];
  for (const k of ['website', 'twitter', 'telegram']) if (typeof t[k] === 'string' && t[k]) links.push({ type: k, url: t[k] });
  const c = upsert(st, {
    chain: 'solana', address: t.id, symbol: t.symbol, name: t.name, icon: t.icon, decimals: num(t.decimals), launchpad: t.launchpad,
    mcap: num(t.mcap) ?? num(t.fdv), liq: num(t.liquidity), holders: num(t.holderCount),
    vol24: (num(s24.buyVolume) ?? 0) + (num(s24.sellVolume) ?? 0) || undefined,
    vol1h: (num(s1.buyVolume) ?? 0) + (num(s1.sellVolume) ?? 0) || undefined,
    buys24: num(s24.numBuys), sells24: num(s24.numSells),
    change: { m5: num(s5.priceChange), h1: num(s1.priceChange), h6: num(s6.priceChange), h24: num(s24.priceChange) },
    organic: num(t.organicScore) !== undefined ? { score: num(t.organicScore)!, label: String(t.organicScoreLabel || 'low') } : undefined,
    audit: { mintRevoked: a.mintAuthorityDisabled, freezeRevoked: a.freezeAuthorityDisabled, topHolders: num(a.topHoldersPercentage), devPct: num(a.devBalancePercentage), devMints: num(a.devMints) },
    createdAt: Date.parse(t.firstPool?.createdAt || t.createdAt) || undefined,
    links: links.length ? links : undefined,
  }, source);
  const p = num(t.usdPrice);
  if (p && p > 0) recordPrice(st, c, p, c.liq, at);
}

async function fetchJupiter(st: State, id: 'jup-recent' | 'jup-trending' | 'jup-organic' | 'jup-traded', path: string) {
  const j = await getJSON(st, id, `/tokens/v2/${path}`, { validate: parseJupiterTokens, prio: 2 });
  if (!Array.isArray(j)) return;
  const at = st.sources[id]?.at;
  j.forEach((t) => fromJupiter(st, t, id, at));
  countSource(st, id, j.length);
}

function fromGtPool(st: State, pool: any, included: Map<string, any>, source: SourceId, fetchedAt = Date.now()) {
  const at = pool?.attributes || {};
  const net = String(pool?.id || '').split('_')[0];
  const chain = GT_TO_CHAIN[net];
  const baseId = pool?.relationships?.base_token?.data?.id as string | undefined;
  if (!chain || !baseId) return;
  const address = baseId.slice(baseId.indexOf('_') + 1);
  if (notMeme(st, chain, address)) return;
  const tok = included.get(baseId)?.attributes || {};
  const tx24 = at.transactions?.h24 || {};
  const c = upsert(st, {
    chain, address, symbol: tok.symbol || String(at.name || '').split(' / ')[0], name: tok.name, icon: tok.image_url && tok.image_url !== 'missing.png' ? tok.image_url : undefined,
    mcap: num(at.market_cap_usd) ?? num(at.fdv_usd), liq: num(at.reserve_in_usd), vol24: num(at.volume_usd?.h24), vol1h: num(at.volume_usd?.h1),
    buys24: num(tx24.buys), sells24: num(tx24.sells),
    change: { m5: num(at.price_change_percentage?.m5), h1: num(at.price_change_percentage?.h1), h6: num(at.price_change_percentage?.h6), h24: num(at.price_change_percentage?.h24) },
    dexId: pool?.relationships?.dex?.data?.id?.replace('pump-fun', 'pumpfun'), pairAddress: at.address,
    createdAt: Date.parse(at.pool_created_at) || undefined,
  }, source);
  const p = num(at.base_token_price_usd);
  if (p && p > 0) recordPrice(st, c, p, c.liq, fetchedAt);
}

async function fetchGt(st: State, id: 'gt-new' | 'gt-trending', path: string) {
  const j = await getJSON(st, id, `/${path}${path.includes('?') ? '&' : '?'}include=base_token`, { validate: parseGtPools, prio: 2 });
  if (!j) return;
  const included = new Map<string, any>(j.included.map((x: any) => [x.id, x]));
  const fetchedAt = st.sources[id]?.at;
  j.data.forEach((p: any) => fromGtPool(st, p, included, id, fetchedAt));
  countSource(st, id, (st.sources[id]?.count || 0) + j.data.length);
}

/** pump.fun coins all have a 1,000,000,000 token supply, so price = USD market cap / 1e9. */
const PUMP_SUPPLY = 1_000_000_000;

function fromPumpFun(st: State, t: PumpCoin, source: 'pumpfun' | 'pump-live', at = Date.now()) {
  const links = [['website', t.website], ['twitter', t.twitter], ['telegram', t.telegram]].filter(([, u]) => typeof u === 'string' && u).map(([type, url]) => ({ type: type as string, url: url as string }));
  const c = upsert(st, {
    chain: 'solana', address: t.mint, symbol: t.symbol, name: t.name, description: t.description, icon: t.image, launchpad: 'pump.fun',
    mcap: t.marketCapUsd, createdAt: t.createdAtMs, links: links.length ? links : undefined,
    liq: t.liquidityUsd,
    pumpComplete: t.complete,
    pumpLive: t.isLive !== undefined ? t.isLive : source === 'pump-live' ? true : undefined,
  }, source);
  // pump.fun reports market cap, not price; use it only until DexScreener prices the pair
  const mc = t.marketCapUsd;
  if (mc && mc > 0 && !(c.updatedAt && Date.now() - c.updatedAt < STALE_MS)) recordPrice(st, c, mc / PUMP_SUPPLY, c.liq, at);
}

async function fetchPumpFun(st: State) {
  const j = await getJSON(st, 'pumpfun', '/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false', { validate: parsePumpCoins, prio: 2 });
  if (!j) return;
  const at = st.sources.pumpfun?.at;
  j.forEach((t) => fromPumpFun(st, t, 'pumpfun', at));
  countSource(st, 'pumpfun', j.length);
}

async function fetchPumpLive(st: State) {
  const j = await getJSON(st, 'pump-live', '/coins/currently-live?limit=50&offset=0&includeNsfw=false', { validate: parsePumpCoins, prio: 2 });
  if (!j) return;
  // coins that stopped streaming drop out of the live category
  const live = new Set(j.map((t) => t.mint));
  for (const c of Object.values(st.coins)) if (c.pumpLive && !live.has(c.address)) c.pumpLive = false;
  const at = st.sources['pump-live']?.at;
  j.forEach((t) => fromPumpFun(st, t, 'pump-live', at));
  countSource(st, 'pump-live', j.length);
}

/** Batch price refresh from DexScreener for the coins on screen, in positions, or on the radar. */
async function refreshPairs(st: State, ids: string[], o: { force?: boolean; prio?: 0 | 1 | 2 } = {}) {
  const byChain: Record<string, string[]> = {};
  for (const id of ids) {
    const c = st.coins[id];
    if (!c) continue;
    (byChain[c.chain] ||= []).push(c.address);
  }
  let n = 0;
  for (const [chain, addrs] of Object.entries(byChain)) {
    for (let i = 0; i < addrs.length; i += 30) {
      const j = await getJSON(st, 'ds-pairs', `/tokens/v1/${chain}/${addrs.slice(i, i + 30).join(',')}`, { validate: parseDexPairs, prio: o.prio ?? 1, force: o.force });
      if (!j) continue;
      const fetchedAt = st.sources['ds-pairs']?.at ?? Date.now();
      const best: Record<string, any> = {};
      for (const p of j) {
        const a = p?.baseToken?.address;
        if (!a) continue;
        const k = keyOf(chain as Chain, a);
        if (!best[k] || (num(p.liquidity?.usd) ?? 0) > (num(best[k].liquidity?.usd) ?? 0)) best[k] = p;
      }
      for (const [k, p] of Object.entries(best)) {
        const c = st.coins[k];
        if (!c) continue;
        const links = [...(p.info?.websites || []).map((w: any) => ({ type: 'website', url: w.url })), ...linksFrom(p.info?.socials)];
        upsert(st, {
          chain: c.chain, address: c.address, symbol: p.baseToken.symbol, name: p.baseToken.name, icon: p.info?.imageUrl, header: p.info?.header,
          mcap: num(p.marketCap) ?? num(p.fdv), liq: num(p.liquidity?.usd), vol24: num(p.volume?.h24), vol1h: num(p.volume?.h1),
          buys24: num(p.txns?.h24?.buys), sells24: num(p.txns?.h24?.sells),
          change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
          dexId: p.dexId, pairAddress: p.pairAddress, createdAt: c.createdAt ?? num(p.pairCreatedAt), links: links.length ? links : undefined,
        });
        const price = num(p.priceUsd);
        if (price && price > 0) { recordPrice(st, c, price, num(p.liquidity?.usd) ?? c.liq, fetchedAt); n++; }
      }
    }
  }
  if (st.sources['ds-pairs']) st.sources['ds-pairs'].count = n;
}

// ======================================================================
// on-demand coin detail: candles, trades, holders
// ======================================================================
export interface RugReport { score?: number; risks: { name: string; level: string; description?: string }[] }
export const detail: Record<string, {
  trades?: ChainTrade[]; tradesAt?: number; holders?: { address: string; pct: number }[]; holdersAt?: number; holdersError?: string;
  poolTried?: boolean; detailsAt?: number; rug?: RugReport; rugError?: string;
}> = {};

/** Coins found on pump.fun or Jupiter may not have a DexScreener pair yet: ask GeckoTerminal for the token's busiest pool. */
export async function ensurePool(st: State, c: Coin) {
  if (c.pairAddress) return;
  const d = (detail[c.id] ||= {});
  if (d.poolTried) return;
  d.poolTried = true;
  const j = await getJSON(st, 'gt-pools', `/networks/${GT_NET[c.chain]}/tokens/${c.address}/pools?page=1`, { validate: parseGtPools, prio: 0 });
  if (!j) { d.poolTried = false; return; } // let the next open try again instead of caching a failure
  const top = j.data[0];
  const addr = top?.attributes?.address;
  if (addr) upsert(st, { chain: c.chain, address: c.address, pairAddress: addr, dexId: c.dexId ?? top?.relationships?.dex?.data?.id?.replace('pump-fun', 'pumpfun') });
}

/**
 * Extra facts for the open coin: Jupiter's token record (holders, audit, organic score) for Solana coins
 * that arrived from another source, and RugCheck's risk report.
 */
export async function loadDetails(st: State, c: Coin) {
  const d = (detail[c.id] ||= {});
  if (d.detailsAt && Date.now() - d.detailsAt < 120_000) return;
  d.detailsAt = Date.now();
  if (c.chain !== 'solana') return;
  const [jup, rug] = await Promise.all([
    getJSON(st, 'jup-search', `/tokens/v2/search?query=${c.address}`, { validate: parseJupiterTokens, prio: 0 }),
    getJSON(st, 'rugcheck', `/v1/tokens/${c.address}/report/summary`, { validate: parseRugSummary, prio: 1 }),
  ]);
  const t = jup?.find((x: any) => x?.id === c.address);
  if (t) fromJupiter(st, t, undefined, st.sources['jup-search']?.at);
  if (rug) {
    d.rug = { score: num(rug.score_normalised) ?? num(rug.score), risks: rug.risks.map((r: any) => ({ name: String(r.name || ''), level: String(r.level || 'info'), description: r.description ? String(r.description) : undefined })).filter((r: any) => r.name) };
    d.rugError = undefined;
  } else d.rugError = st.sources.rugcheck?.error || 'No report';
}

/** Fetch a fresh price for one coin right before a trade, so fills use the market as it is now. */
export async function refreshOne(st: State, id: string) {
  // the trade ticket is open and the user is waiting: bypass the cache and jump the rate-limit queue
  await refreshPairs(st, [id], { force: true, prio: 0 });
  const c = st.coins[id];
  if (c && c.chain === 'solana' && (!c.updatedAt || Date.now() - c.updatedAt > 20_000)) {
    const j = await getJSON(st, 'jup-search', `/tokens/v2/search?query=${c.address}`, { validate: parseJupiterTokens, prio: 0, force: true });
    const t = j?.find((x: any) => x?.id === c.address);
    if (t) fromJupiter(st, t, undefined, st.sources['jup-search']?.at);
  }
  afterPrices(st);
}

export async function refreshSol(st: State) {
  const SOL = 'So11111111111111111111111111111111111111112';
  const j = await getJSON(st, 'jup-price', `/price/v3?ids=${SOL}`, { validate: parseJupiterPrice, prio: 1 });
  const p = j?.[SOL]?.usdPrice;
  if (p) st.solPrice = p;
}

export async function loadTrades(st: State, c: Coin, prio: 0 | 1 | 2 = 1) {
  if (!c.pairAddress) return;
  const d = (detail[c.id] ||= {});
  if (d.tradesAt && Date.now() - d.tradesAt < 20_000) return;
  d.tradesAt = Date.now();
  const rows = await getJSON(st, 'gt-trades', `/networks/${GT_NET[c.chain]}/pools/${c.pairAddress}/trades`, { validate: parseGtTradeRows, prio });
  if (!rows) { d.tradesAt = 0; return; } // failed: allow a retry on the next poll
  const trades: ChainTrade[] = rows.map((r) => ({ id: r.id, t: r.tsMs, coinId: c.id, wallet: r.wallet, side: r.side, usd: r.usd, price: r.priceUsd ?? c.price }));
  d.trades = trades;
  ingestTape(st, trades);
}

export async function loadHolders(st: State, c: Coin) {
  if (c.chain !== 'solana') return;
  const d = (detail[c.id] ||= {});
  if (d.holdersAt && Date.now() - d.holdersAt < 120_000) return;
  d.holdersAt = Date.now();
  const body = (method: string, params: any[]) => ({ jsonrpc: '2.0', id: 1, method, params });
  const [largest, supply] = await Promise.all([
    getJSON(st, 'sol-rpc', '', { method: 'POST', body: body('getTokenLargestAccounts', [c.address]), validate: parseRpc, prio: 1 }),
    getJSON(st, 'sol-rpc', '', { method: 'POST', body: body('getTokenSupply', [c.address]), validate: parseRpc, prio: 1 }),
  ]);
  const total = num(supply?.result?.value?.uiAmount);
  const rows = largest?.result?.value;
  if (!Array.isArray(rows) || !total) { d.holdersError = st.sources['sol-rpc']?.error || 'The Solana RPC returned no holders.'; d.holdersAt = 0; return; }
  d.holders = rows.map((r: any) => ({ address: r.address, pct: ((num(r.uiAmount) ?? 0) / total) * 100 }));
  d.holdersError = undefined;
}

// ======================================================================
// live tape of real on-chain trades
// ======================================================================
function ingestTape(st: State, trades: ChainTrade[]) {
  if (!trades.length) return;
  const seen = new Set(st.tape.map((t) => t.id + t.wallet));
  const fresh = trades.filter((t) => !seen.has(t.id + t.wallet));
  if (!fresh.length) return;
  for (const t of fresh) {
    const c = st.coins[t.coinId];
    const w = (st.wallets[t.wallet] ||= { address: t.wallet, chain: c?.chain || 'solana', vol: 0, buys: 0, sells: 0, lastSeen: 0, coins: [] });
    w.vol += t.usd;
    if (t.side === 'BUY') w.buys++; else w.sells++;
    w.lastSeen = Math.max(w.lastSeen, t.t);
    if (!w.coins.includes(t.coinId)) w.coins.push(t.coinId);
    if (st.user.following.includes(t.wallet) && Date.now() - t.t < 5 * 60_000 && c) {
      notify(st, { tone: t.side === 'BUY' ? 'info' : 'down', title: `${short(t.wallet)} ${t.side === 'BUY' ? 'bought' : 'sold'} $${c.symbol}`, body: `${compact(t.usd)} on-chain at ${compact(c.mcap)} mcap`, coinId: c.id });
    }
  }
  st.tape = [...fresh, ...st.tape].sort((a, b) => b.t - a.t).slice(0, 400);
  // keep the wallet table bounded
  const ws = Object.values(st.wallets);
  if (ws.length > 600) {
    ws.sort((a, b) => b.vol - a.vol).slice(400).forEach((w) => { if (!st.user.following.includes(w.address)) delete st.wallets[w.address]; });
  }
}

export const short = (a: string) => (a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

async function refreshTape(st: State, focus?: string) {
  const picks: Coin[] = [];
  const add = (c?: Coin) => { if (c && c.pairAddress && !c.rugged && !picks.includes(c)) picks.push(c); };
  if (focus) add(st.coins[focus]);
  Object.keys(st.user.positions).forEach((id) => add(st.coins[id]));
  const hot = Object.values(st.coins).filter((c) => c.price > 0 && c.pairAddress).sort((a, b) => (b.vol1h ?? 0) - (a.vol1h ?? 0));
  for (const c of hot) { if (picks.length >= 2) break; add(c); }
  // GeckoTerminal's keyless budget is ~10 calls/min: poll only the coin on screen when its queue is busy
  for (const c of picks.slice(0, 2)) {
    if (c.id !== focus && queueDepth('gt') > 1) continue;
    await loadTrades(st, c, c.id === focus ? 0 : 2);
  }
}

// ======================================================================
// notifications
// ======================================================================
export const toastQueue: Notif[] = [];
export function notify(st: State, n: Omit<Notif, 'id' | 't' | 'read'>) {
  st.notifs.unshift({ ...n, id: uid('n'), t: Date.now(), read: false });
  if (st.notifs.length > 60) st.notifs.length = 60;
  toastQueue.push(st.notifs[0]);
}

// ======================================================================
// paper trading on live prices
// ======================================================================
export interface Quote { ok: boolean; error?: string; qty: number; usd: number; execPrice: number; impact: number; fee: number }

/** Constant-product estimate against the pool's real USD liquidity. Paper trades never move the real price. */
export function quote(c: Coin, side: Side, amount: number, slippage: number): Quote {
  const blank = { qty: 0, usd: 0, execPrice: c.price, impact: 0, fee: 0 };
  if (!(c.price > 0)) return { ok: false, error: 'No live price yet for this coin.', ...blank };
  if (snapshotMode) return { ok: false, error: 'These prices are a frozen snapshot, so paper trading is off here. Open the live app to trade.', ...blank };
  if (Date.now() - c.updatedAt > STALE_MS) return { ok: false, error: 'The price is more than a minute old. Fetching a fresh one; try again in a few seconds.', ...blank };
  if (amount <= 0 || !isFinite(amount)) return { ok: false, error: 'Enter an amount.', ...blank };
  const X = Math.max(250, c.liq / 2);
  if (side === 'BUY') {
    const fee = amount * FEE_RATE;
    const net = amount - fee;
    const k = net / X;
    const execPrice = c.price * (1 + k);
    const q: Quote = { ok: true, qty: net / execPrice, usd: amount, execPrice, impact: k * 100, fee };
    if (q.impact > slippage) { q.ok = false; q.error = `Price impact ${q.impact.toFixed(1)}% is above your ${slippage}% slippage limit. This pool has ${compact(c.liq)} liquidity. Lower the size or raise slippage.`; }
    return q;
  }
  const k = (amount * c.price) / X;
  const execPrice = c.price / (1 + k);
  const gross = amount * execPrice;
  const fee = gross * FEE_RATE;
  const q: Quote = { ok: true, qty: amount, usd: gross - fee, execPrice, impact: (1 - 1 / (1 + k)) * 100, fee };
  if (q.impact > slippage) { q.ok = false; q.error = `Price impact ${q.impact.toFixed(1)}% is above your ${slippage}% slippage limit. Sell less or raise slippage.`; }
  return q;
}

export interface TradeResult { ok: boolean; message: string; trade?: Trade }
const fmtUsd = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(2));

export function userTrade(st: State, coinId: string, side: Side, amount: number, opts: { slippage?: number; via?: string } = {}): TradeResult {
  const c = st.coins[coinId];
  if (!c) return { ok: false, message: 'That coin is no longer listed.' };
  const u = st.user;
  const slippage = opts.slippage ?? st.settings.slippage;
  const now = Date.now();
  if (side === 'BUY') {
    if (amount > u.cash + 1e-9) return { ok: false, message: `You have ${fmtUsd(u.cash)} cash. Lower the amount or add paper cash in Wallet.` };
    if (amount < 1) return { ok: false, message: 'Minimum buy is $1.' };
    const q = quote(c, 'BUY', amount, slippage);
    if (!q.ok) return { ok: false, message: q.error! };
    u.cash -= amount;
    const pos = u.positions[coinId] || { coinId, qty: 0, cost: 0, openedAt: now };
    pos.qty += q.qty;
    pos.cost += amount;
    u.positions[coinId] = pos;
    const tr: Trade = { id: uid('x'), t: now, side, coinId, symbol: c.symbol, qty: q.qty, price: q.execPrice, usd: amount, fee: q.fee, via: opts.via || 'market' };
    u.trades.unshift(tr);
    return { ok: true, message: `Bought ${fmtQty(q.qty)} $${c.symbol} at ${fmtPrice(q.execPrice)}`, trade: tr };
  }
  const pos = u.positions[coinId];
  if (!pos || pos.qty <= 0) return { ok: false, message: `You don’t hold any $${c.symbol}.` };
  const sellQty = Math.min(amount, pos.qty);
  if (sellQty <= 0) return { ok: false, message: 'Enter an amount to sell.' };
  const q = quote(c, 'SELL', sellQty, slippage);
  if (!q.ok) return { ok: false, message: q.error! };
  const costPart = pos.cost * (sellQty / pos.qty);
  const pnl = q.usd - costPart;
  pos.qty -= sellQty;
  pos.cost -= costPart;
  if (pos.qty <= 0 || pos.qty * c.price < 0.01) delete u.positions[coinId];
  u.cash += q.usd;
  const tr: Trade = { id: uid('x'), t: now, side, coinId, symbol: c.symbol, qty: sellQty, price: q.execPrice, usd: q.usd, fee: q.fee, pnl, peakAfter: q.execPrice, via: opts.via || 'market' };
  u.trades.unshift(tr);
  if (u.trades.length > 300) u.trades.length = 300;
  if (!u.positions[coinId]) u.orders = u.orders.filter((o) => !(o.coinId === coinId && o.side === 'SELL'));
  return { ok: true, message: `Sold ${fmtQty(sellQty)} $${c.symbol} for ${fmtUsd(q.usd)} (${pnl >= 0 ? '+' : '-'}${fmtUsd(Math.abs(pnl))})`, trade: tr };
}

export function placeOrder(st: State, o: Omit<Order, 'id' | 'createdAt'>): TradeResult {
  const c = st.coins[o.coinId];
  if (!c) return { ok: false, message: 'Unknown coin.' };
  if (!(c.price > 0)) return { ok: false, message: 'No live price yet for this coin.' };
  if (snapshotMode) return { ok: false, message: 'Orders need live prices. This view is showing a frozen snapshot.' };
  if (!(o.trigger > 0)) return { ok: false, message: 'Enter a trigger price above zero.' };
  if (o.side === 'BUY') {
    if (!o.usd || o.usd < 1) return { ok: false, message: 'Enter how much to spend.' };
    if (o.trigger >= c.price) return { ok: false, message: `A limit buy has to sit below the current price (${fmtPrice(c.price)}). Use Market to buy now.` };
  } else {
    if (!st.user.positions[o.coinId]) return { ok: false, message: `You don’t hold any $${c.symbol} to sell.` };
    if ((o.kind === 'limit' || o.kind === 'tp') && o.trigger <= c.price) return { ok: false, message: `A take-profit has to sit above the current price (${fmtPrice(c.price)}).` };
    if (o.kind === 'sl' && o.trigger >= c.price) return { ok: false, message: `A stop-loss has to sit below the current price (${fmtPrice(c.price)}).` };
  }
  st.user.orders.push({ ...o, id: uid('o'), createdAt: Date.now() });
  const label = o.kind === 'sl' ? 'Stop-loss' : o.kind === 'tp' ? 'Take-profit' : 'Limit buy';
  return { ok: true, message: `${label} set for $${c.symbol} at ${fmtPrice(o.trigger)}. It fills when the live price gets there.` };
}

export function cancelOrder(st: State, id: string) {
  st.user.orders = st.user.orders.filter((o) => o.id !== id);
}

function checkOrders(st: State) {
  const u = st.user;
  if (!u.orders.length) return;
  const keep: Order[] = [];
  for (const o of u.orders) {
    const c = st.coins[o.coinId];
    if (!c || !(c.price > 0) || Date.now() - c.updatedAt > STALE_MS) { keep.push(o); continue; }
    const hit = o.side === 'BUY' ? c.price <= o.trigger : o.kind === 'sl' ? c.price <= o.trigger : c.price >= o.trigger;
    if (!hit) { keep.push(o); continue; }
    let res: TradeResult;
    if (o.side === 'BUY') res = userTrade(st, o.coinId, 'BUY', Math.min(o.usd || 0, u.cash), { slippage: 50, via: o.kind });
    else {
      const pos = u.positions[o.coinId];
      if (!pos) continue;
      res = userTrade(st, o.coinId, 'SELL', pos.qty * ((o.pct ?? 100) / 100), { slippage: 90, via: o.kind });
    }
    const label = o.kind === 'sl' ? 'Stop-loss hit' : o.kind === 'tp' ? 'Take-profit hit' : 'Limit buy filled';
    notify(st, { tone: res.ok ? (o.kind === 'sl' ? 'down' : 'up') : 'info', title: res.ok ? `${label} · $${c.symbol}` : `Order for $${c.symbol} couldn’t fill`, body: res.message, coinId: c.id });
  }
  u.orders = keep.filter((o) => o.side === 'BUY' || u.positions[o.coinId]);
}

let alertsFrom = 0;
export function armAlerts() { alertsFrom = Date.now(); }

function afterPrices(st: State) {
  checkOrders(st);
  for (let i = 0, n = 0; i < st.user.trades.length && n < 40; i++) {
    const tr = st.user.trades[i];
    if (tr.side !== 'SELL') continue;
    n++;
    const c = st.coins[tr.coinId];
    if (c && c.price > (tr.peakAfter ?? 0)) tr.peakAfter = c.price;
  }
  const last = st.user.equity[st.user.equity.length - 1];
  if (!last || Date.now() - last.t > 15_000) {
    st.user.equity.push({ t: Date.now(), v: equity(st) });
    if (st.user.equity.length > 2000) st.user.equity = st.user.equity.filter((_, i) => i % 2 === 0);
  }
  // high-score alerts, only for coins that appeared after the first load
  if (!alertsFrom) return;
  for (const c of Object.values(st.coins)) {
    if ((c as any)._alerted || st.majors.includes(c.id) || !(c.price > 0) || c.firstSeen < alertsFrom || Date.now() - c.firstSeen > 5 * 60_000) continue;
    const s = scoreCoin(c);
    if (s.score >= st.settings.alertsMinScore && s.known >= 5) {
      (c as any)._alerted = true;
      notify(st, { tone: 'gem', title: `Gem Radar: $${c.symbol} scored ${s.score}`, body: `${compact(c.mcap)} mcap · ${compact(c.liq)} liquidity · ${s.risk} risk · seen on ${c.sources.length} source${c.sources.length > 1 ? 's' : ''}`, coinId: c.id });
    }
  }
}

// ======================================================================
// refresh loops
// ======================================================================
export async function discover(st: State) {
  await Promise.all([
    fetchDsProfiles(st),
    fetchDsBoosts(st),
    fetchJupiter(st, 'jup-recent', 'recent'),
    fetchJupiter(st, 'jup-trending', 'toptrending/1h?limit=50'),
    fetchJupiter(st, 'jup-organic', 'toporganicscore/1h?limit=50'),
    fetchJupiter(st, 'jup-traded', 'toptraded/1h?limit=50'),
    (async () => { if (st.sources['gt-new']) st.sources['gt-new'].count = 0; await fetchGt(st, 'gt-new', 'networks/solana/new_pools'); await fetchGt(st, 'gt-new', 'networks/base/new_pools'); })(),
    (async () => { if (st.sources['gt-trending']) st.sources['gt-trending'].count = 0; await fetchGt(st, 'gt-trending', 'networks/solana/trending_pools'); await fetchGt(st, 'gt-trending', 'networks/base/trending_pools'); })(),
    fetchPumpFun(st),
    fetchPumpLive(st),
    refreshSol(st),
  ]);
  prune(st);
}

// ======================================================================
// bundled snapshot (only when every live source is unreachable)
// ======================================================================
export let snapshotMode = false;

export function loadSnapshot(st: State) {
  snapshotMode = true;
  st.snapshotAt = SNAPSHOT_AT;
  const listSource: Record<string, SourceId> = { trending: 'jup-trending', organic: 'jup-organic', recent: 'jup-recent', major: 'major' };
  for (const r of SNAP_JUP) {
    const [id, name, symbol, icon, usdPrice, mcap, liquidity, holderCount, organicScore, chg1h, chg24h, vol24h, numBuys, numSells, mintOff, freezeOff, top, dev, launchpad, createdAt, tags, list] = r;
    fromJupiter(st, {
      id, name, symbol, icon, usdPrice, mcap, liquidity, holderCount, launchpad, createdAt, tags: tags ? tags.split(';') : [],
      organicScore,
      // the snapshot kept Jupiter's numeric score but not its high/medium/low label, so the label is approximated from the score
      organicScoreLabel: organicScore === null ? undefined : organicScore >= 70 ? 'high' : organicScore >= 40 ? 'medium' : 'low',
      stats1h: { priceChange: chg1h }, stats24h: { priceChange: chg24h, buyVolume: vol24h, sellVolume: 0, numBuys, numSells },
      audit: { mintAuthorityDisabled: mintOff ?? undefined, freezeAuthorityDisabled: freezeOff ?? undefined, topHoldersPercentage: top, devBalancePercentage: dev },
    }, listSource[list]);
  }
  for (const [mint, name, symbol, image, marketCapUsd, createdAtMs, complete, liquidityUsd, twitter, telegram, website] of SNAP_PUMP) {
    fromPumpFun(st, { mint, name, symbol, image, marketCapUsd, createdAtMs, complete, liquidityUsd, twitter: twitter ?? undefined, telegram: telegram ?? undefined, website: website ?? undefined, isLive: true }, 'pump-live', SNAPSHOT_AT);
  }
  for (const [chain, address, name, symbol, pairAddress, dexId, price, h1, h24, vol, buys, sells, liq, mcap, created] of SNAP_DS) {
    const c = upsert(st, { chain, address, name, symbol, pairAddress, dexId, mcap, liq, vol24: vol, buys24: buys, sells24: sells, change: { h1, h24 }, createdAt: created });
    recordPrice(st, c, price, liq);
  }
  for (const [mint, amount] of Object.entries(SNAP_BOOSTS)) { const c = st.coins[keyOf('solana', mint)]; if (c) upsert(st, { chain: 'solana', address: mint, boost: amount }, 'ds-boosts'); }
  // frozen: mark every price with the capture time so nothing pretends to be fresh
  for (const c of Object.values(st.coins)) if (c.price > 0) { c.updatedAt = SNAPSHOT_AT; c.spark = c.spark.map((p) => ({ ...p, t: SNAPSHOT_AT })); }
}

/** A live source answered after the snapshot was shown: drop the frozen flag and let live data take over. */
export function leaveSnapshot(st: State) {
  snapshotMode = false;
  st.snapshotAt = undefined;
}

export function priorityIds(st: State, focus?: string): string[] {
  const ids = new Set<string>(st.majors);
  if (focus) ids.add(focus);
  Object.keys(st.user.positions).forEach((id) => ids.add(id));
  st.user.orders.forEach((o) => ids.add(o.coinId));
  const rest = Object.values(st.coins).filter((c) => !ids.has(c.id)).sort((a, b) => b.firstSeen - a.firstSeen || b.sources.length - a.sources.length);
  for (const c of rest) { if (ids.size >= 150) break; ids.add(c.id); }
  return [...ids];
}

export async function refreshPrices(st: State, focus?: string) {
  await refreshPairs(st, priorityIds(st, focus));
  afterPrices(st);
}

export async function refreshLiveTape(st: State, focus?: string) {
  await refreshTape(st, focus);
}

function prune(st: State) {
  const coins = Object.values(st.coins);
  if (coins.length <= 450) return;
  const keep = new Set<string>([...st.majors, ...Object.keys(st.user.positions), ...st.user.orders.map((o) => o.coinId), ...st.user.trades.slice(0, 100).map((t) => t.coinId), ...st.user.theses.map((t) => t.coinId)]);
  coins.filter((c) => !keep.has(c.id)).sort((a, b) => a.firstSeen - b.firstSeen).slice(0, coins.length - 400).forEach((c) => { delete st.coins[c.id]; delete detail[c.id]; });
  const live = new Set(Object.keys(st.coins));
  st.tape = st.tape.filter((t) => live.has(t.coinId));
}

// ======================================================================
// derived
// ======================================================================
export function holdingsValue(st: State) {
  let v = 0;
  for (const p of Object.values(st.user.positions)) { const c = st.coins[p.coinId]; if (c) v += p.qty * c.price; }
  return v;
}
export const equity = (st: State) => st.user.cash + holdingsValue(st);

export function userStats(st: State) {
  const eq = equity(st);
  const sells = st.user.trades.filter((t) => t.side === 'SELL');
  const wins = sells.filter((t) => (t.pnl ?? 0) > 0).length;
  const realized = sells.reduce((a, t) => a + (t.pnl ?? 0), 0);
  let unreal = 0;
  for (const p of Object.values(st.user.positions)) { const c = st.coins[p.coinId]; if (c) unreal += p.qty * c.price - p.cost; }
  const pnl = eq - st.user.deposits;
  return { equity: eq, pnl, pnlPct: (pnl / st.user.deposits) * 100, realized, unreal, winRate: sells.length ? (wins / sells.length) * 100 : 0, sells: sells.length };
}

export function fumbles(st: State) {
  return st.user.trades
    .filter((t) => t.side === 'SELL' && t.peakAfter && t.peakAfter > t.price)
    .map((t) => ({ trade: t, missed: (t.peakAfter! - t.price) * t.qty, mult: t.peakAfter! / t.price }))
    .sort((a, b) => b.missed - a.missed);
}

export function topWallets(st: State): WalletSeen[] {
  return Object.values(st.wallets).sort((a, b) => b.vol - a.vol);
}

// ======================================================================
// state + persistence (only your paper wallet and the coins it references are saved)
// ======================================================================
export function freshState(): State {
  const st: State = {
    v: STATE_VERSION, coins: {}, majors: [], tape: [], wallets: {}, notifs: [], sources: {},
    user: { cash: START_CASH, deposits: START_CASH, positions: {}, trades: [], orders: [], following: [], theses: [], equity: [{ t: Date.now(), v: START_CASH }] },
    settings: { slippage: 5, alertsMinScore: 75 },
    loaded: false,
  };
  for (const m of MAJORS) {
    const c = upsert(st, { chain: m.chain, address: m.address, symbol: m.symbol }, 'major');
    st.majors.push(c.id);
  }
  return st;
}

/** Wallet backup: everything you did (cash, positions, every buy and sell, orders, theses, value history). */
export function exportWallet(st: State): string {
  const keep = new Set<string>([...Object.keys(st.user.positions), ...st.user.orders.map((o) => o.coinId), ...st.user.trades.map((t) => t.coinId), ...st.user.theses.map((t) => t.coinId)]);
  const coins: Record<string, Coin> = {};
  keep.forEach((id) => { const c = st.coins[id]; if (c) coins[id] = { ...c, spark: c.spark.slice(-20) }; });
  return JSON.stringify({ app: 'bagz', v: STATE_VERSION, exportedAt: new Date().toISOString(), user: st.user, settings: st.settings, coins }, null, 1);
}

export function importWallet(st: State, text: string): { ok: boolean; message: string } {
  try {
    const j = JSON.parse(text);
    const u = j?.user;
    if ((j?.app !== 'bagz' && j?.app !== 'frenzy') || !u || typeof u.cash !== 'number' || !Array.isArray(u.trades) || typeof u.positions !== 'object') return { ok: false, message: 'That file isn’t a BAGZ wallet backup.' };
    st.user = { following: [], theses: [], orders: [], equity: [], ...u };
    if (j.settings) st.settings = { ...st.settings, ...j.settings };
    for (const c of Object.values(j.coins || {}) as Coin[]) if (c?.id && !st.coins[c.id]) st.coins[c.id] = { ...c, updatedAt: 0 };
    return { ok: true, message: `Restored ${u.trades.length} trades and ${Object.keys(u.positions).length} positions.` };
  } catch { return { ok: false, message: 'Couldn’t read that file. Pick the .json backup BAGZ saved.' }; }
}

export function load(): State {
  const st = freshState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved.v === STATE_VERSION && saved.user) {
        st.user = saved.user;
        st.settings = { ...st.settings, ...(saved.settings || {}) };
        for (const c of Object.values(saved.coins || {}) as Coin[]) if (!st.coins[c.id]) st.coins[c.id] = { ...c, updatedAt: 0 };
      }
    }
  } catch { /* storage blocked or corrupt; start fresh */ }
  return st;
}

export function save(st: State) {
  try {
    const keep = new Set<string>([...Object.keys(st.user.positions), ...st.user.orders.map((o) => o.coinId), ...st.user.trades.map((t) => t.coinId), ...st.user.theses.map((t) => t.coinId)]);
    const coins: Record<string, Coin> = {};
    keep.forEach((id) => { const c = st.coins[id]; if (c) coins[id] = { ...c, spark: c.spark.slice(-60) }; });
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: STATE_VERSION, user: st.user, settings: st.settings, coins }));
  } catch { /* ignore */ }
}

export function clearSave() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
