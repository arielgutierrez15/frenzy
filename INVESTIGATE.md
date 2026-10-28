# Investigate (token page) — what was built, how to deploy it, what still needs a live check

Investigate is a read-only section on every token page. For Solana tokens it shows who holds the largest token
accounts (as bubbles and as a table), and, for a holder you select, a bounded sample of that token account's recent
transfers with links to each transaction. Other chains get an explicit "Solana only" message. No wallet, signature or
transaction is involved, and nothing is ever simulated: if the server can't answer, the panel says why.

## What is in this version (phase 1)

| Capability | Status |
|---|---|
| Holder snapshot: the token's largest token accounts (the RPC returns at most 20), grouped by owner with exact BigInt sums | Built, tested with scripted RPC |
| Percent of supply: integer division, truncated to 4 decimals; supply read in the same request (same slot) as the balances | Built, tested |
| Scope stated on screen: "not a ranking of the largest wallets"; other accounts of an owner are not counted | Built |
| Owner address type from facts only: off-curve (program-derived) vs key-pair wallet vs program account | Built; on-curve check cross-checked against an independent RFC 8032 decoder (445 vectors, 0 mismatches) |
| Bubble map (area ∝ balance, minimum tap size documented and marked), sortable table alternative, keyboard selection | Built, tested in Chromium (desktop + 390 px phone) |
| Selected holder: full address, its token accounts in the snapshot, balance (readable + raw), share | Built |
| Transfer feed: 10 most recent finalized signatures per page for ONE token account, successful transactions only; direction, readable + raw amount, time, slot, Solscan link, instruction number (outer.inner) and program context | Built, tested |
| Lines on the map only from decoded transfers the user loaded: solid = both owners resolved; grey = inside another program (e.g. a swap); dotted = one side is an unknown token account | Built, tested |
| Market tab: the chart pool's identity and GeckoTerminal buy/sell transaction counts per window; missing values say "unavailable"; candles + volume + timeframes are the existing chart (same pool), reused in place | Built, tested |
| Status: provider, retrieval time, finality, slots, coverage, last successful refresh, "Snapshot" (never "live"), stale and partial states | Built, tested |
| Errors: no server, test copy, wrong chain, invalid mint, key missing, key refused, rate limited, timeout, provider failure, unexpected format, routes not deployed, origin refused | Built, tested |
| Fast token switching: answers for a previous token are dropped; requests are cancelled | Built, tested |

Not built (later phases — do not describe them as available): full-history indexing, complete owner ranking (needs
paginated mint accounts + an index), creator/deployer attribution, shared-funder analysis, related-launch search,
historical ownership, ecosystem-wide statistics, program/service labels for wallets (exchanges, market makers).

## How it works

```
token page ─▶ BAGZ Worker  GET /v1/investigate/holders?mint=…            (3 RPC calls)
          └─▶             GET /v1/investigate/activity?mint=…&account=…  (2 + up to 10 RPC calls, on demand)
                          GET /v1/investigate/health                     (no RPC call)
BAGZ Worker ─▶ Solana RPC from rpcUrl(env): SOLANA_RPC_URL, else HELIUS_API_KEY (never the public RPC for this feature)
```

- The routes are added to the existing `bagz-api` Worker (`worker/investigate.js`, dispatched from `api()` in
  `worker/api.js`), so they get the same origin check, probe token, Cloudflare rate-limit binding, per-IP limits and RPC
  budget as every other `/v1` route. Extra limits: `RATE_INVESTIGATE_PER_MIN` (default 40 per IP) and
  `UPSTREAM_PER_MIN_INVESTIGATE` (default 150 RPC calls per minute per Worker instance).
- Answers are cached per Worker instance for 60 s; identical requests in flight share one set of RPC calls; if the RPC
  fails, an answer up to 15 min old is served flagged `stale` with the reason. The browser reuses answers for 45 s, shares
  identical requests and cancels them when you leave the token.
- Holders: `getTokenLargestAccounts` (finalized) → `getMultipleAccounts` for the mint and those accounts together
  (jsonParsed, `minContextSlot` = ranking slot) → `getMultipleAccounts` for the owners (0-byte data slice, account type
  only). If the owner-type read fails, the answer is marked partial instead of failing.
- Activity: `getAccountInfo` (must be a token account of this mint) → `getSignaturesForAddress` (limit 10, optional
  `before`) → `getTransaction` (jsonParsed, finalized, v0) for successful signatures only, 3 at a time. Only decoded SPL
  Token / Token-2022 `transfer`, `transferChecked`, `transferCheckedWithFee`, `mintTo(Checked)` and `burn(Checked)`
  instructions that involve the selected account are listed. Owners come only from the transaction's own token-balance
  records; anything else stays "unknown token account".
- The response contract is versioned (`kind`, `version: 1`) and the browser rejects any answer that doesn't match it
  (`src/investigate/validate.ts`), including owner totals that don't equal the sum of their accounts.

## Known limits (shown in the UI where they apply)

1. 20 largest token accounts ≠ 20 largest wallets. Owners' other token accounts are not counted.
2. Ranking and balances come from two reads; the panel shows both slots and flags accounts that changed in between.
3. Wrapped SOL: percentages use the wrapped-SOL token supply, not SOL's supply, and the panel says so.
4. Token-2022 extensions are listed; interest-bearing, scaled-UI-amount and confidential extensions are flagged because
   raw balances can differ from what wallets show.
5. A transfer inside a swap is not a payment between two people; lines through program-controlled owners (pools,
   vaults) are drawn grey and labelled. Nothing here says who owns or controls an address.
6. On very narrow screens (map under ~300 px wide) the smallest bubbles can render slightly under 24 px; zoom and the table
   remain available.
7. Per-instance caches and counters are best effort (Cloudflare runs many instances); the Cloudflare rate-limit binding is
   the hard limit, as for the rest of the API.

## Deploy (keeps every existing setting)

Before you start, write down in the Cloudflare dashboard (Workers & Pages → `bagz-api` → Settings): the variables
(including `ENABLE_LIVE_SWAPS`, `ENABLE_LIVE_BOOST_PAYMENTS`, `BAGZ_PLATFORM_FEE_BPS`, `ALLOWED_ORIGINS`), the secrets
list, the D1 binding `Db` and the `RATE_LIMITER` binding. This change does not alter any of them, and needs no new D1
migration.

1. **Secret:** make sure `HELIUS_API_KEY` (or `SOLANA_RPC_URL`) exists under *Variables and Secrets* as a **Secret**. Never
   put it in the repo, the page or `wrangler.toml`.
2. **Worker:** commit the changed files below to `arielgutierrez15/frenzy` on a branch, review, then merge to `main`. The
   connected build (root `worker`, `npx wrangler deploy`) redeploys `bagz-api`. Or from a terminal: `cd worker && npx
   wrangler deploy`. `wrangler.toml` only gained comments; its values are unchanged.
3. **Check the Worker** with the probe (it now includes an Investigate section that makes a real holder request for BONK
   and reads one token account's transfers):
   `npx tsx scripts/probe-worker.ts https://bagz-api.<you>.workers.dev --token <PROBE_TOKEN> --origin https://bagz.pages.dev`
   `investigate health` PASS only means a key is set; `investigate holders (BONK, real RPC)` PASS is what proves the key works.
4. **Site:** `npm run build` (writes `docs/index.html`; the default Worker URL is unchanged), then publish `docs/` the way
   you do now (Cloudflare Pages / GitHub Pages). For the test copy also run `npm run build:copy`.
5. **Look at it:** open a Solana token, scroll to *Investigate*, tap *Load holder map*, select a holder.

**Rollback:** redeploy the previous Worker version (Workers & Pages → `bagz-api` → Deployments → previous version →
Rollback) and republish the previous `docs/index.html`. Nothing is stored by this feature, so there is nothing to undo
in D1.

## What was verified, and how (27 Oct 2026)

Toolchain: the npm registry was not reachable from the build sandbox, so `npm ci` could not run. Checks used the
locally available packages instead: TypeScript 6.0.3 (the project pins ~5.6.3), React 19.2.8, esbuild 0.28.2, tsx 4.23.12,
Playwright's Chromium. `@types/react` is not installed, so `npm run check` uses the project's own `typecheck/shims.d.ts`
(React props are loosely typed there). As a sanity check, rebuilding `main` (after the security review, PR #16) with
this toolchain produced `docs/index.html` and `docs/demo/index.html` byte-identical to the committed ones, so the
rebuilt pages in this branch differ only by the Investigate changes.

Results on this branch (Investigate applied on top of `main` at 3026988):

| Command | Result |
|---|---|
| `npm run check` | passes |
| `npm test` | 220/220 (187 existing + 33 new: `tests/investigate-worker.test.ts` 23, `tests/investigate-client.test.ts` 10) |
| `npm run build`, `npm run build:copy` | succeed (JS 958 → 1011 KB; Investigate code ≈ 52 KB of it) |
| `npm run test:investigate` (new) | 45/45 browser checks |
| `test:browser`, `test:e2e`, `test:app`, `test:telegram`, `test:cards`, `test:social`, `test:copy`, `test:search`, `test:sync`, `test:fees` | all pass (58, 38, 33, 23, 20, 43, 31, 18, 27, 13 checks) |
| `scripts/probe-worker.ts` against a local copy of the Worker | its new Investigate section passes (health, holders, cache hit, activity, invalid mint refused, other website refused) |
| On-curve check vs an independent RFC 8032 decoder (Python) | 445 vectors, 0 mismatches; 40 real Ed25519 keys all on-curve |

**Not verified (needs the live deployment):** real Helius responses (field shapes, Token-2022 extension decoding,
`minContextSlot` behaviour, rate limits and credit cost of `getTokenLargestAccounts` / `getTransaction` on your plan);
that `HELIUS_API_KEY` is set and valid on `bagz-api`; Cloudflare's edge behaviour; real-device phone browsers and the
Telegram Mini App. The separate Observatory Worker (`gentle-credit-e478…`) is not used and was not checked. Run the
probe after deploying; a PASS on `investigate holders (BONK, real RPC)` is the first real proof.

## Changed and added files

Added: `worker/investigate.js`, `src/investigate/` (`api.ts`, `types.ts`, `validate.ts`, `units.ts`, `graph.ts`,
`layout.ts`, `market.ts`, `InvestigatePanel.tsx`, `HolderMap.tsx`, `HolderTable.tsx`, `TransferList.tsx`,
`MarketEvidence.tsx`, `investigate.css`), `tests/investigate-worker.test.ts`, `tests/investigate-client.test.ts`,
`tests/investigate-fixtures.ts`, `tests/investigate-e2e.ts`, this file.

Changed (additive): `worker/api.js` (one import + 3 lines to dispatch `/v1/investigate`), `src/views.tsx` (import, two refs,
the panel after Holders, a link from Holders), `scripts/probe-worker.ts` (Investigate section), `worker/wrangler.toml`
(comments only), `package.json` (`test:investigate` script), `README.md` (status rows), rebuilt `docs/index.html` and
`docs/demo/index.html`.

Not changed: fees, money switches, swaps, BOOST, Vault/cards, social, admin, paper trading, D1 migrations.
