// ㉖v125 报表整合三出口 · 实例证明
// 整合：①顶层工作量→分析报告子页 ②指挥舱运力体检+效率报表→合一页 ③复盘瘦身(删重复业务KPI+跳转)
// 口径修复：capacity 窗口 滚动N*864e5 → 自然日(与 report 同口径)；上限 90→30(底仓只留30天,90天档名存实亡)
// 证明面：
//  A1 capacity days=1 只计今日任务（昨日23:50任务旧滚动窗会误计，新自然日窗排除）
//  A2 capacity days=7 含昨日、不含31天前（30天上限生效）
//  A3 capacity days=90 钳到30，与 days=30 结果一致
//  A4 report days=1 与 capacity days=1 同窗同数（口径统一铁证）
//  B1 前端锚点：TABS 无 rpt、go('rpt') 别名转发、ANA.tab 双子页、pgRpt 纯转发
//  B2 效率合一：loadEff/srEff 在位，_capD/_repD/loadCap 死代码清零，AGVKEY cap/rep→eff
//  B3 复盘瘦身：重复业务 KPI（领料拒取消/呆滞）不在复盘卡，跳转按钮在位，rejC 死变量已删
//  B4 概览KPI今日AGV搬运 go('rpt') 跳转串保留（别名兜底可达）
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_v125'); const PORT = 8363; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v5', username: 'v125_wh', name: 'V125仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V125!a', salt) });
db0.users.push({ id: 'u_v5a', username: 'v125_ad', name: 'V125管理', role: 'admin', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V125b!a', salt) });
// 清掉真实任务底仓避免干扰计数，注入三笔可控任务
const D = new Date(); D.setHours(0, 0, 0, 0); const t0 = D.getTime();
db0.agvTasks = {
  T_TODAY: { car: 7, ex: t0 + 10 * 36e5, fin: t0 + 10.5 * 36e5, dur: 1800, sp: 'NB02-A-01', ep: 'NB03-A-01-01', ck: 'out' },
  T_YEVE: { car: 7, ex: t0 - 60e3, fin: t0 - 10e3, dur: 50, sp: 'NB02-A-02', ep: 'NB03-A-02-01', ck: 'in' }, // 昨日23:59:50 —— 旧滚动窗 days=1 会误计
  T_OLD: { car: 8, ex: t0 - 31 * 864e5, fin: t0 - 31 * 864e5 + 5e3, dur: 5, sp: 'NB02-A-03', ep: 'NB03-A-03-01', ck: 'out' }, // 31天前——超出30天上限
};
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 160)} want=${String(JSON.stringify(w)).slice(0, 160)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v125 报表整合证明');
  const errLines = []; srv.stderr.on('data', (d) => { const s = String(d); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  try {
    const wh = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v125_wh', password: 'E2e#V125!a' }) })).json()).token;
    // ===== A 窗口口径 =====
    const c1 = (await get('/api/agv/capacity?days=1', wh)).json;
    chk('A1 今日窗只计 T_TODAY', [c1.ok, c1.total, c1.days], [true, 1, 1]);
    chkT('A1b 均耗时=1800s（昨日50s任务未混入）', c1.avgDur === 1800);
    const c7 = (await get('/api/agv/capacity?days=7', wh)).json;
    chk('A2 近7天窗含昨日不含31天前', [c7.total, c7.days], [2, 7]);
    const c90 = (await get('/api/agv/capacity?days=90', wh)).json;
    const c30 = (await get('/api/agv/capacity?days=30', wh)).json;
    chk('A3 days=90 钳到30且与30天窗同数', [c90.days, c90.total, c30.days, c30.total], [30, 2, 30, 2]);
    const r1 = (await get('/api/agv/report?days=1', wh)).json;
    chk('A4 report 与 capacity 同窗同数（口径统一）', [r1.totalN, c1.total], [1, 1]);
    // ===== B 前端锚点（console.html 为运行时直读静态文件） =====
    const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('B1a 顶层页签无独立工作量', !/\['rpt','📈 工作量'\]/.test(h) && h.includes("㉖v125 顶层「工作量」并入分析报告子页"));
    chkT('B1b go 别名转发 rpt→ana+work', h.includes("if(_base=='rpt'){ANA.tab='work';_tgt='ana'}") && h.includes('function pgRpt(){ANA.tab=\'work\';pgAna()}'));
    chkT('B1c 双子页签在位', h.includes("anaTab('snap')") && h.includes("anaTab('work')") && h.includes("ANA={g:'day',end:'',tab:'snap'}"));
    chkT('B1d rptGo 容器参数化', h.includes('async function rptGo(_sel)') && h.includes("const _bd=_sel||'#rbody'"));
    chkT('B2a 效率合一页与静默刷新', h.includes('async function loadEff(silent') && h.includes('srEff=srMake(()=>loadEff(1))') && h.includes("leaf=='eff'"));
    chkT('B2b 死代码清零', !h.includes('_capD') && !h.includes('_repD') && !h.includes('async function loadCap') && !h.includes('async function loadRep'));
    chkT('B2c 旧深链键归一到合一页', h.includes("cap:['eff','eff'],rep:['eff','eff']") && h.includes("eff:['eff','eff']"));
    chkT('B2d 独有元素保留', h.includes('峰值并发') && h.includes('搬运热力') && h.includes('车号缺失') && h.includes('慢车预警') && h.includes('24 小时任务分布'));
    chkT('B3a 复盘删重复业务KPI', !h.includes("kpi(rejC,'领料拒/取消'") && !h.includes("kpi(S.stale7!=null?S.stale7:'-','呆滞7天+框'"));
    chkT('B3b 复盘保留调度与服务健康KPI', h.includes("kpi(tot(P),'问题事件总数'") && h.includes("kpi(P.watchdog+P.sysErr,'看门狗/系统错误'") && h.includes("kpi(P.slowApi==null?'未采集':P.slowApi,'慢接口天数'"));
    chkT('B3c 跳转完整分析报告按钮（周期带入+强制快照子页）', h.includes("ANA.end=RV.end;ANA.g=RV.g;ANA.tab='snap';go('ana')"));
    chkT('B3d rejC 死变量已删', !h.includes('const rejC='));
    chkT('B4 概览KPI跳转串走别名', h.includes("go('rpt')"));
    // 复盘简报文本仍含业务线（④⑤行）——删的是卡不是简报，数据完整性保留
    chkT('B5 复盘简报业务行未被误删', h.includes('④ 领料拒/取消') && h.includes('⑤ 呆滞7天+'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
  chkT('F 服务日志无未捕获异常', uncaught.length === 0);
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v125 报表整合实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
