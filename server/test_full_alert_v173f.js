// ㉖v173f 格位未上账巡检（fullFlowAlert）回归测试
// 动因：v93 世代卡死 5分41秒、v154 快照竞态这类"扫了完整格位但账本推不上"全靠人盯网页；
//   照 coarseFlowAlert（粗码未上账）同骨架做常驻巡检。判据必须证明两件事：
//   ① 该报的真报（滞留满龄+账本无+无出库+无墓碑）② 不该报的一律不报（4 个排除项 + NB04 + 开关）
// 分层同 invariant 套件：A 抽函数判据边界（vm，秒级）/ C 真实全库 0 误报回归
//（B 起实例验证"会跑会发通知"需要 5 分钟定时器，抽函数已覆盖判据+通知路径，实例侧由
//  health 可观测 + 现场首日观察兜底——此处如实标注未起实例的原因）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
const topFn = (name) => {
  let i = SRC.indexOf('async function ' + name + '(');
  const asy = i >= 0; if (!asy) i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
};
const NOW = Date.now();
const MIN = 60000;

function run(dbObj, params) {
  const ops = [], notified = [], errs = []; let saved = 0;
  const ctx = vm.createContext({
    db: dbObj, P: () => params, Date, Math, Object, Array, String, Number, Set, Map, RegExp, JSON, isNaN,
    notify: (id, type, text) => notified.push({ id, type, text }),
    pushOps: (u, act, obj, det) => ops.push({ act, obj, det }),
    logErr: (w, e) => errs.push(w + ':' + (e && e.message)),
    save: () => { saved++; },
    console: { log: () => {} },
  });
  vm.runInContext(topFn('fullFlowAlert'), ctx);
  vm.runInContext('fullFlowAlert()', ctx);
  return { ops, notified, errs, savedCount: () => saved };
}
const mkDb = (o) => Object.assign({ ledger: [], scanlog: {}, seenOut: {}, ledgerTomb: [], users: [{ id: 'w1', enabled: true, role: 'warehouse' }, { id: 'w2', enabled: true, role: 'admin' }] }, o);
const P_ON = { fullAlertOn: 1, fullAlertAgeMin: 2 };
const flow = (code, gl, t) => ({ [code + '|b|1']: { code, gl, t, cx: false, wt: 1, op: '张三' } });

console.log('--- A 判据边界（抽函数）---');
{ // 真滞留：完整格位 + 超判龄 + 账本无 + 无出库 + 无墓碑 → 必报 + solo 点名
  const db = mkDb({ scanlog: flow('FA1', 'NB03-E-15-07', NOW - 5 * MIN) });
  const r = run(db, P_ON);
  C('滞留 5 分钟满龄 → ops 留痕"格位未上账"', /格位未上账/.test(r.ops.map((o) => o.act).join('')), r.ops.map((o) => o.act).join(','));
  C('且 ghost_out solo 点名含框号与滞留分钟', r.notified.length >= 2 && r.notified.every((n) => n.type === 'ghost_out' && /FA1/.test(n.text) && /滞留/.test(n.text)), '通知 ' + r.notified.length + ' 人（仓管+管理员）');
  C('去重标记落库 + save 被调（重启不重轰）', db.fullAlert && db.fullAlert.FA1 > 0 && r.savedCount() >= 1);
  C('无异常逃逸', r.errs.length === 0, r.errs.join(';'));
}
{ // 未满判龄（1 分钟 < 2）→ 不报
  const db = mkDb({ scanlog: flow('FA2', 'NB03-E-15-08', NOW - 1 * MIN) });
  const r = run(db, P_ON);
  C('判龄未满（1min<2min 自愈窗口）→ 不报', r.ops.length === 0 && r.notified.length === 0);
}
{ // 排除项①：账本已有 → 不报
  const db = mkDb({ scanlog: flow('FA3', 'NB02-A-05-1F', NOW - 30 * MIN), ledger: [{ c: 'FA3', l: 'NB02-A-05-1F' }] });
  C('账本已有此框 → 不报', run(db, P_ON).ops.length === 0);
}
{ // 排除项②：有出库留痕（正常拣走）→ 不报
  const db = mkDb({ scanlog: flow('FA4', 'NB02-A-05-2F', NOW - 30 * MIN), seenOut: { FA4: { at: NOW - 5 * MIN, no: 'DT1' } } });
  C('有 seenOut 出库史 → 不报（正常流转）', run(db, P_ON).ops.length === 0);
}
{ // 排除项③：有墓碑（PDA 已消位）—— ★现状全库仅有的 2 个候选全靠这条排除
  const db = mkDb({ scanlog: flow('FA5', 'NB02-A-14-2F', NOW - 60 * MIN), ledgerTomb: [{ c: 'FA5', t: NOW - 10 * MIN }] });
  C('有 ledgerTomb 墓碑 → 不报（实测 2 个现网候选全靠此条，缺它上线即误报）', run(db, P_ON).ops.length === 0);
}
{ // 排除项④：NB04 来料区不判（账本无该区，判必误报）
  const db = mkDb({ scanlog: flow('FA6', 'NB04-A-05-1F', NOW - 3 * 60 * MIN) });
  C('NB04 来料区完整格位 → 不判（防刷屏）', run(db, P_ON).ops.length === 0);
}
{ // 粗码（非完整格位）不归本巡检管（归 coarseFlowAlert）
  const db = mkDb({ scanlog: flow('FA7', 'E11', NOW - 3 * 60 * MIN) });
  C('粗码流水 → 本巡检不报（职责不重叠）', run(db, P_ON).ops.length === 0);
}
{ // 作废流水（cx）不报；开关关不跑
  const db = mkDb({ scanlog: { 'FA8|b|1': { code: 'FA8', gl: 'NB03-B-02-03', t: NOW - 30 * MIN, cx: true } } });
  C('已作废流水 → 不报', run(db, P_ON).ops.length === 0);
  const db2 = mkDb({ scanlog: flow('FA9', 'NB03-B-02-04', NOW - 30 * MIN) });
  C('开关=0 → 完全停摆（现场可关）', run(db2, { fullAlertOn: 0, fullAlertAgeMin: 2 }).ops.length === 0);
}
{ // 7 天去重：第二次跑不再报；不同框各自独立报
  const db = mkDb({ scanlog: Object.assign({}, flow('FB1', 'NB03-C-01-01', NOW - 10 * MIN)) });
  const r1 = run(db, P_ON); const r2 = run(db, P_ON);
  C('首次报、二次同框 7 天内去重不重复吵', r1.ops.length === 1 && r2.ops.length === 0);
}
{ // 判龄参数生效：fullAlertAgeMin=60 时 30 分钟滞留不该报
  const db = mkDb({ scanlog: flow('FB2', 'NB03-C-01-02', NOW - 30 * MIN) });
  C('判龄=60 分钟时 30 分钟滞留 → 不报（参数生效）', run(db, { fullAlertOn: 1, fullAlertAgeMin: 60 }).ops.length === 0);
}

console.log('\n--- C 真实全库回归（上线第一天 0 误报的前提）---');
try {
  const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const db = JSON.parse(JSON.stringify(real));
  db.fullAlert = {}; // 副本从零去重，看真实命中面
  const r = run(db, P_ON);
  C('★真实全库现状 0 命中（2 个候选框均在墓碑，被排除项③挡住）', r.ops.length === 0, '命中 ' + r.ops.length + (r.ops.length ? ' → ' + JSON.stringify(r.ops[0].obj) : ''));
  C('★真实全库无异常逃逸（脏值不炸巡检）', r.errs.length === 0, r.errs.join(';'));
} catch (e) { C('读生产快照', false, e.message); }

console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
