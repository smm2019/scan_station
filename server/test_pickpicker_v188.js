// ㉖v188 点名盘「从在架勾选」选择器 · 源码锚点证明
// 用户实锤（11-15 截图）：点名盘按项目翻框要手敲几十个零件号。v174 解析器本就支持批量混贴，
// 但"哪些零件在架、各属哪个项目"人要翻 Excel——选择器把这份知识还给系统：搜索+按项目圈选+多选。
const fs = require('fs');
const dart = fs.readFileSync('D:/work_app/scan_station/lib/inventory_page.dart', 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };

const st = dart.indexOf('Future<void> _openPickPicker()');
// 方法定义 + 按钮 onPressed 引用 = 恰好 2 处（首版断言把按钮引用误判"不唯一"，实现正确）
let _oc = -1, _n = 0; while ((_oc = dart.indexOf('_openPickPicker', _oc + 1)) >= 0) _n++;
chk('B1 选择器方法就位且引用闭合（定义+按钮=2处）', st > 0 && _n === 2, 'n=' + _n);
// 数据源：服务器全厂账本（与 buildPickPlan 的 pull 对齐同口径），项目映射 best-effort 失败降级"全部项目"
// timeout(const Duration(…)) 嵌套括号：[^)]* 会在内层 ) 截断（首版 B2 误报根因），改宽松窗
chk('B2 账本源=AuthApi.ledgerGet 带超时兜底', /ledgerGet\(\)[\s\S]{0,60}\.catchError/.test(dart.slice(st, st + 700)), '');
chk('B3 项目映射 projGet 失败静默降级', dart.slice(st, st + 1400).includes('} catch (_) {}'), '');
// 聚合口径：按零件号聚（1零件=1行，副标题给标签数/格位数），不是 250 行标签平铺
chk('B4 按零件聚合标签与格位', dart.slice(st, st + 2100).includes('(codesMap[pn] ??= <String>{}).add') && dart.slice(st, st + 2100).includes('(locMap[pn] ??= <String>{}).add'), '');
// 项目筛选精确码匹配（非前缀），搜索零件号+物料名
chk('B5 项目筛选精确匹配+双字段搜索', dart.slice(st, st + 2900).includes('(pmap[pn] ?? const []).contains(pf)') && dart.slice(st, st + 2900).includes('(nmMap[pn] ?? "").toUpperCase().contains(kq)'), '');
// 填入=追加合并：用户已手敲内容不被吞（先拼 old 再 sorted 填回）
const fillAt = dart.indexOf('_pickCtrl.text = (old.isEmpty', st);
chk('B6 填入为追加合并非覆盖', fillAt > 0 && dart.slice(fillAt, fillAt + 120).includes('old.isEmpty ? "" : "$old\\n"'), '');
chk('B7 填入后自动展开（省一次点击）', dart.includes('if (sel.isNotEmpty && mounted) _expandPick();'), '');
// 弹层规范：isScrollControlled + 键盘避让 + SafeArea + 高度上限（与 requisition_page 同款惯例）
// 实测偏移：useSafeArea@st+1923、viewInsets@st+2656（首版窗 400/300 太短，B8 误报根因）
const sheetAt = dart.indexOf('isScrollControlled: true', st);
chk('B8 弹层键盘避让与安全区', sheetAt > 0 && dart.slice(st, st + 2800).includes('useSafeArea: true') && dart.slice(st, st + 2800).includes('viewInsets.bottom'), '');
// 全选这批=当前筛选集（筛项目→全选34零件一键成），清空独立按钮（实测偏移 st+4224，首版窗 3400 不足）
chk('B9 全选作用于筛选结果', dart.slice(st, st + 4400).includes('sel.addAll(pns)'), '');
// 不动既有：v174 解析器/输入框/展开清单原样保留（选择器是加法不是替换）
chk('B10 v174 解析器未动', dart.includes("split(RegExp(r'[\\s,;，、；\\n]+'))"), '');
chk('B11 手敲输入框保留（双入口并存）', dart.includes('controller: _pickCtrl') && dart.includes('onPressed: _openPickPicker'), '');
// 无 IsarError 教训沿用：选择器不写本机库（纯读+填文本），零落库副作用
chk('B12 选择器零本机写库', !/writeTxn|\.put\(|putAll/.test(dart.slice(st, dart.indexOf('_pickCtrl.text = (old.isEmpty', st))), '');

console.log('\n===== v188 从在架勾选选择器实例证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
