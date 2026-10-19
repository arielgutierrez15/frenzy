/**
 * Real (on-chain) trading is OFF. It stays off until the whole flow — quote, wallet signature, Jupiter execute and
 * on-chain confirmation — has been exercised against mainnet with a throw-away wallet and tiny amounts.
 *
 * There are two independent locks:
 *  1. build flag   BAGZ_LIVE_TRADING=1 node build.mjs   (default: not set)
 *  2. in code      executeSwap() refuses unless liveTradingEnabled() is true
 * Quotes and wallet connection work either way; nothing in the app can send a transaction while this is false.
 */
declare const __BAGZ_LIVE_TRADING__: string | undefined;

let override: boolean | undefined;
export const liveTradingEnabled = (): boolean =>
  override !== undefined ? override : typeof __BAGZ_LIVE_TRADING__ !== 'undefined' && __BAGZ_LIVE_TRADING__ === '1';
/** tests only */
export const __setLiveTrading = (v: boolean | undefined) => { override = v; };

export class TradingDisabledError extends Error {
  constructor() { super('Live trading is switched off in this build. Paper trading is unaffected.'); this.name = 'TradingDisabledError'; }
}
