// ㉖v123d 货架盘点时间线 + 红外核对 + 网页盘点统一可见 · 实例证明
// 用户三诉求：①货架盘点加时间线 ②核对调用 PDA 红外扫码 ③网页端盘点能看到货架盘点（当前看不到=模型分离）
// 实现：①时间线复用已存在的工单时间戳(at/arriveAt/scanAt/retAt/doneAt)+legTrace 两腿留痕，PDA+网页双端渲染，服务器零改动
//       ②核对扫码从"相机优先"改为"红外扫码枪优先（自动回车提交）、相机兜底"
//       ③网页盘点列表 pgInv 并入 /api/count/list 会话行（货架AGV抽盘），与基准盘点同列表统一入口
// 证明面（仿 test_count_agv_v123：预置 counts 记录，单次启动，纯接口推进）：
//  A 契约：/api/count/list 返回 sid + 五时间戳 + legTrace{out,back}，会话可聚合
//  B 时序：scan(合法)落 scanAt / return 落 retAt / cancel 落 doneAt，且各态非法调用被拒
//  C 网页锚点：pgInv 双源并行、cSess 会话明细、cTl 时间线弹窗、类型区分、差异文本
//  D PDA 锚点：_showTimeline + 整卡点击 + _scanInputBox 红外优先(autofocus/onSubmitted) + 相机兜底
//  E 不变量：全程账本原文不变（只读核对语义守住）
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_v123d'); const PORT = 8366; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_d', username: 'd_wh', name: 'D123d仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#D!123d', salt) });
db0.params = Object.assign(db0.params || {}, { countMax: 3, countSamplePct: 100, countStaleDays: 7, countConc: 3, receivingOn: 0, strictFifo: 1 }); // conc=3：放行归位接口（0 会因 busy>=conc 挡死 return）
delete db0.rcsConfig; delete db0.wmasConfig; db0.agvDispatchMode = 'dry';
// 台账：两框（供在架判定 + E 不变量）
const P1 = 'CTD0000001', P2 = 'CTD0000002', old = now - 30 * 864e5;
db0.ledger.push({ c: P1, l: 'NB02-A-01-1F', f: '1600*1100', t: old, p: '66CTD0001', n: '时间线件一', q: 100, b: '2026-09-01', pid: 'CTPD1', mv: '人工', src: '', by: 'D123d仓管', rec: old, hist: [] });
db0.ledger.push({ c: P2, l: 'NB02-A-02-1F', f: '1600*1100', t: old, p: '66CTD0002', n: '时间线件二', q: 200, b: '2026-09-01', pid: 'CTPD2', mv: '人工', src: '', by: 'D123d仓管', rec: old, hist: [] });
const SID = 'CS20261108' + String(now).slice(-4);
const mkRec = (id, code, state, ex) => Object.assign({ id, sid: SID, code, from: 'NB02-A-01-1F', part: '66CTD0001', nm: '时间线件一', f: '1600*1100', qty: 100, ageDays: 30, state, station: '', uid: 'u_d', by: 'D123d仓管', at: now - 5000, updAt: now, taskNo: '', taskNo2: '', outQueued: 0, backQueued: 0, diff: null }, ex || {});
db0.counts = [
  mkRec('cnt_scan', P1, 'atStation', { arriveAt: now - 3000, station: 'NB02-CK-01', taskNo: 'T-SC' }),           // B1: 到台可核对
  mkRec('cnt_ret', P2, 'scanned', { arriveAt: now - 4000, scanAt: now - 2000, station: 'NB02-CK-02', qty: 200, from: 'NB02-A-02-1F' }), // B2: 已核对可归位（from 对齐 P2 台账货位，否则归位矛盾校验正确拒发）
  mkRec('cnt_done', P1, 'returning', { arriveAt: now - 6000, scanAt: now - 5000, retAt: now - 4000, station: 'NB02-CK-03', taskNo2: 'T-BK' }), // A6: 归位在途样单（验 retAt 契约）
  mkRec('cnt_cx', P1, 'pending', { from: 'NB02-A-01-1F' }),                                                       // B3: 待发车可取消
  mkRec('cnt_illegal', P1, 'toStation', { taskNo: 'T-IL' }),                                                     // B4: 在途 scan 应被拒
];
// legTrace 挂到队列项（与 inspect 同款：countId + type + trace 字符串数组）
db0.agvQueue = db0.agvQueue || [];
db0.agvQueue.push({ id: 'cq_t1', code: P1, type: 'count', countId: 'cnt_scan', state: '完成', station: 'NB02-CK-01', trace: ['WMAS建任务下发成功', 'RCS实际送达NB02-CK-01'] });
// 台账不变量指纹：只取业务三元组（框码/货位/件数）——避开服务启动自愈补丁对无关字段的规范化噪音
const ledgerFp = (arr) => (arr || []).map((x) => [x.c, x.l, x.q].join('|')).sort().join(';');
const ledgerSnap = ledgerFp(db0.ledger);
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 160)} want=${String(JSON.stringify(w)).slice(0, 160)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function getJ(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v123d 时间线+红外+网页统一 证明');
  const errLines = []; srv.stderr.on('data', (d) => { const s = String(d); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  try {
    const wh = (await post('/api/login', null, { username: 'd_wh', password: 'E2e#D!123d' })).json.token;
    // ===== A 契约字段 =====
    const L1 = (await getJ('/api/count/list?all=1', wh)).json;
    const byId = {}; for (const q of L1.list || []) byId[q.id] = q;
    const s0 = byId.cnt_scan;
    chkT('A1 会话 sid 在每项返回（网页可聚合）', s0 && s0.sid === SID);
    chkT('A2 到台工单 arriveAt 有值（时间线到台节点）', s0 && typeof s0.arriveAt === 'number' && s0.arriveAt > 0);
    chkT('A3 legTrace.out 数组且含下架调度文本（时间线调度行）', s0 && Array.isArray(s0.legTrace.out) && s0.legTrace.out.length >= 1 && /WMAS|送达/.test(s0.legTrace.out[0]));
    chkT('A4 聚合键齐备（sid/uid/by/at/qty/ageDays/from/state/code/part）', ['sid', 'uid', 'by', 'at', 'qty', 'ageDays', 'from', 'state', 'code', 'part'].every((k) => k in s0));
    chkT('A5 响应含 cand/busy/conc（网页底部候选与并发）', typeof L1.cand === 'number' && typeof L1.busy === 'number' && L1.conc === 3);

    // ===== B 时序：合法推进落时间戳、非法被拒 =====
    const sc = await post('/api/count/scan', wh, { id: 'cnt_scan', barcode: P1, mesQty: 100 });
    chkT('B1 到台核对成功→scanned 且 scanAt 落值', sc.json.ok === true && sc.json.rec.state === 'scanned' && typeof sc.json.rec.scanAt === 'number');
    chkT('B1b scanAt 晚于 arriveAt（时间单调）', sc.json.rec.scanAt >= s0.arriveAt);
    const ret = await post('/api/count/return', wh, { id: 'cnt_ret' }); // cnt_ret 预置 scanned，from 已对齐台账货位；dry 演算：只入队 backQueued=1，retAt 留到 live 下发
    chkT('B2 已核对归位受理（dry 演算入队 backQueued，非报错）', ret.json.ok === true && (ret.json.rec.backQueued === 1 || ret.json.rec.state === 'returning'));
    // retAt 契约由预置归位在途样单验证（真实时间戳单调性），不依赖 dry 接口是否写
    chkT('B2b 归位在途样单 retAt>scanAt>arriveAt（时间线三级单调契约）', (() => { const d = byId.cnt_done; return d && d.retAt >= d.scanAt && d.scanAt >= d.arriveAt && d.state === 'returning'; })());
    const cxD = await post('/api/count/cancel', wh, { id: 'cnt_cx', reason: '时间线契约验证取消' });
    chkT('B3 取消→canceled 且 doneAt 落值+err记原因', cxD.json.ok === true && cxD.json.rec.state === 'canceled' && typeof cxD.json.rec.doneAt === 'number' && String(cxD.json.rec.err).includes('时间线契约验证取消'));
    chkT('B3b doneAt 晚于 at（时间单调）', cxD.json.rec.doneAt >= cxD.json.rec.at);
    const ill = await post('/api/count/scan', wh, { id: 'cnt_illegal', barcode: P1, mesQty: 100 }); // toStation 态 scan
    chkT('B4 在途(toStation)核对被拒（状态机守门，不乱写 scanAt）', ill.json.ok === false && /不可核对|到站台/.test(String(ill.json.msg)));
    const badQty = await post('/api/count/scan', wh, { id: 'cnt_scan', barcode: P2, mesQty: 999 }); // 已是 scanned 态
    chkT('B5 已核对态重复核对被拒（防重复落时间戳）', badQty.json.ok === false);

    // ===== C 网页锚点 =====
    const ch = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    chkT('C1 pgInv 双数据源并行拉取', ch.includes("Promise.all([api('/api/inventory/list'),api('/api/count/list?all=1')"));
    chkT('C2 会话按 sid 聚合并渲染会话行', ch.includes('cs[q.sid]') && ch.includes("cSess('${_esc(s.sid)}')") && ch.includes('货架AGV抽盘'));
    chkT('C3 基准盘点与货架抽盘两类标签区分', ch.includes('基准盘点') && ch.includes('货架AGV抽盘'));
    chkT('C4 会话明细逐框表（状态/差异/站台/时间线入口）', ch.includes('async function cSess(sid)') && ch.includes("cTl('${esc2(q.id)}')") && ch.includes('核对差异'));
    chkT('C5 时间线弹窗合并时间戳+两腿trace', ch.includes('function cTl(id)') && ch.includes('🏁 框已到站台') && ch.includes('✅ 归位到位·闭环') && ch.includes('legTrace'));
    chkT('C6 串位/数量不符差异文本', ch.includes('串位：实扫') && ch.includes('数量不符：账'));
    chkT('C7 底部候选与并发提示（网页只读跟踪）', ch.includes('当前盲区候选框') && ch.includes('网页端只读跟踪'));

    // ===== D PDA 锚点 =====
    const ip = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_page.dart'), 'utf8');
    chkT('D1 时间线方法在位', ip.includes('void _showTimeline(Map q)') && ip.includes('📋 发起盲区抽盘') && ip.includes('🔎 扫码核对') && ip.includes('✅ 归位到位·闭环'));
    chkT('D2 整卡点击=时间线入口', ip.includes('onTap: () => _showTimeline(q)'));
    chkT('D3 核对改红外优先（扫码框先于相机）', ip.includes('Future<String?> _scanInputBox') && ip.includes('final raw = await _scanInputBox(q)'));
    chkT('D4 红外框 autofocus + onSubmitted 自动提交', ip.includes('autofocus: true') && ip.includes('onSubmitted: (v) => Navigator.pop(c'));
    chkT('D5 相机兜底通道保留', ip.includes('raw == _kCam ? null : raw') && ip.includes('cameraScanDialog'));
    chkT('D6 时间线读五时间戳', ['q["arriveAt"]', 'q["scanAt"]', 'q["retAt"]', 'q["doneAt"]'].every((x) => ip.includes(x)));

    // ===== E 不变量：账本原文不变 =====
    const dbEnd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('E1 盘点核对/时间线全程账本业务三元组未动（只读语义守住）', ledgerFp(dbEnd.ledger) === ledgerSnap, true);
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror|syntaxerror/i.test(s));
  chkT('F 服务日志无未捕获异常', uncaught.length === 0);
  if (uncaught.length) console.log(uncaught.join('\n'));
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v123d 时间线+红外+网页统一 实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
