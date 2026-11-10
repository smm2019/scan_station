part of 'main.dart';

// ===================== ③ 货位占用可视化 v135：统计头 + 货架行卡 + 空位/滞留/搜索过滤 =====================
// 数据源=实时在库账本（computeStock 口径，与库存页一致）；纯只读，不触发任何叫车/控制。
// v135 重做动机（用户实锤：旧版满屏"1框"看不出名堂）：
//   ① 顶部统计头：本区占用/低层空位/滞留≥7天框 一眼总览 + 占用率进度条；
//   ② 行卡化：每架一张圆角卡（行标签+4层分段实色格+占用迷你进度条）；
//   ③ 实用过滤器：只看空位（找位直取，仅货架页）/ 滞留预警（ageH≥168h 红点+红框，接呆滞治理）/ 全部；
//   ④ 搜索：零件号/物料名/条码片段 → 命中格金框高亮、非命中淡出、无命中行隐藏——"XX 件在哪个位"秒答；
//   ⑤ 4F 有货橙框（超低层常规圈，值得注意）；点格弹层补每框滞留时长。
class LocMapPage extends StatefulWidget {
  const LocMapPage({super.key});
  @override
  State<LocMapPage> createState() => _LocMapPageState();
}

class _LocMapPageState extends State<LocMapPage> {
  _StockAgg? _agg;
  bool _loading = true;
  String _err = "";
  String _zone = 'A'; // NB02 区
  String _tab = 'shelf'; // shelf=AGV货架 NB02 / ground=地面 NB03
  String _filter = 'all'; // all=全部 free=只看空位 stale=滞留预警
  String _q = ""; // 搜索词（零件号/物料名/条码，大小写不敏感）
  final TextEditingController _qc = TextEditingController();

  static const int _staleH = 168; // 滞留阈值=7天（与呆滞/盲区抽盘同口径）

  @override
  void initState() { super.initState(); _reload(); }
  @override
  void dispose() { _qc.dispose(); super.dispose(); }

  Future<void> _reload() async {
    setState(() { _loading = true; _err = ""; });
    try {
      await ledgerPullMerge(force: true); // ㉖ 先对齐服务器账本（别台入库/拣下），否则占用图停留在本机旧快照
      final agg = await computeStock();
      if (!mounted) return;
      setState(() { _agg = agg; _loading = false; });
    } catch (e) {
      if (!mounted) return;
      setState(() { _loading = false; _err = "加载失败：$e"; });
    }
  }

  // 货位 → 在库框（含零件/数量）
  Map<String, List<_StockBox>> get _byLoc => _agg?.byLoc ?? const {};

  bool _boxHit(_StockBox b) {
    if (_q.isEmpty) return false;
    return b.partNo.toUpperCase().contains(_q.toUpperCase()) || b.itemName.toUpperCase().contains(_q.toUpperCase()) || b.barcode.toUpperCase().contains(_q.toUpperCase());
  }

  bool _hitBoxes(List<_StockBox> boxes) => _q.isNotEmpty && boxes.any(_boxHit);

  static String _ageTxt(int h) {
    if (h < 0) return "";
    if (h < 24) return "在库 $h 小时";
    final d = h ~/ 24, r = h % 24;
    return "在库 $d 天${r > 0 ? " $r 小时" : ""}";
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF4F6FA),
      appBar: AppBar(title: const Text("货位占用图", style: TextStyle(fontSize: 16)), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: _reload),
      ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _err.isNotEmpty
              ? Center(child: Text(_err, style: const TextStyle(color: Colors.red)))
              : Column(children: [
                  _headCard(),
                  Expanded(child: _tab == 'shelf' ? _shelfView() : _groundView()),
                ]),
    );
  }

  // ---- 顶部：页签 + 统计头 + 过滤 + 搜索 ----
  Widget _headCard() {
    final agg = _agg;
    final totalBoxes = agg?.parts.values.fold<int>(0, (s, r) => s + r.inBoxes) ?? 0;
    return Container(
      margin: const EdgeInsets.fromLTRB(10, 8, 10, 4),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12), boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 8, offset: Offset(0, 2))]),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          _segTab('shelf', "AGV货架 NB02"),
          const SizedBox(width: 8),
          _segTab('ground', "地面库位 NB03"),
          const Spacer(),
          Text("全厂在库 $totalBoxes 框", style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
        ]),
        const SizedBox(height: 8),
        if (_tab == 'shelf') _zoneStatsRow(),
        Row(children: [
          _filterChip('all', "全部"),
          const SizedBox(width: 6),
          if (_tab == 'shelf') ...[_filterChip('free', "🟢 只看空位"), const SizedBox(width: 6)],
          _filterChip('stale', "🔴 滞留≥7天"),
          const Spacer(),
        ]),
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(color: const Color(0xFFF1F3F8), borderRadius: BorderRadius.circular(9)),
          child: Row(children: [
            const Icon(Icons.search, size: 18, color: Colors.blueGrey),
            Expanded(child: TextField(
              controller: _qc,
              style: const TextStyle(fontSize: 13),
              decoration: const InputDecoration(border: InputBorder.none, hintText: "搜零件号 / 物料名 / 条码，定位它在哪个货位", hintStyle: TextStyle(fontSize: 12, color: Color(0xFF9AA6B4))),
              onChanged: (v) => setState(() => _q = v.trim()),
            )),
            if (_q.isNotEmpty) IconButton(icon: const Icon(Icons.close, size: 16), onPressed: () { _qc.clear(); setState(() => _q = ""); }),
          ]),
        ),
      ]),
    );
  }

  Widget _segTab(String key, String label) {
    final on = _tab == key;
    return GestureDetector(
      onTap: () => setState(() => _tab = key),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: on ? const Color(0xFF515BD4) : Colors.white,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: on ? const Color(0xFF515BD4) : const Color(0xFFD5DCE6)),
        ),
        child: Text(label, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: on ? Colors.white : const Color(0xFF5A6675))),
      ),
    );
  }

  Widget _filterChip(String key, String label) {
    final on = _filter == key;
    return GestureDetector(
      onTap: () => setState(() => _filter = key),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: on ? const Color(0xFFE8EAF6) : Colors.transparent,
          borderRadius: BorderRadius.circular(15),
          border: Border.all(color: on ? const Color(0xFF515BD4) : const Color(0xFFD5DCE6)),
        ),
        child: Text(label, style: TextStyle(fontSize: 11.5, color: on ? const Color(0xFF515BD4) : const Color(0xFF78909C), fontWeight: on ? FontWeight.w700 : FontWeight.normal)),
      ),
    );
  }

  // 本区统计：占用格/低层空位/滞留框/搜索命中格 + 占用率条
  Widget _zoneStatsRow() {
    int occ = 0, freeLow = 0, staleN = 0, hitLocs = 0;
    for (var r = 1; r <= 16; r++) {
      for (var f = 1; f <= 4; f++) {
        final boxes = _byLoc['NB02-$_zone-${r.toString().padLeft(2, "0")}-$f' + "F"] ?? const [];
        if (boxes.isEmpty) { if (f <= 3) freeLow++; } else occ++;
        staleN += boxes.where((b) => b.ageH >= _staleH).length;
        if (_hitBoxes(boxes)) hitLocs++;
      }
    }
    final pct = (occ / 64 * 100).round();
    Widget stat(String v, String lbl, Color c) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(v, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: c, height: 1.1)),
      Text(lbl, style: const TextStyle(fontSize: 10, color: Color(0xFF8A97A6))),
    ]);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          stat("$occ/64", "本区已占格", const Color(0xFF1565C0)),
          const SizedBox(width: 14),
          stat("$freeLow", "低层空位(1~3F)", const Color(0xFF2E7D32)),
          const SizedBox(width: 14),
          stat("$staleN", "滞留≥7天框", staleN > 0 ? const Color(0xFFC62828) : const Color(0xFF9AA6B4)),
          if (_q.isNotEmpty) ...[const SizedBox(width: 14), stat("$hitLocs", "搜索命中格", const Color(0xFFE65100))],
          const Spacer(),
          Text("占用 $pct%", style: const TextStyle(fontSize: 11, color: Colors.blueGrey)),
        ]),
        const SizedBox(height: 5),
        Container(height: 5, decoration: BoxDecoration(color: const Color(0xFFEDF1F6), borderRadius: BorderRadius.circular(3)),
          child: FractionallySizedBox(alignment: Alignment.centerLeft, widthFactor: (occ / 64).clamp(0.0, 1.0),
            child: Container(decoration: BoxDecoration(color: pct > 85 ? const Color(0xFFE53935) : pct > 60 ? const Color(0xFFFB8C00) : const Color(0xFF43A047), borderRadius: BorderRadius.circular(3))))),
      ]),
    );
  }

  // ---- NB02：区→16架行卡（每卡=行标签+4层分段格+占用迷你进度） ----
  Widget _shelfView() {
    return Column(children: [
      SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Row(children: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((z) => Padding(padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(label: Text("$z 区"), selected: z == _zone, onSelected: (_) => setState(() => _zone = z)))).toList())),
      Expanded(child: ListView(padding: const EdgeInsets.fromLTRB(10, 4, 10, 12), children: [
        for (var r = 1; r <= 16; r++) _rackRowCard(r),
      ])),
    ]);
  }

  Widget _rackRowCard(int r) {
    final cells = [for (var f = 1; f <= 4; f++) _byLoc['NB02-$_zone-${r.toString().padLeft(2, "0")}-$f' + "F"] ?? const <_StockBox>[]];
    final occ = cells.where((c) => c.isNotEmpty).length;
    final hasFree = cells.any((c) => c.isEmpty);
    final staleRows = cells.any((c) => c.any((b) => b.ageH >= _staleH));
    final hitRow = cells.any((c) => _hitBoxes(c));
    // 过滤器：只看空位=隐藏满架；滞留=隐藏无滞留架；搜索=隐藏无命中架
    if (_filter == 'free' && !hasFree) return const SizedBox.shrink();
    if (_filter == 'stale' && !staleRows) return const SizedBox.shrink();
    if (_q.isNotEmpty && !hitRow) return const SizedBox.shrink();
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 7),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), boxShadow: const [BoxShadow(color: Color(0x0F000000), blurRadius: 5, offset: Offset(0, 1))]),
      child: Column(children: [
        Row(children: [
          SizedBox(width: 46, child: Text("$_zone-${r.toString().padLeft(2, "0")}", style: const TextStyle(fontSize: 11.5, fontFamily: "monospace", fontWeight: FontWeight.w700, color: Color(0xFF37474F)))),
          for (var f = 1; f <= 4; f++) Expanded(child: _nb02Cell('NB02-$_zone-${r.toString().padLeft(2, "0")}-$f' + "F", f, cells[f - 1])),
        ]),
        const SizedBox(height: 4),
        Container(height: 3, margin: const EdgeInsets.only(left: 46), decoration: BoxDecoration(color: const Color(0xFFEDF1F6), borderRadius: BorderRadius.circular(2)),
          child: FractionallySizedBox(alignment: Alignment.centerLeft, widthFactor: (occ / 4).clamp(0.0, 1.0),
            child: Container(decoration: BoxDecoration(color: occ == 4 ? const Color(0xFFFB8C00) : const Color(0xFF42A5F5), borderRadius: BorderRadius.circular(2))))),
      ]),
    );
  }

  Widget _nb02Cell(String code, int floor, List<_StockBox> boxes) {
    final n = boxes.length;
    final stale = boxes.any((b) => b.ageH >= _staleH);
    final hit = _hitBoxes(boxes);
    final dim = _q.isNotEmpty && !hit && n > 0; // 搜索时未命中有货格淡出；空格不淡（找空位仍可用）
    Color bg, fg;
    if (n == 0) {
      bg = floor == 4 ? const Color(0xFFECEFF1) : const Color(0xFFEAF6EC);
      fg = floor == 4 ? const Color(0xFF9AA6B4) : const Color(0xFF66A06A);
    } else {
      bg = n >= 2 ? const Color(0xFF1E88E5) : const Color(0xFF42A5F5);
      fg = Colors.white;
    }
    final border = stale
        ? Border.all(color: const Color(0xFFE53935), width: 1.6)
        : hit
            ? Border.all(color: const Color(0xFFFFB300), width: 2)
            : (floor == 4 && n > 0)
                ? Border.all(color: const Color(0xFFFB8C00), width: 1.4) // 4F 有货=超低层常规圈
                : Border.all(color: Colors.white);
    return Opacity(
      opacity: dim ? 0.35 : 1,
      child: InkWell(
        onTap: n == 0 ? null : () => _showLoc(code, boxes),
        borderRadius: BorderRadius.circular(7),
        child: Stack(children: [
          Container(
            margin: const EdgeInsets.symmetric(horizontal: 2), height: 38,
            decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(7), border: border),
            child: Center(child: Text(n == 0 ? "$floor" + "F" : "$n框", style: TextStyle(fontSize: n == 0 ? 10 : 12, color: fg, fontWeight: n == 0 ? FontWeight.normal : FontWeight.w800)))),
          if (stale) Positioned(top: 2, right: 3, child: Container(width: 7, height: 7, decoration: const BoxDecoration(color: Color(0xFFE53935), shape: BoxShape.circle))),
        ]),
      ),
    );
  }

  // ---- NB03：按排分组行卡（只显示有货排；排内格位 chips） ----
  Widget _groundView() {
    final byRow = <String, List<String>>{};
    for (final k in _byLoc.keys.where((k) => k.startsWith('NB03-'))) {
      if (k.length < 12) continue;
      (byRow[k.substring(0, 9)] ??= []).add(k);
    }
    final rows = byRow.keys.toList()..sort();
    if (rows.isEmpty) return const Center(child: Text("地面库位暂无在库货", style: TextStyle(color: Colors.grey)));
    return ListView(padding: const EdgeInsets.fromLTRB(10, 4, 10, 12), children: [
      for (final row in rows) _groundRowCard(row, byRow[row]!..sort()),
    ]);
  }

  Widget _groundRowCard(String row, List<String> locs) {
    final allBoxes = [for (final l in locs) ...(_byLoc[l] ?? const <_StockBox>[])];
    if (_q.isNotEmpty && !allBoxes.any(_boxHit)) return const SizedBox.shrink();
    if (_filter == 'stale' && !allBoxes.any((b) => b.ageH >= _staleH)) return const SizedBox.shrink();
    final parts = allBoxes.map((b) => b.partNo).toSet();
    final staleN = allBoxes.where((b) => b.ageH >= _staleH).length;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
      decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), boxShadow: const [BoxShadow(color: Color(0x0F000000), blurRadius: 5, offset: Offset(0, 1))]),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Text(row, style: const TextStyle(fontSize: 12.5, fontFamily: "monospace", fontWeight: FontWeight.w800, color: Color(0xFF37474F))),
          const SizedBox(width: 8),
          Text("${allBoxes.length} 框 · ${parts.length} 种", style: const TextStyle(fontSize: 11, color: Color(0xFF78909C))),
          if (staleN > 0) ...[const SizedBox(width: 6), Text("🔴滞留$staleN", style: const TextStyle(fontSize: 11, color: Color(0xFFC62828), fontWeight: FontWeight.w700))],
          const Spacer(),
        ]),
        const SizedBox(height: 5),
        Wrap(spacing: 5, runSpacing: 5, children: [
          for (final l in locs)
            for (final b in _byLoc[l] ?? const <_StockBox>[])
              GestureDetector(
                onTap: () => _showLoc(l, _byLoc[l] ?? const []),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                  decoration: BoxDecoration(
                    color: b.ageH >= _staleH ? const Color(0xFFFFEBEE) : const Color(0xFFE3F2FD),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: b.ageH >= _staleH ? const Color(0xFFE53935) : const Color(0xFFBBDEFB))),
                  child: Text("${l.substring(10)}·${b.partNo}${_boxHit(b) ? " ✓" : ""}",
                    style: TextStyle(fontSize: 10.5, fontFamily: "monospace", color: b.ageH >= _staleH ? const Color(0xFFB71C1C) : const Color(0xFF1565C0), fontWeight: FontWeight.w600)),
                ),
              ),
        ]),
      ]),
    );
  }

  void _showLoc(String code, List<_StockBox> boxes) {
    showModalBottomSheet(context: context, builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(12), child: Text("$code 在库 ${boxes.length} 框", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
      Flexible(child: ListView(children: boxes.map((b) {
        final stale = b.ageH >= _staleH;
        return ListTile(dense: true,
          title: Text("${b.partNo}  ${b.itemName}", style: const TextStyle(fontSize: 13)),
          subtitle: Text("${b.barcode} · ${_fmtInvNum(b.qty)}件${b.container.isNotEmpty ? " · ${b.container}" : ""}${b.ageH >= 0 ? " · ${_ageTxt(b.ageH)}" : ""}",
            style: TextStyle(fontSize: 11, color: stale ? const Color(0xFFC62828) : null)),
          trailing: stale ? const Text("🔴滞留", style: TextStyle(fontSize: 11, color: Color(0xFFC62828))) : null,
        );
      }).toList())),
      TextButton(onPressed: () => Navigator.pop(context), child: const Text("关闭")),
    ])));
  }
}
