/**
 * Paper wallet sync across devices, tabs and Telegram, in Chromium against the REAL Worker code and a SQLite-backed D1.
 *  - two devices on one account: a trade on one shows up on the other; trades made on both at the same time are all kept
 *  - two tabs of one browser: neither tab overwrites the other's trades
 *  - Telegram (its storage wiped): the wallet comes back from the server
 *  - sign out / sign in on a new device; reset on one device reaches the other
 * Market data is mocked (tests/mock-api.mjs).
 * Run: node --import tsx tests/wallet-sync-e2e.ts
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

// ---- helpers for this test
const SYNC_WAIT = 25_000; // poll is 15 s; a focus/visibility change syncs sooner
async function buyCoin(p: any, nth: number, usd = 100) {
  await tab(p, /^Home$/).click();
  await until(async () => (await p.locator('.coin-row').count()) > nth + 1, 40000);
  await p.locator('.coin-row').nth(nth).click();
  await p.locator('.trade-bar .btn-accent').click();
  await until(async () => p.locator('.sheet button[type=submit]').isEnabled(), 15000);
  const amt = p.locator('#trade-usd');
  if (await amt.count()) await amt.fill(String(usd));
  await p.locator('.sheet button[type=submit]').click();
  await sleep(500);
  if (await p.locator('.sheet.share').count()) await p.locator('.sheet.share button[aria-label=Close]').click();
  for (let k = 0; k < 3 && (await p.locator('.sheet').count()); k++) { await p.keyboard.press('Escape'); await sleep(150); }
}
/** the paper wallet this page has, read from its storage */
const wallet = (p: any) => p.evaluate(() => {
  const k = Object.keys(localStorage).find((x) => x.startsWith('frenzy.live.v1:'));
  const w = k ? JSON.parse(localStorage.getItem(k)!) : null;
  return w ? { trades: w.user.trades.map((t: any) => t.id) as string[], cash: w.user.cash as number, positions: Object.keys(w.user.positions).length, deposits: w.user.deposits as number } : null;
});
const server = () => { const r = db.db.prepare('SELECT rev, data FROM wallets').all() as any[]; return r.map((x) => ({ rev: x.rev, trades: JSON.parse(x.data).user.trades.map((t: any) => t.id) as string[], cash: JSON.parse(x.data).user.cash })); };
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const nudge = (p: any) => p.evaluate(() => window.dispatchEvent(new Event('focus')));
async function signIn(p: any, name: string, pw: string) {
  await until(async () => (await p.locator('.onboard').count()) === 1, 15000);
  await p.locator('.onboard button', { hasText: 'I already have an account' }).click();
  await p.locator('.onboard input[autocomplete=username]').fill(name);
  await p.locator('.onboard input[autocomplete=current-password]').fill(pw);
  await p.locator('.onboard button', { hasText: 'Sign in' }).click();
  return until(async () => (await p.locator('.tabbar, .rail').count()) > 0 && (await p.locator('.onboard').count()) === 0, 15000);
}

// ================================================================ 1. device A signs up and trades
const A = await open({ phone: true });
check('device A: sign up', await until(async () => (await A.p.locator('.onboard').count()) === 1, 15000) && await signUp(A.p, 'sam', 'sam-password-1', PIC_A));
await buyCoin(A.p, 0);
await buyCoin(A.p, 1);
const a1 = await wallet(A.p);
check('device A: two paper trades', a1?.trades.length === 2, JSON.stringify(a1));
check('the server gets the wallet within seconds of the trades', await until(async () => sameSet(server()[0]?.trades || [], a1!.trades), 10000), JSON.stringify(server()));

// ================================================================ 2. device B (another phone/browser) signs in: same wallet
const B = await open({ phone: false });
check('device B: sign in', await signIn(B.p, 'sam', 'sam-password-1'));
check('device B: shows the trades made on device A', await until(async () => sameSet((await wallet(B.p))?.trades || [], a1!.trades), SYNC_WAIT), JSON.stringify(await wallet(B.p)));
check('device B: same cash as device A', Math.abs(((await wallet(B.p))?.cash ?? 0) - a1!.cash) < 1e-6);
await tab(B.p, /^Wallet$/).click();
await sleep(500);
check('device B: Wallet screen lists the positions', (await B.p.locator('.pos').count()) >= 2, String(await B.p.locator('.pos').count()));
await B.p.screenshot({ path: `${SHOTS}/wsync-device-b-wallet.png` });

// ================================================================ 3. both devices trade at the same time
await Promise.all([buyCoin(A.p, 2), buyCoin(B.p, 3)]);
await Promise.all([nudge(A.p), nudge(B.p)]);
const want = async () => [...new Set([...(await wallet(A.p))!.trades, ...(await wallet(B.p))!.trades])];
const all4 = await want();
check('simultaneous trades: 4 trades made in total', all4.length === 4, JSON.stringify(all4));
const converged = await until(async () => { await nudge(A.p); await nudge(B.p); const a = await wallet(A.p), b = await wallet(B.p); return a && b && sameSet(a.trades, all4) && sameSet(b.trades, all4) && Math.abs(a.cash - b.cash) < 1e-6; }, SYNC_WAIT, 1000);
check('simultaneous trades: both devices end with all 4 trades and the same cash', converged, JSON.stringify([await wallet(A.p), await wallet(B.p)]));
check('simultaneous trades: the server has all 4', sameSet(server()[0].trades, all4), JSON.stringify(server()));
const cashNow = (await wallet(A.p))!.cash;
check('cash is right after the merge ($10,000 − 4 × $100)', Math.abs(cashNow - 9600) < 0.01, String(cashNow));

// ================================================================ 4. two tabs of one browser (Safari tabs)
const T2 = await B.ctx.newPage();
await T2.addInitScript({ content: FAKE_LWC });
await T2.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => mock.route(r));
T2.on('pageerror', (e: Error) => pageErrors.push('PAGEERROR ' + e.message));
await T2.goto(`${APP}/?proxy=${encodeURIComponent(W)}`);
check('second tab: opens signed in with the same wallet', await until(async () => sameSet((await wallet(T2))?.trades || [], all4), 20000));
await buyCoin(B.p, 4);
await buyCoin(T2, 5);
// wait past a price refresh, when each tab saves its copy again
await sleep(23_000);
const t1w = await wallet(B.p), t2w = await wallet(T2);
check('two tabs: a trade in each tab, neither tab wipes the other\'s (6 trades in both)', t1w?.trades.length === 6 && t2w?.trades.length === 6 && sameSet(t1w.trades, t2w.trades), JSON.stringify([t1w?.trades.length, t2w?.trades.length]));
check('two tabs: cash agrees in both tabs', Math.abs(t1w!.cash - t2w!.cash) < 1e-6 && Math.abs(t1w!.cash - 9400) < 0.01, JSON.stringify([t1w?.cash, t2w?.cash]));
check('two tabs: device A gets both tab trades too', await until(async () => { await nudge(A.p); return (await wallet(A.p))?.trades.length === 6; }, SYNC_WAIT, 1000));
check('two tabs: the server has 6 trades', server()[0].trades.length === 6, JSON.stringify(server()[0]));
await T2.close();

// ================================================================ 5. Telegram: storage wiped, wallet comes back from the server
{
  const { ctx, p } = await open({ phone: true, tg: true });
  check('Telegram: sign in', await signIn(p, 'sam', 'sam-password-1'));
  check('Telegram: all 6 trades are there', await until(async () => (await wallet(p))?.trades.length === 6, SYNC_WAIT));
  await p.evaluate(() => { localStorage.clear(); });
  await p.reload();
  check('Telegram: after Telegram wipes storage, the session and all 6 trades come back', await until(async () => (await p.locator('.tabbar').count()) === 1 && (await wallet(p))?.trades.length === 6, SYNC_WAIT));
  await buyCoin(p, 6);
  check('Telegram: a trade made in Telegram reaches device A', await until(async () => { await nudge(A.p); return (await wallet(A.p))?.trades.length === 7; }, SYNC_WAIT, 1000));
  await ctx.close();
}

// ================================================================ 6. sign out on A, sign in on a brand-new device
{
  await A.p.locator('.topbar-me').click();
  await A.p.locator('button', { hasText: 'Log out' }).click();
  check('device A: log out', await until(async () => (await A.p.locator('.onboard').count()) === 1, 8000));
  const { ctx, p } = await open({ phone: true });
  check('new device: sign in', await signIn(p, 'sam', 'sam-password-1'));
  check('new device: all 7 trades and the same cash', await until(async () => { const w = await wallet(p); return w?.trades.length === 7 && Math.abs(w.cash - 9300) < 0.01; }, SYNC_WAIT), JSON.stringify(await wallet(p)));
  // reset here reaches device B instead of being merged away
  await tab(p, /^Wallet$/).click();
  await p.locator('button', { hasText: 'Reset wallet' }).click();
  await p.locator('.confirm button', { hasText: /Reset|Yes/ }).first().click();
  check('reset on one device reaches the other (0 trades, $10,000)', await until(async () => { await nudge(B.p); const w = await wallet(B.p); return w?.trades.length === 0 && Math.abs(w.cash - 10_000) < 0.01; }, SYNC_WAIT, 1000), JSON.stringify(await wallet(B.p)));
  await ctx.close();
}

// ================================================================ 7. another account keeps its own wallet
{
  const { ctx, p } = await open({ phone: true });
  await until(async () => (await p.locator('.onboard').count()) === 1, 15000);
  check('second account: sign up', await signUp(p, 'tia', 'tia-password-1', PIC_B));
  await buyCoin(p, 0);
  check('second account: has only its own trade', await until(async () => (await wallet(p))?.trades.length === 1, 10000));
  check('server keeps one wallet per account (sam: reset, tia: 1 trade)', await until(async () => { const w = server().map((x) => x.trades.length).sort(); return w.length === 2 && w[0] === 0 && w[1] === 1; }, 15000), JSON.stringify(server().map((x) => x.trades.length)));
  await ctx.close();
}

await browser.close(); appSrv.close(); wsrv.close();
const failed = results.filter((r) => !r.ok);
console.log('\nPAGE ERRORS: ' + (pageErrors.length ? '\n' + [...new Set(pageErrors)].join('\n') : 'none'));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length || pageErrors.length ? 1 : 0);
