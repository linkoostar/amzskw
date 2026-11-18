/**
 * 评论模块入口（P3）。
 *
 * 核心层只 import 这个 ModuleContract，不感知 source/jobs/tools 的内部结构。
 * 作为可选模块，默认关闭，需 AMZ_ENABLED_MODULES=reviews 显式开启。
 */

import type { ModuleContract } from '../types.js';
import { buildReviewsTools } from './tools.js';
import { registerReviewsAdminApi } from './admin-api.js';

export const reviewsModule: ModuleContract = {
  id: 'reviews',
  name: 'Amazon product reviews (negative intelligence)',
  version: '1.0.0',
  buildTools: buildReviewsTools,
  registerAdminApi: registerReviewsAdminApi,
};
