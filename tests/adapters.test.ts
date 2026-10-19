import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOhlcv, parseGtTrades, parsePumpCoins, parseGtPools, parseJupiterTokens, parseDexPairs, parseRugSummary, parseRpc, parseJupiterPrice } from '../src/providers/adapters';

const ohlcv = (list: unknown[]) => ({ data: { attributes: { ohlcv_list: list } } });
const MINT = 'Aov3BtQvrGXM5V9oiHu8PKJWeV8a2rFnr24fwWcNpump';

test('ohlcv: keeps valid rows sorted and de-duplicated, drops malformed rows and counts them', () => {
  const r = parseOhlcv(ohlcv([
    [1800000120, 2, 3, 1, 2.5, 10],
    [1800000000, 1, 2, 0.5, 1.5, 5],
    [1800000060, 1.5, 1.2, 1.4, 1.3, 5],      // high < low  -> dropped
    [1800000180, 0, 1, 1, 1, 1],               // zero price  -> dropped
    [1800000240, 1, 2, 0.5, 1.5, -3],          // negative volume -> dropped
    [1800000300, 1, 2, 3.2, 1.5, 3],           // low above open/close -> dropped
    ['x', 1, 2, 3, 4, 5],                      // not a number -> dropped
    [1800000000, 1, 2.2, 0.5, 1.6, 6],         // duplicate timestamp keeps the last
  ]));
  assert.deepEqual(r.candles.map((k) => k.t), [1800000000_000, 1800000120_000]);
  assert.equal(r.candles[0].c, 1.6);
  assert.equal(r.dropped, 5);
});

test('ohlcv: tiny memecoin prices survive as exact numbers', () => {
  const r = parseOhlcv(ohlcv([[1800000000, '0.0000123', '0.0000150', '0.0000100', '0.0000140', '1234.5']]));
  assert.equal(r.candles[0].o, 0.0000123);
  assert.equal(r.candles[0].h, 0.000015);
});

test('ohlcv: flags extreme wicks without altering them', () => {
  const r = parseOhlcv(ohlcv([[1800000000, 1, 100, 1, 1.1, 5], [1800000060, 1, 1.2, 0.9, 1.1, 5]]));
  assert.equal(r.suspicious, 1);
  assert.equal(r.candles[0].h, 100);
});

test('ohlcv: an empty list is valid (no trades), a missing list or all-bad rows is an error', () => {
  assert.deepEqual(parseOhlcv(ohlcv([])).candles, []);
  assert.throws(() => parseOhlcv({}), /ohlcv_list/);
  assert.throws(() => parseOhlcv(ohlcv([[1, 0, 0, 0, 0, 0]])), /invalid/);
});

test('gecko trades: maps kind, USD price and wallet; rejects rows without them', () => {
  const rows = parseGtTrades({ data: [
    { id: 't1', attributes: { kind: 'buy', volume_in_usd: '12.5', tx_from_address: 'W1', tx_hash: 'H1', block_timestamp: '2026-10-18T12:00:00Z', price_to_in_usd: '0.002', price_from_in_usd: '150' } },
    { id: 't2', attributes: { kind: 'sell', volume_in_usd: '7', tx_from_address: 'W2', tx_hash: 'H2', block_timestamp: '2026-10-18T12:00:05Z', price_to_in_usd: '150', price_from_in_usd: '0.0019' } },
    { id: 't3', attributes: { kind: 'swap', volume_in_usd: '7', tx_from_address: 'W2' } },
    { id: 't4', attributes: { kind: 'buy', volume_in_usd: '0', tx_from_address: 'W3', block_timestamp: '2026-10-18T12:00:05Z' } },
  ] });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].side, rows[0].priceUsd, rows[1].side, rows[1].priceUsd], ['BUY', 0.002, 'SELL', 0.0019]);
  assert.equal(rows[0].tsMs, Date.parse('2026-10-18T12:00:00Z'));
  assert.throws(() => parseGtTrades({ data: [{ id: 'x', attributes: { kind: 'buy' } }] }), /no row passed/);
  assert.throws(() => parseGtTrades([]), /data/);
});

test('pump.fun: accepts a list or {coins}, keeps only real mints, converts fields', () => {
  const raw = { mint: MINT, symbol: 'HNET', name: 'HidraNet', usd_market_cap: 82844.0, created_timestamp: 1791332584688, complete: true, is_currently_live: true, image_uri: 'https://ipfs.io/x', twitter: 'https://x.com/a', website: 'javascript:alert(1)', canonical_pool_liquidity_usd: 25285 };
  for (const j of [[raw, { mint: 'short' }, null], { coins: [raw] }]) {
    const c = parsePumpCoins(j);
    assert.equal(c.length, 1);
    assert.equal(c[0].marketCapUsd, 82844);
    assert.equal(c[0].isLive, true);
    assert.equal(c[0].website, undefined, 'non-http links are dropped');
    assert.equal(c[0].twitter, 'https://x.com/a');
  }
  assert.throws(() => parsePumpCoins({ message: 'Forbidden' }), /list of coins/);
  assert.throws(() => parsePumpCoins([{ mint: 'bad' }]), /valid mint/);
  assert.deepEqual(parsePumpCoins([]), []);
});

test('other shapes: pools, jupiter, dexscreener, rugcheck, rpc, price', () => {
  assert.equal(parseGtPools({ data: [{ id: 'solana_abc', attributes: {} }, { nope: 1 }], included: [{ id: 'x' }, 3] }).data.length, 1);
  assert.throws(() => parseGtPools({ data: [{ nope: 1 }] }), /usable/);
  assert.throws(() => parseGtPools({ error: 'x' }), /data/);
  assert.equal(parseJupiterTokens([{ id: 'a' }, { symbol: 'no id' }]).length, 1);
  assert.deepEqual(parseJupiterTokens([]), []);
  assert.throws(() => parseJupiterTokens({}), /list/);
  assert.equal(parseDexPairs([{ baseToken: { address: 'a' } }, {}]).length, 1);
  assert.throws(() => parseRugSummary({}), /risks/);
  assert.throws(() => parseRpc({ error: { message: 'rate limited' } }), /rate limited/);
  assert.deepEqual(parseJupiterPrice({ SOL: { usdPrice: 150.2 }, BAD: { usdPrice: 'x' } }), { SOL: { usdPrice: 150.2 } });
});
