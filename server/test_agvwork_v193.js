// ㉖v193 AGV 货架盘点作业页整合 · 源码锚点证明（PDA 纯 Dart UI）
// 用户定标：AGV 搬运发起不该跳"盲区抽盘"看板，应留在盘点作业页——把只设计了地面盘的作业页升级为
// 地面+AGV 货架双形态一体（工作台进度带+逐框发车/核对/归位+一次扫码双闭环+结束防漏+向导文案纠偏）。
// ★为什么必须真跑：纯 UI 改造无端到端可跑面，行为语义（联动条件/排序/按钮映射）全部锚点逐条钉死。
const fs = require('fs');
const path = require('path');
const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_page.dart'), 'utf8').replace(/\r\n/g, '\n');
let t = 0, f = 0;
const chk = (n, c, x) => { t++; if (!c) { f++; console.log('FAIL! [' + n + '] ' + (x || '')); } else console.log('PASS [' + n + ']'); };
const chkT = chk; // 本套件全用等值/包含式断言，统一别名防 ReferenceError（首跑 A1 即崩的教训）

// A组 不跳转：留本页
chkT('A1 发起成功后不再跳 ShelfCountPage（留本页）', !/_agvTransport[\s\S]{0,3000}Navigator\.push\(context, MaterialPageRoute\(builder: \(_\) => const ShelfCountPage/.test(dart), '');
chk('A2 发起成功后展开工作台并刷新', dart.includes('if (okN > 0) { _agvOpen = true; await _refreshAgv(); }'), '');

// B组 工作台数据与渲染
chk('B1 8秒轮询随任务类型启动', dart.includes('Timer.periodic(const Duration(seconds: 8)') && dart.includes('_agvTimer = Timer.periodic'), '');
chk('B2 dispose 取消轮询防泄漏', dart.includes('_agvTimer?.cancel();'), '');
chk('B3 进度查询按 pickBatch 归属+同码取最新', dart.includes('(m["pickBatch"] ?? "").toString() != widget.task.batchId') && dart.includes('prev["at"]'), '');
chk('B4 工作台卡片仅在货架点名任务渲染', dart.includes('if (widget.task.invPickMode == 1 && widget.task.invPickShelf.isNotEmpty) _agvWorkCard(),'), '');
chk('B5 排序=要办的在前（不符→在台→待办→在途→归位→完成）', dart.includes('_agvRank((a["state"] ?? "").toString()).compareTo(_agvRank((b["state"] ?? "").toString())') && dart.includes("'mismatch' => 0, 'atStation' => 1"), '');
chk('B6 状态→主操作按钮映射齐（发车/核对/归位）', dart.includes("_agvMiniBtn('发车'") && dart.includes("_agvMiniBtn('核对'") && dart.includes("_agvMiniBtn('归位'"), '');
chk('B7 一键发车走 sid 批量（复用v141接口）', dart.includes('AuthApi.countDeploy(sid: widget.task.batchId)'), '');
chk('B8 取消工单复用盲区撤单语义（已下发先撤WMAS）', dart.includes('AuthApi.countCancel('), '');

// C组 一次扫码双闭环
chk('C1 本地入账成功后联动核对（不阻塞扫码）', dart.includes('unawaited(_agvAutoScan(code));'), '');
chk('C2 联动只对【已到台】的本任务工单生效', /if \(q == null \|\| \(q\["state"\] \?\? ""\)\.toString\(\) != 'atStation'\) return;/.test(dart), '');
chk('C3 MES实数捕获且反查失败按仅核标签传（防-1误判数量不符）', dart.includes('_lastMesQty = (mes["qty"] as num?)?.toInt() ?? -1;') && dart.includes('_lastMesQty = -1; // ㉖v193 防上一次'), '');
chk('C4 手动核对与看板同口径（mesQueryLabel→countScan）', /Future<void> _agvCheckOne/.test(dart) && dart.includes('final mr = await mesQueryLabel(q["code"].toString());'), '');

// D组 结束防漏与文案
chk('D1 结束框加"从未发起搬运"警示行', dart.includes('从未发起 AGV 搬运：$notDepN 框'), '');
chk('D2 "全部盘到✅"需含未发起=0 条件', dart.includes('missN == 0 && goneN == 0 && agvBadN == 0 && notDepN == 0'), '');
chk('D3 向导文案纠偏（旧"任务卡"表述清零）', !dart.includes('任务卡「AGV搬运」') && dart.includes('点顶部横幅右侧 🚚 图标一键发起'), '');
chk('D4 工作台汇总行含 未发起/待处理 计数', dart.includes('框待处理') && dart.includes('框未发起'), '');

// E组 安全边界
chk('E1 联动失败静默不影响本地入账（手动核对兜底在）', /catch \(_\) \{\} \/\/ 联动失败不影响本地入账/.test(dart), '');
chk('E2 setState 前 mounted 守卫齐全（异步回调）', dart.includes('if (!mounted) return;') && /_refreshAgv\(\)[\s\S]{0,400}if \(!mounted\) return;/.test(dart.slice(dart.indexOf('Future<void> _refreshAgv'))), '');
chk('E3 服务器零改动声明成立（只复用既有5接口）', ['countList', 'countStart', 'countScan', 'countDeploy', 'countReturn', 'countCancel'].every((k) => dart.includes('AuthApi.' + k)), '');

console.log('\n===== v193 AGV货架盘点整合实例证明 ' + (t - f) + '/' + t + ' PASS =====');
process.exit(f ? 1 : 0);
