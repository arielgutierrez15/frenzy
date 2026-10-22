/**
 * The Vault API (/v1/vault…): BAGZ Coin balance, daily paper-trading challenges, and limited trading cards.
 *
 *  - Coins are an in-app currency with no cash value. They are earned only by claiming challenges (and a one-time
 *    welcome bonus) and spent only on cards. Buying with real money is not implemented: /vault/buy rejects any
 *    payment method other than coins.
 *  - Challenge progress is read from the paper trades and theses the app already syncs to /me/activity. Those are
 *    reported by the app and range-checked, not independently verified, so a daily cap limits what any account can earn.
 *  - Scarcity is enforced by the database: (card_id, serial) is the primary key and serial is 1..30, so a 31st copy
 *    can't exist. A purchase is one D1 batch (a transaction): the copy is minted only if the buyer can afford it, and
 *    the coins are taken only if the copy was minted.
 */
import { ApiError, database } from './api.js';
import { currentUser } from './social.js';
import { CARDS, CARD_BY_ID, SUPPLY, priceOf } from './vault-cards.js';

const DAY = 86_400_000;
const WELCOME = 100;
const bad = (m) => new ApiError(400, m);
function db(ctx) { const d = database(ctx.env); if (!d) throw new ApiError(503, 'The Vault needs the BAGZ database, which isn’t connected'); return d; }
const all = async (d, sql, ...a) => (await d.prepare(sql).bind(...a).all()).results || [];
const one = (d, sql, ...a) => d.prepare(sql).bind(...a).first();
const changes = (r) => (r && r.meta ? r.meta.changes : 0) || 0;
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** daily challenges; progress comes from today's synced activity (UTC day) */
export const CHALLENGES = [
  { id: 'trades3', title: 'Make 3 paper trades', reward: 50, goal: 3, count: (a) => a.filter((x) => x.kind === 'trade').length },
  { id: 'thesis', title: 'Post a thesis on a coin', reward: 25, goal: 1, count: (a) => a.filter((x) => x.kind === 'thesis').length },
  { id: 'profit', title: 'Close a trade in profit', reward: 75, goal: 1, count: (a) => a.filter((x) => x.kind === 'trade' && x.side === 'SELL' && x.pnl > 0).length },
  { id: 'big20', title: 'Close a trade up 20% or more', reward: 150, goal: 1, count: (a) => a.filter((x) => x.kind === 'trade' && x.side === 'SELL' && x.pnl > 0 && x.usd - x.pnl > 0 && x.pnl / (x.usd - x.pnl) >= 0.2).length },
];
const dayOf = (t) => new Date(Math.floor(t / DAY) * DAY).toISOString().slice(0, 10);

async function balance(d, uid) { return Number((await one(d, 'SELECT COALESCE(SUM(delta), 0) AS b FROM coin_ledger WHERE user_id = ?', uid)).b) || 0; }
async function todaysActivity(d, uid, now) {
  const start = Math.floor(now / DAY) * DAY;
  const rows = await all(d, 'SELECT kind, data FROM activity WHERE user_id = ? AND t >= ? AND t < ?', uid, start, start + DAY);
  return rows.map((r) => ({ kind: r.kind, ...JSON.parse(r.data) }));
}

async function state(ctx, u) {
  const d = db(ctx);
  const now = ctx.now();
  const day = dayOf(now);
  const [bal, act, claimed, welcome, minted, mine] = await Promise.all([
    balance(d, u.id),
    todaysActivity(d, u.id, now),
    all(d, "SELECT ref FROM coin_ledger WHERE user_id = ? AND reason = 'challenge' AND ref LIKE ?", u.id, `%:${day}`),
    one(d, "SELECT 1 AS x FROM coin_ledger WHERE user_id = ? AND reason = 'welcome'", u.id),
    all(d, 'SELECT card_id, COUNT(*) AS n FROM card_mints GROUP BY card_id'),
    all(d, 'SELECT card_id, serial, t FROM card_mints WHERE user_id = ? ORDER BY t DESC', u.id),
  ]);
  const done = new Set(claimed.map((r) => r.ref.split(':')[0]));
  return {
    balance: bal,
    welcome: welcome ? null : WELCOME,
    day, resetsAt: (Math.floor(now / DAY) + 1) * DAY,
    challenges: CHALLENGES.map((c) => ({ id: c.id, title: c.title, reward: c.reward, goal: c.goal, progress: Math.min(c.goal, c.count(act)), claimed: done.has(c.id) })),
    supply: SUPPLY,
    minted: Object.fromEntries(minted.map((r) => [r.card_id, Number(r.n)])),
    mine: mine.map((r) => ({ card: r.card_id, serial: r.serial, t: r.t })),
    realMoney: false,
  };
}

async function claim(ctx, u, b) {
  const d = db(ctx);
  const now = ctx.now();
  if (b.id === 'welcome') {
    const r = await d.prepare("INSERT OR IGNORE INTO coin_ledger (user_id, delta, reason, ref, t) VALUES (?, ?, 'welcome', 'welcome', ?)").bind(u.id, WELCOME, now).run();
    if (!changes(r)) throw bad('Welcome bonus already claimed');
    return state(ctx, u);
  }
  const c = CHALLENGES.find((x) => x.id === b.id);
  if (!c) throw bad('Unknown challenge');
  if (c.count(await todaysActivity(d, u.id, now)) < c.goal) throw bad('Challenge not finished yet');
  const r = await d.prepare("INSERT OR IGNORE INTO coin_ledger (user_id, delta, reason, ref, t) VALUES (?, ?, 'challenge', ?, ?)").bind(u.id, c.reward, `${c.id}:${dayOf(now)}`, now).run();
  if (!changes(r)) throw bad('Already claimed today');
  return state(ctx, u);
}

async function buy(ctx, u, b) {
  const card = CARD_BY_ID[b.card];
  if (!card) throw bad('Unknown card');
  if ((b.pay ?? 'coins') !== 'coins') throw new ApiError(403, 'Buying with real money isn’t available yet');
  const d = db(ctx);
  const price = priceOf(card);
  const now = ctx.now();
  if (await one(d, 'SELECT 1 AS x FROM card_mints WHERE card_id = ? AND user_id = ?', card.id, u.id)) throw bad('You already own this card');
  for (let attempt = 0; attempt < 3; attempt++) {
    const pid = newId();
    let res;
    try {
      res = await d.batch([
        // mint the next serial only if it exists (≤ 30) and the buyer can afford it
        d.prepare(`INSERT INTO card_mints (card_id, serial, user_id, purchase, t)
          SELECT ?, n, ?, ?, ? FROM (SELECT COALESCE(MAX(serial), 0) + 1 AS n FROM card_mints WHERE card_id = ?)
          WHERE n <= ? AND (SELECT COALESCE(SUM(delta), 0) FROM coin_ledger WHERE user_id = ?) >= ?`).bind(card.id, u.id, pid, now, card.id, SUPPLY, u.id, price),
        // take the coins only if that copy was minted
        d.prepare(`INSERT INTO coin_ledger (user_id, delta, reason, ref, t)
          SELECT ?, ?, 'card', ?, ? WHERE EXISTS (SELECT 1 FROM card_mints WHERE purchase = ?)`).bind(u.id, -price, pid, now, pid),
      ]);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message))) {
        if (await one(d, 'SELECT 1 AS x FROM card_mints WHERE card_id = ? AND user_id = ?', card.id, u.id)) throw bad('You already own this card');
        continue; // someone took that serial at the same moment; try the next one
      }
      throw e;
    }
    if (changes(res[0])) {
      const row = await one(d, 'SELECT serial FROM card_mints WHERE purchase = ?', pid);
      return { bought: { card: card.id, serial: row.serial, t: now }, ...(await state(ctx, u)) };
    }
    const n = Number((await one(d, 'SELECT COUNT(*) AS n FROM card_mints WHERE card_id = ?', card.id)).n);
    if (n >= SUPPLY) throw new ApiError(409, 'Sold out: all 30 copies are claimed');
    throw new ApiError(402, `Not enough BAGZ Coins (costs ${price})`);
  }
  throw new ApiError(409, 'Busy, try again');
}

export async function vault(ctx, request, path, body) {
  const m = request.method;
  if (m === 'GET' && path === '/vault') return state(ctx, await currentUser(ctx, request));
  if (m === 'POST' && path === '/vault/claim') return claim(ctx, await currentUser(ctx, request), body || {});
  if (m === 'POST' && path === '/vault/buy') return buy(ctx, await currentUser(ctx, request), body || {});
  return undefined;
}
export { CARDS };
