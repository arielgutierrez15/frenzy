/**
 * Global search bar in Chromium against the REAL Worker code and a SQLite-backed D1: coins by symbol and contract
 * address, BAGZ users by @username (with pictures), and on-chain wallets, on a phone and on desktop.
 * Market data is mocked (tests/mock-api.mjs).
 * Run: npm run test:search
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// @ts-ignore plain JS
import { makeMock } from './mock-api.mjs';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
import { D1 } from './fakechain';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));
const PIC_A = resolve(root, 'tests/fixtures/pfp-ana.png'), PIC_B = resolve(root, 'tests/fixtures/pfp-ben.jpg');

const results: { name: string; ok: boolean }[] = [];
const pageErrors: string[] = [];
const check = (name: string, ok: unknown, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, ms = 15000, step = 200) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const appSrv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
const APP = `http://127.0.0.1:${await listen(appSrv)}`;

// ---- the Worker with D1
const db = new D1();
const mock = makeMock();
const log: { method: string; path: string; status: number }[] = [];
const env: any = { ALLOWED_ORIGINS: APP, Db: db, PASSWORD_ITERATIONS: '10000', RATE_PER_MIN: '20000', RATE_POST_PER_MIN: '20000', ...['JUP', 'GT', 'DS', 'PUMP', 'RUG', 'RPC'].reduce((o, k) => ({ ...o, ['UPSTREAM_PER_MIN_' + k]: '5000' }), {}) };
const viaMock = (url: string, init: any = {}) => new Promise<Response>((res, rej) => {
  const r = { request: () => ({ url: () => url, method: () => init.method || 'GET', postData: () => init.body }), fulfill: ({ status = 200, headers = {}, body = '', contentType }: any) => res(new Response(body, { status, headers: { ...headers, 'content-type': contentType || 'application/json' } })), abort: () => rej(new TypeError('aborted')) };
  mock.route(r).catch(rej);
});
const wsrv = createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) });
  const out = await handle(request, env, undefined, { fetch: viaMock, cache: null });
  log.push({ method: req.method!, path: req.url!, status: out.status });
  const h: Record<string, string> = {}; out.headers.forEach((v: string, k: string) => { h[k] = v; });
  res.writeHead(out.status, h); res.end(Buffer.from(await out.arrayBuffer()));
});
const W = `http://127.0.0.1:${await listen(wsrv)}`;

// ---- browser helpers
const FAKE_LWC = `window.LightweightCharts = { createChart() { const s = () => ({ setData() {}, update() {}, setMarkers() {}, createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } }); return { addCandlestickSeries: s, addLineSeries: s, addAreaSeries: s, addHistogramSeries: s, removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; }, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() {} }; } };`;
// Telegram client with Cloud Storage kept outside the page (survives localStorage being wiped)
const cloud = new Map<string, string>();
const FAKE_TG = `(() => {
  const log = window.__tg = { calls: [] };
  const rec = (n) => (...a) => log.calls.push([n, ...a]);
  window.Telegram = { WebApp: {
    initData: 'query_id=AAH&user=%7B%22id%22%3A7%7D&auth_date=1792400000&hash=abc', initDataUnsafe: {}, version: '8.0', platform: 'ios',
    isVersionAtLeast: (v) => parseFloat(v) <= 8.0, ready: rec('ready'), expand: rec('expand'), setHeaderColor: rec('h'), setBackgroundColor: rec('b'), setBottomBarColor: rec('bb'), disableVerticalSwipes: rec('dvs'),
    openLink: rec('openLink'), openTelegramLink: rec('openTelegramLink'),
    BackButton: { show: rec('back.show'), hide: rec('back.hide'), onClick: (f) => { window.__tgBack = f; }, offClick: () => {} },
    HapticFeedback: { selectionChanged: rec('hap'), impactOccurred: rec('hap'), notificationOccurred: rec('hap') },
    CloudStorage: {
      getItem: (k, cb) => window.__cloudGet(k).then((v) => cb(null, v || '')),
      setItem: (k, v, cb) => window.__cloudSet(k, v).then(() => cb && cb(null, true)),
      removeItem: (k, cb) => window.__cloudSet(k, '').then(() => cb && cb(null, true)),
    },
  } };
})();`;
const browser = await chromium.launch();
async function open(o: { phone?: boolean; tg?: boolean; hash?: string } = {}) {
  const ctx = await browser.newContext(o.phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript({ content: FAKE_LWC });
  if (o.tg) {
    await p.exposeFunction('__cloudGet', async (k: string) => cloud.get(k) || '');
    await p.exposeFunction('__cloudSet', async (k: string, v: string) => { if (v) cloud.set(k, v); else cloud.delete(k); });
    await p.addInitScript({ content: FAKE_TG });
  }
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => mock.route(r));
  p.on('pageerror', (e: Error) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m: any) => { if (m.type() === 'error' && !/net::|Failed to load resource|status of 4\d\d/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(`${APP}/?proxy=${encodeURIComponent(W)}${o.hash ? '#' + o.hash : ''}`);
  return { ctx, p };
}
const text = (p: any, sel = 'body') => p.locator(sel).first().innerText();
const noHScroll = (p: any) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function signUp(p: any, name: string, pw: string, pic: string) {
  await p.locator('.onboard input[autocomplete=username]').fill(name);
  await p.locator('.onboard input[autocomplete=new-password]').nth(0).fill(pw);
  await p.locator('.onboard input[autocomplete=new-password]').nth(1).fill(pw);
  await p.locator('.onboard button', { hasText: 'Continue' }).click();
  await until(async () => /Add a profile picture/.test(await text(p, '.onboard')), 15000);
  await p.locator('.onboard input[type=file]').setInputFiles(pic);
  await until(async () => (await p.locator('.pfp-preview').count()) === 1, 8000);
  await p.locator('.onboard button', { hasText: 'Save and start trading' }).click();
  return until(async () => (await p.locator('.onboard').count()) === 0 && (await p.locator('.tabbar, .rail').count()) > 0, 15000);
}
// phone: Cards, Chats, Ranks and Profile live in the More sheet, so open it when the tab isn't on the bar
const tab = (p: any, label: RegExp) => ({
  click: async () => {
    // Live is a tab inside Radar now
    if (label.test('Live')) { await tab(p, /^Radar$/).click(); return p.locator('.seg button', { hasText: /^Live$/ }).first().click(); }
    const direct = p.locator('.tabbar button:visible, .rail-nav button:visible, .more-sheet .more-item:visible').filter({ has: p.locator('span, b', { hasText: label }) }).first();
    if (await direct.count()) return direct.click();
    await p.locator('.tabbar .tab-more').click();
    return p.locator('.more-sheet .more-item').filter({ has: p.locator('b', { hasText: label }) }).first().click();
  },
});
async function paperTrade(p: any, side: 'buy' | 'sell') {
  if (side === 'buy') {
    await tab(p, /^Home$/).click();
    await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
    await p.locator('.coin-row').first().click();
    await p.locator('.trade-bar .btn-accent').click();
  } else {
    await tab(p, /^Wallet$/).click();
    await p.locator('.pos .btn', { hasText: 'Sell' }).first().click();
  }
  await until(async () => p.locator('.sheet button[type=submit]').isEnabled(), 15000);
  await p.locator('.sheet button[type=submit]').click();
  await sleep(500);
  if (await p.locator('.sheet.share').count()) await p.locator('.sheet.share button[aria-label=Close]').click();
}

// ================================================================ search bar
const S = SHOTS;
const A = await open({ phone: true });
check('ana signs up', await signUp(A.p, 'ana_trades', 'ana-password-1', PIC_A));
const B = await open({ phone: false });
check('ben signs up', await signUp(B.p, 'benny', 'ben-password-1', PIC_B));
{
  const p = A.p;
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('phone: search bar is in the top bar', await p.locator('.topbar .srch input').isVisible());
  check('phone: no horizontal scroll', await noHScroll(p));
  await p.screenshot({ path: `${S}/phone-home.png` });
  const firstSym = (await p.locator('.coin-row b').first().innerText()).replace('$', '').trim();
  const inp = p.locator('.topbar .srch input');
  await inp.fill(firstSym.slice(0, 3));
  check('coin search by symbol shows coins', await until(async () => (await p.locator('.srch-panel .srch-row').count()) > 0, 8000), firstSym);
  await p.screenshot({ path: `${S}/phone-coin-search.png` });
  await p.locator('.srch-panel .srch-row').first().click();
  check('picking a coin opens its page', await until(async () => (await p.locator('.coin-view').count()) === 1, 8000));
  await p.locator('.back').first().click();
  await inp.fill('@ben');
  check('user search finds @benny with picture', await until(async () => /@benny/.test(await text(p, '.srch-panel')), 8000) && (await p.locator('.srch-panel img.uavatar').count()) > 0);
  await p.screenshot({ path: `${S}/phone-user-search.png` });
  await p.locator('.srch-panel .srch-row', { hasText: '@benny' }).click();
  check('picking a user opens their profile', await until(async () => /@benny/.test(await text(p, '.profile-head')), 8000));
  const wallet = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
  await inp.fill(wallet);
  check('wallet address shows a wallet row', await until(async () => /wallets/i.test(await text(p, '.srch-panel')), 8000));
  await p.screenshot({ path: `${S}/phone-wallet-search.png` });
  await p.locator('.srch-panel .srch-row').last().click();
  check('picking a wallet opens the trader page', await until(async () => (await p.locator('.trader-head').count()) === 1, 8000));
  await inp.fill('6AJcP7wuLwmRYLBNbi825wgguaPsWzPBEHcHndpRpump');
  check('contract address finds the coin', await until(async () => /\$VINE/.test(await text(p, '.srch-panel')), 8000));
  await p.locator('.srch-panel .srch-row').first().click();
  check('contract address opens coin', await until(async () => (await p.locator('.coin-view').count()) === 1, 8000));
  await p.screenshot({ path: `${S}/phone-coin-page.png` });
  await inp.fill('zzqqxx');
  check('no match message', await until(async () => /Nothing matches/.test(await text(p, '.srch-panel')), 8000));
}
{
  const p = B.p;
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('desktop: search bar visible at top', await p.locator('.desk-search .srch input').isVisible());
  await p.keyboard.press('/');
  check('"/" focuses search', await p.evaluate(() => document.activeElement?.closest('.srch') !== null));
  await p.keyboard.type('@ana');
  check('desktop user search', await until(async () => /@ana_trades/.test(await text(p, '.srch-panel')), 8000));
  await p.screenshot({ path: `${S}/desk-user-search.png` });
  await p.keyboard.press('Enter');
  check('enter opens highlighted result', await until(async () => /@ana_trades/.test(await text(p, '.profile-head')), 8000));
}
check('no page errors', !pageErrors.length, pageErrors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
await browser.close(); appSrv.close(); wsrv.close();
process.exit(failed ? 1 : 0);
