-- 002: MCP live-fetch governance + call audit + analysis tool pricing

-- per-key live-fetch controls (admin can toggle per key)
ALTER TABLE api_keys ADD COLUMN can_live INTEGER NOT NULL DEFAULT 1;
ALTER TABLE api_keys ADD COLUMN live_daily_limit INTEGER NOT NULL DEFAULT 20;

-- audit log of every billable MCP tool call (basis for live-call quotas)
CREATE TABLE IF NOT EXISTS api_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_api_calls_key_time ON api_calls(api_key_id, created_at);

-- new analysis tools pricing (admin-adjustable in settings UI)
INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES
  ('analyze_roots', 5),
  ('rising_keywords', 3),
  ('cross_site_gap', 3),
  ('weekly_digest', 3);
