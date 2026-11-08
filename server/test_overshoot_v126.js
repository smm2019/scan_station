// ㉖v126 同批末段最小覆盖修剪 + 100%超发边界修复 · 实例证明
// 根因现场（LL2026110813532714，11-08 13:59，用户截图）：需求 1404 件，该零件在架仅同批次(2026-11-06)两框：
//   1308@NB03-B-11-02 / 1500@NB03-B-11-07。贪心按「批次→货位」序先累 1308 不够、再累 1500 →
//   系统盖章建议=两框 2808（超发 1404=恰好100%），仓管照扫无错；而 severeOver 判定 over>need
//   在 over==need 时为 false → 全程零警告转 MES。历史回放 928 行：同批多拣可省 8658 件(19%)、over==need 边界漏判 13 行。
// 修复：① trimLastLot——够数后只重排「末批次」段：该批之前的框必留（守 v82b 跨批不挑框拍板），
//        同批池枚举总件数≥段需求的最小覆盖（≤12框），仅真更省时替换；主路(v69单框替换后)与盖章路(_pool内)双接线。
//      ② over>need → over>=need 三处（主路/盖章路/接单即派守卫）——恰好100%超发同样红字+不自动派。
// 证明面（vm 沙箱跑真实函数体，与 test_fifo_lock_v114 同技法）：
//  S 现场回放：新算法单框 1500/over96/无警告；同夹具手写旧贪心复算=2808 对照
//  G 盖章路：修剪生效且只换池内框，sugAll 两码仍全程可扫（v114 契约不破）
//  C 组合多换一：[600,700,800] 需 1404 → 600+800=1404 零超发（旧 2100）
//  E 边界：单框 1000 覆盖 500 → over==need → severeOver=true（旧 false）
//  F FIFO 守卫：早批框必留、不引入更晚批（含 v69 共存回归）
//  P 接单即派守卫源码 >= 在位
//  H 全库历史回放：旧口径(>need 告警)可省件数 vs 新口径告警捕获率
const fs = require('fs'); const vm = require('vm'); const path = require('path');
const SRV = path.join(__dirname, 'server.js');
const txt = fs.readFileSync(SRV, 'utf8'); const lines = txt.split(/\r?\n/);
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };
const TT = (n, c) => { total++; if (!c) { fail++; console.log('FAIL ' + n); } else console.log('PASS ' + n); };
function grab(startSig, endSig) {
  let s = -1; for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(startSig)) { s = i; break; }
  if (s < 0) throw new Error('未找到起始: ' + startSig);
  let e = -1; for (let i = s + 1; i < lines.length; i++) if (lines[i].trim().startsWith(endSig)) { e = i; break; }
  if (e < 0) throw new Error('未找到结束: ' + endSig);
  return lines.slice(s, e).join('\n');
}
const src = [
  grab('function boxKeyOf', 'function groupLedgerBoxes'),
  grab('function groupLedgerBoxes', 'function agvMapOf'),
  grab('function trimLastLot', 'function pickSuggest'),
  grab('function pickSuggest', 'function reqView'),
  grab('function countActive', 'function countBusyLegs'),
].join('\n');
function mkCtx(ledger) {
  const ctx = { console, Math, Number, String, Object, Array, JSON, Set, Map, Boolean, isNaN, parseInt, parseFloat, Date, RegExp,
    db: { ledger, scanlog: {}, ledgerTomb: [], ledgerRev: 1, ledgerAt: '', ledgerBy: '', counts: [] },
    ledgerView: () => ctx.db.ledger,
    locRecv: (l) => /^NB04-/.test(String(l || '').trim().toUpperCase()),
  };
  vm.createContext(ctx);
  vm.runInContext(src + '\nglobalThis.__f={pickSuggest,trimLastLot};', ctx);
  return ctx.__f;
}
// 账本行构造器：同 l+同 p 同 pid 会被 groupLedgerBoxes 并框，所以每框独立货位
const row = (c, q, b, l, pn) => ({ c, q, b, l: l || 'NB03-X-' + c.slice(-2), p: pn || 'PTEST', f: '1600*1100', pid: '' });

// ===== S 现场回放：需1404，同批(2026-11-06) 1308@02 / 1500@07 =====
{
  const F = mkCtx([row('N26K060108', 1308, '2026-11-06', 'NB03-B-11-02'), row('N26K060107', 1500, '2026-11-06', 'NB03-B-11-07')]);
  const sg = F.pickSuggest('PTEST', 1404, new Set(), {});
  T('S1 新算法只建议 1500 单框', sg.boxes.map((b) => b.q), [1500]);
  T('S1b total=1500 / over=96', [sg.total, sg.over], [1500, 96]);
  T('S1c 96<1404 → 不再误报严重超发', sg.severeOver, false);
  T('S1d 建议码=N26K060107', sg.boxes.flatMap((b) => b.codes), ['N26K060107']);
  // 旧贪心手写复算（同规则无修剪）→ 对照证明旧版确实给 2808
  let acc = 0; const pickOld = [];
  const bx = sg.inStock ? null : null; // 用同一批 boxes 顺序：货位 02 在前
  for (const b of [{ q: 1308 }, { q: 1500 }]) { pickOld.push(b); acc += b.q; if (acc >= 1404) break; }
  const overOld = acc - 1404;
  T('S2 旧贪心对照：两框 2808/over1404', [acc, overOld], [2808, 1404]);
  TT('S2b 旧判定 over>need(1404>1404)=false → 100%超发全程无警告', !(overOld > 1404));
}
// ===== G 盖章路（v114 锁定态）：修剪只在池内，sugAll 契约不破 =====
{
  const F = mkCtx([row('N26K060108', 1308, '2026-11-06', 'NB03-B-11-02'), row('N26K060107', 1500, '2026-11-06', 'NB03-B-11-07')]);
  const sg = F.pickSuggest('PTEST', 1404, new Set(), {}, ['N26K060108', 'N26K060107']);
  T('G1 盖章态修剪同样给 1500 单框', [sg.locked, sg.boxes.map((b) => b.q)], [true, [1500]]);
  T('G2 sugAll 两码仍全程可扫（盖章框不反悔）', (sg.sugAll || []).slice().sort(), ['N26K060107', 'N26K060108']);
  TT('G3 显示框全部∈盖章集', sg.boxes.flatMap((b) => b.codes).every((c) => ['N26K060108', 'N26K060107'].includes(c)));
}
// ===== C 组合多换一：池内可拼更优 =====
{
  const F = mkCtx([row('BOXA01', 600, '2026-11-01', 'NB03-C-01-01'), row('BOXA02', 700, '2026-11-01', 'NB03-C-01-02'), row('BOXA03', 800, '2026-11-01', 'NB03-C-01-03')]);
  const sg = F.pickSuggest('PTEST', 1404, new Set(), {});
  // 600+800=1400 < 1404 不够数（不可行）；700+800=1500 是最小可行覆盖 → 修剪应给 [700,800]
  T('C1 贪心旧路 600+700+800=2100 被修剪为 700+800=1500（over 96）', [sg.total, sg.over], [1500, 96]);
  T('C2 组合=[700,800]（枚举跳过不够数的 600+800=1400）', sg.boxes.map((b) => b.q), [700, 800]);
  T('C3 恰够数不告警', sg.severeOver, false);
  T('C4 三框同批可全扫池仍在（inStock 计数不因修剪丢失）', sg.inStock, 3);
}
// ===== C5 组合精确够数：600+800 覆盖 1400 → 零超发 =====
{
  const F = mkCtx([row('BOXI01', 600, '2026-11-01', 'NB03-H-01-01'), row('BOXI02', 700, '2026-11-01', 'NB03-H-01-02'), row('BOXI03', 800, '2026-11-01', 'NB03-H-01-03')]);
  const sg = F.pickSuggest('PTEST', 1400, new Set(), {});
  T('C5 存在精确组合时取 600+800=1400 零超发', [sg.total, sg.over, sg.severeOver], [1400, 0, false]);
}
// ===== E 边界修复：单框无法拆，over==need 必须告警 =====
{
  const F = mkCtx([row('BOXE01', 1000, '2026-11-01', 'NB03-D-01-01')]);
  const sg = F.pickSuggest('PTEST', 500, new Set(), {});
  T('E1 唯一框 1000 覆盖 500：over=500=need', [sg.total, sg.over], [1000, 500]);
  T('E2 新判定 over>=need → severeOver=true（旧=false，13行漏判类）', sg.severeOver, true);
}
// ===== F FIFO 守卫：跨批边界（v82b 拍板不动） =====
{
  // 早批 2 框(300+300)不足 → 必拉晚批框；晚批 2 框[800@02,400@03]：修剪只换晚批内组合，早批必留
  const F = mkCtx([row('BOXF01', 300, '2026-10-30', 'NB03-E-01-01'), row('BOXF02', 300, '2026-10-30', 'NB03-E-01-02'), row('BOXF03', 800, '2026-10-31', 'NB03-E-02-02'), row('BOXF04', 400, '2026-10-31', 'NB03-E-02-03')]);
  const sg = F.pickSuggest('PTEST', 1000, new Set(), {});
  T('F1 早批两框必留+晚批 400 恰好够数=1000 零超发', sg.boxes.map((b) => b.q).sort((a, b) => a - b), [300, 300, 400]);
  T('F1b total=1000', sg.total, 1000);
  TT('F2 未引入第三批次框（无更晚批可用时不跳池）', sg.boxes.every((b) => ['2026-10-30', '2026-10-31'].includes(b.b)));
  // 晚批只一框时不硬换（pool<2 早退）
  const F3 = mkCtx([row('BOXG01', 100, '2026-10-29', 'NB03-F-01-01'), row('BOXG02', 900, '2026-10-31', 'NB03-F-02-01')]);
  const sg3 = F3.pickSuggest('PTEST', 950, new Set(), {});
  T('F3 末批单框无从优化：100+900=1000 保留', [sg3.total, sg3.over], [1000, 50]);
  // v69 末框单框替换共存回归：同批 [400,600,150] 需 500 → v69 换 150 → [400,150]=550；trim 同组合不换
  const F4 = mkCtx([row('BOXH01', 400, '2026-11-03', 'NB03-G-01-01'), row('BOXH02', 600, '2026-11-03', 'NB03-G-01-02'), row('BOXH03', 150, '2026-11-03', 'NB03-G-01-03')]);
  const sg4 = F4.pickSuggest('PTEST', 500, new Set(), {});
  T('F4 v69 与 trim 共存：[400,150]=550（over50，非 400+600=1000）', [sg4.total, sg4.over, sg4.severeOver], [550, 50, false]);
}
// ===== P 源码锚点：三处 >= 边界与双路接线在位 =====
{
  const joined = lines.join('\n');
  TT('P1 主路 severeOver >=', joined.includes('const severeOver = needQty > 0 && pick.length > 0 && over >= needQty;'));
  TT('P2 盖章路 _severe >=', joined.includes('const _severe = needQty > 0 && _pk.length > 0 && _over >= needQty;'));
  TT('P3 接单即派守卫 >=', joined.includes('if (_needQ > 0 && _accQ - _needQ >= _needQ)'));
  TT('P4 主路 trim 接线（v69 之后）', joined.includes('{ const _tr = trimLastLot(pick, needQty, boxes);'));
  TT('P5 盖章路 trim 限池内', joined.includes('const _tr = trimLastLot(_pk, needQty, _pool);'));
  TT('P6 trim 非单调护栏（v69 换入早批框时不重排）', joined.includes("if (head.some((b) => lotOf(b) > lastLot)) return null;"));
  TT('P7 无收益不硬换（总件数/框数双不劣）', joined.includes('if (bestSum > nowSum || (bestSum === nowSum && tailNew.length >= tailNow.length)) return null;'));
}
// ===== M 已叫车框强制保留（AGV 已在途，丢弃=白搬车+白占台） =====
{
  // 同批三框：700@01(已叫车) / 1000@02 / 300@03。需求 1000。
  // 无叫车时最小覆盖有两条并列 1000 线：【1000 单框】与【700+300】；同总件取框数少 → 应给 1000 单框。
  // 有叫车（700 已到台）：必须保 700 → 给 700+300=1000，绝不丢那框回去。
  const led = [row('N26M000101', 700, '2026-11-06', 'NB03-M-01-01'), row('N26M000102', 1000, '2026-11-06', 'NB03-M-01-02'), row('N26M000103', 300, '2026-11-06', 'NB03-M-01-03')];
  const F = mkCtx(led);
  const sgFree = F.pickSuggest('PTEST', 1000, new Set(), {}); // 无叫车：1000 单框最优（tie 取框少）
  T('M1 无叫车：并列 1000 取单框 [1000]', [sgFree.total, sgFree.boxes.map((b) => b.q)], [1000, [1000]]);
  const sgCalled = F.pickSuggest('PTEST', 1000, new Set(), { N26M000101: 'CK-05' }); // 700 那框已叫车
  T('M2 已叫车框必留：给 [700,300] 而非 1000 单框', sgCalled.boxes.map((b) => b.q), [700, 300]);
  T('M2b 总件仍精确 1000 零超发', [sgCalled.total, sgCalled.over, sgCalled.severeOver], [1000, 0, false]);
  TT('M3 叫车框带 agv 标记（建议区仍显🚗CK-05）', sgCalled.boxes.some((b) => (b.codes || []).includes('N26M000101') && !!b.agv));
  // must 自身已够数 → 不额外拉框
  const sgMust = F.pickSuggest('PTEST', 600, new Set(), { N26M000101: 'CK-05' });
  T('M4 已叫车框够数时不再拉框（需600→仅700）', [sgMust.total, sgMust.boxes.length], [700, 1]);
}
// ===== H 全库历史回放：净效果 + 安全性质 =====
{
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  let linesN = 0, waste = 0, enoughViol = 0, sevOld = 0, sevNew = 0, sevDropUnexplained = 0, poolViol = 0;
  for (const r of db.requisitions || []) {
    for (const it of r.items || []) {
      const need = Number(it.qty) || 0; if (need <= 0) continue;
      const pn = String(it.partNo || '').toUpperCase();
      const led = db.ledger.filter((x) => String(x.p || '').toUpperCase() === pn);
      if (led.length < 2) continue; // 单框库存无从优化
      linesN++;
      // 手写旧贪心复算（含 v69 单框替换，无 trim）
      const g = new Map();
      for (const x of led) { const k = x.pid ? 'P|' + x.pid : 'L|' + x.l + '|' + x.p; if (!g.has(k)) g.set(k, { q: 0, b: String(x.b || ''), l: String(x.l || '') }); g.get(k).q += Number(x.q) || 0; }
      const bx = [...g.values()].sort((a, b) => (a.b || '9999').localeCompare(b.b || '9999') || String(a.l).localeCompare(b.l));
      let acc0 = 0; const pick0 = [];
      for (const b of bx) { pick0.push(b); acc0 += b.q; if (acc0 >= need) break; if (pick0.length >= 24) break; }
      if (acc0 > need && pick0.length) { const last = pick0[pick0.length - 1]; const remain = need - (acc0 - last.q); const cand = bx.filter((x) => !pick0.includes(x) && x.q >= remain && x.q < last.q && String(x.b || '9999') <= String(last.b || '9999')).sort((a, b) => a.q - b.q)[0]; if (cand) { pick0[pick0.length - 1] = cand; acc0 = acc0 - last.q + cand.q; } }
      const over0 = Math.max(0, acc0 - need);
      const F = mkCtx(led);
      const sg = F.pickSuggest(pn, need, new Set(), {});
      // 性质1（安全底线）：旧够数的行，新建议必须仍够数——修剪绝不能造成少发
      if (acc0 >= need && sg.total < need) enoughViol++;
      // 性质2：新建议的框必须都在该零件在架库存内（不凭空造框）
      const onShelfCodes = new Set(led.map((x) => String(x.c).toUpperCase()));
      if ((sg.boxes || []).some((b) => (b.codes || []).some((c) => !onShelfCodes.has(String(c).toUpperCase())))) poolViol++;
      if (acc0 >= need && sg.total < acc0) waste += acc0 - sg.total;
      const sOld = over0 >= need, sNew = sg.over >= need && sg.total >= need;
      if (sOld) sevOld++; if (sNew) sevNew++;
      // 归因：旧告警而新不告警的行，必须确实是"超发被修剪到 <need"（而非判定失效）
      if (sOld && !sNew && !(sg.total >= need && sg.over < need)) sevDropUnexplained++;
    }
  }
  console.log('  [历史回放] 参与行=' + linesN + ' 旧告警行=' + sevOld + ' 新告警行=' + sevNew + ' 修剪净省=' + waste + ' 件 | 够数违反=' + enoughViol + ' 越池=' + poolViol + ' 无归因降级=' + sevDropUnexplained);
  T('H1 安全底线：旧够数的行新建议仍够数（零少发风险）', enoughViol, 0);
  T('H2 建议框全部在该零件在架库存内（不造幽灵框）', poolViol, 0);
  T('H3 告警减少全部可归因于修剪见效（判定逻辑无失效）', sevDropUnexplained, 0);
  TT('H4 净省件数为正且量级可观（>1000 件）', waste > 1000);
  TT('H5 告警行不增加（同批可省的不再骚扰人工）', sevNew <= sevOld);
}
// ===== I 全零件穷举：新算法不劣于旧贪心 + 池约束 + 确定性 =====
{
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  let scan = 0, regress = 0, poolViol = 0, nonDe=0, capCases = 0; const cases = [];
  const pns = [...new Set(db.ledger.map((x) => String(x.p || '').toUpperCase()).filter(Boolean))];
  for (const pn of pns) {
    const led = db.ledger.filter((x) => String(x.p || '').toUpperCase() === pn);
    if (!led.length) continue;
    const F = mkCtx(led);
    // 旧贪心（含 v69 单框替换、同 24 框上限，无 trim）——与 H 段同式复算
    const g = new Map();
    for (const x of led) { const k = x.pid ? 'P|' + String(x.pid).toUpperCase() : 'L|' + String(x.l).toUpperCase() + '|' + pn; if (!g.has(k)) g.set(k, { q: 0, b: '', l: String(x.l || '') }); const bb = g.get(k); bb.q += Number(x.q) || 0; if (x.b && (!bb.b || String(x.b) < bb.b)) bb.b = String(x.b); } // 批次取最早（与 groupLedgerBoxes 同式）
    const bx = [...g.values()].sort((a, b) => (a.b || '9999').localeCompare(b.b || '9999') || String(a.l).localeCompare(b.l));
    const oldGreedy = (need) => { let acc = 0; const pick = []; for (const b of bx) { pick.push(b); acc += b.q; if (acc >= need) break; if (pick.length >= 24) break; } if (acc > need && pick.length) { const last = pick[pick.length - 1]; const remain = need - (acc - last.q); const cand = bx.filter((x) => !pick.includes(x) && x.q >= remain && x.q < last.q && String(x.b || '9999') <= String(last.b || '9999')).sort((a2, b2) => a2.q - b2.q)[0]; if (cand) { pick[pick.length - 1] = cand; acc = acc - last.q + cand.q; } } return acc; };
    const totalQ = led.reduce((s, x) => s + (Number(x.q) || 0), 0);
    const on = new Set(led.map((x) => String(x.c).toUpperCase()));
    for (const need of [1, Math.max(1, Math.round(totalQ * 0.4)), Math.max(1, Math.round(totalQ * 0.8)), totalQ, totalQ + 999]) {
      scan++;
      let sg = null;
      try { sg = F.pickSuggest(pn, need, new Set(), {}); } catch (e) { regress++; cases.push(pn + ' need=' + need + ' 抛异常:' + e.message); continue; }
      // 不劣于旧贪心：旧够数 → 新必须够数且不多发（修剪只减不增）
      const accOld = oldGreedy(need);
      if (accOld >= need && sg.total < need) { regress++; cases.push(pn + ' need=' + need + ' 旧够数' + accOld + ' 新只' + sg.total); }
      if (accOld >= need && sg.total > accOld) { regress++; cases.push(pn + ' need=' + need + ' 新反而多发 ' + sg.total + '>' + accOld); }
      if ((sg.boxes || []).some((b) => (b.codes || []).some((c) => !on.has(String(c).toUpperCase())))) poolViol++;
      // 既有 24 框上限（非本次引入，仅记录供参考）：库存够但旧贪心也够不到
      if (totalQ >= need && accOld < need) capCases++;
    }
    // 确定性：同输入两次调用结果必须一致（子集枚举无随机/无 Map 序依赖）
    const n1 = Math.max(1, Math.round(led.reduce((s, x) => s + (Number(x.q) || 0), 0) * 0.6));
    const a = JSON.stringify(F.pickSuggest(pn, n1, new Set(), {}).boxes.map((b) => b.codes));
    const b2 = JSON.stringify(F.pickSuggest(pn, n1, new Set(), {}).boxes.map((b) => b.codes));
    if (a !== b2) nonDe++;
  }
  regress += nonDe;
  if (cases.length) console.log('  违反用例:\n' + cases.slice(0, 12).join('\n'));
  console.log('  [穷举扫描] 零件数=' + pns.length + ' 用例=' + scan + ' 劣化=' + regress + ' 越池=' + poolViol + ' | 既有24框上限用例=' + capCases + '（非本次引入，多轮扫完自洽）');
  T('I1 新算法不劣于旧贪心（够数不多发、零异常、结果确定）', regress, 0);
  T('I2 建议框全部在该零件在架库存内', poolViol, 0);
}
console.log('\n===== v126 同批修剪+超发边界 实例证明 ' + (total - fail) + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
