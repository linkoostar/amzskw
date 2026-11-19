/**
 * reviews 模块 —— 数据源适配器（P3）
 *
 * 把"评论从哪来"锁在这一层，tool 层与业务层不感知供应商。
 * 当前数据源：junglee/amazon-reviews-scraper (Apify)，由用户提供 token。
 *
 * 两种模式：
 *   - mock（默认）：返回与真实 dataset 同结构的假数据，不访问 Apify、不扣费。
 *     用于 P3-1 骨架验证。开关：APIFY_MODE=mock（或 unset）。
 *   - apify：真实调用 Apify actor run + 轮询 + 读 dataset。开关：APIFY_MODE=apify。
 *     需要环境变量 APIFY_TOKEN；入参按用户实测的 INPUT 构造（见下方 REAL_INPUT）。
 *
 * 真实 INPUT 结构（取自用户 2026-11-18 成功 run 的 KV store，非文档猜测）：
 *   {
 *     deduplicateRedirectedAsins: true,
 *     filterByRatings: ["threeStar","twoStar","oneStar"],  // <=3 星，actor 端过滤=计费前
 *     includeGdprSensitive: false,
 *     maxReviews: 100,
 *     productUrls: [{ url: "https://www.amazon.com/dp/<ASIN>" }],
 *     reviewsAlwaysSaveCategoryData: false,
 *     reviewsUseProductVariantFilter: false,
 *     scrapeProductDetails: true,   // since P5: one extra product-page fetch, not billed per row
 *     sort: "helpful"
 *   }
 *
 * 真实输出字段（取自该 run 的 dataset）：
 *   reviewTitle, reviewDescription, ratingScore, reviewImages[], reviewId, date,
 *   reviewedIn, reviewUrl, reviewReaction, isVerified, isAmazonVine, variant,
 *   variantAttributes, userProfileLink, userId, position, totalCategoryRatings,
 *   totalCategoryReviews, reviewCategoryUrl, filterByRating, filterByKeyword,
 *   productAsin, productOriginalAsin, variantAsin, product, input, country,
 *   countryCode
 */

export interface RawReview {
  reviewId: string;
  asin: string;
  countryCode: string;
  rating: number;
  title: string | null;
  body: string | null;
  date: string | null;
  author: string | null;
  isVerified: boolean;
  isVine: boolean;
  helpfulVotes: number;
  reviewUrl: string | null;
  productUrl: string | null;
}

export interface RawProduct {
  title: string | null;
  image: string | null;
  price: number | null;
  currency: string | null;
  brand: string | null;
  url: string | null;
  stars: number | null;          // product page overall rating (all ratings, not just <=3)
  ratingsCount: number | null;
  reviewsCount: number | null;
}

export interface FetchResult {
  asin: string;
  countryCode: string;
  reviews: RawReview[];
  product: RawProduct | null;    // present when scrapeProductDetails succeeded
  meta: { mode: 'mock' | 'apify'; source: string; fetchedAt: string; totalReturned: number };
}

import { isMockMode as poolIsMock, selectToken, markUsed, markFailed, type SelectedToken } from './token-pool.js';

/** 双模式：settings 优先、env 兜底（P4）。保留原函数名，内部委派到 token-pool。 */
export function isMockMode(): boolean {
  return poolIsMock();
}

/** Build the actor input from a product URL. Rating filter is passed to the actor so
 *  filtered-out rows are never billed (per junglee pricing: pay per delivered row). */
export function buildApifyInput(productUrl: string, maxReviews: number): Record<string, unknown> {
  return {
    deduplicateRedirectedAsins: true,
    filterByRatings: ['threeStar', 'twoStar', 'oneStar'],
    includeGdprSensitive: false,
    maxReviews: Math.min(100, Math.max(1, Math.round(maxReviews))),
    productUrls: [{ url: productUrl }],
    reviewsAlwaysSaveCategoryData: false,
    reviewsUseProductVariantFilter: false,
    scrapeProductDetails: true,
    sort: 'helpful',
  };
}

/** Convert a bare ASIN + country code into the product URL the actor expects. */
export function asinToProductUrl(asin: string, countryCode: string): string {
  const domain = (countryCode || 'US').toLowerCase() === 'us' ? 'com' : `co.${(countryCode || 'us').toLowerCase()}`;
  return `https://www.amazon.${domain}/dp/${encodeURIComponent(asin.trim().toUpperCase())}`;
}

type ApifyRow = Record<string, any>;

/** Extract product details from a dataset row. With scrapeProductDetails=true every
 *  row carries a `product` object; fields vary slightly between actor versions, so
 *  parse defensively and accept nulls. */
function extractProduct(rows: ApifyRow[]): RawProduct | null {
  const p = rows.find((r) => r?.product && typeof r.product === 'object')?.product;
  if (!p) return null;
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const n = Number(v.replace(/[^0-9.]/g, '')); return Number.isFinite(n) && v.trim() !== '' ? n : null; }
    return null;
  };
  return {
    title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null,
    image: typeof p.image === 'string' && p.image ? p.image : (Array.isArray(p.images) && typeof p.images[0] === 'string' ? p.images[0] : null),
    price: num(p.price ?? p.priceValue),
    currency: typeof p.currency === 'string' ? p.currency : null,
    brand: typeof p.brand === 'string' && p.brand ? p.brand : null,
    url: typeof p.url === 'string' && p.url ? p.url : (typeof p.productUrl === 'string' ? p.productUrl : null),
    stars: num(p.stars ?? p.rating),
    ratingsCount: num(p.ratingsCount ?? p.totalRatings) !== null ? Math.round(Number(p.ratingsCount ?? p.totalRatings)) : null,
    reviewsCount: num(p.reviewsCount ?? p.totalReviews) !== null ? Math.round(Number(p.reviewsCount ?? p.totalReviews)) : null,
  };
}

function mapRow(r: ApifyRow): RawReview {
  return {
    reviewId: String(r.reviewId ?? ''),
    asin: String(r.productAsin ?? ''),
    countryCode: String(r.countryCode ?? 'US'),
    rating: Number(r.ratingScore ?? 0),
    title: r.reviewTitle ?? null,
    body: r.reviewDescription ?? null,
    date: r.date ?? null,
    author: r.userId ?? null,
    isVerified: r.isVerified === true,
    isVine: r.isAmazonVine === true,
    helpfulVotes: Number(r.reviewReaction ?? 0) || 0,
    reviewUrl: r.reviewUrl ?? null,
    productUrl: r.input ?? null,
  };
}

// ---------------------------------------------------------------- mock (no cost)
function mockFetch(asin: string, countryCode: string, maxReviews: number): FetchResult {
  const now = new Date().toISOString();
  const samples = [
    { t: 'Destroyed my dashboard', b: 'Works great, except if you need to move it — permanently attached. Absolute garbage.', s: 1 },
    { t: 'Waste of money', b: 'Horrible product, suction cups want to stay stuck to dash.', s: 1 },
    { t: "Don't recommend", b: 'Suction cups do not work very well.', s: 1 },
    { t: 'Not as advertised', b: 'One side will stick and the other will fall off after a few seconds.', s: 2 },
    { t: 'Low quality', b: 'It does not stick to the dash, keeps sliding. Not good.', s: 3 },
  ];
  const n = Math.min(maxReviews, samples.length);
  const reviews: RawReview[] = samples.slice(0, n).map((s, i) => ({
    reviewId: `MOCK${asin}${i}`,
    asin,
    countryCode,
    rating: s.s,
    title: s.t,
    body: s.b,
    date: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10),
    author: `mock-user-${i}`,
    isVerified: true,
    isVine: false,
    helpfulVotes: 10 - i,
    reviewUrl: `https://www.amazon.com/gp/customer-reviews/MOCK${i}`,
    productUrl: asinToProductUrl(asin, countryCode),
  }));
  const product: RawProduct = {
    title: `[MOCK] Universal Phone Mount for Car Dashboard (${asin})`,
    image: null,
    price: 12.99,
    currency: 'USD',
    brand: 'MockBrand',
    url: asinToProductUrl(asin, countryCode),
    stars: 3.9,
    ratingsCount: 1247,
    reviewsCount: 832,
  };
  return {
    asin, countryCode, reviews, product,
    meta: { mode: 'mock', source: 'mock', fetchedAt: now, totalReturned: reviews.length },
  };
}

// ---------------------------------------------------------------- real Apify
const APIFY_BASE = 'https://api.apify.com/v2';
const ACTOR = 'junglee/amazon-reviews-scraper';
const RUN_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

function apifyHeaders(token: string): Record<string, string> {
  if (!token) throw new Error('No Apify token configured; set it in web settings (apify_token / token pool) or the APIFY_TOKEN environment variable');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/** 启动阶段失败（认证/额度/限流），可被上层换 token 重试。 */
export class ApifyStartError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApifyStartError';
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Start an actor run, poll until it finishes, then read its dataset. All rows are
 *  already filtered to <=3 stars by the actor input, so no local re-filter needed. */
export async function apifyFetch(asin: string, countryCode: string, maxReviews: number, token: string): Promise<FetchResult> {
  const productUrl = asinToProductUrl(asin, countryCode);
  const input = buildApifyInput(productUrl, maxReviews);
  const started = Date.now();
  const startedIso = new Date(started).toISOString();
  const headers = apifyHeaders(token);

  const startRes = await fetch(
    `${APIFY_BASE}/acts/${encodeURIComponent(ACTOR)}/runs?maxTotalChargeUsd=1`,
    { method: 'POST', headers, body: JSON.stringify(input) },
  );
  if (!startRes.ok) {
    const body = (await startRes.text()).slice(0, 200);
    // 401/402/403/429 = 换 token 可救；其余是 input/服务问题，换 token 无意义。
    if ([401, 402, 403, 429].includes(startRes.status)) {
      throw new ApifyStartError(`Apify start run failed: HTTP ${startRes.status} ${body}`, startRes.status);
    }
    throw new Error(`Apify start run failed: HTTP ${startRes.status} ${body}`);
  }
  const startedRun = (await startRes.json()) as { data?: { id?: string; defaultDatasetId?: string } };
  const runId = startedRun.data?.id;
  if (!runId) throw new Error('Apify start run returned no run id');

  let status = 'RUNNING';
  let datasetId = startedRun.data?.defaultDatasetId;
  while (status === 'RUNNING' || status === 'READY') {
    if (Date.now() - started > RUN_TIMEOUT_MS) throw new Error(`Apify run ${runId} timed out after ${RUN_TIMEOUT_MS / 1000}s`);
    await sleep(POLL_INTERVAL_MS);
    const stRes = await fetch(`${APIFY_BASE}/actor-runs/${runId}`, { headers });
    if (!stRes.ok) throw new Error(`Apify poll failed: HTTP ${stRes.status}`);
    const st = (await stRes.json()) as {
      data?: { status?: string; defaultDatasetId?: string; exitCode?: number };
    };
    status = st.data?.status ?? 'FAILED';
    datasetId = st.data?.defaultDatasetId ?? datasetId;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${runId} ended with status ${status} (exitCode ${st.data?.exitCode})`);
    }
  }
  if (!datasetId) throw new Error(`Apify run ${runId} finished but returned no dataset id`);

  const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?clean=true&format=json`, { headers });
  if (!itemsRes.ok) throw new Error(`Apify dataset read failed: HTTP ${itemsRes.status}`);
  const rows = (await itemsRes.json()) as ApifyRow[];
  // Defensive local filter: keep <=3 even if the actor ignores filterByRatings for a site.
  const filtered = rows.filter((r) => Number(r.ratingScore ?? 0) <= 3);
  const reviews = filtered.map(mapRow).filter((r) => r.reviewId && r.rating > 0);
  return {
    asin, countryCode, reviews, product: extractProduct(rows),
    meta: {
      mode: 'apify', source: `${ACTOR} (run ${runId})`,
      fetchedAt: startedIso, totalReturned: reviews.length,
    },
  };
}

/** Public fetch entry: dispatches to mock or real Apify by mode.
 *  Real mode selects a token from the pool; on a start-stage auth/quota/limit error it
 *  cools that token and retries with the next one. A run already started is never
 *  re-tried on another token (dataset belongs to the originating account). */
export async function fetchNegativeReviews(
  asin: string,
  countryCode: string,
  maxReviews: number,
): Promise<FetchResult> {
  if (isMockMode()) return mockFetch(asin, countryCode, maxReviews);

  const attempted = new Set<number>();
  for (let attempt = 0; attempt < 10; attempt++) {
    const tok: SelectedToken | null = selectToken();
    if (!tok) throw new Error('No Apify token available (pool empty/exhausted or apify_token not configured)');
    if (attempted.has(tok.id)) break; // 所有可用 token 都试过且失败
    attempted.add(tok.id);
    try {
      const result = await apifyFetch(asin, countryCode, maxReviews, tok.token);
      markUsed(tok.id, result.reviews.length);
      (result.meta as any).tokenId = tok.id;
      (result.meta as any).tokenLabel = tok.label;
      return result;
    } catch (e) {
      markFailed(tok.id, (e as Error).message, e instanceof ApifyStartError ? e.status : undefined);
      if (!(e instanceof ApifyStartError)) throw e; // 非启动错误：不换 token，直接失败
      // ApifyStartError：冷却后换下一个 token 重试
    }
  }
  throw new Error('All Apify tokens failed at start stage (auth/quota/rate-limit); review token pool status');
}
