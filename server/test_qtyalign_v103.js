// ㉖v103 账本件数对账 · 判据单测 + 全库真实回放
// 复刻 server.js latestScanQty / 对账闸 / 存量迁移逻辑（Node版），用 11/3 现场事故数据取证
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// ===== 判据复刻 =====
function latestScanQty(scanlog) {
  const m = {};
  for (const s of Object.values(scanlog || {})) {
    if (s.cx) continue;
    const c = String(s.code || '').toUpperCase(), q = Number(s.q) || 0, t = Number(s.t) || 0;
    if (!c || q <= 0) continue;
    if (!m[c] || t >= m[c].t) m[c] = { q, t };
  }
  return m;
}
// 对账闸（账本推送方向）：入参行按全厂最新有效扫码纠正
function alignRow(row, sq) { const L = sq[String(row.c || '').toUpperCase()]; if (L && Number(row.q) !== L.q) return { ...row, q: L.q, fixed: true }; return { ...row, fixed: false }; }
// 存量迁移：全账本逐行对账
function migrate(ledger, sq) { let n = 0; const out = (ledger || []).map((x) => { const r = alignRow(x, sq); if (r.fixed) n++; return r; }); return { rows: out, n }; }

console.log('===== A. latestScanQty 判据 =====');
const S = {
  a: { code: 'C1', q: 300, t: 1000, cx: false },   // 旧扫码
  b: { code: 'C1', q: 220, t: 2000, cx: false },   // 新扫码→应取220
  c: { code: 'C2', q: 500, t: 3000, cx: true },    // 作废→不参与
  d: { code: 'C3', q: 0, t: 4000, cx: false },     // q=0→不参与（MES未回数量）
  e: { code: 'C4', q: 700, t: 5000, cx: false },
  f: { code: 'C1', q: 999, t: 1500, cx: false },   // 中间时刻→不覆盖最新
};
const sq = latestScanQty(S);
T('A1 同码取最新有效扫码(220非300非999)', sq.C1.q, 220);
T('A2 作废流水不参与', sq.C2, undefined);
T('A3 q=0不参与', sq.C3, undefined);
T('A4 正常单条参与', sq.C4.q, 700);
T('A5 大小写归一', Object.keys(latestScanQty({ x: { code: 'c9', q: 50, t: 1, cx: false } })).includes('C9'), true);

console.log('\n===== B. 对账闸行为 =====');
const sqB = { C1: { q: 220, t: 2000 }, C4: { q: 700, t: 5000 } };
T('B1 旧值300被纠正为220', alignRow({ c: 'C1', q: 300 }, sqB).q, 220);
T('B2 已一致不动', alignRow({ c: 'C1', q: 220 }, sqB).fixed, false);
T('B3 无扫码记录不动(别台扫的/已归档)', alignRow({ c: 'C9', q: 888 }, sqB).q, 888);
T('B4 小写码归一命中', alignRow({ c: 'c1', q: 300 }, sqB).q, 220);
T('B5 账本q=0行补实测值(缺数量应补)', alignRow({ c: 'C1', q: 0 }, sqB).q, 220);

console.log('\n===== C. 11/3 现场事故数据回放（8894153871 虚高80件）=====');
// ⚠ 两态兼容：主库尚未部署 v103 迁移时账本=300（错配现场态）；正式服务重启跑过迁移后=220（已纠正态）。
// 两种状态都必须判通过——断言对象是【判据正确】，不是【主库停在哪个时刻】；流水史是不可变事实源。
const sqReal = latestScanQty(d.scanlog);
const r463 = (d.ledger || []).find((x) => x.c === 'N26J230463');
const r462 = (d.ledger || []).find((x) => x.c === 'N26J230462');
T('C1 现场实况：N26J230463 账本∈{300未迁移, 220已迁移}', [300, 220].includes(r463.q), true);
T('C2 最新有效扫码=220（11/3 16:14 重扫实测，不可变事实源）', sqReal.N26J230463.q, 220);
T('C3 对账后=220（档案页920口径归一）', alignRow(r463, sqReal).q, 220);
T('C4 兄弟码462零误伤（700=扫码700）', alignRow(r462, sqReal).fixed, false);
const mig = migrate(d.ledger, sqReal);
T('C5 全库迁移命中∈{1未迁移, 0已迁移}（零误伤实证）', [0, 1].includes(mig.n), true);
T('C6 纠正后该零件合计=920（与档案页一致，两态同果）', mig.rows.filter((x) => String(x.p || '').toUpperCase() === '8894153871').reduce((s, x) => s + (Number(x.q) || 0), 0), 920);
const _delta = d.ledger.reduce((s, x) => s + (Number(x.q) || 0), 0) - mig.rows.reduce((s, x) => s + (Number(x.q) || 0), 0);
T('C7 全库纠正量∈{80未迁移, 0已迁移}', [0, 80].includes(_delta), true);
// 幂等：迁移后再跑一次应0命中
T('C8 二次迁移幂等(0命中)', migrate(mig.rows, sqReal).n, 0);
// 该零件流水史：10/23 首扫 300 → 11/3 重扫 220（虚高来源实证，不可变）
const hist = Object.values(d.scanlog || {}).filter((v) => v.code === 'N26J230463' && !v.cx).sort((a, b) => a.t - b.t);
T('C9 流水史实证：首扫300(10/23)→重扫220(11/3)', hist.map((h) => h.q), [300, 220]);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
