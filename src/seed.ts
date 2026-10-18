import type { Chain } from './types';

/**
 * Contract addresses only. Every number in the app (price, market cap, liquidity,
 * volume, holders) is fetched live; nothing here is a price or a fake value.
 */
export const MAJORS: { chain: Chain; address: string; symbol: string }[] = [
  { chain: 'ethereum', address: '0x6982508145454Ce325dDbE47a25d4ec3d2311933', symbol: 'PEPE' },
  { chain: 'ethereum', address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', symbol: 'SHIB' },
  { chain: 'bsc', address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', symbol: 'DOGE' },
  { chain: 'ethereum', address: '0xcf0C122c6b73ff809C693DB761e7BaeBe62b6a2E', symbol: 'FLOKI' },
  { chain: 'ethereum', address: '0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C', symbol: 'SPX' },
  { chain: 'ethereum', address: '0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a', symbol: 'MOG' },
  { chain: 'base', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', symbol: 'BRETT' },
  { chain: 'base', address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', symbol: 'TOSHI' },
  { chain: 'solana', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { chain: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { chain: 'solana', address: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', symbol: 'PUMP' },
  { chain: 'solana', address: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', symbol: 'TRUMP' },
  { chain: 'solana', address: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', symbol: 'FARTCOIN' },
  { chain: 'solana', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT' },
  { chain: 'solana', address: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', symbol: 'PNUT' },
  { chain: 'solana', address: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82', symbol: 'BOME' },
  { chain: 'solana', address: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9', symbol: 'GIGA' },
];

/** Narrative categories, matched against a coin's name, symbol and description. */
export const NARRATIVES: { id: string; label: string; re: RegExp }[] = [
  { id: 'dogs', label: 'Dogs', re: /\b(dog|dogs|doge|santadoge|inu|shib|wif|bonk|pup|puppy|shiba|corgi|pug|floki|husky|k9)\b/i },
  { id: 'cats', label: 'Cats', re: /\b(cat|cats|cate|catsky|kitty|kitten|meow|mew|popcat|nyan|catwif|chat|chaton|gato|neko)\b/i },
  { id: 'frogs', label: 'Frogs', re: /\b(pepe|frog|toad|kek|ribbit|brett)\b/i },
  { id: 'ai', label: 'AI & agents', re: /\b(ai|agent|agents|gpt|llm|bot|neural|terminal|autonomous|grok|claude)\b/i },
  { id: 'politics', label: 'Politics', re: /\b(trump|maga|biden|president|elon|musk|vote|election|kamala|melania)\b/i },
];

/** Explorer and trading-terminal links. Axiom, GMGN and Photon have no public data API, so they are link-outs. */
export function tradeLinks(chain: Chain, address: string, pairAddress?: string): { label: string; url: string }[] {
  const ds = { solana: 'solana', ethereum: 'ethereum', base: 'base', bsc: 'bsc' }[chain];
  const out = [{ label: 'DexScreener', url: `https://dexscreener.com/${ds}/${pairAddress || address}` }];
  if (chain === 'solana') {
    out.push(
      { label: 'pump.fun', url: `https://pump.fun/coin/${address}` },
      { label: 'Axiom', url: `https://axiom.trade/meme/${pairAddress || address}` },
      { label: 'GMGN', url: `https://gmgn.ai/sol/token/${address}` },
      { label: 'Jupiter', url: `https://jup.ag/swap/SOL-${address}` },
      { label: 'Solscan', url: `https://solscan.io/token/${address}` },
    );
  } else {
    const gm = { ethereum: 'eth', base: 'base', bsc: 'bsc' }[chain];
    const ex = { ethereum: 'https://etherscan.io/token/', base: 'https://basescan.org/token/', bsc: 'https://bscscan.com/token/' }[chain];
    out.push({ label: 'GMGN', url: `https://gmgn.ai/${gm}/token/${address}` }, { label: 'Explorer', url: ex + address });
  }
  return out;
}

export function walletLink(chain: Chain, address: string) {
  return chain === 'solana' ? `https://solscan.io/account/${address}`
    : chain === 'base' ? `https://basescan.org/address/${address}`
    : chain === 'bsc' ? `https://bscscan.com/address/${address}`
    : `https://etherscan.io/address/${address}`;
}
