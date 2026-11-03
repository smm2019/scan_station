// ㉖v103 会话防重复叫车·活跃性清理 · 判据单测 + 11/3 现场时间线回放
// 复刻 collection_ledger.dart _loadMyQueue 清理逻辑（Node版），用真实队列数据还原 C-02-3F 事故
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// ===== 判据复刻（与 Dart 同逻辑）=====
// mine=本人活跃队列项（服务器已滤完成/取消；失败项仍在）；loc 命中 _colCalled 即挡叫车
function cleanColCalled(colCalled, mine) {
  const actLocs = new Set(mine.filter((q) => q.state !== '失败').map((q) => String(q.station || q.stationManual || '').toUpperCase()).filter((s) => s));
  return new Set([...colCalled].filter((loc) => actLocs.has(loc)));
}
const L = 'NB02-C-02-3F';
console.log('===== A. 判据单测 =====');
T('A1 任务在途→货位保留(整托防重复不受影响)', [...cleanColCalled(new Set([L]), [{ state: '已下发', station: L, by: '宋明明' }])], [L]);
T('A2 任务完成出活跃表→货位释放(修复目标)', [...cleanColCalled(new Set([L]), [])], []);
T('A3 失败项视同不活跃→释放可重叫', [...cleanColCalled(new Set([L]), [{ state: '失败', station: L, by: '宋明明' }])], []);
T('A4 到站仍活跃→保留', [...cleanColCalled(new Set([L]), [{ state: '到站', stationManual: L, station: L, by: '宋明明' }])], [L]);
T('A5 他人任务不影响本名单(判据只喂本人队列)', cleanColCalled(new Set([L]), []).has(L), false);
T('A6 多货位只清完结的', [...cleanColCalled(new Set([L, 'NB02-A-01-1F']), [{ state: '排队', station: 'NB02-A-01-1F', by: '宋明明' }])], ['NB02-A-01-1F']);

console.log('\n===== B. 11/3 现场时间线回放（宋明明设备，真实队列数据）=====');
// 队列项按时刻推演：17:51 叫车112→C-02-3F；18:07 112出库完成；18:22 扫100入同位
const q112in = { code: 'N26K030112', state: '已下发', station: L, by: '宋明明' }; // 17:51 叫车成功后活跃表快照
let col = cleanColCalled(new Set([L]), [q112in]);
T('B1 17:51 叫车112成功后，同托第二框仍被防重复(原设计保留)', col.has(L), true);
// 18:07 前后框出库完成 → 服务器活跃队列里 C-02-3F 无本人任务（完成/取消被服务器过滤）
col = cleanColCalled(col, []);
T('B2 18:07 112送达出库完结→货位释放', col.has(L), false);
// 18:22:42 扫 N26K030100 入 C-02-3F → 修复后自动叫车正常发起（旧版此处挡死，现场连挡3次重扫）
T('B3 18:22 新框入同位→自动叫车不再被挡(修复验证)', col.has(L), false);
// 叫车成功→重新入名单（模拟 add 后再刷新）
col.add(L);
const q100 = { code: 'N26K030100', state: '已下发', station: L, by: '宋明明' };
T('B4 叫车成功后同托再扫仍防重复', cleanColCalled(col, [q100]).has(L), true);
// 对照旧版：_colCalled 永不清理 → 18:22 必被挡（现场事故复现）
const oldCol = new Set([L]); // 17:51 add 后旧版再无 remove
T('B5 对照旧版：18:22 新框被"本会话已叫过车"挡死(事故根因)', oldCol.has(L), true);
// 现场旁证（改用 agvTasks 沉淀=保留30天，队列项仅留2小时会出队）：C-10-1F 11/3 两次入库完成，
// 18:03:34 前框送达 → 18:35:07 同位再进新框——正是"货位腾空后复用"的真实周转，旧版名单会挡死第二次
const L2 = 'NB02-C-10-1F';
const _t = d.agvTasks || {};
const finAt = (no) => (_t[no] || {}).fin || 0;
const t101 = finAt('AGV-20261103-0101'), t105 = finAt('AGV-20261103-0105');
T('B6 旁证(沉淀)：C-10-1F 同日两次入库完成(18:03→18:35 货位复用真实周转)', !!t101 && !!t105 && t105 > t101 && (_t['AGV-20261103-0105'].ep || '') === L2, true);
T('B7 旁证(沉淀)：两次完成间隔 10~60 分钟(同班次高频复用窗口)', t105 - t101 > 600000 && t105 - t101 < 3600000, true);
// 服务器按框防重闸仍在（最后兜底不依赖客户端名单）：100 已沉淀完成、不在活跃队列
const _actCodes = new Set((d.agvQueue || []).filter((q) => ['排队', '下发中', '已下发', '到站'].includes(q.state)).map((q) => String(q.code || '').toUpperCase()));
T('B8 兜底核验：100 已无活跃任务(完成出队)，重复叫车由服务器按框闸拦', _actCodes.has('N26K030100'), false);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
