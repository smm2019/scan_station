// ㉖v130 标签全链路·两楼流转识别 · 实例证明
// 用户洞察：来料区扫码(NB04 wt=2)是"一楼登记→二楼转入→出库"两楼流转的第一步，但全链路把它和普通采集混显"📥 采集入库"，第一步隐形
// 判据（代码实证 server.js:3514 分配例外注释"现位NB04=二楼转入场景，继续分配NB02空位"→转入走采集再扫；真实框 N26K070084 流水形态吻合）：
//   ① wt=2 未作废 = 一楼来料登记(kind=recv)
//   ② 同框存在更早 wt=2 时刻、其后 wt=0/1 未作废采集 = 二楼转入(kind=tin)
//   ③ 无来料历史的采集 = 普通采集入库(kind=scan，行为不变)
//   ④ 撤销流水(cx)仍 scanx、来料之前的采集不误判转入
// 手法：真实起服务 + 夹具 scanlog，查 /api/trace 断言 events 的 kind/title
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_v130'); const PORT = 8373; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hp = (pw) => crypto.scryptSync(pw, salt, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v0', username: 'v0_wh', name: 'V130仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hp('E2e#V0!130') });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
const T1 = now - 6 * 36e5, T2 = now - 3 * 36e5, T0 = now - 9 * 36e5;
const sl = (code, batch, t, o) => { db0.scanlog[code + '|' + batch + '|' + t] = Object.assign({ code, wt: 0, st: '', gl: '', batch, cx: false, t, pn: 'PNV130', q: 50, op: 'V130仓管', nm: '流转件', mk: '', lot: '', mc: '', pid: '', cxAt: 0 }, o); };
// 框1：来料登记→二楼转入（完整两步）
sl('V130A00001', 'B1', T1, { wt: 2, gl: 'NB04-A-01-001' });
sl('V130A00001', 'B1', T2, { wt: 0, st: 'NB02-CK-07', gl: 'NB02-A-01-1F' });
// 框2：普通地面采集（无来料历史）
sl('V130B00002', 'B1', T2, { wt: 1, gl: 'NB03-B-01-05' });
// 框3：来料登记但被撤销（cx）→ 不算来料、该条 scanx
sl('V130C00003', 'B1', T1, { wt: 2, gl: 'NB04-A-01-002', cx: true });
// 框4：来料之前先有一条采集（边界：早于 wt=2 的采集不得误判转入）
sl('V130D00004', 'B1', T0, { wt: 0, st: 'NB02-CK-09', gl: 'NB02-A-09-1F' }); // 最早，无来料
sl('V130D00004', 'B1', T1, { wt: 2, gl: 'NB04-A-01-004' }); // 来料
sl('V130D00004', 'B1', T2, { wt: 0, st: 'NB02-CK-05', gl: 'NB02-A-05-1F' }); // 转入
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v130 两楼流转识别证明');
  const errLines = []; srv.stderr.on('data', (x) => { const s = String(x); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  const trace = async (q) => { const j = await (await fetch(BASE + '/api/trace?q=' + encodeURIComponent(q), { headers: { Authorization: 'Bearer ' + wh } })).json(); return (j.events || []); };
  let wh = '';
  try {
    wh = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v0_wh', password: 'E2e#V0!130' }) })).json()).token;
    // ===== 框1 完整两步 =====
    const e1 = await trace('V130A00001');
    const recv1 = e1.find((e) => e.kind === 'recv'), tin1 = e1.find((e) => e.kind === 'tin');
    chkT('A1 识别出"🏭 来料登记（一楼·来料区）"', !!recv1 && recv1.title.includes('来料登记') && recv1.detail.includes('NB04-A-01-001'));
    chkT('A2 识别出"⬆ 二楼转入（来料区→货架）"', !!tin1 && tin1.title.includes('二楼转入'));
    chkT('A3 来料时刻 < 转入时刻（时序正确）', recv1 && tin1 && recv1.t < tin1.t);
    chkT('A4 无普通"采集入库"混入（两步各自归类）', !e1.some((e) => e.kind === 'scan' && e.title.includes('采集入库')));
    // ===== 框2 普通采集不受影响 =====
    const e2 = await trace('V130B00002');
    chkT('B1 无来料历史的地面采集仍"📥 采集入库"(kind=scan)', e2.some((e) => e.kind === 'scan' && e.title.includes('采集入库')) && !e2.some((e) => e.kind === 'recv' || e.kind === 'tin'));
    // ===== 框3 撤销来料不误判 =====
    const e3 = await trace('V130C00003');
    chkT('C1 撤销的 wt=2 不识别为来料登记（无 recv）', !e3.some((e) => e.kind === 'recv'));
    chkT('C2 撤销条显示 scanx/已撤销', e3.some((e) => e.kind === 'scanx' || e.title.includes('已撤销')));
    // ===== 框4 边界：来料之前的采集不误判转入 =====
    const e4 = (await trace('V130D00004')).filter((e) => ['scan', 'recv', 'tin'].includes(e.kind)).sort((a, b) => a.t - b.t);
    chk('D1 三事件时序 kind 正确（scan→recv→tin）', e4.map((e) => e.kind), ['scan', 'recv', 'tin']);
    chkT('D2 最早那条（先于来料）判为普通采集非转入', e4[0] && e4[0].kind === 'scan');
    // ===== 真实生产框回归（N26K070084：来料→转入→已出库）=====
    const eR = await trace('N26K070084');
    chkT('E1 真实框识别出来料登记+二楼转入', eR.some((e) => e.kind === 'recv') && eR.some((e) => e.kind === 'tin'));
    // ===== 源码锚点：三端注册 =====
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('F1 服务器 recv/tin 分类在位', src.includes("'recv'") && src.includes("'tin'") && src.includes('来料登记（一楼·来料区）') && src.includes('二楼转入（来料区→货架）'));
    const con = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('F2 网页色表注册 recv/tin', con.includes("recv: 't-r', tin: 't-a'"));
    const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_stock_page.dart'), 'utf8');
    chkT('F3 PDA 图标表注册', dart.includes('"recv": Icons.warehouse_outlined') && dart.includes('"tin": Icons.arrow_upward'));
    chkT('F4 PDA 关键节点判定含两环节', dart.includes('title.contains("来料登记")') && dart.includes('title.contains("二楼转入")'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror|syntaxerror/i.test(s));
  chkT('G 服务日志无未捕获异常', uncaught.length === 0);
  if (uncaught.length) console.log(uncaught.join('\n'));
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v130 两楼流转识别实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
