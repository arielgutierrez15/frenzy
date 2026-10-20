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
export interface AdminPromotion extends Order { payment: { signature: string; payer: string; amount_raw: string; block_time: number | null } | null; stats: { impressions: number; clicks: number }; reviewedBy: string | null }
export const adminChallenge = (wallet: string) => apiCall<{ nonce: string; message: string }>('/admin/challenge', { body: { wallet } });
export const adminSession = (wallet: string, nonce: string, signature: string) => apiCall<{ token: string; wallet: string; expiresAt: number }>('/admin/session', { body: { wallet, nonce, signature } });
export const adminPromotions = (token: string, status: string) => apiCall<{ promotions: AdminPromotion[] }>(`/admin/promotions?status=${encodeURIComponent(status)}`, { token });
export const adminDecide = (token: string, id: string, action: 'approve' | 'reject', b: { startsAt?: number; note?: string }) => apiCall<{ order: Order }>(`/admin/promotions/${id}/${action}`, { body: b, token });

/** random idempotency key (letters/digits, 24 chars) */
export const newKey = () => { const a = crypto.getRandomValues(new Uint8Array(18)); return Array.from(a, (b) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'[b & 63]).join(''); };
