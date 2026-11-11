// ㉖v151 KPI 显隐「隐藏清单」制 · 前端真实代码沙箱 + 服务端真实偏好验证
// 缺陷（11-11 现场）：管理员概览看不到「一楼来料登记(标签)/待入库(来料区)」，仓管员却能看到。
// 根因：PF.kpi 是【白名单】——管理员 11-06 19:42 在偏好里存过程序卡快照（11项），此后新上线的卡片
//       不在其快照里 ⇒ 永久隐身；偏好弹窗候选清单还硬编码13项（连"检验待处理"都没有）⇒ 加不回。
// 修法：kpi 只决定顺序，新增 kpiH 显式隐藏清单；判据改「不在隐藏清单里=显示」；候选清单与渲染卡同源。
// 断言覆盖：真实管理员偏好复算、旧逻辑对照（证明确实会丢卡）、隐藏生效、顺序保持、模板/下发链路、
//          以及 prefsFor 超长 if/else 链未被注释吞分支（行尾注释事故回归护栏）。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
const srv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
const NL = String.fromCharCode(10);
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };

const KARR14 = ['今日入库(标签)', '今日入库件数', '一楼来料登记(标签)', '待入库(来料区)', '今日出库拣下', '今日AGV搬运', '队列中', '在库框数', '占用货位', '待接单', '备料中', '待签收', '站台在用', '检验待处理'];

// 抽取真实代码块：const KARR=... 到 kshow 计算结束（不含 $('#main').innerHTML 渲染）
const s0 = h.indexOf(' const KARR=[');
const s1 = h.indexOf(" $('#main').innerHTML=`<div class=\"row\"><span style=\"color:var(--sub)\">数据时刻");
if (s0 < 0 || s1 < 0 || s1 < s0) { console.log('FATAL: 未定位 KPI 显隐代码块'); process.exit(2); }
const block = h.slice(s0, s1);
if (!block.includes('_KALL') || !block.includes('_hid')) { console.log('FATAL: 抽取块不含 v151 新逻辑'); process.exit(2); }

// 真实 KPI 数据桩（值本身不参与显隐判定，给全字段防 KARR 取值 undefined）
const kAll = {}; for (const n of ['inBoxes', 'inQty', 'recvToday', 'pendRecv', 'outToday', 'agvToday', 'agvQueue', 'stockBoxes', 'stockLocs', 'pending', 'accepted', 'ready']) kAll[n] = 5;
kAll.stnTotal = 12; kAll.stnBusy = 3; kAll.inspWait = 2;

// 跑真实块，返回显示卡名序
function runNew(PF) {
  const ctx = { PF, k: kAll, window: {}, todayStr: () => '2026-11-11' };
  vm.createContext(ctx);
  vm.runInContext(block + NL + 'globalThis.__ks=kshow.map((x)=>x[0]);', ctx);
  return ctx.__ks;
}
// 旧逻辑对照组：白名单语义的等价复现（旧代码已被 v151 替换、仓库中不再存在，无法抽取真身）。
// 旧逻辑显隐只依赖名字集合，故纯名字等价：PF.kpi 非空 ⇒ 只显示快照内且系统仍有的卡；否则全显。
function runOld(PF) {
  const snap = Array.isArray(PF.kpi) ? PF.kpi.filter((n) => KARR14.includes(n)) : [];
  return snap.length ? snap : KARR14.slice();
}

// 样本=11-06 09:24 那次"保存偏好"时的【历史快照】定版（当时两张来料卡尚未上线，故只有 11 项）。
// 不读线上 db.prefs：那是在用的生产数据，用户任何一次保存偏好都会改变它（11-11 09:24 已被存成 14 项+
// kpiH，恰好证明修复上线生效），拿它当断言前提会让测试结果随线上操作漂移。
const admKpi = ['今日入库(标签)', '今日入库件数', '今日出库拣下', '今日AGV搬运', '队列中', '在库框数', '占用货位', '待接单', '备料中', '待签收', '站台在用'];
const admKpiH = []; // 历史态：无 kpiH（v151 前不存在该键=未隐藏任何卡）
console.log('=== 样本=历史快照(' + admKpi.length + '项)；线上现状仅记录不断言 ===');
console.log('  线上 u_admin kpi=', JSON.stringify(((((db.prefs || {}).u_admin || {}).kpi) || {}).v || ''), 'kpiH=', JSON.stringify(((((db.prefs || {}).u_admin || {}).kpiH) || {}).v || ''));

// ===== 1. 缺陷复现与修复：同一份历史快照 =====
const oldShown = runOld({ kpi: admKpi });
T('X1 旧逻辑用历史快照=丢3张卡（缺陷复现）', oldShown.length, 11);
T('X1b 旧逻辑确实看不到「一楼来料登记」', oldShown.includes('一楼来料登记(标签)'), false);

const newShown = runNew({ kpi: admKpi, kpiH: admKpiH });
T('V1 新逻辑用同一份历史快照=14张全显（修复生效）', newShown.length, 14);
T('V1b 一楼来料登记 已可见', newShown.includes('一楼来料登记(标签)'), true);
T('V1c 待入库(来料区) 已可见', newShown.includes('待入库(来料区)'), true);
T('V1d 检验待处理 已可见', newShown.includes('检验待处理'), true);
T('V1e 原有快照顺序保持不变（前3张）', newShown.slice(0, 3), ['今日入库(标签)', '今日入库件数', '今日出库拣下']);
T('V1f 新卡补在末尾不打乱老顺序', newShown.slice(3, 11), ['今日AGV搬运', '队列中', '在库框数', '占用货位', '待接单', '备料中', '待签收', '站台在用']);

// ===== 2. 无偏好/空偏好 =====
T('V2 完全无偏好=14张全显', runNew({}).length, 14);
T('V2b kpi空数组=14张全显', runNew({ kpi: [], kpiH: [] }).length, 14);
// 真实仓管员（截图里能看到两张来料卡的人）：其 prefs 无 kpi 快照 ⇒ 走全显，与管理员形成对照
{ const whU = (db.users || []).find((u) => u.role === 'warehouse' && !Object.prototype.hasOwnProperty.call((db.prefs || {})[u.id] || {}, 'kpi'));
  const whP = (db.prefs || {})[(whU || {}).id] || {};
  T('V2c 存在无KPI快照的仓管员（对照成立）', !!whU, true);
  T('V2d 该仓管员（' + ((whU || {}).name || '?') + '）真实偏好=14张全显', runNew({ kpi: Array.isArray(whP.kpi) ? whP.kpi : [], kpiH: Array.isArray(whP.kpiH) ? whP.kpiH : [] }).length, 14); }

// ===== 3. 隐藏清单真正生效（✕ 移除语义未丢）=====
const hid = ['待入库(来料区)', '检验待处理'];
const hShown = runNew({ kpi: admKpi, kpiH: hid });
T('V3 隐藏2张=剩12张', hShown.length, 12);
T('V3b 被隐藏的不再显示', hShown.filter((n) => hid.includes(n)), []);
T('V3c 隐藏不影响其余顺序', hShown.slice(0, 3), ['今日入库(标签)', '今日入库件数', '今日出库拣下']);
T('V3d 隐藏清单里的未知卡名被忽略（版本升级安全）', runNew({ kpi: [], kpiH: ['不存在的卡'] }).length, 14);

// ===== 4. 偏好弹窗候选清单与渲染卡同源（新卡可加回）=====
const s2 = h.indexOf('const N=[[', 0);
const s3 = h.indexOf('const pf=PF.notes||{};', s2);
const s4 = h.indexOf('window._K=K;', s2);
if (s2 < 0 || s4 < 0) { console.log('FATAL: 未定位偏好弹窗候选清单'); process.exit(2); }
const prefBlk = h.slice(h.indexOf('const K=', s2), h.indexOf(NL, h.indexOf('_kord=', s4)));
{
  const ctx = { PF: { kpi: admKpi, kpiH: hid }, window: {}, KARR_NAMES: KARR14 };
  ctx.window._KALL = KARR14;
  vm.createContext(ctx);
  try { vm.runInContext('let _kord=[];let _khide=new Set();' + NL + prefBlk + NL + 'globalThis.__r={K:window._K,ord:_kord,hide:[..._khide].sort()};', ctx); } catch (e) { console.log('弹窗块执行异常:', e.message); }
  const r = ctx.__r || {};
  T('V4 候选清单=全部14张已知卡（含检验待处理，旧版硬编码13项缺它）', (r.K || []).length, 14);
  T('V4b 候选清单含检验待处理', (r.K || []).includes('检验待处理'), true);
  T('V4c 弹窗按 kpiH 初始化隐藏集', r.hide, hid);
  T('V4d 弹窗列表不含被隐藏卡（✕=隐藏语义正确）', (r.ord || []).filter((n) => hid.includes(n)), []);
  T('V4e 弹窗列表=新逻辑显示集一致（12张）', (r.ord || []).length, 12);
}

// ===== 5. 服务端 prefsFor：kpiH 下发 + 超长 if/else 链未被注释吞分支 =====
{
  const p0 = srv.indexOf('function prefsFor(uid)');
  const p1 = srv.indexOf('return r; }', p0) + 'return r; }'.length;
  const src = srv.slice(p0, p1);
  const dbp = {
    prefs: {
      zz: {
        kpi: { v: admKpi, at: 1 }, kpiH: { v: ['待入库(来料区)'], at: 1 }, notes: { v: { req_new: true }, at: 1 },
        pd_tabs: { v: 'T', at: 1 }, ck_use: { v: 'U', at: 1 }, ck_tabs: { v: 'C', at: 1 },
        work: { v: 1, at: 1 }, rate: { v: 0.8, at: 1 }, ck_accent: { v: 'teal', at: 1 },
        ck_tab_auto: { v: true, at: 1 }, pd_font: { v: 'lg', at: 1 }, landing: { v: 'dash', at: 1 },
      },
    },
  };
  const ctx = { db: dbp }; vm.createContext(ctx);
  vm.runInContext(src + NL + 'globalThis.__p=prefsFor("zz");', ctx);
  const p = ctx.__p || {};
  T('S1 kpiH 原样下发为数组', p.kpiH, ['待入库(来料区)']);
  T('S2 kpi 仍下发（顺序信息不丢）', Array.isArray(p.kpi) && p.kpi.length, admKpi.length);
  // 行尾注释事故护栏：kpiH 之后的 pd_tabs/ck_use/work/rate/... 分支必须仍生效
  T('S3 kpiH 之后的 pd_tabs 分支未被注释吞掉', p.pd_tabs, 'T');
  T('S4 ck_use 分支正常', p.ck_use, 'U');
  T('S5 work 分支正常', p.work, 1);
  T('S6 rate 分支正常', p.rate, 0.8);
  T('S7 ck_accent 分支正常', p.ck_accent, 'teal');
  T('S8 ck_tab_auto 分支正常', p.ck_tab_auto, true);
  T('S9 landing 兜底分支正常', p.landing, 'dash');
  T('S10 notes 分支正常', p.notes, { req_new: true });
}

// ===== 6. 模板链路纳入 kpiH（套用他人模板显隐一致）=====
T('M1 套用模板白名单含 kpiH', /for \(const k of \['landing', 'theme', 'kpi', 'kpiH'/.test(srv), true);
T('M2 存模板白名单含 kpiH 且按数组清洗', /'kpiH', 'notes', 'work', 'rate', 'voice'\]\) if \(src\[k\] !== undefined\) clean\[k\] = \(k === 'kpi' \|\| k === 'kpiH'\)/.test(srv), true);
T('M3 偏好保存接口落库 kpiH', /if \(Array\.isArray\(b\.kpiH\)\) mine\.kpiH = \{ v: b\.kpiH\.slice\(0, 30\)/.test(srv), true);
T('M4 前端保存偏好提交 kpiH', /body:\{landing:\$\('#pd_l'\)\.value,kpi,kpiH,notes\}/.test(h), true);
T('M5 前端存模板提交 kpiH', /prefs:\{landing:\$\('#pd_l'\)\.value,kpi,kpiH,notes\}/.test(h), true);
T('M6 移除按钮写入隐藏集', /function kpiRm\(i\)\{const n=_kord\.splice\(i,1\)\[0\];if\(n\)_khide\.add\(n\)/.test(h), true);
T('M7 加入按钮撤回隐藏（可加回）', /_khide\.delete\(v\);_kord\.push\(v\)/.test(h), true);

console.log('\n===== 阶段一（真实数据+静态断言）' + (total - fail) + '/' + total + ' =====');

// ===== 7. 端到端：真实实例 保存 → 落库 → 下发 → 前端真代码消费 =====
const http = require('http');
const { spawn } = require('child_process');
const TMP = path.join(__dirname, 'proof_kpi_hide');
const PORT = 18148, VT = 'TESTTOK_v151';
const rq = (p, tok, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r0 = http.request({ host: '127.0.0.1', port: PORT, path: p, method: body ? 'POST' : 'GET', timeout: 12000, headers: Object.assign({ Authorization: 'Bearer ' + tok }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败 ' + r.statusCode)); } }); });
  r0.on('error', reject); if (data) r0.write(data); r0.end();
});

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TMP, 'db.json')); // 真实 prefs（含 u_admin 那份 11 项快照）
  const sk = path.join(__dirname, 'data', 'secret.key'); if (fs.existsSync(sk)) fs.copyFileSync(sk, path.join(TMP, 'secret.key'));
  const d0 = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8'));
  const adm = (d0.users || []).find((x) => x.role === 'admin' && x.enabled !== false);
  d0.sessions = d0.sessions || {}; d0.sessions[VT] = { userId: adm.id, dev: 'TEST-V151', lastSeen: Date.now() };
  // 确定性注入"历史态"偏好：11 项快照 + 完全不带 kpiH 键（v151 上线前线上就是这个形状）。
  // 线上 db.prefs 是活数据、会被保存偏好改变，直接拿副本当断言前提会让测试漂移，故显式造样本。
  d0.prefs = d0.prefs || {}; d0.prefs[adm.id] = Object.assign({}, d0.prefs[adm.id]);
  d0.prefs[adm.id].kpi = { v: admKpi, at: 1793965344880 };
  delete d0.prefs[adm.id].kpiH;
  fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(d0));

  const inst = spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let up = false;
    for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h0 = await rq('/api/health', ''); if (h0 && (h0.ok || h0.j)) { up = true; break } } catch (_) { } }
    T('E1 隔离服务器就绪（注入历史态偏好）', up, true);
    if (!up) throw new Error('服务未起');

    // E2 存量偏好（kpi=11项快照、无 kpiH）经真实下发 ⇒ 前端真代码显示 14 张 = 修复对老用户立即生效，无需清偏好
    const g0 = await rq('/api/prefs', VT);
    T('E2a 下发含历史快照 11 项', (g0.prefs.kpi || []).length, admKpi.length);
    T('E2b 尚未有 kpiH（老数据无该键）', g0.prefs.kpiH, undefined);
    T('E2c 管理员概览恢复 14 张（两张来料卡找回）', runNew(g0.prefs).length, 14);
    T('E2d 其中含一楼来料登记', runNew(g0.prefs).includes('一楼来料登记(标签)'), true);

    // E3 保存隐藏清单 ⇒ 落库 ⇒ 再下发 ⇒ 前端显示 12 张（✕ 移除语义仍有效，未被改坏）
    const HID2 = ['待入库(来料区)', '检验待处理'];
    const sp = await rq('/api/prefs', VT, { kpi: admKpi, kpiH: HID2 });
    T('E3a 保存成功', sp.ok, true);
    T('E3b 再下发带回 kpiH', sp.prefs.kpiH, HID2);
    T('E3c 显示降为 12 张', runNew(sp.prefs).length, 12);
    T('E3d 隐藏的两张确不显示', runNew(sp.prefs).filter((n) => HID2.includes(n)), []);

    // E4 清空隐藏（＋加入全部加回）⇒ 回到 14 张；空数组须被正确落库而非当成"未设置"
    const sp2 = await rq('/api/prefs', VT, { kpi: admKpi, kpiH: [] });
    T('E4a 空隐藏清单落库为数组（非 undefined）', JSON.stringify(sp2.prefs.kpiH), '[]');
    T('E4b 全部加回=14 张', runNew(sp2.prefs).length, 14);

    // E5 恶意/异常值不得污染（非数组必须被拒，与 kpi 同口径）
    await rq('/api/prefs', VT, { kpiH: '待入库(来料区)' });
    const g5 = await rq('/api/prefs', VT);
    T('E5 非数组 kpiH 被拒（沿用上次合法值不污染）', JSON.stringify(g5.prefs.kpiH), '[]');

    // E6 卡名限长清洗仍生效（30 项 / 14 字符），防偏好被撑爆
    const junk = Array.from({ length: 40 }, (_, i) => '卡名超长测试卡名超长测试卡名' + i);
    const g6 = await rq('/api/prefs', VT, { kpiH: junk });
    T('E6 隐藏清单截断到 30 项', (g6.prefs.kpiH || []).length, 30);
    T('E6b 未知卡名被前端忽略（不影响显示）', runNew({ kpi: admKpi, kpiH: g6.prefs.kpiH }).length, 14);
  } catch (e) {
    T('E0 端到端异常', String(e && e.message || e), '无异常');
  } finally {
    try { inst.kill('SIGKILL'); } catch (_) { }
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('\n===== v151 KPI 隐藏清单验证 ' + (total - fail) + '/' + total + ' 通过 =====');
    process.exit(fail ? 1 : 0);
  }
})();
