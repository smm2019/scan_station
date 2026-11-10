// ㉖v135 PDA 货位占用图重做 · 实例证明（纯 Dart UI 源码锚点 + 数据契约）
// 用户实锤：旧版满屏"1框"看不出名堂，找空位/找货全靠逐格扫。重做=统计头+行卡+过滤器+搜索定位。
// 证明面：
//  A组 页面契约：类名/入口/数据源（ledgerPullMerge→computeStock→byLoc）不被破坏（main.dart 引用 LocMapPage、_StockAgg.byLoc 存在）
//  B组 统计头：本区已占格/低层空位/滞留框/搜索命中格 四指标 + 占用率进度条（64 格=16架×4层口径）
//  C组 三过滤器：all/free/stale 状态 + free 仅货架页显示（地面位无空位概念）+ stale 阈值 168h 与呆滞/盲区同口径
//  D组 搜索定位：_boxHit 三字段匹配（零件号/物料名/条码，大小写不敏感）+ 命中金框/非命中淡出/无命中行隐藏
//  E组 视觉语义：空格浅绿(1~3F)/灰(4F)、有货实色蓝、4F有货橙框、滞留红点红框；点格弹层含滞留时长
//  F组 地面视图：按排分组行卡（substring(0,9) 排键）+ chips 显示 格位·零件号
//  G组 无回归：旧版遗留标识已清除（无"绿=空 · 蓝=有货…灰=第四层"旧图例文案残留）
const fs = require('fs');
const dart = fs.readFileSync(__dirname + '/../lib/loc_map_page.dart', 'utf8');
const main = fs.readFileSync(__dirname + '/../lib/main.dart', 'utf8');
const stock = fs.readFileSync(__dirname + '/../lib/inventory_stock_page.dart', 'utf8');
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 140)} want=${String(JSON.stringify(w)).slice(0, 140)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };

console.log('== A组 页面契约（入口与数据源不破坏） ==');
chkT('A1 类名 LocMapPage 保留（main.dart 入口引用有效）', dart.includes('class LocMapPage extends StatefulWidget') && /MaterialPageRoute\(builder: \(_\) => const LocMapPage\(\)\)/.test(main), true);
chkT('A2 数据链保留：ledgerPullMerge(force)→computeStock', dart.includes('await ledgerPullMerge(force: true)') && dart.includes('await computeStock()'), true);
chkT('A3 byLoc 契约有效（_StockAgg.byLoc 真实存在）', dart.includes('_agg?.byLoc ?? const {}') && stock.includes('final Map<String, List<_StockBox>> byLoc'), true);
chkT('A4 纯只读：页内无叫车/下发接口调用', !/agv\/call|\/api\/ledger\/sync|reserve|dispatch/i.test(dart), true);

console.log('== B组 统计头 ==');
chkT('B1 本区已占格指标（occ/64 口径=16架×4层）', dart.includes('stat("$occ/64", "本区已占格"') && dart.includes('occ / 64'), true);
chkT('B2 低层空位指标（f<=3 才计 freeLow，4F 空不算）', /if \(f <= 3\) freeLow\+\+/.test(dart), true);
chkT('B3 滞留≥7天框指标（staleN 按 ageH 阈值累计）', dart.includes('stat("$staleN", "滞留≥7天框"') && dart.includes('b.ageH >= _staleH'), true);
chkT('B4 搜索命中格指标（仅搜索时显示）', /if \(_q\.isNotEmpty\).*stat\("\$hitLocs", "搜索命中格"/.test(dart), true);
chkT('B5 占用率进度条（>85% 红 >60% 橙 否则绿）', /pct > 85 \? const Color\(0xFFE53935\) : pct > 60 \? const Color\(0xFFFB8C00\) : const Color\(0xFF43A047\)/.test(dart), true);
chkT('B6 全厂在库框数（parts 聚合口径与库存页一致）', dart.includes('agg?.parts.values.fold<int>(0, (s, r) => s + r.inBoxes)'), true);

console.log('== C组 三过滤器 ==');
chkT('C1 三态过滤（all/free/stale）', dart.includes("String _filter = 'all'") && dart.includes("_filterChip('free', \"🟢 只看空位\")") && dart.includes("_filterChip('stale', \"🔴 滞留≥7天\")"), true);
chkT('C2 只看空位仅货架页显示（地面位无空位概念）', /if \(_tab == 'shelf'\) \.\.\.\[_filterChip\('free'/.test(dart), true);
chkT('C3 滞留阈值 168h=7天（与呆滞/盲区抽盘同口径）', dart.includes('static const int _staleH = 168'), true);
chkT('C4 只看空位=隐藏满架', dart.includes("if (_filter == 'free' && !hasFree) return const SizedBox.shrink()"), true);
chkT('C5 滞留过滤=隐藏无滞留架（两视图都有）', dart.includes("if (_filter == 'stale' && !staleRows) return const SizedBox.shrink()") && dart.includes("if (_filter == 'stale' && !allBoxes.any((b) => b.ageH >= _staleH)) return const SizedBox.shrink()"), true);

console.log('== D组 搜索定位 ==');
chkT('D1 三字段匹配（零件号/物料名/条码，大写归一）', /b\.partNo\.toUpperCase\(\)\.contains\(_q\.toUpperCase\(\)\) \|\| b\.itemName\.toUpperCase\(\)\.contains\(_q\.toUpperCase\(\)\) \|\| b\.barcode\.toUpperCase\(\)\.contains\(_q\.toUpperCase\(\)\)/.test(dart), true);
chkT('D2 命中格金框（0xFFFFB300 宽2）', dart.includes('Border.all(color: const Color(0xFFFFB300), width: 2)'), true);
chkT('D3 非命中有货格淡出（空格不淡仍可找位）', /final dim = _q\.isNotEmpty && !hit && n > 0;.*opacity: dim \? 0\.35 : 1/.test(dart.replace(/\n/g, ' ')), true);
chkT('D4 无命中行隐藏', dart.includes("if (_q.isNotEmpty && !hitRow) return const SizedBox.shrink()"), true);
chkT('D5 搜索框可清除+变更即筛（onChanged setState）', dart.includes('onChanged: (v) => setState(() => _q = v.trim())') && dart.includes('_qc.clear()'), true);

console.log('== E组 视觉语义 ==');
chkT('E1 空格双色（1~3F 浅绿 0xFFEAF6EC / 4F 灰 0xFFECEFF1）', dart.includes('const Color(0xFFEAF6EC)') && dart.includes('const Color(0xFFECEFF1)'), true);
chkT('E2 有货实色蓝且 2 框以上加深（密度可读）', dart.includes('n >= 2 ? const Color(0xFF1E88E5) : const Color(0xFF42A5F5)'), true);
chkT('E3 4F 有货橙框警示（超低层常规圈）', dart.includes('Border.all(color: const Color(0xFFFB8C00), width: 1.4)'), true);
chkT('E4 滞留红点+红框', dart.includes('Border.all(color: const Color(0xFFE53935), width: 1.6)') && dart.includes('decoration: const BoxDecoration(color: Color(0xFFE53935), shape: BoxShape.circle)'), true);
chkT('E5 弹层含每框滞留时长（_ageTxt 天/小时格式化）', dart.includes('_ageTxt(b.ageH)') && dart.includes('if (h < 24) return "在库 $h 小时";') && dart.includes('在库 $d 天'), true);
chkT('E6 行卡迷你进度条（满架橙/未满蓝）', dart.includes('occ == 4 ? const Color(0xFFFB8C00) : const Color(0xFF42A5F5)'), true);

console.log('== F组 地面视图 ==');
chkT('F1 按排分组（排键=货位前9字符）', dart.includes('byRow[k.substring(0, 9)]') && dart.includes('_groundRowCard(row, byRow[row]!..sort())'), true);
chkT('F2 排卡头部（框数·品种数·滞留计数）', dart.includes('"${allBoxes.length} 框 · ${parts.length} 种"') && dart.includes('🔴滞留$staleN'), true);
chkT('F3 格位 chips 显示 位序·零件号（substring(10) 取格号）', dart.includes('l.substring(10)'), true);

console.log('== G组 旧版残留清除 ==');
chkT('G1 旧图例文案不再存在（"灰=第四层"已删）', !dart.includes('灰=第四层'), true);
chkT('G2 旧版无过滤/搜索（新代码确有状态字段）', dart.includes('String _filter') && dart.includes('TextEditingController _qc'), true);

console.log(`\n===== v135 占用图重做实例证明 ${total - fail}/${total} PASS =====`);
process.exit(fail ? 1 : 0);
