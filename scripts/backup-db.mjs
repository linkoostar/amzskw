#!/usr/bin/env node
/**
 * 数据库在线备份（一致性快照，不阻塞写入）
 *
 * 用途：每次发布前调用，生成带时间戳的快照，用于回滚兜底。
 *
 * 用法：
 *   node scripts/backup-db.mjs [--db ./data/amz.db] [--out ./backups] [--keep 10]
 *
 * 参数：
 *   --db    源数据库路径（默认 data/amz.db，可用 DB_PATH 环境变量）
 *   --out   备份输出目录（默认 backups/）
 *   --keep  保留最近 N 份，0 = 不清理（默认 10）
 *
 * 机制：使用 SQLite 的 VACUUM INTO，生成事务一致的紧凑副本。
 *       源库只读打开，WAL 模式下不阻塞正常读写。
 *       备份完成后做完整性校验（integrity_check + 关键表计数）。
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' && argv[i + 1]) out.db = argv[++i];
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a === '--keep' && argv[i + 1]) out.keep = Number(argv[++i]);
  }
  return out;
}
const args = parseArgs();
const SRC = path.resolve(args.db || process.env.DB_PATH || path.join(process.cwd(), 'data', 'amz.db'));
const OUT_DIR = path.resolve(args.out || path.join(process.cwd(), 'backups'));
const KEEP = Number.isFinite(args.keep) ? args.keep : 10;

if (!fs.existsSync(SRC)) {
  console.error(`[backup] source db not found: ${SRC}`);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(OUT_DIR, `amz-${stamp}.db`);

console.log(`[backup] source : ${SRC}`);
console.log(`[backup] dest   : ${dest}`);

let db;
try {
  // readonly 打开；VACUUM INTO 在只读连接上可用，且对源库零写入
  db = new Database(SRC, { readonly: true, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  console.log('[backup] snapshot written');
} catch (e) {
  console.error(`[backup] failed: ${e.message}`);
  process.exit(1);
} finally {
  if (db) db.close();
}

// ---------------------------------------------------------------- 校验备份完整性
let checkDb;
try {
  checkDb = new Database(dest, { readonly: true, fileMustExist: true });
  const integrity = checkDb.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`integrity_check=${integrity}`);
  const tables = ['keywords', 'lexicon', 'suggestions_raw', 'api_keys', 'settings', 'fetch_log'];
  const counts = {};
  for (const t of tables) {
    counts[t] = checkDb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  }
  const bytes = fs.statSync(dest).size;
  console.log(`[backup] integrity: ok, size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`[backup] rows: ${JSON.stringify(counts)}`);
} catch (e) {
  console.error(`[backup] verification failed: ${e.message}`);
  process.exit(1);
} finally {
  if (checkDb) checkDb.close();
}

// ---------------------------------------------------------------- 保留策略
if (KEEP > 0) {
  const backups = fs.readdirSync(OUT_DIR)
    .filter((f) => /^amz-.*\.db$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  for (const old of backups.slice(KEEP)) {
    fs.unlinkSync(path.join(OUT_DIR, old.f));
    console.log(`[backup] pruned: ${old.f}`);
  }
}

console.log(`[backup] OK -> ${dest}`);
