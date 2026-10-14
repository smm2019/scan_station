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
  bool inStock = true; // 未出库（框内任一标签在库即整框在库）
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
          ..inStock = !outCodes.contains(r.goodsCode));
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
            ..inStock = !outCodes.contains(p.goodsCode));
    }
  }

  // 零件汇总与货架分布：先按"框键"合并标签级框（同托多码=1框，数量求和、任一已发整框出库），再派生统计
  final merged = <String, _StockBox>{};
  for (final b in boxesByKey.values) {
    final k = boxKey(extraMap[b.barcode]?.palletId ?? "", b.loc, b.partNo, b.barcode);
    final old = merged[k];
    if (old == null) {
      merged[k] = b;
    } else {
      old.qty += b.qty; // ㉖ 框数量=框内各标签之和（一筐两标签各25→50）
      old.inStock = old.inStock && b.inStock; // 框内任一标签已发→整框已出库（一框一发）
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
    row.inStockQty += box.qty;
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

  // ㉖v52 今日出入库框数（自然日）：入库=今日扫描有效流水去重标签，出库=今日出库单去重标签
  final _day0 = DateTime.now().copyWith(hour: 0, minute: 0, second: 0, millisecond: 0);
  agg.todayIn = agg.inRows.where((r) => !r.cancelled && r.time.isAfter(_day0)).map((r) => r.barcode.toUpperCase()).toSet().length;
  agg.todayOut = agg.outRows.where((r) => r.time.isAfter(_day0)).map((r) => r.barcode.toUpperCase()).toSet().length;

  // 期初
  for (final op in openings) {
    if (op.partNo.isEmpty) continue;
    final row = agg.parts
        .putIfAbsent(op.partNo, () => _StockPartRow()..partNo = op.partNo);
    if (row.itemName.isEmpty) row.itemName = op.itemName;
    row.opening += op.qty;
  }
  return agg;
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
  String _search = "";
  @override
  void initState() {
    super.initState();
    _tc = TabController(length: 4, vsync: this);
    _autoPullThenReload();
    _stockTimer = Timer.periodic(
        const Duration(seconds: 45), (_) => _reloadSilent()); // ⑪自动刷新
  }

  Future<void> _autoPullThenReload() async {
    // ㉖ 进页强制与服务器账本对齐（旧5分钟节流致"别台刚入库的框本机看不到"）；函数内20秒全局节流防重复
    await ledgerPullMerge(force: true);
    await _reload();
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
                child: Text(
                    '同步 ${TimeOfDay.fromDateTime(ledgerLastSyncAt!).format(context)}',
                    style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey))),
          if (Auth.can("agv_control"))
            IconButton(
                tooltip: "货架移库（AGV整架搬位）",
                icon: const Icon(Icons.swap_horiz, color: Color(0xFFEF6C00)),
                onPressed: () => showTransferDialog(context)),
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
    rows.sort(_flt == "loc"
        ? (x, y) => y.byLocDist.length.compareTo(x.byLocDist.length)
        : (x, y) => x.partNo.compareTo(y.partNo));
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
            Text('${rows.length} 项',
                style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
          ])),
      Expanded(
          child: rows.isEmpty
              ? const Center(
                  child: Text("暂无库存数据", style: TextStyle(color: Colors.grey)))
              : ListView.builder(
                  padding: const EdgeInsets.all(10),
                  itemCount: rows.length,
                  itemBuilder: (ctx, i) {
                    final r = rows[i];
                    final empty = r.inBoxes == 0;
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

// ---------- Tab2 货架库位（预留：现阶段人工 Excel 维护，本页只读展示） ----------
class _ShelfTab extends StatelessWidget {
  final _StockAgg agg;
  const _ShelfTab({required this.agg});

  @override
  Widget build(BuildContext context) {
    final locs = agg.byLoc.keys.toList()..sort();
    return ListView(padding: const EdgeInsets.all(10), children: [
      Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Row(children: [
              Icon(Icons.construction, color: Colors.orange, size: 18),
              SizedBox(width: 6),
              Text("货架库位 · 预留功能",
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            ]),
            const SizedBox(height: 6),
            const Text(
                "AGV 货架层位占用现阶段仍由人工在 Excel 台账维护；本页数据结构（一货位一框）已预留，后续需要时可直接在 App 内登记分配。",
                style: TextStyle(fontSize: 12, color: Colors.grey)),
            const SizedBox(height: 6),
            Text(
                "App 内已登记：${locs.isEmpty ? "无" : "${locs.length} 个库位"} ｜ 未登记占用的在库框：${agg.unplaced.length} 个",
                style: const TextStyle(fontSize: 12)),
          ]),
        ),
      ),
      ...locs.map((l) => Card(
            margin: const EdgeInsets.symmetric(vertical: 4),
            child: ExpansionTile(
              initiallyExpanded: true,
              tilePadding: const EdgeInsets.symmetric(horizontal: 12),
              leading: const Icon(Icons.shelves, color: Color(0xFF515BD4)),
              title: Text(l,
                  style: const TextStyle(
                      fontSize: 14, fontWeight: FontWeight.w600)),
              subtitle: Text(
                  "${agg.byLoc[l]!.length} 框 · ${agg.byLoc[l]!.map((b) => b.partNo).toSet().join("、")}",
                  style: const TextStyle(fontSize: 11)),
              children: agg.byLoc[l]!
                  .map((b) => ListTile(
                        dense: true,
                        title: Text(b.barcode,
                            style: const TextStyle(
                                fontSize: 12, fontFamily: "monospace")),
                        subtitle: Text(
                            "${b.partNo} ${b.itemName} · ${_fmtInvNum(b.qty)} · ${b.container}",
                            style: const TextStyle(fontSize: 11)),
                      ))
                  .toList(),
            ),
          )),
      const SizedBox(height: 30),
    ]);
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
            "${r.orderNo} · ${r.loc} · ${r.operator}"));
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
                      trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                        Text(_invRelTime(t),
                            style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
                        Text("${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')} ${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}",
                            style: TextStyle(fontSize: 9.5, color: Colors.grey.shade400)),
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
  await ledgerPullMerge(force: true); // 先与电脑账本合并：多台PDA的在库状态对齐（盘点基准必须最新，强制拉）
  final agg = await computeStock();
  final key = "LIVE@${DateTime.now().millisecondsSinceEpoch}";
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
        old.qty += b.qty;
      } else {
        locMap[k] = BaselineLoc(
            fileKey: key,
            locCode: e.key,
            partNo: b.partNo,
            qty: b.qty,
            goodsCode: b.barcode);
      }
    }
  }
  await _globalIsar.writeTxn(() async {
    await _globalIsar.baselineBooks.where().deleteAll();
    await _globalIsar.baselineBooks.putAll(books);
    await _globalIsar.baselineLocs.where().deleteAll();
    await _globalIsar.baselineLocs.putAll(locMap.values.toList());
  });
  return {"key": key, "books": books.length, "locs": locMap.length};
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
  bool get inStock => !cancelled && outTime == null;
  bool get ledgerOnly => inTime == null;
}

class _PPData {
  String partNo = "", itemName = "";
  double opening = 0, inQty = 0, outQty = 0, stockQty = 0;
  int inBoxes = 0, outBoxes = 0, cancelBoxes = 0;
  bool serverOk = false; // 服务器数据合并成功（B）
  final List<_PPBox> boxes = [];
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
            "link": o["linkReqNo"]?.toString() ?? ""
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
          "link": o.linkReqNo
        };
      }
    } catch (_) {}
  }
  void fillOut(_PPBox b) {
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
  for (final op in await isar.inventoryOpenings.where().findAll()) {
    if (op.partNo.toUpperCase() == key) d.opening += op.qty;
  }
  for (final b in d.boxes) {
    if (b.cancelled) {
      d.cancelBoxes++;
      continue;
    }
    d.inQty += b.qty;
    if (b.outTime != null) {
      d.outBoxes++;
      d.outQty += b.qty;
    } else {
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
      setState(() => _watched = list.any((w) =>
          (w["partNo"]?.toString() ?? "").toUpperCase() ==
          widget.partNo.toUpperCase()));
    } catch (_) {}
  }

  Future<void> _toggleWatch() async {
    final r = await AuthApi.watchlistSet(widget.partNo, !_watched);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("操作失败：${r["msg"]}")));
      return;
    }
    setState(() => _watched = !_watched);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(_watched ? "已预约：${widget.partNo} 入库时会通知你" : "已取消预约"),
        backgroundColor: _watched ? Colors.green : Colors.orange));
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
              _stepLine(Icons.logout, const Color(0xFFE65100), "出库",
                  "${_t(b.outTime)}  ·  ${b.outFrom.isNotEmpty ? b.outFrom : "?"} → ${b.outTo}  ·  ${b.outMove.isEmpty ? "" : "${b.outMove}搬运 · "}${b.outOrder}${b.outLink.isNotEmpty ? "（领料单 ${b.outLink}）" : ""}  ·  ${b.outOperator}"),
            if (b.agvChain.isNotEmpty)
              _stepLine(Icons.route, Colors.indigo, "AGV链路", b.agvChain),
          ])),
    );
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
                onPressed: _toggleWatch,
                icon: Icon(
                    _watched
                        ? Icons.shopping_cart
                        : Icons.shopping_cart_outlined,
                    size: 18,
                    color: _watched ? Colors.amber : Colors.white),
                label: Text(_watched ? "已预约" : "预约来料",
                    style: const TextStyle(fontSize: 12)))
          ]),
      body: FutureBuilder<_PPData>(
          future: _f,
          builder: (ctx, sn) {
            if (!sn.hasData)
              return const Center(child: CircularProgressIndicator());
            final d = sn.data!;
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
    final ctrl = TextEditingController();
    String q = "";
    final picked = await showDialog<_PnHit>(
        context: context,
        builder: (dctx) => StatefulBuilder(builder: (bctx, setSt) {
              final lower = q.trim().toLowerCase();
              final hits = lower.isEmpty
                  ? known.take(60).toList()
                  : known
                      .where((h) =>
                          h.partNo.toLowerCase().contains(lower) ||
                          h.itemName.toLowerCase().contains(lower))
                      .take(60)
                      .toList();
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
                            leading: const Icon(Icons.history,
                                size: 18, color: Color(0xFF00897B)),
                            title: Text(h.partNo,
                                style: const TextStyle(
                                    fontSize: 13,
                                    fontFamily: "monospace",
                                    fontWeight: FontWeight.w600)),
                            subtitle: h.itemName.isEmpty
                                ? null
                                : Text(h.itemName,
                                    style: const TextStyle(fontSize: 11),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis),
                            onTap: () => Navigator.pop(bctx, h))),
                      ])),
                    ])),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(dctx),
                      child: const Text("取消")),
                  OutlinedButton(
                      onPressed: () {
                        final t = ctrl.text.trim().toUpperCase();
                        if (t.isNotEmpty) Navigator.pop(dctx, _PnHit(t, ""));
                      },
                      child: const Text("手动预约该零件号")),
                ],
              );
            }));
    ctrl.dispose();
    if (picked == null || picked.partNo.isEmpty || !mounted) return;
    final isKnown = known.any((h) => h.partNo == picked.partNo);
    if (!isKnown) {
      final yes = await showDialog<bool>(
          context: context,
          builder: (c2) => AlertDialog(
                title: const Text("确认陌生零件号",
                    style: TextStyle(color: Colors.orange)),
                content: Text(
                    "「${picked.partNo}」在系统中从未出现过（无采集/出库/期初记录）。\n\n新零件首次来料属正常情况；若是老零件，请核对 MES 零件号是否一字不差——输错一位预约将永远不触发。"),
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
    final r = await AuthApi.watchlistSet(picked.partNo, true);
    if (!mounted) return;
    if (r["ok"] != true) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("预约失败：${r["msg"]}")));
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text("已预约：${picked.partNo} 入库时会通知你"),
        backgroundColor: Colors.green));
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
                            return Card(
                                margin: const EdgeInsets.symmetric(vertical: 4),
                                color: inStock ? const Color(0xFFE8F5E9) : null,
                                child: ListTile(
                                  dense: true,
                                  leading: Icon(
                                      inStock ? Icons.shopping_cart : Icons.shopping_cart_outlined,
                                      color: inStock ? const Color(0xFF2E7D32) : const Color(0xFF00897B),
                                      size: 22),
                                  title: Text(
                                      pr != null && pr.itemName.isNotEmpty ? "${pn}  ${pr.itemName}" : pn,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontSize: 14,
                                          fontFamily: "monospace",
                                          fontWeight: FontWeight.w600)),
                                  subtitle: Text(
                                      (inStock
                                              ? "✅ 已到料 · 在架 ${pr.inBoxes} 框 · ${_fmtInvNum(pr.inStockQty)} 件"
                                              : "⏳ 等待来料中") +
                                          (at > 0 ? " · 预约于 ${_invRelTime(DateTime.fromMillisecondsSinceEpoch(at))}" : ""),
                                      style: TextStyle(
                                          fontSize: 11,
                                          color: inStock ? const Color(0xFF2E7D32) : Colors.grey)),
                                  trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
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
