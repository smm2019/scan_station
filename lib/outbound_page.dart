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
  String linkReqNo = "";    // 关联领料单号（领料发料转MES生成的出库单填写，直调为空）
}

/// 直调/领料转单成功后调用：按零件号×标签逐行落库一张出库单
/// agvCodes：领料单上已叫AGV的标签集合（含同框兄弟码由调用方展开），命中则该箱标记"AGV"，否则"人工"
Future<OutboundOrder> createOutboundOrder(List<Map<String, dynamic>> rows, Map<String, String> to, {String linkReqNo = "", Map<String, String> fromLocs = const {}, Set<String> agvCodes = const {}}) async {
  final isar = _globalIsar;
  final now = DateTime.now();
  final ts = "${now.year}${now.month.toString().padLeft(2, "0")}${now.day.toString().padLeft(2, "0")}${now.hour.toString().padLeft(2, "0")}${now.minute.toString().padLeft(2, "0")}${now.second.toString().padLeft(2, "0")}";
  final items = <Map<String, dynamic>>[];
  for (final r in rows) {
    for (final b in (r["Barcodes"] as List)) {
      final bm = Map<String, dynamic>.from(b as Map);
      final pn = (r["PART_NO"] ?? bm["PART_NO"])?.toString() ?? "";
      final bc = (bm["SCAN_BARCODE"] ?? bm["LABEL_NO"])?.toString() ?? "";
      final fl = (fromLocs[bc.toUpperCase()] ?? "").isNotEmpty ? fromLocs[bc.toUpperCase()]! : await ledgerLocOfCode(bc);
      items.add({
        "code": pn.isNotEmpty ? pn : (r["MITEM_CODE"]?.toString() ?? ""), // 真实零件号，查不到时回退物料编码
        "mitemCode": r["MITEM_CODE"]?.toString() ?? "",
        "name": r["MITEM_NAME"]?.toString() ?? "",
        "qty": (bm["QTY"] as num?)?.toDouble() ?? 0.0,
        "barcode": bc,
        "fromLoc": fl, // 从哪个货架位/地面格位发走
        "move": agvCodes.contains(bc.toUpperCase()) ? "AGV" : "人工", // 搬运方式：叫过车=AGV叉到站台，否则=人工
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
    ..linkReqNo = linkReqNo
    ..itemsJson = jsonEncode(items);
  await isar.writeTxn(() => isar.outboundOrders.put(ob));
  try {
    final outCodes = items.map((e) => e["barcode"].toString().toUpperCase()).where((s) => s.isNotEmpty).toList();
    for (final c in outCodes) { await ledgerRemoveBoxAndPush(c); } //出库即整框拣下：同托兄弟码一并消位并同步电脑
    outboundPushNow(ob); //出库单同步电脑数据库
  } catch (_) {}
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
  List<Map> _remote = []; // ⑰其他设备同步到服务器的出库单（只读）
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    // Isar 3.1 的 sortByXxx 不支持 desc 参数：取全量后内存按创建时间倒序
    final list = await _globalIsar.outboundOrders.where().findAll();
    list.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    List<Map> remote = [];
    try {
      final r = await AuthApi.outboundGet().timeout(const Duration(seconds: 8));
      if (r["ok"] == true) {
        final have = list.map((e) => e.orderNo).toSet();
        for (final o in List<Map>.from(r["items"] ?? [])) {
          final no = o["orderNo"]?.toString() ?? "";
          if (no.isEmpty || have.contains(no)) continue;
          remote.add(o);
        }
        remote.sort((a, b) => ((b["createdAt"] as num?) ?? 0).compareTo((a["createdAt"] as num?) ?? 0));
      }
    } catch (_) {}
    if (!mounted) return;
    setState(() { _orders = list; _remote = remote; _loading = false; });
  }

  String _fmtMs(dynamic v) => _fmt((v as num?)?.toInt() ?? 0);

  void _showRemote(Map ro) {
    final items = List<Map>.from(ro["items"] ?? []);
    showModalBottomSheet(context: context, isScrollControlled: true, builder: (mctx) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(12), child: Text("出库单 ${ro["orderNo"]}（其他设备·只读）", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
      Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Text("转入：${ro["toLoc"]} ｜ ${_fmtMs(ro["createdAt"])} ｜ ${ro["operator"]}", style: const TextStyle(fontSize: 12, color: Colors.grey))),
      const SizedBox(height: 6),
      Flexible(child: ListView(children: items.map((e) => ListTile(dense: true,
        title: Text("${e["code"]}  ${e["name"]}", style: const TextStyle(fontSize: 13, fontFamily: "monospace")),
        subtitle: Text("数量 ${e["qty"]} · 标签 ${e["barcode"]}${(e["fromLoc"] ?? "").toString().isNotEmpty ? " · 原货位 ${e["fromLoc"]}" : ""}", style: const TextStyle(fontSize: 11)),
      )).toList())),
      TextButton(onPressed: () => Navigator.pop(mctx), child: const Text("关闭")),
    ])));
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
          : _orders.isEmpty && _remote.isEmpty
              ? const Center(child: Text("暂无出库单\n直调提交成功后自动生成", textAlign: TextAlign.center, style: TextStyle(color: Colors.grey)))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView.builder(
                    padding: const EdgeInsets.all(10),
                    itemCount: _orders.length + _remote.length,
                    itemBuilder: (ctx, i) {
                      if (i >= _orders.length) {
                        final ro = _remote[i - _orders.length];
                        final rItems = List<Map>.from(ro["items"] ?? []);
                        final rQty = rItems.fold<double>(0, (s, e) => s + ((e["qty"] as num?)?.toDouble() ?? 0));
                        return Card(
                          margin: const EdgeInsets.symmetric(vertical: 5),
                          child: ListTile(
                            leading: CircleAvatar(backgroundColor: Colors.blueGrey.withOpacity(0.12), child: const Icon(Icons.inventory_2_outlined, color: Colors.blueGrey)),
                            title: Text("${ro["orderNo"]}  ${_fmtMs(ro["createdAt"])}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                            subtitle: Text("${ro["toLoc"]}\n${rItems.length} 张 · 合计 $rQty ｜ ${ro["operator"]} ｜ 其他设备单据", style: const TextStyle(fontSize: 12)),
                            isThreeLine: true,
                            trailing: const Icon(Icons.chevron_right),
                            onTap: () => _showRemote(ro),
                          ),
                        );
                      }
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

  bool _checking = false;
  final Map<int, String> _mesRes = {}; // ⑰标签→MES当前在库位置核对结果
  Future<void> _checkMes() async {
    if (_checking || _ob == null || _items.isEmpty) return;
    setState(() { _checking = true; _mesRes.clear(); });
    final to = _ob!.toLoc;
    var okN = 0, badN = 0, missN = 0;
    final idxs = [for (var i = 0; i < _items.length && i < 30; i++) i];
    for (var s = 0; s < idxs.length; s += 5) {
      await Future.wait(idxs.sublist(s, (s + 5) > idxs.length ? idxs.length : s + 5).map((i) async {
        try {
          final d = await mesGetData("/api/v1/rawtransfer/GetBarCodeInfoOnHand", {"barcode": _items[i]["barcode"].toString()});
          if (d == null) { _mesRes[i] = "MES查无此标"; missN++; return; }
          final loc = "${d["WAREHOUSE_NAME"] ?? ""}/${d["DISTRICT_NAME"] ?? ""}/${d["LOC_NAME"] ?? ""}";
          if (loc == to) { _mesRes[i] = "✓ 已在线边仓"; okN++; }
          else { _mesRes[i] = "⚠ 现在在 $loc"; badN++; }
        } catch (_) { _mesRes[i] = "查询失败"; missN++; }
      }));
    }
    if (!mounted) return;
    setState(() => _checking = false);
    _toast("去向核对：$okN 已在线边仓 ｜ $badN 位置不符 ｜ $missN 查不到${_items.length > 30 ? "（仅查前30张）" : ""}", err: badN > 0 || missN > 0);
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
    outboundPushNow(ob); //核对状态变化同步电脑
    if (allChecked) _toast("全部核对完成，出库单已闭环", err: false);
  }

  String _csv() {
    final b = StringBuffer();
    b.writeln("单号,时间,转入货位,操作人,零件号,物料名字,数量,标签号,原货位,搬运方式,核对状态");
    for (final e in _items) {
      b.writeln([_ob!.orderNo, _fmt(_ob!.createdAt), _ob!.toLoc, _ob!.operator,
        '"${e["code"]}"', '"${e["name"]}"', '${e["qty"]}', '"${e["barcode"]}"', '"${e["fromLoc"] ?? ""}"',
        '"${e["move"] ?? ""}"',
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
          IconButton(icon: _checking ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2)) : const Icon(Icons.warehouse_outlined), tooltip: "MES去向核对（标签现是否在线边仓）", onPressed: _checking ? null : _checkMes),
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
          child: Text("已核对 ${_items.where((e) => e["checked"] == true).length}/${_items.length} 张，逐箱对照实物扫码打勾", style: const TextStyle(fontSize: 11, color: Colors.grey)),
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
                    subtitle: Text("数量 ${e["qty"]}${(e["fromLoc"] ?? "").toString().isNotEmpty ? " · 原货位 ${e["fromLoc"]}" : ""}${(e["move"] ?? "").toString().isNotEmpty ? " · ${e["move"] == "AGV" ? "🚗AGV叉来" : "🚶人工"}" : ""}${_mesRes[i] != null ? "\n去向核对：${_mesRes[i]}" : ""}", style: const TextStyle(fontSize: 11)),
                  );
                }).toList(),
              ),
            );
          }),
          const SizedBox(height: 30),
        ])),
        ScanBar(ctrl: _scanCtrl, focus: _scanFocus, hint: "扫描货物二维码进行核对",
          onSubmit: (s) => _onScan()),
      ]),
    );
  }
}