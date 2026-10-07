part of 'main.dart';

// ===================== 库存模块 =====================
// 设计：入库流水=采集记录(未作废)派生；出库流水=出库台账(直调)派生；
// 库存=期初+Σ入库-Σ出库，全部实时计算，不建第三张结存表，永不脱账。
// 新增两张实体表：期初(手动导入)、货架库位占用(一货位一框)。

@collection
class InventoryOpening {
  Id id = Isar.autoIncrement;
  String partNo = "";      // 零件号
  String itemName = "";    // 物料名字
  double qty = 0;          // 期初数量
  String loc = "";         // 货位（可空）
  String container = "";   // 料框类型（可空）
  String operator = "";    // 导入人
  late int importedAt;     // 导入时间戳
}

@collection
class ShelfPlacement {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  String goodsCode = "";   // 货物标签号（一框一条占用）
  String loc = "";         // 完整货架库位编码，如 MB02-A-01-2F
  String container = "";   // 料框类型（登记时带出）
  String operator = "";    // 登记人
  late int assignedAt;     // 登记时间
}

/// 库存聚合计算结果
class _StockAgg {
  final Map<String, _StockPartRow> parts = {};       // partNo -> 行
  final List<_StockInRow> inRows = [];               // 入库流水
  final List<_StockOutRow> outRows = [];             // 出库流水
  final Map<String, List<_StockBox>> byLoc = {};     // 货架库位 -> 框
  final List<_StockBox> unplaced = [];               // 在库未分配货架
}

class _StockPartRow {
  String partNo = "";
  String itemName = "";
  double opening = 0, inQty = 0, outQty = 0;
  double inStockQty = 0;   // 在库标签数量合计（未作废且未出库）
  int inBoxes = 0;         // 在库框数
  double get perBoxQty => inBoxes > 0 ? inStockQty / inBoxes : 0; // 平均件/框（发料最小单位=1框）
  double get stock => opening + inStockQty; // 标签台账法：库存=在库框合计(+可选期初)
}

class _StockInRow {
  late DateTime time; String barcode = "", partNo = "", itemName = "", loc = "", container = "", operator = "";
  double qty = 0; bool cancelled = false;
}

class _StockOutRow {
  late DateTime time; String barcode = "", partNo = "", itemName = "", loc = "", orderNo = "", operator = "";
  double qty = 0;
}

class _StockBox {
  String barcode = "", partNo = "", itemName = "", container = "", operator = "", loc = "";
  double qty = 0;
  bool inStock = true; // 未出库（框内任一标签在库即整框在库）
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
          ..time = t ..barcode = code
          ..partNo = m["code"]?.toString() ?? ""
          ..itemName = m["name"]?.toString() ?? ""
          ..qty = (m["qty"] as num?)?.toDouble() ?? 0
          ..loc = o.toLoc ..orderNo = o.orderNo ..operator = o.operator);
      }
    } catch (_) {}
  }

  // 领料单已发料标签（本地缓存，离线可用）：同样从在库中剔除
  final reqIssued = await RequisitionCache.loadIssued();
  outCodes.addAll(reqIssued);

  // 统一按"框"聚合后再算库存：MES 标签数量是整框数（同托每码都回整框值），
  // 框键=托号优先，其次"货位+零件号"（同位同件视为同框），都缺才一码一框。
  final boxesByKey = <String, _StockBox>{};
  String boxKey(String pid, String loc, String partNo, String code) =>
      pid.isNotEmpty ? "P|$pid" : (loc.isNotEmpty && partNo.isNotEmpty ? "L|$loc|$partNo" : "C|$code");
  void addBox(String key, _StockBox box) {
    final old = boxesByKey[key];
    if (old == null) {
      boxesByKey[key] = box;
    } else {
      if (box.qty > old.qty) old.qty = box.qty; // 框数量取框内标签最大值（防个别码缺失误计）
      old.inStock = old.inStock && box.inStock; // 框内任一标签已发→整框已出库（一框一发）
      if (old.loc.isEmpty && box.loc.isNotEmpty) old.loc = box.loc; // 流水先建框、账本后带位时补货位
    }
  }
  for (final r in records) {
    final cancelled = r.isCancel;
    final partNo = r.mesPartNo ?? "";
    final name = extraMap[r.goodsCode]?.mesItemName ?? "";
    final qty = r.mesQty ?? 0;
    final loc = r.workType == 0 ? (r.stationNo ?? "") : (r.groundLocation ?? "");
    final oper = extraMap[r.goodsCode]?.operator ?? "历史记录";
    agg.inRows.add(_StockInRow()
      ..time = r.scanTime ..barcode = r.goodsCode ..partNo = partNo ..itemName = name
      ..qty = qty ..loc = loc ..container = r.containerType ?? "" ..operator = oper ..cancelled = cancelled);
    if (cancelled || partNo.isEmpty) continue;
    final p = placedMap[r.goodsCode];
    final pid = extraMap[r.goodsCode]?.palletId ?? "";
    addBox(boxKey(pid, p?.loc ?? "", partNo, r.goodsCode), _StockBox()
      ..barcode = r.goodsCode ..partNo = partNo ..itemName = name
      ..qty = qty ..container = p?.container ?? r.containerType ?? ""
      ..operator = p?.operator ?? ""
      ..loc = p?.loc ?? ""
      ..inStock = !outCodes.contains(r.goodsCode));
  }

  // 出库扣减（按出库流水零件号汇总；出库的框已从在库剔除）
  for (final o in agg.outRows) {
    if (o.partNo.isEmpty) continue;
    final row = agg.parts.putIfAbsent(o.partNo, () => _StockPartRow()..partNo = o.partNo);
    if (row.itemName.isEmpty) row.itemName = o.itemName;
    row.outQty += o.qty;
  }

  // 账本独有存量货（只进过账本、本机无采集流水）→ 并入同一框集合
  final flowCodes = records.map((r) => r.goodsCode.toUpperCase()).toSet();
  for (final p in placements) {
    if (flowCodes.contains(p.goodsCode)) continue;
    final info = infoMap[p.goodsCode];
    if (info == null || info.missing || info.partNo.isEmpty) continue;
    addBox(boxKey("", p.loc, info.partNo, p.goodsCode), _StockBox()
      ..barcode = p.goodsCode ..partNo = info.partNo ..itemName = info.itemName
      ..qty = info.qty ..container = p.container ..operator = p.operator
      ..loc = p.loc
      ..inStock = !outCodes.contains(p.goodsCode));
  }

  // 零件汇总与货架分布：全部从框集合派生，天然不双算
  for (final box in boxesByKey.values) {
    final row = agg.parts.putIfAbsent(box.partNo, () => _StockPartRow()..partNo = box.partNo);
    if (row.itemName.isEmpty) row.itemName = box.itemName;
    row.inQty += box.qty; // 入库合计按框计一次
    if (!box.inStock) continue;
    row.inBoxes++;
    row.inStockQty += box.qty;
    if (box.loc.isNotEmpty) {
      agg.byLoc.putIfAbsent(box.loc, () => []).add(box);
    } else {
      agg.unplaced.add(box);
    }
  }

  // 期初
  for (final op in openings) {
    if (op.partNo.isEmpty) continue;
    final row = agg.parts.putIfAbsent(op.partNo, () => _StockPartRow()..partNo = op.partNo);
    if (row.itemName.isEmpty) row.itemName = op.itemName;
    row.opening += op.qty;
  }
  return agg;
}

String _invCsvEsc(String v) => (v.contains(",") || v.contains("\"") || v.contains("\n")) ? "\"${v.replaceAll("\"", "\"\"")}\"" : v;

// ===================== 库存主页面（嵌入主页「库存」Tab） =====================
class InventoryStockPage extends StatefulWidget {
  const InventoryStockPage({super.key});
  @override
  State<InventoryStockPage> createState() => _InventoryStockPageState();
}

class _InventoryStockPageState extends State<InventoryStockPage> with SingleTickerProviderStateMixin {
  late TabController _tc;
  _StockAgg? _agg;
  bool _loading = true;
  String _search = "";
  static DateTime _lastPull = DateTime(2000); // 拉取节流：进页超过5分钟才向服务器增量拉取

  @override
  void initState() {
    super.initState();
    _tc = TabController(length: 3, vsync: this);
    _autoPullThenReload();
  }

  Future<void> _autoPullThenReload() async {
    if (DateTime.now().difference(_lastPull) > const Duration(minutes: 5)) {
      _lastPull = DateTime.now();
      await ledgerPullMerge(); // 静默合并电脑账本（本机无采集/别台已拣下的变化都会同步进来）
    }
    await _reload();
  }

  @override
  void dispose() { _tc.dispose(); super.dispose(); }

  Future<void> _reload() async {
    setState(() => _loading = true);
    final agg = await computeStock();
    if (!mounted) return;
    setState(() { _agg = agg; _loading = false; });
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Container(
        color: Colors.white,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        child: Row(children: [
          Expanded(child: TabBar(
            controller: _tc, isScrollable: true, tabAlignment: TabAlignment.start,
            labelColor: const Color(0xFF515BD4), unselectedLabelColor: Colors.grey,
            indicatorColor: const Color(0xFF515BD4),
            tabs: const [Tab(text: "库存汇总"), Tab(text: "货架库位"), Tab(text: "出入库流水")],
          )),
          IconButton(icon: const Icon(Icons.refresh, color: Color(0xFF515BD4)), onPressed: _reload),
        ]),
      ),
      Expanded(child: _loading
          ? const Center(child: CircularProgressIndicator())
          : TabBarView(
              controller: _tc,
              physics: const NeverScrollableScrollPhysics(), // 内层只点不滑，横滑留给外层换模块
              children: [
                _StockSummaryTab(agg: _agg!, search: _search, onSearch: (v) => setState(() => _search = v), onReload: _reload),
                _ShelfTab(agg: _agg!),
                _FlowTab(agg: _agg!),
              ],
            )),
    ]);
  }
}

// ---------- Tab1 库存汇总 ----------
class _StockSummaryTab extends StatelessWidget {
  final _StockAgg agg; final String search; final ValueChanged<String> onSearch; final VoidCallback onReload;
  const _StockSummaryTab({required this.agg, required this.search, required this.onSearch, required this.onReload});

  Future<void> _export(BuildContext ctx) async {
    final b = StringBuffer("零件号,物料名字,在库框数,在库数量,期初(可选),历史入库合计,历史出库合计\n");
    final rows = agg.parts.values.toList()..sort((x, y) => x.partNo.compareTo(y.partNo));
    for (final r in rows) {
      b.writeln("${_invCsvEsc(r.partNo)},${_invCsvEsc(r.itemName)},${r.inBoxes},${_fmtInvNum(r.inStockQty)},${_fmtInvNum(r.opening)},${_fmtInvNum(r.inQty)},${_fmtInvNum(r.outQty)}");
    }
    final dir = await getExternalStorageDirectory();
    if (dir == null || !ctx.mounted) return;
    final f = File("${dir.path}/库存汇总_${DateTime.now().millisecondsSinceEpoch}.csv");
    await f.writeAsString("\uFEFF${b.toString()}", encoding: utf8);
    if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text("已保存：${f.path}"), backgroundColor: Colors.green));
  }

  @override
  Widget build(BuildContext context) {
    var rows = agg.parts.values.toList()..sort((x, y) => x.partNo.compareTo(y.partNo));
    if (search.trim().isNotEmpty) {
      final k = search.trim().toLowerCase();
      rows = rows.where((r) => r.partNo.toLowerCase().contains(k) || r.itemName.toLowerCase().contains(k)).toList();
    }
    return Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(10, 8, 10, 0), child: Row(children: [
        Expanded(child: TextField(
          onChanged: onSearch,
          decoration: InputDecoration(hintText: "搜索零件号/物料名字", isDense: true, filled: true, fillColor: Colors.white,
            prefixIcon: const Icon(Icons.search, size: 20), border: OutlineInputBorder(borderRadius: BorderRadius.circular(8))),
        )),
        const SizedBox(width: 8),
        IconButton(onPressed: () => _export(context), icon: const Icon(Icons.download, color: Color(0xFF515BD4))),
      ])),
      Expanded(child: rows.isEmpty
          ? const Center(child: Text("暂无库存数据", style: TextStyle(color: Colors.grey)))
          : ListView.builder(
              padding: const EdgeInsets.all(10),
              itemCount: rows.length,
              itemBuilder: (ctx, i) {
                final r = rows[i];
                return Card(
                  margin: const EdgeInsets.symmetric(vertical: 4),
                  child: ListTile(
                    dense: true,
                    title: Text("${r.partNo}  ${r.itemName}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                    subtitle: Text("在库 ${r.inBoxes} 框 · 数量 ${_fmtInvNum(r.inStockQty)}${r.opening > 0 ? "（另有期初 ${_fmtInvNum(r.opening)}）" : ""}", style: const TextStyle(fontSize: 11, color: Colors.grey)),
                    trailing: Text(_fmtInvNum(r.stock), style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold, color: Color(0xFF2E7D32))),
                  ),
                );
              },
            )),
    ]);
  }
}

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
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Row(children: [
              Icon(Icons.construction, color: Colors.orange, size: 18),
              SizedBox(width: 6),
              Text("货架库位 · 预留功能", style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
            ]),
            const SizedBox(height: 6),
            const Text("AGV 货架层位占用现阶段仍由人工在 Excel 台账维护；本页数据结构（一货位一框）已预留，后续需要时可直接在 App 内登记分配。", style: TextStyle(fontSize: 12, color: Colors.grey)),
            const SizedBox(height: 6),
            Text("App 内已登记：${locs.isEmpty ? "无" : "${locs.length} 个库位"} ｜ 未登记占用的在库框：${agg.unplaced.length} 个", style: const TextStyle(fontSize: 12)),
          ]),
        ),
      ),
      ...locs.map((l) => Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: ExpansionTile(
          initiallyExpanded: true, tilePadding: const EdgeInsets.symmetric(horizontal: 12),
          leading: const Icon(Icons.shelves, color: Color(0xFF515BD4)),
          title: Text(l, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
          subtitle: Text("${agg.byLoc[l]!.length} 框 · ${agg.byLoc[l]!.map((b) => b.partNo).toSet().join("、")}", style: const TextStyle(fontSize: 11)),
          children: agg.byLoc[l]!.map((b) => ListTile(
            dense: true,
            title: Text(b.barcode, style: const TextStyle(fontSize: 12, fontFamily: "monospace")),
            subtitle: Text("${b.partNo} ${b.itemName} · ${_fmtInvNum(b.qty)} · ${b.container}", style: const TextStyle(fontSize: 11)),
          )).toList(),
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
class _FlowTabState extends State<_FlowTab> {
  bool _showIn = true;

  @override
  Widget build(BuildContext context) {
    final rows = <Widget>[];
    if (_showIn) {
      final list = widget.agg.inRows.reversed.take(300).toList();
      for (final r in list) {
        rows.add(ListTile(
          dense: true,
          leading: Icon(r.cancelled ? Icons.block : Icons.login, color: r.cancelled ? Colors.red : Colors.green, size: 20),
          title: Text("${r.partNo} ${r.itemName}${r.cancelled ? "（已作废）" : ""}", style: TextStyle(fontSize: 13, decoration: r.cancelled ? TextDecoration.lineThrough : null)),
          subtitle: Text("${r.time.toString().substring(5, 16)} · ${r.barcode} · 数量 ${_fmtInvNum(r.qty)} · ${r.loc} · ${r.container} · ${r.operator}", style: const TextStyle(fontSize: 11)),
        ));
      }
    } else {
      final list = widget.agg.outRows.reversed.take(300).toList();
      for (final r in list) {
        rows.add(ListTile(
          dense: true,
          leading: const Icon(Icons.logout, color: Colors.deepOrange, size: 20),
          title: Text("${r.partNo} ${r.itemName}", style: const TextStyle(fontSize: 13)),
          subtitle: Text("${r.time.toString().substring(5, 16)} · ${r.barcode} · 数量 ${_fmtInvNum(r.qty)} · ${r.orderNo} · ${r.operator}", style: const TextStyle(fontSize: 11)),
        ));
      }
    }
    return Column(children: [
      Padding(padding: const EdgeInsets.all(10), child: SegmentedButton<bool>(
        segments: const [ButtonSegment(value: true, label: Text("入库流水")), ButtonSegment(value: false, label: Text("出库流水"))],
        selected: {_showIn}, onSelectionChanged: (s) => setState(() => _showIn = s.first),
      )),
      Expanded(child: rows.isEmpty ? const Center(child: Text("暂无流水", style: TextStyle(color: Colors.grey))) : ListView(children: rows)),
    ]);
  }
}

// ---------- Tab4 期初导入（页签已下线，类保留备用） ----------

/// 盘点·系统实时在库账本快照 → 基准两表（免上传CSV；NB02货架+NB03地面全覆盖）。
/// 口径与库存页完全一致：账面=在库框数量合计（零库存零件不入基准，扫到即账外料）；货位=各货位在库框按零件号合计。
/// 只覆盖 baselineBooks/baselineLocs 两张盘点基准表（与CSV导入同样的整表替换），不触碰采集/发料/账本数据。
Future<Map<String, dynamic>> buildLiveBaseline() async {
  await ledgerPullMerge(); // 先与电脑账本合并：多台PDA的在库状态对齐
  final agg = await computeStock();
  final key = "LIVE@${DateTime.now().millisecondsSinceEpoch}";
  final books = <BaselineBook>[];
  for (final r in agg.parts.values) {
    if (r.partNo.isEmpty || r.inStockQty <= 0) continue;
    books.add(BaselineBook(fileKey: key, partNo: r.partNo, itemName: r.itemName, bookQty: r.inStockQty));
  }
  final locMap = <String, BaselineLoc>{};
  for (final e in agg.byLoc.entries) {
    for (final b in e.value) {
      if (!b.inStock || b.partNo.isEmpty) continue;
      final k = "${e.key}|${b.partNo}";
      final old = locMap[k];
      if (old != null) { old.qty += b.qty; } else {
        locMap[k] = BaselineLoc(fileKey: key, locCode: e.key, partNo: b.partNo, qty: b.qty, goodsCode: b.barcode);
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
  final _StockAgg agg; final VoidCallback onReload;
  const _OpeningTab({required this.agg, required this.onReload});

  Future<void> _importText(BuildContext ctx) async {
    final ctrl = TextEditingController();
    final ok = await showDialog<bool>(context: ctx, builder: (dctx) => AlertDialog(
      title: const Text("粘贴导入期初库存"),
      content: SizedBox(width: 380, height: 300, child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text("每行：零件号,物料名字,数量（货位/料框可省略）\n从 Excel 复制三列粘贴即可；重复导入会全部替换旧期初。", style: TextStyle(fontSize: 12)),
        const SizedBox(height: 8),
        Expanded(child: TextField(controller: ctrl, maxLines: null, decoration: const InputDecoration(border: OutlineInputBorder()))),
      ])),
      actions: [
        TextButton(onPressed: () async {
          final dir = await getExternalStorageDirectory();
          if (dir == null) return;
          final f = File("${dir.path}/期初模板.csv");
          await f.writeAsString("\uFEFF零件号,物料名字,数量,货位,料框类型\n6608462082-A,示例物料,100,,1800*1200_2\n", encoding: utf8);
          if (dctx.mounted) ScaffoldMessenger.of(dctx).showSnackBar(SnackBar(content: Text("模板已存：${f.path}")));
        }, child: const Text("存模板")),
        TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
        ElevatedButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("导入")),
      ],
    ));
    if (ok != true || !ctx.mounted) return;
    final lines = ctrl.text.split(RegExp(r"[\r\n]+")).where((l) => l.trim().isNotEmpty).toList();
    ctrl.dispose();
    if (lines.isEmpty) return;
    final parsed = <InventoryOpening>[];
    String bad = "";
    for (var i = 0; i < lines.length; i++) {
      final cells = _parseCsvLine(lines[i]);
      if (i == 0 && (cells.first.contains("零件号") || cells.first.toLowerCase() == "partno")) continue; // 表头
      if (cells.length < 3) { bad = "第${i + 1}行列数不足"; break; }
      final q = double.tryParse(cells[2].replaceAll(RegExp(r"[,\s]"), ""));
      if (q == null) { bad = "第${i + 1}行数量「${cells[2]}」不是数字"; break; }
      parsed.add(InventoryOpening()
        ..partNo = cells[0].trim() ..itemName = cells[1].trim() ..qty = q
        ..loc = cells.length > 3 ? cells[3].trim() : ""
        ..container = cells.length > 4 ? cells[4].trim() : ""
        ..operator = Auth.user?.name ?? "手工导入"
        ..importedAt = DateTime.now().millisecondsSinceEpoch);
    }
    if (bad.isNotEmpty) { if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text("导入失败：$bad（已中止，未写入）"), backgroundColor: Colors.red)); return; }
    if (parsed.isEmpty) return;
    final replace = await showDialog<bool>(context: ctx, builder: (dctx) => AlertDialog(
      title: const Text("确认导入"),
      content: Text("解析成功 ${parsed.length} 行。\n当前已有期初 ${agg.parts.values.fold<int>(0, (s, r) => s + (r.opening > 0 ? 1 : 0))} 项，导入将整体替换旧期初，继续？"),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("替换导入"))],
    ));
    if (replace != true) return;
    await _globalIsar.writeTxn(() async {
      await _globalIsar.inventoryOpenings.where().deleteAll();
      await _globalIsar.inventoryOpenings.putAll(parsed);
    });
    if (ctx.mounted) ScaffoldMessenger.of(ctx).showSnackBar(SnackBar(content: Text("期初导入成功：${parsed.length} 项"), backgroundColor: Colors.green));
    onReload();
  }

  @override
  Widget build(BuildContext context) {
    final opRows = agg.parts.values.where((r) => r.opening > 0).toList()..sort((x, y) => x.partNo.compareTo(y.partNo));
    return Column(children: [
      Padding(padding: const EdgeInsets.all(10), child: Row(children: [
        Expanded(child: ElevatedButton.icon(
          style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, minimumSize: const Size(0, 44)),
          onPressed: () => _importText(context), icon: const Icon(Icons.upload_file), label: const Text("粘贴导入 / 更新期初")),
        ),
      ])),
      const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: Align(alignment: Alignment.centerLeft,
        child: Text("默认无需导入期初：库存=在库标签合计（新扫入库、出库扫走自动扣减）。仅当想把系统启用前的老库存也计入时，才盘点一次导入，之后一般不再改动。", style: TextStyle(fontSize: 12, color: Colors.grey)))),
      Expanded(child: opRows.isEmpty
          ? const Center(child: Text("未导入期初（正常，可不填）", style: TextStyle(color: Colors.grey)))
          : ListView.builder(padding: const EdgeInsets.all(10), itemCount: opRows.length, itemBuilder: (ctx, i) {
              final r = opRows[i];
              return Card(margin: const EdgeInsets.symmetric(vertical: 3), child: ListTile(
                dense: true,
                title: Text("${r.partNo}  ${r.itemName}", style: const TextStyle(fontSize: 13)),
                trailing: Text("期初 ${_fmtInvNum(r.opening)}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
              ));
            })),
    ]);
  }
}
