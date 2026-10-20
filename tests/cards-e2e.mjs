// Trading cards + brand marks in Chromium (built app, mocked providers).
// Flow: buy on paper → position card → sell → closed-trade card opens by itself → wallet card → save image.
// Checks every card is a real 1200×750 PNG drawn by the app, labelled as paper trading, and that the new logos are used.
// Usage: node tests/cards-e2e.mjs
import { createServer } from 'http';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { makeMock } from './mock-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));
const results = [], pageErrors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }

const srv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${srv.address().port}/`;
check('splash: the round gorilla badge is in the page before the app starts', /<div id="root"><div class="boot"[^>]*><img src="data:image\/png;base64,/.test(HTML.toString()));

const browser = await chromium.launch();
async function open(phone) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true } : { viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.LightweightCharts = { createChart() { const s = () => ({ setData() {}, update() {}, setMarkers() {}, createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } }); return { addCandlestickSeries: s, addLineSeries: s, addAreaSeries: s, addHistogramSeries: s, removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; }, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() {} }; } }; });
  const mock = makeMock();
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => mock.route(r));
  p.on('pageerror', (e) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(APP);
  return { ctx, p };
}
/** size of the card image the app produced, and its pixels sampled (to prove something was drawn) */
const cardInfo = (p) => p.evaluate(async () => {
  const img = document.querySelector('.card-img');
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const px = (a, b) => Array.from(x.getImageData(a, b, 1, 1).data);
  let colours = new Set();
  for (let i = 0; i < 400; i++) { const d = x.getImageData((i * 97) % c.width, (i * 61) % c.height, 1, 1).data; colours.add(d.slice(0, 3).join(',')); }
  return { w: img.naturalWidth, h: img.naturalHeight, alt: img.alt, src: img.src.slice(0, 5), colours: colours.size, corner: px(5, 5) };
});

{
  const { ctx, p } = await open(true);
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('favicon is the new round badge', (await p.evaluate(() => document.querySelector('link[rel=icon]').href.length)) > 1000);
  // buy
  await p.locator('.coin-row').first().click();
  await p.locator('.trade-bar .btn-accent').click();
  await until(async () => p.locator('.sheet button[type=submit]').isEnabled(), 15000);
  await p.locator('.sheet button[type=submit]').click();
  await sleep(600);
  await p.locator('.tabbar button', { hasText: /^Wallet$/ }).click();
  await until(async () => (await p.locator('.pos').count()) >= 1, 8000);

  // position card
  await p.locator('.pos .icon-btn[aria-label^="Trading card"]').first().click();
  const pos = await until(() => cardInfo(p), 8000);
  check('position card: a 1200×750 PNG drawn by the app', pos && pos.w === 1200 && pos.h === 750 && pos.src === 'blob:', JSON.stringify(pos));
  check('position card has real artwork (many colours), black background', pos && pos.colours > 8 && pos.corner[0] < 30 && pos.corner[1] < 30, pos && `${pos.colours} colours`);
  check('position card text says it is a paper position', pos && /Holding \$.+ on BAGZ \(paper\)/.test(pos.alt), pos?.alt);
  check('card sheet says no real money was used', /No real money was used/.test(await p.locator('.sheet.share').innerText()));
  const img = await p.locator('.card-img').screenshot();
  writeFileSync(`${SHOTS}/card-position.png`, img);
  await p.locator('.sheet.share button[aria-label=Close]').click();

  // sell → closed trade card appears by itself
  await p.locator('.pos .btn', { hasText: 'Sell' }).first().click();
  await until(async () => p.locator('.sheet button[type=submit]').isEnabled(), 15000);
  await p.locator('.sheet button[type=submit]').click();
  const tr = await until(async () => { const i = await cardInfo(p); return i && /Closed/.test(i.alt) ? i : null; }, 10000);
  check('selling opens the closed-trade card automatically', !!tr, tr?.alt);
  check('closed-trade card is a 1200×750 PNG', tr && tr.w === 1200 && tr.h === 750);
  writeFileSync(`${SHOTS}/card-trade.png`, await p.locator('.card-img').screenshot());
  await p.screenshot({ path: `${SHOTS}/card-sheet-phone.png` });
  check('phone: card sheet has no horizontal scroll', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await p.locator('.sheet.share button[aria-label=Close]').click();

  // Cards tab keeps the closed trade's card
  await p.locator('.tabbar button', { hasText: /^Cards$/ }).click();
  check('Cards tab: the closed trade’s card was saved automatically', await until(async () => (await p.locator('.card-thumb').count()) === 1, 8000));
  check('Cards tab: phone layout fits with 7 tabs', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await p.screenshot({ path: `${SHOTS}/cards-tab-phone.png` });
  await p.locator('.tabbar button', { hasText: /^Wallet$/ }).click();
  // activity row card
  await p.locator('.seg button', { hasText: /^Activity/ }).click();
  await p.locator('.activity .icon-btn[aria-label*="sell"]').first().click();
  const act = await until(async () => { const i = await cardInfo(p); return i && /Closed/.test(i.alt) ? i : null; }, 8000);
  check('a past sell in Activity can be turned into a card', !!act);
  await p.locator('.sheet.share button[aria-label=Close]').click();

  // wallet card + save
  await p.locator('button', { hasText: 'Trading card' }).first().click();
  const wal = await until(async () => { const i = await cardInfo(p); return i && /paper wallet/.test(i.alt) ? i : null; }, 8000);
  check('wallet card is drawn', wal && wal.w === 1200, wal?.alt);
  const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 5000 }).catch(() => null), p.locator('.sheet.share button', { hasText: 'Save image' }).click()]);
  check('Save image downloads a PNG named bagz-wallet-card.png', dl && dl.suggestedFilename() === 'bagz-wallet-card.png', dl?.suggestedFilename());
  writeFileSync(`${SHOTS}/card-wallet.png`, await p.locator('.card-img').screenshot());
  await p.locator('.sheet.share button', { hasText: 'Save to Cards' }).click();
  check('wallet card can be saved to Cards', await until(async () => /In your Cards/.test(await p.locator('.sheet.share').innerText()), 4000));
  await p.locator('.sheet.share button[aria-label=Close]').click();

  await p.locator('.tabbar button', { hasText: /^Cards$/ }).click();
  check('Cards tab now holds 2 cards; Wins/Losses filters work', await until(async () => (await p.locator('.card-thumb').count()) === 2, 5000));
  await p.locator('.seg button', { hasText: /^Wallet$/ }).click();
  check('…filter by Wallet shows the wallet card only', await until(async () => (await p.locator('.card-thumb').count()) === 1, 4000));
  await p.locator('.card-thumb').first().click();
  await p.locator('.sheet.share button', { hasText: 'Remove from Cards' }).click();
  await p.locator('.seg button', { hasText: /^All$/ }).click();
  check('a card can be removed from Cards', await until(async () => (await p.locator('.card-thumb').count()) === 1, 4000));
  await p.locator('.tabbar button', { hasText: /^Wallet$/ }).click();
  // brand marks in the UI
  check('empty states use the badge', await until(async () => { await p.locator('.seg button', { hasText: /^Positions/ }).click(); return (await p.locator('.empty .empty-badge').count()) >= 1; }, 5000));
  await ctx.close();
}

check('no runtime errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
await browser.close();
srv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
