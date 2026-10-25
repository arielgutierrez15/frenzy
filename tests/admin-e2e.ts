/**
 * The admin console in the TEST COPY (docs/demo/index.html): the real Worker code runs in the page, and any signed-in
 * account may open #admin there. Clicks through every section and uses each control:
 * kill switches, BOOST queue, revenue, token blocklist (the coin really leaves Home), user stats, Vault controls and
 * the audit log. Desktop and phone. Run: node --import tsx tests/admin-e2e.ts   (after npm run build:copy)
 */
import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
// @ts-ignore plain JS
import { makeMock } from './mock-api.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT || '/opt/npm-tools/node_modules/playwright/index.mjs');
const SHOTS = process.env.SHOTS || '/tmp/bagz-shots';
mkdirSync(SHOTS, { recursive: true });
const HTML = readFileSync(resolve(root, 'docs/demo/index.html'));
const PIC = resolve(root, 'tests/fixtures/pfp-ana.png');
const results: { name: string; ok: boolean }[] = [];
const pageErrors: string[] = [];
const check = (name: string, ok: unknown, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<unknown>, ms = 15000, step = 200) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const listen = (srv: any) => new Promise<number>((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const FAKE_LWC = `window.LightweightCharts = { createChart() { const s = () => ({ setData() {}, update() {}, setMarkers() {}, createPriceLine() { return {}; }, removePriceLine() {}, applyOptions() {}, priceScale() { return { applyOptions() {} }; } }); return { addCandlestickSeries: s, addLineSeries: s, addAreaSeries: s, addHistogramSeries: s, removeSeries() {}, priceScale() { return { applyOptions() {} }; }, timeScale() { return { fitContent() {}, scrollToRealTime() {}, applyOptions() {} }; }, subscribeCrosshairMove() {}, unsubscribeCrosshairMove() {}, applyOptions() {}, resize() {}, remove() {} }; } };`;

const mock = makeMock();
// serve the page, and the Vault card art next to it (the admin Vault list shows thumbnails)
const appSrv = createServer((q, res) => {
  const m = /\/vault\/art\/([a-z]+-\d\d\.webp)$/.exec(q.url || '');
  const f = m && resolve(root, 'docs/vault/art', m[1]);
  if (f && existsSync(f)) { res.writeHead(200, { 'content-type': 'image/webp' }); res.end(readFileSync(f)); return; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML);
});
const APP = `http://127.0.0.1:${await listen(appSrv)}/demo/`;
const browser = await chromium.launch();

const text = (p: any, sel = 'body') => p.locator(sel).first().innerText();
const noHScroll = (p: any) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function newPage(phone = false) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript({ content: FAKE_LWC });
  await p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r: any) => mock.route(r));
  p.on('pageerror', (e: Error) => pageErrors.push('PAGEERROR ' + e.message));
  p.on('console', (m: any) => { if (m.type() === 'error' && !/net::|Failed to load resource|status of 4\d\d/.test(m.text())) pageErrors.push('console.error ' + m.text()); });
  return { ctx, p };
}
async function signUp(p: any, name: string) {
  await p.goto(APP);
  await until(async () => (await p.locator('.onboard').count()) === 1, 20000);
  await p.locator('.onboard input[autocomplete=username]').fill(name);
  await p.locator('.onboard input[autocomplete=new-password]').nth(0).fill('boss-password-1');
  await p.locator('.onboard input[autocomplete=new-password]').nth(1).fill('boss-password-1');
  await p.locator('.onboard button', { hasText: 'Continue' }).click();
  await until(async () => /Add a profile picture/.test(await text(p, '.onboard')), 15000);
  await p.locator('.onboard input[type=file]').setInputFiles(PIC);
  await until(async () => (await p.locator('.pfp-preview').count()) === 1, 8000);
  await p.locator('.onboard button', { hasText: 'Save and start trading' }).click();
  return until(async () => (await p.locator('.onboard').count()) === 0 && (await p.locator('.tabbar, .rail').count()) > 0, 15000);
}
const goAdmin = async (p: any) => { await p.evaluate(() => { location.hash = 'admin'; }); return until(async () => (await p.locator('.admin-nav').count()) === 1, 15000); };
const section = async (p: any, label: string) => { await p.locator('.admin-nav button', { hasText: label }).first().click(); await sleep(150); };
const goHome = async (p: any) => { await p.evaluate(() => { location.hash = ''; }); await p.locator('.rail-nav button:visible, .tabbar button:visible').filter({ has: p.locator('span, b', { hasText: /^Home$/ }) }).first().click(); };

// ---------------------------------------------------------------------------------------------------------------------
const { ctx, p } = await newPage();
check('sign up (test copy account)', await signUp(p, 'boss'));
check('home lists coins from market data', await until(async () => (await p.locator('.coin-row').count()) > 3, 40000));

// pick a coin on Home to block later: its ticker from the row, its mint from the coin page
const row = p.locator('.coin-row').nth(1);
const victim = ((await row.locator('b').first().innerText()).split(/\s/)[0] || '').trim(); // "$SYMBOL"
await row.click();
const rug = await until(async () => p.locator('a[href*="rugcheck.xyz/tokens/"]').first().getAttribute('href'), 15000) as string;
const victimMint = /tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(rug || '')?.[1] || '';
check('found a coin to block', !!victimMint && victim.startsWith('$'), `${victim} ${victimMint}`);

check('#admin opens the console with grouped navigation', await goAdmin(p));
const labels = await p.locator('.admin-nav-label').allInnerTexts();
check('nav groups: Insights · Controls · Records', labels.map((s: string) => s.toUpperCase()).join(',') === 'INSIGHTS,CONTROLS,RECORDS', labels.join(','));
check('11 sections in the nav', (await p.locator('.admin-nav button').count()) === 11);

// overview (unchanged) still loads
await section(p, 'Overview');
check('Overview loads', await until(async () => /Sign-ups & users/.test(await text(p, 'main'))));

// users
await section(p, 'Users');
check('Users: user stats load', await until(async () => /Came back next day/i.test(await text(p, 'main')) && /Most trades · 30 days/i.test(await text(p, 'main'))));
check('Users: the accounts table is on the same page', await until(async () => /@boss/.test(await text(p, '.admin-table'))));
await p.screenshot({ path: `${SHOTS}/admin-users.png`, fullPage: true });

// revenue
await section(p, 'Revenue');
check('Revenue: totals and per-day charts', await until(async () => /Earned/i.test(await text(p, 'main')) && /BOOST per day/i.test(await text(p, 'main')) && /Refunds owed/i.test(await text(p, 'main'))));
await p.locator('button', { hasText: 'Check balances' }).click();
check('Revenue: wallet check answers (test copy has no wallets)', await until(async () => /no real wallets/.test(await text(p, 'main'))));
await p.screenshot({ path: `${SHOTS}/admin-revenue.png`, fullPage: true });

// kill switches
await section(p, 'Kill switches');
check('Switches: four switches listed', await until(async () => (await p.locator('.switch-row').count()) === 4));
const signups = p.locator('.switch-row').filter({ hasText: 'New sign-ups' });
await signups.locator('button', { hasText: 'Pause' }).click();
await signups.locator('button', { hasText: 'Confirm pause' }).click();
check('Switches: pausing asks for a reason first', await until(async () => /reason/i.test(await text(p, '.panel .warn'))));
await signups.locator('input').fill('spam wave');
await signups.locator('button', { hasText: 'Confirm pause' }).click();
check('Switches: New sign-ups shows Paused', await until(async () => /Paused/.test(await signups.innerText()) && /Last changed/.test(await signups.innerText())));
check('Switches: red badge on the nav', await until(async () => (await p.locator('.admin-nav .admin-badge.down').innerText()) === '1'));
await p.screenshot({ path: `${SHOTS}/admin-switches.png`, fullPage: true });
await section(p, 'Overview');
check('a "Paused" banner shows on other sections', await until(async () => /Paused:\s*New sign-ups/.test(await text(p, '.admin-alert'))));
await p.locator('.admin-alert').click();
check('banner opens the switches', await until(async () => (await p.locator('.switch-row').count()) === 4));
await signups.locator('button', { hasText: 'Resume' }).click();
check('Switches: resume → Running, badge gone', await until(async () => /Running/.test(await signups.innerText()) && (await p.locator('.admin-nav .admin-badge.down').count()) === 0));

// BOOST queue
await section(p, 'BOOST queue');
check('BOOST queue: status tabs incl. Running now and Ended early', await until(async () => /Running now/.test(await text(p, 'main')) && /Ended early/.test(await text(p, 'main'))));
check('BOOST queue: empty review queue says so', await until(async () => /Nothing waiting for review/.test(await text(p, 'main'))));

// blocklist → the coin leaves Home
await section(p, 'Blocklist');
await p.locator('.admin-form input').nth(0).fill('not-a-mint');
await p.locator('.admin-form input').nth(2).fill('test');
await p.locator('button', { hasText: 'Block token' }).click();
check('Blocklist: bad address is refused in the form', await until(async () => /valid Solana token address/.test(await text(p, 'main'))));
await p.locator('.admin-form input').nth(0).fill(victimMint);
await p.locator('.admin-form input').nth(1).fill(victim);
await p.locator('.admin-form input').nth(2).fill('e2e: scam copy');
await p.locator('button', { hasText: 'Block token' }).click();
check('Blocklist: token added to the list', await until(async () => (await text(p, 'main')).includes(`${victim} · e2e: scam copy`)));
await p.screenshot({ path: `${SHOTS}/admin-blocklist.png`, fullPage: true });
await goHome(p);
const homeSyms = async () => (await p.locator('.coin-row b').allInnerTexts()).map((s: string) => s.split(/\s/)[0]);
check('the blocked coin is gone from Home', await until(async () => !(await homeSyms()).includes(victim), 10000), victim);
await goAdmin(p);
await section(p, 'Blocklist');
await p.locator('.log-row', { hasText: victim }).locator('button', { hasText: 'Unblock…' }).click();
await p.locator('.log-row', { hasText: victim }).locator('button', { hasText: /^Unblock$/ }).click();
check('Blocklist: unblock (with a confirm step)', await until(async () => /Nothing is blocked/.test(await text(p, 'main'))));

// Vault
await section(p, 'Vault');
check('Vault: 29 cards listed with supply', await until(async () => (await p.locator('.vault-admin-row').count()) === 29 && /0\/30 sold/.test(await text(p, '.vault-admin-row'))));
check('Vault: card art thumbnails load', await until(async () => p.evaluate(() => { const i = document.querySelector('.vault-thumb') as HTMLImageElement; return !!i && i.complete && i.naturalWidth > 0; })));
const ape2 = p.locator('.vault-admin-row').filter({ hasText: 'Skate' }).first();
await ape2.locator('button', { hasText: 'Pause' }).click();
check('Vault: pause a card', await until(async () => /Paused/.test(await ape2.innerText())));
await ape2.locator('button', { hasText: 'Resume' }).click();
check('Vault: resume it', await until(async () => /On sale/.test(await ape2.innerText())));
await ape2.locator('button', { hasText: 'Drop time…' }).click();
await ape2.locator('button', { hasText: 'Schedule' }).click();
check('Vault: schedule a drop', await until(async () => /Scheduled/.test(await ape2.innerText()) && /drops/.test(await ape2.innerText())));
await ape2.locator('button', { hasText: 'Drop time…' }).click();
await ape2.locator('button', { hasText: 'Clear schedule' }).click();
check('Vault: clear the schedule', await until(async () => /On sale/.test(await ape2.innerText())));
const reward = p.locator('input[aria-label^="Reward for"]').first();
await reward.fill('60');
await p.locator('button', { hasText: 'Save rewards' }).click();
check('Vault: change a challenge reward', await until(async () => /Rewards saved/.test(await text(p, 'main')) && /default 50/.test(await text(p, 'main'))));
await p.locator('button', { hasText: 'Reset to defaults' }).click();
check('Vault: reset rewards to defaults', await until(async () => /reset to defaults/.test(await text(p, 'main')) && !/default 50/.test(await text(p, 'main'))));
const coinForm = p.locator('.panel').filter({ hasText: 'Adjust coins' });
await coinForm.locator('input').nth(0).fill('@boss');
await coinForm.locator('input').nth(1).fill('75');
await coinForm.locator('input').nth(2).fill('e2e prize');
await coinForm.locator('button', { hasText: 'Apply' }).click();
check('Vault: give coins → listed with +75', await until(async () => /Coins updated/.test(await text(p, 'main')) && /\+75/.test(await coinForm.innerText())));
await coinForm.locator('input').nth(0).fill('boss');
await coinForm.locator('input').nth(1).fill('-1000');
await coinForm.locator('input').nth(2).fill('too much');
await coinForm.locator('button', { hasText: 'Apply' }).click();
check('Vault: can’t take a balance below 0', await until(async () => /below 0 coins/.test(await text(p, 'main'))));
await p.screenshot({ path: `${SHOTS}/admin-vault.png`, fullPage: true });

// audit log has every change above
await section(p, 'Audit log');
check('Audit log: lists the changes, newest first', await until(async () => {
  const t = await text(p, 'main');
  return /Paused new sign-ups — “spam wave”/.test(t) && /Resumed new sign-ups/.test(t) && /Blocked/.test(t) && /Unblocked/.test(t) && /Gave 75 coins to @boss — “e2e prize”/.test(t) && /Card ape-02/.test(t) && /Changed rewards/.test(t);
}));
await p.locator('.panel .seg button', { hasText: /^Switches$/ }).first().click();
check('Audit log: filter to switches', await until(async () => (await p.locator('.log-row').count()) === 2));
await p.screenshot({ path: `${SHOTS}/admin-audit.png`, fullPage: true });

// records (unchanged sections still work)
await section(p, 'Transactions');
check('Transactions loads', await until(async () => /Paper trades/.test(await text(p, 'main'))));
await section(p, 'Activity');
check('Activity loads', await until(async () => /Created an account/.test(await text(p, 'main'))));
check('the coin adjustment shows in the activity log', await until(async () => /\+75 coins · admin/.test(await text(p, 'main'))));
await ctx.close();

// ---- phone: every section fits the screen ------------------------------------------------------------------------
{
  const { ctx: c2, p: q } = await newPage(true);
  check('phone: sign up', await signUp(q, 'boss_phone'));
  check('phone: console opens', await goAdmin(q));
  const fits: string[] = [];
  for (const s of ['Overview', 'Users', 'Revenue', 'Kill switches', 'BOOST queue', 'Blocklist', 'Vault', 'Transactions', 'Activity', 'Audit log']) {
    await q.locator('.admin-nav button', { hasText: s }).first().scrollIntoViewIfNeeded();
    await q.locator('.admin-nav button', { hasText: s }).first().click();
    await sleep(700);
    if (!(await noHScroll(q))) fits.push(s);
    if (s === 'Kill switches' || s === 'Vault') await q.screenshot({ path: `${SHOTS}/admin-phone-${s.split(' ')[0].toLowerCase()}.png`, fullPage: true });
  }
  check('phone: no sideways scrolling on any section', fits.length === 0, fits.join(', '));
  await q.screenshot({ path: `${SHOTS}/admin-phone-audit.png`, fullPage: true });
  await c2.close();
}

check('no runtime errors', pageErrors.length === 0, pageErrors.slice(0, 4).join(' | '));
await browser.close();
appSrv.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
