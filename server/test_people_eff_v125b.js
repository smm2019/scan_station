// ㉖v125b 人员效率页 + PDA地图首屏修复 · 实例证明
// 背景：①真机反馈地图首屏要"点复位才看清"（W/H=0 时 fitBase 出负缩放）且图例悬浮压车辆标签
//       ②AGV 有运力体检，人员侧无同等视角 → 分析报告第三子页「人员效率」
// 证明面：
//  A1 /api/report/people 鉴权（material 403 / warehouse 200）
//  A2 口径同 buildWork：人均 inB/outB/acc 与 /api/report/work 完全一致
//  A3 hours 数组=24 槽且总动作数与吞吐+接单自洽（入库框+出库单+接单 记小时）
//  A4 team 汇总：persons/totBox/conc 手算复核
//  A5 非法日期 400；空区间不报错
//  B1 前端锚点：三子页签、PPL 控件、pplGo/pplRender 关键元素（三榜+热力+集中度警示+口径脚注）
//  C1 地图修复锚点：lg 移出 cvbox、fitBase 先取 clientWidth、tip 淡出、top 左留白 76px
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_ppl_v125b'); const PORT = 8364; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_pp', username: 'pp_wh', name: 'PP仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Pp!125b', salt) });
db0.users.push({ id: 'u_ppm', username: 'pp_mt', name: 'PP领料', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Ppm!125', salt) });
// 注入可控夹具：近3天两笔入库（不同小时）+ 一笔领料接单；day1 对齐零点保证 getHours 精确
const _d1 = new Date(now - 2 * 864e5); _d1.setHours(0, 0, 0, 0);
const day1 = _d1.getTime();
db0.scanlog = db0.scanlog || {};
db0.scanlog['PPLB001|B1|1'] = { code: 'PPLB001', wt: 1, gl: 'NB03-A-01-01', batch: 'B1', t: day1 + 9 * 36e5, pn: '66PPL0001', q: 10, nm: 'PPL件', op: 'PPL张三', pid: 'PPLP001' };
db0.scanlog['PPLB002|B1|2'] = { code: 'PPLB002', wt: 1, gl: 'NB03-A-01-02', batch: 'B1', t: day1 + 14 * 36e5, pn: '66PPL0002', q: 5, nm: 'PPL件2', op: 'PPL张三(smm)', pid: 'PPLP002' };
db0.requisitions = db0.requisitions || [];
db0.requisitions.push({ id: 'rq_pplb1', no: 'LLPPLB1', by: 'u_pp', byName: 'PP仓管', status: 'accepted', createdAt: new Date(day1 + 8 * 36e5).toISOString(), acceptedAt: day1 + 8 * 36e5 + 5 * 6e4, acceptedBy: 'u_pp', items: [{ partNo: '66PPL0001', qty: 10 }], history: [{ text: '接单 通过', time: new Date(day1 + 8 * 36e5 + 5 * 6e4).toISOString(), by: 'PPL张三' }] });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v125b 人员效率+地图修复证明');
  const errLines = []; srv.stderr.on('data', (d) => { const s = String(d); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  try {
    const lg = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pp_wh', password: 'E2e#Pp!125b' }) })).json()).token;
    const mt = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pp_mt', password: 'E2e#Ppm!125' }) })).json()).token;
    // ===== A 端点 =====
    const f403 = await get('/api/report/people', mt);
    chk('A1 material 角色 403', [f403.status, f403.json.ok], [403, false]);
    const from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const j = (await get('/api/report/people?from=' + from, lg)).json;
    chkT('A1b warehouse 200 结构', j.ok === true && Array.isArray(j.list) && j.team !== undefined);
    const zs = (j.list || []).find((x) => x.name === 'PPL张三');
    chkT('A2 张三存在且账号后缀归并（两笔入库同人）', !!zs && zs.inB === 2);
    const wj = (await get('/api/report/work?from=' + from, lg)).json;
    const wz = (wj.persons || []).find((x) => x.name === 'PPL张三');
    chk('A2b 与 work 口径逐字段一致', zs && wz && [zs.inB, zs.outB, zs.acc, zs.fix, zs.ret], [wz.inB, wz.outB, wz.acc, wz.fix, wz.ret]);
    chkT('A3 hours=24槽且9点/14点各1次入库动作', zs && zs.hours.length === 24 && zs.hours[9] === 1 && zs.hours[14] === 1);
    chkT('A3b 接单动作记入8点小时', zs && zs.hours[8] >= 1);
    chkT('A3c 接单时效=5分钟', zs && zs.avgAccMin === 5);
    // ===== A6 系统管理员不计在岗（v125c：账号非作业人员）——独立第二实例，夹具含管理员+作业人员各1框 =====
    const PORT2 = 8365, BASE2 = 'http://127.0.0.1:' + PORT2;
    const TDIR2 = path.join(__dirname, 'data_e2e_ppl2_v125c');
    fs.rmSync(TDIR2, { recursive: true, force: true }); fs.mkdirSync(TDIR2, { recursive: true });
    const db2 = JSON.parse(fs.readFileSync(path.join(SRC, 'db.json'), 'utf8'));
    db2.users = db0.users;
    db2.scanlog = { 'PPLC001|B1|1': { code: 'PPLC001', wt: 1, gl: 'NB03-A-02-01', batch: 'B1', t: day1 + 10 * 36e5, pn: '66PPL0003', q: 8, nm: 'PPL件3', op: '系统管理员', pid: 'PPLCP001' },
      'PPLC002|B1|2': { code: 'PPLC002', wt: 1, gl: 'NB03-A-02-02', batch: 'B1', t: day1 + 11 * 36e5, pn: '66PPL0004', q: 6, nm: 'PPL件4', op: 'PPL李四', pid: 'PPLCP002' } };
    db2.outbound = {}; db2.requisitions = []; db2.ledgerFixes = [];
    fs.writeFileSync(path.join(TDIR2, 'db.json'), JSON.stringify(db2));
    fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR2, 'secret.key'));
    const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', DATA_DIR: TDIR2 }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { const r = await fetch(BASE2 + '/api/health'); up2 = r.ok; } catch (_) {} }
    chkT('A6a 第二实例就绪', up2);
    const lg2 = (await (await fetch(BASE2 + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pp_wh', password: 'E2e#Pp!125b' }) })).json()).token;
    const j2 = (await (await fetch(BASE2 + '/api/report/people?from=' + from, { headers: { Authorization: 'Bearer ' + lg2 } })).json());
    chkT('A6b 榜单无系统管理员', !(j2.list || []).some((x) => x.name === '系统管理员'));
    chk('A6c 在岗人数只计作业人员', [j2.team.persons, (j2.list || []).length], [1, 1]);
    chk('A6d 管理员框不计入团队总量（纯作业人员口径，总框=Σ榜内人）', j2.team.totBox, 1);
    chk('A6e 集中度按榜内人算（李四独占=100%）', j2.team.conc, 100);
    srv2.kill('SIGKILL'); fs.rmSync(TDIR2, { recursive: true, force: true });
    const totBox = (j.list || []).reduce((s, x) => s + x.inB + x.outB, 0);
    chk('A4 team.totBox=Σ个人框数', [j.team.totBox, totBox], [totBox, totBox]);
    const top = (j.list || [])[0];
    const conc = totBox ? Math.round((top.inB + top.outB) * 100 / totBox) : 0;
    chk('A4b conc=第一人占比', j.team.conc, conc);
    chkT('A4c persons 计数与 list 长度一致', j.team.persons === (j.list || []).length);
    const bad = await get('/api/report/people?from=2026-13-99', lg);
    chk('A5 非法日期 400', [bad.status, bad.json.ok], [400, false]);
    const far = await get('/api/report/people?from=2020-01-01&to=2020-01-02', lg);
    chkT('A5b 远古空区间不报错且 list 为空', far.json.ok === true && (far.json.list || []).length === 0);
    // ===== B/C 前端锚点 =====
    const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('B1 三子页签在位', h.includes("anaTab('snap')") && h.includes("anaTab('work')") && h.includes("anaTab('people')"));
    chkT('B2 PPL 控件与分流', h.includes('id="anapctl"') && h.includes("ANA.tab=='people'){pplGo()}") && h.includes('var PPL={from:\'\',to:\'\',days:14}'));
    chkT('B3 pplGo 调新端点', h.includes("api('/api/report/people'"));
    chkT('B4 三榜+集中度警示+热力在位', h.includes('吞吐榜（日均框）') && h.includes('接单时效榜') && h.includes('质量关注榜') && h.includes('负荷集中') && h.includes('24 小时动作节奏'));
    chkT('B5 口径脚注（观察性声明+未知归因）', h.includes('不作处罚依据') && h.includes('"未知"=流水未带操作人'));
    chkT('B6 自定义区间取消天数高亮', h.includes('PPL.days=0'));
    const g = fs.readFileSync(path.join(__dirname, 'public', 'agvmap.html'), 'utf8');
    chkT('C1 图例移出画布容器', /<\/div>\s*<div id="lg">/.test(g) && !g.includes('#lg{position:absolute'));
    chkT('C2 fitBase 首屏自取尺寸', g.includes('_cv.clientWidth'));
    chkT('C3 提示条自动淡出', g.includes("t.style.opacity='0'"));
    chkT('C4 顶栏让位原生返回浮层', g.includes('padding:6px 10px 6px 76px'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
  chkT('F 服务日志无未捕获异常', uncaught.length === 0);
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v125b 人员效率+地图修复实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
