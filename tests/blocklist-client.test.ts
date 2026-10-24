/**
 * The app side of the admin token blocklist: blocked tokens leave lists and search, but a coin someone holds or has
 * an open order in stays so their paper position keeps working.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshState, keyOf, setBlockedMints, pruneBlocked, isBlockedCoin } from '../src/engine';

const BAD = 'Bad1111111111111111111111111111111111111111';
const HELD = 'Held111111111111111111111111111111111111111';
const OK = 'Okay111111111111111111111111111111111111111';

const coin = (address: string) => ({ id: keyOf('solana', address), chain: 'solana' as const, address, symbol: 'X', name: 'X', price: 1, change: {}, mcap: 0, liq: 0, vol24: 0, audit: {}, socials: 0, links: [], sources: [], spark: [], peakPrice: 0, peakLiq: 0, firstSeen: 0, updatedAt: 0 });

test('blocked tokens are dropped from the store, held ones stay', () => {
  const st = freshState();
  for (const a of [BAD, HELD, OK]) st.coins[keyOf('solana', a)] = coin(a) as any;
  st.user.positions[keyOf('solana', HELD)] = { coinId: keyOf('solana', HELD), qty: 1, cost: 1 } as any;
  setBlockedMints([]);
  assert.equal(pruneBlocked(st), 0, 'empty list hides nothing');
  setBlockedMints([BAD, HELD]);
  assert.equal(isBlockedCoin(coin(BAD)), true);
  assert.equal(isBlockedCoin({ chain: 'base' as any, address: BAD }), false, 'only Solana mints');
  assert.equal(pruneBlocked(st), 1);
  assert.equal(st.coins[keyOf('solana', BAD)], undefined);
  assert.ok(st.coins[keyOf('solana', HELD)], 'a held coin is kept so the position still works');
  assert.ok(st.coins[keyOf('solana', OK)]);
  setBlockedMints([]);
});
