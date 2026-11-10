// ㉖v146 建单页布局压缩 + 预约反馈修复 · 实例证明（PDA 纯 Dart UI，源码锚点+逻辑断言）
// 用户四问：①补料建议独占一行浪费空间 ②急料与存为模板要并一行 ③急料括号说明全删
// ④补料建议点"预约"没反应（根因：SnackBar 显示在底层 Scaffold 被 86% 高弹层挡住——预约其实成功了）+ 能否多选批量加入
// 修复：①补料建议 chip 并入常领横滑工具条首位；②急料+存为模板合并同一 Row；③文案改"急料"两字；
// ④预约改行内状态机（预约中…/✓已预约/✗重试，不依赖 SnackBar）+ 打开弹层回读服务器存量预约；
//   ⑤断供组加勾选（含全选）+ 底部"批量预约(N)"按钮串行登记；"加入领料单"本就支持多选（v137 已有，确认在位）。
const fs = require('fs');
const dart = fs.readFileSync(__dirname + '/../lib/requisition_page.dart', 'utf8');
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 140)} want=${String(JSON.stringify(w)).slice(0, 140)}`); };

console.log('== A组 预约反馈修复（根因级） ==');
{
  // A1 旧根因消除：弹层内不再有任何 SnackBar 调用（context 的 messenger 被弹层挡）
  const sheet = dart.slice(dart.indexOf('Future<void> _showSugSheet'), dart.indexOf('_showSugSheet') + 9000);
  chk('A1 弹层内 SnackBar 调用清零（反馈不再被挡）', (sheet.match(/ScaffoldMessenger|showSnackBar/g) || []).length, 0);
  chkT('A2 行内状态机在位（预约中/已预约/重试三态）', sheet.includes('预约中…') && sheet.includes('✓已预约') && sheet.includes('✗重试'), '');
  chkT('A3 打开弹层回读存量预约（booked 种子）', /final booked = <String>\{\}/.test(sheet) && sheet.includes('AuthApi.watchlistGet()') && sheet.includes('booked.add(w["partNo"]'), '');
  chkT('A4 预约请求体口径不变（qty=建议框数 auto=true）', sheet.includes('qty: (x["boxes"] as num?)?.toInt() ?? 0') && sheet.includes('auto: true'), '');
  chkT('A5 方法已改 async（回读需 await）', dart.includes('Future<void> _showSugSheet() async'), '');
}
console.log('== B组 多选批量预约 ==');
{
  const sheet = dart.slice(dart.indexOf('Future<void> _showSugSheet'), dart.indexOf('Future<void> _showSugSheet') + 16000); // 弹层体含底部按钮区约15K字符，窗口须盖到"加入领料单"
  chkT('B1 断供组勾选集合与全选切换在位', sheet.includes('final selOut = <String>{}') && sheet.includes('取消全选') && sheet.includes('selOut.length == outOfStock.length'), '');
  chkT('B2 批量预约按钮（排除已预约计数、串行循环）', sheet.includes('批量预约(${selOut.where((p) => !booked.contains(p.toUpperCase())).length})') && /for \(final pn in todo\)/.test(sheet), '');
  chkT('B3 批量成功后从勾选移除且置 booked', sheet.includes('booked.add(pn.toUpperCase()); selOut.remove(pn);'), '');
  chkT('B4 加入领料单多选在位（v137 能力保留）', sheet.includes('加入领料单(${sel.where((p) => !_order.contains(p)).length})') && sheet.includes('_syncChosen(pn)'), '');
  chkT('B5 断供行改自定义 Row+Checkbox（无 trailing 非法参数）', sheet.includes('return Row(children: [') && !sheet.includes('trailing: isBooked'), '');
}
console.log('== C组 布局压缩 ==');
{
  const body = dart.slice(dart.indexOf('㉖v146 布局压缩'), dart.indexOf('㉖v146 布局压缩') + 2600).replace(/\r/g, ''); // 归一 CRLF 防行尾差异假阴性
  chkT('C1 补料建议并入横滑工具条首位（独占行已删）', body.includes('if (_sugOn && _sug.isNotEmpty)\n                    Padding(\n                      padding: const EdgeInsets.only(right: 8),'), '');
  chkT('C2 工具条条件合并（三者之一即显示）', dart.includes('if (_sugOn && _sug.isNotEmpty || _freq.isNotEmpty || _tpls.isNotEmpty) ...['), '');
  const bottom = dart.slice(dart.indexOf('㉖v146 底部合并一行'), dart.indexOf('㉖v146 底部合并一行') + 2200);
  chkT('C3 急料与存为模板同 Row（旧 Align 独占块已删）', bottom.includes('Row(crossAxisAlignment: CrossAxisAlignment.start, children: [') && bottom.includes('if (chosen.isNotEmpty)') && !dart.includes('heightFactor: 1.0, // ㉖v70b'), '');
  chkT('C4 急料括号说明全删（仅悬停 title 语义由行内🔥承担）', !dart.includes('急料（AGV排队优先，到站5分钟催扫广播全员）') && bottom.includes('Text("急料",'), '');
}
console.log('== D组 结构完整性 ==');
{
  const bal = (s) => { let d = 0; for (const c of s) { if (c === '{') d++; else if (c === '}') d--; } return d; };
  const sheetStart = dart.indexOf('Future<void> _showSugSheet');
  const sheetEnd = dart.indexOf('\n  }\n', dart.indexOf('}))))', sheetStart));
  chkT('D1 弹层方法体花括号自平衡', bal(dart.slice(dart.indexOf('{', sheetStart), sheetEnd + 4)) === 0, '');
  chkT('D2 无旧代码碎片残留（nAuto 类事故防再）', !dart.includes('icon: const Icon(Icons.folder_open_outlined,\n                          size: 16') || (dart.match(/folder_open_outlined/g) || []).length <= 2, (dart.match(/folder_open_outlined/g) || []).length + '处');
  chkT('D3 CheckboxListTile 误用清零', !/CheckboxListTile\([\s\S]{0,600}trailing:/.test(dart), '');
}
console.log(`\n===== v146 建单布局与预约反馈实例证明 ${total - fail}/${total} PASS =====`);
process.exit(fail ? 1 : 0);
