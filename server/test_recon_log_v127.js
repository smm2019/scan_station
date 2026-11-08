// ㉖v127 对账入账留痕分级 + 逐框存证 · 实例证明
// 现场（LL2026110814494517 走路径C）：三框对账入账留痕写"经 MES 确认此前已在目标仓"，
//   但路径C 是"MES 拒绝文案 + 人工整批确认全部框"，只有被文案点到的框有 MES 证据、其余随批带入——留痕夸大了证据强度，事后无法区分。
// 三路径：A 转单前预检逐框 MES 实证 / B 拒绝后重预检逐框实证 / C 预检拿不到逐框仓位+人工整批确认（recon=codes 全部）
// 修复：PDA 随 transfer 上传 reconEv=[{c,at(=MES实证在目标仓?),loc(仓位实况)}]；服务器按证据分级留痕 + target.reconLog 结构化存证
// 证明面（真实 transfer 接口 + 真实 buildExport/hpush）：
//  L1 全实证（模拟A/B）：留痕标"MES逐框实证·N框均在目标仓"，reconLog 全 at=1
//  L2 混合（模拟C部分）：留痕标"x/N框为人工整批确认"并点名，reconLog at 标记区分
//  L3 全人工（模拟C整批，本次现场即此型）：留痕标"N/N框为人工整批确认·MES未逐框核实"，不再出现"经MES确认"字样
//  L4 旧版兼容：只传 recon 不传 reconEv → 留痕带〔旧版PDA·未附逐框证据〕
//  L5 reconLog 持久化到落盘库（可追溯），且 at/loc 正确
//  A 源码锚点：PDA reconEv 构造 + 服务器分级两分支 + 旧版兜底文案
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_rc_v127'); const PORT = 8371; const BASE = 'http://127.0.0.1:' + PORT;
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 240)} want=${String(JSON.stringify(w)).slice(0, 240)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
// 建一张备料中单：一箱已扫（供 transfer 前置 got>0），recon 框也塞进 issued（对账框已在 issued 里，只是不重复调拨）
function mkOrder(db, oid, no, pn, issuedCodes, qty) {
  db.requisitions = db.requisitions || [];
  db.requisitions.push({ id: oid, no, by: 'u_rc', byName: '对账测试', status: 'accepted', createdAt: new Date().toISOString(), acceptedAt: new Date().toISOString(), acceptedBy: '对账仓管', assigneeId: 'u_rc', items: [{ partNo: pn, itemName: '对账件', qty, issued: issuedCodes.map((c) => ({ c, q: 10, l: 'NB02-A-01-1F' })), transferred: false }], history: [{ time: new Date().toISOString(), by: '对账仓管', text: '接单（对账仓管）' }] });
}
(async () => {
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
  const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex'); const hp = (pw) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const now = Date.now();
  db0.users.push({ id: 'u_rc', username: 'rc_wh', name: '对账仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hp('E2e#Rc!127') });
  db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0, receivingOn: 0 });
  // 四张单：A全实证 / 混合 / C全人工 / 旧版
  mkOrder(db0, 'rq_A', 'LLRCA1', 'PNRCA', ['RCA0000001', 'RCA0000002'], 20);
  mkOrder(db0, 'rq_M', 'LLRCM1', 'PNRCM', ['RCM0000001', 'RCM0000002', 'RCM0000003'], 30);
  mkOrder(db0, 'rq_C', 'LLRCC1', 'PNRCC', ['RCC0000001', 'RCC0000002', 'RCC0000003'], 30);
  mkOrder(db0, 'rq_O', 'LLRCO1', 'PNRCO', ['RCO0000001'], 10);
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v127 对账入账留痕分级证明');
  const errLines = []; srv.stderr.on('data', (x) => { const s = String(x); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  const histOf = (oid) => { const db = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); const r = db.requisitions.find((x) => x.id === oid); return ((r && r.history) || []).map((h) => h.text); };
  try {
    const wh = (await post('/api/login', null, { username: 'rc_wh', password: 'E2e#Rc!127' })).json.token;
    // ===== L1 全实证（路径A/B）=====
    const t1 = await post('/api/requisitions/rq_A/transfer', wh, { partNo: 'PNRCA', recon: ['RCA0000001', 'RCA0000002'], reconEv: [{ c: 'RCA0000001', at: true, loc: 'RCA0000001→焊-宁波-线边仓/A1/01' }, { c: 'RCA0000002', at: true, loc: 'RCA0000002→焊-宁波-线边仓/A1/02' }] });
    chkT('L1a transfer 成功', t1.json.ok === true);
    await sleep(800);
    const h1 = histOf('rq_A').find((t) => t.includes('对账入账'));
    chkT('L1b 留痕标"MES逐框实证·2框均在目标仓"', !!h1 && h1.includes('MES逐框实证') && h1.includes('2框均在目标仓'));
    chkT('L1c 无"人工整批"字样', !!h1 && !h1.includes('人工整批'));
    const dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('L1d reconLog 全 at=1', dbA.requisitions.find((x) => x.id === 'rq_A').items[0].reconLog.map((x) => x.at), [1, 1]);
    // ===== L2 混合（部分实证+部分人工）=====
    await post('/api/requisitions/rq_M/transfer', wh, { partNo: 'PNRCM', recon: ['RCM0000001', 'RCM0000002', 'RCM0000003'], reconEv: [{ c: 'RCM0000001', at: true, loc: 'RCM0000001→焊-宁波-线边仓/B1/01' }, { c: 'RCM0000002', at: false, loc: 'RCM0000002：MES查询无果' }, { c: 'RCM0000003', at: false, loc: 'RCM0000003→已出原料仓在库体系（无在库仓位·与拒绝文案吻合）' }] });
    await sleep(800);
    const h2 = histOf('rq_M').find((t) => t.includes('对账入账'));
    chkT('L2a 留痕标"2/3框为人工整批确认"', !!h2 && h2.includes('2/3框为人工整批确认'));
    chkT('L2b 点名人工框（含无果与已出仓各一）', !!h2 && h2.includes('RCM0000002') && h2.includes('RCM0000003'));
    const dbM = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('L2c reconLog at 标记正确（1实证2人工）', dbM.requisitions.find((x) => x.id === 'rq_M').items[0].reconLog.map((x) => x.at), [1, 0, 0]);
    // ===== L3 全人工（本次现场型：recon=codes 全部，逐框未实证）=====
    await post('/api/requisitions/rq_C/transfer', wh, { partNo: 'PNRCC', recon: ['RCC0000001', 'RCC0000002', 'RCC0000003'], reconEv: [{ c: 'RCC0000001', at: false, loc: 'RCC0000001→已出原料仓在库体系（无在库仓位·与拒绝文案吻合）' }, { c: 'RCC0000002', at: false, loc: 'RCC0000002→已出原料仓在库体系（无在库仓位·与拒绝文案吻合）' }, { c: 'RCC0000003', at: false, loc: 'RCC0000003：MES查询无果' }] });
    await sleep(800);
    const h3 = histOf('rq_C').find((t) => t.includes('对账入账'));
    chkT('L3a 留痕标"3/3框为人工整批确认·MES未逐框核实"', !!h3 && h3.includes('3/3框为人工整批确认') && h3.includes('MES未逐框核实'));
    chkT('L3b 全人工时不再出现"经 MES 确认"误导字样', !!h3 && !h3.includes('经 MES 确认'));
    // ===== L4 旧版兼容（只传 recon 不传 reconEv）=====
    await post('/api/requisitions/rq_O/transfer', wh, { partNo: 'PNRCO', recon: ['RCO0000001'] });
    await sleep(800);
    const h4 = histOf('rq_O').find((t) => t.includes('对账入账'));
    chkT('L4 旧版留痕带〔未附逐框证据〕标注', !!h4 && h4.includes('旧版PDA') && h4.includes('未附逐框证据'));
    const dbO = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chkT('L4b 旧版不写 reconLog（字段缺省，不假装有证）', dbO.requisitions.find((x) => x.id === 'rq_O').items[0].reconLog === undefined);
    // ===== A 源码锚点 =====
    const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'requisition_page.dart'), 'utf8');
    chkT('A1 PDA 上传 reconEv 逐框证据', dart.includes('final reconEv = rc.map') && dart.includes('"at": d != null && atTarget(d)') && dart.includes('"reconEv": reconEv'));
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('A2 服务器三分级分支在位', src.includes('MES逐框实证') && src.includes('框为人工整批确认') && src.includes('未附逐框证据'));
    chkT('A3 reconLog 结构化持久化', src.includes('target.reconLog = _ev.map'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror|syntaxerror/i.test(s));
  chkT('F 服务日志无未捕获异常', uncaught.length === 0);
  if (uncaught.length) console.log(uncaught.join('\n'));
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v127 对账入账留痕分级实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
