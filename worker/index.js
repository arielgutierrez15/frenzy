/**
 * BAGZ proxy — a Cloudflare Worker that sits between the BAGZ web app and the market-data providers.
 *
 *  - Keeps API keys server-side (Jupiter, CoinGecko/GeckoTerminal, your Solana RPC). The browser never sees them.
 *  - Adds CORS for your site only (ALLOWED_ORIGINS) and refuses every /p/ request that has no allowed Origin, so providers
 *    that block browsers can still be used but the proxy is not a free API for scripts. (Deploy checks use the PROBE_TOKEN secret.)
 *  - Validates every query string (names and values), caps request/response sizes and keeps a per-provider upstream budget,
 *    so one visitor cannot burn your Jupiter / CoinGecko / RPC quota.
 *  - Caches answers at the edge and de-duplicates upstream calls, so many visitors share one provider budget.
 *  - Only forwards an allowlist of read-only paths. It is not an open proxy and it never signs transactions. The /p/ routes
 *    send nothing on-chain (the only POST is four read-only RPC methods). Real swaps go through /v1/swap (api.js), which
 *    builds them with the BAGZ fee and only relays a transaction the wallet signed unchanged.
 *
 * Routes:  GET /health   ·   GET|POST /p/<provider>/<path…>   with provider in jup | gt | ds | pump | rug | rpc
 *          GET|POST /v1/…   swaps with the BAGZ fee, BOOST listings, admin review (see api.js; needs the D1 binding "Db")
 */
import { api, ApiError, publicConfig } from './api.js';
import { avatarResponse } from './social.js';

const VERSION = '1.2.0';
const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const ADDR = '[A-Za-z0-9]{20,64}';
const DIG = /^\d{1,6}$/;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINTS = /^[1-9A-HJ-NP-Za-km-z]{32,44}(,[1-9A-HJ-NP-Za-km-z]{32,44}){0,49}$/;
const GTQ = { aggregate: /^\d{1,3}$/, limit: DIG, currency: /^(usd|token)$/, token: /^(base|quote)$/, before_timestamp: /^\d{1,12}$/, include: /^[a-z_,]{1,60}$/, page: /^\d{1,3}$/ };
const AMOUNT = /^\d{1,24}$/;

const PROVIDERS = {
  jup: {
    base: () => 'https://api.jup.ag',
    auth: (env, h) => { if (env.JUPITER_API_KEY) h.set('x-api-key', env.JUPITER_API_KEY); },
    allow: [
      { re: /^\/tokens\/v2\/(recent|toptrending\/\w+|toporganicscore\/\w+|toptraded\/\w+|search|tag|category\/\w+\/\w+)$/, ttl: 30, q: { query: /^[\w.,:\-]{1,200}$/, limit: DIG } },
      { re: /^\/price\/v3$/, ttl: 15, q: { ids: MINTS } },
      { re: /^\/swap\/v2\/order$/, ttl: 0, q: { inputMint: MINT, outputMint: MINT, amount: AMOUNT, taker: MINT, slippageBps: /^\d{1,5}$/ }, need: ['inputMint', 'outputMint', 'amount'] },
    ],
  },
  gt: {
    base: (env) => env.COINGECKO_API_KEY
      ? (env.COINGECKO_PLAN === 'pro' ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.coingecko.com/api/v3/onchain')
      : 'https://api.geckoterminal.com/api/v2',
    auth: (env, h) => { if (env.COINGECKO_API_KEY) h.set(env.COINGECKO_PLAN === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key', env.COINGECKO_API_KEY); },
    allow: [
      { re: new RegExp(`^/networks/[a-z0-9_-]+/pools/${ADDR}/ohlcv/(second|minute|hour|day)$`), ttl: 15, q: GTQ },
      { re: new RegExp(`^/networks/[a-z0-9_-]+/pools/${ADDR}/trades$`), ttl: 15, q: GTQ },
      { re: new RegExp(`^/networks/[a-z0-9_-]+/tokens/${ADDR}/pools$`), ttl: 300, q: GTQ },
      { re: /^\/networks\/([a-z0-9_-]+\/)?(new_pools|trending_pools)$/, ttl: 45, q: GTQ },
    ],
  },
  ds: {
    base: () => 'https://api.dexscreener.com',
    allow: [
      { re: /^\/token-profiles\/latest\/v1$/, ttl: 45, q: {} },
      { re: /^\/token-boosts\/(top|latest)\/v1$/, ttl: 45, q: {} },
      { re: new RegExp(`^/tokens/v1/[a-z0-9]+/(${ADDR})(,${ADDR}){0,29}$`), ttl: 6, q: {} },
    ],
  },
  pump: {
    base: () => 'https://frontend-api-v3.pump.fun',
    // pump.fun publishes no API; it only answers requests that look like its own website
    auth: (_env, h) => { h.set('origin', 'https://pump.fun'); h.set('referer', 'https://pump.fun/'); h.set('user-agent', 'Mozilla/5.0 (compatible; BAGZ-proxy)'); },
    allow: [{ re: /^\/coins(\/currently-live)?$/, ttl: 20, q: { offset: /^\d{1,5}$/, limit: /^\d{1,3}$/, sort: /^[a-z_]{1,32}$/, order: /^(ASC|DESC)$/, includeNsfw: /^(true|false)$/ } }],
  },
  rug: {
    base: () => 'https://api.rugcheck.xyz',
    allow: [{ re: new RegExp(`^/v1/tokens/${B58}/report/summary$`), ttl: 300 }],
  },
  rpc: {
    base: (env) => env.SOLANA_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}` : 'https://api.mainnet-beta.solana.com'),
    allow: [{ re: /^$/, ttl: 60, method: 'POST', q: {}, rpc: ['getTokenLargestAccounts', 'getTokenSupply', 'getLatestBlockhash', 'getSignatureStatuses'] }],
  },
};

// ---- abuse protection ------------------------------------------------------------------------------------------
// In-memory counters live per Worker instance, so they are best effort. For a hard limit bind Cloudflare's Rate Limiting
// (see wrangler.toml: env.RATE_LIMITER) — it is used automatically when present.
const hits = new Map();
function over(bucket, max, windowMs = 60_000, now = Date.now()) {
  const e = hits.get(bucket);
  if (!e || now - e.t > windowMs) { hits.set(bucket, { t: now, n: 1 }); if (hits.size > 8000) { for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); if (hits.size > 8000) hits.clear(); } return false; }
  e.n++;
  return e.n > max;
}
const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
/** upstream calls per minute this Worker instance may make to each provider (cache hits do not count) */
function budget(id, env) {
  const d = { jup: 50, gt: env.COINGECKO_API_KEY ? 80 : 8, ds: 240, pump: 30, rug: 30, rpc: 300 };
  return num(env[`UPSTREAM_PER_MIN_${id.toUpperCase()}`], d[id]);
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://arielgutierrez15.github.io').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean).filter((o) => o !== '*');
}
/** exact match only. No wildcards, no suffix matching, "null" is never allowed. */
function originAllowed(origin, env) {
  if (!origin || origin === 'null') return false;
  if (allowedOrigins(env).includes(origin)) return true;
  return env.ALLOW_LOCALHOST === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

const json = (obj, status, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });
const MAX_BODY = 8_000;
const MAX_RESPONSE = 2_000_000;

/** returns a normalised (sorted) query string, or an error message */
function checkQuery(rule, search) {
  const params = new URLSearchParams(search);
  const spec = rule.q || {};
  const seen = new Set();
  const out = [];
  for (const [k, v] of params) {
    if (!Object.prototype.hasOwnProperty.call(spec, k)) return { error: `Query parameter "${k.slice(0, 40)}" is not allowed` };
    if (seen.has(k)) return { error: `Query parameter "${k}" repeated` };
    seen.add(k);
    if (!spec[k].test(v)) return { error: `Query parameter "${k}" is not valid` };
    out.push([k, v]);
  }
  for (const k of rule.need || []) if (!seen.has(k)) return { error: `Query parameter "${k}" is required` };
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { search: out.length ? '?' + out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '' };
}

const B64 = /^[A-Za-z0-9+/=_-]+$/;
/** the only two POST bodies BAGZ ever sends: a signed Jupiter swap and a read-only RPC call */
function checkBody(rule, text) {
  if (text.length > MAX_BODY) return { status: 413, error: 'Body too large' };
  let j; try { j = JSON.parse(text); } catch { return { status: 400, error: 'Invalid JSON' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { status: 400, error: 'Body must be a JSON object' };
  if (rule.exec) {
    const keys = Object.keys(j).sort().join(',');
    if (keys !== 'requestId,signedTransaction') return { status: 400, error: 'Body must contain exactly signedTransaction and requestId' };
    if (typeof j.signedTransaction !== 'string' || j.signedTransaction.length < 80 || j.signedTransaction.length > 4000 || !B64.test(j.signedTransaction)) return { status: 400, error: 'signedTransaction is not valid' };
    if (typeof j.requestId !== 'string' || !/^[\w-]{4,80}$/.test(j.requestId)) return { status: 400, error: 'requestId is not valid' };
  }
  if (rule.rpc) {
    if (j.jsonrpc !== '2.0' || !rule.rpc.includes(j.method)) return { status: 403, error: 'RPC method not allowed' };
    if (j.params !== undefined && !Array.isArray(j.params)) return { status: 400, error: 'params must be an array' };
    if (Object.keys(j).some((k) => !['jsonrpc', 'id', 'method', 'params'].includes(k))) return { status: 400, error: 'Unexpected RPC field' };
    if (j.method === 'getSignatureStatuses' && (!Array.isArray(j.params?.[0]) || j.params[0].length > 10)) return { status: 400, error: 'At most 10 signatures' };
  }
  return { body: text };
}

export async function handle(request, env, ctx, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const now = deps.now ? deps.now() : Date.now();
  const cache = deps.cache !== undefined ? deps.cache : (typeof caches !== 'undefined' ? caches.default : null);
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const probeOk = !!env.PROBE_TOKEN && sameSecret(request.headers.get('x-bagz-probe') || '', env.PROBE_TOKEN);
  const good = originAllowed(origin, env);

  // a browser from any other site is refused outright
  if (origin && !good) return json({ error: 'Origin not allowed' }, 403);
  const base = {
    ...(good ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '600',
    'access-control-expose-headers': 'x-bagz-cache, x-bagz-upstream-status, x-bagz-limit, retry-after',
    'x-content-type-options': 'nosniff',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: good ? 204 : 403, headers: base });

  if (url.pathname === '/health') {
    const c = publicConfig(env);
    return json({ ok: true, version: VERSION, providers: Object.keys(PROVIDERS), keys: { jupiter: !!env.JUPITER_API_KEY, coingecko: !!env.COINGECKO_API_KEY, rpc: !!(env.SOLANA_RPC_URL || env.HELIUS_API_KEY) }, protection: { origins: allowedOrigins(env).length, rateLimiter: !!env.RATE_LIMITER, probeToken: !!env.PROBE_TOKEN }, features: { liveSwaps: c.liveSwaps, liveBoostPayments: c.liveBoostPayments, feeBps: c.feeBps, database: c.database } }, 200, base);
  }
  // profile pictures are loaded by <img> tags, which send no Origin header; they are public and edge-cached
  const av = /^\/v1\/avatars\/([1-9A-HJ-NP-Za-km-z]{16,32})$/.exec(url.pathname);
  if (av && request.method === 'GET') {
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    if (over(`av:${ip}`, num(env.RATE_AVATAR_PER_MIN, 1200), 60_000, now)) return new Response('Too many requests', { status: 429, headers: { 'retry-after': '30' } });
    const key = new Request(url.toString(), { method: 'GET' });
    if (cache) { const hit = await cache.match(key); if (hit) return hit; }
    try {
      const res = await avatarResponse({ env, now: () => now }, av[1]);
      if (cache && res.status === 200) { const put = cache.put(key, res.clone()); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
      return res;
    } catch { return new Response('Unavailable', { status: 503 }); }
  }
  if (url.pathname.startsWith('/v1/')) {
    if (!good && !probeOk) return json({ error: 'This API only serves the BAGZ web app' }, 403, base);
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    let limited = false;
    if (env.RATE_LIMITER) { try { limited = !(await env.RATE_LIMITER.limit({ key: ip })).success; } catch { /* fall through */ } }
    if (!limited) limited = over(`ip:${ip}`, num(env.RATE_PER_MIN, 240), 60_000, now) || (request.method === 'POST' && over(`post:${ip}`, num(env.RATE_POST_PER_MIN, 20), 60_000, now));
    if (limited) return json({ error: 'Too many requests' }, 429, { ...base, 'retry-after': '30', 'x-bagz-limit': 'client' });
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, base);
    try {
      const out = await api(request, env, { fetch: (u, i) => doFetch(u,i), now: () => (deps.now ? deps.now() : Date.now()), guard: (id) => over(`up:${id}`, budget(id, env), 60_000, deps.now ? deps.now() : Date.now()) });
      return json(out, 200, base);
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message, ...(e.extra || {}) }, e.status, e.status === 429 ? { ...base, 'retry-after': String((e.extra && e.extra.retryAfter) || 20) } : base);
      // never leak internals (RPC URLs carry keys)
      console.error('api error', e && e.message ? String(e.message).replace(/api-key=[^&\s]+/g, 'api-key=…') : e);
      return json({ error: 'Internal error' }, 500, base);
    }
  }
  const m = /^\/p\/([a-z]+)(\/.*)?$/.exec(url.pathname);
  const id = m && Object.prototype.hasOwnProperty.call(PROVIDERS, m[1]) ? m[1] : null;
  if (!id) return json({ error: 'Unknown route' }, 404, base);
  // data routes need an allowed browser origin (or the deploy-check token). A script with no Origin gets nothing.
  if (!good && !probeOk) return json({ error: 'This proxy only serves the BAGZ web app' }, 403, base);
  const prov = PROVIDERS[id];
  const path = m[2] || '';
  const rule = prov.allow.find((r) => r.re.test(path));
  if (!rule) return json({ error: 'Path not allowed' }, 403, base);
  const method = rule.method || 'GET';
  if (request.method !== method) return json({ error: `Use ${method} for this path` }, 405, { ...base, allow: method });
  const q = checkQuery(rule, url.search);
  if (q.error) return json({ error: q.error }, 400, base);

  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  let blocked = false;
  if (env.RATE_LIMITER) { try { blocked = !(await env.RATE_LIMITER.limit({ key: ip })).success; } catch { /* binding trouble: fall through to the local limit */ } }
  if (!blocked) blocked = over(`ip:${ip}`, num(env.RATE_PER_MIN, 240), 60_000, now) || (method === 'POST' && over(`post:${ip}`, num(env.RATE_POST_PER_MIN, 20), 60_000, now));
  if (blocked) return json({ error: 'Too many requests to the BAGZ proxy' }, 429, { ...base, 'retry-after': '30', 'x-bagz-limit': 'client' });

  let body;
  if (method === 'POST') {
    const text = await request.text();
    const b = checkBody(rule, text);
    if (b.error) return json({ error: b.error }, b.status, base);
    body = b.body;
  }

  const upstream = new URL(prov.base(env) + path);
  upstream.search = q.search;
  // cache key: the normalised upstream URL (GET) or a synthetic URL carrying the body (POST); it never includes a secret
  const keyUrl = body !== undefined && rule.ttl > 0 ? `${upstream.toString()}${upstream.search ? '&' : '?'}__body=${encodeURIComponent(body)}` : upstream.toString();
  const key = new Request(keyUrl, { method: 'GET' });
  if (cache && rule.ttl > 0) {
    const hit = await cache.match(key);
    if (hit) { const h = new Headers(hit.headers); for (const [k, v] of Object.entries(base)) h.set(k, v); h.set('x-bagz-cache', 'HIT'); return new Response(hit.body, { status: hit.status, headers: h }); }
  }

  // protect the upstream key / quota: a cache miss spends from this provider's per-minute budget
  if (over(`up:${id}`, budget(id, env), 60_000, now)) return json({ error: `${id} budget for this minute is used up` }, 429, { ...base, 'retry-after': '20', 'x-bagz-limit': 'upstream-budget' });

  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) headers.set('content-type', 'application/json');
  prov.auth?.(env, headers);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let res;
  try { res = await doFetch(upstream.toString(), { method, headers, body, signal: ctrl.signal, redirect: 'manual' }); }
  catch (e) { clearTimeout(timer); return json({ error: e && e.name === 'AbortError' ? 'Upstream timed out' : 'Upstream unreachable' }, e && e.name === 'AbortError' ? 504 : 502, base); }
  clearTimeout(timer);

  if (!res.ok) {
    const extra = { ...base, 'x-bagz-upstream-status': String(res.status) };
    const ra = res.headers.get('retry-after'); if (ra && /^\d{1,5}$/.test(ra)) extra['retry-after'] = ra;
    return json({ error: `Upstream ${res.status}`, upstreamStatus: res.status }, res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status === 404 ? 404 : 502, extra);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE) return json({ error: 'Upstream response too large' }, 502, base);
  // only JSON goes back to the browser, whatever the upstream claims to be
  try { JSON.parse(text); } catch { return json({ error: 'Upstream did not return JSON' }, 502, { ...base, 'x-bagz-upstream-status': '200' }); }
  const out = new Response(text, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${rule.ttl}`, 'x-bagz-cache': 'MISS', 'x-bagz-upstream-status': '200', 'x-content-type-options': 'nosniff' } });
  if (cache && rule.ttl > 0) { const put = cache.put(key, out.clone()); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  const h = new Headers(out.headers); for (const [k, v] of Object.entries(base)) h.set(k, v);
  return new Response(text, { status: 200, headers: h });
}

export default { fetch: (request, env, ctx) => handle(request, env || {}, ctx) };
