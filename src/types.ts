export type Chain = 'solana' | 'ethereum' | 'base' | 'bsc';
export type Side = 'BUY' | 'SELL';

export interface Candle {
  t: number; // ms timestamp of candle open
  o: number;
  h: number;
  l: number;
  c: number;
  v: number; // USD volume traded in the candle
}

/** Where a coin was seen. Every coin keeps the list of sources that reported it. */
export type SourceId =
  | 'ds-profiles' // DexScreener newest token profiles
  | 'ds-boosts' // DexScreener top boosted tokens
  | 'jup-recent' // Jupiter newest tokens
  | 'jup-trending' // Jupiter top trending (1h)
  | 'jup-organic' // Jupiter top organic score (1h)
  | 'jup-traded' // Jupiter most traded (1h)
  | 'gt-new' // GeckoTerminal new pools
  | 'gt-trending' // GeckoTerminal trending pools
  | 'pumpfun' // pump.fun newest coins (frontend API; some browsers block it)
  | 'pump-live' // pump.fun coins livestreaming right now
  | 'major'; // on the blue-chip list

export interface SourceStatus {
  id: SourceId | 'ds-pairs' | 'gt-ohlcv' | 'gt-trades' | 'gt-pools' | 'sol-rpc' | 'jup-search' | 'jup-price' | 'rugcheck' | 'jup-quote' | 'jup-execute' | 'sol-confirm';
  label: string;
  ok: boolean | null; // null = not tried yet
  at?: number; // when the provider data was actually fetched
  count?: number;
  error?: string;
  stale?: boolean; // the live call failed and the last good answer is shown
  via?: 'proxy' | 'direct';
  ms?: number; // recent latency
  kind?: string; // network | timeout | http | rate-limited | invalid | cooldown
}

/** Contract and holder checks. undefined = the sources didn't report it. */
export interface Audit {
  mintRevoked?: boolean;
  freezeRevoked?: boolean;
  topHolders?: number; // % of supply held by the top holders (Jupiter)
  devPct?: number; // % held by the deployer (Jupiter)
  devMints?: number; // coins this deployer has launched before (Jupiter)
}

export interface Coin {
  id: string; // `${chain}:${address}`
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  icon?: string;
  decimals?: number; // token decimals (Jupiter), needed to turn amounts into raw units for swaps
  header?: string; // wide banner image from DexScreener
  description?: string;
  price: number; // 0 = not priced yet
  change: { m5?: number; h1?: number; h6?: number; h24?: number };
  mcap: number;
  liq: number;
  vol24: number;
  vol1h?: number;
  buys24?: number;
  sells24?: number;
  holders?: number;
  organic?: { score: number; label: string };
  audit: Audit;
  socials: number; // count of website/twitter/telegram links
  links: { type: string; url: string }[];
  launchpad?: string; // 'pump.fun', 'bonk.fun', ...
  dexId?: string;
  pairAddress?: string;
  createdAt?: number; // pair or mint creation time
  boost?: number;
  pumpComplete?: boolean; // pump.fun: bonding curve finished and the coin migrated to an AMM
  pumpLive?: boolean; // pump.fun: the creator is livestreaming
  sources: SourceId[];
  spark: { t: number; p: number }[]; // price samples taken on each refresh
  peakPrice: number;
  peakLiq: number;
  rugged?: 'liquidity' | 'crash';
  firstSeen: number;
  updatedAt: number;
}

export interface Position {
  coinId: string;
  qty: number;
  cost: number; // USD cost basis of the remaining qty
  openedAt: number;
}

export interface Trade {
  id: string;
  t: number;
  side: Side;
  coinId: string;
  symbol: string;
  qty: number;
  price: number;
  usd: number;
  fee: number;
  pnl?: number;
  peakAfter?: number;
  via?: string;
}

export type OrderKind = 'limit' | 'tp' | 'sl';
export interface Order {
  id: string;
  coinId: string;
  side: Side;
  kind: OrderKind;
  trigger: number;
  usd?: number;
  pct?: number;
  createdAt: number;
}

/** A real on-chain swap, read from GeckoTerminal. */
export interface ChainTrade {
  id: string; // tx hash
  t: number;
  coinId: string;
  wallet: string;
  side: Side;
  usd: number;
  price: number;
}

export interface WalletSeen {
  address: string;
  chain: Chain;
  vol: number;
  buys: number;
  sells: number;
  lastSeen: number;
  coins: string[];
}

export interface Thesis {
  id: string;
  t: number;
  coinId: string;
  bull: boolean;
  text: string;
  price: number;
  mcap: number;
}

export interface Notif {
  id: string;
  t: number;
  tone: 'up' | 'down' | 'gem' | 'info';
  title: string;
  body: string;
  coinId?: string;
  read: boolean;
}

export interface UserState {
  cash: number;
  deposits: number;
  positions: Record<string, Position>;
  trades: Trade[];
  orders: Order[];
  following: string[]; // wallet addresses
  /** coin ids saved with the bookmark on the coin page */
  watchlist?: string[];
  theses: Thesis[];
  /** trading cards kept in the Cards tab (numbers frozen when the card was made) */
  cards?: SavedCard[];
  equity: { t: number; v: number }[];
  /** changes when the wallet is reset or restored from a backup, so a sync never mixes the old and new wallet */
  epoch?: string;
}

export interface State {
  v: number;
  coins: Record<string, Coin>;
  majors: string[];
  tape: ChainTrade[];
  wallets: Record<string, WalletSeen>;
  user: UserState;
  notifs: Notif[];
  sources: Record<string, SourceStatus>;
  settings: { slippage: number; alertsMinScore: number };
  loaded: boolean; // first discovery round finished
  solPrice?: number; // SOL/USD from Jupiter, for the home page
  snapshotAt?: number; // set when no source answered and the bundled real snapshot is shown instead
}

export interface SavedCard {
  id: string;
  t: number;
  /** what the card is of, so the same trade isn't saved twice (e.g. "trade:x123") */
  key: string;
  data: import('./card/tradingCard').CardData;
}
