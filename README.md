# BAGZ

Live memecoin charts, a Gem Radar for new launches and a paper-trading desk. React + TypeScript, built to one static page for GitHub Pages, with an optional Cloudflare Worker proxy for API keys, CORS and shared caching.

Brand: black `#090909`, hot pink `#FF008C`, white. Green/red are used only for price up/down.

## What is real, and what is not

| Area | Status |
|---|---|
| Provider code, caching, rate limits, retries, validation, health panel | **Passed** automated tests against recorded response shapes (`npm test`) |
| Worker: every endpoint on its own (CORS, allowlist, query/body validation, key injection, limits, error mapping, no secret leaks) | **Passed** 45 tests (`tests/worker*.test.ts`), stub upstream |
| App ⇄ Worker over real HTTP with real browser CORS, phone layout | **Passed** 36 checks (`npm run test:e2e`): the real Worker code in a local server, the real built app in Chromium, mocked providers, fake chart library |
| UI, charts wiring, ranges/intervals, live ticks, paper trading | **Passed** 52 browser checks (`npm run test:browser`), mocked API, fake chart library |
| Worker deployed on Cloudflare (edge cache, rate-limit binding, secrets) | **Not tested.** Not deployed yet. `scripts/probe-worker.ts` tests the deployed Worker against the real providers |
| Real provider responses | **Not tested live.** The build sandbox cannot reach the providers. Run the probe after deploying |
| TradingView Lightweight Charts rendering | **Not tested.** The library could not be downloaded in the sandbox; a basic chart is the fallback |
| Wallet connect, Jupiter quote → sign → execute → confirm | **Unit-tested with a fake wallet only. Switched off.** Never run on mainnet |
| pump.fun feeds | Unofficial; may not work at all |

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
npm test               # unit + Worker endpoint tests
node build.mjs         # writes docs/index.html (GitHub Pages) and dist/bagz.html
npm run test:browser   # app in Chromium, mocked providers (needs Playwright + Chromium)
npm run test:e2e       # app ⇄ real Worker code over HTTP with real CORS, mocked providers
```

Without `npm install`, `node build.mjs` still works: the page then loads Lightweight Charts v4.2.0 from jsDelivr at runtime (or from `docs/vendor/` if you run `npm run vendor:charts`).

## Deploy the site (GitHub Pages)

Settings → Pages → Deploy from a branch → `main` → `/docs`. The site is `https://<user>.github.io/frenzy/`.

## Deploy the proxy (recommended; needed for pump.fun and reliable GeckoTerminal)

The site keeps working without it (calls go direct from the browser, with the limits above). Deploy and test the Worker first, then connect the site.

1. `cd worker && npx wrangler login`
2. In `wrangler.toml`, set `ALLOWED_ORIGINS` to your exact site origin(s): scheme + host, no path, no wildcard (default `https://arielgutierrez15.github.io`). Keep `ALLOW_LOCALHOST = "0"` in production.
3. Secrets live only in Cloudflare, never in the repo or the page:
   ```bash
   npx wrangler secret put JUPITER_API_KEY     # free key: developers.jup.ag/portal
   npx wrangler secret put COINGECKO_API_KEY   # optional but recommended: CoinGecko Demo key (keyless GeckoTerminal ≈ 10 calls/min)
   npx wrangler secret put SOLANA_RPC_URL      # optional: your Helius/QuickNode/etc. URL
   npx wrangler secret put PROBE_TOKEN         # any long random string; lets the probe script test the Worker
   ```
   For local `wrangler dev`, put them in `worker/.dev.vars` (git-ignored).
4. Hard rate limit (recommended): enable the Workers rate-limiting binding named `RATE_LIMITER` (commented block in `wrangler.toml`; check Cloudflare's current syntax). Without it, only the per-instance limits apply.
5. `npx wrangler deploy` → note `https://bagz-proxy.<you>.workers.dev`.
6. **Test every endpoint against the real providers before connecting the site:**
   ```bash
   npx tsx scripts/probe-worker.ts https://bagz-proxy.<you>.workers.dev --token <PROBE_TOKEN>
   ```
   It checks CORS from your origin, refusal of other origins and of tokenless scripts, then calls each endpoint and parses the answer with the app's own validators. It also prints Jupiter's real `/order` field names. FAIL = do not connect yet. pump.fun only warns.
7. Connect: open the site with `?proxy=https://bagz-proxy.<you>.workers.dev` to try it (remembered in that browser; `?proxy=off` clears it). When the Data sources panel looks right, rebuild with `BAGZ_PROXY_URL=https://… node build.mjs` and commit `docs/`.

### What the Worker enforces

- **CORS / origin:** data routes (`/p/…`) answer only browsers from `ALLOWED_ORIGINS` (exact match; `*`, `null`, look-alike hosts and `http://` variants are refused). Requests without an Origin (curl, bots) are refused unless they carry `x-bagz-probe: <PROBE_TOKEN>`. `/health` is open and returns booleans only.
- **Allowlist:** only the paths the app uses, each with its allowed query parameters and value formats; unknown or repeated parameters get 400 before anything reaches a provider. Queries are normalised so reordering cannot bust the cache.
- **Bodies:** two POSTs exist. Swap execute must be exactly `{signedTransaction, requestId}` with sane sizes. RPC allows four read-only methods (`getTokenLargestAccounts`, `getTokenSupply`, `getLatestBlockhash`, `getSignatureStatuses`); `sendTransaction` and everything else is refused.
- **Abuse limits:** per-IP requests/min (`RATE_PER_MIN`, 240), stricter POSTs/min (`RATE_POST_PER_MIN`, 20), the optional Cloudflare binding, and a per-provider upstream budget per minute on cache misses (Jupiter 50, GeckoTerminal 80 with a key / 8 without, DexScreener 240, pump.fun 30, RugCheck 30, RPC 100; override with `UPSTREAM_PER_MIN_<ID>`), so one visitor cannot burn your keys. Limited answers are 429 with `Retry-After` and `x-bagz-limit`.
- **Responses:** JSON only (anything else becomes 502), 2 MB cap, no redirects followed, upstream error bodies never forwarded, errors not cached, keys never echoed.

## Real trading (off)

`src/trading/` has Wallet Standard connection (Phantom, Solflare, Backpack), Jupiter Swap v2 `/order` → wallet signature → `/execute` → on-chain confirmation, with quote age limits, slippage, fee and impact display. No private key or seed phrase is ever requested or stored. Two locks keep it off: the build flag `BAGZ_LIVE_TRADING=1` and a check inside `executeSwap()`.

Do not set the flag until each of these has been verified independently (none has yet):
1. Wallet connectivity with each supported wallet on desktop and phone.
2. Transaction construction: decode Jupiter's returned transaction and confirm taker, mints, amounts and fee accounts match the quote.
3. Security checks: deployed Worker probe passes, CORS refuses other origins, no key in the page, quote expiry and slippage limits enforced.
4. Execution: tiny swaps from a throw-away wallet on mainnet, confirmed on-chain, including failure cases (expired quote, rejected signature, slippage exceeded).

## Paper trading

Starts at $10,000. Fills use constant-product price impact against real pool liquidity, a 0.5% fee, your slippage limit, and only a price fetched in the last 60 seconds (the ticket re-fetches on open and every 10 s). Wallet is saved in the browser (`frenzy.live.v1` key, kept from the Frenzy version so old wallets survive); Back up / Restore buttons export JSON.

## Data compatibility rules

A value from one provider is only combined with another's when they describe the same thing:
- Coins are keyed by chain + token address; DexScreener prices are taken only from pairs where the coin is the **base** token.
- A GeckoTerminal pool is used for charts/trades only if the coin is its **base** token; quote-side pools are skipped, and if no compatible pool exists the chart says so.
- Candles are refused if GeckoTerminal's `meta.base` names another token; if it gives no `meta`, the chart says the token was not confirmed.
- The chart warns when its last close and the quoted price (different pool) differ by more than 3%.
- Stale answers are labelled stale with their real fetch time. When every source is unreachable the app shows a bundled snapshot with a dated banner, frozen prices and trading off.

## Known limitations

- Candles come only from GeckoTerminal for the coin's busiest pool; intervals with no trades have no candle. Very new tokens show less history than the range.
- The chart pool and the quoted price (DexScreener's best pair) can differ; the chart warns above 3%.
- pump.fun livestream status is unavailable without a working pump.fun feed.
- Holder lists use the public Solana RPC and often hit its limits.
- Paper trades are simulations; they never touch a wallet.
