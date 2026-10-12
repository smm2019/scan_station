part of 'main.dart';

// ===================== ㉖④ 检验模式页：按零件号搜框 → AGV下架到站台 → 检验备注 → 一键归位 =====================
class InspectPage extends StatefulWidget {
  const InspectPage({super.key});
  @override
  State<InspectPage> createState() => _InspectPageState();
}

class _InspectPageState extends State<InspectPage>
    with AutomaticKeepAliveClientMixin {
  final TextEditingController _pnCtrl = TextEditingController();
  List<Map> _boxes = [];
  List<Map> _list = [];
  List<String> _free = [];
  Map<String, String> _stnAlias = {}; // ㉖⑫ 站台→自定义别名（选台弹层显示）
  String _stnLabel(String code) {
    final a = _stnAlias[code] ?? "";
    return a.isEmpty ? code : "$a(${code.split("-").last})";
  }

  int _total = 0;
  bool _searching = false, _searched = false, _loading = false, _loaded = false;
  String _err = "", _serr = "";
  Timer? _timer;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
    _timer =
        Timer.periodic(const Duration(seconds: 20), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _pnCtrl.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent && mounted) setState(() => _loading = true);
    final r = await AuthApi.inspectList();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _loaded = true;
      if (r["ok"] == true) {
        _list = List<Map>.from(r["list"] ?? []);
        _err = "";
      } else if (!silent) {
        _err = (r["msg"] ?? "加载失败").toString();
      }
    });
  }

  Future<void> _search() async {
    final q = _pnCtrl.text.trim().toUpperCase();
    if (q.length < 2) {
      _toast("零件号片段至少2个字符（也可直接扫/贴完整标签号）");
      return;
    }
    setState(() {
      _searching = true;
      _serr = "";
    });
    final r = await AuthApi.inspectSearch(q);
    if (!mounted) return;
    setState(() {
      _searching = false;
      _searched = true;
      if (r["ok"] == true) {
        _boxes = List<Map>.from(r["boxes"] ?? []);
        _total = (r["total"] as num?)?.toInt() ?? _boxes.length;
        _free =
            ((r["freeStns"] as List?) ?? []).map((e) => e.toString()).toList();
        final al = r["aliases"];
        _stnAlias = al is Map
            ? al.map((k, v) => MapEntry(k.toString(), v.toString()))
            : {}; // ㉖⑫ 站台别名（选台弹层显示）
        _serr = "";
      } else {
        _boxes = [];
        _serr = (r["msg"] ?? "搜索失败").toString();
      }
    });
  }

  Future<String?> _pickStation() async {
    if (_free.isEmpty) {
      _toast("当前无空闲站台（都占有货/队列/检验），请先清台或稍后再试");
      return null;
    }
    return showModalBottomSheet<String>(
        context: context,
        builder: (c2) => SafeArea(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Padding(
                  padding: EdgeInsets.all(12),
                  child: Text("指定检验下架站台",
                      style: TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 15))),
              ..._free.map((st) => ListTile(
                  leading: const Icon(Icons.pin_drop_outlined,
                      color: Color(0xFF00897B)),
                  title: Text(_stnLabel(st)), // ㉖⑫ 别名优先显示
                  onTap: () => Navigator.pop(c2, st))),
              TextButton(
                  onPressed: () => Navigator.pop(c2), child: const Text("取消")),
            ])));
  }

  Future<void> _start(Map b, {String station = ""}) async {
    final why = await _prompt("检验事由备注（必填，将记入工单与留痕）", "");
    if (why == null || why.trim().isEmpty) return;
    if (!mounted) return;
    final loc = (b["loc"] ?? "").toString();
    final codes = List<String>.from(b["codes"] ?? []);
    final part = (b["part"] ?? "").toString();
    final nm = (b["nm"] ?? "").toString();
    final firstTag = codes.isNotEmpty ? codes[0] : "";
    final more = codes.length > 1 ? " 等${codes.length}码" : "";
    final nmX = nm.isNotEmpty ? " · $nm" : "";
    final stTip = (station.isEmpty ? "自动分配空闲站台" : station) +
        (_assist ? "" : "（提交后由仓管/管理员协助派车）");
    final yes = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
                title: const Text("确认检验下架"),
                content: Text(
                    "货位 $loc\n零件 $part$nmX · ${b["q"] ?? 0}件\n标签 $firstTag$more\n\n站台：$stTip\n检验完成后在本页点「检验完·归位」，AGV 原样送回 $loc。"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2, false),
                      child: const Text("取消")),
                  FilledButton(
                      onPressed: () => Navigator.pop(c2, true),
                      child: const Text("发起下架")),
                ]));
    if (yes != true || !mounted) return;
    final r = await AuthApi.inspectStart(loc, why.trim(), station: station);
    if (!mounted) return;
    if (r["ok"] == true) {
      final rec = Map.from(r["rec"] ?? {});
      _toast("✅ 已下架 → ${rec["station"] ?? "站台"}，到台后通知归位");
      _search();
      _load();
    } else {
      _toast("发起失败：${r["msg"] ?? "未知错误"}");
      _search(); // 状态可能已变化，刷新框列表
    }
  }

  bool get _assist => Auth.can("insp_assist") || Auth.user?.role == "admin";

  Future<void> _assistAct(Map q) async {
    final st = (q["state"] ?? "").toString();
    String station = "";
    if (st == "waitOut") {
      final pick = await _pickStation();
      if (pick == null) return; // 无空闲台或用户取消
      station = pick;
    } else {
      final yes = await showDialog<bool>(
          context: context,
          builder: (c2) => AlertDialog(
                  title: const Text("协助归位"),
                  content: Text(
                      "确认派 AGV 将 ${q["code"] ?? ""} 送回原货位 ${q["from"] ?? ""}？"),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(c2, false),
                        child: const Text("取消")),
                    FilledButton(
                        onPressed: () => Navigator.pop(c2, true),
                        child: const Text("确定")),
                  ]));
      if (yes != true) return;
    }
    final r = await AuthApi.inspectAssist(q["id"].toString(), station: station);
    if (!mounted) return;
    _toast(r["ok"] == true
        ? (st == "waitOut"
            ? "✅ 已协助下架 → ${((r["rec"] as Map?)?["station"]) ?? "站台"}，到台后通知检验员"
            : "✅ 已协助归位，AGV 送回原货位后自动完成")
        : "失败：${r["msg"]}");
    if (r["ok"] == true) _load();
  }

  Future<void> _verdict(Map q) async {
    final vd = await _prompt("检验结论（通过 / 不合格 / 需复检 / 退货）", "通过");
    if (vd == null) return;
    final v2 =
        ["通过", "不合格", "需复检", "退货"].contains(vd.trim()) ? vd.trim() : "通过";
    String rr = "";
    if (v2 == "退货") {
      final r0 = await _prompt("退货原因（必填，如：来料不良/错料/供应商发错）", "");
      if (r0 == null || r0.trim().isEmpty) {
        _toast("退货必须填写原因");
        return;
      }
      rr = r0.trim();
    }
    final note = await _prompt("检验备注（可留空，记入工单留痕）", "");
    if (note == null) return;
    final r = await AuthApi.inspectVerdict(q["id"].toString(), v2, note.trim(),
        retReason: rr);
    if (!mounted) return;
    _toast(r["ok"] == true
        ? (r["returned"] == true
            ? "✅ 已判退货：货留在站台，请仓管按直调/领料出库流程出账"
            : "✅ 结论已记录[$v2]${r["wait"] == true ? '，已通知仓管协助归位' : ''}")
        : "失败：${r["msg"]}");
    if (r["ok"] == true) _load();
  }

  Future<void> _ret(Map q) async {
    final note = await _prompt("检验结果备注（必填，将记入工单留痕）", "");
    if (note == null || note.trim().isEmpty) return;
    final r = await AuthApi.inspectReturn(q["id"].toString(), note.trim());
    if (!mounted) return;
    _toast(r["ok"] == true ? "✅ 归位任务已下发，AGV 送回原货位后自动完成" : "失败：${r["msg"]}");
    if (r["ok"] == true) _load();
  }

  Future<String?> _prompt(String title, String init) async {
    final ctl = TextEditingController(text: init);
    final res = await showDialog<String>(
        context: context,
        builder: (c2) => AlertDialog(
                title: Text(title, style: const TextStyle(fontSize: 15.5)),
                content: TextField(
                    controller: ctl,
                    maxLines: 2,
                    autofocus: true,
                    decoration: const InputDecoration(hintText: "填写内容")),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2),
                      child: const Text("取消")),
                  FilledButton(
                      onPressed: () => Navigator.pop(c2, ctl.text),
                      child: const Text("确定")),
                ]));
    ctl.dispose();
    return res;
  }

  void _toast(String s) {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(s),
          backgroundColor: s.startsWith("✅")
              ? Colors.green
              : (s.startsWith("失败") || s.startsWith("⚠")
                  ? Colors.red
                  : Colors.blueGrey)));
  }

  String _stText(String s) => switch (s) {
        "waitOut" => "🤝 待协助下架",
        "waitBack" => "🤝 待协助归位",
        "waitReturn" => "🔁 待退货出账",
        "toStation" => "🚚 下架途中",
        "atStation" => "📍 站台待检",
        "returning" => "🔙 归位途中",
        "done" => "✅ 已归位",
        "returned" => "✅ 已退货出账",
        "stuck" => "⚠️ 超时待核",
        "cancel" => "已取消",
        _ => s,
      };

  Widget _boxCard(Map b) {
    final can = b["canDown"] == true;
    final codes = List<String>.from(b["codes"] ?? []);
    final loc = (b["loc"] ?? "").toString();
    final part = (b["part"] ?? "").toString();
    final nm = (b["nm"] ?? "").toString();
    final ct = (b["ct"] ?? "").toString();
    final tg = codes.take(2).join("、") +
        (codes.length > 2 ? " 等${codes.length}码" : "");
    final nmX = nm.isNotEmpty ? " · $nm" : "";
    final why = (b["why"] ?? "").toString();
    return Card(
        margin: const EdgeInsets.fromLTRB(10, 0, 10, 8),
        child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 6),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                    child: Text(loc,
                        style: const TextStyle(
                            fontFamily: "monospace",
                            fontWeight: FontWeight.bold,
                            fontSize: 14.5))),
                Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                    decoration: BoxDecoration(
                        color:
                            can ? Colors.green.shade50 : Colors.grey.shade200,
                        borderRadius: BorderRadius.circular(8)),
                    child: Text(can ? "可下架" : (why.isEmpty ? "不可下架" : why),
                        style: TextStyle(
                            fontSize: 11,
                            color: can
                                ? Colors.green.shade800
                                : Colors.blueGrey.shade700))),
              ]),
              Text(
                  "$part$nmX · ${b["q"] ?? 0}件${ct.isNotEmpty ? " · 容器 $ct" : ""}",
                  style:
                      const TextStyle(fontSize: 12.5, color: Colors.blueGrey)),
              Text(tg,
                  style: const TextStyle(
                      fontSize: 11.5,
                      color: Colors.grey,
                      fontFamily: "monospace")),
              Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                if (can)
                  TextButton.icon(
                      onPressed: () => _start(b),
                      icon: const Icon(Icons.local_shipping_outlined,
                          size: 18, color: Color(0xFF515BD4)),
                      label: const Text("一键下架",
                          style: TextStyle(color: Color(0xFF515BD4)))),
                if (can)
                  TextButton.icon(
                      onPressed: () async {
                        final st = await _pickStation();
                        if (st != null && mounted) _start(b, station: st);
                      },
                      icon: const Icon(Icons.pin_drop_outlined,
                          size: 18, color: Color(0xFF00897B)),
                      label: const Text("指定站台",
                          style: TextStyle(color: Color(0xFF00897B)))),
              ]),
            ])));
  }

  Widget _woCard(Map q) {
    final st = (q["state"] ?? "").toString();
    final mins = st == "atStation"
        ? ((DateTime.now().millisecondsSinceEpoch -
                    ((q["arriveAt"] ?? q["at"]) as num).toInt()) /
                60000)
            .round()
        : 0;
    final note = (q["note"] ?? "").toString();
    final note2 = (q["note2"] ?? "").toString();
    final err = (q["err"] ?? "").toString();
    return Card(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: Text("${q["code"] ?? ""}",
                    style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        fontFamily: "monospace",
                        fontSize: 15))),
            Text(_stText(st),
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: st == "atStation"
                        ? Colors.orange
                        : (st == "done"
                            ? Colors.green
                            : (st == "stuck" ? Colors.red : Colors.blueGrey)))),
          ]),
          const SizedBox(height: 4),
          Text("${q["from"] ?? ""} ⇄ ${q["station"] ?? ''}",
              style: const TextStyle(fontSize: 13)),
          Text("${q["part"] ?? ""}",
              style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
          if (note.isNotEmpty)
            Text("事由：$note",
                style: const TextStyle(fontSize: 12, color: Colors.grey)),
          if (note2.isNotEmpty)
            Text("检验：$note2",
                style: const TextStyle(fontSize: 12, color: Colors.teal)),
          if (err.isNotEmpty)
            Text(err, style: const TextStyle(fontSize: 12, color: Colors.red)),
          if (mins > 0)
            Text("已在站台等待约 $mins 分钟",
                style:
                    const TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(
                child: Text(
                    "${q["by"] ?? ""} · ${((q["at"] ?? 0) as num).toInt() > 0 ? DateTime.fromMillisecondsSinceEpoch((q["at"] as num).toInt()).toString().substring(5, 16) : ""}",
                    style: const TextStyle(fontSize: 11, color: Colors.grey))),
            if (st == "atStation" && _assist) ...[
              FilledButton.icon(
                  onPressed: () => _ret(q),
                  icon: const Icon(Icons.restore, size: 16),
                  label: const Text("检验完·归位"),
                  style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF00897B),
                      padding: const EdgeInsets.symmetric(horizontal: 10))),
              const SizedBox(width: 6),
              FilledButton.icon(
                  onPressed: () => _verdict(q),
                  icon: const Icon(Icons.fact_check_outlined, size: 16),
                  label: const Text("结论/退货"),
                  style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFFB26A00),
                      padding: const EdgeInsets.symmetric(horizontal: 10))),
            ],
            if (st == "atStation" && !_assist)
              FilledButton.icon(
                  onPressed: () => _verdict(q),
                  icon: const Icon(Icons.fact_check_outlined, size: 18),
                  label: const Text("填写检验结论"),
                  style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF00897B),
                      padding: const EdgeInsets.symmetric(horizontal: 14))),
            if ((st == "waitOut" || st == "waitBack") && _assist)
              FilledButton.icon(
                  onPressed: () => _assistAct(q),
                  icon: const Icon(Icons.local_shipping_outlined, size: 18),
                  label: Text(st == "waitOut" ? "协助下架" : "协助归位"),
                  style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF515BD4),
                      padding: const EdgeInsets.symmetric(horizontal: 14))),
            if ((st == "waitOut" || st == "waitBack") && !_assist)
              Text(st == "waitOut" ? "等待仓管协助下架" : "等待仓管协助归位",
                  style: const TextStyle(fontSize: 11, color: Colors.grey)),
            if (st == "waitReturn")
              Text(_assist ? "🔁 请按直调/领料出库出账" : "等待仓管出库出账",
                  style:
                      const TextStyle(fontSize: 11, color: Color(0xFFB26A00))),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Column(children: [
      Container(
        width: double.infinity,
        color: const Color(0xFFF3F4FB),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: TextField(
                    controller: _pnCtrl,
                    textInputAction: TextInputAction.search,
                    onSubmitted: (_) => _search(),
                    decoration: const InputDecoration(
                        hintText: "零件号片段 / 完整标签号（扫码枪可直接扫）",
                        isDense: true,
                        prefixIcon: Icon(Icons.search, size: 20),
                        border: OutlineInputBorder(),
                        filled: true,
                        fillColor: Colors.white))),
            const SizedBox(width: 8),
            ElevatedButton(
                onPressed: _searching ? null : _search,
                style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF515BD4),
                    foregroundColor: Colors.white),
                child: Text(_searching ? "搜索中" : "搜索")),
          ]),
          const SizedBox(height: 4),
          Text(
              _free.isNotEmpty
                  ? "空闲站台 ${_free.length} 个：${_free.map(_stnLabel).join("、")}"
                  : (_searched && _serr.isEmpty
                      ? "⚠ 当前 12 个站台全部被占（有货/队列/检验），无法下架"
                      : "流程：搜零件号 → 选框下架到站台 → 现场检验 → 本页「检验完·归位」原样放回"),
              style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
        ]),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: () async {
            await _load();
            if (_searched) await _search();
          },
          child: ListView(
              padding: const EdgeInsets.symmetric(vertical: 8),
              children: [
                if (_serr.isNotEmpty)
                  Padding(
                      padding: const EdgeInsets.all(14),
                      child: Text("搜索失败：$_serr",
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              color: Colors.red, fontSize: 13))),
                if (_searched && _serr.isEmpty) ...[
                  Padding(
                      padding: const EdgeInsets.fromLTRB(12, 2, 12, 6),
                      child: Text(
                          "匹配货位（$_total 框${_total > _boxes.length ? "，显示前${_boxes.length}" : ""}）",
                          style: const TextStyle(
                              fontWeight: FontWeight.bold, fontSize: 13))),
                  if (_boxes.isEmpty)
                    const Padding(
                        padding: EdgeInsets.all(14),
                        child: Center(
                            child: Text("账本中无匹配在库框",
                                style: TextStyle(color: Colors.grey)))),
                  ..._boxes.map(_boxCard),
                  Container(
                      margin: const EdgeInsets.fromLTRB(12, 10, 12, 6),
                      padding: const EdgeInsets.only(top: 8),
                      decoration: const BoxDecoration(
                          border: Border(
                              top: BorderSide(color: Color(0xFFE0E0E0)))),
                      child: Text("检验工单（${_list.length}）",
                          style: TextStyle(
                              fontWeight: FontWeight.bold, fontSize: 13))),
                ],
                if (_err.isNotEmpty)
                  Padding(
                      padding: const EdgeInsets.all(14),
                      child: Text("工单加载失败：$_err",
                          textAlign: TextAlign.center,
                          style: const TextStyle(
                              color: Colors.red, fontSize: 13))),
                if (!_searched && _list.isEmpty && _loaded && _err.isEmpty)
                  const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(
                          child: Text("输入零件号搜索要检验的框\n（也可直接扫标签号）",
                              textAlign: TextAlign.center,
                              style: TextStyle(
                                  color: Colors.grey, fontSize: 13)))),
                ..._list.map(_woCard),
              ]),
        ),
      ),
    ]);
  }
}
