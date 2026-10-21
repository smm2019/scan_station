part of 'main.dart';

// ===================== ㉖v74 缺料反馈：一键生成生产部格式缺料单，分享微信 =====================
// ㉖v74b 全厂口径（换设备结果一致）：在库=服务器货位账本（各PDA合并），需求=领料单，零件全集=采集流水背书
// ㉖v75 物料员视角：项目分类筛选（EX11/E281/V446K/EX1H/EF2H 可自定义，物料名包含即命中，含"其他"兜底）
//      + 零件搜索 + 口径徽章 + 分享只出"当前筛选∧已勾选"；有在途需求的排前（产线在等更急）
// 判定：零库存（入过库/有人要而现在全厂无货）+ 欠料（需求−在库>0）+ 低水位（阈值可设，默认关）
// 版式：一物一单（反馈日期/车型/批次号/物料号/物料名称/异常描述/反馈单位/反馈人/责任单位/确认人/确认日期/@人员）
// 分享：文字（多单拼一条消息）或 图片（多单合成一张长图，系统分享面板直达微信）；数据不出本机

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
  String kind = ""; // ㉖v75 口径徽章：零库存/欠料/低水位
  String proj = ""; // ㉖v75 归属项目关键字（空=其他）
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
      _kLow = "sr_low_line",
      _kProj = "sr_projects";
  String _unit = "鄞州豪斯特生产部",
      _duty = "鄞州豪斯特运营部",
      _conf = "宋明明",
      _at = "Eleven、星光熠熠、雪哥儿";
  double _lowLine = 0; // 低水位阈值（0=不启用）
  bool _showZero = true, _showShort = true, _showLow = true; // 口径开关（低水位阈值未开时不显示该chip）
  // ㉖v75 项目分类：物料名包含关键字（不区分大小写）即命中；默认表可在设置里增删
  static const _defProjects = ["EX11", "E281", "V446K", "EX1H", "EF2H"];
  List<String> _projects = _defProjects;
  String _proj = ""; // 当前项目筛选（""=全部；"__other__"=其他）
  String _search = ""; // ㉖v75 零件号/物料名搜索
  final List<_ShortageItem> _items = [];
  bool _loading = true, _busy = false;
  String _err = ""; // 全厂账本拉取失败提示（缺料判定地基，失败必须可见）
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
        _projects = sp.getStringList(_kProj) ?? _defProjects;
      });
    });
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _err = ""; });
    // ㉖v74b 全厂口径（换设备结果一致）：在库=服务器货位账本（各PDA合并），需求=领料单，零件全集=采集流水出现过
    final stock = <String, double>{}; // partNo → 全厂在库件数
    final boxes = <String, Set<String>>{}; // partNo → 框键集（托号优先，同账本归并口径）
    final names = <String, String>{};
    final lastLot = <String, String>{}, lastLotT = <String, int>{}; // 最近登记批次（有零头时预填）
    try {
      final lg = await AuthApi.ledgerGet().timeout(const Duration(seconds: 10));
      if (lg["ok"] != true) throw Exception(lg["msg"]?.toString() ?? "查询失败");
      for (final x in List<Map>.from(lg["items"] ?? [])) {
        final pn = (x["p"]?.toString() ?? "").trim().toUpperCase();
        if (pn.isEmpty) continue;
        stock[pn] = (stock[pn] ?? 0) + ((x["q"] as num?)?.toDouble() ?? 0);
        final pid = (x["pid"]?.toString() ?? "").toUpperCase();
        final loc = (x["l"]?.toString() ?? "").toUpperCase();
        final code = (x["c"]?.toString() ?? "").toUpperCase();
        (boxes[pn] ??= <String>{})
            .add(pid.isNotEmpty ? "P|$pid" : (loc.isNotEmpty ? "L|$loc|$pn" : "C|$code"));
        final nm = x["n"]?.toString() ?? "";
        if (nm.isNotEmpty && (names[pn] ?? "").isEmpty) names[pn] = nm;
        final t = (x["t"] as num?)?.toInt() ?? 0;
        final b = x["b"]?.toString() ?? "";
        if (b.isNotEmpty && t >= (lastLotT[pn] ?? 0)) { lastLotT[pn] = t; lastLot[pn] = b; }
      }
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _err = "全厂货位账本拉取失败：$e"; });
      return; // 账本是缺料判定的地基，拉不到必须报错，绝不静默显示"没有缺料"
    }
    // 在途需求：pending/accepted 领料单逐行 需求−已发（拉失败降级=只报零库存，不阻塞）
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
            final issued = (it["issued"] is List) ? List.from(it["issued"] as List) : const [];
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
    // 零件全集佐证：采集流水出现过的零件（全厂入过库）——零库存必须有它或需求背书，防账本脏零件号刷屏
    final hist = <String>{};
    try {
      final sl = await AuthApi.scanlogGet().timeout(const Duration(seconds: 8));
      if (sl["ok"] == true) {
        for (final s in List<Map>.from(sl["items"] ?? [])) {
          final pn = (s["pn"]?.toString() ?? "").toUpperCase();
          if (pn.isEmpty) continue;
          hist.add(pn);
          final nm = s["nm"]?.toString() ?? "";
          if (nm.isNotEmpty && (names[pn] ?? "").isEmpty) names[pn] = nm;
        }
      }
    } catch (_) {}
    final out = <_ShortageItem>[];
    for (final pn in {...stock.keys, ...needMap.keys, ...hist}) {
      final st = stock[pn] ?? 0;
      final nd = needMap[pn] ?? 0;
      final zero = st <= 1e-9;
      final short = nd - st > 1e-9;
      final low = _lowLine > 0 && st > 1e-9 && st < _lowLine;
      if (!(zero || short || low)) continue; // ㉖v75 口径开关不参与计算，全量入表由视图层筛选（切开关即时生效免重拉）
      if (zero && !hist.contains(pn) && nd <= 1e-9) continue; // 从未入库也无人要：不是缺料
      final it = _ShortageItem(pn)
        ..itemName = names[pn] ?? ""
        ..inStockQty = st
        ..inBoxes = (boxes[pn] ?? const {}).length
        ..needQty = nd
        ..needFrom = (needFromMap[pn] ?? []).take(3).join("、")
        ..lot = zero ? "" : (lastLot[pn] ?? "")
        ..kind = zero ? "零库存" : (short ? "欠料" : "低水位");
      it.carModel = _carRe.firstMatch(it.itemName)?.group(1) ?? "";
      // ㉖v75 项目归属：自定义关键字表按序匹配（不区分大小写包含），先命中先归；都未命中=其他
      final nmUp = it.itemName.toUpperCase();
      for (final p in _projects) {
        if (p.trim().isNotEmpty && nmUp.contains(p.trim().toUpperCase())) { it.proj = p.trim().toUpperCase(); break; }
      }
      final tail = nd > 0 ? "，待领 ${_fmtInvNum(nd)} 件" : "";
      it.desc = zero
          ? "报缺，仓库无单件$tail"
          : (short ? "报缺，全厂在库仅 ${_fmtInvNum(st)} 件，低于待领需求$tail" : "库存偏低，全厂在库 ${_fmtInvNum(st)} 件$tail");
      it.initCtrls();
      out.add(it);
    }
    out.sort((a, b) {
      final az = a.inStockQty <= 0 ? 0 : 1, bz = b.inStockQty <= 0 ? 0 : 1;
      if (az != bz) return az - bz; // 零库存排前
      final an = a.needQty > 0 ? 0 : 1, bn = b.needQty > 0 ? 0 : 1;
      if (an != bn) return an - bn; // ㉖v75 有在途需求的排前（产线在等，比单纯零库存更急）
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

  // ㉖v75 视图层派生筛选：口径开关 ∧ 项目 ∧ 搜索（切开关只 setState，不重新拉服务器）
  List<_ShortageItem> get _visible {
    final k = _search.trim().toLowerCase();
    return _items.where((it) {
      if (it.kind == "零库存" && !_showZero) return false;
      if (it.kind == "欠料" && !_showShort) return false;
      if (it.kind == "低水位" && !_showLow) return false;
      if (_proj == "__other__") {
        if (it.proj.isNotEmpty) return false;
      } else if (_proj.isNotEmpty) {
        if (it.proj != _proj) return false;
      }
      if (k.isNotEmpty && !it.partNo.toLowerCase().contains(k) && !it.itemName.toLowerCase().contains(k)) return false;
      return true;
    }).toList();
  }

  // 项目 chip 计数（受口径开关与搜索影响，不含项目自身维度）
  int _projCount(String p) {
    final k = _search.trim().toLowerCase();
    return _items.where((it) {
      if (it.kind == "零库存" && !_showZero) return false;
      if (it.kind == "欠料" && !_showShort) return false;
      if (it.kind == "低水位" && !_showLow) return false;
      if (k.isNotEmpty && !it.partNo.toLowerCase().contains(k) && !it.itemName.toLowerCase().contains(k)) return false;
      return p.isEmpty ? true : (p == "__other__" ? it.proj.isEmpty : it.proj == p);
    }).length;
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
    await sp.setStringList(_kProj, _projects); // ㉖v75 自定义项目表
  }

  Future<void> _editGlobals() async {
    final u = TextEditingController(text: _unit),
        d = TextEditingController(text: _duty),
        c = TextEditingController(text: _conf),
        a = TextEditingController(text: _at),
        l = TextEditingController(text: _lowLine > 0 ? _fmtInvNum(_lowLine) : ""),
        pj = TextEditingController(text: _projects.join("、")); // ㉖v75 项目自定义（顿号/逗号分隔，物料名包含即命中）
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
                  TextField(controller: pj, decoration: const InputDecoration(labelText: "项目分类（顿号/逗号分隔）", isDense: true, helperText: "物料名包含关键字即归入该项目，如 EX11、E281、V446K", helperStyle: TextStyle(fontSize: 10))),
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
        final np = pj.text
            .split(RegExp(r"[、,，;；\s]+"))
            .map((e) => e.trim())
            .where((e) => e.isNotEmpty)
            .toList();
        if (np.isNotEmpty) _projects = np;
        final pUp = _proj.toUpperCase(); // 筛选值恒为大写，与项目表大小写归一比对
        if (pUp != "__OTHER__" && !_projects.map((e) => e.trim().toUpperCase()).contains(pUp)) _proj = "";
      });
      _saveGlobals();
      _load(); // 阈值/项目表变了：重算全量清单
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
    final chosen = _visible.where((e) => e.checked).toList(); // ㉖v75 与页面展示范围一致：筛选 ∧ 勾选
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
    // ㉖v75 分享只出"当前筛选 ∧ 已勾选"：EX11 物料员筛 EX11 全选，不会把别的项目轰炸进群
    final chosen = _visible.where((e) => e.checked).toList();
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
              // 口径开关 + 计数（㉖v75 切换只重算派生视图，不再拉服务器）
              Padding(
                  padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
                  child: Row(children: [
                    FilterChip(
                        label: const Text("⛔零库存", style: TextStyle(fontSize: 11.5)),
                        selected: _showZero,
                        onSelected: (v) => setState(() => _showZero = v)),
                    const SizedBox(width: 6),
                    FilterChip(
                        label: const Text("📉欠料", style: TextStyle(fontSize: 11.5)),
                        selected: _showShort,
                        onSelected: (v) => setState(() => _showShort = v)),
                    if (_lowLine > 0) ...[
                      const SizedBox(width: 6),
                      FilterChip(
                          label: const Text("⚠️低水位", style: TextStyle(fontSize: 11.5)),
                          selected: _showLow,
                          onSelected: (v) => setState(() => _showLow = v)),
                    ],
                    const Spacer(),
                    Text("共 ${_visible.length} 项${_items.length != _visible.length ? "/${_items.length}" : ""} · 已选 ${chosen.length}",
                        style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
                  ])),
              // ㉖v75 项目分类 chips（物料名包含关键字命中；"其他"兜底不漏件）
              SizedBox(
                  height: 40,
                  child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      children: [
                        ...[
                          ["", "全部"],
                          for (final p in _projects.where((x) => x.trim().isNotEmpty)) [p.toUpperCase(), p.toUpperCase()],
                          ["__other__", "其他"],
                        ].map((e) => Padding(
                            padding: const EdgeInsets.only(right: 6, top: 4),
                            child: ChoiceChip(
                                label: Text("${e[1]} ${_projCount(e[0])}", style: const TextStyle(fontSize: 11.5)),
                                selected: _proj == e[0],
                                showCheckmark: false,
                                selectedColor: const Color(0xFF515BD4),
                                labelStyle: TextStyle(fontSize: 11.5, color: _proj == e[0] ? Colors.white : Colors.blueGrey),
                                onSelected: (_) => setState(() => _proj = _proj == e[0] ? "" : e[0])))),
                      ])),
              // ㉖v75 零件搜索
              Padding(
                  padding: const EdgeInsets.fromLTRB(10, 4, 10, 0),
                  child: TextField(
                      onChanged: (v) => setState(() => _search = v),
                      style: const TextStyle(fontSize: 13),
                      decoration: InputDecoration(
                          hintText: "搜零件号/物料名",
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                          prefixIcon: const Icon(Icons.search, size: 18),
                          prefixIconConstraints: const BoxConstraints(minWidth: 34, minHeight: 0),
                          suffixIcon: _search.isEmpty
                              ? null
                              : IconButton(
                                  icon: const Icon(Icons.clear, size: 16),
                                  onPressed: () => setState(() => _search = "")),
                          border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)))),
              ),
              Expanded(
                  child: _visible.isEmpty
                      ? Center(
                          child: _err.isNotEmpty
                              ? Column(mainAxisSize: MainAxisSize.min, children: [
                                  Text(_err,
                                      textAlign: TextAlign.center,
                                      style: const TextStyle(color: Colors.red, fontSize: 13)),
                                  const SizedBox(height: 10),
                                  OutlinedButton.icon(
                                      onPressed: _load,
                                      icon: const Icon(Icons.refresh, size: 16),
                                      label: const Text("重试")),
                                ])
                              : Text(_items.isEmpty ? "当前没有符合口径的缺料零件" : "当前筛选下无匹配，换个项目或清空搜索试试",
                                  style: const TextStyle(color: Colors.grey)))
                      : ListView.builder(
                          padding: const EdgeInsets.all(10),
                          itemCount: _visible.length,
                          itemBuilder: (ctx, i) {
                            final it = _visible[i];
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
                // ㉖v75 口径徽章：一眼分清零库存/欠料/低水位（修"零库存筛选混排低水位项无法分辨"）
                Container(
                    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
                    decoration: BoxDecoration(
                        color: (it.kind == "零库存" ? const Color(0xFFE53935) : it.kind == "欠料" ? const Color(0xFFE65100) : const Color(0xFFF9A825)).withOpacity(.1),
                        borderRadius: BorderRadius.circular(5)),
                    child: Text(it.kind,
                        style: TextStyle(
                            fontSize: 10.5,
                            fontWeight: FontWeight.w700,
                            color: it.kind == "零库存" ? const Color(0xFFE53935) : it.kind == "欠料" ? const Color(0xFFE65100) : const Color(0xFFF9A825)))),
                const SizedBox(width: 6),
                Text(it.inStockQty <= 0 ? "在库 0" : "在库 ${_fmtInvNum(it.inStockQty)} · ${it.inBoxes}框",
                    style: const TextStyle(fontSize: 11, color: Colors.blueGrey)),
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
