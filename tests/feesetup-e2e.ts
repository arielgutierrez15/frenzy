/**
 * Admin → Fee accounts, in Chromium against the REAL Worker code (fee-setup routes) with a fake chain and real Ed25519
 * signatures. The admin wallet owns the fee accounts (like the real BAGZ wallet); none exist at first.
 * Flow: sign in → Fee accounts shows "Not created yet" → Create → wallet signs once → only ATA creates were sent →
 * chain lands them → screen shows Ready. Desktop and phone. Run: node --import tsx tests/feesetup-e2e.ts
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// @ts-ignore plain JS
import { makeMock } from './mock-api.mjs';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
// @ts-ignore plain JS
import { associatedTokenAddress, ATA_PROGRAM } from '../worker/feesetup.js';
import { D1, Chain, keypair } from './fakechain';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));
const results: { name: string; ok: boolean }[] = [];
const pageErrors: string[] = [];
const check = (name: string, ok: unknown, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, ms = 15000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const appSrv = createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); });
const APP = `http://127.0.0.1:${await listen(appSrv)}`, APP_LIVE = APP;

const chain = new Chain();
const db = new D1();
const user = await keypair();
const feeOwner = user.address, boostOwner = user.address;
const feeWsol: string = await associatedTokenAddress(feeOwner, sol.MINTS.wsol);
const feeUsdc: string = await associatedTokenAddress(feeOwner, sol.MINTS.usdc);
const boostUsdc = feeUsdc;
// land what the server sends: create the token accounts on the fake chain, like Solana would
const sentIx: string[][] = [];
chain.opts.onSend = (bytes, sig) => {
  const d = sol.parseTransaction(bytes).decoded;
  sentIx.push(d.instructions.map((ix: any) => d.staticKeys[ix.programIdIndex]));
  for (const ix of d.instructions) {
    if (d.staticKeys[ix.programIdIndex] !== ATA_PROGRAM) continue;
    const k = ix.accounts.map((i: number) => d.staticKeys[i]);
    if (!chain.accounts.has(k[1])) chain.addTokenAccount(k[1], k[3], k[2]);
  }
  chain.land(sig, { keys: d.staticKeys });
};
const CHAIN_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts', 'simulateTransaction', 'sendTransaction', 'getSignatureStatuses', 'getTransaction', 'getBlockHeight', 'getBalance', 'getLatestBlockhash', 'getSignaturesForAddress', 'getTokenAccountsByOwner']);

function startWorker(live: boolean) {
  const mock = makeMock();
  const log: { method: string; path: string; status: number }[] = [];
  const env: any = {
    ALLOWED_ORIGINS: `${APP},${APP_LIVE}`, JUPITER_API_KEY: 'SECRET-JUP', Db: db,
    ENABLE_LIVE_SWAPS: 'false', ENABLE_LIVE_BOOST_PAYMENTS: 'false', BAGZ_PLATFORM_FEE_BPS: '50',
    FEE_WALLET: feeOwner, FEE_ACCOUNT_WSOL: feeWsol, FEE_ACCOUNT_USDC: feeUsdc, BOOST_WALLET: boostOwner, BOOST_USDC_ACCOUNT: boostUsdc,
    ADMIN_WALLETS: user.address, ADMIN_SESSION_SECRET: 'z'.repeat(40), PASSWORD_ITERATIONS: '10000',
    ...['JUP', 'GT', 'DS', 'PUMP', 'RUG', 'RPC'].reduce((o, k) => ({ ...o, ['UPSTREAM_PER_MIN_' + k]: '5000' }), {}), RATE_PER_MIN: '5000', RATE_POST_PER_MIN: '5000',
  };
  const viaMock = (url0: string, init: any = {}) => new Promise<Response>((res, rej) => {
    const r = { request: () => ({ url: () => url0, method: () => init.method || 'GET', postData: () => init.body }), fulfill: ({ status = 200, headers = {}, body = '', contentType }: any) => res(new Response(body, { status, headers: { ...headers, 'content-type': contentType || 'application/json' } })), abort: () => rej(new TypeError('aborted')) };
    mock.route(r).catch(rej);
  });
  const up = async (url: string, init: any = {}) => {
    const u = new URL(url);
    if (u.host === 'api.jup.ag' && u.pathname === '/swap/v2/build') return chain.fetch(url, init);
    if (u.host === 'api.mainnet-beta.solana.com' && CHAIN_METHODS.has(JSON.parse(String(init.body || '{}')).method)) return chain.fetch(url, init);
    return viaMock(url, init);
  };
  const srv = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://127.0.0.1:${(srv.address() as any).port}${req.url}`, { method: req.method, headers: req.headers as any, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const out = await handle(request, env, undefined, { fetch: up, cache: null });
    log.push({ method: req.method!, path: req.url!, status: out.status });
    const h: Record<string, string> = {}; out.headers.forEach((v: string, k: string) => { h[k] = v; });
    res.writeHead(out.status, h); res.end(Buffer.from(await out.arrayBuffer()));
  });
  return listen(srv).then((port) => ({ url: `http://127.0.0.1:${port}`, log, env, close: () => new Promise((r) => srv.close(r)) }));
}

// ---- browser
// injected as plain JS strings: functions compiled by tsx can carry helpers (e.g. __name) that do not exist in the page
const FAKE_LWC = `window.LightweightCharts = { createChart() { const s = () => ({ setData() {}, update() {}, setMarkers() {}, createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } }); return { addCandlestickSeries: s, addLineSeries: s, addAreaSeries: s, addHistogramSeries: s, removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; }, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() {} }; } };`;
const WALLET = (address: string) => `(() => {
  const address = ${JSON.stringify(address)};
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = (s) => { let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c)); const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; } return out; };
  const toB64 = (u) => { let s = ''; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const acct = { address, publicKey: b58(address), chains: ['solana:mainnet'], features: ['solana:signTransaction', 'solana:signMessage'] };
  const wallet = { name: 'TestWallet', icon: '', chains: ['solana:mainnet'], accounts: [acct], features: {
    'standard:connect': { connect: async () => ({ accounts: [acct] }) },
    'standard:disconnect': { disconnect: async () => {} },
    'standard:events': { on: () => () => {} },
    'solana:signTransaction': { signTransaction: async (input) => { window.__signed = (window.__signed || 0) + 1; return [{ signedTransaction: fromB64(await window.__nodeSignTx(toB64(input.transaction))) }]; } },
    'solana:signMessage': { signMessage: async (input) => [{ signedMessage: input.message, signature: fromB64(await window.__nodeSignMsg(toB64(input.message))) }] },
  } };
  window.addEventListener('wallet-standard:app-ready', (e) => e.detail.register(wallet));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: (api) => api.register(wallet) }));
})();`;

async function makeSession() {
  const env = { ALLOWED_ORIGINS: APP, Db: db, PASSWORD_ITERATIONS: '10000', RATE_POST_PER_MIN: '5000' };
  const call = async (path: string, body: unknown, token?: string) => (await handle(new Request(`http://w${path}`, { method: 'POST', headers: { origin: APP, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env, undefined, { fetch: chain.fetch, cache: null })).json();
  const r = await call('/v1/auth/signup', { username: 'swaptester', password: 'swap-tester-pw' });
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');
  await call('/v1/me/avatar', { image: png }, r.token);
  return r.token as string;
}
async function open(origin: string, proxy: string, o: { mobile?: boolean; wallet?: boolean; hash?: string } = {}) {
  const ctx = await browser.newContext(o.mobile
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript({ content: FAKE_LWC });
  await p.addInitScript({ content: `try { localStorage.setItem('bagz.session', ${JSON.stringify(SESSION)}); } catch (e) {}` });
  if (o.wallet !== false) {
    await p.exposeFunction('__nodeSignTx', async (b64: string) => {
      const bytes = sol.b64decode(b64); const t = sol.parseTransaction(bytes);
      const out = bytes.slice(); out.set(await user.sign(t.message), 1); return sol.b64encode(out);
    });
    await p.exposeFunction('__nodeSignMsg', async (b64: string) => sol.b64encode(await user.sign(sol.b64decode(b64))));
    await p.addInitScript({ content: WALLET(user.address) });
  }
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => r.abort());
  p.on('pageerror', (e: Error) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m: any) => { if (m.type() === 'error' && !/net::|Failed to load resource|CORS|Access-Control/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  await p.goto(`${origin}/?proxy=${encodeURIComponent(proxy)}${o.hash ? '#' + o.hash : ''}`);
  return { ctx, p };
}
const noHScroll = (p: any) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const text = (p: any, sel: string) => p.locator(sel).first().innerText();
/** connect the test wallet unless the app already has it connected */
async function ensureConnected(p: any, scope = 'main') {
  await until(async () => (await p.locator(`${scope} button`, { hasText: /Connect TestWallet|Disconnect/ }).count()) > 0, 8000);
  const b = p.locator(`${scope} button`, { hasText: /Connect TestWallet/ });
  if (await b.count()) await b.first().click();
  await until(async () => (await p.locator(`${scope} button`, { hasText: /^Disconnect$/ }).count()) > 0, 8000);
}

const SESSION = await makeSession();
const browser = await chromium.launch();
async function signInAdmin(p: any) {
  await until(async () => /Insights, controls and records/.test(await text(p, 'main')));
  const c = p.locator('main button', { hasText: /Connect TestWallet/ });
  if (await until(async () => (await c.count()) > 0, 8000)) await c.first().click();
  await p.locator('main button', { hasText: 'Sign in with this wallet' }).click();
  return until(async () => (await p.locator('.admin-nav').count()) === 1);
}

const w = await startWorker(false);
{
  const { ctx, p } = await open(APP, w.url, { hash: 'admin' });
  check('admin signs in with the wallet', await signInAdmin(p));
  await p.locator('.admin-nav button', { hasText: 'Fee accounts' }).click();
  check('Fee accounts shows both swap accounts as not created yet', await until(async () => { const t = await text(p, 'main'); return /Swap fees · wrapped SOL[\s\S]*Not created yet/.test(t) && /Swap fees · USDC[\s\S]*Not created yet/.test(t); }), (await text(p, 'main')).slice(0, 400).replace(/\s+/g, ' '));
  check('BOOST shares the USDC account and says so', /Same account as the swap-fee USDC account/.test(await text(p, 'main')));
  check('offers to create 2 accounts', /2 accounts to create/.test(await text(p, 'main')));
  await p.screenshot({ path: resolve(SHOTS, 'fees-before.png'), fullPage: true });
  const signedBefore = await p.evaluate(() => (window as any).__signed || 0);
  await p.locator('main button', { hasText: /Create them now/ }).click();
  check('after one wallet signature both accounts show Ready', await until(async () => { const t = await text(p, 'main'); return (t.match(/\bReady\b/g) || []).length >= 5 && /All set/.test(t); }, 40000), (await text(p, 'main')).slice(0, 600).replace(/\s+/g, ' '));
  check('the wallet was asked to sign exactly once', (await p.evaluate(() => (window as any).__signed || 0)) - signedBefore === 1);
  check('one transaction was sent, containing only account creates', sentIx.length === 1 && sentIx[0].length === 2 && sentIx[0].every((x) => x === ATA_PROGRAM), JSON.stringify(sentIx));
  check('link to the transaction on Solscan', (await p.locator('a[href*="solscan.io/tx/"]').count()) === 1);
  check('no create button once everything exists', (await p.locator('main button', { hasText: /Create (them|it) now/ }).count()) === 0);
  await p.screenshot({ path: resolve(SHOTS, 'fees-after.png'), fullPage: true });
  await ctx.close();
}
{
  const { ctx, p } = await open(APP, w.url, { hash: 'admin', mobile: true });
  check('phone: admin signs in', await signInAdmin(p));
  await p.locator('.admin-nav button', { hasText: 'Fee accounts' }).click();
  check('phone: Fee accounts shows Ready', await until(async () => /All set/.test(await text(p, 'main'))));
  check('phone: no sideways scrolling', await noHScroll(p));
  await p.screenshot({ path: resolve(SHOTS, 'fees-phone.png'), fullPage: true });
  await ctx.close();
}
await browser.close(); appSrv.close(); await w.close();
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
