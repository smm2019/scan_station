part of 'main.dart';

// ===================== ㉖v179 我的预约来料（物料员独立页） =====================
// 为什么单独一页：预约功能本就存在（⑮预约来料），但入口在「库存页 → 我的预约」页签里，
//   而库存功能开关（inventory）对 material 角色默认关闭 → 物料员看得见"缺料"却进不去"预约"，
//   只能干等仓管。本页复用同一套服务端预约接口与同一个预约弹窗（bookingDlgOf），
//   功能与零件档案里的预约完全一致（预订筐数/期望到货/够数自动开领料单），只是换了入口与视角。
// ★ 候选零件数据源必须换：库存页 _knownParts 取本机 Isar（scanRecords/outboundOrders/
//   inventoryOpenings），物料员本机从没采集过这些 → 列表必然空白。本页候选一律走服务器口径：
//   ①全厂字典 /api/dict（含实时在架框数）②本人常领 /api/requisitions/frequent
//   ③本人未核销的缺料反馈 /api/shortages —— ③是真正的模块联动：喊过缺料=顺手建预约。
// 列表数据同样走服务器富化端点（watchlist GET 已带 stock/arrived/target/done/reqNo/overdue），
//   本机不存任何副本，换设备结果一致。

class WatchListPage extends StatefulWidget {
  const WatchListPage({super.key});
  @override
  State<WatchListPage> createState() => _WatchListPageState();
}

class _WatchListPageState extends State<WatchListPage> {
  List<Map> _items = [];
  bool _loading = true, _busy = false;
  String _err = "", _flt = ""; // ''=全部 todo=在途等货 done=已达成 late=已逾期

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted) setState(() { _loading = true; _err = ""; });
    final r = await AuthApi.watchlistGet();
    if (!mounted) return;
    if (r["ok"] == true) {
      final l = List<Map>.from(r["list"] ?? []);
      // 排序：逾期 → 有进度未完成 → 零进度未完成 → 已达成（等货最急的排前）
      l.sort((a, b) {
        final rank = (Map m) {
          if (m["overdue"] == true) return 0;
          if (m["done"] == true) return 3;
          return ((m["arrived"] as num?)?.toInt() ?? 0) > 0 ? 1 : 2;
        };
        final d = rank(a) - rank(b);
        return d != 0 ? d : (a["partNo"] ?? "").toString().compareTo((b["partNo"] ?? "").toString());
      });
      setState(() { _items = l; _loading = false; });
    } else {
      setState(() { _loading = false; _err = (r["msg"] ?? "加载失败").toString(); });
    }
  }

  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.red : Colors.green));
  }

  List<Map> get _shown {
    switch (_flt) {
      case "late": return _items.where((m) => m["overdue"] == true).toList();
      case "done": return _items.where((m) => m["done"] == true).toList();
      case "todo": return _items.where((m) => m["done"] != true).toList();
      default: return _items;
    }
  }

  /// 新增/改约：与零件档案预约同一弹窗（预订筐数 + 期望到货 + 够数自动开单）
  Future<void> _book(String pn, String nm, {int initQty = 0, String initDue = "", bool initAuto = true}) async {
    final cfg = await bookingDlgOf(context, pn, nm, initQty: initQty, initDue: initDue, initAuto: initAuto);
    if (cfg == null || !mounted) return;
    setState(() => _busy = true);
    final r = await AuthApi.watchlistSet(pn, true,
        qty: (cfg["qty"] as int?) ?? 0, itemName: nm, due: (cfg["due"] as String?) ?? "", auto: (cfg["auto"] as bool?) ?? true);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r["ok"] != true) { _toast("预约失败：${r["msg"]}"); return; }
    final q = (cfg["qty"] as int?) ?? 0;
    _toast(q > 0 ? "已预约 $pn 预订 $q 框，够数自动开领料单" : "已预约 $pn，到料时通知你", err: false);
    _load();
  }

  Future<void> _cancel(Map m) async {
    final pn = (m["partNo"] ?? "").toString();
    final go = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
            title: const Text("取消预约", style: TextStyle(fontSize: 15)),
            content: Text("取消对 $pn 的预约？\n\n取消后到料不再通知你，也不会自动开领料单。"),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c2, false), child: const Text("留着")),
              FilledButton(onPressed: () => Navigator.pop(c2, true), child: const Text("取消预约")),
            ]));
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    final r = await AuthApi.watchlistSet(pn, false);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r["ok"] != true) { _toast("取消失败：${r["msg"]}"); return; }
    _toast("已取消 $pn 的预约", err: false);
    _load();
  }

  /// 新增入口：三个候选来源（全部服务器口径，物料员本机没有采集数据）
  Future<void> _add() async {
    final picked = await showModalBottomSheet<_PnHit2>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => const _WatchPickSheet());
    if (picked == null || !mounted) return;
    await _book(picked.partNo, picked.itemName);
  }

  @override
  Widget build(BuildContext context) {
    final late_ = _items.where((m) => m["overdue"] == true).length;
    final doneN = _items.where((m) => m["done"] == true).length;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        title: const Text("我的预约来料", style: TextStyle(fontSize: 17)),
        toolbarHeight: 44,
        actions: [
          IconButton(tooltip: "刷新", onPressed: _loading ? null : _load, icon: const Icon(Icons.refresh)),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
          onPressed: _busy ? null : _add,
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white,
          icon: const Icon(Icons.add),
          label: const Text("预约来料")),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(children: [
              Container(
                  width: double.infinity,
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
                  color: Colors.white,
                  child: Wrap(spacing: 6, runSpacing: 4, children: [
                    _chipF('', '全部 ${_items.length}'),
                    _chipF('todo', '在途等货 ${_items.length - doneN}'),
                    _chipF('late', late_ > 0 ? '⚠ 逾期 $late_' : '逾期 0'),
                    _chipF('done', '已达成 $doneN'),
                  ])),
              if (_err.isNotEmpty)
                Container(width: double.infinity, padding: const EdgeInsets.all(10), color: Colors.red.shade50, child: Text(_err, style: TextStyle(color: Colors.red.shade700, fontSize: 12.5))),
              Expanded(
                  child: _shown.isEmpty
                      ? SingleChildScrollView(
                          padding: const EdgeInsets.fromLTRB(20, 48, 20, 90),
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(_items.isEmpty ? "还没有预约" : "该筛选下没有条目", style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                            const SizedBox(height: 8),
                            Text("预约来料能帮你做三件事：\n"
                                "① 到料当天通知你，不用天天问仓管\n"
                                "② 填了预订筐数，够数自动帮你开领料单\n"
                                "③ 仓管在「缺料反馈」页看得见有人等这批货\n\n"
                                "点右下角「预约来料」，可以按零件号搜，也可以直接把我反馈过缺料的零件一键转成预约。",
                                style: const TextStyle(fontSize: 13, height: 1.7, color: Colors.black87)),
                          ]))
                      : RefreshIndicator(onRefresh: _load, child: ListView.builder(
                          padding: const EdgeInsets.fromLTRB(10, 8, 10, 90),
                          itemCount: _shown.length,
                          itemBuilder: (ctx, i) => _card(_shown[i]),
                        ))),
            ]),
    );
  }

  Widget _chipF(String k, String t) {
    final on = _flt == k;
    return GestureDetector(
        onTap: () => setState(() => _flt = on ? "" : k),
        child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
            decoration: BoxDecoration(
                color: on ? const Color(0xFF515BD4) : Colors.transparent,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: on ? const Color(0xFF515BD4) : const Color(0xFFDCE3EC))),
            child: Text(t, style: TextStyle(fontSize: 12, color: on ? Colors.white : Colors.black87, fontWeight: on ? FontWeight.w700 : FontWeight.w400))));
  }

  Widget _card(Map m) {
    final pn = (m["partNo"] ?? "").toString();
    final nm = (m["itemName"] ?? "").toString();
    final target = (m["target"] as num?)?.toInt() ?? 0;
    final arrived = (m["arrived"] as num?)?.toInt() ?? 0;
    final stock = (m["stock"] as num?)?.toInt() ?? 0;
    final done = m["done"] == true, overdue = m["overdue"] == true;
    final reqNo = (m["reqNo"] ?? "").toString();
    final due = (m["due"] ?? "").toString();
    final pct = target > 0 ? (arrived / target).clamp(0.0, 1.0) : (stock > 0 ? 1.0 : 0.0);
    final Color acc = overdue ? const Color(0xFFC62828) : done ? const Color(0xFF2E7D32) : const Color(0xFF515BD4);
    return Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), border: Border.all(color: const Color(0xFFE3E8F0))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(pn, style: const TextStyle(fontFamily: "monospace", fontSize: 14, fontWeight: FontWeight.w700))),
            Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(color: acc.withOpacity(.1), borderRadius: BorderRadius.circular(4)),
                child: Text(done ? (reqNo.startsWith("LL") ? "已自动开单" : "已达成") : (overdue ? "⚠ 已逾期" : target > 0 ? "等货中" : "到料提醒"),
                    style: TextStyle(fontSize: 10.5, color: acc, fontWeight: FontWeight.w700))),
          ]),
          if (nm.isNotEmpty) Text(nm, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12, color: Colors.black87)),
          const SizedBox(height: 6),
          if (target > 0) ...[
            Row(children: [
              Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: pct, minHeight: 6, backgroundColor: const Color(0xFFEDF0F5), valueColor: AlwaysStoppedAnimation(acc)))),
              const SizedBox(width: 8),
              Text("$arrived/$target 框", style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700)),
            ]),
            const SizedBox(height: 4),
          ] else
            const Text("到料提醒型（未填预订筐数）：到料只通知，不开单", style: TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
          Text("当前全厂在架 $stock 框"
              "${due.isNotEmpty ? "　·　期望 ${due.substring(5)}" : ""}"
              "${overdue ? "（已过期望日仍未开单）" : ""}"
              "${done && reqNo.isNotEmpty ? "　·　$reqNo" : ""}",
              style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
            if (done && reqNo.startsWith("LL"))
              TextButton(onPressed: () { Clipboard.setData(ClipboardData(text: reqNo)); _toast("单号已复制", err: false); }, child: const Text("复制单号", style: TextStyle(fontSize: 12.5))),
            TextButton(onPressed: _busy ? null : () => _book(pn, nm, initQty: target, initDue: due, initAuto: m["auto"] != false), child: const Text("改约", style: TextStyle(fontSize: 12.5))),
            TextButton(onPressed: _busy ? null : () => _cancel(m), child: Text(done ? "清掉记录" : "取消预约", style: const TextStyle(fontSize: 12.5, color: Colors.redAccent))),
          ]),
        ]));
  }
}

/// 候选行（本页自有轻量类型：既有 _PnHit2 无副标题字段，而"上次领用/几人催"必须显示）
class _WatchHit {
  final String partNo, itemName, sub;
  final int boxes;
  const _WatchHit(this.partNo, this.itemName, {this.boxes = 0, this.sub = ""});
}

/// 候选选择弹层：三来源全服务器口径（物料员本机无采集数据，不能照抄库存页的本机候选）
class _WatchPickSheet extends StatefulWidget {
  const _WatchPickSheet();
  @override
  State<_WatchPickSheet> createState() => _WatchPickSheetState();
}

class _WatchPickSheetState extends State<_WatchPickSheet> {
  String _kw = "", _src = "freq"; // freq=我常领 short=我反馈缺料 dict=全厂档案搜索
  List<_WatchHit> _freq = const [], _short = const [], _dict = const [];
  bool _load = true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run());
  }

  Future<void> _run() async {
    setState(() => _load = true);
    if (_src == "freq") {
      final j = await AuthApi.reqFrequent(); // 服务端返回 {list:[{pn,nm,n,last,lastQty,lastNo}],days}
      final l = List<Map>.from(j["list"] ?? []).map((x) {
        final q = (x["lastQty"] as num?)?.toDouble() ?? 0;
        return _WatchHit((x["pn"] ?? "").toString(), (x["nm"] ?? "").toString(),
            sub: "近${(j["days"] as num?)?.toInt() ?? 60}天领 ${(x["n"] as num?)?.toInt() ?? 0} 次 · 上次 ${_freqAgo((x["last"] as num?)?.toInt() ?? 0)} ${_fmtInvNum(q)} 件");
      }).toList();
      if (mounted) setState(() { _freq = l; _load = false; });
    } else if (_src == "short") {
      final j = await AuthApi.shortList();
      final l = List<Map>.from(j["list"] ?? []).map((x) {
        final sb = (x["suggestBoxes"] as num?)?.toInt() ?? 0;
        final gap = (x["gapQty"] as num?)?.toDouble() ?? 0;
        return _WatchHit((x["pn"] ?? "").toString(), (x["nm"] ?? "").toString(),
            boxes: (x["boxes"] as num?)?.toInt() ?? 0,
            sub: "${(x["n"] as num?)?.toInt() ?? 1} 人催"
                "${sb > 0 ? " · 建议补 $sb 框" : (gap > 0 ? " · 缺 ${_fmtInvNum(gap)} 件" : "")}");
      }).toList();
      if (mounted) setState(() { _short = l; _load = false; });
    } else {
      final h = await shortDictFind(_kw, limit: 40);
      final l = h.map((x) => _WatchHit(x["pn"].toString(), (x["nm"] ?? "").toString(), boxes: (x["boxes"] as num?)?.toInt() ?? 0)).toList();
      if (mounted) setState(() { _dict = l; _load = false; });
    }
  }

  static String _freqAgo(int t) {
    if (t <= 0) return "很久以前";
    final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(t)).inDays;
    return d <= 0 ? "今天" : "$d 天前";
  }

  @override
  Widget build(BuildContext context) {
    final list = _src == "freq" ? _freq : (_src == "short" ? _short : _dict);
    return Padding(
        padding: EdgeInsets.fromLTRB(14, 12, 14, 14 + MediaQuery.of(context).viewInsets.bottom),
        child: SizedBox(
            height: MediaQuery.of(context).size.height * .72,
            child: Column(children: [
              const Text("预约哪个零件", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              TextField(
                  autofocus: _src == "dict",
                  onChanged: (v) { _kw = v; if (_src == "dict") _run(); },
                  style: const TextStyle(fontSize: 13),
                  decoration: const InputDecoration(hintText: "搜零件号/物料名（全厂档案）", isDense: true, prefixIcon: Icon(Icons.search, size: 18), border: OutlineInputBorder())),
              const SizedBox(height: 6),
              Row(children: [
                _tab('freq', '我常领的'),
                const SizedBox(width: 6),
                _tab('short', '我反馈缺料的'),
                const SizedBox(width: 6),
                _tab('dict', '档案搜索'),
              ]),
              const SizedBox(height: 4),
              Expanded(
                  child: _load
                      ? const Center(child: CircularProgressIndicator())
                      : list.isEmpty
                          ? Center(
                              child: Text(
                                  _src == "dict"
                                      ? (_kw.trim().length < 3 ? "输入 3 个字以上开始搜" : "档案里没有这个号")
                                      : (_src == "short" ? "你还没有未核销的缺料反馈" : "近 60 天你还没领过东西"),
                                  style: const TextStyle(fontSize: 12.5, color: Colors.blueGrey)),
                            )
                          : ListView.builder(
                              itemCount: list.length,
                              itemBuilder: (ctx, i) {
                                final h = list[i];
                                return ListTile(
                                    dense: true,
                                    visualDensity: const VisualDensity(vertical: -1),
                                    title: Text(h.partNo, style: const TextStyle(fontFamily: "monospace", fontSize: 13, fontWeight: FontWeight.w600)),
                                    subtitle: Text([h.itemName, h.sub, h.boxes > 0 ? "在架 ${h.boxes} 框" : (_src == "freq" ? "" : "全厂零在架")].where((s) => s.isNotEmpty).join("　"),
                                        maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
                                    trailing: const Icon(Icons.chevron_right, size: 18, color: Color(0xFFB0BEC5)),
                                    onTap: () => Navigator.pop(ctx, _PnHit2(h.partNo, h.itemName, h.boxes, 0)));
                              }))
            ])));
  }

  Widget _tab(String k, String t) {
    final on = _src == k;
    return Expanded(
        child: GestureDetector(
            onTap: () { if (_src != k) { setState(() => _src = k); _run(); } },
            child: Container(
                padding: const EdgeInsets.symmetric(vertical: 7),
                decoration: BoxDecoration(
                    color: on ? const Color(0xFF515BD4) : const Color(0xFFF1F3F8),
                    borderRadius: BorderRadius.circular(8)),
                child: Text(t, textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: on ? Colors.white : Colors.black87, fontWeight: on ? FontWeight.w700 : FontWeight.w400)))));
  }
}
