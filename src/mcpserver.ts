/**
 * MCP 服务端接线层（P2 瘦身）
 *
 * P1: 工具定义与计费/治理逻辑全部内联在本文件（约 714 行）。
 * P2: 全部业务搬入模块体系，本文件只保留「鉴权 → 构造 server → 收集模块工具
 *     → 注册 → 挂载 transport」的编排骨架（不足 100 行）。
 *
 * 核心不再 import 任何具体业务模块：只依赖 catalog（模块清单）与
 * registry（收集器）。新增功能 = 在 catalog 加一行，本文件零改动。
 * 对外行为（鉴权、工具名/schema、错误码、stateless 语义）与 P1 完全一致。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { authorizeMcpRequest } from './auth.js';
import type { ApiKeyRow } from './credits.js';
import { config } from './config.js';
import { ModuleRegistry } from './modules/registry.js';
import { activeModules } from './modules/catalog.js';

function buildMcpServer(key: ApiKeyRow, clientId: string): McpServer {
  const server = new McpServer({ name: 'amz-lexicon', version: config.version });
  // 每请求一个独立 registry，避免并发请求间 handler 闭包串扰。
  const registry = new ModuleRegistry();
  const reg = registry.makeRegistrar(server);

  // 遍历已启用模块，收集其工具声明，统一经 registry 注册。
  // 模块只贡献声明；注册顺序、重名拦截、原样转发都由核心保证。
  for (const mod of activeModules()) {
    registry.registerModule(mod);
    for (const tool of mod.buildTools({ key, clientId })) {
      reg(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        tool.handler,
      );
    }
  }

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
    const clientId = String(req.headers['x-client-id'] ?? '').trim().slice(0, 64);
    const server = buildMcpServer(auth.key, clientId);
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
