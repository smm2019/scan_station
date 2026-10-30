// ㉖v101 操作人乱码治理 · 判据单测 + 真实数据回放
// 判据逻辑与 server.js 逐字一致（_opBad/opUserMatch/wdName修复/opFix多数原则）
const fs = require('fs');
const USERS = ['系统管理员', '刘向轩', '胡总', '贾正伟', '金先发', '蒋波', '郭彦超', '胡志文', '李亮', '李庆峰', '宋明明', 'aaa', '卫革', '刘锐', '陈明', '物料', '王子浩', '郑先刚'];

const _opBad = (s) => /[\uFFFD\u25C6\uFFFC]/.test(String(s || ''));
function opUserMatch(s0) {
  const t = String(s0 || '').replace(/[\uFFFD\u25C6\uFFFC]/g, '').trim();
  if (!t) return '';
  const hits = [];
  for (const nm of USERS) { const n2 = String(nm || '').trim(); if (n2.length < 2 || n2 === t) continue; let i = 0; for (const ch of n2) { if (ch === t[i]) i++; if (i === t.length) break; } if (i === t.length) hits.push(n2); }
  return hits.length === 1 ? hits[0] : '';
}
const wdName = (s) => { s = String(s || '').trim().replace(/[（(][^）)]*[）)]$/, '').trim(); if (_opBad(s)) s = opUserMatch(s) || s; return s || '未知'; };
// opFix 判据复刻：同批次多数原则，取最长多数名
function opFixOne(badOps, goodOps) {
  const good = {};
  for (const o of goodOps) { const t = String(o || '').trim(); if (t) good[t] = (good[t] || 0) + 1; }
  const gks = Object.keys(good).sort((a, x) => good[x] - good[a] || x.length - a.length);
  const fix = gks.length ? gks[0] : '';
  return badOps.map((b) => fix || opUserMatch(b) || b);
}

let pass = 0, fail = 0;
const T = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };

console.log('== A. _opBad 坏字符识别 ==');
T('A1 U+FFFD 判坏', _opBad('宋\uFFFD\uFFFD\uFFFD明'), true);
T('A2 U+25C6 判坏', _opBad('\u25C6\u25C6明明'), true);
T('A3 正常名不判坏', _opBad('宋明明'), false);
T('A4 空不判坏', _opBad(''), false);

console.log('== B. opUserMatch 子序列唯一归并 ==');
T('B1 ◆◆明明→宋明明', opUserMatch('\uFFFD\uFFFD明明'), '宋明明');
T('B2 宋◆◆◆明→宋明明', opUserMatch('宋\uFFFD\uFFFD\uFFFD明'), '宋明明');
T('B3 ◆明→陈明与宋明明双命中=歧义不猜', opUserMatch('\uFFFD明'), ''); // "陈明"和"宋明明"都含子序列"明"→歧义？"明"是两者子序列且各1次→hits=2→''
T('B4 郭彦◆→郭彦超唯一', opUserMatch('郭彦\uFFFD'), '郭彦超');
T('B5 卫◆◆→卫革唯一', opUserMatch('卫\uFFFD\uFFFD'), '卫革');
T('B6 干净名原样返回(子串"明明"=宋明明子序列但同长排除)', opUserMatch('明明'), '宋明明'); // "明明"⊂"宋明明"唯一；"陈明"不含连续？子序列"明明"——陈明只有一个明→不命中→唯一
T('B7 全坏字符→无法归并', opUserMatch('\uFFFD\uFFFD'), '');
T('B8 用户表外串→无命中', opUserMatch('赵\uFFFD\uFFFD钱'), '');

console.log('== C. wdName 统计归并（报表裂行根因）==');
T('C1 正常名不动', wdName('宋明明'), '宋明明');
T('C2 剥账号后缀', wdName('宋明明(smm123)'), '宋明明');
T('C3 乱码归并到真人', wdName('\uFFFD\uFFFD明明'), '宋明明');
T('C4 乱码带账号也能归并', wdName('宋\uFFFD\uFFFD\uFFFD明(smm123)'), '宋明明'); // 先剥尾括号账号再判坏
T('C5 歧义保持原样不硬猜', wdName('\uFFFD明'), '\uFFFD明');
T('C6 空归未知', wdName(''), '未知');

console.log('== D. opFix 同批次多数原则 ==');
T('D1 批次14:1→全归多数名', opFixOne(['\uFFFD\uFFFD明明'], Array(14).fill('宋明明')), ['宋明明']);
T('D2 批次无正常名→子序列兜底', opFixOne(['宋\uFFFD\uFFFD\uFFFD明'], []), ['宋明明']);
T('D3 计数平局取最长名', opFixOne(['\uFFFD\uFFFD'], ['明明', '宋明明']), ['宋明明']); // 各1次平局→长度取胜
T('D4 双路皆无→原样保留', opFixOne(['赵\uFFFD\uFFFD'], []), ['赵\uFFFD\uFFFD']);

console.log('== E. 真实数据回放（db.json 只读）==');
const db = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));
const badNow = Object.values(db.scanlog || {}).filter((s) => _opBad(s.op));
console.log('现网坏 op 流水:', badNow.length, '条');
// 现网坏值可能已被正式服务启动迁移修复（10/30 主库实测 0 条），两态兼容：
// 仍有坏值→逐条走批次多数回放；为0→验证迁移开关落库且"宋明明"记录健在（修复痕迹）
if (badNow.length > 0) {
  T('E1 现网坏值回放（条数=' + badNow.length + '，逐条批次多数应得宋明明）', badNow.every((s) => {
    const list = Object.values(db.scanlog || {}).filter((x) => x.batch === s.batch);
    const good = list.filter((x) => !_opBad(x.op) && String(x.op || '').trim());
    return good.length && good.every((x) => String(x.op).trim() === '宋明明');
  }), true);
} else {
  T('E1 现网坏值=0（已被正式服务迁移修复）', db.opFixedV101, 1);
  T('E1b 修复痕迹：宋明明记录健在', Object.values(db.scanlog || {}).filter((s) => String(s.op || '').trim() === '宋明明').length > 700, true);
}
// 模拟迁移效果：每条按其批次多数原则应得"宋明明"
for (const s of badNow) {
  const bt = s.batch;
  const list = Object.values(db.scanlog || {}).filter((x) => x.batch === bt);
  const good = list.filter((x) => !_opBad(x.op)).map((x) => x.op);
  const fixed = opFixOne([s.op], good)[0];
  T('E2[' + s.code + '] ' + JSON.stringify(s.op) + '→' + fixed, fixed, '宋明明');
}
// 修复后按人分组：宋明明不再被拆
const grp = {};
for (const s of Object.values(db.scanlog || {})) { const k = wdName(s.op); grp[k] = (grp[k] || 0) + 1; }
const song = Object.keys(grp).filter((k) => k.includes('明') && !k.includes('陈') && !k.includes('\uFFFD'));
console.log('wdName归并后人名分布:', JSON.stringify(grp));
T('E3 归并后"宋明明"一列聚合同批次全部记录', grp['宋明明'] >= 28, true); // 两批次各14+修复2
T('E4 归并后不再有裂名(坏键消失)', Object.keys(grp).some((k) => _opBad(k)), false);

console.log(`\n===== 乱码治理判据：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
