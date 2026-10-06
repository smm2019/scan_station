part of 'main.dart';

// ===================== 位置登记（上架/移库/拣下统一入口 + WPS账本导入） =====================
// 账本=ShelfPlacement（标签号→完整库位，如 MB02-A-01-2F / A3 / 已拣下）。
// 上架=从无库位到有；移库=改库位；拣下=删除登记（回到未分配）。

/// 标签物料信息缓存：批量拿账本标签查 MES 存下，存量筐不必现场扫码也能看到零件信息。
/// 独立表，不写 ScanRecord（采集流水派生库存口径，混入会造成重复计数）。
@collection
class LabelInfo {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  String goodsCode = "";   // 标签号（大写）
  String partNo = "";      // 零件号
  String itemName = "";    // 物料描述
  double qty = 0;          // 数量
  String lotNo = "";       // 批次
  String createTime = "";  // MES 入库时间原文
  bool missing = false;    // 查询成功但 MES 无此标签（避免反复重查）
  late int syncedAt;       // 本地缓存时间
}

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
    final rows = await _globalIsar.shelfPlacements.where().sortByAssignedAt().findAll();
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
      final cached = await _globalIsar.labelInfos.filter().goodsCodeEqualTo(code).findFirst();
      if (cached != null && !cached.missing && (cached.partNo.isNotEmpty || cached.itemName.isNotEmpty)) {
        partNo = cached.partNo; itemName = cached.itemName; qty = cached.qty; date = cached.createTime;
      } else {
        final mes = await mesQueryLabel(code);
        if (mes["ok"] == true) {
          partNo = mes["partNo"]?.toString() ?? ""; itemName = mes["itemName"]?.toString() ?? "";
          qty = (mes["qty"] as num?)?.toDouble() ?? 0; date = mes["createTime"]?.toString() ?? "";
          await _saveLabelInfo(code, partNo, itemName, qty, (mes["lotNo"] ?? "").toString(), date, false);
        } else {
          partNo = "(本地与MES均未查到)";
        }
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

  /// 写/更新标签物料缓存（goodsCode 唯一，先删旧再写新）
  Future<void> _saveLabelInfo(String code, String partNo, String itemName, double qty, String lotNo, String createTime, bool missing) async {
    final up = code.toUpperCase();
    await _globalIsar.writeTxn(() async {
      await _globalIsar.labelInfos.filter().goodsCodeEqualTo(up).deleteAll();
      await _globalIsar.labelInfos.put(LabelInfo()
        ..goodsCode = up ..partNo = partNo ..itemName = itemName ..qty = qty
        ..lotNo = lotNo ..createTime = createTime ..missing = missing
        ..syncedAt = DateTime.now().millisecondsSinceEpoch);
    });
  }

  bool _backfilling = false;

  /// 批量补齐：账本里有库位、但本地无物料记录的标签，逐个查 MES 存入缓存
  Future<void> _backfillMaterials() async {
    if (_backfilling) return;
    final all = await _globalIsar.shelfPlacements.where().findAll();
    if (all.isEmpty) { _toast("账本为空，先导入或登记库位"); return; }
    final cached = {for (final e in await _globalIsar.labelInfos.where().findAll()) e.goodsCode};
    final todo = all.map((p) => p.goodsCode).where((c) => !cached.contains(c)).toList();
    if (todo.isEmpty) { _toast("物料信息已全部补齐（${all.length} 条均有缓存）", err: false); return; }
    final yes = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
      title: const Text("批量补齐物料信息"),
      content: Text("账本 ${all.length} 个标签中，有 ${todo.length} 个本地没有物料记录。\n将逐个向 MES 查询（约每个 0.5~2 秒，期间请保持本页打开、别切走）。\n\n需 MES 已登录。开始？"),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("开始补齐"))],
    ));
    if (yes != true || !mounted) return;
    setState(() => _backfilling = true);
    int done = 0, ok = 0, miss = 0, fail = 0;
    String abort = "";
    for (final code in todo) {
      if (!mounted) break;
      final mes = await mesQueryLabel(code);
      if (mes["ok"] == true) {
        await _saveLabelInfo(code, mes["partNo"]?.toString() ?? "", mes["itemName"]?.toString() ?? "",
            (mes["qty"] as num?)?.toDouble() ?? 0, (mes["lotNo"] ?? "").toString(),
            mes["createTime"]?.toString() ?? "", false);
        ok++;
      } else {
        final m = mes["msg"]?.toString() ?? "";
        if (m.startsWith("MES登录已失效") || m.startsWith("MES Token为空")) { abort = m; break; }
        if (m.contains("查询结果为空")) { await _saveLabelInfo(code, "", "", 0, "", "", true); miss++; }
        else { fail++; } // 网络等异常：不写缓存，下次可重试
      }
      done++;
      setState(() {}); // 刷新进度
    }
    if (!mounted) return;
    setState(() => _backfilling = false);
    if (abort.isNotEmpty) {
      _toast("补齐中断（$done/${todo.length}）：$abort");
    } else {
      _toast("补齐完成：查到 $ok，MES无此码 $miss，失败 $fail（共 $done）", err: false);
      if (ok > 0) _syncLedger(); // 带了新物料，同步电脑
    }
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
        await _globalIsar.shelfPlacements.deleteAll(olds.map((e) => e.id).toList());
        if (newLoc.isNotEmpty) {
          await _globalIsar.shelfPlacements.put(ShelfPlacement()
            ..goodsCode = cd ..loc = newLoc
            ..container = "" ..operator = Auth.user?.name ?? "手工登记"
            ..assignedAt = DateTime.now().millisecondsSinceEpoch);
        }
      }
    });
    if (newLoc.isEmpty) { await ledgerMarkDeleted(codes); } else { await ledgerUnmarkDeleted(codes); } // 拣下记墓碑；登记撤销墓碑
    if (!mounted) return;
    _toast(newLoc.isEmpty ? "已拣下（${codes.length} 码）" : "已登记 $newLoc（${codes.length} 码）", err: false);
    if (await Vibration.hasVibrator() ?? false) await Vibration.vibrate(duration: 80);
    setState(() => _cur = null);
    _loadRecent();
    _labelFocus.requestFocus();
    _syncLedger(quietOnOk: true); // 静默同步电脑（成功不打扰，失败提示手动重试）
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

  /// 账本变化后全量同步到电脑服务器（其他设备可查）；失败不影响本地数据
  Future<void> _syncLedger({bool quietOnOk = false}) async {
    try {
      final all = await _globalIsar.shelfPlacements.where().findAll();
      final hasTomb = (await ledgerTombs()).isNotEmpty;
      if (all.isEmpty && !hasTomb) { _toast("本地账本为空，无需同步"); return; }
      final r = await ledgerPushNow(); // 统一走带墓碑的增量合并推送
      if (!mounted) return;
      if (r["ok"] == true) {
        if (!quietOnOk) _toast("已同步电脑：账本 ${all.length} 条（v${r["rev"]}），其他设备打开 /board/ledger 可查", err: false);
      } else {
        _toast("同步到电脑失败：${r["msg"]}（本地数据已保存，可点右上云图标重试）");
      }
    } catch (e) {
      if (mounted) _toast("同步异常：$e");
    }
  }

  /// WPS 账本导入：从 baseline 目录选货架表 CSV（标签号+完整货位编码列），整批替换
  Future<void> _importWps() async {
    final files = await listBaselineFiles();
    if (!mounted) return;
    final picked = await showModalBottomSheet<String>(context: context, builder: (ctx) => SafeArea(child: ListView(
      children: [
        const Padding(padding: EdgeInsets.all(14), child: Text("选择账本来源", style: TextStyle(fontWeight: FontWeight.bold))),
        ListTile(leading: const Icon(Icons.cloud_download, color: Color(0xFF00897B)),
          title: const Text("从电脑服务器拉取（推荐）"),
          subtitle: const Text("取 PDA 之前同步到电脑的账本，本机没放文件也能用"),
          onTap: () => Navigator.pop(ctx, "_SRV")),
        if (files.isNotEmpty) ...[
          const Divider(height: 1),
          const Padding(padding: EdgeInsets.fromLTRB(14, 8, 14, 4), child: Text("或选择本机已上传的 CSV：", style: TextStyle(fontSize: 12, color: Colors.grey))),
          ...files.map((f) => ListTile(leading: const Icon(Icons.description_outlined), title: Text(f["name"] as String), subtitle: Text("${((f["size"] as int) / 1024).toStringAsFixed(0)} KB · ${(f["mtime"] as String).substring(0, 16)}"), onTap: () => Navigator.pop(ctx, f["path"] as String))),
        ],
      ],
    )));
    if (picked == null || !mounted) return;
    List<List<String>> parsed;
    if (picked == "_SRV") {
      final r = await AuthApi.ledgerGet();
      if (!mounted) return;
      if (r["ok"] != true) { _toast("拉取电脑账本失败：${r["msg"]}"); return; }
      final items = List<Map>.from(r["items"] ?? []);
      if (items.isEmpty) { _toast("电脑账本为空——请先用本机 CSV 导入一次并同步，之后即可双向互拉"); return; }
      parsed = items.map((e) => [
        e["c"]?.toString().toUpperCase() ?? "", e["l"]?.toString().toUpperCase() ?? "", e["f"]?.toString() ?? "",
        e["p"]?.toString().toUpperCase() ?? "", e["n"]?.toString() ?? "", (e["q"] as num?)?.toString() ?? "", e["b"]?.toString() ?? "",
      ]).where((l) => l[0].isNotEmpty && l[1].isNotEmpty).toList();
    } else {
      try {
        final raw = await File(picked).readAsString(encoding: utf8);
        parsed = _parseShelfLedger(raw);
      } catch (e) {
        _toast("导入失败：$e");
        return;
      }
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
    // 被本次导入替换掉的旧标签：记墓碑随推送删除（导入=以这份表为权威重建账本）
    final newSet = parsed.map((e) => e[0].toUpperCase()).toSet();
    final oldAll = await _globalIsar.shelfPlacements.where().findAll();
    final dropped = oldAll.map((p) => p.goodsCode).where((c) => !newSet.contains(c.toUpperCase())).toList();
    if (dropped.isNotEmpty) await ledgerMarkDeleted(dropped);
    await _globalIsar.writeTxn(() async {
      await _globalIsar.shelfPlacements.where().deleteAll();
      await _globalIsar.labelInfos.where().deleteAll();
      await _globalIsar.shelfPlacements.putAll(parsed.map((e) => ShelfPlacement()
        ..goodsCode = e[0] ..loc = e[1] ..container = e.length > 2 ? e[2] : "" ..operator = oper ..assignedAt = now).toList());
      //账本自带物料列写入缓存表：库存立刻可算，不必等MES补齐；无物料的标签留给"批量补齐"
      final infos = <LabelInfo>[];
      for (final e in parsed) {
        final part = e.length > 3 ? e[3] : "";
        if (part.isEmpty) continue;
        infos.add(LabelInfo()
          ..goodsCode = e[0] ..partNo = part
          ..itemName = e.length > 4 ? e[4] : ""
          ..qty = double.tryParse(e.length > 5 ? e[5] : "") ?? 0
          ..lotNo = e.length > 6 ? e[6] : ""
          ..createTime = "" ..missing = false ..syncedAt = now);
      }
      if (infos.isNotEmpty) await _globalIsar.labelInfos.putAll(infos);
    });
    if (!mounted) return;
    _toast("账本导入完成：${parsed.length} 条", err: false);
    setState(() { _cur = null; });
    _loadRecent();
    _syncLedger(); // 导入后同步电脑（带回执）
  }

  @override
  Widget build(BuildContext context) {
    final c = _cur;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        backgroundColor: const Color(0xFF515BD4), title: const Text("位置登记"),
        actions: [
          if (_backfilling)
            const Padding(padding: EdgeInsets.symmetric(horizontal: 12), child: Center(child: SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white))))
          else
            IconButton(tooltip: "批量补齐物料信息（查MES）", icon: const Icon(Icons.build_circle_outlined), onPressed: _backfillMaterials),
          IconButton(tooltip: "同步账本到电脑", icon: const Icon(Icons.cloud_upload_outlined), onPressed: () => _syncLedger()),
          IconButton(tooltip: "导入WPS账本", icon: const Icon(Icons.file_download_outlined), onPressed: _importWps)],
      ),
      body: Column(children: [
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
        ScanBar(ctrl: _labelCtrl, focus: _labelFocus, hint: "扫描货物标签（第一步）",
          onSubmit: (s) => _lookup(s)),
      ]),
    );
  }
}

/// 解析货架账本CSV：找「标签」列+「货位」列（可选「料框类型」列），返回 [[label, loc, frame], ...]
List<List<String>> _parseShelfLedger(String raw) {
  final text = raw.startsWith('\uFEFF') ? raw.substring(1) : raw;
  final lines = text.split(RegExp(r"\r?\n")).where((l) => l.trim().isNotEmpty).toList();
  if (lines.isEmpty) return [];
  final head = _parseCsvLine(lines[0]);
  final colLabel = _findCol(head, ["标签号", "货物标签", "标签", "LABEL", "BARCODE"]);
  final colLoc = _findCol(head, ["完整货位编码", "货位编码", "货位", "库位", "LOC"]);
  if (colLabel < 0 || colLoc < 0) return [];
  final colFrame = _findCol(head, ["料框类型", "容器类型", "料框"]); //不含"容器编码"防误匹配DISPIMG公式列
  final colPart = _findCol(head, ["零件号", "零件编号", "料号", "物料编码"]);
  final colName = _findCol(head, ["物料描述", "物料名称", "零件名称", "品名"]);
  final colQty = _findCol(head, ["数量", "框内数量"]);
  final colLot = _findCol(head, ["批次", "批号"]);
  final out = <List<String>>[];
  final seen = <String>{};
  String cAt(List<String> cols, int i) => i >= 0 && i < cols.length ? cols[i].trim() : "";
  for (var i = 1; i < lines.length; i++) {
    final cols = _parseCsvLine(lines[i]);
    if (cols.length <= colLabel || cols.length <= colLoc) continue;
    var label = cols[colLabel].trim().toUpperCase();
    final loc = cols[colLoc].trim().toUpperCase();
    final part = cAt(cols, colPart).toUpperCase();
    if (loc.isEmpty) continue;
    if (label.isEmpty) {
      if (part.isEmpty) continue; //无标签无零件=真空位
      label = 'NT-$loc'; //无标签有货：占位标签入账，系统不再当空位
    }
    if (!seen.add(label)) continue; //同标签重复行取首行
    out.add([label, loc, cAt(cols, colFrame), part, cAt(cols, colName), cAt(cols, colQty), cAt(cols, colLot)]);
  }
  return out;
}
