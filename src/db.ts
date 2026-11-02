import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { nowIso } from './util.js';

export type DB = Database.Database;

let _db: DB | null = null;

export function getDb(): DB {
  if (_db) return _db;
  const db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  runMigrations(db);
  seed(db);
  _db = db;
  return db;
}

function runMigrations(db: DB): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  let dir = config.migrationsDir;
  if (!fs.existsSync(dir)) {
    // built layout: dist/../migrations is config.migrationsDir already; extra fallback
    dir = path.join(process.cwd(), 'migrations');
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  // schema rebuilds (table re-creation) need FK enforcement off; PRAGMA is a no-op inside a
  // transaction, so toggle around the whole migration window and restore afterwards.
  db.pragma('foreign_keys = OFF');
  try {
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      const tx = db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations(name, applied_at) VALUES (?, ?)').run(f, nowIso());
      });
      tx();
      console.log(`[db] migration applied: ${f}`);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

const DEFAULT_SETTINGS: Record<string, string> = {
  // fetch source endpoint (editable in admin UI; stored in DB)
  suggest_api_url: 'https://completion.amazon.com/api/2017/suggestions',
  // scheduler
  cron: '0 3 * * 1', // every Monday 03:00 server time
  start_jitter_max_ms: '2700000', // up to 45 min random start delay for weekly runs
  // pacing (anti-detection: randomized, slow by design)
  request_delay_min_ms: '1800',
  request_delay_max_ms: '6500',
  pause_chance: '0.05',
  pause_min_ms: '9000',
  pause_max_ms: '25000',
  // harvest params
  basic_limit: '15',
  expand_top: '5',
  alphabet: 'abcdefghijklmnopqrstuvwxyz',
  // resilience
  max_retries: '5',
  backoff_base_ms: '30000',
  backoff_cap_ms: '1800000',
  breaker_threshold: '6',
  breaker_pause_ms: '1800000',
  // retention
  fetch_log_keep_days: '30',
  // mcp
  mcp_rate_limit_per_min: '60',
  // live-fetch governance: 1 = MCP live results are also merged into the lexicon, 0 = ephemeral
  mcp_live_persist: '1',
  // global safety cap: max live tool calls (all keys) per day
  mcp_live_global_daily: '200',
  // auto-seed: live keywords within [min, max] words are auto-added as PAUSED seed keywords
  mcp_live_auto_seed: '1',
  live_seed_min_words: '2',
  live_seed_max_words: '5',
};

const DEFAULT_SITES: Array<{ mid: string; name: string; flag: string; locale: string; sort: number }> = [
  { mid: 'ATVPDKIKX0DER', name: 'United States', flag: 'US', locale: 'en-US', sort: 1 },
  { mid: 'A1F83G8C2ARO7P', name: 'United Kingdom', flag: 'GB', locale: 'en-GB', sort: 2 },
  { mid: 'A1PA6795UKMFR9', name: 'Germany', flag: 'DE', locale: 'de-DE', sort: 3 },
  { mid: 'A13V1IB3VIYZZH', name: 'France', flag: 'FR', locale: 'fr-FR', sort: 4 },
  { mid: 'APJ6JRA9NG5V4', name: 'Italy', flag: 'IT', locale: 'it-IT', sort: 5 },
  { mid: 'A1RKKUPIHCS9HS', name: 'Spain', flag: 'ES', locale: 'es-ES', sort: 6 },
  { mid: 'A1VC38T7YXB528', name: 'Japan', flag: 'JP', locale: 'ja-JP', sort: 7 },
  { mid: 'A3KVACVP276B40', name: 'Canada', flag: 'CA', locale: 'en-CA', sort: 8 },
  { mid: 'A39IBJ37TRP1C6', name: 'Australia', flag: 'AU', locale: 'en-AU', sort: 9 },
  { mid: 'A21TJRUUN4KGV', name: 'India', flag: 'IN', locale: 'en-IN', sort: 10 },
  { mid: 'A2Q3Y263D00KWC', name: 'Brazil', flag: 'BR', locale: 'pt-BR', sort: 11 },
  { mid: 'A2VIGQ35RCS4UG', name: 'United Arab Emirates', flag: 'AE', locale: 'en-AE', sort: 12 },
  { mid: 'A1C4SOXMSFLBCM', name: 'Saudi Arabia', flag: 'SA', locale: 'en-SA', sort: 13 },
  { mid: 'A1805IZSGTT6HS', name: 'Netherlands', flag: 'NL', locale: 'nl-NL', sort: 14 },
  { mid: 'AAHKV2X7AFYLW', name: 'China', flag: 'CN', locale: 'zh-CN', sort: 15 },
];

const DEFAULT_PRICING: Array<[string, number]> = [
  ['list_sites', 0],
  ['get_stats', 0],
  ['lookup_lexicon', 1],
  ['get_keyword_trends', 2],
  ['search_suggestions', 10],
  ['search_suggestions_expand', 30],
];

function seed(db: DB): void {
  const insSite = db.prepare(
    'INSERT OR IGNORE INTO sites(mid, name, flag, locale, sort) VALUES (@mid, @name, @flag, @locale, @sort)',
  );
  for (const s of DEFAULT_SITES) insSite.run(s);
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);
  const insPrice = db.prepare('INSERT OR IGNORE INTO tool_pricing(tool, price) VALUES (?, ?)');
  for (const [t, p] of DEFAULT_PRICING) insPrice.run(t, p);
}

export function getSetting(key: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : '';
}

export function getSettingNum(key: string): number {
  const v = Number(getSetting(key));
  return Number.isFinite(v) ? v : 0;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
