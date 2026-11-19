/**
 * reviews 模块 —— MCP 工具定义（P3）
 *
 * 5 个工具，命名带 reviews_ 前缀避免与 lexicon 冲突：
 *   - reviews_fetch       LIVE 抓取（异步 job），≤3 星过滤，入付费数据源；
 *   - reviews_get_job     轮询 job 状态/结果；
 *   - reviews_query       查本地库（评分/关键词/时间过滤）；
 *   - reviews_summary     某 ASIN 的评分分布 + 差评主题词 + 随时间趋势；
 *   - reviews_new_negative 最近抓取中首次出现的差评（"新增差评"监控）。
 *
 * 计费语义与 lexicon 完全一致：billable 包装，precheck 拒绝不扣费。
 * 定价从 tool_pricing 表读（迁移 010 里 INSERT 默认值）。
 */

import { z } from 'zod';
import { getDb, getSettingNum } from '../../db.js';
import { billable, McpToolError } from '../../core/mcp-helpers.js';
import type { ApiKeyRow } from '../../credits.js';
import { isMockMode } from './source.js';
import { maxConcurrent } from './token-pool.js';
import { createJob, getJob, countRunningJobs, runReviewJob, type ReviewJobArgs } from './jobs.js';
import type { ToolBuildContext, ToolContribution } from '../types.js';

/** Count today's reviews_fetch calls. Kept module-local so the shared
 *  countLiveCallsToday (hardcoded to lexicon's live tools) stays untouched —
 *  zero regression risk for the production lexicon module. */
function countReviewsCallsToday(apiKeyId?: number): number {
  const scope = apiKeyId ? 'AND api_key_id = ?' : '';
  const args = apiKeyId ? [apiKeyId] : [];
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM api_calls WHERE tool = 'reviews_fetch' ${scope}
       AND created_at >= datetime('now', 'start of day')`,
    )
    .get(...args) as { c: number };
  return row.c;
}

/** LIVE guard for the paid review source. Reuses the per-key can_live switch and
 *  per-key daily quota, but uses its own global cap setting so paid fetches do not
 *  starve / get starved by lexicon's free Amazon calls. */
function reviewsLiveGuard(key: ApiKeyRow, clientId: string): void {
  if (!clientId) {
    throw new McpToolError(
      'reviews_fetch requires caller identification: add header "X-Client-Id: <your-agent-name>" to the MCP connection.',
    );
  }
  if (!key.can_live) {
    throw new McpToolError('live fetching is disabled for this API key by the administrator (reviews_fetch).');
  }
  const perKey = countReviewsCallsToday(key.id);
  if (perKey >= key.live_daily_limit) {
    throw new McpToolError(`live-fetch daily limit reached for this API key (${perKey}/${key.live_daily_limit}). Resets at UTC midnight.`);
  }
  const global = countReviewsCallsToday();
  const globalCap = getSettingNum('reviews_global_daily') || 50;
  if (global >= globalCap) {
    throw new McpToolError(`server-wide reviews-fetch daily cap reached (${global}/${globalCap}). Resets at UTC midnight. Query stored data with reviews_query instead.`);
  }
  if (countRunningJobs() >= maxConcurrent()) {
    throw new McpToolError(`another review fetch job is still running (max ${maxConcurrent()} concurrent server-wide). Poll reviews_get_job and retry later.`);
  }
}

export function buildReviewsTools({ key, clientId }: ToolBuildContext): ToolContribution[] {
  return [
    {
      name: 'reviews_fetch',
      description:
        'ASYNCHRONOUS fetch of Amazon product reviews (<=3 stars) via the Apify Amazon Reviews Scraper. ' +
        'Starts a background job and returns a job_id IMMEDIATELY (fits any gateway timeout). ' +
        'Poll reviews_get_job with the job_id until status="done" to get results; reviews are auto-persisted to the local DB. ' +
        'GOVERNANCE: requires X-Client-Id; per-key daily quota + server-wide cap; credits charged at start. ' +
        'The rating filter is applied at the source so filtered-out rows are not billed.',
      inputSchema: {
        asin: z.string().describe('Amazon ASIN, e.g. "B0DWF7823H"'),
        country_code: z.string().optional().default('US').describe('Marketplace country code, default US'),
        max_reviews: z.number().optional().default(30).describe('Max reviews to fetch (1-100, default 30)'),
      },
      handler: billable(
        key, clientId, 'reviews_fetch',
        async (args: { asin: string; country_code?: string; max_reviews?: number }) => {
          const asin = String(args.asin ?? '').trim().toUpperCase();
          if (!/^[A-Z0-9]{10}$/.test(asin)) throw new McpToolError(`invalid ASIN "${args.asin}" (expected 10 uppercase letters/digits)`);
          const a: ReviewJobArgs = {
            asin,
            countryCode: (args.country_code ?? 'US').toUpperCase(),
            maxReviews: Math.min(100, Math.max(1, Math.round(args.max_reviews ?? 30))),
          };
          const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          createJob(id, key.id, clientId, a);
          void runReviewJob(id, a);
          return {
            job_id: id,
            status: 'running',
            asin: a.asin,
            country_code: a.countryCode,
            mode: isMockMode() ? 'mock' : 'apify',
            how_to_get_results: 'poll tool reviews_get_job with {"job_id": "' + id + '"} every 5-10 seconds until status is "done"',
            note: 'credits charged at start; the job keeps running server-side even if you disconnect',
          };
        },
        () => reviewsLiveGuard(key, clientId),
      ),
      live: true,
    },
    {
      name: 'reviews_get_job',
      description:
        'Poll the status/result of an asynchronous reviews_fetch job. Returns the fetch stats once status="done". ' +
        'Job state is persisted in the DB, so it survives a server restart.',
      inputSchema: {
        job_id: z.string().describe('The job_id returned by reviews_fetch'),
      },
      handler: billable(key, clientId, 'reviews_get_job', async (args: { job_id: string }) => {
        const job = getJob(args.job_id, key.id);
        if (!job) throw new McpToolError(`review job not found: "${args.job_id}" (may belong to a different API key).`);
        const base = { job_id: job.job_id, status: job.status, started_at: job.started_at, finished_at: job.finished_at };
        if (job.status === 'running') return { ...base, hint: 'poll again in 5-10 seconds' };
        if (job.status === 'error') return { ...base, error: job.error };
        return { ...base, result: job.result ? JSON.parse(job.result) : null };
      }),
    },
    {
      name: 'reviews_query',
      description:
        'Query locally stored negative reviews (<=3 stars). No external call, no Apify cost. ' +
        'Filter by ASIN, rating, keyword (title/body), and date; results are most-recent first.',
      inputSchema: {
        asin: z.string().optional().describe('Filter by exact ASIN'),
        rating: z.number().optional().describe('Filter by exact star rating (1-3)'),
        keyword: z.string().optional().describe('Substring match in title or body'),
        limit: z.number().optional().default(30).describe('Max rows (default 30, max 100)'),
        offset: z.number().optional().default(0),
      },
      handler: billable(key, clientId, 'reviews_query', async (args: { asin?: string; rating?: number; keyword?: string; limit?: number; offset?: number }) => {
        const db = getDb();
        const where: string[] = ['rating <= 3'];
        const params: any[] = [];
        if (args.asin) { where.push('asin = ?'); params.push(args.asin.trim().toUpperCase()); }
        if (args.rating) { where.push('rating = ?'); params.push(args.rating); }
        if (args.keyword) { where.push('(title LIKE ? OR body LIKE ?)'); const k = `%${args.keyword}%`; params.push(k, k); }
        const clause = where.join(' AND ');
        const limit = Math.min(100, Math.max(1, args.limit ?? 30));
        const offset = Math.max(0, args.offset ?? 0);
        const total = (db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE ${clause}`).get(...params) as { n: number }).n;
        const items = db.prepare(
          `SELECT review_id, asin, country_code, rating, title, body, review_date, author,
                  is_verified, helpful_votes, review_url, first_seen_at
           FROM reviews WHERE ${clause} ORDER BY review_date DESC, id DESC LIMIT ? OFFSET ?`,
        ).all(...params, limit, offset);
        return { total, limit, offset, items };
      }),
    },
    {
      name: 'reviews_summary',
      description:
        'Aggregate intelligence for an ASIN: rating distribution, average rating, top complaint keywords, ' +
        'and how the rating mix changed across fetches (trend). Built from locally stored snapshots — no external call.',
      inputSchema: {
        asin: z.string().describe('Amazon ASIN'),
        snapshots: z.number().optional().default(10).describe('How many recent snapshots to include (default 10)'),
      },
      handler: billable(key, clientId, 'reviews_summary', async (args: { asin: string; snapshots?: number }) => {
        const db = getDb();
        const asin = args.asin.trim().toUpperCase();
        const current = db.prepare(
          `SELECT COUNT(*) AS total, AVG(rating) AS avg_rating,
                  SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) AS negative,
                  SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS one_star,
                  SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS two_star,
                  SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS three_star,
                  SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS four_star,
                  SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS five_star
           FROM reviews WHERE asin = ?`,
        ).get(asin) as Record<string, number>;
        const trend = db.prepare(
          `SELECT fetched_at, total_reviews, negative_reviews, avg_rating, rating_distribution
           FROM reviews_snapshot WHERE asin = ? ORDER BY fetched_at DESC LIMIT ?`,
        ).all(asin, Math.min(52, Math.max(1, args.snapshots ?? 10)));
        // simple complaint word frequency from titles+bodies of <=3 star reviews
        const texts = db.prepare('SELECT title, body FROM reviews WHERE asin = ? AND rating <= 3').all(asin) as Array<{ title: string | null; body: string | null }>;
        const stop = new Set(['the','a','an','and','or','but','is','was','it','this','that','to','of','for','i','my','me','not','with','on','in','at','be','are','were','have','has','had','do','does','did','so','if','as','very','just','get','got','one','would','could','really','about','they','you','your','from','out','up','off','all','can','will','there','here','what','when','than','then','too','more','much','some','any','only','into','over','after','before','its','these','those','am','isnt','dont','didnt','wont']);
        const freq: Record<string, number> = {};
        for (const t of texts) {
          const words = `${t.title ?? ''} ${t.body ?? ''}`.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/);
          for (const w of words) {
            if (w.length < 4 || stop.has(w)) continue;
            freq[w] = (freq[w] ?? 0) + 1;
          }
        }
        const topKeywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([word, count]) => ({ word, count }));
        const product = db.prepare(
          'SELECT title, brand, stars, ratings_count, reviews_count FROM review_products WHERE asin = ? LIMIT 1',
        ).get(asin) as Record<string, unknown> | undefined;
        return { asin, product: product ?? null, current, trend, topKeywords };
      }),
    },
    {
      name: 'reviews_new_negative',
      description:
        'Negative reviews first seen in recent fetch jobs (newly appearing complaints). ' +
        'Uses first_seen_at so a repeated fetch never re-reports the same review. No external call.',
      inputSchema: {
        asin: z.string().optional().describe('Filter by exact ASIN'),
        since_hours: z.number().optional().default(168).describe('Only reviews first seen within N hours (default 168 = 7 days)'),
        limit: z.number().optional().default(30).describe('Max rows (default 30, max 100)'),
      },
      handler: billable(key, clientId, 'reviews_new_negative', async (args: { asin?: string; since_hours?: number; limit?: number }) => {
        const db = getDb();
        const hours = Math.min(8760, Math.max(1, args.since_hours ?? 168));
        const params: any[] = [`-${hours} hours`];
        // first_seen_at may be ISO (with T/Z) or SQLite datetime (space); normalize both.
        let sql = `SELECT review_id, asin, rating, title, body, review_date, helpful_votes, review_url, first_seen_at
                   FROM reviews WHERE rating <= 3
                     AND replace(replace(first_seen_at, 'T', ' '), 'Z', '') >= datetime('now', ?)`;
        if (args.asin) { sql += ' AND asin = ?'; params.push(args.asin.trim().toUpperCase()); }
        sql += ' ORDER BY first_seen_at DESC LIMIT ?';
        params.push(Math.min(100, Math.max(1, args.limit ?? 30)));
        const items = db.prepare(sql).all(...params);
        return { since_hours: hours, asin: args.asin ?? null, total: items.length, items };
      }),
    },
    {
      name: 'reviews_watch_list',
      description:
        'List the monitored ASIN watch list (products tracked over time for negative-review changes). ' +
        'Reads local data only — no external call. Use with reviews_changes to see how each product\'s reviews evolved.',
      inputSchema: {},
      handler: billable(key, clientId, 'reviews_watch_list', async () => {
        const items = getDb().prepare(
          `SELECT asin, country_code, status, note, last_fetched_at, last_new_count, created_at
           FROM review_watch ORDER BY status DESC, id DESC`,
        ).all();
        return { total: (items as unknown[]).length, items };
      }),
    },
    {
      name: 'reviews_changes',
      description:
        'How negative reviews changed across fetch runs: per-snapshot deltas (total/negative/avg rating) and ' +
        'reviews newly first-seen in the last N hours. Reads stored snapshots only — no external call. ' +
        'Omit asin to see changes across all monitored products.',
      inputSchema: {
        asin: z.string().optional().describe('Filter by exact ASIN (omit for all)'),
        hours: z.number().optional().default(720).describe('Window for newly-seen reviews (default 720 = 30 days)'),
      },
      handler: billable(key, clientId, 'reviews_changes', async (args: { asin?: string; hours?: number }) => {
        const db = getDb();
        const asin = args.asin?.trim().toUpperCase() ?? '';
        const hours = Math.min(8760, Math.max(1, args.hours ?? 720));
        const snaps = db.prepare(
          `SELECT asin, fetched_at, total_reviews, negative_reviews, avg_rating
           FROM reviews_snapshot ${asin ? 'WHERE asin = ?' : ''} ORDER BY asin, fetched_at DESC`,
        ).all(...(asin ? [asin] : [])) as Array<Record<string, unknown>>;
        const byAsin: Record<string, any[]> = {};
        for (const s of snaps) (byAsin[String(s.asin)] ??= []).push(s);
        const timeline: Array<Record<string, unknown>> = [];
        for (const [a, list] of Object.entries(byAsin)) {
          for (let i = 0; i < Math.min(list.length, 12); i++) {
            const cur = list[i]; const prev = list[i + 1];
            timeline.push({
              asin: a, fetched_at: cur.fetched_at,
              total_reviews: cur.total_reviews, negative_reviews: cur.negative_reviews, avg_rating: cur.avg_rating,
              delta_total: prev ? Number(cur.total_reviews) - Number(prev.total_reviews) : null,
              delta_negative: prev ? Number(cur.negative_reviews) - Number(prev.negative_reviews) : null,
              delta_avg: prev ? Number((Number(cur.avg_rating) - Number(prev.avg_rating)).toFixed(2)) : null,
            });
          }
        }
        const np: any[] = [`-${hours} hours`];
        let ns = `SELECT review_id, asin, rating, title, body, review_date, first_seen_at FROM reviews
                  WHERE rating <= 3 AND replace(replace(first_seen_at,'T',' '),'Z','') >= datetime('now', ?)`;
        if (asin) { ns += ' AND asin = ?'; np.push(asin); }
        ns += ' ORDER BY first_seen_at DESC LIMIT 100';
        const newReviews = db.prepare(ns).all(...np);
        return { asin: asin || null, hours, timeline, newReviews };
      }),
    },
  ];
}
