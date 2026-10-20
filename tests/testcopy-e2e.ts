/**
 * The TEST COPY (docs/demo/index.html, built with BAGZ_DEMO=1): the real Worker code runs inside the page on SQLite
 * (WebAssembly) and saves to IndexedDB. One browser, two accounts (log out / sign in), plus a reload and Telegram.
 * Run: node --import tsx tests/testcopy-e2e.ts
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// @ts-ignore plain JS
import { makeMock } from './mock-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/demo/index.html'));
const PIC_A = resolve(root, 'tests/fixtures/pfp-ana.png'), PIC_B = resolve(root, 'tests/fixtures/pfp-ben.jpg');
const results: { name: string; ok: boolean }[] = [];
const pageErrors: string[] = [];
const check = (name: string, ok: unknown, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, ms = 15000, step = 200) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));


const mock = makeMock();
const netCalls: string[] = [];
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
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => { netCalls.push(r.request().url()); return mock.route(r); });
  p.on('pageerror', (e: Error) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m: any) => { if (m.type() === 'error' && !/net::|Failed to load resource|status of 4\d\d/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(`${APP}/${o.hash ? '#' + o.hash : ''}`);
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
const tab = (p: any, label: RegExp) => p.locator('.tabbar button:visible, .rail-nav button:visible').filter({ has: p.locator('span', { hasText: label }) }).first();
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

const appSrv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
const APP = `http://127.0.0.1:${await listen(appSrv)}`;

const { ctx, p } = await open({ phone: true });
check('test copy: sign-up screen first, with the test-copy note', await until(async () => (await p.locator('.onboard').count()) === 1, 20000) && /Test copy/.test(await text(p, '.onboard')));
await p.screenshot({ path: `${SHOTS}/testcopy-signup.png` });
check('Ana signs up (username, password, picture) and lands on home', await signUp(p, 'ana', 'ana-password-1', PIC_A));
check('picture shows (served by the in-page server)', await until(async () => p.evaluate(() => { const i = document.querySelector('.topbar-me img') as HTMLImageElement; return !!i && i.complete && i.naturalWidth === 320; }), 8000));
await paperTrade(p, 'buy');
await paperTrade(p, 'sell');
await tab(p, /^Cards$/).click();
check('Cards tab: closing the trade saved its card', await until(async () => (await p.locator('.card-thumb').count()) === 1, 8000));
check('Cards tab: the card thumbnail is drawn', await until(async () => p.evaluate(() => { const i = document.querySelector('.card-thumb img') as HTMLImageElement; return !!i && i.complete && i.naturalWidth === 600; }), 8000));
await p.locator('.card-thumb').first().click();
check('tapping a saved card opens it full size', await until(async () => p.evaluate(() => (document.querySelector('.card-img') as HTMLImageElement)?.naturalWidth === 1200), 8000));
await p.locator('.sheet.share button[aria-label=Close]').click();
await p.screenshot({ path: `${SHOTS}/testcopy-cards.png` });
// sponsored listing: order with a test payment → review → live in the Sponsored row
const PROMO = /export const JUPITER[\s\S]*?\[\s*'([1-9A-HJ-NP-Za-km-z]{32,44})',\s*'([^']+)',\s*'([^']+)'/.exec(readFileSync(resolve(root, 'src/snapshot.ts'), 'utf8'))!;
await tab(p, /^Home$/).click();
await p.locator('button', { hasText: 'Promote a token' }).click();
await p.locator('input[aria-label="Token address"]').fill(PROMO[1]);
check('Promote: token checked (on-chain mint + market data)', await until(async () => (await text(p, '.promo-token')).includes(PROMO[3]), 15000));
await p.locator('.promo-pkg', { hasText: 'Starter' }).click();
check('Promote: test copy says no wallet or money is used', /no wallet or money/.test(await text(p, 'main')));
await p.locator('button', { hasText: /Place order with a test payment/ }).click();
check('Promote: order placed and marked paid → waiting for review', await until(async () => /Paid · waiting for BAGZ review/.test(await text(p, 'main')), 10000));
await p.locator('button', { hasText: 'Open the review desk' }).click();
check('review desk opens for the signed-in account (test copy)', await until(async () => (await p.locator('.admin-row').count()) === 1, 10000));
check('review desk shows the TEST payment', /TEST-PAYMENT|TEST-PAY/.test(await text(p, '.admin-row')) || /20 USDC|10 USDC/.test(await text(p, '.admin-row')));
await p.locator('.admin-row button', { hasText: 'Approve' }).click();
await until(async () => (await p.locator('.admin-row').count()) === 0, 8000);
await tab(p, /^Home$/).click();
check('Sponsored row shows the approved listing, labelled', await until(async () => (await p.locator('.sponsored-card').count()) === 1 && /Paid placement/.test(await text(p, '.sponsored')), 15000));
await p.screenshot({ path: `${SHOTS}/testcopy-sponsored.png` });
await tab(p, /^Ranks$/).click();
check('Ana is on the leaderboard', await until(async () => /#1[\s\S]*You · @ana/.test(await text(p, 'main')), 15000));
// second account in the same browser
await p.locator('.topbar-me').click();
check('profile page shows the test-copy note', /Test copy/.test(await text(p, 'main')));
await p.locator('button', { hasText: 'Log out' }).click();
await until(async () => (await p.locator('.onboard').count()) === 1, 8000);
check('Ben signs up as a second account', await signUp(p, 'ben_trades', 'ben-password-1', PIC_B));
check('Ben starts with his own fresh $10K paper wallet (not Ana’s trades)', await until(async () => { await tab(p, /^Wallet$/).click(); return (await p.locator('.pos').count()) === 0 && /\$10,000\.00/.test(await text(p, 'main')); }, 8000));
await tab(p, /^Chats$/).click();
await p.locator('.seg button', { hasText: /^Friends/ }).click();
await p.locator('.search-input').fill('an');
await until(async () => /@ana/.test(await text(p, 'main')), 8000);
await p.locator('.pick-list li', { hasText: '@ana' }).locator('button', { hasText: 'Add' }).click();
check('Ben sends Ana a friend request', await until(async () => /Request sent to @ana/.test(await text(p, 'main')), 8000));
await p.locator('.topbar-me').click();
await p.locator('button', { hasText: 'Log out' }).click();
await until(async () => (await p.locator('.onboard').count()) === 1, 8000);
await p.locator('.onboard button', { hasText: 'I already have an account' }).click();
await p.locator('.onboard input[autocomplete=username]').fill('ana');
await p.locator('.onboard input[autocomplete=current-password]').fill('ana-password-1');
await p.locator('.onboard button', { hasText: 'Sign in' }).click();
check('Ana signs back in', await until(async () => (await p.locator('.tabbar').count()) === 1, 10000));
check('Ana gets her own paper wallet back (her 2 trades)', await until(async () => { await tab(p, /^Wallet$/).click(); await p.locator('.seg button', { hasText: /^Activity/ }).click(); return (await p.locator('.activity li').count()) === 2; }, 8000));
await tab(p, /^Chats$/).click();
await p.locator('.seg button', { hasText: /^Friends/ }).click();
await until(async () => /Friend requests · 1/.test(await text(p, 'main')), 8000);
await p.locator('.pick-list li', { hasText: '@ben_trades' }).locator('button', { hasText: 'Accept' }).click();
check('Ana accepts Ben', await until(async () => /Friends · 1/.test(await text(p, 'main')), 8000));
await p.locator('.seg button', { hasText: /^Chats/ }).click();
await p.locator('button', { hasText: 'New group' }).click();
await p.locator('.sheet input[placeholder="e.g. Gorilla Gang"]').fill('Gorilla Gang');
await p.locator('.sheet .pick-list label', { hasText: '@ben_trades' }).click();
await p.locator('.sheet button', { hasText: /Create group/ }).click();
await until(async () => /Gorilla Gang/.test(await text(p, '.chat-head')), 8000);
await p.locator('.msg-form input').fill('gm from the test copy');
await p.locator('.msg-form button').click();
check('group chat works', await until(async () => /gm from the test copy/.test(await text(p, '.msgs')), 8000));
await sleep(1500); // let it save
await p.reload();
check('after a reload: still signed in', await until(async () => (await p.locator('.tabbar').count()) === 1, 20000));
await tab(p, /^Chats$/).click();
check('after a reload: the group and message are still there (saved in the browser)', await until(async () => /Gorilla Gang[\s\S]*gm from the test copy/.test(await text(p, 'main')), 10000));
await tab(p, /^Live$/).click();
await p.locator('.seg button', { hasText: /^Friends$/ }).click();
check('Live → Friends: Ana sees no trades from Ben, because Ben has his own empty paper wallet', await until(async () => /haven’t traded yet/.test(await text(p, 'main')), 8000));
check('phone layout fits', await noHScroll(p));
await tab(p, /^Cards$/).click();
check('phone: Cards tab fits', await noHScroll(p));
check('nothing was sent to any BAGZ server (only market data requests left the page)', !netCalls.some((u) => /test-copy\.bagz|workers\.dev/.test(u)), netCalls.filter((u) => /test-copy\.bagz|workers\.dev/.test(u)).slice(0, 3).join(' '));
await ctx.close();

// Telegram
{
  const { ctx: c2, p: q } = await open({ phone: true, tg: true });
  check('Telegram: the test copy opens to the sign-up screen inside Telegram', await until(async () => (await q.locator('.onboard').count()) === 1, 20000));
  check('Telegram: sign-up works in the Mini App', await signUp(q, 'tg_tester', 'tg-password-1', PIC_A));
  check('Telegram: session saved to Telegram Cloud Storage', cloud.has('bagz.session'));
  await c2.close();
}
check('no runtime errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
await browser.close();
appSrv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
