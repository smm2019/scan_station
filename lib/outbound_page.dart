part of 'main.dart';

// ===================== 出库台账（直调=发料：每次提交成功后逐标签落账，供对照实物出库） =====================
// 一张出库单 = 一次直调提交；明细行 = 一个货物标签（零件号/物料名字/数量/标签号）。
// 仓管拿台账逐箱对照实物：在台账里扫码标记「已核对」，未核对的即差异项；可导出 CSV。
@collection
class OutboundOrder {
  Id id = Isar.autoIncrement;
  late String orderNo;      // 直调单号 DTyyyyMMddHHmmss
  late int createdAt;       // 毫秒时间戳
  late String toLoc;        // 转入货位展示串
  late String operator;     // 操作人姓名(账号)
  late int status;          // 0=未核对完 1=全部已核对
  late String itemsJson;    // [{code,name,qty,barcode,checked}]
}

/// 直调提交成功后调用：按零件号×标签逐行落库一张出库单
Future<OutboundOrder> createOutboundOrder(List<Map<String, dynamic>> rows, Map<String, String> to) async {
  final isar = _globalIsar;
  final now = DateTime.now();
  final ts = "${now.year}${now.month.toString().padLeft(2, "0")}${now.day.toString().padLeft(2, "0")}${now.hour.toString().padLeft(2, "0")}${now.minute.toString().padLeft(2, "0")}${now.second.toString().padLeft(2, "0")}";
  final items = <Map<String, dynamic>>[];
  for (final r in rows) {
    for (final b in (r["Barcodes"] as List)) {
      final bm = Map<String, dynamic>.from(b as Map);
      items.add({
        "code": r["MITEM_CODE"]?.toString() ?? "",
        "name": r["MITEM_NAME"]?.toString() ?? "",
        "qty": (bm["QTY"] as num?)?.toDouble() ?? 0.0,
        "barcode": (bm["SCAN_BARCODE"] ?? bm["LABEL_NO"])?.toString() ?? "",
        "checked": false,
      });
    }
  }
  final user = Auth.user;
  final ob = OutboundOrder()
    ..orderNo = "DT$ts"
    ..createdAt = now.millisecondsSinceEpoch
    ..toLoc = "${to["WAREHOUSE_NAME"] ?? ""}/${to["DISTRICT_NAME"] ?? ""}/${to["LOC_NAME"] ?? ""}"
    ..operator = user == null ? "-" : "${user.name}(${user.username})"
    ..status = 0
    ..itemsJson = jsonEncode(items);
  await isar.writeTxn(() => isar.outboundOrders.put(ob));
  return ob;
}

/// 出库台账列表页
class OutboundListPage extends StatefulWidget {
  const OutboundListPage({super.key});
  @override
  State<OutboundListPage> createState() => _OutboundListPageState();
}

class _OutboundListPageState extends State<OutboundListPage> {
  List<OutboundOrder> _orders = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final list = await _globalIsar.outboundOrders.where().sortByCreatedAt(desc: true).findAll();
    if (!mounted) return;
    setState(() { _orders = list; _loading = false; });
  }

  String _fmt(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    return "${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")} ${d.hour.toString().padLeft(2, "0")}:${d.minute.toString().padLeft(2, "0")}";
  }

  int _checkedCount(OutboundOrder o) {
    try {
      final items = (jsonDecode(o.itemsJson) as List).cast<Map>();
      return items.where((e) => e["checked"] == true).length;
    } catch (_) { return 0; }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(title: const Text("出库台账"), centerTitle: true),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _orders.isEmpty
              ? const Center(child: Text("暂无出库单\n直调提交成功后自动生成", textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(10),
                    itemCount: _orders.length,
                    itemBuilder: (ctx, i) {
                      final o = _orders[i];
                      final items = (jsonDecode(o.itemsJson) as List).cast<Map>();
                      final totalQty = items.fold<double>(0, (s, e) => s + ((e["qty"] as num?)?.toDouble() ?? 0));
                      final checked = _checkedCount(o);
                      final done = checked >= items.length && items.isNotEmpty;
                      return Card(
                        margin: const EdgeInsets.symmetric(vertical: 5),
                        child: ListTile(
                          leading: CircleAvatar(
                            backgroundColor: done ? Colors.green.shade100 : Colors.orange.shade100,
                            child: Icon(done ? Icons.check_circle : Icons.pending, color: done ? Colors.green : Colors.orange),
                          ),
                          title: Text(o.orderNo, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                          subtitle: Text("${_fmt(o.createdAt)} ｜ ${o.toLoc}\n${items.length} 张标签 · 合计 $totalQty ｜ 已核对 $checked/${items.length}", style: const TextStyle(fontSize: 12)),
                          isThreeLine: true,
                          trailing: const Icon(Icons.chevron_right),
                          onTap: () async { await Navigator.push(ctx, MaterialPageRoute(builder: (_) => OutboundDetailPage(orderId: o.id))); if (ctx.mounted) _load(); },
                        ),
                      );
                    },
                  ),
                ),
    );
  }
}
// ---------- 出库单详情：逐箱对照实物，扫码标记已核对 ----------
class OutboundDetailPage extends StatefulWidget {
  final int orderId;
  const OutboundDetailPage({super.key, required this.orderId});
  @override
  State<OutboundDetailPage> createState() => _OutboundDetailPageState();
}

class _OutboundDetailPageState extends State<OutboundDetailPage> {
  final _scanCtrl = TextEditingController();
  final _scanFocus = FocusNode();
  OutboundOrder? _ob;
  List<Map<String, dynamic>> _items = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() { _scanCtrl.dispose(); _scanFocus.dispose(); super.dispose(); }

  Future<void> _load() async {
    final ob = await _globalIsar.outboundOrders.get(widget.orderId);
    if (ob == null || !mounted) return;
    setState(() {
      _ob = ob;
      _items = (jsonDecode(ob.itemsJson) as List).cast<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    });
  }

  String _fmt(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    return "${d.year}-${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")} ${d.hour.toString().padLeft(2, "0")}:${d.minute.toString().padLeft(2, "0")}";
  }

  void _toast(String msg, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: err ? Colors.red : Colors.green, duration: const Duration(seconds: 2)));
  }

  /// 扫码成功反馈（震动+提示音，跟随设置页开关）
  Future<void> _feedback() async {
    try {
      if (await AppSettings.getVibrationEnabled()) {
        if ((await Vibration.hasVibrator()) ?? false) await Vibration.vibrate(duration: 80);
      }
      if (await AppSettings.getSoundEnabled()) await SystemSound.play(SystemSoundType.click);
    } catch (_) {}
  }

  /// 扫货物标签：命中未核对行→标记已核对；全部核对完→整单置「已核对」
  Future<void> _onScan() async {
    final code = _scanCtrl.text.trim();
    _scanCtrl.clear();
    if (code.isEmpty) return;
    var idx = _items.indexWhere((e) => e["barcode"] == code && e["checked"] != true);
    if (idx < 0) {
      final dup = _items.indexWhere((e) => e["barcode"] == code);
      _toast(dup >= 0 ? "标签 $code 已核对过" : "该标签不在本出库单内");
      _rescanFocus();
      return;
    }
    setState(() => _items[idx]["checked"] = true);
    _feedback();
    final left = _items.where((e) => e["checked"] != true).length;
    if (left == 0) {
      final ob = _ob!..status = 1;
      await _globalIsar.writeTxn(() => _globalIsar.outboundOrders.put(ob));
      _toast("全部核对完成，出库单已闭环", err: false);
    } else {
      _toast("已核对，剩余 $left 张未核对", err: false);
    }
    _rescanFocus();
  }

  void _rescanFocus() {
    _scanFocus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _scanFocus.requestFocus(); });
  }

  Future<void> _toggleRow(int i) async {
    setState(() => _items[i]["checked"] = !(_items[i]["checked"] == true));
    await _persist();
  }

  Future<void> _resetAll() async {
    final yes = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text("重置核对"), content: const Text("清空本单全部核对标记？"),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("重置", style: TextStyle(color: Colors.red)))]));
    if (yes != true || !mounted) return;
    setState(() { for (final e in _items) { e["checked"] = false; } });
    await _persist();
  }

  Future<void> _persist() async {
    final ob = _ob!;
    final allChecked = _items.every((e) => e["checked"] == true);
    ob..itemsJson = jsonEncode(_items)..status = allChecked ? 1 : 0;
    await _globalIsar.writeTxn(() => _globalIsar.outboundOrders.put(ob));
    if (allChecked) _toast("全部核对完成，出库单已闭环", err: false);
  }

  String _csv() {
    final b = StringBuffer();
    b.writeln("单号,时间,转入货位,操作人,零件号,物料名字,数量,标签号,核对状态");
    for (final e in _items) {
      b.writeln([_ob!.orderNo, _fmt(_ob!.createdAt), _ob!.toLoc, _ob!.operator,
        '"${e["code"]}"', '"${e["name"]}"', '${e["qty"]}', '"${e["barcode"]}"',
        e["checked"] == true ? "已核对" : "未核对"].join(","));
    }
    return b.toString();
  }

  /// 导出：写入应用外部 Download 级目录（与采集导出同路径）；失败则复制剪贴板兜底
  Future<void> _exportCsv() async {
    final csv = _csv();
    final name = "出库台账_${_ob!.orderNo}.csv";
    try {
      final dir = await getExternalStorageDirectory();
      if (dir == null) throw Exception("存储目录不可用");
      final file = File("${dir.path}/$name");
      await file.writeAsString(csv, encoding: utf8);
      _toast("已保存：${file.path}", err: false);
    } catch (_) {
      await Clipboard.setData(ClipboardData(text: csv));
      _toast("保存失败，CSV 已复制到剪贴板", err: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final ob = _ob;
    if (ob == null) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final checked = _items.where((e) => e["checked"] == true).length;
    final totalQty = _items.fold<double>(0, (s, e) => s + ((e["qty"] as num?)?.toDouble() ?? 0));
    final doneQty = _items.where((e) => e["checked"] == true).fold<double>(0, (s, e) => s + ((e["qty"] as num?)?.toDouble() ?? 0));
    // 按零件号分组展示
    final groups = <String, List<int>>{};
    for (var i = 0; i < _items.length; i++) {
      groups.putIfAbsent(_items[i]["code"].toString(), () => []).add(i);
    }
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        title: Text("出库单 ${ob.orderNo}", style: const TextStyle(fontSize: 16)),
        actions: [
          IconButton(icon: const Icon(Icons.download), tooltip: "导出对照CSV", onPressed: () => _exportCsv()),
          IconButton(icon: const Icon(Icons.restart_alt), tooltip: "重置核对", onPressed: _resetAll),
        ],
      ),
      body: Column(children: [
        Container(
          width: double.infinity,
          margin: const EdgeInsets.all(10), padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("转入：${ob.toLoc}", style: const TextStyle(fontSize: 14)),
            const SizedBox(height: 4),
            Text("时间：${_fmt(ob.createdAt)} ｜ 操作人：${ob.operator}", style: const TextStyle(fontSize: 12, color: Colors.grey)),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: LinearProgressIndicator(value: _items.isEmpty ? 0 : checked / _items.length, minHeight: 8, borderRadius: BorderRadius.circular(4))),
              const SizedBox(width: 10),
              Text("$checked/${_items.length} 张", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
            ]),
            const SizedBox(height: 4),
            Text("应出合计 $totalQty ｜ 已核对 $doneQty", style: const TextStyle(fontSize: 12, color: Colors.grey)),
          ]),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: TextField(
            controller: _scanCtrl, focusNode: _scanFocus, textInputAction: TextInputAction.done,
            onSubmitted: (_) => _onScan(),
            decoration: InputDecoration(
              hintText: "扫描货物二维码进行核对", isDense: true, filled: true, fillColor: Colors.white,
              prefixIcon: const Icon(Icons.qr_code_scanner), border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Expanded(child: ListView(padding: const EdgeInsets.symmetric(horizontal: 10), children: [
          ...groups.entries.map((g) {
            final first = _items[g.value.first];
            final gQty = g.value.fold<double>(0, (s, i) => s + ((_items[i]["qty"] as num?)?.toDouble() ?? 0));
            return Card(
              margin: const EdgeInsets.symmetric(vertical: 5),
              child: ExpansionTile(
                initiallyExpanded: true, tilePadding: const EdgeInsets.symmetric(horizontal: 12),
                title: Text("${g.key}  ${first["name"]}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                subtitle: Text("${g.value.length} 张 · 合计 $gQty", style: const TextStyle(fontSize: 12)),
                children: g.value.map((i) {
                  final e = _items[i];
                  final ck = e["checked"] == true;
                  return ListTile(
                    dense: true, onTap: () => _toggleRow(i),
                    leading: Icon(ck ? Icons.check_circle : Icons.radio_button_unchecked, color: ck ? Colors.green : Colors.grey, size: 22),
                    title: Text(e["barcode"], style: const TextStyle(fontSize: 13, fontFamily: "monospace")),
                    subtitle: Text("数量 ${e["qty"]}", style: const TextStyle(fontSize: 11)),
                  );
                }).toList(),
              ),
            );
          }),
          const SizedBox(height: 30),
        ])),
      ]),
    );
  }
}