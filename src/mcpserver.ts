import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authorizeMcpRequest } from './auth.js';
import {
  chargeCredits, getToolPrice, InsufficientCreditsError, ApiKeyRow,
  logApiCall, countLiveCallsToday,
} from './credits.js';
import { liveFetch, randomRequestGap } from './crawler.js';
import { getStats, searchLexicon, getTrendMatrix } from './queries.js';
import { getDb, getSettingNum, getSetting } from './db.js';
import { normalizePhrase, nowIso } from './util.js';
import { config } from './config.js';

function jsonResult(data: unknown, extra: Record<string, unknown> = {}) {
  const body = extra && Object.keys(extra).length > 0 ? { ...(data as object), _meta: extra } : data;
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

class McpToolError extends Error {}

// ---------------------------------------------------------------- expand jobs (async deep-mining)
interface ExpandJob {
  id: string;
  keyId: number;
  clientId: string;
  args: { keyword: string; mid?: string; alias?: string; limit?: number; expand_top?: number; letters?: string };
  status: 'running' | 'done' | 'error';
  progress: { done: number; total: number };
  started_at: string;
  finished_at?: string;
  result?: unknown;
  error?: string;
}
const expandJobs = new Map<string, ExpandJob>();
const EXPAND_JOB_TTL_MS = 3600_000;

function pruneExpandJobs(): void {
  const now = Date.now();
  for (const [id, j] of expandJobs) {
    if (j.status !== 'running' && j.finished_at && now - Date.parse(j.finished_at) > EXPAND_JOB_TTL_MS) expandJobs.delete(id);
  }
}

async function runExpandJob(job: ExpandJob): Promise<void> {
  const a = job.args;
  try {
    const mid = a.mid ?? 'ATVPDKIKX0DER';
    const alias = a.alias ?? 'aps';
    const limit = Math.min(30, Math.max(1, a.limit ?? 15));
    const rawBodies: string[] = [];
    const basic = await liveFetch({ prefix: a.keyword, mid, alias, limit });
    rawBodies.push(basic.body);
    const baseWords = basic.suggestions.map((s) => s.value);
    const expandTop = Math.min(10, Math.max(0, a.expand_top ?? getSettingNum('expand_top')));
    const letters = (a.letters ?? (getSetting('alphabet') || 'abcdefghijklmnopqrstuvwxyz')).split('');
    job.progress.total = Math.max(1, expandTop * letters.length);
    const expanded: Array<{ parent: string; letter: string; phrase: string; position: number }> = [];
    const seen = new Set(baseWords.map((w) => w.toLowerCase()));
    for (const baseWord of baseWords.slice(0, expandTop)) {
      for (const letter of letters) {
        await randomRequestGap();
        try {
          const res = await liveFetch({ prefix: `${baseWord} ${letter}`, mid, alias, limit });
          rawBodies.push(res.body);
          res.suggestions.forEach((s, i) => {
            const n = s.value.toLowerCase();
            if (seen.has(n)) return;
            seen.add(n);
            expanded.push({ parent: baseWord, letter, phrase: s.value, position: i + 1 });
          });
        } catch {
          // keep going on single-letter failure
        }
        job.progress.done++;
      }
    }
    const allPhrases = [...baseWords, ...expanded.map((e) => e.phrase)];
    const { stored, autoSeedCreated } = persistLiveResults(mid, a.keyword, allPhrases, rawBodies, job.clientId);
    job.result = {
      keyword: a.keyword,
      mid,
      basic: baseWords,
      expanded,
      total_unique: seen.size,
      persisted_to_lexicon: stored,
      auto_seed_created: autoSeedCreated,
      auto_seed_note: autoSeedCreated
        ? 'the keyword was added to the seed list as PAUSED (not scheduled); the administrator can enable it for weekly harvesting'
        : undefined,
      fetched_at: new Date().toISOString(),
    };
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = (e as Error).message ?? String(e);
  } finally {
    job.finished_at = new Date().toISOString();
  }
}

/** Guard for LIVE Amazon tools: caller identity, per-key switch, per-key daily quota, global daily cap. */
function liveGuard(key: ApiKeyRow, clientId: string): void {
  if (!clientId) {
    throw new McpToolError(
      'live fetching requires caller identification: add header "X-Client-Id: <your-agent-name>" to the MCP connection. ' +
        'The administrator uses it to attribute live calls to each agent/person sharing this API key.',
    );
  }
  if (!key.can_live) {
    throw new McpToolError('live fetching is disabled for this API key by the administrator (tool: search_*). Use lookup_lexicon / get_keyword_trends instead.');
  }
  const perKey = countLiveCallsToday(key.id);
  if (perKey >= key.live_daily_limit) {
    throw new McpToolError(`live-fetch daily limit reached for this API key (${perKey}/${key.live_daily_limit}). Resets at UTC midnight. Contact the administrator to raise the limit.`);
  }
  const global = countLiveCallsToday();
  const globalCap = getSettingNum('mcp_live_global_daily') || 200;
  if (global >= globalCap) {
    throw new McpToolError(`server-wide live-fetch daily cap reached (${global}/${globalCap}). Resets at UTC midnight. Try lookup_lexicon (accumulated data) instead.`);
  }
}

/** Merge live-fetched phrases into the persistent lexicon + archive raw payloads + auto-seed a PAUSED keyword. */
function persistLiveResults(mid: string, seedKeyword: string, phrases: string[], rawBodies: string[], clientId: string) {
  let stored = 0;
  let autoSeedCreated = false;
  if (getSettingNum('mcp_live_persist')) {
    const db = getDb();
    const up = db.prepare(
      `INSERT INTO lexicon(mid, phrase_norm, phrase, first_seen_at, last_seen_at, seen_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(mid, phrase_norm) DO UPDATE SET seen_count = seen_count + 1, last_seen_at = excluded.last_seen_at`,
    );
    const insKw = db.prepare(
      "INSERT OR IGNORE INTO keywords(text, mid, alias, status, note, source) VALUES (?, ?, 'aps', 'paused', ?, 'mcp-live')",
    );
    const seen = new Set<string>();
    const tx = db.transaction(() => {
      for (const p of phrases) {
        const norm = normalizePhrase(p);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        up.run(mid, norm, p.trim(), nowIso(), nowIso());
        stored++;
      }
      for (const raw of rawBodies) {
        db.prepare('INSERT INTO fetch_log(url, ok, response_body) VALUES (?, 1, ?)').run(
          `mcp://live/${mid}/${encodeURIComponent(seedKeyword)}`,
          raw.slice(0, 65536),
        );
      }
      // auto-seed: keep the fetched keyword as a PAUSED seed for possible future scheduled harvesting
      if (getSettingNum('mcp_live_auto_seed')) {
        const wc = seedKeyword.trim().split(/\s+/).length;
        const mn = getSettingNum('live_seed_min_words') || 2;
        const mx = getSettingNum('live_seed_max_words') || 5;
        if (wc >= mn && wc <= mx) {
          const note = `auto: live fetch via MCP${clientId ? ` (${clientId})` : ''} — paused, review before enabling`;
          autoSeedCreated = insKw.run(seedKeyword.trim(), mid, note).changes > 0;
        }
      }
    });
    tx();
  }
  return { stored, autoSeedCreated };
}

/** wrap a tool handler with credit charging */
function billable(key: ApiKeyRow, clientId: string, tool: string, handler: (args: any) => Promise<unknown>) {
  return async (args: any) => {
    const price = getToolPrice(tool);
    let balance: number;
    try {
      balance = chargeCredits(key.id, price, 'tool_call', tool);
    } catch (e) {
      if (e instanceof InsufficientCreditsError) {
        return errorResult(
          `insufficient credits: balance=${e.balance}, required=${e.required} for tool "${tool}". Contact the administrator to top up.`,
        );
      }
      throw e;
    }
    logApiCall(key.id, tool, clientId);
    try {
      const data = await handler(args);
      return jsonResult(data, { credits_charged: price, credits_balance: balance });
    } catch (e) {
      if (e instanceof McpToolError) return errorResult(e.message);
      return errorResult((e as Error).message ?? String(e));
    }
  };
}

function buildMcpServer(key: ApiKeyRow, clientId: string): McpServer {
  const server = new McpServer({ name: 'amz-lexicon', version: config.version });

  server.registerTool(
    'list_sites',
    {
      description: 'List supported Amazon marketplaces (mid, name, locale). Use `mid` in other tools to pick a site.',
      inputSchema: {},
    },
    billable(key, clientId, 'list_sites', async () => {
      const sites = getDb().prepare('SELECT mid, name, flag, locale FROM sites ORDER BY sort').all();
      return { sites };
    }),
  );

  server.registerTool(
    'get_stats',
    {
      description: 'Harvest database statistics: total seed keywords, lexicon size, suggestions stored, recent fetch health.',
      inputSchema: {},
    },
    billable(key, clientId, 'get_stats', async () => getStats()),
  );

  server.registerTool(
    'lookup_lexicon',
    {
      description:
        'Search the accumulated suggestion lexicon (previously harvested terms). Returns matching phrases with first/last seen dates and how many times observed. Does NOT hit Amazon live.',
      inputSchema: {
        query: z.string().describe('Substring to search, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id filter (from list_sites), omit for all sites'),
        limit: z.number().optional().default(30).describe('Max rows (default 30, max 100)'),
        offset: z.number().optional().default(0),
      },
    },
    billable(key, clientId, 'lookup_lexicon', async (args: { query: string; mid?: string; limit?: number; offset?: number }) => {
      const limit = Math.min(100, Math.max(1, args.limit ?? 30));
      const offset = Math.max(0, args.offset ?? 0);
      const { total, items } = searchLexicon(args.query ?? '', args.mid, limit, offset);
      return { query: args.query, total, limit, offset, items };
    }),
  );

  server.registerTool(
    'get_keyword_trends',
    {
      description:
        'Rank history of a seed keyword: for each weekly snapshot, the searchbox rank of every suggestion. Shows how suggestions move up/down over time.',
      inputSchema: {
        keyword: z.string().describe('Exact seed keyword text, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id; defaults to US (ATVPDKIKX0DER)'),
        runs: z.number().optional().default(12).describe('How many recent snapshots to include (default 12)'),
      },
    },
    billable(
      key,
      clientId,
      'get_keyword_trends',
      async (args: { keyword: string; mid?: string; runs?: number }) => {
        const db = getDb();
        const mid = args.mid ?? 'ATVPDKIKX0DER';
        const kw = db
          .prepare('SELECT id, text, mid FROM keywords WHERE text = ? COLLATE NOCASE AND mid = ?')
          .get(args.keyword, mid) as { id: number; text: string; mid: string } | undefined;
        if (!kw) {
          return { error: 'seed keyword not found', keyword: args.keyword, mid, hint: 'try lookup_lexicon, or list seeds via get_stats + get_keyword_trends with a different mid' };
        }
        const matrix = getTrendMatrix(kw.id, Math.min(52, Math.max(1, args.runs ?? 12)));
        return matrix;
      },
    ),
  );

  server.registerTool(
    'search_suggestions',
    {
      description:
        'LIVE fetch of Amazon search-box suggestions (hits Amazon endpoint directly). Returns suggestions in searchbox rank order. ' +
        'GOVERNANCE: subject to per-key daily live quota and a server-wide daily cap set by the administrator; ' +
        'when server persistence is enabled the phrases are also merged into the lexicon (they become visible via lookup_lexicon).',
      inputSchema: {
        keyword: z.string().describe('Search prefix, e.g. "wireless earbuds"'),
        mid: z.string().optional().describe('Marketplace id, defaults to US'),
        alias: z.string().optional().default('aps').describe('Department alias, "aps" = all departments'),
        limit: z.number().optional().default(15).describe('Max suggestions (1-30)'),
      },
    },
    billable(key, clientId, 'search_suggestions', async (args: { keyword: string; mid?: string; alias?: string; limit?: number }) => {
      liveGuard(key, clientId);
      const mid = args.mid ?? 'ATVPDKIKX0DER';
      const res = await liveFetch({
        prefix: args.keyword,
        mid,
        alias: args.alias ?? 'aps',
        limit: Math.min(30, Math.max(1, args.limit ?? 15)),
      });
      const values = res.suggestions.map((s) => s.value);
      const { stored, autoSeedCreated } = persistLiveResults(mid, args.keyword, values, [res.body], clientId);
      return {
        keyword: args.keyword,
        mid,
        suggestions: res.suggestions.map((s, i) => ({ position: i + 1, value: s.value, strategyId: s.strategyId })),
        persisted_to_lexicon: stored,
        auto_seed_created: autoSeedCreated,
        auto_seed_note: autoSeedCreated
          ? 'the keyword was added to the seed list as PAUSED (not scheduled); the administrator can enable it for weekly harvesting'
          : undefined,
        fetched_at: new Date().toISOString(),
      };
    }),
  );

  server.registerTool(
    'search_suggestions_expand',
    {
      description:
        'ASYNCHRONOUS deep-mining of Amazon suggestions ("alphabet soup"): starts a background job and returns a job_id IMMEDIATELY ' +
        '(fits any gateway timeout). The job fetches basic suggestions, then re-queries base words + letters — a full run can take ' +
        'minutes (130+ paced requests). Poll get_expand_job with the job_id until status="done" to retrieve results. ' +
        'GOVERNANCE: requires X-Client-Id; subject to per-key daily live quota and server-wide cap; credits charged at start; ' +
        'all discovered phrases are merged into the lexicon when persistence is enabled.',
      inputSchema: {
        keyword: z.string().describe('Seed keyword'),
        mid: z.string().optional().describe('Marketplace id, defaults to US'),
        alias: z.string().optional().default('aps'),
        limit: z.number().optional().default(15).describe('Per-request max suggestions (1-30)'),
        expand_top: z.number().optional().default(5).describe('How many base words to expand (max 10)'),
        letters: z.string().optional().describe('Letters to append, defaults to a-z. Use a short set like "ab" for a quick run.'),
      },
    },
    billable(
      key,
      clientId,
      'search_suggestions_expand',
      async (args: { keyword: string; mid?: string; alias?: string; limit?: number; expand_top?: number; letters?: string }) => {
        liveGuard(key, clientId);
        pruneExpandJobs();
        const running = [...expandJobs.values()].filter((j) => j.status === 'running').length;
        if (running >= 2) {
          throw new McpToolError('another expand job is still running (max 2 concurrent server-wide). Poll its job_id with get_expand_job and try again later.');
        }
        const id = `exp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const job: ExpandJob = {
          id, keyId: key.id, clientId,
          args,
          status: 'running',
          progress: { done: 0, total: 1 },
          started_at: new Date().toISOString(),
        };
        expandJobs.set(id, job);
        void runExpandJob(job);
        const est = Math.min(10, Math.max(0, args.expand_top ?? getSettingNum('expand_top')))
          * (args.letters ?? (getSetting('alphabet') || 'abcdefghijklmnopqrstuvwxyz')).length;
        return {
          job_id: id,
          status: 'running',
          estimated_requests: est,
          how_to_get_results: 'poll tool get_expand_job with {"job_id": "' + id + '"} every 10-20 seconds until status is "done"',
          note: 'credits were charged at start; the job keeps running server-side even if you disconnect',
        };
      },
    ),
  );

  server.registerTool(
    'get_expand_job',
    {
      description:
        'Poll the status/result of an asynchronous search_suggestions_expand job. Free of charge. ' +
        'Returns progress (done/total requests) while running; the full mined suggestion set once status="done". ' +
        'Jobs are kept for 1 hour after completion and are lost if the server restarts.',
      inputSchema: {
        job_id: z.string().describe('The job_id returned by search_suggestions_expand'),
      },
    },
    billable(key, clientId, 'get_expand_job', async (args: { job_id: string }) => {
      const job = expandJobs.get(args.job_id);
      if (!job || job.keyId !== key.id) {
        throw new McpToolError(`expand job not found: "${args.job_id}". It may have expired (1h after completion) or was started by a different API key.`);
      }
      const elapsedS = Math.round((Date.now() - Date.parse(job.started_at)) / 1000);
      if (job.status === 'running') {
        return { job_id: job.id, status: 'running', progress: job.progress, elapsed_seconds: elapsedS, hint: 'poll again in 10-20 seconds' };
      }
      if (job.status === 'error') {
        return { job_id: job.id, status: 'error', elapsed_seconds: elapsedS, error: job.error };
      }
      return { job_id: job.id, status: 'done', elapsed_seconds: elapsedS, result: job.result };
    }),
  );

  // ------------------------------------------------------------ analysis tools
  server.registerTool(
    'analyze_roots',
    {
      description:
        'Token-frequency analysis over the accumulated lexicon. Splits every suggestion containing the query into words, removes the seed words themselves, and ranks the remaining modifiers/attributes by how many suggestions they appear in. ' +
        'Use it to find high-demand attribute words (e.g. "magnetic", "waterproof") for listings, PPC ad-group themes and product differentiation. Reads stored data only — no Amazon calls.',
      inputSchema: {
        query: z.string().describe('Scope: only lexicon phrases containing this substring are analyzed, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id filter; omit for all sites'),
        min_count: z.number().optional().default(2).describe('Only return tokens appearing in at least N suggestions (default 2)'),
        limit: z.number().optional().default(25).describe('Max tokens returned, sorted by frequency (max 60)'),
      },
    },
    billable(
      key,
      clientId,
      'analyze_roots',
      async (args: { query: string; mid?: string; min_count?: number; limit?: number }) => {
        const db = getDb();
        const norm = normalizePhrase(args.query);
        const rows = (
          args.mid
            ? db.prepare('SELECT phrase FROM lexicon WHERE mid = ? AND phrase_norm LIKE ?').all(args.mid, `%${norm}%`)
            : db.prepare('SELECT phrase FROM lexicon WHERE phrase_norm LIKE ?').all(`%${norm}%`)
        ) as Array<{ phrase: string }>;
        const seedTokens = new Set(norm.split(/\s+/));
        const counts = new Map<string, { count: number; examples: string[] }>();
        for (const { phrase } of rows) {
          const seenLocal = new Set<string>();
          for (const t of normalizePhrase(phrase).split(/\s+/)) {
            if (seedTokens.has(t) || t.length < 2 || seenLocal.has(t)) continue;
            seenLocal.add(t);
            const e = counts.get(t) ?? { count: 0, examples: [] };
            e.count++;
            if (e.examples.length < 3) e.examples.push(phrase);
            counts.set(t, e);
          }
        }
        const minCount = Math.max(1, args.min_count ?? 2);
        const tokens = [...counts.entries()]
          .map(([token, v]) => ({ token, suggestion_count: v.count, examples: v.examples }))
          .filter((t) => t.suggestion_count >= minCount)
          .sort((a, b) => b.suggestion_count - a.suggestion_count)
          .slice(0, Math.min(60, Math.max(1, args.limit ?? 25)));
        return {
          query: args.query,
          mid: args.mid ?? 'ALL',
          analyzed_suggestions: rows.length,
          tokens,
          interpretation:
            'token = modifier/attribute word found in stored suggestions (seed words excluded); suggestion_count = how many distinct suggestions contain it. High counts are strong demand/attribute signals for listings and PPC.',
        };
      },
    ),
  );

  server.registerTool(
    'rising_keywords',
    {
      description:
        'Rank-movement analysis for one seed keyword: which suggestions are RISING, FALLING, newly appeared (NEW = early demand signal) or dropped out, based on the stored weekly snapshots. ' +
        'Reads stored data only — no Amazon calls. Pair with get_keyword_trends for the full history.',
      inputSchema: {
        keyword: z.string().describe('Exact seed keyword text, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id; defaults to US (ATVPDKIKX0DER)'),
        runs: z.number().optional().default(4).describe('How many recent snapshots to compare (default 4, max 26)'),
      },
    },
    billable(
      key,
      clientId,
      'rising_keywords',
      async (args: { keyword: string; mid?: string; runs?: number }) => {
        const db = getDb();
        const mid = args.mid ?? 'ATVPDKIKX0DER';
        const kw = db
          .prepare('SELECT id, text, mid FROM keywords WHERE text = ? COLLATE NOCASE AND mid = ?')
          .get(args.keyword, mid) as { id: number; text: string; mid: string } | undefined;
        if (!kw) {
          throw new McpToolError(`seed keyword not found: "${args.keyword}" (mid=${mid}). Only harvested seed keywords have rank history — check get_stats or a different mid.`);
        }
        const m = getTrendMatrix(kw.id, Math.min(26, Math.max(2, args.runs ?? 4)))!;
        const rising: Array<{ phrase: string; from: number; to: number }> = [];
        const falling: Array<{ phrase: string; from: number; to: number }> = [];
        const new_terms: string[] = [];
        const fallen_off: string[] = [];
        for (const r of m.rows as Array<{ phrase: string; trend: string; prev?: number; latest?: number }>) {
          if (r.trend === 'up') rising.push({ phrase: r.phrase, from: r.prev!, to: r.latest! });
          else if (r.trend === 'down') falling.push({ phrase: r.phrase, from: r.prev!, to: r.latest! });
          else if (r.trend === 'new') new_terms.push(r.phrase);
          else if (r.trend === 'out') fallen_off.push(r.phrase);
        }
        rising.sort((a, b) => a.from - a.to - (b.from - b.to));
        falling.sort((a, b) => b.to - b.from - (a.to - a.from));
        return {
          keyword: kw.text,
          mid,
          snapshots: m.runs,
          rising,
          falling,
          new_terms,
          fallen_off,
          interpretation:
            'rising/falling = searchbox rank movement vs previous snapshot (from → to, lower number = better); new_terms = first appearance (early demand signal); fallen_off = no longer suggested.',
        };
      },
    ),
  );

  server.registerTool(
    'cross_site_gap',
    {
      description:
        'Compare the suggestion lexicon of two Amazon marketplaces for one topic: phrases found only in site A, only in site B, and in both. ' +
        'Gaps often reveal region-specific demand or untapped opportunities. Reads stored data only — no Amazon calls.',
      inputSchema: {
        query: z.string().describe('Topic to compare, e.g. "starlink mini". Matches lexicon phrases containing this substring.'),
        mid_a: z.string().optional().default('ATVPDKIKX0DER').describe('Marketplace id of site A (defaults to US)'),
        mid_b: z.string().optional().default('A1F83G8C2ARO7P').describe('Marketplace id of site B (defaults to UK)'),
        limit: z.number().optional().default(50).describe('Max phrases per difference list (max 200)'),
      },
    },
    billable(
      key,
      clientId,
      'cross_site_gap',
      async (args: { query: string; mid_a?: string; mid_b?: string; limit?: number }) => {
        const db = getDb();
        const norm = normalizePhrase(args.query);
        const like = `%${norm}%`;
        const limit = Math.min(200, Math.max(1, args.limit ?? 50));
        const load = (mid: string) =>
          new Set(
            (db.prepare('SELECT phrase FROM lexicon WHERE mid = ? AND phrase_norm LIKE ?').all(mid, like) as Array<{ phrase: string }>).map(
              (r) => r.phrase,
            ),
          );
        const a = load(args.mid_a ?? 'ATVPDKIKX0DER');
        const b = load(args.mid_b ?? 'A1F83G8C2ARO7P');
        const onlyA = [...a].filter((x) => !b.has(x)).sort();
        const onlyB = [...b].filter((x) => !a.has(x)).sort();
        const common = [...a].filter((x) => b.has(x)).sort();
        return {
          query: args.query,
          site_a: args.mid_a ?? 'ATVPDKIKX0DER',
          site_b: args.mid_b ?? 'A1F83G8C2ARO7P',
          counts: { a: a.size, b: b.size, common: common.length, only_a: onlyA.length, only_b: onlyB.length },
          only_in_a: onlyA.slice(0, limit),
          only_in_b: onlyB.slice(0, limit),
          common_examples: common.slice(0, limit),
          interpretation:
            'phrases present in one site but not the other indicate region-specific search demand — candidate opportunities to verify with live search_suggestions.',
        };
      },
    ),
  );

  server.registerTool(
    'weekly_digest',
    {
      description:
        'One-call summary across ALL seed keywords: per keyword how many suggestions rose, fell, newly appeared or dropped out in the latest snapshot vs the previous one, plus the top mover. ' +
        'Ideal for a scheduled agent producing a weekly ops report. Reads stored data only — no Amazon calls.',
      inputSchema: {
        mid: z.string().optional().describe('Only include seed keywords of this marketplace; omit for all sites'),
        top: z.number().optional().default(5).describe('Max rising/falling entries listed per keyword (default 5)'),
      },
    },
    billable(
      key,
      clientId,
      'weekly_digest',
      async (args: { mid?: string; top?: number }) => {
        const db = getDb();
        const kws = (
          args.mid
            ? db.prepare('SELECT id, text, mid FROM keywords WHERE mid = ? ORDER BY mid, text').all(args.mid)
            : db.prepare('SELECT id, text, mid FROM keywords ORDER BY mid, text').all()
        ) as Array<{ id: number; text: string; mid: string }>;
        const top = Math.min(20, Math.max(1, args.top ?? 5));
        const keywords: Array<Record<string, unknown>> = [];
        const totals = { rising: 0, falling: 0, new_terms: 0, fallen_off: 0 };
        for (const kw of kws) {
          const m = getTrendMatrix(kw.id, 2)!;
          const rows = m.rows as Array<{ phrase: string; trend: string; prev?: number; latest?: number }>;
          if (!rows.length) continue;
          const rising = rows.filter((r) => r.trend === 'up').map((r) => ({ phrase: r.phrase, from: r.prev!, to: r.latest! }));
          const falling = rows.filter((r) => r.trend === 'down').map((r) => ({ phrase: r.phrase, from: r.prev!, to: r.latest! }));
          const newTerms = rows.filter((r) => r.trend === 'new').map((r) => r.phrase);
          const fallen = rows.filter((r) => r.trend === 'out').map((r) => r.phrase);
          totals.rising += rising.length;
          totals.falling += falling.length;
          totals.new_terms += newTerms.length;
          totals.fallen_off += fallen.length;
          const topMover = [...rising].sort((x, y) => (y.from - y.to) - (x.from - x.to))[0] ?? null;
          keywords.push({
            keyword: kw.text,
            site: kw.mid,
            rising_count: rising.length,
            rising: rising.slice(0, top),
            falling_count: falling.length,
            falling: falling.slice(0, top),
            new_terms: newTerms.slice(0, top),
            fallen_off: fallen.slice(0, top),
            top_mover: topMover,
            snapshot_dates: (m.runs as Array<{ date: string }>).map((r) => r.date),
          });
        }
        return {
          generated_at: new Date().toISOString(),
          scope: args.mid ?? 'ALL',
          keywords_analyzed: keywords.length,
          totals,
          keywords,
          interpretation:
            'compares the two most recent snapshots per seed keyword. Use totals + per-keyword lists to draft a weekly report: what moved up, what slipped, what is new.',
        };
      },
    ),
  );

  return server;
}

const jsonRpcError = (code: number, message: string, id: unknown = null) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id,
});

export function registerMcpEndpoint(app: FastifyInstance): void {
  // stateless mode: each POST creates a fresh server+transport
  app.post('/mcp', async (req, reply) => {
    const auth = authorizeMcpRequest(req.headers.authorization);
    if (!auth.ok || !auth.key) {
      return reply.code(401).send(jsonRpcError(-32001, auth.error ?? 'unauthorized'));
    }
    const clientId = String(req.headers['x-client-id'] ?? '').trim().slice(0, 64);
    const server = buildMcpServer(auth.key, clientId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body as unknown);
  });

  app.get('/mcp', async (_req, reply) => {
    // stateless: no server-initiated SSE streams
    reply.code(405).send(jsonRpcError(-32000, 'SSE streaming not supported in stateless mode; use POST'));
  });

  app.delete('/mcp', async (_req, reply) => {
    reply.code(204).send();
  });
}
