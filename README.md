# BAGZ

Live memecoin charts, a Gem Radar for new launches and a paper-trading desk. React + TypeScript, built to one static page for GitHub Pages, with an optional Cloudflare Worker proxy for API keys, CORS and shared caching.

Brand: black `#090909`, hot pink `#FF008C`, white. Green/red are used only for price up/down.

## What is real, and what is not

| Area | Status |
|---|---|
| Provider code, caching, rate limits, retries, validation, health panel | **Passed** automated tests against recorded response shapes (`npm test`) |
| Worker: every endpoint on its own (CORS, allowlist, query/body validation, key injection, limits, error mapping, no secret leaks) | **Passed** 45 tests (`tests/worker*.test.ts`), stub upstream |
| App ⇄ Worker over real HTTP with real browser CORS, phone layout | **Passed** 38 checks (`npm run test:e2e`): the real Worker code in a local server, the real built app in Chromium, mocked providers, fake chart library |
| UI, charts wiring, ranges/intervals, live ticks, paper trading | **Passed** 52 browser checks (`npm run test:browser`), mocked API, fake chart library |
| Worker deployed on Cloudflare (edge cache, rate-limit binding, secrets) | **Not tested.** Not deployed yet. `scripts/probe-worker.ts` tests the deployed Worker against the real providers |
| Real provider responses | **Not tested live.** The build sandbox cannot reach the providers. Run the probe after deploying |
| TradingView Lightweight Charts rendering | **Not tested.** The library could not be downloaded in the sandbox; a basic chart is the fallback |
| Swap transaction encoding (v0 + lookup tables, legacy) | **Passed** 8 tests (`tests/solana.test.ts`), cross-checked against Solana Kit 8.5.0 (independent implementation, test-only) |
| Swaps with the 0.50% fee: build, simulate, sign, send once, confirm, read fee on-chain; tampering, stale quotes, duplicates, wrong/missing fee account | **Passed** 15 tests (`tests/api-swap.test.ts`), real Worker code, SQLite-backed D1, fake chain + Jupiter `/build` |
| BOOST: packages, token checks, USDC payment build/verify, wrong mint/amount/recipient, reused payments, admin wallet sign-in, approval, scheduling, expiry, analytics | **Passed** 12 tests (`tests/api-boost.test.ts`) |
| App client ⇄ Worker (wallet connect/reject/account switch, rejected signatures, double clicks, timeouts, balances, Boost + admin) | **Passed** 11 tests (`tests/client-flow.test.ts`), real Ed25519 signatures |
| New screens in Chromium (Promote → pay → admin approve → labelled Sponsored row → impression/click; live swap UI with locks closed and open; balances; phone layouts; mobile wallet handoff) | **Passed** 32 checks (`npm run test:app`) |
| Live swaps / BOOST payments on mainnet | **Not run. Switched off** (`ENABLE_LIVE_SWAPS`, `ENABLE_LIVE_BOOST_PAYMENTS`, `BAGZ_LIVE_TRADING`). Never executed against Jupiter or Solana for real |
| Jupiter `/build` real responses, Phantom/Solflare/Backpack real apps | **Not tested.** No network access to them from the build sandbox; the fake follows the documented schema |
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
npm run test:app       # new screens (swap, Promote, admin, Sponsored) against the real Worker + D1, fake chain
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

## Swaps with the BAGZ fee, and BOOST (both OFF)

### How it works
- **Wallets:** Wallet Standard (Phantom, Solflare, Backpack and others register themselves). Account switches and disconnects made inside the wallet are followed. On a phone browser with no wallet, the app offers to open itself inside Phantom or Solflare (their documented `browse` deep links); Backpack users open the page in Backpack's own browser. No private key or seed phrase is ever requested or stored.
- **Swaps:** the Worker calls Jupiter Swap API V2 `GET /swap/v2/build` with `platformFeeBps=50` and the BAGZ fee token account (wSOL for SOL pairs, USDC for USDC pairs; for exact-in swaps Jupiter accepts either mint). It refuses to build if the fee account is missing, not on-chain, the wrong mint or owner, or not wired into Jupiter's swap instruction. It loads lookup tables from the chain, compiles a v0 transaction, simulates it, sets the compute limit to 1.2× use, caps the priority fee, stores the message hash and returns the unsigned transaction. The wallet signs; `/v1/swap/submit` accepts it only if the bytes are unchanged and the signature verifies, sends it once, and `/v1/swap/status` reports confirmed/failed/expired from the chain, including the fee the fee account actually received.
- **BOOST:** `/v1/boost/preview` checks the mint on-chain and finds real token data (Jupiter, then DexScreener). An order gets a unique Solana Pay reference. The payment is a USDC `transferChecked` to the BOOST account carrying that reference plus a memo; it can be paid in-app or with the Solana Pay link. Verification checks success, USDC mint, recipient, amount, reference and that it was made after the order; a signature can pay for one order only. Paid orders wait for an admin, who signs in by signing a one-time message with an allow-listed wallet. Approved listings run from their start for their package length and drop off automatically. Impressions count when a card is half on screen for 1 s; impressions and clicks are de-duplicated per viewer every 30 minutes.
- **Sponsored placements** sit in their own row labelled “Paid placement” and “Ad”, separate from every organic list, and never touch Gem Score or risk checks.

### Switches (all must be on before real money moves)
| Where | Name | Default |
|---|---|---|
| Worker var | `ENABLE_LIVE_SWAPS` | `"false"`: quotes only, no transaction is built or sent |
| Worker var | `ENABLE_LIVE_BOOST_PAYMENTS` | `"false"`: no orders or payments |
| Worker var | `BAGZ_PLATFORM_FEE_BPS` | `"50"` (0.50%). `0` or invalid makes swaps refuse, never run fee-free |
| Site build | `BAGZ_LIVE_TRADING=1 node build.mjs` | not set: the swap button stays off |

### Worker configuration
Vars (`worker/wrangler.toml`, public keys only): `FEE_WALLET`, `FEE_ACCOUNT_WSOL`, `FEE_ACCOUNT_USDC`, `BOOST_WALLET`, `BOOST_USDC_ACCOUNT` (the USDC associated token account of `BOOST_WALLET`, so Solana Pay payments land there), `ADMIN_WALLETS`, `MAX_CU_PRICE_MICROLAMPORTS`.
Secrets (`npx wrangler secret put …`): `JUPITER_API_KEY`, `HELIUS_API_KEY` (or `SOLANA_RPC_URL`), `ADMIN_SESSION_SECRET` (32+ random characters), `ANALYTICS_SALT`, plus the existing `COINGECKO_API_KEY`, `PROBE_TOKEN`.
D1: binding `Db` (as shown in the dashboard). Fill `database_name` / `database_id` in `wrangler.toml`, then:
```bash
cd worker
npx wrangler d1 migrations apply <database_name> --remote
npx wrangler deploy
npx tsx ../scripts/probe-worker.ts https://bagz-api.<you>.workers.dev --token <PROBE_TOKEN>
```
The fee token accounts must exist before swaps are enabled (create the wSOL and USDC associated token accounts for `FEE_WALLET` in any wallet or with `spl-token create-account`).

### Before switching anything on
1. Security review of `worker/api.js` and `worker/solana.js`, and a compliance/legal review of charging swap fees and selling ad placements where you operate.
2. Probe passes against the deployed Worker; `/v1/config` shows the fee accounts, BOOST account and D1 connected.
3. With a throw-away wallet and tiny amounts on mainnet, with `ENABLE_LIVE_SWAPS="true"` and a `BAGZ_LIVE_TRADING=1` build served from a test URL: a buy and a sell on a SOL pair, a rejected signature, an expired quote, slippage exceeded. Check each fee transfer on Solscan.
4. A $10 Starter BOOST paid in-app and one paid via the Solana Pay link; approve, watch it go live and expire.
5. Decide and publish a refund policy for rejected listings (refunds are manual).

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
