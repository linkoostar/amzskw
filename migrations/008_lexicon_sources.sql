-- 008: provenance for lexicon phrases.
-- Scheduled harvests write suggestions_raw, but live MCP fetches only wrote lexicon.
-- Without provenance, "purge keyword" could not know which lexicon rows came from a
-- live seed. Track (site, phrase, seed, source) and backfill existing data.

CREATE TABLE IF NOT EXISTS lexicon_sources (
  mid TEXT NOT NULL,
  phrase_norm TEXT NOT NULL,
  seed_text TEXT NOT NULL COLLATE NOCASE,
  source TEXT NOT NULL,             -- schedule | live
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (mid, phrase_norm, seed_text, source)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_ls_seed ON lexicon_sources(mid, seed_text);
CREATE INDEX IF NOT EXISTS idx_ls_norm ON lexicon_sources(mid, phrase_norm);

-- backfill from scheduled harvest snapshots
INSERT OR IGNORE INTO lexicon_sources(mid, phrase_norm, seed_text, source, last_seen_at)
SELECT s.mid, s.phrase_norm, ri.keyword_text, 'schedule', MAX(s.fetched_at)
FROM suggestions_raw s
JOIN run_items ri ON ri.id = s.run_item_id
GROUP BY s.mid, s.phrase_norm, ri.keyword_text;

-- backfill from archived live MCP responses: url = mcp://live/<mid>/<encoded seed>,
-- body carries the real prefix and suggestion values
INSERT OR IGNORE INTO lexicon_sources(mid, phrase_norm, seed_text, source, last_seen_at)
SELECT l.mid,
       l.phrase_norm,
       json_extract(f.response_body, '$.prefix'),
       'live',
       f.created_at
FROM fetch_log f
JOIN json_each(f.response_body, '$.suggestions') j
JOIN lexicon l
  ON l.mid = substr(f.url, 12, instr(substr(f.url, 12), '/') - 1)
 AND l.phrase_norm = norm(json_extract(j.value, '$.value'))
WHERE f.url LIKE 'mcp://live/%'
  AND f.ok = 1
  AND json_valid(f.response_body)
  AND json_extract(f.response_body, '$.prefix') IS NOT NULL
  AND json_extract(f.response_body, '$.prefix') <> '';
