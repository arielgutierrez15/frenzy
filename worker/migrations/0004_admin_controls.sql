-- Admin controls: kill switches, token blocklist, Vault card controls, coin adjustments and the admin audit log.
-- Apply after 0003 (Cloudflare dashboard → D1 → Console, or `npx wrangler d1 migrations apply <db> --remote`).
-- Times are unix milliseconds.

-- Kill switches and other admin settings. A switch can only turn a feature OFF; the money switches in wrangler.toml
-- (ENABLE_LIVE_SWAPS, ENABLE_LIVE_BOOST_PAYMENTS) still have to be "true" for live money to run at all.
CREATE TABLE IF NOT EXISTS admin_settings (
  key         TEXT PRIMARY KEY,                  -- 'kill:swaps', 'kill:boost', 'kill:signups', 'kill:vault', 'rewards'
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);

-- Tokens hidden from the app (lists, search, trending) and refused for BOOST orders.
CREATE TABLE IF NOT EXISTS token_blocklist (
  mint        TEXT PRIMARY KEY,
  symbol      TEXT,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL
);

-- Per-card sale controls. No row = on sale as normal.
CREATE TABLE IF NOT EXISTS card_controls (
  card_id     TEXT PRIMARY KEY,
  paused      INTEGER NOT NULL DEFAULT 0,        -- 1 = not for sale right now
  drop_at     INTEGER,                           -- not for sale before this time (scheduled drop)
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL
);

-- Every change made from the admin console. Append-only: nothing in the app updates or deletes these rows.
CREATE TABLE IF NOT EXISTS admin_audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  t       INTEGER NOT NULL,
  admin   TEXT NOT NULL,                         -- admin wallet (or @username in the test copy)
  action  TEXT NOT NULL,                         -- e.g. 'switch', 'blocklist.add', 'boost.approve', 'coins.adjust'
  target  TEXT,
  detail  TEXT                                   -- JSON
);
CREATE INDEX IF NOT EXISTS admin_audit_t ON admin_audit (t);
CREATE INDEX IF NOT EXISTS admin_audit_action ON admin_audit (action, t);
