/**
 * Accounts + social features in Chromium against the REAL Worker code and a SQLite-backed D1 (real migrations).
 * Two people (Ana, Ben) in separate browsers, plus Ben again inside a simulated Telegram client.
 * Market data is mocked (tests/mock-api.mjs).
 * Run: node --import tsx tests/social-e2e.ts
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

// ================================================================ 1. Ana: first visit on a phone → profile required
const A = await open({ phone: true });
{
  const p = A.p;
  check('first visit: the sign-up screen comes before the app (no tabs)', await until(async () => (await p.locator('.onboard').count()) === 1, 15000) && (await p.locator('.tabbar').count()) === 0);
  check('phone: sign-up screen fits (no horizontal scroll)', await noHScroll(p));
  await p.screenshot({ path: `${SHOTS}/social-signup-phone.png` });
  // validation
  await p.locator('.onboard input[autocomplete=username]').fill('ana');
  await p.locator('.onboard input[autocomplete=new-password]').nth(0).fill('ana-password-1');
  await p.locator('.onboard input[autocomplete=new-password]').nth(1).fill('different-pw');
  await p.locator('.onboard button', { hasText: 'Continue' }).click();
  check('mismatched passwords are caught', /don’t match/.test(await text(p, '.onboard')));
  await p.locator('.onboard input[autocomplete=username]').fill('admin');
  await p.locator('.onboard input[autocomplete=new-password]').nth(1).fill('ana-password-1');
  await p.locator('.onboard button', { hasText: 'Continue' }).click();
  check('reserved usernames are refused by the server', await until(async () => /reserved/.test(await text(p, '.onboard')), 8000));
  await p.locator('.onboard input[autocomplete=username]').fill('');
  const ok = await signUp(p, 'ana', 'ana-password-1', PIC_A);
  check('username + password → picture → lands on the home screen', ok);
  check('home screen is showing', /What’s moving right now/.test(await text(p, 'main')));
  const av = await until(async () => p.evaluate(() => { const i = document.querySelector('.topbar-me img') as HTMLImageElement; return i && i.complete && i.naturalWidth > 0 ? i.naturalWidth : 0; }), 8000);
  check('the uploaded picture is served by the Worker and shown in the top bar', av === 320, String(av));
  check('picture was resized in the browser before upload (320×320 JPEG)', log.some((l) => l.path === '/v1/me/avatar' && l.status === 200));
  await p.reload();
  check('signed in after a reload (no sign-up screen)', await until(async () => (await p.locator('.tabbar').count()) === 1 && (await p.locator('.onboard').count()) === 0, 15000));
  // paper trades show up publicly
  await paperTrade(p, 'buy');
  await paperTrade(p, 'sell');
  await tab(p, /^Ranks$/).click();
  const ranked = await until(async () => /#1[\s\S]*You · @ana/.test(await text(p, 'main')), 15000);
  check('Ranks: Ana appears on the public leaderboard after trading (stats synced)', ranked, (await text(p, 'main')).slice(0, 200).replace(/\s+/g, ' '));
  check('phone: leaderboard fits', await noHScroll(p));
  await p.screenshot({ path: `${SHOTS}/social-ranks-phone.png` });
  await p.locator('.seg button', { hasText: 'On-chain wallets' }).click();
  check('Ranks → On-chain wallets still lists real wallets', await until(async () => (await p.locator('.leaders li').count()) > 0, 20000));
}

// ================================================================ 2. Ben on desktop: sign up, find Ana, friend request
const B = await open();
{
  const p = B.p;
  check('Ben: sign-up gate on desktop too', await until(async () => (await p.locator('.onboard').count()) === 1));
  check('Ben: signs up with a JPEG picture', await signUp(p, 'ben_trades', 'ben-password-1', PIC_B));
  await tab(p, /^Chats$/).click();
  await p.locator('.seg button', { hasText: /^Friends/ }).click();
  await p.locator('.search-input').fill('an');
  check('search finds @ana', await until(async () => /@ana/.test(await text(p, 'main')), 8000));
  await p.locator('.pick-list li', { hasText: '@ana' }).locator('button', { hasText: 'Add' }).click();
  check('friend request sent', await until(async () => /Request sent to @ana/.test(await text(p, 'main')), 8000));
}

// ================================================================ 3. Ana accepts; makes a group; chat
{
  const p = A.p;
  const badge = await until(async () => (await p.locator('.tabbar .tab-dot').count()) === 1, 30000);
  check('Ana sees a badge on Chats for the new request', badge);
  await tab(p, /^Chats$/).click();
  await p.locator('.seg button', { hasText: /^Friends/ }).click();
  await until(async () => /Friend requests · 1/.test(await text(p, 'main')), 8000);
  await p.locator('.pick-list li', { hasText: '@ben_trades' }).locator('button', { hasText: 'Accept' }).click();
  check('Ana accepts → Ben is in her friends list', await until(async () => /Friends · 1[\s\S]*@ben_trades/.test(await text(p, 'main')), 8000));
  await p.locator('.seg button', { hasText: /^Chats/ }).click();
  await p.locator('button', { hasText: 'New group' }).click();
  await p.locator('.sheet input[placeholder="e.g. Gorilla Gang"]').fill('Gorilla Gang');
  await p.locator('.sheet .pick-list label', { hasText: '@ben_trades' }).click();
  await p.locator('.sheet button', { hasText: /Create group/ }).click();
  check('group created and opened', await until(async () => /Gorilla Gang/.test(await text(p, '.chat-head')), 8000));
  await p.locator('.msg-form input').fill('gm gorillas 🦍');
  await p.locator('.msg-form button').click();
  check('Ana’s message shows in the chat', await until(async () => /gm gorillas 🦍/.test(await text(p, '.msgs')), 8000));
  check('phone: chat room fits', await noHScroll(p));
  await p.screenshot({ path: `${SHOTS}/social-chat-phone.png` });
}
{
  const p = B.p;
  await p.locator('.seg button', { hasText: /^Chats/ }).click();
  check('Ben sees the group with an unread count', await until(async () => /Gorilla Gang[\s\S]*gm gorillas/.test(await text(p, 'main')) && (await p.locator('.chat-unread').count()) === 1, 20000));
  await p.locator('.chat-list button', { hasText: 'Gorilla Gang' }).click();
  check('Ben reads Ana’s message', await until(async () => /gm gorillas 🦍/.test(await text(p, '.msgs')), 8000));
  await p.locator('.msg-form input').fill('wagmi');
  await p.locator('.msg-form input').press('Enter');
  await until(async () => /wagmi/.test(await text(p, '.msgs')), 8000);
}
check('Ana receives Ben’s reply within a few seconds (polling)', await until(async () => /wagmi/.test(await text(A.p, '.msgs')), 10000));

// ================================================================ 4. Ben: Live → Friends filter, Ana’s profile
{
  const p = B.p;
  await tab(p, /^Live$/).click();
  await p.locator('.seg button', { hasText: /^Friends$/ }).click();
  check('Live → Friends shows Ana’s paper trades', await until(async () => /@ana[\s\S]*(Bought|Sold)/i.test(await text(p, 'main')), 15000));
  await p.locator('.friends-feed button.handle', { hasText: '@ana' }).first().click();
  const prof = await until(async () => /@ana[\s\S]*Paper trading[\s\S]*All-time PnL/i.test(await text(p, 'main')), 10000);
  check('tapping a friend opens their public profile with stats and activity', prof);
  check('profile shows "Friends" (they’re connected)', /Friends/.test(await text(p, '.profile-head')));
  await p.screenshot({ path: `${SHOTS}/social-profile-desktop.png` });
}

// ================================================================ 5. log out / log in
{
  const p = A.p;
  await p.locator('.topbar-me').click();
  await p.locator('button', { hasText: 'Log out' }).click();
  check('log out returns to the sign-up screen', await until(async () => (await p.locator('.onboard').count()) === 1, 8000));
  await p.locator('.onboard button', { hasText: 'I already have an account' }).click();
  await p.locator('.onboard input[autocomplete=username]').fill('ana');
  await p.locator('.onboard input[autocomplete=current-password]').fill('wrong-password');
  await p.locator('.onboard button', { hasText: 'Sign in' }).click();
  check('wrong password is refused', await until(async () => /Wrong username or password/.test(await text(p, '.onboard')), 8000));
  await p.locator('.onboard input[autocomplete=current-password]').fill('ana-password-1');
  await p.locator('.onboard button', { hasText: 'Sign in' }).click();
  check('sign in with the right password goes straight to the app', await until(async () => (await p.locator('.onboard').count()) === 0 && (await p.locator('.tabbar').count()) === 1, 10000));
}

// ================================================================ 6. Telegram: Ben inside the Mini App
{
  const { ctx, p } = await open({ phone: true, tg: true });
  check('Telegram: first open shows the sign-up screen', await until(async () => (await p.locator('.onboard').count()) === 1, 15000));
  await p.locator('.onboard button', { hasText: 'I already have an account' }).click();
  await p.locator('.onboard input[autocomplete=username]').fill('ben_trades');
  await p.locator('.onboard input[autocomplete=current-password]').fill('ben-password-1');
  await p.locator('.onboard button', { hasText: 'Sign in' }).click();
  check('Telegram: sign in works inside the Mini App', await until(async () => (await p.locator('.tabbar').count()) === 1, 10000));
  check('Telegram: the session is saved to Telegram Cloud Storage', cloud.has('bagz.session'));
  // Telegram wipes the webview's storage
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload();
  check('Telegram: still signed in after Telegram clears local storage (restored from Cloud Storage)', await until(async () => (await p.locator('.tabbar').count()) === 1 && (await p.locator('.onboard').count()) === 0, 15000));
  await tab(p, /^Chats$/).click();
  await p.locator('.chat-list button', { hasText: 'Gorilla Gang' }).click();
  check('Telegram: open the group chat', await until(async () => /wagmi/.test(await text(p, '.msgs')), 10000));
  check('Telegram: its back button is shown in a chat', (await p.evaluate(() => (window as any).__tg.calls.filter((c: any) => /^back\./.test(c[0])).pop()?.[0])) === 'back.show');
  await p.evaluate(() => (window as any).__tgBack());
  check('Telegram: back button returns to the chat list', await until(async () => (await p.locator('.chat-list').count()) === 1, 5000));
  check('Telegram: phone layout fits', await noHScroll(p));
  await p.screenshot({ path: `${SHOTS}/social-telegram-chats.png` });
  // log out inside Telegram also clears Cloud Storage
  await p.locator('.topbar-me').click();
  await p.locator('button', { hasText: 'Log out' }).click();
  await until(async () => (await p.locator('.onboard').count()) === 1, 8000);
  check('Telegram: logging out removes the session from Cloud Storage', !cloud.has('bagz.session'));
  await ctx.close();
}

// ================================================================ 7. without a server the app still works (no gate)
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript({ content: FAKE_LWC });
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => mock.route(r));
  await p.goto(APP + '/');
  check('no BAGZ server on the page: no sign-up wall, app opens normally', await until(async () => (await p.locator('.coin-row').count()) > 3, 40000) && (await p.locator('.onboard').count()) === 0);
  await p.locator('.rail-nav button', { hasText: 'Ranks' }).click();
  check('…and the leaderboard explains it’s offline', /leaderboard is offline/.test(await text(p, 'main')));
  await ctx.close();
}

check('no runtime errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
check('no server errors (5xx) during the whole run', !log.some((l) => l.status >= 500), log.filter((l) => l.status >= 500).map((l) => l.status + ' ' + l.path).join(', '));
await browser.close();
appSrv.close(); wsrv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
