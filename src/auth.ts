import { getDb, getSettingNum } from './db.js';
import { getApiKeyByHash, touchLastUsed, checkRateLimit, ApiKeyRow } from './credits.js';
import { config } from './config.js';
import { nowIso, randomToken, sha256hex } from './util.js';

// ---------------------------------------------------------------------------
// admin web session auth (cookie)
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = 'amz_session';

export function createAdminSession(): string {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.adminSessionDays * 86400_000).toISOString();
  getDb().prepare('INSERT INTO sessions(token, expires_at) VALUES (?, ?)').run(token, expires);
  // opportunistic cleanup
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
  return token;
}

export function validateAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  const row = getDb().prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token) as
    | { expires_at: string }
    | undefined;
  if (!row) return false;
  return row.expires_at > nowIso();
}

export function destroyAdminSession(token: string | undefined): void {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function checkAdminPassword(password: string): boolean {
  return password === config.adminPassword;
}

// ---------------------------------------------------------------------------
// MCP bearer api key auth
// ---------------------------------------------------------------------------
export interface AuthResult {
  ok: boolean;
  key?: ApiKeyRow;
  error?: string;
}

export function authenticateApiKey(authHeader: string | undefined): AuthResult {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, error: 'missing bearer token' };
  }
  const raw = authHeader.slice(7).trim();
  if (!raw) return { ok: false, error: 'empty token' };
  const key = getApiKeyByHash(sha256hex(raw));
  if (!key) return { ok: false, error: 'invalid api key' };
  if (!key.active || key.revoked_at) return { ok: false, error: 'api key revoked' };
  return { ok: true, key };
}

/** Full MCP auth: key valid + rate limit ok. Billing happens per tool call. */
export function authorizeMcpRequest(authHeader: string | undefined): AuthResult {
  const res = authenticateApiKey(authHeader);
  if (!res.ok) return res;
  const limit = getSettingNum('mcp_rate_limit_per_min');
  if (!checkRateLimit(res.key!.id, limit)) {
    return { ok: false, error: `rate limit exceeded (${limit}/min)` };
  }
  touchLastUsed(res.key!.id);
  return res;
}
