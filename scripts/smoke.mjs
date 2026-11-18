#!/usr/bin/env node
/**
 * 发布冒烟测试（只读，不改业务数据）
 *
 * 用途：
 *   1) 发布前：--save baseline.json   记录当前版本的健康状态与 MCP 工具清单
 *   2) 发布后：--compare baseline.json 对比，确认既有工具零回归
 *   3) 日常：  直接运行，快速验证服务可用
 *
 * 用法：
 *   node scripts/smoke.mjs [--url http://127.0.0.1:8080] [--key ak_xxx]
 *                          [--save baseline.json] [--compare baseline.json]
 *
 * 环境变量（优先级低于命令行参数）：
 *   SMOKE_BASE_URL  服务地址
 *   SMOKE_API_KEY   MCP Bearer key（建议用专用测试 key，不复用生产 key）
 *   SMOKE_CLIENT_ID 调用方标识，默认 smoke-test
 *
 * 退出码：0 = 全部通过；1 = 有失败项
 *
 * 注意：调用 /mcp 会触发应用的正常审计行为（更新 api_keys.last_used_at、
 *       写 api_calls）。这是应用逻辑，测试脚本本身不删除/修改任何业务数据。
 *       建议为冒烟测试单独创建一个 key。
 */

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 参数解析
function parseArgs() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--key' && argv[i + 1]) out.key = argv[++i];
    else if (a === '--save' && argv[i + 1]) out.save = argv[++i];
    else if (a === '--compare' && argv[i + 1]) out.compare = argv[++i];
    else if (a === '--client' && argv[i + 1]) out.client = argv[++i];
  }
  return out;
}
const args = parseArgs();
const BASE = (args.url || process.env.SMOKE_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const KEY = args.key || process.env.SMOKE_API_KEY || '';
const CLIENT_ID = args.client || process.env.SMOKE_CLIENT_ID || 'smoke-test';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function httpGet(path, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(BASE + path, { signal: ctl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(t);
  }
}

/** 单次 JSON-RPC 调用。stateless 模式下每个 POST 独立建 transport。 */
async function mcpCall(method, params, id) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${KEY}`,
        'x-client-id': CLIENT_ID,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    });
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // 若服务端返回 SSE，抽取最后一个 data: 帧
      const lines = text.split('\n').filter((l) => l.startsWith('data:'));
      payload = lines.length ? JSON.parse(lines[lines.length - 1].slice(5).trim()) : null;
    }
    return { status: res.status, payload, raw: text.slice(0, 500) };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- 1. HTTP 层
console.log(`smoke target: ${BASE}`);
console.log('');
try {
  const res = await httpGet('/api/health');
  const body = await res.json().catch(() => ({}));
  check('GET /api/health', res.status === 200 && body.ok === true, `status=${res.status} version=${body.version ?? '?'}`);
  var healthVersion = body.version ?? '';
} catch (e) {
  check('GET /api/health', false, e.message);
  healthVersion = '';
}

try {
  const res = await httpGet('/');
  const text = await res.text();
  check('GET / (SPA index)', res.status === 200 && text.includes('id="app"'), `status=${res.status}`);
} catch (e) {
  check('GET / (SPA index)', false, e.message);
}

try {
  const res = await httpGet('/app.js');
  check('GET /app.js', res.status === 200, `status=${res.status}`);
} catch (e) {
  check('GET /app.js', false, e.message);
}

try {
  const res = await httpGet('/vendor/vue.global.prod.js');
  check('GET /vendor/vue.global.prod.js', res.status === 200, `status=${res.status}`);
} catch (e) {
  check('GET /vendor/vue.global.prod.js', false, e.message);
}

// ---------------------------------------------------------------- 2. MCP 层
let toolList = null;
if (!KEY) {
  console.log('');
  console.log('[SKIP] MCP 检查 — 未提供 SMOKE_API_KEY（设 --key 或 SMOKE_API_KEY 以启用）');
  console.log('       tools/list 基线对比需要 key，发布门禁请务必提供专用测试 key。');
} else {
  console.log('');
  try {
    const init = await mcpCall('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    }, 1);
    const ok = init.status === 200 && init.payload?.result?.protocolVersion;
    check('MCP initialize', !!ok, `status=${init.status} proto=${init.payload?.result?.protocolVersion ?? '?'}`);
  } catch (e) {
    check('MCP initialize', false, e.message);
  }

  try {
    const r = await mcpCall('tools/list', {}, 2);
    const tools = r.payload?.result?.tools;
    if (r.status === 401 || r.payload?.error) {
      check('MCP tools/list', false, `status=${r.status} error=${JSON.stringify(r.payload?.error ?? r.raw)}`);
    } else if (!Array.isArray(tools)) {
      check('MCP tools/list', false, `unexpected payload: ${r.raw}`);
    } else {
      toolList = tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
      }));
      check('MCP tools/list', true, `${tools.length} tools`);
    }
  } catch (e) {
    check('MCP tools/list', false, e.message);
  }

  // 免费只读工具：验证核心查询链路（会产生审计写入，见文件头说明）
  if (toolList) {
    try {
      const r = await mcpCall('tools/call', { name: 'get_stats', arguments: {} }, 3);
      const txt = r.payload?.result?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(txt || '{}');
      check('MCP tool get_stats', !r.payload?.error && typeof parsed.lexicon === 'number',
        r.payload?.error ? JSON.stringify(r.payload.error) : `lexicon=${parsed.lexicon}`);
    } catch (e) {
      check('MCP tool get_stats', false, e.message);
    }
  }
}

// ---------------------------------------------------------------- 3. 基线保存 / 对比
const snapshot = {
  generated_at: new Date().toISOString(),
  base_url: BASE,
  version: healthVersion,
  tools: toolList,
};

if (args.save) {
  try {
    fs.mkdirSync(path.dirname(args.save) || '.', { recursive: true });
    fs.writeFileSync(args.save, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log('');
    console.log(`baseline saved: ${args.save} (${toolList?.length ?? 0} tools)`);
  } catch (e) {
    check('save baseline', false, e.message);
  }
}

if (args.compare) {
  console.log('');
  if (!fs.existsSync(args.compare)) {
    check('baseline file exists', false, args.compare);
  } else if (!toolList) {
    check('baseline compare', false, '当前无 tools/list 结果，无法对比（需提供 --key）');
  } else {
    let base;
    try {
      base = JSON.parse(fs.readFileSync(args.compare, 'utf8'));
    } catch (e) {
      check('baseline file parse', false, e.message);
    }
    if (base) {
      const norm = (t) => `${t.name}|${JSON.stringify(t.inputSchema ?? {})}`;
      const before = new Map((base.tools ?? []).map((t) => [t.name, norm(t)]));
      const after = new Map(toolList.map((t) => [t.name, norm(t)]));
      const missing = [...before.keys()].filter((n) => !after.has(n));
      const changed = [...before.keys()].filter((n) => after.has(n) && before.get(n) !== after.get(n));
      const added = [...after.keys()].filter((n) => !before.has(n));
      check('baseline: no tool removed', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${before.size} preserved`);
      check('baseline: schema unchanged', changed.length === 0, changed.length ? `changed: ${changed.join(', ')}` : 'all identical');
      if (added.length) console.log(`[INFO] new tools added: ${added.join(', ')}`);
      if (base.version && healthVersion && base.version !== healthVersion) {
        console.log(`[INFO] version changed: ${base.version} -> ${healthVersion}`);
      }
    }
  }
}

// ---------------------------------------------------------------- 4. 汇总
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`result: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
