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
        _free = ((r["freeStns"] as List?) ?? [])
            .map((e) => e.toString())
            .toList(); // ㉖ 列表自带空闲台：不搜索也能选台
        final al = r["aliases"];
        if (al is Map)
          _stnAlias =
              al.map((k, v) => MapEntry(k.toString(), v.toString()));
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
      _toast(r["queued"] == true
          ? "✅ 已入队 → ${rec["station"] ?? ""}（站台空闲且真实下发模式时自动发车）"
          : "✅ 已下架 → ${rec["station"] ?? "站台"}，到台后通知归位");
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
        ? (r["queued"] == true
            ? "✅ 已入队（${((r["rec"] as Map?)?["station"]) ?? ""}），站台空闲且真实下发模式时自动发车"
            : (st == "waitOut"
                ? "✅ 已协助下架 → ${((r["rec"] as Map?)?["station"]) ?? "站台"}，到台后通知检验员"
                : "✅ 已协助归位，AGV 送回原货位后自动完成"))
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

  bool _canCancel(Map q, String st) {
    if (!['waitOut', 'toStation', 'returning'].contains(st)) return false; // 框已在站台/待退货须走归位或退货通道
    return _assist || q["uid"] == Auth.user?.id; // 本人发起或仓管/管理员可取消
  }

  Future<void> _cancelWo(Map q) async {
    final st = (q["state"] ?? "").toString();
    final yes = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
                title: Text(st == "returning" ? "取消归位任务" : "取消检验工单"),
                content: Text(st == "waitOut"
                    ? "取消 ${q["code"] ?? ""} 的下架工单？尚未派车，直接作废。"
                    : (st == "returning"
                        ? "撤销 ${q["code"] ?? ""} 的归位任务？框尚未叉出则可撤，工单退回「站台待检」可再操作。"
                        : "取消 ${q["code"] ?? ""}？将同步撤销已下发的 AGV 任务；若 AGV 已叉出货则撤销会被拒，需人工处理。")),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2, false),
                      child: const Text("返回")),
                  FilledButton(
                      onPressed: () => Navigator.pop(c2, true),
                      child: Text("取消工单",
                          style: TextStyle(color: Colors.red.shade50))),
                ]));
    if (yes != true || !mounted) return;
    final r = await AuthApi.inspectCancel(q["id"].toString());
    if (!mounted) return;
    _toast(r["ok"] == true
        ? "✅ ${r["msg"] ?? "工单已取消"}"
        : "取消失败：${r["msg"]}");
    _load();
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
            if (_canCancel(q, st)) ...[
              const SizedBox(width: 6),
              OutlinedButton.icon(
                  onPressed: () => _cancelWo(q),
                  icon: const Icon(Icons.cancel_outlined, size: 16),
                  label: const Text("取消工单"),
                  style: OutlinedButton.styleFrom(
                      foregroundColor: Colors.red.shade700,
                      padding: const EdgeInsets.symmetric(horizontal: 10))),
            ],
            if (st == "waitReturn")
              if (_assist)
                FilledButton.icon(
                    onPressed: () => Navigator.push(
                        context,
                        MaterialPageRoute(
                            builder: (_) => _InspectReturnPage(q: q, onDone: _load))),
                    icon: const Icon(Icons.outbox, size: 18),
                    label: const Text("退库出账"),
                    style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFFB26A00),
                        padding: const EdgeInsets.symmetric(horizontal: 14)))
              else
                Text("等待仓管出库出账",
                    style: const TextStyle(fontSize: 11, color: Color(0xFFB26A00))),
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

// ===================== ㉖ 检验退库出账页：判退货的框（waitReturn，压站台不回原货位）→ 扫转入货位 + 扫标签强核对一致 → MES直调出账 =====================
// 逻辑：①扫/输转入货位（复用 mesLocInfo 大小写兜底）②扫货物标签，与工单标签不一致直接拒绝（防错框）③一致后查 MES 在库拿真实数量
// ④点退库：SaveTRBarcodes 出账（同直调通道）→ createOutboundOrder 落出库台账并自动整框消账（库存减、库位清空）→ 服务器检测该框已不在账本，工单自动转「已退货出账」闭环
class _InspectReturnPage extends StatefulWidget {
  final Map q;
  final VoidCallback? onDone;
  const _InspectReturnPage({required this.q, this.onDone});
  @override
  State<_InspectReturnPage> createState() => _InspectReturnPageState();
}

class _InspectReturnPageState extends State<_InspectReturnPage> {
  final _locCtrl = TextEditingController();
  final _locFocus = FocusNode();
  final _labelCtrl = TextEditingController();
  final _labelFocus = FocusNode();
  Map<String, String> _to = {};
  Map<String, dynamic>? _label; // 核对通过并查到在库的 MES 标签数据
  double _qty = 0;
  bool _busy = false, _submitting = false;

  String get _woCode => (widget.q["code"] ?? "").toString().toUpperCase();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _locFocus.requestFocus());
  }

  @override
  void dispose() {
    _locCtrl.dispose();
    _locFocus.dispose();
    _labelCtrl.dispose();
    _labelFocus.dispose();
    super.dispose();
  }

  void _toast(String m, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(m),
        backgroundColor: err ? Colors.red : Colors.green));
  }

  void _refocus(FocusNode f) {
    f.unfocus();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) f.requestFocus();
    });
  }

  Future<void> _scanLoc() async {
    final code = _locCtrl.text.trim();
    if (code.isEmpty) return;
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final d = await mesLocInfo(code); // 大小写兜底（MES 主档可能小写货位码）
      if (d == null) {
        _toast("货位查询无信息：$code");
        _refocus(_locFocus);
        return;
      }
      setState(() {
        _to = {
          "WAREHOUSE_CODE": d["WAREHOUSE_CODE"]?.toString() ?? "",
          "WAREHOUSE_NAME": d["WAREHOUSE_NAME"]?.toString() ?? "",
          "DISTRICT_CODE": d["DISTRICT_CODE"]?.toString() ?? "",
          "DISTRICT_NAME": d["DISTRICT_NAME"]?.toString() ?? "",
          "LOC_CODE": d["LOC_CODE"]?.toString() ?? "",
          "LOC_NAME": d["LOC_NAME"]?.toString() ?? "",
        };
        _label = null; // 换货位清空已扫标签（防串单）
        _qty = 0;
      });
      _refocus(_labelFocus);
    } catch (e) {
      _toast("货位查询失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _scanLabel() async {
    final code = _labelCtrl.text.trim().toUpperCase();
    _labelCtrl.clear();
    if (code.isEmpty) return;
    if ((_to["LOC_CODE"] ?? "").isEmpty) {
      _toast("请先扫描转入货位");
      _refocus(_locFocus);
      return;
    }
    if (_busy) return;
    // 强核对：扫的标签必须就是本工单要退库的标签
    if (code != _woCode) {
      _toast("标签不符：扫入 $code，本工单退库标签应为 $_woCode");
      _refocus(_labelFocus);
      return;
    }
    setState(() => _busy = true);
    try {
      final d = await mesGetData(
          "/api/v1/rawtransfer/GetBarCodeInfoOnHand", {
        "barcode": code,
        "warehouseCode": _to["WAREHOUSE_CODE"] ?? "",
        "districtCode": _to["DISTRICT_CODE"] ?? "",
        "locCode": _to["LOC_CODE"] ?? "",
      });
      if (d == null) {
        _toast("MES 查无该标签在库信息，无法退库：$code");
        _refocus(_labelFocus);
        return;
      }
      setState(() {
        _label = Map<String, dynamic>.from(d);
        _qty = (d["QTY"] as num?)?.toDouble() ?? 0;
      });
    } catch (e) {
      _toast("标签查询失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _busy = false);
      _refocus(_labelFocus);
    }
  }

  bool get _ready =>
      (_to["LOC_CODE"] ?? "").isNotEmpty && _label != null && _woCode.isNotEmpty;

  Future<void> _submit() async {
    if (_submitting || !_ready) return;
    final yes = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
              title: const Text("确认退库出账"),
              content: Text(
                  "标签 $_woCode（${widget.q["part"] ?? ""}）\n退往：${_to["WAREHOUSE_NAME"]}/${_to["DISTRICT_NAME"]}/${_to["LOC_NAME"]}\n数量：${_qty} 件\n\n提交后：MES 直调出账 → 库存扣减、该框库位清空 → 检验工单自动「已退货出账」闭环。不可撤销，确认？"),
              actions: [
                TextButton(onPressed: () => Navigator.pop(c2, false), child: const Text("取消")),
                FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: const Color(0xFFB26A00)),
                    onPressed: () => Navigator.pop(c2, true),
                    child: const Text("确认退库")),
              ],
            ));
    if (yes != true || !mounted) return;
    setState(() => _submitting = true);
    try {
      final labelNo = (_label!["SCAN_BARCODE"] ?? _label!["LABEL_NO"] ?? _woCode).toString();
      final label = Map<String, dynamic>.from(_label!)..["SCAN_BARCODE"] = labelNo;
      final row = <String, dynamic>{
        "PART_NO": (widget.q["part"] ?? "").toString(),
        "MITEM_ID": _label!["MITEM_ID"],
        "MITEM_CODE": _label!["MITEM_CODE"],
        "MITEM_NAME": _label!["MITEM_DESC"] ?? _label!["MITEM_NAME"] ?? "",
        "UOM": _label!["UOM"] ?? "",
        "REQ_QTY": _qty,
        "Barcodes": [label],
      };
      final detail = Map<String, dynamic>.from(row)..remove("PART_NO");
      detail["TO_WAREHOUSE_CODE"] = _to["WAREHOUSE_CODE"];
      detail["TO_DISTRICT_CODE"] = _to["DISTRICT_CODE"];
      detail["TO_LOC_CODE"] = _to["LOC_CODE"];
      detail["isCheckSap"] = false;
      // ① MES 直调出账（同直调通道，失败抛异常进 catch，不落本地账）
      await mesReq("POST", "/api/v1/rawtransfer/SaveTRBarcodes", body: {"details": [detail]});
      // ② 落出库台账 + 自动整框消账（库存减、库位清空、同步电脑）；失败不回滚 MES（已真实出账），仅提示
      try {
        final ob = await createOutboundOrder([row], Map<String, String>.from(_to));
        _toast("退库成功，已生成出库单 ${ob.orderNo}，工单将转「已退货出账」", err: false);
      } catch (e) {
        _toast("MES 已出账，但出库台账落库失败：$e");
      }
      widget.onDone?.call();
      if (mounted) Navigator.pop(context);
    } catch (e) {
      _toast("退库失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
        title: Text("退库出账 · $_woCode", style: const TextStyle(fontSize: 16)),
        backgroundColor: const Color(0xFFB26A00),
        foregroundColor: Colors.white,
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
                color: Colors.white, borderRadius: BorderRadius.circular(10)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text("检验工单：${widget.q["part"] ?? ""}${(widget.q["nm"] ?? "").toString().isNotEmpty ? " · ${widget.q["nm"]}" : ""}",
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
              const SizedBox(height: 4),
              Text("原货位 ${widget.q["from"] ?? ""} → 现压站台 ${widget.q["station"] ?? ""}",
                  style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
              if ((widget.q["retReason"] ?? "").toString().isNotEmpty)
                Text("退货原因：${widget.q["retReason"]}",
                    style: const TextStyle(fontSize: 12, color: Color(0xFFB26A00))),
            ])),
        const SizedBox(height: 12),
        // 第一步：转入货位
        Row(children: [
          Expanded(
              child: TextField(
                  controller: _locCtrl,
                  focusNode: _locFocus,
                  textInputAction: TextInputAction.done,
                  onSubmitted: (_) => _scanLoc(),
                  decoration: const InputDecoration(
                      labelText: "① 扫描/输入转入货位 *",
                      isDense: true,
                      border: OutlineInputBorder(),
                      prefixIcon: Icon(Icons.location_searching, size: 20)))),
          const SizedBox(width: 8),
          ElevatedButton(
              onPressed: _busy ? null : _scanLoc,
              style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
              child: const Text("查询")),
        ]),
        if ((_to["LOC_CODE"] ?? "").isNotEmpty)
          Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text("转入：${_to["WAREHOUSE_NAME"]}/${_to["DISTRICT_NAME"]}/${_to["LOC_NAME"]}（${_to["LOC_CODE"]}）",
                  style: const TextStyle(fontSize: 12.5, color: Color(0xFF00897B), fontWeight: FontWeight.w600))),
        const SizedBox(height: 12),
        // 第二步：扫标签核对
        TextField(
            controller: _labelCtrl,
            focusNode: _labelFocus,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _scanLabel(),
            decoration: InputDecoration(
                labelText: "② 扫描该框货物标签（须为 $_woCode）",
                isDense: true,
                border: const OutlineInputBorder(),
                prefixIcon: const Icon(Icons.qr_code_scanner, size: 20))),
        if (_label != null)
          Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text("✓ 标签核对一致 · 在库 $_qty 件（${_label!["MITEM_DESC"] ?? _label!["MITEM_NAME"] ?? ""}）",
                  style: const TextStyle(fontSize: 12.5, color: Colors.green, fontWeight: FontWeight.w600))),
        const SizedBox(height: 18),
        ElevatedButton.icon(
            onPressed: (_ready && !_submitting) ? _submit : null,
            style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFFB26A00),
                foregroundColor: Colors.white,
                padding: const EdgeInsets.symmetric(vertical: 14),
                disabledBackgroundColor: Colors.grey.shade300),
            icon: const Icon(Icons.outbox),
            label: Text(_submitting ? "退库中…" : "③ 退库出账（库存减·库位清空）")),
        if (!_ready)
          Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text("需先查询转入货位并扫描核对标签一致后方可退库",
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 11.5, color: Colors.grey))),
      ]),
    );
  }
}
