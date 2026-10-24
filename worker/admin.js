/**
 * BAGZ admin console data (/v1/admin/overview, /admin/users, /admin/log). Every route here requires an admin session
 * (wallet-signed, see requireAdmin in api.js). Read-only: nothing in this file changes app data.
 *
 * Privacy: password hashes, session tokens, avatars and chat message text are never returned. Chats are counted only.
 * Money: swap/BOOST amounts are reported exactly as stored (raw integer strings → decimal using the mint's decimals
 * where known). Paper-trading figures are labelled as paper; they are what the app reported, not real money.
 */
import { MINTS } from './solana.js';

const DAY = 86_400_000;
const USDC = MINTS.usdc;
const WSOL = MINTS.wsol;
const DECIMALS = { [USDC]: 6, [WSOL]: 9 };

const one = (d, sql, ...a) => d.prepare(sql).bind(...a).first();
const all = async (d, sql, ...a) => (await d.prepare(sql).bind(...a).all()).results || [];
const num = (v) => Number(v || 0);
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const DAY_SQL = (col) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;
/** raw integer string → decimal number (exact enough for display; sums are done on BigInt first) */
const units = (raw, mint) => { const dec = DECIMALS[mint]; if (dec === undefined) return null; const b = BigInt(raw || '0'); return Number(b / 10n ** BigInt(dec)) + Number(b % 10n ** BigInt(dec)) / 10 ** dec; };
const sumRaw = (rows, key) => rows.reduce((s, r) => { try { return s + BigInt(r[key] || '0'); } catch { return s; } }, 0n);

/** zero-filled daily series for the last `days` days ending today (UTC) */
function series(rows, days, now) {
  const m = new Map(rows.map((r) => [r.day, num(r.n)]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayKey(now - i * DAY); out.push({ day: k, n: m.get(k) || 0 }); }
  return out;
}

export async function adminOverview(ctx, d, daysParam) {
  const now = ctx.now();
  const days = [7, 14, 30, 90].includes(Number(daysParam)) ? Number(daysParam) : 30;
  const since = dayKey(now - (days - 1) * DAY);
  const sinceMs = Date.parse(since + 'T00:00:00Z');
  const t24 = now - DAY, t7 = now - 7 * DAY, t30 = now - 30 * DAY;

  const u = await one(d, `SELECT COUNT(*) AS total,
      SUM(created_at >= ?) AS d1, SUM(created_at >= ?) AS d7, SUM(created_at >= ?) AS d30,
      SUM(avatar_ver > 0) AS withAvatar, SUM(bio IS NOT NULL AND bio <> '') AS withBio FROM users`, t24, t7, t30);
  const act = await one(d, `SELECT COUNT(DISTINCT CASE WHEN last_seen >= ? THEN user_id END) AS dau,
      COUNT(DISTINCT CASE WHEN last_seen >= ? THEN user_id END) AS wau,
      COUNT(DISTINCT CASE WHEN last_seen >= ? THEN user_id END) AS mau,
      SUM(expires_at > ?) AS liveSessions FROM sessions`, t24, t7, t30, now);
  const signups = series(await all(d, `SELECT ${DAY_SQL('created_at')} AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day`, sinceMs), days, now);
  const activeDaily = series(await all(d, `SELECT ${DAY_SQL('t')} AS day, COUNT(DISTINCT user_id) AS n FROM activity WHERE t >= ? GROUP BY day`, sinceMs), days, now);

  // paper trading (reported by the app)
  const pt = await one(d, `SELECT COUNT(*) AS trades, SUM(t >= ?) AS d1, COUNT(DISTINCT user_id) AS traders,
      SUM(json_extract(data, '$.side') = 'BUY') AS buys, SUM(json_extract(data, '$.side') = 'SELL') AS sells,
      COALESCE(SUM(json_extract(data, '$.usd')), 0) AS volume, COALESCE(SUM(CASE WHEN t >= ? THEN json_extract(data, '$.usd') END), 0) AS volume1d
      FROM activity WHERE kind = 'trade'`, t24, t24);
  const theses = await one(d, `SELECT COUNT(*) AS n FROM activity WHERE kind = 'thesis'`);
  const tradesDaily = series(await all(d, `SELECT ${DAY_SQL('t')} AS day, COUNT(*) AS n FROM activity WHERE kind = 'trade' AND t >= ? GROUP BY day`, sinceMs), days, now);
  const topTokens = (await all(d, `SELECT json_extract(data, '$.symbol') AS symbol, json_extract(data, '$.mint') AS mint, COUNT(*) AS trades,
      COALESCE(SUM(json_extract(data, '$.usd')), 0) AS volume FROM activity WHERE kind = 'trade' AND t >= ? GROUP BY mint ORDER BY trades DESC LIMIT 8`, sinceMs))
    .map((r) => ({ symbol: r.symbol, mint: r.mint, trades: num(r.trades), volume: num(r.volume) }));
  const ps = await one(d, `SELECT COUNT(*) AS n, AVG(pnl_pct) AS avgPnl, SUM(pnl_pct > 0) AS winners, AVG(win_rate) AS avgWin FROM user_stats`);

  // real money (swaps + BOOST) — normally zero while the live switches are off
  const swapStatus = Object.fromEntries((await all(d, 'SELECT status, COUNT(*) AS n FROM swaps GROUP BY status')).map((r) => [r.status, num(r.n)]));
  const feeRows = await all(d, `SELECT fee_mint, fee_collected FROM swaps WHERE status = 'confirmed' AND fee_collected IS NOT NULL`);
  const fees = {};
  for (const r of feeRows) fees[r.fee_mint] = (fees[r.fee_mint] || 0n) + BigInt(r.fee_collected || '0');
  const feesOut = Object.entries(fees).map(([mint, raw]) => ({ mint, symbol: mint === USDC ? 'USDC' : mint === WSOL ? 'SOL' : null, raw: raw.toString(), amount: units(raw.toString(), mint) }));
  const swapsDaily = series(await all(d, `SELECT ${DAY_SQL('created_at')} AS day, COUNT(*) AS n FROM swaps WHERE created_at >= ? GROUP BY day`, sinceMs), days, now);
  const promoStatus = Object.fromEntries((await all(d, 'SELECT status, COUNT(*) AS n FROM promotions GROUP BY status')).map((r) => [r.status, num(r.n)]));
  const pays = await all(d, 'SELECT amount_raw, verified_at FROM payments');
  const boostRaw = sumRaw(pays, 'amount_raw');
  const boostRaw30 = sumRaw(pays.filter((p) => p.verified_at >= t30), 'amount_raw');
  const camp = await one(d, 'SELECT COALESCE(SUM(impressions),0) AS impressions, COALESCE(SUM(clicks),0) AS clicks FROM campaign_stats');

  // vault + social
  const coins = await one(d, `SELECT COALESCE(SUM(CASE WHEN delta > 0 THEN delta END), 0) AS issued, COALESCE(-SUM(CASE WHEN delta < 0 THEN delta END), 0) AS spent FROM coin_ledger`);
  const cards = await one(d, `SELECT COUNT(*) AS minted, COUNT(DISTINCT user_id) AS collectors FROM card_mints`);
  const soc = await one(d, `SELECT (SELECT COUNT(*) FROM friendships WHERE status = 'accepted') AS friends,
      (SELECT COUNT(*) FROM friendships WHERE status = 'pending') AS pendingFriends,
      (SELECT COUNT(*) FROM chats) AS chats, (SELECT COUNT(*) FROM messages WHERE user_id IS NOT NULL) AS messages,
      (SELECT COUNT(*) FROM messages WHERE user_id IS NOT NULL AND t >= ?) AS messages1d`, t24);

  return {
    generatedAt: now, days,
    users: { total: num(u.total), new24h: num(u.d1), new7d: num(u.d7), new30d: num(u.d30), withAvatar: num(u.withAvatar), withBio: num(u.withBio),
      dau: num(act.dau), wau: num(act.wau), mau: num(act.mau), liveSessions: num(act.liveSessions) },
    signups, activeDaily,
    paper: { trades: num(pt.trades), trades24h: num(pt.d1), traders: num(pt.traders), buys: num(pt.buys), sells: num(pt.sells), volumeUsd: num(pt.volume), volume24hUsd: num(pt.volume1d),
      theses: num(theses.n), reporting: num(ps.n), avgPnlPct: ps.avgPnl === null ? null : num(ps.avgPnl), inProfit: num(ps.winners), avgWinRate: ps.avgWin === null ? null : num(ps.avgWin) },
    tradesDaily, topTokens,
    swaps: { byStatus: swapStatus, total: Object.values(swapStatus).reduce((a, b) => a + b, 0), fees: feesOut },
    swapsDaily,
    boost: { byStatus: promoStatus, paidOrders: pays.length, revenueUsdc: units(boostRaw.toString(), USDC), revenue30dUsdc: units(boostRaw30.toString(), USDC), impressions: num(camp.impressions), clicks: num(camp.clicks) },
    vault: { coinsIssued: num(coins.issued), coinsSpent: num(coins.spent), cardsMinted: num(cards.minted), collectors: num(cards.collectors) },
    social: { friendships: num(soc.friends), pendingRequests: num(soc.pendingFriends), chats: num(soc.chats), messages: num(soc.messages), messages24h: num(soc.messages1d) },
  };
}

const SORTS = { new: 'u.created_at DESC', active: 'last_seen DESC', trades: 'trades DESC', pnl: 'pnl_pct DESC', name: 'u.username_lc ASC' };
export async function adminUsers(ctx, d, url) {
  const q = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 30);
  const sort = SORTS[url.searchParams.get('sort')] || SORTS.new;
  const offset = Math.max(0, Math.min(100_000, Number(url.searchParams.get('offset')) || 0));
  const where = q ? 'WHERE u.username_lc LIKE ?' : '';
  const args = q ? [`%${q}%`] : [];
  const total = num((await one(d, `SELECT COUNT(*) AS n FROM users u ${where}`, ...args)).n);
  const rows = await all(d, `SELECT u.id, u.username, u.created_at, u.avatar_ver, u.bio,
      (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen,
      (SELECT COUNT(*) FROM activity a WHERE a.user_id = u.id AND a.kind = 'trade') AS trades,
      st.equity, st.pnl_pct, st.win_rate,
      (SELECT COALESCE(SUM(delta), 0) FROM coin_ledger c WHERE c.user_id = u.id) AS coins,
      (SELECT COUNT(*) FROM card_mints m WHERE m.user_id = u.id) AS cards,
      (SELECT COUNT(*) FROM friendships f WHERE (f.user_a = u.id OR f.user_b = u.id) AND f.status = 'accepted') AS friends
    FROM users u LEFT JOIN user_stats st ON st.user_id = u.id ${where} ORDER BY ${sort} LIMIT 100 OFFSET ?`, ...args, offset);
  return {
    total, offset,
    users: rows.map((r) => ({ id: r.id, username: r.username, createdAt: num(r.created_at), lastSeen: r.last_seen ? num(r.last_seen) : null, hasAvatar: num(r.avatar_ver) > 0,
      avatarVer: num(r.avatar_ver), trades: num(r.trades), equity: r.equity === null ? null : num(r.equity), pnlPct: r.pnl_pct === null ? null : num(r.pnl_pct),
      winRate: r.win_rate === null ? null : num(r.win_rate), coins: num(r.coins), cards: num(r.cards), friends: num(r.friends) })),
  };
}

const LOG_TYPES = ['signup', 'trade', 'thesis', 'swap', 'boost', 'payment', 'card', 'coins'];
/** One merged, newest-first activity log. `type` filters to one kind; `before` pages back in time. */
export async function adminLog(ctx, d, url) {
  const type = LOG_TYPES.includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'all';
  const before = Number(url.searchParams.get('before')) || ctx.now() + 60_000;
  const lim = 80;
  const want = (k) => type === 'all' || type === k;
  const out = [];
  if (want('signup')) for (const r of await all(d, 'SELECT id, username, created_at FROM users WHERE created_at < ? ORDER BY created_at DESC LIMIT ?', before, lim))
    out.push({ type: 'signup', t: num(r.created_at), user: r.username, text: 'Created an account' });
  for (const k of ['trade', 'thesis']) if (want(k)) for (const r of await all(d, `SELECT a.t, a.data, u.username FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.kind = ? AND a.t < ? ORDER BY a.t DESC LIMIT ?`, k, before, lim)) {
    let x = {}; try { x = JSON.parse(r.data); } catch { /* skip bad row */ }
    out.push(k === 'trade'
      ? { type: 'trade', t: num(r.t), user: r.username, side: x.side, symbol: x.symbol, mint: x.mint, usd: num(x.usd), price: num(x.price), pnl: x.pnl ?? null, text: `Paper ${x.side === 'SELL' ? 'sold' : 'bought'} $${x.symbol}` }
      : { type: 'thesis', t: num(r.t), user: r.username, symbol: x.symbol, mint: x.mint, bull: !!x.bull, text: `${x.bull ? 'Bull' : 'Bear'} thesis on $${x.symbol}` });
  }
  if (want('swap')) for (const r of await all(d, 'SELECT id, taker, side, input_mint, output_mint, in_amount, status, signature, fee_mint, fee_collected, error, created_at FROM swaps WHERE created_at < ? ORDER BY created_at DESC LIMIT ?', before, lim))
    out.push({ type: 'swap', t: num(r.created_at), wallet: r.taker, side: r.side, status: r.status, signature: r.signature, inputMint: r.input_mint, outputMint: r.output_mint,
      inAmount: units(r.in_amount, r.input_mint), fee: r.fee_collected ? units(r.fee_collected, r.fee_mint) : null, feeSymbol: r.fee_mint === USDC ? 'USDC' : r.fee_mint === WSOL ? 'SOL' : null, error: r.error, text: `Live ${r.side.toLowerCase()} swap · ${r.status}` });
  if (want('boost')) for (const r of await all(d, 'SELECT id, symbol, package, price_raw, advertiser, status, created_at FROM promotions WHERE created_at < ? ORDER BY created_at DESC LIMIT ?', before, lim))
    out.push({ type: 'boost', t: num(r.created_at), wallet: r.advertiser, symbol: r.symbol, status: r.status, usdc: units(r.price_raw, USDC), text: `BOOST ${r.package} order for $${r.symbol || '?'} · ${r.status.replace(/_/g, ' ')}` });
  if (want('payment')) for (const r of await all(d, 'SELECT p.signature, p.payer, p.amount_raw, p.verified_at, pr.symbol FROM payments p LEFT JOIN promotions pr ON pr.id = p.promotion_id WHERE p.verified_at < ? ORDER BY p.verified_at DESC LIMIT ?', before, lim))
    out.push({ type: 'payment', t: num(r.verified_at), wallet: r.payer, signature: r.signature, usdc: units(r.amount_raw, USDC), text: `BOOST payment verified for $${r.symbol || '?'}` });
  if (want('card')) for (const r of await all(d, 'SELECT m.card_id, m.serial, m.t, u.username FROM card_mints m LEFT JOIN users u ON u.id = m.user_id WHERE m.t < ? ORDER BY m.t DESC LIMIT ?', before, lim))
    out.push({ type: 'card', t: num(r.t), user: r.username, text: `Bought card ${r.card_id} #${r.serial}/30` });
  if (want('coins')) for (const r of await all(d, 'SELECT c.delta, c.reason, c.t, u.username FROM coin_ledger c LEFT JOIN users u ON u.id = c.user_id WHERE c.t < ? ORDER BY c.t DESC LIMIT ?', before, lim))
    out.push({ type: 'coins', t: num(r.t), user: r.username, delta: num(r.delta), text: `${num(r.delta) > 0 ? '+' : ''}${num(r.delta)} coins · ${r.reason}` });
  out.sort((a, b) => b.t - a.t);
  const page = out.slice(0, lim);
  return { type, events: page, next: page.length === lim ? page[page.length - 1].t : null };
}
