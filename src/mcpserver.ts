import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { authorizeMcpRequest } from './auth.js';
import { chargeCredits, getToolPrice, InsufficientCreditsError, ApiKeyRow } from './credits.js';
import { liveFetch, randomRequestGap } from './crawler.js';
import { getStats, searchLexicon, getTrendMatrix } from './queries.js';
import { getDb, getSettingNum, getSetting } from './db.js';
import { config } from './config.js';

function jsonResult(data: unknown, extra: Record<string, unknown> = {}) {
  const body = extra && Object.keys(extra).length > 0 ? { ...(data as object), _meta: extra } : data;
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

/** wrap a tool handler with credit charging */
function billable(key: ApiKeyRow, tool: string, handler: (args: any) => Promise<unknown>) {
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
    try {
      const data = await handler(args);
      return jsonResult(data, price > 0 ? { credits_charged: price, credits_balance: balance } : {});
    } catch (e) {
      return errorResult((e as Error).message ?? String(e));
    }
  };
}

function buildMcpServer(key: ApiKeyRow): McpServer {
  const server = new McpServer({ name: 'amz-lexicon', version: config.version });

  server.registerTool(
    'list_sites',
    {
      description: 'List supported Amazon marketplaces (mid, name, locale). Use `mid` in other tools to pick a site.',
      inputSchema: {},
    },
    billable(key, 'list_sites', async () => {
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
    billable(key, 'get_stats', async () => getStats()),
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
    billable(key, 'lookup_lexicon', async (args: { query: string; mid?: string; limit?: number; offset?: number }) => {
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
        'LIVE fetch of Amazon search-box suggestions for a keyword (hits completion.amazon.com). Returns suggestions in rank order. Slower (~seconds) and charged per call.',
      inputSchema: {
        keyword: z.string().describe('Search prefix, e.g. "wireless earbuds"'),
        mid: z.string().optional().describe('Marketplace id, defaults to US'),
        alias: z.string().optional().default('aps').describe('Department alias, "aps" = all departments'),
        limit: z.number().optional().default(15).describe('Max suggestions (1-30)'),
      },
    },
    billable(key, 'search_suggestions', async (args: { keyword: string; mid?: string; alias?: string; limit?: number }) => {
      const res = await liveFetch({
        prefix: args.keyword,
        mid: args.mid ?? 'ATVPDKIKX0DER',
        alias: args.alias ?? 'aps',
        limit: Math.min(30, Math.max(1, args.limit ?? 15)),
      });
      return {
        keyword: args.keyword,
        mid: args.mid ?? 'ATVPDKIKX0DER',
        suggestions: res.suggestions.map((s, i) => ({ position: i + 1, value: s.value, strategyId: s.strategyId })),
        fetched_at: new Date().toISOString(),
      };
    }),
  );

  server.registerTool(
    'search_suggestions_expand',
    {
      description:
        'LIVE deep-mining: fetches basic suggestions, then re-queries base words + letters to expand the pool (like "alphabet soup"). Makes many paced requests; can take minutes. Charged at a higher rate.',
      inputSchema: {
        keyword: z.string().describe('Seed keyword'),
        mid: z.string().optional().describe('Marketplace id, defaults to US'),
        alias: z.string().optional().default('aps'),
        limit: z.number().optional().default(15).describe('Per-request max suggestions (1-30)'),
        expand_top: z.number().optional().default(5).describe('How many base words to expand (max 10)'),
        letters: z.string().optional().describe('Letters to append, defaults to a-z. Use a short set like "ab" to keep it fast.'),
      },
    },
    billable(
      key,
      'search_suggestions_expand',
      async (args: { keyword: string; mid?: string; alias?: string; limit?: number; expand_top?: number; letters?: string }) => {
        const mid = args.mid ?? 'ATVPDKIKX0DER';
        const alias = args.alias ?? 'aps';
        const limit = Math.min(30, Math.max(1, args.limit ?? 15));
        const basic = await liveFetch({ prefix: args.keyword, mid, alias, limit });
        const baseWords = basic.suggestions.map((s) => s.value);
        const expandTop = Math.min(10, Math.max(0, args.expand_top ?? getSettingNum('expand_top')));
        const letters = (args.letters ?? (getSetting('alphabet') || 'abcdefghijklmnopqrstuvwxyz')).split('');
        const expanded: Array<{ parent: string; letter: string; phrase: string; position: number }> = [];
        const seen = new Set(baseWords.map((w) => w.toLowerCase()));
        for (const baseWord of baseWords.slice(0, expandTop)) {
          for (const letter of letters) {
            await randomRequestGap();
            try {
              const res = await liveFetch({ prefix: `${baseWord} ${letter}`, mid, alias, limit });
              res.suggestions.forEach((s, i) => {
                const n = s.value.toLowerCase();
                if (seen.has(n)) return;
                seen.add(n);
                expanded.push({ parent: baseWord, letter, phrase: s.value, position: i + 1 });
              });
            } catch {
              // keep going on single-letter failure
            }
          }
        }
        return {
          keyword: args.keyword,
          mid,
          basic: baseWords,
          expanded,
          total_unique: seen.size,
          fetched_at: new Date().toISOString(),
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
    const server = buildMcpServer(auth.key);
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
