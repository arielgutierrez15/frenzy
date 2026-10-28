/**
 * Pool-specific trading activity for the Investigate panel, read from the GeckoTerminal pool record BAGZ already uses
 * to find a coin's chart pool (/networks/solana/tokens/<mint>/pools). Only the chart's own pool is used: counts from
 * different pools are never added together. A value the provider does not supply stays undefined ("unavailable"),
 * never 0.
 */
import { fin, isObj, poolHasBase, type GtList } from '../providers/adapters';

export type WindowId = 'm5' | 'm15' | 'm30' | 'h1' | 'h6' | 'h24';
export const WINDOWS: { id: WindowId; label: string }[] = [
  { id: 'm5', label: '5m' }, { id: 'm15', label: '15m' }, { id: 'm30', label: '30m' }, { id: 'h1', label: '1h' }, { id: 'h6', label: '6h' }, { id: 'h24', label: '24h' },
];
export interface WindowCounts { id: WindowId; label: string; buys?: number; sells?: number; buyers?: number; sellers?: number; volumeUsd?: number }
export interface PoolActivity {
  pool: string;
  name?: string;
  dex?: string;
  baseMint?: string;
  quoteMint?: string;
  /** the coin is the pool's base token (true) — only then are buys/sells "of this coin" */
  baseMatches: boolean;
  reserveUsd?: number;
  createdAt?: number;
  windows: WindowCounts[];
  /** how many other pools GeckoTerminal listed for this token on the same page (not added in) */
  otherPools: number;
  /** at least one window has a count */
  hasCounts: boolean;
}

const count = (x: unknown): number | undefined => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : typeof x === 'string' && /^\d{1,12}$/.test(x) ? Number(x) : undefined);
const nonNeg = (x: unknown): number | undefined => { const n = fin(x); return n !== undefined && n >= 0 ? n : undefined; };
const tokenId = (rel: any): string | undefined => { const id = rel?.data?.id; return typeof id === 'string' && id.includes('_') ? id.slice(id.indexOf('_') + 1) : undefined; };

/** the chart pool's record, or null when GeckoTerminal did not list that pool */
export function poolActivity(list: GtList, poolAddress: string, mint: string): PoolActivity | null {
  const row = list.data.find((p) => isObj(p.attributes) && p.attributes.address === poolAddress);
  if (!row) return null;
  const a = row.attributes as Record<string, any>;
  const tx = isObj(a.transactions) ? a.transactions : {};
  const vol = isObj(a.volume_usd) ? a.volume_usd : {};
  const windows = WINDOWS.map((w) => {
    const t = isObj(tx[w.id]) ? tx[w.id] : {};
    return { id: w.id, label: w.label, buys: count(t.buys), sells: count(t.sells), buyers: count(t.buyers), sellers: count(t.sellers), volumeUsd: nonNeg(vol[w.id]) };
  });
  const created = typeof a.pool_created_at === 'string' ? Date.parse(a.pool_created_at) : NaN;
  return {
    pool: poolAddress,
    name: typeof a.name === 'string' ? a.name.slice(0, 80) : undefined,
    dex: typeof row.relationships?.dex?.data?.id === 'string' ? row.relationships.dex.data.id : undefined,
    baseMint: tokenId(row.relationships?.base_token),
    quoteMint: tokenId(row.relationships?.quote_token),
    baseMatches: poolHasBase(row, 'solana', mint),
    reserveUsd: nonNeg(a.reserve_in_usd),
    createdAt: Number.isFinite(created) ? created : undefined,
    windows,
    otherPools: list.data.filter((p) => p !== row).length,
    hasCounts: windows.some((w) => w.buys !== undefined || w.sells !== undefined),
  };
}
