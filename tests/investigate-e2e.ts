/**
 * Browser test of the Investigate section: the REAL built app (docs/index.html) in Chromium, talking over HTTP with real
 * CORS to the REAL Worker code (worker/index.js → api.js → investigate.js). Behind the Worker: a scripted Solana RPC
 * (different holders per mint, with transfers between them) and the usual mocked market providers (tests/mock-api.mjs).
 * Also opens the test copy (docs/demo/index.html) to prove investigation is refused there.
 * Checks: on-demand loading, bubbles/table/selection, transfer feed and evidence lines, error states, stale-token
 * protection when switching coins fast, chart + trade button still working, phone layout, accessibility basics.
 * Run: node --import tsx tests/investigate-e2e.ts   (needs Playwright + Chromium; build first: npm run build && npm run build:copy)
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { generateKeyPairSync } from 'crypto';
// @ts-ignore plain JS
import { makeMock } from './mock-api.mjs';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import { b58encode } from '../worker/solana.js';
// @ts-ignore plain JS
import { __resetInvestigate } from '../worker/investigate.js';
import { OFF, tokenAcct, mintAcct, parsedTx, tb, xfer, opaque, JUP, SYSTEM, RAYDIUM } from './investigate-fixtures';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));
const DEMO_HTML = readFileSync(resolve(root, 'docs/demo/index.html'));

const results: { name: string; ok: boolean }[] = [];
const pageErrors: string[] = [];
const check = (name: string, ok: unknown, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, ms = 15000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const serve = (html: Buffer) => createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
const appSrv = serve(HTML), demoSrv = serve(DEMO_HTML);
const APP = `http://127.0.0.1:${await listen(appSrv)}`, DEMO = `http://127.0.0.1:${await listen(demoSrv)}`;

// ---- a scripted chain: each mint gets its own holders; holder #1 sends to #2, swaps through a pool, and pays an account
// that is created and closed in the same transaction (owner unresolvable)
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const rndKey = () => b58encode(new Uint8Array(generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)));
const rndAddr = () => b58encode(crypto.getRandomValues(new Uint8Array(32)));
const rndSig = () => b58encode(crypto.getRandomValues(new Uint8Array(64)));
interface World { mint: string; owners: string[]; accts: string[]; amounts: string[]; pool: string; sigs: string[] }
const worlds = new Map<string, World>();
function world(mint: string): World {
  if (worlds.has(mint)) return worlds.get(mint)!;
  const owners = Array.from({ length: 11 }, rndKey);
  owners[2] = OFF[worlds.size % OFF.length]; // a program-derived owner (pool authority)
  const owner = (i: number) => (i === 11 ? owners[0] : owners[i]); // account 11 also belongs to holder #1
  const accts = Array.from({ length: 12 }, rndAddr);
  let a = 4_000_000_000_000_000_000n; // above Number.MAX_SAFE_INTEGER
  const amounts = accts.map((_, i) => { const v = a; a = a / 2n - BigInt(i * 7919); return v.toString(); });
  const w = { mint, owners: accts.map((_, i) => owner(i)), accts, amounts, pool: rndAddr(), sigs: [rndSig(), rndSig(), rndSig()] };
  worlds.set(mint, w);
  return w;
}
const delay = { mint: '', ms: 0 };
const rpcLog: { method: string; mint?: string }[] = [];
async function rpc(body: any): Promise<Response> {
  const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'content-type': 'application/json' } });
  const p = body.params || [];
  rpcLog.push({ method: body.method, mint: typeof p[0] === 'string' ? p[0] : undefined });
  if (body.method === 'getTokenLargestAccounts') {
    if (delay.mint === p[0] && delay.ms) await sleep(delay.ms);
    const w = world(p[0]);
    return ok({ context: { slot: 300_000_100 }, value: w.accts.map((x, i) => ({ address: x, amount: w.amounts[i], decimals: 6, uiAmount: Number(w.amounts[i]) / 1e6, uiAmountString: '' })) });
  }
  if (body.method === 'getTokenSupply') return ok({ context: { slot: 1 }, value: { amount: '10000000000000000000', decimals: 6, uiAmount: 1e13, uiAmountString: '10000000000000' } });
  if (body.method === 'getMultipleAccounts') {
    const keys: string[] = p[0];
    if (p[1]?.encoding === 'base64') return ok({ context: { slot: 300_000_102 }, value: keys.map((k) => (OFF.includes(k) ? { owner: RAYDIUM, executable: false, lamports: 1, data: ['', 'base64'] } : { owner: SYSTEM, executable: false, lamports: 1, data: ['', 'base64'] })) });
    const w = world(keys[0]);
    return ok({ context: { slot: 300_000_101 }, value: [mintAcct('10000000000000000000', 6), ...keys.slice(1).map((k) => { const i = w.accts.indexOf(k); return tokenAcct(w.mint, w.owners[i], w.amounts[i]); })] });
  }
  if (body.method === 'getAccountInfo') {
    for (const w of worlds.values()) { const i = w.accts.indexOf(p[0]); if (i >= 0) return ok({ context: { slot: 300_000_200 }, value: tokenAcct(w.mint, w.owners[i], w.amounts[i]) }); }
    return ok({ context: { slot: 300_000_200 }, value: null });
  }
  if (body.method === 'getSignaturesForAddress') {
    const w = [...worlds.values()].find((x) => x.accts.includes(p[0]))!;
    return ok(w.sigs.map((s, i) => ({ signature: s, slot: 300_000_050 - i, err: i === 2 ? { InstructionError: [0, 'Custom'] } : null, blockTime: 1_800_000_000 - i * 60, confirmationStatus: 'finalized' })));
  }
  if (body.method === 'getTransaction') {
    const w = [...worlds.values()].find((x) => x.sigs.includes(p[0]))!;
    const [h1, h2, pool] = [w.accts[0], w.accts[1], w.accts[2]];
    const tmp = rndAddr();
    if (p[0] === w.sigs[0]) {
      // top-level transfer #1 → #2, plus a payment to a temporary account (no token-balance record)
      return ok(parsedTx({ slot: 300_000_050, keys: [w.owners[0], h1, h2, tmp], outer: [opaque('ComputeBudget111111111111111111111111111111'), xfer('transferChecked', { source: h1, destination: h2, mint: w.mint, authority: w.owners[0], tokenAmount: { amount: '9007199254740993' } }), xfer('transferChecked', { source: h1, destination: tmp, mint: w.mint, authority: w.owners[0], tokenAmount: { amount: '1234500' } })],
        pre: [tb(1, w.mint, w.owners[0], w.amounts[0]), tb(2, w.mint, w.owners[1], w.amounts[1])], post: [tb(1, w.mint, w.owners[0], w.amounts[0]), tb(2, w.mint, w.owners[1], w.amounts[1])] }));
    }
    // a swap: Jupiter → pool program → token transfer from the pool vault into holder #1
    return ok(parsedTx({ slot: 300_000_049, keys: [w.owners[0], h1, pool, JUP, RAYDIUM], outer: [opaque(JUP)], inner: [{ index: 0, instructions: [opaque(RAYDIUM, 2), xfer('transfer', { source: pool, destination: h1, authority: w.owners[2], amount: '777000000' }, { stackHeight: 3 })] }],
      pre: [tb(1, w.mint, w.owners[0], '0'), tb(2, w.mint, w.owners[2], '0')], post: [tb(1, w.mint, w.owners[0], '0'), tb(2, w.mint, w.owners[2], '0')] }));
  }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }));
}

function startWorker(envExtra: Record<string, string> = {}, rpcOverride?: (body: any) => Promise<Response> | null) {
  // every test server runs in this one process, so they share the module's per-instance cache; a real Worker would not
  __resetInvestigate();
  const mock = makeMock();
  const seenBodies: string[] = [];
  const env: any = {
    ALLOWED_ORIGINS: APP, JUPITER_API_KEY: 'SECRET-JUP', HELIUS_API_KEY: 'SECRET-HELIUS-KEY', RATE_PER_MIN: '5000', RATE_INVESTIGATE_PER_MIN: '1000',
    ...['JUP', 'GT', 'DS', 'PUMP', 'RUG', 'RPC'].reduce((o, k) => ({ ...o, ['UPSTREAM_PER_MIN_' + k]: '5000' }), {}), ...envExtra,
  };
  for (const k of Object.keys(envExtra)) if (envExtra[k] === '') delete env[k];
  const viaMock = (url0: string, init: any = {}) => new Promise<Response>((res, rej) => {
    const url = url0.replace('https://api.coingecko.com/api/v3/onchain', 'https://api.geckoterminal.com/api/v2');
    const r = { request: () => ({ url: () => url, method: () => init.method || 'GET', postData: () => init.body }), fulfill: ({ status = 200, headers = {}, body = '', contentType }: any) => res(new Response(body, { status, headers: { ...headers, 'content-type': contentType || 'application/json' } })), abort: () => rej(new TypeError('aborted')) };
    mock.route(r).catch(rej);
  });
  const up = async (url: string, init: any = {}) => {
    if (url.startsWith('https://mainnet.helius-rpc.com/')) { const body = JSON.parse(String(init.body)); const o = rpcOverride?.(body); return (o && (await o)) || rpc(body); }
    const res = await viaMock(url, init);
    // give the chart pool GeckoTerminal-style transaction counts, so the Market view has something to draw
    const m = /\/networks\/solana\/tokens\/([1-9A-HJ-NP-Za-km-z]+)\/pools/.exec(url);
    if (m && m[1] === WIF) {
      const j = await res.json();
      for (const p of j.data) Object.assign(p.attributes, { name: 'WIF / SOL', reserve_in_usd: '5012345.67', transactions: { m5: { buys: 12, sells: 9, buyers: 10, sellers: 8 }, h1: { buys: 140, sells: 101 }, h24: { buys: 3012, sells: 2950 } }, volume_usd: { h24: '1250000.5', h1: '61000' } });
      return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
    }
    return res;
  };
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://127.0.0.1:${(srv.address() as any).port}${req.url}`, { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const out = await handle(request, env, undefined, { fetch: up, cache: null });
    const buf = Buffer.from(await out.arrayBuffer());
    if (req.url!.includes('/v1/investigate')) seenBodies.push(buf.toString());
    const h: Record<string, string> = {}; out.headers.forEach((v: string, k: string) => { h[k] = v; });
    res.writeHead(out.status, h); res.end(buf);
  });
  return listen(srv).then((port) => ({ url: `http://127.0.0.1:${port}`, seenBodies, close: () => new Promise((r) => srv.close(r)) }));
}

const FAKE_LWC = `window.LightweightCharts = { createChart() { const s = () => ({ setData() {}, update() {}, setMarkers() {}, createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } }); return { addCandlestickSeries: s, addLineSeries: s, addAreaSeries: s, addHistogramSeries: s, removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; }, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() {} }; } };`;
const browser = await chromium.launch();
async function open(base: string, proxy: string | null, o: { mobile?: boolean; mint?: string; mockPage?: boolean } = {}) {
  const ctx = await browser.newContext(o.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript({ content: FAKE_LWC });
  const invReq: string[] = [];
  p.on('request', (r: any) => { if (r.url().includes('/v1/investigate')) invReq.push(r.url()); });
  if (o.mockPage) { const mock = makeMock(); await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => mock.route(r)); }
  else await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => r.abort());
  p.on('pageerror', (e: Error) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m: any) => { if (m.type() === 'error' && !/net::|Failed to load resource|CORS|Access-Control/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  const q = new URLSearchParams();
  if (proxy) q.set('proxy', proxy);
  if (o.mint) q.set('tgWebAppStartParam', o.mint);
  await p.goto(`${base}/?${q}`);
  return { ctx, p, invReq };
}
const text = (p: any, sel: string) => p.locator(sel).first().innerText();
const noHScroll = (p: any) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const inv = (p: any) => p.locator('[data-testid=investigate]');

// ================================================================ 1. desktop: the full flow
{
  const w = await startWorker();
  const { ctx, p, invReq } = await open(APP, w.url, { mint: WIF });
  check('coin page opens (Telegram start parameter)', await until(async () => (await p.locator('.coin-view').count()) === 1, 40000));
  check('price chart is still on the token page', await until(async () => (await p.locator('.cv-chart [data-testid=lw-box], .cv-chart .chart-empty').count()) > 0, 15000));
  await inv(p).scrollIntoViewIfNeeded();
  check('Investigate section is on the Solana token page', await inv(p).isVisible());
  check('…next to the existing Holders section, which still loads (now through the Worker’s RPC)', await until(async () => (await p.locator('.cv-hlist li').count()) > 0, 15000));
  await sleep(500);
  check('nothing is requested until the user asks (on demand)', invReq.length === 0, `${invReq.length} requests`);
  await inv(p).locator('button', { hasText: 'Load holder map' }).click();
  const bubbles = inv(p).locator('.inv-bubble');
  check('bubble map draws one bubble per owner', await until(async () => (await bubbles.count()) === 11), `${await bubbles.count()} bubbles`);
  const scope = await text(p, '.inv-scope');
  check('scope says the 20 largest token accounts are not the 20 largest wallets', /not a ranking of the largest wallets/.test(scope), scope.slice(0, 120));
  const status = await text(p, '.inv-status');
  check('status shows provider, snapshot (not "live"), finality, slots, coverage and last refresh', /Helius Solana RPC/.test(status) && /Snapshot/.test(status) && /finalized/.test(status) && /300,000,100/.test(status) && /12 largest token accounts → 11 owners/.test(status) && /Last successful refresh/i.test(status) && !/\blive\b/i.test(status), status.replace(/\s+/g, ' ').slice(0, 220));
  check('program-derived owner is drawn as program-controlled', (await inv(p).locator('.inv-bubble.prog').count()) === 1);
  check('accessible: each bubble is a labelled, focusable button', await bubbles.first().getAttribute('role') === 'button' && /of supply from 2 token accounts/.test((await bubbles.first().getAttribute('aria-label')) || ''));
  // table alternative
  await inv(p).locator('button', { hasText: 'Table' }).click();
  const rows = inv(p).locator('.inv-table tbody tr');
  check('table view lists every owner', (await rows.count()) === 11);
  const t1 = await rows.first().innerText();
  const W = world(WIF);
  const sum1 = BigInt(W.amounts[0]) + BigInt(W.amounts[11]);
  check('table shows the exact grouped balance of holder #1 (two accounts) without float rounding', (await rows.first().locator('.inv-bal').getAttribute('title')) === `${sum1} raw units`, t1.replace(/\s+/g, ' '));
  check('table has a caption and column headers with sort state', (await inv(p).locator('.inv-table caption').count()) === 1 && (await inv(p).locator('.inv-table th[aria-sort=ascending]').count()) === 1);
  await inv(p).locator('.inv-table th button', { hasText: 'Accounts' }).click();
  check('sorting by accounts works', /accounts/i.test(await inv(p).locator('.inv-table th[aria-sort]:not([aria-sort=none])').innerText()) && (await rows.first().locator('td').last().innerText()).trim() === '1');
  await inv(p).locator('button', { hasText: 'Bubble map' }).click();
  // keyboard selection of holder #1
  await bubbles.first().focus();
  await p.keyboard.press('Enter');
  const wallet = inv(p).locator('.inv-wallet');
  check('keyboard Enter selects a holder and opens its details', await until(async () => (await wallet.count()) === 1));
  check('selected holder shows its full address', (await text(p, '.inv-addr')) === W.owners[0]);
  check('…and both of its token accounts', (await wallet.locator('.inv-acct').count()) === 2);
  const evs = wallet.locator('.inv-ev');
  check('transfer feed loads on demand for the selected account', await until(async () => (await evs.count()) === 3), `${await evs.count()} events`);
  const feed = await text(p, '.inv-feed');
  check('feed counts only successful transactions (1 failed skipped)', /2 successful, 1 failed \(skipped\)/.test(feed), feed.replace(/\s+/g, ' ').slice(0, 260));
  check('events show direction, readable amount, raw amount, time, slot and a Solscan tx link with the instruction', /OUT/.test(feed) && /IN/.test(feed) && /raw 9007199254740993/.test(feed) && /slot 300000050/.test(feed) && (await wallet.locator('.inv-ev a[href^="https://solscan.io/tx/"]').count()) === 3 && /#2/.test(feed) && /#1\.2/.test(feed));
  check('inner transfer keeps its program context (inside Jupiter → Raydium)', /inside Jupiter Aggregator v6 → Raydium AMM v4/.test(feed));
  check('an unresolvable endpoint stays an unknown token account', /unknown token account/.test(feed));
  check('evidence lines appear only after transfers were loaded: one wallet line, one swap line, one unresolved link', await until(async () => (await inv(p).locator('.inv-edge').count()) === 3) && (await inv(p).locator('.inv-edge-direct').count()) === 1 && (await inv(p).locator('.inv-edge-inner').count()) === 1 && (await inv(p).locator('.inv-edge-acct').count()) === 1);
  check('unknown token account is drawn as its own node', (await inv(p).locator('.inv-sat.unknown').count()) === 1);
  await inv(p).locator('.inv-edge-direct').first().focus();
  await p.keyboard.press('Enter');
  check('selecting a line lists its transfers with provenance', await until(async () => /1 transfer on this line/.test(await text(p, '.inv-edgebox'))) && /raw 9007199254740993/.test(await text(p, '.inv-edgebox')));
  check('the panel says lines are not evidence of ownership or wrongdoing', /not of common ownership, insiders, developers or wrongdoing/.test(await inv(p).innerText()));
  await inv(p).screenshot({ path: `${SHOTS}/investigate-desktop.png` });
  // market view
  await inv(p).locator('.seg button', { hasText: 'Market' }).click();
  check('market view draws buy/sell transaction-count bars for the chart pool only', await until(async () => (await inv(p).locator('.inv-txrow').count()) === 6) && /12 \/ 9/.test(await text(p, '.inv-market')));
  check('missing windows say unavailable (not zero)', /unavailable/.test(await text(p, '.inv-market')));
  check('reserve is labelled as not executable depth', /not executable depth/.test(await text(p, '.inv-market')));
  await inv(p).screenshot({ path: `${SHOTS}/investigate-market.png` });
  await inv(p).locator('button', { hasText: 'Candles & volume' }).click();
  await inv(p).locator('.seg button', { hasText: 'Holders' }).click();
  // trading controls still work
  await p.locator('.trade-bar .btn-accent').click();
  check('Buy button still opens the trade ticket', await until(async () => (await p.locator('.sheet').count()) > 0, 8000));
  await p.keyboard.press('Escape');
  const secretSeen = w.seenBodies.some((b) => b.includes('SECRET-HELIUS-KEY'));
  check('no secret in any investigation response', !secretSeen);
  await ctx.close();
  await w.close();
}

// ================================================================ 2. fast switching between tokens
{
  const w = await startWorker();
  const { ctx, p } = await open(APP, w.url, { mint: WIF });
  await until(async () => (await p.locator('.coin-view').count()) === 1, 40000);
  await inv(p).locator('button', { hasText: 'Load holder map' }).click();
  await until(async () => (await inv(p).locator('.inv-bubble').count()) === 11);
  // the next WIF answer is slow; open BONK while it is still loading
  delay.mint = WIF; delay.ms = 2500;
  await inv(p).locator('.inv-status button', { hasText: 'Refresh' }).click();
  await sleep(200);
  const search = p.locator('.desk-search .srch input');
  await search.fill(BONK);
  await until(async () => (await p.locator('.srch-panel .srch-row').count()) > 0, 10000);
  await p.locator('.srch-panel .srch-row').first().click();
  const B = world(BONK);
  check('the next token page loads its own holders by itself (session opt-in)', await until(async () => (await inv(p).locator('.inv-addr').count()) === 0 && (await inv(p).locator('.inv-bubble').count()) === 11 && ((await inv(p).locator('.inv-bubble').first().getAttribute('aria-label')) || '').includes(B.owners[0]), 15000));
  await sleep(3000); // the slow WIF answer arrives now
  const labels = await inv(p).locator('.inv-bubble').evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label') || '').join(' '));
  const A = world(WIF);
  check('a late answer for the previous token never replaces the new token’s map', labels.includes(B.owners[0]) && !A.owners.some((o) => labels.includes(o)));
  delay.ms = 0;
  await ctx.close();
  await w.close();
}

// ================================================================ 3. error states and other chains
{
  const nokey = await startWorker({ HELIUS_API_KEY: '' });
  let { ctx, p } = await open(APP, nokey.url, { mint: WIF });
  await until(async () => (await p.locator('.coin-view').count()) === 1, 40000);
  await inv(p).locator('button', { hasText: 'Load holder map' }).click();
  check('no RPC key on the server: says so, draws nothing, shows no demo data', await until(async () => /Solana RPC key missing on the server/.test(await inv(p).innerText())) && (await inv(p).locator('.inv-bubble').count()) === 0);
  await ctx.close(); await nokey.close();

  const refused = await startWorker({}, (b) => (b.method === 'getTokenLargestAccounts' ? Promise.resolve(new Response('unauthorized', { status: 401 })) : null));
  ({ ctx, p } = await open(APP, refused.url, { mint: WIF }));
  await until(async () => (await p.locator('.coin-view').count()) === 1, 40000);
  await inv(p).locator('button', { hasText: 'Load holder map' }).click();
  check('invalid key (401 from the RPC): explained, with a retry button', await until(async () => /refused the server’s key/.test(await inv(p).innerText())) && (await inv(p).locator('button', { hasText: 'Retry' }).count()) === 1);
  await ctx.close(); await refused.close();

  const limited = await startWorker({}, (b) => (b.method === 'getTokenLargestAccounts' ? Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '9' } })) : null));
  ({ ctx, p } = await open(APP, limited.url, { mint: WIF }));
  await until(async () => (await p.locator('.coin-view').count()) === 1, 40000);
  await inv(p).locator('button', { hasText: 'Load holder map' }).click();
  check('rate limit: explained with the wait time', await until(async () => /Rate limited[\s\S]*9 s/.test(await inv(p).innerText())));
  // an Ethereum coin from the home list
  await p.locator('.back').first().click();
  await until(async () => (await p.locator('.coin-row').count()) > 3, 20000);
  const eth = p.locator('.coin-row').filter({ hasText: /PEPE|SHIB|FLOKI|MOG|SPX/ }).first();
  if (await eth.count()) {
    await eth.click();
    check('non-Solana token: explicit unsupported state', await until(async () => /supports Solana tokens only/.test(await inv(p).innerText())) && (await inv(p).locator('button', { hasText: 'Load holder map' }).count()) === 0);
  } else check('non-Solana token: explicit unsupported state', false, 'no Ethereum coin on the home list to open');
  await ctx.close(); await limited.close();
}

// ================================================================ 4. phone layout
{
  const w = await startWorker();
  const { ctx, p } = await open(APP, w.url, { mint: WIF, mobile: true });
  await until(async () => (await p.locator('.coin-view').count()) === 1, 40000);
  await inv(p).scrollIntoViewIfNeeded();
  await inv(p).locator('button', { hasText: 'Load holder map' }).click();
  await until(async () => (await inv(p).locator('.inv-bubble').count()) === 11);
  await inv(p).locator('.inv-bubble').first().click();
  await until(async () => (await inv(p).locator('.inv-ev').count()) === 3);
  check('phone: no horizontal scroll with the map, wallet details and feed open', await noHScroll(p));
  const box = await inv(p).locator('.inv-svg').boundingBox();
  check('phone: the map fits the screen width', !!box && box.width <= 390 && box.height >= 200, JSON.stringify(box));
  const small = await inv(p).locator('.inv-bubble .inv-dot').evaluateAll((els: Element[]) => Math.min(...els.map((e) => (e as SVGGraphicsElement).getBoundingClientRect().width)));
  check('phone: the smallest bubble is still at least a 24px tap target', small >= 24, `${small.toFixed(1)}px`);
  await inv(p).screenshot({ path: `${SHOTS}/investigate-phone.png` });
  await inv(p).locator('button[aria-label="Zoom in"]').click();
  check('phone: zoom in/out controls work', (await inv(p).locator('.inv-svg.zoomed').count()) === 1);
  await inv(p).locator('button', { hasText: 'Fit' }).click();
  await ctx.close();
  await w.close();
}

// ================================================================ 5. the test copy refuses investigation
{
  const { ctx, p, invReq } = await open(DEMO, null, { mint: WIF, mockPage: true });
  // the test copy has accounts (in-page server), so it starts with its sign-up screen
  await until(async () => (await p.locator('.onboard input[autocomplete=username]').count()) === 1, 30000);
  await p.locator('.onboard input[autocomplete=username]').fill('inv_tester');
  await p.locator('.onboard input[autocomplete=new-password]').nth(0).fill('inv-tester-pw');
  await p.locator('.onboard input[autocomplete=new-password]').nth(1).fill('inv-tester-pw');
  await p.locator('.onboard button', { hasText: 'Continue' }).click();
  await until(async () => /Add a profile picture/.test(await text(p, '.onboard')), 20000);
  await p.locator('.onboard input[type=file]').setInputFiles(resolve(root, 'tests/fixtures/pfp-ana.png'));
  await until(async () => (await p.locator('.pfp-preview').count()) === 1, 8000);
  await p.locator('.onboard button', { hasText: 'Save and start trading' }).click();
  check('test copy: coin page opens', await until(async () => (await p.locator('.coin-view').count()) === 1, 40000));
  check('test copy: Investigate says it is unavailable and offers no fixtures or demo data', await until(async () => /Not available in the test copy/.test(await inv(p).innerText())) && (await inv(p).locator('.inv-bubble, button:has-text("Load holder map")').count()) === 0);
  check('test copy: no investigation request is made', invReq.length === 0);
  await ctx.close();
}

check('no runtime errors on any page', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
await browser.close();
appSrv.close(); demoSrv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
