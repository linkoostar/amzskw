import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from './db.js';
import { registerApi } from './routes.js';
import { registerMcpEndpoint } from './mcpserver.js';
import { validateAdminSession, SESSION_COOKIE } from './auth.js';
import { config, PROJECT_ROOT } from './config.js';

export async function buildServer() {
  getDb(); // init db early

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(fastifyCookie);
  await app.register(fastifyStatic, { root: config.webDir, prefix: '/' });

  // serve vue from node_modules (no bundler needed)
  const vuePath = path.join(PROJECT_ROOT, 'node_modules', 'vue', 'dist', 'vue.global.prod.js');
  app.get('/vendor/vue.global.prod.js', async (_req, reply) => {
    if (!fs.existsSync(vuePath)) return reply.code(404).send('// vue not found');
    reply.header('Content-Type', 'application/javascript; charset=utf-8');
    return fs.createReadStream(vuePath);
  });

  // admin auth guard for /api/* (except login & health)
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (url === '/api/health' || url === '/api/auth/login' || url === '/api/auth/me') return;
    if (!validateAdminSession(req.cookies?.[SESSION_COOKIE])) {
      return reply.code(401).send({ error: '未登录' });
    }
  });

  registerApi(app);
  registerMcpEndpoint(app);

  // SPA fallback -> index.html
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/mcp')) {
      return reply.code(404).send({ error: 'not found' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}
