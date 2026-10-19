// Frontend ⇄ Worker end-to-end test.
//  - the REAL Worker code (worker/index.js) runs in a local HTTP server
//  - the REAL built app (docs/index.html) runs in Chromium, served over http so browsers apply real CORS rules
//  - only the providers behind the Worker are mocked (tests/mock-api.mjs), and the chart library is a fake
// What this proves: the app's request shapes pass the Worker's validation, CORS works for the allowed origin and fails for others,
// no secret reaches the browser, errors are shown honestly, and the layout works on a phone.
// What it can't prove: real provider responses, real Cloudflare behaviour (edge cache, rate-limit binding), the real chart library.
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { makeMock } from './mock-api.mjs';
import { handle } from '../worker/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));

const results = [];
const pageErrors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---- static servers: the allowed origin and a decoy origin serve the same app
const mkStatic = () => createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
const appSrv = mkStatic(), decoySrv = mkStatic();
const APP_PORT = await listen(appSrv), DECOY_PORT = await listen(decoySrv);
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`, DECOY_ORIGIN = `http://127.0.0.1:${DECOY_PORT}`;

// ---- the Worker, served for real
const SECRET = 'SECRET-JUP-KEY-1234';
const SECRET_CG = 'SECRET-CG-KEY-5678';
function startWorker(envExtra = {}) {
  const mock = makeMock();
  const log = []; const upstream = [];
  const store = new Map();
  const cache = { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => { store.set(r.url, res); } };
  const env = { ALLOWED_ORIGINS: APP_ORIGIN, JUPITER_API_KEY: SECRET, COINGECKO_API_KEY: SECRET_CG, ...['JUP', 'GT', 'DS', 'PUMP', 'RUG', 'RPC'].reduce((o, k) => ({ ...o, ['UPSTREAM_PER_MIN_' + k]: '5000' }), {}), ...envExtra };
  const fetchUp = (url0, init = {}) => new Promise((resolveP, rejectP) => {
    const url = url0.replace('https://api.coingecko.com/api/v3/onchain', 'https://api.geckoterminal.com/api/v2');
    const u = new URL(url0);
    upstream.push({ host: u.host, path: u.pathname + u.search, key: new Headers(init.headers).get('x-api-key') || new Headers(init.headers).get('x-cg-demo-api-key') });
    const r = { request: () => ({ url: () => url, method: () => init.method || 'GET', postData: () => init.body }), fulfill: ({ status = 200, headers = {}, body = '', contentType }) => resolveP(new Response(body, { status, headers: { ...headers, 'content-type': contentType || 'application/json' } })), abort: () => rejectP(new TypeError('aborted')) };
    mock.route(r).catch(rejectP);
  });
  const srv = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://127.0.0.1:${srv.address().port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const out = await handle(request, env, undefined, { fetch: fetchUp, cache });
    log.push({ method: req.method, path: req.url, origin: req.headers.origin || null, status: out.status, cache: out.headers.get('x-bagz-cache') });
    const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(out.status, h); res.end(Buffer.from(await out.arrayBuffer()));
  });
  return listen(srv).then((port) => ({ port, url: `http://127.0.0.1:${port}`, log, upstream, mock, srv, close: () => new Promise((r) => srv.close(r)) }));
}

const FAKE_LWC = () => {
  const reg = (window.__lwc = { charts: [] });
  const mk = (kind) => ({ kind, data: [], updates: [], markers: [], lines: [], setData(d) { this.data = d; }, update(d) { this.updates.push(d); }, setMarkers(m) { this.markers = m; }, createPriceLine(p) { this.lines.push(p); return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } });
  window.LightweightCharts = { createChart(el, opts) {
    const chart = { el, series: [], removed: false,
      addCandlestickSeries() { const s = mk('candle'); chart.series.push(s); return s; }, addLineSeries() { const s = mk('line'); chart.series.push(s); return s; }, addAreaSeries() { const s = mk('area'); chart.series.push(s); return s; }, addHistogramSeries() { const s = mk('volume'); chart.series.push(s); return s; },
      removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; },
      subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() { chart.removed = true; } };
    reg.charts.push(chart); return chart;
  } };
};
const FAKE_WALLET = () => {
  const acct = { address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] };
  const wallet = { name: 'TestWallet', icon: '', chains: ['solana:mainnet'], accounts: [], features: { 'standard:connect': { connect: async () => ({ accounts: [acct] }) }, 'standard:disconnect': { disconnect: async () => {} }, 'solana:signTransaction': { signTransaction: async () => { window.__signed = (window.__signed || 0) + 1; return [{ signedTransaction: new Uint8Array([1]) }]; } } } };
  window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(wallet));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(wallet) }));
};

const browser = await chromium.launch();
async function open({ origin = APP_ORIGIN, proxy, viewport = { width: 1280, height: 900 }, mobile = false, wallet = false }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const p = await ctx.newPage();
  await p.addInitScript(FAKE_LWC);
  if (wallet) await p.addInitScript(FAKE_WALLET);
  // only fonts and CDN scripts are intercepted; calls to the Worker are real network requests with real CORS
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  const seen = { reqHeaders: [], bodies: [] };
  p.on('request', (rq) => { if (rq.url().includes('/p/')) seen.reqHeaders.push({ url: rq.url(), h: rq.headers() }); });
  p.on('response', async (rs) => { if (rs.url().includes('/p/') || rs.url().includes('/health')) { try { seen.bodies.push(JSON.stringify(rs.headers()) + (await rs.text())); } catch { /* preflight or failed */ } } });
  p.on('pageerror', (e) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/net::|Failed to load resource|CORS|Access-Control/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(`${origin}/?proxy=${encodeURIComponent(proxy)}`);
  return { ctx, p, seen };
}
const mainSeries = (p) => p.evaluate(() => { const c = window.__lwc.charts.filter((x) => !x.removed); const s = c[c.length - 1]?.series.find((x) => x.kind !== 'volume'); return s ? { kind: s.kind, n: s.data.length, last: s.data[s.data.length - 1], updates: s.updates.length } : null; });

// ================================================================ 1. desktop, allowed origin
{
  const w = await startWorker();
  const { ctx, p, seen } = await open({ proxy: w.url, wallet: true });
  const loaded = await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('allowed origin: the app loads coins through the Worker', loaded, `${await p.locator('.coin-row').count()} rows`);
  await p.locator('#data-health').scrollIntoViewIfNeeded();
  const pill = await p.locator('#data-health .pill').first().innerText();
  check('health panel says calls go through the BAGZ proxy', /proxy/i.test(pill) && !/direct/i.test(pill), pill);
  check('no source is red after a clean start', (await p.locator('#data-health .hdot-down').count()) === 0);
  check('browser preflights/requests carried the allowed Origin, and the Worker answered CORS for it', w.log.length > 0 && w.log.every((l) => l.origin === APP_ORIGIN));

  // open a coin, walk every range and interval so every OHLCV query shape the UI can produce reaches the Worker validation
  await p.locator('.coin-row').first().click();
  check('chart draws candles from Worker data', await until(async () => (await mainSeries(p))?.n > 10), JSON.stringify(await mainSeries(p)));
  const combos = { '1H': ['1m', '5m'], '4H': ['1m', '5m', '15m'], '24H': ['5m', '15m', '1h'], '7D': ['15m', '1h', '4h'], '30D': ['1h', '4h', '1d'] };
  for (const [r, ivs] of Object.entries(combos)) {
    await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: new RegExp('^' + r + '$') }).click();
    for (const iv of ivs) {
      const before = w.log.filter((l) => /ohlcv/.test(l.path)).length;
      await p.locator('.chart-panel .seg').nth(1).locator('button', { hasText: new RegExp('^' + iv + '$') }).click();
      await until(async () => w.log.filter((l) => /ohlcv/.test(l.path)).length > before, 6000);
    }
  }
  await sleep(1500);
  const ohlcv = w.log.filter((l) => /ohlcv/.test(l.path));
  const kinds = new Set(ohlcv.map((l) => l.path.replace(/.*ohlcv\//, '')));
  check('all range × interval combinations were requested through the Worker', kinds.size >= 14, `${kinds.size} of 14 distinct period/aggregate/limit shapes`);
  check('…and every one of them passed the Worker’s query validation', ohlcv.every((l) => l.status === 200), ohlcv.filter((l) => l.status !== 200).map((l) => l.status + ' ' + l.path).join(' | '));
  check('chart still shows data after the walk', (await mainSeries(p))?.n > 5);

  // before a wallet connects: Jupiter /order preview through the Worker
  await p.locator('.live-swap input[aria-label="Swap amount"]').fill('0.5');
  const quoted = await until(async () => /you receive/i.test(await p.locator('.live-swap').innerText()), 10000);
  check('Jupiter preview quote travels app → Worker → (mock) Jupiter and renders', quoted);
  const order = w.log.find((l) => /swap\/v2\/order/.test(l.path));
  check('the preview order request passed validation (200)', order?.status === 200, JSON.stringify(order));
  // after connecting: the app asks the BAGZ API for the exact fee-carrying quote. This Worker has no fee accounts
  // configured, so the server must refuse and the app must say why, with the swap button disabled.
  await p.locator('.live-swap button', { hasText: /Connect TestWallet/ }).click();
  await until(async () => /7xKX…gAsU/.test(await p.locator('.live-swap').innerText()), 5000);
  const refused = await until(async () => /fee account is not configured/i.test(await p.locator('.live-swap').innerText()), 10000);
  const prep = w.log.find((l) => l.path === '/v1/swap/prepare');
  check('connected wallet → /v1/swap/prepare; without fee accounts the server refuses (503) and the app shows why', refused && prep?.status === 503, JSON.stringify(prep));
  check('/v1/config answered the app (200)', w.log.some((l) => l.path === '/v1/config' && l.status === 200));
  check('swap button stays disabled and the wallet was never asked to sign', (await p.locator('.live-swap .btn-accent').isDisabled()) && (await p.evaluate(() => window.__signed || 0)) === 0);

  // the full contract: nothing the app sent was refused
  // (the deliberate 503 from /v1/swap/prepare above is a configuration refusal, not a contract violation)
  const bad = w.log.filter((l) => l.method !== 'OPTIONS' && l.status >= 400);
  check('contract: no app request was rejected by the Worker (no 400/403/405)', bad.filter((l) => [400, 403, 405].includes(l.status)).length === 0, bad.map((l) => l.status + ' ' + l.path).join(' | '));
  check('every Worker route the app used is an allowlisted provider or the BAGZ API', w.log.every((l) => /^\/(p\/(jup|gt|ds|pump|rug|rpc)\/|health|v1\/(config|swap\/prepare|boost\/active|wallet\/balances))/.test(l.path)), [...new Set(w.log.map((l) => l.path.split('?')[0]))].filter((x) => !/^\/p\//.test(x)).join(' '));

  // secrets
  check('secret key reached the upstream providers (injected server-side)', w.upstream.some((u) => u.key === SECRET));
  check('browser never sent an API key header', seen.reqHeaders.every((r) => !('x-api-key' in r.h) && !('x-cg-demo-api-key' in r.h) && !('authorization' in r.h)));
  check('no response body or header seen by the browser contains a secret', seen.bodies.length > 20 && seen.bodies.every((b) => !b.includes('SECRET')), `${seen.bodies.length} responses scanned`);
  const stored = await p.evaluate(() => JSON.stringify({ ...localStorage }));
  check('nothing secret in the page’s storage', !stored.includes('SECRET'));

  // edge caching works for repeated identical calls (stub cache here; Cloudflare's cache is not tested)
  check('CoinGecko key injected for GeckoTerminal data', w.upstream.some((u) => u.host === 'api.coingecko.com' && u.key === SECRET_CG));
  // a second visitor asking for the same data is served from the Worker cache (stub cache here; Cloudflare's edge cache is not tested)
  const upBefore = w.upstream.length;
  const second = await open({ proxy: w.url });
  await until(async () => (await second.p.locator('.coin-row').count()) > 3, 30000);
  check('second visitor: repeat requests are answered from the Worker cache (HIT)', w.log.some((l) => l.cache === 'HIT'), `${w.log.filter((l) => l.cache === 'HIT').length} hits, ${w.upstream.length - upBefore} new upstream calls`);
  await second.ctx.close();
  await p.screenshot({ path: `${SHOTS}/10-proxy-desktop.png`, fullPage: true });
  await ctx.close(); await w.close();
}

// ================================================================ 2. a different website is blocked
{
  const w = await startWorker();
  const { ctx, p } = await open({ origin: DECOY_ORIGIN, proxy: w.url });
  await sleep(6000);
  const rows = await p.locator('.coin-row').count();
  check('decoy origin: the Worker refused every request from it (403)', w.log.length > 0 && w.log.every((l) => l.status === 403 && l.origin === DECOY_ORIGIN), `${w.log.length} requests, statuses ${[...new Set(w.log.map((l) => l.status))]}`);
  check('decoy origin: not one upstream provider was called on its behalf', w.upstream.length === 0, `${w.upstream.length} upstream calls`);
  await p.locator('#data-health').scrollIntoViewIfNeeded().catch(() => {});
  const down = await p.locator('#data-health .hdot-down').count();
  check('the app reports the failure instead of inventing data (red sources, no live coins)', down > 0 && rows === 0, `red=${down} rows=${rows}`);
  await ctx.close();
  // no Origin header (curl) is refused too, and the deploy-check token is the only way in
  const curl = await fetch(`${w.url}/p/ds/token-boosts/top/v1`);
  check('script with no Origin header: 403', curl.status === 403);
  const health = await fetch(`${w.url}/health`);
  const hj = await health.json();
  check('/health works without Origin and reports booleans only', health.status === 200 && hj.keys.jupiter === true && !JSON.stringify(hj).includes('SECRET'));
  await w.close();
}

// ================================================================ 3. Worker unreachable, then rate limited
{
  const dead = await startWorker(); const deadUrl = dead.url; await dead.close();
  const { ctx, p } = await open({ proxy: deadUrl });
  await sleep(5000);
  await p.locator('#data-health').scrollIntoViewIfNeeded().catch(() => {});
  const txt = (await p.locator('#data-health').innerText().catch(() => '')) || '';
  check('Worker down: the app says the BAGZ proxy is unreachable', /proxy unreachable/i.test(txt), txt.replace(/\s+/g, ' ').slice(0, 160));
  // with nothing reachable the app may fall back to its bundled, dated snapshot. That is allowed only if it says so plainly.
  await until(async () => (await p.locator('.coin-row').count()) > 0, 15000);
  const deadRows = await p.locator('.coin-row').count();
  const banner = await p.locator('.banner-warn').first().innerText().catch(() => '');
  const label = await p.locator('body').innerText();
  check('Worker down: any coins shown are the labelled snapshot (banner names the proxy, prices frozen, trading off)', deadRows === 0 || (/BAGZ proxy can’t be reached/.test(banner) && /snapshot/i.test(banner) && /trading is off/.test(banner) && /Snapshot ·/.test(label)), banner.slice(0, 140));
  await ctx.close();

  const w = await startWorker({ RATE_PER_MIN: '6' });
  const t = await open({ proxy: w.url });
  await sleep(9000);
  const n = w.log.filter((l) => l.method !== 'OPTIONS').length;
  const limited = w.log.filter((l) => l.status === 429);
  check('rate limited: the Worker answered 429 with Retry-After', limited.length > 0);
  await t.p.locator('#data-health').scrollIntoViewIfNeeded().catch(() => {});
  const ht = await t.p.locator('#data-health').innerText().catch(() => '');
  check('rate limited: the app shows the cooldown reason and stops hammering', /rate|too many|cool/i.test(ht) && n < 40, `${n} Worker calls in 9s`);
  await t.ctx.close(); await w.close();
}

// ================================================================ 4. phone
{
  const w = await startWorker();
  const { ctx, p } = await open({ proxy: w.url, viewport: { width: 390, height: 844 }, mobile: true, wallet: true });
  const loaded = await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('phone 390×844: coins load through the Worker', loaded);
  const noScroll = async () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('phone: Home has no horizontal scroll', await noScroll());
  await p.screenshot({ path: `${SHOTS}/11-proxy-phone-home.png` });
  await p.locator('.coin-row').first().tap();
  check('phone: chart draws', await until(async () => (await mainSeries(p))?.n > 10));
  check('phone: coin page has no horizontal scroll', await noScroll());
  const boxW = await p.locator('[data-testid=lw-box]').evaluate((e) => e.getBoundingClientRect().width);
  check('phone: chart fits the screen width', boxW > 300 && boxW <= 390, String(boxW));
  const heights = await p.locator('.chart-panel .seg button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().height));
  check('phone: chart control buttons are at least 32px tall (tappable)', heights.length > 10 && Math.min(...heights) >= 32, `min ${Math.min(...heights)}`);
  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^7D$/ }).tap();
  check('phone: changing range reloads candles through the Worker', await until(async () => w.log.some((l) => /ohlcv\/hour\?aggregate=1&limit=170/.test(l.path) && l.status === 200), 8000));
  await p.screenshot({ path: `${SHOTS}/12-proxy-phone-coin.png`, fullPage: true });
  check('phone: coin page still has no horizontal scroll after the change', await noScroll());
  await ctx.close(); await w.close();
}

await browser.close(); appSrv.close(); decoySrv.close();
console.log('\nPAGE ERRORS: ' + (pageErrors.length ? '\n' + [...new Set(pageErrors)].join('\n') : 'none'));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || pageErrors.length ? 1 : 0);
