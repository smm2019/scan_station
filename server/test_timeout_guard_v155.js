// ㉖v155 AGV 超时误判双防线 · 实例验证
// 背景（11-11 16:46 宋明明 N26K100105）：出库搬运 16:06 下发、16:13:56 已送达 CK-12（沉淀 AGV-20261111-0094
// st=2 fin 俱全）、16:15 已扫码出库转 MES，但队列因站台快照没抓到短暂到站、回收旁证又因 RCS 摘除滞后
// 没赶上判定时点 → 挂"已下发"40 分钟被看门狗枪毙，红字"失败"永久残留误导现场。
// 修法：①判失败前终核（送达沉淀→纠正完成；RCS 在途仍在跑→宽限一周期）②失败态事后自愈（仅超时类）。
// 方式：从 server.js 抽取 dispatchWatchdog 与回收循环节两段真实代码，vm 沙箱执行（隔离实例无 RCS 不跑调度）。
const fs = require('fs');
const vm = require('vm');
const SRC = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n'); // server.js 全文 CRLF，标记串按 LF 匹配
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + (note ? '  ' + note : '')); } };

// ---- 抽函数/循环：剥离行注释后按花括号配对 ----
function extract(startMark, opts) {
  const i = SRC.indexOf(startMark);
  if (i < 0) throw new Error('未找到: ' + startMark);
  let depth = 0, inStr = false, strCh = '';
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (inStr) { if (c === '\\') j++; else if (c === strCh) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '/' && SRC[j + 1] === '/') { j = SRC.indexOf('\n', j); if (j < 0) j = SRC.length; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error('配对失败: ' + startMark);
}
const WD = extract('async function dispatchWatchdog(nowMs) {');
const RC_MARK = '  for (const q of queue) {\n    const s = (db.rcsStations || {})[q.station];';
const rcI = SRC.indexOf(RC_MARK);
if (rcI < 0) throw new Error('回收循环未找到');
let depth = 0, rcE = -1;
for (let j = rcI; j < SRC.length; j++) {
  const c = SRC[j];
  if (c === '/' && SRC[j + 1] === '/') { j = SRC.indexOf('\n', j); if (j < 0) break; continue; }
  if (c === '"' || c === "'") { const ch = c; j++; while (j < SRC.length) { if (SRC[j] === '\\') { j += 2; continue; } if (SRC[j] === ch) break; j++; } continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { rcE = j + 1; break; } }
}
const RC = '{\nconst queue = db.agvQueue || [];\n' + SRC.slice(rcI, rcE) + '\n}'; // 括号块作用域：同 ctx 可重复执行（幂等测试用）
T('X0 抽段成功', WD.length > 1000 && RC.length > 1000, 'watchdog ' + WD.length + 'B, 回收循环 ' + RC.length + 'B');
T('X0b watchdog 含v155终核', WD.indexOf('判失败前终核') >= 0 && WD.indexOf('超时核验纠正') >= 0);
T('X0c 回收循环含v155自愈', RC.indexOf("q.state === '失败'") >= 0 && RC.indexOf('事后自愈') >= 0);

const NOW = Date.now(), M = 60000;
function mkCtx(extra) {
  const calls = { notify: [], event: [], cleared: [] };
  const db = Object.assign({
    agvQueue: [], agvTasks: {}, rcsRun: [], rcsStations: {}, users: [{ id: 'u1', role: 'admin', enabled: true }], notifications: [],
  }, extra || {});
  const ctx = {
    db, nowMs: NOW, console: { log: () => {} },
    P: () => ({ staleMin: 40, failKeepMin: 30 }),
    notify: (to, ty, text, rid, opts) => calls.notify.push({ to, ty, text }),
    pushEvent: (kind, code, det) => calls.event.push({ kind, code }),
    clearQueueCall: (rid, code) => calls.cleared.push(code),
    releaseStnBook: () => {}, inspQueueRollback: () => {}, countQueueRollback: () => {},
    funnelArchive: () => {}, retireQueueItem: (q, st, err) => { q.state = st; q.err = err; },
  };
  vm.createContext(ctx);
  return { ctx, db, calls };
}
const qSent = (over, ex) => Object.assign({
  code: 'N99T000101', fromLoc: 'NB02-X-01-1F', station: 'NB02-CK-12', palletType: '1800*1200_2',
  reqId: 'rq_t', reqNo: 'LLT', by: '测试', state: '已下发', sentAt: NOW - 41 * M, at: NOW - 50 * M, updAt: NOW - 41 * M, trace: [],
}, ex || {});
const taskOf = (fin, st) => ({ 'tk1': { car: 7, st: st === undefined ? 2 : st, ex: NOW - 36 * M, fin: fin === undefined ? NOW - 33 * M : fin, pick: NOW - 34 * M, dur: 464, sp: 'NB02-X-01-1F', ep: 'NB02-CK-12', ck: 'out' } });

// ================= W：判失败前终核 =================
{ // W1 送达沉淀→纠正完成、不发超时通知
  const { ctx, db, calls } = mkCtx({ agvQueue: [qSent()], agvTasks: taskOf() });
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  const q = db.agvQueue[0];
  T('W1a 误滞留项纠正为完成', q.state === '完成', 'state=' + q.state);
  T('W1b dockAt=沉淀fin 且不发超时通知', q.dockAt === NOW - 33 * M && calls.notify.length === 0);
  T('W1c trace 留痕可追溯', /超时核验纠正/.test(String(q.trace)), String(q.trace).slice(0, 50));
  T('W1d 叫车标记已清', calls.cleared.indexOf('N99T000101') >= 0);
}
{ // W2 无旁证无在途→仍判失败（兜底不失效）
  const { ctx, db, calls } = mkCtx({ agvQueue: [qSent()] });
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  const q = db.agvQueue[0];
  T('W2a 真超时仍判失败', q.state === '失败' && /下发超40分钟/.test(String(q.err)));
  T('W2b 全体仓管通知照常发', calls.notify.length === 1 && /AGV任务超时/.test(calls.notify[0].text));
  T('W2c 异常事件落表', calls.event.some(e => e.kind === '出库超时'));
}
{ // W3 外部清除(st=5)不作旁证
  const { ctx, db } = mkCtx({ agvQueue: [qSent()], agvTasks: taskOf(undefined, 5) });
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  T('W3 取消终态不作送达旁证仍判失败', db.agvQueue[0].state === '失败', 'st=5 被v120口径拒');
}
{ // W4 RCS 在途仍有本趟→宽限
  const { ctx, db } = mkCtx({ agvQueue: [qSent()], rcsRun: [{ sp: 'NB02-X-01-1F', ep: 'NB02-CK-12', fin: 0 }] });
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  const q = db.agvQueue[0];
  T('W4a 在途核验宽限不判失败', q.state === '已下发' && q.staleGraceAt === NOW, 'graceAt=' + (q.staleGraceAt ? '已设' : '未设'));
  T('W4b trace 留痕', /宽限一个周期再判/.test(String(q.trace)), String(q.trace).slice(-40));
}
{ // W5 宽限也超两倍窗→判失败
  const { ctx, db } = mkCtx({ agvQueue: [qSent(0, { sentAt: NOW - 161 * M, staleGraceAt: NOW - 81 * M })], rcsRun: [{ sp: 'NB02-X-01-1F', ep: 'NB02-CK-12', fin: 0 }] });
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  T('W5 宽限超窗仍枪毙（防永挂）', db.agvQueue[0].state === '失败');
}
{ // W6 旁证终点不匹配（他趟）→ 不救
  const bad = { 'tkX': { car: 7, st: 2, ex: NOW - 36 * M, fin: NOW - 33 * M, sp: 'NB02-X-01-1F', ep: 'NB02-CK-13', ck: 'out' } };
  const { ctx, db } = mkCtx({ agvQueue: [qSent()], agvTasks: bad });
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  T('W6 终点不符他趟不作旁证（v102串单口径）', db.agvQueue[0].state === '失败');
}

// ================= S：失败态事后自愈 =================
const qFail = (ex) => qSent(0, Object.assign({ state: '失败', err: '出库下发超40分钟未到站，请核查', sentAt: NOW - 50 * M, updAt: NOW - 9 * M }, ex || {}));
{ // S1 本趟沉淀已生成→自愈
  const { ctx, db } = mkCtx({ agvQueue: [qFail()], agvTasks: taskOf() });
  vm.runInContext(RC, ctx);
  const q = db.agvQueue[0];
  T('S1a 超时误判失败自愈为完成', q.state === '完成' && q.err === '', 'state=' + q.state);
  T('S1b dockAt=本趟fin', q.dockAt === NOW - 33 * M);
  T('S1c trace 注明误判纠正', /事后自愈.*误判/.test(String(q.trace)));
}
{ // S2 幂等
  const { ctx, db } = mkCtx({ agvQueue: [qFail()], agvTasks: taskOf() });
  vm.runInContext(RC, ctx);
  const u1 = db.agvQueue[0].updAt;
  vm.runInContext(RC, ctx);
  T('S2 自愈幂等（二轮 updAt 不变）', db.agvQueue[0].updAt === u1 && db.agvQueue[0].state === '完成');
}
{ // S3 外部清除终态不自愈
  const { ctx, db } = mkCtx({ agvQueue: [qFail()], agvTasks: taskOf(undefined, 5) });
  vm.runInContext(RC, ctx);
  T('S3 取消终态(st=5)不自愈', db.agvQueue[0].state === '失败');
}
{ // S4 非超时类失败不碰
  const { ctx, db } = mkCtx({ agvQueue: [qFail({ err: '下发超时未回执，请重新叫车' })], agvTasks: taskOf() });
  vm.runInContext(RC, ctx);
  T('S4 非超时看门狗来源的失败不自愈', db.agvQueue[0].state === '失败', 'err=' + db.agvQueue[0].err);
}
{ // S5 已重叫不自愈（防完成表重复）
  const { ctx, db } = mkCtx({ agvQueue: [qFail(), { code: 'N99T000101', fromLoc: 'NB02-X-01-1F', station: 'NB02-CK-12', state: '排队', at: NOW - 3 * M, sentAt: 0 }], agvTasks: taskOf() });
  vm.runInContext(RC, ctx);
  const old = db.agvQueue.filter(q => q.state === '失败');
  T('S5 该框已重叫入队→旧失败项不救', old.length === 1);
}
{ // S6 终点不符他趟沉淀不误救
  const bad = { 'tkY': { car: 7, st: 2, ex: NOW - 36 * M, fin: NOW - 33 * M, sp: 'NB02-X-01-1F', ep: 'NB02-CK-13', ck: 'out' } };
  const { ctx, db } = mkCtx({ agvQueue: [qFail()], agvTasks: bad });
  vm.runInContext(RC, ctx);
  T('S6 终点不符他趟不自愈', db.agvQueue[0].state === '失败');
}
{ // S7 入库方向自愈（ck=in 起点=台 终点=货架）
  const qin = qFail({ type: 'inbound', fromLoc: 'NB02-CK-09', station: 'NB02-H-01-1F' });
  const tk = { 'tkZ': { car: 6, st: 2, ex: NOW - 45 * M, fin: NOW - 42 * M, sp: 'NB02-CK-09', ep: 'NB02-H-01-1F', ck: 'in' } };
  const { ctx, db } = mkCtx({ agvQueue: [qin], agvTasks: tk });
  vm.runInContext(RC, ctx);
  T('S7 入库方向同样按 ck=in 自愈', db.agvQueue[0].state === '完成');
}

// ================= 生产实况复演 =================
{ // 用 N26K100105 真实时刻回放
  const sent = new Date('2026-11-11 16:06:12').getTime(), fin = new Date('2026-11-11 16:13:56').getTime();
  const q = { code: 'N26K100105', fromLoc: 'NB02-C-13-3F', station: 'NB02-CK-12', reqNo: 'LL2026111114575111', by: '宋明明', state: '已下发', sentAt: sent, at: new Date('2026-11-11 15:32').getTime(), updAt: sent, trace: [] };
  const tk = { 'AGV-20261111-0094': { car: 7, st: 2, ex: sent, fin: fin, pick: new Date('2026-11-11 16:11:04').getTime(), dur: 464, sp: 'NB02-C-13-3F', ep: 'NB02-CK-12', ck: 'out' } };
  const { ctx, db, calls } = mkCtx({ agvQueue: [q], agvTasks: tk });
  ctx.nowMs = new Date('2026-11-11 16:46:30').getTime(); // 判失败当刻（终核分支上线后的效果）
  vm.runInContext(WD + '\ndispatchWatchdog(nowMs);', ctx);
  T('P1a v155后看门狗当刻不再误判', db.agvQueue[0].state === '完成' && calls.notify.length === 0, 'state=' + db.agvQueue[0].state);
  T('P1b dockAt=16:13:56 真实送达时刻', db.agvQueue[0].dockAt === fin);
}
console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
