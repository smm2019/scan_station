// ㉖v164 重复标签拦截提示字段纠错 · 实例验证
// 现场（11-12 截图）：弹窗写「该标签已有采集记录（批次 NB03-F-04-02），禁止重复录入」。
// 两处错：
//  ① 字段+标签双错：取的是 gl（地面货位）却标成"批次"。全库 3295 条流水的批次无一为 NB03- 样式；
//     系统内"批次"既有指代=流水 lot（网页流水页「批次」列同源），采集会话号 batch 另是一回事。
//  ② 取的不是最近一次：labelStatus 里 inScanlog 来自 Object.values().filter()，【无排序】，
//     [0] 是键序首条（通常最早那次）。框挪过位 → 提示历史位置，现场照提示去找实物会找不到。
// 修法：按 t 取最近一次，并分列「时间 / 登记人 / 位置 / 批次」四项。
// ★ 方式：vm 抽【真实】labelStatus + labelBlockReason + localDT，跑真实生产数据（只读）+ 合成挪位场景。
// ★ 数据安全：真实 data/db.json 仅只读取样；挪位场景用内存副本，绝不写生产库。
const fs = require('fs');
const vm = require('vm');
const SRC = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');
const REAL = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + '  got=' + JSON.stringify(cond) + (note ? '  [' + note + ']' : '')); } };

function topFn(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('未找到 ' + name);
  for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
  throw new Error('闭合失败 ' + name);
}
// 造一个跑真实函数的沙箱：塞入指定 db + 真实函数 + 其依赖
function mk(db) {
  const ctx = vm.createContext({
    db, Date, Math, String, Number, Object, Array, JSON, Set, RegExp, isNaN, parseInt, parseFloat,
    P: () => ({ recvRows: 1, recvCols: 720 }), // 只走采集重复分支，不触发来料区闸
    receivingOn: () => false, locRecv: (l) => /^NB04-/.test(String(l || '')),
    // ㉖v168 labelStatus 新增【预占表 locReserve】盲窗查重，内部依赖 resTtlMs，须一并抽出真实函数，
    // 否则 ReferenceError。reserveTtlMin 不注入——真实 resTtlMs 对缺失参数自兜底 10 分钟（不写死数值以免漂移）。
    // 本套件沙箱 db 无 locReserve，该分支恒不触发，原有断言不受影响。
  });
  vm.runInContext(topFn('resTtlMs') + '\n' + topFn('localDT') + '\n' + topFn('labelStatus') + '\n' + topFn('labelBlockReason'), ctx);
  return ctx;
}
const reasonOf = (db, code) => { const c = mk(db); return vm.runInContext(`(function(){const st=labelStatus(${JSON.stringify(code)});return st?labelBlockReason(st,'in'):null})()`, c); };

// ===== A 真实数据：提示里不再把货位标成"批次" =====
{
  // 找一个"有流水但已不在账本"的真实标签（走 inScanlog 分支）
  const onLed = new Set((REAL.ledger || []).map(x => String(x.c || '').toUpperCase()));
  const cand = Object.values(REAL.scanlog || {}).filter(s => !s.cx && String(s.code || '').trim() && !onLed.has(String(s.code).toUpperCase()) && (s.gl || s.st));
  T('A0 找到可验证的真实样本', cand.length > 0, '可用标签 ' + cand.length + ' 个');
  if (cand.length) {
    const code = String(cand[0].code).toUpperCase();
    const msg = reasonOf(REAL, code);
    T('A1 触发到采集重复提示', typeof msg === 'string' && /已有采集记录/.test(msg), String(msg).slice(0, 110));
    T('A2 ★不再出现「批次 NB0x-」这种把货位当批次写法', !/批次\s*NB0/.test(String(msg)), String(msg).slice(0, 110));
    T('A3 位置以「登在」呈现', /登在 /.test(String(msg)), true);
    T('A4 时间已带上（YYYY-MM-DD HH:mm）', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(msg)), true);
    // ★ 收紧：上一版写成 (a&&b)||c，因优先级实际只要 c 成立即过，属弱断言。
    // 人名必须取自该标签【最近一条】流水（提示就是按最近一次生成的），不能取 cand[0].op，
    // 否则首条与最近条操作人不同时会假失败。
    const latestA = Object.values(REAL.scanlog || {})
      .filter(x => !x.cx && String(x.code || '').toUpperCase() === code)
      .sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0))[0];
    const opName = String((latestA && latestA.op) || '').trim();
    T('A5 登记人紧邻出现在「登在」之前', opName ? new RegExp(opName + '\\s*登在').test(String(msg)) : /登在/.test(String(msg)), 'op=' + opName + ' → ' + String(msg).slice(0, 110));
  }
}

// ===== B 真实批次值：必须挑【有 lot 且不在账本】的标签，确保真走到 inScanlog 分支 =====
// ★ 上一版这里用"按时间倒序取第一条带 lot 的流水"选样，结果那条【已在账本】→ 走「已在库」分支，
//   下面的 B2 被 if(has) 静默跳过 = 核心断言根本没跑（假绿）。选样必须先排除在账标签。
{
  const onLed2 = new Set((REAL.ledger || []).map(x => String(x.c || '').toUpperCase()));
  const candLot = Object.values(REAL.scanlog || {})
    .filter(s => !s.cx && s.lot && String(s.code || '').trim() && !onLed2.has(String(s.code).toUpperCase()))
    .sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0));
  T('B0 存在带 lot 且不在账本的真实样本', candLot.length > 0, candLot.length + ' 条');
  if (candLot.length) {
    const s = candLot[0];
    const code = String(s.code).toUpperCase();
    const msg = reasonOf(REAL, code);
    T('B1 ★该样本确实走到「已有采集记录」分支（非被在账分支跳过）', /已有采集记录/.test(String(msg)), String(msg).slice(0, 110));
    // 该标签可能有多条流水：提示取的是最近一次，故期望值=该标签最近一条带 lot 记录的 lot
    const latest = Object.values(REAL.scanlog || {}).filter(x => !x.cx && String(x.code || '').toUpperCase() === code).sort((a, b) => (Number(b.t) || 0) - (Number(a.t) || 0))[0];
    T('B2 ★提示中批次值等于最近一次流水的 lot（非 batch、非货位）', String(msg).includes('批次 ' + String(latest.lot)), '期望 lot=' + latest.lot + '（batch=' + s.batch + '）→ ' + String(msg).slice(0, 130));
    T('B3 批次未误取采集会话号 batch（B2026- 样式）', !/批次 B2026-/.test(String(msg)), true);
  }
}

// ===== C 合成挪位场景：必须提示【最近一次】位置（真实数据里难造，用内存副本）=====
{
  const db = JSON.parse(JSON.stringify(REAL));
  const CODE = 'N9T000001';
  db.ledger = (db.ledger || []).filter(x => String(x.c || '').toUpperCase() !== CODE);
  for (const k of Object.keys(db.scanlog || {})) if (String(db.scanlog[k].code || '').toUpperCase() === CODE) delete db.scanlog[k];
  delete (db.seenIn || {})[CODE]; delete (db.seenOut || {})[CODE];
  // 键序故意让"最早那条"排在前面（模拟 Object.values 键序≠时间序）
  db.scanlog['K_OLD|B1|1000'] = { code: CODE, wt: 1, gl: 'NB03-F-04-02', lot: '2026-11-01', batch: 'B2026-11-11-0900', op: '旧操作人', t: 1000, cx: false };
  db.scanlog['K_NEW|B2|9000'] = { code: CODE, wt: 1, gl: 'NB03-A-14-07', lot: '2026-11-11', batch: 'B2026-11-12-1113', op: '刘向轩', t: 9000, cx: false };
  const msg = reasonOf(db, CODE);
  T('C1 触发到采集重复提示', /已有采集记录/.test(String(msg)), String(msg).slice(0, 140));
  T('C2 ★提示取【最近一次】位置 A-14-07，而非键序首条 F-04-02', /登在 NB03-A-14-07/.test(String(msg)) && !/F-04-02/.test(String(msg)), String(msg).slice(0, 140));
  T('C3 批次取最近一次的 lot=2026-11-11', /批次 2026-11-11/.test(String(msg)) && !/批次 2026-11-01/.test(String(msg)), true);
  T('C4 登记人取最近一次的刘向轩', /刘向轩/.test(String(msg)) && !/旧操作人/.test(String(msg)), true);
}

// ===== D 对照：旧写法会怎样（证明本次修复非空改）=====
{
  const db = JSON.parse(JSON.stringify(REAL));
  const CODE = 'N9T000002';
  db.ledger = (db.ledger || []).filter(x => String(x.c || '').toUpperCase() !== CODE);
  delete (db.seenIn || {})[CODE]; delete (db.seenOut || {})[CODE];
  db.scanlog['K1'] = { code: CODE, wt: 1, gl: 'NB03-F-04-02', lot: '2026-11-01', op: '甲', t: 1000, cx: false };
  db.scanlog['K2'] = { code: CODE, wt: 1, gl: 'NB03-A-14-07', lot: '2026-11-11', op: '乙', t: 9000, cx: false };
  const c = mk(db);
  const oldMsg = vm.runInContext(`(function(){const st=labelStatus(${JSON.stringify(CODE)});return '该标签已有采集记录（批次 '+String(st.inScanlog[0].gl||st.inScanlog[0].st||'')+'），禁止重复录入'})()`, c);
  const newMsg = vm.runInContext(`(function(){const st=labelStatus(${JSON.stringify(CODE)});return labelBlockReason(st,'in')})()`, c);
  T('D1 旧写法确实错标货位为批次', /批次 NB03-F-04-02/.test(oldMsg), oldMsg);
  T('D2 旧写法取的是键序首条（F-04-02）', /F-04-02/.test(oldMsg) && !/A-14-07/.test(oldMsg), true);
  T('D3 新写法两处都纠正', /登在 NB03-A-14-07/.test(newMsg) && !/批次 NB0/.test(newMsg), String(newMsg).slice(0, 140));
}

// ===== E 其他分支未被我改动波及 =====
{
  const db = JSON.parse(JSON.stringify(REAL));
  const inLed = (REAL.ledger || [])[0];
  if (inLed) { const m = reasonOf(db, String(inLed.c).toUpperCase()); T('E1 在库标签仍走「已在库」分支', /已在库/.test(String(m)) || m === '', String(m).slice(0, 90)); }
  const ob = Object.values(REAL.outbound || {})[0];
  if (ob && (ob.items || [])[0]) {
    const bc = String((ob.items[0].barcode || ob.items[0].code || '')).toUpperCase();
    if (bc) {
      const c2 = mk(db);
      const m = vm.runInContext(`(function(){const st=labelStatus(${JSON.stringify(bc)});return st?labelBlockReason(st,'out'):null})()`, c2);
      // ★ 收紧：上一版正则末尾留了空分支（`|`结尾）→ 恒真，等于没断言。
      // 出库目的下要求：给出出库/发料类原因，且绝不串入采集重复文案（本次只改了 in 分支）。
      T('E2 出库重复提示未受影响', String(m) === '' || (/出库单|发料|出库/.test(String(m)) && !/已有采集记录/.test(String(m))), String(m).slice(0, 90));
    }
  }
  const c3 = mk(db);
  const m2 = vm.runInContext(`(function(){const st=labelStatus("N9T000099");return st?labelBlockReason(st,'in'):null})()`, c3);
  T('E3 全新标签不被误拦（无历史不报重复）', m2 === '' , JSON.stringify(m2));
}

console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
