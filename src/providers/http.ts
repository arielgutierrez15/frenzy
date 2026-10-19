/**
 * Shared HTTP core for every provider: response cache, in-flight de-duplication, token-bucket rate limiting with
 * priorities, timeouts, retries with backoff, 429 cool-downs, host fallback, validation and health tracking.
 * It never throws. Callers get `{ ok: true, data, fetchedAt, stale }` or `{ ok: false, error }`.
 * Nothing is invented: a stale answer is returned only if it is flagged `stale` and carries its real `fetchedAt`.
 */
import { PROVIDERS, SOURCES, SOURCE_LABELS, type ProviderId, type SourceId } from './registry';
import { proxyBase } from './config';

export type ErrorKind = 'network' | 'timeout' | 'http' | 'rate-limited' | 'invalid' | 'cooldown';
export interface HttpError { kind: ErrorKind; message: string; status?: number; retryAfterMs?: number }
export interface Ok<T> { ok: true; data: T; fetchedAt: number; stale: boolean; cached: boolean; via: 'proxy' | 'direct'; host: string; ms: number }
export interface Fail { ok: false; error: HttpError }
export type Result<T> = Ok<T> | Fail;

export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export interface RequestOpts<T> {
  source: SourceId;
  /** path under the provider root, e.g. `/networks/solana/new_pools` */
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  /** 0 = user is waiting (open chart, trade ticket), 1 = visible data, 2 = background polling */
  prio?: 0 | 1 | 2;
  /** skip the cache and fetch now */
  force?: boolean;
  ttlMs?: number;
  validate?: (json: unknown) => T;
}

export interface Deps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** schedules the limiter's wake-up; tests replace it so they don't wait in real time */
  timer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}
let deps: Deps = {
  fetch: (u, i) => fetch(u, i),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
  timer: (fn, ms) => setTimeout(fn, ms),
};
export function __setDeps(d: Partial<Deps>) { deps = { ...deps, ...d }; }

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
export type HealthStatus = 'idle' | 'ok' | 'stale' | 'rate-limited' | 'down';
export interface SourceHealth {
  source: SourceId;
  provider: ProviderId;
  label: string;
  status: HealthStatus;
  lastOkAt?: number;
  lastAttemptAt?: number;
  lastError?: string;
  errorKind?: ErrorKind;
  httpStatus?: number;
  latencyMs?: number;
  via?: 'proxy' | 'direct';
  host?: string;
  okCount: number;
  failCount: number;
  consecutiveFailures: number;
  servedStale: boolean;
}

const health = new Map<SourceId, SourceHealth>();
const subs = new Set<() => void>();
export function subscribeHealth(fn: () => void) { subs.add(fn); return () => { subs.delete(fn); }; }
let hv = 0;
export const healthVersion = () => hv;
const poke = () => { hv++; subs.forEach((f) => f()); };

function h(source: SourceId): SourceHealth {
  let x = health.get(source);
  if (!x) {
    x = { source, provider: SOURCES[source].provider, label: SOURCE_LABELS[source], status: 'idle', okCount: 0, failCount: 0, consecutiveFailures: 0, servedStale: false };
    health.set(source, x);
  }
  return x;
}
export function getHealth(source?: SourceId): SourceHealth[] {
  if (source) return [h(source)];
  return [...health.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.label.localeCompare(b.label));
}

function markOk(source: SourceId, ms: number, via: 'proxy' | 'direct', host: string, at: number) {
  const x = h(source);
  x.status = 'ok'; x.lastOkAt = at; x.lastAttemptAt = at; x.lastError = undefined; x.errorKind = undefined; x.httpStatus = undefined;
  x.latencyMs = x.latencyMs === undefined ? ms : Math.round(x.latencyMs * 0.6 + ms * 0.4);
  x.via = via; x.host = host; x.okCount++; x.consecutiveFailures = 0; x.servedStale = false;
  poke();
}
function markFail(source: SourceId, err: HttpError, servedStale: boolean) {
  const x = h(source);
  x.lastAttemptAt = deps.now(); x.lastError = err.message; x.errorKind = err.kind; x.httpStatus = err.status;
  x.failCount++; x.consecutiveFailures++; x.servedStale = servedStale;
  x.status = err.kind === 'rate-limited' || err.kind === 'cooldown' ? 'rate-limited' : servedStale ? 'stale' : 'down';
  poke();
}

// ---------------------------------------------------------------------------
// cache + de-duplication
// ---------------------------------------------------------------------------
interface Entry { t: number; data: unknown; via: 'proxy' | 'direct'; host: string }
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Result<any>>>();
const CACHE_MAX = 400;

function remember(key: string, e: Entry) {
  cache.delete(key);
  cache.set(key, e);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

// ---------------------------------------------------------------------------
// rate limiting: token bucket + priority queue + concurrency cap
// ---------------------------------------------------------------------------
interface Waiter { prio: number; seq: number; resolve: (release: () => void) => void }
class Limiter {
  tokens: number; last: number; active = 0; seq = 0; queue: Waiter[] = []; timer: ReturnType<typeof setTimeout> | null = null;
  constructor(public rate: number, public burst: number, public maxConcurrent: number) { this.tokens = burst; this.last = deps.now(); }
  private refill() {
    const n = deps.now();
    this.tokens = Math.min(this.burst, this.tokens + ((n - this.last) / 1000) * this.rate);
    this.last = n;
  }
  /** rough wait before a new request would start */
  eta(): number {
    this.refill();
    const need = this.queue.length + 1 - this.tokens;
    return need <= 0 ? 0 : Math.ceil((need / this.rate) * 1000);
  }
  acquire(prio: number): Promise<() => void> {
    return new Promise((resolve) => { this.queue.push({ prio, seq: this.seq++, resolve }); this.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq); this.pump(); });
  }
  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.refill();
    while (this.queue.length && this.active < this.maxConcurrent && this.tokens >= 1) {
      const w = this.queue.shift()!;
      this.tokens -= 1; this.active++;
      let done = false;
      w.resolve(() => { if (done) return; done = true; this.active--; this.pump(); });
    }
    if (this.queue.length && this.active < this.maxConcurrent && this.tokens < 1) {
      this.timer = deps.timer(() => this.pump(), Math.max(20, Math.ceil(((1 - this.tokens) / this.rate) * 1000)));
    }
  }
  depth() { return this.queue.length + this.active; }
}
const limiters = new Map<string, Limiter>();
function limiterFor(p: ProviderId, via: 'proxy' | 'direct'): Limiter {
  const k = `${p}:${via}`;
  let l = limiters.get(k);
  if (!l) { const s = PROVIDERS[p]; const b = via === 'proxy' ? s.proxied : s.direct; l = new Limiter(b.rate, b.burst, s.maxConcurrent); limiters.set(k, l); }
  return l;
}
/** How many requests are waiting on a provider right now (background pollers back off when it is busy). */
export function queueDepth(p: ProviderId): number {
  return (limiters.get(`${p}:${proxyBase() ? 'proxy' : 'direct'}`)?.depth()) ?? 0;
}

// ---------------------------------------------------------------------------
// provider cool-downs after 429 and the active upstream host
// ---------------------------------------------------------------------------
const cooldown = new Map<ProviderId, { until: number; strikes: number }>();
const activeHost = new Map<ProviderId, { idx: number; since: number }>();
export function cooldownUntil(p: ProviderId): number { return cooldown.get(p)?.until ?? 0; }

export function __reset() {
  cache.clear(); inflight.clear(); limiters.clear(); cooldown.clear(); activeHost.clear(); health.clear();
}

const MAX_QUEUE_WAIT_MS = 20_000;

function buildUrl(p: ProviderId, path: string, via: 'proxy' | 'direct', hostIdx: number): { url: string; host: string } {
  if (via === 'proxy') return { url: `${proxyBase()}/p/${p}${path}`, host: new URL(proxyBase()!).host };
  const root = PROVIDERS[p].hosts[hostIdx];
  return { url: `${root}${path}`, host: new URL(root).host };
}

function classify(status: number, retryAfter: string | null): HttpError {
  if (status === 429) {
    const s = retryAfter ? parseFloat(retryAfter) : NaN;
    return { kind: 'rate-limited', status, message: 'Rate limited (HTTP 429)', retryAfterMs: isFinite(s) ? Math.min(s * 1000, 300_000) : undefined };
  }
  return { kind: 'http', status, message: `HTTP ${status}` };
}

async function once(o: RequestOpts<unknown>, via: 'proxy' | 'direct', hostIdx: number, timeoutMs: number): Promise<{ ok: true; json: unknown; ms: number; host: string } | { ok: false; error: HttpError; host: string }> {
  const p = SOURCES[o.source].provider;
  const { url, host } = buildUrl(p, o.path, via, hostIdx);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = deps.now();
  try {
    const init: RequestInit = { method: o.method || 'GET', signal: ctrl.signal, cache: 'no-store', headers: { accept: 'application/json' } };
    if (o.body !== undefined) { init.body = JSON.stringify(o.body); (init.headers as Record<string, string>)['content-type'] = 'application/json'; }
    const res = await deps.fetch(url, init);
    if (!res.ok) {
      let msg = '';
      if (via === 'proxy') { try { const j = await res.json(); msg = typeof j?.error === 'string' ? j.error : ''; } catch { /* ignore */ } }
      const e = classify(res.status, res.headers?.get?.('retry-after') ?? null);
      if (msg) e.message = `${e.message}: ${msg}`;
      return { ok: false, error: e, host };
    }
    let json: unknown;
    try { json = await res.json(); } catch { return { ok: false, error: { kind: 'invalid', message: 'Response was not JSON (blocked or error page)' }, host }; }
    return { ok: true, json, ms: deps.now() - t0, host };
  } catch (e: any) {
    if (e?.name === 'AbortError') return { ok: false, error: { kind: 'timeout', message: 'Timed out' }, host };
    return { ok: false, error: { kind: 'network', message: via === 'proxy' ? 'BAGZ proxy unreachable' : 'Blocked, offline or refused by the provider (CORS)' }, host };
  } finally {
    clearTimeout(timer);
  }
}

async function run<T>(o: RequestOpts<T>, key: string, ttlStale: number): Promise<Result<T>> {
  const spec = SOURCES[o.source];
  const prov = PROVIDERS[spec.provider];
  const via: 'proxy' | 'direct' = proxyBase() ? 'proxy' : 'direct';
  const prio = o.prio ?? 1;

  const stale = (err: HttpError): Result<T> => {
    const hit = cache.get(key);
    if (hit && ttlStale > 0 && deps.now() - hit.t <= ttlStale) {
      markFail(o.source, err, true);
      return { ok: true, data: hit.data as T, fetchedAt: hit.t, stale: true, cached: true, via: hit.via, host: hit.host, ms: 0 };
    }
    markFail(o.source, err, false);
    return { ok: false, error: err };
  };

  const cd = cooldown.get(spec.provider);
  if (cd && cd.until > deps.now()) {
    return stale({ kind: 'cooldown', message: `${prov.label} asked us to slow down; retrying in ${Math.ceil((cd.until - deps.now()) / 1000)}s`, retryAfterMs: cd.until - deps.now() });
  }

  const limiter = limiterFor(spec.provider, via);
  let last: HttpError = { kind: 'network', message: 'No attempt made' };

  for (let attempt = 0; attempt <= spec.retries; attempt++) {
    if (prio > 0 && limiter.eta() > MAX_QUEUE_WAIT_MS) {
      return stale({ kind: 'rate-limited', message: `${prov.label} call budget used up; skipped to stay under its rate limit` });
    }
    // direct mode may fall back across hosts (e.g. api.jup.ag then lite-api.jup.ag)
    // Never fall back across hosts for POSTs or swap calls: re-sending a swap to a second host could execute it twice.
    const pinned = via === 'proxy' || o.method === 'POST' || o.path.startsWith('/swap/');
    const hosts = pinned ? [0] : prov.hosts.map((_, i) => i);
    const ah = activeHost.get(spec.provider);
    const start = !pinned && ah && deps.now() - ah.since < 5 * 60_000 ? ah.idx : 0;
    const order = hosts.map((_, i) => hosts[(i + start) % hosts.length]);
    let result: Awaited<ReturnType<typeof once>> | undefined;
    for (const hi of order) {
      const release = await limiter.acquire(prio);
      try { result = await once(o as RequestOpts<unknown>, via, hi, spec.timeoutMs); } finally { release(); }
      if (result.ok) { if (!pinned) activeHost.set(spec.provider, { idx: hi, since: hi === 0 ? 0 : deps.now() }); break; }
      // only try another host when this one looks broken, not when it is rate limiting us
      if (result.error.kind === 'rate-limited') break;
    }
    if (result && result.ok) {
      let data: T;
      try { data = o.validate ? o.validate(result.json) : (result.json as T); }
      catch (e: any) {
        const err: HttpError = { kind: 'invalid', message: `Unexpected response shape: ${e?.message || 'invalid'}` };
        return stale(err);
      }
      const at = deps.now();
      remember(key, { t: at, data, via, host: result.host });
      cooldown.delete(spec.provider);
      markOk(o.source, result.ms, via, result.host, at);
      return { ok: true, data, fetchedAt: at, stale: false, cached: false, via, host: result.host, ms: result.ms };
    }
    last = result ? result.error : last;
    if (last.kind === 'rate-limited') {
      const strikes = (cooldown.get(spec.provider)?.strikes ?? 0) + 1;
      const wait = last.retryAfterMs ?? Math.min(15_000 * 2 ** (strikes - 1), 120_000);
      cooldown.set(spec.provider, { until: deps.now() + wait, strikes });
      if (wait <= 2500 && attempt < spec.retries) { await deps.sleep(wait); continue; }
      break;
    }
    if (last.kind === 'invalid') break;
    if (last.kind === 'http' && last.status && last.status < 500) break; // 4xx other than 429: retrying won't help
    if (attempt < spec.retries) await deps.sleep(Math.round(400 * 2 ** attempt * (0.75 + deps.random() * 0.5)));
  }
  return stale(last);
}

export function request<T = unknown>(o: RequestOpts<T>): Promise<Result<T>> {
  const spec = SOURCES[o.source];
  const key = `${o.method || 'GET'} ${spec.provider} ${o.path}${o.body !== undefined ? ' ' + JSON.stringify(o.body) : ''}`;
  const ttl = o.ttlMs ?? spec.ttlMs;
  const hit = cache.get(key);
  if (!o.force && hit && deps.now() - hit.t < ttl) {
    return Promise.resolve({ ok: true, data: hit.data as T, fetchedAt: hit.t, stale: false, cached: true, via: hit.via, host: hit.host, ms: 0 });
  }
  const running = inflight.get(key);
  if (running) return running as Promise<Result<T>>;
  const p = run<T>(o, key, spec.staleOkMs).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}
