/**
 * The Vault card set. Shared by the Worker (prices, supply) and the app (names, art, frames).
 * Every card is limited to SUPPLY copies; each copy gets a serial number "n/30" in the order it was claimed.
 * Rarity is set per card (any animal can be Common, Rare or Gem) and shows as the frame colour:
 * Common = blue, Rare = gold, Gem = pink. Change a card's letter below and both sides follow.
 */
export const SUPPLY = 30;
export const RARITY = {
  common: { label: 'Common', price: 100 },
  rare: { label: 'Rare', price: 250 },
  gem: { label: 'Gem', price: 600 },
};
export const SERIES = {
  ape: { label: 'OG Ape' },
  bear: { label: 'Bear' },
  bull: { label: 'Bull' },
};
const R = { c: 'common', r: 'rare', g: 'gem' };
// [mode, rarity letter] in card-number order
const set = (series, list) => list.map(([mode, r], i) => ({ id: `${series}-${String(i + 1).padStart(2, '0')}`, series, no: i + 1, mode, rarity: R[r] }));
export const CARDS = [
  ...set('ape', [['Day Trading', 'g'], ['Skate', 'c'], ['Jet Ski', 'r'], ['Gaming', 'c'], ['Chill', 'c'], ['Travel', 'r'], ['Fishing', 'c'], ['Gym', 'c'], ['Explore', 'r']]),
  ...set('bear', [['Work', 'c'], ['Basketball', 'r'], ['Cook', 'c'], ['Snowboard', 'r'], ['HODL', 'g'], ['Tennis', 'c'], ['Fish', 'c'], ['Golf', 'c'], ['Yacht', 'r'], ['Chill', 'c']]),
  ...set('bull', [['Trade', 'g'], ['Moto', 'c'], ['Surf', 'r'], ['Hunt', 'c'], ['Polo', 'r'], ['Boxing', 'c'], ['Music', 'c'], ['Drive', 'r'], ['Invest', 'c'], ['Travel', 'c']]),
];
export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));
export const priceOf = (c) => RARITY[c.rarity].price;
