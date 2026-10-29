// ㉖v101 项目字典派生 · 判据单测 + 真实数据只读回放
// 判据逻辑与 server.js（projBases/PROJ_BRAND_RX/PROJ_PAREN_RX/projCodeOk/projSuggest分组）逐字一致抄录
const fs = require('fs');

const PROJ_BRANDS = ['吉利', '沃尔沃', '长城', '比亚迪', '上汽', '广汽', '理想', '蔚来', '小鹏', '零跑', '问界', '极氪', '岚图', '奇瑞', '长安', '东风', '大众', '丰田', '本田', '日产', '奔驰', '宝马', '奥迪', '特斯拉', '小米'];
const PROJ_BRAND_RX = new RegExp('(' + PROJ_BRANDS.join('|') + ')\\s*([A-Z]{1,3}\\d{2,4}[A-Z]?(?:/\\d{2,4}[A-Z]?)?)', 'g');
const PROJ_PAREN_RX = /[（(]([A-Z][A-Z0-9/]{2,13})[）)]/g;
function projBases(mm) {
  const parts0 = String(mm || '').toUpperCase().replace(/\s/g, '').split('/');
  const lead0 = (String(parts0[0]).match(/^[A-Z]+/) || [''])[0].slice(0, 3);
  const out = [];
  for (let p of parts0) {
    if (!p) continue;
    if (!/^[A-Z]/.test(p)) p = lead0 + p;
    const m = p.match(/^([A-Z]{1,3}\d{2,4})/);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
function projCodeOk(c) { return /^[一-龥A-Z0-9\/-]{1,24}$/.test(c) && /\d/.test(c); }
function projSuggestOn(itemDict, map) { // server 版逻辑（数据源参数化便于单测注入）
  map = map || {};
  const groups = {}; let hitPn = 0, missPn = 0, skipped = 0;
  for (const [pn0, e] of Object.entries(itemDict || {})) {
    const pn = String(pn0 || '').toUpperCase(); const nm = String((e && e.nm) || '');
    if (!nm) continue;
    if (map[pn] && map[pn].length) { skipped++; continue; }
    const cands = []; let m;
    PROJ_BRAND_RX.lastIndex = 0;
    while ((m = PROJ_BRAND_RX.exec(nm))) cands.push({ brand: m[1], token: m[2] });
    const anyBrand = PROJ_BRANDS.find((b) => nm.includes(b)) || '';
    PROJ_PAREN_RX.lastIndex = 0;
    while ((m = PROJ_PAREN_RX.exec(nm))) { const t = m[1]; if (/^[HC]{1,2}STD/.test(t)) continue; cands.push({ brand: anyBrand, token: t }); }
    let got = false; const seenKey = new Set();
    for (const c0 of cands) for (const base of projBases(c0.token)) {
      const key = c0.brand + base;
      if (seenKey.has(key)) continue; seenKey.add(key); got = true;
      const g = (groups[key] = groups[key] || { code: key, brand: c0.brand, base, variants: {}, pns: [] });
      const vt = c0.token.toUpperCase().replace(/\s/g, '');
      g.variants[vt] = (g.variants[vt] || 0) + 1;
      if (g.pns.length < 600) g.pns.push(pn);
    }
    if (got) hitPn++; else missPn++;
  }
  const list = Object.values(groups).map((g) => { g.suspect = Object.keys(g.variants).length > 1; g.n = g.pns.length; return g; });
  list.sort((a, b) => b.n - a.n);
  return { groups: list, hitPn, missPn, skipped };
}

let pass = 0, fail = 0;
const T = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const s1 = (nm) => { const r = projSuggestOn({ PN1: { nm } }, {}); return r.groups.map((g) => g.code); };

console.log('== A. projBases 归一折叠 ==');
T('A1 V446K→V446', projBases('V446K'), ['V446']);
T('A2 E281E→E281', projBases('E281E'), ['E281']);
T('A3 V446/451K→双码', projBases('V446/451K'), ['V446', 'V451']);
T('A4 EX11原样', projBases('EX11'), ['EX11']);
T('A5 V451K→V451', projBases('V451K'), ['V451']);
T('A6 E281原样', projBases('E281'), ['E281']);

console.log('== B. projCodeOk 码格式闸 ==');
T('B1 V446K 合法', projCodeOk('V446K'), true);
T('B2 V446/451K 合法', projCodeOk('V446/451K'), true);
T('B3 纯字母无数字 拒', projCodeOk('ABC'), false);
T('B4 小写 拒（端点已先转大写，防呆）', projCodeOk('v446k'), false);
T('B5 含空格 拒（中文允许但空格禁，与派生分组码口径一致）', projCodeOk('吉利 E281'), false);
T('B5b 中文品牌码合法', projCodeOk('吉利E281'), true);
T('B6 超长25位 拒', projCodeOk('A1234567890123456789012345'), false);

console.log('== C. 派生整名判据（真实名称样本）==');
T('C1 品牌前缀名', s1('13-吉利E281前围左下板CSTD250917-冷冲'), ['吉利E281']);
T('C2 括号沃尔沃车型', s1('06-后防撞梁-HSTD241159（沃尔沃V446K）'), ['沃尔沃V446']);
T('C3 图纸号+纯数字括号不误抓', s1('11-后门槛饰板安装支架-CSTD180188(8889116320)'), []);
T('C4 CSTD碎片不抓', s1('20-吉利EX11前围中横梁HSTD180165-2成品'), ['吉利EX11']);
T('C5 共享写法双码', s1('11-排气管后部左安装支架-CSTD241161（沃尔沃V446/451K）'), ['沃尔沃V446', '沃尔沃V451']);
T('C6 无任何车型字样→空建议', s1('左前座椅前安装横梁'), []);
T('C7 吉利名中间出现也算', s1('03-吉利E281后地板左板HHSTD230717镭射'), ['吉利E281']);
T('C8 尾注空格括号', s1('11-CCB右后安装支架-CSTD180184(8889038556 )'), []);

console.log('== D. 真实数据回放（db.json 只读）==');
const db = JSON.parse(fs.readFileSync(__dirname + '/data/db.json', 'utf8'));
const r0 = projSuggestOn(db.itemDict, {}); // 全量建议（未配任何归属）
console.log(`建议分组 ${r0.groups.length} 组，命中 ${r0.hitPn}，未识别 ${r0.missPn}（字典共 ${Object.keys(db.itemDict || {}).length}）`);
for (const g of r0.groups) console.log(`  ${String(g.n).padStart(4)} ${g.code}${g.suspect ? ' ⚠suspect ' + JSON.stringify(g.variants) : ''}`);
T('D1 命中≥179（实测179，品牌+括号两条腿）', r0.hitPn >= 179, true);
T('D2 命中+未识别=有名字零件总数', r0.hitPn + r0.missPn, Object.values(db.itemDict).filter((e) => e.nm).length);
T('D3 分组数≤10（变体已折叠）', r0.groups.length <= 10, true);
const ge281 = r0.groups.find((g) => g.code === '吉利E281');
T('D4 E281E 已折叠进吉利E281（不再单独成组）', r0.groups.some((g) => g.code === '吉利E281E'), false);
T('D5 吉利E281 组含变体标记suspect', ge281 && ge281.suspect, true);
const v446 = r0.groups.find((g) => g.code === '沃尔沃V446');
T('D6 沃尔沃V446 组吸收 V446K 变体', v446 && v446.variants && Object.keys(v446.variants).includes('V446K'), true);

// 已入典零件不再建议（skipped 口径）
const map1 = {}; for (const g of r0.groups.slice(0, 2)) for (const pn of g.pns) map1[pn] = [g.code];
const r1 = projSuggestOn(db.itemDict, map1);
T('D7 已归属零件被跳过', r1.skipped, Object.values(map1).length);
T('D8 跳过后命中数下降', r1.hitPn < r0.hitPn, true);

console.log(`\n===== 项目派生：${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
