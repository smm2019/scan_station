// ㉖v149 PDA 建单库存列表懒加载 · 实例证明（源码锚点+结构断言）
// 用户报"卡顿较重"，怀疑常领条零件号所致。实测定位：真凶是库存列表 ListView(children:) 一次构建
// 全部行（~250行×输入框）——每次填框数 setState 都整表重建。常领条仅12个轻量chip非卡顿源，
// 去掉零件号会让chip不可区分（同前缀零件多）且治不了卡顿，故不改常领展示。
// 修复：ListView.builder 懒加载（只渲染可视窗口）+ ScrollController 释放。
// 证明面：
//  B1 库存列表改 builder（itemCount/itemBuilder/控制器在位）
//  B2 旧全量构建清零（"child: ListView(children:" 在库存段无残留）
//  B3 控制器字段+dispose 释放（防句柄泄漏）
//  B4 输入框控制器仍经 putIfAbsent 与行生命周期解耦（懒加载下不丢已填值）
//  B5 常领chip零件号保留（用户建议经分析否决：非卡顿源且去号不可区分）
const fs = require('fs');
const dart = fs.readFileSync(__dirname + '/../lib/requisition_page.dart', 'utf8');
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
console.log('== B组 懒加载结构 ==');
{
  const st = dart.indexOf('㉖v149 懒加载');
  chkT('B1 库存列表改 ListView.builder', st > 0 && dart.slice(Math.max(0, st - 300), st + 800).includes('ListView.builder('), '');
  const seg = dart.slice(st, st + 1600);
  chkT('B1b itemCount/itemCount=controller 三要素齐', seg.includes('itemCount: list.length') && seg.includes('itemBuilder: (ctx, i)') && seg.includes('controller: _stockScroll'), seg.slice(0, 200));
  chkT('B2 库存段无旧全量构建残留', !seg.includes('ListView(children: ['), '');
  chkT('B3 控制器字段+dispose 释放在位', dart.includes('final ScrollController _stockScroll = ScrollController();') && dart.includes('_stockScroll.dispose();'), '');
  chkT('B4 行输入框仍 putIfAbsent 解耦', seg.includes('_qtyCtrl.putIfAbsent'), '');
  chkT('B5 常领chip仍带零件号后缀（非卡顿源，保留可辨识）', dart.includes('pn.substring(pn.length - 6)'), '');
  // 全文件 builder 出现次数=既有2处+新增1处=3（防误改别处）
  chkT('B6 ListView.builder 全文恰3处（600/1667/4297 区域）', (dart.match(/ListView\.builder\(/g) || []).length === 3, (dart.match(/ListView\.builder\(/g) || []).length);
}
console.log(`\n===== v149 库存列表懒加载实例证明 ${total - fail}/${total} PASS =====`);
process.exit(fail ? 1 : 0);
