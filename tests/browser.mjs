// Browser test: runs the built app (docs/index.html) in Chromium against a MOCKED provider API and a FAKE chart library.
// Mocks are test fixtures only (shapes taken from real responses recorded in src/snapshot.ts). Nothing here ships in the app.
// Usage: node tests/browser.mjs   (PLAYWRIGHT=/path/to/playwright/index.mjs, SHOTS=/dir for screenshots)
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const APP = 'file://' + resolve(root, 'docs/index.html');

import { makeMock } from './mock-api.mjs';

// fake Lightweight Charts v4: records every call so the test can inspect what the app drew
const FAKE_LWC = () => {
  const reg = (window.__lwc = { charts: [] });
  const mk = (kind, o, chart) => ({ kind, o, chart, data: [], updates: [], markers: [], lines: [], removed: false,
    setData(d) { this.data = d; }, update(d) { this.updates.push(d); }, setMarkers(m) { this.markers = m; },
    createPriceLine(p) { this.lines.push(p); return { applyOptions() {} }; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } });
  window.LightweightCharts = { createChart(el, opts) {
    const chart = { el, opts, series: [], fit: 0, handlers: [], removed: false,
      addCandlestickSeries(o) { const s = mk('candle', o, chart); chart.series.push(s); return s; }, addLineSeries(o) { const s = mk('line', o, chart); chart.series.push(s); return s; },
      addAreaSeries(o) { const s = mk('area', o, chart); chart.series.push(s); return s; }, addHistogramSeries(o) { const s = mk('volume', o, chart); chart.series.push(s); return s; },
      removeSeries(s) { s.removed = true; }, priceScale() { return { applyOptions() {} }; },
      timeScale() { return { fitContent() { chart.fit++; }, scrollToRealTime() {}, applyOptions() {}, setVisibleLogicalRange() {} }; },
      subscribeCrosshairMove(f) { chart.handlers.push(f); }, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() { chart.removed = true; } };
    reg.charts.push(chart);
    return chart;
  } };
};
const FAKE_WALLET = () => {
  const acct = { address: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', publicKey: new Uint8Array(32), chains: ['solana:mainnet'], features: [] };
  const wallet = { name: 'TestWallet', icon: '', chains: ['solana:mainnet'], accounts: [], features: { 'standard:connect': { connect: async () => ({ accounts: [acct] }) }, 'standard:disconnect': { disconnect: async () => {} }, 'solana:signTransaction': { signTransaction: async () => { window.__signed = (window.__signed || 0) + 1; return [{ signedTransaction: new Uint8Array([1]) }]; } } } };
  const announce = () => window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(wallet) }));
  window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(wallet));
  announce();
};

// ---------------------------------------------------------------- runner
const results = [];
const pageErrors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }

const browser = await chromium.launch();
async function newPage({ viewport = { width: 1280, height: 900 }, mock, lwc = true, wallet = false, storage } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  if (lwc) await p.addInitScript(FAKE_LWC);
  if (wallet) await p.addInitScript(FAKE_WALLET);
  if (storage) await p.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  await p.route('**/*', (r) => {
    const url = r.request().url();
    // "no chart library" also means the vendored copy in docs/vendor/ is missing
    if (!lwc && url.startsWith('file:') && url.includes('/vendor/lightweight-charts')) return r.abort();
    return url.startsWith('file:') ? r.continue() : mock.route(r);
  });
  p.on('pageerror', (e) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/net::|Failed to load resource|CORS|Access-Control/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(APP);
  return { ctx, p };
}
const charts = (p) => p.evaluate(() => window.__lwc.charts.filter((c) => !c.removed).map((c) => ({ series: c.series.filter((s) => !s.removed).map((s) => ({ kind: s.kind, n: s.data.length, first: s.data[0], last: s.data[s.data.length - 1], updates: s.updates.length, lastUpdate: s.updates[s.updates.length - 1], markers: s.markers.length, lines: s.lines.length })), fit: c.fit })));
const mainSeries = async (p) => { const c = await charts(p); const ch = c[c.length - 1]; return ch?.series.find((s) => s.kind !== 'volume'); };
const volSeries = async (p) => { const c = await charts(p); return c[c.length - 1]?.series.find((s) => s.kind === 'volume'); };

// ================================================================ 1. desktop, healthy providers
{
  const mock = makeMock();
  const { ctx, p } = await newPage({ mock, wallet: true });
  await until(async () => (await p.locator('.coin-row').count()) > 3, 30000);
  await p.screenshot({ path: `${SHOTS}/01-home-desktop.png`, fullPage: true });

  check('title is BAGZ', (await p.title()) === 'BAGZ', await p.title());
  const logo = await p.locator('img.brand-mark').first().evaluate((i) => ({ w: i.naturalWidth, alt: i.alt, h: i.getBoundingClientRect().height }));
  check('BAGZ wordmark image loads and is visible', logo.w > 500 && logo.alt === 'BAGZ' && logo.h > 20, JSON.stringify(logo));
  const css = await p.evaluate(() => ({ accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(), bg: getComputedStyle(document.body).backgroundColor }));
  check('palette: hot pink #FF008C on #090909', css.accent === '#ff008c' && css.ink === '#090909' && css.bg === 'rgb(9, 9, 9)', JSON.stringify(css));
  const text = (await p.locator('body').innerText()).toLowerCase();
  check('no leftover "frenzy" text in the UI', !text.includes('frenzy'));

  // provider health
  await p.locator('#data-health').scrollIntoViewIfNeeded();
  const rows = await p.locator('#data-health .health li').count();
  check('health panel lists the providers', rows >= 10, rows + ' rows');
  const via = await p.locator('#data-health .pill').first().innerText();
  check('health panel says calls go direct from the browser (no proxy configured)', /direct/i.test(via), via);
  check('every source that answered shows OK', (await p.locator('#data-health .hdot-down').count()) === 0);
  check('Jupiter calls use api.jup.ag, not the deprecated lite-api', mock.requests.some((r) => r.startsWith('api.jup.ag/tokens/v2')) && !mock.requests.some((r) => r.startsWith('lite-api')));
  check('home shows coins from several sources', (await p.locator('.mover').count()) > 0 && (await p.locator('.coin-row').count()) > 5);

  // open a coin with a pool and look at the chart
  const target = p.locator('.coin-row').first();
  const sym = await target.locator('b').first().innerText();
  await target.click();
  const ok24 = await until(async () => (await mainSeries(p))?.n > 10);
  check(`coin page $${sym}: candlestick series created with data`, ok24, JSON.stringify(await mainSeries(p)).slice(0, 160));
  await p.screenshot({ path: `${SHOTS}/02-coin-desktop.png`, fullPage: true });
  let ms = await mainSeries(p);
  check('default range 24H / 15m draws ~96 candles (the requested 98 trimmed to the 24h window)', ms?.kind === 'candle' && ms.n >= 96 && ms.n <= 98, `kind=${ms?.kind} n=${ms?.n}`);
  check('candles are in ascending time order with OHLC fields', ms.first.time < ms.last.time && ['open', 'high', 'low', 'close'].every((k) => ms.first[k] > 0));
  const vs = await volSeries(p);
  check('volume histogram drawn with the same candles', vs?.n === ms.n);
  check('high/low markers placed', ms.markers === 2, String(ms.markers));

  const rangeBtns = await p.locator('.chart-panel .seg').nth(0).locator('button').allInnerTexts();
  check('range buttons are 1H 4H 24H 7D 30D', rangeBtns.join(',') === '1H,4H,24H,7D,30D', rangeBtns.join(','));
  const ivOf = async () => (await p.locator('.chart-panel .seg').nth(1).locator('button').allInnerTexts()).join(',');

  const lastUrl = (re) => [...mock.requests].reverse().find((r) => re.test(r)) || '';
  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^7D$/ }).click();
  await until(async () => /ohlcv\/hour\?aggregate=1&limit=170/.test(lastUrl(/ohlcv/)));
  check('7D → 1h candles requested with limit 170', /ohlcv\/hour\?aggregate=1&limit=170/.test(lastUrl(/ohlcv/)), lastUrl(/ohlcv/));
  check('7D offers 15m / 1h / 4h', (await ivOf()) === '15m,1h,4h', await ivOf());
  await until(async () => (await mainSeries(p))?.n >= 168);
  check('7D chart holds ~168 hourly candles', (await mainSeries(p))?.n >= 168 && (await mainSeries(p))?.n <= 170, String((await mainSeries(p))?.n));

  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^30D$/ }).click();
  await until(async () => /ohlcv\/hour\?aggregate=4&limit=182/.test(lastUrl(/ohlcv/)));
  check('30D → 4h candles requested with limit 182', /ohlcv\/hour\?aggregate=4&limit=182/.test(lastUrl(/ohlcv/)), lastUrl(/ohlcv/));
  await until(async () => (await mainSeries(p))?.n >= 180);

  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^1H$/ }).click();
  await until(async () => /ohlcv\/minute\?aggregate=1&limit=62/.test(lastUrl(/ohlcv/)));
  check('1H → 1m candles requested with limit 62', /ohlcv\/minute\?aggregate=1&limit=62/.test(lastUrl(/ohlcv/)), lastUrl(/ohlcv/));
  check('1H offers 1m / 5m', (await ivOf()) === '1m,5m', await ivOf());

  // independent interval per range
  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^24H$/ }).click();
  await p.locator('.chart-panel .seg').nth(1).locator('button', { hasText: /^1h$/ }).click();
  await until(async () => /ohlcv\/hour\?aggregate=1&limit=26/.test(lastUrl(/ohlcv/)));
  check('24H with 1h interval → limit 26', /ohlcv\/hour\?aggregate=1&limit=26/.test(lastUrl(/ohlcv/)), lastUrl(/ohlcv/));
  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^7D$/ }).click();
  await p.locator('.chart-panel .seg').nth(0).locator('button', { hasText: /^24H$/ }).click();
  const active = await p.locator('.chart-panel .seg').nth(1).locator('button.on').innerText();
  check('each range remembers its own interval (24H stays on 1h)', active === '1h', active);

  // chart types
  for (const [label, kind] of [['Line', 'line'], ['Area', 'area'], ['Candles', 'candle']]) {
    await p.locator('.chart-panel .seg').nth(2).locator('button', { hasText: new RegExp('^' + label + '$') }).click();
    const okType = await until(async () => (await mainSeries(p))?.kind === kind && (await mainSeries(p))?.n > 5);
    const s = await mainSeries(p);
    check(`chart type ${label}: ${kind} series with data`, okType && (kind === 'candle' ? 'open' in s.first : 'value' in s.first && !('open' in s.first)), `kind=${s?.kind} n=${s?.n}`);
  }
  // price/mcap axis (non-majors default to market cap, as before)
  await p.locator('.chart-panel .seg').nth(3).locator('button', { hasText: /^Price$/ }).click();
  await sleep(500);
  const priceClose = (await mainSeries(p)).last.close;
  await p.locator('.chart-panel .seg').nth(3).locator('button', { hasText: /^MCap$/ }).click();
  await sleep(500);
  const mcapClose = (await mainSeries(p)).last.close;
  check('MCap axis multiplies prices by supply', mcapClose > priceClose * 1000, `${priceClose} → ${mcapClose}`);
  check('no price-mismatch warning when the chart pool and the quote agree', (await p.locator('.chart-note.warn').count()) === 0, (await p.locator('.chart-note.warn').allInnerTexts()).join(' / '));

  // meta/status line is truthful
  const meta = await p.locator('.chart-meta').innerText();
  check('status line shows interval, candle count, pool and fetch age', /candles/.test(meta) && /GeckoTerminal pool/.test(meta) && /fetched .* ago/.test(meta), meta.replace(/\n/g, ' | '));

  // live tick from a real price refresh
  const upd0 = (await mainSeries(p)).updates;
  mock.boost = 1.08;
  const moved = await until(async () => { const s = await mainSeries(p); return s.updates > upd0 && s.lastUpdate; }, 45000, 500);
  check('live price tick updates the newest candle (series.update)', !!moved, JSON.stringify(moved || {}));
  await p.screenshot({ path: `${SHOTS}/03-coin-after-tick.png`, fullPage: true });
  // live swap panel
  const swapTxt = await p.locator('.live-swap').innerText();
  check('live swap panel says trading is switched off', /Preview only/.test(swapTxt) && /switched off/.test(swapTxt));
  check('swap button is disabled', await p.locator('.live-swap .btn-accent').isDisabled());
  await p.locator('.live-swap button', { hasText: /Connect TestWallet/ }).click();
  check('wallet connects through the Wallet Standard (address shown, no key requested)', await until(async () => /7xKX…gAsU/.test(await p.locator('.live-swap').innerText()), 5000));
  await p.locator('.live-swap input[aria-label="Swap amount"]').fill('0.5');
  const quoted = await until(async () => /you receive/i.test(await p.locator('.live-swap').innerText()), 8000);
  check('live Jupiter quote appears (min after slippage, route, fee)', quoted && /metis/i.test(await p.locator('.live-swap').innerText()));
  const orderReq = mock.requests.find((r) => r.includes('/swap/v2/order'));
  check('quote request has no taker, so nothing signable is created', orderReq && !orderReq.includes('taker='), orderReq);
  check('swap still disabled with a quote and a connected wallet', await p.locator('.live-swap .btn-accent').isDisabled());
  check('the wallet was never asked to sign', (await p.evaluate(() => window.__signed || 0)) === 0);
  await p.locator('.live-swap').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SHOTS}/04-live-swap.png` });

  // switch to another coin: no stale candles from the previous one
  const firstClose = (await mainSeries(p)).last.close;
  await p.locator('.back').click();
  await p.locator('.coin-row').nth(2).click();
  await until(async () => { const s = await mainSeries(p); return s && s.last && s.last.close !== firstClose; }, 15000);
  const second = (await mainSeries(p)).last.close;
  check('opening a different coin loads that coin’s own candles', second !== firstClose, `${firstClose} → ${second}`);

  // paper trading + persistence
  await p.locator('.trade-bar .btn-accent').click();
  const enabled = await until(async () => await p.locator('.sheet button[type=submit]').isEnabled(), 15000);
  check('paper trade ticket enables once a fresh price is fetched', enabled);
  if (enabled) {
    await p.locator('.sheet button[type=submit]').click();
    await sleep(500);
  }
  await p.locator('button:visible', { hasText: /^Wallet$/ }).first().click();
  const posN = await p.locator('.pos').count();
  check('paper buy creates a position', posN >= 1, String(posN));
  await p.reload();
  await until(async () => (await p.locator('.coin-row').count()) > 0, 20000);
  await p.locator('button:visible', { hasText: /^Wallet$/ }).first().click();
  check('paper wallet survives a reload', (await p.locator('.pos').count()) === posN);
  await p.screenshot({ path: `${SHOTS}/05-wallet.png` });
  await ctx.close();
}

// ================================================================ 2. providers failing
{
  const mock = makeMock({ fail: { pump: 403, gtTrades: 429 } });
  const { ctx, p } = await newPage({ mock });
  await until(async () => (await p.locator('.coin-row').count()) > 3, 30000);
  await p.locator('#data-health').scrollIntoViewIfNeeded();
  await sleep(500);
  const text = await p.locator('#data-health').innerText();
  check('pump.fun failure is shown with a plain explanation', /pump\.fun/.test(text) && /no supported public API/.test(text) && /unofficial/i.test(text));
  check('failed sources show a red status dot', (await p.locator('#data-health .hdot-down').count()) >= 1);
  check('other providers keep working while pump.fun is down', (await p.locator('.coin-row').count()) > 3);
  await p.locator('.coin-row').first().click();
  await until(async () => (await mainSeries(p))?.n > 10, 20000);
  await p.locator('.seg button', { hasText: 'Live trades' }).first().click().catch(() => {});
  await sleep(1500);
  const tradesTxt = await p.locator('.coin-view').innerText();
  check('GeckoTerminal trades 429 is reported, no invented trades', /Couldn’t load swaps|Loading swaps/.test(tradesTxt) && (await p.locator('.tape li').count()) === 0, (tradesTxt.match(/Couldn’t load swaps[^\n]*/) || [''])[0]);
  await p.screenshot({ path: `${SHOTS}/06-failing-providers.png`, fullPage: true });
  await ctx.close();
}

// ================================================================ 3. chart library unavailable → basic chart, honest note
{
  const mock = makeMock();
  const { ctx, p } = await newPage({ mock, lwc: false });
  await until(async () => (await p.locator('.coin-row').count()) > 3, 30000);
  await p.locator('.coin-row').first().click();
  const fb = await until(async () => await p.locator('.lw-fallback').count(), 20000);
  check('without Lightweight Charts the basic chart is shown with an explicit notice', !!fb && /couldn’t load/.test(await p.locator('.lw-fallback').innerText()));
  check('the fallback chart still draws candles from real data', (await p.locator('.chart svg').count()) > 0);
  await p.screenshot({ path: `${SHOTS}/07-fallback-chart.png`, fullPage: true });
  await ctx.close();
}

// ================================================================ 4. phone layout
{
  const mock = makeMock();
  const { ctx, p } = await newPage({ mock, viewport: { width: 390, height: 844 }, wallet: true });
  await until(async () => (await p.locator('.coin-row').count()) > 3, 30000);
  await p.screenshot({ path: `${SHOTS}/08-home-phone.png`, fullPage: true });
  let w = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check('phone home: no horizontal scroll', w[0] <= w[1], JSON.stringify(w));
  check('phone: bottom tab bar visible', await p.locator('.tabbar').isVisible());
  await p.locator('.coin-row').first().click();
  await until(async () => (await mainSeries(p))?.n > 10, 20000);
  await sleep(400);
  w = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  const box = await p.locator('[data-testid=lw-box]').boundingBox();
  check('phone coin page: no horizontal scroll', w[0] <= w[1], JSON.stringify(w));
  check('phone: chart fits the screen width', box && box.width <= 390 && box.width > 300, JSON.stringify(box));
  const seg = await p.locator('.chart-panel .toolbar').boundingBox();
  check('phone: chart controls stay inside the viewport', seg && seg.x >= 0 && seg.x + seg.width <= 391, JSON.stringify(seg));
  await p.screenshot({ path: `${SHOTS}/09-coin-phone.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log('\nPAGE ERRORS:', pageErrors.length ? '\n' + [...new Set(pageErrors)].join('\n') : 'none');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (pageErrors.length) failed.push({ name: 'page errors' });
process.exit(failed.length ? 1 : 0);
