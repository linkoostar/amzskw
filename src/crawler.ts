import { getDb, getSetting, getSettingNum } from './db.js';
import { fetchSuggestionsOnce, FetchSuggestOptions } from './amazon.js';
import { CrawlerError, genSessionId, normalizePhrase, randFloat, randInt, shuffle, sleep, nowIso } from './util.js';

// ---------------------------------------------------------------------------
// circuit breaker (module-level, shared across runs)
// ---------------------------------------------------------------------------
let consecutiveFailures = 0;
let breakerUntil = 0;

export function breakerState(): { failures: number; pausedUntil: number } {
  return { failures: consecutiveFailures, pausedUntil: breakerUntil };
}

async function waitIfBreakerPaused(signal?: AbortSignal): Promise<void> {
  while (Date.now() < breakerUntil) {
    const waitMs = Math.min(breakerUntil - Date.now(), 5000);
    await sleep(waitMs);
    if (signal?.aborted) return;
  }
}

function noteSuccess(): void {
  consecutiveFailures = 0;
}

function noteFailure(): void {
  consecutiveFailures += 1;
  const threshold = getSettingNum('breaker_threshold');
  const pauseMs = getSettingNum('breaker_pause_ms');
  if (threshold > 0 && consecutiveFailures >= threshold) {
    breakerUntil = Date.now() + pauseMs;
    consecutiveFailures = 0;
    console.warn(`[crawler] circuit breaker OPEN for ${Math.round(pauseMs / 60000)} min after repeated failures`);
  }
}

// ---------------------------------------------------------------------------
// pacing helpers (anti-detection)
// ---------------------------------------------------------------------------
export async function randomRequestGap(): Promise<void> {
  const min = getSettingNum('request_delay_min_ms');
  const max = getSettingNum('request_delay_max_ms');
  await sleep(randInt(Math.max(0, min), Math.max(min, max)));
  // occasionally take a longer "human" pause
  const chance = Number(getSetting('pause_chance'));
  if (chance > 0 && Math.random() < chance) {
    await sleep(randInt(getSettingNum('pause_min_ms'), getSettingNum('pause_max_ms')));
  }
}

function backoffDelay(attempt: number): number {
  const base = getSettingNum('backoff_base_ms');
  const cap = getSettingNum('backoff_cap_ms');
  const exp = base * Math.pow(2, attempt - 1);
  return Math.min(cap, Math.round(exp * randFloat(0.5, 1.5)));
}

// ---------------------------------------------------------------------------
// single fetch with retry + fetch_log archive
// ---------------------------------------------------------------------------
interface TryContext {
  runItemId?: number | null;
  signal?: AbortSignal;
}

async function fetchWithRetry(opts: FetchSuggestOptions, ctx: TryContext) {
  const db = getDb();
  const maxRetries = Math.max(1, getSettingNum('max_retries'));
  const insLog = db.prepare(
    `INSERT INTO fetch_log(run_item_id, url, status_code, ok, latency_ms, attempt, response_body, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (ctx.signal?.aborted) throw new CrawlerError('aborted', 'network');
    try {
      const result = await fetchSuggestionsOnce({ ...opts, signal: ctx.signal });
      insLog.run(ctx.runItemId ?? null, result.url, result.status, 1, result.latencyMs, attempt, result.body.slice(0, 65536), '');
      noteSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      const ce = err as CrawlerError;
      const isAbort = ce.message === 'aborted';
      const retryable = !isAbort && (ce.kind !== 'http' || ce.statusCode === 429 || (ce.statusCode ?? 0) >= 500);
      insLog.run(
        ctx.runItemId ?? null,
        opts.prefix ? buildUrlForLog(opts) : '',
        ce.statusCode ?? null,
        0,
        0,
        attempt,
        '',
        ce.message.slice(0, 2000),
      );
      if (isAbort || !retryable || attempt === maxRetries) {
        noteFailure();
        throw err;
      }
      await sleep(backoffDelay(attempt));
    }
  }
  throw lastErr;
}

function buildUrlForLog(opts: FetchSuggestOptions): string {
  return `completion.amazon.com prefix="${opts.prefix}" mid=${opts.mid} alias=${opts.alias ?? 'aps'}`;
}

// ---------------------------------------------------------------------------
// run orchestration
// ---------------------------------------------------------------------------
export interface RunHandle {
  runId: number;
  controller: AbortController;
}

const activeRuns = new Map<number, AbortController>();

export function cancelRun(runId: number): boolean {
  const c = activeRuns.get(runId);
  if (!c) return false;
  getDb().prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE id=? AND status IN ('pending','running')").run(nowIso(), runId);
  c.abort();
  return true;
}

export function startRun(
  triggerType: 'weekly' | 'manual',
  keywordIds?: number[],
  onFinish?: (runId: number) => void,
): number {
  const db = getDb();
  const kws = keywordIds && keywordIds.length > 0
    ? db.prepare(`SELECT id, text, mid, alias FROM keywords WHERE id IN (${keywordIds.map(() => '?').join(',')}) AND status='active' ORDER BY id`).all(...keywordIds)
    : db.prepare("SELECT id, text, mid, alias FROM keywords WHERE status='active' ORDER BY id").all();

  if (kws.length === 0) {
    throw new Error('没有可抓取的关键词（列表为空或全部暂停）');
  }

  const runId = db.prepare('INSERT INTO runs(trigger_type, status) VALUES (?, ?)').run(triggerType, 'pending').lastInsertRowid as number;

  const insItem = db.prepare(
    'INSERT INTO run_items(run_id, keyword_id, keyword_text, mid, status) VALUES (?, ?, ?, ?, ?)',
  );
  // shuffle keyword order to look less regular
  for (const kw of shuffle(kws as Array<{ id: number; text: string; mid: string; alias: string }>)) {
    insItem.run(runId, kw.id, kw.text, kw.mid, 'pending');
  }
  db.prepare('UPDATE runs SET total_keywords = ? WHERE id = ?').run(kws.length, runId);

  const controller = new AbortController();
  activeRuns.set(runId, controller);
  // fire and forget
  void processRun(runId, controller)
    .catch((e) => console.error(`[crawler] run ${runId} crashed:`, e))
    .finally(() => {
      activeRuns.delete(runId);
      onFinish?.(runId);
    });

  return runId;
}

async function processRun(runId: number, controller: AbortController): Promise<void> {
  const db = getDb();
  const signal = controller.signal;
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(nowIso(), runId);

  const items = db.prepare("SELECT id, keyword_id, keyword_text, mid FROM run_items WHERE run_id=? ORDER BY id").all(runId) as Array<{ id: number; keyword_id: number; keyword_text: string; mid: string }>;

  for (const item of items) {
    // check cancellation via DB flag (set by cancelRun)
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    if (run.status === 'cancelled' || signal.aborted) {
      db.prepare("UPDATE run_items SET status='skipped' WHERE run_id=? AND status IN ('pending','running')").run(runId);
      db.prepare("UPDATE runs SET status='cancelled', finished_at=? WHERE id=?").run(nowIso(), runId);
      return;
    }

    db.prepare("UPDATE run_items SET status='running', started_at=? WHERE id=?").run(nowIso(), item.id);
    try {
      await waitIfBreakerPaused(signal);
      if (signal.aborted) continue;
      const { basicCount, expandCount, requestCount } = await harvestKeyword(item, signal);
      db.prepare(
        "UPDATE run_items SET status='done', basic_count=?, expand_count=?, request_count=?, finished_at=? WHERE id=?",
      ).run(basicCount, expandCount, requestCount, nowIso(), item.id);
    } catch (err) {
      const aborted = signal.aborted || (err as CrawlerError).message === 'aborted';
      db.prepare(
        "UPDATE run_items SET status=?, error=?, finished_at=? WHERE id=?",
      ).run(aborted ? 'skipped' : 'failed', String((err as Error).message ?? err).slice(0, 500), nowIso(), item.id);
      if (aborted) continue;
    } finally {
      db.prepare("UPDATE runs SET done_keywords = done_keywords + 1 WHERE id = ?").run(runId);
    }
  }

  const final = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
  if (final.status === 'running') {
    const stats = db.prepare(
      "SELECT COUNT(*) total, SUM(request_count) reqs, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) fails FROM run_items WHERE run_id=?",
    ).get(runId) as { total: number; reqs: number | null; fails: number | null };
    db.prepare("UPDATE runs SET status='done', finished_at=?, total_requests=?, error_requests=? WHERE id=?").run(
      nowIso(), stats.reqs ?? 0, stats.fails ?? 0, runId,
    );
  } else if (final.status !== 'cancelled') {
    db.prepare("UPDATE runs SET status='failed', finished_at=? WHERE id=?").run(nowIso(), runId);
  }
}

/** Harvest one keyword: basic snapshot + a-z expansion. Returns counts. */
async function harvestKeyword(
  item: { id: number; keyword_id: number; keyword_text: string; mid: string },
  signal: AbortSignal,
): Promise<{ basicCount: number; expandCount: number; requestCount: number }> {
  const db = getDb();
  const kw = db.prepare('SELECT id, text, mid, alias FROM keywords WHERE id = ?').get(item.keyword_id) as
    | { id: number; text: string; mid: string; alias: string }
    | undefined;
  if (!kw) throw new Error('keyword deleted');

  const sessionId = genSessionId(); // one browsing session per keyword
  let requestCount = 0;

  const insRaw = db.prepare(
    `INSERT INTO suggestions_raw
       (run_item_id, keyword_id, mid, phrase, phrase_norm, source_type, parent_phrase, letter, position, strategy_id, sugg_type, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertLex = db.prepare(
    `INSERT INTO lexicon(mid, phrase_norm, phrase, first_seen_at, first_seen_keyword_id, last_seen_at, seen_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(mid, phrase_norm) DO UPDATE SET
       phrase = excluded.phrase,
       last_seen_at = excluded.last_seen_at,
       seen_count = lexicon.seen_count + 1`,
  );

  const store = (
    phrase: string,
    sourceType: 'basic' | 'expand',
    position: number,
    parent: string | null,
    letter: string | null,
    strategyId: string,
    suggType: string,
    raw: unknown,
  ) => {
    insRaw.run(
      item.id, kw.id, kw.mid, phrase, normalizePhrase(phrase), sourceType, parent, letter,
      position, strategyId ?? '', suggType ?? '', JSON.stringify(raw ?? {}),
    );
    upsertLex.run(kw.mid, normalizePhrase(phrase), phrase, nowIso(), kw.id, nowIso());
  };

  // --- 1. basic snapshot ---
  const basic = await fetchWithRetry({ prefix: kw.text, mid: kw.mid, alias: kw.alias, sessionId, signal }, { runItemId: item.id, signal });
  requestCount += 1;
  let basicCount = 0;
  const basicPhrases: string[] = [];
  basic.suggestions.forEach((s, i) => {
    basicPhrases.push(s.value);
    store(s.value, 'basic', i + 1, null, null, s.strategyId ?? '', s.suggType ?? '', s.raw);
    basicCount += 1;
  });

  // --- 2. a-z expansion over top base words ---
  const expandTop = Math.max(0, getSettingNum('expand_top'));
  const alphabet = getSetting('alphabet') || 'abcdefghijklmnopqrstuvwxyz';
  let expandCount = 0;
  const seen = new Set(basicPhrases.map(normalizePhrase));

  if (expandTop > 0 && alphabet.length > 0) {
    for (const baseWord of basicPhrases.slice(0, expandTop)) {
      if (signal.aborted) break;
      // shuffle letter order per base word to avoid a-z patterns
      for (const letter of shuffle(alphabet.split(''))) {
        if (signal.aborted) break;
        await randomRequestGap();
        if (signal.aborted) break;
        try {
          const res = await fetchWithRetry(
            { prefix: `${baseWord} ${letter}`, mid: kw.mid, alias: kw.alias, sessionId, signal },
            { runItemId: item.id, signal },
          );
          requestCount += 1;
          res.suggestions.forEach((s, i) => {
            const norm = normalizePhrase(s.value);
            if (seen.has(norm)) return; // store only new discoveries per run
            seen.add(norm);
            store(s.value, 'expand', i + 1, baseWord, letter, s.strategyId ?? '', s.suggType ?? '', s.raw);
            expandCount += 1;
          });
        } catch (err) {
          if (signal.aborted || (err as CrawlerError).message === 'aborted') throw err;
          // single letter failure: log and continue
          console.warn(`[crawler] expand "${baseWord} ${letter}" failed: ${(err as Error).message}`);
        }
      }
    }
  }

  return { basicCount, expandCount, requestCount };
}

/** One-off live fetch used by MCP realtime tool (no persistence except fetch_log). */
export async function liveFetch(opts: FetchSuggestOptions) {
  return fetchWithRetry(opts, { runItemId: null });
}
