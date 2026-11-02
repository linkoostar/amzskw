import { ProxyAgent, request as undiciRequest } from 'undici';
import { CrawlerError, genSessionId, pick } from './util.js';
import { getDb, getSetting } from './db.js';

/** Rotation pool of modern browser UAs */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; AppleWebKit/537.36 (KHTML, like Gecko)) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
];

let proxyDispatcher: ProxyAgent | undefined | null = null;
function getProxyDispatcher(): ProxyAgent | undefined {
  if (proxyDispatcher === null) {
    const url = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
    proxyDispatcher = url ? new ProxyAgent(url) : undefined;
    if (proxyDispatcher) console.log(`[amazon] using proxy ${url}`);
  }
  return proxyDispatcher;
}

export function acceptLanguageFor(locale: string): string {
  // en-US -> "en-US,en;q=0.9" style
  const base = locale.split('-')[0];
  return `${locale},${base};q=0.8,en;q=0.6`;
}

export interface Suggestion {
  value: string;
  strategyId?: string;
  suggType?: string;
  raw: unknown;
}

export interface FetchSuggestOptions {
  prefix: string;
  mid: string;
  alias?: string;
  limit?: number;
  sessionId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FetchSuggestResult {
  suggestions: Suggestion[];
  status: number;
  latencyMs: number;
  body: string;
  url: string;
}

/** Low-level single request to the Amazon completion endpoint. */
export async function fetchSuggestionsOnce(opts: FetchSuggestOptions): Promise<FetchSuggestResult> {
  const db = getDb();
  const site = db.prepare('SELECT locale FROM sites WHERE mid = ?').get(opts.mid) as { locale: string } | undefined;
  const alias = opts.alias ?? 'aps';
  const limit = opts.limit ?? 15;
  const sessionId = opts.sessionId ?? genSessionId();

  // fetch source comes from DB settings (admin UI), never hardcoded here
  const base = (getSetting('suggest_api_url') || 'https://completion.amazon.com/api/2017/suggestions').trim();
  const url =
    base + (base.includes('?') ? '&' : '?') +
    `limit=${encodeURIComponent(String(limit))}` +
    `&prefix=${encodeURIComponent(opts.prefix)}` +
    `&alias=${encodeURIComponent(alias)}` +
    `&fresh=true` +
    `&mid=${encodeURIComponent(opts.mid)}` +
    `&session-id=${encodeURIComponent(sessionId)}` +
    `&client-info=amazon-search-ui`;

  const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? 15000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
  const started = Date.now();

  let resBody: string;
  let statusCode: number;
  try {
    const result = await undiciRequest(url, {
      method: 'GET',
      dispatcher: getProxyDispatcher(),
      signal,
      headersTimeout: opts.timeoutMs ?? 15000,
      bodyTimeout: opts.timeoutMs ?? 15000,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': acceptLanguageFor(site?.locale ?? 'en-US'),
        'user-agent': pick(USER_AGENTS),
        // keep default accept-encoding (undici handles gzip/br transparently)
      },
    });
    statusCode = result.statusCode;
    resBody = await result.body.text();
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new CrawlerError('aborted', 'network');
    }
    throw new CrawlerError(`network error: ${(err as Error).message}`, 'network', undefined);
  }
  const latencyMs = Date.now() - started;

  if (statusCode !== 200) {
    throw new CrawlerError(`http ${statusCode}`, 'http', statusCode);
  }

  let parsed: { suggestions?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(resBody);
  } catch {
    throw new CrawlerError('invalid json response', 'parse');
  }
  const suggestions: Suggestion[] = (parsed.suggestions ?? [])
    .map((s) => ({
      value: String(s.value ?? ''),
      strategyId: s.strategyId ? String(s.strategyId) : undefined,
      suggType: s.suggType ? String(s.suggType) : undefined,
      raw: s,
    }))
    .filter((s) => s.value.length > 0);

  return { suggestions, status: statusCode, latencyMs, body: resBody, url };
}
