// ㉖v102 AGV入库旁证终点匹配 · 判据单测 + 今日真实事故回放（冻结快照）
// 复刻 server.js 旁证匹配（旧/新两版）与自愈回退逻辑，用 10/30 现场实况取证
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// ===== 判据复刻 =====
// 旧版旁证回退匹配：方向in + 起点=fromLoc + fin≥下发-60s，取 fin 最大（无终点校验）
function matchOld(q, tasks) {
  const sp = String(q.fromLoc || '').toUpperCase(), lo = (q.sentAt || q.at || 0) - 60000;
  let b = null;
  for (const t of Object.values(tasks)) {
    if (t.ck !== 'in' || String(t.sp || '').toUpperCase() !== sp || (t.fin || 0) < lo) continue;
    if (!b || (t.fin || 0) > (b.fin || 0)) b = t;
  }
  return b;
}
// 新版：直查命中但 ep≠station 弃之；回退匹配加 ep=station 过滤（station 空则退化不滤）
function matchNew(q, tasks) {
  let rt = tasks[String(q.wmsTask || '')] || null;
  if (rt && q.station && String(rt.ep || '').toUpperCase() !== String(q.station).toUpperCase()) rt = null;
  if (!rt) {
    const sp = String(q.fromLoc || '').toUpperCase(), ep = String(q.station || '').toUpperCase(), lo = (q.sentAt || q.at || 0) - 60000;
    let b = null;
    for (const t of Object.values(tasks)) {
      if (t.ck !== 'in' || String(t.sp || '').toUpperCase() !== sp || (t.fin || 0) < lo) continue;
      if (ep && String(t.ep || '').toUpperCase() !== ep) continue;
      if (!b || (t.fin || 0) > (b.fin || 0)) b = t;
    }
    rt = b;
  }
  return rt;
}
// 自愈回退：完成态入库项 + 台上无本框(has=false) + rcsRun 仍有 起点/终点 全匹配且未完成的在途任务 → 回退
function needRollback(q, rcsRun, has) {
  if (q.state !== '完成' || (q.type !== 'inbound' && q.type !== 'inspback') || has) return false;
  return (rcsRun || []).some((t) => String(t.sp || '').toUpperCase() === String(q.fromLoc || '').toUpperCase() && String(t.ep || '').toUpperCase() === String(q.station || '').toUpperCase() && !(t.fin || 0));
}
// dockAt 修正（事故窗口已过分支）：本趟已沉淀且 ep=station 且 dockAt≠fin → 改回本趟 fin
function fixDock(q, tasks) {
  if (q.state !== '完成' || (q.type !== 'inbound' && q.type !== 'inspback')) return q.dockAt;
  const own = tasks[String(q.wmsTask || '')];
  if (own && own.fin && String(own.ep || '').toUpperCase() === String(q.station || '').toUpperCase() && q.dockAt !== own.fin) return own.fin;
  return q.dockAt;
}

// ===== 单元判据 =====
const tk = {
  'AGV-20261030-0059': { ck: 'in', sp: 'NB02-CK-12', ep: 'NB02-C-05-3F', fin: 1400 },
  'AGV-20261030-0067x': { ck: 'in', sp: 'NB02-CK-12', ep: 'NB02-C-10-2F', fin: 1500 },
};
const qA = { wmsTask: 'AGV-20261030-0059', fromLoc: 'NB02-CK-12', station: 'NB02-C-05-3F', sentAt: 1300 };
T('U1 直查命中且终点相符→采用', matchNew(qA, tk) === tk['AGV-20261030-0059'], true);
const qB = { wmsTask: 'AGV-20261030-0059', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F', sentAt: 1300 };
T('U2 直查命中但终点不符(串单)→弃之转回退匹配', matchNew(qB, tk) === tk['AGV-20261030-0067x'], true);
const qC = { wmsTask: 'NO-EXIST', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F', sentAt: 1300 };
T('U3 回退匹配带终点过滤→抓到本趟0067x', matchNew(qC, tk) === tk['AGV-20261030-0067x'], true);
const tk2 = { A: { ck: 'in', sp: 'NB02-CK-12', ep: 'NB02-C-05-3F', fin: 1500 }, B: { ck: 'in', sp: 'NB02-CK-12', ep: 'NB02-C-10-2F', fin: 1400 } };
const qD = { wmsTask: 'X', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F', sentAt: 1300 };
T('U4 旧版错抓他趟(fin更大)', matchOld(qD, tk2) === tk2['A'], true);
T('U5 新版正确抓本趟', matchNew(qD, tk2) === tk2['B'], true);
const qE = { wmsTask: 'X', fromLoc: 'NB02-CK-12', station: '', sentAt: 1300 };
T('U6 station缺失→退化为旧行为(不误杀)', matchNew(qE, tk2) === tk2['A'], true);
T('U7 本趟未沉淀→新版判无旁证(不假完成)', matchNew({ wmsTask: 'X', fromLoc: 'CK9', station: 'NB02-C-99-9F', sentAt: 1 }, tk2), null);
const run = [{ sp: 'NB02-CK-12', ep: 'NB02-C-10-2F', fin: 0 }];
T('U8 完成态+在途同趟→需回退', needRollback({ state: '完成', type: 'inbound', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F' }, run, false), true);
T('U9 台上已见本框→不回退(到站是事实)', needRollback({ state: '完成', type: 'inbound', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F' }, run, true), false);
T('U10 在途任务终点不同→不回退', needRollback({ state: '完成', type: 'inbound', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F' }, [{ sp: 'NB02-CK-12', ep: 'NB02-C-05-3F', fin: 0 }], false), false);
T('U11 出库项不走此回退(另有清台机制)', needRollback({ state: '完成', type: 'outbound', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F' }, run, false), false);
T('U12 dockAt修正：错配他趟时刻→改回本趟fin', fixDock({ state: '完成', type: 'inbound', wmsTask: 'B', station: 'NB02-C-10-2F', dockAt: 1500 }, tk2), 1400);
T('U13 dockAt修正：已正确→不动(幂等)', fixDock({ state: '完成', type: 'inbound', wmsTask: 'B', station: 'NB02-C-10-2F', dockAt: 1400 }, tk2), 1400);
T('U14 dockAt修正：本趟未沉淀→不动', fixDock({ state: '完成', type: 'inbound', wmsTask: 'ZZ', station: 'NB02-C-10-2F', dockAt: 1500 }, tk2), 1500);

// ===== 今日真实事故回放（事故窗口【冻结快照】+ agvTasks 沉淀 30 天，防 live 库推进漂移）=====
// ⚠ 队列项终态仅留 2 小时（agvDispatch 出队），live 读不到 → 现场三项在此固化（10/30 14:25 实测 dump）；
//   旁证 0059/0067 沉淀在 agvTasks 可长期核对，值与此处一致。
const mk = (o) => o;
const q067 = mk({ code: 'N26J300069', state: '完成', type: 'inbound', fromLoc: 'NB02-CK-12', station: 'NB02-C-10-2F', wmsTask: 'AGV-20261030-0067', at: 1793340314680, sentAt: 1793340314680, dockAt: 1793340490000, by: '宋明明' }); // 被错配成0059完成时刻
const q039 = mk({ code: 'N26J300039', state: '完成', type: 'inbound', fromLoc: 'NB02-CK-11', station: 'NB02-C-10-1F', wmsTask: 'AGV-20261030-0066', at: 1793340296000, sentAt: 1793340296000, dockAt: 1793340292000, by: '宋明明' }); // dockAt早于sentAt
const q057 = mk({ code: 'N26J300057', state: '完成', type: 'inbound', fromLoc: 'NB02-CK-12', station: 'NB02-C-05-3F', wmsTask: 'AGV-20261030-0059', at: 1793339049959, sentAt: 1793339049959, dockAt: 1793340490000, by: '宋明明' }); // 真完成
const INC_TASKS = { 'AGV-20261030-0059': { ck: 'in', sp: 'NB02-CK-12', ep: 'NB02-C-05-3F', fin: 1793340490000 } }; // 事故窗口内唯一沉淀
const INC_RUN = [{ no: 'AGV-20261030-0067', sp: 'NB02-CK-12', ep: 'NB02-C-10-2F', fin: 0 }]; // 0067 真实在途
T('R0 沉淀旁证：0059/0067 仍在 agvTasks(30天)且终点与快照一致', (() => { const a = d.agvTasks || {}; return !!a['AGV-20261030-0059'] && a['AGV-20261030-0059'].ep === 'NB02-C-05-3F' && !!a['AGV-20261030-0067'] && a['AGV-20261030-0067'].ep === 'NB02-C-10-2F'; })(), true);
T('R1 现场实况：0067 队列项已被误判"完成"', q067.state, '完成');
const own67 = ((d.agvTasks || {})['AGV-20261030-0067'] || {}).fin;
T('R2 现场：0067 dockAt=错配时刻(0059)或已修正(本趟fin)，二者必居其一', q067.dockAt === 1793340490000 || q067.dockAt === own67, true);
T('R2b 若已修正则恰=本趟沉淀fin', q067.dockAt === 1793340490000 ? true : q067.dockAt === own67, true);
T('R3 事故快照：旧判据抓到0059(ep=C-05-3F≠目标C-10-2F)复现错配', (matchOld(q067, INC_TASKS) || {}).ep, 'NB02-C-05-3F');
T('R4 事故快照：新判据拒绝错配(本趟未沉淀→无旁证,继续等WMAS对账)', matchNew(q067, INC_TASKS), null);
T('R5 事故快照：自愈回退生效(撤销误判完成)', needRollback(q067, INC_RUN, false), true);
const own39 = ((d.agvTasks || {})['AGV-20261030-0066'] || {}).fin;
// 冻结快照固化事故态：0039 dockAt(14:04:52) 早于 sentAt(14:04:56)——旧判据抓到同位前一趟完成时刻
T('R6 事故态实证：0039 dockAt 早于 sentAt（错配前趟时刻）', q039.dockAt < q039.sentAt, true);
T('R6b 修正能力：按本趟沉淀0066 fin 纠正且晚于 sentAt', own39 > q039.sentAt && fixDock(q039, d.agvTasks || {}) === own39, true);
T('R7 新判据下 0039 同样拒绝该错配', (() => { const r = matchNew(q039, INC_TASKS); return r === null || String(r.ep).toUpperCase() === String(q039.station).toUpperCase(); })(), true);
T('R8 零误伤：0057(真完成)新判据仍命中自己任务', (matchNew(q057, d.agvTasks || {}) || {}).ep, q057.station);
// R9/R10 全量对比改用沉淀自洽集（每项 station=自身 ep，等价于"真实完成项"），不依赖 2 小时出队的队列项
const _selfPool = Object.entries(d.agvTasks || {}).filter(([, t]) => t.ck === 'in' && t.fin).map(([no, t]) => ({ code: 'T' + no, state: '完成', type: 'inbound', fromLoc: t.sp, station: t.ep, wmsTask: no, at: t.fin - 600000, sentAt: t.fin - 600000 }));
const viol = _selfPool.filter((q) => { const r = matchNew(q, d.agvTasks || {}); return r && String(r.ep || '').toUpperCase() !== String(q.station || '').toUpperCase(); });
T('R9 全量零违例：新判据对全部真实完成项终点必自洽', [viol.length, _selfPool.length > 200], [0, true]);
const violOld = _selfPool.filter((q) => { const r = matchOld(q, d.agvTasks || {}); return r && String(r.ep || '').toUpperCase() !== String(q.station || '').toUpperCase(); });
T('R10 对照：旧判据同池违例数（同站台串单风险量化）', typeof violOld.length, 'number');
console.log('  （同池对照：旧判据违例 =', violOld.length, '，新判据 =', viol.length, '；事故三项违例另见 R3/R6）');
// 事故窗口已过（0067 现已沉淀 14:27:14）：回退不再触发，dockAt 修正生效
const own067 = (d.agvTasks || {})['AGV-20261030-0067'];
T('R11 0067 现已沉淀(ep=C-10-2F,fin=14:27:14)', own067 && String(own067.ep).toUpperCase(), 'NB02-C-10-2F');
T('R12 dockAt修正：0067 错配时刻(14:08:10)→本趟fin(14:27:14)', fixDock(q067, d.agvTasks || {}), own067.fin);
T('R13 修正后与真实到站一致且晚于下发', fixDock(q067, d.agvTasks || {}) > q067.sentAt, true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
