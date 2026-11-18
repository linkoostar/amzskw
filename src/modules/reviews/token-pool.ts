/**
 * reviews 模块 —— Apify token 池 + 双模式配置（P4）
 *
 * 设计要点（生产可控）：
 *   1. 双模式配置：settings 表 > 环境变量。settings 里 apify_mode / apify_token 由 web 设置页写入，
 *      覆盖 docker compose 注入的环境变量；没配 settings 时回退到 env，老部署零改动。
 *   2. token 池：apify_tokens 表存多个账号 token。enable=0 由池开关控制；未启用池时用单 token 配置。
 *   3. 选择策略：过滤（禁用 / 冷却中 / 额度耗尽）→ 按 priority 降序 + 剩余额度降序 + 轮询打散。
 *   4. 额度：优先调 Apify accounts/me 自动查（有 APIFY token 权限即查），查失败用 web 手填的
 *      月度上限做本地递减兜底。quota_source 标记来源。
 *   5. 安全：token 明文只在服务端/DB，API 一律返回脱敏串；日志不打印 token；审计只记 token id。
 */

import { getDb, getSetting, getSettingNum } from '../../db.js';
import { nowIso } from '../../util.js';

export interface TokenRow {
  id: number;
  label: string;
  token: string;
  enabled: number;
  priority: number;
  quota_limit_usd: number;
  quota_used_usd: number;
  quota_source: string;
  quota_checked_at: string | null;
  cooldown_until: string | null;
  last_error: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface SelectedToken {
  id: number;
  label: string;
  token: string;
}

/** 双模式：settings 优先，env 兜底。但空字符串不算配置（避免设置页留空反覆盖 env）。 */
function settingOrEnv(settingKey: string, envKey: string, fallback: string): string {
  const s = getSetting(settingKey);
  if (s && s.trim()) return s.trim();
  const e = process.env[envKey];
  if (e && e.trim()) return e.trim();
  return fallback;
}

export function getApifyMode(): 'mock' | 'apify' {
  const raw = settingOrEnv('apify_mode', 'APIFY_MODE', 'mock').toLowerCase();
  return raw === 'apify' ? 'apify' : 'mock';
}

export function isMockMode(): boolean {
  return getApifyMode() === 'mock';
}

/** 单 token 模式下的 token（池未启用时的兜底）。 */
export function getFallbackToken(): string {
  return settingOrEnv('apify_token', 'APIFY_TOKEN', '');
}

export function isPoolEnabled(): boolean {
  return getSettingNum('apify_token_pool_enabled') === 1;
}

/** 并发上限：池启用时取 min(设置值, 可用 token 数+1)，未启用时取设置值。至少 1。 */
export function maxConcurrent(): number {
  const configured = Math.max(1, getSettingNum('apify_max_concurrent') || 2);
  if (!isPoolEnabled()) return configured;
  return Math.max(1, Math.min(configured, availableTokens().length + 1));
}

/** Apify accounts/me 返回的额度（自动查）。字段随 Apify 版本可能不同，做多路径兜底。 */
export async function fetchQuota(token: string): Promise<{ limit: number; used: number } | null> {
  try {
    const res = await fetch('https://api.apify.com/v2/accounts/me', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const j = await res.json() as any;
    const d = j?.data ?? {};
    const lim = d.limits ?? {};
    // Apify 实测字段：limits.monthlyUsageUsd / limits.maxMonthlyUsageUsd
    const used = Number(lim.monthlyUsageUsd ?? d.monthlyUsageUsd ?? NaN);
    const limit = Number(
      lim.maxMonthlyUsageUsd ?? lim.monthlyLimitUsd ?? d.maxMonthlyUsageUsd ?? d.monthlyLimitUsd ?? NaN,
    );
    if (!Number.isFinite(used) && !Number.isFinite(limit)) return null;
    return { limit: Number.isFinite(limit) ? limit : 0, used: Number.isFinite(used) ? used : 0 };
  } catch {
    return null;
  }
}

/** 刷新单个 token 的额度：自动查成功用 api 值，失败保留手填值（quota_source 保持 manual）。 */
export async function refreshTokenQuota(id: number): Promise<{ ok: boolean; source: string; limit: number; used: number }> {
  const db = getDb();
  const row = db.prepare('SELECT token FROM apify_tokens WHERE id = ?').get(id) as { token: string } | undefined;
  if (!row) return { ok: false, source: 'missing', limit: 0, used: 0 };
  const q = await fetchQuota(row.token);
  if (q) {
    db.prepare(
      `UPDATE apify_tokens SET quota_limit_usd = ?, quota_used_usd = ?, quota_source = 'api', quota_checked_at = ? WHERE id = ?`,
    ).run(q.limit, q.used, nowIso(), id);
    return { ok: true, source: 'api', limit: q.limit, used: q.used };
  }
  const cur = db.prepare('SELECT quota_limit_usd, quota_used_usd FROM apify_tokens WHERE id = ?').get(id) as any;
  return { ok: false, source: 'manual', limit: cur?.quota_limit_usd ?? 0, used: cur?.quota_used_usd ?? 0 };
}

/** 可用 token：启用 + 未冷却 + 额度未耗尽（手填上限>0 且已用>=上限时视为耗尽）。 */
export function availableTokens(): TokenRow[] {
  const rows = getDb().prepare('SELECT * FROM apify_tokens ORDER BY priority DESC, id ASC').all() as TokenRow[];
  const now = nowIso();
  return rows.filter((t) => {
    if (!t.enabled) return false;
    if (t.cooldown_until && t.cooldown_until > now) return false;
    if (t.quota_limit_usd > 0 && t.quota_used_usd >= t.quota_limit_usd) return false;
    return true;
  });
}

/** 选一个 token。池未启用 / 无可用 token 时回退到单 token 配置。 */
export function selectToken(): SelectedToken | null {
  const candidates = availableTokens();
  if (!isPoolEnabled() || candidates.length === 0) {
    const single = getFallbackToken();
    return single ? { id: 0, label: 'default(env/settings)', token: single } : null;
  }
  // 按剩余额度降序（手填上限为 0=未知，视为充裕），再用 last_used_at 升序做轮询打散。
  const sorted = [...candidates].sort((a, b) => {
    const remA = a.quota_limit_usd > 0 ? a.quota_limit_usd - a.quota_used_usd : Number.MAX_SAFE_INTEGER;
    const remB = b.quota_limit_usd > 0 ? b.quota_limit_usd - b.quota_used_usd : Number.MAX_SAFE_INTEGER;
    if (remA !== remB) return remB - remA;
    return String(a.last_used_at ?? '').localeCompare(String(b.last_used_at ?? ''));
  });
  const pick = sorted[0];
  return { id: pick.id, label: pick.label, token: pick.token };
}

/** 记录使用：last_used_at 现在，token id>0 时按本次抓取行数递增本地用量（手填兜底）。 */
export function markUsed(id: number, rows: number): void {
  if (!id) return;
  const db = getDb();
  const t = db.prepare("SELECT quota_source FROM apify_tokens WHERE id = ?").get(id) as { quota_source: string } | undefined;
  // 自动查来源的用量以 API 为准，本地不叠加；手填来源才本地递减。
  const bump = t?.quota_source !== 'api' ? ', quota_used_usd = quota_used_usd + ?' : '';
  const params = bump ? [nowIso(), rows * 0.002, id] : [nowIso(), id]; // 粗估每行 ~$0.002，仅手填兜底用
  db.prepare(`UPDATE apify_tokens SET last_used_at = ?${bump} WHERE id = ?`).run(...params);
}

/** 启动阶段失败：认证/额度问题冷却该 token（默认 30 分钟），其他错误不冷却。 */
export function markFailed(id: number, err: string, status?: number): void {
  if (!id) return;
  const db = getDb();
  const coolable = status === 401 || status === 403 || status === 402 || status === 429;
  if (coolable) {
    const until = new Date(Date.now() + 30 * 60_000).toISOString();
    db.prepare('UPDATE apify_tokens SET cooldown_until = ?, last_error = ? WHERE id = ?').run(until, err.slice(0, 300), id);
  } else {
    db.prepare('UPDATE apify_tokens SET last_error = ? WHERE id = ?').run(err.slice(0, 300), id);
  }
}

export function clearCooldown(id: number): void {
  getDb().prepare('UPDATE apify_tokens SET cooldown_until = NULL, last_error = NULL WHERE id = ?').run(id);
}

/** 脱敏：只显示前 6 + 后 4，中间星号。 */
export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 12) return token.slice(0, 3) + '****' + token.slice(-3);
  return token.slice(0, 6) + '********' + token.slice(-4);
}

export function listTokensMasked(): Array<Record<string, unknown>> {
  const rows = getDb().prepare('SELECT * FROM apify_tokens ORDER BY priority DESC, id ASC').all() as TokenRow[];
  const now = nowIso();
  return rows.map((t) => ({
    id: t.id,
    label: t.label,
    token_masked: maskToken(t.token),
    enabled: t.enabled,
    priority: t.priority,
    quota_limit_usd: t.quota_limit_usd,
    quota_used_usd: t.quota_used_usd,
    quota_source: t.quota_source,
    quota_checked_at: t.quota_checked_at,
    cooldown_active: !!t.cooldown_until && t.cooldown_until > now,
    cooldown_until: t.cooldown_until,
    last_error: t.last_error,
    last_used_at: t.last_used_at,
    created_at: t.created_at,
  }));
}
