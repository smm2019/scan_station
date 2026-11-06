// ㉖v113 指挥舱融合（11标签→7标签两级导航）· 实例验证
// N1 服务端：/api/report/analytics 的 series 追加 prob 分类型字段，且 v112 原有键与口径不变（回归）
// N2 前端沙箱：跑 console.html 真代码 —— 7 标签结构、11 旧键映射、未知键回落、记住子页、深链、红牌角标
// N3 复盘页：用服务端真实返回 + 合成数据双路喂给真 rvRender/rvPulse/rvBrief，验证不抛异常且渲染出内容
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_agvnav_data');
const PORT = 18141;
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (p, tok) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 15000, headers: tok ? { Authorization: 'Bearer ' + tok } : {} }, (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败(状态' + res.statusCode + '): ' + s.slice(0, 120))); } }); }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('超时')); }); });

const H = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
// 脉冲图 11 个类型键（与前端 RVROWS 同源）；PROB_PULSE = v112 pulse 计分口径（8 项之和，回归基准）
const PROB_KEYS = ['alarm', 'redflag', 'jam', 'timeoutOut', 'timeoutIn', 'fifo', 'conflict', 'overfire', 'overdue', 'watchdog', 'sysErr'];
const PROB_PULSE = ['alarm', 'redflag', 'jam', 'timeoutOut', 'timeoutIn', 'fifo', 'watchdog', 'sysErr'];
const NL = String.fromCharCode(10);
const between = (a, b) => { const i = H.indexOf(a); const j = H.indexOf(b, i < 0 ? 0 : i); if (i < 0 || j < 0 || j <= i) throw new Error('切片失败: ' + a + ' → ' + b); return H.slice(i, j) };
// 从 marker 所在行起，取到下一个「行首顶格的顶层声明」为止（函数体的续行都带前导空格，故不会误截）
const declOf = (marker) => { const i = H.indexOf(marker); if (i < 0) throw new Error('未找到: ' + marker); const rest = H.slice(i); const lines = rest.split(NL); const out = [lines[0]]; for (let k = 1; k < lines.length; k++) { if (/^(function |async function |var |let |const |\/\/ |window\.)/.test(lines[k])) break; out.push(lines[k]) } return out.join(NL) };

(async () => {
  // ================= 服务端实例（先起，拿到真实 analytics 返回供前端喂数）=================
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const VT = 'TESTTOK_agvnav';
  { const _d = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8')); const _a = (_d.users || []).find((x) => x.role === 'admin' && x.enabled !== false); if (!_a) { console.log('FATAL: 无启用 admin'); process.exit(2); } _d.sessions = _d.sessions || {}; _d.sessions[VT] = { userId: _a.id, dev: 'TEST-NAV', lastSeen: Date.now() }; fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(_d)); }
  let inst = null, up = false;
  try { inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { console.log('  [跳过服务端实例] spawn 失败：' + e.code + '（沙箱不允许起子进程；前端沙箱验证照常进行）') }
  if (inst) { inst.on('error', (e) => { console.log('  [跳过服务端实例] ' + e.code) }) }
  if (inst) { for (let i = 0; i < 45; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await rq('/api/health'); if (h.ok) { up = true; break } } catch (_) { } } }
  if (!inst || !up) { console.log('  N1 服务端实例项跳过（' + (inst ? '未就绪' : '无法起子进程') + '）——改由离线读日快照验证 prob 字段'); }
  else T('N1a 隔离服务器就绪', up, true);

  const end = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') })();
  let wj = null, realSeries = null;
  if (up) {
    try { wj = await rq('/api/report/analytics?g=week&end=' + end, VT) } catch (e) { console.log('  analytics 请求失败: ' + e.message) }
    T('N1b analytics 周报返回 ok', !!(wj && wj.ok), true);
    if (wj && wj.ok) {
      const se = wj.series || [];
      T('N1c series 非空（有日快照可聚合）', se.length > 0, true);
      if (se.length) {
        realSeries = se; const s0 = se[0];
        T('N1d series v112 原有键全部保留（分析报告页回归）', ['day', 'inB', 'outB', 'created', 'agv', 'ev', 'pulse', 'health'].every((k) => k in s0), true);
        T('N1e series 追加 prob 分类型对象', typeof s0.prob === 'object' && s0.prob !== null, true);
        T('N1f prob 含脉冲图所需 11 个类型键', PROB_KEYS.every((k) => typeof s0.prob[k] === 'number'), true);
        const p = s0.prob, sum = p.alarm + p.redflag + p.jam + p.timeoutOut + p.timeoutIn + p.fifo + p.watchdog + p.sysErr;
        T('N1g pulse 口径未被改坏（仍等于 v112 各类型之和）', s0.pulse, sum);
        T('N1h health 口径未被改坏', s0.health, Math.max(0, 100 - s0.pulse * 2));
        T('N1i 追加 stale/rej/canc 供简报取数', ['stale', 'rej', 'canc'].every((k) => typeof s0[k] === 'number'), true);
      }
      T('N1j cur.problems 字段存在（可为 null=旧快照未采集）', !!(wj.cur && ('problems' in wj.cur)), true);
    }
  } else {
    // 离线兜底：直读生产日快照，验证 problems 字段与脉冲图 11 个类型键在真实数据里都存在
    const RD = path.join(__dirname, 'data', 'reports');
    let snaps = [];
    try { snaps = fs.readdirSync(RD).filter((x) => /^daily-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort().slice(-7).map((x) => JSON.parse(fs.readFileSync(path.join(RD, x), 'utf8'))) } catch (_) { }
    T('N1b 离线读到近 7 份日快照', snaps.length > 0, true);
    if (snaps.length) {
      const withP = snaps.filter((s) => s.problems);
      // 如实反映：v112 problems 是本次在途新增，存量快照生成于它之前 → 无该字段属正常，
      // 前端必须按"未采集"降级（N3l/N3m 覆盖），新快照从服务重启当天起自动带上。
      console.log('  [信息] ' + withP.length + '/' + snaps.length + ' 份存量快照含 problems（其余早于 v112，属预期）');
      if (withP.length) {
        const q = withP[withP.length - 1].problems;
        T('N1d 脉冲图 11 个类型键在真实快照中均为数字', PROB_KEYS.every((k) => typeof q[k] === 'number'), true);
        realSeries = snaps.map((r) => { const p = r.problems || {}; return { day: r.day, pulse: PROB_PULSE.reduce((s, k) => s + (p[k] || 0), 0), prob: Object.fromEntries(PROB_KEYS.map((k) => [k, p[k] || 0])) } });
        console.log('  （离线口径：' + withP.length + '/' + snaps.length + ' 份快照有 problems，最近一天 ' + JSON.stringify(withP[withP.length - 1].problems).slice(0, 150) + '…）');
      }
      const st = snaps[snaps.length - 1];
      T('N1e 简报取数依赖的 stock.stale7 / reqs.rejected / cars 在快照中存在', !!(st.stock && 'stale7' in st.stock) && !!(st.reqs && 'rejected' in st.reqs) && typeof st.cars === 'object', true);
    }
  }
  try { if (inst) inst.kill('SIGKILL') } catch (_) { }

  // ================= 前端沙箱：抽取 console.html 真实导航代码 =================
  const els = {};
  const mk = (id) => (els[id] = els[id] || { id, innerHTML: '', style: {}, dataset: {}, className: '', textContent: '', appendChild() { }, removeChild() { }, closest() { return null }, querySelectorAll() { return [] }, addEventListener() { }, scrollIntoView() { } });
  const ctx = {
    window: {}, console, Math, Date, Object, JSON, String, Number, Array, RegExp, Set, Boolean, parseInt, parseFloat, isFinite,
    localStorage: { _d: {}, getItem(k) { return this._d[k] == null ? null : this._d[k] }, setItem(k, v) { this._d[k] = String(v) } },
    location: { hash: '' },
    $: (s) => mk(String(s).replace(/^#/, '')),
    _esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    T: () => { }, ctCopy: () => { }, api: async () => { ctx._apiCalled = (ctx._apiCalled || 0) + 1; return { ok: true } },
    U: { role: 'admin' }, TAB: 'agv', HEAT: false, NET: { lands: {}, edges: [] },
    EVS: null, EVDAY: '', EVK: '', EVW: 'a', EVLO: 0, EVUN: 0,
    loadEv: () => { ctx._evCalled = (ctx._evCalled || 0) + 1 }, rvGo: () => { }, pgBar: () => '', sTh: () => '<th></th>', sortArr: (a) => a,
    loadMap: () => { ctx._loaded = 'map' }, loadPipe: () => { ctx._loaded = 'pipe' }, loadBoard: () => { ctx._loaded = 'board' },
    loadGantt: () => { ctx._loaded = 'gantt' }, loadQ: () => { ctx._loaded = 'q' }, loadCars: () => { ctx._loaded = 'car' },
    loadTraf: () => { ctx._loaded = 'traf' }, loadCap: () => { ctx._loaded = 'cap' }, loadRep: () => { ctx._loaded = 'rep' },
    loadPlay: () => { ctx._loaded = 'play' }, drawMap: () => { },
    UiTune: { renderNav() { }, enter() { } }, navBadge: () => { },
  };
  vm.createContext(ctx);
  const src = [
    between('let NET=null,SSE=null,AGV1=', 'function esSSE(){'),            // 导航骨架：AGVNAV/AGVSUB/AGVKEY/AGVKIDS/AGVTAB/renderAgvNav/agvNavBadge
    declOf('function agvTab(t){'),                                          // 两级调度器
    declOf('function agvCurHash()'),                                        // 深链地址生成
    between('// ===== ㉖v113「异常与复盘」', 'var _capD=7;'),                 // 复盘页真实代码
    'globalThis.__x={get AGVTAB(){return AGVTAB},get AGV1(){return AGV1},AGVNAV,AGVKEY,AGVKIDS,agvTab,renderAgvNav,agvCurHash,rvRender,rvPulse,rvTrend,rvBrief,loadReview,RV,rvEnd}',
  ].filter((x) => typeof x === 'string').join(NL);
  let ran = true;
  try { vm.runInContext(src, ctx) } catch (e) { ran = false; console.log('  导航代码抛错: ' + e.message) }
  T('N2a console.html 真实导航+复盘代码在沙箱执行不抛异常', ran, true);
  const X = ctx.__x || {};

  T('N2b 一级标签恰为 7 个', (X.AGVNAV || []).length, 7);
  T('N2c 一级标签键序与草图一致', (X.AGVNAV || []).map((x) => x[0]), ['map', 'ops', 'stn', 'veh', 'play', 'eff', 'rev']);
  T('N2d 一级标签显示名（融合后的 7 个）', (X.AGVNAV || []).map((x) => x[1].replace(/^\S+\s/, '')), ['地图', '调度运作', '站台', '车辆', '回放', '效率', '异常与复盘']);

  // 保险②旧键兼容：原 11 个平铺标签键全部可解析并落到正确的一级+叶子
  const LEG = { map: ['map', 'map'], pipe: ['ops', 'pipe'], board: ['stn', 'board'], gantt: ['stn', 'gantt'], q: ['ops', 'q'], car: ['veh', 'car'], traf: ['veh', 'traf'], ev: ['rev', 'rev'], play: ['play', 'play'], cap: ['eff', 'cap'], rep: ['eff', 'rep'] };
  let legOk = true;
  for (const k of Object.keys(LEG)) { X.agvTab(k); const got = [X.AGV1, X.AGVTAB]; if (JSON.stringify(got) !== JSON.stringify(LEG[k])) { legOk = false; console.log('  旧键 ' + k + ' 期望 ' + LEG[k] + ' 实得 ' + got) } }
  T('N2e 保险②：11 个旧键全部正确映射（agvTab("gantt")/"ev" 照常直达）', legOk, true);

  let gOk = true;
  for (const [k, , kids] of X.AGVNAV) { X.agvTab(k); if (X.AGV1 !== k) { gOk = false; console.log('  一级键 ' + k + ' 未选中') } const want = kids.length ? kids[0] : k; if (X.AGVTAB !== want) { gOk = false; console.log('  一级键 ' + k + ' 叶子期望 ' + want + ' 实得 ' + X.AGVTAB) } }
  T('N2f 7 个一级键均可进入，有子页者默认落到首个子页', gOk, true);

  X.agvTab('zzz_nope'); T('N2g 未知键回落地图（绝不白屏）', [X.AGV1, X.AGVTAB], ['map', 'map']);
  X.agvTab(''); T('N2h 空键回落地图', [X.AGV1, X.AGVTAB], ['map', 'map']);
  X.agvTab(null); T('N2i null 键回落地图', [X.AGV1, X.AGVTAB], ['map', 'map']);

  X.agvTab('gantt'); T('N2j 保险①：所选子页写入本地存储', ctx.localStorage.getItem('ck_agvtab'), 'gantt');
  X.agvTab('traf'); T('N2k 保险①：切换子页后存储同步更新', ctx.localStorage.getItem('ck_agvtab'), 'traf');
  T('N2l 保险①：存储值可被解析表接受（刷新后能回到该页）', !!(X.AGVKEY[ctx.localStorage.getItem('ck_agvtab')]), true);

  X.agvTab('rep'); T('N2m 保险③：深链 hash = #agv/叶子键', ctx.location.hash, '#agv/rep');
  X.agvTab('map'); T('N2n 保险③：地图页 hash 同步', ctx.location.hash, '#agv/map');
  T('N2o agvCurHash 返回可分享的当前地址', X.agvCurHash(), 'agv/map');
  X.agvTab('ev'); T('N2p 旧键 ev 深链落到 rev', ctx.location.hash, '#agv/rev');

  // 保险④红牌角标挂在「异常与复盘」一级标签上
  ctx.window._lastRed = 3; X.agvTab('rev'); X.renderAgvNav();
  const nav1 = els['agvnav'].innerHTML;
  T('N2q 保险④：红牌>0 时「异常与复盘」标签带角标', /data-g="rev"[\s\S]*?navbd/.test(nav1), true);
  T('N2r 保险④：角标数字为红牌数', />3</.test(nav1), true);
  T('N2s 保险④：角标只挂在 rev 标签，不误挂其它标签', (nav1.match(/navbd/g) || []).length, 1);
  ctx.window._lastRed = 12; X.renderAgvNav();
  T('N2t 保险④：红牌>9 显示 9+', />9\+</.test(els['agvnav'].innerHTML), true);
  ctx.window._lastRed = 0; X.renderAgvNav();
  T('N2u 保险④：红牌清零后角标消失', /navbd/.test(els['agvnav'].innerHTML), false);

  const noSub = ['map', 'play', 'rev'].every((k) => { X.agvTab(k); X.renderAgvNav(); return els['agvsub'].style.display === 'none' });
  T('N2v 地图/回放/异常与复盘 无二级栏（不显示空行占位）', noSub, true);
  const hasSub = ['ops', 'stn', 'veh', 'eff'].every((k) => { X.agvTab(k); X.renderAgvNav(); return els['agvsub'].style.display === 'flex' });
  T('N2w 调度运作/站台/车辆/效率 显示二级栏', hasSub, true);
  const leaves = [].concat(...X.AGVNAV.map((x) => x[2]));
  T('N2x 二级子页集合正确（8 个）', leaves, ['pipe', 'q', 'board', 'gantt', 'car', 'traf', 'cap', 'rep']);
  T('N2y 二级子页均有中文名（不会出现裸键）', leaves.every((k) => String((vm.runInContext('AGVSUB', ctx) || {})[k] || '').length >= 2), true);
  T('N2z 原 11 个平铺标签全部被 7 个一级覆盖（无功能丢失）', ['map', 'pipe', 'board', 'gantt', 'q', 'car', 'traf', 'ev', 'play', 'cap', 'rep'].every((k) => !!X.AGVKEY[k]), true);

  // ================= N3 复盘页：真实返回 + 合成数据双路喂真函数 =================
  const synth = {
    ok: true, g: 'week', range: '2026-10-30 ~ 2026-11-05', days: 7, loaded: 7, missing: [],
    cur: { rejected: 2, cancelled: 4, problems: { alarm: 30, redflag: 4, jam: 2, timeoutOut: 3, timeoutIn: 1, fifo: 12, conflict: 1, overfire: 0, overdue: 5, watchdog: 1, sysErr: 2, slowApi: 2, slowMax: 1800, slowP: '/api/rcs/map' }, stock: { stale7: 31 }, cars: { '3': { n: 90, dur: 90 * 900, dn: 90 }, '5': { n: 88, dur: 88 * 240, dn: 88 }, '7': { n: 60, dur: 60 * 300, dn: 60 } } },
    prev: { rejected: 1, cancelled: 2, problems: { alarm: 26, redflag: 6, jam: 3, timeoutOut: 5, timeoutIn: 0, fifo: 8, conflict: 2, overfire: 1, overdue: 7, watchdog: 0, sysErr: 1 } },
    series: Array.from({ length: 7 }, (_, i) => ({ day: '2026-10-' + (30 + i), pulse: 10 + i, health: 80 - i * 3, prob: { alarm: 4 + (i % 3), redflag: i === 3 ? 4 : 0, jam: i === 5 ? 2 : 0, timeoutOut: i === 1 ? 3 : 0, timeoutIn: 0, fifo: i === 3 ? 4 : 1, conflict: 0, overfire: 0, overdue: 1, watchdog: 0, sysErr: 0 }, stale: 30, rej: 1, canc: 1 })),
  };
  let r1 = true;
  try { els['rvbody'] = mk('rvbody'); els['rvpulse'] = mk('rvpulse'); els['rvtrend'] = mk('rvtrend'); els['rvbrief'] = mk('rvbrief'); X.rvRender(synth) } catch (e) { r1 = false; console.log('  rvRender(合成) 抛错: ' + e.message + NL + (e.stack || '').split(NL)[1]) }
  T('N3a 复盘渲染（合成数据，problems 齐全）不抛异常', r1, true);
  const kb = els['rvbody'].innerHTML;
  T('N3b KPI 卡渲染出问题总数', /问题事件总数/.test(kb), true);
  T('N3c KPI 卡渲染出 FIFO/红牌/呆滞', /FIFO违反/.test(kb) && /红牌急停/.test(kb) && /呆滞7天\+框/.test(kb), true);
  T('N3d 环比箭头出现（prev 存在）', /▲\+|▼/.test(kb), true);
  T('N3e 慢接口按真实值渲染', /慢接口天数/.test(kb) && /1800/.test(kb), true);
  T('N3f 脉冲图渲染出可点击格子（带日期与类型）', /rvDrill\('2026-10-3[0-6]'/i.test(els['rvpulse'].innerHTML) || /rvDrill\(/.test(els['rvpulse'].innerHTML), true);
  T('N3g 脉冲图爆红格（当日≥3起）标出数字', /font-weight:700[^>]*>\d+</.test(els['rvpulse'].innerHTML), true);
  T('N3h 健康趋势条渲染出每日一根', (els['rvtrend'].innerHTML.match(/<i /g) || []).length, synth.series.length);
  const brief = els['rvbrief'].innerHTML;
  T('N3i 简报生成且可复制（含区间与问题总数）', /复盘简报/.test(brief) && /2026-10-30 ~ 2026-11-05/.test(String(ctx.window._rvTxt || '')), true);
  T('N3j 简报含慢车点名（按真实 cars 算出）', /慢车点名/.test(String(ctx.window._rvTxt || '')), true);
  T('N3k 简报含 FIFO 集中日（脉冲最坏日）', /集中 10-3[0-6]/.test(String(ctx.window._rvTxt || '')) || /FIFO违反 12 起/.test(String(ctx.window._rvTxt || '')), true);

  // problems 为 null（旧快照未采集）→ 必须走"未采集"分支而不是崩或显示 0 骗人
  const nul = JSON.parse(JSON.stringify(synth)); nul.cur.problems = null;
  let r2 = true;
  try { els['rvbody'].innerHTML = ''; X.rvRender(nul) } catch (e) { r2 = false; console.log('  rvRender(null) 抛错: ' + e.message) }
  T('N3l problems=null 不抛异常', r2, true);
  T('N3m problems=null 明确提示未采集（不静默显示 0）', /未采集问题数据/.test(els['rvbody'].innerHTML), true);

  // 真实服务端返回直接喂入（字段名对不上的话这里就会露馅）
  if (wj && wj.ok) {
    let r3 = true;
    try { els['rvbody'].innerHTML = ''; els['rvpulse'].innerHTML = ''; els['rvtrend'].innerHTML = ''; els['rvbrief'].innerHTML = ''; X.rvRender(wj) } catch (e) { r3 = false; console.log('  rvRender(真实返回) 抛错: ' + e.message) }
    T('N3n 服务端真实返回喂入 rvRender 不抛异常', r3, true);
    T('N3o 真实返回渲染出内容（非空）', els['rvbody'].innerHTML.length > 0, true);
    const hasProb = !!(wj.cur && wj.cur.problems);
    T('N3p 真实数据走对分支（有problems→KPI卡；无→未采集提示）', hasProb ? /问题事件总数/.test(els['rvbody'].innerHTML) : /未采集问题数据/.test(els['rvbody'].innerHTML), true);
    if (hasProb && realSeries && realSeries.length >= 2) T('N3q 真实 series 渲染出脉冲图', els['rvpulse'].innerHTML.length > 200, true);
    console.log('  （真实数据 problems=' + (hasProb ? '已采集' : '未采集(null)') + '，series ' + realSeries.length + ' 天）');
  }

  // 下钻：点脉冲格 → 事件流水过滤条件被正确写入，且时间窗放开到"全部"（否则历史日期会被筛成空白）
  try { vm.runInContext("rvDrill('2026-10-31','FIFO违反')", ctx) } catch (e) { console.log('  rvDrill 抛错: ' + e.message); fail++; total++ }
  T('N3r 下钻写入按日+按类型过滤', [ctx.EVDAY, ctx.EVK], ['2026-10-31', 'FIFO违反']);
  T('N3s 下钻放开时间窗为全部（防止点了像没反应）', ctx.EVW, 'a');
  T('N3t 下钻重置分页与仅未了结/仅未认领', [ctx.EVLO, ctx.EVUN], [0, 0]);
  T('N3u 下钻触发事件流水重载', (ctx._evCalled || 0) > 0, true);

  // 角色降级：必须走真实入口 rvGo（守卫在这里）。物料员能进指挥舱，而 analytics 对非管理/仓管返 403，
  // api() 遇 403 会直接 out() 登出 —— 没有这层守卫，物料员点「异常与复盘」就被踢下线。
  // 先排空微任务：前面 agvTab('rev') 触发的 loadReview() 会发起一个未 await 的 rvGo（当时是 admin，
  // 守卫放行），它在本次 await 时才恢复并回写 rvbody，会覆盖掉物料员的守卫结果 —— 属夹具时序，非产品缺陷。
  await new Promise((r) => setTimeout(r, 0));
  ctx.U = { role: 'material' }; ctx._apiCalled = 0; els['rvbody'].innerHTML = '';
  let r4 = true; try { await vm.runInContext('rvGo()', ctx) } catch (e) { r4 = false; console.log('  rvGo(material) 抛错: ' + e.message) }
  T('N3v 物料员看复盘页不抛异常', r4, true);
  T('N3w 物料员被降级提示而非泄露数据', /仅管理员\/仓管员可见/.test(els['rvbody'].innerHTML) && !/问题事件总数/.test(els['rvbody'].innerHTML), true);
  // 守卫必须真的拦住请求：未放行到 analytics（api() 遇 403 会登出，放行=踢人下线）
  T('N3x 守卫未放行到 analytics 接口（不会触发 403 登出）', ctx._apiCalled || 0, 0);
  ctx.U = { role: 'admin' };

  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch (_) { }
  console.log('\n===== v113 融合导航验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})();
