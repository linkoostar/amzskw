import { getDb } from './db.js';
import { nowIso } from './util.js';

export class InsufficientCreditsError extends Error {
  constructor(public readonly balance: number, public readonly required: number) {
    super(`insufficient credits: balance=${balance}, required=${required}`);
    this.name = 'InsufficientCreditsError';
  }
}

export interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  active: number;
  credits_balance: number;
  can_live: number;
  live_daily_limit: number;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function getApiKeyByHash(hash: string): ApiKeyRow | undefined {
  return getDb().prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hash) as ApiKeyRow | undefined;
}

export function getToolPrice(tool: string): number {
  const row = getDb().prepare('SELECT price FROM tool_pricing WHERE tool = ?').get(tool) as { price: number } | undefined;
  return row ? row.price : 0;
}

/** Atomically charge credits for one tool call. Throws InsufficientCreditsError. */
export function chargeCredits(apiKeyId: number, amount: number, reason: string, detail: string): number {
  if (amount === 0) {
    const row = getDb().prepare('SELECT credits_balance FROM api_keys WHERE id = ?').get(apiKeyId) as
      | { credits_balance: number }
      | undefined;
    return row ? row.credits_balance : 0;
  }
  const db = getDb();
  const tx = db.transaction((): number => {
    const row = db.prepare('SELECT credits_balance, active FROM api_keys WHERE id = ?').get(apiKeyId) as
      | { credits_balance: number; active: number }
      | undefined;
    if (!row) throw new Error('api key not found');
    if (row.credits_balance < amount) throw new InsufficientCreditsError(row.credits_balance, amount);
    const newBalance = row.credits_balance - amount;
    db.prepare('UPDATE api_keys SET credits_balance = ? WHERE id = ?').run(newBalance, apiKeyId);
    db.prepare('INSERT INTO credits_ledger(api_key_id, delta, balance_after, reason, detail) VALUES (?, ?, ?, ?, ?)').run(
      apiKeyId, -amount, newBalance, reason, detail,
    );
    return newBalance;
  });
  return tx();
}

/** Add credits (topup / bonus / manual adjust). */
export function addCredits(apiKeyId: number, amount: number, reason: string, detail: string): number {
  const db = getDb();
  const tx = db.transaction((): number => {
    const row = db.prepare('SELECT credits_balance FROM api_keys WHERE id = ?').get(apiKeyId) as
      | { credits_balance: number }
      | undefined;
    if (!row) throw new Error('api key not found');
    const newBalance = row.credits_balance + amount;
    db.prepare('UPDATE api_keys SET credits_balance = ? WHERE id = ?').run(newBalance, apiKeyId);
    db.prepare('INSERT INTO credits_ledger(api_key_id, delta, balance_after, reason, detail) VALUES (?, ?, ?, ?, ?)').run(
      apiKeyId, amount, newBalance, reason, detail,
    );
    return newBalance;
  });
  return tx();
}

export function touchLastUsed(apiKeyId: number): void {
  getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowIso(), apiKeyId);
}

/** Record one billable tool call for quota/audit purposes. */
export function logApiCall(apiKeyId: number, tool: string): void {
  getDb().prepare('INSERT INTO api_calls(api_key_id, tool) VALUES (?, ?)').run(apiKeyId, tool);
}

/** Count live-fetch tool calls since midnight (UTC). */
export function countLiveCallsToday(apiKeyId?: number): number {
  const LIVE_TOOLS = ['search_suggestions', 'search_suggestions_expand'];
  const scope = apiKeyId ? 'AND api_key_id = ?' : '';
  const args = apiKeyId ? [...LIVE_TOOLS, apiKeyId] : LIVE_TOOLS;
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) c FROM api_calls WHERE tool IN (${LIVE_TOOLS.map(() => '?').join(',')}) ${scope}
       AND created_at >= datetime('now', 'start of day')`,
    )
    .get(...args) as { c: number };
  return row.c;
}

// --- simple in-memory rate limiter per api key ---
const buckets = new Map<number, number[]>(); // key id -> timestamps (ms)

export function checkRateLimit(apiKeyId: number, limitPerMin: number): boolean {
  if (limitPerMin <= 0) return true;
  const now = Date.now();
  const arr = (buckets.get(apiKeyId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= limitPerMin) {
    buckets.set(apiKeyId, arr);
    return false;
  }
  arr.push(now);
  buckets.set(apiKeyId, arr);
  return true;
}
