// ㉖v103 缺陷一（防重复名单口径）· 实例证明
// 证明：_colCalled 存入库落位货架位，而队列项 station=AGV取货站台、stationManual=目标货架位。
// 旧判据 station ?? stationManual 在任务【在途期间】就错误释放货位（防重复失效）；
// 新判据 stationManual优先退station 在途保留、完成才释放（防重复+防卡死两头都保住）。
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// ===== 判据复刻（精确照抄 Dart 语义：?? 只对 null 生效，空串''非null不回退）=====
// 旧版：final _actLocs = mine.where(非失败).map((q)=>(q["station"] ?? q["stationManual"] ?? "").toUpperCase()).where(非空)
function oldActLocs(mine) {
  const s = new Set();
  for (const q of mine) {
    if (q.state === '失败') continue;
    const v = String(q.station != null ? q.station : (q.stationManual != null ? q.stationManual : '')).toUpperCase(); // Dart ?? 链：station 非null(含'')即取
    if (v !== '') s.add(v);
  }
  return s;
}
// 新版：sm=stationManual.trim().upper; sm非空取sm; 否则取 station.trim().upper
function newActLocs(mine) {
  const s = new Set();
  for (const q of mine) {
    if (q.state === '失败') continue;
    const sm = String(q.stationManual ?? '').trim().toUpperCase();
    const v = sm !== '' ? sm : String(q.station ?? '').trim().toUpperCase();
    if (v !== '') s.add(v);
  }
  return s;
}
// 清理：_colCalled.removeWhere((loc)=>!_actLocs.contains(loc))
function cleanColCalled(colCalled, actLocs) { return new Set([...colCalled].filter((l) => actLocs.has(l))); }

console.log('===== E1 真实字段值域佐证（服务器沉淀入库任务）=====');
const tk = Object.values(d.agvTasks || {});
const inb = tk.filter((x) => x && x.ck === 'in' && x.sp && x.ep);
let spAllCK = true, epAllShelf = true;
for (const x of inb) {
  if (!/^NB02-CK-\d{1,2}$/.test(String(x.sp).toUpperCase())) spAllCK = false; // 起点=AGV取货站台
  if (!/^NB02-[A-H]-\d{1,2}-[1-4]F$/.test(String(x.ep).toUpperCase()) && !/^NB03-/.test(String(x.ep).toUpperCase())) epAllShelf = false; // 终点=货架位/地面位
}
T('E1a 入库任务起点(sp=队列项station值域)全部是CK站台', spAllCK, true);
T('E1b 入库任务终点(ep=队列项stationManual值域)全部是货架位/地面位', epAllShelf, true);
T('E1c 两值域天然不相交（station永远≠落位货位）→ 旧判据取station必落空', /^NB02-CK-/.test(String(inb[0].sp)) && !/^NB02-CK-/.test(String(inb[0].ep)), true);

// ===== 生命周期实例：11/3 真实事故货位 NB02-A-12-3F，宋明明设备 =====
const LOC = 'NB02-A-12-3F', STN = 'NB02-CK-06', BY = '宋明明';
console.log('\n===== E2~E5 入库任务四阶段对撞（_colCalled 初始={' + LOC + '}）=====');
// 阶段队列项快照（字段形态照 carry 入队 + dispatchOne 下发赋值 q.station=stn）
const stage = {
  '排队(未下发)': [{ code: 'N26J310249', state: '排队', fromLoc: STN, stationManual: LOC, station: '', by: BY }], // station 初始空串
  '已下发(在途)': [{ code: 'N26J310249', state: '已下发', fromLoc: STN, stationManual: LOC, station: STN, by: BY }], // 下发后 station=取货台
  '到站(待扫)': [{ code: 'N26J310249', state: '到站', fromLoc: STN, stationManual: LOC, station: STN, by: BY }],
  '完成(已出队)': [], // 服务器queue排除完成/取消 → mine 里根本没这项
};
const init = new Set([LOC]);
const rows = [];
for (const [name, mine] of Object.entries(stage)) {
  const oldLeft = cleanColCalled(init, oldActLocs(mine));
  const newLeft = cleanColCalled(init, newActLocs(mine));
  rows.push({ 阶段: name, 旧判据名单: [...oldLeft].join(',') || '(空)', 新判据名单: [...newLeft].join(',') || '(空)' });
  console.log(`  ${name.padEnd(12)} 旧=[${[...oldLeft].join(',') || '空'}]  新=[${[...newLeft].join(',') || '空'}]`);
}
// 在途三阶段：货位必须保留在名单（防重复）
T('E2 排队态·旧判据误释放（防重复失效）', rows[0].旧判据名单, '(空)');
T('E2 排队态·新判据正确保留', rows[0].新判据名单, LOC);
T('E3 已下发态·旧判据误释放（取到站台码落空）', rows[1].旧判据名单, '(空)');
T('E3 已下发态·新判据正确保留', rows[1].新判据名单, LOC);
T('E4 到站态·旧判据误释放', rows[2].旧判据名单, '(空)');
T('E4 到站态·新判据正确保留', rows[2].新判据名单, LOC);
// 完成出队：货位必须释放（防卡死）——新判据也要做到
T('E5 完成出队·新判据正确释放（防卡死仍生效）', rows[3].新判据名单, '(空)');

console.log('\n===== E6 危害后果：任务在途时同货位二次扫码 =====');
// 采集页拦截逻辑：if(_colCalled.contains(loc)) → 挡重复；否则放行叫车
const mineInflight = stage['已下发(在途)'];
const oldAfter = cleanColCalled(init, oldActLocs(mineInflight));
const newAfter = cleanColCalled(init, newActLocs(mineInflight));
const oldBlocks = oldAfter.has(LOC), newBlocks = newAfter.has(LOC);
T('E6 旧判据·在途二次扫同货位→名单已空→放行重复叫车(错)', oldBlocks, false);
T('E6 新判据·在途二次扫同货位→名单保留→拦截重复叫车(对)', newBlocks, true);

console.log('\n===== E7 混合真实场景：同设备多货位任务并存，各自正确 =====');
// 还原 11/3 16:1x 宋明明设备：A-12-3F 在途 + C-06-3F 已完成出队 + E-11-2F 排队
const mixed = [
  { code: 'N26J310249', state: '已下发', fromLoc: 'NB02-CK-06', stationManual: 'NB02-A-12-3F', station: 'NB02-CK-06', by: BY },
  { code: 'N26J230462', state: '排队', fromLoc: 'NB02-CK-05', stationManual: 'NB02-E-11-2F', station: '', by: BY },
]; // C-06-3F 已完成→不在 mine
const initMulti = new Set(['NB02-A-12-3F', 'NB02-C-06-3F', 'NB02-E-11-2F']);
const nm = cleanColCalled(initMulti, newActLocs(mixed));
T('E7 新判据·保留两个在途货位、释放已完成货位', [...nm].sort(), ['NB02-A-12-3F', 'NB02-E-11-2F']);
const om = cleanColCalled(initMulti, oldActLocs(mixed));
T('E7 旧判据·三个货位全被误释放（在途的也没保住）', [...om].sort(), []);

console.log(fail === 0 ? '\n===== 实例证明：全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
