/**
 * Browser client for the BAGZ Worker's /v1/investigate routes.
 *  - Only the deployed BAGZ server is used. The test copy (in-page demo server) is refused up front: investigation never
 *    shows simulated data.
 *  - Every answer is contract-checked (validate.ts) before it is returned.
 *  - Identical requests in flight are shared; each caller can cancel with its own AbortSignal and the network request is
 *    cancelled once nobody is waiting for it. Answers are reused for CLIENT_TTL_MS unless the caller forces a refresh.
 */
import { proxyBase } from '../providers/config';
import { demo } from '../demo/hook';
import { B58, ContractError, validateActivity, validateHolders } from './validate';
import type { ActivityResponse, HoldersResponse, InvestigateErrorCode } from './types';

export class InvestigateError extends Error {
  constructor(public code: InvestigateErrorCode | 'not_deployed', message: string, public status = 0, public retryAfter?: number) { super(message); this.name = 'InvestigateError'; }
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (u, i) => fetch(u, i);
let nowImpl = () => Date.now();
const CLIENT_TTL_MS = 45_000;
const TIMEOUT_MS = 30_000;

interface Flight { promise: Promise<unknown>; ctrl: AbortController; waiters: number }
const cache = new Map<string, { at: number; data: unknown }>();
const flights = new Map<string, Flight>();

/** tests only */
export function __setInvestigateDeps(d: { fetch?: FetchFn; now?: () => number }) { if (d.fetch) fetchImpl = d.fetch; if (d.now) nowImpl = d.now; clearInvestigateCache(); }
export function clearInvestigateCache() { cache.clear(); for (const f of flights.values()) f.ctrl.abort(); flights.clear(); }
export const inflightCount = () => flights.size;

/** why investigation can't run on this page at all (null = it can) */
export function unavailableReason(): InvestigateError | null {
  if (demo()) return new InvestigateError('demo_unavailable', 'Investigation isn’t available in the test copy. It needs the deployed BAGZ server with a Solana RPC key, and nothing here is simulated.');
  if (!proxyBase()) return new InvestigateError('no_server', 'This page isn’t connected to the BAGZ server, so on-chain investigation isn’t available here.');
  return null;
}

const KNOWN: Record<string, InvestigateErrorCode | 'not_deployed'> = {
  provider_not_configured: 'provider_not_configured', provider_auth: 'provider_auth', demo_unavailable: 'demo_unavailable',
  invalid_mint: 'invalid_mint', invalid_account: 'invalid_account', account_not_found: 'account_not_found', account_mint_mismatch: 'account_mint_mismatch',
  provider_rate_limited: 'rate_limited', rate_limited: 'rate_limited', budget_exhausted: 'rate_limited',
  provider_timeout: 'timeout', provider_error: 'provider_error', provider_unreachable: 'provider_error', provider_rpc_error: 'provider_error',
  provider_malformed: 'provider_error', provider_min_context_slot: 'provider_error',
};

async function getJSON(path: string, signal: AbortSignal): Promise<unknown> {
  const gate = unavailableReason();
  if (gate) throw gate;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await fetchImpl(`${proxyBase()}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
  } catch (e: any) {
    if (signal.aborted) throw new InvestigateError('aborted', 'Cancelled');
    if (timedOut || e?.name === 'AbortError') throw new InvestigateError('timeout', 'The BAGZ server took too long to answer.');
    throw new InvestigateError('network', 'Couldn’t reach the BAGZ server.');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
  let text = '';
  try { text = await res.text(); } catch { if (signal.aborted) throw new InvestigateError('aborted', 'Cancelled'); }
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok) {
    const code = body && typeof body.code === 'string' ? body.code : '';
    const msg = body && typeof body.error === 'string' ? body.error.slice(0, 300) : `The BAGZ server answered HTTP ${res.status}.`;
    const ra = Number(res.headers.get('retry-after') || body?.retryAfter);
    const retry = Number.isFinite(ra) && ra > 0 ? ra : undefined;
    if (KNOWN[code]) throw new InvestigateError(KNOWN[code], msg, res.status, retry);
    if (res.status === 403) throw new InvestigateError('origin_refused', `The BAGZ server refused this site (${msg}). Its ALLOWED_ORIGINS must include this page’s address.`, 403);
    if (res.status === 404) throw new InvestigateError('not_deployed', 'This BAGZ server doesn’t have the investigation routes yet. Deploy the updated Worker.', 404);
    if (res.status === 429) throw new InvestigateError('rate_limited', msg, 429, retry);
    if (res.status === 504) throw new InvestigateError('timeout', msg, 504);
    if (res.status >= 500) throw new InvestigateError('provider_error', msg, res.status);
    throw new InvestigateError('unknown', msg, res.status);
  }
  if (body === null) throw new InvestigateError('malformed', 'The BAGZ server answered with something that is not JSON.', res.status);
  return body;
}

/** shares one network request between callers; it is cancelled only when every caller has gone */
function join<T>(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  let f = flights.get(key);
  if (!f) {
    const ctrl = new AbortController();
    const fl: Flight = { promise: Promise.resolve(), ctrl, waiters: 0 };
    fl.promise = start(ctrl.signal).finally(() => { if (flights.get(key) === fl) flights.delete(key); });
    fl.promise.catch(() => { /* observed by the waiters */ });
    flights.set(key, fl);
    f = fl;
  }
  const fl = f;
  fl.waiters++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const leave = () => { done = true; fl.waiters--; signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => {
      if (done) return;
      leave();
      if (fl.waiters <= 0) { fl.ctrl.abort(); if (flights.get(key) === fl) flights.delete(key); }
      reject(new InvestigateError('aborted', 'Cancelled'));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    (fl.promise as Promise<T>).then((v) => { if (!done) { leave(); resolve(v); } }, (e) => { if (!done) { leave(); reject(e); } });
  });
}

export interface Loaded<T> { data: T; receivedAt: number; fromClientCache: boolean }

async function load<T>(path: string, check: (j: unknown) => T, o: { signal?: AbortSignal; force?: boolean }): Promise<Loaded<T>> {
  const hit = cache.get(path);
  if (!o.force && hit && nowImpl() - hit.at < CLIENT_TTL_MS) return { data: hit.data as T, receivedAt: hit.at, fromClientCache: true };
  const data = await join(path, async (signal) => {
    const j = await getJSON(path, signal);
    try { return check(j); } catch (e) {
      if (e instanceof ContractError) throw new InvestigateError('malformed', `The BAGZ server answered in an unexpected format (${e.message}), so nothing is drawn.`);
      throw e;
    }
  }, o.signal);
  const at = nowImpl();
  cache.set(path, { at, data });
  if (cache.size > 60) cache.delete(cache.keys().next().value as string);
  return { data, receivedAt: at, fromClientCache: false };
}

export function loadHolders(mint: string, o: { signal?: AbortSignal; force?: boolean } = {}): Promise<Loaded<HoldersResponse>> {
  if (!B58.test(mint)) return Promise.reject(new InvestigateError('invalid_mint', 'This token’s address is not a valid Solana mint address.'));
  return load(`/v1/investigate/holders?mint=${encodeURIComponent(mint)}`, (j) => validateHolders(j, mint), o);
}

export function loadActivity(mint: string, account: string, o: { signal?: AbortSignal; force?: boolean; before?: string | null } = {}): Promise<Loaded<ActivityResponse>> {
  if (!B58.test(mint)) return Promise.reject(new InvestigateError('invalid_mint', 'This token’s address is not a valid Solana mint address.'));
  if (!B58.test(account)) return Promise.reject(new InvestigateError('invalid_account', 'That token account address is not valid.'));
  const q = new URLSearchParams({ mint, account, ...(o.before ? { before: o.before } : {}) });
  return load(`/v1/investigate/activity?${q}`, (j) => validateActivity(j, mint, account), o);
}

/** plain-language explanation for each failure state */
export function explain(e: unknown): { title: string; body: string; retry: boolean } {
  const x = e instanceof InvestigateError ? e : new InvestigateError('unknown', e instanceof Error ? e.message : 'Something went wrong.');
  switch (x.code) {
    case 'demo_unavailable': return { title: 'Not available in the test copy', body: x.message, retry: false };
    case 'no_server': return { title: 'BAGZ server not connected', body: x.message, retry: false };
    case 'not_deployed': return { title: 'Server not updated yet', body: x.message, retry: true };
    case 'provider_not_configured': return { title: 'Solana RPC key missing on the server', body: 'The BAGZ server has no HELIUS_API_KEY (or SOLANA_RPC_URL) secret, so it can’t read holders. Nothing is shown in place of real data.', retry: false };
    case 'provider_auth': return { title: 'The Solana RPC refused the server’s key', body: `${x.message} The key may be wrong, expired, or its plan may not allow this method.`, retry: true };
    case 'rate_limited': return { title: 'Rate limited', body: `${x.message}${x.retryAfter ? ` Try again in about ${Math.ceil(x.retryAfter)} s.` : ''}`, retry: true };
    case 'timeout': return { title: 'Timed out', body: x.message, retry: true };
    case 'network': return { title: 'Couldn’t reach the BAGZ server', body: 'Check your connection and try again.', retry: true };
    case 'provider_error': return { title: 'The Solana RPC didn’t answer properly', body: x.message, retry: true };
    case 'malformed': return { title: 'Unexpected answer', body: x.message, retry: true };
    case 'invalid_mint': return { title: 'Not a token mint', body: x.message, retry: false };
    case 'invalid_account': case 'account_mint_mismatch': return { title: 'Can’t use that token account', body: x.message, retry: false };
    case 'account_not_found': return { title: 'Token account not found', body: x.message, retry: false };
    case 'origin_refused': return { title: 'This site isn’t allowed by the server', body: x.message, retry: false };
    default: return { title: 'Something went wrong', body: x.message, retry: true };
  }
}
