// ㉖v101 地面排格数设置修复 · 判据单测 + 真实数据只读回放
// 复刻 location_reg_page.dart _openGroundSlots 清单构建逻辑（Node版），断言区/排/默认值口径与服务器返回一致
const fs = require('fs');
let fail = 0, total = 0;
function T(name, got, want) { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `\n  got=${JSON.stringify(got)}\n want=${JSON.stringify(want)}`}`); }
const pad = (n) => String(n).padStart(2, '0');

// —— 判据复刻（与 Dart 逐字同逻辑）——
function buildRows(r) {
  const slots = r.slots || {}, def = r.def || {};
  const defCols = def.cols ?? 12, defRows = def.rows ?? 18;
  const zoneRows = r.rows || {}, lists = r.lists || {}, offs = r.offs || {};
  const rows = {};
  for (const z of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    const lst = lists[z];
    let rowArr;
    if (Array.isArray(lst) && lst.length) rowArr = lst.map(Number);
    else {
      const zr = zoneRows[z];
      const n = zr == null ? defRows : Number(zr);
      rowArr = []; for (let i = 1; i <= n; i++) rowArr.push(i);
    }
    for (const n of rowArr) { const k = `NB03-${z}-${pad(n)}`; rows[k] = slots[k] != null ? Number(slots[k]) : defCols; }
  }
  return { rows, defCols };
}

console.log('===== 判据单测 =====');
// U1 全空配置：8区×18排×默认12
let R = buildRows({ slots: {}, rows: {}, lists: {}, offs: {}, def: { cols: 12, rows: 18 } });
T('U1 全空=8区×18排=144行', Object.keys(R.rows).length, 144);
T('U1b F区12排在列', R.rows['NB03-F-12'], 12);
T('U1c 旧版漏掉的H区现在可见', R.rows['NB03-H-18'], 12);
// U2 真实排号清单优先
R = buildRows({ slots: { 'NB03-A-11': 13 }, rows: { A: 18 }, lists: { A: [11, 12, 13] }, offs: {}, def: { cols: 12, rows: 18 } });
T('U2 lists优先于rows：A区只列3排', Object.keys(R.rows).filter((k) => k.startsWith('NB03-A-')).length, 3);
T('U2b slots保留已配置值', R.rows['NB03-A-11'], 13);
// U3 按区排数覆盖；0=整区不列
R = buildRows({ slots: {}, rows: { B: 15, E: 0 }, lists: {}, offs: {}, def: { cols: 12, rows: 18 } });
T('U3 B区排数覆盖=15', Object.keys(R.rows).filter((k) => k.startsWith('NB03-B-')).length, 15);
T('U3b E区0=整区不列', Object.keys(R.rows).filter((k) => k.startsWith('NB03-E-')).length, 0);
// U4 默认列数非12（现场调参）
R = buildRows({ slots: {}, rows: {}, lists: {}, offs: {}, def: { cols: 14, rows: 10 } });
T('U4 def.cols权威', R.rows['NB03-G-01'], 14);
T('U4b def.rows权威：8区×10排', Object.keys(R.rows).length, 80);
// U5 diff 提交判据：orig vs 现值，仅变化项；改回默认=count 0
function diffSubmit(orig, rows, defCols) {
  const out = [];
  for (const k of Object.keys(rows)) if (orig[k] !== rows[k]) out.push({ prefix: k, count: rows[k] === defCols ? 0 : rows[k] });
  return out;
}
const o1 = { 'NB03-A-11': 12, 'NB03-A-12': 12, 'NB03-F-05': 12 };
T('U5 无改动=空提交', diffSubmit(o1, { ...o1 }, 12).length, 0);
T('U5b 改一格=1条', diffSubmit(o1, { ...o1, 'NB03-A-11': 13 }, 12).length, 1);
T('U5c 13改回12=提交1条且count0（恢复默认）', JSON.stringify(diffSubmit({ ...o1, 'NB03-A-11': 13 }, o1, 12)), '[{"prefix":"NB03-A-11","count":0}]');
const d2 = diffSubmit({ 'NB03-A-11': 13 }, { 'NB03-A-11': 12 }, 12);
T('U5d 已改值恢复默认提交count=0', d2[0].count, 0);

console.log('\n===== 真实数据只读回放 =====');
const d = JSON.parse(fs.readFileSync(require.resolve('./data/db.json'), 'utf8'));
const RR = buildRows({ slots: d.groundSlots || {}, rows: d.gndZoneRows || {}, lists: d.gndZoneList || {}, offs: d.gndRowOff || {}, def: { cols: 12, rows: 18 } });
const keys = Object.keys(RR.rows);
const zoneOf = (k) => k.split('-')[1];
const byZone = {}; keys.forEach((k) => { byZone[zoneOf(k)] = (byZone[zoneOf(k)] || 0) + 1; });
T('M1 现网口径=8区各18排=144行（旧版只有72行）', keys.length, 144);
T('M2 现场在用六区全覆盖', ['A', 'B', 'C', 'F', 'G', 'H'].every((z) => byZone[z] === 18), true);
T('M3 F/G/H区排清单可见（旧版完全无法配置）', keys.filter((k) => 'FGH'.includes(zoneOf(k))).length, 54);
// 账本在库排必须全部在清单内（否则有货排改不了格数）
const ledRows = new Set();
for (const x of d.ledger || []) { const m = String(x.l || '').match(/^NB03-([A-H])-(\d{1,2})-/); if (m) ledRows.add(`NB03-${m[1]}-${pad(Number(m[2]))}`); }
T('M4 账本在库地面排全部在新清单内', [...ledRows].every((k) => RR.rows[k] !== undefined), true);
console.log('  账本在库排数:', ledRows.size, '| 现网 groundSlots 条数:', Object.keys(d.groundSlots || {}).length, '（69条=12冗余将被清理迁移删除，3条真实覆盖保留）');
const _real = Object.entries(d.groundSlots || {}).filter(([, v]) => Number(v) !== 12);
T('M5 清理判据零误伤：仅删=12冗余，3条真实覆盖保留（B-18=13,C-11=14,B-12=18）', _real.length, 3);
T('M5b 真实覆盖值全部在有效区间1~60', _real.every(([, v]) => Number(v) >= 1 && Number(v) <= 60), true);
// 清理后回放：非默认覆盖值仍要在清单里正确显示
const RR2 = buildRows({ slots: Object.fromEntries(_real), rows: d.gndZoneRows || {}, lists: d.gndZoneList || {}, offs: {}, def: { cols: 12, rows: 18 } });
T('M6 清理后清单仍显示真实覆盖', RR2.rows['NB03-B-18'], 13);
T('M6b 其余排回默认12', RR2.rows['NB03-F-05'], 12);

console.log(`\n===== 合计 ${total} 项，${fail} 项失败 =====`);
process.exit(fail ? 1 : 0);
