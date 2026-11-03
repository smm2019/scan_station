// ㉖v103 档案双计/汇总0框/出库漏记 三缺陷修复 · 判据复刻 + 11/3 现场数据回放
// 复刻 inventory_stock_page.dart 两处修复逻辑 + server.js 兜底补建新判据（Node版），只读取证
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const P = '8889330048', C90 = 'N26J300090', C107 = 'N26J290107';

console.log('===== 现场事实基线（服务器数据，不可变）=====');
const led = d.ledger || [];
const ledCodes = new Set(led.map((x) => String(x.c).toUpperCase()));
T('F1 服务器账本：300090 在架 A-04-1F 200件', (() => { const x = led.find((y) => String(y.c).toUpperCase() === C90); return x ? [x.l, Number(x.q)] : null; })(), ['NB02-A-04-1F', 200]);
T('F2 服务器账本：290107 已消位（不在账本）', ledCodes.has(C107), false);
const req = (d.requisitions || []).find((x) => x.no === 'LL2026110308231354');
const line = (req.items || []).find((i) => String(i.partNo).toUpperCase() === P);
T('F3 竞态误记账实况：行需400 记实发400 两框（含在库的300090）', [line.qty, line.transferQty, (line.issued || []).length], [400, 400, 2]);
const obHas = (bc) => Object.values(d.outbound || {}).some((o) => (o.items || []).some((i) => String(i.barcode || '').toUpperCase() === bc));
T('F4 出库台账只有290107（正确！300090实物未出库本就不该记）', [obHas(C107), obHas(C90)], [true, false]);

console.log('\n===== 缺陷一：档案页同码去重（复刻新算法）=====');
// 本机流水：300090 于 10/30、11/3 各有效扫一次（服务器流水实况，本机同源）
const recs = Object.values(d.scanlog || {}).filter((s) => String(s.pn || '').toUpperCase() === P).map((s) => ({ code: String(s.code).toUpperCase(), q: Number(s.q) || 0, t: Number(s.t) || 0, cx: !!s.cx })).sort((a, b) => a.t - b.t);
function profileBoxes(rs) { // 新判据：未作废按码取最新一条建框；作废逐条保留
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
function sumInStock(outCodesFromLedgerAndCache, placedSet) { // 新判据：账本在架码从"已出库"集合剔除
  const oc = new Set(outCodesFromLedgerAndCache);
  for (const c of [...oc]) if (placedSet.has(c.toUpperCase())) oc.delete(c);
  return oc;
}
const cacheOut = [C90, C107]; // 领料缓存+出库台账摊平（300090 曾发料在缓存内）
const fixed = sumInStock(cacheOut, ledCodes);
T('B1 旧算法：300090 被判已出库→汇总 0 框', cacheOut.includes(C90), true);
T('B2 新算法：账本在架→剔出已出库集合', fixed.has ? fixed.has(C90) : [...fixed].includes(C90), false);
T('B3 290107 不在账本→维持已出库判定（不误翻）', [...fixed].includes(C107), true);

console.log('\n===== 缺陷三（定性修正）：撤扫竞态误记账 + 补建在库排除 =====');
// 真相：300090 不是"漏记出库"——撤扫退回+10:45 重上架，实物从未出库；出库单只有 290107 本就正确。
// 错误在领料行：竞态把 300090 加回 issued → 转单回写记实发 400（应 200）+ 误登记 seenOut。
T('D1 竞态铁证：300090 在账本(在库) 且有转单后有效扫码', (() => {
  const inLed = ledCodes.has(C90);
  const rescan = Object.values(d.scanlog || {}).some((s) => String(s.code || '').toUpperCase() === C90 && !s.cx && (s.t || 0) > (line.transferAt || 0));
  return [inLed, rescan];
})(), [true, true]);
T('D2 误记账实况：行 transferQty=400 但 issued 含在库框', [line.transferQty, (line.issued || []).length], [400, 2]);
// 存量修正（复刻 reqRaceFixV103 三重判据）
function raceFix(db) {
  const ledOn = new Set((db.ledger || []).map((x) => String(x.c).toUpperCase()));
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
const rf = raceFix(d);
T('D3 全库竞态行=1（三重判据零误伤）', rf.n, 1);
T('D4 命中行=事故单，剔除300090 扣200 实发400→200', rf.out[0], { no: 'LL2026110308231354', pn: '8889330048', rm: [C90], cut: 200, newQty: 200 });
// 正常"转单后返架余料"不得命中：框转单后返架 = 不在本行 issued（已剔除）→ 判据②不成立
T('D5 判据不误伤已正常撤扫行（290107 不在账本→非竞态）', rf.out[0].rm.includes(C107), false);
// 补建防线：missing 必须排除在库框
function fixScan(outbound, requisitions, ledger) { // 新判据：missing=行内台账查无 且 不在账本 的码
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
const plan = fixScan(d.outbound, d.requisitions, d.ledger);
T('E1 在库排除：竞态框 300090 不被补建坐实（该单 0 计划）', plan.some((x) => x.no === 'LL2026110308231354' && String(x.pn).toUpperCase() === P), false);
// 真漏记对照：把 290107 从台账删掉（模拟 PDA 推送丢失），补建应命中它（已消位不在账本）
const d3 = JSON.parse(JSON.stringify(d));
for (const o of Object.values(d3.outbound || {})) o.items = (o.items || []).filter((i) => String(i.barcode || '').toUpperCase() !== C107);
const plan3 = fixScan(d3.outbound, d3.requisitions, d3.ledger);
T('E2 对照：真漏记的已消位框 290107 仍会被补建（防线不误伤补建本职）', plan3.some((x) => x.missing.some((m) => m.c === C107)), true);
// 修正后幂等：竞态行修完再扫=0
const d4 = JSON.parse(JSON.stringify(d));
const it4 = d4.requisitions.find((r) => r.no === 'LL2026110308231354').items.find((i) => String(i.partNo).toUpperCase() === P);
it4.issued = (it4.issued || []).filter((x) => String((typeof x === 'string' ? x : x.c) || '').toUpperCase() !== C90);
it4.transferQty = 200;
T('D6 修正后二次扫描幂等（0 竞态行）', raceFix(d4).n, 0);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
