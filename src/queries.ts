import { getDb, getSettingNum } from './db.js';
import { normalizePhrase } from './util.js';

// ---------------------------------------------------------------------------
// dashboard stats
// ---------------------------------------------------------------------------
export function getStats() {
  const db = getDb();
  const count = (sql: string, ...args: unknown[]): number =>
    (db.prepare(sql).get(...args) as { c: number }).c;

  const keywords = count("SELECT COUNT(*) c FROM keywords");
  const keywordsActive = count("SELECT COUNT(*) c FROM keywords WHERE status='active'");
  const lexicon = count('SELECT COUNT(*) c FROM lexicon');
  const lexicon7d = count("SELECT COUNT(*) c FROM lexicon WHERE first_seen_at >= datetime('now', '-7 days')");
  const suggestions = count('SELECT COUNT(*) c FROM suggestions_raw');
  const runs = count('SELECT COUNT(*) c FROM runs');
  const lastRun = db
    .prepare('SELECT id, trigger_type, status, total_keywords, done_keywords, started_at, finished_at FROM runs ORDER BY id DESC LIMIT 1')
    .get() as Record<string, unknown> | undefined;
  const errors24h = count("SELECT COUNT(*) c FROM fetch_log WHERE ok=0 AND created_at >= datetime('now', '-1 day')");
  const total24h = count("SELECT COUNT(*) c FROM fetch_log WHERE created_at >= datetime('now', '-1 day')");
  const apiKeys = count('SELECT COUNT(*) c FROM api_keys WHERE active=1');
  const creditsTotal = (db.prepare('SELECT COALESCE(SUM(credits_balance),0) c FROM api_keys WHERE active=1').get() as { c: number }).c;

  return {
    keywords,
    keywordsActive,
    lexicon,
    lexicon7d,
    suggestions,
    runs,
    lastRun: lastRun ?? null,
    fetch24h: { total: total24h, errors: errors24h },
    apiKeys,
    creditsTotal,
  };
}

// ---------------------------------------------------------------------------
// keyword snapshot: latest done run_item's basic + expand results
// ---------------------------------------------------------------------------
export function getKeywordSnapshot(keywordId: number) {
  const db = getDb();
  const kw = db
    .prepare('SELECT id, text, mid, alias, status, note FROM keywords WHERE id = ?')
    .get(keywordId) as Record<string, unknown> | undefined;
  if (!kw) return null;

  const item = db
    .prepare("SELECT id, run_id, finished_at FROM run_items WHERE keyword_id=? AND status='done' ORDER BY id DESC LIMIT 1")
    .get(keywordId) as { id: number; run_id: number; finished_at: string } | undefined;
  if (!item) return { keyword: kw, snapshot: null };

  const basic = db
    .prepare("SELECT phrase, position, strategy_id FROM suggestions_raw WHERE run_item_id=? AND source_type='basic' ORDER BY position")
    .all(item.id);
  const expandRows = db
    .prepare("SELECT phrase, position, parent_phrase, letter, strategy_id FROM suggestions_raw WHERE run_item_id=? AND source_type='expand' ORDER BY phrase COLLATE NOCASE, position")
    .all(item.id) as Array<{ phrase: string; position: number; parent_phrase: string; letter: string; strategy_id: string }>;
  const expand: Array<{ parent: string; letter: string; phrase: string; position: number }> = expandRows.map((r) => ({
    parent: r.parent_phrase, letter: r.letter, phrase: r.phrase, position: r.position,
  }));

  return { keyword: kw, snapshot: { run_id: item.run_id, fetched_at: item.finished_at, basic, expand } };
}

// ---------------------------------------------------------------------------
// rank trend matrix for one keyword across runs (basic source = searchbox rank)
// ---------------------------------------------------------------------------
export interface TrendMatrix {
  keyword: { id: number; text: string; mid: string };
  runs: Array<{ run_id: number; date: string }>;        // oldest -> newest
  rows: Array<{
    phrase: string;
    positions: Array<number | null>;                    // aligned with runs
    latest: number | null;
    prev: number | null;
    trend: 'up' | 'down' | 'same' | 'new' | 'out';
    first_seen: string;                                  // first time seen in any run
    last_seen: string;
  }>;
}

export function getTrendMatrix(keywordId: number, runsLimit = 12): TrendMatrix | null {
  const db = getDb();
  const kw = db.prepare('SELECT id, text, mid FROM keywords WHERE id = ?').get(keywordId) as
    | { id: number; text: string; mid: string }
    | undefined;
  if (!kw) return null;

  const runs = db
    .prepare(
      `SELECT DISTINCT r.id AS run_id, COALESCE(r.finished_at, r.started_at, r.created_at) AS date
       FROM runs r JOIN run_items ri ON ri.run_id = r.id
       WHERE ri.keyword_id = ? AND ri.status='done'
       ORDER BY date ASC`,
    )
    .all(keywordId) as Array<{ run_id: number; date: string }>;

  const recent = runs.slice(-Math.max(1, runsLimit));
  if (recent.length === 0) return { keyword: kw, runs: [], rows: [] };

  const runIds = recent.map((r) => r.run_id);
  const rowsRaw = db
    .prepare(
      `SELECT ri.run_id, s.phrase_norm, MIN(s.position) AS position, MAX(s.phrase) AS phrase
       FROM suggestions_raw s JOIN run_items ri ON ri.id = s.run_item_id
       WHERE s.keyword_id = ? AND s.source_type='basic' AND ri.status='done' AND ri.run_id IN (${runIds.map(() => '?').join(',')})
       GROUP BY ri.run_id, s.phrase_norm`,
    )
    .all(keywordId, ...runIds) as Array<{ run_id: number; phrase_norm: string; position: number; phrase: string }>;

  // first/last seen across ALL runs (not only recent window)
  const seenRange = db
    .prepare(
      `SELECT s.phrase_norm, MIN(COALESCE(r.finished_at, r.started_at, r.created_at)) AS first_seen,
              MAX(COALESCE(r.finished_at, r.started_at, r.created_at)) AS last_seen
       FROM suggestions_raw s JOIN run_items ri ON ri.id = s.run_item_id JOIN runs r ON r.id = ri.run_id
       WHERE s.keyword_id = ? AND s.source_type='basic' AND ri.status='done'
       GROUP BY s.phrase_norm`,
    )
    .all(keywordId) as Array<{ phrase_norm: string; first_seen: string; last_seen: string }>;
  const rangeMap = new Map(seenRange.map((r) => [r.phrase_norm, r]));

  const byPhrase = new Map<string, (number | null)[]>();
  const phraseDisplay = new Map<string, string>();
  for (const r of rowsRaw) {
    if (!byPhrase.has(r.phrase_norm)) byPhrase.set(r.phrase_norm, recent.map(() => null));
    phraseDisplay.set(r.phrase_norm, r.phrase);
    const idx = recent.findIndex((x) => x.run_id === r.run_id);
    if (idx >= 0) byPhrase.get(r.phrase_norm)![idx] = r.position;
  }

  const rows: TrendMatrix['rows'] = [];
  for (const [norm, positions] of byPhrase) {
    let latestIdx = -1;
    for (let i = positions.length - 1; i >= 0; i--) {
      if (positions[i] !== null) { latestIdx = i; break; }
    }
    const latest = latestIdx >= 0 ? (positions[latestIdx] as number) : null;
    let prev: number | null = null;
    for (let i = latestIdx - 1; i >= 0; i--) {
      if (positions[i] !== null) { prev = positions[i] as number; break; }
    }
    let trend: TrendMatrix['rows'][number]['trend'];
    if (prev === null && latest === null) trend = 'out';
    else if (prev === null) trend = 'new';
    else if (latest === null) trend = 'out';
    else if (latest < prev) trend = 'up';
    else if (latest > prev) trend = 'down';
    else trend = 'same';
    const range = rangeMap.get(norm);
    rows.push({
      phrase: phraseDisplay.get(norm) ?? norm,
      positions,
      latest,
      prev,
      trend,
      first_seen: range?.first_seen ?? '',
      last_seen: range?.last_seen ?? '',
    });
  }
  // newest-run position first, then phrase
  rows.sort((a, b) => {
    const pa = a.latest ?? 9999;
    const pb = b.latest ?? 9999;
    if (pa !== pb) return pa - pb;
    return a.phrase.localeCompare(b.phrase);
  });

  return { keyword: kw, runs: recent.map((r) => ({ run_id: r.run_id, date: r.date })), rows };
}

// ---------------------------------------------------------------------------
// lexicon search
// ---------------------------------------------------------------------------
export function searchLexicon(query: string, mid: string | undefined, limit: number, offset: number) {
  const db = getDb();
  const q = `%${normalizePhrase(query)}%`;
  const where: string[] = [];
  const args: unknown[] = [];
  if (query) { where.push('phrase_norm LIKE ?'); args.push(q); }
  if (mid) { where.push('mid = ?'); args.push(mid); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (db.prepare(`SELECT COUNT(*) c FROM lexicon ${w}`).get(...args) as { c: number }).c;
  const items = db
    .prepare(`SELECT id, mid, phrase, first_seen_at, last_seen_at, seen_count FROM lexicon ${w} ORDER BY seen_count DESC, last_seen_at DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  return { total, items };
}
