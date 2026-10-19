/**
 * Provider registry: where every data source lives, how fast it may be called, and how long answers stay fresh.
 *
 * Verified against vendor docs on 18 Oct 2026:
 *  - Jupiter: api.jup.ag (x-api-key). Keyless 0.5 req/s, free key 1 req/s. lite-api.jup.ag is being phased out.
 *  - GeckoTerminal keyless: ~10 calls/min shared per IP, "not for production". A CoinGecko Demo key allows 100/min.
 *  - pump.fun: no published API. frontend-api-v3 is an unofficial host that can change or disappear.
 */
export type ProviderId = 'jup' | 'gt' | 'ds' | 'pump' | 'rug' | 'rpc';

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  /** upstream roots tried in order when calling the provider directly (no proxy) */
  hosts: string[];
  /** token bucket for direct calls: refill per second + burst */
  direct: { rate: number; burst: number };
  /** token bucket when going through the BAGZ proxy (it caches at the edge, so clients can be looser) */
  proxied: { rate: number; burst: number };
  maxConcurrent: number;
  /** false = vendor does not publish or support this API */
  official: boolean;
  note?: string;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  jup: {
    id: 'jup', label: 'Jupiter', hosts: ['https://api.jup.ag', 'https://lite-api.jup.ag'],
    direct: { rate: 0.5, burst: 4 }, proxied: { rate: 1, burst: 6 }, maxConcurrent: 3, official: true,
    note: 'Keyless is 0.5 req/s. Add a free key to the proxy for 1 req/s.',
  },
  gt: {
    id: 'gt', label: 'GeckoTerminal', hosts: ['https://api.geckoterminal.com/api/v2'],
    direct: { rate: 10 / 60, burst: 3 }, proxied: { rate: 0.5, burst: 5 }, maxConcurrent: 2, official: true,
    note: 'Keyless is about 10 calls a minute per IP. The proxy caches and can use a CoinGecko Demo key (100/min).',
  },
  ds: {
    id: 'ds', label: 'DexScreener', hosts: ['https://api.dexscreener.com'],
    direct: { rate: 3, burst: 8 }, proxied: { rate: 3, burst: 8 }, maxConcurrent: 4, official: true,
  },
  pump: {
    id: 'pump', label: 'pump.fun', hosts: ['https://frontend-api-v3.pump.fun'],
    direct: { rate: 0.5, burst: 2 }, proxied: { rate: 0.5, burst: 3 }, maxConcurrent: 1, official: false,
    note: 'pump.fun publishes no API. This is an undocumented website backend and browsers usually can’t call it directly.',
  },
  rug: {
    id: 'rug', label: 'RugCheck', hosts: ['https://api.rugcheck.xyz'],
    direct: { rate: 0.5, burst: 3 }, proxied: { rate: 0.5, burst: 3 }, maxConcurrent: 2, official: true,
  },
  rpc: {
    id: 'rpc', label: 'Solana RPC', hosts: ['https://api.mainnet-beta.solana.com'],
    direct: { rate: 1, burst: 3 }, proxied: { rate: 2, burst: 5 }, maxConcurrent: 2, official: true,
    note: 'The public RPC is heavily rate limited. Point the proxy at your own RPC URL.',
  },
};

export type SourceId =
  | 'ds-profiles' | 'ds-boosts' | 'ds-pairs'
  | 'jup-recent' | 'jup-trending' | 'jup-organic' | 'jup-traded' | 'jup-search' | 'jup-price'
  | 'gt-new' | 'gt-trending' | 'gt-pools' | 'gt-ohlcv' | 'gt-trades'
  | 'pumpfun' | 'pump-live' | 'rugcheck' | 'sol-rpc' | 'jup-quote' | 'jup-execute' | 'sol-confirm';

export interface SourceSpec {
  provider: ProviderId;
  /** how long a successful answer is reused without calling the network */
  ttlMs: number;
  /** if the provider fails, an answer up to this old may still be shown (flagged as stale) */
  staleOkMs: number;
  retries: number;
  timeoutMs: number;
}

export const SOURCES: Record<SourceId, SourceSpec> = {
  'ds-profiles': { provider: 'ds', ttlMs: 60_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 9000 },
  'ds-boosts': { provider: 'ds', ttlMs: 60_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 9000 },
  'ds-pairs': { provider: 'ds', ttlMs: 8_000, staleOkMs: 0, retries: 1, timeoutMs: 9000 },
  'jup-recent': { provider: 'jup', ttlMs: 45_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 9000 },
  'jup-trending': { provider: 'jup', ttlMs: 45_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 9000 },
  'jup-organic': { provider: 'jup', ttlMs: 45_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 9000 },
  'jup-traded': { provider: 'jup', ttlMs: 45_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 9000 },
  'jup-search': { provider: 'jup', ttlMs: 12_000, staleOkMs: 0, retries: 1, timeoutMs: 9000 },
  'jup-price': { provider: 'jup', ttlMs: 20_000, staleOkMs: 2 * 60_000, retries: 1, timeoutMs: 9000 },
  'jup-quote': { provider: 'jup', ttlMs: 0, staleOkMs: 0, retries: 0, timeoutMs: 12_000 },
  // never retried automatically: a retry after an unclear failure could send a second swap
  'jup-execute': { provider: 'jup', ttlMs: 0, staleOkMs: 0, retries: 0, timeoutMs: 25_000 },
  'sol-confirm': { provider: 'rpc', ttlMs: 0, staleOkMs: 0, retries: 1, timeoutMs: 10_000 },
  'gt-new': { provider: 'gt', ttlMs: 60_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 10_000 },
  'gt-trending': { provider: 'gt', ttlMs: 60_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 10_000 },
  'gt-pools': { provider: 'gt', ttlMs: 10 * 60_000, staleOkMs: 60 * 60_000, retries: 1, timeoutMs: 10_000 },
  'gt-ohlcv': { provider: 'gt', ttlMs: 20_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 12_000 },
  'gt-trades': { provider: 'gt', ttlMs: 25_000, staleOkMs: 5 * 60_000, retries: 1, timeoutMs: 10_000 },
  pumpfun: { provider: 'pump', ttlMs: 30_000, staleOkMs: 5 * 60_000, retries: 0, timeoutMs: 8000 },
  'pump-live': { provider: 'pump', ttlMs: 30_000, staleOkMs: 5 * 60_000, retries: 0, timeoutMs: 8000 },
  rugcheck: { provider: 'rug', ttlMs: 5 * 60_000, staleOkMs: 30 * 60_000, retries: 1, timeoutMs: 10_000 },
  'sol-rpc': { provider: 'rpc', ttlMs: 2 * 60_000, staleOkMs: 10 * 60_000, retries: 1, timeoutMs: 10_000 },
};

export const SOURCE_LABELS: Record<SourceId | 'major', string> = {
  'ds-pairs': 'DexScreener prices',
  'ds-profiles': 'DexScreener new listings',
  'ds-boosts': 'DexScreener boosts',
  'jup-recent': 'Jupiter new tokens',
  'jup-trending': 'Jupiter trending',
  'jup-organic': 'Jupiter organic score',
  'jup-traded': 'Jupiter most traded',
  'jup-search': 'Jupiter token details',
  'jup-price': 'Jupiter SOL price',
  'jup-quote': 'Jupiter swap quote',
  'jup-execute': 'Jupiter swap execute',
  'sol-confirm': 'Solana confirmation',
  'gt-new': 'GeckoTerminal new pools',
  'gt-trending': 'GeckoTerminal trending',
  'gt-pools': 'GeckoTerminal pool lookup',
  'gt-ohlcv': 'GeckoTerminal candles',
  'gt-trades': 'GeckoTerminal trades',
  pumpfun: 'pump.fun new coins',
  'pump-live': 'pump.fun livestreams',
  rugcheck: 'RugCheck report',
  'sol-rpc': 'Solana RPC holders',
  major: 'Blue-chip list',
};
