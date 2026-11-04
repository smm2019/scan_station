// ㉖v103 三缺陷（档案双计/汇总0框/竞态误记账）修复 · 判据复刻 + 现场数据回放
// 主库已被生产服务跑过迁移（修正态），判据不能依赖"主库停在哪个时刻"：
// 构造【修复前态】内存副本 dPre（注入误记账三要素），D/E 系列对 dPre 取证；F 系列验证主库现态=修正后。
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const P = '8889330048', C90 = 'N26J300090', C107 = 'N26J290107';
const led = d.ledger || [];
const ledCodes = new Set(led.map((x) => String(x.c).toUpperCase()));

// ===== 构造修复前态副本 dPre（reqRaceFixV103 未跑时的样子）=====
const dPre = JSON.parse(JSON.stringify(d));
const linePre = dPre.requisitions.find((x) => x.no === 'LL2026110308231354').items.find((i) => String(i.partNo).toUpperCase() === P);
linePre.transferQty = 400;
if (!(linePre.issued || []).some((e) => String(e.c || e).toUpperCase() === C90)) (linePre.issued = linePre.issued || []).push({ c: C90, q: 200, l: 'NB02-C-06-3F', b: '2026-10-30', f: '1800*1200_2', n: '03-吉利EX11右前地板上纵梁（国内版HSTD180168-1镭射' });
dPre.seenOut = dPre.seenOut || {};
dPre.seenOut[C90] = { at: Number(linePre.transferAt) || Date.now(), no: 'LL2026110308231354', by: '宋明明' };

const line = led && (d.requisitions.find((x) => x.no === 'LL2026110308231354').items.find((i) => String(i.partNo).toUpperCase() === P));
const obHas = (bc, src) => Object.values(src || {}).some((o) => (o.items || []).some((i) => String(i.barcode || '').toUpperCase() === bc));

console.log('===== 现场事实基线（不可变 + 两态闭环）=====');
T('F1 账本：300090 在架 A-04-1F 200件（实物从未出库，不可变）', (() => { const x = led.find((y) => String(y.c).toUpperCase() === C90); return x ? [x.l, Number(x.q)] : null; })(), ['NB02-A-04-1F', 200]);
T('F2 账本：290107 已消位（真实出库，不可变）', ledCodes.has(C107), false);
T('F3 修复前态：行记实发400、issued含在库框300090', [linePre.transferQty, (linePre.issued || []).length], [400, 2]);
T('F4 出库台账只有290107、无300090（实物未出库本就不该记，正确）', [obHas(C107, d.outbound), obHas(C90, d.outbound)], [true, false]);
T('F5 主库现态=已修正（transferQty=200、issued一框、承诺已撤）', [line.transferQty, (line.issued || []).length, !!(d.seenOut || {})[C90]], [200, 1, false]);

console.log('\n===== 缺陷一：档案页同码去重（复刻新算法，基于不可变流水）=====');
const recs = Object.values(d.scanlog || {}).filter((s) => String(s.pn || '').toUpperCase() === P).map((s) => ({ code: String(s.code).toUpperCase(), q: Number(s.q) || 0, t: Number(s.t) || 0, cx: !!s.cx })).sort((a, b) => a.t - b.t);
function profileBoxes(rs) {
  const latestValid = {};
  for (const r of rs) { if (!r.cx) latestValid[r.code] = r; }
  const valid = rs.filter((r) => !r.cx && latestValid[r.code] === r);
  const cancelled = rs.filter((r) => r.cx);
  return { valid, cancelCount: cancelled.length, inQty: valid.reduce((s, r) => s + r.q, 0) };
}
const pf = profileBoxes(recs);
T('A1 旧算法会建 3 框（300090×2+290107×1）双计', recs.filter((r) => !r.cx).length, 3);
T('A2 新算法去重后 2 框（300090 只留最新）', pf.valid.length, 2);
T('A3 累计入库=400（旧 600 虚高200）', pf.inQty, 400);
T('A4 300090 取最新一条（11/3 10:45）', pf.valid.find((r) => r.code === C90).t, Math.max(...recs.filter((r) => r.code === C90).map((r) => r.t)));
T('A5 作废记录逐条保留（不吞历史）', pf.cancelCount, recs.filter((r) => r.cx).length);

console.log('\n===== 缺陷二：汇总页在库判定=账本权威（复刻新算法）=====');
function sumInStock(outCodesFromLedgerAndCache, placedSet) {
  const oc = new Set(outCodesFromLedgerAndCache);
  for (const c of [...oc]) if (placedSet.has(c.toUpperCase())) oc.delete(c);
  return oc;
}
const cacheOut = [C90, C107];
const fixed = sumInStock(cacheOut, ledCodes);
T('B1 旧算法：300090 在缓存被判已出库', cacheOut.includes(C90), true);
T('B2 新算法：账本在架→剔出已出库集合', [...fixed].includes(C90), false);
T('B3 290107 不在账本→维持已出库判定（不误翻）', [...fixed].includes(C107), true);

console.log('\n===== 缺陷三：撤扫竞态误记账 + 补建在库排除（对 dPre 修复前态取证）=====');
T('D1 竞态铁证：300090 在账本(在库) 且有转单后有效扫码', (() => {
  const inLed = ledCodes.has(C90);
  const rescan = Object.values(d.scanlog || {}).some((s) => String(s.code || '').toUpperCase() === C90 && !s.cx && (s.t || 0) > (linePre.transferAt || 0));
  return [inLed, rescan];
})(), [true, true]);
function raceFix(db) {
  const ledOn = new Set((db.ledger || []).map((x) => String(x.c || '').toUpperCase()));
  let n = 0; const out = [];
  for (const r of db.requisitions || []) for (const it of r.items || []) {
    if (it.transferred !== true) continue;
    const rows = (it.issued || []).map((x) => (typeof x === 'string' ? { c: x, q: 0 } : { c: String(x.c || '').toUpperCase(), q: Number(x.q) || 0 }));
    const tAt = Number(it.transferAt) || 0;
    const race = rows.filter((e) => e.c && ledOn.has(e.c) && Object.values(db.scanlog || {}).some((s) => String(s.code || '').toUpperCase() === e.c && !s.cx && (Number(s.t) || 0) > tAt));
    if (!race.length) continue;
    const rm = new Set(race.map((e) => e.c));
    const cut = race.reduce((s, e) => s + e.q, 0);
    out.push({ no: r.no, pn: it.partNo, rm: [...rm], cut, newQty: (Number(it.transferQty) || 0) - cut });
    n++;
  }
  return { n, out };
}
const rf = raceFix(dPre);
T('D2 全库竞态行=1（三重判据零误伤）', rf.n, 1);
T('D3 命中行=事故单，剔除300090 扣200 实发400→200', rf.out[0], { no: 'LL2026110308231354', pn: P, rm: [C90], cut: 200, newQty: 200 });
T('D4 判据不误伤已真实出库框（290107 不在账本→非竞态）', rf.out[0].rm.includes(C107), false);
// 修正后幂等
const d4 = JSON.parse(JSON.stringify(dPre));
const it4 = d4.requisitions.find((r) => r.no === 'LL2026110308231354').items.find((i) => String(i.partNo).toUpperCase() === P);
it4.issued = (it4.issued || []).filter((x) => String((typeof x === 'string' ? x : x.c) || '').toUpperCase() !== C90);
it4.transferQty = 200;
T('D5 修正后二次扫描幂等（0 竞态行）', raceFix(d4).n, 0);
// 补建防线：missing 必须排除在库框
function fixScan(outbound, requisitions, ledger) {
  const obCodes = new Set();
  for (const o of Object.values(outbound || {})) for (const i of o.items || []) { const c = String(i.barcode || '').toUpperCase(); if (c) obCodes.add(c); }
  const ledOn = new Set((ledger || []).map((x) => String(x.c || '').toUpperCase()));
  const plan = [];
  for (const r of requisitions || []) for (const it of r.items || []) {
    if (it.transferred !== true) continue;
    const rows = (it.issued || []).map((x) => (typeof x === 'string' ? { c: x } : { c: String(x.c || '').toUpperCase(), q: Number(x.q) || 0 }));
    const missing = rows.filter((e) => e.c && !obCodes.has(e.c) && !ledOn.has(e.c));
    if (!rows.length || !missing.length) continue;
    plan.push({ no: r.no, pn: it.partNo, missing });
    for (const e of missing) obCodes.add(e.c);
  }
  return plan;
}
const plan = fixScan(dPre.outbound, dPre.requisitions, dPre.ledger);
T('E1 在库排除：竞态框 300090 不被补建坐实（该单 0 计划）', plan.some((x) => x.no === 'LL2026110308231354' && String(x.pn).toUpperCase() === P), false);
const d3 = JSON.parse(JSON.stringify(dPre));
for (const o of Object.values(d3.outbound || {})) o.items = (o.items || []).filter((i) => String(i.barcode || '').toUpperCase() !== C107);
const plan3 = fixScan(d3.outbound, d3.requisitions, d3.ledger);
T('E2 对照：真漏记的已消位框 290107 仍会被补建（防线不误伤补建本职）', plan3.some((x) => x.missing.some((m) => m.c === C107)), true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
