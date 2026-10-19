import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request, getHealth, cooldownUntil, ValidationError } from '../src/providers/http';
import { __setProxy } from '../src/providers/config';
import { harness, jsonRes } from './helpers';

test('caches within the TTL and refetches after it', async () => {
  const h = harness(() => jsonRes([{ id: 'a' }]));
  const a = await request({ source: 'jup-recent', path: '/tokens/v2/recent' });
  const b = await request({ source: 'jup-recent', path: '/tokens/v2/recent' });
  assert.ok(a.ok && b.ok);
  assert.equal(h.calls.length, 1);
  assert.equal(b.ok && b.cached, true);
  h.advance(46_000);
  await request({ source: 'jup-recent', path: '/tokens/v2/recent' });
  assert.equal(h.calls.length, 2);
});

test('de-duplicates identical in-flight requests', async () => {
  const h = harness(() => jsonRes({ ok: 1 }));
  const rs = await Promise.all([1, 2, 3, 4].map(() => request({ source: 'ds-profiles', path: '/token-profiles/latest/v1' })));
  assert.equal(h.calls.length, 1);
  assert.ok(rs.every((r) => r.ok));
});

test('force bypasses the cache', async () => {
  const h = harness(() => jsonRes({ ok: 1 }));
  await request({ source: 'ds-pairs', path: '/tokens/v1/solana/x' });
  await request({ source: 'ds-pairs', path: '/tokens/v1/solana/x', force: true });
  assert.equal(h.calls.length, 2);
});

test('retries a 500 with backoff and then succeeds', async () => {
  const h = harness((_u, _i, n) => (n === 1 ? jsonRes({}, 500) : jsonRes({ ok: 1 })));
  const r = await request({ source: 'ds-profiles', path: '/token-profiles/latest/v1' });
  assert.ok(r.ok);
  assert.equal(h.calls.length, 2);
});

test('does not retry a 404', async () => {
  const h = harness(() => jsonRes({}, 404));
  const r = await request({ source: 'rugcheck', path: '/v1/tokens/x/report/summary' });
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 1);
  assert.equal(!r.ok && r.error.status, 404);
});

test('429 sets a cool-down, later calls make no network request, and a stale answer is flagged', async () => {
  let rate = false;
  const h = harness(() => (rate ? jsonRes({}, 429, { 'retry-after': '20' }) : jsonRes({ data: [1] })));
  const ok = await request({ source: 'gt-new', path: '/networks/solana/new_pools' });
  assert.ok(ok.ok && !ok.stale);
  rate = true;
  h.advance(61_000); // cache expired
  const r = await request({ source: 'gt-new', path: '/networks/solana/new_pools' });
  assert.ok(r.ok && r.stale, 'falls back to the last good answer, flagged stale');
  assert.equal(r.ok && r.fetchedAt, ok.ok ? ok.fetchedAt : -1, 'stale answer keeps its real fetch time');
  const n = h.calls.length;
  assert.ok(cooldownUntil('gt') > h.now());
  await request({ source: 'gt-trending', path: '/networks/solana/trending_pools' }); // same provider, no cached answer
  assert.equal(h.calls.length, n, 'no new network call while cooling down');
  const health = getHealth('gt-new')[0];
  assert.equal(health.status, 'rate-limited');
  assert.equal(health.servedStale, true, 'the UI is told the visible data is the last good answer');
  h.advance(25_000);
  rate = false;
  const again = await request({ source: 'gt-trending', path: '/networks/solana/trending_pools' });
  assert.ok(again.ok);
});

test('a stale answer is never served for sources that forbid it (prices)', async () => {
  let fail = false;
  const h = harness(() => (fail ? jsonRes({}, 500) : jsonRes([{ baseToken: { address: 'x' } }])));
  await request({ source: 'ds-pairs', path: '/tokens/v1/solana/x' });
  fail = true;
  h.advance(9_000);
  const r = await request({ source: 'ds-pairs', path: '/tokens/v1/solana/x' });
  assert.equal(r.ok, false);
});

test('invalid responses are reported as invalid and not cached', async () => {
  const h = harness(() => jsonRes({ nope: true }));
  const validate = (j: unknown) => { if (!Array.isArray(j)) throw new ValidationError('expected a list'); return j; };
  const r = await request({ source: 'jup-recent', path: '/tokens/v2/recent', validate });
  assert.ok(!r.ok && r.error.kind === 'invalid');
  assert.equal(h.calls.length, 1, 'no retry for a shape error');
  assert.equal(getHealth('jup-recent')[0].status, 'down');
});

test('an HTML error page is reported as not JSON', async () => {
  harness(() => new Response('<html>blocked</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const r = await request({ source: 'pumpfun', path: '/coins' });
  assert.ok(!r.ok && r.error.kind === 'invalid');
});

test('network failure is classified and retried once', async () => {
  const h = harness(() => new TypeError('Failed to fetch'));
  const r = await request({ source: 'ds-profiles', path: '/token-profiles/latest/v1' });
  assert.ok(!r.ok && r.error.kind === 'network');
  assert.equal(h.calls.length, 2);
});

test('falls back from api.jup.ag to lite-api.jup.ag when the first host is broken', async () => {
  const h = harness((u) => (u.startsWith('https://api.jup.ag') ? jsonRes({}, 401) : jsonRes([{ id: 'x' }])));
  const r = await request({ source: 'jup-recent', path: '/tokens/v2/recent' });
  assert.ok(r.ok);
  assert.equal(h.calls[0].url, 'https://api.jup.ag/tokens/v2/recent');
  assert.equal(h.calls[1].url, 'https://lite-api.jup.ag/tokens/v2/recent');
  assert.equal(r.ok && r.host, 'lite-api.jup.ag');
});

test('rate limiter lets a burst through, then makes callers wait, high priority first', async () => {
  const order: string[] = [];
  const h = harness((u) => { order.push(u); return jsonRes({ data: [] }); });
  await Promise.all([0, 1, 2].map((i) => request({ source: 'gt-trades', path: `/networks/solana/pools/p${i}/trades`, prio: 2 })));
  assert.equal(order.length, 3, 'burst of 3 goes straight through');
  const low = request({ source: 'gt-trades', path: '/networks/solana/pools/low/trades', prio: 2 });
  const high = request({ source: 'gt-trades', path: '/networks/solana/pools/high/trades', prio: 0 });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(order.length, 3, 'no tokens, so no call yet');
  h.advance(6_500); // one token refills (10 calls/min)
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(order.length, 4);
  assert.ok(order[3].includes('/high/'), 'the priority-0 request goes first');
  h.advance(6_500);
  await new Promise((r) => setTimeout(r, 30));
  await Promise.all([low, high]);
  assert.ok(order[4].includes('/low/'));
});

test('proxy mode builds /p/<provider>/… URLs and never sends a key', async () => {
  const h = harness(() => jsonRes([{ id: 'x' }]));
  __setProxy('https://bagz-proxy.example.workers.dev');
  await request({ source: 'jup-recent', path: '/tokens/v2/recent' });
  assert.equal(h.calls[0].url, 'https://bagz-proxy.example.workers.dev/p/jup/tokens/v2/recent');
  assert.ok(!JSON.stringify(h.calls[0].init.headers).toLowerCase().includes('api-key'));
  __setProxy(null);
});

test('POST bodies are sent as JSON and included in the cache key', async () => {
  const h = harness((_u, init) => jsonRes({ result: { value: JSON.parse(String(init.body)).params[0] } }));
  const a = await request({ source: 'sol-rpc', path: '', method: 'POST', body: { method: 'getTokenSupply', params: ['A'] } });
  const b = await request({ source: 'sol-rpc', path: '', method: 'POST', body: { method: 'getTokenSupply', params: ['B'] } });
  assert.ok(a.ok && b.ok);
  assert.equal(h.calls.length, 2);
  assert.equal(a.ok && (a.data as any).result.value, 'A');
});

test('POSTs and swap calls are pinned to one host and never retried across hosts', async () => {
  const h = harness(() => jsonRes({}, 500));
  const r = await request({ source: 'jup-execute', path: '/swap/v2/execute', method: 'POST', body: { a: 1 } });
  assert.equal(r.ok, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://api.jup.ag/swap/v2/execute');
  const g = harness(() => jsonRes({}, 500));
  await request({ source: 'jup-quote', path: '/swap/v2/order?x=1' });
  assert.ok(g.calls.every((c) => c.url.startsWith('https://api.jup.ag/')), 'quotes never go to lite-api');
});
