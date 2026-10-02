part of 'main.dart';

// ===================== 位置登记（上架/移库/拣下统一入口 + WPS账本导入） =====================
// 账本=ShelfPlacement（标签号→完整库位，如 MB02-A-01-2F / A3 / 已拣下）。
// 上架=从无库位到有；移库=改库位；拣下=删除登记（回到未分配）。

class LocationRegPage extends StatefulWidget {
  const LocationRegPage({super.key});
  @override
  State<LocationRegPage> createState() => _LocationRegPageState();
}

class _LocationRegPageState extends State<LocationRegPage> {
  final _labelCtrl = TextEditingController();
  final _labelFocus = FocusNode();
  final _locCtrl = TextEditingController();
  Map<String, dynamic>? _cur; // 当前筐信息 {barcode,partNo,itemName,qty,date,curLoc,siblings:[]}
  List<ShelfPlacement> _recent = [];

  @override
  void initState() { super.initState(); _loadRecent(); }
  @override
  void dispose() { _labelCtrl.dispose(); _labelFocus.dispose(); _locCtrl.dispose(); super.dispose(); }

  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.red : Colors.green));
  }

  Future<void> _loadRecent() async {
    final rows = await _globalIsar.shelfPlacements.where().sortByAssignedAt(desc: false).findAll();
    if (!mounted) return;
    setState(() => _recent = rows.reversed.take(30).toList());
  }

  /// 扫/输标签：查本地采集账→MES兜底，带出信息与当前库位、同托兄弟码
  Future<void> _lookup(String code) async {
    code = code.trim();
    if (code.isEmpty) return;
    _labelCtrl.clear();
    String partNo = "", itemName = "", date = "";
    double qty = 0;
    final recs = await _globalIsar.scanRecords.filter().goodsCodeEqualTo(code).findAll();
    recs.sort((a, b) => a.scanTime.compareTo(b.scanTime));
    final rec = recs.where((r) => !r.isCancel).lastOrNull ?? recs.lastOrNull;
    final extra = await _globalIsar.recordExtras.filter().goodsCodeEqualTo(code).findFirst();
    if (rec != null && (rec.mesPartNo?.isNotEmpty ?? false)) {
      partNo = rec.mesPartNo!; itemName = extra?.mesItemName ?? ""; qty = rec.mesQty ?? 0; date = rec.mesCreateTime ?? "";
    } else {
      final mes = await mesQueryLabel(code);
      if (mes["ok"] == true) {
        partNo = mes["partNo"]?.toString() ?? ""; itemName = mes["itemName"]?.toString() ?? "";
        qty = (mes["qty"] as num?)?.toDouble() ?? 0; date = mes["createTime"]?.toString() ?? "";
      } else {
        partNo = "(本地与MES均未查到)";
      }
    }
    final sp = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(code).findFirst();
    List<String> siblings = [];
    final palletId = extra?.palletId ?? "";
    if (palletId.isNotEmpty) {
      final mates = await _globalIsar.recordExtras.filter().palletIdEqualTo(palletId).findAll();
      siblings = mates.where((m) => m.goodsCode != code).map((m) => m.goodsCode).toList();
    }
    if (!mounted) return;
    setState(() {
      _cur = {"barcode": code, "partNo": partNo, "itemName": itemName, "qty": qty, "date": date,
        "curLoc": sp?.loc ?? "", "siblings": siblings};
      _locCtrl.text = "";
    });
    _labelFocus.unfocus();
  }

  /// 提交登记：newLoc 空串=拣下（删除）
  Future<void> _commit(String newLoc) async {
    final c = _cur;
    if (c == null) { _toast("请先扫描货物标签"); return; }
    final code = c["barcode"] as String;
    final curLoc = c["curLoc"] as String;
    final List siblings = c["siblings"] as List;
    if (newLoc.isEmpty && curLoc.isEmpty) { _toast("该筐当前无库位记录，无需拣下"); return; }
    bool withSiblings = false;
    if (siblings.isNotEmpty) {
      final sel = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
        title: Text(newLoc.isEmpty ? "拣下该筐" : "登记到 $newLoc"),
        content: Text("该筐为整托多码：同托还有 ${siblings.length} 个兄弟码\n${siblings.join("、")}\n\n是否一并处理（推荐，同托同进同出）？"),
        actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: Text(newLoc.isEmpty ? "仅本码" : "只登记本码")),
          TextButton(onPressed: () => Navigator.pop(dctx, true), child: Text(newLoc.isEmpty ? "全部拣下" : "一并登记"))],
      ));
      if (sel == null) return;
      withSiblings = sel;
    } else {
      final yes = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
        title: Text(newLoc.isEmpty ? "确认拣下" : "确认登记"),
        content: Text(newLoc.isEmpty
            ? "标签 $code\n将从账本移除库位（回到未分配）"
            : "标签 $code\n${curLoc.isEmpty ? "上架" : "移库 $curLoc →"} $newLoc"),
        actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
          TextButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("确认"))],
      ));
      if (yes != true) return;
    }
    final codes = [code, ...(withSiblings ? siblings.map((e) => e.toString()) : <String>[])];
    await _globalIsar.writeTxn(() async {
      for (final cd in codes) {
        final olds = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(cd).findAll();
        await _globalIsar.shelfPlacements.deleteAll(olds.map((e) => e.id));
        if (newLoc.isNotEmpty) {
          await _globalIsar.shelfPlacements.put(ShelfPlacement()
            ..goodsCode = cd ..loc = newLoc
            ..container = "" ..operator = Auth.user?.name ?? "手工登记"
            ..assignedAt = DateTime.now().millisecondsSinceEpoch);
        }
      }
    });
    if (!mounted) return;
    _toast(newLoc.isEmpty ? "已拣下（${codes.length} 码）" : "已登记 $newLoc（${codes.length} 码）", err: false);
    if (await Vibration.hasVibrator() ?? false) await Vibration.vibrate(duration: 80);
    setState(() => _cur = null);
    _loadRecent();
    _labelFocus.requestFocus();
  }

  /// 选库位：扫库位码或手输+层快捷
  Future<void> _pickLoc() async {
    final ctrl = TextEditingController(text: _locCtrl.text);
    final recent = _recent.map((e) => e.loc).toSet().toList()..sort();
    final result = await showDialog<String>(context: context, builder: (dctx) => StatefulBuilder(builder: (bctx, setSt) {
      return AlertDialog(
        title: const Text("目标库位"),
        content: SizedBox(width: 340, child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(labelText: "完整库位（如 MB02-A-01-2F 或 A3）", isDense: true, border: OutlineInputBorder())),
          if (recent.isNotEmpty) ...[
            const SizedBox(height: 6),
            Align(alignment: Alignment.centerLeft, child: Text("最近使用：", style: TextStyle(fontSize: 11, color: Colors.grey))),
            Wrap(spacing: 6, children: recent.take(10).map((l) => ActionChip(label: Text(l, style: const TextStyle(fontSize: 10)), onPressed: () { ctrl.text = l; setSt(() {}); })).toList()),
          ],
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dctx), child: const Text("取消")),
          ElevatedButton(onPressed: () => Navigator.pop(dctx, ctrl.text.trim().toUpperCase()), child: const Text("确定")),
        ],
      );
    }));
    ctrl.dispose();
    if (result == null) return;
    if (result.isEmpty) { _commit(""); return; } // 空=拣下
    setState(() { _locCtrl.text = result; _cur = {...?_cur}; });
    _commit(result);
  }

  /// WPS 账本导入：从 baseline 目录选货架表 CSV（标签号+完整货位编码列），整批替换
  Future<void> _importWps() async {
    final files = await listBaselineFiles();
    if (!mounted) return;
    if (files.isEmpty) { _toast("请先在电脑浏览器打开门户，上传货架表CSV（含 标签号+完整货位编码 两列）"); return; }
    final picked = await showModalBottomSheet<String>(context: context, builder: (ctx) => SafeArea(child: ListView(
      children: [
        const Padding(padding: EdgeInsets.all(14), child: Text("选择货架账本文件（网页门户已上传）", style: TextStyle(fontWeight: FontWeight.bold))),
        ...files.map((f) => ListTile(title: Text(f["name"] as String), subtitle: Text("${((f["size"] as int) / 1024).toStringAsFixed(0)} KB · ${(f["mtime"] as String).substring(0, 16)}"), onTap: () => Navigator.pop(ctx, f["path"] as String))),
      ],
    )));
    if (picked == null || !mounted) return;
    List<List<String>> parsed;
    try {
      final raw = await File(picked).readAsString(encoding: utf8);
      parsed = _parseShelfLedger(raw);
    } catch (e) {
      _toast("导入失败：$e");
      return;
    }
    if (parsed.isEmpty) { _toast("未解析到有效行：需要「标签」列与「货位」列（如 完整货位编码）"); return; }
    final preview = parsed.take(5).map((e) => "${e[0]} → ${e[1]}").join("\n");
    final yes = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
      title: const Text("确认导入货架账本"),
      content: Text("解析成功 ${parsed.length} 条（示例）：\n$preview\n\n⚠️ 将整批替换现有库位登记（地面/站台记录不受影响的判断：全部替换，导入后请抽查）。确认？"),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("替换导入"))],
    ));
    if (yes != true) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    final oper = Auth.user?.name ?? "WPS导入";
    await _globalIsar.writeTxn(() async {
      await _globalIsar.shelfPlacements.where().deleteAll();
      await _globalIsar.shelfPlacements.putAll(parsed.map((e) => ShelfPlacement()
        ..goodsCode = e[0] ..loc = e[1] ..container = "" ..operator = oper ..assignedAt = now).toList());
    });
    if (!mounted) return;
    _toast("账本导入完成：${parsed.length} 条", err: false);
    setState(() { _cur = null; });
    _loadRecent();
  }

  @override
  Widget build(BuildContext context) {
    final c = _cur;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        backgroundColor: const Color(0xFF515BD4), title: const Text("位置登记"),
        actions: [IconButton(tooltip: "导入WPS账本", icon: const Icon(Icons.file_download_outlined), onPressed: _importWps)],
      ),
      body: Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 4), child: TextField(
          controller: _labelCtrl, focusNode: _labelFocus, autofocus: true,
          decoration: const InputDecoration(hintText: "扫描货物标签（第一步）", isDense: true, prefixIcon: Icon(Icons.qr_code_scanner), filled: true, fillColor: Colors.white, border: OutlineInputBorder()),
          onSubmitted: _lookup,
        )),
        if (c != null) Container(
          width: double.infinity, margin: const EdgeInsets.fromLTRB(12, 6, 12, 0), padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFC7CDF0))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("${c["partNo"]}  ${c["itemName"]}", style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
            const SizedBox(height: 2),
            Text("标签 ${c["barcode"]} · 数量 ${_fmtInvNum(c["qty"] as double)}${(c["date"] as String).isNotEmpty ? " · 入库 ${(c["date"] as String).substring(0, 10)}" : ""}", style: const TextStyle(fontSize: 12, color: Colors.grey)),
            const SizedBox(height: 2),
            Text("当前库位：${(c["curLoc"] as String).isEmpty ? "未登记" : c["curLoc"]}", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: (c["curLoc"] as String).isEmpty ? Colors.orange : const Color(0xFF3F51B5))),
            if ((c["siblings"] as List).isNotEmpty) Text("同托兄弟码 ${(c["siblings"] as List).length} 个：${(c["siblings"] as List).join("、")}", style: const TextStyle(fontSize: 11, color: Colors.teal)),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
                onPressed: _pickLoc, icon: const Icon(Icons.place_outlined), label: Text((c["curLoc"] as String).isEmpty ? "扫/选库位上架" : "移库 / 拣下")),
              ),
            ]),
          ]),
        ),
        const SizedBox(height: 6),
        Expanded(child: _recent.isEmpty
            ? const Center(child: Text("暂无库位登记记录", style: TextStyle(color: Colors.grey)))
            : ListView(padding: const EdgeInsets.symmetric(horizontal: 12), children: [
                const Padding(padding: EdgeInsets.fromLTRB(4, 8, 4, 4), child: Text("最近登记", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
                ..._recent.map((p) => Card(margin: const EdgeInsets.symmetric(vertical: 3), child: ListTile(
                  dense: true,
                  leading: const Icon(Icons.shelves, size: 20, color: Color(0xFF515BD4)),
                  title: Text(p.loc, style: const TextStyle(fontSize: 13, fontFamily: "monospace", fontWeight: FontWeight.w600)),
                  subtitle: Text("${p.goodsCode} · ${p.operator} · ${DateTime.fromMillisecondsSinceEpoch(p.assignedAt).toString().substring(5, 16)}", style: const TextStyle(fontSize: 11)),
                ))),
              ])),
      ]),
    );
  }
}

/// 解析货架账本CSV：找「标签」列+「货位」列，返回 [[label, loc], ...]
List<List<String>> _parseShelfLedger(String raw) {
  final text = raw.startsWith('\uFEFF') ? raw.substring(1) : raw;
  final lines = text.split(RegExp(r"\r?\n")).where((l) => l.trim().isNotEmpty).toList();
  if (lines.isEmpty) return [];
  final head = _parseCsvLine(lines[0]);
  final colLabel = _findCol(head, ["标签号", "货物标签", "标签", "LABEL", "BARCODE"]);
  final colLoc = _findCol(head, ["完整货位编码", "货位编码", "货位", "库位", "LOC"]);
  if (colLabel < 0 || colLoc < 0) return [];
  final out = <List<String>>[];
  final seen = <String>{};
  for (var i = 1; i < lines.length; i++) {
    final cols = _parseCsvLine(lines[i]);
    if (cols.length <= colLabel || cols.length <= colLoc) continue;
    final label = cols[colLabel].trim().toUpperCase();
    final loc = cols[colLoc].trim().toUpperCase();
    if (label.isEmpty || loc.isEmpty) continue;
    if (!seen.add(label)) continue; //同标签重复行取首行
    out.add([label, loc]);
  }
  return out;
}
