/**
 * Live check of a DEPLOYED BAGZ Worker against the REAL providers. Run it after `wrangler deploy`, before pointing the app at it.
 *
 *   npx tsx scripts/probe-worker.ts https://bagz-proxy.<you>.workers.dev --token <PROBE_TOKEN> [--origin https://arielgutierrez15.github.io]
 *
 * Every endpoint is called on its own and its answer is parsed with the SAME validators the app uses, so a PASS means
 * "the app will understand this response". Nothing here signs or sends a transaction; the swap execute endpoint is only
 * sent an invalid body to prove the Worker rejects it.
 * Exit code 0 = no FAIL. pump.fun is reported but cannot fail the run (it is an unofficial API).
 */
import { parseDexPairs, parseDexProfiles, parseGtPools, parseGtTrades, parseJupiterPrice, parseJupiterTokens, parseOhlcv, parsePumpCoins, parseRpc, parseRugSummary, poolHasBase } from '../src/providers/adapters';
import { parseOrder } from '../src/trading/jupiter';
import { validateHolders, validateActivity } from '../src/investigate/validate';

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/$/, '');
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const token = opt('token') || process.env.PROBE_TOKEN || '';
const origin = opt('origin') || 'https://arielgutierrez15.github.io';
if (!base) { console.error('usage: npx tsx scripts/probe-worker.ts <worker-url> --token <PROBE_TOKEN> [--origin <site>]'); process.exit(2); }

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

type Row = { name: string; result: 'PASS' | 'FAIL' | 'WARN' | 'SKIP'; detail: string };
const rows: Row[] = [];
const log = (r: Row) => { rows.push(r); console.log(`${r.result.padEnd(4)}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`); };

async function call(path: string, o: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const t0 = Date.now();
  const res = await fetch(base + path, { method: o.method || 'GET', headers: { 'x-bagz-probe': token, ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.headers || {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  const text = await res.text();
  let json: unknown; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, ms: Date.now() - t0, h: res.headers };
}
async function endpoint(name: string, path: string, parse: (j: unknown) => unknown, describe: (v: any) => string, o: { method?: string; body?: unknown; soft?: boolean } = {}) {
  try {
    const r = await call(path, o);
    if (r.status !== 200) { log({ name, result: o.soft ? 'WARN' : 'FAIL', detail: `HTTP ${r.status} ${(r.json as any)?.error || r.text.slice(0, 80)} (upstream ${r.h.get('x-bagz-upstream-status') || '?'})` }); return undefined; }
    const v = parse(r.json);
    log({ name, result: 'PASS', detail: `${describe(v)} · ${r.ms} ms · cache ${r.h.get('x-bagz-cache')}` });
    return v as any;
  } catch (e: any) { log({ name, result: o.soft ? 'WARN' : 'FAIL', detail: `response not usable by the app: ${e?.message || e}` }); return undefined; }
}

// ---- 1. the Worker itself
const health = await call('/health', { headers: { 'x-bagz-probe': '' } });
const hj: any = health.json;
log({ name: '/health', result: health.status === 200 && hj?.ok ? 'PASS' : 'FAIL', detail: health.status === 200 ? `v${hj.version} keys ${JSON.stringify(hj.keys)} protection ${JSON.stringify(hj.protection)}` : `HTTP ${health.status}` });
if (hj?.keys && !hj.keys.jupiter) log({ name: 'Jupiter key configured', result: 'WARN', detail: 'JUPITER_API_KEY not set: Jupiter is limited to 0.5 req/s' });
if (hj?.keys && !hj.keys.coingecko) log({ name: 'CoinGecko key configured', result: 'WARN', detail: 'COINGECKO_API_KEY not set: GeckoTerminal is keyless (~10 calls/min) and the Worker budget is 8/min' });
if (hj?.protection && !hj.protection.rateLimiter) log({ name: 'Cloudflare rate-limit binding', result: 'WARN', detail: 'RATE_LIMITER not bound: only the per-instance limit applies' });

// ---- 2. access control, from the outside
const pre = await fetch(base + '/p/ds/token-boosts/top/v1', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
log({ name: `CORS preflight from ${origin}`, result: pre.status === 204 && pre.headers.get('access-control-allow-origin') === origin ? 'PASS' : 'FAIL', detail: `HTTP ${pre.status}, allow-origin ${pre.headers.get('access-control-allow-origin')}` });
const evil = await fetch(base + '/p/ds/token-boosts/top/v1', { headers: { origin: 'https://evil.example' } });
log({ name: 'another website is refused', result: evil.status === 403 && !evil.headers.get('access-control-allow-origin') ? 'PASS' : 'FAIL', detail: `HTTP ${evil.status}` });
const anon = await fetch(base + '/p/ds/token-boosts/top/v1');
log({ name: 'script without Origin or token is refused', result: anon.status === 403 ? 'PASS' : 'FAIL', detail: `HTTP ${anon.status}` });
const smuggle = await fetch(base + '/p/jup/tokens/v2/recent?api-key=x', { headers: { origin } });
log({ name: 'unknown query parameters are refused', result: smuggle.status === 400 ? 'PASS' : 'FAIL', detail: `HTTP ${smuggle.status}` });
const viaBrowser = await fetch(base + '/p/ds/token-boosts/top/v1', { headers: { origin } });
log({ name: 'allowed origin gets data with CORS', result: viaBrowser.status === 200 && viaBrowser.headers.get('access-control-allow-origin') === origin ? 'PASS' : 'FAIL', detail: `HTTP ${viaBrowser.status}` });
if (!token) { log({ name: 'probe token', result: 'SKIP', detail: 'no --token given, so the per-endpoint checks below are skipped' }); finish(); }
const tok = await call('/p/ds/token-boosts/top/v1');
if (tok.status === 403) { log({ name: 'probe token accepted', result: 'FAIL', detail: 'the Worker rejected the token; check PROBE_TOKEN' }); finish(); }

// ---- 3. every data endpoint, real providers, app validators
await endpoint('DexScreener new listings', '/p/ds/token-profiles/latest/v1', parseDexProfiles, (v) => `${v.length} profiles`);
await endpoint('DexScreener boosts', '/p/ds/token-boosts/top/v1', parseDexProfiles, (v) => `${v.length} boosts`);
const pairs = await endpoint('DexScreener prices', `/p/ds/tokens/v1/solana/${BONK},${USDC}`, parseDexPairs, (v) => `${v.length} pairs, BONK $${v.find((p: any) => p.baseToken?.address === BONK)?.priceUsd}`);
await endpoint('Jupiter new tokens', '/p/jup/tokens/v2/recent', parseJupiterTokens, (v) => `${v.length} tokens`);
for (const l of ['toptrending', 'toporganicscore', 'toptraded']) await endpoint(`Jupiter ${l}`, `/p/jup/tokens/v2/${l}/1h?limit=50`, parseJupiterTokens, (v) => `${v.length} tokens`);
await endpoint('Jupiter token details', `/p/jup/tokens/v2/search?query=${BONK}`, parseJupiterTokens, (v) => `${v.length} match, symbol ${v[0]?.symbol}`);
await endpoint('Jupiter SOL price', `/p/jup/price/v3?ids=${SOL}`, parseJupiterPrice, (v) => `SOL $${v[SOL]?.usdPrice}`);
const gtPools = await endpoint('GeckoTerminal pool lookup', `/p/gt/networks/solana/tokens/${BONK}/pools?page=1`, parseGtPools, (v) => `${v.data.length} pools, ${v.data.filter((p: any) => poolHasBase(p, 'solana', BONK)).length} with BONK as base`);
await endpoint('GeckoTerminal new pools', '/p/gt/networks/solana/new_pools?include=base_token', parseGtPools, (v) => `${v.data.length} pools`);
await endpoint('GeckoTerminal trending', '/p/gt/networks/solana/trending_pools?include=base_token', parseGtPools, (v) => `${v.data.length} pools`);
const pool = gtPools?.data.find((p: any) => poolHasBase(p, 'solana', BONK))?.attributes?.address;
if (pool) {
  const o = await endpoint('GeckoTerminal candles (24H / 15m)', `/p/gt/networks/solana/pools/${pool}/ohlcv/minute?aggregate=15&limit=98&currency=usd&token=base`, parseOhlcv,
    (v) => `${v.candles.length} candles, ${v.dropped} dropped, meta.base ${v.baseAddress === BONK ? 'matches BONK' : v.baseAddress ? 'MISMATCH ' + v.baseAddress : 'absent'}`);
  if (o && o.baseAddress && o.baseAddress !== BONK) log({ name: 'candle token check', result: 'FAIL', detail: 'GeckoTerminal priced the candles in another token' });
  if (o && pairs) {
    const ds = Number(pairs.find((p: any) => p.baseToken?.address === BONK)?.priceUsd);
    const last = o.candles[o.candles.length - 1]?.c;
    const gap = ds > 0 && last > 0 ? Math.abs(last - ds) / ds : NaN;
    log({ name: 'candle close vs DexScreener price', result: gap < 0.05 ? 'PASS' : 'WARN', detail: `${(gap * 100).toFixed(2)}% apart (different pools and moments can differ a little)` });
  }
  await endpoint('GeckoTerminal trades', `/p/gt/networks/solana/pools/${pool}/trades`, parseGtTrades, (v) => `${v.length} trades`);
} else log({ name: 'GeckoTerminal candles / trades', result: 'SKIP', detail: 'no BONK-base pool found to test with' });
await endpoint('RugCheck report', `/p/rug/v1/tokens/${BONK}/report/summary`, parseRugSummary, (v) => `${v.risks.length} risks`);
await endpoint('pump.fun new coins (unofficial)', '/p/pump/coins?offset=0&limit=30&sort=created_timestamp&order=DESC&includeNsfw=false', parsePumpCoins, (v) => `${v.length} coins`, { soft: true });
await endpoint('pump.fun livestreams (unofficial)', '/p/pump/coins/currently-live?limit=50&offset=0&includeNsfw=false', parsePumpCoins, (v) => `${v.length} live`, { soft: true });
const rpc = (method: string, params: unknown[]) => ({ method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
await endpoint('Solana RPC getLatestBlockhash', '/p/rpc', parseRpc, (v) => `slot ${v?.context?.slot ?? '?'}`, rpc('getLatestBlockhash', []));
await endpoint('Solana RPC getTokenSupply', '/p/rpc', parseRpc, (v) => `BONK supply ${v?.value?.uiAmountString ?? '?'}`, rpc('getTokenSupply', [BONK]));
await endpoint('Solana RPC getTokenLargestAccounts', '/p/rpc', parseRpc, (v) => `${v?.value?.length ?? '?'} accounts`, rpc('getTokenLargestAccounts', [BONK]));
await endpoint('Solana RPC getSignatureStatuses', '/p/rpc', parseRpc, (v) => `${v?.value?.length ?? '?'} statuses`, rpc('getSignatureStatuses', [['5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'], { searchTransactionHistory: false }]));
const send = await call('/p/rpc', rpc('sendTransaction', ['x']));
log({ name: 'RPC sendTransaction is refused', result: send.status === 403 ? 'PASS' : 'FAIL', detail: `HTTP ${send.status}` });

// ---- 4. Jupiter swap: quote only (no taker = no transaction is built), execute is never really called
const lamports = '10000000'; // 0.01 SOL
const orderRaw = await call(`/p/jup/swap/v2/order?inputMint=${SOL}&outputMint=${USDC}&amount=${lamports}&slippageBps=50`);
if (orderRaw.status === 200) {
  try {
    const q = parseOrder(orderRaw.json);
    const keys = Object.keys(orderRaw.json as object).sort();
    const usd = Number(q.outAmount) / 1e6;
    log({ name: 'Jupiter swap quote (0.01 SOL → USDC, no taker)', result: q.transaction === null && Number(q.outAmount) > 0 ? 'PASS' : 'FAIL', detail: `out ${usd.toFixed(4)} USDC, router ${q.router}, fee ${q.feeBps} bps, transaction ${q.transaction ? 'PRESENT (unexpected)' : 'none'}` });
    log({ name: 'Jupiter order fields (resolves the price-impact name)', result: 'PASS', detail: keys.join(', ') });
    log({ name: 'price impact reported', result: q.priceImpactPct !== undefined ? 'PASS' : 'WARN', detail: q.priceImpactPct !== undefined ? `${q.priceImpactPct}` : 'not present under priceImpactPct / priceImpact; the app will say "not reported"' });
  } catch (e: any) { log({ name: 'Jupiter swap quote', result: 'FAIL', detail: e.message }); }
} else log({ name: 'Jupiter swap quote', result: 'FAIL', detail: `HTTP ${orderRaw.status} ${(orderRaw.json as any)?.error || ''}` });
const exec = await call('/p/jup/swap/v2/execute', { method: 'POST', body: { signedTransaction: 'not-a-transaction', requestId: 'probe' } });
log({ name: 'fee-less Jupiter execute relay is closed', result: exec.status === 403 ? 'PASS' : 'FAIL', detail: `HTTP ${exec.status}` });

// ---- 5. BAGZ API (/v1): configuration and switches. Never prepares, signs or sends anything.
const cfg = await call('/v1/config');
if (cfg.status === 200) {
  const c = cfg.json as any;
  log({ name: 'API config reachable', result: 'PASS', detail: `liveSwaps=${c.liveSwaps} liveBoostPayments=${c.liveBoostPayments} feeBps=${c.feeBps} db=${c.database} rpc=${c.rpc}` });
  log({ name: 'platform fee is 50 bps', result: c.feeBps === 50 ? 'PASS' : 'FAIL', detail: String(c.feeBps) });
  log({ name: 'D1 binding "Db" connected', result: c.database ? 'PASS' : 'FAIL', detail: String(c.database) });
  log({ name: 'accounts enabled (sign-up screen will show)', result: c.accounts ? 'PASS' : 'FAIL', detail: String(c.accounts) });
  log({ name: 'fee accounts configured', result: c.feeAccounts?.wsol && c.feeAccounts?.usdc ? 'PASS' : 'WARN', detail: JSON.stringify(c.feeAccounts) });
  log({ name: 'BOOST receiving account configured', result: c.boostConfigured ? 'PASS' : 'WARN', detail: String(c.boostConfigured) });
  log({ name: 'live money switches are OFF', result: !c.liveSwaps && !c.liveBoostPayments ? 'PASS' : 'WARN', detail: 'expected OFF until reviews are complete' });
} else log({ name: 'API config reachable', result: 'FAIL', detail: `HTTP ${cfg.status}` });
const lb = await call('/v1/leaderboard');
log({ name: 'leaderboard (accounts tables migrated)', result: lb.status === 200 ? 'PASS' : 'FAIL', detail: `HTTP ${lb.status}${lb.status !== 200 ? ' — run worker/migrations/0002_social.sql' : ''}` });
const active = await call('/v1/boost/active');
log({ name: 'BOOST active list (D1 query)', result: active.status === 200 ? 'PASS' : 'FAIL', detail: `HTTP ${active.status} · ${(active.json as any)?.campaigns?.length ?? '?'} live campaigns` });

// ---- 6. Investigate (/v1/investigate): read-only research, real Solana RPC through the Worker's secret. Never signs or sends.
// "configured" in health only means a key is set; the holder request below is what proves the key and plan work.
const ih = await call('/v1/investigate/health');
const ihj: any = ih.json;
if (ih.status === 404) log({ name: 'investigate routes deployed', result: 'FAIL', detail: 'HTTP 404: this Worker does not have /v1/investigate yet' });
else log({ name: 'investigate health', result: ih.status === 200 && ihj?.configured ? 'PASS' : 'FAIL', detail: ih.status === 200 ? `provider ${ihj.provider} · configured=${ihj.configured} (not proof the key works)` : `HTTP ${ih.status} ${ihj?.error || ''}` });
if (ih.status === 200 && ihj?.configured) {
  const hold = await call(`/v1/investigate/holders?mint=${BONK}`);
  if (hold.status !== 200) log({ name: 'investigate holders (BONK, real RPC)', result: 'FAIL', detail: `HTTP ${hold.status} ${(hold.json as any)?.code || ''} ${(hold.json as any)?.error || ''}` });
  else {
    try {
      const d = validateHolders(hold.json, BONK);
      log({ name: 'investigate holders (BONK, real RPC)', result: d.holders.length > 0 ? 'PASS' : 'WARN', detail: `${d.holders.length} owners from ${d.coverage.tokenAccountsReturned} token accounts · ${d.coverage.includedPercent ?? '?'}% of supply · slots ${d.slots.ranking}/${d.slots.accounts} · ${d.consistency.changedAccounts} changed · ${hold.ms} ms` });
      const again = await call(`/v1/investigate/holders?mint=${BONK}`);
      log({ name: 'investigate holders cached on the second call', result: (again.json as any)?.cache?.hit ? 'PASS' : 'WARN', detail: `cache ${JSON.stringify((again.json as any)?.cache)}` });
      const acct = d.holders[0]?.accounts[0]?.address;
      if (acct) {
        const act = await call(`/v1/investigate/activity?mint=${BONK}&account=${acct}`);
        if (act.status !== 200) log({ name: 'investigate activity (largest BONK account)', result: 'FAIL', detail: `HTTP ${act.status} ${(act.json as any)?.code || ''} ${(act.json as any)?.error || ''}` });
        else {
          const a = validateActivity(act.json, BONK, acct);
          log({ name: 'investigate activity (largest BONK account)', result: 'PASS', detail: `${a.transfers.length} events from ${a.coverage.successfulSignatures}/${a.coverage.signaturesReturned} successful signatures · complete=${a.coverage.complete} · ${act.ms} ms` });
          if (!a.coverage.complete) log({ name: 'investigate activity coverage', result: 'WARN', detail: `missing bodies ${a.coverage.missingTransactionBodies}, fetch errors ${a.coverage.transactionFetchErrors}, halted ${a.coverage.haltedBy}` });
        }
      }
    } catch (e: any) { log({ name: 'investigate holders (BONK, real RPC)', result: 'FAIL', detail: `answer not usable by the app: ${e?.message || e}` }); }
  }
  const bad = await call('/v1/investigate/holders?mint=not-a-mint');
  log({ name: 'investigate rejects an invalid mint', result: bad.status === 400 ? 'PASS' : 'FAIL', detail: `HTTP ${bad.status}` });
  const evilInv = await fetch(base + `/v1/investigate/holders?mint=${BONK}`, { headers: { origin: 'https://evil.example' } });
  log({ name: 'investigate refuses other websites', result: evilInv.status === 403 ? 'PASS' : 'FAIL', detail: `HTTP ${evilInv.status}` });
}

finish();

function finish(): never {
  const n = (r: Row['result']) => rows.filter((x) => x.result === r).length;
  console.log(`\n${n('PASS')} pass · ${n('FAIL')} fail · ${n('WARN')} warn · ${n('SKIP')} skipped`);
  process.exit(n('FAIL') ? 1 : 0);
}
