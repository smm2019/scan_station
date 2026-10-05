part of 'main.dart';

// ===================== 领料单（物料员下单/签收 · 仓管接单/扫码发料） =====================
// 状态机（服务端强制）：pending待接单 → accepted备料中 → ready已备齐 → done已完成
//                        pending → rejected已拒绝 / pending|accepted → cancelled已取消

/// 领料已发料标签本地缓存：每次拉取领料列表后刷新，库存计算据此剔除已发框（离线兜底）
class RequisitionCache {
  static const String _kIssued = "req_issued_barcodes";
  static Future<void> saveIssued(List<Map> reqs) async {
    final set = <String>{};
    const active = {'accepted', 'ready', 'done'}; // 取消/拒单整单退回库存
    for (final r in reqs) {
      if (!active.contains(r["status"])) continue;
      final finished = r["status"] == 'ready' || r["status"] == 'done'; // ready/done 时所有行必已 transfer/skip
      for (final it in List<Map>.from(r["items"] ?? [])) {
        if (!finished && it["transferred"] != true) continue; // 备料中：只扣已转MES的行（扫而未转不算出库）
        for (final x in List.from(it["issued"] ?? [])) {
          // 新格式 {c:标签,q:件数}；旧格式纯字符串标签
          set.add(x is Map ? (x["c"]?.toString() ?? "") : x.toString());
        }
      }
    }
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kIssued, jsonEncode(set.toList()));
  }
  static Future<Set<String>> loadIssued() async {
    final sp = await SharedPreferences.getInstance();
    final s = sp.getString(_kIssued);
    if (s == null || s.isEmpty) return {};
    try { return (jsonDecode(s) as List).map((e) => e.toString()).toSet(); } catch (_) { return {}; }
  }
}
class RequisitionPage extends StatefulWidget {
  const RequisitionPage({super.key});
  @override
  State<RequisitionPage> createState() => _RequisitionPageState();
}

class _RequisitionPageState extends State<RequisitionPage> with AutomaticKeepAliveClientMixin {
  List<Map> _reqs = [];
  bool _loading = true;
  String _err = "";

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  static DateTime _lastPull = DateTime(2000); // 账本拉取节流：超5分钟才向服务器合并

  Future<void> _load() async {
    setState(() { _loading = true; _err = ""; });
    // 物料员本机没有采集/登记数据：先与电脑账本增量合并，建单选件才有库存与货位
    if (Auth.user?.role == 'material' &&
        DateTime.now().difference(_lastPull) > const Duration(minutes: 5)) {
      _lastPull = DateTime.now();
      await ledgerPullMerge();
    }
    final r = await AuthApi.reqList();
    if (!mounted) return;
    if (r["ok"] == true) {
      final list = List<Map>.from(r["reqs"] ?? []);
      RequisitionCache.saveIssued(list); // 刷新已发料标签缓存（库存联动）
      setState(() { _reqs = list; _loading = false; });
    } else {
      setState(() { _loading = false; _err = (r["msg"] ?? "加载失败").toString(); });
    }
  }

  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.red : Colors.green));
  }

  Color _statusColor(String s) => switch (s) {
    'pending' => Colors.orange, 'accepted' => Colors.blue, 'ready' => Colors.teal,
    'done' => Colors.green, 'rejected' || 'cancelled' => Colors.grey, _ => Colors.grey,
  };

  Future<void> _create() async {
    // 从库存选零件号下单：多行 items
    final agg = await computeStock();
    if (!mounted) return;
    final parts = agg.parts.values.where((p) => p.inStockQty > 0).toList()..sort((a, b) => a.partNo.compareTo(b.partNo));
    if (parts.isEmpty) { _toast("当前库存为空，无法下单"); return; }
    final res = await showModalBottomSheet<Map<String, dynamic>>(
      context: context, isScrollControlled: true,
      builder: (ctx) => _ReqCreateSheet(parts: parts));
    if (res == null || !mounted) return;
    final r = await AuthApi.reqCreate(res["items"] as List<Map>, res["remark"]?.toString() ?? "",
        assigneeId: res["assigneeId"]?.toString() ?? "");
    if (!mounted) return;
    if (r["ok"] == true) {
      final aName = res["assigneeName"]?.toString() ?? "";
      _toast(aName.isNotEmpty ? "领料单已提交：${r["req"]["no"]}，已指定 ${aName} 备料（30分钟未接自动放开）" : "领料单已提交：${r["req"]["no"]}", err: false);
      _load();
    }
    else _toast((r["msg"] ?? "提交失败").toString());
  }

  Future<void> _detail(Map rq) async {
    final changed = await showModalBottomSheet<bool>(
      context: context, isScrollControlled: true,
      builder: (ctx) => _ReqDetailSheet(rq: rq, toast: _toast, statusColor: _statusColor));
    if (changed == true) _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    // 入口门禁：物料员看领料开关；仓管/管理员可进（接单发料由服务端按角色强制）
    final role = Auth.user?.role ?? "";
    if (!Auth.can("requisition") && !Auth.can("receive_confirm") && role != "warehouse" && role != "admin") {
      return const Center(child: Text("当前角色未开通领料功能，请联系管理员", style: TextStyle(color: Colors.grey)));
    }
    final canOrder = Auth.can("requisition");
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        title: const Text("领料单"), toolbarHeight: 44,
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)],
      ),
      floatingActionButton: canOrder ? FloatingActionButton.extended(
        onPressed: _create, backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white,
        icon: const Icon(Icons.add), label: const Text("新建领料单"),
      ) : null,
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _err.isNotEmpty
              ? Center(child: Text(_err, style: const TextStyle(color: Colors.red)))
              : _reqs.isEmpty
                  ? const Center(child: Text("暂无领料单", style: TextStyle(color: Colors.grey)))
                  : RefreshIndicator(onRefresh: _load, child: ListView.builder(
                      padding: const EdgeInsets.fromLTRB(10, 8, 10, 90),
                      itemCount: _reqs.length,
                      itemBuilder: (ctx, i) {
                        final r = _reqs[i];
                        final items = List<Map>.from(r["items"] ?? []);
                        final st = r["status"].toString();
                        final itemsText = items.map((e) => "${e["partNo"]}×${e["qty"]}").join("、");
                        final aName = r["assigneeName"]?.toString() ?? "";
                        final aOpen = (r["assignOpenAt"] ?? "").toString().isNotEmpty;
                        final assignTxt = aName.isEmpty ? "" : (st == 'pending' && aOpen ? "\n📌 已指定 $aName" : (st == 'pending' ? "\n（原指定 $aName 超时放开）" : ""));
                        return Card(
                          margin: const EdgeInsets.symmetric(vertical: 5),
                          child: ListTile(
                            leading: CircleAvatar(backgroundColor: _statusColor(st).withOpacity(0.14),
                              child: Icon(_stIcon(st), color: _statusColor(st), size: 22)),
                            title: Text("${r["no"]}  ${r["byName"]}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                            subtitle: Text("$itemsText\n${(r["createdAt"] ?? "").toString().substring(0, 16).replaceFirst("T", " ")}${(r["remark"]?.toString().isNotEmpty ?? false) ? " · ${r["remark"]}" : ""}$assignTxt", style: const TextStyle(fontSize: 12)),
                            isThreeLine: true,
                            trailing: Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                              decoration: BoxDecoration(color: _statusColor(st).withOpacity(0.12), borderRadius: BorderRadius.circular(6)),
                              child: Text(r["statusText"]?.toString() ?? st, style: TextStyle(fontSize: 11, color: _statusColor(st)))),
                            onTap: () => _detail(r),
                          ),
                        );
                      },
                    )),
    );
  }
}

IconData _stIcon(String s) => switch (s) {
  'pending' => Icons.hourglass_top, 'accepted' => Icons.local_shipping_outlined,
  'ready' => Icons.inventory, 'done' => Icons.check_circle_outline,
  _ => Icons.cancel_outlined,
};

// ---------- 新建领料单弹层：从库存选零件号+数量，可多行 ----------
class _ReqCreateSheet extends StatefulWidget {
  final List<_StockPartRow> parts;
  const _ReqCreateSheet({required this.parts});
  @override
  State<_ReqCreateSheet> createState() => _ReqCreateSheetState();
}
class _ReqCreateSheetState extends State<_ReqCreateSheet> {
  final Map<String, TextEditingController> _qtyCtrl = {}; // partNo -> qty 输入控制器
  final _remarkCtrl = TextEditingController();
  String _search = "";
  List<Map> _warehouses = []; // 可选仓管员（指定备料）
  String _assigneeId = "";

  @override
  void initState() {
    super.initState();
    AuthApi.reqWarehouseUsers().then((r) {
      if (!mounted) return;
      if (r["ok"] == true) {
        final list = List<Map>.from(r["users"] ?? []);
        final last = r["lastAssigneeId"]?.toString() ?? ""; // 上次指定过的人，默认沿用
        setState(() {
          _warehouses = list;
          if (last.isNotEmpty && list.any((w) => w["id"] == last)) _assigneeId = last;
        });
      }
    });
  }

  @override
  void dispose() {
    for (final c in _qtyCtrl.values) { c.dispose(); }
    _remarkCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    var list = widget.parts;
    if (_search.trim().isNotEmpty) {
      final k = _search.trim().toLowerCase();
      list = list.where((p) => p.partNo.toLowerCase().contains(k) || p.itemName.toLowerCase().contains(k)).toList();
    }
    final chosen = _qtyCtrl.entries.where((e) => (int.tryParse(e.value.text.trim()) ?? 0) > 0).toList();
    return Padding(
      padding: EdgeInsets.fromLTRB(14, 10, 14, MediaQuery.of(context).viewInsets.bottom + 14),
      child: SizedBox(height: MediaQuery.of(context).size.height * 0.72, child: Column(children: [
        const Text("新建领料单（从库存选择）", style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        TextField(
          onChanged: (v) => setState(() => _search = v),
          decoration: const InputDecoration(hintText: "搜索零件号/物料名", isDense: true, prefixIcon: Icon(Icons.search, size: 20), border: OutlineInputBorder()),
        ),
        if (_warehouses.isNotEmpty) ...[
          const SizedBox(height: 6),
          InkWell(
            onTap: () => showModalBottomSheet(context: context, builder: (mctx) => SafeArea(child: ListView(
              shrinkWrap: true, children: [
                ListTile(title: const Text("不指定（全部仓管可见抢单）"), trailing: _assigneeId.isEmpty ? const Icon(Icons.check, color: Colors.teal) : null,
                  onTap: () { setState(() => _assigneeId = ""); Navigator.pop(mctx); }),
                ..._warehouses.map((w) => ListTile(
                  leading: CircleAvatar(radius: 14, child: Text((w["name"] ?? "?").toString().substring(0, 1), style: const TextStyle(fontSize: 12))),
                  title: Text(w["name"]?.toString() ?? ""),
                  trailing: _assigneeId == w["id"] ? const Icon(Icons.check, color: Colors.teal) : null,
                  onTap: () { setState(() => _assigneeId = w["id"].toString()); Navigator.pop(mctx); },
                )),
              ]))),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 2),
              child: Row(children: [
                const Icon(Icons.person_add_alt, size: 18, color: Color(0xFF3949AB)),
                const SizedBox(width: 6),
                Text("指定仓管员：", style: const TextStyle(fontSize: 13)),
                Text(_assigneeId.isEmpty ? "不指定（谁接都可以）" : (_warehouses.firstWhere((w) => w["id"] == _assigneeId)["name"]?.toString() ?? ""),
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _assigneeId.isEmpty ? Colors.grey : const Color(0xFF3949AB))),
                const Spacer(),
                const Icon(Icons.expand_more, size: 18, color: Colors.grey),
              ]),
            ),
          ),
        ],
        const SizedBox(height: 8),
        Expanded(child: ListView(children: [
          ...list.map((p) => ListTile(
            dense: true,
            title: Text("${p.partNo}  ${p.itemName}", style: const TextStyle(fontSize: 13)),
            subtitle: Text("在库 ${p.inBoxes} 框 · ${_fmtInvNum(p.inStockQty)}", style: const TextStyle(fontSize: 11)),
            trailing: SizedBox(width: 90, child: TextField(
              controller: _qtyCtrl.putIfAbsent(p.partNo, () => TextEditingController()),
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(hintText: "数量", isDense: true, border: OutlineInputBorder()),
              onChanged: (_) => setState(() {}),
            )),
          )),
        ])),
        const SizedBox(height: 6),
        TextField(
          controller: _remarkCtrl,
          decoration: const InputDecoration(hintText: "备注（用途/产线，可选）", isDense: true, border: OutlineInputBorder()),
        ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context), child: const Text("取消"))),
          const SizedBox(width: 10),
          Expanded(flex: 2, child: ElevatedButton(
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
            onPressed: chosen.isEmpty ? null : () {
              final items = chosen.map((e) {
                final p = widget.parts.firstWhere((x) => x.partNo == e.key);
                return {"partNo": p.partNo, "itemName": p.itemName, "qty": int.parse(e.value.text.trim())};
              }).toList();
              Navigator.pop(context, {"items": items, "remark": _remarkCtrl.text.trim(),
                "assigneeId": _assigneeId,
                "assigneeName": _assigneeId.isEmpty ? "" : (_warehouses.firstWhere((w) => w["id"] == _assigneeId)["name"]?.toString() ?? "")});
            },
            child: Text(chosen.isEmpty ? "请至少填一行数量" : "提交（${chosen.length} 行）"),
          )),
        ]),
      ])),
    );
  }
}

// ---------- 领料单详情弹层：状态动作 + 扫码发料 ----------
class _ReqDetailSheet extends StatefulWidget {
  final Map rq;
  final void Function(String, {bool err}) toast;
  final Color Function(String) statusColor;
  const _ReqDetailSheet({required this.rq, required this.toast, required this.statusColor});
  @override
  State<_ReqDetailSheet> createState() => _ReqDetailSheetState();
}
class _ReqDetailSheetState extends State<_ReqDetailSheet> {
  late Map _r;
  final _scanCtrl = TextEditingController();
  final _scanFocus = FocusNode();
  final _locCtrl = TextEditingController();
  final _locFocus = FocusNode();
  bool _busy = false;
  String? _issuePart; // 当前发料目标零件号：选定后扫码框连续发料
  Map<String, String> _to = {}; // 转入货位（本单所有行转同一目标位）
  bool _checkSap = false; // 转MES时是否开启SAP库存校验
  final Map<String, Map<String, dynamic>> _boxData = {}; // 标签 -> 转单所需MES数据
  Map<String, dynamic>? _lastBoxData; // 本次扫码抓到的MES数据

  @override
  void initState() {
    super.initState();
    _r = Map.from(widget.rq);
    final tl = _r["toLoc"];
    if (tl is Map) _to = tl.map((k, v) => MapEntry(k.toString(), v?.toString() ?? ""));
    if ((_to["LOC_CODE"] ?? "").isEmpty) _to = {};
    if (_to.isEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _to.isEmpty) _locFocus.requestFocus();
      });
    } else {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _to.isNotEmpty) _scanFocus.requestFocus();
      });
    }
  }
  @override
  void dispose() { _scanCtrl.dispose(); _scanFocus.dispose(); _locCtrl.dispose(); _locFocus.dispose(); super.dispose(); }

  Future<void> _act(String action, [Map? body]) async {
    if (_busy) return;
    setState(() => _busy = true);
    final res = await AuthApi.reqAction(_r["id"].toString(), action, body);
    if (!mounted) return;
    setState(() => _busy = false);
    if (res["ok"] == true) {
      setState(() => _r = Map.from(res["req"]));
      widget.toast("操作成功：${_r["statusText"]}", err: false);
    } else {
      widget.toast((res["msg"] ?? "操作失败").toString());
    }
  }

  /// 已发件数（兼容旧格式：纯字符串标签按0件计，仅提示不再自动满）
  double _issuedQtyOf(Map item) {
    double s = 0;
    for (final x in List.from(item["issued"] ?? [])) {
      if (x is Map) s += (x["q"] as num?)?.toDouble() ?? 0;
    }
    return s;
  }
  List<String> _issuedCodesOf(Map item) {
    return List.from(item["issued"] ?? []).map((x) => x is Map ? (x["c"]?.toString() ?? "") : x.toString()).toList();
  }

  /// 建议框点击：NB02 货架位 → 弹叫AGV出库窗（人工选站台），成功后登记"已叫AGV"；地面/其他 → 复制标签去扫码
  void _onSuggestTap(String code, String loc, String ftype, String partNo) async {
    if (loc.startsWith('NB02-') && !loc.contains('-CK-')) {
      final stn = await showDialog<String>(context: context,
        builder: (_) => AgvCallDialog(fromLoc: loc, containerType: ftype, label: code, toast: widget.toast));
      if (stn == null || !mounted) return;
      final res = await AuthApi.reqAction(_r["id"].toString(), "agv", {"partNo": partNo, "barcode": code, "station": stn});
      if (!mounted) return;
      if (res["ok"] == true) setState(() => _r = Map.from(res["req"]));
      else widget.toast("已叫车，但登记失败：${res["msg"]}"); // 不影响AGV任务本身
      return;
    }
    Clipboard.setData(ClipboardData(text: code));
    widget.toast("已复制 $code，拿去扫码发料", err: false);
  }

  /// 取货建议（服务器 reqView 每行附 suggest：boxes=框级[同托多码合并]，flatBoxes=标签级供逐码复制）
  Widget _buildSuggest(Map item, bool finished) {
    if (finished) return const SizedBox.shrink();
    final sg = item["suggest"];
    if (sg is! Map) return const SizedBox.shrink();
    final boxes = List<Map>.from(sg["boxes"] ?? []);
    final flat = List<Map>.from(sg["flatBoxes"] ?? sg["boxes"] ?? []); // 兼容旧服务器：无 flatBoxes 时退回标签级
    final total = (sg["total"] as num?)?.toDouble() ?? 0;
    final inStock = (sg["inStock"] as num?)?.toInt() ?? 0;
    final noInfo = (sg["noInfoQty"] as num?)?.toInt() ?? 0;
    if (flat.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(inStock == 0
            ? (noInfo > 0 ? "⚠ 账本有 $noInfo 框但缺物料信息，PDA「位置登记」批量补齐后可出建议" : "⚠ 同步账本中没有该零件的在架框（可能未同步或无货，可跳过）")
            : "⚠ 账本有 ${inStock + noInfo} 框但都缺件数信息，建议先补齐",
            style: const TextStyle(fontSize: 11, color: Colors.deepOrange)),
      );
    }
    // 同货位标签总数（>1 即同托多码），用于 chip 上标注"同托多码"
    final perBoxCodes = <String, int>{};
    for (final b in boxes) {
      final lk = b["l"]?.toString() ?? "";
      perBoxCodes[lk] = (perBoxCodes[lk] ?? 0) + ((b["codes"] as List?)?.length ?? 1);
    }
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(color: const Color(0xFFF0F4FF), borderRadius: BorderRadius.circular(8)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text("💡 取货建议（FIFO）：在架 $inStock 框，建议 ${boxes.length} 框 ≈ ${_fmtInvNum(total)} 件 · 点货架框叫AGV / 点地面标签复制",
            style: const TextStyle(fontSize: 11, color: Color(0xFF3949AB), fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        Wrap(spacing: 6, runSpacing: 4, children: [
          for (final b in flat)
            Builder(builder: (bc) {
              final code = b["c"]?.toString() ?? "";
              final loc = b["l"]?.toString() ?? "";
              final lot = (b["b"]?.toString() ?? "").split(" ").first;
              final qv = (b["q"] as num?)?.toDouble() ?? 0;
              final multi = (perBoxCodes[loc] ?? 1) > 1;
              final agv = (b["agv"] ?? "").toString();
              return InkWell(
                onTap: () => _onSuggestTap(code, loc, (b["f"] ?? "").toString(), item["partNo"]?.toString() ?? ""),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: agv.isEmpty ? Colors.white : const Color(0xFFFFF3E0),
                    border: Border.all(color: agv.isEmpty ? const Color(0xFFC7CDF0) : const Color(0xFFE65100)),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text("${agv.isEmpty ? "" : "🚗$agv · "}$code @ $loc${qv > 0 ? " ${_fmtInvNum(qv)}件" : ""}${lot.isNotEmpty ? " 批$lot" : ""}${multi ? " ·同托多码" : ""}",
                      style: TextStyle(fontSize: 11, fontFamily: "monospace", color: agv.isEmpty ? const Color(0xFF1A237E) : const Color(0xFFE65100))),
                ),
              );
            }),
        ]),
        if (noInfo > 0) Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text("另有 $noInfo 框缺件数/批次（未补齐），建议按货位就近补拣", style: const TextStyle(fontSize: 10.5, color: Colors.brown)),
        ),
      ]),
    );
  }

  /// 扫码框提交：查 MES 取该箱件数，按件数计入目标零件行；发满自动切下一行
  Future<void> _scanIssue() async {
    final code = _scanCtrl.text.trim();
    _scanCtrl.clear();
    if (code.isEmpty) return;
    if (_busy) return;
    final items = List<Map>.from(_r["items"] ?? []);
    var target = items.firstWhere((e) => e["partNo"] == _issuePart, orElse: () => const {});
    if (target.isEmpty) { widget.toast("请先点击选择要发料的零件行"); _refocusScan(); return; }
    if (_issuedCodesOf(target).contains(code)) { widget.toast("标签 $code 已扫过"); _refocusScan(); return; }
    setState(() => _busy = true);
    String? scanErr;
    double boxQty = 0;
    _lastBoxData = null;
    try {
      // 查 MES 拿该箱件数与零件号（复用采集页查询通道：失效自动重登）
      final mes = await mesQueryLabel(code);
      if (mes["ok"] != true) {
        scanErr = "标签 $code MES查询失败：${mes["msg"]}";
      } else {
        final mp = mes["partNo"]?.toString() ?? "";
        if (mp != target["partNo"]) { scanErr = "该箱零件号 $mp 与所选行 ${target["partNo"]} 不符"; }
        boxQty = (mes["qty"] as num?)?.toDouble() ?? 0;
        // 抓转MES所需完整标签数据（物料ID/编码/名称/UOM）；失败不阻塞发料记账，转单时再补查
        try {
          final d = await mesGetData("/api/v1/rawtransfer/GetBarCodeInfoOnHand", {
            "barcode": code,
            "warehouseCode": _to["WAREHOUSE_CODE"] ?? "",
            "districtCode": _to["DISTRICT_CODE"] ?? "",
            "locCode": _to["LOC_CODE"] ?? "",
          });
          if (d != null) _lastBoxData = Map<String, dynamic>.from(d);
        } catch (_) {}
      }
    } catch (e) {
      scanErr = "查询异常：$e";
    }
    if (scanErr != null) {
      if (!mounted) return;
      setState(() => _busy = false);
      widget.toast(scanErr);
      _refocusScan();
      return;
    }
    final ledOld = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(code.toUpperCase()).findAll();
    final fromLoc = ledOld.isNotEmpty ? ledOld.first.loc : "";
    final res = await AuthApi.reqAction(_r["id"].toString(), "scan", {"barcode": code, "partNo": target["partNo"], "qty": boxQty, "fromLoc": fromLoc});
    if (!mounted) return;
    setState(() => _busy = false);
    if (res["ok"] != true) { widget.toast((res["msg"] ?? "发料失败").toString()); _refocusScan(); return; }
    setState(() {
      _r = Map.from(res["req"]);
      _boxData[code] = _lastBoxData ?? {}; // 缓存该箱 MES 数据供转单组报文
    });
    final items2 = List<Map>.from(_r["items"] ?? []);
    final nowT = items2.firstWhere((e) => e["partNo"] == _issuePart, orElse: () => const {});
    final tGot = nowT.isEmpty ? 0.0 : _issuedQtyOf(nowT);
    final tNeed = (nowT["qty"] as num?)?.toDouble() ?? 0.0;
    widget.toast("已发 $code（$boxQty 件）累计 ${_fmtInvNum(tGot)}/${_fmtInvNum(tNeed)}${fromLoc.isNotEmpty ? " · 原$fromLoc 已拣下" : ""}", err: false);
    if (fromLoc.isNotEmpty) ledgerRemoveBoxAndPush(code.toUpperCase()); //发料扫码即整框拣下（同托兄弟码一并消位）
    if (tGot >= tNeed) {
      final next = items2.firstWhere((e) => _issuedQtyOf(e) < ((e["qty"] as num?)?.toDouble() ?? 0), orElse: () => const {});
      if (!next.isEmpty) setState(() => _issuePart = next["partNo"].toString());
    }
    _refocusScan();
  }

  void _refocusScan() {
    _scanFocus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _scanFocus.requestFocus(); });
  }

  /// 行级转MES：把该行已扫箱真实直调转单（申请600实扫500也照转500），成功后回写服务器+落出库台账
  Future<void> _transferRow(Map item) async {
    if (_busy) return;
    final partNo = item["partNo"].toString();
    final codes = _issuedCodesOf(item);
    if (codes.isEmpty) { widget.toast("该行还没有扫入标签"); return; }
    if (_to.isEmpty) { widget.toast("请先扫描转入货位"); return; }
    final yes = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
      title: const Text("转 MES 出库"),
      content: Text("零件号 $partNo\n将把已扫的 ${codes.length} 箱（${_fmtInvNum(_issuedQtyOf(item))} 件）真实转单到：\n${_to["WAREHOUSE_NAME"]}/${_to["DISTRICT_NAME"]}/${_to["LOC_NAME"]}\n\n转单即 MES 移库，不可撤销（退回需反向再转）。确认提交？"),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("确认转单"))],
    ));
    if (yes != true || !mounted) return;
    setState(() => _busy = true);
    try {
      // 1. 组报文：逐箱补齐 MES 数据（缓存缺失的现场补查一次）
      final boxes = <Map<String, dynamic>>[];
      for (final c in codes) {
        var d = _boxData[c];
        if (d == null || (d["MITEM_ID"] ?? "").toString().isEmpty) {
          final fresh = await mesGetData("/api/v1/rawtransfer/GetBarCodeInfoOnHand", {
            "barcode": c,
            "warehouseCode": _to["WAREHOUSE_CODE"] ?? "",
            "districtCode": _to["DISTRICT_CODE"] ?? "",
            "locCode": _to["LOC_CODE"] ?? "",
          });
          if (fresh == null) throw Exception("标签 $c 查不到 MES 在库信息，无法转单");
          d = Map<String, dynamic>.from(fresh);
          _boxData[c] = d;
        }
        d["SCAN_BARCODE"] = d["SCAN_BARCODE"] ?? c; // 兜底：台账条码=扫入标签号
        boxes.add(d);
      }
      // 2. 按零件号聚合成 SaveTRBarcodes 明细（与直调页同口径）
      final rows = <Map<String, dynamic>>[];
      for (final d in boxes) {
        final idx = rows.indexWhere((r) => r["MITEM_CODE"] == d["MITEM_CODE"]);
        final q = (d["QTY"] as num?)?.toDouble() ?? 0;
        if (idx >= 0) {
          rows[idx]["REQ_QTY"] = (rows[idx]["REQ_QTY"] as double) + q;
          (rows[idx]["Barcodes"] as List).add(d);
        } else {
          rows.add({
            "MITEM_ID": d["MITEM_ID"], "MITEM_CODE": d["MITEM_CODE"],
            "MITEM_NAME": d["MITEM_DESC"] ?? d["MITEM_NAME"] ?? "",
            "UOM": d["UOM"] ?? "", "REQ_QTY": q, "Barcodes": [d],
          });
        }
      }
      final details = rows.map((r) {
        final m = Map<String, dynamic>.from(r);
        m["TO_WAREHOUSE_CODE"] = _to["WAREHOUSE_CODE"];
        m["TO_DISTRICT_CODE"] = _to["DISTRICT_CODE"];
        m["TO_LOC_CODE"] = _to["LOC_CODE"];
        m["isCheckSap"] = _checkSap;
        return m;
      }).toList();
      await mesReq("POST", "/api/v1/rawtransfer/SaveTRBarcodes", body: {"details": details});
      // 3. 回写服务器行级 transferred（幂等），并落出库台账关联领料单号
      final res = await AuthApi.reqAction(_r["id"].toString(), "transfer", {"partNo": partNo});
      if (res["ok"] != true) throw Exception("MES已转单，但服务器回写失败：${res["msg"]}（请重开该单重试，MES侧勿重复转）");
      try {
        final fromLocs = <String, String>{};
        for (final x in List.from(item["issued"] ?? [])) {
          if (x is Map) {
            final c0 = x["c"]?.toString().toUpperCase() ?? "";
            final l0 = x["l"]?.toString() ?? "";
            if (c0.isNotEmpty && l0.isNotEmpty) fromLocs[c0] = l0;
          }
        }
        final ob = await createOutboundOrder(
          rows.map((r) => {...r, "PART_NO": partNo}).toList(), _to, linkReqNo: _r["no"].toString(), fromLocs: fromLocs);
        widget.toast("已转MES（${_fmtInvNum(_issuedQtyOf(item))}件），出库单 ${ob.orderNo}", err: false);
      } catch (_) {
        widget.toast("已转MES，出库台账落库失败（不影响转单）", err: false);
      }
      setState(() {
        _r = Map.from(res["req"]);
        _issuePart = null;
      });
    } catch (e) {
      widget.toast("转单失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 行级跳过：仓库无货，0件转单
  Future<void> _skipRow(Map item) async {
    if (_busy) return;
    final reason = await _askReason("跳过原因（如：无库存，待补货另开单）");
    if (reason == null) return;
    await _act("skip", {"partNo": item["partNo"].toString(), "reason": reason});
  }

  /// 扫转入货位（复用直调同款接口）
  Future<void> _scanLoc() async {
    final code = _locCtrl.text.trim();
    _locCtrl.clear();
    if (code.isEmpty) { _refocusLoc(); return; }
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final d = await mesGetData("/api/v1/invwarehousetransfer/getwarehousemodelinfo", {"loccode": code});
      if (d == null) { widget.toast("货位查询无信息：$code"); return; }
      final to = {
        "WAREHOUSE_CODE": d["WAREHOUSE_CODE"]?.toString() ?? "",
        "WAREHOUSE_NAME": d["WAREHOUSE_NAME"]?.toString() ?? "",
        "DISTRICT_CODE": d["DISTRICT_CODE"]?.toString() ?? "",
        "DISTRICT_NAME": d["DISTRICT_NAME"]?.toString() ?? "",
        "LOC_CODE": d["LOC_CODE"]?.toString() ?? "",
        "LOC_NAME": d["LOC_NAME"]?.toString() ?? "",
      };
      final res = await AuthApi.reqSetLoc(_r["id"].toString(), to);
      if (res["ok"] != true) { widget.toast("货位设置失败：${res["msg"]}"); return; }
      setState(() { _to = to; _r = Map.from(res["req"]); });
      widget.toast("转入货位已设置：${to["LOC_NAME"]}", err: false);
      _refocusScan(); // 修复：货位设好后光标交给发料框，扫码枪可直接连续发料
    } catch (e) {
      widget.toast("货位查询失败：${e.toString().replaceFirst("Exception: ", "")}");
      _refocusLoc(); // 失败后光标回到货位框，可直接重扫
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _refocusLoc() {
    _locFocus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _locFocus.requestFocus(); });
  }

  /// 管理员转派/指定：选择目标仓管员（服务器会重置30分钟窗口）
  Future<void> _reassign() async {
    final curId = _r["assigneeId"]?.toString() ?? "";
    final r = await AuthApi.reqWarehouseUsers();
    if (!mounted) return;
    if (r["ok"] != true) { widget.toast("获取仓管员列表失败：${r["msg"]}"); return; }
    final users = List<Map>.from(r["users"] ?? []).where((w) => w["id"] != curId).toList();
    if (users.isEmpty) { widget.toast(curId.isEmpty ? "没有可指定的仓管员" : "没有其他可转派的仓管员"); return; }
    final picked = await showModalBottomSheet<String>(
      context: context,
      builder: (mctx) => SafeArea(child: ListView(
        shrinkWrap: true, padding: const EdgeInsets.symmetric(vertical: 8), children: [
          Padding(padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
            child: Text(curId.isEmpty ? "指定仓管员备料" : "转派给其他仓管员", style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold))),
          ...users.map((w) => ListTile(
            leading: CircleAvatar(radius: 15, child: Text((w["name"] ?? "?").toString().substring(0, 1), style: const TextStyle(fontSize: 13))),
            title: Text(w["name"]?.toString() ?? ""),
            onTap: () => Navigator.pop(mctx, w["id"].toString()),
          )),
        ])));
    if (picked == null || !mounted) return;
    await _act("reassign", {"assigneeId": picked});
  }

  @override
  Widget build(BuildContext context) {
    final st = _r["status"].toString();
    final isWh = Auth.user?.role == 'warehouse' || Auth.user?.role == 'admin';
    final isOwner = _r["by"] == Auth.user?.id;
    // 指定仓管员：pending 且锁定期内、非指定人非管理员 → 接单/拒单锁定
    final aId = _r["assigneeId"]?.toString() ?? "";
    final aName = _r["assigneeName"]?.toString() ?? "";
    final aOpenStr = _r["assignOpenAt"]?.toString() ?? "";
    final aLocked = aId.isNotEmpty && aOpenStr.isNotEmpty &&
        DateTime.tryParse(aOpenStr)?.isAfter(DateTime.now()) == true;
    final assignBlocked = st == 'pending' && isWh && aLocked && Auth.user?.id != aId && !Auth.isAdmin;
    final items = List<Map>.from(_r["items"] ?? []);
    final history = List<Map>.from(_r["history"] ?? []);
    return Padding(
      padding: EdgeInsets.fromLTRB(14, 10, 14, MediaQuery.of(context).viewInsets.bottom + 14),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.75,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text("${_r["no"]}  ${_r["byName"]}", style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold))),
            Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(color: widget.statusColor(st).withOpacity(0.12), borderRadius: BorderRadius.circular(6)),
              child: Text(_r["statusText"]?.toString() ?? st, style: TextStyle(fontSize: 12, color: widget.statusColor(st)))),
          ]),
          if ((_r["remark"]?.toString().isNotEmpty ?? false)) Text("备注：${_r["remark"]}", style: const TextStyle(fontSize: 12, color: Colors.grey)),
          if ((_r["shortInfo"]?.toString().isNotEmpty ?? false)) Container(
            margin: const EdgeInsets.only(top: 4), padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(color: Colors.deepOrange.shade50, borderRadius: BorderRadius.circular(6)),
            child: Text("⚠ 短装：${_r["shortInfo"]}", style: const TextStyle(fontSize: 12, color: Colors.deepOrange)),
          ),
          // 打印领料单：复制打印页链接，电脑浏览器打开 Ctrl+P
          Align(alignment: Alignment.centerLeft, child: TextButton.icon(
            style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 4)),
            onPressed: () async {
              final server = await AuthStore.serverUrl();
              final url = "$server/print/requisition?id=${_r["id"]}";
              await Clipboard.setData(ClipboardData(text: url));
              if (!mounted) return;
              showDialog(context: context, builder: (dctx) => AlertDialog(
                title: const Text("打印链接已复制"),
                content: Text("在连接打印机的电脑浏览器打开：\n\n$url\n\n页面内点「打印本单」或按 Ctrl+P。零件号可鼠标选中复制，纸上有货位/实发空栏供手写。", style: const TextStyle(fontSize: 13)),
                actions: [TextButton(onPressed: () => Navigator.pop(dctx), child: const Text("知道了"))],
              ));
            },
            icon: const Icon(Icons.print_outlined, size: 18), label: const Text("打印领料单（复制链接到电脑）", style: TextStyle(fontSize: 13)),
          )),
          const SizedBox(height: 8),
          // 发料扫码框（备料中且是仓管）
          if (st == 'accepted' && isWh) ...[
            if (_to.isEmpty)
              Row(children: [
                Expanded(child: TextField(
                  controller: _locCtrl, focusNode: _locFocus,
                  decoration: const InputDecoration(hintText: "先扫转入货位（产线/接驳位）", isDense: true, prefixIcon: Icon(Icons.place_outlined, size: 20), border: OutlineInputBorder()),
                  onSubmitted: (_) => _scanLoc(),
                )),
                const SizedBox(width: 8),
                SizedBox(width: 72, child: ElevatedButton(onPressed: _busy ? null : _scanLoc, child: const Text("设定"))),
              ])
            else
              Row(children: [
                Expanded(child: Text("转入：${_to["WAREHOUSE_NAME"]}/${_to["DISTRICT_NAME"]}/${_to["LOC_NAME"]}（${_to["LOC_CODE"]}）",
                  style: const TextStyle(fontSize: 12, color: Color(0xFF3F51B5))),),
                TextButton(onPressed: _busy ? null : () { setState(() => _to = {}); _refocusLoc(); }, child: const Text("改货位", style: TextStyle(fontSize: 12))),
              ]),
            SwitchListTile(
              dense: true, contentPadding: EdgeInsets.zero,
              title: const Text("开启SAP库存校验", style: TextStyle(fontSize: 13)),
              value: _checkSap, onChanged: (v) => setState(() => _checkSap = v),
            ),
            TextField(
              controller: _scanCtrl, focusNode: _scanFocus,
              // 修复：删除 autofocus，避免打开详情时抢走转入货位框的焦点导致扫货位无反应
              decoration: InputDecoration(
                hintText: _issuePart == null ? "先点击下方零件行选择发料目标，再连续扫码" : "连续扫码发料中：$_issuePart",
                isDense: true, prefixIcon: const Icon(Icons.qr_code_scanner, size: 20),
                border: OutlineInputBorder(borderSide: BorderSide(color: _issuePart == null ? Colors.grey.shade300 : Colors.teal)),
              ),
              onSubmitted: (_) => _scanIssue(),
            ),
            const SizedBox(height: 6),
          ],
          Expanded(child: ListView(children: [
            ...items.map((item) {
              final codes = _issuedCodesOf(item);
              final got = _issuedQtyOf(item);
              final qty = (item["qty"] as num?)?.toDouble() ?? 0;
              final done = got >= qty && qty > 0;
              final transferred = item["transferred"] == true;
              final skipped = item["skipped"] == true;
              final selected = _issuePart == item["partNo"].toString();
              final boxQs = Map<String, double>.fromEntries(
                List.from(item["issued"] ?? []).whereType<Map>().map((x) => MapEntry(x["c"]?.toString() ?? "", (x["q"] as num?)?.toDouble() ?? 0)));
              return Card(
                shape: selected ? RoundedRectangleBorder(side: const BorderSide(color: Colors.teal, width: 2), borderRadius: BorderRadius.circular(12)) : null,
                child: InkWell(
                  onTap: (st == 'accepted' && isWh && !done && !transferred && !skipped) ? () { setState(() => _issuePart = item["partNo"].toString()); _refocusScan(); } : null,
                  child: Padding(padding: const EdgeInsets.all(10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text("${item["partNo"]}  ${item["itemName"] ?? ""}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
                      if (transferred)
                        Text("已转 ${_fmtInvNum((item["transferQty"] as num?)?.toDouble() ?? got)} 件", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.green))
                      else if (skipped)
                        const Text("已跳过", style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: Colors.grey))
                      else
                        Text("已发 ${_fmtInvNum(got)}/${_fmtInvNum(qty)} 件", style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: done ? Colors.green : Colors.orange)),
                      if (selected) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.my_location, size: 16, color: Colors.teal)),
                    ]),
                    const SizedBox(height: 4),
                    Wrap(spacing: 6, runSpacing: 4, children: [
                      ...codes.map((c) => Chip(label: Text(boxQs[c] != null && boxQs[c]! > 0 ? "$c·${_fmtInvNum(boxQs[c]!)}" : c, style: const TextStyle(fontSize: 10, color: Colors.white)), backgroundColor: transferred ? Colors.green.shade700 : Colors.green, padding: EdgeInsets.zero, visualDensity: VisualDensity.compact)),
                    ]),
                    _buildSuggest(item, transferred || skipped),
                    if (st == 'accepted' && isWh && !transferred && !skipped) Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Row(children: [
                        Expanded(child: ElevatedButton.icon(
                          style: ElevatedButton.styleFrom(backgroundColor: Colors.teal, foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300, minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 8)),
                          onPressed: (_busy || got <= 0 || _to.isEmpty) ? null : () => _transferRow(item),
                          icon: const Icon(Icons.sync, size: 16),
                          label: Text(got <= 0 ? "转MES出库" : (got < qty ? "转 ${_fmtInvNum(got)} 件(短装)" : "转MES出库"), style: const TextStyle(fontSize: 12)),
                        )),
                        const SizedBox(width: 8),
                        Expanded(child: OutlinedButton.icon(
                          style: OutlinedButton.styleFrom(foregroundColor: Colors.grey.shade700, minimumSize: const Size(0, 36), padding: const EdgeInsets.symmetric(horizontal: 8)),
                          onPressed: _busy ? null : () => _skipRow(item),
                          icon: const Icon(Icons.skip_next, size: 16), label: const Text("无货跳过", style: TextStyle(fontSize: 12)),
                        )),
                      ]),
                    ),
                  ])),
                ),
              );
            }),
            if (history.isNotEmpty) ...[
              const SizedBox(height: 4),
              const Text("流转记录", style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
              ...history.map((h) => Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Text("${(h["time"] ?? "").toString().substring(5, 16).replaceFirst("T", " ")}  ${h["by"]}：${h["text"]}", style: const TextStyle(fontSize: 11, color: Colors.grey)),
              )),
            ],
          ])),
          const SizedBox(height: 8),
          // 底部动作条
          if (st == 'pending' && aLocked && aName.isNotEmpty) Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text("📌 本单已指定 $aName 备料${Auth.user?.id == aId ? "（就是你，请尽快接单）" : "，超时未接将放开给全部仓管"}",
              style: TextStyle(fontSize: 12, color: Auth.user?.id == aId ? Colors.deepOrange : const Color(0xFF3949AB))),
          ),
          Row(children: [
            if (st == 'pending' && Auth.isAdmin) ...[
              Expanded(child: OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF3949AB)),
                onPressed: _busy ? null : _reassign,
                icon: const Icon(Icons.swap_horiz, size: 16), label: Text(aName.isEmpty ? "指定" : "转派"))),
              const SizedBox(width: 8),
            ],
            if (st == 'pending' && isWh) ...[
              Expanded(child: OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                onPressed: (_busy || assignBlocked) ? null : () async {
                  final reason = await _askReason("拒单原因");
                  if (reason != null) await _act("reject", {"reason": reason});
                }, icon: const Icon(Icons.block, size: 16), label: const Text("拒单"))),
              const SizedBox(width: 8),
              Expanded(flex: 2, child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
                onPressed: (_busy || assignBlocked) ? null : () => _act("accept"),
                icon: const Icon(Icons.how_to_reg), label: Text(assignBlocked ? "已指定 $aName" : "接单备料"))),
            ],
            if ((st == 'pending' || st == 'accepted') && (isOwner || Auth.isAdmin))
              Expanded(child: OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                onPressed: _busy ? null : () => _act("cancel"), icon: const Icon(Icons.close, size: 16), label: const Text("取消订单"))),
            if (st == 'ready' && (isOwner || Auth.can("receive_confirm")))
              Expanded(flex: 2, child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(backgroundColor: Colors.green, foregroundColor: Colors.white),
                onPressed: _busy ? null : () async {
                  final yes = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
                    title: const Text("确认收货"), content: Text("确认已收到 ${_r["no"]} 的全部物料？"),
                    actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
                      TextButton(onPressed: () => Navigator.pop(dctx, true), child: const Text("确认收到"))]));
                  if (yes == true) await _act("confirm");
                }, icon: const Icon(Icons.done_all), label: const Text("确认收到货物"))),
            Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(context, st != _r["status"]), child: const Text("关闭"))),
          ]),
        ]),
      ),
    );
  }

  Future<String?> _askReason(String title) async {
    final ctrl = TextEditingController();
    final v = await showDialog<String>(context: context, builder: (dctx) => AlertDialog(
      title: Text(title),
      content: SizedBox(width: 280, child: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(border: OutlineInputBorder()))),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx), child: const Text("取消")),
        ElevatedButton(onPressed: () => Navigator.pop(dctx, ctrl.text.trim()), child: const Text("确定"))],
    ));
    ctrl.dispose();
    return v;
  }
}
