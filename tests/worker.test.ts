import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module
import { handle } from '../worker/index.js';

const ORIGIN = 'https://arielgutierrez15.github.io';
const mem = () => {
  const m = new Map<string, Response>();
  return { match: async (r: Request) => m.get(r.url)?.clone(), put: async (r: Request, res: Response) => { m.set(r.url, res); }, size: () => m.size };
};
const env = { JUPITER_API_KEY: 'SECRET-JUP', COINGECKO_API_KEY: 'SECRET-CG', ALLOWED_ORIGINS: ORIGIN };
const req = (path: string, init: RequestInit & { origin?: string } = {}) =>
  new Request(`https://proxy.test${path}`, { ...init, headers: { ...(init.origin === undefined ? { origin: ORIGIN } : init.origin ? { origin: init.origin } : {}), 'cf-connecting-ip': Math.random().toString(), ...(init.headers as object) } });

test('rejects browsers from other origins and answers preflight for the allowed one', async () => {
  const bad = await handle(req('/p/ds/token-profiles/latest/v1', { origin: 'https://evil.example' }), env, undefined, { fetch: async () => new Response('[]'), cache: null });
  assert.equal(bad.status, 403);
  const pre = await handle(req('/p/ds/token-profiles/latest/v1', { method: 'OPTIONS' }), env, undefined, { cache: null });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
});

test('only allowlisted paths are forwarded', async () => {
  let called = 0;
  const f = async () => { called++; return new Response('{}'); };
  for (const p of ['/p/jup/user/profile', '/p/gt/../../secret', '/p/ds/orders/v1/solana/x', '/p/pump/admin', '/p/nope/x', '/p/rug/v1/tokens/short/report/summary']) {
    const r = await handle(req(p), env, undefined, { fetch: f, cache: null });
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal(called, 0);
});

test('adds the Jupiter key upstream and never leaks any key to the browser', async () => {
  let seen: Headers | undefined; let url = '';
  const f = async (u: string, init: RequestInit) => { url = u; seen = new Headers(init.headers); return new Response(JSON.stringify([{ id: 'x' }]), { headers: { 'content-type': 'application/json' } }); };
  const r = await handle(req('/p/jup/tokens/v2/recent'), env, undefined, { fetch: f, cache: null });
  assert.equal(r.status, 200);
  assert.equal(url, 'https://api.jup.ag/tokens/v2/recent');
  assert.equal(seen!.get('x-api-key'), 'SECRET-JUP');
  const dump = JSON.stringify([...r.headers.entries()]) + (await r.text());
  assert.ok(!dump.includes('SECRET'), 'no secret in the response');
});

test('GeckoTerminal goes through CoinGecko with the demo key header when a key is set, keyless otherwise', async () => {
  const seen: { url: string; h: Headers }[] = [];
  const f = async (u: string, init: RequestInit) => { seen.push({ url: u, h: new Headers(init.headers) }); return new Response('{"data":[]}'); };
  await handle(req('/p/gt/networks/solana/new_pools?include=base_token'), env, undefined, { fetch: f, cache: null });
  assert.equal(seen[0].url, 'https://api.coingecko.com/api/v3/onchain/networks/solana/new_pools?include=base_token');
  assert.equal(seen[0].h.get('x-cg-demo-api-key'), 'SECRET-CG');
  await handle(req('/p/gt/networks/solana/new_pools'), { ALLOWED_ORIGINS: ORIGIN }, undefined, { fetch: f, cache: null });
  assert.equal(seen[1].url, 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools');
  assert.equal(seen[1].h.get('x-cg-demo-api-key'), null);
});

test('caches at the edge: the second request is a HIT and does not reach the provider', async () => {
  const cache = mem();
  let n = 0;
  const f = async () => { n++; return new Response('{"data":[1]}', { headers: { 'content-type': 'application/json' } }); };
  const a = await handle(req('/p/gt/networks/solana/pools/PoolAddress1111111111111111/ohlcv/minute?aggregate=1&limit=60'), env, undefined, { fetch: f, cache });
  const b = await handle(req('/p/gt/networks/solana/pools/PoolAddress1111111111111111/ohlcv/minute?aggregate=1&limit=60'), env, undefined, { fetch: f, cache });
  assert.equal(a.headers.get('x-bagz-cache'), 'MISS');
  assert.equal(b.headers.get('x-bagz-cache'), 'HIT');
  assert.equal(n, 1);
  assert.equal(b.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(await b.text(), '{"data":[1]}');
});

test('upstream errors are not cached, 429 is passed through with Retry-After', async () => {
  const cache = mem();
  const f = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '17' } });
  const r = await handle(req('/p/ds/token-boosts/top/v1'), env, undefined, { fetch: f, cache });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '17');
  assert.equal(cache.size(), 0);
  const e = await handle(req('/p/ds/token-boosts/top/v1'), env, undefined, { fetch: async () => { throw new TypeError('x'); }, cache });
  assert.equal(e.status, 502);
});

test('pump.fun requests carry website-like headers', async () => {
  let h: Headers | undefined;
  await handle(req('/p/pump/coins?offset=0&limit=30'), env, undefined, { fetch: async (_u: string, i: RequestInit) => { h = new Headers(i.headers); return new Response('[]'); }, cache: null });
  assert.equal(h!.get('origin'), 'https://pump.fun');
});

test('RPC: POST only, read-only method allowlist, uses your RPC URL', async () => {
  let url = '';
  const f = async (u: string) => { url = u; return new Response('{"result":{}}'); };
  const e = { ...env, SOLANA_RPC_URL: 'https://rpc.example/key' };
  const post = (method: string) => req('/p/rpc', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });
  assert.equal((await handle(post('getTokenSupply'), e, undefined, { fetch: f, cache: null })).status, 200);
  assert.equal(url, 'https://rpc.example/key');
  assert.equal((await handle(post('sendTransaction'), e, undefined, { fetch: f, cache: null })).status, 403);
  assert.equal((await handle(post('requestAirdrop'), e, undefined, { fetch: f, cache: null })).status, 403);
  assert.equal((await handle(req('/p/rpc'), e, undefined, { fetch: f, cache: null })).status, 405);
});

test('Jupiter execute is POST-only and never cached', async () => {
  const cache = mem();
  const f = async () => new Response('{"status":"Success"}');
  const g = await handle(req('/p/jup/swap/v2/execute'), env, undefined, { fetch: f, cache });
  assert.equal(g.status, 405);
  const p = await handle(req('/p/jup/swap/v2/execute', { method: 'POST', body: '{"signedTransaction":"x","requestId":"y"}' }), env, undefined, { fetch: f, cache });
  assert.equal(p.status, 200);
  assert.equal(cache.size(), 0);
});

test('per-IP rate limit and health endpoint (booleans only)', async () => {
  const limitedEnv = { ...env, RATE_PER_MIN: '3' };
  const mk = () => new Request('https://proxy.test/p/ds/token-boosts/top/v1', { headers: { origin: ORIGIN, 'cf-connecting-ip': '9.9.9.9' } });
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await handle(mk(), limitedEnv, undefined, { fetch: async () => new Response('[]'), cache: null })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  const h = await handle(req('/health'), env, undefined, { cache: null });
  const j = await h.json();
  assert.deepEqual(j.keys, { jupiter: true, coingecko: true, rpc: false });
  assert.ok(!JSON.stringify(j).includes('SECRET'));
});
