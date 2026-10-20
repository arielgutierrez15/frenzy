// Telegram Mini App test: the built app (docs/index.html) in Chromium, opened the way Telegram opens it (launch data in
// the URL hash). telegram.org's script is replaced by a fake that records every WebApp call. Providers are mocked.
// Proves: the script loads only inside Telegram; ready/expand/colours/swipe lock; Telegram back button; start parameter
// opens a coin; outside links and wallet hand-off go through Telegram without leaking launch data; haptics; phone layout.
// Usage: node tests/telegram-e2e.mjs
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { makeMock } from './mock-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));
const src = readFileSync(resolve(root, 'src/snapshot.ts'), 'utf8');
const [, MINT, , SYM] = /export const JUPITER[\s\S]*?\[\s*'([1-9A-HJ-NP-Za-km-z]{32,44})',\s*'([^']+)',\s*'([^']+)'/.exec(src);

const results = [];
const pageErrors = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }

const srv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const APP = `http://127.0.0.1:${srv.address().port}`;

// what telegram.org/js/telegram-web-app.js provides, reduced to a recorder
const FAKE_TG = `(() => {
  const log = window.__tg = { calls: [], back: { visible: false, handlers: [] } };
  const rec = (n) => (...a) => { log.calls.push([n, ...a]); };
  const p = new URLSearchParams(location.hash.slice(1));
  const sp = new URLSearchParams(location.search).get('tgWebAppStartParam') || undefined;
  try { if (p.get('tgWebAppData')) sessionStorage.setItem('__telegram__initParams', location.hash.slice(1)); } catch (e) {}
  const stored = (() => { try { return new URLSearchParams(sessionStorage.getItem('__telegram__initParams') || ''); } catch (e) { return new URLSearchParams(); } })();
  const initData = p.get('tgWebAppData') || stored.get('tgWebAppData') || '';
  const version = p.get('tgWebAppVersion') || stored.get('tgWebAppVersion') || '6.0';
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 2; i++) { if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) - (y[i]||0); } return 0; };
  window.Telegram = { WebApp: {
    initData, initDataUnsafe: { start_param: sp }, version, platform: 'ios',
    isVersionAtLeast: (v) => cmp(version, v) >= 0,
    ready: rec('ready'), expand: rec('expand'), setHeaderColor: rec('setHeaderColor'), setBackgroundColor: rec('setBackgroundColor'),
    setBottomBarColor: rec('setBottomBarColor'), disableVerticalSwipes: rec('disableVerticalSwipes'),
    openLink: rec('openLink'), openTelegramLink: rec('openTelegramLink'),
    BackButton: { show() { log.back.visible = true; log.calls.push(['BackButton.show']); }, hide() { log.back.visible = false; log.calls.push(['BackButton.hide']); },
      onClick(f) { log.back.handlers.push(f); }, offClick(f) { log.back.handlers = log.back.handlers.filter((x) => x !== f); } },
    HapticFeedback: { selectionChanged: rec('haptic.selection'), impactOccurred: rec('haptic.impact'), notificationOccurred: rec('haptic.notify') },
  } };
})();`;

const browser = await chromium.launch();
async function open(url, { phone = true } = {}) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram-iOS' } : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => { window.LightweightCharts = { createChart() { const s = () => ({ setData() {}, update() {}, setMarkers() {}, createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } }); return { addCandlestickSeries: s, addLineSeries: s, addAreaSeries: s, addHistogramSeries: s, removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; }, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() {} }; } }; });
  const mock = makeMock();
  const tgRequests = [];
  const popups = [];
  ctx.on('page', (np) => popups.push(np.url()));
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
    const u = new URL(r.request().url());
    if (u.hostname === 'telegram.org') { tgRequests.push(u.pathname); return r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TG }); }
    return mock.route(r);
  });
  p.on('pageerror', (e) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(url);
  return { ctx, p, tgRequests, popups };
}
const calls = (p) => p.evaluate(() => window.__tg?.calls || []);
const has = async (p, name) => (await calls(p)).some((c) => c[0] === name);
const INIT = 'query_id%3DAAH%26user%3D%257B%2522id%2522%253A42%257D%26auth_date%3D1792400000%26hash%3Ddeadbeef';
const LAUNCH = `#tgWebAppData=${INIT}&tgWebAppVersion=8.0&tgWebAppPlatform=ios`;

// ---------------------------------------------------------------- 1. normal browser visit
{
  const { ctx, p, tgRequests } = await open(APP + '/', { phone: false });
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('normal visit: Telegram script is not loaded', tgRequests.length === 0);
  check('normal visit: not in Telegram mode', !(await p.evaluate(() => document.documentElement.classList.contains('tg'))));
  await ctx.close();
}

// ---------------------------------------------------------------- 2. opened from Telegram with a start parameter
{
  const { ctx, p, tgRequests, popups } = await open(`${APP}/?tgWebAppStartParam=${MINT}${LAUNCH}`);
  check('Telegram launch: telegram-web-app.js is loaded from telegram.org', tgRequests.includes('/js/telegram-web-app.js'), tgRequests.join(','));
  check('ready() and expand() are called', await until(async () => (await has(p, 'ready')) && (await has(p, 'expand')), 5000));
  const c = await calls(p);
  check('header, background and bottom bar use BAGZ black #090909', ['setHeaderColor', 'setBackgroundColor', 'setBottomBarColor'].every((n) => c.some((x) => x[0] === n && x[1] === '#090909')));
  check('swipe-down-to-close is turned off (charts and lists scroll safely)', c.some((x) => x[0] === 'disableVerticalSwipes'));
  check('Telegram mode is on', await p.evaluate(() => document.documentElement.classList.contains('tg')));
  const opened = await until(async () => new RegExp('\\$' + SYM.replace(/[$^]/g, '')).test(await p.locator('.coin-head').innerText()), 40000);
  check(`start parameter opens the shared coin ($${SYM})`, opened);
  check('in-page Back is hidden (Telegram’s header button replaces it)', !(await p.locator('.view > .back').isVisible()));
  check('Telegram back button is shown on the coin page', await until(async () => p.evaluate(() => window.__tg.back.visible && window.__tg.back.handlers.length > 0), 5000));
  await p.screenshot({ path: `${SHOTS}/tg-coin.png` });

  // outside link goes through Telegram, no new tab
  const ext = p.locator('a.ext').first();
  const href = await ext.getAttribute('href');
  await ext.click();
  check('outside links open through Telegram (openLink), not inside the Mini App', await until(async () => (await calls(p)).some((x) => x[0] === 'openLink' && x[1] === href), 3000) && popups.length === 0, href);

  // wallet hand-off
  const ws = p.locator('.live-swap');
  check('wallet panel explains wallets can’t connect inside Telegram', /can’t connect inside Telegram/.test(await ws.innerText()));
  await ws.locator('button', { hasText: 'Open in Phantom' }).click();
  const ph = (await calls(p)).filter((x) => x[0] === 'openLink').pop()?.[1] || '';
  check('“Open in Phantom” goes through Telegram to Phantom’s browse link', ph.startsWith('https://phantom.com/ul/browse/' + encodeURIComponent(APP)), ph.slice(0, 90));
  check('…and never includes Telegram’s launch data (signed session)', !/tgWebApp|query_id|deadbeef/.test(decodeURIComponent(decodeURIComponent(ph))));
  await ws.locator('button', { hasText: 'Open in browser' }).click();
  const br = (await calls(p)).filter((x) => x[0] === 'openLink').pop()?.[1] || '';
  check('“Open in browser” opens the clean page address', br.startsWith(APP) && !/tgWebApp|query_id/.test(br), br);

  // Telegram's back button goes back
  await p.evaluate(() => window.__tg.back.handlers.slice(-1)[0]());
  check('pressing Telegram’s back button returns to the list and hides it', await until(async () => (await p.locator('.coin-head').count()) === 0 && !(await p.evaluate(() => window.__tg.back.visible)), 5000));

  // haptic tap on tab change
  await p.locator('.tabbar button', { hasText: 'Radar' }).click();
  check('tab taps give haptic feedback', await until(async () => has(p, 'haptic.selection'), 3000));
  check('phone layout: no horizontal scroll inside Telegram', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await p.screenshot({ path: `${SHOTS}/tg-radar.png` });

  // reload: Telegram keeps launch data in sessionStorage (hash is gone after BAGZ navigates)
  await p.reload();
  check('after a reload inside Telegram the script still loads and ready() is called', await until(async () => has(p, 'ready'), 8000));
  await ctx.close();
}

// ---------------------------------------------------------------- 3. old Telegram app (6.0): no newer calls
{
  const { ctx, p } = await open(`${APP}/#tgWebAppData=${INIT}&tgWebAppVersion=6.0&tgWebAppPlatform=android`);
  await until(async () => has(p, 'ready'), 8000);
  const c = await calls(p);
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  await p.locator('.coin-row').first().click();
  check('older Telegram versions keep the in-page Back button', await until(async () => p.locator('.view > .back').isVisible(), 5000));
  check('older Telegram versions: version-gated calls are skipped, nothing breaks', !c.some((x) => ['setHeaderColor', 'disableVerticalSwipes', 'setBottomBarColor'].includes(x[0])) && c.some((x) => x[0] === 'expand'));
  await ctx.close();
}

check('no runtime errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
await browser.close();
srv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
