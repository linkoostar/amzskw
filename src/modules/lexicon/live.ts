/**
 * 联想词模块 —— live 抓取治理与持久化（P2 从 mcpserver.ts 搬入，行为逐字不变）
 *
 * 包含：
 *   - expandJobs:     异步深度挖掘 job 表（进程内，重启即丢）
 *   - liveGuard:      live 工具四层管控（调用方身份 / key 开关 / key 日限 / 全服日限）
 *   - ensureExpandCapacity: expand job 并发闸
 *   - persistLiveResults:   live 结果合并入词库 + 原始报文归档 + 自动暂停种子词
 *
 * 这些都是 lexicon 业务专属逻辑，附带对 Amazon 端点的直连抓取。
 */

import { liveFetch, randomRequestGap } from '../../crawler.js';
import { getDb, getSetting, getSettingNum } from '../../db.js';
import { reattachOrphanHistory } from '../../queries.js';
import { normalizePhrase, nowIso } from '../../util.js';
import { countLiveCallsToday, type ApiKeyRow } from '../../credits.js';
import { McpToolError } from '../../core/mcp-helpers.js';

// ---------------------------------------------------------------- expand jobs (async deep-mining)
export interface ExpandJob {
  id: string;
  keyId: number;
  clientId: string;
  args: { keyword: string; mid?: string; alias?: string; limit?: number; expand_top?: number; letters?: string };
  status: 'running' | 'done' | 'error';
  progress: { done: number; total: number };
  started_at: string;
  finished_at?: string;
  result?: unknown;
  error?: string;
}
export const expandJobs = new Map<string, ExpandJob>();
export const EXPAND_JOB_TTL_MS = 3600_000;

export function pruneExpandJobs(): void {
  const now = Date.now();
  for (const [id, j] of expandJobs) {
    if (j.status !== 'running' && j.finished_at && now - Date.parse(j.finished_at) > EXPAND_JOB_TTL_MS) expandJobs.delete(id);
  }
}

export async function runExpandJob(job: ExpandJob): Promise<void> {
  const a = job.args;
  try {
    const mid = a.mid ?? 'ATVPDKIKX0DER';
    const alias = a.alias ?? 'aps';
    const limit = Math.min(30, Math.max(1, a.limit ?? 15));
    const rawBodies: string[] = [];
    const basic = await liveFetch({ prefix: a.keyword, mid, alias, limit });
    rawBodies.push(basic.body);
    const baseWords = basic.suggestions.map((s) => s.value);
    const expandTop = Math.min(10, Math.max(0, a.expand_top ?? getSettingNum('expand_top')));
    const letters = (a.letters ?? (getSetting('alphabet') || 'abcdefghijklmnopqrstuvwxyz')).split('');
    job.progress.total = Math.max(1, expandTop * letters.length);
    const expanded: Array<{ parent: string; letter: string; phrase: string; position: number }> = [];
    const seen = new Set(baseWords.map((w) => w.toLowerCase()));
    for (const baseWord of baseWords.slice(0, expandTop)) {
      for (const letter of letters) {
        await randomRequestGap();
        try {
          const res = await liveFetch({ prefix: `${baseWord} ${letter}`, mid, alias, limit });
          rawBodies.push(res.body);
          res.suggestions.forEach((s, i) => {
            const n = s.value.toLowerCase();
            if (seen.has(n)) return;
            seen.add(n);
            expanded.push({ parent: baseWord, letter, phrase: s.value, position: i + 1 });
          });
        } catch {
          // keep going on single-letter failure
        }
        job.progress.done++;
      }
    }
    const allPhrases = [...baseWords, ...expanded.map((e) => e.phrase)];
    const { stored, autoSeedCreated } = persistLiveResults(mid, a.keyword, allPhrases, rawBodies, job.clientId);
    job.result = {
      keyword: a.keyword,
      mid,
      basic: baseWords,
      expanded,
      total_unique: seen.size,
      persisted_to_lexicon: stored,
      auto_seed_created: autoSeedCreated,
      auto_seed_note: autoSeedCreated
        ? 'the keyword was added to the seed list as PAUSED (not scheduled); the administrator can enable it for weekly harvesting'
        : undefined,
      fetched_at: new Date().toISOString(),
    };
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = (e as Error).message ?? String(e);
  } finally {
    job.finished_at = new Date().toISOString();
  }
}

/** Guard for LIVE Amazon tools: caller identity, per-key switch, per-key daily quota, global daily cap. */
export function liveGuard(key: ApiKeyRow, clientId: string): void {
  if (!clientId) {
    throw new McpToolError(
      'live fetching requires caller identification: add header "X-Client-Id: <your-agent-name>" to the MCP connection. ' +
        'The administrator uses it to attribute live calls to each agent/person sharing this API key.',
    );
  }
  if (!key.can_live) {
    throw new McpToolError('live fetching is disabled for this API key by the administrator (tool: search_*). Use lookup_lexicon / get_keyword_trends instead.');
  }
  const perKey = countLiveCallsToday(key.id);
  if (perKey >= key.live_daily_limit) {
    throw new McpToolError(`live-fetch daily limit reached for this API key (${perKey}/${key.live_daily_limit}). Resets at UTC midnight. Contact the administrator to raise the limit.`);
  }
  const global = countLiveCallsToday();
  const globalCap = getSettingNum('mcp_live_global_daily') || 200;
  if (global >= globalCap) {
    throw new McpToolError(`server-wide live-fetch daily cap reached (${global}/${globalCap}). Resets at UTC midnight. Try lookup_lexicon (accumulated data) instead.`);
  }
}

/** Concurrency guard for expand jobs, checked before charging credits. */
export function ensureExpandCapacity(): void {
  pruneExpandJobs();
  const running = [...expandJobs.values()].filter((j) => j.status === 'running').length;
  if (running >= 2) {
    throw new McpToolError('another expand job is still running (max 2 concurrent server-wide). Poll its job_id with get_expand_job and try again later.');
  }
}

/** Merge live-fetched phrases into the persistent lexicon + archive raw payloads + auto-seed a PAUSED keyword. */
export function persistLiveResults(mid: string, seedKeyword: string, phrases: string[], rawBodies: string[], clientId: string) {
  let stored = 0;
  let autoSeedCreated = false;
  if (getSettingNum('mcp_live_persist')) {
    const db = getDb();
    const up = db.prepare(
      `INSERT INTO lexicon(mid, phrase_norm, phrase, first_seen_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(mid, phrase_norm) DO UPDATE SET seen_count = seen_count + 1, last_seen_at = excluded.last_seen_at`,
    );
    const upSource = db.prepare(
      `INSERT INTO lexicon_sources(mid, phrase_norm, seed_text, source, last_seen_at)
       VALUES (?, ?, ?, 'live', ?)
       ON CONFLICT(mid, phrase_norm, seed_text, source) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    );
    const insKw = db.prepare(
      "INSERT OR IGNORE INTO keywords(text, mid, alias, status, note, source) VALUES (?, ?, 'aps', 'paused', ?, 'mcp-live')",
    );
    const seen = new Set<string>();
    const tx = db.transaction(() => {
      for (const p of phrases) {
        const norm = normalizePhrase(p);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        const ts = nowIso();
        up.run(mid, norm, p.trim(), ts, ts);
        upSource.run(mid, norm, seedKeyword.trim(), ts);
        stored++;
      }
      for (const raw of rawBodies) {
        db.prepare('INSERT INTO fetch_log(url, ok, response_body) VALUES (?, 1, ?)').run(
          `mcp://live/${mid}/${encodeURIComponent(seedKeyword)}`,
          raw.slice(0, 65536),
        );
      }
      // auto-seed: keep the fetched keyword as a PAUSED seed for possible future scheduled harvesting
      if (getSettingNum('mcp_live_auto_seed')) {
        const wc = seedKeyword.trim().split(/\s+/).length;
        const mn = getSettingNum('live_seed_min_words') || 2;
        const mx = getSettingNum('live_seed_max_words') || 5;
        if (wc >= mn && wc <= mx) {
          const note = `auto: live fetch via MCP${clientId ? ` (${clientId})` : ''} — paused, review before enabling`;
          const r = insKw.run(seedKeyword.trim(), mid, note);
          autoSeedCreated = r.changes > 0;
          if (autoSeedCreated) reattachOrphanHistory(seedKeyword.trim(), mid, Number(r.lastInsertRowid));
        }
      }
    });
    tx();
  }
  return { stored, autoSeedCreated };
}
