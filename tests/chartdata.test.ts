import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RANGES, INTERVALS, candlesNeeded, validInterval, applyLiveTick, priceGap, MAX_CANDLES, rangeOf, TICK_MAX_AGE_MS } from '../src/chart/data';
import type { Candle } from '../src/types';

const MIN = 60_000;
const k = (t: number, o: number, h: number, l: number, c: number, v = 10): Candle => ({ t, o, h, l, c, v });

test('every range/interval pair fits in one provider request and yields a readable number of candles', () => {
  for (const r of RANGES) {
    assert.ok(r.intervals.includes(r.def), `${r.id} default is one of its intervals`);
    for (const i of r.intervals) {
      const n = candlesNeeded(r, INTERVALS[i]);
      assert.ok(n <= MAX_CANDLES, `${r.id}/${i} needs ${n}`);
      assert.ok(n >= 12, `${r.id}/${i} would show only ${n} candles`);
    }
  }
});

test('the five ranges are 1H, 4H, 24H, 7D and 30D with independent interval choices', () => {
  assert.deepEqual(RANGES.map((r) => r.id), ['1H', '4H', '24H', '7D', '30D']);
  assert.deepEqual(rangeOf('1H').intervals, ['1m', '5m']);
  assert.deepEqual(rangeOf('30D').intervals, ['1h', '4h', '1d']);
  assert.equal(validInterval(rangeOf('1H'), '1d'), '1m', 'an interval the range does not offer falls back to its default');
  assert.equal(validInterval(rangeOf('7D'), '4h'), '4h');
});

test('live tick moves the open candle: close follows the price, wicks widen', () => {
  const t0 = 1_800_000_000_000 - (1_800_000_000_000 % (5 * MIN));
  const cs = [k(t0 - 5 * MIN, 1, 1.1, 0.9, 1.0), k(t0, 1.0, 1.05, 0.98, 1.02)];
  const now = t0 + 2 * MIN;
  const r = applyLiveTick(cs, { price: 1.2, at: now - 1000 }, 5 * MIN, now);
  assert.equal(r.changed, true);
  assert.equal(r.candles.length, 2);
  assert.deepEqual([r.candles[1].o, r.candles[1].h, r.candles[1].l, r.candles[1].c], [1.0, 1.2, 0.98, 1.2]);
  assert.equal(cs[1].c, 1.02, 'input is not mutated');
  const down = applyLiveTick(r.candles, { price: 0.9, at: now }, 5 * MIN, now);
  assert.equal(down.candles[1].l, 0.9);
  assert.equal(down.candles[1].h, 1.2);
});

test('live tick opens the next candle from the previous close, with zero volume', () => {
  const t0 = 1_800_000_000_000 - (1_800_000_000_000 % (5 * MIN));
  const cs = [k(t0, 1, 1.1, 0.9, 1.05)];
  const now = t0 + 6 * MIN;
  const r = applyLiveTick(cs, { price: 1.2, at: now }, 5 * MIN, now);
  assert.equal(r.candles.length, 2);
  assert.deepEqual(r.candles[1], { t: t0 + 5 * MIN, o: 1.05, h: 1.2, l: 1.05, c: 1.2, v: 0 });
});

test('live tick ignores stale, invalid or out-of-order prices and never draws long runs of empty candles', () => {
  const t0 = 1_800_000_000_000 - (1_800_000_000_000 % MIN);
  const cs = [k(t0, 1, 1, 1, 1)];
  const now = t0 + 10 * MIN;
  assert.equal(applyLiveTick(cs, { price: 2, at: now - TICK_MAX_AGE_MS - 1 }, MIN, now).changed, false, 'too old');
  assert.equal(applyLiveTick(cs, { price: NaN, at: now }, MIN, now).changed, false);
  assert.equal(applyLiveTick(cs, { price: -1, at: now }, MIN, now).changed, false);
  assert.equal(applyLiveTick(cs, undefined, MIN, now).changed, false);
  assert.equal(applyLiveTick(cs, { price: 2, at: t0 - 1 }, MIN, now - 1).changed, false, 'older than the last candle');
  assert.equal(applyLiveTick(cs, { price: 2, at: now }, MIN, now).changed, false, '10 empty minutes: refetch instead of inventing candles');
  assert.equal(applyLiveTick([], { price: 2, at: now }, MIN, now).changed, false);
});

test('price gap between chart pool and quoted price', () => {
  assert.equal(priceGap(1, 1), 0);
  assert.ok(Math.abs(priceGap(1.05, 1) - 0.05) < 1e-12);
  assert.equal(priceGap(0, 1), 0);
});
