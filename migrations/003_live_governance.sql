-- 003: live-fetch caller identity + auto-seed controls

ALTER TABLE api_calls ADD COLUMN client_id TEXT NOT NULL DEFAULT '';

INSERT OR IGNORE INTO settings(key, value) VALUES
  ('mcp_live_auto_seed', '1'),
  ('live_seed_min_words', '2'),
  ('live_seed_max_words', '5');
