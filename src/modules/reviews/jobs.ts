/**
 * reviews 模块 —— 异步 job 状态机 + 入库（P3）
 *
 * 与 lexicon 的 expand job 同构，但 job 状态落在 DB（review_jobs 表），
 * 因为一次 Apify 抓取是真金白银，重启丢 job 等于丢钱。
 *
 * 入库语义：
 *   - reviews 当前态：按 (review_id, asin) upsert，重复抓取不产生重复行；
 *   - 首次出现的 review_id 计入 newCount（"新增差评"监控的数据源）；
 *   - reviews_snapshot：每次抓取记一条评分分布快照，支撑趋势分析。
 */

import { getDb } from '../../db.js';
import { nowIso } from '../../util.js';
import { fetchNegativeReviews, type FetchResult } from './source.js';

export interface ReviewJobRow {
  job_id: string;
  key_id: number;
  client_id: string;
  status: 'running' | 'done' | 'error';
  args: string;
  progress: string;
  result: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface ReviewJobArgs {
  asin: string;
  countryCode?: string;
  maxReviews?: number;
}

export interface ReviewJobResult {
  asin: string;
  countryCode: string;
  fetchedAt: string;
  source: string;
  totalReturned: number;
  stored: number;
  newCount: number;
  negativeCount: number;
  avgRating: number;
  ratingDistribution: Record<string, number>;
}

export function createJob(jobId: string, keyId: number, clientId: string, args: ReviewJobArgs): void {
  getDb()
    .prepare(
      `INSERT INTO review_jobs(job_id, key_id, client_id, status, args, progress, started_at)
       VALUES (?, ?, ?, 'running', ?, '{}', ?)`,
    )
    .run(jobId, keyId, clientId, JSON.stringify(args), nowIso());
}

export function getJob(jobId: string, keyId: number): ReviewJobRow | undefined {
  return getDb()
    .prepare('SELECT * FROM review_jobs WHERE job_id = ? AND key_id = ?')
    .get(jobId, keyId) as ReviewJobRow | undefined;
}

export function countRunningJobs(): number {
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM review_jobs WHERE status = 'running'").get() as { n: number };
  return r.n;
}

interface PersistStats {
  stored: number;
  newCount: number;
  negativeCount: number;
  avgRating: number;
  ratingDistribution: Record<string, number>;
}

/** Persist fetched reviews + one snapshot atomically. */
function persist(res: FetchResult, jobId: string): PersistStats {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM reviews WHERE review_id = ? AND asin = ?');
  const upsert = db.prepare(
    `INSERT INTO reviews(review_id, asin, country_code, rating, title, body, review_date, author,
       is_verified, is_vine, helpful_votes, review_url, product_url, source, first_seen_at, last_seen_at)
     VALUES (@review_id, @asin, @country_code, @rating, @title, @body, @review_date, @author,
       @is_verified, @is_vine, @helpful_votes, @review_url, @product_url, @source, @now, @now)
     ON CONFLICT(review_id, asin) DO UPDATE SET
       rating = excluded.rating, title = excluded.title, body = excluded.body,
       review_date = excluded.review_date, helpful_votes = excluded.helpful_votes,
       last_seen_at = excluded.last_seen_at`,
  );
  const dist: Record<string, number> = {};
  let newCount = 0;
  let stored = 0;
  let sum = 0;
  const tx = db.transaction(() => {
    for (const r of res.reviews) {
      const wasNew = !exists.get(r.reviewId, r.asin);
      upsert.run({
        review_id: r.reviewId, asin: r.asin, country_code: r.countryCode, rating: r.rating,
        title: r.title, body: r.body, review_date: r.date, author: r.author,
        is_verified: r.isVerified ? 1 : 0, is_vine: r.isVine ? 1 : 0,
        helpful_votes: r.helpfulVotes, review_url: r.reviewUrl, product_url: r.productUrl,
        source: res.meta.source, now: nowIso(),
      });
      if (wasNew) newCount++;
      stored++;
      sum += r.rating;
      const bucket = String(Math.round(r.rating));
      dist[bucket] = (dist[bucket] ?? 0) + 1;
    }
    db.prepare(
      `INSERT INTO reviews_snapshot(job_id, asin, country_code, fetched_at, total_reviews,
         negative_reviews, avg_rating, rating_distribution, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId, res.asin, res.countryCode, res.meta.fetchedAt, res.reviews.length,
      res.reviews.filter((r) => r.rating <= 3).length,
      res.reviews.length ? sum / res.reviews.length : 0,
      JSON.stringify(dist), res.meta.source,
    );
  });
  tx();
  return {
    stored,
    newCount,
    negativeCount: res.reviews.filter((r) => r.rating <= 3).length,
    avgRating: res.reviews.length ? sum / res.reviews.length : 0,
    ratingDistribution: dist,
  };
}

/** Run the fetch in the background; updates review_jobs on completion. */
export async function runReviewJob(jobId: string, args: ReviewJobArgs): Promise<void> {
  const db = getDb();
  try {
    const res = await fetchNegativeReviews(args.asin, args.countryCode ?? 'US', args.maxReviews ?? 30);
    const stats = persist(res, jobId);
    const result: ReviewJobResult = {
      asin: res.asin, countryCode: res.countryCode, fetchedAt: res.meta.fetchedAt,
      source: res.meta.source, totalReturned: res.meta.totalReturned,
      ...stats,
    };
    db.prepare("UPDATE review_jobs SET status = 'done', progress = ?, result = ?, finished_at = ? WHERE job_id = ?")
      .run(JSON.stringify({ done: 1, total: 1 }), JSON.stringify(result), nowIso(), jobId);
  } catch (e) {
    db.prepare("UPDATE review_jobs SET status = 'error', error = ?, finished_at = ? WHERE job_id = ?")
      .run((e as Error).message ?? String(e), nowIso(), jobId);
  }
}
