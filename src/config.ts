import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// works for both src/config.ts (dev) and dist/config.js (built): one level below project root
export const PROJECT_ROOT = path.resolve(__dirname, '..');

function envStr(key: string, dflt: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? dflt : v;
}
function envInt(key: string, dflt: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

export const config = {
  port: envInt('PORT', 8080),
  host: envStr('HOST', '0.0.0.0'),
  dbPath: envStr('DB_PATH', path.join(PROJECT_ROOT, 'data', 'amz.db')),
  adminPassword: envStr('ADMIN_PASSWORD', 'admin123'),
  adminSessionDays: envInt('ADMIN_SESSION_DAYS', 7),
  webDir: path.join(PROJECT_ROOT, 'web'),
  migrationsDir: path.join(PROJECT_ROOT, 'migrations'),
  /** when running from dist, migrations/web may sit at project root; fallback chain handled by caller */
  version: '0.1.0',
};

export function ensureDbDir(): void {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
}
