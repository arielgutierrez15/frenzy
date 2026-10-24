-- Each BAGZ account's paper wallet, so it is the same on every device (phone, laptop, Telegram).
-- The Worker also creates this table by itself the first time it is needed, so running this file is optional.
-- Times are unix milliseconds.

CREATE TABLE IF NOT EXISTS wallets (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL,                  -- goes up by one on every save; a save must name the rev it started from
  data        TEXT NOT NULL,                     -- the paper wallet as JSON (cash, positions, trades, orders, theses …)
  updated_at  INTEGER NOT NULL
);
