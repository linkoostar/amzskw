/**
 * reviews 模块 —— 后台管理 API（P3-3）
 *
 * 管理员在 Web 后台触发抓取 / 查看差评走这里（session 鉴权，server.ts 的 onRequest hook 统一保护 /api/*），
 * 不走 MCP 的 API key + credits 计费路径。这样后台操作和 agent 调用互不干扰：
 *   - agent 通过 MCP tools（reviews_*）按 credits 计费；
 *   - 管理员通过本 API 直接读库 / 触发 job，不扣费。
 *
 * 本文件由 reviews 模块自注册，核心 routes.ts / server.ts 零业务改动。
 */

import type { FastifyInstance } from 'fastify';
import { getDb, getSettingNum } from '../../db.js';
import { isMockMode } from './source.js';
import { createJob, runReviewJob, countRunningJobs, type ReviewJobArgs } from './jobs.js';

/** 后台触发的 job 记在 admin key_id=0 名下，与任何真实 API key 隔离。 */
const ADMIN_KEY_ID = 0;
const ADMIN_CLIENT = 'admin-ui';

function validAsin(v: unknown): string | null {
  const s = String(v ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(s) ? s : null;
}

/** 供模块契约挂载：把 reviews 的后台 API 注册到 app。 */
export function registerReviewsAdminApi(app: FastifyInstance): void {
  // 概览：库内差评统计 + 抓取模式 + 最近 job
  app.get('/api/reviews/overview', async () => {
    const db = getDb();
    const totals = db.prepare(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT asin) AS asins,
              COALESCE(ROUND(AVG(rating), 2), 0) AS avg_rating,
              SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) AS negative2
       FROM reviews WHERE rating <= 3`,
    ).get() as { total: number; asins: number; avg_rating: number; negative2: number };
    const perAsin = db.prepare(
      `SELECT asin, country_code, COUNT(*) AS total,
              COALESCE(ROUND(AVG(rating), 2), 0) AS avg_rating,
              SUM(CASE WHEN rating <= 2 THEN 1 ELSE 0 END) AS negative2,
              MAX(review_date) AS latest_review
       FROM reviews WHERE rating <= 3 GROUP BY asin, country_code ORDER BY total DESC`,
    ).all() as Array<Record<string, unknown>>;
    const jobs = db.prepare(
      `SELECT job_id, status, args, result, error, started_at, finished_at
       FROM review_jobs ORDER BY started_at DESC LIMIT 20`,
    ).all() as Array<Record<string, unknown>>;
    // 解析 job.args 里的 asin 供前端直接显示
    for (const j of jobs) {
      try { (j as any).asin = JSON.parse(String(j.args)).asin; } catch { (j as any).asin = null; }
      delete (j as any).args;
    }
    return {
      mode: isMockMode() ? 'mock' : 'apify',
      totals, perAsin, jobs,
      governance: {
        global_daily: getSettingNum('reviews_global_daily') || 50,
        used_today: (db.prepare(
          `SELECT COUNT(*) AS n FROM review_jobs WHERE started_at >= datetime('now','start of day')`,
        ).get() as { n: number }).n,
        running: countRunningJobs(),
        max_concurrent: 2,
      },
    };
  });

  // 差评列表（只读，直接查库，不扣 credits）
  app.get('/api/reviews/list', async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const db = getDb();
    const where: string[] = ['rating <= 3'];
    const params: any[] = [];
    if (q.asin) { where.push('asin = ?'); params.push(String(q.asin).trim().toUpperCase()); }
    if (q.rating) { where.push('rating = ?'); params.push(Number(q.rating)); }
    if (q.keyword) {
      where.push('(title LIKE ? OR body LIKE ?)');
      const k = `%${q.keyword}%`; params.push(k, k);
    }
    const clause = where.join(' AND ');
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 30));
    const offset = Math.max(0, Number(q.offset) || 0);
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM reviews WHERE ${clause}`).get(...params) as { n: number }).n;
    const items = db.prepare(
      `SELECT review_id, asin, country_code, rating, title, body, review_date, author,
              is_verified, is_vine, helpful_votes, review_url, first_seen_at
       FROM reviews WHERE ${clause}
       ORDER BY review_date DESC, id DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset);
    return { total, limit, offset, items };
  });

  // 单 ASIN 摘要：评分分布 + 主题词 + 快照趋势
  app.get('/api/reviews/summary', async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const asin = String(q.asin ?? '').trim().toUpperCase();
    if (!asin) return { error: 'asin required' };
    const db = getDb();
    const current = db.prepare(
      `SELECT COUNT(*) AS total, COALESCE(ROUND(AVG(rating),2),0) AS avg_rating,
              SUM(CASE WHEN rating=1 THEN 1 ELSE 0 END) AS s1,
              SUM(CASE WHEN rating=2 THEN 1 ELSE 0 END) AS s2,
              SUM(CASE WHEN rating=3 THEN 1 ELSE 0 END) AS s3
       FROM reviews WHERE asin = ? AND rating <= 3`,
    ).get(asin);
    const trend = db.prepare(
      `SELECT fetched_at, total_reviews, negative_reviews, avg_rating, rating_distribution
       FROM reviews_snapshot WHERE asin = ? ORDER BY fetched_at DESC LIMIT 12`,
    ).all(asin) as Array<Record<string, unknown>>;
    for (const t of trend) {
      try { (t as any).dist = JSON.parse(String(t.rating_distribution)); } catch { (t as any).dist = {}; }
      delete (t as any).rating_distribution;
    }
    const texts = db.prepare('SELECT title, body FROM reviews WHERE asin = ? AND rating <= 3').all(asin) as Array<{ title: string | null; body: string | null }>;
    const stop = new Set(['the','a','an','and','or','but','is','was','it','this','that','to','of','for','i','my','me','not','with','on','in','at','be','are','were','have','has','had','do','does','did','so','if','as','very','just','get','got','one','would','could','really','about','they','you','your','from','out','up','off','all','can','will','there','here','what','when','than','then','too','more','much','some','any','only','into','over','after','before','its','these','those','product','item']);
    const freq: Record<string, number> = {};
    for (const t of texts) {
      const words = `${t.title ?? ''} ${t.body ?? ''}`.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/);
      for (const w of words) {
        if (w.length < 4 || stop.has(w)) continue;
        freq[w] = (freq[w] ?? 0) + 1;
      }
    }
    const topKeywords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([word, count]) => ({ word, count }));
    return { asin, current, trend, topKeywords };
  });

  // 触发抓取（异步 job）。mock 模式零成本；apify 模式受全服日限 + 并发限制保护。
  app.post('/api/reviews/fetch', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const asin = validAsin(body.asin);
    if (!asin) return reply.code(400).send({ error: 'ASIN 必须是 10 位字母/数字，例如 B0DWF7823H' });
    const countryCode = String(body.country_code ?? 'US').trim().toUpperCase() || 'US';
    const maxReviews = Math.min(100, Math.max(1, Math.round(Number(body.max_reviews) || 30)));

    const db = getDb();
    const usedToday = (db.prepare(
      `SELECT COUNT(*) AS n FROM review_jobs WHERE started_at >= datetime('now','start of day')`,
    ).get() as { n: number }).n;
    const cap = getSettingNum('reviews_global_daily') || 50;
    if (usedToday >= cap) {
      return reply.code(429).send({ error: `今日全服抓取配额已用完 (${usedToday}/${cap})，UTC 零点重置` });
    }
    if (countRunningJobs() >= 2) {
      return reply.code(429).send({ error: '已有抓取任务在运行（全服最多 2 并发），请稍候' });
    }

    const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const args: ReviewJobArgs = { asin, countryCode, maxReviews };
    createJob(id, ADMIN_KEY_ID, ADMIN_CLIENT, args);
    void runReviewJob(id, args);
    return {
      job_id: id, asin, country_code: countryCode, max_reviews: maxReviews,
      mode: isMockMode() ? 'mock' : 'apify',
      hint: '抓取在后台运行，轮询 /api/reviews/overview 或页面状态直到完成',
    };
  });

  // 单个 job 状态（前端轮询用）
  app.get('/api/reviews/job', async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const jobId = String(q.job_id ?? '');
    const row = getDb().prepare(
      `SELECT job_id, status, result, error, started_at, finished_at FROM review_jobs WHERE job_id = ?`,
    ).get(jobId) as Record<string, unknown> | undefined;
    if (!row) return { error: 'job not found' };
    if (row.result) { try { (row as any).result = JSON.parse(String(row.result)); } catch { /* keep raw */ } }
    return row;
  });
}
