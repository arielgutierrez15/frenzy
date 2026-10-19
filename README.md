# BAGZ

Live memecoin charts, a Gem Radar for new launches and a paper-trading desk. React + TypeScript, built to one static page for GitHub Pages, with an optional Cloudflare Worker proxy for API keys, CORS and shared caching.

Brand: black `#090909`, hot pink `#FF008C`, white. Green/red are used only for price up/down.

## What is real, and what is not

| Area | Status |
|---|---|
| Provider code, caching, rate limits, retries, validation, health panel | **Verified** by 55 automated tests against recorded response shapes |
| Cloudflare Worker (allowlist, CORS, key injection, edge cache, RPC allowlist) | **Verified** by 10 automated tests (not deployed by me) |
| UI, charts wiring, ranges/intervals, live ticks, paper trading, phone layout | **Verified** in Chromium (52 checks) against a **mocked** API and a **fake** chart library |
| Real provider responses (Jupiter, GeckoTerminal, DexScreener, pump.fun, RugCheck, RPC) | **Not verified live.** The build sandbox could not reach those sites. Response shapes come from earlier real captures and vendor docs |
| TradingView Lightweight Charts rendering | **Not verified.** The library could not be downloaded in the sandbox. Written against the v4.2 API; a basic SVG chart is the fallback |
| Wallet connect, Jupiter quote → sign → execute → confirm | **Unit-tested with a fake wallet only.** **Switched off.** Never run against mainnet |
| pump.fun feeds | pump.fun publishes no API. These are unofficial and may not work at all |

## Data sources (checked against vendor docs, 18 Oct 2026)

- **Jupiter** `api.jup.ag` — Tokens v2, Price v3, Swap v2. API key header `x-api-key`; keyless 0.5 req/s, free key 1 req/s. `lite-api.jup.ag` is being phased out (kept only as a read-only fallback, never for swaps).
- **GeckoTerminal** — keyless is about 10 calls/min shared per IP and not meant for production. The proxy can use a CoinGecko Demo key (100/min).
- **DexScreener**, **RugCheck**, **Solana RPC** — keyless; the public RPC is heavily limited, so give the proxy your own RPC URL.
- **pump.fun** `frontend-api-v3` — undocumented website backend; browsers are usually blocked, so it works only through the proxy, if at all. When it is down the app says so and still finds pump.fun coins through Jupiter/GeckoTerminal launch data.

Every request goes through one core (`src/providers/http.ts`): response cache, in-flight de-duplication, token-bucket rate limits with priorities, timeouts, retries with backoff, 429 cool-downs, host fallback, shape validation, and per-source health. The Data sources panel on Home shows the real time each provider last answered. Stale answers are labelled stale; nothing is invented.

## Setup

```bash
npm install            # installs lightweight-charts so it is bundled into the page
npm run check          # type-check
npm test               # 55 unit/integration tests
node build.mjs         # writes docs/index.html (GitHub Pages) and dist/bagz.html
npm run test:browser   # needs Playwright + Chromium
```

Without `npm install`, `node build.mjs` still works: the page then loads Lightweight Charts v4.2.0 from jsDelivr at runtime (or from `docs/vendor/` if you run `npm run vendor:charts`).

## Deploy the site (GitHub Pages)

Settings → Pages → Deploy from a branch → `main` → `/docs`. The site is `https://<user>.github.io/frenzy/`.

## Deploy the proxy (recommended; needed for pump.fun and reliable GeckoTerminal)

1. `cd worker && npx wrangler login`
2. Edit `wrangler.toml`: set `ALLOWED_ORIGINS` to your site origin.
3. Secrets (never commit them):
   ```bash
   npx wrangler secret put JUPITER_API_KEY     # free key: developers.jup.ag/portal
   npx wrangler secret put COINGECKO_API_KEY   # optional, raises GeckoTerminal limits
   npx wrangler secret put SOLANA_RPC_URL      # optional, your Helius/QuickNode/etc. endpoint
   ```
4. `npx wrangler deploy` → note the `https://bagz-proxy.<you>.workers.dev` URL. Check `/health`.
5. Add a Cloudflare rate-limiting rule for the Worker (the built-in limiter is per-instance, best effort).
6. Rebuild with the proxy: `BAGZ_PROXY_URL=https://bagz-proxy.<you>.workers.dev node build.mjs`, commit `docs/`. For a quick test without rebuilding, open the site with `?proxy=https://…` (remembered in the browser; `?proxy=off` clears it).

## Real trading (off)

`src/trading/` has Wallet Standard connection (Phantom, Solflare, Backpack), Jupiter Swap v2 `/order` → wallet signature → `/execute` → on-chain confirmation, with quote age limits, slippage, fee and impact display. No private key or seed phrase is ever requested or stored. Two locks keep it off: the build flag `BAGZ_LIVE_TRADING=1` and a check inside `executeSwap()`. Before enabling: run the whole flow on mainnet with a throw-away wallet and tiny amounts, confirm Jupiter's `/order` response fields (`priceImpact` is shown only if Jupiter reports it), and decide on priority-fee handling (not included in quotes).

## Paper trading

Starts at $10,000. Fills use constant-product price impact against real pool liquidity, a 0.5% fee, your slippage limit, and only a price fetched in the last 60 seconds (the ticket re-fetches on open and every 10 s). Wallet is saved in the browser (`frenzy.live.v1` key, kept from the Frenzy version so old wallets survive); Back up / Restore buttons export JSON.

## Known limitations

- Candles come only from GeckoTerminal for the coin's busiest pool; intervals with no trades have no candle. Very new tokens show less history than the range.
- The chart pool and the quoted price (DexScreener's best pair) can differ; the chart warns above 3%.
- pump.fun livestream status is unavailable without a working pump.fun feed.
- Holder lists use the public Solana RPC and often hit its limits.
- Paper trades are simulations; they never touch a wallet.
