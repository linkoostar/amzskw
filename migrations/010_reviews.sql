-- reviews module (P3): negative review intelligence from Apify.
-- ADD-ONLY migration: creates new tables only, never touches existing tables/data.
-- Rolling back = switch back to the previous tag (old code ignores these tables).

-- current state: one row per review_id (upsert on re-fetch)
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'US',
  rating REAL NOT NULL,
  title TEXT,
  body TEXT,
  review_date TEXT,
  author TEXT,
  is_verified INTEGER NOT NULL DEFAULT 0,
  is_vine INTEGER NOT NULL DEFAULT 0,
  helpful_votes INTEGER NOT NULL DEFAULT 0,
  review_url TEXT,
  product_url TEXT,
  source TEXT NOT NULL DEFAULT 'apify',
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(review_id, asin)
);
CREATE INDEX IF NOT EXISTS idx_reviews_asin_rating ON reviews(asin, rating);
CREATE INDEX IF NOT EXISTS idx_reviews_date ON reviews(review_date);

-- each fetch run: a snapshot of rating distribution + counts, for trend over time
CREATE TABLE IF NOT EXISTS reviews_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  asin TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT 'US',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  total_reviews INTEGER NOT NULL DEFAULT 0,
  negative_reviews INTEGER NOT NULL DEFAULT 0,
  avg_rating REAL NOT NULL DEFAULT 0,
  rating_distribution TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'apify'
);
CREATE INDEX IF NOT EXISTS idx_reviews_snap_asin_time ON reviews_snapshot(asin, fetched_at);

-- async job state (persisted so a server restart does not lose a paid Apify fetch)
CREATE TABLE IF NOT EXISTS review_jobs (
  job_id TEXT PRIMARY KEY,
  key_id INTEGER NOT NULL,
  client_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',   -- running | done | error
  args TEXT NOT NULL DEFAULT '{}',
  progress TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_review_jobs_key ON review_jobs(key_id, started_at);

-- tool pricing (INSERT OR IGNORE: never overrides an admin-changed price)
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_fetch', 40);
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_get_job', 0);
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_query', 1);
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_summary', 2);
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES ('reviews_new_negative', 2);

-- governance setting: server-wide daily cap for paid review fetches
INSERT OR IGNORE INTO settings(key, value) VALUES ('reviews_global_daily', '50');
