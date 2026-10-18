# Frenzy

Paper-trade real memecoins at their live prices. Find coins on a Gem Radar that merges several market data sites, watch real on-chain swaps, follow real wallets, and track your paper PnL. No wallet connection, no real money, and no fake users or bot traders.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build:single # dist/frenzy.html, one file you can open by double-clicking
```

Live data loads in any normal browser: `npm run dev`, the single `frenzy.html` file, or any static host (GitHub Pages, Netlify, Vercel).

Pages published inside claude.ai can't make outside requests. There, Frenzy shows a bundled snapshot of real data captured on 18 Oct 2026 (Jupiter, pump.fun, DexScreener). The page labels it as a snapshot, freezes prices and turns paper trading off. If a live source answers later, live data takes over.

## Data sources

| Source | What Frenzy reads |
| --- | --- |
| Jupiter (lite-api.jup.ag) | Newest tokens, top trending (1h), top organic score (1h), most traded (1h): price, holders, mint/freeze authority, top-holder and dev %, organic score |
| pump.fun (frontend-api-v3.pump.fun) | Newest coins and coins livestreaming now: market cap, bonding-curve status (graduated or not), socials |
| DexScreener | Newest token profiles, top boosts, and the batch price refresh for every tracked coin every 20 s |
| GeckoTerminal | New and trending pools (Solana and Base), 1-minute candles, and real swaps with wallet addresses |
| Solana public RPC | The 20 largest holders of a Solana coin |
| Axiom, GMGN, Photon | No public data API. Each coin page links out to them |

Coins are merged by contract address, so one coin seen on three sites carries all three sites' data.

## Categories (built from the combined data)

Hot on 2+ sites, New (24h), pump.fun, Live on pump.fun, Graduated, Most traded, Boosted, Organic flow, Dogs, Cats, Frogs, AI & agents, Politics, Blue chips. Stablecoins, wrapped majors, liquid-staking tokens and tokenized stocks are filtered out of the radar.

## Gem Score

0–100 from the checks the sources report: mint and freeze authority, top-holder %, deployer %, deployer's past launches, holder count, liquidity, socials, Jupiter organic score, buy/sell balance, and how many sites list the coin. Checks a source didn't report count as unknown, not as passes. A coin whose liquidity is pulled or that falls 90% from its session peak is flagged as rugged.

## Users

Nobody else uses Frenzy yet, so there is no user leaderboard or social feed of fake people. The Live feed and the Wallets tab show real wallets from on-chain swaps. Your own paper trades and theses appear under "You".

## Colors

Solana palette: purple `#9945FF` for actions and gems, green `#14F195` for gains, the purple-to-green gradient on the wordmark and PnL card. Dark and light themes both follow the viewer's system setting.

## Files

```
src/engine.ts      data fetching and merging, Gem Score, categories, paper trading, orders, persistence
src/snapshot.ts    real data captured 18 Oct 2026, used only when every live source is unreachable
src/seed.ts        blue-chip contract addresses, narrative keywords, outbound links
src/store.ts       store and refresh loops (prices 20 s, discovery 60 s, swaps 30 s)
src/views.tsx      Live feed, Gem Radar, coin page, Wallet, Wallets
src/TradeSheet.tsx trade sheet and PnL share card
src/ui.tsx         icons, badges, score ring, charts
src/App.tsx        shell, navigation, alerts, toasts
src/styles.css     styling, Solana palette in dark and light
```
