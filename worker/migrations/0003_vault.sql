-- The Vault: BAGZ Coins (earned from paper-trading challenges) and limited trading cards (30 serials each).
-- Apply after 0002 (Cloudflare dashboard → D1 → Console, or `npx wrangler d1 migrations apply <db> --remote`).
-- Times are unix milliseconds.

-- every coin movement; the balance is the sum. (reason, ref) is unique per user so a reward can't be claimed twice.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  delta    INTEGER NOT NULL,
  reason   TEXT NOT NULL,                        -- 'challenge', 'welcome', 'card'
  ref      TEXT NOT NULL,                        -- challenge id + day, or the purchase id
  t        INTEGER NOT NULL,
  UNIQUE (user_id, reason, ref)
);
CREATE INDEX IF NOT EXISTS coin_ledger_user ON coin_ledger (user_id);

-- one row per minted copy. (card_id, serial) is the scarcity guarantee: serials 1..30, never reused.
CREATE TABLE IF NOT EXISTS card_mints (
  card_id   TEXT NOT NULL,
  serial    INTEGER NOT NULL CHECK (serial BETWEEN 1 AND 30),
  user_id   TEXT REFERENCES users (id) ON DELETE SET NULL,  -- a deleted account's copy stays minted (supply never grows back)
  purchase  TEXT NOT NULL UNIQUE,
  t         INTEGER NOT NULL,
  PRIMARY KEY (card_id, serial)
);
CREATE UNIQUE INDEX IF NOT EXISTS card_mints_one_each ON card_mints (card_id, user_id);
CREATE INDEX IF NOT EXISTS card_mints_user ON card_mints (user_id);
