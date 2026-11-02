import { ensureDbDir } from './config.js';
import { buildServer } from './server.js';
import { getDb } from './db.js';
import { startScheduler } from './scheduler.js';
import { config } from './config.js';

async function main() {
  ensureDbDir();
  const db = getDb();
  console.log(`[amz-lexicon] db ready at ${config.dbPath}`);

  // resume orphaned runs from a previous crash
  db.prepare("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE status IN ('pending','running')").run();

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  console.log(`[amz-lexicon] web admin:  http://localhost:${config.port}`);
  console.log(`[amz-lexicon] mcp endpoint: http://localhost:${config.port}/mcp (POST, Bearer api key)`);
  if (config.adminPassword === 'admin123') {
    console.warn('[amz-lexicon] WARNING: using default admin password, set ADMIN_PASSWORD env!');
  }
  startScheduler();
}

main().catch((e) => {
  console.error('[amz-lexicon] fatal:', e);
  process.exit(1);
});
