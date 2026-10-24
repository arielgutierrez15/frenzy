/**
 * Client for the BAGZ API (/v1 on the Cloudflare Worker). Swaps, BOOST and admin all go through here.
 * Without a configured Worker (see providers/config.ts) these features say so instead of failing silently.
 */
import { proxyBase } from '../providers/config';
import { demo } from '../demo/hook';

/** where the BAGZ API lives: the configured Worker, or the in-page server in the test copy */
export const apiBase = (): string | null => demo()?.base || proxyBase();

export class ApiErr extends Error {
  constructor(public status: number, message: string, public body?: any) { super(message); this.name = 'ApiErr'; }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (u, i) => { const d = demo(); return d ? d.fetch(u, i) : fetch(u, i); };
/** tests only */
export const __setApiFetch = (f: FetchFn) => { fetchImpl = f; cfgCache = null; };

export const NO_SERVER = 'The BAGZ server isn’t connected to this page, so live swaps and Boost aren’t available here.';

export async function apiCall<T>(path: string, o: { method?: 'GET' | 'POST'; body?: unknown; token?: string; timeoutMs?: number } = {}): Promise<T> {
  const base = apiBase();
  if (!base) throw new ApiErr(0, NO_SERVER);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 20_000);
  let res: Response;
  try {
    const headers: Record<string, string> = {};
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    res = await fetchImpl(`${base}/v1${path}`, { method: o.method || (o.body === undefined ? 'GET' : 'POST'), headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: ctrl.signal, credentials: 'omit' });
  } catch (e: any) {
    throw new ApiErr(0, e?.name === 'AbortError' ? 'The BAGZ server took too long to answer' : 'Couldn’t reach the BAGZ server');
  } finally { clearTimeout(timer); }
  let body: any = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiErr(res.status, (body && typeof body.error === 'string' && body.error) || `BAGZ server answered ${res.status}`, body);
  return body as T;
}

export interface Pkg { id: 'starter' | 'boost' | 'prime' | 'spotlight'; label: string; usdc: number; hours: number }
export interface ServerConfig {
  liveSwaps: boolean; liveBoostPayments: boolean; feeBps: number | null;
  feeAccounts: { wsol: boolean; usdc: boolean }; boostConfigured: boolean; adminConfigured: boolean; database: boolean;
  jupiterKey: boolean; rpc: 'custom' | 'helius' | 'public'; packages: Pkg[]; testCopy?: boolean;
}
let cfgCache: { at: number; v: Promise<ServerConfig> } | null = null;
export function getServerConfig(force = false): Promise<ServerConfig> {
  if (!force && cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.v;
  const v = apiCall<ServerConfig>('/config');
  cfgCache = { at: Date.now(), v };
  v.catch(() => { cfgCache = null; });
  return v;
}

// ---- swaps ----------------------------------------------------------------------------------------------------------
export interface SwapQuoteV1 {
  side: 'BUY' | 'SELL'; inputMint: string; outputMint: string; inAmount: string; outAmount: string; minOut: string;
  slippageBps: number; priceImpactPct: number | null; routes: string[];
  feeBps: number; feeMint: string; feeAccount: string; feeEstimateRaw: string;
  networkFeeLamports: number; networkFeeIsMax: boolean; computeUnitLimit: number; computeUnitPrice: number; simulated: boolean;
}
export interface Prepared { live: boolean; swapId?: string; transaction?: string; expiresAt?: number; quote: SwapQuoteV1; note?: string; replay?: boolean }
export interface SwapStatus { id: string; status: 'prepared' | 'submitting' | 'sent' | 'confirmed' | 'failed' | 'expired'; signature: string | null; feeCollected: string | null; feeMint: string; error: string | null; warning: string | null }
export const prepareSwap = (b: { taker: string; inputMint: string; outputMint: string; amount: string; slippageBps: number; idempotencyKey: string }) => apiCall<Prepared>('/swap/prepare', { body: b, timeoutMs: 30_000 });
export const submitSwap = (swapId: string, signedTransaction: string) => apiCall<{ signature: string; status: string; note?: string }>('/swap/submit', { body: { swapId, signedTransaction }, timeoutMs: 30_000 });
export const swapStatus = (id: string) => apiCall<SwapStatus>(`/swap/status?id=${encodeURIComponent(id)}`);

// ---- balances -------------------------------------------------------------------------------------------------------
export interface Balances { owner: string; lamports: string; tokens: { mint: string; amount: string; decimals: number }[]; at: number }
export const getBalances = (owner: string) => apiCall<Balances>(`/wallet/balances?owner=${encodeURIComponent(owner)}`);

// ---- BOOST ----------------------------------------------------------------------------------------------------------
export interface TokenInfo { mint: string; symbol: string; name: string; icon: string | null; decimals: number }
export interface Order {
  id: string; mint: string; symbol: string; name: string; icon: string | null; package: Pkg['id']; priceRaw: string; priceUsdc: number; durationMs: number;
  advertiser: string; reference: string; status: 'awaiting_payment' | 'pending_review' | 'approved' | 'rejected' | 'cancelled' | 'expired_unpaid';
  startsAt: number | null; endsAt: number | null; payBy: number; createdAt: number; reviewNote: string | null;
}
export interface Campaign { id: string; mint: string; symbol: string; name: string; icon: string | null; package: Pkg['id']; endsAt: number }
export const boostPreview = (mint: string, pkg: string) => apiCall<{ token: TokenInfo; package: Pkg & { priceRaw: string; durationMs: number }; live: boolean }>('/boost/preview', { body: { mint, package: pkg } });
export const createOrder = (b: { mint: string; package: string; advertiser: string; idempotencyKey: string }) => apiCall<{ order: Order; solanaPay: string | null }>('/boost/orders', { body: b });
export const getOrder = (id: string) => apiCall<{ order: Order; solanaPay: string | null }>(`/boost/orders/${id}`);
export const orderTransaction = (id: string, payer: string) => apiCall<{ transaction: string; lastValidBlockHeight: number }>(`/boost/orders/${id}/transaction`, { body: { payer } });
export const submitOrderPayment = (id: string, signedTransaction: string) => apiCall<{ signature: string; status: string }>(`/boost/orders/${id}/submit`, { body: { signedTransaction } });
export const verifyOrder = (id: string, signature?: string) => apiCall<{ order: Order; verified: boolean; reason?: string; signature?: string }>(`/boost/orders/${id}/verify`, { body: signature ? { signature } : {} });
/** TEST COPY ONLY: fake payment so the review flow can be tried (the server refuses it everywhere else) */
export const testPayOrder = (id: string) => apiCall<{ order: Order; verified: boolean }>(`/boost/orders/${id}/test-pay`, { body: {} });
export const activeCampaigns = () => apiCall<{ campaigns: Campaign[]; at: number }>('/boost/active');
export const sendCampaignEvent = (id: string, type: 'impression' | 'click') => apiCall<{ counted: boolean }>('/boost/events', { body: { id, type } }).catch(() => ({ counted: false }));

// ---- admin ----------------------------------------------------------------------------------------------------------
export interface AdminPromotion extends Order { payment: { signature: string; payer: string; amount_raw: string; block_time: number | null } | null; stats: { impressions: number; clicks: number }; reviewedBy: string | null; blocked?: boolean; running?: boolean; refundOwed?: boolean }
export type BoostCounts = Partial<Record<Order['status'] | 'running' | 'refunds', number>>;
export const adminChallenge = (wallet: string) => apiCall<{ nonce: string; message: string }>('/admin/challenge', { body: { wallet } });
export const adminSession = (wallet: string, nonce: string, signature: string) => apiCall<{ token: string; wallet: string; expiresAt: number }>('/admin/session', { body: { wallet, nonce, signature } });
export const adminPromotions = (token: string, status: string) => apiCall<{ promotions: AdminPromotion[]; counts?: BoostCounts }>(`/admin/promotions?status=${encodeURIComponent(status)}`, { token });
export const adminEndCampaign = (token: string, id: string, note: string) => apiCall<{ order: Order }>(`/admin/promotions/${id}/end`, { body: { note }, token });
export const adminDecide = (token: string, id: string, action: 'approve' | 'reject', b: { startsAt?: number; note?: string }) => apiCall<{ order: Order }>(`/admin/promotions/${id}/${action}`, { body: b, token });

export interface Daily { day: string; n: number }
export interface AdminOverview {
  generatedAt: number; days: number;
  users: { total: number; new24h: number; new7d: number; new30d: number; withAvatar: number; withBio: number; dau: number; wau: number; mau: number; liveSessions: number };
  signups: Daily[]; activeDaily: Daily[]; tradesDaily: Daily[]; swapsDaily: Daily[];
  paper: { trades: number; trades24h: number; traders: number; buys: number; sells: number; volumeUsd: number; volume24hUsd: number; theses: number; reporting: number; avgPnlPct: number | null; inProfit: number; avgWinRate: number | null };
  topTokens: { symbol: string; mint: string; trades: number; volume: number }[];
  swaps: { byStatus: Record<string, number>; total: number; fees: { mint: string; symbol: string | null; raw: string; amount: number | null }[] };
  boost: { byStatus: Record<string, number>; paidOrders: number; revenueUsdc: number; revenue30dUsdc: number; impressions: number; clicks: number };
  vault: { coinsIssued: number; coinsSpent: number; cardsMinted: number; collectors: number };
  social: { friendships: number; pendingRequests: number; chats: number; messages: number; messages24h: number };
}
export interface AdminUser { id: string; username: string; createdAt: number; lastSeen: number | null; hasAvatar: boolean; avatarVer: number; trades: number; equity: number | null; pnlPct: number | null; winRate: number | null; coins: number; cards: number; friends: number }
export interface AdminEvent {
  type: 'signup' | 'trade' | 'thesis' | 'swap' | 'boost' | 'payment' | 'card' | 'coins'; t: number; text: string;
  user?: string | null; wallet?: string; side?: string; symbol?: string | null; mint?: string; usd?: number; price?: number; pnl?: number | null; bull?: boolean;
  status?: string; signature?: string | null; inAmount?: number | null; fee?: number | null; feeSymbol?: string | null; usdc?: number | null; delta?: number; error?: string | null;
}
export const adminOverview = (token: string, days: number) => apiCall<AdminOverview>(`/admin/overview?days=${days}`, { token });
export const adminUsers = (token: string, o: { q?: string; sort?: string; offset?: number }) => apiCall<{ total: number; offset: number; users: AdminUser[] }>(`/admin/users?${new URLSearchParams({ q: o.q || '', sort: o.sort || 'new', offset: String(o.offset || 0) })}`, { token });
export const adminLog = (token: string, type: string, before?: number) => apiCall<{ type: string; events: AdminEvent[]; next: number | null }>(`/admin/log?type=${encodeURIComponent(type)}${before ? `&before=${before}` : ''}`, { token });

// ---- admin controls -------------------------------------------------------------------------------------------------
export interface AdminSwitch { id: 'swaps' | 'boost' | 'signups' | 'vault'; label: string; help: string; paused: boolean; serverSwitch: 'on' | 'off' | null; running: boolean; updatedAt: number | null; updatedBy: string | null }
export interface Switches { ready: boolean; migration: string | null; switches: AdminSwitch[] }
export const adminSwitches = (token: string) => apiCall<Switches>('/admin/switches', { token });
export const adminSetSwitch = (token: string, id: string, paused: boolean, reason: string) => apiCall<Switches>('/admin/switches', { body: { id, paused, reason }, token });

type Totals = { today: number; d7: number; d30: number; all: number };
export interface AdminRevenue {
  generatedAt: number; days: number;
  swapFees: { sol: Totals; usdc: Totals; swaps: number }; boost: { usdc: Totals; orders: number };
  dailySwapFeesSol: Daily[]; dailySwapFeesUsdc: Daily[]; dailyBoostUsdc: Daily[];
  byPackage: { package: string; orders: number; usdc: number }[]; refundsOwed: { orders: number; usdc: number }; testPayments: number;
  live: { swaps: boolean; boost: boolean };
}
export interface WalletBalance { label: string; address: string; kind: string; amount: number | null; symbol?: string; error?: string }
export const adminRevenue = (token: string, days: number) => apiCall<AdminRevenue>(`/admin/revenue?days=${days}`, { token });
export const adminWallets = (token: string) => apiCall<{ at: number; accounts: WalletBalance[]; note?: string }>('/admin/revenue/wallets', { token, timeoutMs: 30_000 });

export interface BlockedToken { mint: string; symbol: string | null; reason: string; createdAt: number; createdBy: string }
export interface Blocklist { ready: boolean; migration?: string; tokens: BlockedToken[]; affectedBoosts?: { id: string; symbol: string | null; status: string }[] }
export const adminBlocklist = (token: string) => apiCall<Blocklist>('/admin/blocklist', { token });
export const adminBlockToken = (token: string, b: { mint: string; symbol?: string; reason: string }) => apiCall<Blocklist>('/admin/blocklist', { body: b, token });
export const adminUnblockToken = (token: string, mint: string) => apiCall<Blocklist>('/admin/blocklist/remove', { body: { mint }, token });
/** public: tokens the admins hid from the app */
export const getBlocklist = () => apiCall<{ mints: string[]; at: number }>('/blocklist');

type Leader = { username: string; value: number; extra: number | null };
export interface AdminUserStats {
  generatedAt: number; total: number; dau: number; wau: number; mau: number; stickiness: number | null;
  retention: Record<'d1' | 'd7' | 'd30', { pct: number | null; base: number }>;
  engagement: { none: number; some: number; regular: number; heavy: number };
  profiles: { withPicture: number; withBio: number }; activeHoursUtc: number[];
  leaders: { pnl: Leader[]; trades30d: Leader[]; coins: Leader[]; friends: Leader[] };
}
export const adminUserStats = (token: string) => apiCall<AdminUserStats>('/admin/user-stats', { token });

export interface AdminCard { id: string; series: string; no: number; mode: string; rarity: 'common' | 'rare' | 'gem'; price: number; minted: number; lastSale: number | null; paused: boolean; dropAt: number | null; status: 'on_sale' | 'paused' | 'scheduled' | 'sold_out' }
export interface AdminVault {
  ready: boolean; migration: string | null; now: number; supply: number;
  series: Record<string, { label: string }>; rarities: Record<string, { label: string; price: number }>;
  cards: AdminCard[];
  coins: { issued: number; spent: number; circulating: number; adjusted: number };
  challenges: { id: string; title: string; defaultReward: number; reward: number }[];
  adjustments: { username: string | null; delta: number; t: number }[];
}
export const adminVault = (token: string) => apiCall<AdminVault>('/admin/vault', { token });
export const adminSetCard = (token: string, card: string, paused: boolean, dropAt: number | null) => apiCall<{ ok: true }>('/admin/vault/card', { body: { card, paused, dropAt }, token });
export const adminAdjustCoins = (token: string, username: string, delta: number, reason: string) => apiCall<{ username: string; balance: number }>('/admin/vault/coins', { body: { username, delta, reason }, token });
export const adminSetRewards = (token: string, rewards: Record<string, number>) => apiCall<{ ok: true }>('/admin/vault/rewards', { body: { rewards }, token });

export interface AuditEntry { id: number; t: number; admin: string; action: string; target: string | null; detail: Record<string, any> | null }
export const adminAudit = (token: string, group: string, before?: number) => apiCall<{ ready: boolean; migration?: string; entries: AuditEntry[]; next: number | null }>(`/admin/audit?group=${encodeURIComponent(group)}${before ? `&before=${before}` : ''}`, { token });

/** random idempotency key (letters/digits, 24 chars) */
export const newKey = () => { const a = crypto.getRandomValues(new Uint8Array(18)); return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join(''); };
