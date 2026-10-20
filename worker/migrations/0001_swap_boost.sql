-- BAGZ swaps + BOOST promotional listings. Apply with:
--   npx wrangler d1 migrations apply <database_name> --remote
-- All times are unix milliseconds. Amounts are raw integer strings (smallest token unit) to avoid float errors.

-- Every swap BAGZ builds. One row per prepared transaction; a row can be submitted at most once.
CREATE TABLE IF NOT EXISTS swaps (
  id                TEXT PRIMARY KEY,
  idempotency_key   TEXT NOT NULL UNIQUE,          -- client-generated; a retried "prepare" returns the same swap
  taker             TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  input_mint        TEXT NOT NULL,
  output_mint       TEXT NOT NULL,
  in_amount         TEXT NOT NULL,
  quoted_out        TEXT NOT NULL,
  min_out           TEXT NOT NULL,
  slippage_bps      INTEGER NOT NULL,
  fee_bps           INTEGER NOT NULL,
  fee_mint          TEXT NOT NULL,
  fee_account       TEXT NOT NULL,
  message_hash      TEXT NOT NULL,                 -- sha256 of the exact message the wallet must sign
  tx_b64            TEXT NOT NULL,                 -- the unsigned transaction BAGZ returned (a retried prepare gets the same one)
  quote_json        TEXT NOT NULL,                 -- the quote shown to the user before signing
  last_valid_height INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('prepared', 'submitting', 'sent', 'confirmed', 'failed', 'expired')),
  signature         TEXT UNIQUE,
  fee_collected     TEXT,                          -- raw amount the fee account actually received (verified on-chain)
  error             TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS swaps_taker ON swaps (taker, created_at);
CREATE INDEX IF NOT EXISTS swaps_status ON swaps (status, updated_at);

-- Sponsored listing campaigns (one per paid order).
CREATE TABLE IF NOT EXISTS promotions (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  mint            TEXT NOT NULL,
  symbol          TEXT,
  name            TEXT,
  icon            TEXT,
  package         TEXT NOT NULL CHECK (package IN ('starter', 'boost', 'prime', 'spotlight')),
  price_raw       TEXT NOT NULL,                   -- USDC raw units (6 decimals)
  duration_ms     INTEGER NOT NULL,
  advertiser      TEXT NOT NULL,                   -- wallet that pays
  reference       TEXT NOT NULL UNIQUE,            -- Solana Pay reference key tying the payment to this order
  status          TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'pending_review', 'approved', 'rejected', 'cancelled', 'expired_unpaid')),
  message_hash    TEXT,                            -- payment transaction BAGZ built, if paid through the app
  starts_at       INTEGER,
  ends_at         INTEGER,
  reviewed_by     TEXT,
  review_note     TEXT,
  created_at      INTEGER NOT NULL,
  pay_by          INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS promotions_status ON promotions (status, starts_at, ends_at);
CREATE INDEX IF NOT EXISTS promotions_mint ON promotions (mint);

-- Verified payments. A transaction signature can pay for exactly one order, ever.
CREATE TABLE IF NOT EXISTS payments (
  signature     TEXT PRIMARY KEY,
  promotion_id  TEXT NOT NULL UNIQUE REFERENCES promotions (id),
  payer         TEXT NOT NULL,
  mint          TEXT NOT NULL,
  amount_raw    TEXT NOT NULL,
  destination   TEXT NOT NULL,
  slot          INTEGER,
  block_time    INTEGER,
  verified_at   INTEGER NOT NULL
);

-- Campaign analytics: daily totals plus a short-lived de-duplication table so one viewer is counted once per window.
CREATE TABLE IF NOT EXISTS campaign_stats (
  promotion_id TEXT NOT NULL REFERENCES promotions (id),
  day          TEXT NOT NULL,                      -- YYYY-MM-DD (UTC)
  impressions  INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (promotion_id, day)
);
CREATE TABLE IF NOT EXISTS campaign_event_seen (
  key        TEXT PRIMARY KEY,                     -- promotion|type|viewer-hash|window
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS campaign_event_seen_age ON campaign_event_seen (created_at);

-- Admin sign-in: single-use challenges signed by an allow-listed admin wallet.
CREATE TABLE IF NOT EXISTS admin_challenges (
  nonce      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
