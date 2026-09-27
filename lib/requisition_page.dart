part of 'main.dart';

// ===================== 领料单（物料员下单/签收 · 仓管接单/扫码发料） =====================
// 状态机（服务端强制）：pending待接单 → accepted备料中 → ready已备齐 → done已完成
//                        pending → rejected已拒绝 / pending|accepted → cancelled已取消

/// 领料已发料标签本地缓存：每次拉取领料列表后刷新，库存计算据此剔除已发框（离线兜底）
class RequisitionCache {
  static const String _kIssued = "req_issued_barcodes";
  static Future<void> saveIssued(List<Map> reqs) async {
    final set = <String>{};
    const active = {'accepted', 'ready', 'done'}; // 仅这些状态的已发框算出库；取消/拒单退回库存
    for (final r in reqs) {
      if (!active.contains(r["status"])) continue;
      for (final it in List<Map>.from(r["items"] ?? [])) {
        for (final c in List.from(it["issued"] ?? [])) { set.add(c.toString()); }
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

  Future<void> _load() async {
    setState(() { _loading = true; _err = ""; });
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
    final r = await AuthApi.reqCreate(res["items"] as List<Map>, res["remark"]?.toString() ?? "");
    if (!mounted) return;
    if (r["ok"] == true) { _toast("领料单已提交：${r["req"]["no"]}", err: false); _load(); }
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
    if (!Auth.can("requisition") && !Auth.can("receive_confirm")) {
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
                        return Card(
                          margin: const EdgeInsets.symmetric(vertical: 5),
                          child: ListTile(
                            leading: CircleAvatar(backgroundColor: _statusColor(st).withOpacity(0.14),
                              child: Icon(_stIcon(st), color: _statusColor(st), size: 22)),
                            title: Text("${r["no"]}  ${r["byName"]}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600)),
                            subtitle: Text("$itemsText\n${(r["createdAt"] ?? "").toString().substring(0, 16).replaceFirst("T", " ")}${(r["remark"]?.toString().isNotEmpty ?? false) ? " · ${r["remark"]}" : ""}", style: const TextStyle(fontSize: 12)),
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
              Navigator.pop(context, {"items": items, "remark": _remarkCtrl.text.trim()});
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
  bool _busy = false;
  String? _issuePart; // 当前发料目标零件号：选定后扫码框连续发料

  @override
  void initState() { super.initState(); _r = Map.from(widget.rq); }
  @override
  void dispose() { _scanCtrl.dispose(); _scanFocus.dispose(); super.dispose(); }

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

  /// 扫码框提交：按当前目标零件号发一箱；扫满自动切到下一个未满行
  Future<void> _scanIssue() async {
    final code = _scanCtrl.text.trim();
    _scanCtrl.clear();
    if (code.isEmpty) return;
    final items = List<Map>.from(_r["items"] ?? []);
    var target = items.firstWhere((e) => e["partNo"] == _issuePart, orElse: () => const {});
    if (target.isEmpty) { widget.toast("请先点击选择要发料的零件行"); _refocusScan(); return; }
    final issued = List<String>.from((target["issued"] ?? []).map((e) => e.toString()));
    final qty = (target["qty"] as num?)?.toDouble() ?? 0;
    if (issued.length >= qty) {
      // 本行已满，自动切到下一个未满行
      final next = items.firstWhere((e) => (List.from(e["issued"] ?? []).length) < ((e["qty"] as num?)?.toDouble() ?? 0), orElse: () => const {});
      if (next.isEmpty) { _refocusScan(); return; }
      setState(() => _issuePart = next["partNo"].toString());
      target = next;
    }
    await _act("scan", {"barcode": code, "partNo": target["partNo"]});
    // 发完后若目标行已满，自动切换
    final nowTarget = items.firstWhere((e) => e["partNo"] == _issuePart, orElse: () => const {});
    if (!nowTarget.isEmpty && List.from(nowTarget["issued"] ?? []).length >= ((nowTarget["qty"] as num?)?.toDouble() ?? 0)) {
      final next = items.firstWhere((e) => (List.from(e["issued"] ?? []).length) < ((e["qty"] as num?)?.toDouble() ?? 0), orElse: () => const {});
      if (!next.isEmpty) setState(() => _issuePart = next["partNo"].toString());
    }
    _refocusScan();
  }

  void _refocusScan() {
    _scanFocus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) { if (mounted) _scanFocus.requestFocus(); });
  }

  @override
  Widget build(BuildContext context) {
    final st = _r["status"].toString();
    final isWh = Auth.user?.role == 'warehouse' || Auth.user?.role == 'admin';
    final isOwner = _r["by"] == Auth.user?.id;
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
          const SizedBox(height: 8),
          // 发料扫码框（备料中且是仓管）
          if (st == 'accepted' && isWh) ...[
            TextField(
              controller: _scanCtrl, focusNode: _scanFocus, autofocus: true,
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
              final issued = List<String>.from((item["issued"] ?? []).map((e) => e.toString()));
              final qty = (item["qty"] as num?)?.toDouble() ?? 0;
              final done = issued.length >= qty;
              final selected = _issuePart == item["partNo"].toString();
              return Card(
                shape: selected ? RoundedRectangleBorder(side: const BorderSide(color: Colors.teal, width: 2), borderRadius: BorderRadius.circular(12)) : null,
                child: InkWell(
                  onTap: (st == 'accepted' && isWh && !done) ? () { setState(() => _issuePart = item["partNo"].toString()); _refocusScan(); } : null,
                  child: Padding(padding: const EdgeInsets.all(10), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(child: Text("${item["partNo"]}  ${item["itemName"] ?? ""}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
                      Text("已发 ${issued.length}/$qty", style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: done ? Colors.green : Colors.orange)),
                      if (selected) const Padding(padding: EdgeInsets.only(left: 6), child: Icon(Icons.my_location, size: 16, color: Colors.teal)),
                    ]),
                    const SizedBox(height: 4),
                    Wrap(spacing: 6, runSpacing: 4, children: [
                      ...issued.map((c) => Chip(label: Text(c, style: const TextStyle(fontSize: 10, color: Colors.white)), backgroundColor: Colors.green, padding: EdgeInsets.zero, visualDensity: VisualDensity.compact)),
                    ]),
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
          Row(children: [
            if (st == 'pending' && isWh) ...[
              Expanded(child: OutlinedButton.icon(style: OutlinedButton.styleFrom(foregroundColor: Colors.red),
                onPressed: _busy ? null : () async {
                  final reason = await _askReason("拒单原因");
                  if (reason != null) await _act("reject", {"reason": reason});
                }, icon: const Icon(Icons.block, size: 16), label: const Text("拒单"))),
              const SizedBox(width: 8),
              Expanded(flex: 2, child: ElevatedButton.icon(
                style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
                onPressed: _busy ? null : () => _act("accept"), icon: const Icon(Icons.how_to_reg), label: const Text("接单备料"))),
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
