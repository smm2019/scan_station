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
      final finished = r["status"] == 'ready' ||
          r["status"] == 'done'; // ready/done 时所有行必已 transfer/skip
      for (final it in List<Map>.from(r["items"] ?? [])) {
        if (!finished && it["transferred"] != true)
          continue; // 备料中：只扣已转MES的行（扫而未转不算出库）
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
    try {
      return (jsonDecode(s) as List).map((e) => e.toString()).toSet();
    } catch (_) {
      return {};
    }
  }
}

class RequisitionPage extends StatefulWidget {
  const RequisitionPage({super.key});
  @override
  State<RequisitionPage> createState() => _RequisitionPageState();
}

/// 服务器时间（UTC ISO串）→ 本地 MM-DD HH:mm 显示（修复直接截取导致差8小时）
String reqTimeLocal(dynamic s) {
  final str = s?.toString() ?? "";
  if (str.isEmpty) return "";
  final dt = DateTime.tryParse(str);
  if (dt == null)
    return str.length >= 16 ? str.substring(5, 16).replaceFirst("T", " ") : str;
  final lo = DateTime.fromMillisecondsSinceEpoch(
      dt.toLocal().millisecondsSinceEpoch + kClockOffsetMs); // ㉒G11 按服务器时钟校正
  return "${lo.month.toString().padLeft(2, "0")}-${lo.day.toString().padLeft(2, "0")} ${lo.hour.toString().padLeft(2, "0")}:${lo.minute.toString().padLeft(2, "0")}";
}

/// v60 建单弹层历史行压缩："10-12 20:51 领5000件 LL2026101212510740" → "10-12 领5000件"
String _histShort(String h) {
  final m = RegExp(r'^(\d{2}-\d{2})\s+\d{2}:\d{2}\s+(领\S+件?)').firstMatch(h);
  if (m != null) return "${m.group(1)} ${m.group(2)}";
  final m2 = RegExp(r'^(\d{2}-\d{2})\s+(领\S+件?)').firstMatch(h); // 无时分的旧格式
  if (m2 != null) return "${m2.group(1)} ${m2.group(2)}";
  return h.length > 14 ? "${h.substring(0, 14)}…" : h;
}

class _RequisitionPageState extends State<RequisitionPage>
    with AutomaticKeepAliveClientMixin {
  List<Map> _reqs = [];
  bool _loading = true;
  String _err = "";
  Timer? _listTimer;

  @override
  bool get wantKeepAlive => true;

  String _search = ""; // ⑰领料记录搜索：零件号/物料名/单号/人/日期
  @override
  void initState() {
    super.initState();
    _load();
    _listTimer = Timer.periodic(
        const Duration(seconds: 30), (_) => _loadSilent()); // ⑪自动刷新
    kReqJump.addListener(_onJump); // ㉖通知点击直达详情
    kReqAgain.addListener(_onAgain); // ㉖v76 领料账本一键续领
  }

  bool _jumping = false;
  void _onJump() {
    final v = kReqJump.value;
    if (v.isEmpty || _jumping) return;
    kReqJump.value = "";
    final id = v.split("@").first;
    _jumping = true;
    _load().then((_) {
      _jumping = false;
      if (!mounted) return;
      Map? hit;
      for (final r in _reqs) {
        if (r["id"]?.toString() == id) {
          hit = r;
          break;
        }
      }
      if (hit != null)
        _detail(hit);
      else
        _toast("该单不在当前列表（可能已归档或无权限）");
    });
  }

  // ㉖v76 领料账本"一键续领"：零件号|件数 → 开建单弹层预填（弹层自动按均值换算框数）
  void _onAgain() {
    final v = kReqAgain.value;
    if (v.isEmpty) return;
    kReqAgain.value = "";
    final seg = v.split("|");
    if (seg.length < 2) return;
    if (!Auth.can("requisition")) {
      _toast("当前角色无领料下单权限");
      return;
    }
    _create(prefill: {seg[0]: seg[1]});
  }

  @override
  void dispose() {
    _listTimer?.cancel();
    kReqJump.removeListener(_onJump);
    kReqAgain.removeListener(_onAgain);
    super.dispose();
  }

  /// 静默刷新：不转圈、失败不报错，只更新列表数据
  Future<void> _loadSilent() async {
    if (!mounted) return;
    final r = await AuthApi.reqList();
    if (!mounted || r["ok"] != true) return;
    final list = List<Map>.from(r["reqs"] ?? []);
    RequisitionCache.saveIssued(list);
    setState(() => _reqs = list);
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _err = "";
    });
    // 物料员本机没有采集/登记数据：先与电脑账本增量合并，建单选件才有库存与货位
    // ㉖ 页面级5分钟节流取消，统一走 ledgerPullMerge 内 20 秒全局节流（多页共享，不会重复打服务器）
    if (Auth.user?.role == 'material') await ledgerPullMerge();
    final r = await AuthApi.reqList();
    if (!mounted) return;
    if (r["ok"] == true) {
      final list = List<Map>.from(r["reqs"] ?? []);
      RequisitionCache.saveIssued(list); // 刷新已发料标签缓存（库存联动）
      setState(() {
        _reqs = list;
        _loading = false;
      });
    } else {
      setState(() {
        _loading = false;
        _err = (r["msg"] ?? "加载失败").toString();
      });
    }
  }

  List<Map> get _shown {
    final k = _search.trim().toLowerCase();
    if (k.isEmpty) return _reqs;
    return _reqs.where((r) {
      for (final e in List<Map>.from(r["items"] ?? [])) {
        if ((e["partNo"]?.toString().toLowerCase().contains(k) ?? false) ||
            (e["itemName"]?.toString().toLowerCase().contains(k) ?? false))
          return true;
      }
      if ((r["no"]?.toString().toLowerCase().contains(k) ?? false) ||
          (r["byName"]?.toString().toLowerCase().contains(k) ?? false) ||
          (r["remark"]?.toString().toLowerCase().contains(k) ?? false))
        return true;
      return (r["createdAt"]?.toString().toLowerCase() ?? "")
          .contains(k); // 支持 10-09 / 2026-10 等日期片段
    }).toList();
  }

  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(m), backgroundColor: err ? Colors.red : Colors.green));
  }

  /// ㉖v52 备料排队看板：排位一目了然——我正排第几、仓管在给谁备料、前面都有谁
  Future<void> _showQueueBoard() async {
    // 本人最早的未完单作为排位锚点（物料员视角）；仓管/管理员传空看全景
    final mine = _reqs
        .where((r) =>
            r["by"] == Auth.user?.id &&
            (r["status"] == "pending" || r["status"] == "accepted"))
        .toList();
    mine.sort((a, b) =>
        (a["createdAt"] ?? "").toString().compareTo((b["createdAt"] ?? "").toString()));
    showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => _QueueBoardSheet(myId: mine.isEmpty ? "" : mine.first["id"].toString()));
  }

  Color _statusColor(String s) => switch (s) {
        'pending' => Colors.orange,
        'accepted' => Colors.blue,
        'ready' => Colors.teal,
        'done' => Colors.green,
        'rejected' || 'cancelled' => Colors.grey,
        _ => Colors.grey,
      };

  Future<void> _create({Map<String, String>? prefill}) async {
    // 从库存选零件号下单：多行 items；prefill=再来一单（原单零件号+数量带入，可改）
    final agg = await computeStock();
    if (!mounted) return;
    final parts = agg.parts.values.where((p) => p.inStockQty > 0).toList()
      ..sort((a, b) => a.partNo.compareTo(b.partNo));
    if (parts.isEmpty) {
      _toast("当前库存为空，无法下单");
      return;
    }
    if (prefill != null && prefill.isNotEmpty) {
      final miss = prefill.keys
          .where((pn) => !parts.any((p) => p.partNo == pn))
          .toList();
      if (miss.isNotEmpty) _toast("原单零件 ${miss.join("、")} 当前无在库，未预填", err: false);
    }
    // ⑰该零件最近领用记录（从可见领料单聚合，最新在前）
    final hist = <String, List<String>>{};
    for (final r in _reqs) {
      final t = reqTimeLocal(r["createdAt"]);
      for (final e in List<Map>.from(r["items"] ?? [])) {
        final pn = e["partNo"]?.toString() ?? "";
        if (pn.isEmpty) continue;
        (hist[pn] ??= <String>[]).add("$t 领${e["qty"]}件 ${r["no"]}");
      }
    }
    hist.forEach((k, v) => hist[k] = v.take(3).toList());
    final res = await showModalBottomSheet<Map<String, dynamic>>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => _ReqCreateSheet(parts: parts, hist: hist, prefill: prefill));
    if (res == null || !mounted) return;
    final r = await AuthApi.reqCreate(
        res["items"] as List<Map>, res["remark"]?.toString() ?? "",
        assigneeId: res["assigneeId"]?.toString() ?? "",
        rush: res["rush"] == true,
        needDate: res["needDate"]?.toString() ?? "");
    if (!mounted) return;
    if (r["ok"] == true) {
      // ㉖v52 排队看板回执：我排几号 / 正在给谁备料 / 前面还有谁在等 / 仓库在跑多少 AGV 任务
      final q = r["queue"];
      String qTxt = "";
      if (q is Map) {
        final rank = (q["rank"] as num?)?.toInt() ?? 0;
        final total = (q["total"] as num?)?.toInt() ?? 0;
        final serving = List<Map>.from(q["servingNow"] ?? [])
            .map((x) => "${x["byName"]}的单（${x["acceptedBy"]}备料中${(x["acceptedMin"] as num?) != null ? "·已${x["acceptedMin"]}分钟" : ""}）")
            .take(2)
            .join("、");
        final ahead = List<Map>.from(q["ahead"] ?? []);
        final aheadWho = ahead
            .map((x) => "${x["byName"]}${x["status"] == "pending" ? "（待接单）" : "（备料中）"}")
            .take(3)
            .join("、");
        final eta = (q["etaMin"] as num?)?.toInt();
        final agv = (q["agvActive"] as num?)?.toInt() ?? 0;
        if (rank <= 1 && ahead.isEmpty) {
          qTxt = "，你排第 $rank 位${total > 1 ? "（共 $total 单）" : ""}，仓管马上就能接你的单";
        } else {
          qTxt = "，你排第 $rank 位（共 $total 单）"
              "${ahead.isNotEmpty ? "，前面：$aheadWho${ahead.length > 3 ? "…等${ahead.length}单" : ""}" : ""}"
              "${serving.isNotEmpty ? "，正在给 $serving" : ""}"
              "${eta != null && eta > 0 ? "，预计 ${eta > 90 ? "${(eta / 60).ceil()} 小时" : "$eta 分钟"}后轮到你" : ""}"
              "${agv > 0 ? "｜仓库在跑 $agv 个AGV任务" : ""}";
        }
      } else {
        final ahead = (r["queueAhead"] as num?)?.toInt();
        qTxt = ahead == null
            ? ""
            : ahead == 0
                ? "，当前无单排队，仓管接单最快"
                : "，前面还有 $ahead 张单在排队";
      }
      final aName = res["assigneeName"]?.toString() ?? "";
      _toast(
          "领料单已提交：${r["req"]["no"]}"
          "${aName.isNotEmpty ? "，已指定 $aName 备料（30分钟未接自动放开）" : ""}$qTxt\n（点顶部「排队」按钮随时看进度）",
          err: false);
      _load();
    } else
      _toast((r["msg"] ?? "提交失败").toString());
  }

  Future<void> _detail(Map rq) async {
    final changed = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => _ReqDetailSheet(
            rq: rq,
            toast: _toast,
            statusColor: _statusColor,
            onAgain: _again));
    if (changed == true) _load();
  }

  /// ㉖ 再来一单：把原单零件号+数量带入新建弹层（可改），下单人为当前账号
  void _again(Map rq) {
    final pf = <String, String>{};
    for (final e in List<Map>.from(rq["items"] ?? [])) {
      final pn = e["partNo"]?.toString() ?? "";
      if (pn.isEmpty) continue;
      pf[pn] = (e["qty"] ?? "").toString();
    }
    if (pf.isEmpty) {
      _toast("原单无有效零件行");
      return;
    }
    _create(prefill: pf);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    // 入口门禁：物料员看领料开关；仓管/管理员可进（接单发料由服务端按角色强制）
    final role = Auth.user?.role ?? "";
    if (!Auth.can("requisition") &&
        !Auth.can("receive_confirm") &&
        role != "warehouse" &&
        role != "admin") {
      return const Center(
          child:
              Text("当前角色未开通领料功能，请联系管理员", style: TextStyle(color: Colors.grey)));
    }
    final canOrder = Auth.can("requisition");
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        title: const Text("领料单"),
        toolbarHeight: 44,
        actions: [
          IconButton(
              icon: const Icon(Icons.query_stats_outlined),
              tooltip: "领料账本（消耗聚合/撑几天/呆滞榜/报告分享）",
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const ReqLedgerPage()))),
          IconButton(
              icon: const Icon(Icons.groups_outlined),
              tooltip: "备料排队看板",
              onPressed: _showQueueBoard),
          IconButton(
              icon: const Icon(Icons.share_outlined, color: Color(0xFF07C160)),
              tooltip: "缺料反馈分享（微信）",
              onPressed: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const ShortageReportPage()))),
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load), // ㉖ 顶栏铃铛按用户要求移除（消息入口保留在底部"消息"页签）
        ],
      ),
      floatingActionButton: canOrder
          ? FloatingActionButton.extended(
              onPressed: () => _create(),
              backgroundColor: const Color(0xFF515BD4),
              foregroundColor: Colors.white,
              icon: const Icon(Icons.add),
              label: const Text("新建领料单"),
            )
          : null,
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _err.isNotEmpty
              ? Center(
                  child: Text(_err, style: const TextStyle(color: Colors.red)))
              : _reqs.isEmpty
                  ? const Center(
                      child:
                          Text("暂无领料单", style: TextStyle(color: Colors.grey)))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: Column(children: [
                        Padding(
                            padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                            child: TextField(
                              onChanged: (v) => setState(() => _search = v),
                              decoration: InputDecoration(
                                  hintText: "搜零件号/物料名/单号/日期（如 10-09）",
                                  isDense: true,
                                  prefixIcon:
                                      const Icon(Icons.search, size: 20),
                                  suffixIcon: _search.isEmpty
                                      ? null
                                      : IconButton(
                                          icon:
                                              const Icon(Icons.clear, size: 18),
                                          onPressed: () =>
                                              setState(() => _search = "")),
                                  border: const OutlineInputBorder()),
                            )),
                        Expanded(
                            child: _shown.isEmpty
                                ? Center(
                                    child: Text("没有匹配「$_search」的领料记录，清空搜索可看全部",
                                        style: const TextStyle(
                                            color: Colors.grey)))
                                : ListView.builder(
                                    padding: const EdgeInsets.fromLTRB(
                                        10, 8, 10, 90),
                                    itemCount: _shown.length,
                                    itemBuilder: (ctx, i) {
                                      final r = _shown[i];
                                      final items =
                                          List<Map>.from(r["items"] ?? []);
                                      final st = r["status"].toString();
                                      final itemsText = items
                                          .map((e) =>
                                              "${e["partNo"]}×${e["qty"]}")
                                          .join("、");
                                      final aName =
                                          r["assigneeName"]?.toString() ?? "";
                                      final aOpen = (r["assignOpenAt"] ?? "")
                                          .toString()
                                          .isNotEmpty;
                                      final assignTxt = aName.isEmpty
                                          ? ""
                                          : (st == 'pending' && aOpen
                                              ? "\n📌 已指定 $aName"
                                              : (st == 'pending'
                                                  ? "\n（原指定 $aName 超时放开）"
                                                  : ""));
                                      return Card(
                                        margin: const EdgeInsets.symmetric(
                                            vertical: 5),
                                        child: ListTile(
                                          leading: CircleAvatar(
                                              backgroundColor: _statusColor(st)
                                                  .withOpacity(0.14),
                                              child: Icon(_stIcon(st),
                                                  color: _statusColor(st),
                                                  size: 22)),
                                          title: Text(
                                              "${r["rush"] == true ? "🔥 " : ""}${r["no"]}  ${r["byName"]}",
                                              style: TextStyle(
                                                  fontSize: 14,
                                                  fontWeight: FontWeight.w600,
                                                  color: r["rush"] == true
                                                      ? Colors.red.shade700
                                                      : null)),
                                          subtitle: Text(
                                              "$itemsText\n${reqTimeLocal(r["createdAt"])}${(r["remark"]?.toString().isNotEmpty ?? false) ? " · ${r["remark"]}" : ""}$assignTxt",
                                              style: const TextStyle(
                                                  fontSize: 12)),
                                          isThreeLine: true,
                                          trailing: Container(
                                              padding:
                                                  const EdgeInsets.symmetric(
                                                      horizontal: 8,
                                                      vertical: 3),
                                              decoration: BoxDecoration(
                                                  color: _statusColor(st)
                                                      .withOpacity(0.12),
                                                  borderRadius:
                                                      BorderRadius.circular(6)),
                                              child: Text(
                                                  r["statusText"]?.toString() ??
                                                      st,
                                                  style: TextStyle(
                                                      fontSize: 11,
                                                      color:
                                                          _statusColor(st)))),
                                          onTap: () => _detail(r),
                                        ),
                                      );
                                    },
                                  ))
                      ])),
    );
  }
}

IconData _stIcon(String s) => switch (s) {
      'pending' => Icons.hourglass_top,
      'accepted' => Icons.local_shipping_outlined,
      'ready' => Icons.inventory,
      'done' => Icons.check_circle_outline,
      _ => Icons.cancel_outlined,
    };

// ---------- 新建领料单弹层：从库存选零件号+数量，可多行 ----------
class _ReqCreateSheet extends StatefulWidget {
  final List<_StockPartRow> parts;
  final Map<String, List<String>> hist; // 零件号→最近领用记录
  final Map<String, String>? prefill; // 再来一单：原单零件号→数量预填（可改）
  const _ReqCreateSheet({required this.parts, this.hist = const {}, this.prefill});
  @override
  State<_ReqCreateSheet> createState() => _ReqCreateSheetState();
}

class _ReqCreateSheetState extends State<_ReqCreateSheet> {
  final Map<String, TextEditingController> _qtyCtrl = {}; // partNo -> qty 输入控制器
  String _search = "";
  List<Map> _warehouses = []; // 可选仓管员（指定备料）
  String _assigneeId = "";
  String _lastAsg = ""; // 第3档 上次指定仓管（默认沿用）
  bool _defAssignee = true; // 第3档 是否默认沿用上次指定
  String _needDate = ""; // 第3档 期望到货日期 yyyy-MM-dd
  bool _rush = false; // 急料：AGV优先排队+到站5分钟催扫广播
  final List<String> _order = []; // v55 已选物料行序（靠前=加急，入队按此序）
  final Set<String> _rushLines = {}; // v55 行级急料开关
  List<Map> _freq = []; // ㉖v62 常领清单（近60天本人聚合，服务端排序）
  List<Map> _tpls = []; // v62 产线模板（私有+共享）
  String _myUid = ""; // v62 当前用户id（判断模板归属：自己的才显示删除）

  /// v55 数量变化同步已选区：填>0入选（追加到队尾），清空即除名；零件下架由提交时兜底过滤
  void _syncChosen(String partNo) {
    final q = int.tryParse(_qtyCtrl[partNo]?.text.trim() ?? "") ?? 0;
    if (q > 0) {
      if (!_order.contains(partNo)) _order.add(partNo);
    } else if (_order.contains(partNo)) {
      _order.remove(partNo);
      _rushLines.remove(partNo);
    }
  }

  /// v55 提交行集：按已选顺序输出，零件中途清零/下架跳过（沿用 v53 防崩口径）
  /// ㉖v71b 单位统一：输入框=框数，服务器/详情/发料进度=件数——提交按平均件/框换算（修"填10框提交变10件"）
  List<Map> _chosenItems() {
    final out = <Map>[];
    for (final pn in _order) {
      final found = widget.parts.where((x) => x.partNo == pn).toList();
      if (found.isEmpty) continue;
      final q = int.tryParse(_qtyCtrl[pn]?.text.trim() ?? "") ?? 0;
      if (q <= 0) continue;
      final p = found.first;
      final qtyPieces = p.perBoxQty > 0 ? (q * p.perBoxQty).round() : q; // 框数→件数（无框均值时兜底原值）
      out.add({"partNo": p.partNo, "itemName": p.itemName, "qty": qtyPieces, "rush": _rushLines.contains(pn)});
    }
    return out;
  }

  /// ㉖v71b 件数→框数（预填用，向上取整至少1框）
  int _boxesFromPieces(double pieces, double perBox) =>
      pieces > 0 && perBox > 0 ? (pieces / perBox).ceil() : (pieces > 0 ? pieces.round() : 1);

  @override
  void initState() {
    super.initState();
    // ㉖ 再来一单：预填原单零件号数量（在库有才填，用户可改可清空）
    final pf = widget.prefill;
    if (pf != null && pf.isNotEmpty) {
      for (final p in widget.parts) {
        final q = pf[p.partNo];
        if (q != null && q.isNotEmpty) {
          // ㉖v71b 原单qty=件数，预填换算回框数（输入框口径=框）
          final pieces = double.tryParse(q) ?? 0;
          final boxes = _boxesFromPieces(pieces, p.perBoxQty);
          _qtyCtrl[p.partNo] = TextEditingController(text: "$boxes");
          _syncChosen(p.partNo); // v55 预填行同步入已选区
        }
      }
    }
    SharedPreferences.getInstance().then((sp) {
      final off = sp.getInt("pd_dateOffset") ?? 0;
      final d = DateTime.now().add(Duration(days: off));
      if (!mounted) return;
      setState(() {
        _defAssignee = sp.getBool("pd_defAssignee") ?? true;
        _needDate =
            "${d.year.toString().padLeft(4, "0")}-${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")}";
      });
      _applyAssignee(); // 第3档 sp 与用户列表哪个后到都再判一次
    });
    AuthApi.reqWarehouseUsers().then((r) {
      if (!mounted) return;
      if (r["ok"] == true) {
        setState(() {
          _warehouses = List<Map>.from(r["users"] ?? []);
          _lastAsg = r["lastAssigneeId"]?.toString() ?? "";
        });
        _applyAssignee();
      }
    });
    // ㉖v62 建单提效：并行拉常领清单与产线模板（失败静默，不影响正常建单）
    AuthStore.user().then((au) {
      if (mounted && au != null) setState(() => _myUid = au.id);
    });
    AuthApi.reqFrequent().then((r) {
      if (!mounted) return;
      if (r["ok"] == true) setState(() => _freq = List<Map>.from(r["list"] ?? []));
    });
    AuthApi.tplList().then((r) {
      if (!mounted) return;
      if (r["ok"] == true) setState(() => _tpls = List<Map>.from(r["list"] ?? []));
    });
  }

  /// ㉖v62 建单提效：常领一键加（近60天本人聚合）+ 产线模板整单载入
  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(m),
        duration: const Duration(seconds: 2),
        backgroundColor: err ? Colors.red.shade700 : Colors.blueGrey));
  }

  /// ㉖v62 一键把常领零件加入已选（数量默认=上次领用，可改）；已在清单里的跳过
  void _addFrequent(List<String> pns) {
    final byPn = {for (final p in widget.parts) p.partNo: p};
    final fm = {for (final f in _freq) f["pn"].toString(): f};
    int added = 0;
    for (final pn in pns) {
      if (byPn[pn] == null) continue; // 当前无在架，不加
      if (_order.contains(pn)) continue;
      final last = (fm[pn]?["lastQty"] as num?)?.toDouble() ?? 0; // 上次领用=件数
      // ㉖v71b 件数换算回框数填入（输入框口径=框）
      final boxes = _boxesFromPieces(last, byPn[pn]!.perBoxQty);
      _qtyCtrl[pn] = TextEditingController(text: "$boxes");
      _syncChosen(pn);
      added++;
    }
    if (added > 0) setState(() {});
  }

  /// ㉖v62 存/编辑产线模板：edit=null 新建（取当前已选行）；edit=模板 原地编辑我的（显示模板自身行，只改名/共享；要改行请用载入后另存）
  void _saveAsTpl({Map? edit}) {
    // ㉖v71b 模板口径固定=框数（与载入端直接填框一致，兼容 v62 旧模板）；_chosenItems 已改存件数，此处不可复用
    final items = edit != null
        ? List<Map>.from(edit["items"] ?? [])
        : _order
            .map((pn) {
              final p = widget.parts.where((x) => x.partNo == pn).firstOrNull;
              final q = int.tryParse(_qtyCtrl[pn]?.text.trim() ?? "") ?? 0;
              if (p == null || q <= 0) return null;
              return {"partNo": p.partNo, "itemName": p.itemName, "qty": q};
            })
            .whereType<Map>()
            .toList();
    if (items.isEmpty) return;
    final nameCtrl = TextEditingController(text: edit?["name"]?.toString() ?? "");
    bool shared = edit == null ? false : edit["shared"] == true;
    showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (mctx) => Padding(
            padding: EdgeInsets.fromLTRB(
                16, 14, 16, MediaQuery.of(mctx).viewInsets.bottom + 16),
            child: StatefulBuilder(builder: (mctx2, setS) => Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text("${edit == null ? "存为" : "编辑"}产线模板（${items.length} 行）",
                      style: const TextStyle(
                          fontSize: 15, fontWeight: FontWeight.bold)),
                  if (edit != null)
                    const Padding(
                        padding: EdgeInsets.only(top: 2),
                        child: Text("此处改名称/共享；要增删物料行：先点模板载入到清单，再「存为产线模板」",
                            style: TextStyle(
                                fontSize: 11, color: Color(0xFF78909C)))),
                  const SizedBox(height: 8),
                  TextField(
                      controller: nameCtrl,
                      maxLength: 20,
                      decoration: const InputDecoration(
                          hintText: "模板名，如：焊装一线常领",
                          isDense: true,
                          counterText: "",
                          border: OutlineInputBorder())),
                  CheckboxListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      controlAffinity: ListTileControlAffinity.leading,
                      value: shared,
                      onChanged: (v) => setS(() => shared = v ?? false),
                      title: const Text("共享给同事（同产线的人可直接用）",
                          style: TextStyle(fontSize: 13))),
                  const SizedBox(height: 4),
                  Row(children: [
                    Expanded(
                        child: OutlinedButton(
                            onPressed: () => Navigator.pop(mctx),
                            child: const Text("取消"))),
                    const SizedBox(width: 10),
                    Expanded(
                        flex: 2,
                        child: ElevatedButton(
                            onPressed: () async {
                              final nm = nameCtrl.text.trim();
                              if (nm.isEmpty) {
                                _toast("请给模板起个名字", err: false);
                                return;
                              }
                              final r = await AuthApi.tplSave(nm, items, shared,
                                  id: edit?["id"]?.toString() ?? "");
                              if (!mctx.mounted) return;
                              Navigator.pop(mctx);
                              if (r["ok"] == true) {
                                _toast("模板「$nm」已${edit == null ? "保存" : "更新"}", err: false);
                                final g = await AuthApi.tplList();
                                if (mounted && g["ok"] == true) setState(() =>
                                    _tpls = List<Map>.from(g["list"] ?? []));
                              } else {
                                _toast(r["msg"]?.toString() ?? "保存失败");
                              }
                            },
                            child: Text(edit == null ? "保存" : "更新"))),
                  ]),
                ]))));
  }

  /// ㉖v62 把他人共享模板载入当前清单并提示另存为自己的（可改行改量后存）
  void _forkTpl(Map t) {
    final items = List<Map>.from(t["items"] ?? []);
    final miss = <String>[];
    for (final it in items) {
      final pn = it["partNo"].toString();
      if (!widget.parts.any((p) => p.partNo == pn)) { miss.add(pn); continue; }
      if (_order.contains(pn)) continue;
      final q = (it["qty"] as num?)?.toInt() ?? 1;
      _qtyCtrl[pn] = TextEditingController(text: "$q");
      _syncChosen(pn);
    }
    setState(() {});
    _toast("已载入「${t["name"]}」，调整后可点下方「存为产线模板」存成自己的", err: false);
    if (miss.isNotEmpty) _toast("其中 ${miss.join("、")} 当前无在架，已跳过", err: false);
  }

  /// ㉖v62 产线模板弹层：点模板整单载入（无在架行自动跳过并提示），左滑删除
  void _showTplSheet() {
    showModalBottomSheet(
        context: context,
        builder: (mctx) => SafeArea(
            child: ListView(shrinkWrap: true, children: [
          const Padding(
              padding: EdgeInsets.all(12),
              child: Text("产线模板 · 点击整单载入",
                  style: TextStyle(fontWeight: FontWeight.bold))),
          ..._tpls.map((t) {
            final items = List<Map>.from(t["items"] ?? []);
            final mine = t["byName"]?.toString();
            return ListTile(
              dense: true,
              leading: CircleAvatar(
                  radius: 15,
                  backgroundColor: t["shared"] == true
                      ? const Color(0xFF26A69A)
                      : const Color(0xFF5C6BC0),
                  child: Text("${items.length}",
                      style: const TextStyle(fontSize: 12, color: Colors.white))),
              title: Text(t["name"]?.toString() ?? "",
                  style: const TextStyle(fontSize: 14)),
              subtitle: Text(
                  "${t["shared"] == true ? "共享" : "私有"} · ${mine ?? ""} · 用过${t["use"] ?? 0}次",
                  style: const TextStyle(fontSize: 11)),
              trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (t["by"] == _myUid) ...[
                      IconButton(
                          tooltip: "编辑名称/共享",
                          icon: const Icon(Icons.edit_outlined,
                              size: 20, color: Color(0xFF3949AB)),
                          onPressed: () {
                            Navigator.pop(mctx);
                            _saveAsTpl(edit: Map<String, dynamic>.from(t));
                          }),
                      IconButton(
                          tooltip: "删除",
                          icon: const Icon(Icons.delete_outline,
                              size: 20, color: Colors.redAccent),
                          onPressed: () async {
                            await AuthApi.tplDelete(t["id"].toString());
                            final r = await AuthApi.tplList();
                            if (mounted && r["ok"] == true) setState(() =>
                                _tpls = List<Map>.from(r["list"] ?? []));
                            if (mctx.mounted) Navigator.pop(mctx);
                          }),
                    ] else
                      IconButton(
                          tooltip: "载入后另存为我的模板",
                          icon: const Icon(Icons.copy_all_outlined,
                              size: 20, color: Color(0xFF00897B)),
                          onPressed: () {
                            Navigator.pop(mctx);
                            _forkTpl(t);
                          }),
                    const Icon(Icons.chevron_right, size: 20),
                  ]),
              onTap: () {
                Navigator.pop(mctx);
                final miss = <String>[];
                for (final it in items) {
                  final pn = it["partNo"].toString();
                  if (!widget.parts.any((p) => p.partNo == pn)) {
                    miss.add(pn);
                    continue;
                  }
                  if (_order.contains(pn)) continue;
                  final q = (it["qty"] as num?)?.toInt() ?? 1;
                  _qtyCtrl[pn] = TextEditingController(text: "$q");
                  _syncChosen(pn);
                }
                setState(() {});
                AuthApi.tplUse(t["id"].toString());
                if (miss.isNotEmpty)
                  _toast("模板中 ${miss.join("、")} 当前无在架，已跳过", err: false);
              },
            );
          }),
        ])));
  }

  /// 第3档 开「默认沿用上次指定」且上次的人仍有效时自动带上（网络与本地偏好都就绪才决断）
  void _applyAssignee() {
    if (!_defAssignee || _lastAsg.isEmpty || _assigneeId.isNotEmpty) return;
    if (_warehouses.any((w) => w["id"] == _lastAsg))
      setState(() => _assigneeId = _lastAsg);
  }

  @override
  void dispose() {
    for (final c in _qtyCtrl.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    var list = widget.parts;
    if (_search.trim().isNotEmpty) {
      final k = _search.trim().toLowerCase();
      list = list
          .where((p) =>
              p.partNo.toLowerCase().contains(k) ||
              p.itemName.toLowerCase().contains(k))
          .toList();
    }
    final chosen = _qtyCtrl.entries
        .where((e) => (int.tryParse(e.value.text.trim()) ?? 0) > 0)
        .toList();
    return Padding(
      padding: EdgeInsets.fromLTRB(
          14, 10, 14, MediaQuery.of(context).viewInsets.bottom + 14),
      child: SizedBox(
          height: MediaQuery.of(context).size.height * 0.95,
          child: Column(children: [
            const Text("新建领料单（从库存选择）",
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            const SizedBox(height: 8),
            TextField(
              onChanged: (v) => setState(() => _search = v),
              style: const TextStyle(fontSize: 13),
              decoration: const InputDecoration(
                  hintText: "搜索零件号/物料名",
                  isDense: true,
                  contentPadding:
                      EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  prefixIcon: Icon(Icons.search, size: 18),
                  prefixIconConstraints:
                      BoxConstraints(minWidth: 34, minHeight: 0),
                  border: OutlineInputBorder()),
            ),
            // ㉖v62 建单提效：常领一键加（近60天本人聚合）+ 产线模板整单载入
            if (_freq.isNotEmpty || _tpls.isNotEmpty) ...[
              const SizedBox(height: 6),
              SizedBox(
                height: 40,
                child: ListView(scrollDirection: Axis.horizontal, children: [
                  if (_tpls.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: ActionChip(
                        avatar: const Icon(Icons.folder_copy_outlined,
                            size: 16, color: Color(0xFF3949AB)),
                        label: Text("产线模板(${_tpls.length})",
                            style: const TextStyle(fontSize: 12)),
                        onPressed: _showTplSheet,
                      ),
                    ),
                  if (_freq.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ActionChip(
                        avatar: const Icon(Icons.bolt,
                            size: 16, color: Color(0xFFEF6C00)),
                        label: const Text("常领", style: TextStyle(fontSize: 12)),
                        onPressed: () => _addFrequent(
                            _freq.map((f) => f["pn"].toString()).toList()),
                      ),
                    ),
                  ..._freq.take(12).map((f) {
                    final pn = f["pn"].toString();
                    final pp = widget.parts
                        .where((p) => p.partNo == pn)
                        .firstOrNull;
                    final inStock = pp != null;
                    // ㉖v71b chip 显示框数（与点击填入、输入框口径统一；lastQty=件数按均值换算）
                    final boxes = _boxesFromPieces(
                        (f["lastQty"] as num?)?.toDouble() ?? 0,
                        pp?.perBoxQty ?? 0);
                    return Padding(
                      padding: const EdgeInsets.only(right: 6),
                      child: ActionChip(
                        backgroundColor: inStock
                            ? const Color(0xFFFFF3E0)
                            : const Color(0xFFF1F1F1),
                        label: Text(
                            "${pn.length > 6 ? pn.substring(pn.length - 6) : pn} ×${boxes}框",
                            style: TextStyle(
                                fontSize: 11.5,
                                color: inStock
                                    ? const Color(0xFF6D4C41)
                                    : Colors.grey),
                            overflow: TextOverflow.ellipsis),
                        onPressed: inStock ? () => _addFrequent([pn]) : null,
                      ),
                    );
                  }),
                ]),
              ),
            ],
            if (_warehouses.isNotEmpty) ...[
              const SizedBox(height: 6),
              InkWell(
                onTap: () => showModalBottomSheet(
                    context: context,
                    builder: (mctx) => SafeArea(
                            child: ListView(shrinkWrap: true, children: [
                          ListTile(
                              title: const Text("不指定（全部仓管可见抢单）"),
                              trailing: _assigneeId.isEmpty
                                  ? const Icon(Icons.check, color: Colors.teal)
                                  : null,
                              onTap: () {
                                setState(() => _assigneeId = "");
                                Navigator.pop(mctx);
                              }),
                          ..._warehouses.map((w) => ListTile(
                                leading: CircleAvatar(
                                    radius: 14,
                                    child: Text(
                                        (w["name"] ?? "?")
                                            .toString()
                                            .substring(0, 1),
                                        style: const TextStyle(fontSize: 12))),
                                title: Text(w["name"]?.toString() ?? ""),
                                trailing: _assigneeId == w["id"]
                                    ? const Icon(Icons.check,
                                        color: Colors.teal)
                                    : null,
                                onTap: () {
                                  setState(
                                      () => _assigneeId = w["id"].toString());
                                  Navigator.pop(mctx);
                                },
                              )),
                        ]))),
                child: Padding(
                  padding:
                      const EdgeInsets.symmetric(vertical: 6, horizontal: 2),
                  child: Row(children: [
                    const Icon(Icons.person_add_alt,
                        size: 18, color: Color(0xFF3949AB)),
                    const SizedBox(width: 6),
                    Text("指定仓管员：", style: const TextStyle(fontSize: 13)),
                    Text(
                        _assigneeId.isEmpty
                            ? "不指定（谁接都可以）"
                            : (_warehouses.firstWhere(
                                    (w) => w["id"] == _assigneeId,
                                    orElse: () => const {})["name"]
                                    ?.toString() ??
                                "（已停用）"),
                        style: TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: _assigneeId.isEmpty
                                ? Colors.grey
                                : const Color(0xFF3949AB))),
                    const Spacer(),
                    const Icon(Icons.expand_more, size: 18, color: Colors.grey),
                  ]),
                ),
              ),
            ],
            const SizedBox(height: 8),
            if (_order.isNotEmpty)
              SizedBox(
                  height: 22.0 +
                      47.0 * (_order.length > 8 ? 8 : _order.length), // ㉖v69b 行高按实测单行47配足（旧公式54<实际60致第6行被裁不显示），8行内全显、更多滚动
                  child: Column(children: [
                    const Text("已选物料（拖把手调序 · 靠前先出库 · 首位=🔥加急 · 数量填框数）",
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 11,
                            color: Color(0xFF3949AB),
                            fontWeight: FontWeight.w600)),
                    const SizedBox(height: 1),
                    Expanded(
                        child: ReorderableListView(
                            shrinkWrap: true,
                            buildDefaultDragHandles: false,
                            onReorder: (oldI, newI) => setState(() {
                              final pn = _order.removeAt(oldI);
                              _order.insert(newI > oldI ? newI - 1 : newI, pn);
                            }),
                            children: [
                              ..._order.asMap().entries.map((en) {
                                final i = en.key, pn = en.value;
                                final p = widget.parts
                                    .where((x) => x.partNo == pn)
                                    .firstOrNull;
                                final q = int.tryParse(
                                        _qtyCtrl[pn]?.text.trim() ?? "") ??
                                    0;
                                final r = _rushLines.contains(pn);
                                return Card(
                                    key: ValueKey(pn),
                                    margin: const EdgeInsets.symmetric(
                                        vertical: 1),
                                    color: r
                                        ? const Color(0xFFFFF6F0)
                                        : Colors.white,
                                    shape: RoundedRectangleBorder(
                                        borderRadius: BorderRadius.circular(8),
                                        side: BorderSide(
                                            color: r
                                                ? const Color(0xFFE65100)
                                                : const Color(0xFFD7DEE8))),
                                    child: Padding(
                                        padding: const EdgeInsets.fromLTRB(
                                            2, 2, 6, 2),
                                        child: Row(children: [
                                          ReorderableDragStartListener(
                                              index: i,
                                              child: const Padding(
                                                  padding: EdgeInsets.symmetric(
                                                      horizontal: 3),
                                                  child: Icon(Icons.drag_handle,
                                                      size: 20,
                                                      color:
                                                          Colors.blueGrey))),
                                          CircleAvatar(
                                              radius: 9,
                                              backgroundColor: r
                                                  ? const Color(0xFFE65100)
                                                  : const Color(0xFF90A4AE),
                                              child: Text("${i + 1}",
                                                  style: const TextStyle(
                                                      fontSize: 10,
                                                      color: Colors.white,
                                                      fontWeight:
                                                          FontWeight.bold))),
                                          const SizedBox(width: 6),
                                          Expanded(
                                              child: FittedBox(
                                                  fit: BoxFit.scaleDown,
                                                  alignment: Alignment.centerLeft, // ㉖v70b 零件号按可用宽自动缩放，10位完整显示不再截断
                                                  child: Text(pn,
                                                      maxLines: 1,
                                                      style: const TextStyle(
                                                          fontSize: 13.5,
                                                          fontWeight:
                                                              FontWeight.w600)))),
                                          SizedBox(
                                              width: 52,
                                              child: TextField(
                                                controller: _qtyCtrl.putIfAbsent(
                                                    pn,
                                                    () => TextEditingController()),
                                                keyboardType:
                                                    TextInputType.number,
                                                textAlign: TextAlign.center,
                                                style: const TextStyle(
                                                    fontSize: 12.5,
                                                    fontWeight:
                                                        FontWeight.w600),
                                                decoration: InputDecoration(
                                                    hintText: "框",
                                                    isDense: true,
                                                    contentPadding:
                                                        const EdgeInsets
                                                            .symmetric(
                                                            horizontal: 2,
                                                            vertical: 7),
                                                    enabledBorder:
                                                        OutlineInputBorder(
                                                            borderRadius:
                                                                BorderRadius
                                                                    .circular(
                                                                        6),
                                                            borderSide: BorderSide(
                                                                color: r
                                                                    ? const Color(
                                                                        0xFFE65100)
                                                                    : const Color(
                                                                        0xFFB9C4D6),
                                                                width: 1)),
                                                    border:
                                                        const OutlineInputBorder()),
                                                onChanged: (_) {
                                                  setState(
                                                      () => _syncChosen(pn)); // 框数清零自动除名
                                                },
                                              )),
                                          SizedBox(
                                              width: 52,
                                              child: FittedBox(
                                                  fit: BoxFit.scaleDown,
                                                  alignment: Alignment.centerRight,
                                                  child: Text(
                                                  q > 0 &&
                                                          (p?.perBoxQty ?? 0) >
                                                              0
                                                      ? "≈${_fmtInvNum(q * (p!.perBoxQty))}件"
                                                      : q > 0
                                                          ? "$q 框"
                                                          : "",
                                                  maxLines: 1,
                                                  textAlign: TextAlign.right,
                                                  style: const TextStyle(
                                                      fontSize: 10.5,
                                                      color:
                                                          Color(0xFF78909C))))),
                                          IconButton(
                                              tooltip: r ? "取消加急" : "加急此行",
                                              visualDensity:
                                                  VisualDensity.compact,
                                              onPressed: () => setState(() => r
                                                  ? _rushLines.remove(pn)
                                                  : _rushLines.add(pn)),
                                              icon: Icon(
                                                  r
                                                      ? Icons
                                                          .local_fire_department
                                                      : Icons
                                                          .local_fire_department_outlined,
                                                  size: 20,
                                                  color: r
                                                      ? const Color(0xFFE65100)
                                                      : Colors.blueGrey
                                                          .shade300)),
                                          IconButton(
                                              tooltip: "移除该行",
                                              visualDensity:
                                                  VisualDensity.compact,
                                              onPressed: () => setState(() {
                                                _order.remove(pn);
                                                _rushLines.remove(pn);
                                                _qtyCtrl[pn]?.clear();
                                              }),
                                              icon: const Icon(Icons.close,
                                                  size: 18, color: Colors.grey)),
                                        ])));
                              })
                            ])),
                  ])),
            const SizedBox(height: 6),
            const SizedBox(height: 4),
            const Text("从库存勾选 · 填框数自动加入上方清单",
                style: TextStyle(
                    fontSize: 11.5,
                    color: Color(0xFF3949AB),
                    fontWeight: FontWeight.w600)),
            Expanded(
                child: ListView(children: [
              ...list.map((p) {
                final h = widget.hist[p.partNo] ?? [];
                return ListTile(
                  dense: true,
                  visualDensity: const VisualDensity(vertical: -1),
                  title: Text("${p.partNo}  ${p.itemName}",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 13, fontWeight: FontWeight.w600)),
                  subtitle: Text(
                      "在库 ${p.inBoxes} 框${p.perBoxQty > 0 ? " · ≈${_fmtInvNum(p.perBoxQty.roundToDouble())}件/框" : ""}${h.isNotEmpty ? " · 上次 ${_histShort(h.first)}" : ""}",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 11, color: Color(0xFF78909C))),
                  trailing: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                            width: 56,
                            child: TextField(
                              controller: _qtyCtrl.putIfAbsent(
                                  p.partNo, () => TextEditingController()),
                              keyboardType: TextInputType.number,
                              textAlign: TextAlign.center,
                              decoration: const InputDecoration(
                                  hintText: "框数",
                                  isDense: true,
                                  contentPadding: EdgeInsets.symmetric(
                                      horizontal: 2, vertical: 8),
                                  border: OutlineInputBorder()),
                              onChanged: (_) {
                                setState(() => _syncChosen(p.partNo)); // v55 填数即入选/清空即除名
                              },
                            )),
                        const SizedBox(width: 2),
                        const Icon(Icons.chevron_right,
                            size: 18, color: Color(0xFFB0BEC5)),
                      ]),
                );
              }),
            ])),
            const SizedBox(height: 6),
            InkWell(
              onTap: () => setState(() => _rush = !_rush),
              child: Padding(
                  padding:
                      const EdgeInsets.symmetric(vertical: 8, horizontal: 2),
                  child: Row(children: [
                    Icon(
                        _rush ? Icons.check_box : Icons.check_box_outline_blank,
                        size: 20,
                        color: _rush ? Colors.red : Colors.grey),
                    const SizedBox(width: 6),
                    Text("急料（AGV排队优先，到站5分钟催扫广播全员）",
                        style: TextStyle(
                            fontSize: 12.5,
                            color:
                                _rush ? Colors.red.shade700 : Colors.blueGrey,
                            fontWeight:
                                _rush ? FontWeight.bold : FontWeight.normal)),
                  ])),
            ),
            const SizedBox(height: 4),
            if (chosen.isNotEmpty) // ㉖v62 把本单物料存成产线模板，下次一键载入
              Align(
                  widthFactor: 1.0,
                  heightFactor: 1.0, // ㉖v70b 修复：Align 不设 factor 会撑满 Column 剩余空间，致急料与存模板之间大片空白
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                      onPressed: _saveAsTpl,
                      style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          visualDensity: VisualDensity.compact),
                      icon: const Icon(Icons.folder_open_outlined,
                          size: 16, color: Color(0xFF3949AB)),
                      label: const Text("存为产线模板",
                          style:
                              TextStyle(fontSize: 12, color: Color(0xFF3949AB))))),
            Row(children: [
              Expanded(
                  child: OutlinedButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text("取消"))),
              const SizedBox(width: 10),
              Expanded(
                  flex: 2,
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                        backgroundColor: const Color(0xFF515BD4),
                        foregroundColor: Colors.white,
                        disabledBackgroundColor: Colors.grey.shade300),
                    onPressed: chosen.isEmpty
                        ? null
                        : () {
                            final items = _chosenItems(); // v55 按已选顺序提交，行级 rush（靠前=加急）
                            if (items.isEmpty) {
                              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                                  content: Text("所选零件行已无库存，请重新选择")));
                              return;
                            }
                            Navigator.pop(context, {
                              "items": items,
                              "remark": "", // ㉖v68 建单不再收集备注
                              "rush": _rush,
                              "needDate": _needDate,
                              "assigneeId": _assigneeId,
                              "assigneeName": _assigneeId.isEmpty
                                  ? ""
                                  : (_warehouses.firstWhere((w) =>
                                          w["id"] == _assigneeId,
                                          orElse: () => const {})["name"]
                                      ?.toString() ??
                                      "")
                            });
                          },
                    child: Text(
                        chosen.isEmpty ? "请至少填一行数量" : "提交（${chosen.length} 行）"),
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
  final void Function(Map rq)? onAgain; // ㉖ 再来一单：零件号+数量预填新建（下单人=当前账号）
  const _ReqDetailSheet(
      {required this.rq, required this.toast, required this.statusColor, this.onAgain});
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
  Map<String, String> _agvStat = {}; // "起点|站台" → 排队/在途/已到站（哈工库讯RCS实时状态）
  // ㉖v91 统一状态：优先用服务端权威 stage 归并成粗粒度3态（排队/在途/已到站），无 stage 回退 state
  static String agvCoarse(Map q) {
    final stg = q["stage"];
    if (stg is int) {
      if (stg == 1) return "排队";
      if (stg == 5 || stg == 6) return "已到站";
      if (stg == 0) return "完成";
      if (stg == -1) return "失败";
      if (stg == -2) return "取消";
      return "在途";
    }
    final s0 = q["state"]?.toString() ?? "?";
    return s0 == "排队" ? "排队" : s0 == "到站" ? "已到站" : s0 == "完成" ? "完成" : s0 == "失败" ? "失败" : s0 == "取消" ? "取消" : "在途";
  }
  Timer? _agvTimer;

  /// 拉RCS任务表，把已叫AGV的框标出实时配送状态（AGV账号未配置则静默跳过）
  Future<void> _loadAgvStat() async {
    final st = _r["status"].toString();
    final hasCalled = List<Map>.from(_r["items"] ?? [])
        .any((i) => (i["agvCalled"] as List?)?.isNotEmpty == true);
    if (st != 'accepted') return;
    if (!hasCalled) {
      await _loadQueue();
      return;
    } // 没叫过车也要拉队列：别台设备叫的/失败项需可见可清理
    if (await AgvApi.token() == null) {
      await _loadQueue();
      return;
    } // AGV账号未配置：不显示配送状态，静默跳过
    final rs = await Future.wait([AgvApi.tasksRunning(), AgvApi.tasksDone()]);
    final m = <String, String>{};
    for (final t in rs[0] as List<Map>) {
      final rt = AgvApi.taskRoute(t);
      final key =
          "${(rt["startPoint"] ?? "").toString().toUpperCase()}|${(rt["endPoint"] ?? "").toString().toUpperCase()}";
      final nt = AgvApi.nodeTimesOf(t); // [叉出, 到达]：执行中若已叉出，状态带上叉出时刻
      m[key] = t["taskState"] == 1
          ? (nt[0] > 0 ? "在途·${AgvApi.fmtClock(nt[0])}叉出" : "在途")
          : "排队";
    }
    for (final t in rs[1] as List<Map>) {
      final rt = AgvApi.taskRoute(t);
      final key =
          "${(rt["startPoint"] ?? "").toString().toUpperCase()}|${(rt["endPoint"] ?? "").toString().toUpperCase()}";
      if (m.containsKey(key)) continue; // 历史同路线只补空，不覆盖进行中
      final nt = AgvApi.nodeTimesOf(t);
      m[key] = t["taskState"] == 2
          ? (nt[1] > 0 ? "已到站·${AgvApi.fmtClock(nt[1])}" : "已到站")
          : "异常";
    }
    if (!mounted) return;
    setState(() {
      _agvStat = m;
    });
    await _loadQueue();
  }

  /// ㉖v96 队列条计数：按 agvCoarse 粗粒度态统计（与采集页 _qSeg 同语义）
  /// ㉖v97 复检修正：直接用 agvCoarse 归类，删掉多余的手动失败/取消分支——旧写法把"取消"项误计入"失败"数
  int _queueCnt(String coarse) {
    var n = 0;
    for (final q in _queueItems) {
      if (agvCoarse(q) == coarse) n++;
    }
    return n;
  }

  /// 拉本单AGV排队队列状态摘要
  List<Map> _queueItems = [];
  String _queueMode = "dry"; // 服务器真实调度模式：dry演算 / live真实下发
  Future<void> _loadQueue() async {
    final r = await AuthApi.rcsStations();
    if (!mounted || r["ok"] != true) return;
    final mine = List<Map>.from(r["queue"] ?? [])
        .where((q) => q["reqId"] == _r["id"])
        .toList();
    // 活跃队列项注入配送状态：chip key为"起点|站台"，未分配站台时登记在"起点|已叫"下
    final m2 = Map<String, String>.from(_agvStat);
    for (final q in mine) {
      final s0 = q["state"]?.toString() ?? "";
      if (!["排队", "下发中", "已下发", "到站"].contains(s0)) continue;
      final from = (q["fromLoc"] ?? "").toString().toUpperCase(),
          stn = (q["station"] ?? "").toString().toUpperCase();
      if (from.isEmpty) continue;
      final txt = agvCoarse(q); // ㉖v91 统一粗粒度（排队/在途/已到站）
      if (stn.isNotEmpty) m2["$from|$stn"] = txt;
      if (!m2.containsKey("$from|已叫")) m2["$from|已叫"] = txt;
    }
    setState(() {
      _queueItems = mine;
      _agvStat = m2;
      _queueMode = r["mode"]?.toString() ?? "dry";
    });
  }

  /// 队列管理面板：按项状态糅合 RCS 任务同款操作——排队=置顶/取消，失败=取消（重叫即再入队），
  /// 下发中/已下发=撤销任务（服务器先撤 WMAS，未叉出才撤得掉），到站=提示扫码清台；整单清空与关闭移底部拇指区
  void _showQueueSheet() {
    showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (mctx) => SafeArea(
                child: StatefulBuilder(builder: (mctx, setSt) {
              Future<void> _reload() async {
                await _loadQueue();
                if (mctx.mounted) setSt(() {}); // ㉖ 弹层独立 context：外层 setState 不会重建它，操作后必须手动刷新
              }
              Future<void> _doPrio(Map q) async {
                final off = (q["prio"] ?? 0) != 0;
                final r = await AuthApi.agvQueuePrio(q["code"].toString(), off: off);
                if (!mctx.mounted) return;
                widget.toast(r["ok"] == true ? r["msg"].toString() : "失败：${r["msg"]}", err: r["ok"] != true);
                await _reload();
              }
              Future<void> _doCancel(Map q, {bool task = false}) async {
                final yes = await showDialog<bool>(
                    context: mctx,
                    builder: (c2) => AlertDialog(
                            title: Text(task ? "撤销 AGV 任务" : "取消排队"),
                            content: Text(task
                                ? "${q["code"]} 已下发给 AGV。撤销会先请求 WMAS 停单：车还没叉货则撤销成功、任务取消；已叉出会被拒绝（货不能悬半路）。确认撤销？"
                                : "取消 ${q["code"]} 的排队任务？"),
                            actions: [
                              TextButton(onPressed: () => Navigator.pop(c2, false), child: const Text("返回")),
                              FilledButton(style: FilledButton.styleFrom(backgroundColor: Colors.red), onPressed: () => Navigator.pop(c2, true), child: const Text("确定"))
                            ]));
                if (yes != true) return;
                final r = await AuthApi.agvQueueCancel([q["code"].toString()]);
                if (!mctx.mounted) return;
                widget.toast(r["ok"] == true ? (r["msg"].toString().isEmpty ? "已取消" : r["msg"].toString()) : "取消失败：${r["msg"]}", err: r["ok"] != true);
                await _reload();
              }
              Future<void> _clearAll() async {
                final yes = await showDialog<bool>(
                    context: mctx,
                    builder: (c2) => AlertDialog(
                          title: const Text("清空本单队列"),
                          content: const Text("未下发的直接取消；已下发的逐条向 AGV 系统申请撤单（车还没叉货则撤成功，已叉出会保留并告知原因）。确认？"),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(c2, false), child: const Text("取消")),
                            FilledButton(style: FilledButton.styleFrom(backgroundColor: Colors.red), onPressed: () => Navigator.pop(c2, true), child: const Text("清空"))
                          ],
                        ));
                if (yes != true || !mctx.mounted) return;
                final r = await AuthApi.agvQueueCancel(const [], reqId: _r["id"].toString());
                if (!mctx.mounted) return;
                // ㉖v72 有内容必提示；全部撤净才关窗，有被拒/到站项留在弹层让用户看见并逐条处置
                final msg = (r["msg"] ?? "").toString();
                if (r["ok"] != true) { widget.toast("清空失败：${r["msg"] ?? ""}"); return; }
                if (msg.isNotEmpty) widget.toast(msg, err: false);
                final denied = List.from(r["denied"] ?? []);
                if (denied.isEmpty && (r["atStation"] ?? 0) == 0) {
                  if (mctx.mounted) Navigator.pop(mctx);
                } else {
                  await _reload();
                }
              }
              final canCtl = Auth.can("agv_control");
              return Column(mainAxisSize: MainAxisSize.min, children: [
                Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 4),
                    child: Row(children: [
                      const Expanded(
                          child: Text("AGV 排队队列",
                              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16))),
                      Text(_queueItems.isEmpty ? "" : "共${_queueItems.length}项", style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
                    ])),
                Flexible(
                    child: ListView(padding: const EdgeInsets.only(bottom: 4), children: [
                  for (final q in _queueItems)
                    ListTile(
                      dense: true,
                      leading: CircleAvatar(
                          radius: 15,
                          backgroundColor: switch (q["state"]?.toString()) {
                            "排队" => const Color(0xFFE3F2FD),
                            "下发中" => const Color(0xFFFFF3E0),
                            "已下发" => const Color(0xFFFFF3E0),
                            "到站" => const Color(0xFFE8F5E9),
                            _ => const Color(0xFFFAFAFA)
                          },
                          child: Text(
                              switch (q["state"]?.toString()) {
                                "排队" => "排",
                                "下发中" => "运",
                                "已下发" => "运",
                                "到站" => "达",
                                _ => "其"
                              },
                              style: const TextStyle(fontSize: 12))),
                      title: Text(
                          "${(q["prio"] ?? 0) != 0 ? "📌 " : ""}${q["code"]}  ${q["fromLoc"]}${(q["station"] ?? "").toString().isNotEmpty ? " → ${q["station"]}" : ((q["plan"] ?? "").toString().isNotEmpty ? " → ${q["plan"]}（计划）" : "")}",
                          style: const TextStyle(fontSize: 12, fontFamily: "monospace")),
                      subtitle: Text(
                          "${q["state"]}${(q["err"] ?? "").toString().isNotEmpty ? " · ${q["err"]}" : ""}${(q["palletType"] ?? "").toString().isNotEmpty ? " · ${q["palletType"]}" : ""}${q["state"] == "到站" ? " · 已到站台，请扫码发料/入库清台" : ""}${((q["trace"] is List && (q["trace"] as List).isNotEmpty) ? "\n🧭 ${(q["trace"] as List).last}" : "")}",
                          style: TextStyle(fontSize: 11, color: q["state"] == "到站" ? Colors.teal : null)),
                      trailing: !canCtl
                          ? null
                          : Wrap(
                              spacing: 2,
                              children: [
                                if (q["state"] == "排队")
                                  TextButton(
                                      style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8), visualDensity: VisualDensity.compact, minimumSize: Size.zero),
                                      onPressed: () => _doPrio(q),
                                      child: Text((q["prio"] ?? 0) != 0 ? "取消置顶" : "置顶", style: const TextStyle(fontSize: 12, color: Color(0xFF515BD4)))),
                                if (q["state"] == "排队" || q["state"] == "失败")
                                  TextButton(
                                      style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8), visualDensity: VisualDensity.compact, foregroundColor: Colors.red),
                                      onPressed: () => _doCancel(q),
                                      child: const Text("取消", style: TextStyle(fontSize: 12))),
                                if (q["state"] == "下发中" || q["state"] == "已下发")
                                  TextButton(
                                      style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 8), visualDensity: VisualDensity.compact, foregroundColor: Colors.red.shade800),
                                      onPressed: () => _doCancel(q, task: true),
                                      child: const Text("撤销任务", style: TextStyle(fontSize: 12))),
                              ]),
                    ),
                  if (_queueItems.isEmpty)
                    const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(
                            child: Text("本单暂无队列（点行内「一键叫车」入队）",
                                style: TextStyle(color: Colors.grey)))),
                ])),
                Padding(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                    child: Row(children: [
                      if (canCtl)
                        Expanded(
                            child: OutlinedButton.icon(
                                style: OutlinedButton.styleFrom(foregroundColor: Colors.red.shade700, side: BorderSide(color: Colors.red.shade200), padding: const EdgeInsets.symmetric(vertical: 12)),
                                onPressed: _queueItems.isEmpty ? null : _clearAll,
                                icon: const Icon(Icons.delete_sweep_outlined, size: 18),
                                label: const Text("清空本单"))),
                      if (canCtl) const SizedBox(width: 10),
                      Expanded(
                          child: FilledButton(
                              style: FilledButton.styleFrom(backgroundColor: const Color(0xFF515BD4), padding: const EdgeInsets.symmetric(vertical: 12)),
                              onPressed: () => Navigator.pop(mctx),
                              child: const Text("关闭"))),
                    ])),
              ]);
            })));
  }

  /// 一键叫车：本行全部货架框入服务器队列，自动分配空闲站台排队下发
  Future<void> _queueAll(Map item, List<Map> boxes) async {
    final agvMap = <String>{
      for (final e in List<Map>.from(item["agvCalled"] ?? []))
        e["c"]?.toString().toUpperCase() ?? ""
    };
    final issuedSet = _issuedCodesOf(item).map((e) => e.toUpperCase()).toSet();
    final its = <Map>[];
    for (final b in boxes) {
      final l = b["l"]?.toString() ?? "";
      if (!l.startsWith('NB02-') || l.contains('-CK-')) continue;
      final cs = List<String>.from(
          (b["codes"] as List? ?? const []).map((e) => e.toString()));
      if (cs.isEmpty || cs.any((c) => issuedSet.contains(c.toUpperCase())))
        continue;
      if (cs.any((c) => agvMap.contains(c.toUpperCase()))) continue;
      its.add({
        "code": cs.first,
        "fromLoc": l,
        "palletType": b["f"]?.toString() ?? "",
        "partNo": item["partNo"]?.toString() ?? ""
      });
    }
    if (its.isEmpty) {
      widget.toast("没有可叫车的货架框（已叫过的请点标签看状态）");
      return;
    }
    final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("一键叫车"),
              content: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text(
                    "将 ${its.length} 框加入AGV队列？\n系统自动分配空闲站台，台满自动排队，空了就下发。\n当前模式：${_queueMode == "live" ? "⚠️ 真实下发（入队后会真的叫AGV）" : "演算（只排计划不下发）"}"),
                // ㉖v82 严重超发显式确认：红字列出多搬件数，防"为补109件白搬2400大筐"
                if (((item["suggest"] as Map?)?["severeOver"]) == true)
                  Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                          "⛔ 注意严重超发：本轮整筐合计 ${_fmtInvNum(((item["suggest"] as Map?)?["total"] as num?)?.toDouble() ?? 0)} 件，超出需求 ${_fmtInvNum(((item["suggest"] as Map?)?["over"] as num?)?.toDouble() ?? 0)} 件——叫车后要么白搬大筐，要么人工拆框。确定还要叫吗？",
                          style: const TextStyle(
                              color: Color(0xFFC62828),
                              fontWeight: FontWeight.w700,
                              fontSize: 12))),
              ]),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: ((item["suggest"] as Map?)?["severeOver"]) == true ? const Color(0xFFC62828) : null),
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("加入队列"))
              ],
            ));
    if (yes != true || !mounted) return;
    setState(() => _busy = true);
    final r = await AuthApi.agvQueueEnqueue(
        reqId: _r["id"].toString(), reqNo: _r["no"].toString(), items: its);
    if (!mounted) return;
    setState(() => _busy = false);
    widget.toast(r["ok"] == true ? r["msg"].toString() : "排队失败：${r["msg"]}",
        err: r["ok"] != true);
    await _loadQueue();
  }

  @override
  void initState() {
    super.initState();
    _r = Map.from(widget.rq);
    final tl = _r["toLoc"];
    if (tl is Map)
      _to = tl.map((k, v) => MapEntry(k.toString(), v?.toString() ?? ""));
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
    WidgetsBinding.instance.addPostFrameCallback((_) => _loadAgvStat());
    _agvTimer =
        Timer.periodic(const Duration(seconds: 20), (_) => _loadAgvStat());
  }

  @override
  void dispose() {
    _scanCtrl.dispose();
    _scanFocus.dispose();
    _locCtrl.dispose();
    _locFocus.dispose();
    _agvTimer?.cancel();
    super.dispose();
  }

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
    return List.from(item["issued"] ?? [])
        .map((x) => x is Map ? (x["c"]?.toString() ?? "") : x.toString())
        .toList();
  }

  /// 建议框点击：有车辆控制权限且NB02货架位 → 弹叫AGV出库窗；无权限/地面/其他 → 复制标签去扫码
  void _onSuggestTap(
      String code, String loc, String ftype, String partNo) async {
    if (loc.startsWith('NB02-') &&
        !loc.contains('-CK-') &&
        Auth.can("agv_control")) {
      final stn = await showDialog<String>(
          context: context,
          builder: (_) => AgvCallDialog(
              fromLoc: loc,
              containerType: ftype,
              label: code,
              toast: widget.toast));
      if (stn == null || !mounted) return;
      final res = await AuthApi.reqAction(_r["id"].toString(), "agv",
          {"partNo": partNo, "barcode": code, "station": stn});
      if (!mounted) return;
      if (res["ok"] == true)
        setState(() => _r = Map.from(res["req"]));
      else
        widget.toast("已叫车，但登记失败：${res["msg"]}"); // 不影响AGV任务本身
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
    final flat = List<Map>.from(
        sg["flatBoxes"] ?? sg["boxes"] ?? []); // 兼容旧服务器：无 flatBoxes 时退回标签级
    final total = (sg["total"] as num?)?.toDouble() ?? 0;
    final over = (sg["over"] as num?)?.toDouble() ?? 0; // ㉖v69 整框发料超发件数（多备件，剩余可返架）
    final inStock = (sg["inStock"] as num?)?.toInt() ?? 0;
    final noInfo = (sg["noInfoQty"] as num?)?.toInt() ?? 0;
    // ㉖v79c 发齐（剩余需求≤0）：服务器返回done标记，显示完成态不再列框（旧版发满还挂着建议框，照着叫就超发）
    if (sg["done"] == true) {
      // ㉖v92b 已发齐但"已叫车未扫码"的框继续显示可扫：框已应本单叫车在途/到站，藏码会逼仓管走直调拆单（10/24复盘）
      final pend = List<Map>.from(sg["calledPending"] ?? []);
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                  // ㉖v82 修显示bug：done时total/need均=0，原样打出"已发齐 0 件"——应显示真实已发件数
                  pend.isEmpty
                      ? "✅ 该行已发齐 ${_fmtInvNum(_issuedQtyOf(item))} 件——无需再叫车，点「转MES出库」收尾"
                      : "✅ 该行已发齐 ${_fmtInvNum(_issuedQtyOf(item))} 件，但还有 ${pend.length} 个已叫车标签未扫码",
                  style: TextStyle(
                      fontSize: 11,
                      color: pend.isEmpty
                          ? const Color(0xFF2E7D32)
                          : const Color(0xFFE65100),
                      fontWeight: FontWeight.w600)),
              if (pend.isNotEmpty) ...[
                const Padding(
                    padding: EdgeInsets.only(top: 2, bottom: 3),
                    child: Text(
                        "🚗 框已在途/到站：点标签选中本行并复制去扫码（计入本单，多发部分转单确认窗可取消勾选→自动撤扫返架）",
                        style: TextStyle(
                            fontSize: 10.5, color: Color(0xFFE65100)))),
                Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: pend.map<Widget>((b) {
                      final c0 = b["c"]?.toString().toUpperCase() ?? "";
                      if (c0.isEmpty) return const SizedBox.shrink();
                      return InkWell(
                          onTap: () {
                            setState(() => _issuePart =
                                item["partNo"].toString());
                            Clipboard.setData(ClipboardData(text: c0));
                            widget.toast("已选中本行并复制 ${c0}，扫码枪直接扫标签也行",
                                err: false);
                          },
                          child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 7, vertical: 3),
                              decoration: BoxDecoration(
                                  color: const Color(0xFFFFF3E0),
                                  borderRadius: BorderRadius.circular(6),
                                  border: Border.all(
                                      color: const Color(0xFFFFB74D))),
                              child: Text(
                                  "${c0}×${_fmtInvNum((b["q"] as num?)?.toDouble() ?? 0)} ${(b["l"] ?? "").toString().replaceAll('NB02-', '')}",
                                  style: const TextStyle(
                                      fontSize: 11,
                                      fontFamily: "monospace",
                                      color: Color(0xFFE65100),
                                      fontWeight: FontWeight.w700))));
                    }).toList()),
              ],
            ]),
      );
    }
    if (flat.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(
            inStock == 0
                ? (noInfo > 0
                    ? "⚠ 账本有 $noInfo 框但缺物料信息，PDA「位置登记」批量补齐后可出建议"
                    : "⚠ 同步账本中没有该零件的在架框（可能未同步或无货，可跳过）")
                : "⚠ 账本有 ${inStock + noInfo} 框但都缺件数信息，建议先补齐",
            style: const TextStyle(fontSize: 11, color: Colors.deepOrange)),
      );
    }
    final canCtl = Auth.can("agv_control"); // 叫车是车辆控制权限：物料员只见建议不露叫车按钮
    // ㉖v82 严重超发警告：整筐最小方案也超发过需求本身（如补109件却要叫2400大筐）——红字劝退，建议改小批凑单或留待下次
    final severeOver = sg["severeOver"] == true;
    // 同货位标签总数（>1 即同托多码），用于 chip 上标注"同托多码"
    final perBoxCodes = <String, int>{};
    for (final b in boxes) {
      final lk = b["l"]?.toString() ?? "";
      perBoxCodes[lk] =
          (perBoxCodes[lk] ?? 0) + ((b["codes"] as List?)?.length ?? 1);
    }
    return Container(
      margin: const EdgeInsets.only(top: 6),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
          color: const Color(0xFFF0F4FF),
          borderRadius: BorderRadius.circular(8)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(
              child: Text(
                  "💡 取货建议（FIFO）：在架 $inStock 框，还差 ${_fmtInvNum((sg["left"] as num?)?.toDouble() ?? (sg["need"] as num?)?.toDouble() ?? 0)} 件，本轮建议 ${boxes.length} 框 ≈ ${_fmtInvNum(total)} 件${over > 0 ? "（含超发 ${_fmtInvNum(over)} 件，整框发料余料可返架）" : ""} · ${canCtl ? '点标签单独叫车' : '点标签复制'}",
                  style: const TextStyle(
                      fontSize: 11,
                      color: Color(0xFF3949AB),
                      fontWeight: FontWeight.w600))),
          if (canCtl &&
              boxes.any((b) =>
                  (b["l"]?.toString().startsWith('NB02-') ?? false) &&
                  (b["l"]?.toString().contains('-CK-') ?? true) == false))
            TextButton(
                style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    visualDensity: VisualDensity.compact),
                onPressed: _busy ? null : () => _queueAll(item, boxes),
                child: const Text("一键叫车",
                    style:
                        TextStyle(fontSize: 11, fontWeight: FontWeight.bold))),
        ]),
        // ㉖v82 严重超发警告行：整筐最小方案超发仍大于需求本身（如补109件却只能叫2400大筐）
        if (severeOver)
          Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(
                  "⛔ 严重超发：只差 ${_fmtInvNum((sg["left"] as num?)?.toDouble() ?? (total - over))} 件，最小整筐却要 ${_fmtInvNum(total)} 件，白搬 ${_fmtInvNum(over)} 件！\n建议：等凑更大单再叫／改叫地面小框／人工拆框发料，别为小尾巴搬大筐",
                  style: const TextStyle(
                      fontSize: 11,
                      color: Color(0xFFC62828),
                      fontWeight: FontWeight.w700))),
        // ㉖v96 行内队列条删除：多零件行时每行重复显示同一条统计（10/25 用户"太重复"），改整单顶部常驻一条
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
              final stat = agv.isEmpty
                  ? ""
                  : (_agvStat["${loc.toUpperCase()}|${agv.toUpperCase()}"] ??
                      "");
              final arrived = stat.startsWith("已到站");
              final boxColor = agv.isEmpty
                  ? null
                  : (arrived
                      ? const Color(0xFF2E7D32)
                      : const Color(0xFFE65100));
              return InkWell(
                onTap: () {
                  // 有活跃AGV任务才拦截重复叫车；无任务在跑的旧标记（失败/取消残留）点击直接重叫
                  if (agv.isNotEmpty && stat.isNotEmpty) {
                    widget.toast("框 $code 已叫AGV → 站台 $agv（$stat），请勿重复叉取",
                        err: false);
                    return;
                  }
                  _onSuggestTap(code, loc, (b["f"] ?? "").toString(),
                      item["partNo"]?.toString() ?? "");
                },
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(
                    color: agv.isEmpty
                        ? Colors.white
                        : (arrived
                            ? const Color(0xFFE8F5E9)
                            : const Color(0xFFFFF3E0)),
                    border:
                        Border.all(color: boxColor ?? const Color(0xFFC7CDF0)),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Text(
                      "${agv.isEmpty ? "" : "🚗${stat.isEmpty ? "已叫" : stat} · "}$code @ $loc${agv.isEmpty ? "" : "→$agv"}${qv > 0 ? " ${_fmtInvNum(qv)}件" : ""}${lot.isNotEmpty ? " 批$lot" : ""}${multi ? " ·同托多码" : ""}", // ㉖v94p 货位后追加站台号（旧版台号缺失只显示"已叫"，仓管不知道去哪个台取）
                      style: TextStyle(
                          fontSize: 11,
                          fontFamily: "monospace",
                          color: agv.isEmpty
                              ? const Color(0xFF1A237E)
                              : boxColor)),
                ),
              );
            }),
        ]),
        if (noInfo > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text("另有 $noInfo 框缺件数/批次（未补齐），建议按货位就近补拣",
                style: const TextStyle(fontSize: 10.5, color: Colors.brown)),
          ),
      ]),
    );
  }

  /// 扫码框提交：查 MES 取该箱件数，按件数计入目标零件行；发满自动切下一行
  /// MES 不可用时可走「应急人工登记」（记件数+原因+留痕），事后转单自动补查 MES 完成补转
  Future<void> _scanIssue() async {
    final code = _scanCtrl.text.trim();
    _scanCtrl.clear();
    if (code.isEmpty) return;
    if (_busy) return;
    final items = List<Map>.from(_r["items"] ?? []);
    var target = items.firstWhere((e) => e["partNo"] == _issuePart,
        orElse: () => const {});
    if (target.isEmpty) {
      widget.toast("请先点击选择要发料的零件行");
      _refocusScan();
      return;
    }
    if (_issuedCodesOf(target).contains(code)) {
      widget.toast("标签 $code 已扫过");
      _refocusScan();
      return;
    }
    setState(() => _busy = true);
    String? scanErr;
    bool emEligible = false; // MES取不到数才允许应急；零件号不符等真实冲突仍硬拦
    double boxQty = 0;
    String scanLot = ""; // 扫入框批次（MES LOT_NO），FIFO 比对用
    Map<String, dynamic>? fifoMark; // 非空=用户确认过FIFO违反，随scan上报留痕
    _lastBoxData = null;
    try {
      // 查 MES 拿该箱件数与零件号（复用采集页查询通道：失效自动重登）
      final mes = await mesQueryLabel(code);
      if (mes["ok"] != true) {
        scanErr = "标签 $code MES查询失败：${mes["msg"]}";
        emEligible = true;
      } else {
        final mp = mes["partNo"]?.toString() ?? "";
        if (mp != target["partNo"]) {
          scanErr = "该箱零件号 $mp 与所选行 ${target["partNo"]} 不符";
        }
        boxQty = (mes["qty"] as num?)?.toDouble() ?? 0;
        scanLot = (mes["lotNo"] ?? "").toString().trim();
        // 抓转MES所需完整标签数据（物料ID/编码/名称/UOM）；失败不阻塞发料记账，转单时再补查
        try {
          final d =
              await mesGetData("/api/v1/rawtransfer/GetBarCodeInfoOnHand", {
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
      emEligible = true;
    }
    final ledOld = await _globalIsar.shelfPlacements
        .filter()
        .goodsCodeEqualTo(code.toUpperCase())
        .findAll();
    final fromLoc = ledOld.isNotEmpty ? ledOld.first.loc : "";
    Map<String, dynamic>? em; // 应急登记结果 {qty, why}；null=走正常流程或放弃
    if (scanErr != null) {
      setState(() => _busy = false);
      if (!emEligible || !mounted) {
        // 零件号不符等：直接报错，不放开应急（㉖v96 升级为弹窗——toast 在连续扫码节奏下无感知，与 v92c 扫重弹窗同族病）
        if (mounted) {
          await showDialog<void>(
              context: context,
              builder: (ctx) => AlertDialog(
                    icon: const Icon(Icons.swap_horiz, color: Colors.red, size: 36),
                    title: const Text("扫入标签与本行零件不符"),
                    content: Text("$scanErr\n\n当前发料行：${target["partNo"]} ${target["itemName"] ?? ""}\n\n请核对实物标签：拿错框了，或该标签属于本单其他零件行（可点击对应行切换后再扫）。"),
                    actions: [
                      FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text("知道了"))
                    ],
                  ));
          _refocusScan();
        }
        return;
      }
      em = await _emergencyIssue(code, fromLoc); // 弹应急人工登记窗
      if (!mounted) return;
      if (em == null) {
        widget.toast(scanErr);
        _refocusScan();
        return;
      } // 用户放弃应急
      boxQty = (em["qty"] as num?)?.toDouble() ?? 0;
    }
    // 🟡 FIFO 强控：扫入批次晚于账本该零件最早批次 → 黄色警告，确认才放行（本地+单据历史双留痕）；应急登记时批次未知不判
    if (em == null) {
      final sg = target["suggest"];
      String oldest = "";
      if (sg is Map) {
        for (final bx in List<Map>.from(sg["boxes"] ?? [])) {
          final bb = (bx["b"] ?? "").toString().trim();
          if (bb.isNotEmpty) {
            oldest = bb;
            break;
          }
        }
      }
      if (scanLot.isNotEmpty &&
          oldest.isNotEmpty &&
          scanLot.compareTo(oldest) > 0) {
        if (!mounted) return;
        setState(() => _busy = false);
        final go = await showDialog<bool>(
            context: context,
            builder: (ctx) => AlertDialog(
                  icon: const Icon(Icons.warning_amber_rounded,
                      color: Colors.amber, size: 36),
                  backgroundColor: const Color(0xFFFFF8E1),
                  title: const Text("非最早批次（先进先出提醒）"),
                  content: Text(
                      "标签 $code 批次 $scanLot\n该零件账本最早批次为 $oldest\n\n正常应先发最早批。确认仍发 $scanLot？（会写入审计留痕）"),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, false),
                        child: const Text("取消，改拣最早批")),
                    FilledButton(
                        style: FilledButton.styleFrom(
                            backgroundColor: Colors.amber,
                            foregroundColor: Colors.black87),
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text("确认继续"))
                  ],
                ));
        if (go != true) {
          if (mounted) {
            widget.toast("已取消：请按先进先出先拣批次 $oldest");
            _refocusScan();
          }
          return;
        }
        fifoMark = {"lot": scanLot, "oldest": oldest, "ok": 1};
        LocalLog.op('FIFO违反', '$code 批$scanLot（最早$oldest）确认继续');
        if (!mounted) return;
      }
    }
    setState(() => _busy = true);
    final res = await AuthApi.reqAction(_r["id"].toString(), "scan", {
      "barcode": code,
      "partNo": target["partNo"],
      "qty": boxQty,
      "fromLoc": fromLoc,
      if (em != null) "emergency": true,
      if (em != null) "why": em["why"],
      if (fifoMark != null) "fifo": fifoMark,
    });
    if (!mounted) return;
    setState(() => _busy = false);
    if (res["ok"] != true) {
      final _msg = (res["msg"] ?? "发料失败").toString();
      // ㉖v92c 扫重/扫错/行锁定这类冲突必须弹窗确认——toast 会被连续扫码节奏淹没（10/24 复盘：扫错码无感知）
      if (mounted) {
        await showDialog<void>(
            context: context,
            builder: (ctx) => AlertDialog(
                  icon: const Icon(Icons.block, color: Colors.red, size: 36),
                  title: const Text("该标签不能发料"),
                  content: Text("$_msg\n\n请核对实物标签与本单零件行，确认后关闭。"),
                  actions: [
                    FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text("知道了"))
                  ],
                ));
      }
      _refocusScan();
      return;
    }
    setState(() {
      _r = Map.from(res["req"]);
      _boxData[code] = _lastBoxData ?? {}; // 缓存该箱 MES 数据供转单组报文（应急时为空，转单再补查）
    });
    final items2 = List<Map>.from(_r["items"] ?? []);
    final nowT = items2.firstWhere((e) => e["partNo"] == _issuePart,
        orElse: () => const {});
    final tGot = nowT.isEmpty ? 0.0 : _issuedQtyOf(nowT);
    final tNeed = (nowT["qty"] as num?)?.toDouble() ?? 0.0;
    widget.toast(
        "${em != null ? "⚠️应急已发" : "已发"} $code（$boxQty 件）累计 ${_fmtInvNum(tGot)}/${_fmtInvNum(tNeed)}${fromLoc.isNotEmpty ? " · 原$fromLoc 已拣下" : ""}",
        err: false);
    if (fromLoc.isNotEmpty)
      ledgerRemoveAndPush([code.toUpperCase()]); //㉖v59 方案B：逐码发料→单码拣下（同托兄弟码各自扫各自消，不再整框连坐）
    if (tGot >= tNeed) {
      final next = items2.firstWhere(
          (e) => _issuedQtyOf(e) < ((e["qty"] as num?)?.toDouble() ?? 0),
          orElse: () => const {});
      if (!next.isEmpty) setState(() => _issuePart = next["partNo"].toString());
    }
    _refocusScan();
  }

  /// MES 不可用时的应急人工登记窗：核对件数 + 填原因（留审计痕迹），返回 {qty, why}，取消返回 null
  Future<Map<String, dynamic>?> _emergencyIssue(
      String code, String fromLoc) async {
    final qtyCtrl = TextEditingController();
    final whyCtrl = TextEditingController();
    final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("⚠️ MES 不可用 · 应急发料登记",
                  style: TextStyle(color: Colors.deepOrange)),
              content: SingleChildScrollView(
                  child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                    Text(
                        "标签 $code 无法向 MES 查询（网络/接口异常）。应急登记会本地记账并${fromLoc.isNotEmpty ? "拣下原货位 $fromLoc，" : ""}事后转单时自动补查 MES 完成转单。"),
                    const SizedBox(height: 8),
                    TextField(
                        controller: qtyCtrl,
                        keyboardType: TextInputType.number,
                        autofocus: true,
                        decoration: const InputDecoration(
                            labelText: "本箱件数（务必按实物核对）",
                            isDense: true,
                            border: OutlineInputBorder())),
                    const SizedBox(height: 8),
                    TextField(
                        controller: whyCtrl,
                        decoration: const InputDecoration(
                            labelText: "应急原因（必填·入审计留痕）",
                            isDense: true,
                            border: OutlineInputBorder())),
                  ])),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    style: FilledButton.styleFrom(
                        backgroundColor: Colors.deepOrange),
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认应急登记"))
              ],
            ));
    if (yes != true) return null;
    final q = double.tryParse(qtyCtrl.text.trim()) ?? 0;
    final why = whyCtrl.text.trim();
    if (q <= 0) {
      widget.toast("请填写有效的本箱件数");
      return null;
    }
    if (why.isEmpty) {
      widget.toast("请填写应急原因");
      return null;
    }
    LocalLog.op('应急发料', '$code · $why');
    return {"qty": q, "why": why};
  }

  void _refocusScan() {
    _scanFocus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scanFocus.requestFocus();
    });
  }

  /// 行级转MES：把该行已扫箱真实直调转单（申请600实扫500也照转500），成功后回写服务器+落出库台账
  Future<void> _transferRow(Map item) async {
    if (_busy) return;
    final partNo = item["partNo"].toString();
    var codes = _issuedCodesOf(item);
    if (codes.isEmpty) {
      widget.toast("该行还没有扫入标签");
      return;
    }
    if (_to.isEmpty) {
      widget.toast("请先扫描转入货位");
      return;
    }
    // ㉖v82b 转单确认窗（用户拍板）：逐框显示 标签/件数/原货位 可勾选——不想发的框取消勾选，
    // 确认后自动撤扫退回在架（货没走就不该记账出库），只转勾选的框；严格FIFO下多叫的筐在这人工裁决
    var item2 = Map.from(item);
    final issuedRows = List.from(item2["issued"] ?? []).whereType<Map>().toList();
    // ㉖v92b 转单前最后一道提醒：行转单后锁定，已叫未扫的框就再也记不进本单（只能直调/返架）——先扫再转
    final cpPend = (((item2["suggest"] as Map?)?["calledPending"]) as List?) ?? const [];
    final sel = <String, bool>{for (final x in issuedRows) (x["c"]?.toString().toUpperCase() ?? ""): true};
    sel.remove("");
    double selQty() => issuedRows
        .where((x) => sel[(x["c"]?.toString().toUpperCase() ?? "")] == true)
        .fold(0.0, (s, x) => s + ((x["q"] as num?)?.toDouble() ?? 0));
    if (!mounted) return;
    final ok0 = await showDialog<bool>(
        context: context,
        builder: (dctx) => StatefulBuilder(
            builder: (bctx, setSt) => AlertDialog(
                  title: Text("确认发出框 · $partNo", style: const TextStyle(fontSize: 15)),
                  content: SingleChildScrollView(
                      child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                        Text(
                            "需求 ${_fmtInvNum((item2["qty"] as num?)?.toDouble() ?? 0)} 件 · 已扫 ${issuedRows.length} 框 ${_fmtInvNum(_issuedQtyOf(item2))} 件"),
                        if (cpPend.isNotEmpty)
                          Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                  "⛔ 还有已叫车未扫标签：${cpPend.map((e) => e["c"]).join(' / ')}——转单后本行锁定，这些框只能走直调或返架！建议先扫码再转",
                                  style: const TextStyle(
                                      fontSize: 11,
                                      color: Color(0xFFC62828),
                                      fontWeight: FontWeight.w700))),
                        const Text("取消勾选 = 该框不发，自动退回在架（下次可再叫）",
                            style: TextStyle(fontSize: 11, color: Colors.grey)),
                        const SizedBox(height: 6),
                        ...issuedRows.map((x) {
                          final c0 = x["c"]?.toString().toUpperCase() ?? "";
                          if (c0.isEmpty) return const SizedBox.shrink();
                          return CheckboxListTile(
                              dense: true,
                              contentPadding: EdgeInsets.zero,
                              controlAffinity: ListTileControlAffinity.leading,
                              value: sel[c0] == true,
                              onChanged: (v) => setSt(() => sel[c0] = v == true),
                              title: Text(
                                  "$c0  ${_fmtInvNum((x["q"] as num?)?.toDouble() ?? 0)} 件",
                                  style: const TextStyle(
                                      fontSize: 13, fontFamily: "monospace")),
                              subtitle: Text(
                                  "原货位 ${(x["l"]?.toString().isNotEmpty ?? false) ? x["l"] : "—"}${x["e"] == 1 ? " · 应急发料" : ""}",
                                  style: const TextStyle(fontSize: 11)));
                        }),
                        const SizedBox(height: 4),
                        Text(
                            "将转 ${sel.values.where((v) => v).length} 框 ${_fmtInvNum(selQty())} 件 → ${_to["LOC_NAME"]}\n转单即 MES 移库，不可撤销（退回需反向再转）",
                            style: const TextStyle(
                                fontSize: 12,
                                color: Color(0xFF3949AB),
                                fontWeight: FontWeight.w600)),
                      ])),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(dctx, false),
                        child: const Text("取消")),
                    FilledButton(
                        onPressed: () => Navigator.pop(dctx, true),
                        child: const Text("确认发出并转单")),
                  ],
                )));
    if (ok0 != true || !mounted) return;
    // 取消勾选的框 → 逐框撤扫退回在架（服务器 unscan：移除已发记录+账本复挂+清墓碑）
    for (final x in issuedRows) {
      final c0 = x["c"]?.toString().toUpperCase() ?? "";
      if (c0.isEmpty || sel[c0] == true) continue;
      final ur = await AuthApi.reqAction(_r["id"].toString(), "unscan",
          {"partNo": partNo, "barcode": c0});
      if (!mounted) return;
      if (ur["ok"] != true) {
        widget.toast("撤扫 $c0 失败：${ur["msg"]}");
        return;
      }
      if (ur["req"] is Map) {
        final its = List<Map>.from((ur["req"] as Map)["items"] ?? []);
        final t2 = its.where((e) => e["partNo"]?.toString() == partNo);
        if (t2.isNotEmpty) {
          _r = Map.from(ur["req"]);
          item2 = Map.from(t2.first);
        }
      }
      widget.toast("↩️ $c0 已撤扫退回在架", err: false);
    }
    codes = _issuedCodesOf(item2);
    if (codes.isEmpty) {
      widget.toast("至少保留一框发出（已全部撤扫）");
      setState(() {});
      return;
    }
    item = item2;
    // ㉖v79c SYS 补录框（源表无标签号、MES 从未建过码）：转MES必"查不到在库信息"死路——
    // 货实际已发走，走本地转单：不回传 MES，只回写行 transferred + 落出库台账，仓库账闭环
    if (codes.every((c) => c.toUpperCase().startsWith('SYS'))) {
      final yes = await showDialog<bool>(
          context: context,
          builder: (dctx) => AlertDialog(
                icon: const Icon(Icons.inventory_2_outlined,
                    color: Colors.teal, size: 32),
                title: const Text("本地转单（补录框 · 不回传 MES）"),
                content: Text(
                    "零件号 $partNo\n已扫 ${codes.length} 箱（${_fmtInvNum(_issuedQtyOf(item))} 件）为账本补录标签（SYS 号），MES 无此码。\n\n本操作仅在本系统闭环出库账（转单+出库台账），不同步 MES。产线对账如需 MES 记录，请让计划按实补打标签。确认？"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(dctx, false),
                      child: const Text("取消")),
                  TextButton(
                      onPressed: () => Navigator.pop(dctx, true),
                      child: const Text("确认本地转单"))
                ],
              ));
      if (yes != true || !mounted) return;
      setState(() => _busy = true);
      try {
        final res = await AuthApi.reqAction(
            _r["id"].toString(), "transfer", {"partNo": partNo});
        if (res["ok"] != true)
          throw Exception("服务器回写失败：${res["msg"]}");
        final fromLocs = <String, String>{};
        final bars = <Map<String, dynamic>>[];
        for (final x in List.from(item["issued"] ?? [])) {
          if (x is! Map) continue;
          final c0 = x["c"]?.toString().toUpperCase() ?? "";
          final l0 = x["l"]?.toString() ?? "";
          if (c0.isEmpty) continue;
          if (l0.isNotEmpty) fromLocs[c0] = l0;
          bars.add({
            "SCAN_BARCODE": c0,
            "MITEM_CODE": partNo,
            "QTY": (x["q"] as num?)?.toDouble() ?? 0,
          });
        }
        final rows = [
          {
            "PART_NO": partNo,
            "MITEM_CODE": partNo,
            "MITEM_NAME": item["itemName"]?.toString() ?? "",
            "REQ_QTY": _issuedQtyOf(item),
            "Barcodes": bars,
          }
        ];
        final ob = await createOutboundOrder(rows, _to,
            linkReqNo: _r["no"].toString(), fromLocs: fromLocs);
        LocalLog.op('本地转单', '$partNo ${ob.orderNo}（SYS补录框）');
        widget.toast(
            "已本地转单（${_fmtInvNum(_issuedQtyOf(item))}件），出库单 ${ob.orderNo}",
            err: false);
        setState(() {
          _r = Map.from(res["req"]);
          _issuePart = null;
        });
      } catch (e) {
        widget.toast("本地转单失败：${e.toString().replaceFirst("Exception: ", "")}");
      } finally {
        if (mounted) setState(() => _busy = false);
      }
      return;
    }
    final yes = await showDialog<bool>(
        context: context,
        builder: (dctx) => AlertDialog(
              title: const Text("转 MES 出库"),
              content: Text(
                  "零件号 $partNo\n将把已扫的 ${codes.length} 箱（${_fmtInvNum(_issuedQtyOf(item))} 件）真实转单到：\n${_to["WAREHOUSE_NAME"]}/${_to["DISTRICT_NAME"]}/${_to["LOC_NAME"]}\n\n转单即 MES 移库，不可撤销（退回需反向再转）。确认提交？"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dctx, false),
                    child: const Text("取消")),
                TextButton(
                    onPressed: () => Navigator.pop(dctx, true),
                    child: const Text("确认转单"))
              ],
            ));
    if (yes != true || !mounted) return;
    setState(() => _busy = true);
    try {
      // 1. 组报文：逐箱补齐 MES 数据（缓存缺失的现场补查一次）
      final boxes = <Map<String, dynamic>>[];
      for (final c in codes) {
        var d = _boxData[c];
        if (d == null || (d["MITEM_ID"] ?? "").toString().isEmpty) {
          final fresh =
              await mesGetData("/api/v1/rawtransfer/GetBarCodeInfoOnHand", {
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
            "MITEM_ID": d["MITEM_ID"],
            "MITEM_CODE": d["MITEM_CODE"],
            "MITEM_NAME": d["MITEM_DESC"] ?? d["MITEM_NAME"] ?? "",
            "UOM": d["UOM"] ?? "",
            "REQ_QTY": q,
            "Barcodes": [d],
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
      await mesReq("POST", "/api/v1/rawtransfer/SaveTRBarcodes",
          body: {"details": details});
      // 3. 回写服务器行级 transferred（幂等），并落出库台账关联领料单号
      final res = await AuthApi.reqAction(
          _r["id"].toString(), "transfer", {"partNo": partNo});
      if (res["ok"] != true)
        throw Exception("MES已转单，但服务器回写失败：${res["msg"]}（请重开该单重试，MES侧勿重复转）");
      try {
        final fromLocs = <String, String>{};
        for (final x in List.from(item["issued"] ?? [])) {
          if (x is Map) {
            final c0 = x["c"]?.toString().toUpperCase() ?? "";
            final l0 = x["l"]?.toString() ?? "";
            if (c0.isNotEmpty && l0.isNotEmpty) fromLocs[c0] = l0;
          }
        }
        // 叫过AGV的框→展开同托兄弟码：扫其中任一码该框都算"AGV叉来"
        final agvCodes = <String>{};
        for (final e in List<Map>.from(item["agvCalled"] ?? [])) {
          final c1 = e["c"]?.toString().toUpperCase() ?? "";
          if (c1.isEmpty) continue;
          agvCodes.add(c1);
          try {
            final ex = await _globalIsar.recordExtras
                .filter()
                .goodsCodeEqualTo(c1)
                .findFirst();
            final pid = ex?.palletId ?? "";
            if (pid.isNotEmpty) {
              final mates = await _globalIsar.recordExtras
                  .filter()
                  .palletIdEqualTo(pid)
                  .findAll();
              agvCodes.addAll(mates.map((m) => m.goodsCode.toUpperCase()));
            }
          } catch (_) {}
        }
        final ob = await createOutboundOrder(
            rows.map((r) => {...r, "PART_NO": partNo}).toList(), _to,
            linkReqNo: _r["no"].toString(),
            fromLocs: fromLocs,
            agvCodes: agvCodes);
        LocalLog.op('转MES', '${item["partNo"]} ${ob.orderNo}');
        widget.toast(
            "已转MES（${_fmtInvNum(_issuedQtyOf(item))}件），出库单 ${ob.orderNo}",
            err: false);
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
  /// ㉖v79c 独立 _locBusy：旧版与发料/叫车共用 _busy，且入口先 clear 再查忙——
  /// 上一笔处理中扫货位，码被清空后直接 return，无提示丢失（"扫完货位有时消失"根因之一）
  bool _locBusy = false;
  Future<void> _scanLoc() async {
    final code = _locCtrl.text.trim().toUpperCase(); // 扫码枪/手输可能小写，MES货位码为大写→归一
    _locCtrl.clear();
    if (code.isEmpty) {
      _refocusLoc();
      return;
    }
    if (_locBusy) {
      widget.toast("上一笔货位还在处理，稍候自动完成", err: false);
      return; // 前一笔成功后 _to 会落地，无需重复
    }
    _locBusy = true;
    setState(() => _busy = true);
    try {
      final d = await mesLocInfo(code); // ㉖ 与直调同款共用助手：MES 主档大小写不一，查不到自动互换大小写重试
      if (d == null) {
        widget.toast("货位查询无信息：$code");
        return;
      }
      final to = {
        "WAREHOUSE_CODE": d["WAREHOUSE_CODE"]?.toString() ?? "",
        "WAREHOUSE_NAME": d["WAREHOUSE_NAME"]?.toString() ?? "",
        "DISTRICT_CODE": d["DISTRICT_CODE"]?.toString() ?? "",
        "DISTRICT_NAME": d["DISTRICT_NAME"]?.toString() ?? "",
        "LOC_CODE": d["LOC_CODE"]?.toString() ?? "",
        "LOC_NAME": d["LOC_NAME"]?.toString() ?? "",
      };
      final res = await AuthApi.reqSetLoc(_r["id"].toString(), to);
      if (res["ok"] != true) {
        widget.toast("货位设置失败：${res["msg"]}");
        return;
      }
      setState(() {
        _to = to;
        _r = Map.from(res["req"]);
      });
      widget.toast("转入货位已设置：${to["LOC_NAME"]}", err: false);
      _refocusScan(); // 修复：货位设好后光标交给发料框，扫码枪可直接连续发料
    } catch (e) {
      widget.toast("货位查询失败：${e.toString().replaceFirst("Exception: ", "")}");
      _refocusLoc(); // 失败后光标回到货位框，可直接重扫
    } finally {
      _locBusy = false;
      if (mounted) setState(() => _busy = false);
    }
  }

  void _refocusLoc() {
    _locFocus.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _locFocus.requestFocus();
    });
  }

  /// 备料向导步骤条（纯展示，状态全部从单据现有字段推导，不发任何请求）
  Widget _buildWizard(List<Map> items, String st) {
    if (st == 'pending' || st == 'rejected' || st == 'cancelled')
      return const SizedBox.shrink();
    final n = items.length;
    final trans = items
        .where((i) => i["transferred"] == true || i["skipped"] == true)
        .length;
    final scanned =
        items.where((i) => (i["issued"] as List?)?.isNotEmpty == true).length;
    final called = items.fold<int>(
        0, (s, i) => s + ((i["agvCalled"] as List?)?.length ?? 0));
    final hasShelf = items.any((i) =>
        ((i["suggest"] as Map?)?["boxes"] as List?)?.any(
            (b) => (b["l"]?.toString().startsWith('NB02-') ?? false) == true) ==
        true);
    final steps = <List<Object>>[
      ["接单", true],
      ["转入货位", _to.isNotEmpty],
      ["叫AGV", !hasShelf || called > 0 || scanned > 0], // ㉖v92c 有扫码发料=框已到位(叫车或人工)，转单清agvCalled后不误挡
      ["扫码发料", scanned > 0],
      ["转MES", trans >= n && n > 0],
    ];
    int cur = steps.indexWhere((s) => s[1] != true);
    if (cur < 0) cur = steps.length;
    return Container(
        margin: const EdgeInsets.only(top: 6, bottom: 2),
        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 6),
        decoration: BoxDecoration(
            color: const Color(0xFFF2F3FA),
            borderRadius: BorderRadius.circular(10)),
        child: Row(children: [
          for (var i = 0; i < steps.length; i++) ...[
            Expanded(
                child: Column(children: [
              Container(
                  width: 22,
                  height: 22,
                  decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: i < cur
                          ? const Color(0xFF2E7D32)
                          : (i == cur ? const Color(0xFF515BD4) : Colors.white),
                      border: Border.all(
                          color: i <= cur
                              ? Colors.transparent
                              : const Color(0xFFB0B7D9),
                          width: 1.5)),
                  child: Center(
                      child: i < cur
                          ? const Icon(Icons.check,
                              size: 14, color: Colors.white)
                          : Text("${i + 1}",
                              style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.bold,
                                  color: i == cur
                                      ? Colors.white
                                      : const Color(0xFF8890B8))))),
              const SizedBox(height: 3),
              Text(steps[i][0].toString(),
                  style: TextStyle(
                      fontSize: 10.5,
                      fontWeight:
                          i == cur ? FontWeight.bold : FontWeight.normal,
                      color: i <= cur ? const Color(0xFF303F9F) : Colors.grey)),
            ])),
            if (i < steps.length - 1)
              SizedBox(
                  width: 10,
                  child: Container(
                      height: 2,
                      color: i < cur
                          ? const Color(0xFF2E7D32)
                          : const Color(0xFFD3D8EE))),
          ],
        ]));
  }

  /// 管理员转派/指定：选择目标仓管员（服务器会重置30分钟窗口）
  Future<void> _reassign() async {
    final curId = _r["assigneeId"]?.toString() ?? "";
    final r = await AuthApi.reqWarehouseUsers();
    if (!mounted) return;
    if (r["ok"] != true) {
      widget.toast("获取仓管员列表失败：${r["msg"]}");
      return;
    }
    final users = List<Map>.from(r["users"] ?? [])
        .where((w) => w["id"] != curId)
        .toList();
    if (users.isEmpty) {
      widget.toast(curId.isEmpty ? "没有可指定的仓管员" : "没有其他可转派的仓管员");
      return;
    }
    final picked = await showModalBottomSheet<String>(
        context: context,
        builder: (mctx) => SafeArea(
                child: ListView(
                    shrinkWrap: true,
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    children: [
                  Padding(
                      padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
                      child: Text(curId.isEmpty ? "指定仓管员备料" : "转派给其他仓管员",
                          style: const TextStyle(
                              fontSize: 15, fontWeight: FontWeight.bold))),
                  ...users.map((w) => ListTile(
                        leading: CircleAvatar(
                            radius: 15,
                            child: Text(
                                (w["name"] ?? "?").toString().substring(0, 1),
                                style: const TextStyle(fontSize: 13))),
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
    final aLocked = aId.isNotEmpty &&
        aOpenStr.isNotEmpty &&
        DateTime.tryParse(aOpenStr)?.isAfter(DateTime.now()) == true;
    final assignBlocked = st == 'pending' &&
        isWh &&
        aLocked &&
        Auth.user?.id != aId &&
        !Auth.isAdmin;
    final items = List<Map>.from(_r["items"] ?? []);
    final history = List<Map>.from(_r["history"] ?? []);
    return Padding(
      padding: EdgeInsets.fromLTRB(
          14, 10, 14, MediaQuery.of(context).viewInsets.bottom + 14),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.92,
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: Text("${_r["no"]}  ${_r["byName"]}",
                    style: const TextStyle(
                        fontSize: 16, fontWeight: FontWeight.bold))),
            if (_r["rush"] == true)
              Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 7, vertical: 2),
                      decoration: BoxDecoration(
                          color: Colors.red.withOpacity(0.1),
                          borderRadius: BorderRadius.circular(6),
                          border: Border.all(
                              color: Colors.redAccent.withOpacity(0.6))),
                      child: const Text("🔥急料",
                          style: TextStyle(
                              fontSize: 11.5,
                              color: Colors.red,
                              fontWeight: FontWeight.bold)))),
            if (isWh && (st == 'pending' || st == 'accepted'))
              TextButton(
                  style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      visualDensity: VisualDensity.compact,
                      foregroundColor: _r["rush"] == true
                          ? Colors.grey
                          : Colors.red.shade700),
                  onPressed: _busy
                      ? null
                      : () => _act("rush", {"rush": _r["rush"] != true}),
                  child: Text(_r["rush"] == true ? "取消急料" : "标为急料",
                      style: const TextStyle(fontSize: 12))),
            Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                    color: widget.statusColor(st).withOpacity(0.12),
                    borderRadius: BorderRadius.circular(6)),
                child: Text(_r["statusText"]?.toString() ?? st,
                    style: TextStyle(
                        fontSize: 12, color: widget.statusColor(st)))),
          ]),
          _buildWizard(items, st),
          // ㉖v96 整单常驻AGV队列条（采集页同款样式）：旧版每个零件行重复一条文字链，多行单刷屏（10/25 用户）
          InkWell(
              onTap: _showQueueSheet,
              borderRadius: BorderRadius.circular(8),
              child: Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(top: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
                  decoration: BoxDecoration(
                      color: const Color(0xFFE8F0FE),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: const Color(0xFFB3C7F0))),
                  child: Row(children: [
                    const Text("🚛", style: TextStyle(fontSize: 14)),
                    const SizedBox(width: 6),
                    Expanded(
                        child: Text(
                            _queueItems.isEmpty
                                ? "本单AGV任务：暂无排队（点行内「一键叫车」入队）"
                                : "本单AGV任务：${_queueCnt("排队")}排 · ${_queueCnt("在途")}在途 · ${_queueCnt("已到站")}到站${_queueCnt("失败") > 0 ? " · ${_queueCnt("失败")}失败" : ""}",
                            style: const TextStyle(
                                fontSize: 12.5,
                                fontWeight: FontWeight.w600,
                                color: Color(0xFF1A237E)))),
                    Text(_queueMode == "live" ? "真实下发" : "演算模式",
                        style: TextStyle(
                            fontSize: 10.5,
                            color: _queueMode == "live"
                                ? Colors.green.shade700
                                : Colors.grey)),
                    const Icon(Icons.chevron_right, size: 18, color: Color(0xFF1A237E)),
                  ]))),
          if ((_r["remark"]?.toString().isNotEmpty ?? false))
            Text("备注：${_r["remark"]}",
                style: const TextStyle(fontSize: 12, color: Colors.grey)),
          if ((_r["shortInfo"]?.toString().isNotEmpty ?? false))
            Container(
              margin: const EdgeInsets.only(top: 4),
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                  color: Colors.deepOrange.shade50,
                  borderRadius: BorderRadius.circular(6)),
              child: Text("⚠ 短装：${_r["shortInfo"]}",
                  style:
                      const TextStyle(fontSize: 12, color: Colors.deepOrange)),
            ),
          // 打印领料单：复制打印页链接，电脑浏览器打开 Ctrl+P
          Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                style: TextButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 4)),
                onPressed: () async {
                  final server = await AuthStore.serverUrl();
                  final url = "$server/print/requisition?id=${_r["id"]}";
                  await Clipboard.setData(ClipboardData(text: url));
                  if (!mounted) return;
                  showDialog(
                      context: context,
                      builder: (dctx) => AlertDialog(
                            title: const Text("打印链接已复制"),
                            content: Text(
                                "在连接打印机的电脑浏览器打开：\n\n$url\n\n页面内点「打印本单」或按 Ctrl+P。零件号可鼠标选中复制，纸上有货位/实发空栏供手写。",
                                style: const TextStyle(fontSize: 13)),
                            actions: [
                              TextButton(
                                  onPressed: () => Navigator.pop(dctx),
                                  child: const Text("知道了"))
                            ],
                          ));
                },
                icon: const Icon(Icons.print_outlined, size: 18),
                label: const Text("打印领料单（复制链接到电脑）",
                    style: TextStyle(fontSize: 13)),
              )),
          const SizedBox(height: 8),
          // 发料扫码框（备料中且是仓管）
          if (st == 'accepted' && isWh) ...[
            if (_to.isEmpty)
              Row(children: [
                Expanded(
                    child: TextField(
                  controller: _locCtrl,
                  focusNode: _locFocus,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                      hintText: "先扫转入货位（产线/接驳位）",
                      isDense: true,
                      prefixIcon: Icon(Icons.place_outlined, size: 20),
                      border: OutlineInputBorder()),
                  onSubmitted: (_) => _scanLoc(),
                )),
                const SizedBox(width: 8),
                SizedBox(
                    width: 72,
                    child: ElevatedButton(
                        onPressed: _busy ? null : _scanLoc,
                        child: const Text("设定"))),
              ])
            else
              Row(children: [
                Expanded(
                  child: Text(
                      "转入：${_to["WAREHOUSE_NAME"]}/${_to["DISTRICT_NAME"]}/${_to["LOC_NAME"]}（${_to["LOC_CODE"]}）",
                      style: const TextStyle(
                          fontSize: 12, color: Color(0xFF3F51B5))),
                ),
                TextButton(
                    onPressed: _busy
                        ? null
                        : () {
                            setState(() => _to = {});
                            _refocusLoc();
                          },
                    child: const Text("改货位", style: TextStyle(fontSize: 12))),
              ]),
            SwitchListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: const Text("开启SAP库存校验", style: TextStyle(fontSize: 13)),
              value: _checkSap,
              onChanged: (v) => setState(() => _checkSap = v),
            ),
            TextField(
              controller: _scanCtrl, focusNode: _scanFocus,
              // 修复：删除 autofocus，避免打开详情时抢走转入货位框的焦点导致扫货位无反应
              decoration: InputDecoration(
                hintText: _issuePart == null
                    ? "先点击下方零件行选择发料目标，再连续扫码"
                    : "连续扫码发料中：$_issuePart",
                isDense: true,
                prefixIcon: const Icon(Icons.qr_code_scanner, size: 20),
                border: OutlineInputBorder(
                    borderSide: BorderSide(
                        color: _issuePart == null
                            ? Colors.grey.shade300
                            : Colors.teal)),
              ),
              onSubmitted: (_) => _scanIssue(),
            ),
            const SizedBox(height: 6),
          ],
          Expanded(
              child: ListView(children: [
            ...items.map((item) {
              final codes = _issuedCodesOf(item);
              final got = _issuedQtyOf(item);
              final qty = (item["qty"] as num?)?.toDouble() ?? 0;
              final done = got >= qty && qty > 0;
              final transferred = item["transferred"] == true;
              final skipped = item["skipped"] == true;
              final selected = _issuePart == item["partNo"].toString();
              final boxQs = Map<String, double>.fromEntries(
                  List.from(item["issued"] ?? []).whereType<Map>().map((x) =>
                      MapEntry(x["c"]?.toString() ?? "",
                          (x["q"] as num?)?.toDouble() ?? 0)));
              return Card(
                shape: selected
                    ? RoundedRectangleBorder(
                        side: const BorderSide(color: Colors.teal, width: 2),
                        borderRadius: BorderRadius.circular(12))
                    : null,
                child: InkWell(
                  onTap: (st == 'accepted' &&
                          isWh &&
                          !done &&
                          !transferred &&
                          !skipped)
                      ? () {
                          setState(
                              () => _issuePart = item["partNo"].toString());
                          _refocusScan();
                        }
                      : null,
                  child: Padding(
                      padding: const EdgeInsets.all(10),
                      child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(children: [
                              Expanded(
                                  child: Text(
                                      "${item["partNo"]}  ${item["itemName"] ?? ""}",
                                      style: const TextStyle(
                                          fontSize: 14,
                                          fontWeight: FontWeight.w600))),
                              if (transferred)
                                Text(
                                    "已转 ${_fmtInvNum((item["transferQty"] as num?)?.toDouble() ?? got)} 件",
                                    style: const TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.bold,
                                        color: Colors.green))
                              else if (skipped)
                                const Text("已跳过",
                                    style: TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.bold,
                                        color: Colors.grey))
                              else
                                Text(
                                    "已发 ${_fmtInvNum(got)}/${_fmtInvNum(qty)} 件",
                                    style: TextStyle(
                                        fontSize: 13,
                                        fontWeight: FontWeight.bold,
                                        color: done
                                            ? Colors.green
                                            : Colors.orange)),
                              if (selected)
                                const Padding(
                                    padding: EdgeInsets.only(left: 6),
                                    child: Icon(Icons.my_location,
                                        size: 16, color: Colors.teal)),
                            ]),
                            const SizedBox(height: 4),
                            Wrap(spacing: 6, runSpacing: 4, children: [
                              ...codes.map((c) {
                                final isEm = List.from(item["issued"] ?? [])
                                    .any((x) =>
                                        x is Map &&
                                        (x["c"]?.toString() ?? "") == c &&
                                        x["e"] == 1);
                                return Chip(
                                    label: Text(
                                        "${isEm ? "⚠" : ""}${boxQs[c] != null && boxQs[c]! > 0 ? "$c·${_fmtInvNum(boxQs[c]!)}" : c}",
                                        style: const TextStyle(
                                            fontSize: 10, color: Colors.white)),
                                    backgroundColor: isEm
                                        ? Colors.deepOrange
                                        : (transferred
                                            ? Colors.green.shade700
                                            : Colors.green),
                                    padding: EdgeInsets.zero,
                                    visualDensity: VisualDensity.compact);
                              }),
                            ]),
                            if (st == 'pending' &&
                                isOwner &&
                                List<Map>.from(_r["items"] ?? []).length > 1)
                              Align(
                                  alignment: Alignment.centerRight,
                                  child: IconButton(
                                      visualDensity: VisualDensity.compact,
                                      icon: const Icon(Icons.delete_outline,
                                          size: 18, color: Colors.redAccent),
                                      tooltip: "删除本行",
                                      onPressed: _busy
                                          ? null
                                          : () async {
                                              final yes = await showDialog<
                                                      bool>(
                                                  context: context,
                                                  builder: (dc) => AlertDialog(
                                                          title: const Text(
                                                              "删除该行？"),
                                                          content: Text(
                                                              "删除零件 ${item["partNo"]}×${item["qty"]}"),
                                                          actions: [
                                                            TextButton(
                                                                onPressed: () =>
                                                                    Navigator.pop(
                                                                        dc,
                                                                        false),
                                                                child:
                                                                    const Text(
                                                                        "取消")),
                                                            TextButton(
                                                                onPressed: () =>
                                                                    Navigator.pop(
                                                                        dc,
                                                                        true),
                                                                child: const Text(
                                                                    "删除",
                                                                    style: TextStyle(
                                                                        color: Colors
                                                                            .red)))
                                                          ]));
                                              if (yes == true)
                                                await _act("delitem",
                                                    {"partNo": item["partNo"]});
                                            })),
                            _buildSuggest(item, transferred || skipped),
                            if (st == 'accepted' &&
                                isWh &&
                                !transferred &&
                                !skipped)
                              Padding(
                                padding: const EdgeInsets.only(top: 6),
                                child: Row(children: [
                                  Expanded(
                                      child: ElevatedButton.icon(
                                    style: ElevatedButton.styleFrom(
                                        backgroundColor: Colors.teal,
                                        foregroundColor: Colors.white,
                                        disabledBackgroundColor:
                                            Colors.grey.shade300,
                                        minimumSize: const Size(0, 36),
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: 8)),
                                    onPressed:
                                        (_busy || got <= 0 || _to.isEmpty)
                                            ? null
                                            : () => _transferRow(item),
                                    icon: const Icon(Icons.sync, size: 16),
                                    label: Text(
                                        got <= 0
                                            ? "转MES出库"
                                            : (got < qty
                                                ? "转 ${_fmtInvNum(got)} 件(短装)"
                                                : "转MES出库"),
                                        style: const TextStyle(fontSize: 12)),
                                  )),
                                  const SizedBox(width: 8),
                                  Expanded(
                                      child: OutlinedButton.icon(
                                    style: OutlinedButton.styleFrom(
                                        foregroundColor: Colors.grey.shade700,
                                        minimumSize: const Size(0, 36),
                                        padding: const EdgeInsets.symmetric(
                                            horizontal: 8)),
                                    onPressed:
                                        _busy ? null : () => _skipRow(item),
                                    icon: const Icon(Icons.skip_next, size: 16),
                                    label: const Text("无货跳过",
                                        style: TextStyle(fontSize: 12)),
                                  )),
                                ]),
                              ),
                          ])),
                ),
              );
            }),
            if (history.isNotEmpty) ...[
              const SizedBox(height: 4),
              const Text("流转记录",
                  style: TextStyle(fontSize: 13, fontWeight: FontWeight.bold)),
              ...history.map((h) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Text(
                        "${reqTimeLocal(h["time"])}  ${h["by"]}：${h["text"]}",
                        style:
                            const TextStyle(fontSize: 11, color: Colors.grey)),
                  )),
            ],
          ])),
          const SizedBox(height: 8),
          // 底部动作条
          if (st == 'pending' && aLocked && aName.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                  "📌 本单已指定 $aName 备料${Auth.user?.id == aId ? "（就是你，请尽快接单）" : "，超时未接将放开给全部仓管"}",
                  style: TextStyle(
                      fontSize: 12,
                      color: Auth.user?.id == aId
                          ? Colors.deepOrange
                          : const Color(0xFF3949AB))),
            ),
          Wrap(spacing: 6, runSpacing: 6, children: [
            if (st == 'pending' && Auth.isAdmin) ...[
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 92),
                  child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF3949AB)),
                      onPressed: _busy ? null : _reassign,
                      icon: const Icon(Icons.swap_horiz, size: 16),
                      label: Text(aName.isEmpty ? "指定" : "转派"))),
            ],
            if (st == 'pending' && isWh) ...[
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 92),
                  child: OutlinedButton.icon(
                      style:
                          OutlinedButton.styleFrom(foregroundColor: Colors.red),
                      onPressed: (_busy || assignBlocked)
                          ? null
                          : () async {
                              final reason = await _askReason("拒单原因");
                              if (reason != null)
                                await _act("reject", {"reason": reason});
                            },
                      icon: const Icon(Icons.block, size: 16),
                      label: const Text("拒单"))),
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 150),
                  child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                          backgroundColor: const Color(0xFF515BD4),
                          foregroundColor: Colors.white,
                          disabledBackgroundColor: Colors.grey.shade300),
                      onPressed: (_busy || assignBlocked)
                          ? null
                          : () => _act("accept"),
                      icon: const Icon(Icons.how_to_reg),
                      label: Text(assignBlocked ? "已指定 $aName" : "接单备料"))),
            ],
            if ((st == 'pending' || st == 'accepted') &&
                (isOwner || Auth.isAdmin))
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 92),
                  child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                          foregroundColor: Colors.deepOrange),
                      onPressed: _busy
                          ? null
                          : () async {
                              final note = await _askReason(st == 'accepted'
                                  ? "催备料（可写哪个零件急用）"
                                  : "催接单（可补充说明）");
                              if (note == null) return;
                              setState(() => _busy = true);
                              final res = await AuthApi.reqAction(
                                  _r["id"].toString(), "urge", {"note": note});
                              if (!mounted) return;
                              setState(() => _busy = false);
                              widget.toast(
                                  res["ok"] == true
                                      ? "已催，仓管会收到通知"
                                      : (res["msg"] ?? "催单失败").toString(),
                                  err: res["ok"] != true);
                              if (res["ok"] == true && res["req"] is Map)
                                setState(
                                    () => _r = Map.from(res["req"] as Map));
                            },
                      icon: const Icon(Icons.alarm, size: 16),
                      label: Text(st == 'accepted' ? "催备料" : "催接单"))),
            if ((st == 'pending' || st == 'accepted') &&
                (isOwner || Auth.isAdmin))
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 92),
                  child: OutlinedButton.icon(
                      style:
                          OutlinedButton.styleFrom(foregroundColor: Colors.red),
                      onPressed: _busy ? null : () => _act("cancel"),
                      icon: const Icon(Icons.close, size: 16),
                      label: const Text("取消订单"))),
            if (st == 'ready' && (isOwner || Auth.can("receive_confirm")))
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 150),
                  child: ElevatedButton.icon(
                      style: ElevatedButton.styleFrom(
                          backgroundColor: Colors.green,
                          foregroundColor: Colors.white),
                      onPressed: _busy
                          ? null
                          : () async {
                              final yes = await showDialog<bool>(
                                  context: context,
                                  builder: (dctx) => AlertDialog(
                                          title: const Text("确认收货"),
                                          content:
                                              Text("确认已收到 ${_r["no"]} 的全部物料？"),
                                          actions: [
                                            TextButton(
                                                onPressed: () =>
                                                    Navigator.pop(dctx, false),
                                                child: const Text("取消")),
                                            TextButton(
                                                onPressed: () =>
                                                    Navigator.pop(dctx, true),
                                                child: const Text("确认收到"))
                                          ]));
                              if (yes == true) await _act("confirm");
                            },
                      icon: const Icon(Icons.done_all),
                      label: const Text("确认收到货物"))),
            if (widget.onAgain != null &&
                List<Map>.from(_r["items"] ?? []).isNotEmpty)
              ConstrainedBox(
                  constraints: const BoxConstraints(minWidth: 110),
                  child: OutlinedButton.icon(
                      style: OutlinedButton.styleFrom(
                          foregroundColor: const Color(0xFF00897B)),
                      onPressed: () {
                        final rq = _r;
                        Navigator.pop(context, false);
                        widget.onAgain!.call(rq); // 先关详情再开预填新建，避免双层弹层
                      },
                      icon: const Icon(Icons.replay, size: 16),
                      label: const Text("再来一单"))),
            ConstrainedBox(
                constraints: const BoxConstraints(minWidth: 92),
                child: OutlinedButton(
                    onPressed: () => Navigator.pop(context, st != _r["status"]),
                    child: const Text("关闭"))),
          ]),
        ]),
      ),
    );
  }

  Future<String?> _askReason(String title) async {
    final ctrl = TextEditingController();
    final v = await showDialog<String>(
        context: context,
        builder: (dctx) => AlertDialog(
              title: Text(title),
              content: SizedBox(
                  width: 280,
                  child: TextField(
                      controller: ctrl,
                      autofocus: true,
                      decoration:
                          const InputDecoration(border: OutlineInputBorder()))),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dctx),
                    child: const Text("取消")),
                ElevatedButton(
                    onPressed: () => Navigator.pop(dctx, ctrl.text.trim()),
                    child: const Text("确定"))
              ],
            ));
    ctrl.dispose();
    return v;
  }
}

// ---------- 消息中心：本人最近历史通知（只读，不影响未读横幅） ----------
class MsgCenterPage extends StatefulWidget {
  const MsgCenterPage({super.key});
  @override
  State<MsgCenterPage> createState() => _MsgCenterPageState();
}

class _MsgCenterPageState extends State<MsgCenterPage> {
  List<Map> _msgs = [];
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
    final r = await AuthApi.notificationsHistory(limit: 50);
    if (!mounted) return;
    if (r["ok"] == true) {
      // ㉖v50 三级排序：未处理车辆告警 > 未读 > 普通已读；组内时间倒序
      final list = List<Map>.from(r["notifications"] ?? []);
      int rank(Map m) {
        final t = m["type"]?.toString() ?? "";
        final txt = m["text"]?.toString() ?? "";
        final resolved = txt.startsWith("✅") ||
            txt.contains("已恢复") ||
            txt.contains("已认领");
        if (t == "car_alarm" && !resolved) return 0;
        return m["read"] != true ? 1 : 2;
      }

      list.sort((a, b) {
        final ra = rank(a), rb = rank(b);
        if (ra != rb) return ra - rb;
        return (b["time"] ?? "").toString()
            .compareTo((a["time"] ?? "").toString());
      });
      setState(() {
        _msgs = list;
        _loading = false;
      });
    } else
      setState(() {
        _loading = false;
        _err = (r["msg"] ?? "加载失败").toString();
      });
  }

  static const _typeIcon = {
    "req_new": Icons.assignment_add,
    "req_accept": Icons.how_to_reg,
    "req_reject": Icons.block,
    "req_ready": Icons.inventory_2,
    "req_ready_wh": Icons.inventory,
    "req_done": Icons.check_circle,
    "req_cancel": Icons.cancel,
    "req_timeout": Icons.hourglass_empty,
    "req_reassign": Icons.swap_horiz,
    "req_arrive": Icons.local_shipping,
    "req_urge": Icons.alarm,
    "car_alarm": Icons.error,
  };

  String _dayOf(String t) {
    final d = DateTime.tryParse(t);
    if (d == null) return "";
    final now = DateTime.now();
    final day0 = DateTime(now.year, now.month, now.day);
    final dd = DateTime(d.year, d.month, d.day);
    final diff = day0.difference(dd).inDays;
    if (diff <= 0) return "今天";
    if (diff == 1) return "昨天";
    if (diff < 7) return "${diff}天前";
    return "${d.month}月${d.day}日";
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
          title: const Text("消息中心", style: TextStyle(fontSize: 16)),
          actions: [
            IconButton(icon: const Icon(Icons.refresh), onPressed: _load)
          ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _err.isNotEmpty
              ? Center(
                  child: Text(_err, style: const TextStyle(color: Colors.red)))
              : _msgs.isEmpty
                  ? const Center(
                      child: Text("暂无消息", style: TextStyle(color: Colors.grey)))
                  : ListView.builder(
                      padding: const EdgeInsets.all(10),
                      itemCount: _msgs.length,
                      itemBuilder: (_, i) {
                        final m = _msgs[i];
                        final tp = m["type"]?.toString() ?? "";
                        final t = (m["time"] ?? "").toString();
                        final urgent = i == 0 &&
                            tp == 'car_alarm' &&
                            !(m["text"]?.toString() ?? "")
                                    .startsWith("✅");
                        final unread = m["read"] != true;
                        String dayHdr = "";
                        if (i == 0 ||
                            _dayOf(t) != _dayOf((_msgs[i - 1]["time"] ?? "")
                                .toString())) {
                          dayHdr = _dayOf(t);
                        }
                        return Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              if (dayHdr.isNotEmpty)
                                Padding(
                                  padding:
                                      const EdgeInsets.fromLTRB(4, 10, 4, 2),
                                  child: Text(dayHdr,
                                      style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold,
                                          color: Colors.blueGrey)),
                                ),
                              Card(
                                  margin: const EdgeInsets.symmetric(vertical: 4),
                                  color: urgent
                                      ? const Color(0xFFFFEBEE)
                                      : null,
                                  shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(8),
                                      side: urgent
                                          ? const BorderSide(
                                              color: Color(0xFFD32F2F),
                                              width: 1.2)
                                          : BorderSide.none),
                                  child: ListTile(
                                    leading: CircleAvatar(
                                        backgroundColor: urgent
                                            ? const Color(0xFFD32F2F)
                                                .withOpacity(0.15)
                                            : tp == 'req_arrive'
                                                ? Colors.orange.shade100
                                                : const Color(0xFFE8EAF6),
                                        child: Icon(
                                            _typeIcon[tp] ??
                                                Icons.notifications_none,
                                            size: 20,
                                            color: urgent
                                                ? const Color(0xFFD32F2F)
                                                : tp == 'req_arrive'
                                                    ? Colors.deepOrange
                                                    : const Color(0xFF3949AB))),
                                    title: Text(m["text"]?.toString() ?? "",
                                        style: TextStyle(
                                            fontSize: 13,
                                            fontWeight: unread
                                                ? FontWeight.w600
                                                : FontWeight.normal,
                                            color: unread
                                                ? Colors.black87
                                                : Colors.black54)),
                                    subtitle: Text(reqTimeLocal(t),
                                        style: const TextStyle(
                                            fontSize: 11, color: Colors.grey)),
                                    trailing: unread
                                        ? Container(
                                            width: 8,
                                            height: 8,
                                            decoration: BoxDecoration(
                                                color: urgent
                                                    ? const Color(0xFFD32F2F)
                                                    : Colors.blueAccent,
                                                borderRadius:
                                                    BorderRadius.circular(4)))
                                        : null,
                                    isThreeLine: false,
                                    dense: true,
                                  )),
                            ]);
                      }),
    );
  }
}

// ---------- ㉖v52 备料排队看板：物料员"我排第几、谁在备料、前面还有谁"一屏看清 ----------
class _QueueBoardSheet extends StatefulWidget {
  final String myId; // 本人某未完单号；空=仓管/管理员全景视角
  const _QueueBoardSheet({required this.myId});
  @override
  State<_QueueBoardSheet> createState() => _QueueBoardSheetState();
}

class _QueueBoardSheetState extends State<_QueueBoardSheet> {
  Map? _q;
  bool _loading = true;
  String _err = "";
  bool _expandAll = false; // ㉖v52 长队列默认折叠（前3+我的附近），点头部芯片展开

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
    final r = await AuthApi.reqQueue(my: widget.myId);
    if (!mounted) return;
    if (r["ok"] == true) {
      setState(() {
        _q = r["board"] as Map?;
        _loading = false;
      });
    } else {
      setState(() {
        _loading = false;
        _err = (r["msg"] ?? "加载失败").toString();
      });
    }
  }

  String _dur(dynamic min) {
    final m = (min as num?)?.toInt();
    if (m == null) return "—";
    if (m < 1) return "刚刚";
    if (m < 60) return "$m 分钟";
    if (m < 1440) {
      final h = (m / 60).floor(), mm = m % 60;
      return mm == 0 ? "$h 小时" : "$h 小时 $mm 分";
    }
    final d = (m / 1440).floor(), h = ((m % 1440) / 60).floor();
    return h == 0 ? "$d 天" : "$d 天 $h 小时"; // ㉖v52 超一天按"天 小时"，不再显示 405 小时
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(top: MediaQuery.of(context).viewInsets.top),
      child: Container(
        constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.94),
        decoration: const BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
        child: _loading
            ? const Padding(
                padding: EdgeInsets.all(40),
                child: Center(child: CircularProgressIndicator()))
            : _err.isNotEmpty
                ? Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(_err,
                        style: const TextStyle(color: Colors.red)))
                : Column(children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 14, 8, 6),
                      child: Row(children: [
                        const Text("备料排队看板",
                            style: TextStyle(
                                fontSize: 17, fontWeight: FontWeight.bold)),
                        const Spacer(),
                        TextButton.icon(
                            onPressed: _load,
                            icon: const Icon(Icons.refresh, size: 18),
                            label: const Text("刷新")),
                        IconButton(
                            onPressed: () => Navigator.pop(context),
                            icon: const Icon(Icons.close)),
                      ]),
                    ),
                    _head(),
                    Expanded(
                        child: ListView(
                            padding: const EdgeInsets.fromLTRB(12, 4, 12, 20),
                            children: _rows())),
                  ]),
      ),
    );
  }

  Widget _head() {
    final q = _q ?? const {};
    final rank = (q["rank"] as num?)?.toInt();
    final total = (q["total"] as num?)?.toInt() ?? 0;
    final agv = (q["agvActive"] as num?)?.toInt() ?? 0;
    final eta = (q["etaMin"] as num?)?.toInt();
    final serving = List<Map>.from(q["servingNow"] ?? []);
    final isMine = rank != null;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 4, 12, 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
          color: const Color(0xFFF0F4FF),
          borderRadius: BorderRadius.circular(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (isMine)
            Row(children: [
              Text("你排在第 ",
                  style: const TextStyle(fontSize: 15, color: Color(0xFF3F51B5))),
              Text("$rank",
                  style: const TextStyle(
                      fontSize: 30,
                      fontWeight: FontWeight.w900,
                      color: Color(0xFF3F51B5))),
              Text(" 号 · 共 $total 单在队",
                  style: const TextStyle(fontSize: 15, color: Color(0xFF3F51B5))),
            ])
          else
            Row(children: [
              const Text("当前在队 ",
                  style: TextStyle(fontSize: 15, color: Color(0xFF3F51B5))),
              Text("$total",
                  style: const TextStyle(
                      fontSize: 30,
                      fontWeight: FontWeight.w900,
                      color: Color(0xFF3F51B5))),
              const Text(" 单（全景视角）",
                  style: TextStyle(fontSize: 15, color: Color(0xFF3F51B5))),
            ]),
          if (eta != null && eta > 0)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text("⏳ 预计 ${_dur(eta)} 后轮到你（按近期备料实测均时估算）",
                  style:
                      const TextStyle(fontSize: 12.5, color: Color(0xFF5C6BC0))),
            ),
          if (serving.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: _servingLine(serving),
            )
          else if (total > 0)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: const Text("🕐 暂无仓管接单，稍候或催单提醒",
                  style: TextStyle(
                      fontSize: 13.5, color: Color(0xFFE65100))),
            ),
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text("🤖 仓库在跑 $agv 个 AGV 搬运任务",
                style: const TextStyle(fontSize: 12, color: Colors.grey)),
          ),
        ],
      ),
    );
  }

  // ㉖v52 一句话摘要：我的单正在被备料时优先播报，否则只报"几人几单在备"，不再罗列全队列
  Widget _servingLine(List<Map> serving) {
    final mine = serving.firstWhere((s) => s["mine"] == true, orElse: () => const {});
    if (mine.isNotEmpty) {
      return Text(
          "🔧 好消息：你的单正在备料！${mine["acceptedBy"]} 已备 ${_dur(mine["acceptedMin"])}",
          style: const TextStyle(
              fontSize: 14, fontWeight: FontWeight.bold, color: Color(0xFF2E7D32)));
    }
    final who = serving.map((s) => (s["acceptedBy"] ?? "?").toString()).toSet().toList();
    final head = who.take(2).join("、");
    return Text(
        "🔧 ${who.length} 位仓管在备料 · 共 ${serving.length} 单进行中"
        "${head.isEmpty ? "" : "（$head${who.length > 2 ? " 等" : ""}）"}",
        style: const TextStyle(fontSize: 13.5, color: Color(0xFF2E7D32)));
  }

  List<Widget> _rows() {
    final items = List<Map>.from((_q?["items"] as List?) ?? []);
    if (items.isEmpty)
      return [
        const Padding(
            padding: EdgeInsets.all(30),
            child: Center(
                child: Text("队列为空，没有待接单/备料中的单",
                    style: TextStyle(color: Colors.grey))))
      ];
    final rank = (_q?["rank"] as num?)?.toInt();
    final myPos = rank ?? (_q?["total"] as num?)?.toInt() ?? 0;
    // ㉖v52 默认折叠：前 3 单 + 我的单附近（±2）+ 备料中/下一个 永远可见
    final show = <int>{};
    for (final x in items) {
      final pos = (x["pos"] as num).toInt();
      if (!_expandAll &&
          pos > 3 &&
          (rank == null || (pos - myPos).abs() > 2) &&
          x["status"] != "accepted" &&
          x["mine"] != true &&
          !(rank != null && pos == rank + 1 && x["status"] == "pending")) continue;
      show.add(pos);
    }
    final hidden = items.length - show.length;
    final out = <Widget>[
      Padding(
          padding: const EdgeInsets.fromLTRB(4, 6, 4, 4),
          child: Row(children: [
            Text(_expandAll ? "完整排队序列（按下单先后）" : "关键队列（前3 + 我的附近）",
                style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.bold,
                    color: Colors.blueGrey)),
            const Spacer(),
            if (hidden > 0 || _expandAll)
              InkWell(
                  onTap: () => setState(() => _expandAll = !_expandAll),
                  child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      child: Text(_expandAll ? "收起 ▴" : "展开全部 ${items.length} 单 ▾",
                          style: const TextStyle(
                              fontSize: 12.5,
                              color: Color(0xFF1565C0),
                              fontWeight: FontWeight.bold))))
          ]))
    ];
    for (final x in items) {
      final pos = (x["pos"] as num).toInt();
      if (!show.contains(pos)) continue;
      final me = x["mine"] == true;
      final isNext = rank != null && x["pos"] == rank + 1 && x["status"] == "pending";
      final serving = x["status"] == "accepted";
      out.add(Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        color: me ? const Color(0xFFE8EAF6) : null,
        child: ListTile(
          dense: true,
          leading: CircleAvatar(
            radius: 18,
            backgroundColor: serving
                ? const Color(0xFF2E7D32)
                : (x["rush"] == true ? const Color(0xFFE65100) : Colors.blueGrey),
            child: Text("${x["pos"]}",
                style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: Colors.white)),
          ),
          title: Row(children: [
            Flexible(
              child: Text(
                  "${x["byName"]}${me ? "（我）" : ""} · ${x["no"]}",
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      fontSize: 15,
                      fontWeight: me ? FontWeight.bold : FontWeight.normal)),
            ),
            if (x["rush"] == true)
              const Padding(
                  padding: EdgeInsets.only(left: 4),
                  child: Text("🔥急",
                      style: TextStyle(fontSize: 12, color: Color(0xFFE65100)))),
            if (isNext)
              const Padding(
                  padding: EdgeInsets.only(left: 4),
                  child: Text("← 下一个",
                      style: TextStyle(
                          fontSize: 12,
                          color: Color(0xFF1565C0),
                          fontWeight: FontWeight.bold))),
          ]),
          subtitle: Text(
            serving
                ? "🔧 ${x["acceptedBy"]} 备料中 · 已 ${_dur(x["acceptedMin"])}"
                : "🕐 等待接单 ${_dur(x["waitMin"])}",
            style: const TextStyle(fontSize: 13),
          ),
          trailing: Text(
              serving
                  ? "备料中"
                  : (x["rush"] == true ? "急料待接" : "待接单"),
              style: TextStyle(
                  fontSize: 12.5,
                  color: serving ? const Color(0xFF2E7D32) : Colors.orange)),
        ),
      ));
    }
    return out;
  }
}
