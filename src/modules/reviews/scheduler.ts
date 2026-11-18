/**
 * reviews 模块 —— 监控 ASIN 定时重抓调度器（P4）
 *
 * 与核心 lexicon 周调度完全独立：
 *   - 只在 reviews 模块启用（AMZ_ENABLED_MODULES 含 reviews）时启动；
 *   - cron 表达式来自 settings.reviews_watch_cron，空字符串 = 不启用（默认关）；
 *   - 到点批量重抓 review_watch 中 status='active' 的 ASIN；
 *   - 受日限 + 并发 + token 池约束（复用 admin 提交逻辑同款守卫）。
 *
 * 生产安全：默认关闭，不影响现有 lexicon 周调度；改 cron 后可 reload。
 */

import cron from 'node-cron';
import { getDb, getSetting, getSettingNum } from '../../db.js';
import { randInt, sleep } from '../../util.js';
import { activeModules } from '../catalog.js';
import { createJob, runReviewJob, countRunningJobs, type ReviewJobArgs } from './jobs.js';
import { maxConcurrent } from './token-pool.js';

let task: cron.ScheduledTask | null = null;
let running = false;
const ADMIN_KEY_ID = 0;
const ADMIN_CLIENT = 'reviews-scheduler';

function reviewsEnabled(): boolean {
  return activeModules().some((m) => m.id === 'reviews');
}

export function reviewsSchedulerStatus(): { cron: string; active: boolean; enabled: boolean; running: boolean } {
  return {
    cron: getSetting('reviews_watch_cron') || '',
    active: task !== null,
    enabled: reviewsEnabled(),
    running,
  };
}

export function startReviewsScheduler(): void {
  reloadReviewsScheduler();
}

export function reloadReviewsScheduler(): void {
  if (task) { task.stop(); task = null; }
  if (!reviewsEnabled()) return;
  const expr = getSetting('reviews_watch_cron') || '';
  if (!expr.trim()) return; // 默认关
  if (!cron.validate(expr)) {
    console.warn(`[reviews-scheduler] invalid cron "${expr}", disabled`);
    return;
  }
  task = cron.schedule(expr, () => { void fire(); });
  console.log(`[reviews-scheduler] watch re-fetch scheduled: "${expr}"`);
}

async function fire(): Promise<void> {
  if (running) { console.warn('[reviews-scheduler] previous run still active, skipping'); return; }
  const jitter = getSettingNum('reviews_watch_jitter_max_ms');
  if (jitter > 0) await sleep(randInt(0, jitter));
  running = true;
  try {
    const db = getDb();
    const active = db.prepare("SELECT id, asin, country_code FROM review_watch WHERE status='active'").all() as any[];
    const cap = getSettingNum('reviews_global_daily') || 50;
    const usedToday = (db.prepare(`SELECT COUNT(*) AS n FROM review_jobs WHERE started_at >= datetime('now','start of day')`).get() as { n: number }).n;
    let slots = Math.min(Math.max(0, cap - usedToday), Math.max(0, maxConcurrent() - countRunningJobs()));
    let submitted = 0;
    for (const w of active.slice(0, slots)) {
      const id = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const args: ReviewJobArgs = { asin: w.asin, countryCode: w.country_code, maxReviews: 50 };
      createJob(id, ADMIN_KEY_ID, ADMIN_CLIENT, args);
      void runReviewJob(id, args);
      db.prepare('UPDATE review_watch SET last_fetched_at = ? WHERE id = ?').run(new Date().toISOString(), w.id);
      submitted++;
    }
    console.log(`[reviews-scheduler] submitted ${submitted}/${active.length} watch re-fetches`);
  } catch (e) {
    console.error('[reviews-scheduler] failed:', (e as Error).message);
  } finally {
    running = false;
  }
}
