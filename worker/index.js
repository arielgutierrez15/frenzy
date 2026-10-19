/**
 * BAGZ proxy — a Cloudflare Worker that sits between the BAGZ web app and the market-data providers.
 *
 *  - Keeps API keys server-side (Jupiter, CoinGecko/GeckoTerminal, your Solana RPC). The browser never sees them.
 *  - Adds CORS for your site only (ALLOWED_ORIGINS), so providers that block browsers can still be used.
 *  - Caches answers at the edge and de-duplicates upstream calls, so many visitors share one provider budget.
 *  - Only forwards an allowlist of read-only paths. It is not an open proxy and it never signs or sends transactions
 *    (the only POSTs are Jupiter /swap/v2/execute with an already-signed transaction, and four read-only RPC methods).
 *
 * Routes:  GET /health   ·   GET|POST /p/<provider>/<path…>   with provider in jup | gt | ds | pump | rug | rpc
 */
const VERSION = '1.0.0';
const B58 = '[1-9A-HJ-NP-Za-km-z]{32,44}';
const ADDR = '[A-Za-z0-9]{20,64}';

const PROVIDERS = {
  jup: {
    base: () => 'https://api.jup.ag',
    auth: (env, h) => { if (env.JUPITER_API_KEY) h.set('x-api-key', env.JUPITER_API_KEY); },
    allow: [
      { re: /^\/tokens\/v2\/(recent|toptrending\/\w+|toporganicscore\/\w+|toptraded\/\w+|search|tag|category\/\w+\/\w+)$/, ttl: 30 },
      { re: /^\/price\/v3$/, ttl: 15 },
      { re: /^\/swap\/v2\/order$/, ttl: 0 },
      { re: /^\/swap\/v2\/execute$/, ttl: 0, method: 'POST' },
    ],
  },
  gt: {
    base: (env) => env.COINGECKO_API_KEY
      ? (env.COINGECKO_PLAN === 'pro' ? 'https://pro-api.coingecko.com/api/v3/onchain' : 'https://api.coingecko.com/api/v3/onchain')
      : 'https://api.geckoterminal.com/api/v2',
    auth: (env, h) => { if (env.COINGECKO_API_KEY) h.set(env.COINGECKO_PLAN === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key', env.COINGECKO_API_KEY); },
    allow: [
      { re: new RegExp(`^/networks/[a-z0-9_-]+/pools/${ADDR}/ohlcv/(second|minute|hour|day)$`), ttl: 15 },
      { re: new RegExp(`^/networks/[a-z0-9_-]+/pools/${ADDR}/trades$`), ttl: 15 },
      { re: new RegExp(`^/networks/[a-z0-9_-]+/tokens/${ADDR}/pools$`), ttl: 300 },
      { re: /^\/networks\/([a-z0-9_-]+\/)?(new_pools|trending_pools)$/, ttl: 45 },
    ],
  },
  ds: {
    base: () => 'https://api.dexscreener.com',
    allow: [
      { re: /^\/token-profiles\/latest\/v1$/, ttl: 45 },
      { re: /^\/token-boosts\/(top|latest)\/v1$/, ttl: 45 },
      { re: new RegExp(`^/tokens/v1/[a-z0-9]+/(${ADDR})(,${ADDR}){0,29}$`), ttl: 6 },
    ],
  },
  pump: {
    base: () => 'https://frontend-api-v3.pump.fun',
    // pump.fun publishes no API; it only answers requests that look like its own website
    auth: (_env, h) => { h.set('origin', 'https://pump.fun'); h.set('referer', 'https://pump.fun/'); h.set('user-agent', 'Mozilla/5.0 (compatible; BAGZ-proxy)'); },
    allow: [{ re: /^\/coins(\/currently-live)?$/, ttl: 20 }],
  },
  rug: {
    base: () => 'https://api.rugcheck.xyz',
    allow: [{ re: new RegExp(`^/v1/tokens/${B58}/report/summary$`), ttl: 300 }],
  },
  rpc: {
    base: (env) => env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    allow: [{ re: /^$/, ttl: 60, method: 'POST', rpc: ['getTokenLargestAccounts', 'getTokenSupply', 'getLatestBlockhash', 'getSignatureStatuses'] }],
  },
};

const hits = new Map(); // best effort per-isolate rate limit; add a Cloudflare rate-limiting rule for real protection
function limited(ip, env) {
  const max = parseInt(env.RATE_PER_MIN || '240', 10);
  const now = Date.now();
  const e = hits.get(ip);
  if (!e || now - e.t > 60_000) { hits.set(ip, { t: now, n: 1 }); if (hits.size > 5000) hits.clear(); return false; }
  e.n++;
  return e.n > max;
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || 'https://arielgutierrez15.github.io').split(',').map((s) => s.trim()).filter(Boolean);
}
function corsFor(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return { ok: true, headers: {} };
  const list = allowedOrigins(env);
  const local = env.ALLOW_LOCALHOST === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!list.includes(origin) && !local) return { ok: false, headers: {} };
  return { ok: true, headers: { 'access-control-allow-origin': origin, vary: 'Origin' } };
}

const json = (obj, status, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...extra } });

export async function handle(request, env, ctx, deps = {}) {
  const doFetch = deps.fetch || fetch;
  const cache = deps.cache !== undefined ? deps.cache : (typeof caches !== 'undefined' ? caches.default : null);
  const url = new URL(request.url);
  const cors = corsFor(request, env);
  if (!cors.ok) return json({ error: 'Origin not allowed' }, 403);
  const base = {
    ...cors.headers,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    'access-control-expose-headers': 'x-bagz-cache, x-bagz-upstream-status, retry-after',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: base });

  if (url.pathname === '/health') {
    return json({ ok: true, version: VERSION, providers: Object.keys(PROVIDERS), keys: { jupiter: !!env.JUPITER_API_KEY, coingecko: !!env.COINGECKO_API_KEY, rpc: !!env.SOLANA_RPC_URL } }, 200, base);
  }
  const m = /^\/p\/([a-z]+)(\/.*)?$/.exec(url.pathname);
  const prov = m && PROVIDERS[m[1]];
  if (!prov) return json({ error: 'Unknown route' }, 404, base);
  const path = m[2] || '';
  const rule = prov.allow.find((r) => r.re.test(path));
  if (!rule) return json({ error: 'Path not allowed' }, 403, base);
  const method = rule.method || 'GET';
  if (request.method !== method) return json({ error: `Use ${method} for this path` }, 405, base);

  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  if (limited(ip, env)) return json({ error: 'Too many requests to the BAGZ proxy' }, 429, { ...base, 'retry-after': '30' });

  let body;
  if (method === 'POST') {
    const text = await request.text();
    if (text.length > 20_000) return json({ error: 'Body too large' }, 413, base);
    if (rule.rpc) {
      let j; try { j = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400, base); }
      if (!j || !rule.rpc.includes(j.method)) return json({ error: 'RPC method not allowed' }, 403, base);
    }
    body = text;
  }

  const upstream = new URL(prov.base(env) + path);
  upstream.search = url.search;
  // cache key: the upstream URL (GET) or a synthetic URL carrying the body (POST), never including any secret
  const keyUrl = body !== undefined && rule.ttl > 0 ? `${upstream.toString()}${upstream.search ? '&' : '?'}__body=${encodeURIComponent(body)}` : upstream.toString();
  const key = new Request(keyUrl, { method: 'GET' });
  if (cache && rule.ttl > 0) {
    const hit = await cache.match(key);
    if (hit) { const h = new Headers(hit.headers); for (const [k, v] of Object.entries(base)) h.set(k, v); h.set('x-bagz-cache', 'HIT'); return new Response(hit.body, { status: hit.status, headers: h }); }
  }

  const headers = new Headers({ accept: 'application/json' });
  if (body !== undefined) headers.set('content-type', 'application/json');
  prov.auth?.(env, headers);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let res;
  try { res = await doFetch(upstream.toString(), { method, headers, body, signal: ctrl.signal }); }
  catch (e) { clearTimeout(timer); return json({ error: e && e.name === 'AbortError' ? 'Upstream timed out' : 'Upstream unreachable' }, e && e.name === 'AbortError' ? 504 : 502, base); }
  clearTimeout(timer);

  if (!res.ok) {
    const extra = { ...base, 'x-bagz-upstream-status': String(res.status) };
    const ra = res.headers.get('retry-after'); if (ra) extra['retry-after'] = ra;
    return json({ error: `Upstream ${res.status}`, upstreamStatus: res.status }, res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status, extra);
  }
  const text = await res.text();
  const out = new Response(text, { status: 200, headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': `public, s-maxage=${rule.ttl}`, 'x-bagz-cache': 'MISS', 'x-bagz-upstream-status': '200' } });
  if (cache && rule.ttl > 0) { const put = cache.put(key, out.clone()); if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put; }
  const h = new Headers(out.headers); for (const [k, v] of Object.entries(base)) h.set(k, v);
  return new Response(text, { status: 200, headers: h });
}

export default { fetch: (request, env, ctx) => handle(request, env || {}, ctx) };
