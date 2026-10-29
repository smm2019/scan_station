// ㉖v100 货位格式防线·真实数据全量回放（只读，不改 db.json）
// 目的：1) 证明防线①对现账本 356 行零误伤；2) 证明防线②对现流水零误伤（实测存量应 0 命中）；
//       3) 检查前缀-尾段混用形态（NB03-…-xF / NB02-…-数字）是否存在，决定 locStrict 能否安全收紧（B11）
const fs = require('fs');
const db = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));

const locStrict = (l) => { const s = String(l || '').trim().toUpperCase(); return /^NB02-[A-H]-\d{1,2}-[1-4]F$/.test(s) || /^NB03-[A-H]-\d{1,2}-\d{1,2}$/.test(s); };
const locStation = (l) => /^NB02-CK-\d{1,2}$/.test(String(l || '').trim().toUpperCase());
const flowModeBad = (wt, st, gl) => { const s = String(st || '').trim().toUpperCase(), g = String(gl || '').trim().toUpperCase(); return Number(wt) === 0 ? /^NB03-/.test(s) : locStation(g); };

let fail = 0;
const chk = (name, got, want) => { const ok = got === want; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${got} want=${want}`); };

// —— 防线①回放：账本 l ——
const led = db.ledger || [];
const ledBad = led.filter((x) => !locStrict(x.l));
console.log(`账本共 ${led.length} 行，locStrict 不满足 ${ledBad.length} 行`);
ledBad.slice(0, 10).forEach((x) => console.log('  拒回样例: ' + x.c + ' l=' + x.l));
chk('R1 账本零误伤(防线①不误杀任何真实行)', ledBad.length, 0);

// B11 决策：前缀-尾段混用形态在真实账本中是否存在
const mixNB03F = led.filter((x) => /^NB03-/.test(String(x.l).toUpperCase()) && /[1-4]F$/i.test(String(x.l)));
const mixNB02Num = led.filter((x) => /^NB02-/.test(String(x.l).toUpperCase()) && !/-CK-/i.test(String(x.l)) && !/F$/i.test(String(x.l)));
console.log(`混用形态：NB03 带层F=${mixNB03F.length} 行，NB02 纯数字尾=${mixNB02Num.length} 行`);
mixNB03F.slice(0, 5).forEach((x) => console.log('  NB03xF: ' + x.c + ' ' + x.l));
mixNB02Num.slice(0, 5).forEach((x) => console.log('  NB02数字尾: ' + x.c + ' ' + x.l));
console.log((mixNB03F.length || mixNB02Num.length) ? '⇒ 收紧会误伤真实行，B11 维持现判据（记录为已知接受形态）' : '⇒ 真实数据无混用，可安全收紧为前缀-尾段配对判据');

// —— 防线②回放：流水 st/gl 跨模式 ——
const flows = Object.values(db.scanlog || {});
const flowSick = flows.filter((v) => flowModeBad(v.wt, v.st, v.gl));
console.log(`流水共 ${flows.length} 条，flowModeBad 命中 ${flowSick.length} 条`);
flowSick.slice(0, 10).forEach((v) => console.log('  错配样例: ' + v.code + ' wt=' + v.wt + ' st=' + v.st + ' gl=' + v.gl));
chk('R2 流水零误伤(体检对现网数据0命中，不会留痕刷屏)', flowSick.length, 0);

// —— 防线②补充：流水 gl=粗码/空 属在管待补录态，确认判据确实放行 ——
const glCoarse = flows.filter((v) => Number(v.wt) === 1 && v.gl && !locStrict(v.gl) && !locStation(v.gl));
const glCoarseFlagged = glCoarse.filter((v) => flowModeBad(v.wt, v.st, v.gl));
console.log(`地面模式 gl 粗码/异形 ${glCoarse.length} 条，其中被判错配 ${glCoarseFlagged.length} 条`);
chk('R3 粗码待补录态不被误判(7条系v83/v85c在管)', glCoarseFlagged.length, 0);

// —— 防线③场景：AGV 流水 st 全是站台码 → 恢复取位必被 locStrict 闸（应 100% 拦，正是设计意图）——
const agvSt = flows.filter((v) => Number(v.wt) === 0 && v.st);
const agvStStation = agvSt.filter((v) => locStation(v.st));
console.log(`AGV 流水 st 非空 ${agvSt.length} 条，其中站台码形态 ${agvStStation.length} 条`);
chk('R4 AGV流水st确为站台码(防线③按设计必拒其直接上账)', agvSt.length ? agvStStation.length === agvSt.length : true, true);

// —— seenIn 与防线语义独立性抽查：seenIn.l 里 NB02-CK 是合法初始位（补丁判据≠防线判据的实证）——
const si = Object.values(db.seenIn || {});
const siStation = si.filter((e) => locStation(e.l));
console.log(`seenIn 共 ${si.length} 条，l=站台码(AGV合法初始位) ${siStation.length} 条 → 补丁绝不能用 locStrict 的实证`);

console.log(`\n===== 真实数据回放：${fail === 0 ? '全部通过' : fail + ' 项失败'} =====`);
process.exit(fail ? 1 : 0);
