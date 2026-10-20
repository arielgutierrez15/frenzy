/**
 * Accounts, profiles, leaderboard, friends, friends feed and group chats through the real Worker entry point,
 * with the real migrations applied to a SQLite-backed D1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS
import { handle } from '../worker/index.js';
import { D1 } from './fakechain';

const ORIGIN = 'https://arielgutierrez15.github.io';
// smallest valid PNG / JPEG headers followed by filler; the server checks the first bytes
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]).toString('base64');
const JPG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 2)]).toString('base64');

function setup(extra: Record<string, string> = {}) {
  const db = new D1();
  let t = 1_800_000_000_000;
  const env: any = { ALLOWED_ORIGINS: ORIGIN, Db: db, PASSWORD_ITERATIONS: '10000', RATE_PER_MIN: '100000', RATE_POST_PER_MIN: '100000', ...extra };
  let n = 0;
  const call = async (path: string, o: { body?: unknown; token?: string; ip?: string; method?: string; origin?: string | null } = {}) => {
    const h: Record<string, string> = { 'cf-connecting-ip': o.ip || `10.3.0.${n++ % 250}`, 'content-type': 'application/json' };
    if (o.origin !== null) h.origin = o.origin || ORIGIN;
    if (o.token) h.authorization = `Bearer ${o.token}`;
    const res = await handle(new Request(`https://api.test${path}`, { method: o.method || (o.body === undefined ? 'GET' : 'POST'), headers: h, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), env, undefined, { fetch: async () => new Response('{}'), now: () => t, cache: null });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : null, res };
  };
  const user = async (username: string, password = 'hunter22pass', withAvatar = true) => {
    const r = await call('/v1/auth/signup', { body: { username, password } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (withAvatar) assert.equal((await call('/v1/me/avatar', { body: { image: PNG }, token: r.body.token })).status, 200);
    return { token: r.body.token as string, id: r.body.user.id as string, username };
  };
  return { db, env, call, user, advance: (ms: number) => { t += ms; } };
}
const stats = (equity: number, o: Partial<Record<string, any>> = {}) => ({ equity, deposits: 10_000, realized: 0, winRate: 50, sells: 2, trades: 4, best: { symbol: 'WIF', pct: 40 }, ...o });

test('signup: validation, unique usernames (any case), reserved names, password rules', async () => {
  const s = setup();
  const cases: [any, number, RegExp][] = [
    [{ username: 'ab', password: 'longenough1' }, 400, /3–20/],
    [{ username: 'has space', password: 'longenough1' }, 400, /3–20/],
    [{ username: 'admin', password: 'longenough1' }, 400, /reserved/],
    [{ username: 'okname', password: 'short' }, 400, /at least 8/],
    [{ username: 'okname', password: 'OKNAME' + '' }, 400, /at least 8|username/],
    [{ username: 'sameasme', password: 'SameAsMe' }, 400, /username/],
  ];
  for (const [b, st, re] of cases) { const r = await s.call('/v1/auth/signup', { body: b }); assert.equal(r.status, st, JSON.stringify(b)); assert.match(r.body.error, re); }
  const a = await s.call('/v1/auth/signup', { body: { username: 'Ana_1', password: 'correct horse' } });
  assert.equal(a.status, 200);
  assert.equal(a.body.user.complete, false, 'no picture yet');
  assert.match(a.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await s.call('/v1/auth/signup', { body: { username: 'ana_1', password: 'another pass' } })).status, 409);
  // the password and its hash never come back
  const meR = await s.call('/v1/me', { token: a.body.token });
  assert.ok(!JSON.stringify(meR.body).includes('correct horse') && !JSON.stringify(meR.body).includes('pass_hash'));
  // only a hash of the session token is stored
  const row: any = s.db.db.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(row.token_hash, a.body.token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  const u: any = s.db.db.prepare('SELECT pass_hash, pass_iter FROM users').get();
  assert.ok(!u.pass_hash.includes('correct'));
  assert.equal(u.pass_iter, 10000);
});

test('login: right/wrong password, throttling after repeated failures, logout ends the session', async () => {
  const s = setup();
  await s.user('bob', 'bob-password-1');
  const ok = await s.call('/v1/auth/login', { body: { username: 'BOB', password: 'bob-password-1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.username, 'bob');
  assert.equal((await s.call('/v1/auth/login', { body: { username: 'bob', password: 'nope-nope' } })).status, 401);
  assert.equal((await s.call('/v1/auth/login', { body: { username: 'nobody', password: 'whatever1' } })).body.error, 'Wrong username or password');
  for (let i = 0; i < 8; i++) await s.call('/v1/auth/login', { body: { username: 'bob', password: 'guess' + i + 'xxxx' } });
  const locked = await s.call('/v1/auth/login', { body: { username: 'bob', password: 'bob-password-1' } });
  assert.equal(locked.status, 429, 'even the right password waits while the account is throttled');
  s.advance(16 * 60_000);
  assert.equal((await s.call('/v1/auth/login', { body: { username: 'bob', password: 'bob-password-1' } })).status, 200);
  assert.equal((await s.call('/v1/me', { token: ok.body.token })).status, 200);
  assert.equal((await s.call('/v1/auth/logout', { body: {}, token: ok.body.token })).status, 200);
  assert.equal((await s.call('/v1/me', { token: ok.body.token })).status, 401);
  // sessions expire
  const t2 = (await s.call('/v1/auth/login', { body: { username: 'bob', password: 'bob-password-1' } })).body.token;
  s.advance(31 * 86_400_000);
  assert.equal((await s.call('/v1/me', { token: t2 })).status, 401);
});

test('signup throttling per network', async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) assert.equal((await s.call('/v1/auth/signup', { body: { username: `user${i}x`, password: 'password123' }, ip: '9.9.9.9' })).status, 200);
  assert.equal((await s.call('/v1/auth/signup', { body: { username: 'user6x', password: 'password123' }, ip: '9.9.9.9' })).status, 429);
});

test('profile picture: PNG/JPEG checked by content, size cap, served publicly with safe headers and no Origin needed', async () => {
  const s = setup();
  const a = await s.user('carla', 'password123', false);
  const bad = 'data:image/png;base64,' + Buffer.from('<svg onload=alert(1)>').toString('base64');
  assert.equal((await s.call('/v1/me/avatar', { body: { image: bad }, token: a.token })).status, 400, 'an SVG renamed to PNG is refused');
  assert.equal((await s.call('/v1/me/avatar', { body: { image: 'data:image/svg+xml;base64,AAAA' }, token: a.token })).status, 400);
  const big = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(160_000)]).toString('base64');
  assert.equal((await s.call('/v1/me/avatar', { body: { image: big }, token: a.token })).status, 413);
  assert.equal((await s.call('/v1/me/avatar', { body: { image: PNG } })).status, 401, 'needs sign-in');
  const ok = await s.call('/v1/me/avatar', { body: { image: JPG }, token: a.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.complete, true);
  const img = await s.call(`/v1/avatars/${a.id}`, { origin: null });
  assert.equal(img.status, 200);
  assert.equal(img.res.headers.get('content-type'), 'image/jpeg');
  assert.equal(img.res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(img.res.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await s.call('/v1/avatars/1111111111111111111x', { origin: null })).status, 404);
});

test('public profile: stats (PnL derived on the server), recent paper trades, rank; incomplete profiles hidden', async () => {
  const s = setup();
  const a = await s.user('dana');
  const b = await s.user('eli');
  await s.user('nopic', 'password123', false);
  assert.equal((await s.call('/v1/me/stats', { body: stats(12_500), token: a.token })).status, 200);
  assert.equal((await s.call('/v1/me/stats', { body: stats(11_000), token: b.token })).status, 200);
  // a client claiming a fake pnl is ignored: pnl is equity − deposits
  await s.call('/v1/me/stats', { body: { ...stats(12_500), pnl: 999999, pnlPct: 9999 }, token: a.token });
  const t0 = 1_800_000_000_000;
  const act = await s.call('/v1/me/activity', { body: { items: [
    { id: 'x1', kind: 'trade', side: 'BUY', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', usd: 100, price: 0.2, t: t0 },
    { id: 'x2', kind: 'trade', side: 'SELL', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', usd: 140, price: 0.28, pnl: 40, t: t0 + 1 },
    { id: 't1', kind: 'thesis', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', bull: true, text: 'dogs are back', t: t0 + 2 },
  ] }, token: a.token });
  assert.equal(act.body.added, 3);
  assert.equal((await s.call('/v1/me/activity', { body: { items: [{ id: 'x1', kind: 'trade', side: 'BUY', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', usd: 100, price: 0.2, t: t0 }] }, token: a.token })).body.added, 0, 'retries never duplicate');
  const p = await s.call('/v1/users/DANA');
  assert.equal(p.status, 200);
  assert.equal(p.body.stats.pnl, 2500);
  assert.equal(p.body.stats.pnlPct, 25);
  assert.equal(p.body.rank, 1);
  assert.equal(p.body.activity.length, 3);
  assert.equal(p.body.activity[0].kind, 'thesis');
  assert.equal(p.body.relation, 'none');
  assert.equal((await s.call('/v1/users/dana', { token: a.token })).body.relation, 'self');
  assert.equal((await s.call('/v1/users/nopic')).status, 404, 'no picture = profile not public yet');
  // bad stats and activity are refused
  for (const bad of [stats(-1), stats(1e11), { ...stats(1), deposits: 5 }, { ...stats(1), winRate: 140 }, { ...stats(1), trades: 1, sells: 5 }]) assert.equal((await s.call('/v1/me/stats', { body: bad, token: a.token })).status, 400);
  assert.equal((await s.call('/v1/me/activity', { body: { items: [{ id: 'z', kind: 'trade', side: 'HODL', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'W', usd: 1, price: 1, t: t0 }] }, token: a.token })).status, 400);
});

test('leaderboard: ranks complete profiles with trades, sort options, my rank, friends scope', async () => {
  const s = setup();
  const a = await s.user('fay'), b = await s.user('gus'), c = await s.user('hal'), d = await s.user('ivy');
  await s.call('/v1/me/stats', { body: stats(15_000, { winRate: 40 }), token: a.token });
  await s.call('/v1/me/stats', { body: stats(20_000, { winRate: 30 }), token: b.token });
  await s.call('/v1/me/stats', { body: stats(9_000, { winRate: 90 }), token: c.token });
  await s.call('/v1/me/stats', { body: stats(10_000, { trades: 0, sells: 0 }), token: d.token }); // no trades: not ranked
  let r = await s.call('/v1/leaderboard', { token: a.token });
  assert.deepEqual(r.body.rows.map((x: any) => x.user.username), ['gus', 'fay', 'hal']);
  assert.equal(r.body.total, 3);
  assert.equal(r.body.mine.rank, 2);
  r = await s.call('/v1/leaderboard?sort=win_rate');
  assert.deepEqual(r.body.rows.map((x: any) => x.user.username), ['hal', 'fay', 'gus']);
  assert.equal((await s.call('/v1/leaderboard?scope=friends')).status, 401);
  await s.call('/v1/friends/request', { body: { username: 'hal' }, token: a.token });
  await s.call('/v1/friends/respond', { body: { userId: a.id, accept: true }, token: c.token });
  r = await s.call('/v1/leaderboard?scope=friends', { token: a.token });
  assert.deepEqual(r.body.rows.map((x: any) => x.user.username), ['fay', 'hal']);
});

test('friends: request, incoming/outgoing, accept, decline, mutual request auto-accepts, remove', async () => {
  const s = setup();
  const a = await s.user('jay'), b = await s.user('kim'), c = await s.user('lou');
  assert.equal((await s.call('/v1/friends/request', { body: { username: 'jay' }, token: a.token })).status, 400, 'not yourself');
  assert.equal((await s.call('/v1/friends/request', { body: { username: 'ghost' }, token: a.token })).status, 404);
  assert.equal((await s.call('/v1/friends/request', { body: { username: 'KIM' }, token: a.token })).body.status, 'requested');
  assert.equal((await s.call('/v1/friends/request', { body: { username: 'kim' }, token: a.token })).body.status, 'requested', 'idempotent');
  let fa = (await s.call('/v1/friends', { token: a.token })).body, fb = (await s.call('/v1/friends', { token: b.token })).body;
  assert.deepEqual([fa.outgoing.map((x: any) => x.username), fb.incoming.map((x: any) => x.username)], [['kim'], ['jay']]);
  assert.equal((await s.call('/v1/users/kim', { token: a.token })).body.relation, 'requested');
  assert.equal((await s.call('/v1/users/jay', { token: b.token })).body.relation, 'incoming');
  assert.equal((await s.call('/v1/friends/respond', { body: { userId: b.id, accept: true }, token: a.token })).status, 404, 'the requester can’t accept their own request');
  assert.equal((await s.call('/v1/friends/respond', { body: { userId: a.id, accept: true }, token: b.token })).body.status, 'friends');
  fa = (await s.call('/v1/friends', { token: a.token })).body;
  assert.deepEqual(fa.friends.map((x: any) => x.username), ['kim']);
  // decline
  await s.call('/v1/friends/request', { body: { username: 'lou' }, token: a.token });
  assert.equal((await s.call('/v1/friends/respond', { body: { userId: a.id, accept: false }, token: c.token })).body.status, 'none');
  assert.equal((await s.call('/v1/friends', { token: a.token })).body.outgoing.length, 0);
  // both ask each other: becomes friends
  await s.call('/v1/friends/request', { body: { username: 'lou' }, token: b.token });
  assert.equal((await s.call('/v1/friends/request', { body: { username: 'kim' }, token: c.token })).body.status, 'friends');
  // remove
  await s.call('/v1/friends/remove', { body: { userId: b.id }, token: a.token });
  assert.equal((await s.call('/v1/friends', { token: a.token })).body.friends.length, 0);
  // search finds complete profiles by prefix
  assert.deepEqual((await s.call('/v1/users/search?q=ki', { token: a.token })).body.users.map((x: any) => x.username), ['kim']);
});

test('friends feed: only accepted friends’ trades and theses, newest first', async () => {
  const s = setup();
  const a = await s.user('max'), b = await s.user('neo'), c = await s.user('ozzy');
  const t0 = 1_800_000_000_000;
  const trade = (id: string, t: number) => ({ id, kind: 'trade', side: 'BUY', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', usd: 50, price: 0.2, t });
  await s.call('/v1/me/activity', { body: { items: [trade('b1', t0), trade('b2', t0 + 5)] }, token: b.token });
  await s.call('/v1/me/activity', { body: { items: [trade('c1', t0 + 9)] }, token: c.token });
  assert.deepEqual((await s.call('/v1/feed/friends', { token: a.token })).body, { items: [], friends: 0 });
  await s.call('/v1/friends/request', { body: { username: 'neo' }, token: a.token });
  assert.equal((await s.call('/v1/feed/friends', { token: a.token })).body.items.length, 0, 'pending is not a friend');
  await s.call('/v1/friends/respond', { body: { userId: a.id, accept: true }, token: b.token });
  const f = (await s.call('/v1/feed/friends', { token: a.token })).body;
  assert.deepEqual(f.items.map((x: any) => [x.user.username, x.t]), [['neo', t0 + 5], ['neo', t0]]);
  assert.equal((await s.call('/v1/feed/friends')).status, 401);
});

test('group chats: friends only, messages, unread counts, add members, leave, outsiders locked out', async () => {
  const s = setup();
  const a = await s.user('pam'), b = await s.user('quin'), c = await s.user('rex'), x = await s.user('stranger');
  const befriend = async (p: any, q: any) => { await s.call('/v1/friends/request', { body: { username: q.username }, token: p.token }); await s.call('/v1/friends/respond', { body: { userId: p.id, accept: true }, token: q.token }); };
  await befriend(a, b); await befriend(a, c);
  assert.equal((await s.call('/v1/chats', { body: { name: 'Degens', memberIds: [x.id] }, token: a.token })).status, 403, 'can’t add a non-friend');
  assert.equal((await s.call('/v1/chats', { body: { name: '', memberIds: [b.id] }, token: a.token })).status, 400);
  const g = await s.call('/v1/chats', { body: { name: 'Degens 🦍', memberIds: [b.id] }, token: a.token });
  assert.equal(g.status, 200);
  const id = g.body.id;
  assert.equal((await s.call(`/v1/chats/${id}/messages`, { body: { body: 'gm' }, token: a.token })).status, 200);
  assert.equal((await s.call(`/v1/chats/${id}/messages`, { body: { body: '   ' }, token: a.token })).status, 400);
  let lb = (await s.call('/v1/chats', { token: b.token })).body;
  assert.equal(lb.chats[0].name, 'Degens 🦍');
  assert.equal(lb.chats[0].unread, 2, 'the "created" line and "gm"');
  assert.equal(lb.chats[0].last.body, 'gm');
  const read = await s.call(`/v1/chats/${id}/messages`, { token: b.token });
  assert.deepEqual(read.body.messages.map((m: any) => [m.system, m.body]), [[true, 'pam created “Degens 🦍”'], [false, 'gm']]);
  assert.equal((await s.call('/v1/chats', { token: b.token })).body.chats[0].unread, 0, 'reading marks it read');
  const after = read.body.messages[1].id;
  await s.call(`/v1/chats/${id}/messages`, { body: { body: 'wagmi' }, token: b.token });
  const inc = await s.call(`/v1/chats/${id}/messages?after=${after}`, { token: a.token });
  assert.deepEqual(inc.body.messages.map((m: any) => [m.user.username, m.body]), [['quin', 'wagmi']]);
  // outsiders can't read, post, add or leave
  for (const [p, o] of [[`/v1/chats/${id}/messages`, {}], [`/v1/chats/${id}/messages`, { body: { body: 'hi' } }], [`/v1/chats/${id}/members`, { body: { userIds: [x.id] } }]] as const)
    assert.equal((await s.call(p, { ...o, token: x.token })).status, 404);
  // b can't add c (not b's friend); a can
  assert.equal((await s.call(`/v1/chats/${id}/members`, { body: { userIds: [c.id] }, token: b.token })).status, 403);
  assert.equal((await s.call(`/v1/chats/${id}/members`, { body: { userIds: [c.id] }, token: a.token })).body.added, 1);
  assert.equal((await s.call(`/v1/chats/${id}/messages`, { token: c.token })).body.chat.members.length, 3);
  // leave; last one out deletes the chat
  await s.call(`/v1/chats/${id}/leave`, { body: {}, token: a.token });
  assert.equal((await s.call(`/v1/chats/${id}/messages`, { token: a.token })).status, 404);
  await s.call(`/v1/chats/${id}/leave`, { body: {}, token: b.token });
  await s.call(`/v1/chats/${id}/leave`, { body: {}, token: c.token });
  assert.equal((s.db.db.prepare('SELECT COUNT(*) AS n FROM chats').get() as any).n, 0);
  // message flood limit
  const g2 = (await s.call('/v1/chats', { body: { name: 'spam', memberIds: [b.id] }, token: a.token })).body.id;
  let last = 0;
  for (let i = 0; i < 31; i++) last = (await s.call(`/v1/chats/${g2}/messages`, { body: { body: 'x' + i }, token: a.token })).status;
  assert.equal(last, 429);
});

test('delete account: password required; removes profile, friendships, sessions; chats keep "deleted user"', async () => {
  const s = setup();
  const a = await s.user('tia'), b = await s.user('uma');
  await s.call('/v1/friends/request', { body: { username: 'uma' }, token: a.token });
  await s.call('/v1/friends/respond', { body: { userId: a.id, accept: true }, token: b.token });
  const g = (await s.call('/v1/chats', { body: { name: 'pair', memberIds: [b.id] }, token: a.token })).body.id;
  await s.call(`/v1/chats/${g}/messages`, { body: { body: 'bye' }, token: a.token });
  assert.equal((await s.call('/v1/me/delete', { body: { password: 'wrong-one' }, token: a.token })).status, 401);
  assert.equal((await s.call('/v1/me/delete', { body: { password: 'hunter22pass' }, token: a.token })).status, 200);
  assert.equal((await s.call('/v1/me', { token: a.token })).status, 401);
  assert.equal((await s.call('/v1/users/tia')).status, 404);
  assert.equal((await s.call('/v1/friends', { token: b.token })).body.friends.length, 0);
  const m = (await s.call(`/v1/chats/${g}/messages`, { token: b.token })).body.messages;
  assert.equal(m.find((x: any) => x.body === 'bye').user.username, 'deleted user');
  assert.equal((await s.call('/v1/auth/signup', { body: { username: 'tia', password: 'new-password-1' } })).status, 200, 'the name is free again');
});

test('without the database the API says accounts are unavailable', async () => {
  const s = setup();
  delete s.env.Db;
  assert.equal((await s.call('/v1/config')).body.accounts, false);
  const r = await s.call('/v1/auth/signup', { body: { username: 'vic', password: 'password123' } });
  assert.equal(r.status, 503);
});
