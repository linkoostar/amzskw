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
      route: 'modules',
      toast: '', errToast: '',
      // modules (base registry, drives navigation)
      modules: [], switchVar: 'AMZ_ENABLED_MODULES', navCollapsed: {},
      stats: null,
      sites: [],
      // keywords
      kwList: [], kwFilters: { status: '', mid: '', search: '', source: '' },
      kwForm: { text: '', mid: 'ATVPDKIKX0DER', alias: 'aps', note: '' },
      kwSelected: [],
      snapshot: null, snapLoading: false,
      pwForm: { old: '', new1: '', new2: '' },
      // runs
      runList: [], runDetail: null, runPoll: null,
      // trends
      trendKid: null, trendRuns: 12, trendData: null, trendLoading: false,
      trendKwQuery: '', trendKwOpen: false,
      // lexicon
      lexQuery: '', lexMid: '', lexData: null, lexPage: 0, lexJump: 1, lexSort: 'cnt', lexDir: 'desc',
      // reviews (negative intelligence)
      revOverview: null, revList: null, revSummary: null, revJobs: null, revJobPoll: null,
      revFilters: { asin: '', rating: '', keyword: '' }, revForm: { asin: '', country_code: 'US', max_reviews: 30 },
      revBusy: false, revPage: 0,
      // review library (global search across all stored negative reviews)
      libList: null, libPage: 0, libFilters: { asin: '', rating: '', keyword: '' }, libTotalPages: 1,
      // watched ASIN list + changes
      watchList: null, watchForm: { asin: '', country_code: 'US', note: '' }, watchBusy: false,
      changes: null, changesAsin: '', changesHours: 720,
      // apify token pool
      tokenData: null, tokenForm: { label: '', token: '', priority: 0, quota_limit_usd: 0 }, tokenBusy: false,
      dsForm: { apify_mode: 'mock', apify_token: '' },
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
    libTotalPages() { return this.libList ? Math.max(1, Math.ceil(this.libList.total / 30)) : 1; },
    trendKwOptions() {
      const q = this.trendKwQuery.trim().toLowerCase();
      // 输入框内容和选中项一致时不过滤，避免刚选中就被过滤到空列表
      const sel = this.kwList.find((k) => k.id === this.trendKid);
      if (sel && this.trendKwQuery === this.trendKwLabel(sel)) return this.kwList.slice(0, 60);
      const list = q ? this.kwList.filter((k) => k.text.toLowerCase().includes(q) || k.mid.toLowerCase().includes(q)) : this.kwList;
      return list.slice(0, 60);
    },
    // 哪些现有页面归属于哪个模块（模块 id -> 路由键数组）。
    // 新增模块只要在这里登记，侧边栏就自动出现对应入口；不改 template。
    moduleRoutes() {
      return {
        lexicon: [
          { route: 'dashboard', icon: '📊', label: '仪表盘' },
          { route: 'keywords', icon: '🔑', label: '关键词管理' },
          { route: 'runs', icon: '🚚', label: '抓取任务' },
          { route: 'trends', icon: '📈', label: '排名趋势' },
          { route: 'lexicon', icon: '📚', label: '词库检索' },
        ],
        reviews: [
          { route: 'reviews', icon: '⭐', label: '差评情报' },
          { route: 'reviewlib', icon: '🗂️', label: '差评库' },
          { route: 'reviewwatch', icon: '👁️', label: '监控 ASIN' },
          { route: 'reviewchanges', icon: '📉', label: '变化视图' },
        ],
      };
    },
    // 侧边栏短名：后端 name 是完整英文句，显示太长会折行；这里给每个模块一个中文短名。
    moduleShortNames() {
      return { lexicon: '联想词词库', reviews: 'ASIN 差评', system: '基座管理' };
    },
    // 后端模块清单 -> 分组导航。数据模块在前，系统管理在后。
    navGroups() {
      const groups = [];
      const active = this.modules.filter((m) => m.enabled);
      for (const m of active) {
        const pages = this.moduleRoutes[m.id];
        if (!pages) continue; // 已启用但前端尚无页面：只在模块总览展示，不生成空入口
        const hasActive = pages.some((p) => p.route === this.route);
        groups.push({
          key: m.id,
          label: this.moduleShortNames[m.id] || m.name,
          icon: m.id === 'reviews' ? '💬' : '🧩',
          core: m.core,
          // 默认：当前页所在分组展开、其余折叠；用户手动点过箭头则以手动值为准
          collapsed: this.navCollapsed[m.id] === undefined ? !hasActive : this.navCollapsed[m.id],
          items: pages.map((p) => ({ ...p, route: p.route })),
        });
      }
      const sysHasActive = ['modules', 'datasource', 'keys', 'settings'].includes(this.route);
      groups.push({
        key: 'system', label: this.moduleShortNames.system, icon: '⚙️', core: true,
        collapsed: this.navCollapsed.system === undefined ? !sysHasActive : this.navCollapsed.system,
        items: [
          { route: 'modules', icon: '🧩', label: '模块总览' },
          { route: 'datasource', icon: '🔌', label: '数据源配置' },
          { route: 'keys', icon: '🎫', label: 'API Keys / 计费' },
          { route: 'settings', icon: '⚙️', label: '系统设置' },
        ],
      });
      return groups;
    },
    routeTitle() {
      // 优先从模块页签找标题，否则用系统路由表
      for (const g of this.navGroups) {
        const hit = g.items.find((i) => i.route === this.route);
        if (hit) return hit.label;
      }
      return { modules: '模块总览', datasource: '数据源配置（Apify / Token 池）', keys: 'API Keys / Credits 计费', settings: '系统设置' }[this.route] || this.route;
    },
    mcpConfig() {
      if (!this.newKey) return '';
      return JSON.stringify({
        mcpServers: {
          'amz-lexicon': {
            url: location.origin + '/mcp',
            headers: {
              Authorization: 'Bearer ' + this.newKey.key,
              'X-Client-Id': '把这里改成调用方名字，如 alice-claude（多人共用 key 时用于区分身份）',
            },
          },
        },
      }, null, 2);
    },
  },
  async mounted() {
    window.addEventListener('hashchange', () => this.onRoute());
    try { await api('GET', '/api/auth/me').then(r => this.authed = r.authed); } catch {}
    this.ready = true;
    if (this.authed) {
      await this.loadModules();
      this.onRoute(true);
    }
  },
  methods: {
    fmtDate, esc,
    nav(r) { location.hash = '#' + r; },
    toggleGroup(key) { this.navCollapsed[key] = !this.navCollapsed[key]; },
    onRoute(force) {
      if (!this.authed) return;
      const r = (location.hash.slice(1) || 'modules');
      this.route = r;
      this.toast = '';
      if (r !== 'reviews') this.stopRevPoll();
      if (r === 'modules') return; // 模块总览数据已在 mounted 加载
      if (r === 'dashboard') this.loadStats();
      if (r === 'keywords') this.loadKeywords();
      if (r === 'runs') { this.loadRuns(); this.startPoll(); } else this.stopPoll();
      if (r === 'trends') { this.loadKeywords().then(() => { if (!this.trendKid && this.kwList.length) this.trendKid = this.kwList[0].id; if (this.trendKid) { this.syncTrendKwQuery(); this.loadTrend(); } }); }
      if (r === 'lexicon') this.loadLexicon();
      if (r === 'reviews') this.loadReviewsOverview();
      if (r === 'reviewlib') this.loadLib();
      if (r === 'reviewwatch') this.loadWatch();
      if (r === 'reviewchanges') this.loadChanges();
      if (r === 'datasource') this.loadTokens();
      if (r === 'keys') this.loadKeys();
      if (r === 'settings') this.loadSettings();
      if (r === 'dashboard') this.loadSites();
    },
    notify(msg) { this.errToast = ''; this.toast = msg; setTimeout(() => { if (this.toast === msg) this.toast = ''; }, 4000); },

    async login() {
      this.loginErr = '';
      try {
        await api('POST', '/api/auth/login', { password: this.loginPassword });
        this.authed = true;
        await this.loadModules();
        await this.loadSites();
        this.onRoute(true);
      } catch (e) { this.loginErr = '密码错误'; }
    },
    async logout() { await api('POST', '/api/auth/logout'); this.authed = false; },

    async loadModules() {
      try {
        const r = await api('GET', '/api/modules');
        this.modules = r.modules ?? [];
        this.switchVar = r.switchVar || 'AMZ_ENABLED_MODULES';
      } catch (e) { this.handleErr(e); }
    },

    // ---------------- reviews 差评情报 ----------------
    async loadReviewsOverview() {
      try {
        this.revOverview = await api('GET', '/api/reviews/overview');
        this.revJobs = this.revOverview.jobs || [];
        // 若有运行中的 job，启动轮询
        const running = (this.revJobs).find((j) => j.status === 'running');
        if (running) this.startRevPoll(running.job_id);
        // 默认选中第一个 ASIN 看摘要
        const first = this.revOverview.perAsin && this.revOverview.perAsin[0];
        if (first && !this.revFilters.asin) this.revFilters.asin = first.asin;
        if (this.revFilters.asin) this.loadReviewsSummary();
        this.loadReviewsList();
      } catch (e) { this.handleErr(e); }
    },
    async loadReviewsList() {
      try {
        const f = this.revFilters;
        const q = new URLSearchParams({ limit: '30', offset: String(this.revPage * 30) });
        if (f.asin) q.set('asin', f.asin);
        if (f.rating) q.set('rating', f.rating);
        if (f.keyword) q.set('keyword', f.keyword);
        this.revList = await api('GET', '/api/reviews/list?' + q.toString());
      } catch (e) { this.handleErr(e); }
    },
    async loadReviewsSummary() {
      if (!this.revFilters.asin) { this.revSummary = null; return; }
      try {
        this.revSummary = await api('GET', '/api/reviews/summary?asin=' + encodeURIComponent(this.revFilters.asin));
      } catch (e) { this.handleErr(e); }
    },
    pickRevAsin(asin) {
      this.revFilters.asin = asin; this.revPage = 0;
      this.loadReviewsSummary(); this.loadReviewsList();
    },
    async startRevFetch() {
      const f = this.revForm;
      const asin = String(f.asin || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) { this.errToast = '请输入 10 位 ASIN（如 B0DWF7823H）'; return; }
      const mode = this.revOverview?.mode || 'mock';
      if (mode === 'apify' && !confirm('当前为真实 Apify 模式，抓取会产生费用（约几分钱）。确认继续？')) return;
      this.revBusy = true; this.errToast = '';
      try {
        const r = await api('POST', '/api/reviews/fetch', { asin, country_code: f.country_code, max_reviews: f.max_reviews });
        this.notify(`已提交抓取任务 ${r.job_id}（${r.mode === 'mock' ? '模拟模式' : '真实模式'}）`);
        // 顺手加入监控清单（幂等：已在则忽略），让"抓取→持续跟踪"闭环
        try { await api('POST', '/api/reviews/watch', { asin, country_code: f.country_code }); } catch {}
        this.startRevPoll(r.job_id);
      } catch (e) { this.handleErr(e); }
      finally { this.revBusy = false; }
    },
    startRevPoll(jobId) {
      this.stopRevPoll();
      this.revJobPoll = setInterval(async () => {
        try {
          const j = await api('GET', '/api/reviews/job?job_id=' + encodeURIComponent(jobId));
          if (j.status === 'done') {
            this.stopRevPoll();
            this.notify('抓取完成，数据已入库');
          } else if (j.status === 'error') {
            this.stopRevPoll();
            this.errToast = '抓取失败：' + (j.error || '未知错误');
          }
          this.loadReviewsOverview();
        } catch { /* 轮询期间网络抖动忽略 */ }
      }, 4000);
    },
    stopRevPoll() { if (this.revJobPoll) { clearInterval(this.revJobPoll); this.revJobPoll = null; } },
    revStar(n) { return '★'.repeat(Math.max(0, Math.round(n))) + '☆'.repeat(Math.max(0, 5 - Math.round(n))); },

    // ---------------- review library (global search) ----------------
    async loadLib() {
      try {
        const f = this.libFilters;
        const q = new URLSearchParams({ limit: '30', offset: String(this.libPage * 30) });
        if (f.asin) q.set('asin', f.asin.trim().toUpperCase());
        if (f.rating) q.set('rating', f.rating);
        if (f.keyword) q.set('keyword', f.keyword);
        this.libList = await api('GET', '/api/reviews/list?' + q.toString());
      } catch (e) { this.handleErr(e); }
    },
    libSearch() { this.libPage = 0; this.loadLib(); },
    goAsin(asin) { this.revFilters.asin = asin; location.hash = '#reviews'; },

    // ---------------- watched ASIN list ----------------
    async loadWatch() {
      try { this.watchList = await api('GET', '/api/reviews/watch'); } catch (e) { this.handleErr(e); }
    },
    async addWatch() {
      const asin = String(this.watchForm.asin || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) { this.errToast = '请输入 10 位 ASIN'; return; }
      this.watchBusy = true;
      try {
        await api('POST', '/api/reviews/watch', { asin, country_code: this.watchForm.country_code, note: this.watchForm.note });
        this.notify(`已加入监控：${asin}`);
        this.watchForm.asin = ''; this.watchForm.note = '';
        this.loadWatch();
      } catch (e) { this.handleErr(e); }
      finally { this.watchBusy = false; }
    },
    async toggleWatch(w) {
      try { await api('PATCH', '/api/reviews/watch/' + w.id, { status: w.status === 'active' ? 'paused' : 'active' }); this.loadWatch(); }
      catch (e) { this.handleErr(e); }
    },
    async delWatch(w) {
      if (!confirm(`从监控清单移除 ${w.asin}？（已入库差评会保留）`)) return;
      try { await api('DELETE', '/api/reviews/watch/' + w.id); this.notify('已移除'); this.loadWatch(); }
      catch (e) { this.handleErr(e); }
    },
    async fetchWatch(w) {
      try {
        const r = await api('POST', '/api/reviews/watch/' + w.id + '/fetch');
        this.notify(`已提交重抓 ${w.asin}（${r.job_id}）`);
        this.startRevPoll(r.job_id);
        setTimeout(() => this.loadWatch(), 1500);
      } catch (e) { this.handleErr(e); }
    },
    async fetchAllWatch() {
      if (!confirm('批量重抓所有启用监控的 ASIN？真实模式会产生 Apify 费用。')) return;
      this.watchBusy = true;
      try {
        const r = await api('POST', '/api/reviews/watch/fetch-all');
        this.notify(`已提交 ${r.submitted} 个重抓任务${r.skipped ? `，跳过 ${r.skipped} 个（并发/日限）` : ''}`);
        this.loadWatch();
      } catch (e) { this.handleErr(e); }
      finally { this.watchBusy = false; }
    },

    // ---------------- changes view ----------------
    async loadChanges() {
      try {
        const q = new URLSearchParams({ hours: String(this.changesHours) });
        if (this.changesAsin) q.set('asin', this.changesAsin.trim().toUpperCase());
        this.changes = await api('GET', '/api/reviews/changes?' + q.toString());
      } catch (e) { this.handleErr(e); }
    },
    deltaBadge(n) {
      if (n === null || n === undefined) return '';
      if (n > 0) return '+' + n;
      return String(n);
    },

    // ---------------- apify token pool ----------------
    async loadTokens() {
      try {
        this.tokenData = await api('GET', '/api/reviews/tokens');
        const s = await api('GET', '/api/settings');
        this.dsForm = {
          apify_mode: s.settings.apify_mode || 'mock',
          apify_token: s.settings.apify_token || '',
        };
      } catch (e) { this.handleErr(e); }
    },
    async saveDsConfig() {
      try {
        await api('PUT', '/api/settings', { settings: { apify_mode: this.dsForm.apify_mode, apify_token: this.dsForm.apify_token } });
        this.notify('数据源配置已保存（settings 优先于环境变量）');
        this.loadTokens();
      } catch (e) { this.handleErr(e); }
    },
    async addToken() {
      const token = String(this.tokenForm.token || '').trim();
      if (!token) { this.errToast = '请填写 token'; return; }
      this.tokenBusy = true;
      try {
        await api('POST', '/api/reviews/tokens', {
          label: this.tokenForm.label, token,
          priority: Number(this.tokenForm.priority) || 0,
          quota_limit_usd: Number(this.tokenForm.quota_limit_usd) || 0,
        });
        this.notify('已添加 token');
        this.tokenForm = { label: '', token: '', priority: 0, quota_limit_usd: 0 };
        this.loadTokens();
      } catch (e) { this.handleErr(e); }
      finally { this.tokenBusy = false; }
    },
    async updateTokenField(t, field, value) {
      try { await api('PUT', '/api/reviews/tokens/' + t.id, { [field]: value }); this.loadTokens(); }
      catch (e) { this.handleErr(e); }
    },
    async refreshToken(t) {
      try { const r = await api('POST', '/api/reviews/tokens/' + t.id + '/refresh'); this.notify(r.ok ? '额度已刷新（API）' : 'API 查询失败，仍用手填额度'); this.loadTokens(); }
      catch (e) { this.handleErr(e); }
    },
    async clearCooldown(t) {
      try { await api('POST', '/api/reviews/tokens/' + t.id + '/cooldown-clear'); this.notify('已清除冷却'); this.loadTokens(); }
      catch (e) { this.handleErr(e); }
    },
    async delToken(t) {
      if (!confirm(`删除 token「${t.label || t.token_masked}」？`)) return;
      try { await api('DELETE', '/api/reviews/tokens/' + t.id); this.notify('已删除'); this.loadTokens(); }
      catch (e) { this.handleErr(e); }
    },
    async togglePool() {
      if (!this.tokenData) return;
      const next = this.tokenData.enabled ? 0 : 1;
      try {
        await api('PUT', '/api/settings', { settings: { apify_token_pool_enabled: String(next) } });
        this.notify(next ? 'Token 池已启用' : 'Token 池已关闭（回退单 token）');
        this.loadTokens();
      } catch (e) { this.handleErr(e); }
    },

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
      const lines = this.kwForm.text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return;
      try {
        if (lines.length === 1) {
          await api('POST', '/api/keywords', { text: lines[0], mid: this.kwForm.mid, alias: this.kwForm.alias, note: this.kwForm.note });
          this.notify('已添加关键词');
        } else {
          const r = await api('POST', '/api/keywords/import', { text: lines.join('\n'), mid: this.kwForm.mid, alias: this.kwForm.alias });
          this.notify(`批量导入完成：新增 ${r.added}，跳过重复 ${r.skipped}`);
        }
        this.kwForm.text = ''; this.kwForm.note = '';
        this.loadKeywords();
      } catch (e) { this.handleErr(e); }
    },
    toggleAllKw(e) {
      this.kwSelected = e.target.checked ? this.kwList.map((k) => k.id) : [];
    },
    async batchKw(action) {
      const label = { enable: '启用', pause: '暂停', delete: '删除' }[action];
      if (!confirm(`确认${label}选中的 ${this.kwSelected.length} 个关键词？`)) return;
      let purge = false;
      if (action === 'delete') {
        purge = confirm(`是否同时彻底清除这 ${this.kwSelected.length} 个关键词的联想词库与全部抓取历史？\n\n【确定】= 彻底清除（不可恢复）\n【取消】= 仅删除关键词（保留词库与历史，重加自动接回）`);
      }
      try {
        const r = await api('POST', '/api/keywords/batch', { action, ids: this.kwSelected, purge });
        this.notify(action === 'delete'
          ? (purge
            ? `已删除并彻底清除 ${r.affected} 个关键词（词库移除 ${r.purged_lexicon ?? 0} 条）`
            : `已删除 ${r.affected} 个关键词（历史已保留，重加自动接回）`)
          : `批量${label}完成：${r.affected} 项`);
        this.kwSelected = [];
        this.loadKeywords();
      } catch (e) { this.handleErr(e); }
    },
    async toggleKw(kw) {
      await api('PATCH', '/api/keywords/' + kw.id, { status: kw.status === 'active' ? 'paused' : 'active' });
      this.loadKeywords();
    },
    async changePassword() {
      const f = this.pwForm;
      if (!f.old || !f.new1) return this.notify('请填写旧密码和新密码');
      if (f.new1 !== f.new2) return this.notify('两次输入的新密码不一致');
      try {
        await api('POST', '/api/auth/change-password', { old_password: f.old, new_password: f.new1 });
        this.pwForm = { old: '', new1: '', new2: '' };
        this.notify('密码已修改，下次登录使用新密码');
      } catch (e) { this.handleErr(e); }
    },
    async delKw(kw) {
      if (!confirm(`删除关键词「${kw.text}」？\n\n· 默认保留词库与抓取历史，重新添加同名关键词（同站点）时自动接回；\n· 只想停每周抓取请用「暂停」。`)) return;
      const purge = confirm(`是否同时彻底清除「${kw.text}」的联想词库与全部抓取历史？\n\n【确定】= 彻底清除（该词的词库联想词 + 历史，不可恢复）\n【取消】= 仅删除关键词（保留词库与历史）`);
      await api('DELETE', '/api/keywords/' + kw.id + (purge ? '?purge=1' : ''));
      this.notify(purge ? '已删除并彻底清除词库与历史' : '已删除（历史已保留，重加自动接回）');
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
      try {
        await api('POST', `/api/runs/${run.id}/cancel`);
        this.notify(`任务 #${run.id} 已请求取消`);
        this.loadRuns();
      } catch (e) { this.handleErr(e); }
    },
    async delRun(run) {
      if (!confirm(`删除任务 #${run.id}（${run.trigger_type === 'weekly' ? '周调度' : '手动'}，${run.status}）？\n\n将删除该批次的任务明细与原始响应快照；已积累的词库数据不受影响。此操作不可恢复。`)) return;
      try {
        await api('DELETE', '/api/runs/' + run.id);
        if (this.modal && this.modal.type === 'run' && this.modal.run.id === run.id) this.closeModal();
        this.notify(`任务 #${run.id} 已删除`);
        this.loadRuns();
      } catch (e) { this.handleErr(e); }
    },
    runStatusTag(s) {
      return { done: 'green', running: 'blue', pending: 'gray', failed: 'red', cancelled: 'amber', skipped: 'gray' }[s] || 'gray';
    },
    runProgress(r) {
      const expected = Number(r.requests_expected) || 0;
      const done = Number(r.requests_done) || 0;
      if (expected > 0) {
        return {
          pct: Math.min(100, Math.round(done / expected * 100)),
          text: `请求 ${done}/${expected}`,
          sub: `${r.done_keywords}/${r.total_keywords} 词`,
        };
      }
      const pct = r.total_keywords ? Math.round(r.done_keywords / r.total_keywords * 100) : 0;
      return { pct, text: `${r.done_keywords}/${r.total_keywords} 词`, sub: '' };
    },
    runRequests(r) {
      const expected = Number(r.requests_expected) || 0;
      return expected > 0 ? `${Number(r.requests_done) || 0}/${expected}` : `${r.total_requests ?? 0}`;
    },
    itemProgress(it) {
      if (it.status === 'running' || it.status === 'pending') {
        const expected = Number(it.expected_requests) || 0;
        if (expected > 0) return `${Number(it.done_requests) || 0}/${expected}`;
      }
      return `${it.request_count ?? 0}`;
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
    trendKwLabel(kw) { return this.siteFlag(kw.mid) + ' ' + kw.text; },
    pickTrendKw(kw) {
      this.trendKid = kw.id;
      this.trendKwQuery = this.trendKwLabel(kw);
      this.trendKwOpen = false;
      this.loadTrend();
    },
    syncTrendKwQuery() {
      const kw = this.kwList.find((k) => k.id === this.trendKid);
      if (kw) this.trendKwQuery = this.trendKwLabel(kw);
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
    async purgeSeedLexicon() {
      const text = prompt('输入已删除的种子词（精确匹配，不是搜索子串）：', this.lexQuery);
      if (text === null) return;
      const seed = text.trim();
      if (!seed) return;
      if (!this.lexMid) { this.notify('请先在站点下拉框选择站点，再清理残留词库'); return; }
      if (!confirm(`清理种子词「${seed}」的残留联想词？\n\n· 仅删除只由该种子词发现的联想词；\n· 同时被其他种子词发现的会保留；\n· 不可恢复（不会删除关键词与抓取历史）。`)) return;
      try {
        const r = await api('POST', '/api/lexicon/purge-seed', { text: seed, mid: this.lexMid });
        this.notify(r.purged_lexicon > 0
          ? `已清理 ${r.purged_lexicon} 条联想词`
          : '未找到可精确归属的残留；如页面仍有该词的联想词，请用「强制清理」');
        this.loadLexicon();
      } catch (e) { this.handleErr(e); }
    },
    async forcePurgeSeedLexicon() {
      const text = prompt('强制清理：输入已删除的种子词（按包含匹配）：', this.lexQuery);
      if (text === null) return;
      const seed = text.trim();
      if (!seed) return;
      if (!this.lexMid) { this.notify('请先在站点下拉框选择站点，再清理残留词库'); return; }
      if (!confirm(`⚠ 强制清理「${seed}」的残留？\n\n· 将删除本站点所有包含「${seed}」的联想词；\n· 会忽略“其他种子词也发现过”的共享保护；\n· 仅删除词库，不影响关键词与抓取历史；\n· 不可恢复。`)) return;
      try {
        const r = await api('POST', '/api/lexicon/purge-seed', { text: seed, mid: this.lexMid, force: true });
        this.notify(`已强制清理 ${r.purged_lexicon} 条联想词`);
        this.loadLexicon();
      } catch (e) { this.handleErr(e); }
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
      try {
        await api('POST', `/api/keys/${k.id}/revoke`);
        this.notify('已吊销');
        this.loadKeys();
      } catch (e) { this.handleErr(e); }
    },
    async delKey(k) {
      if (!confirm(`删除「${k.name}」？\n\n· 该 key 将立即失效并从列表移除；\n· credits 流水与调用审计记录会保留，便于追溯。`)) return;
      try {
        await api('DELETE', '/api/keys/' + k.id);
        this.notify('已删除（审计与流水已保留）');
        this.loadKeys();
      } catch (e) { this.handleErr(e); }
    },
    async toggleLive(k) {
      const next = k.can_live ? 0 : 1;
      try {
        await api('PUT', '/api/keys/' + k.id, { can_live: next });
        k.can_live = next;
        this.notify(next ? '已允许实时抓取' : '已禁止实时抓取');
      } catch (e) { this.handleErr(e); }
    },
    async setLiveLimit(k) {
      if (!k.can_live) { this.notify('请先允许实时抓取'); return; }
      const v = prompt(`「${k.name}」每日实时抓取限额（今日已用 ${k.live_today ?? 0} 次）:`, String(k.live_daily_limit));
      if (v === null) return;
      const n = Math.max(0, Math.round(Number(v) || 0));
      try {
        await api('PUT', '/api/keys/' + k.id, { live_daily_limit: n });
        k.live_daily_limit = n;
        this.notify('限额已更新');
      } catch (e) { this.handleErr(e); }
    },
    async showCalls(k) {
      try {
        const rows = await api('GET', `/api/keys/${k.id}/calls`);
        this.modal = { type: 'calls', title: `调用记录 — ${k.name}（最近 ${rows.length} 条）`, rows };
      } catch (e) { this.handleErr(e); }
    },
    async topupKey(k, current) {
      const v = prompt(`为「${k.name}」充值 credits（正数充值，负数扣减）:`, '1000');
      if (v === null) return;
      const amount = Math.round(Number(v));
      if (!Number.isFinite(amount) || amount === 0) return;
      try {
        await api('POST', `/api/keys/${k.id}/topup`, { amount, note: current });
        this.notify('Credits 已更新');
        this.loadKeys();
      } catch (e) { this.handleErr(e); }
    },
    async showLedger(k) {
      try {
        const rows = await api('GET', `/api/keys/${k.id}/ledger`);
        this.modal = { title: `Credits 流水 — ${k.name}`, rows, type: 'ledger' };
      } catch (e) { this.handleErr(e); }
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
      try {
        await api('PUT', '/api/settings', { settings: this.settingsForm, pricing });
        this.settingsMsg = '已保存，调度已按新 cron 重新加载';
        setTimeout(() => this.settingsMsg = '', 3500);
        this.loadSettings();
      } catch (e) { this.handleErr(e); }
    },

    handleErr(e) {
      if (e.code === 401) { this.authed = false; return; }
      const msg = e.message || String(e);
      this.toast = '';
      this.errToast = msg;
      setTimeout(() => { if (this.errToast === msg) this.errToast = ''; }, 5000);
    },
    closeModal() { this.modal = null; },
    async copyText(t) { try { await navigator.clipboard.writeText(t); this.notify('已复制'); } catch {} },
  },
  template: `
<div v-if="!ready"></div>
<div v-else-if="!authed" class="login-wrap">
  <form class="login" @submit.prevent="login">
    <h2>AMZ Data Hub</h2>
    <p>数据 MCP 基座 · 模块化管理后台</p>
    <div v-if="loginErr" class="err">{{loginErr}}</div>
    <input type="password" v-model="loginPassword" placeholder="管理员密码" autofocus>
    <button class="btn primary" type="submit">登 录</button>
  </form>
</div>
<div v-else class="layout">
  <aside class="sidebar">
    <div class="logo">AMZ Data Hub<small>数据 MCP 基座</small></div>
    <nav class="nav">
      <template v-for="g in navGroups" :key="g.key">
        <button class="nav-group" @click="toggleGroup(g.key)" :title="g.collapsed?'展开分组':'收起分组'">
          <span class="chev" :class="{closed:g.collapsed}">▾</span>
          <span>{{g.icon}} {{g.label}}</span>
          <span v-if="g.key!=='system'" class="nav-core" :title="g.core?'核心模块（恒启用）':'可选模块'">{{g.core?'core':'opt'}}</span>
        </button>
        <template v-if="!g.collapsed">
          <a v-for="it in g.items" :key="it.route" :class="{on:route===it.route}" :href="'#'+it.route">{{it.icon}} {{it.label}}</a>
        </template>
      </template>
    </nav>
    <div class="mcp-hint" style="padding:14px 18px;font-size:11px;color:#5d6b81">
      MCP: <span class="mono" style="color:#8ea2bd">POST /mcp</span>
    </div>
  </aside>
  <main class="main">
    <div class="topbar">
      <h1>{{routeTitle}}</h1>
      <div class="userbox">
        <span v-if="toast" class="okmsg">{{toast}}</span>
        <span v-else-if="errToast" class="err">{{errToast}}</span>
        <button class="btn sm" @click="logout">退出</button>
      </div>
    </div>

    <!-- ==================== MODULES OVERVIEW ==================== -->
    <template v-if="route==='modules'">
      <div class="card hub-intro">
        <h3>数据 MCP 基座</h3>
        <p class="muted">各功能以模块形式接入，统一通过 <span class="mono">POST /mcp</span> 向 agent 分发数据。模块化的收益是：新增数据能力不改核心、默认关闭、按需灰度。</p>
      </div>
      <div class="mod-grid">
        <div class="card mod-card" v-for="m in modules" :key="m.id">
          <div class="mod-head">
            <div class="mod-title">{{m.name}}</div>
            <div class="mod-badges">
              <span class="tag" :class="m.core?'blue':'muted-tag'" :title="m.core?'核心模块，恒启用':'可选模块，默认关闭'">{{m.core?'core':'optional'}}</span>
              <span class="tag" :class="m.enabled?'green':'gray'">{{m.enabled?'已启用':'未启用'}}</span>
            </div>
          </div>
          <div class="mod-meta"><span class="mono">id={{m.id}}</span> · v{{m.version}} · {{m.tools.length}} 个 MCP 工具</div>
          <div class="mod-tools">
            <div class="mod-tool" v-for="t in m.tools" :key="t.name">
              <span class="mono tool-name">{{t.name}}</span>
              <span v-if="t.live" class="tag amber" title="直连外部数据源，受 live 治理管控">live</span>
              <span class="tool-desc">{{t.description}}</span>
            </div>
            <div v-if="!m.tools.length" class="muted" style="font-size:12px">该模块暂无工具</div>
          </div>
          <div class="mod-foot" v-if="!m.core">
            开启方式：环境变量 <span class="mono">{{switchVar}}={{m.id}}</span>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== REVIEWS (negative intelligence) ==================== -->
    <template v-if="route==='reviews'">
      <!-- 模式提示条 -->
      <div v-if="revOverview" class="card rev-mode" :class="revOverview.mode==='mock'?'is-mock':'is-live'">
        <span v-if="revOverview.mode==='mock'">🧪 <b>模拟模式</b>：抓取返回假数据、不产生费用。设置 <span class="mono">APIFY_MODE=apify</span> + <span class="mono">APIFY_TOKEN</span> 即为真实抓取。</span>
        <span v-else>🔴 <b>真实模式</b>：每次抓取调用付费 Apify actor，受全服日限保护（今日 {{revOverview.governance.used_today}}/{{revOverview.governance.global_daily}}，运行中 {{revOverview.governance.running}}）。</span>
      </div>

      <!-- 抓取控制 -->
      <div class="card">
        <h3>抓取 ASIN 差评（≤3 星）</h3>
        <div class="row">
          <input v-model="revForm.asin" placeholder="ASIN，如 B0DWF7823H" maxlength="10" style="width:180px;text-transform:uppercase" @keyup.enter="startRevFetch">
          <select v-model="revForm.country_code" style="width:90px">
            <option value="US">🇺🇸 US</option><option value="GB">🇬🇧 GB</option><option value="DE">🇩🇪 DE</option>
            <option value="FR">🇫🇷 FR</option><option value="JP">🇯🇵 JP</option><option value="CA">🇨🇦 CA</option>
          </select>
          <input v-model.number="revForm.max_reviews" type="number" min="1" max="100" style="width:110px" title="最多抓取条数">
          <button class="btn primary" @click="startRevFetch" :disabled="revBusy">{{revBusy?'提交中…':'🚀 抓取差评'}}</button>
        </div>
        <p class="muted" style="margin:8px 0 0">抓取在后台异步运行，完成后自动入库；≤3 星在数据源端过滤（计费前），差评数据留存在本地库，后续查询不再花钱。</p>
      </div>

      <!-- 统计卡 -->
      <div class="grid cols4" v-if="revOverview">
        <div class="stat"><div class="l">差评总量</div><div class="v">{{revOverview.totals.total}}</div><div class="sub">≤3 星</div></div>
        <div class="stat"><div class="l">监控 ASIN</div><div class="v">{{revOverview.totals.asins}}</div><div class="sub">已抓取的产品</div></div>
        <div class="stat"><div class="l">平均评分</div><div class="v">{{revOverview.totals.avg_rating}}</div><div class="sub">差评样本均分</div></div>
        <div class="stat"><div class="l">严重差评</div><div class="v" style="color:var(--red)">{{revOverview.totals.negative2}}</div><div class="sub">1–2 星</div></div>
      </div>

      <!-- 按 ASIN 概览 -->
      <div class="card" v-if="revOverview && revOverview.perAsin.length">
        <h3>按 ASIN 概览</h3>
        <table>
          <thead><tr><th>ASIN</th><th>站点</th><th class="num">差评数</th><th class="num">均分</th><th class="num">1–2 星</th><th>最近评论</th></tr></thead>
          <tbody>
            <tr v-for="a in revOverview.perAsin" :key="a.asin" @click="pickRevAsin(a.asin)" style="cursor:pointer"
                :style="revFilters.asin===a.asin?'background:var(--primary-weak)':''">
              <td class="mono"><b>{{a.asin}}</b></td><td>{{a.country_code}}</td>
              <td class="num">{{a.total}}</td><td class="num">{{a.avg_rating}}</td>
              <td class="num" style="color:var(--red)">{{a.negative2}}</td><td class="muted">{{fmtDate(a.latest_review)}}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 单 ASIN 摘要 -->
      <template v-if="revSummary">
        <div class="grid cols2">
          <div class="card">
            <h3>评分分布 · <span class="mono">{{revSummary.asin}}</span></h3>
            <template v-if="revSummary.current && revSummary.current.total">
              <div v-for="s in [{k:'s1',label:'1 星'},{k:'s2',label:'2 星'},{k:'s3',label:'3 星'}]" :key="s.k" class="rev-bar-row">
                <span class="rev-bar-label">{{s.label}}</span>
                <div class="progress" style="flex:1"><i :style="{width:(revSummary.current[s.k]/revSummary.current.total*100)+'%',background:s.k==='s1'?'var(--red)':s.k==='s2'?'var(--amber)':'#94a3b8'}"></i></div>
                <span class="rev-bar-num">{{revSummary.current[s.k] || 0}}</span>
              </div>
            </template>
            <div v-else class="muted">暂无数据</div>
            <div class="muted" style="margin-top:10px">平均 {{revSummary.current?.avg_rating || 0}} · 共 {{revSummary.current?.total || 0}} 条差评</div>
          </div>
          <div class="card">
            <h3>高频抱怨词</h3>
            <div v-if="revSummary.topKeywords && revSummary.topKeywords.length" class="rev-kw-cloud">
              <span v-for="k in revSummary.topKeywords" :key="k.word" class="rev-kw" :style="{fontSize:Math.min(18,11+k.count*1.5)+'px'}">{{k.word}} <small>×{{k.count}}</small></span>
            </div>
            <div v-else class="muted">暂无足够文本</div>
          </div>
        </div>
        <div class="card" v-if="revSummary.trend && revSummary.trend.length">
          <h3>抓取趋势</h3>
          <table><thead><tr><th>时间</th><th class="num">差评数</th><th class="num">均分</th><th>分布</th></tr></thead><tbody>
            <tr v-for="t in revSummary.trend" :key="t.fetched_at">
              <td class="muted">{{fmtDate(t.fetched_at)}}</td><td class="num">{{t.total_reviews}}</td><td class="num">{{t.avg_rating}}</td>
              <td class="muted mono" style="font-size:11px">{{JSON.stringify(t.dist)}}</td>
            </tr>
          </tbody></table>
        </div>
      </template>

      <!-- 差评列表 -->
      <div class="card">
        <h3>差评明细 <span v-if="revList" class="muted" style="font-weight:400">（共 {{revList.total}} 条）</span></h3>
        <div class="filters">
          <select v-model="revFilters.asin" @change="pickRevAsin(revFilters.asin)">
            <option value="">全部 ASIN</option>
            <option v-for="a in (revOverview?.perAsin||[])" :key="a.asin" :value="a.asin">{{a.asin}} ({{a.total}})</option>
          </select>
          <select v-model="revFilters.rating" @change="revPage=0;loadReviewsList()">
            <option value="">全部星级</option><option value="1">1 星</option><option value="2">2 星</option><option value="3">3 星</option>
          </select>
          <input v-model="revFilters.keyword" placeholder="搜标题/正文" @keyup.enter="revPage=0;loadReviewsList()">
          <button class="btn sm" @click="revPage=0;loadReviewsSummary();loadReviewsList()">筛选</button>
        </div>
        <div v-if="revList && revList.items.length" class="rev-list">
          <div v-for="r in revList.items" :key="r.review_id" class="rev-item">
            <div class="rev-item-head">
              <span class="rev-stars" :title="r.rating+' 星'">{{revStar(r.rating)}}</span>
              <b v-if="r.title">{{r.title}}</b><span v-else class="muted">（无标题）</span>
              <span v-if="r.is_verified" class="tag green">Verified</span>
              <span class="muted mono" style="margin-left:auto">{{r.asin}} · {{fmtDate(r.review_date)}}</span>
            </div>
            <div class="rev-body">{{r.body}}</div>
            <div class="rev-item-foot">
              <span class="muted">👍 {{r.helpful_votes}} · {{r.author || '匿名'}}</span>
              <a v-if="r.review_url" :href="r.review_url" target="_blank" rel="noopener">查看原文 ↗</a>
            </div>
          </div>
          <div class="pager row" style="justify-content:center;margin-top:14px">
            <button class="btn sm" :disabled="revPage<=0" @click="revPage--;loadReviewsList()">上一页</button>
            <span class="muted">第 {{revPage+1}} 页</span>
            <button class="btn sm" :disabled="(revPage+1)*30 >= (revList?.total||0)" @click="revPage++;loadReviewsList()">下一页</button>
          </div>
        </div>
        <div v-else class="empty">{{revList?'暂无差评数据，先在上方抓取一个 ASIN':'加载中…'}}</div>
      </div>
    </template>

    <!-- ==================== REVIEW LIBRARY (global search) ==================== -->
    <template v-else-if="route==='reviewlib'">
      <div class="card">
        <div class="row">
          <input v-model="libFilters.keyword" placeholder="全文搜索差评正文/标题" style="flex:1" @keyup.enter="libSearch">
          <select v-model="libFilters.asin" @change="libSearch">
            <option value="">全部 ASIN</option>
            <option v-for="a in (revOverview?.perAsin||[])" :key="a.asin" :value="a.asin">{{a.asin}}</option>
          </select>
          <select v-model="libFilters.rating" @change="libSearch">
            <option value="">全部星级</option><option value="1">1 星</option><option value="2">2 星</option><option value="3">3 星</option>
          </select>
          <button class="btn primary" @click="libSearch">搜索</button>
        </div>
        <p class="muted" style="margin-top:8px">差评库 = 所有已入库 ≤3 星差评的去重合集，可跨 ASIN 直接检索，无需先选产品。点 ASIN 进入该产品的差评情报。</p>
      </div>
      <div class="card" v-if="libList">
        <p class="muted" style="margin-bottom:10px">共 {{libList.total}} 条</p>
        <table v-if="libList.items.length">
          <thead><tr><th>星级</th><th>标题 / 摘要</th><th>ASIN</th><th>站点</th><th>评论日期</th><th>首次入库</th></tr></thead>
          <tbody>
            <tr v-for="r in libList.items" :key="r.review_id">
              <td><span class="rev-stars" :title="r.rating+' 星'">{{revStar(r.rating)}}</span></td>
              <td style="max-width:420px"><b>{{r.title||'（无标题）'}}</b><div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{r.body}}</div></td>
              <td><a href="#" @click.prevent="goAsin(r.asin)" class="mono">{{r.asin}}</a></td>
              <td>{{r.country_code}}</td>
              <td class="muted">{{fmtDate(r.review_date)}}</td>
              <td class="muted">{{fmtDate(r.first_seen_at)}}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">无匹配结果</div>
        <div class="row pager" style="margin-top:12px;justify-content:center" v-if="libList.total>30">
          <button class="btn sm" :disabled="libPage===0" @click="libPage--;loadLib()">上一页</button>
          <span class="muted">第 {{libPage+1}} / {{libTotalPages}} 页</span>
          <button class="btn sm" :disabled="libPage+1>=libTotalPages" @click="libPage++;loadLib()">下一页</button>
        </div>
      </div>
    </template>

    <!-- ==================== REVIEW WATCH (monitored ASINs) ==================== -->
    <template v-else-if="route==='reviewwatch'">
      <div class="card">
        <h3>加入监控 ASIN</h3>
        <div class="row">
          <input v-model="watchForm.asin" placeholder="ASIN，如 B0DWF7113H" maxlength="10" style="width:180px;text-transform:uppercase" @keyup.enter="addWatch">
          <select v-model="watchForm.country_code" style="width:100px">
            <option value="US">🇺🇸 US</option><option value="GB">🇬🇧 GB</option><option value="DE">🇩🇪 DE</option>
            <option value="FR">🇫🇷 FR</option><option value="JP">🇯🇵 JP</option><option value="CA">🇨🇦 CA</option>
          </select>
          <input v-model="watchForm.note" placeholder="备注（可选）" style="width:200px">
          <button class="btn primary" @click="addWatch" :disabled="watchBusy">加入监控</button>
        </div>
        <p class="muted" style="margin-top:8px">监控中的 ASIN 会被定时重抓（需在「数据源配置 / 系统设置」开启 <span class="mono">reviews_watch_cron</span>）；重复差评自动去重，只记录新增。</p>
      </div>
      <div class="card" v-if="watchList">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0">监控清单（{{watchList.items.length}}）</h3>
          <button class="btn sm" @click="fetchAllWatch" :disabled="watchBusy">🔄 批量重抓启用项</button>
        </div>
        <table v-if="watchList.items.length">
          <thead><tr><th>ASIN</th><th>站点</th><th>状态</th><th>差评数</th><th>备注</th><th>最近抓取</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="w in watchList.items" :key="w.id">
              <td class="mono"><b>{{w.asin}}</b></td>
              <td>{{w.country_code}}</td>
              <td><span class="tag" :class="w.status==='active'?'green':'gray'">{{w.status==='active'?'启用':'暂停'}}</span></td>
              <td class="num">{{w.review_count}}</td>
              <td class="muted">{{w.note||'—'}}</td>
              <td class="muted">{{fmtDate(w.last_fetched_at)}}</td>
              <td>
                <button class="btn sm" @click="fetchWatch(w)" title="立即重抓">抓取</button>
                <button class="btn sm" @click="toggleWatch(w)" style="margin-left:4px">{{w.status==='active'?'暂停':'启用'}}</button>
                <button class="btn sm danger" @click="delWatch(w)" style="margin-left:4px">移除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">监控清单为空，先在上方加入一个 ASIN</div>
      </div>
    </template>

    <!-- ==================== REVIEW CHANGES (delta view) ==================== -->
    <template v-else-if="route==='reviewchanges'">
      <div class="card">
        <div class="row">
          <select v-model="changesAsin" @change="loadChanges">
            <option value="">全部 ASIN</option>
            <option v-for="a in (revOverview?.perAsin||[])" :key="a.asin" :value="a.asin">{{a.asin}}</option>
          </select>
          <select v-model.number="changesHours" @change="loadChanges">
            <option :value="24">近 24 小时</option><option :value="168">近 7 天</option>
            <option :value="720">近 30 天</option><option :value="8760">近 1 年</option>
          </select>
          <button class="btn primary" @click="loadChanges">刷新</button>
        </div>
      </div>
      <div class="card" v-if="changes">
        <h3>抓取快照变化（每 ASIN 最近 12 次）</h3>
        <table v-if="changes.timeline.length">
          <thead><tr><th>ASIN</th><th>抓取时间</th><th class="num">差评数</th><th class="num">较上次</th><th class="num">1-2 星</th><th class="num">均分</th><th class="num">均分变化</th></tr></thead>
          <tbody>
            <tr v-for="(t,i) in changes.timeline" :key="i">
              <td class="mono">{{t.asin}}</td><td class="muted">{{fmtDate(t.fetched_at)}}</td>
              <td class="num">{{t.total_reviews}}</td>
              <td class="num" :style="t.delta_total>0?'color:var(--red)':t.delta_total<0?'color:var(--green)':''">{{deltaBadge(t.delta_total)}}</td>
              <td class="num">{{t.negative_reviews}}</td>
              <td class="num">{{Number(t.avg_rating||0).toFixed(2)}}</td>
              <td class="num" :style="t.delta_avg>0?'color:var(--green)':t.delta_avg<0?'color:var(--red)':''">{{deltaBadge(t.delta_avg)}}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">暂无快照，先抓取几次差评后即可看到变化</div>
      </div>
      <div class="card" v-if="changes && changes.newReviews.length">
        <h3>新增差评（窗口内首次入库，共 {{changes.newReviews.length}} 条）</h3>
        <div class="rev-list">
          <div v-for="r in changes.newReviews" :key="r.review_id" class="rev-item">
            <div class="rev-item-head">
              <span class="rev-stars">{{revStar(r.rating)}}</span>
              <b>{{r.title||'（无标题）'}}</b>
              <span class="muted mono" style="margin-left:auto">{{r.asin}} · 入库 {{fmtDate(r.first_seen_at)}}</span>
            </div>
            <div class="rev-body">{{r.body}}</div>
          </div>
        </div>
      </div>
    </template>

    <!-- ==================== DATASOURCE CONFIG (dual-mode + token pool) ==================== -->
    <template v-else-if="route==='datasource'">
      <div class="card">
        <h3>Apify 数据源模式</h3>
        <div class="settings-grid">
          <label>模式（mock 免费 / apify 真实付费）</label>
          <select v-model="dsForm.apify_mode">
            <option value="mock">mock（模拟，不扣费）</option>
            <option value="apify">apify（真实抓取，付费）</option>
          </select>
          <label>单 token（池未启用时使用）</label>
          <input v-model="dsForm.apify_token" class="mono" type="password" placeholder="留空则用环境变量 APIFY_TOKEN">
        </div>
        <p class="muted" style="margin-top:8px">此处的值写入系统设置，<b>优先于 docker compose 环境变量</b>。留空时回退到环境变量。</p>
        <button class="btn primary" style="margin-top:12px" @click="saveDsConfig">保存配置</button>
      </div>

      <div class="card" v-if="tokenData">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0">Token 池（多账号额度轮换）</h3>
          <button class="btn sm" :class="tokenData.enabled?'danger':'primary'" @click="togglePool">{{tokenData.enabled?'关闭池（回退单 token）':'启用池'}}</button>
        </div>
        <p class="muted" style="margin-bottom:12px">
          当前模式 <b>{{tokenData.mode}}</b> · 池 {{tokenData.enabled?'已启用':'未启用'}} · 可用 {{tokenData.items.filter(t=>t.enabled&&!t.cooldown_active).length}}/{{tokenData.items.length}} · 单 token {{tokenData.single_token_masked||'未配置'}}
        </p>
        <div class="row" style="margin-bottom:14px;padding:12px;background:#f8fafc;border-radius:8px">
          <input v-model="tokenForm.label" placeholder="标签，如 账号A" style="width:130px">
          <input v-model="tokenForm.token" class="mono" type="password" placeholder="apify_api_xxx" style="width:220px">
          <input v-model.number="tokenForm.priority" type="number" placeholder="优先级" style="width:90px" title="越大越优先">
          <input v-model.number="tokenForm.quota_limit_usd" type="number" step="0.5" placeholder="月度额度$" style="width:110px" title="手填月度上限，0=未知">
          <button class="btn primary" @click="addToken" :disabled="tokenBusy">添加</button>
        </div>
        <table v-if="tokenData.items.length">
          <thead><tr><th>标签</th><th>Token</th><th>优先级</th><th class="num">额度/已用</th><th>来源</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="t in tokenData.items" :key="t.id">
              <td><input :value="t.label" @change="updateTokenField(t,'label',$event.target.value)" style="width:100px;height:30px"></td>
              <td class="mono">{{t.token_masked}}</td>
              <td><input :value="t.priority" type="number" @change="updateTokenField(t,'priority',Number($event.target.value))" style="width:60px;height:30px"></td>
              <td class="num">{{t.quota_limit_usd||'—'}} / {{Number(t.quota_used_usd||0).toFixed(2)}}</td>
              <td><span class="tag" :class="t.quota_source==='api'?'blue':'gray'">{{t.quota_source}}</span></td>
              <td>
                <span class="tag" :class="t.enabled?'green':'gray'">{{t.enabled?'启用':'禁用'}}</span>
                <span v-if="t.cooldown_active" class="tag amber" title="认证/额度问题临时冷却">冷却中</span>
              </td>
              <td>
                <button class="btn sm" @click="refreshToken(t)" title="从 Apify 自动查额度">刷额度</button>
                <button class="btn sm" @click="updateTokenField(t,'enabled',t.enabled?0:1)" style="margin-left:4px">{{t.enabled?'禁用':'启用'}}</button>
                <button class="btn sm" v-if="t.cooldown_active" @click="clearCooldown(t)" style="margin-left:4px">解冷却</button>
                <button class="btn sm danger" @click="delToken(t)" style="margin-left:4px">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">Token 池为空，添加一个账号 token 开始轮换</div>
        <p class="muted" style="margin-top:10px">策略：过滤禁用/冷却/额度耗尽 → 剩余额度多者优先 + 轮询打散。启动阶段遇认证/额度错误自动冷却该 token 并换下一个；一个抓取 run 全程绑定同一 token。token 不明文回显、不进日志。</p>
      </div>
    </template>

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
      <div class="card">
        <h3>添加关键词</h3>
          <div class="row" style="margin-bottom:10px">
            <textarea v-model="kwForm.text" style="flex:1;min-height:72px" placeholder="一个关键词直接添加；多个关键词请按行填写（Ctrl+Enter 提交），如：&#10;starlink mini&#10;portable power station" @keydown.ctrl.enter.prevent="addKeyword"></textarea>
          </div>
          <div class="row">
            <select v-model="kwForm.mid"><option v-for="s in sites" :value="s.mid">{{s.flag}} {{s.name}}</option></select>
            <input v-model="kwForm.note" placeholder="备注（可选，仅单个添加时生效）" style="flex:1">
            <button class="btn primary" @click="addKeyword">添加</button>
          </div>
      </div>
      <div class="card">
        <div class="filters">
          <select v-model="kwFilters.mid" @change="loadKeywords"><option value="">全部站点</option><option v-for="s in sites" :value="s.mid">{{s.flag}} {{s.name}}</option></select>
          <select v-model="kwFilters.status" @change="loadKeywords"><option value="">全部状态</option><option value="active">活跃</option><option value="paused">暂停</option></select>
          <select v-model="kwFilters.source" @change="loadKeywords"><option value="">全部来源</option><option value="manual">手动添加</option><option value="mcp-live">Agent 自动</option></select>
          <input v-model="kwFilters.search" placeholder="搜索关键词" @keyup.enter="loadKeywords">
          <button class="btn" @click="loadKeywords">筛选</button>
        </div>
        <div class="row" v-if="kwSelected.length" style="margin-bottom:10px;background:#f1f5f9;padding:8px 12px;border-radius:8px">
          <b>已选 {{kwSelected.length}} 项：</b>
          <button class="btn sm" @click="batchKw('enable')">批量启用</button>
          <button class="btn sm" @click="batchKw('pause')">批量暂停</button>
          <button class="btn sm danger" @click="batchKw('delete')">批量删除</button>
          <button class="btn sm" @click="kwSelected=[]">取消选择</button>
        </div>
        <table v-if="kwList.length">
          <thead><tr><th style="width:34px"><input type="checkbox" :checked="kwSelected.length>0 && kwSelected.length===kwList.length" @change="toggleAllKw"></th><th>关键词</th><th>站点</th><th>状态</th><th class="num" title="词库中该关键词前缀下的联想词数量（含 live 与周抓入库）">词库联想数</th><th>最近抓取</th><th>备注</th><th style="width:370px"></th></tr></thead>
          <tbody>
            <tr v-for="kw in kwList" :key="kw.id">
              <td><input type="checkbox" :value="kw.id" v-model="kwSelected"></td>
              <td style="font-weight:600">{{kw.text}} <span v-if="kw.source==='mcp-live'" class="tag blue" title="由 agent live 抓取自动创建，暂停待审核">Agent</span></td>
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
          <thead><tr><th>#</th><th>触发</th><th>状态</th><th>进度</th><th class="num">请求(已/计划)</th><th class="num">失败</th><th>开始时间</th><th>结束时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in runList" :key="r.id">
              <td>{{r.id}}</td>
              <td>{{r.trigger_type==='weekly'?'周调度':'手动'}}</td>
              <td><span class="tag" :class="runStatusTag(r.status)">{{r.status}}</span></td>
              <td style="min-width:160px">
                <div class="progress"><i :style="{width:runProgress(r).pct+'%'}"></i></div>
                <span class="muted" style="font-size:11px">{{runProgress(r).text}}<span v-if="runProgress(r).sub"> · {{runProgress(r).sub}}</span></span>
              </td>
              <td class="num">{{runRequests(r)}}</td>
              <td class="num" :style="{color:r.error_requests>0?'var(--red)':''}">{{r.error_requests}}</td>
              <td class="muted">{{fmtDate(r.started_at)}}</td>
              <td class="muted">{{fmtDate(r.finished_at)}}</td>
              <td><div class="row" style="flex-wrap:nowrap">
                <button class="btn sm" @click="showRun(r)">详情</button>
                <button v-if="r.status==='running'||r.status==='pending'" class="btn sm danger" @click="cancelRun(r)">取消</button>
                <button v-else class="btn sm danger" @click="delRun(r)">删除</button>
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
          <div class="combo" style="min-width:260px">
            <input v-model="trendKwQuery" placeholder="输入关键词筛选，如 stylus…" autocomplete="off"
                   @focus="trendKwOpen=true; syncTrendKwQuery(); trendKwQuery=''" @input="trendKwOpen=true" @blur="trendKwOpen=false; syncTrendKwQuery()"
                   @keydown.escape="trendKwOpen=false">
            <div class="combo-list" v-if="trendKwOpen">
              <div v-for="kw in trendKwOptions" :key="kw.id" class="combo-item" :class="{active:kw.id===trendKid}"
                   @mousedown.prevent="pickTrendKw(kw)">{{trendKwLabel(kw)}}</div>
              <div v-if="!trendKwOptions.length" class="combo-item muted">无匹配关键词</div>
            </div>
          </div>
          <select v-model.number="trendRuns" @change="loadTrend">
            <option :value="6">最近 6 次快照</option><option :value="12">最近 12 次</option><option :value="26">最近 26 次</option><option :value="52">最近 52 次</option>
          </select>
          <a v-if="trendData && trendData.runs.length" class="btn" :href="'/api/trends/export?keyword_id='+trendKid">导出 CSV</a>
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
          <button class="btn danger" @click="purgeSeedLexicon" title="按来源精确清理已删除关键词的残留联想词">清理残留</button>
          <button class="btn danger" @click="forcePurgeSeedLexicon" title="删除包含该关键词的所有联想词（忽略共享保护）">强制清理</button>
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
              <td><span style="font-weight:600">{{it.phrase}}</span> <span v-if="it.is_core" class="tag blue">核心</span></td>
              <td>{{siteFlag(it.mid)}}</td>
              <td class="num">{{it.seen_count}}</td>
              <td class="muted">{{it.first_seen_at.slice(0,10)}}</td>
              <td class="muted">{{it.last_seen_at.slice(0,10)}}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">无匹配结果</div>
        <div class="row pager" style="margin-top:12px;justify-content:center" v-if="lexData.total>50">
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
          <thead><tr><th>名称</th><th>Key</th><th>状态</th><th class="num">Credits 余额</th><th>实时抓取（今日用量）</th><th>最近调用</th><th>创建时间</th><th style="width:250px"></th></tr></thead>
          <tbody>
            <tr v-for="k in keyList" :key="k.id">
              <td style="font-weight:600">{{k.name}}</td>
              <td class="mono muted">{{k.key_prefix}}…</td>
              <td><span class="tag" :class="k.active?'green':'red'">{{k.active?'有效':'已吊销'}}</span></td>
              <td class="num"><b>{{k.credits_balance}}</b></td>
              <td>
                <button class="btn sm" :class="k.can_live?'':'danger'" style="margin-right:6px" @click="toggleLive(k)">{{k.can_live?'允许':'禁止'}}</button>
                <a class="mono muted" style="cursor:pointer;text-decoration:underline dotted" @click="setLiveLimit(k)" :title="k.can_live?'点击修改每日限额':'实时抓取已禁止'">{{k.live_today ?? 0}}/{{k.can_live ? k.live_daily_limit : '—'}} 次/日</a>
              </td>
              <td class="muted">{{fmtDate(k.last_used_at)}}</td>
              <td class="muted">{{fmtDate(k.created_at)}}</td>
              <td><div class="row" style="flex-wrap:nowrap">
                <button class="btn sm" @click="topupKey(k,'充值')">充值</button>
                <button class="btn sm" @click="showLedger(k)">流水</button>
                <button class="btn sm" @click="showCalls(k)">调用</button>
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
          <label>MCP live 全服每日上限（所有 key 合计）<input v-model="settingsForm.mcp_live_global_daily" type="number"></label>
          <label>live 抓取结果合并进词库（1 开 / 0 关）<input v-model="settingsForm.mcp_live_persist" type="number" min="0" max="1"></label>
          <label>live 关键词自动建为暂停种子词（1 开 / 0 关）<input v-model="settingsForm.mcp_live_auto_seed" type="number" min="0" max="1"></label>
          <label>自动建种子词的最少词数<input v-model="settingsForm.live_seed_min_words" type="number"></label>
          <label>自动建种子词的最多词数<input v-model="settingsForm.live_seed_max_words" type="number"></label>
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
      <div class="card">
        <h3>修改管理员密码</h3>
        <p class="muted" style="margin-top:0">保存后以数据库密码为准（重启/升级不变，环境变量失效）。至少 8 位。</p>
        <div class="row">
          <input v-model="pwForm.old" type="password" placeholder="旧密码" style="width:220px">
          <input v-model="pwForm.new1" type="password" placeholder="新密码（至少 8 位）" style="width:220px">
          <input v-model="pwForm.new2" type="password" placeholder="确认新密码" style="width:220px">
          <button class="btn primary" @click="changePassword">修改密码</button>
        </div>
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
            <span class="muted">{{modal.run.done_keywords}}/{{modal.run.total_keywords}} 关键词 · 请求 {{runRequests(modal.run)}} · 失败 {{modal.run.error_requests}}</span>
          </div>
          <div class="progress" style="margin-bottom:14px"><i :style="{width:runProgress(modal.run).pct+'%'}"></i></div>
          <div style="max-height:420px;overflow:auto">
            <table>
              <thead><tr><th>关键词</th><th>站点</th><th>状态</th><th class="num">基础</th><th class="num">扩展</th><th class="num">请求(已/计划)</th><th>错误</th></tr></thead>
              <tbody>
                <tr v-for="it in modal.items" :key="it.id">
                  <td>{{it.keyword_text}}</td>
                  <td>{{siteFlag(it.mid)}}</td>
                  <td><span class="tag" :class="runStatusTag(it.status)">{{it.status}}</span></td>
                  <td class="num">{{it.basic_count}}</td>
                  <td class="num">{{it.expand_count}}</td>
                  <td class="num">{{itemProgress(it)}}</td>
                  <td class="muted" style="font-size:11px">{{it.error}}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <template v-else-if="modal.type==='calls'">
          <table>
            <thead><tr><th>时间</th><th>调用方</th><th>工具</th></tr></thead>
            <tbody>
              <tr v-for="r in modal.rows" :key="r.id">
                <td class="muted">{{fmtDate(r.created_at)}}</td>
                <td><span class="tag" :class="r.client_id?'blue':'gray'">{{r.client_id || '未标识'}}</span></td>
                <td class="mono">{{r.tool}}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted" style="margin-top:10px">调用方由请求头 X-Client-Id 提供；未标识的调用不会记录身份。</p>
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
