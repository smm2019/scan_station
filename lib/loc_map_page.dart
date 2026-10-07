part of 'main.dart';

// ===================== ③ 货位占用可视化：NB02货架网格 + NB03地面排 热力视图 =====================
// 数据源=实时在库账本（computeStock 口径，与库存页一致）；纯只读，不触发任何叫车/控制。
class LocMapPage extends StatefulWidget {
  const LocMapPage({super.key});
  @override State<LocMapPage> createState() => _LocMapPageState();
}

class _LocMapPageState extends State<LocMapPage> {
  _StockAgg? _agg;
  bool _loading = true;
  String _err = "";
  String _zone = 'A'; // NB02 区
  String _tab = 'shelf'; // shelf=AGV货架 NB02 / ground=地面 NB03

  @override
  void initState() { super.initState(); _reload(); }

  Future<void> _reload() async {
    setState(() { _loading = true; _err = ""; });
    try {
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(title: const Text("货位占用图", style: TextStyle(fontSize: 16)), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: _reload),
      ]),
      body: _loading
        ? const Center(child: CircularProgressIndicator())
        : _err.isNotEmpty
          ? Center(child: Text(_err, style: const TextStyle(color: Colors.red)))
          : Column(children: [
              Padding(padding: const EdgeInsets.fromLTRB(12, 8, 12, 4), child: Row(children: [
                ChoiceChip(label: const Text("AGV货架 NB02"), selected: _tab == 'shelf', onSelected: (_) => setState(() => _tab = 'shelf')),
                const SizedBox(width: 8),
                ChoiceChip(label: const Text("地面库位 NB03"), selected: _tab == 'ground', onSelected: (_) => setState(() => _tab = 'ground')),
                const Spacer(),
                Text("在库 ${_agg?.parts.values.fold<int>(0, (s, r) => s + r.inBoxes) ?? 0} 框", style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
              ])),
              Expanded(child: _tab == 'shelf' ? _shelfView() : _groundView()),
            ]),
    );
  }

  // ---- NB02：区→16架×4层网格 ----
  Widget _shelfView() {
    return Column(children: [
      SingleChildScrollView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 10),
        child: Row(children: ['A','B','C','D','E','F','G','H'].map((z) => Padding(padding: const EdgeInsets.only(right: 6),
          child: ChoiceChip(label: Text("$z 区"), selected: z == _zone, onSelected: (_) => setState(() => _zone = z)))).toList())),
      const Padding(padding: EdgeInsets.fromLTRB(12, 6, 12, 0), child: Align(alignment: Alignment.centerLeft,
        child: Text("绿=空 · 蓝=有货（数字=框数，点开看零件）· 灰=第四层", style: TextStyle(fontSize: 11, color: Colors.grey)))),
      Expanded(child: ListView(children: [
        for (var r = 1; r <= 16; r++)
          Padding(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2), child: Row(children: [
            SizedBox(width: 42, child: Text("$_zone-${r.toString().padLeft(2, "0")}", style: const TextStyle(fontSize: 11, fontFamily: "monospace"))),
            for (var f = 1; f <= 4; f++)
              Expanded(child: _nb02Cell('NB02-$_zone-${r.toString().padLeft(2, "0")}-$f' + 'F', f)),
          ])),
      ])),
    ]);
  }

  Widget _nb02Cell(String code, int floor) {
    final boxes = _byLoc[code] ?? const [];
    final n = boxes.length;
    final bg = n == 0 ? (floor == 4 ? const Color(0xFFEEEEEE) : const Color(0xFFE8F5E9)) : const Color(0xFFE3F2FD);
    return InkWell(
      onTap: n == 0 ? null : () => _showLoc(code, boxes),
      child: Container(margin: const EdgeInsets.symmetric(horizontal: 2), height: 34,
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(4), border: Border.all(color: Colors.white)),
        child: Center(child: Text(n == 0 ? "$floor" + "F" : "$n框", style: TextStyle(fontSize: 10, color: n == 0 ? Colors.grey : const Color(0xFF1565C0), fontWeight: n == 0 ? FontWeight.normal : FontWeight.bold)))),
    );
  }

  // ---- NB03：区排→格位 ----
  Widget _groundView() {
    final groundLocs = _byLoc.keys.where((k) => k.startsWith('NB03-')).toList()..sort();
    if (groundLocs.isEmpty) return const Center(child: Text("地面库位暂无在库货", style: TextStyle(color: Colors.grey)));
    return ListView(padding: const EdgeInsets.all(10), children: [
      for (final loc in groundLocs)
        Card(margin: const EdgeInsets.symmetric(vertical: 3), child: ListTile(
          dense: true,
          leading: const Icon(Icons.view_module, color: Colors.teal, size: 20),
          title: Text(loc, style: const TextStyle(fontSize: 13, fontFamily: "monospace", fontWeight: FontWeight.w600)),
          subtitle: Text(_byLoc[loc]!.map((b) => "${b.partNo}×${_fmtInvNum(b.qty)}").join("、"), style: const TextStyle(fontSize: 11)),
          trailing: Text("${_byLoc[loc]!.length}框", style: const TextStyle(fontSize: 12, color: Colors.teal)),
        )),
    ]);
  }

  void _showLoc(String code, List<_StockBox> boxes) {
    showModalBottomSheet(context: context, builder: (_) => SafeArea(child: Column(mainAxisSize: MainAxisSize.min, children: [
      Padding(padding: const EdgeInsets.all(12), child: Text("$code 在库 ${boxes.length} 框", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
      Flexible(child: ListView(children: boxes.map((b) => ListTile(dense: true,
        title: Text("${b.partNo}  ${b.itemName}", style: const TextStyle(fontSize: 13)),
        subtitle: Text("${b.barcode} · ${_fmtInvNum(b.qty)}件${b.container.isNotEmpty ? " · ${b.container}" : ""}", style: const TextStyle(fontSize: 11)),
      )).toList())),
      TextButton(onPressed: () => Navigator.pop(context), child: const Text("关闭")),
    ])));
  }
}
