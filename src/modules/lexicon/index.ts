/**
 * 联想词模块入口。
 *
 * 这是 lexicon 功能的唯一对外出口：核心层只 import 这个 ModuleContract，
 * 不感知 live.ts / tools.ts 的内部结构。未来的评论 / ETL 模块照此实现即可。
 */

import type { ModuleContract } from '../types.js';
import { buildLexiconTools } from './tools.js';

export const lexiconModule: ModuleContract = {
  id: 'lexicon',
  name: 'Amazon search-suggestion lexicon',
  version: '1.0.0',
  buildTools: buildLexiconTools,
};
