// ㉖v120 修复实例证明：外部清除AGV任务的"幽灵完成事件"不再污染队列对账与终点纠正
// 复刻现场错误实例（2026-11-07 N26J290111 / B-14-2F）：
//   0039：B-14-2F→CK-09 已下发后被运维在AGV系统清除 → RCS沉淀 taskState≠2、finishTime=11:01:55
//   0052：B-14-2F→CK-08 11:20 下发，实际按请求送达 CK-08
//   旧病①：旁证抓 0039 的完成时刻→0052 假"到站"→站台无货→假"完成"+释放容器
//   旧病②：v79c 纠正抓 0039 幽灵事件(终点CK-09)→0052 的 CK-08 被"纠正"成 CK-09（物料员按错台找货）
// 本测试将 server.js 两处修复的判定谓词原样抽出复刻（旁证循环 st 过滤 + 纠正时间窗），
// 用真实时间线数据断言修复后行为，并回归验证正常换台纠正、真送达旁证不被误杀。
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/server.js', 'utf8');

// —— 防漂移：断言两处修复确在 server.js 现行代码中（谓词逐字锚定）——
const guard1 = src.includes('if (t.st !== undefined && t.st !== 2) continue;'); // 旁证取消过滤
const guard2 = src.includes('finTs >= (Number(x.sentAt) || Number(x.at) || 0) - 60000'); // 纠正时间窗
const guard3 = src.includes('st: t.taskState, ex, fin'); // 沉淀记录补存终态
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };

// —— 复刻旁证循环（server.js:7316-7327 修复后语义）——
function advanceBySediment(q, tasks) {
  let fin = 0;
  for (const t of Object.values(tasks)) {
    if (t.ck !== 'out' || String(t.ep).toUpperCase() !== String(q.station).toUpperCase()) continue;
    if (String(t.sp).toUpperCase() !== String(q.fromLoc).toUpperCase()) continue;
    if ((t.fin || 0) < q.sentAt - 60000) continue;
    if (t.st !== undefined && t.st !== 2) continue; // ★修复①：取消/驳回终态不作旁证
    if ((t.fin || 0) > fin) fin = t.fin;
  }
  return fin; // 0=不推进
}
// —— 复刻 v79c 纠正匹配（server.js:6803 修复后语义）——
function correctQueueItem(queue, evt) { // evt={sp,ep,codes,finTs}
  const _qq = queue.find((x) => evt.codes.includes(String(x.code).toUpperCase())
    && ['已下发', '到站'].includes(x.state) && x.station && x.station !== evt.ep
    && x.type !== 'inbound' && x.type !== 'inspback'
    && String(x.fromLoc).toUpperCase() === evt.sp
    && evt.finTs >= (Number(x.sentAt) || Number(x.at) || 0) - 60000); // ★修复②：幽灵事件时间窗
  return _qq || null;
}

const T09 = new Date('2026-11-07T11:01:55').getTime();
const T08 = new Date('2026-11-07T11:35:12').getTime();
const SENT52 = new Date('2026-11-07T11:20:31').getTime();
const CODE = 'N26J290111', FROM = 'NB02-B-14-2F';

// 现场沉淀表：0039=被外部清除(taskState=3取消,fin=清除时刻,终点CK-09)；0052=真送达CK-08(taskState=2)
const tasks = {
  '0039': { ck: 'out', sp: FROM, ep: 'NB02-CK-09', fin: T09, st: 3 },
  '0052': { ck: 'out', sp: FROM, ep: 'NB02-CK-08', fin: T08, st: 2 },
};
const q52 = { code: CODE, fromLoc: FROM, station: 'NB02-CK-08', state: '已下发', sentAt: SENT52 };

// ===== A. 修复①：0052 的旁证只认自己那趟真送达 =====
chk('A1 旁证终点匹配=CK-08 真送达时刻', advanceBySediment(q52, tasks), T08);
const qGhost = { code: CODE, fromLoc: FROM, station: 'NB02-CK-09', state: '已下发', sentAt: SENT52 }; // 假设仍请求CK-09
chk('A2 取消任务(0039)不再被任何队列项当旁证', advanceBySediment(qGhost, { '0039': tasks['0039'] }), 0);
chk('A3 回归：正常完成(st=2)旁证照常推进', advanceBySediment(q52, { '0052': tasks['0052'] }), T08);
chk('A4 兼容：存量旧记录无st字段不误杀', advanceBySediment(q52, { 'x': { ck: 'out', sp: FROM, ep: 'NB02-CK-08', fin: T08 } }), T08);

// ===== B. 修复②：0039 幽灵完成事件不改写 0052 终点 =====
const ghostEvt = { sp: FROM, ep: 'NB02-CK-09', codes: [CODE], finTs: T09 }; // 清除时刻 11:01:55 < 0052 下发 11:20:31
chk('B1 幽灵事件(早于下发)被时间窗拒绝', correctQueueItem([q52], ghostEvt), null);
const realEvt = { sp: FROM, ep: 'NB02-CK-09', codes: [CODE], finTs: new Date('2026-11-07T11:30:00').getTime() }; // 下发后真换台事件
chk('B2 回归：下发后真实换台仍正常纠正', correctQueueItem([q52], realEvt) === q52, true);
const tolEvt = { sp: FROM, ep: 'NB02-CK-10', codes: [CODE], finTs: SENT52 - 30000 }; // 下发前30秒(容差内)
chk('B3 时钟容差60秒内不误杀(下发前30秒事件仍纠正)', correctQueueItem([q52], tolEvt) === q52, true);
const qDone = { code: CODE, fromLoc: FROM, station: 'NB02-CK-08', state: '完成', sentAt: SENT52 };
chk('B4 回归：终态项不被纠正(原state过滤保留)', correctQueueItem([qDone], realEvt), null);
const qOther = { code: 'OTHER00001', fromLoc: FROM, station: 'NB02-CK-08', state: '已下发', sentAt: SENT52 };
chk('B5 回归：非同框码不纠正', correctQueueItem([qOther], realEvt), null);

console.log(`\nserver.js 修复锚点在场：旁证st过滤=${guard1} 纠正时间窗=${guard2} 沉淀存st=${guard3}`);
chk('C1 三处修复锚点均在现行代码', [guard1, guard2, guard3], [true, true, true]);
console.log(`\n===== v120 幽灵完成事件修复实例证明：${total - fail}/${total} PASS =====`);
process.exit(fail ? 1 : 0);
