part of 'main.dart';

// ===================== 库存模块 =====================
// 设计：入库流水=采集记录(未作废)派生；出库流水=出库台账(直调)派生；
// 库存=期初+Σ入库-Σ出库，全部实时计算，不建第三张结存表，永不脱账。
// 新增两张实体表：期初(手动导入)、货架库位占用(一货位一框)。

@collection
class InventoryOpening {
  Id id = Isar.autoIncrement;
  String partNo = ""; // 零件号
  String itemName = ""; // 物料名字
  double qty = 0; // 期初数量
  String loc = ""; // 货位（可空）
  String container = ""; // 料框类型（可空）
  String operator = ""; // 导入人
  late int importedAt; // 导入时间戳
}

@collection
class ShelfPlacement {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  String goodsCode = ""; // 货物标签号（一框一条占用）
  String loc = ""; // 完整货架库位编码，如 MB02-A-01-2F
  String container = ""; // 料框类型（登记时带出）
  String operator = ""; // 登记人
  late int assignedAt; // 登记时间
}

/// 库存聚合计算结果
class _StockAgg {
  final Map<String, _StockPartRow> parts = {}; // partNo -> 行
  final List<_StockInRow> inRows = []; // 入库流水
  final List<_StockOutRow> outRows = []; // 出库流水
  final Map<String, List<_StockBox>> byLoc = {}; // 货架库位 -> 框
  final List<_StockBox> unplaced = []; // 在库未分配货架
  int todayIn = 0, todayOut = 0; // ㉖v52 今日入/出库框数（自然日）
  int staleBoxes = 0; // 滞留 7 天+ 在库框
  int freshBoxes = 0; // 3 天内新入在库框
}

class _StockPartRow {
  String partNo = "";
  String itemName = "";
  double opening = 0, inQty = 0, outQty = 0;
  double inStockQty = 0; // 在库标签数量合计（未作废且未出库）
  int inBoxes = 0; // 在库框数
  final Map<String, int> byLocDist = {}; // ㉖v52 在库框按货位分布（前缀归并，同网页零件档案）
  int staleBoxes = 0; // ㉖v52 滞留 7 天+ 框数
  double get perBoxQty =>
      inBoxes > 0 ? inStockQty / inBoxes : 0; // 平均件/框（发料最小单位=1框）
  double get stock => opening + inStockQty; // 标签台账法：库存=在库框合计(+可选期初)
}

class _StockInRow {
  late DateTime time;
  String barcode = "",
      partNo = "",
      itemName = "",
      loc = "",
      container = "",
      operator = "";
  double qty = 0;
  bool cancelled = false;
}

class _StockOutRow {
  late DateTime time;
  String barcode = "",
      partNo = "",
      itemName = "",
      loc = "",
      orderNo = "",
      operator = "";
  double qty = 0;
}

class _StockBox {
  String barcode = "",
      partNo = "",
      itemName = "",
      container = "",
      operator = "",
      loc = "";
  double qty = 0;
  double inStockQty = 0; // ㉖v59 方案B：框内在库量=未发标签数量之和（半发托只扣已发码，不整框连坐）
  bool inStock = true; // 框内仍有未发标签即在库（方案B逐码口径）
  int ageH = -1; // ㉖v52 在库滞留小时（登记时刻起算；-1=时刻缺失）
}

/// 全量聚合（数据量万级以内，内存计算毫秒级）
Future<_StockAgg> computeStock() async {
  final isar = _globalIsar;
  final agg = _StockAgg();
  final records = await isar.scanRecords.where().findAll();
  records.sort((a, b) => a.scanTime.compareTo(b.scanTime));
  final extras = await isar.recordExtras.where().findAll();
  final extraMap = {for (final e in extras) e.goodsCode: e};
  final outs = await isar.outboundOrders.where().findAll();
  final openings = await isar.inventoryOpenings.where().findAll();
  final placements = await isar.shelfPlacements.where().findAll();
  final placedMap = {for (final p in placements) p.goodsCode: p};
  final labelInfos = await isar.labelInfos.where().findAll();
  final infoMap = {for (final e in labelInfos) e.goodsCode: e};

  // 已出库标签集合（出库台账摊平）
  final outCodes = <String>{};
  for (final o in outs) {
    final t = DateTime.fromMillisecondsSinceEpoch(o.createdAt);
    try {
      for (final e in (jsonDecode(o.itemsJson) as List)) {
        final m = Map<String, dynamic>.from(e as Map);
        final code = m["barcode"]?.toString() ?? "";
        if (code.isEmpty) continue;
        outCodes.add(code);
        agg.outRows.add(_StockOutRow()
          ..time = t
          ..barcode = code
          ..partNo = m["code"]?.toString() ?? ""
          ..itemName = m["name"]?.toString() ?? ""
          ..qty = (m["qty"] as num?)?.toDouble() ?? 0
          ..loc = o.toLoc
          ..orderNo = o.orderNo
          ..operator = o.operator);
      }
    } catch (_) {}
  }

  // 领料单已发料标签（本地缓存，离线可用）：同样从在库中剔除
  final reqIssued = await RequisitionCache.loadIssued();
  outCodes.addAll(reqIssued);

  // 统一按"框"聚合后再算库存：MES 标签数量是整框数（同托每码都回整框值），
  // 框键=托号优先，其次"货位+零件号"（同位同件视为同框），都缺才一码一框。
  final boxesByKey = <String, _StockBox>{}; // ㉖v52 键改标签号：同托多码仍各自留框（分布/滞留需要），下方汇总处再按框键合并
  String boxKey(String pid, String loc, String partNo, String code) => pid
          .isNotEmpty
      ? "P|$pid"
      : (loc.isNotEmpty && partNo.isNotEmpty ? "L|$loc|$partNo" : "C|$code");
  void addBox(String key, _StockBox box) {
    boxesByKey[key] = box;
  }

  final _boxSeen = <String>{}; // ㉖ sum 口径防护：同码多条有效采集记录只计一次（流水行仍全量展示）
  for (final r in records) {
    final cancelled = r.isCancel;
    final partNo = r.mesPartNo ?? "";
    final name = extraMap[r.goodsCode]?.mesItemName ?? "";
    final qty = r.mesQty ?? 0;
    final loc =
        r.workType == 0 ? (r.stationNo ?? "") : (r.groundLocation ?? "");
    final oper = extraMap[r.goodsCode]?.operator ?? "历史记录";
    agg.inRows.add(_StockInRow()
      ..time = r.scanTime
      ..barcode = r.goodsCode
      ..partNo = partNo
      ..itemName = name
      ..qty = qty
      ..loc = loc
      ..container = r.containerType ?? ""
      ..operator = oper
      ..cancelled = cancelled);
    if (cancelled || partNo.isEmpty) continue;
    if (!_boxSeen.add(r.goodsCode.toUpperCase())) continue; // 同码已计过框→跳过
    final p = placedMap[r.goodsCode];
    final pid = extraMap[r.goodsCode]?.palletId ?? "";
    addBox(
        r.goodsCode.toUpperCase(),
        _StockBox()
          ..barcode = r.goodsCode
          ..partNo = partNo
          ..itemName = name
          ..qty = qty
          ..container = r.containerType ?? ""
          ..operator = oper
          ..loc = loc
          ..ageH = ((DateTime.now()).difference(r.scanTime).inMinutes / 60).floor()
          ..inStock = !outCodes.contains(r.goodsCode)
          ..inStockQty = outCodes.contains(r.goodsCode) ? 0 : qty);
  }

  // 出库扣减（按出库流水零件号汇总；出库的框已从在库剔除）
  for (final o in agg.outRows) {
    if (o.partNo.isEmpty) continue;
    final row = agg.parts
        .putIfAbsent(o.partNo, () => _StockPartRow()..partNo = o.partNo);
    if (row.itemName.isEmpty) row.itemName = o.itemName;
    row.outQty += o.qty;
  }

  // 账本独有存量货（只进过账本、本机无采集流水）→ 并入同一框集合
  final flowCodes = records.map((r) => r.goodsCode.toUpperCase()).toSet();
  for (final p in placements) {
    if (flowCodes.contains(p.goodsCode)) continue;
    final info = infoMap[p.goodsCode];
    if (info == null || info.missing || info.partNo.isEmpty) continue;
    final b = boxesByKey[p.goodsCode.toUpperCase()];
    if (b != null) {
      // 账本带权威信息补全流水框：容器/操作人/货位以账本为准；滞留取更早入账时刻（流水扫描 vs 账本登记）
      if ((p.container ?? "").isNotEmpty) b.container = p.container;
      if ((p.operator ?? "").isNotEmpty && b.operator.isEmpty) b.operator = p.operator;
      if (b.loc.isEmpty && p.loc.isNotEmpty) b.loc = p.loc;
      final age2 = ((DateTime.now()).difference(DateTime.fromMillisecondsSinceEpoch(p.assignedAt)).inMinutes / 60).floor();
      if (b.ageH < 0 || age2 > b.ageH) b.ageH = age2; // assignedAt 是登记入账时刻，取更大滞留
    } else {
      addBox(
          p.goodsCode.toUpperCase(),
          _StockBox()
            ..barcode = p.goodsCode
            ..partNo = info.partNo
            ..itemName = info.itemName
            ..qty = info.qty
            ..container = p.container
            ..operator = p.operator
            ..loc = p.loc
            ..ageH = ((DateTime.now()).difference(DateTime.fromMillisecondsSinceEpoch(p.assignedAt)).inMinutes / 60).floor()
            ..inStock = !outCodes.contains(p.goodsCode)
            ..inStockQty = outCodes.contains(p.goodsCode) ? 0 : info.qty);
    }
  }

  // 零件汇总与货架分布：先按"框键"合并标签级框（同托多码=1框，数量求和；㉖v59方案B：逐码发料，任一码在库即框在库，在库量=未发码之和），再派生统计
  // ㉖v99 托号两级回退：本机采集扩展（自己扫的托）→ LabelInfo 账本缓存（别机扫的托，拉取时已带 pid 入库）——
  // 旧版只认本机扩展托号，未亲手扫过整托的设备把同托分位框按货位拆开数，在库框数各设备不一致（314 vs 305）
  final merged = <String, _StockBox>{};
  String pidOf(String code) {
    final a = extraMap[code]?.palletId ?? "";
    if (a.isNotEmpty) return a;
    return infoMap[code]?.palletId ?? "";
  }
  for (final b in boxesByKey.values) {
    final k = boxKey(pidOf(b.barcode), b.loc, b.partNo, b.barcode);
    final old = merged[k];
    if (old == null) {
      merged[k] = b;
    } else {
      old.qty += b.qty; // ㉖ 框数量=框内各标签之和（一筐两标签各25→50）
      old.inStockQty += b.inStockQty; // ㉖v59 在库量=未发标签之和（半发托不整框连坐）
      old.inStock = old.inStock || b.inStock; // ㉖v59 方案B：框内任一标签未发→框仍在库（旧口径"任一已发整框出库"作废）
      if (old.loc.isEmpty && b.loc.isNotEmpty) old.loc = b.loc;
      if (old.ageH < 0 || (b.ageH >= 0 && b.ageH > old.ageH)) old.ageH = b.ageH; // 同托取最早入账（最大滞留）
    }
  }
  for (final box in merged.values) {
    final row = agg.parts
        .putIfAbsent(box.partNo, () => _StockPartRow()..partNo = box.partNo);
    if (row.itemName.isEmpty) row.itemName = box.itemName;
    row.inQty += box.qty; // 入库合计按框计一次
    if (!box.inStock) continue;
    row.inBoxes++;
    row.inStockQty += box.inStockQty; // ㉖v59 方案B：在库量=框内未发码之和（半发托只算剩余码）
    if (box.ageH >= 168) { row.staleBoxes++; agg.staleBoxes++; }
    else if (box.ageH >= 0 && box.ageH < 72) agg.freshBoxes++;
    if (box.loc.isNotEmpty) {
      agg.byLoc.putIfAbsent(box.loc, () => []).add(box);
      // 货位前两段归并做分布展示（NB02-A-05-2F → NB02-A · 2F 太碎，聚到巷道级）
      final parts = box.loc.split("-");
      final distKey = parts.length >= 2 ? "${parts[0]}-${parts[1]}" : box.loc;
      row.byLocDist[distKey] = (row.byLocDist[distKey] ?? 0) + 1;
    } else {
      agg.unplaced.add(box);
    }
  }

  // ㉖v99 今日出入库改服务器全厂口径（自然日）：旧版按本机流水/本机遇历统计，"谁扫的算谁的"→
  // 两台仓管设备同屏 0 vs 40 不一致。取 /api/counts todayIn/todayOut（60秒缓存，45秒自动刷新的库存页够用）；
  // 服务器不通时保留本机口径兜底（下方 fallback 值），离线不空白
  final _day0 = DateTime.now().copyWith(hour: 0, minute: 0, second: 0, millisecond: 0);
  final _fbIn = agg.inRows.where((r) => !r.cancelled && r.time.isAfter(_day0)).map((r) => r.barcode.toUpperCase()).toSet().length;
  final _fbOut = agg.outRows.where((r) => r.time.isAfter(_day0)).map((r) => r.barcode.toUpperCase()).toSet().length;
  final _srv = await _todayCountsCached();
  agg.todayIn = _srv?["todayIn"] as int? ?? _fbIn;
  agg.todayOut = _srv?["todayOut"] as int? ?? _fbOut;

  // 期初
  for (final op in openings) {
    if (op.partNo.isEmpty) continue;
    final row = agg.parts
        .putIfAbsent(op.partNo, () => _StockPartRow()..partNo = op.partNo);
    if (row.itemName.isEmpty) row.itemName = op.itemName;
    row.opening += op.qty;
  }
  // ㉖v98 并入服务器零件全集（字典∪账本∪流水∪出库∪领料）：
  // 零库存清单原靠本机采集流水撑（新设备/清内存后"查无此件"，物料员搜不到也无法预约；
  // 且账本世代对齐会清空本机流水，老设备同样会一夜归零）——改用全厂背书，任何设备结果一致
  final backing = await _partsBackingCached();
  for (final e in backing.entries) {
    final pn = e.key;
    final row = agg.parts.putIfAbsent(pn, () => _StockPartRow()..partNo = pn);
    if (row.itemName.isEmpty && e.value.isNotEmpty) row.itemName = e.value;
  }
  return agg;
}

/// 零件全集缓存（5 分钟）：库存页 45 秒自动刷新不重复打服务器
Map<String, String> _backingCache = {};
int _backingAt = 0;
void invalidatePartsBacking() { _backingAt = 0; } // ㉖v98 一键对齐时强制下次重拉全集（0 让 5 分钟窗失效）

// ㉖v99 今日出入库全厂口径缓存（60 秒）：/api/counts todayIn/todayOut；失败返回 null 由调用方本机兜底
Map<String, int>? _todayCache;
int _todayCacheAt = 0;
int _todayFailAt = 0; // ㉖v99 复检加固：失败退避 120 秒——库存页45秒自动刷新，离线时不再每轮空等6秒超时
Future<Map<String, int>?> _todayCountsCached() async {
  final now = DateTime.now().millisecondsSinceEpoch;
  if (_todayCache != null && now - _todayCacheAt < 60000) return _todayCache;
  // 复检v100：退避不再限"从未成功"——曾成功过但服务器转离线时，过期后每45秒仍会空等6秒超时；
  // 任意失败后 120 秒内一律直接回退（有旧值用旧值，无旧值 null→本机口径）
  if (now - _todayFailAt < 120000) return _todayCache;
  try {
    final r = await AuthApi.counts().timeout(const Duration(seconds: 6));
    if (r["ok"] == true && r["todayIn"] is num) {
      _todayCache = {"todayIn": (r["todayIn"] as num).toInt(), "todayOut": ((r["todayOut"] as num?) ?? 0).toInt()};
      _todayCacheAt = now;
      _todayFailAt = 0;
      return _todayCache;
    }
    _todayFailAt = now;
  } catch (_) {
    _todayFailAt = now;
  } // 服务器不通：退避窗口内不再打点
  return _todayCache; // 拉取失败但有过旧值：续用旧值（比闪回本机口径稳）
}
Future<Map<String, String>> _partsBackingCached() async {
  final now = DateTime.now().millisecondsSinceEpoch;
  if (_backingCache.isNotEmpty && now - _backingAt < 300000) return _backingCache;
  try {
    final r = await AuthApi.partsBacking().timeout(const Duration(seconds: 8));
    if (r["ok"] == true) {
      final m = <String, String>{};
      for (final x in List<Map>.from(r["list"] ?? [])) {
        final pn = (x["pn"]?.toString() ?? "").trim().toUpperCase();
        if (pn.isEmpty) continue;
        m[pn] = x["nm"]?.toString() ?? "";
      }
      if (m.isNotEmpty) {
        _backingCache = m;
        _backingAt = now;
      }
    }
  } catch (_) {} // 服务器不通：退回本机口径（已有行不受影响），不阻塞库存页
  return _backingCache;
}

String _invRelTime(DateTime t) {
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return "刚刚";
  if (d.inMinutes < 60) return "${d.inMinutes} 分钟前";
  if (d.inHours < 24) return "${d.inHours} 小时前";
  if (d.inDays < 2) return "昨天";
  if (d.inDays < 8) return "${d.inDays} 天前";
  return "${t.month}月${t.day}日";
}

String _invCsvEsc(String v) =>
    (v.contains(",") || v.contains("\"") || v.contains("\n"))
        ? "\"${v.replaceAll("\"", "\"\"")}\""
        : v;

// ===================== 库存主页面（嵌入主页「库存」Tab） =====================
class InventoryStockPage extends StatefulWidget {
  const InventoryStockPage({super.key});
  @override
  State<InventoryStockPage> createState() => _InventoryStockPageState();
}

class _InventoryStockPageState extends State<InventoryStockPage>
    with SingleTickerProviderStateMixin {
  late TabController _tc;
  _StockAgg? _agg;
  bool _loading = true;
  bool _busyPull = false; // ㉖v98 状态灯防重入
  String _search = "";
  @override
  void initState() {
    super.initState();
    _tc = TabController(length: 4, vsync: this);
    _autoPullThenReload();
    _stockTimer = Timer.periodic(
        const Duration(seconds: 45), (_) => _reloadSilent()); // ⑪自动刷新
  }

  // ㉖v98 同步状态灯：绿<2分钟 · 橙<10分钟 · 红≥10分钟（点灯=立即强制对齐）
  Color _syncLampColor() {
    final t = ledgerLastSyncAt;
    if (t == null) return Colors.red;
    final age = DateTime.now().difference(t);
    if (age.inMinutes < 2) return const Color(0xFF43A047);
    if (age.inMinutes < 10) return const Color(0xFFEF6C00);
    return const Color(0xFFE53935);
  }

  Future<void> _autoPullThenReload() async {
    // ㉖ 进页强制与服务器账本对齐（旧5分钟节流致"别台刚入库的框本机看不到"）；函数内20秒全局节流防重复
    if (_busyPull) return;
    _busyPull = true;
    try {
      await ledgerPullMerge(force: true);
      await _reload();
    } finally {
      _busyPull = false;
      if (mounted) setState(() {}); // ㉖v98 对齐完成灯色即时转绿
    }
  }

  @override
  void dispose() {
    _tc.dispose();
    _stockTimer?.cancel();
    super.dispose();
  }

  Timer? _stockTimer; // ⑪自动刷新

  Future<void> _reload() async {
    if (!mounted)
      return; // ㉖⑮ 修设备异常上报抓到的崩溃：initState→await账本合并→切页销毁后 setState 炸 _element!
    setState(() => _loading = true);
    final agg = await computeStock();
    if (!mounted) return;
    setState(() {
      _agg = agg;
      _loading = false;
    });
  }

  /// 静默重算：不转圈（keep-alive 后台也跑，切回即最新）
  Future<void> _reloadSilent() async {
    await ledgerPullMerge(); // ㉖ 先对齐服务器账本（20秒内刚拉过自动跳过），再重算——45秒周期即最迟45秒看到别台入库
    final agg = await computeStock();
    if (!mounted) return;
    setState(() => _agg = agg);
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Container(
        color: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        child: Row(children: [
          Expanded(
              child: TabBar(
            controller: _tc,
            isScrollable: true,
            tabAlignment: TabAlignment.start,
            labelColor: const Color(0xFF515BD4),
            unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFF515BD4),
            tabs: const [
              Tab(text: "库存汇总"),
              Tab(text: "货架库位"),
              Tab(text: "出入库流水"),
              Tab(text: "我的预约")
            ],
          )),
          if (ledgerLastSyncAt != null)
            Padding(
                padding: const EdgeInsets.only(right: 2),
                child: Tooltip(
                    message: '上次与服务器对齐：${TimeOfDay.fromDateTime(ledgerLastSyncAt!).format(context)}\n点圆点立即重新对齐（绿<2分钟 · 橙<10分钟 · 红≥10分钟）',
                    child: InkWell(
                        borderRadius: BorderRadius.circular(10),
                        onTap: _busyPull ? null : _autoPullThenReload,
                        child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                            child: Row(mainAxisSize: MainAxisSize.min, children: [
                              Container(
                                  width: 9, height: 9,
                                  decoration: BoxDecoration(
                                      shape: BoxShape.circle,
                                      color: _syncLampColor())),
                              const SizedBox(width: 3),
                              Text(
                                  '同步 ${TimeOfDay.fromDateTime(ledgerLastSyncAt!).format(context)}',
                                  style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
                            ]))))),
          if (Auth.can("agv_control"))
            IconButton(
                tooltip: "货架移库（AGV整架搬位）",
                icon: const Icon(Icons.swap_horiz, color: Color(0xFFEF6C00)),
                onPressed: () => showTransferDialog(context)),
          IconButton(
              tooltip: "出入库全链路查询",
              icon: const Icon(Icons.route, color: Color(0xFF515BD4)),
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const TracePage()))),
          IconButton(
              tooltip: "刷新（与电脑账本对齐）",
              icon: const Icon(Icons.refresh, color: Color(0xFF515BD4)),
              onPressed: _autoPullThenReload),
        ]),
      ),
      Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : TabBarView(
                  controller: _tc,
                  physics:
                      const NeverScrollableScrollPhysics(), // 内层只点不滑，横滑留给外层换模块
                  children: [
                    _StockSummaryTab(
                        agg: _agg!,
                        search: _search,
                        onSearch: (v) => setState(() => _search = v),
                        onReload: _reload),
                    _ShelfTab(agg: _agg!),
                    _FlowTab(agg: _agg!),
                    _WatchTab(agg: _agg!),
                  ],
                )),
    ]);
  }
}

// ---------- Tab1 库存汇总 ----------
class _StockSummaryTab extends StatefulWidget {
  final _StockAgg agg;
  final String search;
  final ValueChanged<String> onSearch;
  final VoidCallback onReload;
  const _StockSummaryTab(
      {required this.agg,
      required this.search,
      required this.onSearch,
      required this.onReload});

  @override
  State<_StockSummaryTab> createState() => _StockSummaryTabState();
}

class _StockSummaryTabState extends State<_StockSummaryTab> {
  String _flt = ""; // ""全部 / stale滞留7天+ / zero断料 / loc按货位分布排序

  Future<void> _export(BuildContext ctx) async {
    final b = StringBuffer("零件号,物料名字,在库框数,在库数量,期初(可选),历史入库合计,历史出库合计\n");
    final rows = widget.agg.parts.values.toList()
      ..sort((x, y) => x.partNo.compareTo(y.partNo));
    for (final r in rows) {
      b.writeln(
          "${_invCsvEsc(r.partNo)},${_invCsvEsc(r.itemName)},${r.inBoxes},${_fmtInvNum(r.inStockQty)},${_fmtInvNum(r.opening)},${_fmtInvNum(r.inQty)},${_fmtInvNum(r.outQty)}");
    }
    final dir = await getExternalStorageDirectory();
    if (dir == null || !ctx.mounted) return;
    final f =
        File("${dir.path}/库存汇总_${DateTime.now().millisecondsSinceEpoch}.csv");
    await f.writeAsString("\uFEFF${b.toString()}", encoding: utf8);
    if (ctx.mounted)
      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
          content: Text("已保存：${f.path}"), backgroundColor: Colors.green));
  }

  Color _ageColor(int ageH) =>
      ageH >= 168 ? const Color(0xFFE53935) : (ageH >= 72 ? const Color(0xFFFB8C00) : const Color(0xFF43A047));

  @override
  Widget build(BuildContext context) {
    final agg = widget.agg;
    var rows = agg.parts.values.toList();
    final k = widget.search.trim().toLowerCase();
    if (k.isNotEmpty) {
      rows = rows
          .where((r) =>
              r.partNo.toLowerCase().contains(k) ||
              r.itemName.toLowerCase().contains(k))
          .toList();
    }
    if (_flt == "stale") {
      rows = rows.where((r) => r.staleBoxes > 0).toList();
    } else if (_flt == "zero") {
      rows = rows.where((r) => r.inBoxes == 0 && r.stock <= 0).toList();
    }
    // ㉖v69 界面优化：零库存沉底成组（单次稳定排序：组间沉底、组内保持零件号/分散度次序，避免两轮sort打乱）
    rows.sort((x, y) {
      final xz = (x.inBoxes == 0 && x.stock <= 0) ? 1 : 0;
      final yz = (y.inBoxes == 0 && y.stock <= 0) ? 1 : 0;
      if (xz != yz) return xz - yz;
      if (_flt == "loc") {
        final d = y.byLocDist.length.compareTo(x.byLocDist.length);
        if (d != 0) return d;
      }
      return x.partNo.compareTo(y.partNo);
    });
    final firstEmpty = rows
        .indexWhere((r) => r.inBoxes == 0 && r.stock <= 0);
    // ㉖v52 新鲜度点/分布摘要一次预计算（列表逐帧不重复扫 byLoc）
    final dots = <String, List<Widget>>{};
    final dotSeen = <String>{}; // 同托多码只画一点（与"框数"口径一致）
    for (final e in agg.byLoc.entries) {
      for (final b in e.value) {
        final dk = "${b.partNo}|${b.barcode}";
        if (!dotSeen.add(dk)) continue;
        (dots[b.partNo] ??= []).add(Container(
            width: 7,
            height: 7,
            margin: const EdgeInsets.only(right: 2),
            decoration: BoxDecoration(
                color: _ageColor(b.ageH),
                shape: BoxShape.circle,
                border: Border.all(color: Colors.white, width: .5))));
      }
    }
    final distOf = <String, List<MapEntry<String, int>>>{};
    for (final r in rows) {
      final d = r.byLocDist.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));
      distOf[r.partNo] = d;
    }
    final totalBoxes = agg.parts.values.fold<int>(0, (s, r) => s + r.inBoxes);
    final totalQty = agg.parts.values.fold<double>(0, (s, r) => s + r.inStockQty);
    final hasHdr = _flt != "zero" && firstEmpty >= 0; // ㉖v69 零库存分组头（筛选零库存时不折叠）
    chip(String key, String txt, Color c) => ChoiceChip(
        label: Text(txt, style: TextStyle(fontSize: 11.5, color: _flt == key ? Colors.white : c)),
        selected: _flt == key,
        showCheckmark: false,
        selectedColor: c,
        labelPadding: const EdgeInsets.symmetric(horizontal: 6),
        onSelected: (_) => setState(() => _flt = _flt == key ? "" : key));
    return Column(children: [
      // ㉖v52 顶部 KPI 条（借鉴网页概览/容器管理：一眼看清家底与健康度）
      Container(
          width: double.infinity,
          color: Colors.white,
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
          child: Wrap(spacing: 8, runSpacing: 6, children: [
            _kpiCard('零件种类', '${agg.parts.length}', const Color(0xFF515BD4)),
            _kpiCard('在库框数', '$totalBoxes', const Color(0xFF00897B)),
            _kpiCard('在库数量', _fmtInvNum(totalQty), const Color(0xFF3949AB)),
            _kpiCard('今日入库', '${agg.todayIn}框', const Color(0xFF43A047)),
            _kpiCard('今日出库', '${agg.todayOut}框', const Color(0xFFEF6C00)),
            if (agg.staleBoxes > 0)
              _kpiCard('滞留7天+', '${agg.staleBoxes}框', const Color(0xFFE53935)),
          ])),
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 0),
          child: Row(children: [
            Expanded(
                child: TextField(
              onChanged: widget.onSearch,
              decoration: InputDecoration(
                  hintText: "搜索零件号/物料名字",
                  isDense: true,
                  filled: true,
                  fillColor: Colors.white,
                  prefixIcon: const Icon(Icons.search, size: 20),
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8))),
            )),
            const SizedBox(width: 8),
            IconButton(
                onPressed: () => _export(context),
                icon: const Icon(Icons.download, color: Color(0xFF515BD4))),
          ])),
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 6, 10, 0),
          child: Row(children: [
            chip("", '全部', Colors.blueGrey),
            const SizedBox(width: 6),
            chip('stale', '🧊有滞留', const Color(0xFFE53935)),
            const SizedBox(width: 6),
            chip('zero', '⛔零库存', const Color(0xFF757575)),
            const SizedBox(width: 6),
            chip('loc', '📍按分散度', const Color(0xFF00897B)),
            const Spacer(),
            TextButton.icon(
                style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 6), visualDensity: VisualDensity.compact, foregroundColor: const Color(0xFF07C160)),
                onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ShortageReportPage())),
                icon: const Icon(Icons.share, size: 15),
                label: const Text("缺料分享", style: TextStyle(fontSize: 11.5))),
            Text('${rows.length} 项',
                style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
          ])),
      Expanded(
          child: rows.isEmpty
              ? const Center(
                  child: Text("暂无库存数据", style: TextStyle(color: Colors.grey)))
              : ListView.builder(
                  padding: const EdgeInsets.all(10),
                  itemCount: rows.length + (hasHdr ? 1 : 0),
                  itemBuilder: (ctx, i) {
                    if (hasHdr && i == firstEmpty) {
                      return Padding(
                          padding: const EdgeInsets.only(top: 12, bottom: 2),
                          child: Row(children: [
                            Text("⛔ 零库存 ${rows.length - firstEmpty} 项 · 不在架",
                                style: TextStyle(
                                    fontSize: 11.5,
                                    fontWeight: FontWeight.w700,
                                    color: Colors.grey.shade600)),
                            const SizedBox(width: 8),
                            Expanded(child: Divider(color: Colors.grey.shade300)),
                          ]));
                    }
                    final r = rows[hasHdr && i > firstEmpty ? i - 1 : i];
                    final empty = r.inBoxes == 0;
                    // ㉖v69 纯零库存（无期初）沉底紧凑单行；筛选"零库存"时保留完整卡片
                    if (empty && r.stock <= 0 && _flt != "zero") {
                      return InkWell(
                          onTap: () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                  builder: (_) =>
                                      PartProfilePage(partNo: r.partNo))),
                          child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 10, vertical: 7),
                              decoration: BoxDecoration(
                                  border: Border(
                                      bottom:
                                          BorderSide(color: Colors.grey.shade200))),
                              child: Row(children: [
                                const Icon(Icons.remove_circle_outline,
                                    size: 13, color: Color(0xFF9E9E9E)),
                                const SizedBox(width: 6),
                                Expanded(
                                    child: Text("${r.partNo}  ${r.itemName}",
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                            fontSize: 11.5,
                                            color: Colors.black54))),
                                Text("0",
                                    style: TextStyle(
                                        fontSize: 12,
                                        color: Colors.grey.shade400,
                                        fontWeight: FontWeight.w600)),
                              ])));
                    }
                    // 分布摘要：NB02-A×3 · NB03-B×2（巷道级，最多列 3 处）
                    final dist = distOf[r.partNo] ?? const [];
                    final distTxt = dist
                        .take(3)
                        .map((e) => '${e.key.replaceFirst("NB0", "").replaceFirst("-0", "-")}×${e.value}')
                        .join(' · ');
                    return Card(
                      margin: const EdgeInsets.symmetric(vertical: 4),
                      child: ListTile(
                        dense: true,
                        onTap: () => Navigator.push(
                            context,
                            MaterialPageRoute(
                                builder: (_) =>
                                    PartProfilePage(partNo: r.partNo))),
                        title: Row(children: [
                          Flexible(
                              child: Text("${r.partNo}  ${r.itemName}",
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w500))),
                          if (r.staleBoxes > 0)
                            Container(
                                margin: const EdgeInsets.only(left: 6),
                                padding: const EdgeInsets.symmetric(
                                    horizontal: 5, vertical: 1),
                                decoration: BoxDecoration(
                                    color: const Color(0xFFFFEBEE),
                                    borderRadius: BorderRadius.circular(8)),
                                child: Text('🧊${r.staleBoxes}',
                                    style: const TextStyle(
                                        fontSize: 10, color: Color(0xFFE53935)))),
                        ]),
                        subtitle: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                  empty
                                      ? "⛔ 无在库框${r.opening > 0 ? "（仅期初 ${_fmtInvNum(r.opening)}）" : ""} · 点击查看全链路"
                                      : "在库 ${r.inBoxes} 框 · ${_fmtInvNum(r.inStockQty)} 件${r.opening > 0 ? " · 另有期初" : ""}${distTxt.isNotEmpty ? " · $distTxt${dist.length > 3 ? " 等${dist.length}处" : ""}" : ""}",
                                  style: TextStyle(
                                      fontSize: 11,
                                      color: empty
                                          ? const Color(0xFF9E9E9E)
                                          : Colors.blueGrey)),
                              if (!empty)
                                Padding(
                                    padding: const EdgeInsets.only(top: 3),
                                    child: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text("新鲜度 ",
                                              style: TextStyle(
                                                  fontSize: 10.5,
                                                  color: Colors.grey.shade500)),
                                          ...dots[r.partNo]!.take(24),
                                        ])),
                            ]),
                        trailing: Text(
                            empty ? "—" : _fmtInvNum(r.stock),
                            style: TextStyle(
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                                color: empty
                                    ? const Color(0xFFBDBDBD)
                                    : const Color(0xFF2E7D32))),
                      ),
                    );
                  },
                )),
    ]);
  }
}

Widget _kpiCard(String t, String v, Color c) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    decoration: BoxDecoration(
        color: c.withOpacity(.07),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: c.withOpacity(.25))),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(v,
          style: TextStyle(
              fontSize: 15, fontWeight: FontWeight.w800, color: c)),
      Text(t, style: const TextStyle(fontSize: 10, color: Colors.black54)),
    ]));

// ---------- Tab2 货架库位（㉖v69 对齐网页版货位账本：一框一行·同托多码归并·可搜索） ----------
class _ShelfTab extends StatefulWidget {
  final _StockAgg? agg; // 仅借用提示"未登记占用的在库框"
  const _ShelfTab({this.agg});
  @override
  State<_ShelfTab> createState() => _ShelfTabState();
}

class _LedgerBox {
  String loc = "";
  final List<String> codes = [];
  String partNo = "", itemName = "", container = "", lot = "", operator = "";
  double qty = 0;
  int regAt = 0; // 最早登记时刻
}

class _ShelfTabState extends State<_ShelfTab> {
  String _q = "";
  List<_LedgerBox>? _boxes;
  int _labels = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final isar = _globalIsar;
    final placements = await isar.shelfPlacements.where().findAll();
    final extras = {
      for (final e in await isar.recordExtras.where().findAll()) e.goodsCode: e
    };
    final infos = {
      for (final e in await isar.labelInfos.where().findAll()) e.goodsCode: e
    };
    final group = <String, _LedgerBox>{};
    for (final p in placements) {
      final code = p.goodsCode.toUpperCase();
      final info = infos[p.goodsCode] ?? infos[code];
      final ex = extras[p.goodsCode] ?? extras[code];
      final partNo = info?.partNo ?? "";
      final pid = ex?.palletId ?? "";
      // 框键口径与网页/服务器一致：托号优先，其次同货位同零件号，都缺一码一框
      final key = pid.isNotEmpty
          ? "P|$pid"
          : (p.loc.isNotEmpty && partNo.isNotEmpty
              ? "L|${p.loc.toUpperCase()}|$partNo"
              : "C|$code");
      final b = group.putIfAbsent(key, _LedgerBox.new);
      if (b.loc.isEmpty) b.loc = p.loc;
      b.codes.add(p.goodsCode);
      if (b.partNo.isEmpty) b.partNo = partNo;
      if (b.itemName.isEmpty && info != null) b.itemName = info.itemName;
      if (b.lot.isEmpty && info != null) {
        b.lot = lotFromPrintDate(info.createTime, info.lotNo);
      }
      if (b.container.isEmpty) b.container = p.container;
      if (b.operator.isEmpty) b.operator = p.operator;
      b.qty += info?.qty ?? 0; // 框数量=框内各标签之和（与服务器账本同口径）
      if (b.regAt == 0 || p.assignedAt < b.regAt) b.regAt = p.assignedAt;
    }
    final list = group.values.toList()
      ..sort((a, x) {
        final c = a.loc.compareTo(x.loc);
        return c != 0 ? c : a.codes.first.compareTo(x.codes.first);
      });
    if (!mounted) return;
    setState(() {
      _boxes = list;
      _labels = placements.length;
    });
  }

  @override
  Widget build(BuildContext context) {
    final k = _q.trim().toUpperCase();
    final all = _boxes ?? const <_LedgerBox>[];
    final shown = k.isEmpty
        ? all
        : all
            .where((b) =>
                b.loc.toUpperCase().contains(k) ||
                b.partNo.toUpperCase().contains(k) ||
                b.itemName.toUpperCase().contains(k) ||
                b.codes.any((c) => c.toUpperCase().contains(k)))
            .toList();
    final locs = shown.map((b) => b.loc).toSet().length;
    return RefreshIndicator(
        onRefresh: _load,
        child: ListView(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 30),
            children: [
              TextField(
                onChanged: (v) => setState(() => _q = v),
                style: const TextStyle(fontSize: 13),
                decoration: InputDecoration(
                    hintText: "搜货位/标签/零件号/物料（支持前缀，如 NB02-B）",
                    isDense: true,
                    contentPadding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                    prefixIcon:
                        const Icon(Icons.search, size: 18),
                    prefixIconConstraints:
                        const BoxConstraints(minWidth: 34, minHeight: 0),
                    suffixIcon: _q.isEmpty
                        ? null
                        : IconButton(
                            icon: const Icon(Icons.clear, size: 16),
                            onPressed: () => setState(() => _q = "")),
                    border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8))),
              ),
              Padding(
                  padding: const EdgeInsets.fromLTRB(2, 8, 2, 4),
                  child: Text(
                      "共 $_labels 个标签 · ${all.length} 框 · $locs 个货位"
                      "${k.isNotEmpty ? " ｜ 匹配 ${shown.length} 框" : ""}"
                      "${widget.agg != null && widget.agg!.unplaced.isNotEmpty ? " · 未登记占用的在库框 ${widget.agg!.unplaced.length}" : ""}",
                      style: const TextStyle(
                          fontSize: 11.5, color: Colors.blueGrey))),
              if (shown.isEmpty)
                const Padding(
                    padding: EdgeInsets.all(30),
                    child: Center(
                        child: Text("账本为空：请在「位置登记」页导入或登记库位，\n同步后这里自动出现数据",
                            textAlign: TextAlign.center,
                            style:
                                TextStyle(fontSize: 12.5, color: Colors.grey))))
              else
                ...shown.map((b) {
                  final exact = k.isNotEmpty &&
                      b.codes
                          .any((c) => c.toUpperCase() == k); // 精确标签命中高亮
                  final reg = b.regAt > 0
                      ? DateTime.fromMillisecondsSinceEpoch(b.regAt)
                      : null;
                  return Card(
                      margin: const EdgeInsets.symmetric(vertical: 3),
                      color: exact ? const Color(0xFFFFF3CD) : null,
                      child: Padding(
                          padding:
                              const EdgeInsets.fromLTRB(10, 8, 10, 9),
                          child: Column(
                              crossAxisAlignment:
                                  CrossAxisAlignment.start,
                              children: [
                                Row(children: [
                                  Text(b.loc.isEmpty ? "未分配" : b.loc,
                                      style: const TextStyle(
                                          fontSize: 13.5,
                                          fontWeight: FontWeight.w800,
                                          fontFamily: "monospace",
                                          color: Color(0xFF2456C9))),
                                  const Spacer(),
                                  if (b.codes.length > 1)
                                    Text("${b.codes.length}码1框",
                                        style: const TextStyle(
                                            fontSize: 10.5,
                                            fontWeight: FontWeight.w700,
                                            color: Color(0xFFE65100))),
                                ]),
                                Text(b.codes.join(" / "),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        fontSize: 11.5,
                                        fontFamily: "monospace")),
                                Text(
                                    "${b.partNo}${b.itemName.isNotEmpty ? " · ${b.itemName}" : ""}",
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        fontSize: 12,
                                        fontWeight: FontWeight.w600)),
                                const SizedBox(height: 2),
                                Text(
                                    "${_fmtInvNum(b.qty)} 件"
                                    "${b.lot.isNotEmpty ? " · 批次 ${b.lot}" : ""}"
                                    "${b.container.isNotEmpty ? " · ${b.container}" : ""}"
                                    "${reg != null ? " · ${reg.month}-${reg.day.toString().padLeft(2, "0")} ${reg.hour.toString().padLeft(2, "0")}:${reg.minute.toString().padLeft(2, "0")} 登记" : ""}"
                                    "${b.operator.isNotEmpty ? " · ${b.operator}" : ""}",
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        fontSize: 11,
                                        color: Color(0xFF78909C))),
                              ])));
                }),
            ]));
  }
}

// ---------- Tab3 出入库流水 ----------
class _FlowTab extends StatefulWidget {
  final _StockAgg agg;
  const _FlowTab({required this.agg});
  @override
  State<_FlowTab> createState() => _FlowTabState();
}

class _FlowView {
  final DateTime time;
  final String partNo, itemName, barcode, sub;
  final double qty;
  final bool cancelled;
  const _FlowView(this.time, this.partNo, this.itemName, this.barcode, this.qty, this.sub, {this.cancelled = false});
}

class _FlowTabState extends State<_FlowTab> {
  bool _showIn = true;
  String _q = "";
  int _win = 0; // 0全部 1今天 3近3天 7近7天

  @override
  Widget build(BuildContext context) {
    final k = _q.trim().toLowerCase();
    final cutoff = _win == 1
        ? DateTime.now().copyWith(hour: 0, minute: 0, second: 0, millisecond: 0)
        : _win > 1
            ? DateTime.now().subtract(Duration(days: _win))
            : null;
    // 统一视图模型：入库/出库两类型字段不同，先各自摊平再共同过滤渲染
    final views = <_FlowView>[];
    if (_showIn) {
      for (final r in widget.agg.inRows.reversed) {
        views.add(_FlowView(r.time, r.partNo, r.itemName, r.barcode, r.qty,
            "${r.loc}${r.container.isNotEmpty ? " · ${r.container}" : ""}${r.cancelled ? " · 已作废" : " · ${r.operator}"}",
            cancelled: r.cancelled));
      }
    } else {
      for (final r in widget.agg.outRows.reversed) {
        views.add(_FlowView(r.time, r.partNo, r.itemName, r.barcode, r.qty,
            "${r.orderNo} · ${isMoveToLoc(r.loc) ? "🔄移仓→" : ""}${r.loc} · ${r.operator}")); // ㉖v100 去向非线边仓=移仓标注
      }
    }
    var list = views;
    if (cutoff != null) list = list.where((r) => r.time.isAfter(cutoff)).toList();
    if (k.isNotEmpty) {
      list = list
          .where((r) =>
              r.partNo.toLowerCase().contains(k) ||
              r.itemName.toLowerCase().contains(k) ||
              r.barcode.toLowerCase().contains(k) ||
              r.sub.toLowerCase().contains(k))
          .toList();
    }
    final shown = list.take(300).toList();
    chip(int v, String t) => ChoiceChip(
        label: Text(t, style: TextStyle(fontSize: 11.5, color: _win == v ? Colors.white : Colors.blueGrey)),
        selected: _win == v,
        showCheckmark: false,
        selectedColor: const Color(0xFF515BD4),
        labelPadding: const EdgeInsets.symmetric(horizontal: 6),
        onSelected: (_) => setState(() => _win = v));
    return Column(children: [
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
          child: Row(children: [
            Expanded(
                child: TextField(
              onChanged: (v) => setState(() => _q = v),
              decoration: InputDecoration(
                  hintText: _showIn ? "搜零件/标签/操作人/货位" : "搜零件/标签/出库单/操作人",
                  isDense: true,
                  filled: true,
                  fillColor: Colors.white,
                  prefixIcon: const Icon(Icons.search, size: 20),
                  suffixIcon: _q.isEmpty
                      ? null
                      : IconButton(
                          icon: const Icon(Icons.clear, size: 18),
                          onPressed: () => setState(() => _q = "")),
                  border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(8))),
            )),
          ])),
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
          child: Row(children: [
            Expanded(
              child: SegmentedButton<bool>(
                style: const ButtonStyle(visualDensity: VisualDensity.compact),
                segments: const [
                  ButtonSegment(value: true, label: Text("入库流水")),
                  ButtonSegment(value: false, label: Text("出库流水"))
                ],
                selected: {_showIn},
                onSelectionChanged: (s) => setState(() => _showIn = s.first),
              ),
            ),
          ])),
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
          child: Row(children: [
            chip(1, "今天"),
            const SizedBox(width: 6),
            chip(3, "近3天"),
            const SizedBox(width: 6),
            chip(7, "近7天"),
            const SizedBox(width: 6),
            chip(0, "全部"),
            const Spacer(),
            Text('${shown.length}${list.length > 300 ? "/${list.length}" : ""} 条',
                style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
          ])),
      Expanded(
          child: shown.isEmpty
              ? Center(
                  child: Text(k.isNotEmpty || _win != 0 ? "没有符合条件的流水" : "暂无流水",
                      style: const TextStyle(color: Colors.grey)))
              : ListView.builder(
                  padding: const EdgeInsets.all(10),
                  itemCount: shown.length,
                  itemBuilder: (ctx, i) {
                    final r = shown[i];
                    final t = r.time;
                    return ListTile(
                      dense: true,
                      contentPadding: const EdgeInsets.symmetric(horizontal: 6),
                      leading: Icon(_showIn ? (r.cancelled ? Icons.block : Icons.login) : Icons.logout,
                          color: _showIn ? (r.cancelled ? Colors.red : Colors.green) : Colors.deepOrange,
                          size: 20),
                      title: Text("${r.partNo} ${r.itemName}",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 13,
                              decoration: r.cancelled ? TextDecoration.lineThrough : null)),
                      subtitle: Text(
                          "${r.barcode} · ${_fmtInvNum(r.qty)} 件 · ${r.sub}",
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 11,
                              color: r.cancelled ? Colors.red : null)),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                          Text(_invRelTime(t),
                              style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
                          Text("${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}",
                              style: TextStyle(fontSize: 9.5, color: Colors.grey.shade400)),
                        ]),
                        IconButton(
                            tooltip: "全链路",
                            visualDensity: VisualDensity.compact,
                            icon: const Icon(Icons.route,
                                size: 17, color: Color(0xFF515BD4)),
                            onPressed: () => Navigator.push(context,
                                MaterialPageRoute(
                                    builder: (_) => TracePage(seed: r.barcode)))),
                      ]),
                    );
                  },
                )),
    ]);
  }
}

// ---------- Tab4 期初导入（页签已下线，类保留备用） ----------

/// 盘点·系统实时在库账本快照 → 基准两表（免上传CSV；NB02货架+NB03地面全覆盖）。
/// 口径与库存页完全一致：账面=在库框数量合计（零库存零件不入基准，扫到即账外料）；货位=各货位在库框按零件号合计。
/// 只覆盖 baselineBooks/baselineLocs 两张盘点基准表（与CSV导入同样的整表替换），不触碰采集/发料/账本数据。
Future<Map<String, dynamic>> buildLiveBaseline() async {
  final pr = await ledgerPullMerge(force: true); // 先与电脑账本合并：多台PDA的在库状态对齐（盘点基准必须最新，强制拉）
  final agg = await computeStock();
  final key = "LIVE@${DateTime.now().millisecondsSinceEpoch}";
  // ㉖v94u 快照留痕：服务器账本版本 vs 本机合并后行数——现场"明明有2框却报差异"时可判定快照是否落后/拉取失败
  final localRows = await _globalIsar.shelfPlacements.where().count();
  final meta = <String, dynamic>{
    "pullOk": pr["ok"] == true,
    "srvRev": (pr["rev"] as num?)?.toInt() ?? -1,
    "srvTotal": (pr["total"] as num?)?.toInt() ?? -1,
    "srvAt": pr["srvAt"] ?? "",
    "srvBy": pr["srvBy"] ?? "",
    "localRows": localRows,
    "msg": pr["msg"] ?? "",
  };
  final books = <BaselineBook>[];
  for (final r in agg.parts.values) {
    if (r.partNo.isEmpty || r.inStockQty <= 0) continue;
    books.add(BaselineBook(
        fileKey: key,
        partNo: r.partNo,
        itemName: r.itemName,
        bookQty: r.inStockQty));
  }
  final locMap = <String, BaselineLoc>{};
  for (final e in agg.byLoc.entries) {
    for (final b in e.value) {
      if (!b.inStock || b.partNo.isEmpty) continue;
      final k = "${e.key}|${b.partNo}";
      final old = locMap[k];
      if (old != null) {
        old.qty += b.inStockQty; // ㉖v59 方案B：基线库位量按未发码之和（与库存页在库口径一致，防半发托虚高致盘点误判）
      } else {
        locMap[k] = BaselineLoc(
            fileKey: key,
            locCode: e.key,
            partNo: b.partNo,
            qty: b.inStockQty,
            goodsCode: b.barcode);
      }
    }
  }
  // ㉖v97 基准补框：computeStock 会整框跳过"零件号解析不到"的在架码（流水 mesPartNo 为空/已作废，
  // 或无流水且 MES 缓存缺失），明明在架却不进基准 → 盘点报"账面 520 实物 1320"假盘亏。
  // 精确复算其跳过条件找出这些码，用 MES 缓存/流水回填零件号补进两表；已入基准的码（含同托兄弟码）绝不双计
  final recByCode = <String, List<dynamic>>{}; // 大写码→该码全部有效流水（按时间序）
  for (final r in await _globalIsar.scanRecords.where().findAll()) {
    (recByCode[r.goodsCode.trim().toUpperCase()] ??= []).add(r);
  }
  final labelInfos = await _globalIsar.labelInfos.where().findAll();
  final infoByCode = {for (final li in labelInfos) li.goodsCode.trim().toUpperCase(): li};
  final bIdx = <String, int>{
    for (var i = 0; i < books.length; i++) books[i].partNo.trim().toUpperCase(): i
  };
  var backfilled = 0;
  for (final p in await _globalIsar.shelfPlacements.where().findAll()) {
    final cd = p.goodsCode.trim().toUpperCase();
    if (cd.isEmpty) continue;
    final rs = recByCode[cd];
    String pn;
    double q;
    if (rs != null && rs.isNotEmpty) {
      // 有流水：computeStock 的入基准条件=存在"未作废且 mesPartNo 非空"的流水；有则本码已计，跳过
      final ok = rs.where((r) => !(r as dynamic).isCancel && ((r.mesPartNo ?? "").trim().isNotEmpty)).toList();
      if (ok.isNotEmpty) continue;
      // 全被跳过：从 MES 缓存回填
      final li = infoByCode[cd];
      pn = (li?.partNo ?? "").trim().toUpperCase();
      q = li?.qty ?? 0;
    } else {
      // 无流水：ledger-only 分支入基准条件=info 存在、未标记 missing、partNo 非空；满足则已计，跳过
      final li = infoByCode[cd];
      if (li != null && !li.missing && li.partNo.trim().isNotEmpty) continue;
      pn = (li?.partNo ?? "").trim().toUpperCase();
      q = li?.qty ?? 0;
    }
    if (pn.isEmpty || q <= 0) continue; // 确实无法回填：盘点扫到按账外料口径处理
    final nm = infoByCode[cd]?.itemName.trim() ?? "";
    backfilled++;
    final bi = bIdx[pn];
    if (bi != null) {
      final ob = books[bi];
      books[bi] = BaselineBook(fileKey: key, partNo: ob.partNo, itemName: ob.itemName, bookQty: ob.bookQty + q); // 基准总账按零件号唯一行，累加合并
    } else {
      bIdx[pn] = books.length;
      books.add(BaselineBook(fileKey: key, partNo: pn, itemName: nm, bookQty: q));
    }
    final lc = p.loc.trim().toUpperCase();
    final lk = "$lc|$pn";
    final old = locMap[lk];
    if (old != null) {
      old.qty += q;
    } else {
      locMap[lk] = BaselineLoc(fileKey: key, locCode: p.loc, partNo: pn, qty: q, goodsCode: p.goodsCode);
    }
  }
  await _globalIsar.writeTxn(() async {
    await _globalIsar.baselineBooks.where().deleteAll();
    await _globalIsar.baselineBooks.putAll(books);
    await _globalIsar.baselineLocs.where().deleteAll();
    await _globalIsar.baselineLocs.putAll(locMap.values.toList());
  });
  // ㉖v94u 留痕持久化（本地缓存即可——差异报表只在本机生成；key 带快照时刻防旧值串用）
  meta["locRows"] = locMap.length;
  meta["bookRows"] = books.length;
  meta["backfilled"] = backfilled; // ㉖v97 零件号缺失回填进基准的框数（留痕可查）
  try {
    final sp = await SharedPreferences.getInstance();
    await sp.setString("inv_live_meta_$key", jsonEncode(meta));
  } catch (_) {}
  return {"key": key, "books": books.length, "locs": locMap.length, "meta": meta};
}

class _OpeningTab extends StatelessWidget {
  final _StockAgg agg;
  final VoidCallback onReload;
  const _OpeningTab({required this.agg, required this.onReload});

  Future<void> _importText(BuildContext ctx) async {
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(
        context: ctx,
        builder: (dctx) => AlertDialog(
              title: const Text("粘贴导入期初库存"),
              content: SizedBox(
                  width: 380,
                  height: 300,
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Text(
                        "每行：零件号,物料名字,数量（货位/料框可省略）\n从 Excel 复制三列粘贴即可；重复导入会全部替换旧期初。",
                        style: TextStyle(fontSize: 12)),
                    const SizedBox(height: 8),
                    Expanded(
                        child: TextField(
                            controller: ctrl,
                            maxLines: null,
                            decoration: const InputDecoration(
                                border: OutlineInputBorder()))),
                  ])),
              actions: [
                TextButton(
                    onPressed: () async {
                      final dir = await getExternalStorageDirectory();
                      if (dir == null) return;
                      final f = File("${dir.path}/期初模板.csv");
                      await f.writeAsString(
                          "\uFEFF零件号,物料名字,数量,货位,料框类型\n6608462082-A,示例物料,100,,1800*1200_2\n",
                          encoding: utf8);
                      if (dctx.mounted)
                        ScaffoldMessenger.of(dctx).showSnackBar(
                            SnackBar(content: Text("模板已存：${f.path}")));
                    },
                    child: const Text("存模板")),
                TextButton(
                    onPressed: () => Navigator.pop(dctx, false),
                    child: const Text("取消")),
                ElevatedButton(
                    onPressed: () => Navigator.pop(dctx, true),
                    child: const Text("导入")),
              ],
            ));
    if (ok != true || !ctx.mounted) return;
    final lines = ctrl.text
        .split(RegExp(r"[\r\n]+"))
        .where((l) => l.trim().isNotEmpty)
        .toList();
    ctrl.dispose();
    if (lines.isEmpty) return;
    final parsed = <InventoryOpening>[];
    String bad = "";
    for (var i = 0; i < lines.length; i++) {
      final cells = _parseCsvLine(lines[i]);
      if (i == 0 &&
          (cells.first.contains("零件号") ||
              cells.first.toLowerCase() == "partno")) continue; // 表头
      if (cells.length < 3) {
        bad = "第${i + 1}行列数不足";
        break;
      }
      final q = double.tryParse(cells[2].replaceAll(RegExp(r"[,\s]"), ""));
      if (q == null) {
        bad = "第${i + 1}行数量「${cells[2]}」不是数字";
        break;
      }
      parsed.add(InventoryOpening()
        ..partNo = cells[0].trim()
        ..itemName = cells[1].trim()
        ..qty = q
        ..loc = cells.length > 3 ? cells[3].trim() : ""
        ..container = cells.length > 4 ? cells[4].trim() : ""
        ..operator = Auth.user?.name ?? "手工导入"
        ..importedAt = DateTime.now().millisecondsSinceEpoch);
    }
    if (bad.isNotEmpty) {
      if (ctx.mounted)
        ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
            content: Text("导入失败：$bad（已中止，未写入）"), backgroundColor: Colors.red));
      return;
    }
    if (parsed.isEmpty) return;
    final replace = await showDialog<bool>(
        context: ctx,
        builder: (dctx) => AlertDialog(
              title: const Text("确认导入"),
              content: Text(
                  "解析成功 ${parsed.length} 行。\n当前已有期初 ${agg.parts.values.fold<int>(0, (s, r) => s + (r.opening > 0 ? 1 : 0))} 项，导入将整体替换旧期初，继续？"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dctx, false),
                    child: const Text("取消")),
                TextButton(
                    onPressed: () => Navigator.pop(dctx, true),
                    child: const Text("替换导入"))
              ],
            ));
    if (replace != true) return;
    await _globalIsar.writeTxn(() async {
      await _globalIsar.inventoryOpenings.where().deleteAll();
      await _globalIsar.inventoryOpenings.putAll(parsed);
    });
    if (ctx.mounted)
      ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(
          content: Text("期初导入成功：${parsed.length} 项"),
          backgroundColor: Colors.green));
    onReload();
  }

  @override
  Widget build(BuildContext context) {
    final opRows = agg.parts.values.where((r) => r.opening > 0).toList()
      ..sort((x, y) => x.partNo.compareTo(y.partNo));
    return Column(children: [
      Padding(
          padding: const EdgeInsets.all(10),
          child: Row(children: [
            Expanded(
              child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF515BD4),
                      foregroundColor: Colors.white,
                      minimumSize: const Size(0, 44)),
                  onPressed: () => _importText(context),
                  icon: const Icon(Icons.upload_file),
                  label: const Text("粘贴导入 / 更新期初")),
            ),
          ])),
      const Padding(
          padding: EdgeInsets.symmetric(horizontal: 12),
          child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                  "默认无需导入期初：库存=在库标签合计（新扫入库、出库扫走自动扣减）。仅当想把系统启用前的老库存也计入时，才盘点一次导入，之后一般不再改动。",
                  style: TextStyle(fontSize: 12, color: Colors.grey)))),
      Expanded(
          child: opRows.isEmpty
              ? const Center(
                  child: Text("未导入期初（正常，可不填）",
                      style: TextStyle(color: Colors.grey)))
              : ListView.builder(
                  padding: const EdgeInsets.all(10),
                  itemCount: opRows.length,
                  itemBuilder: (ctx, i) {
                    final r = opRows[i];
                    return Card(
                        margin: const EdgeInsets.symmetric(vertical: 3),
                        child: ListTile(
                          dense: true,
                          title: Text("${r.partNo}  ${r.itemName}",
                              style: const TextStyle(fontSize: 13)),
                          trailing: Text("期初 ${_fmtInvNum(r.opening)}",
                              style: const TextStyle(
                                  fontSize: 14, fontWeight: FontWeight.w600)),
                        ));
                  })),
    ]);
  }
}

// ===================== 零件档案：逐框入库/出库全链路 =====================
class _PPBox {
  String barcode = "", itemName = "", lot = "", pallet = "", container = "";
  double qty = 0;
  DateTime? inTime;
  String inOperator = "", inLoc = "", inBatch = "";
  bool cancelled = false;
  String curLoc = "";
  DateTime? outTime;
  String outOrder = "",
      outTo = "",
      outOperator = "",
      outMove = "",
      outFrom = "",
      outLink = "";
  String agvChain = ""; // 领料出库时服务器AGV节点链路（A补充）
  Map? insp; // v55 检验历史 {v,at}（null=未检）
  String inspBusy = ""; // v55 进行中检验工单状态（非空=检验中）
  bool get inStock => !cancelled && outTime == null;
  bool get ledgerOnly => inTime == null;
}

class _PPData {
  String partNo = "", itemName = "";
  double opening = 0, inQty = 0, outQty = 0, stockQty = 0;
  int inBoxes = 0, outBoxes = 0, cancelBoxes = 0;
  bool serverOk = false; // 服务器数据合并成功（B）
  final List<_PPBox> boxes = [];
  final List<Map> demand = []; // ㉖v68 在途领料需求（pending/accepted 未满足行）
}

Future<_PPData> loadPartProfile(String partNo) async {
  final isar = _globalIsar;
  final key = partNo.trim().toUpperCase();
  final d = _PPData()..partNo = partNo;
  final recs = (await isar.scanRecords.where().findAll())
      .where((r) => (r.mesPartNo ?? "").toUpperCase() == key)
      .toList()
    ..sort((a, b) => a.scanTime.compareTo(b.scanTime));
  final extras = {
    for (final e in await isar.recordExtras.where().findAll()) e.goodsCode: e
  };
  final infos = {
    for (final e in await isar.labelInfos.where().findAll()) e.goodsCode: e
  };
  final places = {
    for (final p in await isar.shelfPlacements.where().findAll()) p.goodsCode: p
  };
  final outHit = <String, Map<String, Object>>{};
  // ㉖v98c 严重修复（10/29 现场：出库后汇总1728、档案却2128，差=刚出库的400）：
  // 档案页旧口径"出库台账匹配不到=在库"与汇总页"账本权威"天然漂移——出库单 barcode 与流水 code 不一致
  // （同托兄弟码/转单换码/出库行缺码）时，同一框会被算两遍：流水框算在库 + 出库码补建算已出库，
  // 当前库存虚高。改为以服务器账本为在库权威：码在账本=在库（不标出库），不在账本且出库台有=已出库。
  // 账本拉取失败（离线）→ ledOn=null 回退旧逻辑，不阻断档案页。
  Set<String>? ledOn;
  try {
    final lg = await AuthApi.ledgerGet().timeout(const Duration(seconds: 8));
    if (lg["ok"] == true) {
      ledOn = <String>{};
      for (final x in List<Map>.from(lg["items"] ?? [])) {
        if ((x["p"]?.toString() ?? "").toUpperCase() == key) ledOn.add((x["c"]?.toString() ?? "").toUpperCase());
      }
      ledOn.remove('');
    }
  } catch (_) {}
  // 服务器出库单先入表，本机出库单覆盖（本机更权威）：别台设备转单的框也能拿到出库链路
  try {
    final ob = await AuthApi.outboundGet().timeout(const Duration(seconds: 8));
    if (ob["ok"] == true) {
      d.serverOk = true;
      for (final o in List<Map>.from(ob["items"] ?? [])) {
        final no = o["orderNo"]?.toString() ?? "";
        if (no.isEmpty) continue;
        for (final e in List<Map>.from(o["items"] ?? [])) {
          final bc = (e["barcode"]?.toString() ?? "").toUpperCase();
          if (bc.isEmpty) continue;
          outHit[bc] = {
            "t": (o["createdAt"] as num?)?.toInt() ?? 0,
            "no": no,
            "to": o["toLoc"]?.toString() ?? "",
            "op": o["operator"]?.toString() ?? "",
            "move": (e["move"] ?? "").toString(),
            "from": (e["fromLoc"] ?? "").toString(),
            "link": o["linkReqNo"]?.toString() ?? "",
            "code": (e["code"] ?? "").toString(),
            "qty": (e["qty"] as num?) ?? 0,
            "name": (e["name"] ?? "").toString()
          };
        }
      }
    }
  } catch (_) {}
  for (final o in await isar.outboundOrders.where().findAll()) {
    try {
      for (final e in (jsonDecode(o.itemsJson) as List)) {
        final m = Map<String, dynamic>.from(e as Map);
        final bc = (m["barcode"]?.toString() ?? "").toUpperCase();
        if (bc.isEmpty) continue;
        outHit[bc] = {
          "t": o.createdAt,
          "no": o.orderNo,
          "to": o.toLoc,
          "op": o.operator,
          "move": (m["move"] ?? "").toString(),
          "from": (m["fromLoc"] ?? "").toString(),
          "link": o.linkReqNo,
          "code": (m["code"] ?? "").toString(),
          "qty": (m["qty"] as num?) ?? 0,
          "name": (m["name"] ?? "").toString()
        };
      }
    } catch (_) {}
  }
  void fillOut(_PPBox b) {
    if (ledOn != null && ledOn.contains(b.barcode.toUpperCase())) return; // ㉖v98c 账本在架=在库权威，出库台账不覆盖当前事实
    final oh = outHit[b.barcode.toUpperCase()];
    if (oh == null) return;
    b.outTime = DateTime.fromMillisecondsSinceEpoch(oh["t"] as int);
    b.outOrder = oh["no"].toString();
    b.outTo = oh["to"].toString();
    b.outOperator = oh["op"].toString();
    b.outMove = oh["move"].toString();
    b.outFrom = oh["from"].toString();
    b.outLink = oh["link"].toString();
  }

  final seen = <String>{};
  for (final r in recs) {
    final b = _PPBox()
      ..barcode = r.goodsCode
      ..qty = r.mesQty ?? 0
      ..inTime = r.scanTime
      ..inBatch = r.batchId
      ..container = r.containerType ?? ""
      ..cancelled = r.isCancel
      ..inLoc =
          r.workType == 0 ? (r.stationNo ?? "") : (r.groundLocation ?? "");
    final ex = extras[r.goodsCode];
    if (ex != null) {
      b.itemName = ex.mesItemName;
      // ㉖ 批次口径：MES标签打印日期优先，缺失回退原LOT_NO
      b.lot = lotFromPrintDate(r.mesCreateTime ?? "", ex.mesLotNo);
      b.pallet = ex.palletId;
      b.inOperator = ex.operator;
    }
    if (d.itemName.isEmpty) d.itemName = b.itemName;
    final p = places[r.goodsCode] ?? places[r.goodsCode.toUpperCase()];
    if (p != null) b.curLoc = p.loc;
    fillOut(b);
    seen.add(r.goodsCode.toUpperCase());
    d.boxes.add(b);
  }
  // 服务器采集流水：补全别台设备采集的入库框（B：全厂口径）
  try {
    final sl = await AuthApi.scanlogGet().timeout(const Duration(seconds: 8));
    if (sl["ok"] == true) {
      d.serverOk = true;
      for (final s in List<Map>.from(sl["items"] ?? [])) {
        if ((s["pn"]?.toString() ?? "").toUpperCase() != key) continue;
        final code = (s["code"]?.toString() ?? "").toUpperCase();
        if (code.isEmpty || seen.contains(code)) continue;
        final t = (s["t"] as num?)?.toInt() ?? 0;
        final b = _PPBox()
          ..barcode = code
          ..qty = (s["q"] as num?)?.toDouble() ?? 0
          ..inBatch = s["batch"]?.toString() ?? ""
          ..container = s["ct"]?.toString() ?? ""
          ..cancelled = s["cx"] == true
          ..inLoc = ((s["wt"] as num?)?.toInt() ?? 0) == 0
              ? (s["st"]?.toString() ?? "")
              : (s["gl"]?.toString() ?? "")
          ..inOperator = s["op"]?.toString() ?? ""
          ..itemName = s["nm"]?.toString() ?? ""
          ..lot = s["lot"]?.toString() ?? ""
          ..pallet = s["pid"]?.toString() ?? "";
        if (t > 0) b.inTime = DateTime.fromMillisecondsSinceEpoch(t);
        if (d.itemName.isEmpty) d.itemName = b.itemName;
        final p = places[code];
        if (p != null) b.curLoc = p.loc;
        fillOut(b);
        seen.add(code);
        d.boxes.add(b);
      }
    }
  } catch (_) {}
  // 账本独有存量（从未进过任何采集流水）
  for (final p in places.values) {
    if (seen.contains(p.goodsCode.toUpperCase())) continue;
    final info = infos[p.goodsCode];
    if (info == null || info.partNo.toUpperCase() != key) continue;
    final b = _PPBox()
      ..barcode = p.goodsCode
      ..qty = info.qty
      ..itemName = info.itemName
      // ㉖ 批次口径：MES标签打印日期优先，缺失回退缓存LOT_NO
      ..lot = lotFromPrintDate(info.createTime, info.lotNo)
      ..curLoc = p.loc
      ..inLoc = p.loc
      ..inOperator = p.operator;
    if (d.itemName.isEmpty) d.itemName = b.itemName;
    fillOut(b);
    seen.add(p.goodsCode.toUpperCase());
    d.boxes.add(b);
  }
  // ㉖v68 修复：出库台账里有、但入库流水/账本里没有的框（入库在别台设备且超出流水限、或更早归档），
  // 补建为"已出库"框——否则累计出库与"已出库"筛选会因缺入库记录而整框消失、显示 0
  for (final entry in outHit.entries) {
    final bc = entry.key;
    if (seen.contains(bc)) continue;
    if (ledOn != null && ledOn.contains(bc)) continue; // ㉖v98c 码仍在账本（如撤扫返架后旧出库单残留）→ 不补建已出库框，防重复计
    final oh = entry.value;
    if ((oh["code"]?.toString().toUpperCase() ?? "") != key) continue;
    final b = _PPBox()
      ..barcode = bc
      ..qty = (oh["qty"] as num?)?.toDouble() ?? 0
      ..itemName = oh["name"]?.toString() ?? ""
      ..outTime = DateTime.fromMillisecondsSinceEpoch(oh["t"] as int)
      ..outOrder = oh["no"].toString()
      ..outTo = oh["to"].toString()
      ..outOperator = oh["op"].toString()
      ..outMove = oh["move"].toString()
      ..outFrom = oh["from"].toString()
      ..outLink = oh["link"].toString();
    if (d.itemName.isEmpty) d.itemName = b.itemName;
    seen.add(bc);
    d.boxes.add(b);
  }
  for (final op in await isar.inventoryOpenings.where().findAll()) {
    if (op.partNo.toUpperCase() == key) d.opening += op.qty;
  }
  for (final b in d.boxes) {
    if (b.cancelled) {
      d.cancelBoxes++;
      continue;
    }
    d.inQty += b.qty;
    // ㉖v98c 当前库存严格按服务器账本命中（与库存汇总页同源）：出库后同托兄弟码/重复登记框
    // 不在出库台账里，旧口径"无出库记录=在库"把它们算进库存 → 档案虚高（10/29 现场 2128 vs 1728）。
    // 账本无+出库台账无 = 漏登记/已消失框：不计当前库存（汇总同样不计），靠 v83 未登记标记提示补登。
    // 离线（ledOn=null）回退旧行为。
    final onLed = ledOn == null ? b.outTime == null : ledOn.contains(b.barcode.toUpperCase());
    if (b.outTime != null) {
      d.outBoxes++;
      d.outQty += b.qty;
    } else if (onLed) {
      d.inBoxes++;
      d.stockQty += b.qty;
    }
  }
  d.boxes.sort((a, b) {
    if (a.inStock != b.inStock) return a.inStock ? -1 : 1;
    final ta = a.outTime ?? a.inTime ?? DateTime(2000);
    final tb = b.outTime ?? b.inTime ?? DateTime(2000);
    return tb.compareTo(ta);
  });
  // A补充：领料出库的框向服务器查AGV全链路节点时刻（限20框并行，失败静默）
  final chainTodo = d.boxes
      .where((b) => b.outLink.startsWith("LL") && b.outTime != null)
      .take(20)
      .toList();
  if (chainTodo.isNotEmpty) {
    await Future.wait(chainTodo.map((b) async {
      try {
        final r = await AuthApi.agvTaskOf(b.barcode)
            .timeout(const Duration(seconds: 8));
        final ch = r["chain"];
        if (ch is! Map) return;
        String fm(Object? v) {
          final n = v is num ? v.toInt() : 0;
          if (n == 0) return "";
          final dt = DateTime.fromMillisecondsSinceEpoch(n);
          final p2 = (int x) => x.toString().padLeft(2, "0");
          return "${p2(dt.month)}-${p2(dt.day)} ${p2(dt.hour)}:${p2(dt.minute)}";
        }

        const steps = [
          ["call", "叫车"],
          ["enqueue", "入队"],
          ["dispatch", "下发"],
          ["exe", "接令"],
          ["pick", "叉出"],
          ["arrive", "到站"],
          ["transfer", "转MES"],
          ["confirm", "签收"]
        ];
        final parts = <String>[];
        for (final e in steps) {
          final s = fm(ch[e[0]]);
          if (s.isNotEmpty) parts.add("${e[1]}$s");
        }
        if (parts.isNotEmpty) b.agvChain = parts.join(" → ");
      } catch (_) {}
    }));
  }
  // v55 在库框批量拉检验态（徽章+检验下架按钮用；服务器不可达静默=全部按未检显示）
  final inStockBoxes = d.boxes.where((b) => b.inStock && b.barcode.isNotEmpty).toList();
  if (inStockBoxes.isNotEmpty) {
    try {
      final r = await AuthApi.inspectStatus(inStockBoxes.map((b) => b.barcode).toList()).timeout(const Duration(seconds: 8));
      if (r["ok"] == true) {
        final m = r["map"];
        final busy = r["busy"];
        if (m is Map) for (final b in inStockBoxes) { final e = m[b.barcode.toUpperCase()]; if (e is Map) b.insp = Map.from(e); }
        if (busy is Map) for (final b in inStockBoxes) { final s = busy[b.barcode.toUpperCase()]; if (s != null) b.inspBusy = s.toString(); }
      }
    } catch (_) {}
  }
  // ㉖v68 在途领料需求（对齐网页零件档案：pending/accepted 未满足领料行）；服务器不通静默=不显示
  try {
    final pp = await AuthApi.partProfile(key).timeout(const Duration(seconds: 8));
    if (pp["ok"] == true && pp["demand"] is List) {
      d.demand.addAll(List<Map>.from(pp["demand"] as List));
    }
  } catch (_) {}
  return d;
}

class PartProfilePage extends StatefulWidget {
  final String partNo;
  const PartProfilePage({super.key, required this.partNo});
  @override
  State<PartProfilePage> createState() => _PartProfilePageState();
}

class _PartProfilePageState extends State<PartProfilePage> {
  late Future<_PPData> _f;
  String _filter = "全部";
  bool _watched = false;
  Map? _watchRow; // ㉖v96 本零件预约记录（target/arrived/due/done/reqNo），按钮进度显示与改约用
  String _itemNameCache = ""; // 档案数据到位后回填，供预约弹窗显示物料名

  @override
  void initState() {
    super.initState();
    _f = loadPartProfile(widget.partNo);
    _loadWatch();
  }

  Future<void> _loadWatch() async {
    try {
      final r = await AuthApi.watchlistGet();
      if (!mounted) return;
      final list = List<Map>.from(r["list"] ?? []);
      final mine = list.where((w) =>
          (w["partNo"]?.toString() ?? "").toUpperCase() ==
          widget.partNo.toUpperCase()).toList();
      setState(() {
        _watched = mine.isNotEmpty;
        _watchRow = mine.isEmpty ? null : mine.first;
      });
    } catch (_) {}
  }

  // ㉖v96 预约来料：与「我的预约·添加预约」同一弹窗同一功能（预订筐数/期望到货/够数自动开单）；已预约再点=看进度/改约/取消
  Future<void> _toggleWatch() async {
    if (!_watched) {
      final cfg = await bookingDlgOf(context, widget.partNo, _itemNameCache);
      if (cfg == null || !mounted) return;
      final r = await AuthApi.watchlistSet(widget.partNo, true,
          qty: cfg["qty"] as int,
          itemName: _itemNameCache,
          due: cfg["due"] as String,
          auto: cfg["auto"] as bool);
      if (!mounted) return;
      if (r["ok"] != true) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("预约失败：${r["msg"]}")));
        return;
      }
      final qq = (cfg["qty"] as int) > 0;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(qq
              ? "已预约：${widget.partNo} 预订 ${cfg["qty"]} 筐，够数自动开领料单"
              : "已预约：${widget.partNo} 入库时会通知你"),
          backgroundColor: Colors.green));
      await _loadWatch();
      return;
    }
    final w = _watchRow ?? {};
    final tgt = (w["target"] as num?)?.toInt() ?? 0;
    final act = await showDialog<String>(
        context: context,
        builder: (c2) => AlertDialog(
              title: Text("已预约 ${widget.partNo}",
                  style: const TextStyle(fontSize: 15)),
              content: Text(
                  tgt > 0
                      ? "预订 $tgt 筐 · 已到 ${(w["arrived"] as num?)?.toInt() ?? 0} 筐${(w["due"]?.toString() ?? "").isNotEmpty ? " · 期望 ${w["due"]}" : ""}\n${w["done"] == true ? "已自动开单：${w["reqNo"] ?? ""}" : "够数后自动开领料单并通知仓管"}"
                      : "到料时站内通知你（纯提醒模式）${w["done"] == true ? " · 已到料" : ""}",
                  style: const TextStyle(fontSize: 13, height: 1.5)),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(c2),
                    child: const Text("关闭")),
                TextButton(
                    onPressed: () => Navigator.pop(c2, "off"),
                    child: const Text("取消预约",
                        style: TextStyle(color: Colors.orange))),
                FilledButton(
                    style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF00897B)),
                    onPressed: () => Navigator.pop(c2, "edit"),
                    child: const Text("修改预约")),
              ],
            ));
    if (!mounted || act == null) return;
    if (act == "off") {
      final r = await AuthApi.watchlistSet(widget.partNo, false);
      if (!mounted) return;
      if (r["ok"] != true) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("取消失败：${r["msg"]}")));
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("已取消预约"), backgroundColor: Colors.orange));
      await _loadWatch();
      return;
    }
    final cfg = await bookingDlgOf(context, widget.partNo, _itemNameCache,
        initQty: tgt,
        initDue: w["due"]?.toString() ?? "",
        initAuto: w["auto"] != false);
    if (cfg == null || !mounted) return;
    final r = await AuthApi.watchlistSet(widget.partNo, true,
        qty: cfg["qty"] as int,
        itemName: _itemNameCache,
        due: cfg["due"] as String,
        auto: cfg["auto"] as bool);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("修改失败：${r["msg"]}")));
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text("预约已更新"), backgroundColor: Colors.green));
    await _loadWatch();
  }

  String _t(DateTime? t) => t == null ? "" : t.toString().substring(5, 16);

  Widget _stepLine(IconData ic, Color c, String title, String detail) {
    return Padding(
        padding: const EdgeInsets.only(top: 7),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(
              padding: const EdgeInsets.all(4),
              decoration: BoxDecoration(
                  color: c.withOpacity(0.12),
                  borderRadius: BorderRadius.circular(5)),
              child: Icon(ic, size: 14, color: c)),
          const SizedBox(width: 8),
          Expanded(
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                Text(title,
                    style: TextStyle(
                        fontSize: 12, fontWeight: FontWeight.w700, color: c)),
                Text(detail,
                    style: const TextStyle(
                        fontSize: 11.5, color: Colors.blueGrey, height: 1.35)),
              ])),
        ]));
  }

  Widget _boxCard(_PPBox b) {
    final badge = b.cancelled
        ? const _PpBadge("作废", Colors.grey)
        : (b.outTime != null
            ? const _PpBadge("已出库", Color(0xFFE65100))
            : (b.ledgerOnly
                ? const _PpBadge("账本存量", Color(0xFF0891B2))
                : const _PpBadge("在库", Colors.green)));
    // v55 检验态徽章 + 检验下架入口（在库·AGV货架位·无在途工单·有检验权限）
    final isShelf = b.inStock && RegExp(r'^NB02-').hasMatch(b.curLoc) && !b.curLoc.contains('-CK-');
    final canInsp = isShelf && b.inspBusy.isEmpty && Auth.can("inspect_mode");
    Widget? inspBadge;
    if (b.inStock && (b.insp != null || b.inspBusy.isNotEmpty)) {
      final busy = b.inspBusy.isNotEmpty;
      final v = (b.insp?["v"] ?? "").toString();
      final at = (b.insp?["at"] as num?)?.toInt() ?? 0;
      final dt = at > 0 ? DateTime.fromMillisecondsSinceEpoch(at) : null;
      final txt = busy
          ? "检验中"
          : "已检·$v${dt == null ? "" : "·${dt.month}-${dt.day.toString().padLeft(2, "0")}"}";
      final col = busy
          ? const Color(0xFF515BD4)
          : (v == "需复检"
              ? const Color(0xFFE65100)
              : (v == "退货"
                  ? const Color(0xFFC62828)
                  : (v == "不合格" ? const Color(0xFFAD1457) : Colors.blueGrey)));
      inspBadge = Container(
          margin: const EdgeInsets.only(left: 6),
          padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
          decoration: BoxDecoration(
              color: col.withOpacity(.1), borderRadius: BorderRadius.circular(7)),
          child: Text(txt,
              style: TextStyle(fontSize: 10.5, color: col, fontWeight: FontWeight.w600)));
    }
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 5),
      child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                  child: Text(b.barcode,
                      style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          fontFamily: "monospace"))),
              Text(" ${_fmtInvNum(b.qty)} 件 ",
                  style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
              badge,
              if (inspBadge != null) inspBadge,
              IconButton(
                  tooltip: "出入库全链路（采集→检验→AGV→出库）",
                  visualDensity: VisualDensity.compact,
                  icon: const Icon(Icons.route,
                      size: 18, color: Color(0xFF515BD4)),
                  onPressed: () => _ppTrace(b)),
            ]),
            if (b.pallet.isNotEmpty || b.itemName.isNotEmpty)
              Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                      "${b.itemName}${b.pallet.isNotEmpty ? "  · 托 ${b.pallet}" : ""}",
                      style:
                          const TextStyle(fontSize: 11.5, color: Colors.grey))),
            if (b.inTime != null)
              _stepLine(Icons.login, const Color(0xFF2E7D32), "入库",
                  "${_t(b.inTime)}  ·  ${b.inOperator.isEmpty ? "历史记录" : b.inOperator}  ·  批次 ${b.inBatch}${b.inLoc.isNotEmpty ? "  ·  初始位 ${b.inLoc}" : ""}${b.lot.isNotEmpty ? "  ·  批号 ${b.lot}" : ""}${b.container.isNotEmpty ? "  ·  ${b.container}" : ""}"),
            if (b.inStock && b.curLoc.isNotEmpty)
              _stepLine(Icons.place, Colors.teal, "在库", "当前货位 ${b.curLoc}"),
            if (b.cancelled)
              _stepLine(Icons.block, Colors.grey, "已作废", "人工作废，不计入库存"),
            if (b.outTime != null)
              _stepLine(Icons.logout, const Color(0xFFE65100), isMoveToLoc(b.outTo) ? "移仓" : "出库", // ㉖v100 去向非线边仓=移仓（与服务器同判据，不计出库口径）
                  "${_t(b.outTime)}  ·  ${b.outFrom.isNotEmpty ? b.outFrom : "?"} → ${b.outTo}  ·  ${b.outMove.isEmpty ? "" : "${b.outMove}搬运 · "}${b.outOrder}${b.outLink.isNotEmpty ? "（领料单 ${b.outLink}）" : ""}  ·  ${b.outOperator}"),
            if (b.agvChain.isNotEmpty)
              _stepLine(Icons.route, Colors.indigo, "AGV链路", b.agvChain),
            if (canInsp)
              Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                    TextButton.icon(
                        onPressed: () => _inspStart(b),
                        icon: const Icon(Icons.local_shipping_outlined,
                            size: 18, color: Color(0xFF515BD4)),
                        label: const Text("🔎 检验下架",
                            style: TextStyle(color: Color(0xFF515BD4)))),
                  ])),
          ])),
    );
  }

  /// v55 库存页发起检验下架：自动/指定站台 → /api/inspect/start → 刷新
  Future<void> _inspStart(_PPBox b) async {
    final pick = await showDialog<String>(
        context: context,
        builder: (c2) => AlertDialog(
                title: const Text("发起检验下架"),
                content: Text(
                    "货位 ${b.curLoc}\n零件 ${widget.partNo}${b.itemName.isNotEmpty ? " · ${b.itemName}" : ""} · ${_fmtInvNum(b.qty)}件\n标签 ${b.barcode}${b.inBatch.isNotEmpty ? "\n批次 ${b.inBatch}" : ""}\n\nAGV 把该框送到站台，检验员看完结论后由仓管协助归位回 ${b.curLoc}。"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2),
                      child: const Text("取消")),
                  TextButton(
                      onPressed: () => Navigator.pop(c2, "pick"),
                      child: const Text("指定站台",
                          style: TextStyle(color: Color(0xFF00897B)))),
                  FilledButton(
                      onPressed: () => Navigator.pop(c2, "auto"),
                      child: const Text("自动分配")),
                ]));
    if (pick == null || !mounted) return;
    String station = "";
    if (pick == "pick") {
      final st = await _pickFreeStation();
      if (st == null || !mounted) return;
      station = st;
    }
    final r = await AuthApi.inspectStart(b.curLoc, "库存页发起检验",
        station: station);
    if (!mounted) return;
    if (r["ok"] == true) {
      final rec = Map.from(r["rec"] ?? {});
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(r["queued"] == true
              ? "✅ 已入队 → ${rec["station"] ?? ""}（站台空闲且真实下发模式时自动发车）"
              : "✅ 已下架 → ${rec["station"] ?? "站台"}，到台后通知归位"),
          backgroundColor: Colors.green));
      setState(() => _f = loadPartProfile(widget.partNo)); // 刷新徽章/按钮态
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text("发起失败：${r["msg"] ?? "未知错误"}"),
          backgroundColor: Colors.red));
    }
  }

  /// 空闲站台选层（数据与检验页同源：inspectSearch 附带 freeStns/aliases）
  Future<String?> _pickFreeStation() async {
    final r = await AuthApi.inspectSearch(widget.partNo);
    if (!mounted) return null;
    final free =
        ((r["freeStns"] as List?) ?? []).map((e) => e.toString()).toList();
    if (free.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text("当前无空闲站台（都有货/队列/检验占用），请先清台或改用自动分配"),
          backgroundColor: Colors.orange));
      return null;
    }
    final al = r["aliases"];
    final alias = al is Map
        ? al.map((k, v) => MapEntry(k.toString(), v.toString()))
        : <String, String>{};
    return showModalBottomSheet<String>(
        context: context,
        builder: (c2) => SafeArea(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Padding(
                  padding: EdgeInsets.all(12),
                  child: Text("指定检验下架站台",
                      style:
                          TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
              ...free.map((st) => ListTile(
                  leading: const Icon(Icons.pin_drop_outlined,
                      color: Color(0xFF00897B)),
                  title: Text(alias[st] == null || alias[st]!.isEmpty
                      ? st
                      : "${alias[st]}(${st.split("-").last})"),
                  onTap: () => Navigator.pop(c2, st))),
              TextButton(
                  onPressed: () => Navigator.pop(c2), child: const Text("取消")),
            ])));
  }

  /// v56 框级出入库全链路：采集入库→检验→AGV节点→扫码发料→出库出账（并行拉四源按时间线合并）
  /// ㉖v68 服务器优先全链路（同托兄弟归并+领料/调度/RCS/出库全事件），失败静默回退本地四源拼接
  Future<List<List<Object?>>> _traceServerFirst(String code) async {
    try {
      final r = await AuthApi.trace(code).timeout(const Duration(seconds: 8));
      if (r["ok"] == true) {
        final evs =
            (r["events"] is List) ? List<Map>.from(r["events"]) : <Map>[];
        if (evs.isNotEmpty) {
          String fmt(int n) {
          final dt = DateTime.fromMillisecondsSinceEpoch(n);
          String p(int x) => x.toString().padLeft(2, "0");
          return "${p(dt.month)}-${p(dt.day)} ${p(dt.hour)}:${p(dt.minute)}";
        }
        return evs.map((e) {
          final k = e["kind"]?.toString() ?? "";
          final tt = (e["t"] as num?)?.toInt() ?? 0;
          final t1 = e["title"]?.toString() ?? "";
          final det = [
            e["detail"]?.toString() ?? "",
            e["actor"]?.toString() ?? ""
          ].where((s) => s.isNotEmpty).join(" · ");
          return <Object?>[
            _TracePageState._kIcon[k] ?? Icons.circle,
            _TracePageState._kCol[k] ?? Colors.blueGrey,
            tt > 0 ? "${fmt(tt)}  $t1" : t1,
            det
          ];
        }).toList();
        }
      }
    } catch (_) {}
    return _traceNodes(code); // 本地兜底
  }

  Future<void> _ppTrace(_PPBox b) async {
    final code = b.barcode.toUpperCase();
    showDialog(
        context: context,
        builder: (c2) => AlertDialog(
            title: Text("🔎 全链路 · $code"),
            content: SizedBox(
                width: double.maxFinite,
                child: FutureBuilder<List<List<Object?>>>(
                    future: _traceServerFirst(code),
                    builder: (ctx, snap) {
                      if (snap.connectionState != ConnectionState.done)
                        return const Center(
                            child: SizedBox(
                                width: 26,
                                height: 26,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2.5)));
                      final ns = snap.data ?? const [];
                      if (ns.isEmpty)
                        return const Text(
                            "该标签在采集/账本/AGV/出库各域均无记录（可能属更早归档）",
                            style: TextStyle(fontSize: 12.5));
                      return ListView(
                          shrinkWrap: true,
                          children: ns
                              .map((n) => _stepLine(n[0] as IconData,
                                  n[1] as Color, n[2] as String, n[3] as String))
                              .toList());
                    })),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(c2),
                  child: const Text("关闭")),
            ]));
  }

  Future<List<List<Object?>>> _traceNodes(String code) async {
    final nodes = <List<Object?>>[];
    String fm(Object? v) {
      final n = v is num ? v.toInt() : 0;
      if (n == 0) return "";
      final dt = DateTime.fromMillisecondsSinceEpoch(n);
      String p(int x) => x.toString().padLeft(2, "0");
      return "${dt.year}-${p(dt.month)}-${p(dt.day)} ${p(dt.hour)}:${p(dt.minute)}";
    }

    final rs = await Future.wait([
      AuthApi.scanlogGet(limit: 2000).catchError((_) => <String, dynamic>{}),
      AuthApi.outboundGet().catchError((_) => <String, dynamic>{}),
      AuthApi.inspectList().catchError((_) => <String, dynamic>{}),
      AuthApi.agvTaskOf(code).catchError((_) => <String, dynamic>{}),
    ]);
    final sl = rs[0], ob = rs[1], ins = rs[2], tk = rs[3];
    for (final x in List<Map>.from(sl["items"] ?? [])) {
      if (x["code"]?.toString().toUpperCase() != code) continue;
      nodes.add([
        Icons.login,
        const Color(0xFF2E7D32),
        "📥 采集入库",
        "${fm(x["t"])} · ${x["op"] ?? ""} · 初始位 ${x["wt"] == 0 ? (x["st"] ?? "") : (x["gl"] ?? "")} · ${x["q"] ?? 0}件${x["cx"] == true ? " ·【已作废】" : ""}"
      ]);
    }
    for (final q in List<Map>.from(ins["list"] ?? [])) {
      if (q["code"]?.toString().toUpperCase() != code) continue;
      nodes.add([
        Icons.find_in_page,
        const Color(0xFF515BD4),
        "🔎 检验",
        "${fm(q["at"])} · ${q["by"] ?? ""} · ${q["from"] ?? ""}⇄${q["station"] ?? ""} · ${q["state"] ?? ""}${(q["verdict"] ?? "").toString().isNotEmpty ? " · 结论:${q["verdict"]}" : ""}"
      ]);
    }
    final ch = (tk["chain"] is Map)
        ? Map<String, dynamic>.from(tk["chain"] as Map)
        : <String, dynamic>{};
    const steps = <List<Object>>[
      ["created", "📋 领料下单", Icons.assignment, Color(0xFF3949AB)],
      ["accept", "🙋 接单", Icons.pan_tool, Color(0xFF3949AB)],
      ["call", "🚗 叫车登记", Icons.local_shipping, Color(0xFFE65100)],
      ["enqueue", "⏳ 加入队列", Icons.hourglass_bottom, Color(0xFFE65100)],
      ["dispatch", "📮 任务下发", Icons.markunread_mailbox, Color(0xFFE65100)],
      ["pick", "🤖 AGV 叉出", Icons.forklift, Color(0xFFE65100)],
      ["arrive", "🏁 到站", Icons.flag, Color(0xFF00897B)],
      ["issue", "📤 扫码发料", Icons.qr_code_scanner, Color(0xFF2E7D32)],
      ["transfer", "🔄 转 MES", Icons.sync, Color(0xFF6A1B9A)],
      ["confirm", "✅ 签收", Icons.verified, Color(0xFF2E7D32)],
    ];
    for (final st in steps) {
      final v = ch[st[0]];
      if (v is num && v > 0) nodes.add([st[2], st[3], st[1], fm(v)]);
    }
    for (final o in (ob["items"] is List ? List<Map>.from(ob["items"]) : <Map>[])) {
      final it = (List<Map>.from(o["items"] ?? [])).firstWhere(
          (i) => i["barcode"]?.toString().toUpperCase() == code,
          orElse: () => const {});
      if (it.isEmpty) continue;
      nodes.add([
        Icons.logout,
        const Color(0xFFE65100),
        "📤 出库出账",
        "${fm(o["createdAt"])} · ${o["orderNo"] ?? ""} · ${it["qty"] ?? 0}件 → ${o["toLoc"] ?? ""}${(o["linkReqNo"] ?? "").toString().isNotEmpty ? " · 单${o["linkReqNo"]}" : ""}"
      ]);
    }
    nodes.sort((a, x) => a[3].toString().compareTo(x[3].toString()));
    return nodes;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F6FA),
      appBar: AppBar(
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white,
          title: Text("零件档案 · ${widget.partNo}",
              style: const TextStyle(fontSize: 15)),
          actions: [
            TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: Colors.white),
                onPressed: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                        builder: (_) => TracePage(seed: widget.partNo))),
                icon: const Icon(Icons.route, size: 18, color: Colors.white),
                label: const Text("全链路", style: TextStyle(fontSize: 12))),
            TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: Colors.white),
                onPressed: _toggleWatch,
                icon: Icon(
                    _watched
                        ? Icons.shopping_cart
                        : Icons.shopping_cart_outlined,
                    size: 18,
                    color: _watched ? Colors.amber : Colors.white),
                label: Text(_watched
                    ? (((_watchRow?["target"] as num?)?.toInt() ?? 0) > 0
                        ? "已预约 ${(_watchRow?["arrived"] as num?)?.toInt() ?? 0}/${(_watchRow?["target"] as num?)?.toInt() ?? 0}筐"
                        : "已预约")
                    : "预约来料",
                    style: const TextStyle(fontSize: 12)))
          ]),
      body: FutureBuilder<_PPData>(
          future: _f,
          builder: (ctx, sn) {
            if (!sn.hasData)
              return const Center(child: CircularProgressIndicator());
            final d = sn.data!;
            _itemNameCache = d.itemName; // ㉖v96 回填物料名（非渲染字段，赋值不触发重建）供预约弹窗显示
            final shown = d.boxes
                .where((b) => _filter == "全部"
                    ? true
                    : _filter == "在库"
                        ? b.inStock
                        : _filter == "已出库"
                            ? b.outTime != null
                            : b.cancelled)
                .toList();
            return Column(children: [
              Padding(
                  padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
                  child: Card(
                      child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                    d.itemName.isEmpty
                                        ? widget.partNo
                                        : "${widget.partNo}  ${d.itemName}",
                                    style: const TextStyle(
                                        fontSize: 15,
                                        fontWeight: FontWeight.w700)),
                                const SizedBox(height: 6),
                                Row(
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      Expanded(
                                          child: Wrap(
                                              spacing: 10,
                                              runSpacing: 2,
                                              children: [
                                            Text("期初 ${_fmtInvNum(d.opening)}",
                                                style: const TextStyle(
                                                    fontSize: 12,
                                                    color: Colors.blueGrey)),
                                            Text("累计入库 ${_fmtInvNum(d.inQty)}",
                                                style: const TextStyle(
                                                    fontSize: 12,
                                                    color: Color(0xFF2E7D32))),
                                            Text(
                                                "累计出库 ${_fmtInvNum(d.outQty)}（${d.outBoxes} 框）",
                                                style: const TextStyle(
                                                    fontSize: 12,
                                                    color: Color(0xFFE65100))),
                                            if (d.cancelBoxes > 0)
                                              Text("作废 ${d.cancelBoxes} 框",
                                                  style: const TextStyle(
                                                      fontSize: 12,
                                                      color: Colors.grey)),
                                          ])),
                                      Text("当前库存 ",
                                          style: const TextStyle(
                                              fontSize: 12,
                                              color: Colors.blueGrey)),
                                      Text(_fmtInvNum(d.stockQty),
                                          style: const TextStyle(
                                              fontSize: 26,
                                              fontWeight: FontWeight.w800,
                                              color: const Color(0xFF2E7D32))),
                                    ]),
                                const SizedBox(height: 4),
                                Text(
                                    d.serverOk
                                        ? "数据源：本机 + 服务器全厂合并"
                                        : "数据源：仅本机（服务器未连通，别台设备的框可能缺失）",
                                    style: TextStyle(
                                        fontSize: 10.5,
                                        color: d.serverOk
                                            ? Colors.blueGrey
                                            : Colors.orange)),
                              ])))),
              if (d.demand.isNotEmpty)
                Padding(
                    padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
                    child: Card(
                        margin: EdgeInsets.zero,
                        color: const Color(0xFFFFF4E5),
                        child: Padding(
                            padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
                            child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  const Text("📋 在途领料需求（未满足）",
                                      style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w700,
                                          color: Color(0xFFE65100))),
                                  ...d.demand.map((x) => Padding(
                                      padding: const EdgeInsets.only(top: 3),
                                      child: Text(
                                          "${x["no"]}  ·  还需 ${_fmtInvNum((x["need"] as num?)?.toDouble() ?? 0)} 件  ·  ${x["by"]}（${x["status"] == "pending" ? "待接单" : "已接单"}）",
                                          style: const TextStyle(
                                              fontSize: 11.5,
                                              color: Color(0xFF8D5000))))),
                                ])))),
              Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  child: Row(children: [
                    for (final t in ["全部", "在库", "已出库", "作废"]) ...[
                      ChoiceChip(
                          label: Text(t, style: const TextStyle(fontSize: 12)),
                          selected: _filter == t,
                          onSelected: (_) => setState(() => _filter = t)),
                      const SizedBox(width: 6),
                    ],
                    const Spacer(),
                    Text("${shown.length} 框",
                        style:
                            const TextStyle(fontSize: 12, color: Colors.grey)),
                  ])),
              Expanded(
                  child: shown.isEmpty
                      ? const Center(
                          child: Text("该筛选下暂无框",
                              style: TextStyle(color: Colors.grey)))
                      : ListView(
                          padding: const EdgeInsets.fromLTRB(10, 0, 10, 16),
                          children: shown.map(_boxCard).toList())),
            ]);
          }),
    );
  }
}

class _PpBadge extends StatelessWidget {
  final String txt;
  final Color c;
  const _PpBadge(this.txt, this.c);
  @override
  Widget build(BuildContext context) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
          color: c.withOpacity(0.12),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: c.withOpacity(0.5))),
      child: Text(txt,
          style:
              TextStyle(fontSize: 11, color: c, fontWeight: FontWeight.w700)));
}

// ---------- ⑮ 我的预约（来料提醒）Tab ----------
class _WatchTab extends StatefulWidget {
  final _StockAgg agg;
  const _WatchTab({required this.agg});
  @override
  State<_WatchTab> createState() => _WatchTabState();
}

class _WatchTabState extends State<_WatchTab> {
  List<Map> _items = [];
  bool _loading = true;
  String _err = "";

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _err = "";
    });
    final r = await AuthApi.watchlistGet();
    if (!mounted) return;
    if (r["ok"] == true)
      setState(() {
        _items = List<Map>.from(r["list"] ?? []);
        _loading = false;
      });
    else
      setState(() {
        _loading = false;
        _err = (r["msg"] ?? "加载失败").toString();
      });
  }

  /// 已知零件候选：采集流水∪出库流水∪期初（含历史来过但当前在架=0 的零件）
  Future<List<_PnHit>> _knownParts() async {
    final isar = _globalIsar;
    final m = <String, String>{};
    for (final r in await isar.scanRecords.where().findAll()) {
      final p = (r.mesPartNo ?? "").trim().toUpperCase();
      if (p.isEmpty) continue;
      if (!m.containsKey(p)) {
        final e = await isar.recordExtras
            .filter()
            .goodsCodeEqualTo(r.goodsCode.toUpperCase())
            .findFirst();
        m[p] = e?.mesItemName ?? "";
      }
    }
    for (final o in await isar.outboundOrders.where().findAll()) {
      try {
        for (final e in (jsonDecode(o.itemsJson) as List)) {
          final mm = Map<String, dynamic>.from(e as Map);
          final p = (mm["code"]?.toString() ?? "").trim().toUpperCase();
          if (p.isEmpty) continue;
          m.putIfAbsent(p, () => mm["name"]?.toString() ?? "");
        }
      } catch (_) {}
    }
    for (final op in await isar.inventoryOpenings.where().findAll()) {
      final p = op.partNo.trim().toUpperCase();
      if (p.isNotEmpty) m.putIfAbsent(p, () => op.itemName);
    }
    final out = m.entries.map((e) => _PnHit(e.key, e.value)).toList()
      ..sort((a, b) => a.partNo.compareTo(b.partNo));
    return out;
  }

  Future<void> _add() async {
    final known = await _knownParts();
    if (!mounted) return;
    // ㉖v96 人性化：候选行附当前在库筐数/件数（库存页同口径），在库>0 排前——已到料的先看，避免重复预约
    final hits0 = known.map((h) {
      final pr = widget.agg.parts[h.partNo];
      return _PnHit2(h.partNo, h.itemName, pr?.inBoxes ?? 0, (pr?.inStockQty ?? 0).toInt());
    }).toList()
      ..sort((a, b) => a.boxes != b.boxes
          ? b.boxes.compareTo(a.boxes)
          : a.partNo.compareTo(b.partNo));
    final ctrl = TextEditingController();
    String q = "";
    _PnHit2? picked;
    await showDialog(
        context: context,
        builder: (dctx) => StatefulBuilder(builder: (bctx, setSt) {
              final lower = q.trim().toLowerCase();
              final hits = lower.isEmpty
                  ? hits0.take(80).toList()
                  : hits0
                      .where((h) =>
                          h.partNo.toLowerCase().contains(lower) ||
                          h.itemName.toLowerCase().contains(lower))
                      .take(80)
                      .toList();
              final typed = q.trim().toUpperCase();
              return AlertDialog(
                title: const Text("预约来料提醒"),
                content: SizedBox(
                    width: 360,
                    height: 430,
                    child: Column(children: [
                      TextField(
                          controller: ctrl,
                          autofocus: true,
                          textCapitalization: TextCapitalization.characters,
                          onChanged: (v) => setSt(() => q = v),
                          decoration: const InputDecoration(
                              isDense: true,
                              prefixIcon: Icon(Icons.search, size: 18),
                              hintText: "输入零件号/物料名搜索选择；查无结果可手动预约",
                              border: OutlineInputBorder())),
                      const SizedBox(height: 4),
                      Expanded(
                          child: ListView(children: [
                        if (hits.isEmpty && q.trim().isNotEmpty)
                          const Padding(
                              padding: EdgeInsets.all(10),
                              child: Text("系统中未搜到该零件",
                                  style: TextStyle(
                                      fontSize: 12, color: Colors.grey))),
                        ...hits.map((h) => ListTile(
                            dense: true,
                            leading: Icon(
                                h.boxes > 0
                                    ? Icons.inventory_2_outlined
                                    : Icons.history,
                                size: 18,
                                color: h.boxes > 0
                                    ? const Color(0xFF2E7D32)
                                    : const Color(0xFF00897B)),
                            title: Text(h.partNo,
                                style: const TextStyle(
                                    fontSize: 13,
                                    fontFamily: "monospace",
                                    fontWeight: FontWeight.w600)),
                            subtitle: Text(
                                "${h.itemName.isEmpty ? "（无物料名）" : h.itemName} · ${h.boxes > 0 ? "在库${h.boxes}筐/${h.qty}件" : "当前在库0"}",
                                style: const TextStyle(fontSize: 11),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis),
                            onTap: () {
                              picked = h;
                              Navigator.pop(bctx);
                            })),
                      ])),
                    ])),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(dctx),
                      child: const Text("取消")),
                  OutlinedButton(
                      // ㉖v96 所见即所得：输入了零件号→按钮直接预约输入值；没输入→按钮禁用提示先选/先输
                      onPressed: typed.isEmpty
                          ? null
                          : () {
                              picked = _PnHit2(typed, "", 0, 0);
                              Navigator.pop(dctx);
                            },
                      child: Text(typed.isEmpty
                          ? "手动预约该零件号"
                          : "预约「$typed」")),
                ],
              );
            }));
    ctrl.dispose();
    if (picked == null || picked!.partNo.isEmpty || !mounted) return;
    final isKnown = known.any((h) => h.partNo == picked!.partNo);
    if (!isKnown) {
      final yes = await showDialog<bool>(
          context: context,
          builder: (c2) => AlertDialog(
                title: const Text("确认陌生零件号",
                    style: TextStyle(color: Colors.orange)),
                content: Text(
                    "「${picked!.partNo}」在系统中从未出现过（无采集/出库/期初记录）。\n\n新零件首次来料属正常情况；若是老零件，请核对 MES 零件号是否一字不差——输错一位预约将永远不触发。"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2, false),
                      child: const Text("再核对一下")),
                  FilledButton(
                      style: FilledButton.styleFrom(
                          backgroundColor: Colors.orange),
                      onPressed: () => Navigator.pop(c2, true),
                      child: const Text("确认预约"))
                ],
              ));
      if (yes != true || !mounted) return;
    }
    final cfg = await _bookingDlg(picked!.partNo, picked!.itemName);
    if (cfg == null || !mounted) return;
    final qq = (cfg["qty"] as int) > 0;
    final r = await AuthApi.watchlistSet(picked!.partNo, true,
        qty: cfg["qty"] as int,
        itemName: picked!.itemName,
        due: cfg["due"] as String,
        auto: cfg["auto"] as bool);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("预约失败：${r["msg"]}")));
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(qq
            ? "已预约：${picked!.partNo} 预订 ${cfg["qty"]} 筐，够数自动开领料单"
            : "已预约：${picked!.partNo} 入库时会通知你"),
        backgroundColor: Colors.green));
    await _load();
  }

  // ㉖v94n 预约设置弹层：预订框数(0=仅提醒旧模式) + 期望到货 + 够数自动开领料单
  // ㉖v96 弹窗体提为顶层 bookingDlgOf 共享——零件档案页「预约来料」按钮同弹窗同功能
  Future<Map?> _bookingDlg(String pn, String itemName,
          {int initQty = 0, String initDue = "", bool initAuto = true}) =>
      bookingDlgOf(context, pn, itemName,
          initQty: initQty, initDue: initDue, initAuto: initAuto);

  // ㉖v94n 修改已有预约（卡片铅笔按钮）
  Future<void> _edit(Map w) async {
    final pn = w["partNo"]?.toString() ?? "";
    if (pn.isEmpty) return;
    final pr = widget.agg.parts[pn];
    final nm = pr == null ? "" : pr.itemName;
    final cfg = await _bookingDlg(pn, nm,
        initQty: (w["target"] as num?)?.toInt() ?? 0,
        initDue: w["due"]?.toString() ?? "",
        initAuto: w["auto"] != false);
    if (cfg == null || !mounted) return;
    final r = await AuthApi.watchlistSet(pn, true,
        qty: cfg["qty"] as int,
        itemName: nm,
        due: cfg["due"] as String,
        auto: cfg["auto"] as bool);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("修改失败：${r["msg"]}")));
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text("预约已更新：$pn"), backgroundColor: Colors.green));
    await _load();
  }

  Future<void> _remove(String pn) async {
    final r = await AuthApi.watchlistSet(pn, false);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("取消失败：${r["msg"]}")));
      return;
    }
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    // 已到料（当前在架>0）排前面，让"等到的"最先看到；其余按预约时间倒序
    final sorted = _items.toList()..sort((a, b) {
      final pa = widget.agg.parts[a["partNo"]?.toString()];
      final pb = widget.agg.parts[b["partNo"]?.toString()];
      final ha = (pa != null && pa.inBoxes > 0) ? 1 : 0;
      final hb = (pb != null && pb.inBoxes > 0) ? 1 : 0;
      if (ha != hb) return hb - ha;
      return ((b["at"] as num?)?.toInt() ?? 0).compareTo((a["at"] as num?)?.toInt() ?? 0);
    });
    final arrived = sorted.where((w) {
      final p = widget.agg.parts[w["partNo"]?.toString()];
      return p != null && p.inBoxes > 0;
    }).length;
    return Column(children: [
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
          child: Row(children: [
            Expanded(
                child: Text(_items.isEmpty
                    ? "到料时通知我的零件号（入库后推送，同零件10分钟聚合一条）"
                    : "共 ${_items.length} 个预约 · $arrived 个已到料在架",
                    style: const TextStyle(fontSize: 12, color: Colors.blueGrey))),
            FilledButton.icon(
                style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFF00897B)),
                onPressed: _add,
                icon: const Icon(Icons.add, size: 16),
                label: const Text("添加预约")),
          ])),
      Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _err.isNotEmpty
                  ? Center(
                      child:
                          Text(_err, style: const TextStyle(color: Colors.red)))
                  : _items.isEmpty
                      ? const Center(
                          child: Text("暂无预约：去零件档案页点「🛒 预约来料」，或点右上添加",
                              style: TextStyle(color: Colors.grey)))
                      : ListView.builder(
                          padding: const EdgeInsets.all(10),
                          itemCount: sorted.length,
                          itemBuilder: (ctx, i) {
                            final w = sorted[i];
                            final pn = w["partNo"]?.toString() ?? "";
                            final at = (w["at"] as num?)?.toInt() ?? 0;
                            final pr = widget.agg.parts[pn];
                            final inStock = pr != null && pr.inBoxes > 0;
                            // ㉖v94n 数量预约：进度/履行态（target=0 为纯提醒型，显示同旧版）
                            final tgt = (w["target"] as num?)?.toInt() ?? 0;
                            final got = (w["arrived"] as num?)?.toInt() ?? 0;
                            final done = w["done"] == true;
                            final overdue = w["overdue"] == true;
                            final reqNo = w["reqNo"]?.toString() ?? "";
                            final sub = tgt <= 0
                                ? (inStock
                                        ? "✅ 已到料 · 在架 ${pr.inBoxes} 框 · ${_fmtInvNum(pr.inStockQty)} 件"
                                        : "⏳ 等待来料中") +
                                    (at > 0 ? " · 预约于 ${_invRelTime(DateTime.fromMillisecondsSinceEpoch(at))}" : "")
                                : done
                                    ? "✅ 已转领料单 $reqNo"
                                    : "到料 $got/$tgt 框（${(got * 100 / tgt).round()}%）· 在架 ${(w["stock"] as num?)?.toInt() ?? 0}" +
                                        (overdue ? " · ⏰已超期望日" : "") +
                                        (w["due"]?.toString().isNotEmpty == true ? " · 期望 ${w["due"]}" : "");
                            return Card(
                                margin: const EdgeInsets.symmetric(vertical: 4),
                                color: done
                                    ? const Color(0xFFE8F5E9)
                                    : overdue
                                        ? const Color(0xFFFFF3E0)
                                        : inStock ? const Color(0xFFF1F8E9) : null,
                                child: ListTile(
                                  dense: true,
                                  leading: Icon(
                                      done ? Icons.check_circle : Icons.shopping_cart,
                                      color: done
                                          ? const Color(0xFF2E7D32)
                                          : const Color(0xFF00897B),
                                      size: 22),
                                  title: Text(
                                      pr != null && pr.itemName.isNotEmpty ? "${pn}  ${pr.itemName}" : pn,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontSize: 14,
                                          fontFamily: "monospace",
                                          fontWeight: FontWeight.w600)),
                                  subtitle: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(sub,
                                            style: TextStyle(
                                                fontSize: 11,
                                                color: done
                                                    ? const Color(0xFF2E7D32)
                                                    : overdue
                                                        ? Colors.deepOrange
                                                        : Colors.grey)),
                                        if (tgt > 0 && !done)
                                          ClipRRect(
                                              borderRadius: BorderRadius.circular(3),
                                              child: LinearProgressIndicator(
                                                  minHeight: 4,
                                                  value: (got / tgt).clamp(0.0, 1.0),
                                                  backgroundColor: const Color(0xFFE0E0E0),
                                                  color: overdue ? Colors.deepOrange : const Color(0xFF00897B)))
                                      ]),
                                  trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        if (tgt > 0)
                                          IconButton(
                                              tooltip: "修改预约",
                                              icon: const Icon(Icons.edit_outlined,
                                                  size: 18, color: Color(0xFF00897B)),
                                              onPressed: () => _edit(w)),
                                        IconButton(
                                            tooltip: "查看档案",
                                            icon: const Icon(Icons.info_outline,
                                                size: 18,
                                                color: Color(0xFF515BD4)),
                                            onPressed: () => Navigator.push(
                                                context,
                                                MaterialPageRoute(
                                                    builder: (_) =>
                                                        PartProfilePage(
                                                            partNo: pn)))),
                                        TextButton(
                                            onPressed: () => _remove(pn),
                                            child: const Text("取消",
                                                style: TextStyle(
                                                    color: Colors.red,
                                                    fontSize: 12))),
                                      ]),
                                ));
                          })),
    ]);
  }
}

class _PnHit {
  final String partNo, itemName;
  const _PnHit(this.partNo, this.itemName);
}

/// ㉖v96 预约候选行（带当前在库筐数/件数，库存页同口径）
class _PnHit2 extends _PnHit {
  final int boxes;
  final int qty;
  const _PnHit2(String partNo, String itemName, this.boxes, this.qty)
      : super(partNo, itemName);
}

/// ㉖v96 预约设置弹层（顶层共享）：预订筐数(0=仅提醒) + 期望到货 + 够数自动开领料单。
/// 「我的预约·添加」与「零件档案·预约来料」两处入口共用，功能完全一致。
Future<Map?> bookingDlgOf(BuildContext ctx, String pn, String itemName,
    {int initQty = 0, String initDue = "", bool initAuto = true}) async {
  int qty = initQty;
  String due = initDue;
  bool auto = initAuto;
  String fmtOff(int days) {
    final d = DateTime.now().add(Duration(days: days));
    return "${d.year.toString().padLeft(4, "0")}-${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")}";
  }
  return showDialog<Map>(
      context: ctx,
      builder: (c2) => StatefulBuilder(builder: (bctx2, setSt2) {
            final dueOpts = <List<String>>[
              ["", "不限"],
              [fmtOff(1), "明天"],
              [fmtOff(3), "3天后"],
              [fmtOff(7), "一周"],
            ];
            return AlertDialog(
              title: Text("预约来料 $pn", style: const TextStyle(fontSize: 15)),
              content: SizedBox(
                  width: 340,
                  child: SingleChildScrollView(
                      child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        if (itemName.isNotEmpty)
                          Text(itemName,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                  fontSize: 12, color: Colors.blueGrey)),
                        const SizedBox(height: 6),
                        const Text("预订筐数（0=只提醒不开单）",
                            style: TextStyle(fontSize: 12)),
                        Wrap(spacing: 6, children: [0, 1, 2, 3, 5, 10].map((v) {
                          return ChoiceChip(
                              label: Text(v == 0 ? "仅提醒" : "$v 筐"),
                              selected: qty == v,
                              selectedColor: const Color(0xFFB2DFDB),
                              onSelected: (_) => setSt2(() => qty = v));
                        }).toList()),
                        if (qty > 0) ...[
                          const SizedBox(height: 6),
                          const Text("期望到货", style: TextStyle(fontSize: 12)),
                          Wrap(
                              spacing: 6,
                              children: dueOpts.map((d) {
                                return ChoiceChip(
                                    label: Text(d[1]),
                                    selected: due == d[0],
                                    selectedColor: const Color(0xFFB2DFDB),
                                    onSelected: (_) => setSt2(() => due = d[0]));
                              }).toList()),
                          SwitchListTile(
                              contentPadding: EdgeInsets.zero,
                              title: const Text("够数自动开领料单",
                                  style: TextStyle(fontSize: 12)),
                              value: auto,
                              onChanged: (v) => setSt2(() => auto = v)),
                        ],
                        const SizedBox(height: 2),
                        Text(
                            qty > 0
                                ? "来料入库累计到 $qty 筐后，按实际到料数自动开领料单并通知仓管"
                                : "到料时站内通知你（纯提醒模式）",
                            style: const TextStyle(
                                fontSize: 11, color: Colors.grey)),
                      ]))),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(c2),
                    child: const Text("取消")),
                FilledButton(
                    style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF00897B)),
                    onPressed: () =>
                        Navigator.pop(c2, {"qty": qty, "due": due, "auto": auto}),
                    child: const Text("确认预约")),
              ],
            );
          }));
}

// ===================== 全链路追踪页（对齐网页版 /api/trace 事件流） =====================
class TracePage extends StatefulWidget {
  final String seed; // 框码/零件号/出库单/领料单/AGV任务号；空=进页面手输
  const TracePage({super.key, this.seed = ""});
  @override
  State<TracePage> createState() => _TracePageState();
}

class _TracePageState extends State<TracePage> {
  late final TextEditingController _q;
  Map? _res;
  bool _loading = false;
  String _err = "";
  static const _kIcon = <String, IconData>{
    "scan": Icons.login, "scanx": Icons.block, "req": Icons.assignment,
    "out": Icons.logout, "queue": Icons.hourglass_bottom, "trace": Icons.explore,
    "station": Icons.flag, "agv": Icons.forklift, "shelf": Icons.inventory_2,
  };
  static const _kCol = <String, Color>{
    "scan": Color(0xFF2E7D32), "scanx": Color(0xFF9E9E9E), "req": Color(0xFF3949AB),
    "out": Color(0xFFE65100), "queue": Color(0xFFE65100), "trace": Color(0xFF6A1B9A),
    "station": Color(0xFF00897B), "agv": Color(0xFFEF6C00), "shelf": Color(0xFF00897B),
  };
  static const _seedName = <String, String>{
    "task": "AGV任务", "order": "单据", "box": "框码", "part": "零件号", "unknown": "未知",
  };

  @override
  void initState() {
    super.initState();
    _q = TextEditingController(text: widget.seed);
    if (widget.seed.trim().isNotEmpty) _go(widget.seed);
  }

  @override
  void dispose() { _q.dispose(); super.dispose(); }

  Future<void> _go([String? s]) async {
    final q = (s ?? _q.text).trim();
    if (q.isEmpty) {
      if (mounted) setState(() { _err = "请输入框码 / 零件号 / 单号"; _res = null; });
      return;
    }
    setState(() { _loading = true; _err = ""; });
    try {
      final r = await AuthApi.trace(q).timeout(const Duration(seconds: 10));
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(() { _res = r; _loading = false; });
      } else {
        setState(() { _loading = false; _err = (r["msg"] ?? "查询失败").toString(); _res = null; });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() { _loading = false; _err = "服务器未连通，请检查网络后重试"; _res = null; });
    }
  }

  static String _fmtT(DateTime dt) {
    String p(int x) => x.toString().padLeft(2, "0");
    return "${p(dt.month)}-${p(dt.day)} ${p(dt.hour)}:${p(dt.minute)}";
  }

  static const _wk = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  static String _dayHead(DateTime dt) =>
      "${dt.year}年${dt.month}月${dt.day}日 ${_wk[dt.weekday - 1]}";

  /// 关键节点强调（出生/离场/闭环三锚点加粗底色）
  static bool _isKey(String k, String title) =>
      title.contains("采集入库") || title.contains("入账登记") || title.contains("出库 ") || title.contains("签收确认") || title.contains("转MES");

  /// 事件按自然日分组（新→旧展示更贴合"最近发生了什么"，组内保持时间正序=一生从左到右读）
  List<Map<String, Object>> _groupEvents(List<Map> evs) {
    final rows = <Map<String, Object>>[];
    String? lastDay;
    final sorted = evs.reversed.toList(); // 新→旧
    for (final e in sorted) {
      final tt = (e["t"] as num?)?.toInt() ?? 0;
      final day = tt > 0 ? DateTime.fromMillisecondsSinceEpoch(tt) : null;
      final dk = day == null ? "?" : "${day.year}-${day.month}-${day.day}";
      if (dk != lastDay) {
        lastDay = dk;
        rows.add({"head": day == null ? "时间未知" : _dayHead(day), "n": 0});
      }
      rows.add({"ev": e});
    }
    // 组内倒序→改成正序（阅读方向=时间线从左到右/从上到下）
    final out = <Map<String, Object>>[];
    var buf = <Map<String, Object>>[];
    Map<String, Object>? head;
    for (final r in rows) {
      if (r.containsKey("head")) {
        if (head != null) { out.add(head!); out.addAll(buf.reversed); buf = []; }
        head = r;
      } else { buf.add(r); }
    }
    if (head != null) { out.add(head); out.addAll(buf.reversed); }
    return out;
  }

  @override
  Widget build(BuildContext context) {
    final evs = (_res?["events"] is List) ? List<Map>.from(_res!["events"]) : <Map>[];
    final _grouped = _groupEvents(evs); // ㉖v99 日期分组时间线
    final kind = _res?["kind"]?.toString() ?? "";
    final count = (_res?["count"] as num?)?.toInt() ?? evs.length;
    final onShelf = (_res?["onShelf"] as num?)?.toInt() ?? 0;
    final st = _res?["state"]?.toString() ?? "";
    return Scaffold(
      backgroundColor: const Color(0xFFF4F6FA),
      appBar: AppBar(
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white,
          title: const Text("出入库全链路", style: TextStyle(fontSize: 15))),
      body: Column(children: [
        Padding(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 6),
            child: Row(children: [
              Expanded(
                  child: TextField(
                controller: _q,
                textInputAction: TextInputAction.search,
                onSubmitted: (_) => _go(),
                decoration: InputDecoration(
                    hintText: "框码 / 零件号 / 出库单 / 领料单 / AGV任务号",
                    isDense: true,
                    filled: true,
                    fillColor: Colors.white,
                    prefixIcon: const Icon(Icons.search, size: 20),
                    suffixIcon: IconButton(
                        icon: const Icon(Icons.arrow_forward,
                            size: 18, color: Color(0xFF515BD4)),
                        onPressed: () => _go()),
                    border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8)),
              ))),
            ])),
        if (_res != null)
          Padding(
              padding: const EdgeInsets.fromLTRB(12, 2, 12, 6),
              child: Row(children: [
                Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                        color: const Color(0xFF515BD4).withOpacity(.1),
                        borderRadius: BorderRadius.circular(7)),
                    child: Text("识别为：${_seedName[kind] ?? kind}",
                        style: const TextStyle(
                            fontSize: 11,
                            color: Color(0xFF515BD4),
                            fontWeight: FontWeight.w600))),
                const SizedBox(width: 8),
                Expanded(
                    child: Text(
                        "$count 个事件 · 在架 $onShelf 框"
                        "${st.isNotEmpty ? " · 队列：$st" : ""}",
                        style: const TextStyle(
                            fontSize: 11.5, color: Colors.blueGrey))),
              ])),
        Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : _err.isNotEmpty
                    ? Center(
                        child: Text(_err,
                            style: const TextStyle(
                                color: Colors.grey, fontSize: 13)))
                    : _res == null
                        ? const Center(
                            child: Padding(
                                padding: EdgeInsets.all(30),
                                child: Text(
                                    "输入框码 / 零件号 / 单号，查看该货物从采集入库到出库的完整时间线",
                                    textAlign: TextAlign.center,
                                    style: TextStyle(
                                        color: Colors.grey, fontSize: 13))))
                        : evs.isEmpty
                            ? const Center(
                                child: Text("未查到相关事件",
                                    style: TextStyle(color: Colors.grey)))
                            : ListView.builder(
                                padding:
                                    const EdgeInsets.fromLTRB(10, 0, 10, 16),
                                itemCount: _grouped.length + (count > evs.length ? 1 : 0),
                                itemBuilder: (ctx, i) {
                                  if (i >= _grouped.length) {
                                    return Padding(
                                        padding: const EdgeInsets.all(12),
                                        child: Text(
                                            "事件较多，仅显示最近 ${evs.length} 条（共 $count 条）",
                                            textAlign: TextAlign.center,
                                            style: const TextStyle(
                                                fontSize: 11.5,
                                                color: Colors.grey)));
                                  }
                                  final row = _grouped[i];
                                  if (row.containsKey("head")) {
                                    return Padding(
                                        padding: const EdgeInsets.fromLTRB(2, 14, 2, 4),
                                        child: Row(children: [
                                          Container(
                                              padding: const EdgeInsets.symmetric(
                                                  horizontal: 8, vertical: 2),
                                              decoration: BoxDecoration(
                                                  color: const Color(0xFF515BD4),
                                                  borderRadius:
                                                      BorderRadius.circular(9)),
                                              child: Text("${row["head"]}",
                                                  style: const TextStyle(
                                                      fontSize: 11,
                                                      color: Colors.white,
                                                      fontWeight:
                                                          FontWeight.w700))),
                                          const SizedBox(width: 8),
                                          const Expanded(
                                              child: Divider(
                                                  color: Color(0xFFDDE3EC))),
                                        ]));
                                  }
                                  final e = row["ev"] as Map;
                                  final k = e["kind"]?.toString() ?? "";
                                  final c = _kCol[k] ?? Colors.blueGrey;
                                  final tt = (e["t"] as num?)?.toInt() ?? 0;
                                  final dt = tt > 0
                                      ? DateTime.fromMillisecondsSinceEpoch(tt)
                                      : null;
                                  final title = e["title"]?.toString() ?? "";
                                  final detail = e["detail"]?.toString() ?? "";
                                  final actor = e["actor"]?.toString() ?? "";
                                  final key = _isKey(k, title);
                                  return Padding(
                                      padding: const EdgeInsets.only(top: 7),
                                      child: Row(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            // 左轨：时间 + 竖线连接（时间线视觉）
                                            SizedBox(
                                                width: 44,
                                                child: Column(
                                                    crossAxisAlignment:
                                                        CrossAxisAlignment
                                                            .end,
                                                    children: [
                                                      Text(
                                                          dt == null
                                                              ? "--:--"
                                                              : "${dt.hour.toString().padLeft(2, "0")}:${dt.minute.toString().padLeft(2, "0")}",
                                                          style: TextStyle(
                                                              fontSize: 10.5,
                                                              fontFamily:
                                                                  "monospace",
                                                              color:
                                                                  Colors.blueGrey.shade400)),
                                                      if (i < _grouped.length -
                                                          1)
                                                        Container(
                                                            width: 1.6,
                                                            height: 30,
                                                            color: const Color(
                                                                0xFFDDE3EC)),
                                                    ])),
                                            const SizedBox(width: 6),
                                            Container(
                                                margin: const EdgeInsets.only(top: 2),
                                                padding:
                                                    const EdgeInsets.all(4),
                                                decoration: BoxDecoration(
                                                    color: c.withOpacity(0.12),
                                                    borderRadius:
                                                        BorderRadius.circular(
                                                            5)),
                                                child: Icon(
                                                    _kIcon[k] ?? Icons.circle,
                                                    size: 14,
                                                    color: c)),
                                            const SizedBox(width: 8),
                                            Expanded(
                                                child: Container(
                                                    padding: const EdgeInsets
                                                        .symmetric(
                                                        horizontal: 8,
                                                        vertical: 5),
                                                    decoration: BoxDecoration(
                                                        color: key
                                                            ? c.withOpacity(
                                                                0.06)
                                                            : Colors.white,
                                                        borderRadius:
                                                            BorderRadius.circular(
                                                                7),
                                                        border: Border.all(
                                                            color: key
                                                                ? c.withOpacity(
                                                                    0.45)
                                                                : const Color(
                                                                    0xFFE7EBF2))),
                                                    child: Column(
                                                    crossAxisAlignment:
                                                        CrossAxisAlignment
                                                            .start,
                                                    children: [
                                                  Text(title,
                                                      style: TextStyle(
                                                          fontSize: 12,
                                                          fontWeight:
                                                              FontWeight.w700,
                                                          color: c)),
                                                  if (detail.isNotEmpty)
                                                    Text(detail,
                                                        style: const TextStyle(
                                                            fontSize: 11.5,
                                                            color: Colors
                                                                .blueGrey,
                                                            height: 1.35)),
                                                  if (actor.isNotEmpty)
                                                    Text(actor,
                                                        style: const TextStyle(
                                                            fontSize: 11,
                                                            color:
                                                                Colors.grey)),
                                                ]))),
                                          ]));
                                })),
      ]),
    );
  }
}
