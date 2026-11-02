import type { FastifyInstance } from 'fastify';
import { getDb, getAllSettings, setSetting, getSetting } from './db.js';
import { checkAdminPassword, createAdminSession, destroyAdminSession, SESSION_COOKIE, validateAdminSession } from './auth.js';
import { startRun, cancelRun, breakerState, liveFetch } from './crawler.js';
import { getStats, getKeywordSnapshot, getTrendMatrix, searchLexicon } from './queries.js';
import { addCredits, countLiveCallsToday } from './credits.js';
import { reattachOrphanHistory } from './queries.js';
import { reloadScheduler, schedulerStatus } from './scheduler.js';
import { config } from './config.js';
import { csvEscape, nowIso, randomToken, sha256hex } from './util.js';

export function registerApi(app: FastifyInstance): void {
  const db = getDb();

  // ------------------------------------------------------------------ health
  app.get('/api/health', async () => ({ ok: true, version: config.version, time: nowIso() }));

  // -------------------------------------------------------------------- auth
  app.post('/api/auth/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!password || !checkAdminPassword(password)) {
      return reply.code(401).send({ error: '密码错误' });
    }
    const token = createAdminSession();
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: config.adminSessionDays * 86400,
    });
    return { ok: true };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    destroyAdminSession(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  app.get('/api/auth/me', async (req) => ({ authed: validateAdminSession(req.cookies?.[SESSION_COOKIE]) }));

  // ------------------------------------------------------------------- stats
  app.get('/api/stats', async () => ({ ...getStats(), breaker: breakerState(), scheduler: schedulerStatus() }));

  // ------------------------------------------------------------------- sites
  app.get('/api/sites', async () => db.prepare('SELECT mid, name, flag, locale FROM sites ORDER BY sort').all());

  // ---------------------------------------------------------------- keywords
  app.get('/api/keywords', async (req) => {
    const q = req.query as { status?: string; mid?: string; search?: string; source?: string };
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.status) { where.push('k.status = ?'); args.push(q.status); }
    if (q.mid) { where.push('k.mid = ?'); args.push(q.mid); }
    if (q.source) { where.push('k.source = ?'); args.push(q.source); }
    if (q.search) { where.push('k.text LIKE ?'); args.push(`%${q.search}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return db
      .prepare(
        `SELECT k.*, s.name AS site_name, s.flag AS site_flag,
           (SELECT COUNT(*) FROM lexicon l
             WHERE l.phrase_norm = LOWER(k.text) OR l.phrase_norm LIKE LOWER(k.text) || ' %') AS suggestion_count,
           (SELECT MAX(ri.finished_at) FROM run_items ri WHERE ri.keyword_id = k.id AND ri.status='done') AS last_fetched
         FROM keywords k LEFT JOIN sites s ON s.mid = k.mid ${w}
         ORDER BY k.created_at DESC, k.id DESC`,
      )
      .all(...args);
  });

  app.post('/api/keywords', async (req, reply) => {
    const b = req.body as { text?: string; mid?: string; alias?: string; note?: string };
    const text = (b.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: '关键词不能为空' });
    const mid = b.mid || 'ATVPDKIKX0DER';
    const alias = b.alias || 'aps';
    try {
      const id = db
        .prepare('INSERT INTO keywords(text, mid, alias, note) VALUES (?, ?, ?, ?)')
        .run(text, mid, alias, b.note ?? '').lastInsertRowid;
      const reattached = reattachOrphanHistory(text, mid, Number(id));
      return { id, reattached_history: reattached };
    } catch (e) {
      return reply.code(409).send({ error: '关键词已存在（相同站点/类目）' });
    }
  });

  app.post('/api/keywords/import', async (req, reply) => {
    const b = req.body as { text?: string; mid?: string; alias?: string };
    const lines = (b.text ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return reply.code(400).send({ error: '没有可导入的关键词' });
    const mid = b.mid || 'ATVPDKIKX0DER';
    const alias = b.alias || 'aps';
    const ins = db.prepare('INSERT OR IGNORE INTO keywords(text, mid, alias) VALUES (?, ?, ?)');
    const attach = (text: string, id: number) => reattachOrphanHistory(text, mid, id);
    const tx = db.transaction(() => {
      let added = 0;
      let reattached = 0;
      for (const line of lines) {
        const r = ins.run(line, mid, alias);
        added += r.changes;
        if (r.changes > 0 && r.lastInsertRowid) reattached += attach(line, Number(r.lastInsertRowid));
      }
      return { added, reattached };
    });
    const { added, reattached } = tx();
    return { added, skipped: lines.length - added, reattached_history: reattached };
  });

  app.patch('/api/keywords/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { status?: string; note?: string; text?: string; mid?: string; alias?: string };
    const kw = db.prepare('SELECT id FROM keywords WHERE id = ?').get(id);
    if (!kw) return reply.code(404).send({ error: 'not found' });
    if (b.status) db.prepare('UPDATE keywords SET status = ? WHERE id = ?').run(b.status === 'active' ? 'active' : 'paused', id);
    if (b.note !== undefined) db.prepare('UPDATE keywords SET note = ? WHERE id = ?').run(b.note, id);
    if (b.text) db.prepare('UPDATE keywords SET text = ? WHERE id = ?').run(b.text.trim(), id);
    if (b.mid) db.prepare('UPDATE keywords SET mid = ? WHERE id = ?').run(b.mid, id);
    if (b.alias) db.prepare('UPDATE keywords SET alias = ? WHERE id = ?').run(b.alias, id);
    return { ok: true };
  });

  app.delete('/api/keywords/:id', async (req) => {
    const { id: idRaw } = req.params as { id: string };
    const id = Number(idRaw);
    const purge = (req.query as { purge?: string }).purge === '1';
    const kw = db.prepare('SELECT id, text, mid FROM keywords WHERE id = ?').get(id) as
      | { id: number; text: string; mid: string }
      | undefined;
    if (!kw) return { ok: true, purged: 0 };

    if (purge) {
      const tx = db.transaction(() => {
        // 1) lexicon: remove suggestions discovered under this seed, unless also
        //    referenced by another keyword's history (shared words survive)
        const mine = (
          db.prepare('SELECT DISTINCT phrase_norm FROM suggestions_raw WHERE keyword_id = ?').all(id) as
            Array<{ phrase_norm: string }>
        ).map((r) => r.phrase_norm);
        let purgedLex = 0;
        if (mine.length > 0) {
          const others = new Set(
            (
              db
                .prepare(
                  `SELECT DISTINCT phrase_norm FROM suggestions_raw
                   WHERE keyword_id != ? AND phrase_norm IN (${mine.map(() => '?').join(',')})`,
                )
                .all(id, ...mine) as Array<{ phrase_norm: string }>
            ).map((r) => r.phrase_norm),
          );
          const toDel = mine.filter((p) => !others.has(p));
          for (let i = 0; i < toDel.length; i += 500) {
            const chunk = toDel.slice(i, i + 500);
            purgedLex += db
              .prepare(`DELETE FROM lexicon WHERE phrase_norm IN (${chunk.map(() => '?').join(',')})`)
              .run(...chunk).changes;
          }
        }
        // 2) history: this keyword's snapshots + orphaned rows from earlier deletions of same text
        db.prepare('DELETE FROM suggestions_raw WHERE keyword_id = ?').run(id);
        db.prepare(
          'DELETE FROM run_items WHERE keyword_id = ? OR (keyword_id IS NULL AND keyword_text = ? COLLATE NOCASE AND mid = ?)',
        ).run(id, kw.text, kw.mid);
        db.prepare('DELETE FROM keywords WHERE id = ?').run(id);
        return purgedLex;
      });
      const purgedLex = tx();
      return { ok: true, purged: 1, purged_lexicon: purgedLex };
    }

    db.prepare('DELETE FROM keywords WHERE id = ?').run(id);
    return { ok: true, purged: 0 };
  });

  app.post('/api/keywords/batch', async (req, reply) => {
    const b = req.body as { action?: string; ids?: number[] };
    const ids = (b.ids ?? []).map(Number).filter(Number.isFinite);
    if (!ids.length) return reply.code(400).send({ error: 'ids required' });
    const ph = ids.map(() => '?').join(',');
    let affected = 0;
    if (b.action === 'enable' || b.action === 'pause') {
      const st = b.action === 'enable' ? 'active' : 'paused';
      affected = db.prepare(`UPDATE keywords SET status = ? WHERE id IN (${ph})`).run(st, ...ids).changes;
    } else if (b.action === 'delete') {
      affected = db.prepare(`DELETE FROM keywords WHERE id IN (${ph})`).run(...ids).changes;
    } else {
      return reply.code(400).send({ error: 'invalid action, expect enable | pause | delete' });
    }
    return { ok: true, affected };
  });

  // ------------------------------------------------------- keyword snapshot
  app.get('/api/keywords/:id/snapshot', async (req, reply) => {
    const { id } = req.params as { id: string };
    const snap = getKeywordSnapshot(Number(id));
    if (!snap) return reply.code(404).send({ error: 'not found' });
    return snap;
  });

  // ------------------------------------------------------------------- runs
  app.get('/api/runs', async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    return db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit);
  });

  app.post('/api/runs', async (req, reply) => {
    const b = (req.body ?? {}) as { keyword_ids?: number[] };
    try {
      const runId = startRun('manual', b.keyword_ids);
      return { run_id: runId };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!run) return reply.code(404).send({ error: 'not found' });
    const items = db
      .prepare(
        `SELECT ri.*, k.note FROM run_items ri LEFT JOIN keywords k ON k.id = ri.keyword_id WHERE ri.run_id = ? ORDER BY ri.id`,
      )
      .all(id);
    return { run, items };
  });

  app.post('/api/runs/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const ok = cancelRun(Number(id));
    return { ok };
  });

  // ------------------------------------------------------------------ trends
  app.get('/api/trends', async (req, reply) => {
    const q = req.query as { keyword_id?: string; runs?: string };
    const kid = Number(q.keyword_id);
    if (!kid) return reply.code(400).send({ error: 'keyword_id required' });
    const matrix = getTrendMatrix(kid, Math.min(52, Math.max(1, Number(q.runs) || 12)));
    if (!matrix) return reply.code(404).send({ error: 'keyword not found' });
    return matrix;
  });

  app.get('/api/trends/export', async (req, reply) => {
    const q = req.query as { keyword_id?: string; runs?: string };
    const kid = Number(q.keyword_id);
    const matrix = getTrendMatrix(kid, Math.min(52, Math.max(1, Number(q.runs) || 52)));
    if (!matrix || matrix.runs.length === 0) return reply.code(404).send({ error: 'no data' });
    const header = ['phrase', ...matrix.runs.map((r) => r.date.slice(0, 10)), 'first_seen', 'last_seen'];
    const lines = [header.map(csvEscape).join(',')];
    for (const row of matrix.rows) {
      lines.push([row.phrase, ...row.positions.map((p) => (p === null ? '' : String(p))), row.first_seen, row.last_seen].map(csvEscape).join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="trend-${kid}.csv"`);
    return '\uFEFF' + lines.join('\r\n');
  });

  // ----------------------------------------------------------------- lexicon
  app.get('/api/lexicon', async (req) => {
    const q = req.query as { query?: string; mid?: string; limit?: string; offset?: string; sort?: string; dir?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const offset = Math.max(0, Number(q.offset) || 0);
    const { total, items } = searchLexicon(q.query ?? '', q.mid || undefined, limit, offset, q.sort || 'cnt', q.dir || 'desc');
    return { total, limit, offset, items };
  });

  // ---------------------------------------------------------------- settings
  app.get('/api/settings', async () => ({
    settings: getAllSettings(),
    pricing: db.prepare('SELECT tool, price FROM tool_pricing ORDER BY tool').all(),
  }));

  app.put('/api/settings', async (req) => {
    const b = req.body as { settings?: Record<string, string>; pricing?: Record<string, number> };
    if (b.settings) {
      const up = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      const tx = db.transaction(() => {
        for (const [k, v] of Object.entries(b.settings!)) up.run(k, String(v));
      });
      tx();
      reloadScheduler(); // cron may have changed
    }
    if (b.pricing) {
      const up = db.prepare('INSERT INTO tool_pricing(tool, price) VALUES (?, ?) ON CONFLICT(tool) DO UPDATE SET price=excluded.price');
      const tx = db.transaction(() => {
        for (const [tool, price] of Object.entries(b.pricing!)) up.run(tool, Math.max(0, Math.round(price)));
      });
      tx();
    }
    return { ok: true };
  });

  // --------------------------------------------------------------- api keys
  app.get('/api/keys', async () => {
    const rows = db
      .prepare('SELECT id, name, key_prefix, active, credits_balance, can_live, live_daily_limit, created_at, last_used_at, revoked_at FROM api_keys ORDER BY id DESC')
      .all() as Array<{ id: number; live_today?: number }>;
    for (const r of rows) r.live_today = countLiveCallsToday(r.id);
    return rows;
  });

  app.post('/api/keys', async (req, reply) => {
    const b = req.body as { name?: string; credits?: number; can_live?: number; live_daily_limit?: number };
    const name = (b.name ?? '').trim() || 'unnamed';
    const raw = 'ak_' + randomToken(24);
    const id = db
      .prepare('INSERT INTO api_keys(name, key_prefix, key_hash, credits_balance, can_live, live_daily_limit) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        name, raw.slice(0, 12), sha256hex(raw), Math.max(0, Math.round(b.credits ?? 0)),
        b.can_live === 0 ? 0 : 1, Math.max(0, Math.round(b.live_daily_limit ?? 20)),
      ).lastInsertRowid;
    if ((b.credits ?? 0) > 0) {
      // ledger entry for the initial balance
      db.prepare('INSERT INTO credits_ledger(api_key_id, delta, balance_after, reason, detail) VALUES (?, ?, ?, ?, ?)').run(
        Number(id), Math.round(b.credits!), Math.round(b.credits!), 'bonus', 'initial balance',
      );
    }
    return { id, key: raw }; // shown once
  });

  app.put('/api/keys/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as { can_live?: number; live_daily_limit?: number };
    if (b.can_live !== undefined) {
      db.prepare('UPDATE api_keys SET can_live = ? WHERE id = ?').run(b.can_live ? 1 : 0, id);
    }
    if (b.live_daily_limit !== undefined) {
      db.prepare('UPDATE api_keys SET live_daily_limit = ? WHERE id = ?').run(Math.max(0, Math.round(b.live_daily_limit)), id);
    }
    return { ok: true };
  });

  app.get('/api/keys/:id/calls', async (req) => {
    const { id } = req.params as { id: string };
    return db
      .prepare('SELECT id, tool, client_id, created_at FROM api_calls WHERE api_key_id = ? ORDER BY id DESC LIMIT 100')
      .all(id);
  });

  app.post('/api/keys/:id/revoke', async (req) => {
    const { id } = req.params as { id: string };
    db.prepare('UPDATE api_keys SET active=0, revoked_at=? WHERE id=?').run(nowIso(), id);
    return { ok: true };
  });

  app.delete('/api/keys/:id', async (req) => {
    const { id } = req.params as { id: string };
    db.prepare('DELETE FROM api_keys WHERE id = ?').run(id); // ledger rows cascade
    return { ok: true };
  });

  app.post('/api/keys/:id/topup', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { amount?: number; note?: string };
    const amount = Math.round(b.amount ?? 0);
    if (amount === 0) return reply.code(400).send({ error: 'amount required' });
    try {
      const balance = addCredits(Number(id), amount, amount > 0 ? 'topup' : 'adjust', b.note ?? '');
      return { balance };
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  app.get('/api/keys/:id/ledger', async (req) => {
    const { id } = req.params as { id: string };
    return db
      .prepare('SELECT * FROM credits_ledger WHERE api_key_id = ? ORDER BY id DESC LIMIT 200')
      .all(id);
  });

  // ------------------------------------------------- live preview (manual test)
  app.post('/api/live-test', async (req, reply) => {
    const b = req.body as { keyword?: string; mid?: string; alias?: string; limit?: string };
    const keyword = (b.keyword ?? '').trim();
    if (!keyword) return reply.code(400).send({ error: 'keyword required' });
    try {
      const res = await liveFetch({
        prefix: keyword,
        mid: b.mid || 'ATVPDKIKX0DER',
        alias: b.alias || 'aps',
        limit: Math.min(30, Math.max(1, Number(b.limit) || 15)),
      });
      return {
        keyword, mid: b.mid || 'ATVPDKIKX0DER',
        suggestions: res.suggestions.map((s, i) => ({ position: i + 1, value: s.value, strategyId: s.strategyId })),
        latency_ms: res.latencyMs,
      };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
}
