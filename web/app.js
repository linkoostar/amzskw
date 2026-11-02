/* AMZ Lexicon admin SPA (Vue 3 global build, no bundler) */
const { createApp } = Vue;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { throw Object.assign(new Error('unauthorized'), { code: 401 }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}
function fmtDate(s) { return s ? String(s).replace('T', ' ').slice(0, 16) : '—'; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

const App = {
  data() {
    return {
      authed: false, ready: false, loginPassword: '', loginErr: '',
      route: 'dashboard',
      toast: '',
      stats: null,
      sites: [],
      // keywords
      kwList: [], kwFilters: { status: '', mid: '', search: '' },
      kwForm: { text: '', mid: 'ATVPDKIKX0DER', alias: 'aps', note: '' },
      importText: '', importMid: 'ATVPDKIKX0DER', importAlias: 'aps',
      snapshot: null, snapLoading: false,
      // runs
      runList: [], runDetail: null, runPoll: null,
      // trends
      trendKid: null, trendRuns: 12, trendData: null, trendLoading: false,
      // lexicon
      lexQuery: '', lexMid: '', lexData: null, lexPage: 0, lexJump: 1, lexSort: 'cnt', lexDir: 'desc',
      // keys
      keyList: [], keyForm: { name: '', credits: 100 }, newKey: null, ledger: null, ledgerName: '',
      // settings
      settingsForm: {}, pricingRows: [], settingsMsg: '',
      modal: null, // {title, body, wide}
    };
  },
  computed: {
    keywordOptions() { return this.kwList; },
    lexTotalPages() { return this.lexData ? Math.max(1, Math.ceil(this.lexData.total / 50)) : 1; },
    mcpConfig() {
      if (!this.newKey) return '';
      return JSON.stringify({
        mcpServers: {
          'amz-lexicon': {
            url: location.origin + '/mcp',
            headers: { Authorization: 'Bearer ' + this.newKey.key },
          },
        },
      }, null, 2);
    },
  },
  async mounted() {
    window.addEventListener('hashchange', () => this.onRoute());
    try { await api('GET', '/api/auth/me').then(r => this.authed = r.authed); } catch {}
    this.ready = true;
    if (this.authed) this.onRoute(true);
  },
  methods: {
    fmtDate, esc,
    nav(r) { location.hash = '#' + r; },
    onRoute(force) {
      if (!this.authed) return;
      const r = (location.hash.slice(1) || 'dashboard');
      this.route = r;
      this.toast = '';
      if (r === 'dashboard') this.loadStats();
      if (r === 'keywords') this.loadKeywords();
      if (r === 'runs') { this.loadRuns(); this.startPoll(); } else this.stopPoll();
      if (r === 'trends') { this.loadKeywords().then(() => { if (!this.trendKid && this.kwList.length) this.trendKid = this.kwList[0].id; if (this.trendKid) this.loadTrend(); }); }
      if (r === 'lexicon') this.loadLexicon();
      if (r === 'keys') this.loadKeys();
      if (r === 'settings') this.loadSettings();
      if (r === 'dashboard') this.loadSites();
    },
    notify(msg) { this.toast = msg; setTimeout(() => { if (this.toast === msg) this.toast = ''; }, 4000); },

    async login() {
      this.loginErr = '';
      try {
        await api('POST', '/api/auth/login', { password: this.loginPassword });
        this.authed = true;
        await this.loadSites();
        this.onRoute(true);
      } catch (e) { this.loginErr = '密码错误'; }
    },
    async logout() { await api('POST', '/api/auth/logout'); this.authed = false; },

    async loadStats() { try { this.stats = await api('GET', '/api/stats'); } catch (e) { this.handleErr(e); } },
    async loadSites() {
      if (this.sites.length) return;
      try { this.sites = await api('GET', '/api/sites'); } catch {}
    },
    siteFlag(mid) { const s = this.sites.find(x => x.mid === mid); return s ? s.flag : mid; },

    // ------------------------------------------------------------ keywords
    async loadKeywords() {
      try {
        const p = new URLSearchParams(Object.fromEntries(Object.entries(this.kwFilters).filter(([, v]) => v)));
        this.kwList = await api('GET', '/api/keywords?' + p);
      } catch (e) { this.handleErr(e); }
    },
    async addKeyword() {
      if (!this.kwForm.text.trim()) return;
      try {
        await api('POST', '/api/keywords', this.kwForm);
        this.kwForm.text = ''; this.kwForm.note = '';
        this.notify('已添加关键词');
        this.loadKeywords();
      } catch (e) { this.handleErr(e); }
    },
    async importKeywords() {
      try {
        const r = await api('POST', '/api/keywords/import', { text: this.importText, mid: this.importMid, alias: this.importAlias });
        this.notify(`导入完成：新增 ${r.added}，跳过重复 ${r.skipped}`);
        this.importText = '';
        this.loadKeywords();
      } catch (e) { this.handleErr(e); }
    },
    async toggleKw(kw) {
      await api('PATCH', '/api/keywords/' + kw.id, { status: kw.status === 'active' ? 'paused' : 'active' });
      this.loadKeywords();
    },
    async delKw(kw) {
      if (!confirm(`删除关键词「${kw.text}」？历史数据将保留在词库，但不再继续追踪。`)) return;
      await api('DELETE', '/api/keywords/' + kw.id);
      this.loadKeywords();
    },
    async fetchKw(kw) {
      try {
        const r = await api('POST', '/api/runs', { keyword_ids: [kw.id] });
        this.notify(`已创建抓取任务 #${r.run_id}，请到「抓取任务」页查看进度`);
      } catch (e) { this.handleErr(e); }
    },
    async showSnapshot(kw) {
      this.modal = { type: 'snapshot', title: `快照 — ${kw.text} (${this.siteFlag(kw.mid)})`, snap: null };
      try {
        const r = await api('GET', `/api/keywords/${kw.id}/snapshot`);
        this.modal = {
          type: 'snapshot', title: `快照 — ${kw.text} (${this.siteFlag(kw.mid)})`,
          snap: r.snapshot ? { fetched_at: r.snapshot.fetched_at, basic: r.snapshot.basic, expand: r.snapshot.expand } : null,
        };
      } catch (e) { this.handleErr(e); this.closeModal(); }
    },

    // ---------------------------------------------------------------- runs
    async loadRuns() { try { this.runList = await api('GET', '/api/runs?limit=100'); } catch (e) { this.handleErr(e); } },
    startPoll() { this.stopPoll(); this.runPoll = setInterval(() => { if (this.route === 'runs') this.loadRuns(); }, 5000); },
    stopPoll() { if (this.runPoll) { clearInterval(this.runPoll); this.runPoll = null; } },
    async triggerRun() {
      try {
        const r = await api('POST', '/api/runs', {});
        this.notify(`已启动全量抓取任务 #${r.run_id}`);
        this.loadRuns();
      } catch (e) { this.handleErr(e); }
    },
    async showRun(run) {
      const d = await api('GET', '/api/runs/' + run.id);
      this.modal = { title: `任务 #${run.id} 详情`, run: d.run, items: d.items, type: 'run' };
      if (d.run.status === 'running' || d.run.status === 'pending') {
        setTimeout(async () => {
          if (this.modal && this.modal.type === 'run' && this.modal.run.id === run.id) {
            const fresh = await api('GET', '/api/runs/' + run.id);
            this.modal = { title: `任务 #${run.id} 详情`, run: fresh.run, items: fresh.items, type: 'run' };
            if (fresh.run.status === 'running' || fresh.run.status === 'pending') setTimeout(() => this.pollModal(run.id), 5000);
          }
        }, 5000);
      }
    },
    async pollModal(runId) {
      if (!this.modal || this.modal.type !== 'run' || this.modal.run.id !== runId) return;
      const fresh = await api('GET', '/api/runs/' + runId);
      if (!this.modal || this.modal.type !== 'run' || this.modal.run.id !== runId) return;
      this.modal = { title: `任务 #${runId} 详情`, run: fresh.run, items: fresh.items, type: 'run' };
      if (fresh.run.status === 'running' || fresh.run.status === 'pending') setTimeout(() => this.pollModal(runId), 5000);
      else this.loadRuns();
    },
    async cancelRun(run) {
      await api('POST', `/api/runs/${run.id}/cancel`);
      this.notify(`任务 #${run.id} 已请求取消`);
      this.loadRuns();
    },
    runStatusTag(s) {
      return { done: 'green', running: 'blue', pending: 'gray', failed: 'red', cancelled: 'amber', skipped: 'gray' }[s] || 'gray';
    },

    // -------------------------------------------------------------- trends
    async loadTrend() {
      if (!this.trendKid) return;
      this.trendLoading = true;
      try { this.trendData = await api('GET', `/api/trends?keyword_id=${this.trendKid}&runs=${this.trendRuns}`); }
      catch (e) { this.handleErr(e); }
      this.trendLoading = false;
    },
    trendArrow(row) {
      return { up: '<span class="badge-up">↑' + row.prev + '→' + row.latest + '</span>', down: '<span class="badge-down">↓' + row.prev + '→' + row.latest + '</span>', same: '<span class="muted">·</span>', new: '<span class="badge-new">NEW</span>', out: '<span class="badge-out">落榜</span>' }[row.trend] || '';
    },

    // ------------------------------------------------------------- lexicon
    async loadLexicon() {
      try {
        const p = new URLSearchParams({ query: this.lexQuery, limit: '50', offset: String(this.lexPage * 50), sort: this.lexSort, dir: this.lexDir });
        if (this.lexMid) p.set('mid', this.lexMid);
        this.lexData = await api('GET', '/api/lexicon?' + p);
        this.lexJump = this.lexPage + 1;
      } catch (e) { this.handleErr(e); }
    },
    sortLex(col) {
      if (this.lexSort === col) {
        this.lexDir = this.lexDir === 'asc' ? 'desc' : 'asc';
      } else {
        this.lexSort = col;
        this.lexDir = (col === 'cnt' || col === 'first' || col === 'last') ? 'desc' : 'asc';
      }
      this.lexPage = 0;
      this.loadLexicon();
    },
    lexArrow(col) {
      if (this.lexSort !== col) return '';
      return this.lexDir === 'asc' ? '▲' : '▼';
    },
    jumpLex() {
      const p = Math.min(Math.max(1, Math.round(Number(this.lexJump) || 1)), this.lexTotalPages);
      this.lexPage = p - 1;
      this.loadLexicon();
    },

    // ---------------------------------------------------------------- keys
    async loadKeys() { try { this.keyList = await api('GET', '/api/keys'); } catch (e) { this.handleErr(e); } },
    async createKey() {
      try {
        this.newKey = await api('POST', '/api/keys', this.keyForm);
        this.loadKeys();
      } catch (e) { this.handleErr(e); }
    },
    async revokeKey(k) {
      if (!confirm(`吊销 ${k.name}？使用该 key 的 agent 将立即失效。`)) return;
      await api('POST', `/api/keys/${k.id}/revoke`);
      this.loadKeys();
    },
    async delKey(k) {
      if (!confirm(`彻底删除「${k.name}」？其余额与 credits 流水将一并清除，不可恢复！建议先用「吊销」保留记录。`)) return;
      await api('DELETE', '/api/keys/' + k.id);
      this.notify('已删除');
      this.loadKeys();
    },
    async topupKey(k, current) {
      const v = prompt(`为「${k.name}」充值 credits（正数充值，负数扣减）:`, '1000');
      if (v === null) return;
      const amount = Math.round(Number(v));
      if (!Number.isFinite(amount) || amount === 0) return;
      await api('POST', `/api/keys/${k.id}/topup`, { amount, note: current });
      this.loadKeys();
    },
    async showLedger(k) {
      const rows = await api('GET', `/api/keys/${k.id}/ledger`);
      this.modal = { title: `Credits 流水 — ${k.name}`, rows, type: 'ledger' };
    },

    // ------------------------------------------------------------ settings
    async loadSettings() {
      try {
        const d = await api('GET', '/api/settings');
        this.settingsForm = d.settings;
        this.pricingRows = d.pricing;
      } catch (e) { this.handleErr(e); }
    },
    async saveSettings() {
      const pricing = {};
      this.pricingRows.forEach(p => pricing[p.tool] = p.price);
      await api('PUT', '/api/settings', { settings: this.settingsForm, pricing });
      this.settingsMsg = '已保存，调度已按新 cron 重新加载';
      setTimeout(() => this.settingsMsg = '', 3500);
      this.loadSettings();
    },

    handleErr(e) {
      if (e.code === 401) { this.authed = false; return; }
      alert(e.message || e);
    },
    closeModal() { this.modal = null; },
    async copyText(t) { try { await navigator.clipboard.writeText(t); this.notify('已复制'); } catch {} },
  },
  template: `
<div v-if="!ready"></div>
<div v-else-if="!authed" class="login-wrap">
  <form class="login" @submit.prevent="login">
    <h2>AMZ Lexicon</h2>
    <p>亚马逊搜索联想词词库 · 管理后台</p>
    <div v-if="loginErr" class="err">{{loginErr}}</div>
    <input type="password" v-model="loginPassword" placeholder="管理员密码" autofocus>
    <button class="btn primary" type="submit">登 录</button>
  </form>
</div>
<div v-else class="layout">
  <aside class="sidebar">
    <div class="logo">AMZ Lexicon<small>亚马逊联想词词库</small></div>
    <nav class="nav">
      <a :class="{on:route==='dashboard'}" href="#dashboard">📊 仪表盘</a>
      <a :class="{on:route==='keywords'}" href="#keywords">🔑 关键词管理</a>
      <a :class="{on:route==='runs'}" href="#runs">🚚 抓取任务</a>
      <a :class="{on:route==='trends'}" href="#trends">📈 排名趋势</a>
      <a :class="{on:route==='lexicon'}" href="#lexicon">📚 词库检索</a>
      <a :class="{on:route==='keys'}" href="#keys">🎫 API Keys / 计费</a>
      <a :class="{on:route==='settings'}" href="#settings">⚙️ 系统设置</a>
    </nav>
    <div style="padding:14px 18px;font-size:11px;color:#5d6b81">
      MCP: <span class="mono" style="color:#8ea2bd">POST /mcp</span>
    </div>
  </aside>
  <main class="main">
    <div class="topbar">
      <h1>{{ {dashboard:'仪表盘',keywords:'关键词管理',runs:'抓取任务',trends:'排名趋势',lexicon:'词库检索',keys:'API Keys / Credits 计费',settings:'系统设置'}[route] }}</h1>
      <div class="userbox" v-if="toast"><span class="okmsg" style="margin:0">{{toast}}</span></div>
      <div class="userbox"><button class="btn sm" @click="logout">退出</button></div>
    </div>

    <!-- ==================== DASHBOARD ==================== -->
    <template v-if="route==='dashboard'">
      <div class="grid cols4" v-if="stats">
        <div class="stat"><div class="l">种子关键词</div><div class="v">{{stats.keywords}}</div><div class="sub">活跃 {{stats.keywordsActive}} 个</div></div>
        <div class="stat"><div class="l">词库总量</div><div class="v">{{stats.lexicon}}</div><div class="sub">近 7 天新增 {{stats.lexicon7d}}</div></div>
        <div class="stat"><div class="l">联想词快照记录</div><div class="v">{{stats.suggestions}}</div><div class="sub">历史批次 {{stats.runs}} 次</div></div>
        <div class="stat"><div class="l">24h 抓取健康</div><div class="v">{{stats.fetch24h.total - stats.fetch24h.errors}}<span style="font-size:13px;color:var(--muted)">/{{stats.fetch24h.total}}</span></div><div class="sub">失败 {{stats.fetch24h.errors}} 次</div></div>
        <div class="stat"><div class="l">API Keys</div><div class="v">{{stats.apiKeys}}</div><div class="sub">余额合计 {{stats.creditsTotal}} credits</div></div>
        <div class="stat"><div class="l">周调度</div><div class="v mono" style="font-size:15px">{{stats.scheduler.cron}}</div>
          <div class="sub"><span class="pill-run" :class="{off:!stats.scheduler.active}"><i></i>{{stats.scheduler.active?'运行中':'未启用'}}</span>
          <span v-if="stats.breaker.pausedUntil && Date.now()<stats.breaker.pausedUntil" style="color:var(--amber)">· 熔断暂停中</span></div></div>
        <div class="stat" style="grid-column:span 2"><div class="l">最近任务</div>
          <div v-if="stats.lastRun" style="font-size:13px;margin-top:4px">
            #{{stats.lastRun.id}} · {{stats.lastRun.trigger_type==='weekly'?'周调度':'手动'}} ·
            <span class="tag" :class="runStatusTag(stats.lastRun.status)">{{stats.lastRun.status}}</span>
            <div class="muted" style="margin-top:3px">{{fmtDate(stats.lastRun.started_at)}} · {{stats.lastRun.done_keywords}}/{{stats.lastRun.total_keywords}} 词</div>
          </div>
          <div v-else class="muted">尚无任务，去「抓取任务」页启动第一次抓取</div>
        </div>
      </div>
      <div class="card" style="margin-top:18px">
        <h3>MCP 接入</h3>
        <p class="muted" style="margin-bottom:8px">其他 agent 通过标准 MCP Streamable HTTP 协议调用本词库：</p>
        <div class="mono" style="background:#0f172a;color:#93c5fd;padding:12px 14px;border-radius:8px;font-size:12px;line-height:1.8">
          URL&nbsp;&nbsp;&nbsp;: http://&lt;host&gt;:&lt;port&gt;/mcp<br>
          Auth&nbsp;&nbsp;: Authorization: Bearer &lt;api key&gt;<br>
          Tools&nbsp;: lookup_lexicon · get_keyword_trends · search_suggestions · search_suggestions_expand · list_sites · get_stats
        </div>
        <p class="muted" style="margin-top:8px">在「API Keys」页创建密钥并充值 credits 后即可使用。</p>
      </div>
    </template>

    <!-- ==================== KEYWORDS ==================== -->
    <template v-else-if="route==='keywords'">
      <div class="grid cols2">
        <div class="card">
          <h3>添加关键词</h3>
          <div class="row" style="margin-bottom:10px">
            <input v-model="kwForm.text" placeholder="关键词，如 starlink mini" style="flex:1;min-width:180px" @keyup.enter="addKeyword">
            <select v-model="kwForm.mid"><option v-for="s in sites" :value="s.mid">{{s.flag}} {{s.name}}</option></select>
          </div>
          <div class="row">
            <input v-model="kwForm.note" placeholder="备注（可选）" style="flex:1">
            <button class="btn primary" @click="addKeyword">添加</button>
          </div>
        </div>
        <div class="card">
          <h3>批量导入（每行一个）</h3>
          <textarea v-model="importText" placeholder="starlink mini&#10;portable power station&#10;..."></textarea>
          <div class="row" style="margin-top:10px">
            <select v-model="importMid"><option v-for="s in sites" :value="s.mid">{{s.flag}} {{s.name}}</option></select>
            <button class="btn primary" @click="importKeywords">导入</button>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="filters">
          <select v-model="kwFilters.mid" @change="loadKeywords"><option value="">全部站点</option><option v-for="s in sites" :value="s.mid">{{s.flag}} {{s.name}}</option></select>
          <select v-model="kwFilters.status" @change="loadKeywords"><option value="">全部状态</option><option value="active">活跃</option><option value="paused">暂停</option></select>
          <input v-model="kwFilters.search" placeholder="搜索关键词" @keyup.enter="loadKeywords">
          <button class="btn sm" @click="loadKeywords">筛选</button>
        </div>
        <table v-if="kwList.length">
          <thead><tr><th>关键词</th><th>站点</th><th>状态</th><th class="num">联想词总数</th><th>最近抓取</th><th>备注</th><th style="width:230px"></th></tr></thead>
          <tbody>
            <tr v-for="kw in kwList" :key="kw.id">
              <td style="font-weight:600">{{kw.text}}</td>
              <td>{{siteFlag(kw.mid)}}</td>
              <td><span class="tag" :class="kw.status==='active'?'green':'gray'">{{kw.status==='active'?'活跃':'暂停'}}</span></td>
              <td class="num">{{kw.suggestion_count}}</td>
              <td class="muted">{{fmtDate(kw.last_fetched)}}</td>
              <td class="muted">{{kw.note}}</td>
              <td>
                <div class="row" style="flex-wrap:nowrap">
                  <button class="btn sm" @click="showSnapshot(kw)">快照</button>
                  <button class="btn sm" @click="fetchKw(kw)">立即抓取</button>
                  <button class="btn sm" @click="toggleKw(kw)">{{kw.status==='active'?'暂停':'启用'}}</button>
                  <button class="btn sm danger" @click="delKw(kw)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">还没有关键词，先在上面添加或批量导入</div>
      </div>
    </template>

    <!-- ==================== RUNS ==================== -->
    <template v-else-if="route==='runs'">
      <div class="card">
        <div class="row" style="justify-content:space-between">
          <div>
            <h3 style="margin-bottom:4px">抓取批次</h3>
            <p class="muted">周调度自动创建，也可手动触发全量抓取。抓取过程自动随机延迟 + 退避，避免触发反爬。</p>
          </div>
          <button class="btn primary" @click="triggerRun">▶ 立即全量抓取</button>
        </div>
      </div>
      <div class="card">
        <table v-if="runList.length">
          <thead><tr><th>#</th><th>触发</th><th>状态</th><th>进度</th><th class="num">请求</th><th class="num">失败</th><th>开始时间</th><th>结束时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in runList" :key="r.id">
              <td>{{r.id}}</td>
              <td>{{r.trigger_type==='weekly'?'周调度':'手动'}}</td>
              <td><span class="tag" :class="runStatusTag(r.status)">{{r.status}}</span></td>
              <td style="min-width:130px">
                <div class="progress"><i :style="{width:(r.total_keywords? Math.round(r.done_keywords/r.total_keywords*100):0)+'%'}"></i></div>
                <span class="muted" style="font-size:11px">{{r.done_keywords}}/{{r.total_keywords}}</span>
              </td>
              <td class="num">{{r.total_requests}}</td>
              <td class="num" :style="{color:r.error_requests>0?'var(--red)':''}">{{r.error_requests}}</td>
              <td class="muted">{{fmtDate(r.started_at)}}</td>
              <td class="muted">{{fmtDate(r.finished_at)}}</td>
              <td><div class="row" style="flex-wrap:nowrap">
                <button class="btn sm" @click="showRun(r)">详情</button>
                <button v-if="r.status==='running'||r.status==='pending'" class="btn sm danger" @click="cancelRun(r)">取消</button>
              </div></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无抓取任务</div>
      </div>
    </template>

    <!-- ==================== TRENDS ==================== -->
    <template v-else-if="route==='trends'">
      <div class="card">
        <div class="row">
          <select v-model="trendKid" @change="loadTrend" style="min-width:220px">
            <option v-for="kw in keywordOptions" :key="kw.id" :value="kw.id">{{siteFlag(kw.mid)}} {{kw.text}}</option>
          </select>
          <select v-model.number="trendRuns" @change="loadTrend">
            <option :value="6">最近 6 次快照</option><option :value="12">最近 12 次</option><option :value="26">最近 26 次</option><option :value="52">最近 52 次</option>
          </select>
          <a v-if="trendData && trendData.runs.length" class="btn sm" :href="'/api/trends/export?keyword_id='+trendKid">导出 CSV</a>
          <span v-if="trendLoading" class="muted">加载中…</span>
        </div>
        <p class="muted" style="margin-top:8px">每次周调度都是一次快照。基础联想的返回顺序 = 搜索框真实排名，跨快照对比即可看到升降变化。</p>
      </div>
      <div class="card" v-if="trendData">
        <div v-if="trendData.rows.length===0" class="empty">该关键词还没有快照数据，先执行一次抓取</div>
        <div v-else style="overflow:auto">
          <table>
            <thead><tr>
              <th style="min-width:180px">联想词</th>
              <th v-for="r in trendData.runs" :key="r.run_id" class="num">{{r.date.slice(0,10)}}</th>
              <th>变化</th><th class="num">首次收录</th>
            </tr></thead>
            <tbody>
              <tr v-for="row in trendData.rows" :key="row.phrase">
                <td>{{row.phrase}}</td>
                <td v-for="(p,i) in row.positions" :key="i" class="num">
                  <span v-if="p===null" class="ranknull">—</span>
                  <b v-else :style="{color: p===1?'var(--green)': p<=5?'var(--text)':'var(--muted)'}">{{p}}</b>
                </td>
                <td v-html="trendArrow(row)"></td>
                <td class="num muted">{{row.first_seen.slice(0,10)}}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- ==================== LEXICON ==================== -->
    <template v-else-if="route==='lexicon'">
      <div class="card">
        <div class="row">
          <input v-model="lexQuery" placeholder="搜索词库，如 starlink" style="flex:1" @keyup.enter="lexPage=0;loadLexicon()">
          <select v-model="lexMid"><option value="">全部站点</option><option v-for="s in sites" :value="s.mid">{{s.flag}} {{s.name}}</option></select>
          <button class="btn primary" @click="lexPage=0;loadLexicon()">搜索</button>
        </div>
        <p class="muted" style="margin-top:8px">词库 = 所有种子词历次抓取发现的联想词去重合集，记录首次/最近收录时间与出现次数。</p>
      </div>
      <div class="card" v-if="lexData">
        <p class="muted" style="margin-bottom:10px">共 {{lexData.total}} 条</p>
        <table v-if="lexData.items.length">
          <thead><tr>
            <th class="sortable" @click="sortLex('phrase')">联想词 {{lexArrow('phrase')}}</th>
            <th class="sortable" @click="sortLex('site')">站点 {{lexArrow('site')}}</th>
            <th class="sortable num" @click="sortLex('cnt')">出现次数 {{lexArrow('cnt')}}</th>
            <th class="sortable" @click="sortLex('first')">首次收录 {{lexArrow('first')}}</th>
            <th class="sortable" @click="sortLex('last')">最近收录 {{lexArrow('last')}}</th>
          </tr></thead>
          <tbody>
            <tr v-for="it in lexData.items" :key="it.id">
              <td style="font-weight:600">{{it.phrase}}</td>
              <td>{{siteFlag(it.mid)}}</td>
              <td class="num">{{it.seen_count}}</td>
              <td class="muted">{{it.first_seen_at.slice(0,10)}}</td>
              <td class="muted">{{it.last_seen_at.slice(0,10)}}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">无匹配结果</div>
        <div class="row" style="margin-top:12px;justify-content:center" v-if="lexData.total>50">
          <button class="btn sm" :disabled="lexPage===0" @click="lexPage--;loadLexicon()">上一页</button>
          <span class="muted">第 {{lexPage+1}} / {{lexTotalPages}} 页</span>
          <button class="btn sm" :disabled="lexPage+1>=lexTotalPages" @click="lexPage++;loadLexicon()">下一页</button>
          <input v-model.number="lexJump" type="number" min="1" :max="lexTotalPages" style="width:90px" @keyup.enter="jumpLex" title="输入页码后回车">
          <button class="btn sm" @click="jumpLex">跳转</button>
        </div>
      </div>
    </template>

    <!-- ==================== KEYS ==================== -->
    <template v-else-if="route==='keys'">
      <div class="card">
        <h3>创建 API Key</h3>
        <div class="row">
          <input v-model="keyForm.name" placeholder="调用方名称，如 claude-agent" style="width:220px">
          <input v-model.number="keyForm.credits" type="number" placeholder="初始 credits" style="width:130px">
          <button class="btn primary" @click="createKey">生成</button>
        </div>
        <div v-if="newKey" class="okmsg" style="margin-top:12px">
          请立即保存（仅显示一次）：<br>
          <span class="mono" style="font-size:13px">{{newKey.key}}</span>
          <button class="btn sm" style="margin-left:8px" @click="copyText(newKey.key)">复制</button>
        </div>
        <div v-if="newKey" style="margin-top:12px">
          <h3 style="font-size:13px;margin-bottom:6px">MCP 客户端配置（粘贴到 agent 的 mcp 设置里）</h3>
          <pre class="mono" style="white-space:pre-wrap;background:#0f172a;color:#93c5fd;padding:12px 14px;border-radius:8px;font-size:12px">{{mcpConfig}}</pre>
          <button class="btn sm primary" @click="copyText(mcpConfig)">复制完整 MCP 配置</button>
        </div>
      </div>
      <div class="card">
        <table v-if="keyList.length">
          <thead><tr><th>名称</th><th>Key</th><th>状态</th><th class="num">Credits 余额</th><th>最近调用</th><th>创建时间</th><th style="width:230px"></th></tr></thead>
          <tbody>
            <tr v-for="k in keyList" :key="k.id">
              <td style="font-weight:600">{{k.name}}</td>
              <td class="mono muted">{{k.key_prefix}}…</td>
              <td><span class="tag" :class="k.active?'green':'red'">{{k.active?'有效':'已吊销'}}</span></td>
              <td class="num"><b>{{k.credits_balance}}</b></td>
              <td class="muted">{{fmtDate(k.last_used_at)}}</td>
              <td class="muted">{{fmtDate(k.created_at)}}</td>
              <td><div class="row" style="flex-wrap:nowrap">
                <button class="btn sm" @click="topupKey(k,'充值')">充值</button>
                <button class="btn sm" @click="showLedger(k)">流水</button>
                <button v-if="k.active" class="btn sm danger" @click="revokeKey(k)">吊销</button>
                <button class="btn sm danger" @click="delKey(k)">删除</button>
              </div></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">还没有 API Key</div>
      </div>
    </template>

    <!-- ==================== SETTINGS ==================== -->
    <template v-else-if="route==='settings'">
      <div class="card">
        <h3>运行参数</h3>
        <div v-if="settingsMsg" class="okmsg">{{settingsMsg}}</div>
        <div class="settings-grid" v-if="settingsForm.cron!==undefined">
          <template v-if="settingsForm.suggest_api_url!==undefined">
            <div class="group-title">抓取源（联想词接口地址，存在数据库，可随时更换；不带 ? 参数，兼容带参数的完整地址）</div>
            <label>接口地址<input v-model="settingsForm.suggest_api_url" class="mono"></label>
          </template>

          <div class="group-title">周调度</div>
          <label>cron 表达式（周几几点抓取）<input v-model="settingsForm.cron"></label>
          <label>随机启动延迟上限（毫秒，打散启动时间）<input v-model="settingsForm.start_jitter_max_ms" type="number"></label>

          <div class="group-title">反爬节奏（速度换安全，宁慢勿封）</div>
          <label>请求间随机延迟下限（毫秒）<input v-model="settingsForm.request_delay_min_ms" type="number"></label>
          <label>请求间随机延迟上限（毫秒）<input v-model="settingsForm.request_delay_max_ms" type="number"></label>
          <label>长停顿触发概率（0-1，模拟人类走神）<input v-model="settingsForm.pause_chance" type="number" step="0.01"></label>
          <label>长停顿时长下限（毫秒）<input v-model="settingsForm.pause_min_ms" type="number"></label>
          <label>长停顿时长上限（毫秒）<input v-model="settingsForm.pause_max_ms" type="number"></label>

          <div class="group-title">抓取范围</div>
          <label>基础联想返回条数<input v-model="settingsForm.basic_limit" type="number"></label>
          <label>扩展挖掘：取前 N 个基础词做字母扩展<input v-model="settingsForm.expand_top" type="number"></label>
          <label>扩展字母表<input v-model="settingsForm.alphabet"></label>

          <div class="group-title">容错与熔断</div>
          <label>单请求最大重试次数<input v-model="settingsForm.max_retries" type="number"></label>
          <label>退避基数（毫秒，指数×2）<input v-model="settingsForm.backoff_base_ms" type="number"></label>
          <label>退避上限（毫秒）<input v-model="settingsForm.backoff_cap_ms" type="number"></label>
          <label>连续失败 N 次触发熔断<input v-model="settingsForm.breaker_threshold" type="number"></label>
          <label>熔断暂停时长（毫秒）<input v-model="settingsForm.breaker_pause_ms" type="number"></label>

          <div class="group-title">存储与 MCP</div>
          <label>fetch_log 原始报文保留天数<input v-model="settingsForm.fetch_log_keep_days" type="number"></label>
          <label>MCP 限流（每 key 每分钟调用上限）<input v-model="settingsForm.mcp_rate_limit_per_min" type="number"></label>
        </div>
      </div>
      <div class="card">
        <h3>MCP Tool 定价（credits / 次）</h3>
        <table>
          <thead><tr><th>Tool</th><th style="width:140px">价格</th></tr></thead>
          <tbody>
            <tr v-for="p in pricingRows" :key="p.tool">
              <td class="mono">{{p.tool}}</td>
              <td><input v-model.number="p.price" type="number" min="0" style="width:110px"></td>
            </tr>
          </tbody>
        </table>
        <button class="btn primary" style="margin-top:14px" @click="saveSettings">保存全部设置</button>
      </div>
    </template>

    <!-- ==================== MODAL ==================== -->
    <div v-if="modal" class="modal-mask" @click.self="closeModal">
      <div class="modal" style="width:900px">
        <button class="close" @click="closeModal">✕</button>
        <h3>{{modal.title}}</h3>

        <template v-if="modal.type==='run'">
          <div class="row" style="margin-bottom:12px">
            <span class="tag" :class="runStatusTag(modal.run.status)">{{modal.run.status}}</span>
            <span class="muted">{{modal.run.done_keywords}}/{{modal.run.total_keywords}} 关键词 · 请求 {{modal.run.total_requests}} · 失败 {{modal.run.error_requests}}</span>
          </div>
          <div class="progress" style="margin-bottom:14px"><i :style="{width:(modal.run.total_keywords? Math.round(modal.run.done_keywords/modal.run.total_keywords*100):0)+'%'}"></i></div>
          <div style="max-height:420px;overflow:auto">
            <table>
              <thead><tr><th>关键词</th><th>站点</th><th>状态</th><th class="num">基础</th><th class="num">扩展</th><th class="num">请求</th><th>错误</th></tr></thead>
              <tbody>
                <tr v-for="it in modal.items" :key="it.id">
                  <td>{{it.keyword_text}}</td>
                  <td>{{siteFlag(it.mid)}}</td>
                  <td><span class="tag" :class="runStatusTag(it.status)">{{it.status}}</span></td>
                  <td class="num">{{it.basic_count}}</td>
                  <td class="num">{{it.expand_count}}</td>
                  <td class="num">{{it.request_count}}</td>
                  <td class="muted" style="font-size:11px">{{it.error}}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else-if="modal.type==='ledger'">
          <table>
            <thead><tr><th>时间</th><th class="num">变动</th><th class="num">余额</th><th>原因</th><th>说明</th></tr></thead>
            <tbody>
              <tr v-for="r in modal.rows" :key="r.id">
                <td class="muted">{{fmtDate(r.created_at)}}</td>
                <td class="num" :style="{color:r.delta>0?'var(--green)':'var(--red)'}">{{r.delta>0?'+':''}}{{r.delta}}</td>
                <td class="num">{{r.balance_after}}</td>
                <td><span class="tag" :class="{green:r.reason==='topup',blue:r.reason==='tool_call',gray:r.reason!=='topup'&&r.reason!=='tool_call'}">{{r.reason}}</span></td>
                <td class="muted">{{r.detail}}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-else-if="modal.type==='snapshot' && modal.snap">
          <p class="muted" style="margin-bottom:10px">快照时间：{{fmtDate(modal.snap.fetched_at)}} · 基础 {{modal.snap.basic.length}} 条 · 扩展 {{modal.snap.expand.length}} 条</p>
          <div style="max-height:480px;overflow:auto">
            <h3 style="font-size:13px;margin:6px 0">基础联想（核心词 · 按搜索框排名）</h3>
            <table><tbody>
              <tr v-for="b in modal.snap.basic" :key="'b'+b.position">
                <td class="num" style="width:40px">{{b.position}}</td>
                <td>{{b.phrase}} <span class="tag blue" style="margin-left:6px">核心</span></td>
                <td class="muted">{{b.strategy_id}}</td>
              </tr>
            </tbody></table>
            <template v-if="modal.snap.expand.length">
              <h3 style="font-size:13px;margin:14px 0 6px">扩展联想（按字母排序）</h3>
              <table><tbody>
                <tr v-for="(e,i) in modal.snap.expand" :key="'e'+i">
                  <td class="num" style="width:40px">{{e.position}}</td><td>{{e.phrase}}</td>
                  <td class="muted">来自「{{e.parent}}」+ {{e.letter}}</td>
                </tr>
              </tbody></table>
            </template>
          </div>
        </template>
      </div>
    </div>
  </main>
</div>
`,
};

const app = createApp(App);
app.mount('#app');
