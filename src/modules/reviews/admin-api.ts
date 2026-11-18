/**
 * reviews 模块 —— 后台管理 API（P3 / P4）
 *
 * 管理员在 Web 后台触发抓取 / 查看差评走这里（session 鉴权，server.ts 的 onRequest hook 统一保护 /api/*），
 * 不走 MCP 的 API key + credits 计费路径。这样后台操作和 agent 调用互不干扰：
 *   - agent 通过 MCP tools（reviews_*）按 credits 计费；
 *   - 管理员通过本 API 直接读库 / 触发 job，不扣费。
 *
 * P4 新增：token 池管理、监控 ASIN 清单、差评变化视图、配置双模式状态。
 * 本文件由 reviews 模块自注册，核心 routes.ts / server.ts 零业务改动。
 */

import type { FastifyInstance } from 'fastify';
import { getDb, getSetting, getSettingNum, setSetting } from '../../db.js';
import { isMockMode } from './source.js';
import {
  listTokensMasked, availableTokens, refreshTokenQuota, clearCooldown,
  maxConcurrent, maskToken, isPoolEnabled, getApifyMode,
} from './token-pool.js';
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
  // 概览：库内差评统计 + 抓取模式 + 最近 job + 池/监控状态
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
    for (const j of jobs) {
      try { (j as any).asin = JSON.parse(String(j.args)).asin; } catch { (j as any).asin = null; }
      delete (j as any).args;
    }
    const watchCount = (db.prepare("SELECT COUNT(*) AS n FROM review_watch WHERE status='active'").get() as { n: number }).n;
    return {
      mode: getApifyMode(),
      totals, perAsin, jobs,
      pool: {
        enabled: isPoolEnabled(),
        available: availableTokens().length,
        total: listTokensMasked().length,
        max_concurrent: maxConcurrent(),
      },
      watch: { active: watchCount },
      governance: {
        global_daily: getSettingNum('reviews_global_daily') || 50,
        used_today: (db.prepare(
          `SELECT COUNT(*) AS n FROM review_jobs WHERE started_at >= datetime('now','start of day')`,
        ).get() as { n: number }).n,
        running: countRunningJobs(),
        max_concurrent: maxConcurrent(),
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
    const cap = getSettingNum('reviews_global_daily') || 50;
    if (!submitGuard(reply, cap)) return;
    const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const args: ReviewJobArgs = { asin, countryCode, maxReviews };
    createJob(id, ADMIN_KEY_ID, ADMIN_CLIENT, args);
    void runReviewJob(id, args);
    return {
      job_id: id, asin, country_code: countryCode, max_reviews: maxReviews,
      mode: getApifyMode(),
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

  // ---------------- P4: token 池管理 ----------------
  app.get('/api/reviews/tokens', async () => ({
    enabled: isPoolEnabled(),
    mode: getApifyMode(),
    single_token_masked: maskToken(getSetting('apify_token') || process.env.APIFY_TOKEN || ''),
    items: listTokensMasked(),
  }));

  app.post('/api/reviews/tokens', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const token = String(b.token ?? '').trim();
    if (!token) return reply.code(400).send({ error: 'token 不能为空' });
    const label = String(b.label ?? '').trim().slice(0, 60);
    const priority = Math.round(Number(b.priority) || 0);
    const quotaLimit = Math.max(0, Number(b.quota_limit_usd) || 0);
    getDb().prepare(
      `INSERT INTO apify_tokens(label, token, enabled, priority, quota_limit_usd, quota_used_usd, quota_source)
       VALUES (?, ?, 1, ?, ?, 0, 'manual')`,
    ).run(label, token, priority, quotaLimit);
    return { ok: true, items: listTokensMasked() };
  });

  app.put('/api/reviews/tokens/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const db = getDb();
    const cur = db.prepare('SELECT id FROM apify_tokens WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: 'token not found' });
    const sets: string[] = [];
    const vals: any[] = [];
    if (b.label !== undefined) { sets.push('label = ?'); vals.push(String(b.label).trim().slice(0, 60)); }
    if (b.priority !== undefined) { sets.push('priority = ?'); vals.push(Math.round(Number(b.priority) || 0)); }
    if (b.enabled !== undefined) { sets.push('enabled = ?'); vals.push(b.enabled ? 1 : 0); }
    if (b.quota_limit_usd !== undefined) { sets.push('quota_limit_usd = ?'); vals.push(Math.max(0, Number(b.quota_limit_usd) || 0)); }
    // token 明文仅在显式提供非空新值时更新（前端传掩码时不覆盖）
    if (typeof b.token === 'string' && b.token.trim() && !b.token.includes('****')) {
      sets.push('token = ?'); vals.push(b.token.trim());
    }
    if (sets.length) {
      vals.push(id);
      db.prepare(`UPDATE apify_tokens SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }
    return { ok: true, items: listTokensMasked() };
  });

  app.delete('/api/reviews/tokens/:id', async (req) => {
    const id = Number((req.params as any).id);
    getDb().prepare('DELETE FROM apify_tokens WHERE id = ?').run(id);
    return { ok: true, items: listTokensMasked() };
  });

  app.post('/api/reviews/tokens/:id/refresh', async (req) => {
    const id = Number((req.params as any).id);
    return { id, ...(await refreshTokenQuota(id)) };
  });

  app.post('/api/reviews/tokens/:id/cooldown-clear', async (req) => {
    clearCooldown(Number((req.params as any).id));
    return { ok: true, items: listTokensMasked() };
  });

  // ---------------- P4: 监控 ASIN 清单 ----------------
  app.get('/api/reviews/watch', async () => {
    const rows = getDb().prepare(
      `SELECT w.*,
              (SELECT COUNT(*) FROM reviews r WHERE r.asin = w.asin AND r.rating <= 3) AS review_count
       FROM review_watch w ORDER BY w.status DESC, w.id DESC`,
    ).all() as Array<Record<string, unknown>>;
    return { items: rows, max_concurrent: maxConcurrent() };
  });

  app.post('/api/reviews/watch', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const asin = validAsin(b.asin);
    if (!asin) return reply.code(400).send({ error: 'ASIN 必须是 10 位字母/数字' });
    const cc = String(b.country_code ?? 'US').trim().toUpperCase() || 'US';
    const note = String(b.note ?? '').trim().slice(0, 200);
    try {
      getDb().prepare('INSERT INTO review_watch(asin, country_code, note) VALUES (?, ?, ?)').run(asin, cc, note);
    } catch (e) {
      if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: '该 ASIN 已在监控清单' });
      throw e;
    }
    return { ok: true };
  });

  app.patch('/api/reviews/watch/:id', async (req) => {
    const id = Number((req.params as any).id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: any[] = [];
    if (b.status !== undefined) { sets.push('status = ?'); vals.push(b.status === 'active' ? 'active' : 'paused'); }
    if (b.note !== undefined) { sets.push('note = ?'); vals.push(String(b.note).trim().slice(0, 200)); }
    if (sets.length) { vals.push(id); getDb().prepare(`UPDATE review_watch SET ${sets.join(', ')} WHERE id = ?`).run(...vals); }
    return { ok: true };
  });

  app.delete('/api/reviews/watch/:id', async (req) => {
    getDb().prepare('DELETE FROM review_watch WHERE id = ?').run(Number((req.params as any).id));
    return { ok: true };
  });

  // 重抓单个监控 ASIN
  app.post('/api/reviews/watch/:id/fetch', async (req, reply) => {
    const row = getDb().prepare('SELECT asin, country_code FROM review_watch WHERE id = ?').get(Number((req.params as any).id)) as any;
    if (!row) return reply.code(404).send({ error: 'watch not found' });
    const cap = getSettingNum('reviews_global_daily') || 50;
    if (!submitGuard(reply, cap)) return;
    const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const args: ReviewJobArgs = { asin: row.asin, countryCode: row.country_code, maxReviews: 50 };
    createJob(id, ADMIN_KEY_ID, ADMIN_CLIENT, args);
    void runReviewJob(id, args);
    getDb().prepare('UPDATE review_watch SET last_fetched_at = ? WHERE id = ?').run(new Date().toISOString(), Number((req.params as any).id));
    return { job_id: id, asin: row.asin };
  });

  // 批量重抓所有 active 监控 ASIN（受并发/日限约束，逐个提交直到满）
  app.post('/api/reviews/watch/fetch-all', async () => {
    const db = getDb();
    const active = db.prepare("SELECT id, asin, country_code FROM review_watch WHERE status='active' ORDER BY last_fetched_at ASC").all() as any[];
    const cap = getSettingNum('reviews_global_daily') || 50;
    const usedToday = (db.prepare(`SELECT COUNT(*) AS n FROM review_jobs WHERE started_at >= datetime('now','start of day')`).get() as { n: number }).n;
    let slots = Math.max(0, cap - usedToday);
    const limit = maxConcurrent() - countRunningJobs();
    slots = Math.min(slots, Math.max(0, limit));
    const submitted: string[] = [];
    for (const w of active.slice(0, slots)) {
      const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const args: ReviewJobArgs = { asin: w.asin, countryCode: w.country_code, maxReviews: 50 };
      createJob(id, ADMIN_KEY_ID, ADMIN_CLIENT, args);
      void runReviewJob(id, args);
      db.prepare('UPDATE review_watch SET last_fetched_at = ? WHERE id = ?').run(new Date().toISOString(), w.id);
      submitted.push(w.asin);
    }
    return { submitted, skipped: active.length - submitted.length, slots };
  });

  // ---------------- P4: 差评变化视图 ----------------
  app.get('/api/reviews/changes', async (req) => {
    const q = (req.query ?? {}) as Record<string, string | undefined>;
    const db = getDb();
    const asin = q.asin ? String(q.asin).trim().toUpperCase() : '';
    const params: any[] = [];
    let where = 'rating <= 3';
    if (asin) { where += ' AND asin = ?'; params.push(asin); }
    // 每个 ASIN 的最近两次快照对比
    const snaps = db.prepare(
      `SELECT asin, fetched_at, total_reviews, negative_reviews, avg_rating, rating_distribution
       FROM reviews_snapshot ${asin ? 'WHERE asin = ?' : ''} ORDER BY asin, fetched_at DESC`,
    ).all(...(asin ? [asin] : [])) as Array<Record<string, unknown>>;
    const byAsin: Record<string, any[]> = {};
    for (const s of snaps) {
      const a = String(s.asin);
      (byAsin[a] ??= []).push(s);
    }
    const timeline: Array<Record<string, unknown>> = [];
    for (const [a, list] of Object.entries(byAsin)) {
      for (let i = 0; i < Math.min(list.length, 12); i++) {
        const cur = list[i];
        const prev = list[i + 1];
        let dist: any = {};
        try { dist = JSON.parse(String(cur.rating_distribution)); } catch { /* keep */ }
        timeline.push({
          asin: a, fetched_at: cur.fetched_at,
          total_reviews: cur.total_reviews, negative_reviews: cur.negative_reviews, avg_rating: cur.avg_rating,
          delta_total: prev ? Number(cur.total_reviews) - Number(prev.total_reviews) : null,
          delta_negative: prev ? Number(cur.negative_reviews) - Number(prev.negative_reviews) : null,
          delta_avg: prev ? Number((Number(cur.avg_rating) - Number(prev.avg_rating)).toFixed(2)) : null,
          dist,
        });
      }
    }
    // 最近 N 小时首次出现的新增差评
    const hours = Math.min(8760, Math.max(1, Number(q.hours) || 720));
    const newParams: any[] = [`-${hours} hours`];
    let newSql = `SELECT review_id, asin, rating, title, body, review_date, helpful_votes, review_url, first_seen_at
                  FROM reviews WHERE rating <= 3
                    AND replace(replace(first_seen_at,'T',' '),'Z','') >= datetime('now', ?)`;
    if (asin) { newSql += ' AND asin = ?'; newParams.push(asin); }
    newSql += ' ORDER BY first_seen_at DESC LIMIT 100';
    const newReviews = db.prepare(newSql).all(...newParams);
    return { asin: asin || null, hours, timeline, newReviews };
  });
}

/** 提交抓取前的全局守卫：日限 + 并发。返回 false 时已写入 reply。 */
function submitGuard(reply: any, cap: number): boolean {
  const db = getDb();
  const usedToday = (db.prepare(`SELECT COUNT(*) AS n FROM review_jobs WHERE started_at >= datetime('now','start of day')`).get() as { n: number }).n;
  if (usedToday >= cap) {
    reply.code(429).send({ error: `今日全服抓取配额已用完 (${usedToday}/${cap})，UTC 零点重置` });
    return false;
  }
  if (countRunningJobs() >= maxConcurrent()) {
    reply.code(429).send({ error: `已有抓取任务在运行（全服最多 ${maxConcurrent()} 并发），请稍候` });
    return false;
  }
  return true;
}
