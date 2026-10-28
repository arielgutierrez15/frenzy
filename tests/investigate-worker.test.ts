/**
 * Investigate routes of the BAGZ Worker (worker/investigate.js), through the real router (worker/index.js → api.js).
 * The RPC is scripted (tests/investigate-fixtures.ts); nothing here touches a real provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import { aggregateHolders, percentOf, isOnCurve, parseTokenEvents, classifyOwner, __resetInvestigate } from '../worker/investigate.js';
// @ts-ignore plain JS
import { b58encode } from '../worker/solana.js';
import { validateHolders, validateActivity } from '../src/investigate/validate';
import {
  TOKEN, TOKEN22, SYSTEM, JUP, RAYDIUM, ON, OFF, MINT, OTHER_MINT, addr, sig, tokenAcct, mintAcct, rpcFetch, holderWorld, parsedTx, tb, xfer, opaque, type RpcScript,
} from './investigate-fixtures';

const ORIGIN = 'https://bagz.pages.dev';
const KEY = 'HELIUS-SECRET-KEY-123';
const baseEnv = (extra: Record<string, string> = {}) => ({ ALLOWED_ORIGINS: ORIGIN, HELIUS_API_KEY: KEY, RATE_PER_MIN: '100000', ...extra });
let ipn = 0;
const req = (path: string, o: { method?: string; origin?: string | null; ip?: string } = {}) => {
  const h: Record<string, string> = { 'cf-connecting-ip': o.ip || `10.9.${Math.floor(ipn / 250)}.${ipn++ % 250}` };
  if (o.origin !== null) h.origin = o.origin || ORIGIN;
  return new Request(`https://w.test${path}`, { method: o.method || 'GET', headers: h });
};
let clock = 1_800_000_000_000;
const call = async (path: string, env: object, f: (u: string, i: RequestInit) => Promise<Response>, o: { method?: string; origin?: string | null; ip?: string } = {}) => {
  const res: Response = await handle(req(path, o), env, undefined, { fetch: f, cache: null, now: () => clock });
  const text = await res.text();
  let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body, text, h: res.headers };
};
const H = (mint = MINT) => `/v1/investigate/holders?mint=${mint}`;

// ---------------------------------------------------------------------------------------------------- pure functions
test('aggregation: exact sums above MAX_SAFE_INTEGER, several accounts per owner, exclusions with reasons', () => {
  const w = holderWorld();
  const multi = w.script.getMultipleAccounts([[MINT, ...w.acc]], 1);
  const r = aggregateHolders(w.largest, multi.value.slice(1), MINT, w.supply);
  assert.equal(r.holders.length, 3);
  assert.equal(r.holders[0].owner, w.A);
  assert.equal(r.holders[0].amount, (BigInt(w.big) + 4000n).toString());
  assert.equal(r.holders[0].amount, '18446744073709555615');
  assert.equal(r.holders[0].accounts.length, 2);
  assert.deepEqual(r.holders[0].accounts.map((a: any) => a.address), [w.acc[0], w.acc[2]]);
  assert.equal(r.holders[1].owner, w.B);
  assert.equal(r.holders[1].amount, '9007199254740993'); // 2^53 + 1: a float would round this to ...992
  assert.equal(r.holders[2].accounts[0].program, 'spl-token-2022');
  assert.deepEqual(r.excluded.map((x: any) => x.reason).sort(), ['closed_or_missing', 'wrong_mint']);
  assert.equal(r.includedRaw, (BigInt(w.big) + 4000n + 9007199254740993n + 1000n).toString());
  assert.equal(r.accountsIncluded, 4);
  // percent: integer division, truncated to 4 places
  assert.equal(r.holders[0].percent, percentOf(r.holders[0].amount, w.supply));
  assert.match(r.holders[0].percent, /^50\.0000$/);
});

test('aggregation: changed balances are flagged; zero or missing supply gives no percentages; ties sort by owner', () => {
  const w = holderWorld({ changed: true });
  const multi = w.script.getMultipleAccounts([[MINT, ...w.acc]], 1);
  const r = aggregateHolders(w.largest, multi.value.slice(1), MINT, w.supply);
  assert.equal(r.changed, 1);
  assert.equal(r.holders[0].accounts.find((a: any) => a.address === w.acc[2]).changedSinceRanking, true);
  assert.equal(r.holders[0].accounts.find((a: any) => a.address === w.acc[2]).rankingAmount, '5000');
  const z = aggregateHolders(w.largest, multi.value.slice(1), MINT, '0');
  assert.ok(z.holders.every((h: any) => h.percent === null));
  assert.equal(z.includedPercent, null);
  const m = aggregateHolders(w.largest, multi.value.slice(1), MINT, undefined);
  assert.ok(m.holders.every((h: any) => h.percent === null));
  const tie = aggregateHolders([{ address: addr(1), amount: '5' }, { address: addr(2), amount: '5' }], [tokenAcct(MINT, ON[1], '5'), tokenAcct(MINT, ON[0], '5')], MINT, '10');
  assert.deepEqual(tie.holders.map((h: any) => h.owner), [ON[0], ON[1]].sort());
});

test('percentOf truncates and never rounds up', () => {
  assert.equal(percentOf('1', '3'), '33.3333');
  assert.equal(percentOf('2', '3'), '66.6666');
  assert.equal(percentOf('1', '1000000000000'), '0.0000');
  assert.equal(percentOf('10', '10'), '100.0000');
  assert.equal(percentOf('5', '0'), null);
  assert.equal(percentOf('18446744073709551615', '36893488147419103230'), '50.0000');
});

test('on-curve check: real Ed25519 keys are on the curve; known off-curve addresses (PDAs) are not', () => {
  for (let i = 0; i < 25; i++) {
    const { publicKey } = generateKeyPairSync('ed25519');
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    assert.equal(isOnCurve(b58encode(new Uint8Array(raw))), true);
  }
  for (const a of ON) assert.equal(isOnCurve(a), true, a);
  for (const a of OFF) assert.equal(isOnCurve(a), false, a);
  // Raydium AMM v4 authority, a program-derived address
  assert.equal(isOnCurve('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'), false);
  assert.equal(isOnCurve('not-base58!'), false);
});

test('owner classification uses facts only', () => {
  assert.equal(classifyOwner(OFF[0], { owner: RAYDIUM, executable: false }).kind, 'pda');
  assert.equal(classifyOwner(OFF[0], { owner: RAYDIUM, executable: false }).programOwnerLabel, 'Raydium AMM v4');
  assert.equal(classifyOwner(ON[0], { owner: SYSTEM, executable: false }).kind, 'wallet');
  assert.equal(classifyOwner(ON[0], null).kind, 'wallet_no_sol');
  assert.equal(classifyOwner(ON[0], undefined).kind, 'unknown');
  assert.equal(classifyOwner(ON[0], { owner: JUP, executable: true }).kind, 'program');
  for (const k of [classifyOwner(ON[0], { owner: SYSTEM }), classifyOwner(OFF[0], null)]) assert.doesNotMatch(k.label + k.detail, /scam|insider|developer|dev wallet|rug/i);
});

// ---------------------------------------------------------------------------------------------------- transfer decoding
const ACCT = addr(50), OWNER = ON[0], PEER_ACCT = addr(51), PEER = ON[1], POOL_VAULT = addr(52), POOL_AUTH = OFF[0];

test('decoding: top-level transferChecked into the account, with owners from token balances and provenance', () => {
  const tx = parsedTx({
    keys: [PEER, PEER_ACCT, ACCT, MINT, TOKEN],
    outer: [opaque('ComputeBudget111111111111111111111111111111'), opaque(SYSTEM), xfer('transferChecked', { source: PEER_ACCT, destination: ACCT, mint: MINT, authority: PEER, tokenAmount: { amount: '18446744073709551615', decimals: 6 } })],
    pre: [tb(1, MINT, PEER, '20000000000000000000'), tb(2, MINT, OWNER, '0')],
    post: [tb(1, MINT, PEER, '1553255926290448385'), tb(2, MINT, OWNER, '18446744073709551615')],
  });
  const r = parseTokenEvents(tx, sig(1), MINT, ACCT);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.direction, 'in');
  assert.equal(e.amount, '18446744073709551615');
  assert.equal(e.path, '2');
  assert.equal(e.outerIndex, 2);
  assert.equal(e.innerIndex, null);
  assert.equal(e.context, 'top_level');
  assert.equal(e.sourceOwner, PEER);
  assert.equal(e.destinationOwner, OWNER);
  assert.equal(e.authority, PEER);
  assert.equal(e.slot, 500);
  assert.equal(e.blockTime, 1_800_000_000);
});

test('decoding: inner transfers keep outer + inner index; unchecked transfer mint resolved from balances; other mints and other accounts skipped', () => {
  const tx = parsedTx({
    keys: [OWNER, ACCT, POOL_VAULT, addr(53), addr(54), JUP, RAYDIUM, TOKEN],
    outer: [opaque(JUP)],
    inner: [{ index: 0, instructions: [
      opaque(RAYDIUM, 2),
      xfer('transfer', { source: ACCT, destination: POOL_VAULT, authority: OWNER, amount: '2500' }, { stackHeight: 3 }),
      xfer('transfer', { source: addr(53), destination: addr(54), authority: POOL_AUTH, amount: '77' }, { stackHeight: 3 }), // other mint
      xfer('transferChecked', { source: POOL_VAULT, destination: addr(60), mint: MINT, authority: POOL_AUTH, tokenAmount: { amount: '1' } }, { stackHeight: 3 }), // same mint, not our account
    ] }],
    pre: [tb(1, MINT, OWNER, '3000'), tb(2, MINT, POOL_AUTH, '10'), tb(3, OTHER_MINT, POOL_AUTH, '100'), tb(4, OTHER_MINT, OWNER, '0')],
    post: [tb(1, MINT, OWNER, '500'), tb(2, MINT, POOL_AUTH, '2509'), tb(3, OTHER_MINT, POOL_AUTH, '23'), tb(4, OTHER_MINT, OWNER, '77')],
  });
  const r = parseTokenEvents(tx, sig(2), MINT, ACCT);
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.path, '0.1');
  assert.equal(e.outerIndex, 0);
  assert.equal(e.innerIndex, 1);
  assert.equal(e.context, 'inner');
  assert.equal(e.direction, 'out');
  assert.equal(e.outerProgramId, JUP);
  assert.equal(e.outerProgramLabel, 'Jupiter Aggregator v6');
  assert.equal(e.invokedBy, RAYDIUM); // nearest earlier inner instruction one level up
  assert.equal(e.destinationOwner, POOL_AUTH);
  assert.match(e.interpretation, /not necessarily a direct payment/);
  assert.equal(r.otherMintTransfers, 1);
  assert.equal(r.otherAccountTransfers, 1);
});

test('decoding: failed transactions give nothing; unresolved and changed owners stay null with a reason', () => {
  const failed = parsedTx({ err: { InstructionError: [0, 'Custom'] }, keys: [OWNER, ACCT, PEER_ACCT], outer: [xfer('transferChecked', { source: ACCT, destination: PEER_ACCT, mint: MINT, tokenAmount: { amount: '5' } })] });
  assert.equal(parseTokenEvents(failed, sig(3), MINT, ACCT).events.length, 0);
  assert.equal(parseTokenEvents(null, sig(3), MINT, ACCT).events.length, 0);
  // the destination was created and closed inside the transaction, so it has no token-balance record
  const tmp = addr(70);
  const tx = parsedTx({
    keys: [OWNER, ACCT, tmp, PEER_ACCT],
    outer: [xfer('transferChecked', { source: ACCT, destination: tmp, mint: MINT, tokenAmount: { amount: '5' } }), xfer('transferChecked', { source: PEER_ACCT, destination: ACCT, mint: MINT, tokenAmount: { amount: '6' } })],
    pre: [tb(1, MINT, OWNER, '5'), tb(3, MINT, PEER, '6')],
    post: [tb(1, MINT, OWNER, '6'), tb(3, MINT, ON[2], '0')], // owner of PEER_ACCT changed inside the transaction
  });
  const r = parseTokenEvents(tx, sig(4), MINT, ACCT);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].destinationOwner, null);
  assert.equal(r.events[0].destinationOwnerNote, 'not_in_token_balances');
  assert.equal(r.events[1].sourceOwner, null);
  assert.equal(r.events[1].sourceOwnerNote, 'owner_changed_in_transaction');
});

test('decoding: mint, burn and transfer-with-fee events', () => {
  const tx = parsedTx({
    keys: [OWNER, ACCT, PEER_ACCT, MINT],
    outer: [
      { program: 'spl-token', programId: TOKEN, parsed: { type: 'mintTo', info: { mint: MINT, account: ACCT, mintAuthority: PEER, amount: '1000' } } },
      { program: 'spl-token', programId: TOKEN, parsed: { type: 'burnChecked', info: { mint: MINT, account: ACCT, authority: OWNER, tokenAmount: { amount: '10' } } } },
      xfer('transferCheckedWithFee', { source: ACCT, destination: PEER_ACCT, mint: MINT, authority: OWNER, tokenAmount: { amount: '100' }, feeAmount: { amount: '3' } }, { program: TOKEN22 }),
    ],
    pre: [tb(1, MINT, OWNER, '0'), tb(2, MINT, PEER, '0')],
    post: [tb(1, MINT, OWNER, '890'), tb(2, MINT, PEER, '97')],
  });
  const r = parseTokenEvents(tx, sig(5), MINT, ACCT);
  assert.deepEqual(r.events.map((e: any) => [e.kind, e.direction, e.amount]), [['mint', 'in', '1000'], ['burn', 'out', '10'], ['transfer', 'out', '100']]);
  assert.equal(r.events[0].sourceAccount, null);
  assert.equal(r.events[2].feeAmount, '3');
  assert.equal(r.events[2].programId, TOKEN22);
});

// ---------------------------------------------------------------------------------------------------- routes
test('health: says what is configured, never proves or leaks the key', async () => {
  __resetInvestigate();
  const none = await call('/v1/investigate/health', { ALLOWED_ORIGINS: ORIGIN }, async () => { throw new Error('no upstream expected'); });
  assert.equal(none.status, 200);
  assert.equal(none.body.configured, false);
  assert.equal(none.body.available, false);
  const yes = await call('/v1/investigate/health', baseEnv(), async () => { throw new Error('no upstream expected'); });
  assert.equal(yes.body.configured, true);
  assert.equal(yes.body.keyVerified, false);
  assert.equal(yes.body.rpc, 'helius');
  assert.ok(!yes.text.includes(KEY));
  const custom = await call('/v1/investigate/health', baseEnv({ SOLANA_RPC_URL: 'https://my-node.example/rpc?token=SECRET2' }), async () => { throw new Error('none'); });
  assert.equal(custom.body.rpc, 'custom');
  assert.ok(!custom.text.includes('SECRET2'));
});

test('holders: full snapshot through the real router, SOLANA_RPC_URL precedence, client contract accepts it', async () => {
  __resetInvestigate();
  const w = holderWorld();
  const { f, calls } = rpcFetch(w.script);
  const r = await call(H(), baseEnv({ SOLANA_RPC_URL: 'https://custom-rpc.example/k=SECRET3' }), f);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.h.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(calls.map((c) => c.method), ['getTokenLargestAccounts', 'getMultipleAccounts', 'getMultipleAccounts']);
  assert.ok(calls.every((c) => c.url === 'https://custom-rpc.example/k=SECRET3'));
  assert.deepEqual(calls[0].params, [MINT, { commitment: 'finalized' }]);
  assert.equal(calls[1].params[0][0], MINT); // mint read together with the balances (same slot)
  assert.equal(calls[1].params[1].minContextSlot, 1000);
  assert.ok(!r.text.includes('SECRET3') && !r.text.includes(KEY));
  const d = validateHolders(r.body, MINT);
  assert.equal(d.holders.length, 3);
  assert.equal(d.holders[0].ownerKind.kind, 'wallet');
  assert.equal(d.holders[1].ownerKind.kind, 'pda');
  assert.equal(d.holders[2].ownerKind.kind, 'wallet_no_sol');
  assert.equal(d.slots.ranking, 1000);
  assert.equal(d.slots.accounts, 1001);
  assert.equal(d.denominator.kind, 'token_supply');
  assert.equal(d.coverage.completeOwnerRanking, false);
  assert.match(d.coverage.description, /not a ranking of the largest wallets/);
  assert.deepEqual(d.connections, []);
  assert.equal(d.cache.hit, false);
  assert.equal(d.token.decimals, 6);
});

test('holders: a second request inside 60 s is served from cache; identical requests in flight share one upstream call', async () => {
  __resetInvestigate();
  const w = holderWorld();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const script: RpcScript = { ...w.script, getTokenLargestAccounts: async (p, n) => { await gate; return w.script.getTokenLargestAccounts(p, n); } };
  const { f, calls } = rpcFetch(script);
  const env = baseEnv();
  const a = call(H(), env, f), b = call(H(), env, f);
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  assert.equal(calls.filter((c) => c.method === 'getTokenLargestAccounts').length, 1);
  assert.ok(ra.body.cache.shared || rb.body.cache.shared);
  clock += 30_000;
  const c = await call(H(), env, f);
  assert.equal(c.body.cache.hit, true);
  assert.equal(c.body.cache.ageMs, 30_000);
  assert.equal(c.body.retrievedAt, ra.body.retrievedAt); // the real retrieval time, not "now"
  assert.equal(calls.filter((x) => x.method === 'getTokenLargestAccounts').length, 1);
});

test('holders: provider failure after expiry serves the earlier answer flagged stale; too old means an error', async () => {
  __resetInvestigate();
  const w = holderWorld();
  let down = false;
  const { f } = rpcFetch({ ...w.script, getTokenLargestAccounts: (p, n) => (down ? new Response('oops', { status: 503 }) : w.script.getTokenLargestAccounts(p, n)) });
  const env = baseEnv();
  assert.equal((await call(H(), env, f)).status, 200);
  down = true;
  clock += 61_000;
  const s = await call(H(), env, f);
  assert.equal(s.status, 200);
  assert.equal(s.body.cache.stale, true);
  assert.equal(s.body.cache.staleCode, 'provider_error');
  clock += 15 * 60_000;
  const e = await call(H(), env, f);
  assert.equal(e.status, 502);
  assert.equal(e.body.code, 'provider_error');
});

test('holders: provider errors map to explicit codes, never to demo data, never leaking the key', async () => {
  const cases: [string, RpcScript['x'] | ((u: string, i: RequestInit) => Promise<Response>), number, string][] = [
    ['401', () => new Response('no', { status: 401 }), 502, 'provider_auth'],
    ['403', () => new Response('no', { status: 403 }), 502, 'provider_auth'],
    ['429', () => new Response('slow', { status: 429, headers: { 'retry-after': '7' } }), 429, 'provider_rate_limited'],
    ['500', () => new Response('x', { status: 500 }), 502, 'provider_error'],
    ['not json', () => new Response('<html>gateway</html>', { status: 200 }), 502, 'provider_malformed'],
    ['rpc key error', () => ({ __rpcError: { code: -32001, message: `invalid api key ${KEY} at https://mainnet.helius-rpc.com/?api-key=${KEY}` } }), 502, 'provider_auth'],
    ['rpc rate limit', () => ({ __rpcError: { code: -32005, message: 'rate limit exceeded' } }), 429, 'provider_rate_limited'],
    ['not a mint', () => ({ __rpcError: { code: -32602, message: 'Invalid param: not a Token mint' } }), 400, 'invalid_mint'],
    ['no result', () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), { status: 200 }), 502, 'provider_malformed'],
  ];
  for (const [name, h, status, code] of cases) {
    __resetInvestigate();
    const { f } = rpcFetch({ getTokenLargestAccounts: h as any });
    const r = await call(H(), baseEnv(), f);
    assert.equal(r.status, status, `${name}: ${r.text}`);
    assert.equal(r.body.code, code, name);
    assert.ok(!r.text.includes(KEY), `${name} leaked the key`);
    assert.ok(!('holders' in r.body), `${name} returned data`);
    if (status === 429) assert.ok(Number(r.h.get('retry-after')) > 0);
  }
  __resetInvestigate();
  const timeout = await call(H(), baseEnv(), async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.code, 'provider_timeout');
  __resetInvestigate();
  const down = await call(H(), baseEnv(), async () => { throw new TypeError('fetch failed'); });
  assert.equal(down.status, 502);
  assert.equal(down.body.code, 'provider_unreachable');
});

test('holders: an address that is not a mint, malformed slots, wrapped SOL and zero supply', async () => {
  __resetInvestigate();
  const w = holderWorld();
  const notMint = rpcFetch({ ...w.script, getMultipleAccounts: () => ({ context: { slot: 1001 }, value: [{ owner: SYSTEM, lamports: 1, executable: false, data: ['', 'base64'] }, ...w.acc.map(() => null)] }) });
  const r1 = await call(H(), baseEnv(), notMint.f);
  assert.equal(r1.status, 400);
  assert.equal(r1.body.code, 'invalid_mint');
  __resetInvestigate();
  const badSlot = rpcFetch({ ...w.script, getTokenLargestAccounts: () => ({ context: {}, value: [] }) });
  assert.equal((await call(H(), baseEnv(), badSlot.f)).body.code, 'provider_malformed');
  __resetInvestigate();
  const WSOL = 'So11111111111111111111111111111111111111112';
  const ws = rpcFetch({ getTokenLargestAccounts: () => ({ context: { slot: 9 }, value: [{ address: addr(1), amount: '50' }] }), getMultipleAccounts: (p) => (p[1].encoding === 'base64' ? { context: { slot: 9 }, value: [null] } : { context: { slot: 9 }, value: [mintAcct('100', 9), tokenAcct(WSOL, ON[0], '50')] }) });
  const r2 = await call(H(WSOL), baseEnv(), ws.f);
  const d2 = validateHolders(r2.body, WSOL);
  assert.equal(d2.denominator.kind, 'wrapped_sol_token_supply');
  assert.match(d2.denominator.note, /not SOL’s circulating supply/);
  __resetInvestigate();
  const zero = rpcFetch({ getTokenLargestAccounts: () => ({ context: { slot: 9 }, value: [{ address: addr(1), amount: '0' }] }), getMultipleAccounts: (p) => (p[1].encoding === 'base64' ? { context: { slot: 9 }, value: [null] } : { context: { slot: 9 }, value: [mintAcct('0'), tokenAcct(MINT, ON[0], '0')] }) });
  const d3 = validateHolders((await call(H(), baseEnv(), zero.f)).body, MINT);
  assert.equal(d3.denominator.kind, 'none');
  assert.equal(d3.holders[0].percent, null);
  __resetInvestigate();
  const empty = rpcFetch({ getTokenLargestAccounts: () => ({ context: { slot: 9 }, value: [] }), getMultipleAccounts: () => ({ context: { slot: 9 }, value: [mintAcct('100')] }) });
  const d4 = validateHolders((await call(H(), baseEnv(), empty.f)).body, MINT);
  assert.equal(d4.holders.length, 0);
});

test('holders: Token-2022 mints list extensions and flag the ones that change what a balance means', async () => {
  __resetInvestigate();
  const w = holderWorld();
  const { f } = rpcFetch({ ...w.script, getMultipleAccounts: (p, n) => { const r = w.script.getMultipleAccounts(p, n); if (p[1].encoding !== 'base64') r.value[0] = mintAcct(w.supply, 6, { program: TOKEN22, extensions: ['metadataPointer', 'interestBearingConfig'] }); return r; } });
  const d = validateHolders((await call(H(), baseEnv(), f)).body, MINT);
  assert.equal(d.token.program, 'spl-token-2022');
  assert.deepEqual(d.token.extensions, ['metadataPointer', 'interestBearingConfig']);
  assert.deepEqual(d.token.decodingGaps.map((g) => g.extension), ['interestBearingConfig']);
});

test('holders: owner-type read failing makes the answer partial, not an error', async () => {
  __resetInvestigate();
  const w = holderWorld();
  const { f } = rpcFetch({ ...w.script, getMultipleAccounts: (p, n) => (p[1].encoding === 'base64' ? new Response('x', { status: 500 }) : w.script.getMultipleAccounts(p, n)) });
  const d = validateHolders((await call(H(), baseEnv(), f)).body, MINT);
  assert.match(d.coverage.ownersNote!, /could not be read/);
  assert.equal(d.holders[1].ownerKind.kind, 'pda'); // the curve check still applies
  assert.equal(d.holders[0].ownerKind.kind, 'unknown');
});

test('routes: protections — origin, method, parameters, configuration, test copy, per-IP limit, budget', async () => {
  __resetInvestigate();
  const never = async () => { throw new Error('upstream must not be called'); };
  assert.equal((await call(H(), baseEnv(), never, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(H(), baseEnv(), never, { origin: null })).status, 403);
  assert.equal((await call(H(), baseEnv(), never, { method: 'POST' })).body.code, 'method_not_allowed');
  assert.equal((await call('/v1/investigate/holders?mint=xyz', baseEnv(), never)).body.code, 'invalid_mint');
  assert.equal((await call(`${H()}&extra=1`, baseEnv(), never)).status, 400);
  assert.equal((await call(`${H()}&mint=${MINT}`, baseEnv(), never)).status, 400);
  assert.equal((await call('/v1/investigate/holders', baseEnv(), never)).status, 400);
  assert.equal((await call(`/v1/investigate/activity?mint=${MINT}`, baseEnv(), never)).status, 400);
  assert.equal((await call(`/v1/investigate/activity?mint=${MINT}&account=${addr(1)}&before=short`, baseEnv(), never)).status, 400);
  assert.equal((await call('/v1/investigate/nope', baseEnv(), never)).status, 404);
  const nc = await call(H(), { ALLOWED_ORIGINS: ORIGIN }, never);
  assert.equal(nc.status, 503);
  assert.equal(nc.body.code, 'provider_not_configured');
  const demo = await call(H(), baseEnv({ TEST_COPY: '1' }), never);
  assert.equal(demo.status, 503);
  assert.equal(demo.body.code, 'demo_unavailable');
  // per-IP limit for investigation
  __resetInvestigate();
  const w = holderWorld();
  const { f } = rpcFetch(w.script);
  const env = baseEnv({ RATE_INVESTIGATE_PER_MIN: '3' });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await call(H(), env, f, { ip: '10.77.0.1' })).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
  // upstream budget: 1 RPC call per minute is not enough for a snapshot
  __resetInvestigate();
  const b = await call(H(), baseEnv({ UPSTREAM_PER_MIN_INVESTIGATE: '1' }), rpcFetch(w.script).f);
  assert.equal(b.status, 429);
  assert.equal(b.body.code, 'budget_exhausted');
  assert.ok(Number(b.h.get('retry-after')) > 0);
  // with 2 the snapshot itself fits; only the optional owner-type read is skipped, and the answer says so
  __resetInvestigate();
  const p = await call(H(), baseEnv({ UPSTREAM_PER_MIN_INVESTIGATE: '2' }), rpcFetch(w.script).f);
  assert.equal(p.status, 200);
  assert.match(p.body.coverage.ownersNote, /budget_exhausted/);
});

// ---------------------------------------------------------------------------------------------------- activity
function activityWorld(o: { sigCount?: number; missing?: number[]; failing?: number[]; broken?: number[] } = {}) {
  const n = o.sigCount ?? 4;
  const sigs = Array.from({ length: n }, (_, i) => ({ signature: sig(100 + i), slot: 900 - i, err: o.failing?.includes(i) ? { InstructionError: [0, 'Custom'] } : null, blockTime: 1_800_000_000 - i, confirmationStatus: 'finalized' }));
  const script: RpcScript = {
    getAccountInfo: () => ({ context: { slot: 950 }, value: tokenAcct(MINT, OWNER, '123') }),
    getSignaturesForAddress: () => sigs,
    getTransaction: (p) => {
      const i = sigs.findIndex((s) => s.signature === p[0]);
      if (o.missing?.includes(i)) return null;
      if (o.broken?.includes(i)) return new Response('x', { status: 500 });
      return parsedTx({
        slot: sigs[i].slot, keys: [OWNER, ACCT, PEER_ACCT],
        outer: [xfer('transferChecked', i % 2 ? { source: ACCT, destination: PEER_ACCT, mint: MINT, tokenAmount: { amount: String(1000 + i) } } : { source: PEER_ACCT, destination: ACCT, mint: MINT, tokenAmount: { amount: String(1000 + i) } })],
        pre: [tb(1, MINT, OWNER, '0'), tb(2, MINT, PEER, '0')], post: [tb(1, MINT, OWNER, '0'), tb(2, MINT, PEER, '0')],
      });
    },
  };
  return { sigs, script };
}
const A = (o: { before?: string } = {}) => `/v1/investigate/activity?mint=${MINT}&account=${ACCT}${o.before ? `&before=${o.before}` : ''}`;

test('activity: successful transactions only, newest first, bounded, contract-valid', async () => {
  __resetInvestigate();
  const w = activityWorld({ failing: [1] });
  const { f, calls } = rpcFetch(w.script);
  const r = await call(A(), baseEnv(), f);
  assert.equal(r.status, 200, r.text);
  const d = validateActivity(r.body, MINT, ACCT);
  assert.equal(calls.filter((c) => c.method === 'getTransaction').length, 3); // the failed one is never opened
  assert.ok(!calls.some((c) => c.method === 'getTransaction' && c.params[0] === w.sigs[1].signature));
  assert.deepEqual(calls.find((c) => c.method === 'getSignaturesForAddress')!.params, [ACCT, { limit: 10, commitment: 'finalized' }]);
  assert.equal(d.coverage.failedSignaturesSkipped, 1);
  assert.equal(d.coverage.successfulSignatures, 3);
  assert.equal(d.coverage.complete, true);
  assert.equal(d.coverage.nextBefore, null);
  assert.deepEqual(d.transfers.map((e) => e.slot), [900, 898, 897]);
  assert.deepEqual(d.transfers.map((e) => e.direction), ['in', 'in', 'out']);
  assert.equal(d.tokenAccount.decimals, 6);
  const gtx = calls.find((c) => c.method === 'getTransaction')!;
  assert.deepEqual(gtx.params[1], { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 });
});

test('activity: missing bodies and failed reads are counted as incomplete coverage; pagination uses before=', async () => {
  __resetInvestigate();
  const w = activityWorld({ sigCount: 10, missing: [2], broken: [3] });
  const { f, calls } = rpcFetch(w.script);
  const d = validateActivity((await call(A(), baseEnv(), f)).body, MINT, ACCT);
  assert.equal(d.coverage.missingTransactionBodies, 1);
  assert.equal(d.coverage.transactionFetchErrors, 1);
  assert.equal(d.coverage.complete, false);
  assert.equal(d.transfers.length, 8);
  assert.equal(d.coverage.nextBefore, w.sigs[9].signature);
  const older = await call(A({ before: w.sigs[9].signature }), baseEnv(), f);
  assert.equal(older.status, 200);
  assert.deepEqual(calls.filter((c) => c.method === 'getSignaturesForAddress').pop()!.params[1], { limit: 10, commitment: 'finalized', before: w.sigs[9].signature });
});

test('activity: wrong-mint account, closed account and non-token account are refused before any history is read', async () => {
  for (const [value, code, status] of [[tokenAcct(OTHER_MINT, OWNER, '1'), 'account_mint_mismatch', 400], [null, 'account_not_found', 404], [mintAcct('5'), 'invalid_account', 400]] as const) {
    __resetInvestigate();
    const { f, calls } = rpcFetch({ getAccountInfo: () => ({ context: { slot: 1 }, value }) });
    const r = await call(A(), baseEnv(), f);
    assert.equal(r.status, status);
    assert.equal(r.body.code, code);
    assert.ok(!calls.some((c) => c.method === 'getSignaturesForAddress'));
  }
});

test('activity: a rate limit midway stops further reads and reports a partial sample', async () => {
  __resetInvestigate();
  const w = activityWorld({ sigCount: 10 });
  let n = 0;
  const { f } = rpcFetch({ ...w.script, getTransaction: (p, k) => (++n === 2 ? new Response('slow', { status: 429 }) : w.script.getTransaction(p, k)) });
  const d = validateActivity((await call(A(), baseEnv(), f)).body, MINT, ACCT);
  assert.equal(d.coverage.complete, false);
  assert.equal(d.coverage.haltedBy, 'provider_rate_limited');
  assert.ok(d.coverage.transactionsNotFetched > 0);
});

test('existing /v1 routes still answer after the investigation router (config)', async () => {
  const r = await call('/v1/config', baseEnv(), async () => { throw new Error('none'); });
  assert.equal(r.status, 200);
  assert.equal(r.body.liveSwaps, false);
  assert.equal(r.body.feeBps, 50);
});
