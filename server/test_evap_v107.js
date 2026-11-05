// ㉖v107 蒸发框修正审计佐证 · 真实快照对撞取证（只读）
const fs = require('fs'), path = require('path');
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const A = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/snapshots/ledger-20261103.json'), 'utf8'));
const B = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/snapshots/ledger-20261104.json'), 'utf8'));
const ma = {}, mb = {};
for (const x of A.items || []) ma[String(x.c).toUpperCase()] = x;
for (const x of B.items || []) mb[String(x.c).toUpperCase()] = x;
const _obv = {}; for (const o of Object.values(d.outbound || {})) for (const i of o.items || []) { const bc = String(i.barcode || '').toUpperCase(); if (bc) _obv[bc] = 1; }
const _snapAt = Date.parse(A.at) || 0;
const _fxv = {}; for (const f of d.ledgerFixes || []) { if (f.act === '消位' && (Date.parse(f.time) || 0) >= _snapAt) _fxv[String(f.code || '').toUpperCase()] = 1; }
// 旧判据（两源佐证）=当前库视图（R2b 用）与新判据（三源佐证）在下方断言区计算
let okNew = 0, manualNew = 0; const evapNew = [];
for (const c of Object.keys(ma)) {
  if (mb[c]) continue;
  if (_obv[c] || (d.seenOut || {})[c]) { okNew++; continue; }
  if (_fxv[c]) { manualNew++; continue; }
  evapNew.push(c);
}
console.log('=== 截图时点复现（快照A=11/3 18:15 B=11/4 18:26）===');
const CS = ['SYS001437', 'N26J290080', 'N26J290085', 'N26J290079', 'N26J310085', 'N26J310080'];
// 截图时刻（18:26）080/085/079 的转单尚未完成（18:31 才落库）——旧判据当时无出库佐证。
// 取证不依赖主库时刻：显式构造【截图时刻视图】（这三码的出库单/承诺视为不存在）跑旧判据
const _obvAt = Object.assign({}, _obv), _soAt = Object.assign({}, d.seenOut || {});
for (const c of ['N26J290080', 'N26J290085', 'N26J290079']) { delete _obvAt[c]; delete _soAt[c]; }
const evapAt = [];
for (const c of Object.keys(ma)) { if (mb[c]) continue; if (_obvAt[c] || _soAt[c]) continue; evapAt.push(c); }
T('R1 六框当时都在A快照、都不在B快照（蒸发前提成立）', CS.every((c) => ma[c] && !mb[c]), true);
T('R2 截图时刻旧判据报蒸发=6（截图"蒸发框 6"精确复现）', [evapAt.length, CS.every((c) => evapAt.includes(c))], [6, true]);
let okOld = 0; const evapOld = [];
for (const c of Object.keys(ma)) { if (mb[c]) continue; if (_obv[c] || (d.seenOut || {})[c]) { okOld++; continue; } evapOld.push(c); }
T('R2b 当前库旧判据报蒸发=3（转单窗口期3个已自愈，印证时序误报定性）', evapOld.length, 3);
T('R3 新判据三源佐证后报蒸发=0（出库单吸收3个+修正消位吸收3个）', evapNew.length, 0);
T('R4 吸收明细：SYS001437/310085/310080 走修正消位佐证', CS.filter((c) => !evapNew.includes(c) && _fxv[c] && !_obv[c] && !(d.seenOut || {})[c]), ['SYS001437', 'N26J310085', 'N26J310080']);
T('R5 吸收明细：080/085/079 走出库单+承诺佐证（转单完成后自动闭环）', CS.filter((c) => !evapNew.includes(c) && (_obv[c] || (d.seenOut || {})[c])), ['N26J290080', 'N26J290085', 'N26J290079']);
T('R6 新判据计数自洽：出库吸收+消位吸收+报出=旧报出总数', okNew + manualNew + evapNew.length, okOld + evapOld.length);
T('R7 修正审计只认快照后消位（11/3前的历史消位不得吸收）', (() => { const before = (d.ledgerFixes || []).filter((f) => f.act === '消位' && (Date.parse(f.time) || 0) < _snapAt).map((f) => String(f.code || '').toUpperCase()); return before.every((c) => !ma[c] || mb[c]); })(), true);
T('R8 数量变化=1且正是v103件数对账纠正的框（修复生效实证）', (() => { const v = []; for (const c of Object.keys(ma)) { if (!mb[c]) continue; if ((Number(mb[c].q) || 0) !== (Number(ma[c].q) || 0)) v.push(c + '(' + ma[c].q + '→' + mb[c].q + ')'); } return v; })(), ['N26J230463(300→220)']);
console.log('\n=== 源码断言 ===');
const sv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
T('S1 第三佐证构建（消位+快照后时刻）', /f\.act === '消位' && \(Date\.parse\(f\.time\) \|\| 0\) >= _snapAt/.test(sv), true);
T('S2 判据链插入位置正确（出库佐证后、报蒸发前）', /_evOk\+\+; continue; \} if \(_fxv\[c\]\) \{ _evManual\+\+; continue; \}/.test(sv), true);
T('S3 noteB 文案带消位归因计数', /个为网页修正消位/.test(sv), true);
T('S4 墓碑不作佐证（保守口径注释在位）', /墓碑不算佐证/.test(sv), true);
console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
