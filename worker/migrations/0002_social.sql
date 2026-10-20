-- BAGZ accounts, public profiles, leaderboard, friends, group chats, friends feed.
-- Apply after 0001 (Cloudflare dashboard → D1 → Console, or `npx wrangler d1 migrations apply <db> --remote`).
-- Times are unix milliseconds.

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  username_lc     TEXT NOT NULL UNIQUE,          -- case-insensitive uniqueness
  pass_hash       TEXT NOT NULL,                 -- PBKDF2-SHA256, base64
  pass_salt       TEXT NOT NULL,
  pass_iter       INTEGER NOT NULL,
  bio             TEXT,
  avatar_mime     TEXT,
  avatar          BLOB,                          -- small square picture, ≤ 150 KB
  avatar_ver      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                  -- sha256 of the bearer token; the token itself is never stored
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- failed-login / signup throttling (per username and per IP)
CREATE TABLE IF NOT EXISTS auth_throttle (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- paper-trading stats reported by the app (shown as "paper, reported by the app")
CREATE TABLE IF NOT EXISTS user_stats (
  user_id     TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  equity      REAL NOT NULL,
  deposits    REAL NOT NULL,
  pnl         REAL NOT NULL,
  pnl_pct     REAL NOT NULL,
  realized    REAL NOT NULL,
  win_rate    REAL NOT NULL,
  sells       INTEGER NOT NULL,
  trades      INTEGER NOT NULL,
  best_symbol TEXT,
  best_pct    REAL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_stats_pnl ON user_stats (pnl_pct);

-- public activity: paper trades and theses (profile + friends feed)
CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id  TEXT NOT NULL,                       -- the app's trade/thesis id, so a retry never duplicates
  kind       TEXT NOT NULL CHECK (kind IN ('trade', 'thesis')),
  data       TEXT NOT NULL,                       -- JSON, validated server-side
  t          INTEGER NOT NULL,
  UNIQUE (user_id, client_id)
);
CREATE INDEX IF NOT EXISTS activity_user_t ON activity (user_id, t);

-- friendships: one row per pair (user_a < user_b); status pending until the other side accepts
CREATE TABLE IF NOT EXISTS friendships (
  user_a       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  user_b       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS friendships_b ON friendships (user_b);

CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_msg_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_members (
  chat_id   TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  last_read INTEGER NOT NULL DEFAULT 0,          -- id of the last message this member has seen
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members (user_id);
CREATE TABLE IF NOT EXISTS messages (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id  TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  user_id  TEXT,                                  -- NULL for system lines ("Ana added Ben")
  body     TEXT NOT NULL,
  t        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages (chat_id, id);
