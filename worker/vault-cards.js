/**
 * The Vault card set. Shared by the Worker (prices, supply) and the app (names, art, frames).
 * Every card is limited to SUPPLY copies; each copy gets a serial number "n/30" in the order it was claimed.
 * Change a card's rarity here and both sides follow.
 */
export const SUPPLY = 30;
export const RARITY = {
  common: { label: 'Common', price: 100 },
  rare: { label: 'Rare', price: 250 },
  gem: { label: 'Gem', price: 600 },
};
export const SERIES = {
  ape: { label: 'OG Ape', rarity: 'gem' },
  bear: { label: 'Bear', rarity: 'rare' },
  bull: { label: 'Bull', rarity: 'common' },
};
const set = (series, modes) => modes.map((mode, i) => ({ id: `${series}-${String(i + 1).padStart(2, '0')}`, series, no: i + 1, mode, rarity: SERIES[series].rarity }));
export const CARDS = [
  ...set('ape', ['Day Trading', 'Skate', 'Jet Ski', 'Gaming', 'Chill', 'Travel', 'Fishing', 'Gym', 'Explore']),
  ...set('bear', ['Work', 'Basketball', 'Cook', 'Snowboard', 'HODL', 'Tennis', 'Fish', 'Golf', 'Yacht', 'Chill']),
  ...set('bull', ['Trade', 'Moto', 'Surf', 'Hunt', 'Polo', 'Boxing', 'Music', 'Drive', 'Invest', 'Travel']),
];
export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));
export const priceOf = (c) => RARITY[c.rarity].price;
