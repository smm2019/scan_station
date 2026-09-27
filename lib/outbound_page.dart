part of 'main.dart';

// ===================== 出库单（直调提交成功后落库，供仓管对照出库/逐箱备料） =====================
// 一张出库单 = 一次直调提交。items 按零件号聚合，每个零件号含多张标签。
// 仓管逐箱扫货物二维码：命中未扫标签→标记已扫；全部扫完→自动置「已备齐」。

@collection
class OutboundOrder {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  String orderNo = "";        // 单号 DT+毫秒
  DateTime createTime;
  String toWarehouseName = "";
  String toDistrictName = "";
  String toLocName = "";
  String toLocCode = "";
  String operator = "";       // 提交人（App登录用户名）
  int status = 0;             // 0=待备料 1=备料中 2=已备齐
  // items: [{partNo, itemName, uom, planQty, labels:[{code, qty, scanned}]}]
  String itemsJson = "[]";
  OutboundOrder({
    required this.orderNo,
    required this.createTime,
    this.toWarehouseName = "",
    this.toDistrictName = "",
    this.toLocName = "",
    this.toLocCode = "",
    this.operator = "",
    this.status = 0,
    this.itemsJson = "[]",
  });
}

/// 出库单内存视图对象（解析 itemsJson）
class _ObItem {
  String partNo;
  String itemName;
  String uom;
  double planQty;
  List<_ObLabel> labels;
  _ObItem(this.partNo, this.itemName, this.uom, this.planQty, this.labels);
}
class _ObLabel {
  String code;
  double qty;
  bool scanned;
  _ObLabel(this.code, this.qty, this.scanned);
}

List<_ObItem> _parseObItems(String json) {
  try {
    final arr = jsonDecode(json) as List;
    return arr.map((e) {
      final m = Map<String, dynamic>.from(e as Map);
      final labels = (m["labels"] as List? ?? []).map((b) {
        final bm = Map<String, dynamic>.from(b as Map);
        return _ObLabel(bm["code"]?.toString() ?? "", (bm["qty"] as num?)?.toDouble() ?? 0, bm["scanned"] == true);
      }).toList();
      return _ObItem(m["partNo"]?.toString() ?? "", m["itemName"]?.toString() ?? "", m["uom"]?.toString() ?? "",
          (m["planQty"] as num?)?.toDouble() ?? 0, labels);
    }).toList();
  } catch (_) {
    return [];
  }
}

String _serializeObItems(List<_ObItem> items) {
  return jsonEncode(items.map((it) => {
    "partNo": it.partNo, "itemName": it.itemName, "uom": it.uom, "planQty": it.planQty,
    "labels": it.labels.map((l) => {"code": l.code, "qty": l.qty, "scanned": l.scanned}).toList(),
  }).toList());
}

/// 由直调提交的 _rows 生成并保存一张出库单
Future<OutboundOrder> createOutboundOrder(List<Map<String, dynamic>> rows, Map<String, String> to) async {
  final now = DateTime.now();
  final order = OutboundOrder(
    orderNo: "DT${now.millisecondsSinceEpoch}",
    createTime: now,
    toWarehouseName: to["WAREHOUSE_NAME"] ?? "",
    toDistrictName: to["DISTRICT_NAME"] ?? "",
    toLocName: to["LOC_NAME"] ?? "",
    toLocCode: to["LOC_CODE"] ?? "",
    operator: Auth.user?.name ?? Auth.user?.username ?? "",
  );
  final items = rows.map((r) {
    final labels = (r["Barcodes"] as List).map((b) {
      final bm = Map<String, dynamic>.from(b as Map);
      return _ObLabel((bm["SCAN_BARCODE"] ?? bm["LABEL_NO"])?.toString() ?? "", (bm["QTY"] as num?)?.toDouble() ?? 0, false);
    }).toList();
    return _ObItem(r["MITEM_CODE"]?.toString() ?? "", r["MITEM_NAME"]?.toString() ?? "", r["UOM"]?.toString() ?? "",
        (r["REQ_QTY"] as num?)?.toDouble() ?? 0, labels);
  }).toList();
  order.itemsJson = _serializeObItems(items);
  await _globalIsar.writeTxn(() => _globalIsar.outboundOrders.put(order));
  return order;
}

/// 出库单列表页
class OutboundListPage extends StatefulWidget {
  const OutboundListPage({super.key});
  @override
  State<OutboundListPage> createState() => _OutboundListPageState();
}
class _OutboundListPageState extends State<OutboundListPage> {
  List<OutboundOrder> _orders = [];

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    final all = await _globalIsar.outboundOrders.where().sortByCreateTimeDesc().findAll();
    if (mounted) setState(() => _orders = all);
  }

  String _statusLabel(int s) => s == 2 ? "已备齐" : (s == 1 ? "备料中" : "待备料");
  Color _statusColor(int s) => s == 2 ? Colors.green : (s == 1 ? Colors.orange : Colors.grey);

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("出库单"), actions: [
        IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
      ]),
      body: _orders.isEmpty
          ? const Center(child: Text("暂无出库单\n直调提交成功后会自动生成", textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)))
          : ListView.builder(
              itemCount: _orders.length,
              itemBuilder: (ctx, i) {
                final o = _orders[i];
                final items = _parseObItems(o.itemsJson);
                final totalLabels = items.fold<int>(0, (s, it) => s + it.labels.length);
                final scannedLabels = items.fold<int>(0, (s, it) => s + it.labels.where((l) => l.scanned).length);
                final totalQty = items.fold<double>(0, (s, it) => s + it.planQty);
                return Card(
                  margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                  child: ListTile(
                    leading: CircleAvatar(backgroundColor: _statusColor(o.status).withOpacity(0.15),
                      child: Icon(Icons.assignment_outlined, color: _statusColor(o.status))),
                    title: Text(o.orderNo, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                    subtitle: Text(
                      "转入 ${o.toLocName}｜${items.length}种/${totalLabels}箱｜数量合计${_fmtNum(totalQty)}\n"
                      "备料 ${scannedLabels}/$totalLabels 箱  ${o.operator}",
                      style: const TextStyle(fontSize: 12)),
                    trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                      Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(color: _statusColor(o.status).withOpacity(0.12), borderRadius: BorderRadius.circular(6)),
                        child: Text(_statusLabel(o.status), style: TextStyle(fontSize: 11, color: _statusColor(o.status)))),
                      const Icon(Icons.chevron_right),
                    ]),
                    onTap: () async {
                      await Navigator.push(context, MaterialPageRoute(builder: (_) => OutboundPickPage(orderId: o.id)));
                      _load();
                    },
                  ),
                );
              },
            ),
    );
  }
}

/// 出库单备料页：对照表格 + 逐箱扫码核销
class OutboundPickPage extends StatefulWidget {
  final int orderId;
  const OutboundPickPage({super.key, required this.orderId});
  @override
  State<OutboundPickPage> createState() => _OutboundPickPageState();
}
class _OutboundPickPageState extends State<OutboundPickPage> {
  final _scanCtrl = TextEditingController();
  final _scanFocus = FocusNode();
  OutboundOrder? _order;
  List<_ObItem> _items = [];
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  @override
  void dispose() { _scanCtrl.dispose(); _scanFocus.dispose(); super.dispose(); }

  Future<void> _load() async {
    final o = await _globalIsar.outboundOrders.get(widget.orderId);
    if (o != null && mounted) {
      setState(() { _order = o; _items = _parseObItems(o.itemsJson); _loading = false; });
    } else if (mounted) {
      setState(() => _loading = false);
    }
  }

  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.red : Colors.green));
  }

  Future<void> _refocus() async {
    _scanFocus.unfocus();
    await Future.delayed(const Duration(milliseconds: 60));
    if (mounted) _scanFocus.requestFocus();
  }

  Future<void> _onScan() async {
    final code = _scanCtrl.text.trim();
    _scanCtrl.clear();
    if (code.isEmpty) return;
    if (_order == null) return;
    // 命中未扫标签
    _ObItem? hitItem;
    _ObLabel? hitLabel;
    for (final it in _items) {
      for (final l in it.labels) {
        if (l.code == code && !l.scanned) { hitItem = it; hitLabel = l; break; }
      }
      if (hitLabel != null) break;
    }
    if (hitLabel == null) {
      // 是否已扫过
      bool already = _items.any((it) => it.labels.any((l) => l.code == code && l.scanned));
      _toast(already ? "标签 $code 已备料" : "该标签不属于本出库单：$code");
      await _refocus();
      return;
    }
    // 震动/声音反馈
    if (await AppSettings.getVibrationEnabled() && (await Vibration.hasVibrator() ?? false)) {
      await Vibration.vibrate(duration: 60);
    }
    if (await AppSettings.getSoundEnabled()) await SystemSound.play(SystemSoundType.click);
    setState(() {
      hitLabel!.scanned = true;
      _order!.status = _computeStatus();
    });
    await _save();
    // 完成判定
    final total = _items.fold<int>(0, (s, it) => s + it.labels.length);
    final done = _items.fold<int>(0, (s, it) => s + it.labels.where((l) => l.scanned).length);
    if (done >= total) {
      _toast("全部备齐（$done/$total 箱）", err: false);
    } else {
      _toast("${hitItem!.partNo} 已扫（本单 $done/$total 箱）", err: false);
    }
    await _refocus();
  }

  int _computeStatus() {
    final total = _items.fold<int>(0, (s, it) => s + it.labels.length);
    final done = _items.fold<int>(0, (s, it) => s + it.labels.where((l) => l.scanned).length);
    if (done >= total) return 2;
    if (done > 0) return 1;
    return 0;
  }

  Future<void> _save() async {
    final o = _order!;
    o.itemsJson = _serializeObItems(_items);
    await _globalIsar.writeTxn(() => _globalIsar.outboundOrders.put(o));
  }

  Future<void> _undoAll() async {
    final yes = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text("重置备料"), content: const Text("清空本单所有已扫标记，回到待备料？"),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("重置", style: TextStyle(color: Colors.red)))]));
    if (yes != true || !mounted) return;
    setState(() { for (final it in _items) { for (final l in it.labels) { l.scanned = false; } } _order!.status = 0; });
    await _save();
    _toast("已重置", err: false);
  }

  Future<void> _exportCsv() async {
    if (_order == null) return;
    final o = _order!;
    String f(String v) => (v.contains(",") || v.contains("\"")) ? "\"${v.replaceAll("\"", "\"\"")}\"" : v;
    final sb = StringBuffer("单号,零件号,物料名字,标签号,数量,备料状态\n");
    for (final it in _items) {
      for (final l in it.labels) {
        sb.writeln("${f(o.orderNo)},${f(it.partNo)},${f(it.itemName)},${f(l.code)},${_fmtNum(l.qty)},${l.scanned ? "已扫" : "未扫"}\n");
      }
    }
    final dir = await getExternalStorageDirectory();
    if (dir == null) { _toast("无法访问存储目录"); return; }
    final path = "${dir.path}/出库单_${o.orderNo}.csv";
    await File(path).writeAsString(sb.toString(), encoding: utf8);
    if (mounted) _toast("已导出：$path", err: false);
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_order == null) return const Scaffold(body: Center(child: Text("出库单不存在")));
    final o = _order!;
    final total = _items.fold<int>(0, (s, it) => s + it.labels.length);
    final done = _items.fold<int>(0, (s, it) => s + it.labels.where((l) => l.scanned).length);
    return Scaffold(
      appBar: AppBar(title: Text("备料 ${o.orderNo}"), actions: [
        IconButton(onPressed: _exportCsv, icon: const Icon(Icons.download)),
        IconButton(onPressed: _undoAll, icon: const Icon(Icons.restart_alt)),
      ]),
      body: Column(children: [
        Container(
          width: double.infinity, padding: const EdgeInsets.all(12), color: const Color(0xFFF0F4FF),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("转入：${o.toWarehouseName} / ${o.toDistrictName} / ${o.toLocName}（${o.toLocCode}）", style: const TextStyle(fontSize: 13, color: Color(0xFF3F51B5))),
            const SizedBox(height: 4),
            Row(children: [
              Text("备料进度 $done/$total 箱", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
              Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(color: _statusColorOf(o.status).withOpacity(0.12), borderRadius: BorderRadius.circular(6)),
                child: Text(_statusLabelOf(o.status), style: TextStyle(fontSize: 11, color: _statusColorOf(o.status)))),
            ]),
          ]),
        ),
        Padding(padding: const EdgeInsets.all(12), child: TextField(
          controller: _scanCtrl, focusNode: _scanFocus, autofocus: true,
          decoration: const InputDecoration(labelText: "逐箱扫描货物二维码", isDense: true, border: OutlineInputBorder(),
            contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 12)),
          onSubmitted: (_) => _onScan(),
        )),
        Expanded(child: ListView(children: [
          ..._items.map((it) {
            final itTotal = it.labels.length;
            final itDone = it.labels.where((l) => l.scanned).length;
            return Card(margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 4), child: Column(
              crossAxisAlignment: CrossAxisAlignment.start, children: [
                ListTile(
                  dense: true,
                  title: Text("${it.partNo}  ${it.itemName}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                  subtitle: Text("计划数量 ${_fmtNum(it.planQty)} ${it.uom}｜$itDone/$itTotal 箱", style: const TextStyle(fontSize: 12)),
                  trailing: itDone >= itTotal ? const Icon(Icons.check_circle, color: Colors.green) : null,
                ),
                Padding(padding: const EdgeInsets.fromLTRB(16, 0, 16, 10), child: Wrap(spacing: 6, runSpacing: 6, children: [
                  ...it.labels.map((l) => Chip(
                    label: Text("${l.code}·${_fmtNum(l.qty)}", style: const TextStyle(fontSize: 11, color: Colors.white)),
                    backgroundColor: l.scanned ? Colors.green : Colors.grey.shade400,
                    padding: EdgeInsets.zero, visualDensity: VisualDensity.compact, materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  )),
                ])),
              ],
            ));
          }),
          const SizedBox(height: 30),
        ])),
      ]),
    );
  }
}

String _statusLabelOf(int s) => s == 2 ? "已备齐" : (s == 1 ? "备料中" : "待备料");
Color _statusColorOf(int s) => s == 2 ? Colors.green : (s == 1 ? Colors.orange : Colors.grey);
String _fmtNum(num v) {
  if (v == v.roundToDouble()) return v.toInt().toString();
  return v.toStringAsFixed(2);
}
