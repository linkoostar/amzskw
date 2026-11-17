/**
 * 模块总目录（P2）
 *
 * 核心与具体业务模块之间的唯一接线点。核心只 import 本文件，
 * 新增功能 = 在这里加一行 import + 数组项，不改 mcpserver.ts 一行。
 *
 * 功能开关语义（对齐生产灰度要求）：
 *   - core 模块（lexicon）：恒启用。它是既有生产功能，必须默认开，
 *     关闭它等于功能回归 —— 因此不允许被开关关掉。
 *   - 可选模块（评论 / ETL 等后续功能）：默认关闭，需通过环境变量显式开启。
 *
 * 开关用法：
 *   AMZ_ENABLED_MODULES=reviews,etl    逗号分隔的可选模块 id
 *   （core 模块始终加载，无需列出）
 */

import type { ModuleContract } from './types.js';
import type { ApiKeyRow } from '../credits.js';
import { lexiconModule } from './lexicon/index.js';

/** 恒启用的核心模块（既有生产功能）。 */
const CORE_MODULES: ModuleContract[] = [lexiconModule];

/**
 * 可选模块注册表（P3+ 填入）。
 * 这里预置为占位：未来评论 / ETL 模块 import 后加入本数组，默认不启用。
 */
const OPTIONAL_MODULES: ModuleContract[] = [];

function enabledOptionalIds(): Set<string> {
  const raw = process.env.AMZ_ENABLED_MODULES ?? '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** 返回本次进程实际启用的模块列表（顺序稳定：核心在前）。 */
export function activeModules(): ModuleContract[] {
  const enabled = enabledOptionalIds();
  return [
    ...CORE_MODULES,
    ...OPTIONAL_MODULES.filter((m) => enabled.has(m.id)),
  ];
}

/**
 * 仅用于读取工具声明的哑 key。buildTools 构造工具声明时不访问 DB，
 * handler 内部才用真实 key —— 这里只取 name/description/inputSchema，
 * 绝不调用 handler，因此 dummy key 不会触发任何计费或数据访问。
 */
const INTROSPECT_KEY: ApiKeyRow = {
  id: 0, name: 'introspection', key_prefix: '', key_hash: '', active: 1,
  credits_balance: 0, can_live: 0, live_daily_limit: 0,
  created_at: '', last_used_at: null, revoked_at: null,
};

/** 供后台/诊断展示：所有已知模块及其启用状态、贡献的工具清单。 */
export function describeModules(): Array<{
  id: string; name: string; version: string; enabled: boolean; core: boolean;
  tools: Array<{ name: string; description: string; live: boolean }>;
}> {
  const enabled = enabledOptionalIds();
  const describe = (m: ModuleContract, isEnabled: boolean, core: boolean) => ({
    id: m.id, name: m.name, version: m.version, enabled: isEnabled, core,
    tools: m.buildTools({ key: INTROSPECT_KEY, clientId: '' }).map((t) => ({
      name: t.name, description: t.description, live: t.live === true,
    })),
  });
  return [
    ...CORE_MODULES.map((m) => describe(m, true, true)),
    ...OPTIONAL_MODULES.map((m) => describe(m, enabled.has(m.id), false)),
  ];
}
