import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, freshState, refreshOne, refreshPrices, loadTrades, userTrade, detail, categoriesOf, keyOf } from '../src/engine';
import { loadCandleSet, __clearCandles } from '../src/chart/data';
import { getHealth } from '../src/providers/http';
import { harness, jsonRes } from './helpers';

const MINT = 'Aov3BtQvrGXM5V9oiHu8PKJWeV8a2rFnr24fwWcNpump';
const POOL = 'PoolPoolPoolPoolPoolPoolPoolPoolPool11';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

const jupToken = { id: MINT, name: 'HidraNet', symbol: 'HNET', icon: 'https://img/h.png', usdPrice: 0.0000828, mcap: 82844, liquidity: 25285, holderCount: 410, launchpad: 'pump.fun', organicScore: 55, organicScoreLabel: 'medium',
  stats1h: { priceChange: 12 }, stats24h: { priceChange: 40, buyVolume: 9000, sellVolume: 8000, numBuys: 300, numSells: 280 }, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true }, firstPool: { createdAt: '2026-10-18T10:00:00Z' } };
const pump = { mint: MINT, symbol: 'HNET', name: 'HidraNet', usd_market_cap: 82844, created_timestamp: Date.parse('2026-10-18T10:00:00Z'), complete: false, is_currently_live: true, image_uri: 'https://img/h.png' };
const dsPair = { chainId: 'solana', dexId: 'pumpswap', pairAddress: POOL, baseToken: { address: MINT, symbol: 'HNET', name: 'HidraNet' }, priceUsd: '0.0000830', liquidity: { usd: 25000 }, marketCap: 83000, volume: { h24: 17000, h1: 2000 }, txns: { h24: { buys: 300, sells: 280 } }, priceChange: { m5: 1, h1: 12, h6: 20, h24: 40 }, info: { imageUrl: 'https://img/h.png' } };

function route(over: Record<string, () => Response> = {}) {
  return (u: string, init: RequestInit) => {
    for (const [k, f] of Object.entries(over)) if (u.includes(k)) return f();
    if (u.includes('/tokens/v2/')) return jsonRes([jupToken]);
    if (u.includes('/price/v3')) return jsonRes({ So11111111111111111111111111111111111111112: { usdPrice: 151.25 } });
    if (u.includes('coins/currently-live')) return jsonRes([pump]);
    if (u.includes('pump.fun/coins')) return jsonRes([pump]);
    if (u.includes('/token-profiles/')) return jsonRes([{ chainId: 'solana', tokenAddress: MINT, icon: 'https://img/h.png' }]);
    if (u.includes('/token-boosts/')) return jsonRes([]);
    if (u.includes('/tokens/v1/solana/')) return jsonRes([dsPair]);
    if (u.includes('new_pools') || u.includes('trending_pools')) return jsonRes({ data: [], included: [] });
    if (u.includes('/trades')) return jsonRes({ data: [
      { id: 'a', attributes: { kind: 'buy', volume_in_usd: '50', tx_from_address: WALLET, tx_hash: 'H1', block_timestamp: new Date().toISOString(), price_to_in_usd: '0.000083' } },
    ] });
    if (u.includes('/ohlcv/')) return jsonRes({ data: { attributes: { ohlcv_list: [[Math.floor(Date.now() / 1000) - 120, 0.00008, 0.000085, 0.000079, 0.000083, 900], [Math.floor(Date.now() / 1000) - 60, 0.000083, 0.000084, 0.000081, 0.000082, 400]] } } });
    return jsonRes({}, 404);
  };
}

test('discovery merges Jupiter + pump.fun + DexScreener into one coin and records real fetch times', async () => {
  const h = harness(route(), { autoAdvance: true });
  const st = freshState();
  await discover(st);
  await refreshPrices(st);
  const c = st.coins[keyOf('solana', MINT)];
  assert.ok(c, 'coin exists');
  assert.equal(c.symbol, 'HNET');
  assert.ok(c.sources.includes('jup-recent') && c.sources.includes('pumpfun') && c.sources.includes('pump-live') && c.sources.includes('ds-profiles'));
  assert.equal(c.pairAddress, POOL);
  assert.equal(c.price, 0.000083, 'price comes from DexScreener once it prices the pair');
  assert.equal(c.updatedAt, st.sources['ds-pairs'].at, 'price time is the provider fetch time');
  assert.equal(c.pumpLive, true);
  assert.ok(categoriesOf(st, c).includes('live'));
  assert.equal(st.solPrice, 151.25);
  assert.ok(h.calls.every((x) => x.url.startsWith('https://')));
  assert.ok(h.calls.some((x) => x.url.startsWith('https://api.jup.ag/')), 'uses the supported Jupiter host first');
  assert.ok(!h.calls.some((x) => x.url.includes('lite-api')), 'does not need the deprecated host when api.jup.ag works');
  assert.ok(getHealth().every((x) => x.status === 'ok'));
});

test('a failing pump.fun feed is reported, does not break the rest, and invents nothing', async () => {
  harness(route({ 'pump.fun/coins': () => jsonRes({ error: 'forbidden' }, 403) }), { autoAdvance: true });
  const st = freshState();
  await discover(st);
  assert.equal(st.sources.pumpfun.ok, false);
  assert.match(st.sources.pumpfun.error!, /403/);
  assert.equal(st.sources['pump-live'].ok, false);
  const c = st.coins[keyOf('solana', MINT)];
  assert.ok(c, 'the coin still arrives through Jupiter');
  assert.ok(!c.sources.includes('pumpfun') && !c.sources.includes('pump-live'));
  assert.notEqual(c.pumpLive, true, 'no fabricated live-stream flag');
  assert.equal(st.sources['jup-recent'].ok, true);
});

test('GeckoTerminal trades: validated rows feed the tape; a bad response leaves existing trades alone', async () => {
  harness(route(), { autoAdvance: true });
  const st = freshState();
  await discover(st); await refreshPrices(st);
  const c = st.coins[keyOf('solana', MINT)];
  await loadTrades(st, c, 0);
  assert.equal(detail[c.id].trades!.length, 1);
  assert.equal(st.tape.length, 1);
  assert.equal(st.tape[0].wallet, WALLET);
  // now the provider returns garbage
  detail[c.id].tradesAt = 0;
  harness(route({ '/trades': () => jsonRes({ nope: 1 }) }), { autoAdvance: true });
  await loadTrades(st, c, 0);
  assert.equal(detail[c.id].trades!.length, 1, 'previous real trades are kept');
  assert.equal(st.sources['gt-trades'].ok, false);
  assert.equal(st.sources['gt-trades'].kind, 'invalid');
});

test('candles: requested per pool/range/interval, validated, and never shared across coins or intervals', async () => {
  const h = harness(route(), { autoAdvance: true });
  __clearCandles();
  const st = freshState();
  await discover(st); await refreshPrices(st);
  const c = st.coins[keyOf('solana', MINT)];
  const r1 = await loadCandleSet(st, c, '1H', '1m');
  assert.ok(r1.ok);
  const u1 = h.calls.find((x) => x.url.includes('/ohlcv/'))!.url;
  assert.match(u1, /\/networks\/solana\/pools\/PoolPool.*\/ohlcv\/minute\?aggregate=1&limit=62&currency=usd&token=base/);
  const r2 = await loadCandleSet(st, c, '30D', '4h');
  assert.ok(r2.ok);
  const u2 = h.calls.filter((x) => x.url.includes('/ohlcv/')).pop()!.url;
  assert.match(u2, /ohlcv\/hour\?aggregate=4&limit=182/);
  assert.equal(r1.ok && r1.set.interval, '1m');
  assert.equal(r2.ok && r2.set.interval, '4h');
  assert.equal(r2.ok && r2.set.partial, true, 'a 2-candle history is flagged as partial for 30D');
});

test('trading uses a price that is fresh: a cached answer cannot pass for a new one', async () => {
  const h = harness(route(), { autoAdvance: true });
  const st = freshState();
  await discover(st); await refreshPrices(st);
  const c = st.coins[keyOf('solana', MINT)];
  const before = h.calls.length;
  h.advance(5_000);
  await refreshOne(st, c.id); // forced, bypasses the 8s cache
  assert.ok(h.calls.length > before, 'a new network call was made');
  assert.equal(c.updatedAt, h.now(), 'price timestamp = the new fetch');
  const t = userTrade(st, c.id, 'BUY', 100);
  assert.equal(t.ok, true);
  // 2 minutes pass without any refresh: the ticket must refuse to fill on the old price
  h.advance(120_000);
  const late = userTrade(st, c.id, 'BUY', 100);
  assert.equal(late.ok, false);
});
