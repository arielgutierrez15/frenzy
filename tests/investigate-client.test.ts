/**
 * Investigate, browser side: contract validation, exact unit formatting, the API client (errors, cache, de-duplication,
 * cancellation, demo isolation), the connection graph, the bubble layout and the pool-activity reader.
 * The Worker answers used here are produced by the real Worker code (tests/investigate-fixtures.ts drives its RPC).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import { __resetInvestigate } from '../worker/investigate.js';
import { __setProxy } from '../src/providers/config';
import { validateHolders, validateActivity, ContractError } from '../src/investigate/validate';
import { exactUnits, readableUnits, compactUnits, pctText, percentOf, ixLabel } from '../src/investigate/units';
import { loadHolders, loadActivity, InvestigateError, __setInvestigateDeps, clearInvestigateCache, inflightCount, unavailableReason, explain } from '../src/investigate/api';
import { buildGraph } from '../src/investigate/graph';
import { packBubbles, fitLayout, radiusFor, MIN_R, MAX_R, MIN_TAP_PX } from '../src/investigate/layout';
import { poolActivity } from '../src/investigate/market';
import type { Holder, TokenEvent } from '../src/investigate/types';
import { MINT, ON, OFF, addr, sig, rpcFetch, holderWorld, tokenAcct, parsedTx, tb, xfer } from './investigate-fixtures';

const ORIGIN = 'https://bagz.pages.dev';
const BASE = 'https://bagz-api.test';
const env = { ALLOWED_ORIGINS: ORIGIN, HELIUS_API_KEY: 'K', RATE_PER_MIN: '100000', RATE_INVESTIGATE_PER_MIN: '100000' };

/** a real Worker answer for the standard holder world */
async function workerHolders(world = holderWorld()) {
  __resetInvestigate();
  const { f } = rpcFetch(world.script);
  const res: Response = await handle(new Request(`${BASE}/v1/investigate/holders?mint=${MINT}`, { headers: { origin: ORIGIN } }), env, undefined, { fetch: f, cache: null });
  return res.json();
}
const ACCT = addr(50), PEER_ACCT = addr(51);
async function workerActivity() {
  __resetInvestigate();
  const sigs = [0, 1].map((i) => ({ signature: sig(300 + i), slot: 50 - i, err: null }));
  const { f } = rpcFetch({
    getAccountInfo: () => ({ context: { slot: 60 }, value: tokenAcct(MINT, ON[0], '7') }),
    getSignaturesForAddress: () => sigs,
    getTransaction: (p) => parsedTx({ slot: 50, keys: [ON[0], ACCT, PEER_ACCT], outer: [xfer('transferChecked', { source: PEER_ACCT, destination: ACCT, mint: MINT, tokenAmount: { amount: p[0] === sigs[0].signature ? '5' : '2' } })], pre: [tb(1, MINT, ON[0], '0'), tb(2, MINT, ON[1], '7')], post: [tb(1, MINT, ON[0], '7'), tb(2, MINT, ON[1], '0')] }),
  });
  const res: Response = await handle(new Request(`${BASE}/v1/investigate/activity?mint=${MINT}&account=${ACCT}`, { headers: { origin: ORIGIN } }), env, undefined, { fetch: f, cache: null });
  return res.json();
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------------------------------------------- contract
test('contract: real Worker answers pass; tampered answers are rejected as a whole', async () => {
  const h = await workerHolders();
  assert.equal(validateHolders(h, MINT).holders.length, 3);
  const bad: [string, (x: any) => void][] = [
    ['other token', (x) => { x.mint = addr(9); }],
    ['owner total ≠ sum of accounts', (x) => { x.holders[0].amount = '1'; }],
    ['float amount', (x) => { x.holders[1].amount = '9007199254740992.5'; x.holders[1].accounts[0].amount = '9007199254740992.5'; }],
    ['percent not a fixed string', (x) => { x.holders[0].percent = 50; }],
    ['not sorted', (x) => { [x.holders[0], x.holders[1]] = [x.holders[1], x.holders[0]]; x.holders[0].rank = 1; x.holders[1].rank = 2; }],
    ['connections from balances', (x) => { x.connections = [{ from: 'a', to: 'b' }]; }],
    ['coverage total mismatch', (x) => { x.coverage.includedRaw = '5'; }],
    ['wrong version', (x) => { x.version = 2; }],
    ['duplicate owner', (x) => { x.holders[2].owner = x.holders[0].owner; }],
  ];
  for (const [name, mut] of bad) { const x = clone(h); mut(x); assert.throws(() => validateHolders(x, MINT), ContractError, name); }
  const a = await workerActivity();
  assert.equal(validateActivity(a, MINT, ACCT).transfers.length, 2);
  const badA: [string, (x: any) => void][] = [
    ['event for another account', (x) => { x.transfers[0].destinationAccount = addr(99); }],
    ['duplicate event', (x) => { x.transfers[1] = x.transfers[0]; }],
    ['count mismatch', (x) => { x.coverage.eventsFound = 9; }],
    ['path does not match indexes', (x) => { x.transfers[0].path = '4.1'; }],
    ['other account', (x) => { x.account = addr(98); }],
  ];
  for (const [name, mut] of badA) { const x = clone(a); mut(x); assert.throws(() => validateActivity(x, MINT, ACCT), ContractError, name); }
});

// ---------------------------------------------------------------------------------------------------- units
test('units: exact decimal conversion with BigInt, display truncation is flagged, never rounded up', () => {
  assert.equal(exactUnits('18446744073709551615', 9), '18446744073.709551615');
  assert.equal(exactUnits('9007199254740993', 0), '9007199254740993');
  assert.equal(exactUnits('1', 6), '0.000001');
  assert.equal(exactUnits('1000000', 6), '1');
  assert.deepEqual(readableUnits('18446744073709551615', 9, 4), { text: '18,446,744,073.7095', truncated: true });
  assert.deepEqual(readableUnits('1999999', 6, 2), { text: '1.99', truncated: true });
  assert.deepEqual(readableUnits('1500000', 6, 2), { text: '1.5', truncated: false });
  assert.deepEqual(readableUnits('12', 9, 4), { text: '0.000000012', truncated: false });
  assert.equal(compactUnits('18446744073709551615', 6), '18.44T');
  assert.equal(compactUnits('999999000000', 6), '999.99K');
  assert.equal(pctText('12.3456'), '12.34%');
  assert.equal(pctText('0.0042'), '<0.01%');
  assert.equal(pctText('0.0000', true), '<0.0001%');
  assert.equal(pctText(null), 'n/a');
  assert.equal(percentOf('1', '3'), '33.3333');
  assert.equal(ixLabel(3, null), '#4');
  assert.equal(ixLabel(0, 1), '#1.2');
});

// ---------------------------------------------------------------------------------------------------- api client
type Reply = Response | Error | ((url: string, init: RequestInit) => Promise<Response>);
function client(replies: Reply[] | ((url: string, n: number) => Reply)) {
  let t = 2_000_000_000_000;
  const seen: { url: string; init: RequestInit }[] = [];
  __setProxy(BASE);
  delete (globalThis as any).__BAGZ_DEMO__;
  __setInvestigateDeps({
    now: () => t,
    fetch: async (url, init) => {
      seen.push({ url, init });
      const r = Array.isArray(replies) ? replies[Math.min(seen.length - 1, replies.length - 1)] : replies(url, seen.length);
      if (r instanceof Error) throw r;
      if (typeof r === 'function') return r(url, init);
      return r.clone();
    },
  });
  return { seen, advance: (ms: number) => { t += ms; } };
}
const json = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...h } });
async function codeOf(p: Promise<unknown>) { try { await p; return 'ok'; } catch (e) { return e instanceof InvestigateError ? e.code : String(e); } }

test('client: every failure becomes an explicit state (401/403/404/429/5xx/timeout/network/bad JSON/contract)', async () => {
  const cases: [Reply, string, number?][] = [
    [json({ error: 'refused', code: 'provider_auth' }, 502), 'provider_auth'],
    [json({ error: 'Too many', code: 'provider_rate_limited', retryAfter: 7 }, 429, { 'retry-after': '7' }), 'rate_limited', 7],
    [json({ error: 'Too many requests' }, 429, { 'retry-after': '30' }), 'rate_limited', 30],
    [json({ error: 'This API only serves the BAGZ web app' }, 403), 'origin_refused'],
    [json({ error: 'Unknown route' }, 404), 'not_deployed'],
    [json({ error: 'no key', code: 'provider_not_configured' }, 503), 'provider_not_configured'],
    [json({ error: 'x', code: 'provider_error' }, 502), 'provider_error'],
    [json({ error: 'x' }, 500), 'provider_error'],
    [json({ error: 'x', code: 'provider_timeout' }, 504), 'timeout'],
    [new Response('<html>not json</html>', { status: 200 }), 'malformed'],
    [json({ kind: 'bagz.investigate.holders', version: 1, mint: MINT }), 'malformed'],
    [new TypeError('Failed to fetch'), 'network'],
  ];
  for (const [reply, code, retry] of cases) {
    client([reply]);
    try { await loadHolders(MINT); assert.fail(`expected ${code}`); } catch (e) {
      assert.ok(e instanceof InvestigateError, String(e));
      assert.equal(e.code, code, `${code}: ${e.message}`);
      if (retry) assert.equal(e.retryAfter, retry);
      assert.ok(explain(e).title.length > 0);
    }
  }
  // timeout: a request that never answers is cut off by the client's own timer
  client([(_u, init) => new Promise<Response>((_r, rej) => { init.signal!.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); })]);
  const realSetTimeout = globalThis.setTimeout;
  (globalThis as any).setTimeout = (fn: () => void, _ms: number) => realSetTimeout(fn, 1);
  try { assert.equal(await codeOf(loadHolders(MINT)), 'timeout'); } finally { (globalThis as any).setTimeout = realSetTimeout; }
});

test('client: demo copy and missing server are refused before any request; invalid addresses never leave the page', async () => {
  const c = client([json({})]);
  (globalThis as any).__BAGZ_DEMO__ = { base: 'https://test-copy.bagz', fetch: async () => json({}) };
  assert.equal(unavailableReason()?.code, 'demo_unavailable');
  assert.equal(await codeOf(loadHolders(MINT)), 'demo_unavailable');
  delete (globalThis as any).__BAGZ_DEMO__;
  __setProxy(null);
  assert.equal(unavailableReason()?.code, 'no_server');
  assert.equal(await codeOf(loadHolders(MINT)), 'no_server');
  __setProxy(BASE);
  assert.equal(await codeOf(loadHolders('0xNotSolana')), 'invalid_mint');
  assert.equal(await codeOf(loadActivity(MINT, 'bad')), 'invalid_account');
  assert.equal(c.seen.length, 0);
});

test('client: cache keeps the real receive time, force refreshes, concurrent callers share one request', async () => {
  const body = await workerHolders();
  const c = client(() => json(body));
  const a = loadHolders(MINT), b = loadHolders(MINT);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(c.seen.length, 1);
  assert.equal(ra.receivedAt, rb.receivedAt);
  assert.equal(c.seen[0].url, `${BASE}/v1/investigate/holders?mint=${MINT}`);
  assert.equal(c.seen[0].init.credentials, 'omit');
  c.advance(10_000);
  const r2 = await loadHolders(MINT);
  assert.equal(r2.fromClientCache, true);
  assert.equal(r2.receivedAt, ra.receivedAt);
  assert.equal(c.seen.length, 1);
  const r3 = await loadHolders(MINT, { force: true });
  assert.equal(r3.fromClientCache, false);
  assert.equal(r3.receivedAt, ra.receivedAt + 10_000);
  assert.equal(c.seen.length, 2);
  c.advance(60_000);
  await loadHolders(MINT);
  assert.equal(c.seen.length, 3);
});

test('client: cancelling one caller keeps the shared request; cancelling all aborts it; rapid token switching', async () => {
  const body = await workerHolders();
  let aborted = 0;
  let release: (() => void) | null = null;
  client(() => (_u: string, init: RequestInit) => new Promise<Response>((res, rej) => {
    init.signal!.addEventListener('abort', () => { aborted++; const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    release = () => res(json(body));
  }));
  const a1 = new AbortController(), a2 = new AbortController();
  const p1 = loadHolders(MINT, { signal: a1.signal }), p2 = loadHolders(MINT, { signal: a2.signal });
  await new Promise((r) => setTimeout(r, 5));
  a1.abort();
  assert.equal(await codeOf(p1), 'aborted');
  assert.equal(aborted, 0);
  release!();
  assert.equal((await p2).data.mint, MINT);
  // all callers gone -> the network request itself is cancelled
  clearInvestigateCache();
  const a3 = new AbortController();
  const p3 = loadHolders(MINT, { signal: a3.signal, force: true });
  await new Promise((r) => setTimeout(r, 5));
  a3.abort();
  assert.equal(await codeOf(p3), 'aborted');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(aborted, 1);
  assert.equal(inflightCount(), 0);
  // a slow answer for token A can never be accepted as token B's: the contract check pins the mint
  const OTHER = addr(222);
  client([json(body)]);
  assert.equal(await codeOf(loadHolders(OTHER)), 'malformed');
});

test('client: activity requests carry mint, account and before, and are validated', async () => {
  const body = await workerActivity();
  const c = client(() => json(body));
  const r = await loadActivity(MINT, ACCT, { before: sig(9) });
  assert.equal(r.data.transfers.length, 2);
  const u = new URL(c.seen[0].url);
  assert.equal(u.pathname, '/v1/investigate/activity');
  assert.deepEqual(Object.fromEntries(u.searchParams), { mint: MINT, account: ACCT, before: sig(9) });
});

// ---------------------------------------------------------------------------------------------------- graph
const H = (owner: string, rank: number, amount: string): Holder => ({ rank, owner, amount, percent: null, percentBelowDisplay: false, accounts: [{ address: addr(rank + 400), amount, rankingAmount: amount, changedSinceRanking: false, state: 'initialized', program: 'spl-token' }], balanceScope: 'selected_accounts_only', ownerKind: { kind: 'wallet', label: 'Key-pair wallet', detail: '', programOwner: null, programOwnerLabel: null } });
const ev = (n: number, o: Partial<TokenEvent>): TokenEvent => ({
  signature: sig(n), path: '0', outerIndex: 0, innerIndex: null, instructionType: 'transferChecked', programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', outerProgramId: null, outerProgramLabel: null,
  invokedBy: null, invokedByLabel: null, stackHeight: null, slot: 1, blockTime: null, kind: 'transfer', direction: 'out', amount: '1', feeAmount: null,
  sourceAccount: addr(1), destinationAccount: addr(2), sourceOwner: null, destinationOwner: null, sourceOwnerNote: null, destinationOwnerNote: null, authority: null, context: 'top_level', interpretation: '', ...o,
});

test('graph: wallet links only with both owners resolved; unknown accounts stay separate; no edges from balances, mints or self-transfers', () => {
  const holders = [H(ON[0], 1, '100'), H(ON[1], 2, '50'), H(OFF[0], 3, '10')];
  assert.equal(buildGraph(holders, []).edges.length, 0);
  const g = buildGraph(holders, [
    ev(1, { sourceOwner: ON[0], destinationOwner: ON[1], amount: '18446744073709551615' }),
    ev(2, { sourceOwner: ON[0], destinationOwner: ON[1], amount: '9007199254740993', context: 'inner', innerIndex: 1, path: '0.1' }),
    ev(2, { sourceOwner: ON[0], destinationOwner: ON[1], amount: '9007199254740993', context: 'inner', innerIndex: 1, path: '0.1' }), // duplicate
    ev(3, { sourceOwner: ON[0], destinationOwner: null, destinationAccount: addr(77), destinationOwnerNote: 'not_in_token_balances' }),
    ev(4, { sourceOwner: OFF[1], destinationOwner: ON[1] }), // a wallet outside the snapshot
    ev(5, { sourceOwner: ON[1], destinationOwner: ON[1] }), // self
    ev(6, { kind: 'mint', sourceAccount: null, destinationOwner: ON[0], direction: 'in' }),
  ]);
  const w = g.edges.find((e) => e.from === `o:${ON[0]}` && e.to === `o:${ON[1]}`)!;
  assert.equal(w.evidence, 'wallet');
  assert.equal(w.events.length, 2);
  assert.equal(w.context, 'mixed');
  assert.equal(w.total, (18446744073709551615n + 9007199254740993n).toString());
  const u = g.edges.find((e) => e.to === `a:${addr(77)}`)!;
  assert.equal(u.evidence, 'account');
  assert.equal(g.nodes.find((n) => n.id === `a:${addr(77)}`)!.kind, 'unknown_account');
  assert.equal(g.nodes.find((n) => n.id === `o:${OFF[1]}`)!.kind, 'owner');
  assert.equal(g.selfTransfers, 1);
  assert.equal(g.walletEdges, 2);
  assert.equal(g.accountLinks, 1);
  assert.ok(!g.edges.some((e) => e.from.includes(OFF[0]) || e.to.includes(OFF[0]))); // holder #3 has no evidence, so no line
});

// ---------------------------------------------------------------------------------------------------- layout
test('layout: area proportional to balance, documented minimum size, no overlaps, deterministic', () => {
  const items = [
    { id: 'a', amount: '18446744073709551615' }, { id: 'b', amount: '4611686018427387903' }, { id: 'c', amount: '1152921504606846975' },
    ...Array.from({ length: 17 }, (_, i) => ({ id: `s${i}`, amount: String(1000 + i) })),
  ];
  const L = packBubbles(items, [{ id: 'sat', r: 9 }]);
  const by = new Map(L.bubbles.map((b) => [b.id, b]));
  assert.equal(by.get('a')!.r, MAX_R);
  // (r_b / r_a)^2 == amount_b / amount_a  (≈ 1/4)
  assert.ok(Math.abs((by.get('b')!.r / by.get('a')!.r) ** 2 - 0.25) < 1e-6);
  assert.ok(Math.abs((by.get('c')!.r / by.get('a')!.r) ** 2 - 0.0625) < 1e-6);
  assert.equal(by.get('s0')!.r, MIN_R);
  assert.equal(by.get('s0')!.minSized, true);
  assert.equal(by.get('a')!.minSized, false);
  for (const x of L.bubbles) for (const y of L.bubbles) if (x !== y) assert.ok(Math.hypot(x.x - y.x, x.y - y.y) >= x.r + y.r, `${x.id} overlaps ${y.id}`);
  for (const b of L.bubbles) { assert.ok(b.x - b.r >= L.box.x && b.x + b.r <= L.box.x + L.box.w); }
  assert.deepEqual(packBubbles(items, [{ id: 'sat', r: 9 }]), L);
  assert.deepEqual(radiusFor('0', '10'), { r: MIN_R, minSized: true });
  // phone width: big bubbles shrink until the smallest one is still a 24 px target on screen; proportions above the minimum hold
  const F = fitLayout(items, Array.from({ length: 6 }, (_, i) => ({ id: `sat${i}`, r: 10 })), 320);
  assert.ok(F.scale * 2 * MIN_R >= MIN_TAP_PX, `min bubble ${(F.scale * 2 * MIN_R).toFixed(1)}px`);
  const fb = new Map(F.bubbles.map((b) => [b.id, b]));
  assert.ok(fb.get('a')!.r < MAX_R);
  assert.ok(Math.abs((fb.get('b')!.r / fb.get('a')!.r) ** 2 - 0.25) < 1e-6);
  assert.equal(fitLayout(items, [], 1200).bubbles.find((b) => b.id === 'a')!.r, MAX_R);
});

// ---------------------------------------------------------------------------------------------------- pool activity
test('pool activity: only the chart pool, missing values stay unavailable (not zero), other pools not added', () => {
  const POOL = addr(600), OTHER = addr(601);
  const list = {
    data: [
      { id: `solana_${OTHER}`, attributes: { address: OTHER, transactions: { h24: { buys: 999999, sells: 999999 } } }, relationships: { base_token: { data: { id: `solana_${MINT}` } } } },
      { id: `solana_${POOL}`, attributes: { address: POOL, name: 'TKN / SOL', reserve_in_usd: '12345.6', transactions: { m5: { buys: 3, sells: 1, buyers: 2, sellers: 1 }, h1: { buys: 40, sells: 'x' }, h24: { buys: '1200', sells: 900 } }, volume_usd: { h24: '250000.5', h1: null } },
        relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } }, dex: { data: { id: 'raydium' } } } },
    ],
    included: [],
  };
  const p = poolActivity(list, POOL, MINT)!;
  assert.equal(p.baseMatches, true);
  assert.equal(p.otherPools, 1);
  assert.equal(p.dex, 'raydium');
  assert.equal(p.quoteMint, 'So11111111111111111111111111111111111111112');
  const w = Object.fromEntries(p.windows.map((x) => [x.id, x]));
  assert.deepEqual([w.m5.buys, w.m5.sells, w.m5.buyers], [3, 1, 2]);
  assert.equal(w.h1.buys, 40);
  assert.equal(w.h1.sells, undefined); // malformed -> unavailable, not 0
  assert.equal(w.h1.volumeUsd, undefined);
  assert.equal(w.m15.buys, undefined);
  assert.equal(w.h24.buys, 1200);
  assert.equal(w.h24.volumeUsd, 250000.5);
  assert.equal(p.reserveUsd, 12345.6);
  assert.equal(p.hasCounts, true);
  assert.equal(poolActivity(list, addr(602), MINT), null);
  const bare = poolActivity({ data: [{ id: 'x', attributes: { address: POOL }, relationships: { base_token: { data: { id: `solana_${addr(5)}` } } } }], included: [] }, POOL, MINT)!;
  assert.equal(bare.hasCounts, false);
  assert.equal(bare.baseMatches, false);
});
