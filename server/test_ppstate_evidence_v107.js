// ㉖v107 档案页四态 · 实例证明（用主库真实数据，非合成）
// 证明对象：11/4 现场截图实锤——6608225548 卡单期间"当前库存400 · 在库4框"同屏矛盾
// 数据源：db.json 真实账本/出库台账/领料单（不可变事实），旧新算法逐框对撞
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const P = '6608225548';
const BOXES = ['N26J270036', 'N26J310209', 'N26J250225', 'N26J250226'];

// ===== E1 真实足迹取证（截图里那 4 张框卡）=====
console.log('===== E1 四框在服务器里的真实足迹 =====');
const ledOn = new Set((d.ledger || []).filter((x) => String(x.p || '').toUpperCase() === P).map((x) => String(x.c).toUpperCase()));
const outCodes = new Set();
for (const o of Object.values(d.outbound || {})) for (const l of o.items || []) { const c = String(l.barcode || '').toUpperCase(); if (c) outCodes.add(c); }
const req = (d.requisitions || []).find((x) => x.no === 'LL2026110409555589');
const line = req.items.find((i) => String(i.partNo).toUpperCase() === P);
const issued = (line.issued || []).map((x) => String(x.c).toUpperCase());
console.log('  账本在架:', [...ledOn].join(','), '| 出库台账含:', BOXES.filter((c) => outCodes.has(c)).join(',') || '无', '| 卡单issued:', issued.join(','), '| transferred:', line.transferred === true);
T('E1a 270036/310209 在账本（真在架两框）', [ledOn.has('N26J270036'), ledOn.has('N26J310209')], [true, true]);
T('E1b 250225/250226 不在账本（实物已离架，入账也不复活）', [ledOn.has('N26J250225'), ledOn.has('N26J250226')], [false, false]);
// ㉖v107 两态兼容：主库可能仍卡单（accepted 未转），也可能已被 v107 自愈（ready 已转+出库单在案）——
// 两种实况都必须与算法推演自洽，断言对象是【算法正确】而非【主库停在哪个时刻】
const stuck = req.status === 'accepted' && line.transferred !== true;
if (stuck) {
  T('E1c 卡单态实况：无出库记录、行未转', [outCodes.has('N26J250225'), outCodes.has('N26J250226'), line.transferred === true], [false, false, false]);
} else {
  T('E1c 自愈态实况：行已转、两框出库记录在案（v107对账入账闭环实证）', [line.transferred === true, outCodes.has('N26J250225'), outCodes.has('N26J250226')], [true, true, true]);
}
T('E1d issued 恰含这两框（两态不变量）', issued.sort(), ['N26J250225', 'N26J250226']);

// ===== 算法复刻 =====
// 旧版逐框判定（v107 之前的 inStock getter）
const oldInStock = (c) => !c.cancelled && c.outTime == null;
// 新版四态（与 Dart ppState 逐分支一致）；pendOut=saveIssued 的 pending 集
function newPPState(c, pendOut) {
  if (c.cancelled) return '作废';
  if (c.outTime != null) return '已出库';
  const onLed = c.ledOn == null ? c.outTime == null : c.ledOn.has(c.barcode);
  if (onLed) return c.inTime == null ? '账本存量' : '在库';
  if (pendOut.has(c.barcode)) return '已发未转';
  return '账外';
}
// 真实缓存复刻：从主库全部领料单算 pending 集（与 Dart saveIssued 同逻辑）
function realPending() {
  const pending = new Set();
  for (const r of d.requisitions || []) {
    if (!['accepted', 'ready', 'done'].includes(r.status)) continue;
    const finished = r.status === 'ready' || r.status === 'done';
    for (const it of r.items || []) {
      if (!finished && it.transferred !== true) for (const x of it.issued || []) pending.add(String(typeof x === 'string' ? x : x.c).toUpperCase());
    }
  }
  return pending;
}
const pend = realPending();
const mkBox = (c) => ({ barcode: c, cancelled: false, outTime: null, ledOn, inTime: new Date('2026-10-25') }); // 四框都有入库流水（截图"入库"行可证）

// ===== E2 旧算法复现截图矛盾 =====
console.log('\n===== E2 旧算法回放：截图矛盾精确复现 =====');
const oldStates = BOXES.map((c) => oldInStock(mkBox(c)));
T('E2a 旧算法4框全判"在库"（截图"在库 4框"的来源）', oldStates, [true, true, true, true]);
const stockQty = (d.ledger || []).filter((x) => String(x.p || '').toUpperCase() === P).reduce((s, x) => s + (Number(x.q) || 0), 0);
T('E2b 头部库存走账本=400（截图"当前库存400"）——同屏 400 vs 4框 矛盾成立', stockQty, 400);

// ===== E3 新算法四态（对【卡单时刻形态】推演：outTime=null + pending 集含两码）=====
console.log('\n===== E3 新算法逐框判定 =====');
// 卡单时刻的 pending 集：stuck 时即主库真实值；已自愈则用当时的形态快照（两码在架外·未转·无出库记录）
const pendStuck = stuck ? pend : new Set([...pend, 'N26J250225', 'N26J250226']);
const newStates = BOXES.map((c) => newPPState(mkBox(c), pendStuck));
console.log('  ' + BOXES.map((c, i) => `${c}=${newStates[i]}`).join('  '));
T('E3a 真在架两框=在库', newStates[0] + '/' + newStates[1], '在库/在库');
T('E3b 卡单两框=已发未转（不再冒充在库）', newStates[2] + '/' + newStates[3], '已发未转/已发未转');
T('E3c 在库筛选计数 4→2（与库存400件自洽）', newStates.filter((s) => s === '在库' || s === '账本存量').length, 2);
T('E3d 头部计数分流：pendingBoxes=2 ghostBoxes=0', [BOXES.filter((c, i) => newStates[i] === '已发未转').length, BOXES.filter((c, i) => newStates[i] === '账外').length], [2, 0]);
if (stuck) {
  T('E3e pending集来自主库真实领料单（非硬编码）', [pend.has('N26J250225'), pend.has('N26J250226'), pend.has('N26J270036')], [true, true, false]);
} else {
  T('E3e 自愈后主库 pending 已不含两码（行已转，缓存自动摘除）', [pend.has('N26J250225'), pend.has('N26J250226')], [false, false]);
}

// ===== E4 v106 对账入账后的翻转（状态机推演）=====
console.log('\n===== E4 v106对账入账后：两框自动翻"已出库" =====');
// 入账效果（race/recon 端到端已实证服务器行为）：行 transferred=true → pending 集清空该码；
// 出库台账生成 → fillOut 置 outTime。用真实结构模拟入账后的两份数据：
const pendAfter = new Set([...pend].filter((c) => c !== 'N26J250225' && c !== 'N26J250226'));
const mkOut = (c) => ({ barcode: c, cancelled: false, outTime: new Date('2026-11-05'), ledOn, inTime: new Date('2026-10-25') });
T('E4a 入账后两框=已出库', [newPPState(mkOut('N26J250225'), pendAfter), newPPState(mkOut('N26J250226'), pendAfter)], ['已出库', '已出库']);
T('E4b 在库筛选仍=2（真在架两框不受影响）', ['N26J270036', 'N26J310209'].map((c) => newPPState(mkBox(c), pendAfter)), ['在库', '在库']);

// ===== E5 边界：离线回退 / 账外 / 作废优先 =====
console.log('\n===== E5 边界分支 =====');
T('E5a 离线(账本拉不到)回退旧口径不阻断', newPPState({ barcode: 'N26J250225', cancelled: false, outTime: null, ledOn: null, inTime: new Date() }, pend), '在库');
T('E5b 账本无·pending无·出库无 → 账外（幽灵框诚实身份）', newPPState({ barcode: 'SYNTH-GHOST-1', cancelled: false, outTime: null, ledOn, inTime: new Date() }, pend), '账外');
T('E5c 作废优先一切', newPPState({ barcode: 'N26J250225', cancelled: true, outTime: null, ledOn, inTime: new Date() }, pend), '作废');
T('E5d 账本命中优先于pending（同托兄弟码在架不误标）', newPPState({ barcode: 'N26J270036', cancelled: false, outTime: null, ledOn, inTime: new Date() }, new Set([...pend, 'N26J270036'])), '在库');

// ===== E6 检验入口连带收敛（inStock 语义变更下游）=====
console.log('\n===== E6 下游连带：卡单框不再给检验下架入口 =====');
const canInspOld = oldInStock(mkBox('N26J250225')); // 旧：在库→可检验下架（货已离架，会叉空）
const canInspNew = newPPState(mkBox('N26J250225'), pend) === '在库'; // 新：已发未转→非在库
T('E6a 旧算法卡单框可进检验入口（隐患）', canInspOld, true);
T('E6b 新算法卡单框排除在检验入口外', canInspNew, false);

console.log(fail === 0 ? '\n===== 实例证明：全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
