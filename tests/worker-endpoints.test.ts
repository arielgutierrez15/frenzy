/**
 * Every Worker endpoint, tested one at a time, with the exact request shapes the BAGZ frontend sends.
 * The upstream is a stub; nothing here touches a real provider. Real-provider checks are in scripts/probe-worker.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import { handle } from '../worker/index.js';
import { orderPath } from '../src/trading/jupiter';

const ORIGIN = 'https://arielgutierrez15.github.io';
const MINT = 'So11111111111111111111111111111111111111112';
const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const TX = 'AQAB'.repeat(60);
const SECRETS = { JUPITER_API_KEY: 'SECRET-JUP-KEY', COINGECKO_API_KEY: 'SECRET-CG-KEY', SOLANA_RPC_URL: 'https://rpc.example/SECRET-RPC-KEY' };
const env = (extra: object = {}) => ({ ...SECRETS, ALLOWED_ORIGINS: ORIGIN, ...extra });
let ipn = 0;
const ip = () => `10.1.${Math.floor(ipn / 250)}.${ipn++ % 250}`;
const mk = (path: string, o: { method?: string; origin?: string | null; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) => {
  const h: Record<string, string> = { 'cf-connecting-ip': o.ip || ip(), ...(o.headers || {}) };
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (origin) h.origin = origin;
  return new Request(`https://proxy.test${path}`, { method: o.method || 'GET', headers: h, body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body) });
};
interface Seen { url: string; method: string; h: Headers; body?: string }
const stub = (payload: unknown = { ok: 1 }, status = 200, hdrs: Record<string, string> = {}) => {
  const seen: Seen[] = [];
  const f = async (u: string, init: RequestInit) => { seen.push({ url: u, method: String(init.method), h: new Headers(init.headers), body: init.body as string | undefined }); return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: hdrs }); };
  return { f, seen };
};
const run = (req: Request, e: object, f: (u: string, i: RequestInit) => Promise<Response>, cache: unknown = null) => handle(req, e, undefined, { fetch: f, cache });

interface Ep { name: string; path: string; method?: string; body?: unknown; upstream: string; key?: 'x-api-key' | 'x-cg-demo-api-key'; rpc?: boolean }
const ENDPOINTS: Ep[] = [
  { name: 'ds profiles', path: '/p/ds/token-profiles/latest/v1', upstream: 'https://api.dexscreener.com/token-profiles/latest/v1' },
  { name: 'ds boosts top', path: '/p/ds/token-boosts/top/v1', upstream: 'https://api.dexscreener.com/token-boosts/top/v1' },
  { name: 'ds boosts latest', path: '/p/ds/token-boosts/latest/v1', upstream: 'https://api.dexscreener.com/token-boosts/latest/v1' },
  { name: 'ds pairs', path: `/p/ds/tokens/v1/solana/${TOKEN},${MINT}`, upstream: `https://api.dexscreener.com/tokens/v1/solana/${TOKEN},${MINT}` },
  { name: 'jup recent', path: '/p/jup/tokens/v2/recent', upstream: 'https://api.jup.ag/tokens/v2/recent', key: 'x-api-key' },
  { name: 'jup trending', path: '/p/jup/tokens/v2/toptrending/1h?limit=50', upstream: 'https://api.jup.ag/tokens/v2/toptrending/1h?limit=50', key: 'x-api-key' },
  { name: 'jup organic', path: '/p/jup/tokens/v2/toporganicscore/1h', upstream: 'https://api.jup.ag/tokens/v2/toporganicscore/1h', key: 'x-api-key' },
  { name: 'jup traded', path: '/p/jup/tokens/v2/toptraded/1h', upstream: 'https://api.jup.ag/tokens/v2/toptraded/1h', key: 'x-api-key' },
  { name: 'jup search', path: `/p/jup/tokens/v2/search?query=${TOKEN}`, upstream: `https://api.jup.ag/tokens/v2/search?query=${TOKEN}`, key: 'x-api-key' },
  { name: 'jup price', path: `/p/jup/price/v3?ids=${MINT}`, upstream: `https://api.jup.ag/price/v3?ids=${MINT}`, key: 'x-api-key' },
  { name: 'jup order (frontend orderPath)', path: '/p/jup' + orderPath({ inMint: MINT, outMint: TOKEN, amountRaw: '100000000', slippageBps: 300, taker: POOL }), upstream: '', key: 'x-api-key' },
  { name: 'jup execute', path: '/p/jup/swap/v2/execute', method: 'POST', body: { signedTransaction: TX, requestId: 'req-abcd1234' }, upstream: 'https://api.jup.ag/swap/v2/execute', key: 'x-api-key' },
  { name: 'gt new pools', path: '/p/gt/networks/solana/new_pools?include=base_token', upstream: 'https://api.coingecko.com/api/v3/onchain/networks/solana/new_pools?include=base_token', key: 'x-cg-demo-api-key' },
  { name: 'gt trending pools', path: '/p/gt/networks/solana/trending_pools?include=base_token', upstream: 'https://api.coingecko.com/api/v3/onchain/networks/solana/trending_pools?include=base_token', key: 'x-cg-demo-api-key' },
  { name: 'gt token pools', path: `/p/gt/networks/solana/tokens/${TOKEN}/pools?page=1`, upstream: `https://api.coingecko.com/api/v3/onchain/networks/solana/tokens/${TOKEN}/pools?page=1`, key: 'x-cg-demo-api-key' },
  { name: 'gt ohlcv', path: `/p/gt/networks/solana/pools/${POOL}/ohlcv/minute?aggregate=5&limit=290&currency=usd&token=base`, upstream: `https://api.coingecko.com/api/v3/onchain/networks/solana/pools/${POOL}/ohlcv/minute?aggregate=5&currency=usd&limit=290&token=base`, key: 'x-cg-demo-api-key' },
  { name: 'gt trades', path: `/p/gt/networks/solana/pools/${POOL}/trades`, upstream: `https://api.coingecko.com/api/v3/onchain/networks/solana/pools/${POOL}/trades`, key: 'x-cg-demo-api-key' },
  { name: 'pump coins', path: '/p/pump/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false', upstream: 'https://frontend-api-v3.pump.fun/coins?includeNsfw=false&limit=30&offset=0&order=DESC&sort=created_timestamp' },
  { name: 'pump live', path: '/p/pump/coins/currently-live?limit=50&offset=0&includeNsfw=false', upstream: 'https://frontend-api-v3.pump.fun/coins/currently-live?includeNsfw=false&limit=50&offset=0' },
  { name: 'rugcheck', path: `/p/rug/v1/tokens/${TOKEN}/report/summary`, upstream: `https://api.rugcheck.xyz/v1/tokens/${TOKEN}/report/summary` },
  ...['getTokenLargestAccounts', 'getTokenSupply', 'getLatestBlockhash', 'getSignatureStatuses'].map((m): Ep => ({
    name: `rpc ${m}`, path: '/p/rpc', method: 'POST', rpc: true, upstream: SECRETS.SOLANA_RPC_URL,
    body: { jsonrpc: '2.0', id: 1, method: m, params: m === 'getSignatureStatuses' ? [[SIG]] : m === 'getLatestBlockhash' ? [] : [TOKEN] },
  })),
];

for (const ep of ENDPOINTS) {
  test(`endpoint: ${ep.name}`, async () => {
    const method = ep.method || 'GET';
    const opts = (o = {}) => ({ method, body: ep.body, ...o });
    // 1. allowed origin -> forwarded to the right upstream, key injected server-side, JSON back with CORS for that origin only
    const s = stub({ ok: 1 });
    const r = await run(mk(ep.path, opts()), env(), s.f);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(s.seen.length, 1);
    if (ep.upstream) assert.equal(s.seen[0].url, ep.upstream);
    assert.equal(s.seen[0].method, method);
    if (ep.key) assert.ok(s.seen[0].h.get(ep.key)?.startsWith('SECRET'), 'key added upstream');
    assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(r.headers.get('content-type') || '', /application\/json/);
    const dump = JSON.stringify([...r.headers.entries()]) + (await r.text());
    assert.ok(!dump.includes('SECRET'), 'no secret reaches the browser');
    // 2. another website's browser is refused and the upstream is never called
    const s2 = stub();
    const bad = await run(mk(ep.path, opts({ origin: 'https://evil.example' })), env(), s2.f);
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
    // 3. no Origin at all (curl / script) is refused too
    const none = await run(mk(ep.path, opts({ origin: null })), env(), s2.f);
    assert.equal(none.status, 403);
    assert.equal(s2.seen.length, 0);
    // 4. with the deploy-check token a script may call it
    const probe = await run(mk(ep.path, opts({ origin: null, headers: { 'x-bagz-probe': 'probe-secret' } })), env({ PROBE_TOKEN: 'probe-secret' }), s2.f);
    assert.equal(probe.status, 200);
    const wrong = await run(mk(ep.path, opts({ origin: null, headers: { 'x-bagz-probe': 'nope' } })), env({ PROBE_TOKEN: 'probe-secret' }), s2.f);
    assert.equal(wrong.status, 403);
    // 5. wrong method
    const wm = await run(mk(ep.path, { method: method === 'GET' ? 'POST' : 'GET', body: method === 'GET' ? '{}' : undefined }), env(), s2.f);
    assert.equal(wm.status, 405);
    // 6. unknown query parameter is rejected before anything is sent upstream (blocks cache-busting and key smuggling)
    const before = s2.seen.length;
    const sep = ep.path.includes('?') ? '&' : '?';
    const q = await run(mk(ep.path + sep + 'api-key=stolen', opts()), env(), s2.f);
    assert.equal(q.status, 400);
    assert.equal(s2.seen.length, before);
  });
}

test('browser preflight: only allowed origins, exact match', async () => {
  const pre = (origin: string | null, e = env()) => handle(mk('/p/gt/networks/solana/new_pools', { method: 'OPTIONS', origin, headers: { 'access-control-request-method': 'GET' } }), e, undefined, { cache: null });
  const ok = await pre(ORIGIN);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('vary'), 'Origin');
  for (const o of ['https://evil.example', 'null', `${ORIGIN}.evil.com`, 'https://evil.com/?https://arielgutierrez15.github.io', 'http://arielgutierrez15.github.io', ORIGIN.toUpperCase()]) {
    const r = await pre(o);
    assert.equal(r.status, 403, o);
    assert.equal(r.headers.get('access-control-allow-origin'), null, o);
  }
  assert.equal((await pre(null)).status, 403);
  // a wildcard in ALLOWED_ORIGINS is ignored, not honoured
  assert.equal((await pre('https://evil.example', env({ ALLOWED_ORIGINS: '*' }))).status, 403);
  // localhost only when explicitly enabled
  assert.equal((await pre('http://localhost:5173')).status, 403);
  assert.equal((await pre('http://localhost:5173', env({ ALLOW_LOCALHOST: '1' }))).status, 204);
  assert.equal((await pre('http://localhost.evil.com', env({ ALLOW_LOCALHOST: '1' }))).status, 403);
});

test('several allowed origins are supported, each echoed back exactly', async () => {
  const e = env({ ALLOWED_ORIGINS: `${ORIGIN}, https://bagz.example/` });
  for (const o of [ORIGIN, 'https://bagz.example']) {
    const r = await run(mk('/p/ds/token-boosts/top/v1', { origin: o }), e, stub().f);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), o);
  }
});

test('routes that do not exist or are not allowlisted are refused without calling upstream', async () => {
  const s = stub();
  const paths = ['/', '/p', '/p/', '/p/jup', '/p/jup/', '/p/jup/user/profile', '/p/jup/swap/v2/order/../../x', '/p/jup/tokens/v2/recent/extra', '/p/gt/networks/solana/pools/short/ohlcv/minute',
    '/p/gt/networks/solana/pools/' + POOL + '/ohlcv/week', '/p/constructor/x', '/p/__proto__/x', '/p/ds/orders/v1/solana/x', '/p/rug/v1/tokens/' + TOKEN + '/report', '/p/pump/admin', '/p/rpc/extra'];
  for (const p of paths) {
    const r = await run(mk(p), env(), s.f);
    assert.ok([403, 404, 405].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal(s.seen.length, 0);
});

test('query values are validated, not just names', async () => {
  const s = stub();
  const bad = [
    `/p/jup/price/v3?ids=${MINT}%26x%3D1`, '/p/jup/price/v3?ids=short', `/p/jup/swap/v2/order?inputMint=${MINT}&outputMint=${TOKEN}`, // missing amount
    `/p/jup/swap/v2/order?inputMint=${MINT}&outputMint=${TOKEN}&amount=-5`, `/p/jup/swap/v2/order?inputMint=${MINT}&outputMint=${TOKEN}&amount=1&slippageBps=1e9`,
    `/p/gt/networks/solana/pools/${POOL}/ohlcv/minute?limit=99999999999`, `/p/gt/networks/solana/pools/${POOL}/ohlcv/minute?aggregate=1&aggregate=5`,
    '/p/pump/coins?order=DROP', '/p/ds/token-boosts/top/v1?x=1',
  ];
  for (const p of bad) assert.equal((await run(mk(p), env(), s.f)).status, 400, p);
  assert.equal(s.seen.length, 0);
});

test('query order does not matter: same request, one upstream call', async () => {
  const store = new Map<string, Response>();
  const cache = { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } };
  const s = stub({ data: [] });
  const a = await run(mk(`/p/gt/networks/solana/pools/${POOL}/ohlcv/minute?aggregate=1&limit=60`), env(), s.f, cache);
  const b = await run(mk(`/p/gt/networks/solana/pools/${POOL}/ohlcv/minute?limit=60&aggregate=1`), env(), s.f, cache);
  assert.equal(a.headers.get('x-bagz-cache'), 'MISS');
  assert.equal(b.headers.get('x-bagz-cache'), 'HIT');
  assert.equal(s.seen.length, 1);
});

test('POST bodies: swap execute and RPC are strictly validated', async () => {
  const s = stub();
  const post = (path: string, body: unknown) => run(mk(path, { method: 'POST', body }), env(), s.f);
  for (const b of [
    {}, { signedTransaction: TX }, { signedTransaction: TX, requestId: 'req-1234', extra: 1 }, { signedTransaction: 'short', requestId: 'req-1234' },
    { signedTransaction: TX + '!!!', requestId: 'req-1234' }, { signedTransaction: TX, requestId: 'a b' }, { signedTransaction: 'A'.repeat(5000), requestId: 'req-1234' }, '[]', 'not json',
  ]) assert.equal((await post('/p/jup/swap/v2/execute', b)).status, 400, JSON.stringify(b).slice(0, 60));
  assert.equal((await post('/p/jup/swap/v2/execute', 'x'.repeat(9000))).status, 413);
  for (const method of ['sendTransaction', 'simulateTransaction', 'requestAirdrop', 'getAccountInfo', 'getProgramAccounts', 'getBalance']) {
    assert.equal((await post('/p/rpc', { jsonrpc: '2.0', id: 1, method, params: [] })).status, 403, method);
  }
  assert.equal((await post('/p/rpc', { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: 'x' })).status, 400);
  assert.equal((await post('/p/rpc', { jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses', params: [Array(11).fill(SIG)] })).status, 400);
  assert.equal((await post('/p/rpc', { jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [TOKEN], extra: true })).status, 400);
  assert.equal(s.seen.length, 0);
});

test('upstream failures are mapped, never cached, and never leak upstream bodies or secrets', async () => {
  const store = new Map<string, Response>();
  const cache = { match: async (r: Request) => store.get(r.url)?.clone(), put: async (r: Request, res: Response) => { store.set(r.url, res); } };
  const cases: [number, number][] = [[429, 429], [500, 502], [503, 502], [401, 502], [404, 404]];
  for (const [up, want] of cases) {
    const s = stub('SECRET-JUP-KEY leaked in upstream body', up, { 'retry-after': '7' });
    const r = await run(mk('/p/ds/token-boosts/top/v1'), env(), s.f, cache);
    assert.equal(r.status, want, `upstream ${up}`);
    assert.equal(r.headers.get('x-bagz-upstream-status'), String(up));
    assert.ok(!(await r.text()).includes('SECRET'));
  }
  assert.equal(store.size, 0, 'errors are not cached');
  const t = await run(mk('/p/ds/token-boosts/top/v1'), env(), async () => { throw new TypeError('boom SECRET-JUP-KEY'); });
  assert.equal(t.status, 502);
  assert.ok(!(await t.text()).includes('SECRET'));
  const abort = await run(mk('/p/ds/token-boosts/top/v1'), env(), async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; });
  assert.equal(abort.status, 504);
  const html = await run(mk('/p/ds/token-boosts/top/v1'), env(), stub('<html>captcha</html>').f, cache);
  assert.equal(html.status, 502);
  const big = await run(mk('/p/ds/token-boosts/top/v1'), env(), stub('[' + '1,'.repeat(1_100_000) + '1]').f, cache);
  assert.equal(big.status, 502);
  assert.equal(store.size, 0);
});

test('abuse protection: per-IP limit, stricter POST limit, per-provider upstream budget', async () => {
  const f = stub('[]').f;
  const same = '203.0.113.7';
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await run(mk('/p/ds/token-boosts/top/v1', { ip: same }), env({ RATE_PER_MIN: '3' }), f)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const other = await run(mk('/p/ds/token-boosts/top/v1', { ip: '203.0.113.8' }), env({ RATE_PER_MIN: '3' }), f);
  assert.equal(other.status, 200, 'another visitor is unaffected');
  const limited = await run(mk('/p/ds/token-boosts/top/v1', { ip: same }), env({ RATE_PER_MIN: '3' }), f);
  assert.equal(limited.headers.get('retry-after'), '30');
  assert.equal(limited.headers.get('x-bagz-limit'), 'client');

  const postIp = '203.0.113.9';
  const pc: number[] = [];
  for (let i = 0; i < 4; i++) pc.push((await run(mk('/p/rpc', { method: 'POST', ip: postIp, body: { jsonrpc: '2.0', id: i, method: 'getLatestBlockhash', params: [] } }), env({ RATE_POST_PER_MIN: '2' }), stub('{"r":1}').f)).status);
  assert.deepEqual(pc, [200, 200, 429, 429]);

  // upstream budget: cache misses spend it, then the Worker stops calling the provider instead of burning the key
  const s = stub('{"data":[]}');
  const e = env({ UPSTREAM_PER_MIN_RUG: '2' });
  const rc: number[] = [];
  const toks = [TOKEN, MINT, POOL.replace('58', '59'), TOKEN.replace('Dez', 'Dey')];
  const t0 = Date.now() + 3_600_000; // a fresh minute, so earlier tests' calls don't count
  const at = (path: string) => handle(mk(path), e, undefined, { fetch: s.f, cache: null, now: () => t0 });
  for (const t of toks) rc.push((await at(`/p/rug/v1/tokens/${t}/report/summary`)).status);
  assert.deepEqual(rc, [200, 200, 429, 429]);
  assert.equal(s.seen.length, 2);
  const over = await at(`/p/rug/v1/tokens/${TOKEN}/report/summary`);
  assert.equal(over.headers.get('x-bagz-limit'), 'upstream-budget');
});

test('Cloudflare rate-limit binding is honoured when present, and a failing binding does not open the door', async () => {
  const f = stub('[]').f;
  const denied = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await run(mk('/p/ds/token-boosts/top/v1'), env(denied), f)).status, 429);
  const allowed = { RATE_LIMITER: { limit: async () => ({ success: true }) } };
  assert.equal((await run(mk('/p/ds/token-boosts/top/v1'), env(allowed), f)).status, 200);
  const broken = { RATE_LIMITER: { limit: async () => { throw new Error('down'); } }, RATE_PER_MIN: '1' };
  const ipx = '203.0.113.50';
  assert.equal((await run(mk('/p/ds/token-boosts/top/v1', { ip: ipx }), env(broken), f)).status, 200);
  assert.equal((await run(mk('/p/ds/token-boosts/top/v1', { ip: ipx }), env(broken), f)).status, 429);
});

test('/health: reachable without Origin, booleans only, no secret values', async () => {
  const r = await handle(mk('/health', { origin: null }), env({ PROBE_TOKEN: 'probe-secret' }), undefined, { cache: null });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.keys, { jupiter: true, coingecko: true, rpc: true });
  assert.deepEqual(j.protection, { origins: 1, rateLimiter: false, probeToken: true });
  assert.ok(!JSON.stringify(j).includes('SECRET') && !JSON.stringify(j).includes('probe-secret'));
  const none = await handle(mk('/health', { origin: null }), { ALLOWED_ORIGINS: ORIGIN }, undefined, { cache: null });
  assert.deepEqual((await none.json()).keys, { jupiter: false, coingecko: false, rpc: false });
  const evil = await handle(mk('/health', { origin: 'https://evil.example' }), env(), undefined, { cache: null });
  assert.equal(evil.status, 403);
});

test('keyless GeckoTerminal budget is tight; a key raises it', async () => {
  const s = stub('{"data":[]}');
  const codes: number[] = [];
  for (let i = 0; i < 10; i++) codes.push((await run(mk(`/p/gt/networks/solana/pools/${POOL}/trades`, { ip: ip() }), { ALLOWED_ORIGINS: ORIGIN }, s.f)).status);
  // 8 per minute per Worker instance without a key, the rest are refused locally (an earlier test may have used some of the minute)
  assert.ok(codes.filter((c) => c === 200).length <= 8);
  assert.ok(codes.includes(429));
});
