/**
 * 模块契约（P1 定义 / P2 实装）
 *
 * 这是把 amz-lexicon 从「单一业务应用」改造为「数据 MCP 基座」的核心约定。
 * 每个功能点（联想词 / 评论 / ETL）实现同一个 ModuleContract，
 * 由 catalog 汇总、registry 统一收集工具、core 统一注册。
 *
 * P2 起，联想词已作为第一个真实模块（lexicon）走通此契约：
 * 核心只依赖 ModuleContract，不 import 任何具体业务模块的实现细节。
 * 新增功能 = 加一个实现 ModuleContract 的目录 + 在 catalog 登记，核心零改动。
 */

import type { ApiKeyRow } from '../credits.js';

/** 构造工具时的请求级上下文：handler 闭包需要绑定本次调用的 key / clientId。 */
export interface ToolBuildContext {
  key: ApiKeyRow;
  clientId: string;
}

/** 一个 MCP 工具声明。字段与 McpServer.registerTool 的参数一一对应。 */
export interface ToolContribution {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<unknown>;
  /** 语义标记：是否为 live（直打外部数据源）工具，供治理层识别。 */
  live?: boolean;
  /** 语义标记：默认价格，仅供文档/迁移参考；实际计费始终读 tool_pricing 表。 */
  defaultPrice?: number;
}

/** 一个功能模块的完整契约。 */
export interface ModuleContract {
  /** 模块唯一标识，同时作为命名空间来源，例如 'lexicon' / 'reviews' / 'etl'。 */
  id: string;
  name: string;
  version: string;
  /** 每次请求构造该模块贡献的工具集合。 */
  buildTools: (ctx: ToolBuildContext) => ToolContribution[];
  /** 该模块贡献的后台 API 路由（P4 使用）。 */
  routes?: unknown[];
  /** 该模块的定时抓取任务（后续阶段使用）。 */
  schedule?: unknown;
  /** 该模块自己的迁移文件 glob（后续阶段使用）。 */
  migrations?: string;
}
