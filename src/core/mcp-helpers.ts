/**
 * 通用 MCP 工具能力（P2 从 mcpserver.ts 抽取）
 *
 * 这些能力对所有业务模块通用，与"数据是什么"无关：
 *   - billable:        原子扣 credits + 审计 + 统一结果封装
 *   - McpToolError:    面向调用方的业务错误（会被转成 isError 结果，不穿透到框架）
 *   - jsonResult / errorResult: MCP content 结果封装
 *
 * 注意：这里刻意不引用任何业务模块（lexicon / reviews / etl），
 * 保证核心层可以独立于任何数据源复用。行为与 P1 完全一致。
 */

import {
  chargeCredits,
  getToolPrice,
  InsufficientCreditsError,
  type ApiKeyRow,
  logApiCall,
} from '../credits.js';

export function jsonResult(data: unknown, extra: Record<string, unknown> = {}) {
  const body = extra && Object.keys(extra).length > 0 ? { ...(data as object), _meta: extra } : data;
  return { content: [{ type: 'text' as const, text: JSON.stringify(body, null, 2) }] };
}

export function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

export class McpToolError extends Error {}

/**
 * 包装一个工具 handler 并施加 credits 计费。`precheck` 在扣费之前执行，
 * 因此被拒绝的调用（live 关闭 / 配额满 / 并发满）不会扣调用方 credits。
 *
 * 这是所有模块共用的计费边界 —— 保持与 P1 逐字一致的行为语义。
 */
export function billable(
  key: ApiKeyRow,
  clientId: string,
  tool: string,
  handler: (args: any) => Promise<unknown>,
  precheck?: () => void,
) {
  return async (args: any) => {
    if (precheck) {
      try {
        precheck();
      } catch (e) {
        if (e instanceof McpToolError) return errorResult(e.message);
        throw e;
      }
    }
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
