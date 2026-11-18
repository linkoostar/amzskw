-- reviews module v2 (P4): Apify token pool + watched ASIN list.
-- ADD-ONLY migration: creates new tables/settings only, never touches existing tables/data.
-- Rolling back = switch back to the previous tag (old code ignores these tables).

-- Apify token pool: multiple accounts to spread free quotas.
-- token is stored raw in DB (admin-only, session-guarded); API always returns a masked value.
CREATE TABLE IF NOT EXISTS apify_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,          -- higher = preferred
  quota_limit_usd REAL NOT NULL DEFAULT 0,      -- manually entered monthly cap (0 = unknown)
  quota_used_usd REAL NOT NULL DEFAULT 0,       -- monthly usage (auto-checked or manual fallback)
  quota_source TEXT NOT NULL DEFAULT 'manual',  -- manual | api
  quota_checked_at TEXT,
  cooldown_until TEXT,                          -- ISO timestamp; NULL = not cooling down
  last_error TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apify_tokens_enabled ON apify_tokens(enabled, priority);

-- Watched ASIN list: products tracked over time; periodic re-fetch detects new negative reviews.
CREATE TABLE IF NOT EXISTS review_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asin TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'US',
  status TEXT NOT NULL DEFAULT 'active',        -- active | paused
  note TEXT NOT NULL DEFAULT '',
  last_fetched_at TEXT,
  last_new_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(asin, country_code)
);
CREATE INDEX IF NOT EXISTS idx_review_watch_status ON review_watch(status);

-- Dual-mode Apify config: settings value wins over environment variable.
INSERT OR IGNORE INTO settings(key, value) VALUES ('apify_mode', 'mock');
INSERT OR IGNORE INTO settings(key, value) VALUES ('apify_token', '');
INSERT OR IGNORE INTO settings(key, value) VALUES ('apify_token_pool_enabled', '0');
INSERT OR IGNORE INTO settings(key, value) VALUES ('apify_max_concurrent', '2');

-- Reviews periodic scheduler (default off; empty cron = disabled).
INSERT OR IGNORE INTO settings(key, value) VALUES ('reviews_watch_cron', '');
INSERT OR IGNORE INTO settings(key, value) VALUES ('reviews_watch_jitter_max_ms', '2700000');

-- new MCP tools pricing (INSERT OR IGNORE: never overrides an admin-changed price)
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_watch_list', 1);
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_changes', 2);
