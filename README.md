# AMZ Lexicon — 亚马逊搜索联想词词库

把亚马逊下拉联想接口的数据**定期抓下来存成自己的词库**，并通过标准 MCP 协议供其他 agent 调用（内置 credits 计费）。

- 抓取源：接口地址存于数据库（系统设置 → 抓取源，可随时手动更换），15 个站点，支持基础联想 + a-z 扩展挖掘
- 反爬节奏：请求间随机延迟、概率长停顿、随机启动时间、字母顺序打乱、指数退避、连续失败熔断——**慢而稳，速度优先级最低**
- 存储：SQLite（WAL），原始报文全量归档 `fetch_log`，接口失效后词库仍是你的
- Web 后台：关键词管理（增删/批量导入/启停）、抓取任务、**排名趋势**（每次快照的搜索框排名对比，看联想词升降）、词库检索、API Key 与 credits 充值流水、运行参数
- MCP：`POST /mcp`（Streamable HTTP, Bearer 认证），6 个 tool 按 credits 计费

## 快速开始（Docker）

```bash
docker compose up -d
# 打开 http://localhost:8080  密码 ADMIN_PASSWORD（默认 admin123，务必修改）
```

数据落盘 `./data/amz.db`，定期备份该文件即可。

## 本地开发

```bash
npm install
npm run dev     # tsx watch
npm run build && npm start
```

## 使用流程

1. 「关键词管理」添加/批量导入种子词（选站点）→ 点「立即抓取」或等周调度
2. 「抓取任务」看进度；「排名趋势」看同一词每次快照的排名变化（↑↓/NEW/落榜），可导出 CSV
3. 「API Keys」创建密钥、充值 credits
4. Agent 通过 MCP 接入：

```json
{
  "mcpServers": {
    "amz-lexicon": {
      "type": "url",
      "url": "http://<host>:8080/mcp",
      "headers": { "Authorization": "Bearer ak_xxx" }
    }
  }
}
```

### MCP Tools

| Tool | 说明 | 默认价格 (credits/次) |
|---|---|---|
| `list_sites` | 15 个站点 marketplace id | 0 |
| `get_stats` | 词库统计 | 0 |
| `lookup_lexicon` | 查已积累词库（不打亚马逊） | 1 |
| `get_keyword_trends` | 种子词排名历史矩阵（升/降/新上榜/落榜） | 2 |
| `rising_keywords` | 单词的上升/下降/新词/落榜清单 | 3 |
| `weekly_digest` | 全部种子词的周报摘要（一次调用） | 3 |
| `cross_site_gap` | 两个站点的联想词差集（市场空白） | 3 |
| `analyze_roots` | 词根/修饰词频率分析（卖点词、PPC 词包） | 5 |
| `search_suggestions` | 实时抓基础联想（live，受管控） | 10 |
| `search_suggestions_expand` | 实时 a-z 深度挖掘（live，较慢，受管控） | 30 |

价格在「系统设置」页可调；余额不足返回 `insufficient credits` 错误；每 key 每分钟限流可配。

### 实时抓取管控（live 工具）

`search_suggestions` / `search_suggestions_expand` 直打亚马逊，有三层管控（API Keys 页可管理）：

1. **按 Key 开关**：每个 API Key 可一键「允许 / 禁止」实时抓取
2. **按 Key 日限额**：每 Key 每天的 live 调用次数上限（默认 20，可改），UTC 零点重置
3. **全服日上限**：所有 Key 合计的 live 调用日上限（设置项 `mcp_live_global_daily`，默认 200）

live 抓到的词默认**落库**（合并进词库 + 原始报文归档 fetch_log，设置项 `mcp_live_persist` 可关掉变成纯透传），每个计费调用都会记录到 `api_calls` 审计表。

## 网络受限环境

容器内访问不了亚马逊时，设置代理环境变量（undici ProxyAgent 自动生效）：

```yaml
environment:
  - HTTPS_PROXY=http://host.docker.internal:7890
```

## 风险说明

该接口为亚马逊公开但未承诺的端点，可能限流（429）或改版。系统已做退避+熔断+报文归档兜底；请勿将抓取数据商用分发。
