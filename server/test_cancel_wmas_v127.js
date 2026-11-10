// ㉖v127 盘点取消撤 AGV 任务联动 · 实例证明
// 现场事故（11/8 14:32 N26J3300127）：PDA 盘点页取消工单，本系统工单 canceled、冻结解除，
//   但旧代码只改队列项状态、从不向 WMAS 撤单 → 车照跑，40 分钟未到判"盘点下架超时"，
//   用户只能去 AGV 系统手工取消。检验通道（inspect/cancel）本就有撤单，盘点漏了这段。
// 修复：count/cancel 取消前——①仅"已下发未叉取"腿（下发中/已下发且有 wmsTask）先撤 WMAS；
//   ②撤失败→拒绝取消（防框送到站台无人认领）；③WMAS 说"不存在"→视同已撤放行；
//   ④撤成功/本就未下发→retireQueueItem 统一回收（清叫车占位+站台预占+解冻）；
//   ⑤到台/完成态不撤（搬运已发生），留痕提示人工处理框。
// 证明面（假 WMAS 服务按任务号前缀路由：T-OK 成功 / T-FAIL 拒绝 / T-NX 报"任务不存在"）：
//  S1 已下发未叉取→撤单成功→工单 canceled+队列项回收+冻结解除（盲区候选回升）
//  S2 撤单被拒→400 且工单/队列项原样（cand 不回升）——关键保护
//  S3 WMAS 报任务不存在→视同已撤放行取消
//  S4 排队未下发（无 wmsTask）→不碰 WMAS 直接取消（dry/未派车路径行为不变）
//  S5 到台态→不撤单、取消成功、到站队列项不误标
//  S6 归位在途→撤的是 countback 腿任务号
//  S7 终态幂等：canceled 再取消 400
//  S8 已下发但 WMAS 未配置→400 引导先去 AGV 系统撤（第二实例）
//  A 源码锚点；F 日志无异常
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto'); const http = require('http');
const SRC = path.join(__dirname, 'data'); const PORT = 8368; const BASE = 'http://127.0.0.1:' + PORT;
const WPORT = 8369; const PORT2 = 8370; const BASE2 = 'http://127.0.0.1:' + PORT2;
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(url, tk, body) { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function getJ(url, tk) { const r = await fetch(url, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
// ===== 假 WMAS：记录每次 cancelTask 的入参，按任务号前缀路由 =====
const cancelHits = [];
const fakeWmas = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/auth/login') { res.end(JSON.stringify({ success: true, data: { token: 'FAKE-TK' } })); return; }
    if (req.url === '/api/logistics/agv-task/cancelTask') {
      const list = (() => { try { return JSON.parse(d); } catch (_) { return []; } })();
      cancelHits.push(list[0] || '');
      const tn = String(list[0] || '');
      if (tn.startsWith('T-FAIL')) { res.end(JSON.stringify({ success: false, message: 'AGV已叉取货物，任务不可取消' })); return; }
      if (tn.startsWith('T-NX')) { res.end(JSON.stringify({ success: false, message: '任务不存在' })); return; }
      res.end(JSON.stringify({ success: true })); return;
    }
    res.end(JSON.stringify({ success: true, data: {} }));
  });
});
// ===== 夹具 =====
function mkDb(dir, withWmas) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'db.json'), path.join(dir, 'db.json'));
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(dir, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex'); const hp = (pw) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const now = Date.now();
  db.users.push({ id: 'u_cw', username: 'cw_wh', name: '撤单仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hp('E2e#Cw!127') });
  db.params = Object.assign(db.params || {}, { countMax: 12, countSamplePct: 10, countStaleDays: 7, countConc: 3, receivingOn: 0, staleMin: 40, sendTimeoutMin: 5, countAutoDeploy: 1 }); // ㉖v141 开启自动发车保工单进入在途态可复现
  db.ledger = []; db.counts = []; db.agvQueue = []; db.rcsStations = {}; db.requisitions = []; db.outbound = {};
  db.autoDispatch = false; db.agvDispatchMode = 'dry';
  if (withWmas) db.wmasConfig = { host: '127.0.0.1:' + WPORT, account: 'fake', pwd: 'fake' }; else delete db.wmasConfig;
  delete db.rcsConfig; delete db.rcsToken;
  const box = (c, loc) => db.ledger.push({ c, l: loc, f: '1800*1200_2', t: now - 30 * 864e5, p: 'PN' + c.slice(-2), n: '撤单件', q: 100, b: '2026-09-01', pid: '', by: '夹具', rec: now - 30 * 864e5, hist: [] });
  const rec = (id, code, state, ex) => Object.assign({ id, sid: 'CS127', code, from: 'NB02-A-' + code.slice(-2) + '-1F', part: 'PN' + code.slice(-2), nm: '撤单件', f: '1800*1200_2', qty: 100, ageDays: 30, state, station: '', uid: 'u_cw', by: '撤单仓管', at: now, updAt: now, taskNo: '', taskNo2: '', outQueued: 0, backQueued: 0, diff: null }, ex || {});
  const qi = (id, code, type, state, wmsTask, stn) => ({ id, code, type, countId: id, state, wmsTask: wmsTask || '', station: stn || '', fromLoc: 'NB02-A-' + code.slice(-2) + '-1F', palletType: '1800*1200_2', by: '撤单仓管', at: now, updAt: now, trace: [] });
  box('CTA1270001', 'NB02-A-01-1F'); db.counts.push(rec('c1', 'CTA1270001', 'toStation', { taskNo: 'T-OK-1', station: 'NB02-CK-01' })); db.agvQueue.push(qi('c1', 'CTA1270001', 'count', '已下发', 'T-OK-1', 'NB02-CK-01'));
  box('CTA1270002', 'NB02-A-02-1F'); db.counts.push(rec('c2', 'CTA1270002', 'toStation', { taskNo: 'T-FAIL-2', station: 'NB02-CK-02' })); db.agvQueue.push(qi('c2', 'CTA1270002', 'count', '已下发', 'T-FAIL-2', 'NB02-CK-02'));
  box('CTA1270003', 'NB02-A-03-1F'); db.counts.push(rec('c3', 'CTA1270003', 'toStation', { taskNo: 'T-NX-3', station: 'NB02-CK-03' })); db.agvQueue.push(qi('c3', 'CTA1270003', 'count', '已下发', 'T-NX-3', 'NB02-CK-03'));
  box('CTA1270004', 'NB02-A-04-1F'); db.counts.push(rec('c4', 'CTA1270004', 'toStation', { station: '' })); db.agvQueue.push(qi('c4', 'CTA1270004', 'count', '排队', '', ''));
  box('CTA1270005', 'NB02-A-05-1F'); db.counts.push(rec('c5', 'CTA1270005', 'atStation', { taskNo: 'T-OK-5', station: 'NB02-CK-05', arriveAt: now })); db.agvQueue.push(qi('c5', 'CTA1270005', 'count', '到站', 'T-OK-5', 'NB02-CK-05'));
  box('CTA1270006', 'NB02-A-06-1F'); db.counts.push(rec('c6', 'CTA1270006', 'returning', { taskNo2: 'T-OK-6', station: 'NB02-CK-06', scanAt: now, retAt: now })); db.agvQueue.push(qi('c6', 'CTA1270006', 'countback', '已下发', 'T-OK-6', ''));
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db));
}
const TDIR = path.join(__dirname, 'data_e2e_cc_v127'); const TDIR2 = path.join(__dirname, 'data_e2e_cc2_v127');
(async () => {
  fakeWmas.listen(WPORT, '127.0.0.1');
  mkDb(TDIR, true);
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 主实例未就绪'); srv.kill(); fakeWmas.close(); process.exit(1); }
  console.log('主实例+假WMAS已就绪 —— v127 盘点取消撤单联动证明');
  const errLines = []; srv.stderr.on('data', (x) => { const s = String(x); if (!/EADDRINUSE|deprecated/i.test(s)) errLines.push(s.trim()); });
  try {
    const wh = (await post(BASE + '/api/login', null, { username: 'cw_wh', password: 'E2e#Cw!127' })).json.token;
    const cand0 = (await getJ(BASE + '/api/count/list?all=1', wh)).json.cand;
    // ===== S1 撤单成功 → 取消+回收+解冻 =====
    const s1 = await post(BASE + '/api/count/cancel', wh, { id: 'c1', reason: '先解冻发料' });
    chk('S1a 取消成功且标记已撤 WMAS', [s1.json.ok === true, s1.json.rec.state === 'canceled', s1.json.wmasCancelled], [true, true, true]);
    chkT('S1b 假 WMAS 收到撤销 T-OK-1', cancelHits.includes('T-OK-1'));
    await sleep(800); // save() 120ms 防抖+异步落盘，读文件前等刷盘（同 v123b 处理）
    const dbf1 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const q1 = dbf1.agvQueue.find((x) => x.id === 'c1');
    chk('S1c 队列项经统一回收（取消态+留痕）', [q1.state, String(q1.err).includes('盘点单取消')], ['取消', true]);
    const cand1 = (await getJ(BASE + '/api/count/list?all=1', wh)).json.cand;
    chk('S1d 冻结解除：盲区候选回升 1', cand1 - cand0, 1);
    // ===== S2 撤单被拒 → 拒绝取消，一切原样 =====
    const s2 = await post(BASE + '/api/count/cancel', wh, { id: 'c2', reason: 'x' });
    chk('S2a 撤被拒→400 拒绝取消', [s2.json.ok === false, /撤销未成功|叉取/.test(String(s2.json.msg))], [true, true]);
    const dbf2 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('S2b 工单与队列项原样（未取消未解冻）', [dbf2.counts.find((x) => x.id === 'c2').state, dbf2.agvQueue.find((x) => x.id === 'c2').state], ['toStation', '已下发']);
    chkT('S2c 假 WMAS 确有尝试撤销 T-FAIL-2', cancelHits.includes('T-FAIL-2'));
    // ===== S3 任务不存在 → 视同已撤放行 =====
    const s3 = await post(BASE + '/api/count/cancel', wh, { id: 'c3' });
    chk('S3 报"不存在"→取消成功', [s3.json.ok === true, s3.json.rec.state], [true, 'canceled']);
    // ===== S4 未下发 → 不碰 WMAS 直接取消 =====
    const h4 = cancelHits.length;
    const s4 = await post(BASE + '/api/count/cancel', wh, { id: 'c4' });
    chk('S4a 排队未下发取消成功', [s4.json.ok === true, s4.json.wmasCancelled], [true, false]);
    chk('S4b 全程未调 WMAS 撤销', cancelHits.length, h4);
    // ===== S5 到台态 → 不撤单、不误标到站队列项 =====
    const h5 = cancelHits.length;
    const s5 = await post(BASE + '/api/count/cancel', wh, { id: 'c5' });
    chk('S5a 到台取消成功且不撤单', [s5.json.ok === true, s5.json.wmasCancelled, cancelHits.length === h5], [true, false, true]);
    const dbf5 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('S5b 到站队列项保持到站（搬运已发生不标取消）', dbf5.agvQueue.find((x) => x.id === 'c5').state, '到站');
    // ===== S6 归位在途 → 撤 countback 腿 =====
    const s6 = await post(BASE + '/api/count/cancel', wh, { id: 'c6' });
    chk('S6a 归位在途取消成功', [s6.json.ok === true, s6.json.wmasCancelled], [true, true]);
    chkT('S6b 撤的是归位腿 T-OK-6', cancelHits.includes('T-OK-6'));
    // ===== S7 终态幂等 =====
    const s7 = await post(BASE + '/api/count/cancel', wh, { id: 'c1' });
    chk('S7 已取消再取消 400', [s7.json.ok === false, /终态/.test(String(s7.json.msg))], [true, true]);
    // ===== S8 无 WMAS 配置但已下发 → 引导人工撤 =====
    mkDb(TDIR2, false);
    const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT2), HOST: '127.0.0.1', DATA_DIR: TDIR2 }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch(BASE2 + '/api/health')).ok; } catch (_) {} }
    if (!up2) { console.log('FAIL! 第二实例未就绪'); srv2.kill(); }
    else {
      const wh2 = (await post(BASE2 + '/api/login', null, { username: 'cw_wh', password: 'E2e#Cw!127' })).json.token;
      const s8 = await post(BASE2 + '/api/count/cancel', wh2, { id: 'c1' });
      chk('S8a WMAS 不可用→拒绝取消并引导', [s8.json.ok === false, /AGV 系统|WMAS/.test(String(s8.json.msg))], [true, true]);
      const dbf8 = JSON.parse(fs.readFileSync(path.join(TDIR2, 'db.json'), 'utf8'));
      chk('S8b 工单未被置取消（防静默丢单）', dbf8.counts.find((x) => x.id === 'c1').state, 'toStation');
      srv2.kill('SIGKILL'); fs.rmSync(TDIR2, { recursive: true, force: true });
    }
    // ===== A 源码锚点 =====
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('A1 撤单调用在位', src.includes("wmasHttp('POST', '/api/logistics/agv-task/cancelTask', tk, [_taskNo])"));
    chkT('A2 旧裸改状态写法已消失', !src.includes("q.state = '取消'; q.err = '盘点单取消（人工）';"));
    chkT('A3 统一回收在位', src.includes("retireQueueItem(qq, '取消', '盘点单取消（人工）')"));
    chkT('A4 到台留痕提示人工处理框', src.includes('框可能已在站台，请确认实物并归位/出库'));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = errLines.filter((s) => /uncaught|referenceerror|typeerror|syntaxerror/i.test(s));
  chkT('F 服务日志无未捕获异常', uncaught.length === 0);
  if (uncaught.length) console.log(uncaught.join('\n'));
  srv.kill('SIGKILL'); fakeWmas.close(); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v127 盘点取消撤单联动实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
