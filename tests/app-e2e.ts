/**
 * Browser test of the new screens against the REAL Worker code (worker/index.js + api.js) with a real SQLite-backed D1.
 *  - market data: mocked providers (tests/mock-api.mjs); chain + Jupiter /build: fake chain (tests/fakechain.ts)
 *  - wallet: a Wallet Standard wallet injected into the page whose signatures are made in Node with a real Ed25519 key
 * Flows: Promote → pay USDC → verified → admin signs in and approves → Sponsored row (labelled) → impression/click
 * counted; live swap UI (locks closed, and with every lock open on a test build); real-wallet balances; phone layouts.
 * Run: node --import tsx tests/app-e2e.ts
 */
import { createServer } from 'http';
import { readFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// @ts-ignore plain JS
import { makeMock } from './mock-api.mjs';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
// @ts-ignore plain JS
import * as sol from '../worker/solana.js';
import { D1, Chain, keypair, rnd } from './fakechain';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/index.html'));
const LIVE_PAGE = resolve(SHOTS, 'bagz-live-test.html');
execFileSync('node', ['build.mjs'], { cwd: root, env: { ...process.env, BAGZ_LIVE_TRADING: '1', BAGZ_PAGE_OUT: LIVE_PAGE }, stdio: 'pipe' });
const HTML_LIVE = readFileSync(LIVE_PAGE);

const results: { name: string; ok: boolean }[] = [];
const pageErrors: string[] = [];
const check = (name: string, ok: unknown, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, ms = 15000, step = 150) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---- app servers
const serve = (html: Buffer) => createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); });
const appSrv = serve(HTML), liveSrv = serve(HTML_LIVE);
const APP_PORT = await listen(appSrv), LIVE_PORT = await listen(liveSrv);
const APP = `http://127.0.0.1:${APP_PORT}`, APP_LIVE = `http://127.0.0.1:${LIVE_PORT}`;

// ---- chain, wallet, Worker
const chain = new Chain();
const db = new D1();
const user = await keypair();
const feeOwner = rnd(), feeWsol = rnd(), feeUsdc = rnd(), boostOwner = rnd(), boostUsdc = rnd(), userUsdc = rnd();
chain.addTokenAccount(feeWsol, sol.MINTS.wsol, feeOwner);
chain.addTokenAccount(feeUsdc, sol.MINTS.usdc, feeOwner);
chain.addTokenAccount(boostUsdc, sol.MINTS.usdc, boostOwner);
chain.addTokenAccount(userUsdc, sol.MINTS.usdc, user.address, '250000000');
const src = readFileSync(resolve(root, 'src/snapshot.ts'), 'utf8');
const PROMO = /export const JUPITER[\s\S]*?\[\s*'([1-9A-HJ-NP-Za-km-z]{32,44})',\s*'([^']+)',\s*'([^']+)'/.exec(src)!;
const [PROMO_MINT, , PROMO_SYM] = [PROMO[1], PROMO[2], PROMO[3]];
chain.addMint(PROMO_MINT, 6);
chain.addTokenAccount(rnd(), PROMO_MINT, user.address, '4200000000');
// land every payment/swap the server sends, the way the real chain would report it
chain.opts.onSend = (bytes, sig) => {
  const d = sol.parseTransaction(bytes).decoded;
  const isPay = d.staticKeys.includes(sol.PROGRAMS.memo);
  if (isPay) {
    const ix = d.instructions[0];
    const amount = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true).toString();
    chain.land(sig, { keys: d.staticKeys, instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked', info: { mint: sol.MINTS.usdc, destination: d.staticKeys[ix.accounts[2]], authority: user.address, tokenAmount: { amount } } } }], blockTime: Math.floor(Date.now() / 1000) });
  } else chain.land(sig, { feeAccount: feeWsol, feeMint: sol.MINTS.wsol, feeDelta: '2500000', keys: [user.address] });
};
const CHAIN_METHODS = new Set(['getAccountInfo', 'getMultipleAccounts', 'simulateTransaction', 'sendTransaction', 'getSignatureStatuses', 'getTransaction', 'getBlockHeight', 'getBalance', 'getLatestBlockhash', 'getSignaturesForAddress', 'getTokenAccountsByOwner']);

function startWorker(live: boolean) {
  const mock = makeMock();
  const log: { method: string; path: string; status: number }[] = [];
  const env: any = {
    ALLOWED_ORIGINS: `${APP},${APP_LIVE}`, JUPITER_API_KEY: 'SECRET-JUP', Db: db,
    ENABLE_LIVE_SWAPS: live ? 'true' : 'false', ENABLE_LIVE_BOOST_PAYMENTS: 'true', BAGZ_PLATFORM_FEE_BPS: '50',
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

// this suite is about swaps and Boost, so a BAGZ account with a picture is created up front (accounts have their own suite)
async function makeSession() {
  const env = { ALLOWED_ORIGINS: APP, Db: db, PASSWORD_ITERATIONS: '10000', RATE_POST_PER_MIN: '5000' };
  const call = async (path: string, body: unknown, token?: string) => (await handle(new Request(`http://w${path}`, { method: 'POST', headers: { origin: APP, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env, undefined, { fetch: chain.fetch, cache: null })).json();
  const r = await call('/v1/auth/signup', { username: 'swaptester', password: 'swap-tester-pw' });
  const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]).toString('base64');
  await call('/v1/me/avatar', { image: png }, r.token);
  return r.token as string;
}
const SESSION = await makeSession();
const browser = await chromium.launch();
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

// ================================================================ 1. Promote → pay → review → sponsored
{
  const w = await startWorker(false);
  const { ctx, p } = await open(APP, w.url, { hash: 'promote' });
  check('Promote page opens at #promote', await until(async () => /Promote a token/.test(await text(p, 'main'))));
  check('packages show the right prices', await until(async () => { const t = await text(p, '.promo-pkgs'); return /\$10[\s\S]*12 hours[\s\S]*\$20[\s\S]*24 hours[\s\S]*\$75[\s\S]*3 days[\s\S]*\$200[\s\S]*7 days/.test(t); }), (await text(p, '.promo-pkgs')).replace(/\s+/g, ' '));
  await p.locator('input[aria-label="Token address"]').fill('not-a-mint');
  check('invalid token address is refused in the form', await until(async () => /isn’t a Solana token address/.test(await text(p, 'main'))));
  await p.locator('input[aria-label="Token address"]').fill(PROMO_MINT);
  check('a real mint is verified and its market data shown', await until(async () => (await text(p, '.promo-token')).includes(PROMO_SYM)), PROMO_SYM);
  await p.locator('.promo-pkg', { hasText: 'Starter' }).click();
  await ensureConnected(p);
  await p.locator('main button', { hasText: /^Pay 10 USDC$/ }).click();
  check('payment: wallet signs once, server verifies on-chain, order goes to review', await until(async () => /Paid · waiting for BAGZ review/.test(await text(p, 'main')), 25000), await text(p, '.promo-order').catch(() => ''));
  check('the wallet was asked to sign exactly one transaction', (await p.evaluate(() => (window as any).__signed)) === 1);
  check('not shown before approval', (await db.prepare("SELECT COUNT(*) AS n FROM promotions WHERE status = 'approved'").first('n')) === 0);
  await p.screenshot({ path: `${SHOTS}/promote-desktop.png`, fullPage: true });

  // admin
  await p.goto(`${APP}/?proxy=${encodeURIComponent(w.url)}#admin`);
  check('typing #admin into the open tab navigates to the review desk', await until(async () => /Boost review/.test(await text(p, 'main'))));
  await ensureConnected(p);
  await p.locator('main button', { hasText: 'Sign in with this wallet' }).click();
  check('admin signs in with a wallet signature', await until(async () => /Signed in as/.test(await text(p, 'main'))));
  check('the paid order is waiting for review, with its payment', await until(async () => (await p.locator('.admin-row').count()) === 1 && /paid/.test(await text(p, '.admin-row'))));
  await p.locator('.admin-row button', { hasText: 'Approve' }).click();
  check('approve moves it out of the review queue', await until(async () => (await p.locator('.admin-row').count()) === 0));
  await p.screenshot({ path: `${SHOTS}/admin-desktop.png`, fullPage: true });

  // home shows it, labelled, separate from rankings
  await p.goto(`${APP}/?proxy=${encodeURIComponent(w.url)}#home`);
  check('Sponsored row appears on Home', await until(async () => (await p.locator('.sponsored-card').count()) === 1, 20000));
  const sp = await text(p, '.sponsored');
  check('it is labelled as paid and as not a ranking or risk rating', /Paid placement/i.test(sp) && /not BAGZ picks, rankings or risk ratings/.test(sp) && /\bAd\b/i.test(await text(p, '.sponsored-card .ad-tag')), sp.replace(/\s+/g, ' ').slice(0, 160));
  check('sponsored token is not injected into organic lists', !(await p.locator('.movers, .coin-list').allInnerTexts()).join(' ').includes('Ad\n'));
  await p.locator('.sponsored').scrollIntoViewIfNeeded();
  const imp = await until(async () => Number(await db.prepare('SELECT COALESCE(SUM(impressions),0) AS n FROM campaign_stats').first('n')) === 1, 8000);
  check('an impression is counted once the card has been visible for a second', imp);
  await sleep(1500);
  check('…and only once per viewer', Number(await db.prepare('SELECT SUM(impressions) AS n FROM campaign_stats').first('n')) === 1);
  const [popup] = await Promise.all([p.waitForEvent('popup', { timeout: 3000 }).catch(() => null), p.locator('.sponsored-card').click()]);
  check('a click is counted', await until(async () => Number(await db.prepare('SELECT SUM(clicks) AS n FROM campaign_stats').first('n')) === 1, 5000));
  void popup;
  await p.screenshot({ path: `${SHOTS}/home-sponsored-desktop.png` });
  await ctx.close();
  await w.close();
}

// ================================================================ 2. live swap UI, server switch OFF (default)
let coinPath = '';
{
  const w = await startWorker(false);
  const { ctx, p } = await open(APP, w.url);
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  // open a coin that has known decimals (any Jupiter-listed coin)
  await p.locator('.coin-row').first().click();
  await until(async () => (await p.locator('.live-swap').count()) === 1, 10000);
  await ensureConnected(p, '.live-swap');
  check('connected wallet shows verified on-chain balances', await until(async () => /Balance: .* SOL/.test(await text(p, '.live-swap'))), (await text(p, '.live-swap')).split('\n').find((l: string) => /Balance/.test(l)));
  await p.locator('.live-swap input[aria-label="Swap amount"]').fill('0.25');
  const ok = await until(async () => { const t = await text(p, '.live-swap'); return /BAGZ fee \(0\.50%\)/i.test(t) && /Minimum received/i.test(t) && /Price impact/i.test(t) && /Network fee/i.test(t) && /Max slippage/i.test(t) && /You pay/i.test(t) && /not simulated/.test(t); }, 15000);
  check('quote shows amounts, minimum received, slippage, price impact, BAGZ 0.50% fee and network fee', ok, ok ? '' : (await text(p, '.live-swap')).replace(/\s+/g, ' ').slice(-300) + ' || ' + JSON.stringify(w.log.filter((l) => l.path.startsWith('/v1')).slice(-6)));
  check('server switch off: quote is exact but not signable; button disabled; wallet never asked', (await p.locator('.live-swap .btn-accent').isDisabled()) && /switched off/i.test(await text(p, '.live-swap .btn-accent')) && !(await p.evaluate(() => (window as any).__signed)));
  check('no transaction was built while live swaps are off', !w.log.some((l) => l.path === '/v1/swap/submit') && (await db.prepare('SELECT COUNT(*) AS n FROM swaps').first('n')) === 0);
  coinPath = await p.evaluate(() => location.hash);
  await p.screenshot({ path: `${SHOTS}/swap-off-desktop.png`, fullPage: true });
  await ctx.close();
  await w.close();
}

// ================================================================ 3. live swap, every lock open (test build + server switch on)
{
  const w = await startWorker(true);
  const { ctx, p } = await open(APP_LIVE, w.url);
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  await p.locator('.coin-row').first().click();
  await until(async () => (await p.locator('.live-swap').count()) === 1, 10000);
  await ensureConnected(p, '.live-swap');
  await p.locator('.live-swap input[aria-label="Swap amount"]').fill('0.5');
  check('live: swap button enables with a fresh signable quote', await until(async () => !(await p.locator('.live-swap .btn-accent').isDisabled()) && /refreshes in/.test(await text(p, '.live-swap')), 15000), await text(p, '.live-swap .btn-accent'));
  await p.locator('.live-swap .btn-accent').click();
  const done = await until(async () => /Confirmed on Solana/.test(await text(p, '.live-swap')), 25000);
  check('live: wallet signs → server sends → chain confirms → app reports the fee read from chain', done && /BAGZ fee collected: 0\.0025 SOL\./.test(await text(p, '.live-swap')), (await text(p, '.live-swap')).split('\n').filter((l: string) => /Confirmed|warn|fee collected/i.test(l)).join(' | '));
  check('exactly one swap transaction was sent', chain.sent.filter((x) => !sol.parseTransaction(x.bytes).decoded.staticKeys.includes(sol.PROGRAMS.memo)).length === 1);
  const row = await db.prepare("SELECT status, fee_collected FROM swaps WHERE status = 'confirmed'").first();
  check('database records the confirmed swap and the collected fee', row && row.fee_collected === '2500000', JSON.stringify(row));
  await p.screenshot({ path: `${SHOTS}/swap-live-desktop.png`, fullPage: true });
  await ctx.close();
  await w.close();
}

// ================================================================ 4. phones
{
  const w = await startWorker(false);
  // with a wallet in the page (wallet app browser)
  let { ctx, p } = await open(APP, w.url, { mobile: true });
  await until(async () => (await p.locator('.coin-row').count()) > 3, 40000);
  check('phone: Home has no horizontal scroll (with Sponsored row)', await noHScroll(p) && (await p.locator('.sponsored-card').count()) === 1);
  await p.screenshot({ path: `${SHOTS}/home-phone.png` });
  for (const page of ['promote', 'admin', 'wallet']) {
    await p.goto(`${APP}/?proxy=${encodeURIComponent(w.url)}#${page}`);
    await sleep(800);
    check(`phone: ${page} has no horizontal scroll`, await noHScroll(p));
    await p.screenshot({ path: `${SHOTS}/${page}-phone.png`, fullPage: true });
  }
  await ensureConnected(p);
  check('phone: Wallet tab shows the real wallet balances panel', await until(async () => /Your Solana wallet[\s\S]*SOL[\s\S]*2\.5/.test(await text(p, 'main'))));
  await p.screenshot({ path: `${SHOTS}/wallet-connected-phone.png`, fullPage: true });
  await p.goto(`${APP}/?proxy=${encodeURIComponent(w.url)}${coinPath}`);
  await ctx.close();
  // plain phone browser with no wallet: offer to open BAGZ inside the wallet app
  ({ ctx, p } = await open(APP, w.url, { mobile: true, wallet: false, hash: 'promote' }));
  const handoff = await until(async () => (await p.locator('a', { hasText: 'Open in Phantom' }).count()) === 1, 8000);
  const href = handoff ? await p.locator('a', { hasText: 'Open in Phantom' }).getAttribute('href') : '';
  check('phone without a wallet: Phantom/Solflare handoff links open this page in the wallet browser', handoff && href!.startsWith('https://phantom.com/ul/browse/' + encodeURIComponent(APP)) && (await p.locator('a', { hasText: 'Open in Solflare' }).count()) === 1, href || '');
  await p.screenshot({ path: `${SHOTS}/promote-phone-nowallet.png`, fullPage: true });
  await ctx.close();
  await w.close();
}

check('no runtime errors on any page', pageErrors.length === 0, pageErrors.slice(0, 5).join(' | '));
await browser.close();
appSrv.close(); liveSrv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
