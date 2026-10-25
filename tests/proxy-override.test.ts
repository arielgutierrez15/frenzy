/**
 * The runtime ?proxy= override must not let a shared link point the real site at someone else's server
 * (which would receive passwords, session tokens and swap transactions).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function page(href: string, stored: Record<string, string> = {}) {
  const store = new Map(Object.entries(stored));
  const u = new URL(href);
  (globalThis as any).location = { search: u.search, hostname: u.hostname, protocol: u.protocol, href };
  (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  (globalThis as any).__BAGZ_PROXY__ = 'https://bagz-api.example.workers.dev';
  return store;
}
async function fresh() { return import(`../src/providers/config.ts?x=${Math.random()}`); }

test('a shared link cannot redirect the real site to another server', async () => {
  const store = page('https://bagz.pages.dev/?proxy=https://evil.example.com');
  const { proxyBase } = await fresh();
  assert.equal(proxyBase(), 'https://bagz-api.example.workers.dev');
  assert.equal(store.get('bagz.proxy'), undefined, 'not remembered');
});

test('a bad override remembered by an older version is removed', async () => {
  const store = page('https://bagz.pages.dev/', { 'bagz.proxy': 'https://evil.example.com' });
  const { proxyBase } = await fresh();
  assert.equal(proxyBase(), 'https://bagz-api.example.workers.dev');
  assert.equal(store.has('bagz.proxy'), false);
});

test('local development and tests can still point at a local Worker', async () => {
  page('https://bagz.pages.dev/?proxy=http://127.0.0.1:8787');
  assert.equal((await fresh()).proxyBase(), 'http://127.0.0.1:8787');
  page('http://127.0.0.1:5173/?proxy=https://bagz-api.staging.workers.dev');
  assert.equal((await fresh()).proxyBase(), 'https://bagz-api.staging.workers.dev');
});
