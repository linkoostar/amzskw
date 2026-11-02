-- sites: supported Amazon marketplaces (seeded at startup)
CREATE TABLE IF NOT EXISTS sites (
  mid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  flag TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'en-US',
  sort INTEGER NOT NULL DEFAULT 0
);

-- keywords: seed keywords to harvest
CREATE TABLE IF NOT EXISTS keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  mid TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER',
  alias TEXT NOT NULL DEFAULT 'aps',
  status TEXT NOT NULL DEFAULT 'active',            -- active | paused
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(text COLLATE NOCASE, mid, alias)
);
CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords(status);

-- runs: one harvest batch (weekly scheduled or manual)
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_type TEXT NOT NULL,                       -- weekly | manual
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | running | done | failed | cancelled
  total_keywords INTEGER NOT NULL DEFAULT 0,
  done_keywords INTEGER NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  error_requests INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- run_items: per keyword per run
CREATE TABLE IF NOT EXISTS run_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  keyword_text TEXT NOT NULL,
  mid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | running | done | failed | skipped
  basic_count INTEGER NOT NULL DEFAULT 0,
  expand_count INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_items_run ON run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_run_items_kw ON run_items(keyword_id);

-- suggestions_raw: every suggestion as returned, per snapshot (source of truth, archived)
CREATE TABLE IF NOT EXISTS suggestions_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_item_id INTEGER NOT NULL REFERENCES run_items(id) ON DELETE CASCADE,
  keyword_id INTEGER NOT NULL,
  mid TEXT NOT NULL,
  phrase TEXT NOT NULL,
  phrase_norm TEXT NOT NULL,
  source_type TEXT NOT NULL,                        -- basic | expand
  parent_phrase TEXT,                               -- for expand: base word
  letter TEXT,                                      -- appended char
  position INTEGER NOT NULL,                        -- order as returned by Amazon
  strategy_id TEXT NOT NULL DEFAULT '',
  sugg_type TEXT NOT NULL DEFAULT '',
  raw_json TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_raw_kw ON suggestions_raw(keyword_id, source_type, position);
CREATE INDEX IF NOT EXISTS idx_raw_item ON suggestions_raw(run_item_id);
CREATE INDEX IF NOT EXISTS idx_raw_norm ON suggestions_raw(mid, phrase_norm);

-- lexicon: global normalized dictionary (dedup across seeds/runs)
CREATE TABLE IF NOT EXISTS lexicon (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mid TEXT NOT NULL,
  phrase_norm TEXT NOT NULL,
  phrase TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  first_seen_keyword_id INTEGER,
  last_seen_at TEXT NOT NULL,
  seen_count INTEGER NOT NULL DEFAULT 1,
  UNIQUE(mid, phrase_norm)
);
CREATE INDEX IF NOT EXISTS idx_lexicon_norm ON lexicon(mid, phrase_norm);

-- fetch_log: archived raw HTTP exchanges (audit trail in case API dies)
CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_item_id INTEGER,
  url TEXT NOT NULL,
  status_code INTEGER,
  ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 1,
  response_body TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at);

-- api_keys: MCP consumers
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,                         -- display only (first 12 chars)
  key_hash TEXT NOT NULL UNIQUE,                    -- sha256 hex
  active INTEGER NOT NULL DEFAULT 1,
  credits_balance INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT
);

-- credits_ledger: append-only credits history
CREATE TABLE IF NOT EXISTS credits_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,                           -- positive topup / negative charge
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,                             -- topup | tool_call | adjust | bonus
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_key ON credits_ledger(api_key_id, created_at);

-- tool_pricing: credits charged per MCP tool call
CREATE TABLE IF NOT EXISTS tool_pricing (
  tool TEXT PRIMARY KEY,
  price INTEGER NOT NULL DEFAULT 0
);

-- settings: key-value runtime config
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- sessions: admin web sessions
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
