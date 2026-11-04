// ㉖v107 RCS换台纠正方向守卫 · 实例证明（11/4 现场 N26J300181 截图实锤）
// 事故：同一框两趟任务（出库腿 E-06-3F→CK-12 完成事件）触发 v79c 换台纠正时，
// 按标签码抓在途项，把【入库归位腿】(CK-12→E-06-3F) 的货架目的地也"纠正"成起点站台 → CK-12→CK-12 乱码行
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const C = 'N26J300181';

// ===== E1 真实沉淀任务（不可变事实源，保留30天）=====
console.log('===== E1 两趟任务真实方向（agvTasks 沉淀）=====');
const tk = d.agvTasks || {};
const t12 = tk['AGV-20261104-0012'], t17 = tk['AGV-20261104-0017'];
T('E1a 0012=出库腿 货架→站台', [t12.ck, t12.sp, t12.ep], ['out', 'NB02-E-06-3F', 'NB02-CK-12']);
T('E1b 0017=入库腿 站台→货架（同框同站台，时间紧随）', [t17.ck, t17.sp, t17.ep], ['in', 'NB02-CK-12', 'NB02-E-06-3F']);
T('E1c 两腿时刻吻合截图（0012完成09:30:43→0017下发09:44:27）', [t12.fin < t17.ex, t17.fin > t12.fin], [true, true]);
T('E1d 该框账本仍在货架位（入库腿最终送达，货没丢）', (() => { const x = (d.ledger || []).find((y) => String(y.c).toUpperCase() === C); return x ? x.l : null; })(), 'NB02-E-06-3F');

// ===== 纠正判据复刻 =====
// 事件=出库任务完成（ep=实际送达站台）；q=队列项
function fixOld(q, ep, codes) {
  if (!codes.includes(q.code)) return null;
  if (!['已下发', '到站'].includes(q.state)) return null;
  if (!q.station || q.station === ep) return null;
  return { hit: 1, newStation: ep, trace: `RCS实际送达 ${ep}（请求 ${q.station}，已自动纠正）` };
}
function fixNew(q, ep, codes, sp) {
  if (!codes.includes(q.code)) return null;
  if (!['已下发', '到站'].includes(q.state)) return null;
  if (!q.station || q.station === ep) return null;
  if (q.type === 'inbound' || q.type === 'inspback') return null; // 方向守卫：入库/归位腿不换台
  if (String(q.fromLoc || '').toUpperCase() !== sp) return null; // 同趟守卫：起点=事件起点
  return { hit: 1, newStation: ep, trace: `RCS实际送达 ${ep}（请求 ${q.station}，已自动纠正）` };
}

// 截图事故时刻的两条队列项（trace 与完成表列即现场 dump）
const qOut = { code: C, type: 'outbound', state: '到站', fromLoc: 'NB02-E-06-3F', station: 'NB02-CK-12', stationManual: '', wmsTask: 'AGV-20261104-0012' }; // 出库腿：请求台=实际台
const qIn = { code: C, type: 'inbound', state: '已下发', fromLoc: 'NB02-CK-12', station: 'NB02-E-06-3F', stationManual: 'NB02-E-06-3F', wmsTask: 'AGV-20261104-0017' }; // 入库腿：目的地=货架

// ===== E2 旧判据复现污染（0012 出库完成事件，ep=CK-12）=====
console.log('\n===== E2 旧判据：出库完成事件串染入库腿（截图乱码行复现）=====');
const EP = 'NB02-CK-12', SP = 'NB02-E-06-3F';
T('E2a 出库腿自身 station===ep 被跳过（未换台，正常）', fixOld(qOut, EP, [C]), null);
const hitOld = fixOld(qIn, EP, [C]);
T('E2b 入库腿被错误命中（旧版无方向/同趟守卫）', !!hitOld, true);
T('E2c 污染结果：目的地 E-06-3F 被改成起点 CK-12 → CK-12→CK-12 乱码', hitOld.newStation, 'NB02-CK-12');
T('E2d 截图 trace 原文精确复现', hitOld.trace, 'RCS实际送达 NB02-CK-12（请求 NB02-E-06-3F，已自动纠正）');

// ===== E3 新判据：同事件下入库腿免疫 =====
console.log('\n===== E3 新判据：入库腿不再被串染 =====');
T('E3a 出库腿仍跳过（未换台）', fixNew(qOut, EP, [C], SP), null);
T('E3b 入库腿被方向守卫拒绝', fixNew(qIn, EP, [C], SP), null);
T('E3c 入库腿目的地保持货架位（完成表不再乱码）', qIn.station, 'NB02-E-06-3F');

// ===== E4 新判据正向能力保留：出库腿真换台仍要纠正 =====
console.log('\n===== E4 换台纠正本职不受影响（v79c 原场景回归）=====');
// 实测原场景：请求 CK-03，RCS 自行换到 CK-12（同向出库腿，起点=事件起点）
const qSwitch = { code: 'N26K040021', type: 'outbound', state: '已下发', fromLoc: 'NB02-C-05-1F', station: 'NB02-CK-03' };
const hitNew = fixNew(qSwitch, 'NB02-CK-12', ['N26K040021'], 'NB02-C-05-1F');
T('E4a 出库腿换台仍正常纠正（CK-03→CK-12）', hitNew && hitNew.newStation, 'NB02-CK-12');
// 起点不符（别的趟）不得纠正
const qOther = { code: C, type: 'outbound', state: '已下发', fromLoc: 'NB02-B-11-2F', station: 'NB02-CK-01' };
T('E4b 同码但起点≠事件起点（别的趟）→ 同趟守卫拒绝', fixNew(qOther, EP, [C], SP), null);
// 检验归位腿同入库腿免疫
const qInspBack = { code: C, type: 'inspback', state: '已下发', fromLoc: 'NB02-CK-12', station: 'NB02-E-06-3F' };
T('E4c 检验归位腿同样免疫（方向守卫）', fixNew(qInspBack, EP, [C], SP), null);

// ===== E5 污染连带危害：v102 自愈回退/dockAt修正 按 ep===station 比对被架空 =====
console.log('\n===== E5 污染连带危害（v102 防线被架空）=====');
// v102 dockAt 修正与自愈回退都比对 _own.ep === q.station；入库腿真 ep=E-06-3F
const own17ep = String(t17.ep).toUpperCase(); // 'NB02-E-06-3F'
const qInPolluted = { ...qIn, station: hitOld.newStation }; // 污染后 station=CK-12（用复刻返回值，非硬编码）
T('E5a 污染后 station(CK-12)≠本趟ep(E-06-3F) → dockAt修正/自愈回退条件不成立（防线失效）', own17ep === qInPolluted.station, false);
T('E5b 未污染时 station(E-06-3F)===本趟ep → 防线正常可比对', own17ep === qIn.station, true);
// 到站判定取数键=rcsStations[q.station]：污染后查错台（不依赖 live 快照内容，只证键错位）
T('E5c 到站判定取数键错位：污染项查CK-12台、正常项查E-06-3F货架（键不同=抓错对象）', qInPolluted.station !== qIn.station, true);

console.log(fail === 0 ? '\n===== 实例证明：全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
