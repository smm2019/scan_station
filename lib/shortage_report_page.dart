part of 'main.dart';

// ===================== ㉖v74 缺料反馈：一键生成生产部格式缺料单，分享微信 =====================
// 口径：零库存 + 在途领料欠料（pending/accepted 需求−已发）+ 低水位（阈值可设，默认关）
// 版式：一物一单（反馈日期/车型/批次号/物料号/物料名称/异常描述/反馈单位/反馈人/责任单位/确认人/确认日期/@人员）
// 分享：文字（多单拼一条消息）或 图片（每单一张 PNG，系统分享面板直达微信）；数据不出本机

class _ShortageItem {
  final String partNo;
  String itemName;
  String carModel; // 车型（从物料名自动提取，可改）
  String lot; // 批次号（默认空，手填）
  String desc; // 异常描述（默认按口径生成，可改）
  double inStockQty; // 在库件数
  int inBoxes; // 在库框数
  double needQty; // 在途需求（未满足件数）
  String needFrom; // 需求来源单号摘要
  bool checked; // 是否纳入本次分享
  TextEditingController descC = TextEditingController();
  TextEditingController lotC = TextEditingController();
  TextEditingController carC = TextEditingController();
  _ShortageItem(this.partNo)
      : itemName = "",
        carModel = "",
        lot = "",
        desc = "",
        inStockQty = 0,
        inBoxes = 0,
        needQty = 0,
        needFrom = "",
        checked = true;
  void initCtrls() {
    descC.text = desc;
    lotC.text = lot;
    carC.text = carModel;
  }
  void dispose() {
    descC.dispose();
    lotC.dispose();
    carC.dispose();
  }
}

class ShortageReportPage extends StatefulWidget {
  const ShortageReportPage({super.key});
  @override
  State<ShortageReportPage> createState() => _ShortageReportPageState();
}

class _ShortageReportPageState extends State<ShortageReportPage> {
  static const _shareCh = MethodChannel("app.installer");
  // 全局字段本地记忆键（首次弹出设置后记住）
  static const _kUnit = "sr_feedback_unit",
      _kDuty = "sr_duty_unit",
      _kConf = "sr_confirmer",
      _kAt = "sr_at_names",
      _kLow = "sr_low_line";
  String _unit = "鄞州豪斯特生产部",
      _duty = "鄞州豪斯特运营部",
      _conf = "宋明明",
      _at = "Eleven、星光熠熠、雪哥儿";
  double _lowLine = 0; // 低水位阈值（0=不启用）
  bool _showZero = true, _showShort = true; // 口径开关
  final List<_ShortageItem> _items = [];
  bool _loading = true, _busy = false;
  int _mode = 0; // 0文字 1图片（多单合成一张长图）
  final GlobalKey _allKey = GlobalKey(); // 长图整体截取用

  static final RegExp _carRe =
      RegExp(r'(EX\d+|V\d{3}K|E\d{3}|L\d{3}K)'); // 车型：物料名自带（吉利EX11/沃尔沃V446K/E281…）

  @override
  void initState() {
    super.initState();
    SharedPreferences.getInstance().then((sp) {
      setState(() {
        _unit = sp.getString(_kUnit) ?? _unit;
        _duty = sp.getString(_kDuty) ?? _duty;
        _conf = sp.getString(_kConf) ?? _conf;
        _at = sp.getString(_kAt) ?? _at;
        _lowLine = (sp.getDouble(_kLow) ?? 0);
      });
    });
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final agg = await computeStock();
    // 在途需求聚合：pending/accepted 领料单逐行 需求−已发
    final needMap = <String, double>{};
    final needFromMap = <String, List<String>>{};
    try {
      final r = await AuthApi.reqList().timeout(const Duration(seconds: 8));
      if (r["ok"] == true) {
        for (final q in List<Map>.from(r["reqs"] ?? [])) {
          if (!['pending', 'accepted'].contains(q["status"])) continue;
          for (final it in List<Map>.from(q["items"] ?? [])) {
            final pn = (it["partNo"]?.toString() ?? "").toUpperCase();
            if (pn.isEmpty) continue;
            final issued = (it["issued"] is List)
                ? List.from(it["issued"] as List)
                : const [];
            double got = 0;
            for (final e in issued) {
              if (e is Map) got += (e["q"] as num?)?.toDouble() ?? 0;
            }
            final need = ((it["qty"] as num?)?.toDouble() ?? 0) - got;
            if (need <= 1e-9) continue;
            needMap[pn] = (needMap[pn] ?? 0) + need;
            (needFromMap[pn] ??= []).add(q["no"]?.toString() ?? "");
          }
        }
      }
    } catch (_) {}
    final out = <_ShortageItem>[];
    for (final row in agg.parts.values) {
      final pn = row.partNo.toUpperCase();
      if (pn.isEmpty) continue;
      final zero = row.inStockQty <= 1e-9;
      final short = (needMap[pn] ?? 0) - row.inStockQty > 1e-9;
      final low = _lowLine > 0 && row.inStockQty > 1e-9 && row.inStockQty < _lowLine;
      if (!((zero && _showZero) || (short && _showShort) || low)) continue;
      final it = _ShortageItem(row.partNo)
        ..itemName = row.itemName
        ..inStockQty = row.inStockQty
        ..inBoxes = row.inBoxes
        ..needQty = needMap[pn] ?? 0
        ..needFrom = (needFromMap[pn] ?? []).take(3).join("、");
      it.carModel = _carRe.firstMatch(row.itemName)?.group(1) ?? "";
      final tail = it.needQty > 0 ? "，待领 ${_fmtInvNum(it.needQty)} 件" : "";
      it.desc = zero
          ? "报缺，仓库无单件$tail"
          : (short ? "报缺，在库仅 ${_fmtInvNum(row.inStockQty)} 件，低于待领需求$tail" : "库存偏低，在库 ${_fmtInvNum(row.inStockQty)} 件$tail");
      it.initCtrls();
      out.add(it);
    }
    out.sort((a, b) {
      final az = a.inStockQty <= 0 ? 0 : 1, bz = b.inStockQty <= 0 ? 0 : 1;
      if (az != bz) return az - bz; // 零库存排前
      return b.needQty.compareTo(a.needQty); // 需求大的排前
    });
    for (final old in _items) {
      old.dispose();
    }
    _items.clear();
    _items.addAll(out);
    if (!mounted) return;
    setState(() => _loading = false);
  }

  String get _today {
    final d = DateTime.now();
    String p(int x) => x.toString().padLeft(2, "0");
    return "${d.year}.${p(d.month)}.${p(d.day)}";
  }

  String get _ats => _at
      .split(RegExp(r"[、,，;；\s]+"))
      .where((s) => s.trim().isNotEmpty)
      .map((s) => "@${s.trim()}")
      .join(" ");

  String _feedText(_ShortageItem it) => [
        "【缺料反馈】",
        "反馈日期：$_today",
        "车型：${it.carC.text}",
        "批次号：${it.lotC.text}",
        "物料号：${it.partNo}",
        "物料名称：${it.itemName}",
        "异常描述：${it.descC.text}",
        "反馈单位：$_unit",
        "反馈人：${Auth.user?.name ?? ''}",
        "责任单位：$_duty",
        "确认人：$_conf",
        "确认日期：$_today",
        _ats,
      ].join("\n");

  Future<void> _saveGlobals() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kUnit, _unit);
    await sp.setString(_kDuty, _duty);
    await sp.setString(_kConf, _conf);
    await sp.setString(_kAt, _at);
    await sp.setDouble(_kLow, _lowLine);
  }

  Future<void> _editGlobals() async {
    final u = TextEditingController(text: _unit),
        d = TextEditingController(text: _duty),
        c = TextEditingController(text: _conf),
        a = TextEditingController(text: _at),
        l = TextEditingController(text: _lowLine > 0 ? _fmtInvNum(_lowLine) : "");
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
            title: const Text("缺料单默认字段（记住，下次自动带出）"),
            content: SizedBox(
                width: 340,
                child: SingleChildScrollView(
                    child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                  TextField(controller: u, decoration: const InputDecoration(labelText: "反馈单位", isDense: true)),
                  TextField(controller: d, decoration: const InputDecoration(labelText: "责任单位", isDense: true)),
                  TextField(controller: c, decoration: const InputDecoration(labelText: "确认人", isDense: true)),
                  TextField(controller: a, decoration: const InputDecoration(labelText: "@人员（顿号分隔）", isDense: true)),
                  TextField(controller: l, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: "低水位阈值（件，0=不启用）", isDense: true, helperText: "在库低于此值也算缺料纳入清单", helperStyle: TextStyle(fontSize: 10))),
                ]))),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
              FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("保存")),
            ]));
    if (ok == true && mounted) {
      setState(() {
        _unit = u.text.trim().isEmpty ? _unit : u.text.trim();
        _duty = d.text.trim().isEmpty ? _duty : d.text.trim();
        _conf = c.text.trim().isEmpty ? _conf : c.text.trim();
        _at = a.text.trim().isEmpty ? _at : a.text.trim();
        _lowLine = double.tryParse(l.text.trim()) ?? 0;
      });
      _saveGlobals();
      _load(); // 阈值变了重算清单
    }
  }

  /// 图片模式：勾选的多张缺料单合成一张长图（微信对多图分享渠道兼容性差，长图最稳且适合群汇报）
  Future<List<String>> _captureImages() async {
    final ctx = _allKey.currentContext;
    final bo = ctx?.findRenderObject() as RenderRepaintBoundary?;
    if (bo == null) return const [];
    await Future.delayed(const Duration(milliseconds: 80)); // 等挂载布局
    // 纹理上限约 8192px：按逻辑高自适应缩放（单量少时保持 2.5 倍高清）
    final h = bo.size.height;
    final ratio = h <= 0 ? 2.5 : [2.5, 8000 / h].reduce((a, b) => a < b ? a : b);
    final img = await bo.toImage(pixelRatio: ratio);
    final bd = await img.toByteData(format: ui.ImageByteFormat.png);
    if (bd == null) return const [];
    final dir = await getTemporaryDirectory();
    final f = File("${dir.path}/shortage_${DateTime.now().millisecondsSinceEpoch}.png");
    await f.writeAsBytes(bd.buffer.asUint8List());
    return [f.path];
  }

  Future<void> _share() async {
    final chosen = _items.where((e) => e.checked).toList();
    if (chosen.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请至少勾选一张缺料单")));
      return;
    }
    setState(() => _busy = true);
    try {
      if (_mode == 0) {
        final text = chosen.map(_feedText).join("\n\n");
        await _shareCh.invokeMethod("share", {"text": text, "paths": <String>[]});
      } else {
        final paths = await _captureImages();
        if (paths.isEmpty) throw Exception("图片生成失败");
        await _shareCh.invokeMethod("share", {"text": "", "paths": paths});
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("分享失败：$e"), backgroundColor: Colors.red.shade700));
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  void dispose() {
    for (final it in _items) {
      it.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final chosen = _items.where((e) => e.checked).toList();
    return Scaffold(
      backgroundColor: const Color(0xFFF4F6FA),
      appBar: AppBar(
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white,
          title: const Text("缺料反馈分享", style: TextStyle(fontSize: 15)),
          actions: [
            IconButton(
                tooltip: "默认字段设置",
                icon: const Icon(Icons.tune, size: 20),
                onPressed: _editGlobals),
            IconButton(
                tooltip: "重新计算",
                icon: const Icon(Icons.refresh, size: 20),
                onPressed: _load),
          ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(children: [
              // 口径开关 + 计数
              Padding(
                  padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                  child: Row(children: [
                    FilterChip(
                        label: const Text("⛔零库存", style: TextStyle(fontSize: 11.5)),
                        selected: _showZero,
                        onSelected: (v) { setState(() => _showZero = v); _later(); }),
                    const SizedBox(width: 6),
                    FilterChip(
                        label: const Text("📉欠料", style: TextStyle(fontSize: 11.5)),
                        selected: _showShort,
                        onSelected: (v) { setState(() => _showShort = v); _later(); }),
                    const Spacer(),
                    Text("共 ${_items.length} 项 · 已选 ${chosen.length}",
                        style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
                  ])),
              Expanded(
                  child: _items.isEmpty
                      ? const Center(
                          child: Text("当前没有符合口径的缺料零件",
                              style: TextStyle(color: Colors.grey)))
                      : ListView.builder(
                          padding: const EdgeInsets.all(10),
                          itemCount: _items.length,
                          itemBuilder: (ctx, i) {
                            final it = _items[i];
                            return _itemCard(it);
                          })),
              // 底部：模式切换 + 分享按钮（图片模式需先渲染卡片，用隐藏 Stack 挂载）
              Container(
                  color: Colors.white,
                  padding: EdgeInsets.fromLTRB(10, 8, 10, MediaQuery.of(context).padding.bottom + 10),
                  child: Column(children: [
                    SegmentedButton<int>(
                        style: const ButtonStyle(visualDensity: VisualDensity.compact),
                        segments: const [
                          ButtonSegment(value: 0, label: Text("文字版（可复制）")),
                          ButtonSegment(value: 1, label: Text("图片版（长图）")),
                        ],
                        selected: {_mode},
                        onSelectionChanged: (s) => setState(() => _mode = s.first)),
                    const SizedBox(height: 8),
                    SizedBox(
                        width: double.infinity,
                        child: FilledButton.icon(
                            style: FilledButton.styleFrom(backgroundColor: const Color(0xFF07C160), padding: const EdgeInsets.symmetric(vertical: 13)),
                            onPressed: _busy ? null : _share,
                            icon: _busy
                                ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                                : const Icon(Icons.wechat, size: 20),
                            label: Text(_mode == 0 ? "分享到微信（文字 ${chosen.length} 单）" : "分享到微信（${chosen.length} 单合成长图）",
                                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)))),
                  ])),
              // 图片模式：卡片真实尺寸渲染、Transform 移出屏幕外（ClipRect 防溢出告警；
              // RepaintBoundary 自带 layer，toImage 截取不受祖先裁剪影响——零尺寸容器方案会截出空图，已规避）
              // 图片模式：勾选卡片按 750 宽真实布局、平移出屏，整体一个 RepaintBoundary 截长图
              if (_mode == 1 && chosen.isNotEmpty)
                ClipRect(
                    child: SizedBox(
                        width: 1,
                        height: 1,
                        child: UnconstrainedBox(
                            alignment: Alignment.topLeft,
                            child: Transform.translate(
                                offset: const Offset(-800, -800),
                                child: RepaintBoundary(
                                    key: _allKey,
                                    child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                      ...chosen.map((it) => _feedCard(it)),
                                    ])),
                            ))),
                ),
            ]),
    );
  }

  void _later() => WidgetsBinding.instance.addPostFrameCallback((_) => _load());

  Widget _itemCard(_ShortageItem it) {
    return Card(
        margin: const EdgeInsets.symmetric(vertical: 5),
        child: Padding(
            padding: const EdgeInsets.fromLTRB(10, 6, 10, 10),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Checkbox(value: it.checked, visualDensity: VisualDensity.compact, onChanged: (v) => setState(() => it.checked = v ?? true)),
                Expanded(
                    child: Text("${it.partNo}  ${it.itemName}",
                        maxLines: 1, overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700))),
                Text(it.inStockQty <= 0 ? "零库存" : "在库 ${_fmtInvNum(it.inStockQty)}",
                    style: TextStyle(fontSize: 11.5, color: it.inStockQty <= 0 ? Colors.red : Colors.blueGrey)),
              ]),
              if (it.needQty > 0)
                Padding(
                    padding: const EdgeInsets.only(left: 4, bottom: 2),
                    child: Text("待领 ${_fmtInvNum(it.needQty)} 件${it.needFrom.isNotEmpty ? " · ${it.needFrom}" : ""}",
                        style: const TextStyle(fontSize: 11.5, color: Color(0xFFE65100)))),
              Row(children: [
                const SizedBox(width: 4),
                const Text("车型", style: TextStyle(fontSize: 11, color: Colors.grey)),
                const SizedBox(width: 6),
                SizedBox(width: 90, child: TextField(controller: it.carC, style: const TextStyle(fontSize: 12.5), decoration: const InputDecoration(isDense: true, contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6), border: OutlineInputBorder()))),
                const SizedBox(width: 10),
                const Text("批次号", style: TextStyle(fontSize: 11, color: Colors.grey)),
                const SizedBox(width: 6),
                Expanded(child: TextField(controller: it.lotC, style: const TextStyle(fontSize: 12.5), decoration: const InputDecoration(isDense: true, contentPadding: EdgeInsets.symmetric(horizontal: 6, vertical: 6), border: OutlineInputBorder()))),
              ]),
              const SizedBox(height: 6),
              TextField(
                  controller: it.descC,
                  maxLines: 2,
                  style: const TextStyle(fontSize: 12.5),
                  decoration: const InputDecoration(
                      labelText: "异常描述", isDense: true, labelStyle: TextStyle(fontSize: 11),
                      contentPadding: EdgeInsets.symmetric(horizontal: 8, vertical: 8),
                      border: OutlineInputBorder())),
            ])));
  }

  /// 图片版缺料单（750 逻辑宽，字段两列，底部@行——生产部微信汇报格式）
  Widget _feedCard(_ShortageItem it) {
    Widget row(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 110, child: Text("$k：", style: const TextStyle(fontSize: 17, color: Color(0xFF666666)))),
          Expanded(child: Text(v.isEmpty ? "—" : v, style: const TextStyle(fontSize: 17, color: Color(0xFF222222), fontWeight: FontWeight.w600))),
        ]));
    return SizedBox(
        width: 750,
        child: Container(
            color: Colors.white,
            padding: const EdgeInsets.all(28),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
                decoration: BoxDecoration(color: const Color(0xFFE53935), borderRadius: BorderRadius.circular(6)),
                child: const Text("缺料反馈", style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Colors.white))),
            const SizedBox(width: 12),
            const Text("鄞州豪斯特 · 原料库", style: TextStyle(fontSize: 15, color: Color(0xFF999999))),
          ]),
          const SizedBox(height: 14),
          const Divider(height: 1, color: Color(0xFFEEEEEE)),
          const SizedBox(height: 6),
          row("反馈日期", _today),
          row("车型", it.carC.text),
          row("批次号", it.lotC.text),
          row("物料号", it.partNo),
          row("物料名称", it.itemName),
          row("异常描述", it.descC.text),
          row("反馈单位", _unit),
          row("反馈人", Auth.user?.name ?? ""),
          row("责任单位", _duty),
          row("确认人", _conf),
          row("确认日期", _today),
          const Divider(height: 20, color: Color(0xFFEEEEEE)),
          Text(_ats, style: const TextStyle(fontSize: 17, color: Color(0xFF1A73E8), fontWeight: FontWeight.w600)),
        ])));
  }
}
