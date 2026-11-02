-- 005: keep keyword rank history after keyword deletion.
-- Rebuild run_items so keyword_id uses ON DELETE SET NULL instead of CASCADE:
-- deleting a keyword preserves its run history (keyword_id becomes NULL, keyword_text
-- stays as an identifying snapshot); re-adding the same text + site re-links the history.

CREATE TABLE run_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  keyword_id INTEGER REFERENCES keywords(id) ON DELETE SET NULL,
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
INSERT INTO run_items_new(id, run_id, keyword_id, keyword_text, mid, status, basic_count, expand_count, request_count, error, started_at, finished_at)
  SELECT id, run_id, keyword_id, keyword_text, mid, status, basic_count, expand_count, request_count, error, started_at, finished_at FROM run_items;
DROP TABLE run_items;
ALTER TABLE run_items_new RENAME TO run_items;
CREATE INDEX IF NOT EXISTS idx_run_items_run ON run_items(run_id);
CREATE INDEX IF NOT EXISTS idx_run_items_kw ON run_items(keyword_id);
CREATE INDEX IF NOT EXISTS idx_run_items_kwtext ON run_items(keyword_text, mid);
