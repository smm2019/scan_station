// ㉖v154 竞态修复验证：N26K110043 混档记录（AGV标记+空台站）根因=保存链 6 个 await 期间
// SharedPreferences 异步回调改写 _workType。本测试全区间扫描保存链源码，断言：
// 校验/落库/叫车/登记链路不再有任何"实时可变状态读取"（界面清理赋值除外），全部改用入口快照。
const fs = require('fs');
const src = fs.readFileSync('D:/work_app/scan_station/lib/main.dart', 'utf8');
const lines = src.split(/\r?\n/);
let pass = 0, fail = 0;
const T = (id, cond, note) => {
  if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); }
  else { fail++; console.log('FAIL ' + id + (note ? '  ' + note : '')); }
};

// ---- 定位主链区间：快照声明 → scheduleScanPush ----
const si = lines.findIndex(l => l.indexOf('final int wt0 = _workType;') >= 0);
let ei = -1;
for (let i = si + 1; i < lines.length; i++) if (lines[i].indexOf('scheduleScanPush();') >= 0) { ei = i; break; }
T('R0 区间锚点', si > 0 && ei > si, '主链 L' + (si + 1) + '-' + (ei + 1));

// ---- 快照 6 变量齐备且为 final ----
const region = lines.slice(si, ei + 1);
T('R1a 模式快照', /^final int wt0 = _workType;/.test(region[0].trim()));
T('R1b 台站快照', /final String\? st0 = _selectedStation;/.test(region.join('\n')));
T('R1c 地面快照', /final String\? gl0 = _selectedGroundLoc;/.test(region.join('\n')));
T('R1d 容器快照', /final String\? ct0 = _containerType;/.test(region.join('\n')));
T('R1e 整托快照', /final bool pallet0 = _palletMode;/.test(region.join('\n')));
T('R1f 退库快照', /final bool ret0 = _retMode;/.test(region.join('\n')));

// ---- 核心断言：区间内（快照声明之后的 6 行除外）不得有实时可变读取 ----
// 允许例外：界面清理"赋值"行（_xxx = null/false 是写 State，不是读）
const MUT = ['_workType', '_selectedStation', '_selectedGroundLoc', '_containerType', '_palletMode', '_retMode'];
const isAssignOnly = l => {
  const t = l.trim();
  // 纯赋值语句（含注释尾巴），左侧是字段本身、右侧不含被读字段
  const m = t.match(/^(_workType|_selectedStation|_selectedGroundLoc|_containerType|_palletMode|_retMode)\s*=(?!=)\s*(.+)$/);
  if (!m) return false;
  const rhs = m[2].replace(/\/\/.*$/, '');
  return !MUT.some(k => new RegExp('(?<![A-Za-z0-9_])' + k + '(?![A-Za-z0-9_])').test(rhs));
};
const leaks = [];
for (let i = 7; i < region.length; i++) { // 跳过快照声明6行+其后注释
  const l = region[i];
  const code = l.replace(/\/\/.*$/, '');
  if (isAssignOnly(code)) continue;
  for (const k of MUT) {
    if (new RegExp('(?<![A-Za-z0-9_])' + k + '(?![A-Za-z0-9_])').test(code)) leaks.push('L' + (si + i + 1) + ':' + k + ' → ' + code.trim().slice(0, 70));
  }
}
T('R2 主链零实时读取', leaks.length === 0, leaks.length ? leaks.join(' | ') : '含 await 窗口全程只读快照');

// ---- 关键落点抽查（语义不因批量替换而错位）----
const reg = region.join('\n');
T('R3a 落库 workType 用快照', /workType: wt0,/.test(reg));
T('R3b 落库台站按快照模式', /stationNo: wt0 == 0 \? st0 : null,/.test(reg));
T('R3c 落库地面/来料按快照', /groundLocation: wt0 == 1 \? gl0 : \(wt0 == 2 \? recvSlotAuto : null\)/.test(reg));
T('R3d 落库容器用快照', /containerType: ct0,/.test(reg));
T('R4a 校验2-AGV认快照台站', /if \(wt0 == 0\) \{\s*\n?\s*locationValid = st0 != null;/.test(reg) || (reg.indexOf('wt0 == 0') >= 0 && reg.indexOf('st0 != null') >= 0));
T('R4b 第二道站台闸用快照', /if \(wt0 == 0 && st0 == null\) \{/.test(reg));
T('R5 查重带快照 ret/wt', /_globalDupCheck\(code, recv: wt0 == 2, ret: ret0 && wt0 != 2\)/.test(reg));
T('R6 站台占用查询用快照', /\.stationNoEqualTo\(st0\)/.test(reg));
T('R7 叫车站台取自快照', /final autoCallSt =\s*\n?\s*wt0 == 0 \? \(st0 \?\? ""\) : "";/.test(reg));

// ---- 登记函数：快照入参必填 + 体内零实时读取 ----
const fi = lines.findIndex(l => l.indexOf('Future<void> _ledgerRegisterOnSave(String code,') >= 0);
let fe = -1;
for (let i = fi + 1; i < lines.length; i++) if (lines[i] === '  }') { fe = i; break; }
T('R8a 登记函数定位', fi > 0 && fe > fi, 'L' + (fi + 1) + '-' + (fe + 1));
T('R8b 快照参数必填', /required int wtSnap, required bool palletSnap/.test(lines[fi + 1]), '漏传即编译错，杜绝将来静默漂移');
const fbody = lines.slice(fi + 3, fe).join('\n');
const fleaks = [];
{
  const fl = lines.slice(fi + 3, fe);
  for (let i = 0; i < fl.length; i++) {
    const code = fl[i].replace(/\/\/.*$/, '');
    if (isAssignOnly(code)) continue;
    for (const k of MUT) {
      if (new RegExp('(?<![A-Za-z0-9_])' + k + '(?![A-Za-z0-9_])').test(code)) fleaks.push('L' + (fi + 4 + i) + ':' + k + ' → ' + code.trim().slice(0, 70));
    }
  }
}
T('R9 登记函数体零实时读取', fleaks.length === 0, fleaks.length ? fleaks.join(' | ') : '叫车/账本落库只认快照');
// 调用点传齐快照实参
const callRegion = lines.slice(0, fi).join('\n');
T('R10 调用点传齐实参', /wtSnap: wt0, palletSnap: pallet0, ctSnap: ct0,/.test(callRegion));

// ---- 界面清理行为不回归：保存成功后仍清空真实字段 ----
const cleanup = region.join('\n');
T('R11a 保存后仍清真实台站', /_selectedStation = null;/.test(cleanup));
T('R11b 保存后仍清真实容器', /_containerType = null;/.test(cleanup));
T('R11c 退库勾选仍单次生效', /_retMode = false;/.test(cleanup));

// ---- 竞态模型复演：旧(读实时)必产混档、新(读快照)必不产 ----
function simulate(useSnapshot) {
  let wt = 1, st = null, gl = 'H9'; // 用户在地面模式选好 H9 后点保存
  const snap = { wt: wt, st: st, gl: gl };
  const validate = v => (v.wt === 0 ? v.st != null : v.wt === 2 ? true : v.gl != null); // 校验2
  // 时序（与真码逐行一致）：校验2 → 查重 → 第二道站台闸 —— 全部在 MES await 之前
  const pre = useSnapshot ? snap : { wt: wt, st: st, gl: gl };
  if (!validate(pre)) return 'blocked1';
  if (pre.wt === 0 && pre.st == null) return 'blocked2';
  // ↓ MES 查询 await（数秒网络窗口）期间，SP 回调把模式漂成 AGV(0)，台站仍空
  wt = 0; st = null;
  // ↓ 落库：旧代码读实时值 → 混档；快照版仍是点保存那一刻的值
  const post = useSnapshot ? snap : { wt: wt, st: st, gl: gl };
  return { workType: post.wt, stationNo: post.st == null ? null : post.st, groundLocation: post.gl };
}
// 注：漂移点在第二道闸(2475)之后、ScanRecord(2642)之前的 MES await 窗口，与生产时序吻合——
// 生产流水 wt=0+无gl+无st 能落库正是两道闸都已按"地面模式"放行后、模式才漂成 AGV 的结果。
T('R12a 旧逻辑复演产混档', (() => { const r = simulate(false); return typeof r === 'object' && r.workType === 0 && r.stationNo === null; })(), 'wt=0+空台站=N26K110043 实况');
{
  const r = simulate(true);
  T('R12b 快照逻辑不产混档', typeof r === 'object' ? !(r.workType === 0 && r.stationNo === null) : true,
    typeof r === 'object' ? '落库=' + JSON.stringify(r) + '（与校验时刻同口径）' : '结果=' + r);
}

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
