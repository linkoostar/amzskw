# AMZ Lexicon — 亚马逊搜索联想词词库

把亚马逊下拉联想接口的数据**定期抓下来存成自己的词库**，并通过标准 MCP 协议供其他 agent 调用（内置 credits 计费）。

- 抓取源：`completion.amazon.com/api/2017/suggestions`（与 amztools 相同接口），15 个站点，支持基础联想 + a-z 扩展挖掘
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
| `get_keyword_trends` | 种子词排名历史矩阵 | 2 |
| `search_suggestions` | 实时抓基础联想（live） | 10 |
| `search_suggestions_expand` | 实时 a-z 深度挖掘（live，较慢） | 30 |

价格在「系统设置」页可调；余额不足返回 `insufficient credits` 错误；每 key 每分钟限流可配。

## 网络受限环境

容器内访问不了亚马逊时，设置代理环境变量（undici ProxyAgent 自动生效）：

```yaml
environment:
  - HTTPS_PROXY=http://host.docker.internal:7890
```

## 风险说明

该接口为亚马逊公开但未承诺的端点，可能限流（429）或改版。系统已做退避+熔断+报文归档兜底；请勿将抓取数据商用分发。
