// ㉖v187 范围盘货架清单按键升序 · 源码锚点证明
// 用户实锤（新建盘点任务 3/4 截图）：货架键按 locs 遍历插入序出（A-03→B-06→C-03→A-04→C-11 乱序）。
// 修复=渲染前 (keys..sort())，与地面排 zones 的 .sort() 同款；层格位原有 l.sort() 不变。
const fs = require('fs');
const dart = fs.readFileSync('D:/work_app/scan_station/lib/inventory_page.dart', 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };

const st = dart.indexOf("final shelfGroups = <String, List<String>>{}");
chk('B1 锚点定位（shelfGroups 构建段）', st > 0, '');
// 1) 渲染处必须按键升序，且不再直接用 entries 的插入序
const rd = dart.indexOf('(shelfGroups.keys.toList()..sort()).map');
chk('B2 渲染按键升序 keys.toList()..sort()', rd > st, '');
chk('B3 旧插入序渲染已清除（无 shelfGroups.entries.map）', !dart.includes('shelfGroups.entries.map'), '');
// 2) MapEntry 沿用原变量名，下游 en.key/en.value 引用不断
chk('B4 MapEntry 组装保 en.key/en.value 语义', dart.includes('final en = MapEntry(rackKey, shelfGroups[rackKey]!)'), '');
chk('B5 下游 en.key 渲染仍在（货架名显示不变）', dart.indexOf('Text(en.key') > rd, '');
// 3) 层内格位排序未被误删（只加了外层键排序）
chk('B6 层格位原有 l.sort() 保留', dart.slice(st, st + 900).includes('for (final l in shelfGroups.values) { l.sort(); }'), '');
// 4) 地面排 zones 排序未受影响（对照同款实现）
chk('B7 地面 zones 原有 .sort() 保留', dart.includes('zones.sort();'), '');
// 5) v182 崩溃防线（三元+级联）未被本次改动重新引入——先剥行注释再判：
//    v182 修复注释原文就引用了崩溃写法（`cond ? const [] : list..sort()`），不剥注释哨兵必误报
//    （v187 首跑 B8 FAIL 即此因，11-15 实测：命中行正是 994 行修复注释）
const codeOnly = dart.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
chk('B8 无三元接级联 sort 崩溃模式（剥注释后）', !/\? *const *\[\] *: *[A-Za-z_.]+ *\.\.sort\(\)/.test(codeOnly), '');

console.log('\n===== v187 货架清单排序实例证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
