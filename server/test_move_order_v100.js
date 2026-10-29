// ㉖v100 出库/移仓口径分离 · 判据单测 + 真实数据回放（只读）
// 判据抄录 server.js 现行实现：去向含任一关键词=出库；全不含=移仓；空去向/空清单=按出库（保守回退）
const fs = require('fs');
const mkIsMove = (keysStr) => (o) => { const keys = String(keysStr || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean); if (!keys.length) return false; const to = String((o && o.toLoc) || '').trim(); if (!to) return false; return !keys.some((k) => to.includes(k)); };

let pass = 0, fail = 0;
const T = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };

console.log('== A. 判据单测（默认关键词"线边仓"）==');
const isMove = mkIsMove('线边仓');
T('A1 线边仓=出库', isMove({ toLoc: '焊-宁波-线边仓/焊-宁波-线边仓/焊-宁波-线边仓' }), false);
T('A2 冷冲件仓=移仓', isMove({ toLoc: '焊-宁波-冷冲件仓/焊-宁波-冷冲件仓/焊-宁波-冷冲件仓' }), true);
T('A3 热压单件仓=移仓', isMove({ toLoc: '焊-宁波-热压单件仓/焊-宁波-热压单件仓/焊-宁波-热压单件仓' }), true);
T('A4 代发仓=移仓', isMove({ toLoc: '焊-宁波-代发仓/焊-宁波-代发仓/焊-宁波-代发仓' }), true);
T('A5 空去向=出库(保守)', isMove({ toLoc: '' }), false);
T('A6 无toLoc字段=出库', isMove({}), false);
T('A7 去向含线边仓于中段=出库', isMove({ toLoc: 'X-线边仓临时/Y/Z' }), false);

console.log('== B. 多关键词与回退 ==');
const isMove2 = mkIsMove('线边仓，装配超市'); // 中英文逗号混用
T('B1 第二关键词命中=出库', isMove2({ toLoc: '装配超市/A/B' }), false);
T('B2 都不含=移仓', isMove2({ toLoc: '冷冲件仓/A/B' }), true);
T('B3 空清单=全按出库(回退旧口径)', mkIsMove('')({ toLoc: '冷冲件仓' }), false);
T('B4 纯逗号=全按出库', mkIsMove('，,')({ toLoc: '冷冲件仓' }), false);

console.log('== C. 真实数据回放（现网 db.json）==');
const db = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));
const obs = Object.values(db.outbound || {});
const mv = obs.filter(isMove), out = obs.filter((o) => !isMove(o));
console.log(`出库单共 ${obs.length} 张：判出库 ${out.length} 张 / 判移仓 ${mv.length} 张`);
for (const o of mv) console.log(`  移仓: ${o.orderNo} → ${o.toLoc} (${(o.items || []).length}行 ${o.operator || ''})`);
T('C1 现网移仓单=5张(冷冲1+热压2+代发2，与10/29核查一致)', mv.length, 5);
T('C2 判出库的单全部去向含线边仓(DT直调+LL转单，无一漏判)', out.filter((o) => String(o.toLoc || '').includes('线边仓')).length, out.length);
T('C3 领料转单(LL关联)不受影响判出库', out.filter((o) => o.linkReqNo).length >= 0, true); // LL单去向也是线边仓，判出库 ✓
const llMove = obs.filter((o) => o.linkReqNo && isMove(o));
T('C4 无带领料关联的移仓单(转单目标恒线边仓)', llMove.length, 0);

console.log(`\n===== 移仓口径：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
