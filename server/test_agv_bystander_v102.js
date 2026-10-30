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

// ===== 今日真实事故回放（14:05-14:25 事故窗口冻结快照，防 live 库推进漂移）=====
// 快照来源：14:25 实测 dump——0067 在途(rcsRun)、沉淀仅有 0059(14:08:10)、0067 队列项已被错配判"完成"(dockAt=0059时刻)
const q067 = (d.agvQueue || []).find((x) => x.code === 'N26J300069');
const q039 = (d.agvQueue || []).find((x) => x.code === 'N26J300039');
const q057 = (d.agvQueue || []).find((x) => x.code === 'N26J300057');
const INC_TASKS = { 'AGV-20261030-0059': { ck: 'in', sp: 'NB02-CK-12', ep: 'NB02-C-05-3F', fin: 1793340490000 } }; // 事故窗口内唯一沉淀
const INC_RUN = [{ no: 'AGV-20261030-0067', sp: 'NB02-CK-12', ep: 'NB02-C-10-2F', fin: 0 }]; // 0067 真实在途
T('R1 现场实况：0067 队列项已被误判"完成"', q067.state, '完成');
T('R2 现场实况：0067 的 dockAt=0059完成时刻(张冠李戴)', q067.dockAt, 1793340490000);
T('R3 事故快照：旧判据抓到0059(ep=C-05-3F≠目标C-10-2F)复现错配', (matchOld(q067, INC_TASKS) || {}).ep, 'NB02-C-05-3F');
T('R4 事故快照：新判据拒绝错配(本趟未沉淀→无旁证,继续等WMAS对账)', matchNew(q067, INC_TASKS), null);
T('R5 事故快照：自愈回退生效(撤销误判完成)', needRollback(q067, INC_RUN, false), true);
T('R6 0039 同款错配：dockAt 早于 sentAt(抓到0058完成时刻)', q039.dockAt < q039.sentAt, true);
T('R7 新判据下 0039 同样拒绝该错配', (() => { const r = matchNew(q039, INC_TASKS); return r === null || String(r.ep).toUpperCase() === String(q039.station).toUpperCase(); })(), true);
T('R8 零误伤：0057(真完成)新判据仍命中自己任务', (matchNew(q057, d.agvTasks || {}) || {}).ep, q057.station);
// 全量：今日所有入库项，新判据命中旁证的 ep 必须=station
const allIn = (d.agvQueue || []).filter((x) => (x.type || '') === 'inbound' && x.wmsTask);
const viol = allIn.filter((q) => { const r = matchNew(q, d.agvTasks || {}); return r && String(r.ep || '').toUpperCase() !== String(q.station || '').toUpperCase(); });
T('R9 全量回放零违例：新判据命中的旁证终点必=目标货架位', viol.length, 0);
const violOld = allIn.filter((q) => { const r = matchOld(q, d.agvTasks || {}); return r && String(r.ep || '').toUpperCase() !== String(q.station || '').toUpperCase(); });
T('R10 对照：旧判据今日全量违例≥2(0067/0039实锤)', violOld.length >= 2, true);
console.log('  （旧判据今日违例数 =', violOld.length, '，新判据 =', viol.length, '）');
// 事故窗口已过（0067 现已沉淀 14:27:14）：回退不再触发，dockAt 修正生效
const own067 = (d.agvTasks || {})['AGV-20261030-0067'];
T('R11 0067 现已沉淀(ep=C-10-2F,fin=14:27:14)', own067 && String(own067.ep).toUpperCase(), 'NB02-C-10-2F');
T('R12 dockAt修正：0067 错配时刻(14:08:10)→本趟fin(14:27:14)', fixDock(q067, d.agvTasks || {}), own067.fin);
T('R13 修正后与真实到站一致且晚于下发', fixDock(q067, d.agvTasks || {}) > q067.sentAt, true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
