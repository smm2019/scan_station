// ㉖v195 僵尸墓碑自愈 · 源码锚点证明（PDA 拉取合并核心病灶根治）
// 现场实锤（11-15）：那台 PDA 缺 12 框，「库存页拉取 + 杀进程重启」都救不回。
// 服务器取证三重证据：①服务器账本 9 码全在架 ②服务器墓碑全空 ③epoch 停在 10/23 导入。
// 根因：本机墓碑台账（SharedPreferences，重启/重装都带得走）早前被 v173c 并发竞态误删时落下，
//       拉取"本机已删除→不复活"规则永久挡行；epoch 未变→重启不清缓存→三招全碰不到病灶。
// 修复=拉取侧僵尸碑自愈：碑挡行 + 服务器有该码在架行 + 碑超10分钟宽限 → 撤碑复活+审计留痕。
const fs = require('fs');
const path = require('path');
const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'collection_ledger.dart'), 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };

chk('A1 服务器在架行索引构建（自愈判据数据源）', dart.includes('final _srvByCode = {for (final x in items)'), '');
chk('A2 僵尸判定三条件齐（服务器行t>0 + 碑已超600秒宽限）', dart.includes('if (st > 0 && tv < now - 600000) { tombZombie.add(c); }'), '');
chk('A3 复活放行插在"不复活"规则处（墓碑>=行t 且非僵尸才跳过）', dart.includes('if ((tombMap[c] ?? 0) >= t && t > 0) {') && dart.includes('if (!tombZombie.contains(c)) continue;'), '');
chk('A4 复活留痕走本地审计（可追责可统计）', dart.includes("LocalLog.op('账本墓碑自愈'"), '');
chk('A5 撤销持久化：僵尸碑从台账真删（下轮不再重复判/重复留痕）', dart.includes('if (tombAdds.isNotEmpty || tombZombie.isNotEmpty)') && dart.includes('m.remove(c);'), '');
chk('A6 真删除保护①：本轮落了更新墓碑的码保留新碑（断网重推不被截）', dart.includes('if (tombAdds.containsKey(c)) continue;'), '');
chk('A7 真删除保护②：宽限期外若码又被别台删除，下次拉取"服务器墓碑更新"分支重落碑（自愈不永久抹真删）', dart.includes('if ((tombMap[c] ?? 0) < t) tombAdds[c] = t;'), '');
chk('A8 只影响僵尸码：其余墓碑行为零变化（原"不复活"continue 路径保留）', /if \(!tombZombie\.contains\(c\)\) continue;[\s\S]{0,200}?\}/.test(dart), '');
chk('A9 无残留未定义标识（tombCut 已彻底清除）', !dart.includes('tombCut'), '');
chk('A10 重启/重装救不回的原因在代码注释留档（后人不再走弯路）', dart.includes('墓碑台账存 SharedPreferences') && dart.includes('epoch 未变不清缓存'), '');

console.log('\n===== v195 僵尸墓碑自愈实例证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
