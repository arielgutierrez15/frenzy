/**
 * Admin controls (/v1/admin/…): kill switches, BOOST queue extras, revenue, token blocklist, user stats, Vault controls
 * and the admin audit log. Plus the small read helpers the rest of the Worker uses to obey them.
 *
 * Rules:
 *  - Every admin route needs an admin session (requireAdmin in api.js). Every change writes one admin_audit row.
 *  - Kill switches only turn things OFF. Live swaps and BOOST payments also need ENABLE_LIVE_SWAPS /
 *    ENABLE_LIVE_BOOST_PAYMENTS = "true" in wrangler.toml; a switch here can never turn live money on by itself.
 *  - Reads are cached per Worker instance for a few seconds, so a change reaches every visitor within ~10 s.
 *  - If the 0004 tables are missing (migration not applied yet) the app keeps working as before: nothing is paused or
 *    hidden, and admin changes fail with a message saying which migration to run.
 */
import { ApiError, database, config, isTestCopy, rpcUrl } from './api.js';
import { MINTS, isPubkey } from './solana.js';
import { CARDS, CARD_BY_ID, SUPPLY, priceOf, RARITY, SERIES } from './vault-cards.js';

const DAY = 86_400_000;
const CACHE_MS = 10_000;
const USDC = MINTS.usdc, WSOL = MINTS.wsol;
const bad = (m) => new ApiError(400, m);
const one = (d, sql, ...a) => d.prepare(sql).bind(...a).first();
const all = async (d, sql, ...a) => (await d.prepare(sql).bind(...a).all()).results || [];
const run = (d, sql, ...a) => d.prepare(sql).bind(...a).run();
const changes = (r) => (r && r.meta ? r.meta.changes : 0) || 0;
const num = (v) => Number(v || 0);
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const DAY_SQL = (col) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;
const toUnits = (raw, dec) => { let b; try { b = BigInt(raw || '0'); } catch { return 0; } const p = 10n ** BigInt(dec); return Number(b / p) + Number(b % p) / 10 ** dec; };
const newRef = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
const missingTables = (e) => /no such table/i.test(String(e && e.message));
const MIGRATION_MSG = 'Admin controls need the database update in worker/migrations/0004_admin_controls.sql. Run it in the D1 console, then try again.';

function needDb(ctx) { const d = database(ctx.env); if (!d) throw new ApiError(503, 'Database (D1 binding "Db") is not connected'); return d; }
/** run an admin write; a missing 0004 table becomes a clear message instead of "Internal error" */
async function write(fn) { try { return await fn(); } catch (e) { if (missingTables(e)) throw new ApiError(503, MIGRATION_MSG); throw e; } }

// ---- shared, cached state ---------------------------------------------------------------------------------------------
export const SWITCHES = {
  swaps: { label: 'Live swaps', help: 'Real Jupiter swaps with the 0.50% fee. Quotes still show; nothing can be signed or sent.', master: 'liveSwaps' },
  boost: { label: 'BOOST payments', help: 'New BOOST orders and payments. Payments already sent can still be verified.', master: 'liveBoostPayments' },
  signups: { label: 'New sign-ups', help: 'Creating BAGZ accounts. People who already have an account can still log in.' },
  vault: { label: 'The Vault', help: 'Claiming challenge coins and buying cards. Collections stay visible.' },
};
const cache = new WeakMap();
async function load(ctx) {
  const d = database(ctx.env);
  if (!d) return { settings: new Map(), blocked: new Map(), cards: new Map() };
  const hit = cache.get(d);
  if (hit && ctx.now() - hit.at < CACHE_MS) return hit;
  const out = { at: ctx.now(), settings: new Map(), blocked: new Map(), cards: new Map() };
  try {
    for (const r of await all(d, 'SELECT key, value FROM admin_settings')) out.settings.set(r.key, r.value);
    for (const r of await all(d, 'SELECT mint, symbol FROM token_blocklist')) out.blocked.set(r.mint, r.symbol || null);
    for (const r of await all(d, 'SELECT card_id, paused, drop_at FROM card_controls')) out.cards.set(r.card_id, { paused: !!r.paused, dropAt: r.drop_at === null ? null : num(r.drop_at) });
  } catch (e) { if (!missingTables(e)) throw e; } // 0004 not applied yet: behave exactly as before
  cache.set(d, out);
  return out;
}
const invalidate = (ctx) => { const d = database(ctx.env); if (d) cache.delete(d); };

/** true when an admin switched this feature off */
export async function isPaused(ctx, id) { return (await load(ctx)).settings.get(`kill:${id}`) === '1'; }
export async function isBlocked(ctx, mint) { return (await load(ctx)).blocked.has(mint); }
export async function blockedSet(ctx) { return (await load(ctx)).blocked; }
export async function cardControls(ctx) { return (await load(ctx)).cards; }
/** challenge reward overrides set from the admin console: { challengeId: coins } */
export async function rewardOverrides(ctx) {
  const v = (await load(ctx)).settings.get('rewards');
  if (!v) return {};
  try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}
/** public list for the app: hidden tokens */
export async function publicBlocklist(ctx) {
  const b = await blockedSet(ctx);
  return { mints: [...b.keys()], at: ctx.now() };
}

/** one audit row; the time follows the Worker clock (tests and the test copy use a fake one) */
export async function auditAt(ctx, d, admin, action, target, detail) {
  await run(d, 'INSERT INTO admin_audit (t, admin, action, target, detail) VALUES (?, ?, ?, ?, ?)', ctx.now(), String(admin).slice(0, 64), action, target === undefined || target === null ? null : String(target).slice(0, 120), detail === undefined ? null : JSON.stringify(detail).slice(0, 2000));
}
const note = (v, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---- kill switches ------------------------------------------------------------------------------------------------------
export async function getSwitches(ctx) {
  const d = needDb(ctx);
  const cfg = config(ctx.env);
  let rows = [];
  let ready = true;
  try { rows = await all(d, "SELECT key, value, updated_at, updated_by FROM admin_settings WHERE key LIKE 'kill:%'"); } catch (e) { if (!missingTables(e)) throw e; ready = false; }
  const by = new Map(rows.map((r) => [r.key, r]));
  return {
    ready, migration: ready ? null : MIGRATION_MSG,
    switches: Object.entries(SWITCHES).map(([id, s]) => {
      const r = by.get(`kill:${id}`);
      const paused = r ? r.value === '1' : false;
      const masterOn = s.master ? !!cfg[s.master] : true;
      return {
        id, label: s.label, help: s.help, paused,
        // "server" = the wrangler.toml money switch; when it is off the feature is off whatever this switch says
        serverSwitch: s.master ? (masterOn ? 'on' : 'off') : null,
        running: !paused && masterOn,
        updatedAt: r ? num(r.updated_at) : null, updatedBy: r ? r.updated_by : null,
      };
    }),
  };
}
export async function setSwitch(ctx, admin, b) {
  const d = needDb(ctx);
  if (!Object.prototype.hasOwnProperty.call(SWITCHES, b.id)) throw bad('Unknown switch');
  if (typeof b.paused !== 'boolean') throw bad('paused must be true or false');
  const reason = note(b.reason);
  if (b.paused && !reason) throw bad('Add a short reason for pausing (it goes in the audit log)');
  await write(async () => {
    await run(d, `INSERT INTO admin_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, `kill:${b.id}`, b.paused ? '1' : '0', ctx.now(), admin);
    await auditAt(ctx, d, admin, b.paused ? 'switch.pause' : 'switch.resume', b.id, reason ? { reason } : undefined);
  });
  invalidate(ctx);
  return getSwitches(ctx);
}

// ---- BOOST queue extras -------------------------------------------------------------------------------------------------
export async function boostCounts(ctx, d) {
  const t = ctx.now();
  const rows = await all(d, 'SELECT status, COUNT(*) AS n FROM promotions GROUP BY status');
  const counts = Object.fromEntries(rows.map((r) => [r.status, num(r.n)]));
  counts.running = num((await one(d, "SELECT COUNT(*) AS n FROM promotions WHERE status = 'approved' AND starts_at <= ? AND ends_at > ?", t, t)).n);
  counts.refunds = num((await one(d, "SELECT COUNT(*) AS n FROM promotions p JOIN payments y ON y.promotion_id = p.id WHERE p.status = 'rejected'")).n);
  return counts;
}

// ---- revenue ------------------------------------------------------------------------------------------------------------
const isTestSig = (s) => typeof s === 'string' && s.startsWith('TEST-PAYMENT-');
export async function revenue(ctx, daysParam) {
  const d = needDb(ctx);
  const now = ctx.now();
  const days = [7, 14, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 30;
  const since = Date.parse(dayKey(now - (days - 1) * DAY) + 'T00:00:00Z');
  const keys = []; for (let i = days - 1; i >= 0; i--) keys.push(dayKey(now - i * DAY));

  // swap fees: confirmed swaps, amount read from the chain, dated by confirmation (updated_at)
  const fees = await all(d, `SELECT fee_mint, fee_collected, updated_at FROM swaps WHERE status = 'confirmed' AND fee_collected IS NOT NULL`);
  // BOOST: verified payments (test-copy fake payments are counted apart, never as revenue)
  const pays = await all(d, `SELECT y.signature, y.amount_raw, y.verified_at, p.package, p.status FROM payments y LEFT JOIN promotions p ON p.id = y.promotion_id`);
  const realPays = pays.filter((p) => !isTestSig(p.signature));

  const sum = (rows, key, from, dec) => { let s = 0n; for (const r of rows) if (num(r.t) >= from) { try { s += BigInt(r[key] || '0'); } catch { /* skip */ } } return toUnits(s.toString(), dec); };
  const feeRows = (mint) => fees.filter((f) => f.fee_mint === mint).map((f) => ({ raw: f.fee_collected, t: f.updated_at }));
  const boostRows = realPays.map((p) => ({ raw: p.amount_raw, t: p.verified_at }));
  const windows = { today: Date.parse(dayKey(now) + 'T00:00:00Z'), d7: now - 7 * DAY, d30: now - 30 * DAY, all: 0 };
  const totals = (rows, dec) => Object.fromEntries(Object.entries(windows).map(([k, from]) => [k, sum(rows, 'raw', from, dec)]));

  const daily = (rows, dec) => {
    const m = new Map();
    for (const r of rows) if (num(r.t) >= since) { const k = dayKey(num(r.t)); try { m.set(k, (m.get(k) || 0n) + BigInt(r.raw || '0')); } catch { /* skip */ } }
    return keys.map((k) => ({ day: k, n: toUnits((m.get(k) || 0n).toString(), dec) }));
  };
  const byPackage = {};
  for (const p of realPays) {
    const k = p.package || 'unknown';
    const e = (byPackage[k] ||= { orders: 0, usdc: 0 });
    e.orders++; e.usdc += toUnits(p.amount_raw, 6);
  }
  const refundRows = realPays.filter((p) => p.status === 'rejected');
  return {
    generatedAt: now, days,
    swapFees: { sol: totals(feeRows(WSOL), 9), usdc: totals(feeRows(USDC), 6), swaps: fees.length },
    boost: { usdc: totals(boostRows, 6), orders: realPays.length },
    dailySwapFeesSol: daily(feeRows(WSOL), 9), dailySwapFeesUsdc: daily(feeRows(USDC), 6), dailyBoostUsdc: daily(boostRows, 6),
    byPackage: Object.entries(byPackage).map(([pkg, v]) => ({ package: pkg, orders: v.orders, usdc: Math.round(v.usdc * 1e6) / 1e6 })).sort((a, b) => b.usdc - a.usdc),
    refundsOwed: { orders: refundRows.length, usdc: refundRows.reduce((s, p) => s + toUnits(p.amount_raw, 6), 0) },
    testPayments: pays.length - realPays.length,
    live: { swaps: config(ctx.env).liveSwaps, boost: config(ctx.env).liveBoostPayments },
  };
}

/** what the fee / BOOST accounts hold right now, read from Solana (one RPC call per account, on demand) */
export async function walletBalances(ctx) {
  const cfg = config(ctx.env);
  if (isTestCopy(ctx.env)) return { at: ctx.now(), accounts: [], note: 'The test copy has no real wallets.' };
  const rpc = async (method, params) => {
    if (ctx.guard && ctx.guard('rpc')) throw new Error('RPC budget for this minute is used up');
    const res = await ctx.fetch(rpcUrl(ctx.env), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.error) throw new Error((j && j.error && j.error.message) || `RPC answered ${res.status}`);
    return j.result;
  };
  const list = [];
  const seen = new Set();
  const add = (label, address, kind) => { if (!isPubkey(address) || seen.has(address + kind)) return; seen.add(address + kind); list.push({ label, address, kind }); };
  add('Fee wallet (SOL)', cfg.feeOwner, 'sol');
  add('Swap fees · wrapped SOL account', cfg.feeAccounts[WSOL], 'token');
  add('Swap fees · USDC account', cfg.feeAccounts[USDC], 'token');
  add('BOOST · USDC account', cfg.boostAccount, 'token');
  const accounts = [];
  for (const a of list) {
    try {
      if (a.kind === 'sol') { const r = await rpc('getBalance', [a.address, { commitment: 'confirmed' }]); accounts.push({ ...a, amount: toUnits(String(r && r.value || 0), 9), symbol: 'SOL' }); }
      else { const r = await rpc('getTokenAccountBalance', [a.address, { commitment: 'confirmed' }]); const v = r && r.value; accounts.push({ ...a, amount: v ? toUnits(v.amount, v.decimals) : 0, symbol: a.label.includes('USDC') ? 'USDC' : 'wSOL' }); }
    } catch (e) { accounts.push({ ...a, amount: null, error: String(e && e.message || 'unavailable').replace(/api-key=[^&\s]+/g, 'api-key=…').slice(0, 120) }); }
  }
  return { at: ctx.now(), accounts };
}

// ---- token blocklist ----------------------------------------------------------------------------------------------------
export async function listBlocklist(ctx) {
  const d = needDb(ctx);
  try {
    const rows = await all(d, 'SELECT mint, symbol, reason, created_at, created_by FROM token_blocklist ORDER BY created_at DESC');
    return { ready: true, tokens: rows.map((r) => ({ mint: r.mint, symbol: r.symbol, reason: r.reason, createdAt: num(r.created_at), createdBy: r.created_by })) };
  } catch (e) { if (missingTables(e)) return { ready: false, migration: MIGRATION_MSG, tokens: [] }; throw e; }
}
export async function blockToken(ctx, admin, b) {
  const d = needDb(ctx);
  const mint = typeof b.mint === 'string' ? b.mint.trim() : '';
  if (!isPubkey(mint)) throw bad('Paste a valid Solana token address');
  if (mint === USDC || mint === WSOL) throw bad('SOL and USDC can’t be blocked; BAGZ trades against them');
  const reason = note(b.reason, 200);
  if (!reason) throw bad('Add a reason (for example "rug pull" or "scam copy of $WIF")');
  const symbol = note(b.symbol, 20).replace(/^\$/, '') || null;
  await write(async () => {
    const r = await run(d, 'INSERT OR IGNORE INTO token_blocklist (mint, symbol, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?)', mint, symbol, reason, ctx.now(), admin);
    if (!changes(r)) throw new ApiError(409, 'That token is already blocked');
    // a blocked token's running or waiting BOOST campaigns stop showing; they are listed for manual follow-up
    await auditAt(ctx, d, admin, 'blocklist.add', mint, { symbol, reason });
  });
  invalidate(ctx);
  const affected = await all(d, "SELECT id, symbol, status FROM promotions WHERE mint = ? AND status IN ('pending_review', 'approved', 'awaiting_payment')", mint);
  return { ...(await listBlocklist(ctx)), affectedBoosts: affected.map((r) => ({ id: r.id, symbol: r.symbol, status: r.status })) };
}
export async function unblockToken(ctx, admin, b) {
  const d = needDb(ctx);
  if (!isPubkey(b.mint)) throw bad('Not a valid token address');
  await write(async () => {
    const r = await run(d, 'DELETE FROM token_blocklist WHERE mint = ?', b.mint);
    if (!changes(r)) throw new ApiError(404, 'That token isn’t on the blocklist');
    await auditAt(ctx, d, admin, 'blocklist.remove', b.mint, note(b.reason) ? { reason: note(b.reason) } : undefined);
  });
  invalidate(ctx);
  return listBlocklist(ctx);
}

// ---- user stats ---------------------------------------------------------------------------------------------------------
export async function userStats(ctx) {
  const d = needDb(ctx);
  const now = ctx.now();
  const lastSeen = '(SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id)';
  const r = await one(d, `SELECT COUNT(*) AS total,
      SUM(created_at <= ?) AS old1, SUM(created_at <= ? AND ${lastSeen} >= created_at + ?) AS back1,
      SUM(created_at <= ?) AS old7, SUM(created_at <= ? AND ${lastSeen} >= created_at + ?) AS back7,
      SUM(created_at <= ?) AS old30, SUM(created_at <= ? AND ${lastSeen} >= created_at + ?) AS back30
      FROM users u`, now - DAY, now - DAY, DAY, now - 7 * DAY, now - 7 * DAY, 7 * DAY, now - 30 * DAY, now - 30 * DAY, 30 * DAY);
  const act = await one(d, `SELECT COUNT(DISTINCT CASE WHEN last_seen >= ? THEN user_id END) AS dau,
      COUNT(DISTINCT CASE WHEN last_seen >= ? THEN user_id END) AS wau, COUNT(DISTINCT CASE WHEN last_seen >= ? THEN user_id END) AS mau FROM sessions`, now - DAY, now - 7 * DAY, now - 30 * DAY);
  const rate = (back, base) => (num(base) ? Math.round((num(back) / num(base)) * 1000) / 10 : null);
  // how engaged accounts are, by number of paper trades
  const buckets = await one(d, `SELECT SUM(n = 0) AS none, SUM(n BETWEEN 1 AND 9) AS some, SUM(n BETWEEN 10 AND 49) AS regular, SUM(n >= 50) AS heavy
      FROM (SELECT u.id, (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id AND a.kind = 'trade') AS n FROM users u)`);
  const pick = (rows) => rows.map((x) => ({ username: x.username, value: num(x.v), extra: x.e === undefined || x.e === null ? null : num(x.e) }));
  const topPnl = pick(await all(d, `SELECT u.username, st.pnl_pct AS v, st.trades AS e FROM user_stats st JOIN users u ON u.id = st.user_id WHERE st.trades >= 3 ORDER BY st.pnl_pct DESC LIMIT 10`));
  const topTrades = pick(await all(d, `SELECT u.username, COUNT(*) AS v FROM activity a JOIN users u ON u.id = a.user_id WHERE a.kind = 'trade' AND a.t >= ? GROUP BY a.user_id ORDER BY v DESC LIMIT 10`, now - 30 * DAY));
  const topCoins = pick(await all(d, `SELECT u.username, SUM(c.delta) AS v FROM coin_ledger c JOIN users u ON u.id = c.user_id GROUP BY c.user_id HAVING v > 0 ORDER BY v DESC LIMIT 10`));
  const topFriends = pick(await all(d, `SELECT u.username, COUNT(*) AS v FROM friendships f JOIN users u ON (u.id = f.user_a OR u.id = f.user_b) WHERE f.status = 'accepted' GROUP BY u.id ORDER BY v DESC LIMIT 10`));
  const prof = await one(d, `SELECT SUM(avatar_ver > 0) AS pic, SUM(bio IS NOT NULL AND bio <> '') AS bio FROM users`);
  // when people are active (UTC hour of their paper trades, last 30 days)
  const hours = await all(d, `SELECT CAST(strftime('%H', t / 1000, 'unixepoch') AS INTEGER) AS h, COUNT(*) AS n FROM activity WHERE t >= ? GROUP BY h`, now - 30 * DAY);
  const byHour = Array.from({ length: 24 }, (_, h) => num((hours.find((x) => num(x.h) === h) || {}).n));
  return {
    generatedAt: now,
    total: num(r.total), dau: num(act.dau), wau: num(act.wau), mau: num(act.mau),
    stickiness: num(act.mau) ? Math.round((num(act.dau) / num(act.mau)) * 1000) / 10 : null,
    retention: {
      d1: { pct: rate(r.back1, r.old1), base: num(r.old1) },
      d7: { pct: rate(r.back7, r.old7), base: num(r.old7) },
      d30: { pct: rate(r.back30, r.old30), base: num(r.old30) },
    },
    engagement: { none: num(buckets.none), some: num(buckets.some), regular: num(buckets.regular), heavy: num(buckets.heavy) },
    profiles: { withPicture: num(prof.pic), withBio: num(prof.bio) },
    activeHoursUtc: byHour,
    leaders: { pnl: topPnl, trades30d: topTrades, coins: topCoins, friends: topFriends },
  };
}

// ---- vault controls -----------------------------------------------------------------------------------------------------
export async function vaultAdmin(ctx, challenges) {
  const d = needDb(ctx);
  const now = ctx.now();
  const minted = new Map((await all(d, 'SELECT card_id, COUNT(*) AS n, MAX(t) AS last FROM card_mints GROUP BY card_id')).map((r) => [r.card_id, r]));
  const ctl = await cardControls(ctx);
  const over = await rewardOverrides(ctx);
  const coins = await one(d, `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta END), 0) AS issued, COALESCE(-SUM(CASE WHEN delta < 0 AND reason = 'card' THEN delta END), 0) AS spent,
      COALESCE(SUM(delta), 0) AS circulating, COALESCE(SUM(CASE WHEN reason = 'admin' THEN delta END), 0) AS adjusted FROM coin_ledger`);
  let ready = true;
  try { await one(d, 'SELECT 1 FROM card_controls LIMIT 1'); } catch (e) { if (missingTables(e)) ready = false; else throw e; }
  const adjustments = await all(d, `SELECT c.delta, c.ref, c.t, u.username FROM coin_ledger c LEFT JOIN users u ON u.id = c.user_id WHERE c.reason = 'admin' ORDER BY c.t DESC LIMIT 20`);
  return {
    ready, migration: ready ? null : MIGRATION_MSG, now,
    supply: SUPPLY, rarities: RARITY, series: SERIES,
    cards: CARDS.map((c) => {
      const m = minted.get(c.id); const k = ctl.get(c.id) || { paused: false, dropAt: null };
      const sold = m ? num(m.n) : 0;
      const status = sold >= SUPPLY ? 'sold_out' : k.paused ? 'paused' : k.dropAt && k.dropAt > now ? 'scheduled' : 'on_sale';
      return { id: c.id, series: c.series, no: c.no, mode: c.mode, rarity: c.rarity, price: priceOf(c), minted: sold, lastSale: m && m.last ? num(m.last) : null, paused: k.paused, dropAt: k.dropAt, status };
    }),
    coins: { issued: num(coins.issued), spent: num(coins.spent), circulating: num(coins.circulating), adjusted: num(coins.adjusted) },
    challenges: challenges.map((c) => ({ id: c.id, title: c.title, defaultReward: c.reward, reward: Number.isInteger(over[c.id]) ? over[c.id] : c.reward })),
    adjustments: adjustments.map((a) => ({ username: a.username, delta: num(a.delta), t: num(a.t) })),
  };
}
export async function setCard(ctx, admin, b) {
  const d = needDb(ctx);
  const card = CARD_BY_ID[b.card];
  if (!card) throw bad('Unknown card');
  const paused = !!b.paused;
  let dropAt = null;
  if (b.dropAt !== null && b.dropAt !== undefined && b.dropAt !== '') {
    dropAt = Number(b.dropAt);
    if (!Number.isFinite(dropAt) || dropAt < ctx.now() - 60_000 || dropAt > ctx.now() + 365 * DAY) throw bad('Pick a drop time in the next 12 months');
  }
  await write(async () => {
    await run(d, `INSERT INTO card_controls (card_id, paused, drop_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (card_id) DO UPDATE SET paused = excluded.paused, drop_at = excluded.drop_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, card.id, paused ? 1 : 0, dropAt, ctx.now(), admin);
    await auditAt(ctx, d, admin, 'vault.card', card.id, { paused, dropAt });
  });
  invalidate(ctx);
  return { ok: true };
}
export async function adjustCoins(ctx, admin, b) {
  const d = needDb(ctx);
  const username = typeof b.username === 'string' ? b.username.trim().replace(/^@/, '').toLowerCase() : '';
  const delta = Number(b.delta);
  const reason = note(b.reason, 200);
  if (!username) throw bad('Enter a username');
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 100_000) throw bad('Enter a whole number of coins between -100,000 and 100,000 (not 0)');
  if (!reason) throw bad('Add a reason (it goes in the audit log)');
  const u = await one(d, 'SELECT id, username FROM users WHERE username_lc = ?', username);
  if (!u) throw new ApiError(404, `No account called @${username}`);
  await write(() => one(d, 'SELECT 1 FROM admin_audit LIMIT 1')); // no audit table = no unlogged changes
  const ref = `admin-${newRef()}`;
  // the balance can never go below zero: the row is only added if the result stays ≥ 0
  const r = await run(d, `INSERT INTO coin_ledger (user_id, delta, reason, ref, t)
      SELECT ?, ?, 'admin', ?, ? WHERE (SELECT COALESCE(SUM(delta), 0) FROM coin_ledger WHERE user_id = ?) + ? >= 0`, u.id, delta, ref, ctx.now(), u.id, delta);
  if (!changes(r)) throw bad(`That would take @${u.username} below 0 coins`);
  await write(() => auditAt(ctx, d, admin, 'coins.adjust', `@${u.username}`, { delta, reason }));
  const bal = num((await one(d, 'SELECT COALESCE(SUM(delta), 0) AS b FROM coin_ledger WHERE user_id = ?', u.id)).b);
  return { username: u.username, balance: bal };
}
export async function setRewards(ctx, admin, b, challenges) {
  const d = needDb(ctx);
  const src = b && b.rewards;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw bad('rewards must be an object');
  const out = {};
  for (const c of challenges) {
    if (src[c.id] === undefined) continue;
    const v = Number(src[c.id]);
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw bad(`${c.title}: reward must be a whole number from 0 to 1000`);
    if (v !== c.reward) out[c.id] = v; // only store what differs from the default
  }
  await write(async () => {
    await run(d, `INSERT INTO admin_settings (key, value, updated_at, updated_by) VALUES ('rewards', ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`, JSON.stringify(out), ctx.now(), admin);
    await auditAt(ctx, d, admin, 'vault.rewards', null, out);
  });
  invalidate(ctx);
  return { ok: true };
}

// ---- audit log ----------------------------------------------------------------------------------------------------------
export const AUDIT_GROUPS = {
  switch: ['switch.pause', 'switch.resume'],
  boost: ['boost.approve', 'boost.reject', 'boost.end'],
  blocklist: ['blocklist.add', 'blocklist.remove'],
  vault: ['vault.card', 'vault.rewards', 'coins.adjust'],
  signin: ['signin'],
};
export async function auditLog(ctx, url) {
  const d = needDb(ctx);
  const g = url.searchParams.get('group');
  const before = Number(url.searchParams.get('before')) || ctx.now() + 60_000;
  const actions = Object.prototype.hasOwnProperty.call(AUDIT_GROUPS, g) ? AUDIT_GROUPS[g] : null;
  const lim = 60;
  let rows;
  try {
    rows = actions
      ? await all(d, `SELECT id, t, admin, action, target, detail FROM admin_audit WHERE t < ? AND action IN (${actions.map(() => '?').join(',')}) ORDER BY t DESC, id DESC LIMIT ?`, before, ...actions, lim)
      : await all(d, 'SELECT id, t, admin, action, target, detail FROM admin_audit WHERE t < ? ORDER BY t DESC, id DESC LIMIT ?', before, lim);
  } catch (e) { if (missingTables(e)) return { ready: false, migration: MIGRATION_MSG, entries: [], next: null }; throw e; }
  const entries = rows.map((r) => { let detail = null; try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { /* keep null */ } return { id: num(r.id), t: num(r.t), admin: r.admin, action: r.action, target: r.target, detail }; });
  return { ready: true, group: actions ? g : 'all', entries, next: entries.length === lim ? entries[entries.length - 1].t : null };
}
