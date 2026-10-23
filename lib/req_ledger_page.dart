part of 'main.dart';

// ===================== ㉖v76 领料账本：把"单据流"翻转成物料员的"消费账本" =====================
// 时间窗：今天/近2/近3/近5/近7/自定义（记住上次用的窗口）
// 三层视图：①窗口概览卡（单数/件数/种类/急料/环比）②按天消耗柱状图（点柱下钻当日单据）
//          ③按零件消耗排行（消耗量/单数/日均/还能撑几天🔴<3🟡<7/🔄一键续领）
// 呆滞榜：全厂在库但近30天零领用的零件（在库件数降序，附最后领用日期）——反向提醒运营处理
// 报告分享：窗口消耗TOP+环比+呆滞预警，一键发微信（复用 v74 原生 share 通道）
// 数据源：/api/requisitions（服务器全量，近500张窗口）+ /api/ledger（全厂在库，v74b 同口径）；服务端零改动

class _LedgerPart {
  String partNo = "", itemName = "";
  double qty = 0; // 窗口消耗件数
  int orders = 0; // 窗口内领用单数
  double stock = 0; // 全厂在库件数
  int boxes = 0; // 全厂在库框数
  DateTime? lastAt; // 最近一次领用（全量范围）
  double get daily => _winDays > 0 ? qty / _winDays : 0;
  double get daysLeft => daily > 0.01 ? stock / daily : double.infinity; // 还能撑几天
  int _winDays = 0;
}

class ReqLedgerPage extends StatefulWidget {
  const ReqLedgerPage({super.key});
  @override
  State<ReqLedgerPage> createState() => _ReqLedgerPageState();
}

class _ReqLedgerPageState extends State<ReqLedgerPage> {
  static const _shareCh = MethodChannel("app.installer");
  static const _kWin = "rl_win_days";
  int _win = 3; // 窗口天数（0=自定义）
  DateTimeRange? _range; // 自定义区间
  String _winKey = "3"; // 记忆键值（"3"/"7"/"C20261001-20261015"）
  int _tab = 0; // 0消耗账本 1呆滞榜
  bool _loading = true, _busy = false;
  String _err = "";
  List<Map> _reqs = [];
  final Map<String, double> _stockQty = {}; // 全厂在库件数
  final Map<String, Set<String>> _stockBox = {}; // 全厂在库框键集
  final Map<String, String> _names = {};
  DateTime? _dayStart; // 窗口起点（本地零点）
  DateTime? _dayEnd; // 窗口终点（不含）

  @override
  void initState() {
    super.initState();
    // 恢复上次窗口（"3"/"7" 或 "C2026-10-01-2026-10-15"）后单次加载，避免默认窗先拉一遍
    SharedPreferences.getInstance().then((sp) {
      final k = sp.getString(_kWin);
      if (k != null) {
        if (k.startsWith("C") && k.length == 22) {
          final s = DateTime.tryParse(k.substring(1, 11)), e = DateTime.tryParse(k.substring(12));
          if (s != null && e != null) {
            _win = 0;
            _range = DateTimeRange(start: s, end: e.add(const Duration(days: 1)));
            _winKey = k;
          }
        } else {
          final d = int.tryParse(k);
          if (d != null && d > 0) { _win = d; _winKey = k; }
        }
      }
      _load();
    });
  }

  Future<void> _saveWin() async => (await SharedPreferences.getInstance()).setString(_kWin, _winKey);

  void _setWin(int d) {
    setState(() {
      _win = d;
      _range = null;
      _winKey = "$d";
    });
    _saveWin();
    _load();
  }

  Future<void> _pickRange() async {
    final now = DateTime.now();
    final r = await showDateRangePicker(
        context: context,
        firstDate: DateTime(now.year - 1),
        lastDate: now.add(const Duration(days: 1)));
    if (r == null || !mounted) return;
    setState(() {
      _win = 0;
      _range = DateTimeRange(start: r.start, end: r.end.add(const Duration(days: 1))); // 含所选末日
      _winKey = "C${_fmtYMD(r.start)}-${_fmtYMD(r.end)}";
    });
    _saveWin();
    _load();
  }

  static String _fmtYMD(DateTime d) => "${d.year.toString().padLeft(4, "0")}-${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")}";

  int get _winDays {
    if (_dayStart == null || _dayEnd == null) return _win > 0 ? _win : 1;
    return _dayEnd!.difference(_dayStart!).inDays.clamp(1, 365);
  }

  Future<void> _load() async {
    setState(() { _loading = true; _err = ""; });
    final now = DateTime.now();
    final end = _range?.end ?? DateTime(now.year, now.month, now.day).add(const Duration(days: 1));
    final start = _range?.start ?? end.subtract(Duration(days: _win > 0 ? _win : 3));
    _dayStart = start; _dayEnd = end;
    try {
      final rs = await Future.wait([
        AuthApi.reqList().timeout(const Duration(seconds: 10)),
        AuthApi.ledgerGet().timeout(const Duration(seconds: 10)),
      ]);
      final rq = rs[0], lg = rs[1];
      if (rq["ok"] != true) throw Exception(rq["msg"]?.toString() ?? "领料记录拉取失败");
      if (lg["ok"] != true) throw Exception(lg["msg"]?.toString() ?? "货位账本拉取失败");
      _reqs = List<Map>.from(rq["reqs"] ?? []);
      _rowsCache = null; _aggDirty = true; // 数据变了：行摊平与聚合缓存全部失效
      _stockQty.clear(); _stockBox.clear();
      for (final x in List<Map>.from(lg["items"] ?? [])) {
        final pn = (x["p"]?.toString() ?? "").trim().toUpperCase();
        if (pn.isEmpty) continue;
        _stockQty[pn] = (_stockQty[pn] ?? 0) + ((x["q"] as num?)?.toDouble() ?? 0);
        final pid = (x["pid"]?.toString() ?? "").toUpperCase();
        final loc = (x["l"]?.toString() ?? "").toUpperCase();
        final code = (x["c"]?.toString() ?? "").toUpperCase();
        (_stockBox[pn] ??= <String>{}).add(pid.isNotEmpty ? "P|$pid" : (loc.isNotEmpty ? "L|$loc|$pn" : "C|$code"));
        final nm = x["n"]?.toString() ?? "";
        if (nm.isNotEmpty && (_names[pn] ?? "").isEmpty) _names[pn] = nm;
      }
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _err = "$e"; });
      return;
    }
    if (!mounted) return;
    setState(() => _loading = false);
  }

  List<Map>? _rowsCache;
  /// 全量有效领用行摊平（排除已取消单；消耗账本只计已发数量）
  List<Map> get _rows {
    if (_rowsCache != null) return _rowsCache!;
    final out = <Map>[];
    for (final r in _reqs) {
      if (r["status"] == "cancelled") continue;
      final t = DateTime.tryParse(r["createdAt"]?.toString() ?? "")?.toLocal();
      if (t == null) continue;
      for (final it in List<Map>.from(r["items"] ?? [])) {
        final pn = (it["partNo"]?.toString() ?? "").toUpperCase();
        if (pn.isEmpty) continue;
        final got = (it["issued"] is List)
            ? List.from(it["issued"] as List).fold<double>(0, (s, e) => s + ((e is Map ? (e["q"] as num?)?.toDouble() : null) ?? 0))
            : 0.0;
        out.add({"t": t, "pn": pn, "qty": got, "no": r["no"]?.toString() ?? "", "by": r["byName"]?.toString() ?? "", "rush": r["rush"] == true || it["rush"] == true, "id": r["id"]?.toString() ?? ""});
      }
    }
    return _rowsCache = out;
  }

  List<Map> _rowsIn(DateTime s, DateTime e) => _rows.where((x) => !x["t"].isBefore(s) && x["t"].isBefore(e)).toList();

  /// 窗口聚合结果（脏标记缓存：数据/窗口变化时重算，build 内多次访问不重复计算）
  _Agg? _aggCache;
  bool _aggDirty = true;
  _Agg get _agg {
    if (_aggDirty || _aggCache == null) {
      _aggCache = _compute();
      _aggDirty = false;
    }
    return _aggCache!;
  }
  _Agg _compute() {
    final s = _dayStart!, e = _dayEnd!;
    final rows = _rowsIn(s, e);
    final consumed = rows.where((x) => (x["qty"] as double) > 0).toList(); // 只计已实际发料（未发的单不算消耗）
    // 环比：上一等长窗口
    final prev = _rowsIn(s.subtract(e.difference(s)), s).where((x) => (x["qty"] as double) > 0);
    double sum(Iterable<Map> l) => l.fold<double>(0, (a, x) => a + (x["qty"] as double));
    final cur = sum(consumed), before = sum(prev);
    final parts = <String, _LedgerPart>{};
    for (final x in consumed) {
      final pn = x["pn"] as String;
      final p = parts.putIfAbsent(pn, () => _LedgerPart()
        ..partNo = pn
        ..itemName = _names[pn] ?? ""
        .._winDays = _winDays);
      p.qty += x["qty"] as double;
      p.orders++;
    }
    // 最近领用日（全量范围、以实际发料为准，供呆滞榜）
    final lastAt = <String, DateTime>{};
    for (final x in _rows) {
      if ((x["qty"] as double) <= 0) continue;
      final t = x["t"] as DateTime;
      if (t.isAfter(lastAt[x["pn"]] ?? DateTime(2000))) lastAt[x["pn"]] = t;
    }
    for (final p in parts.values) {
      p.stock = _stockQty[p.partNo] ?? 0;
      p.boxes = (_stockBox[p.partNo] ?? const {}).length;
    }
    // 按天柱状
    final days = <DateTime, double>{};
    for (var d = DateTime(s.year, s.month, s.day); d.isBefore(e); d = d.add(const Duration(days: 1))) {
      days[d] = 0;
    }
    for (final x in consumed) {
      final t = x["t"] as DateTime;
      final k = DateTime(t.year, t.month, t.day);
      if (days.containsKey(k)) days[k] = days[k]! + (x["qty"] as double);
    }
    // 呆滞：全厂有在库、近30天零领用（以实际发料为准）
    final d30 = DateTime.now().subtract(const Duration(days: 30));
    final used30 = _rows.where((x) => (x["qty"] as double) > 0 && (x["t"] as DateTime).isAfter(d30)).map((x) => x["pn"] as String).toSet();
    final stale = <_LedgerPart>[];
    for (final e2 in _stockQty.entries) {
      if (e2.value <= 0 || used30.contains(e2.key)) continue;
      stale.add(_LedgerPart()
        ..partNo = e2.key
        ..itemName = _names[e2.key] ?? ""
        ..stock = e2.value
        ..boxes = (_stockBox[e2.key] ?? const {}).length
        ..lastAt = lastAt[e2.key]);
    }
    stale.sort((a, b) => b.stock.compareTo(a.stock));
    final list = parts.values.where((p) => p.qty > 0).toList()
      ..sort((a, b) => b.qty.compareTo(a.qty));
    return _Agg(
      orders: consumed.map((x) => x["id"].toString()).toSet().length,
      qty: cur,
      kinds: parts.length,
      rush: consumed.where((x) => x["rush"] == true).map((x) => x["id"].toString()).toSet().length,
      prevQty: before,
      parts: list,
      days: days.entries.toList()..sort((a, b) => a.key.compareTo(b.key)),
      stale: stale,
      truncated: _reqs.length >= 500,
    );
  }

  /// 一键续领：发全局通知 → 领料页自动打开建单弹层并预填（件数口径，弹层按均值换算框数）
  void _again(_LedgerPart p) {
    kReqAgain.value = "${p.partNo}|${_fmtInvNum(p.daily)}|${DateTime.now().millisecondsSinceEpoch}";
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("已带入 ${p.partNo}（按日均 ${_fmtInvNum(p.daily)} 件），请核对后提交"), duration: const Duration(seconds: 2))); // 先提示后出页：pop 后 context 失效
    if (mounted) Navigator.pop(context);
  }

  Future<void> _shareReport() async {
    final a = _agg;
    final w = _win > 0 ? "近$_win天" : "${_fmtYMD(_dayStart!)}~${_fmtYMD(_dayEnd!.subtract(const Duration(days: 1)))}";
    final rate = a.prevQty > 0 ? ((a.qty - a.prevQty) / a.prevQty * 100) : null;
    final sb = StringBuffer()
      ..writeln("【领料$w报告】鄞州豪斯特 · 原料库")
      ..writeln("期间：${_fmtYMD(_dayStart!)} ~ ${_fmtYMD(_dayEnd!.subtract(const Duration(days: 1)))}  制表：${Auth.user?.name ?? ''}  ${_fmtYMD(DateTime.now())}")
      ..writeln("总领用 ${_fmtInvNum(a.qty)} 件 · ${a.orders} 单 · ${a.kinds} 种零件${a.rush > 0 ? " · 急料 ${a.rush} 单" : ""}")
      ..writeln("环比上一轮：${rate == null ? "无对比数据" : "${rate >= 0 ? "+" : ""}${rate.round()}%"}")
      ..writeln("── 消耗 TOP10 ──");
    var i = 0;
    for (final p in a.parts.take(10)) {
      i++;
      final dl = p.daysLeft;
      sb.writeln("$i. ${p.partNo} ${p.itemName}｜${_fmtInvNum(p.qty)}件/${p.orders}单｜日均${_fmtInvNum(p.daily)}｜${dl.isInfinite ? "撑>30天" : "撑${dl.toStringAsFixed(1)}天"}${dl < 3 ? "🔴" : dl < 7 ? "🟡" : ""}");
    }
    if (a.stale.isNotEmpty) {
      sb.writeln("── 呆滞预警（在库但30天零领用，前5）──");
      for (final p in a.stale.take(5)) {
        sb.writeln("· ${p.partNo} ${p.itemName}｜在库${_fmtInvNum(p.stock)}件/${p.boxes}框｜${p.lastAt == null ? "更早或从未领用" : "最后领用 ${_fmtYMD(p.lastAt!)}"}");
      }
    }
    setState(() => _busy = true);
    try {
      await _shareCh.invokeMethod("share", {"text": sb.toString().trimRight(), "paths": <String>[]});
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("分享失败：$e"), backgroundColor: Colors.red.shade700));
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F6FA),
      appBar: AppBar(
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white,
          title: const Text("领料账本", style: TextStyle(fontSize: 15)),
          actions: [
            IconButton(
                tooltip: "分享报告到微信",
                icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.share, size: 20),
                onPressed: _loading || _busy ? null : _shareReport),
            IconButton(tooltip: "刷新", icon: const Icon(Icons.refresh, size: 20), onPressed: _load),
          ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _err.isNotEmpty
              ? Center(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Text(_err, textAlign: TextAlign.center, style: const TextStyle(color: Colors.red, fontSize: 13)),
                    const SizedBox(height: 10),
                    OutlinedButton.icon(onPressed: _load, icon: const Icon(Icons.refresh, size: 16), label: const Text("重试")),
                  ]))
              : Column(children: [
                  // 时间窗
                  SizedBox(
                      height: 42,
                      child: ListView(
                          scrollDirection: Axis.horizontal,
                          padding: const EdgeInsets.symmetric(horizontal: 10),
                          children: [
                            ...[1, 2, 3, 5, 7].map((d) => Padding(
                                padding: const EdgeInsets.only(right: 6, top: 6),
                                child: ChoiceChip(
                                    label: Text(d == 1 ? "今天" : "近${d}天", style: const TextStyle(fontSize: 11.5)),
                                    selected: _win == d,
                                    showCheckmark: false,
                                    selectedColor: const Color(0xFF515BD4),
                                    labelStyle: TextStyle(fontSize: 11.5, color: _win == d ? Colors.white : Colors.blueGrey),
                                    onSelected: (_) => _setWin(d)))),
                            Padding(
                                padding: const EdgeInsets.only(right: 6, top: 6),
                                child: ChoiceChip(
                                    avatar: Icon(Icons.edit_calendar, size: 15, color: _win == 0 ? Colors.white : Colors.blueGrey),
                                    label: Text(_win == 0 ? "自定义中" : "自定义", style: const TextStyle(fontSize: 11.5)),
                                    selected: _win == 0,
                                    showCheckmark: false,
                                    selectedColor: const Color(0xFF515BD4),
                                    labelStyle: TextStyle(fontSize: 11.5, color: _win == 0 ? Colors.white : Colors.blueGrey),
                                    onSelected: (_) => _pickRange())),
                          ])),
                  // 分段
                  Padding(
                      padding: const EdgeInsets.fromLTRB(10, 6, 10, 0),
                      child: Row(children: [
                        SegmentedButton<int>(
                            style: const ButtonStyle(visualDensity: VisualDensity.compact),
                            segments: const [
                              ButtonSegment(value: 0, label: Text("📊 消耗账本")),
                              ButtonSegment(value: 1, label: Text("🧊 呆滞榜")),
                            ],
                            selected: {_tab},
                            onSelectionChanged: (s) => setState(() => _tab = s.first)),
                        const Spacer(),
                        if (_agg.truncated)
                          const Text("服务器保留最近500单", style: TextStyle(fontSize: 10.5, color: Colors.orange)),
                      ])),
                  Expanded(child: _tab == 0 ? _consumeView() : _staleView()),
                ]),
    );
  }

  Widget _consumeView() {
    final a = _agg;
    final rate = a.prevQty > 0 ? (a.qty - a.prevQty) / a.prevQty * 100 : null;
    final maxDay = a.days.fold<double>(0, (m, e) => e.value > m ? e.value : m);
    return ListView(padding: const EdgeInsets.fromLTRB(10, 8, 10, 20), children: [
      // 概览卡
      Card(
          margin: EdgeInsets.zero,
          child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Text("${_win > 0 ? "近$_win天" : "所选区间"}消耗", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Color(0xFF3949AB))),
                  const Spacer(),
                  if (rate != null)
                    Text("环比 ${rate >= 0 ? "+" : ""}${rate.round()}%",
                        style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w700, color: rate >= 0 ? const Color(0xFFE53935) : const Color(0xFF43A047))),
                ]),
                const SizedBox(height: 8),
                Row(children: [
                  _stat("${_fmtInvNum(a.qty)}", "件数"),
                  _stat("${a.orders}", "单"),
                  _stat("${a.kinds}", "种类"),
                  _stat("${a.rush}", "急料"),
                ]),
              ]))),
      const SizedBox(height: 8),
      // 按天柱状（点柱看当日单据）
      Card(
          margin: EdgeInsets.zero,
          child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text("按天消耗（点柱子看当日单据）", style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 8),
                SizedBox(
                    height: 96,
                    child: a.days.isEmpty
                        ? const Center(child: Text("窗口内无领用", style: TextStyle(fontSize: 11.5, color: Colors.grey)))
                        : SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
                              for (final d in a.days)
                                GestureDetector(
                                    onTap: () => _dayDetail(d.key),
                                    child: SizedBox(
                                        width: 34,
                                        child: Column(mainAxisAlignment: MainAxisAlignment.end, children: [
                                          Text(d.value <= 0 ? "" : _fmtInvNum(d.value).replaceAll(".0", ""),
                                              maxLines: 1, style: const TextStyle(fontSize: 8.5, color: Colors.blueGrey)),
                                          Container(
                                              height: maxDay > 0 ? (70 * d.value / maxDay).clamp(d.value > 0 ? 4.0 : 0.0, 70.0) : 0,
                                              margin: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                                              decoration: BoxDecoration(
                                                  color: d.value > 0 ? const Color(0xFF515BD4) : const Color(0xFFE3E6EE),
                                                  borderRadius: BorderRadius.circular(3))),
                                          Text("${d.key.month}/${d.key.day}", style: const TextStyle(fontSize: 9, color: Colors.grey)),
                                        ]))),
                            ]))),
              ]))),
      const SizedBox(height: 8),
      const Text("按零件消耗排行（🔄一键续领按日均量补货）",
          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF3949AB))),
      ...a.parts.map(_partCard),
      if (a.parts.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text("窗口内没有领用记录", style: TextStyle(color: Colors.grey)))),
    ]);
  }

  Widget _stat(String v, String t) => Expanded(
      child: Column(children: [
        Text(v, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: Color(0xFF515BD4))),
        Text(t, style: const TextStyle(fontSize: 10.5, color: Colors.black54)),
      ]));

  Widget _partCard(_LedgerPart p) {
    final dl = p.daysLeft;
    final col = dl.isInfinite ? Colors.green : (dl < 3 ? const Color(0xFFE53935) : dl < 7 ? const Color(0xFFF9A825) : const Color(0xFF43A047));
    return Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 6, 9),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                    child: Text("${p.partNo}  ${p.itemName}",
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700))),
                TextButton.icon(
                    style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 6), visualDensity: VisualDensity.compact, foregroundColor: const Color(0xFF515BD4)),
                    onPressed: () => _again(p),
                    icon: const Icon(Icons.refresh, size: 15),
                    label: const Text("续领", style: TextStyle(fontSize: 11.5))),
              ]),
              Row(children: [
                Expanded(
                    child: Text(
                        "领 ${_fmtInvNum(p.qty)} 件 · ${p.orders} 单 · 日均 ${_fmtInvNum(p.daily)} · 在库 ${_fmtInvNum(p.stock)} 件/${p.boxes} 框",
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey))),
                Text(dl.isInfinite ? "撑>30天" : "撑 ${dl.toStringAsFixed(1)} 天",
                    style: TextStyle(fontSize: 11.5, fontWeight: FontWeight.w800, color: col)),
              ]),
            ])));
  }

  void _dayDetail(DateTime d) {
    final e = d.add(const Duration(days: 1));
    final rows = _rowsIn(d, e).where((x) => (x["qty"] as double) > 0).toList();
    showModalBottomSheet(
        context: context,
        builder: (ctx) => SafeArea(
            child: ListView(shrinkWrap: true, padding: const EdgeInsets.all(12), children: [
                  Text("${d.month}月${d.day}日 领用明细（${rows.length} 行 · ${_fmtInvNum(rows.fold<double>(0, (a, x) => a + (x["qty"] as double)))} 件）",
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                  const SizedBox(height: 6),
                  if (rows.isEmpty) const Padding(padding: EdgeInsets.all(20), child: Center(child: Text("当天无领用", style: TextStyle(color: Colors.grey)))),
                  ...rows.map((x) => ListTile(
                      dense: true,
                      title: Text("${x["pn"]} ${_names[x["pn"]] ?? ""}", maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12.5)),
                      subtitle: Text("${x["by"]} · ${_fmtInvNum(x["qty"])} 件 · ${x["no"]}${x["rush"] == true ? " · 🔥急料" : ""}", style: const TextStyle(fontSize: 11)),
                      trailing: TextButton(
                          onPressed: () {
                            Navigator.pop(ctx);
                            kReqAgain.value = "${x["pn"]}|${_fmtInvNum(x["qty"])}|${DateTime.now().millisecondsSinceEpoch}"; // 点行=照这行量续领
                            Navigator.pop(context);
                          },
                          child: const Text("续领", style: TextStyle(fontSize: 11.5))),
                      )),
                ])));
  }

  Widget _staleView() {
    final s = _agg.stale;
    return ListView(padding: const EdgeInsets.fromLTRB(10, 8, 10, 20), children: [
      Card(
          margin: EdgeInsets.zero,
          color: const Color(0xFFFFF4E5),
          child: const Padding(
              padding: EdgeInsets.all(12),
              child: Text("呆滞榜：全厂有在库、但近 30 天无人领用的零件（按在库量降序）。占着货架和资金，建议运营核对是否可退供方、改他用或降安全库存。",
                  style: TextStyle(fontSize: 12, color: Color(0xFF8D5000), height: 1.45)))),
      const SizedBox(height: 8),
      Text("共 ${s.length} 种呆滞零件", style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: Color(0xFF3949AB))),
      ...s.map((p) => Card(
          margin: const EdgeInsets.symmetric(vertical: 4),
          child: ListTile(
              dense: true,
              leading: const Icon(Icons.snowing, color: Color(0xFF0288D1)),
              title: Text("${p.partNo}  ${p.itemName}", maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              subtitle: Text("在库 ${_fmtInvNum(p.stock)} 件 · ${p.boxes} 框 · ${p.lastAt == null ? "500单内查无领用记录" : "最后领用 ${_fmtYMD(p.lastAt!)}"}",
                  style: const TextStyle(fontSize: 11, color: Colors.blueGrey)),
              trailing: const Icon(Icons.chevron_right, size: 18, color: Colors.grey)))),
      if (s.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text("没有呆滞零件，库存周转健康 👍", style: TextStyle(color: Colors.grey)))),
    ]);
  }
}

class _Agg {
  final int orders, kinds, rush;
  final double qty, prevQty;
  final List<_LedgerPart> parts;
  final List<MapEntry<DateTime, double>> days;
  final List<_LedgerPart> stale;
  final bool truncated;
  _Agg({required this.orders, required this.kinds, required this.rush, required this.qty, required this.prevQty, required this.parts, required this.days, required this.stale, required this.truncated});
}
