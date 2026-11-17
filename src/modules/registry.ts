/**
 * 模块注册表（P1）
 *
 * 职责：
 *   1) 提供 makeRegistrar(server)：包装 McpServer.registerTool，在真实注册的同时
 *      把工具声明收集进注册表 —— 现有工具代码无需重写即可被模块体系感知。
 *   2) 保存已注册模块的元数据，供后续（P2+）路由挂载、cron 注册使用。
 *
 * P1 行为保证：
 *   - makeRegistrar 返回的函数签名与 server.registerTool 完全一致，
 *     内部原样转发调用，MCP 端对外表现零变化。
 *   - 注册顺序、工具数量、schema 全部保持原样，可由 smoke.mjs 的基线对比验证。
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ModuleContract, ToolContribution } from './types.js';

export class ModuleRegistry {
  private readonly tools = new Map<string, ToolContribution>();
  private readonly modules = new Map<string, ModuleContract>();

  /**
   * 返回一个可替代 server.registerTool 的注册函数。
   * 每次调用：先记录声明，再原样转发给 McpServer，保持运行时行为不变。
   */
  makeRegistrar(server: McpServer) {
    return (
      name: string,
      config: { description?: string; inputSchema?: Record<string, unknown>; [k: string]: unknown },
      handler: (args: unknown) => Promise<unknown>,
    ): void => {
      if (this.tools.has(name)) {
        throw new Error(`[registry] duplicate tool name: ${name}`);
      }
      this.tools.set(name, {
        name,
        description: config.description ?? '',
        inputSchema: config.inputSchema ?? {},
        handler,
      });
      // 原样转发，参数不做任何加工
      server.registerTool(name, config as never, handler as never);
    };
  }

  /** 登记一个模块（P2+ 使用）。P1 无实际模块对象，留接口。 */
  registerModule(mod: ModuleContract): void {
    if (this.modules.has(mod.id)) {
      throw new Error(`[registry] duplicate module id: ${mod.id}`);
    }
    this.modules.set(mod.id, mod);
  }

  /** 注册表内工具名（按注册顺序）。 */
  listToolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** 注册表内工具快照（只读副本）。 */
  listTools(): ToolContribution[] {
    return [...this.tools.values()];
  }

  listModuleIds(): string[] {
    return [...this.modules.keys()];
  }
}

/** 进程级默认注册表。P1：每个 MCP 请求复用同一实例，仅做声明收集；
 *  由于工具声明按请求构建（依赖 key/clientId 的 handler 闭包），
 *  这里的 tools 仅用于自省/测试，真正对外注册由 makeRegistrar 完成。 */
export const defaultRegistry = new ModuleRegistry();
