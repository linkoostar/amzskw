/**
 * 联想词模块 —— 11 个 MCP 工具定义（P2 从 mcpserver.ts 搬入）
 *
 * 所有工具的 description / inputSchema / handler 与 P1 逐字一致：
 * 唯一变化是注册入口由 buildMcpServer 收集后经 registry 统一注册。
 * description 与 inputSchema 是外部 agent 的契约，任何字符变动都会破坏基线。
 */

import { z } from 'zod';
import { liveFetch } from '../../crawler.js';
import { getDb, getSetting, getSettingNum } from '../../db.js';
import { getStats, searchLexicon, getTrendMatrix } from '../../queries.js';
import { normalizePhrase } from '../../util.js';
import { billable, McpToolError } from '../../core/mcp-helpers.js';
import {
  expandJobs, liveGuard, ensureExpandCapacity, persistLiveResults,
  runExpandJob, type ExpandJob,
} from './live.js';
import type { ToolBuildContext, ToolContribution } from '../types.js';

/** 每次请求构造本模块的全部工具（handler 闭包绑定该请求的 key/clientId）。 */
export function buildLexiconTools({ key, clientId }: ToolBuildContext): ToolContribution[] {
  return [
    {
      name: 'list_sites',
      description: 'List supported Amazon marketplaces (mid, name, locale). Use `mid` in other tools to pick a site.',
      inputSchema: {},
      handler: billable(key, clientId, 'list_sites', async () => {
        const sites = getDb().prepare('SELECT mid, name, flag, locale FROM sites ORDER BY sort').all();
        return { sites };
      }),
    },
    {
      name: 'get_stats',
      description: 'Harvest database statistics: total seed keywords, lexicon size, suggestions stored, recent fetch health.',
      inputSchema: {},
      handler: billable(key, clientId, 'get_stats', async () => getStats()),
    },
    {
      name: 'lookup_lexicon',
      description:
        'Search the accumulated suggestion lexicon (previously harvested terms). Returns matching phrases with first/last seen dates and how many times observed. Does NOT hit Amazon live.',
      inputSchema: {
        query: z.string().describe('Substring to search, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id filter (from list_sites), omit for all sites'),
        limit: z.number().optional().default(30).describe('Max rows (default 30, max 100)'),
        offset: z.number().optional().default(0),
      },
      handler: billable(key, clientId, 'lookup_lexicon', async (args: { query: string; mid?: string; limit?: number; offset?: number }) => {
        const limit = Math.min(100, Math.max(1, args.limit ?? 30));
        const offset = Math.max(0, args.offset ?? 0);
        const { total, items } = searchLexicon(args.query ?? '', args.mid, limit, offset);
        return { query: args.query, total, limit, offset, items };
      }),
    },
    {
      name: 'get_keyword_trends',
      description:
        'Rank history of a seed keyword: for each weekly snapshot, the searchbox rank of every suggestion. Shows how suggestions move up/down over time.',
      inputSchema: {
        keyword: z.string().describe('Exact seed keyword text, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id; defaults to US (ATVPDKIKX0DER)'),
        runs: z.number().optional().default(12).describe('How many recent snapshots to include (default 12)'),
      },
      handler: billable(
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
    },
    {
      name: 'search_suggestions',
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
      handler: billable(
        key,
        clientId,
        'search_suggestions',
        async (args: { keyword: string; mid?: string; alias?: string; limit?: number }) => {
          const mid = args.mid ?? 'ATVPDKIKX0DER';
          const deadlineMs = getSettingNum('mcp_live_sync_deadline_ms') || 25000;
          let res;
          try {
            res = await liveFetch(
              {
                prefix: args.keyword,
                mid,
                alias: args.alias ?? 'aps',
                limit: Math.min(30, Math.max(1, args.limit ?? 15)),
              },
              deadlineMs,
            );
          } catch (e) {
            const msg = (e as Error).message ?? String(e);
            if (msg.includes('deadline')) {
              const budget = deadlineMs >= 1000 ? `${Math.round(deadlineMs / 1000)}s` : `${deadlineMs}ms`;
              throw new McpToolError(
                `live fetch exceeded the ${budget} synchronous budget (upstream slow). ` +
                  `Use search_suggestions_expand (async job, poll get_expand_job) for slower deep mining, ` +
                  `or lookup_lexicon / search_suggestions for already-stored data.`,
              );
            }
            throw e;
          }
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
        },
        () => liveGuard(key, clientId),
      ),
      live: true,
    },
    {
      name: 'search_suggestions_expand',
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
      handler: billable(
        key,
        clientId,
        'search_suggestions_expand',
        async (args: { keyword: string; mid?: string; alias?: string; limit?: number; expand_top?: number; letters?: string }) => {
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
        () => {
          liveGuard(key, clientId);
          ensureExpandCapacity();
        },
      ),
      live: true,
    },
    {
      name: 'get_expand_job',
      description:
        'Poll the status/result of an asynchronous search_suggestions_expand job. Free of charge. ' +
        'Returns progress (done/total requests) while running; the full mined suggestion set once status="done". ' +
        'Jobs are kept for 1 hour after completion and are lost if the server restarts.',
      inputSchema: {
        job_id: z.string().describe('The job_id returned by search_suggestions_expand'),
      },
      handler: billable(key, clientId, 'get_expand_job', async (args: { job_id: string }) => {
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
    },
    {
      name: 'analyze_roots',
      description:
        'Token-frequency analysis over the accumulated lexicon. Splits every suggestion containing the query into words, removes the seed words themselves, and ranks the remaining modifiers/attributes by how many suggestions they appear in. ' +
        'Use it to find high-demand attribute words (e.g. "magnetic", "waterproof") for listings, PPC ad-group themes and product differentiation. Reads stored data only — no Amazon calls.',
      inputSchema: {
        query: z.string().describe('Scope: only lexicon phrases containing this substring are analyzed, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id filter; omit for all sites'),
        min_count: z.number().optional().default(2).describe('Only return tokens appearing in at least N suggestions (default 2)'),
        limit: z.number().optional().default(25).describe('Max tokens returned, sorted by frequency (max 60)'),
      },
      handler: billable(
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
    },
    {
      name: 'rising_keywords',
      description:
        'Rank-movement analysis for one seed keyword: which suggestions are RISING, FALLING, newly appeared (NEW = early demand signal) or dropped out, based on the stored weekly snapshots. ' +
        'Reads stored data only — no Amazon calls. Pair with get_keyword_trends for the full history.',
      inputSchema: {
        keyword: z.string().describe('Exact seed keyword text, e.g. "starlink mini"'),
        mid: z.string().optional().describe('Marketplace id; defaults to US (ATVPDKIKX0DER)'),
        runs: z.number().optional().default(4).describe('How many recent snapshots to compare (default 4, max 26)'),
      },
      handler: billable(
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
    },
    {
      name: 'cross_site_gap',
      description:
        'Compare the suggestion lexicon of two Amazon marketplaces for one topic: phrases found only in site A, only in site B, and in both. ' +
        'Gaps often reveal region-specific demand or untapped opportunities. Reads stored data only — no Amazon calls.',
      inputSchema: {
        query: z.string().describe('Topic to compare, e.g. "starlink mini". Matches lexicon phrases containing this substring.'),
        mid_a: z.string().optional().default('ATVPDKIKX0DER').describe('Marketplace id of site A (defaults to US)'),
        mid_b: z.string().optional().default('A1F83G8C2ARO7P').describe('Marketplace id of site B (defaults to UK)'),
        limit: z.number().optional().default(50).describe('Max phrases per difference list (max 200)'),
      },
      handler: billable(
        key,
        clientId,
        'cross_site_gap',
        async (args: { query: string; mid_a?: string; mid_b?: string; limit?: number }) => {
          const db = getDb();
          const norm = normalizePhrase(args.query);
          const like = `%${norm}%`;
          const limit = Math.min(200, Math.max(1, args.limit ?? 50));
          // compare on phrase_norm so case/punctuation differences are not reported as site gaps;
          // keep one stored display form per norm for readability
          const load = (mid: string) => {
            const rows = db
              .prepare('SELECT phrase, phrase_norm FROM lexicon WHERE mid = ? AND phrase_norm LIKE ?')
              .all(mid, like) as Array<{ phrase: string; phrase_norm: string }>;
            const map = new Map<string, string>();
            for (const r of rows) if (!map.has(r.phrase_norm)) map.set(r.phrase_norm, r.phrase);
            return map;
          };
          const a = load(args.mid_a ?? 'ATVPDKIKX0DER');
          const b = load(args.mid_b ?? 'A1F83G8C2ARO7P');
          const disp = (m: Map<string, string>, k: string) => m.get(k) ?? k;
          const onlyA = [...a.keys()].filter((k) => !b.has(k)).sort().map((k) => disp(a, k));
          const onlyB = [...b.keys()].filter((k) => !a.has(k)).sort().map((k) => disp(b, k));
          const common = [...a.keys()].filter((k) => b.has(k)).sort().map((k) => disp(a, k));
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
    },
    {
      name: 'weekly_digest',
      description:
        'One-call summary across ALL seed keywords: per keyword how many suggestions rose, fell, newly appeared or dropped out in the latest snapshot vs the previous one, plus the top mover. ' +
        'Ideal for a scheduled agent producing a weekly ops report. Reads stored data only — no Amazon calls.',
      inputSchema: {
        mid: z.string().optional().describe('Only include seed keywords of this marketplace; omit for all sites'),
        top: z.number().optional().default(5).describe('Max rising/falling entries listed per keyword (default 5)'),
      },
      handler: billable(
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
    },
  ];
}
