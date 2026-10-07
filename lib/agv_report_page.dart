part of 'main.dart';

// ===================== ⑦ AGV效率报表：按车统计 + 站台分时热力 =====================
class AgvReportPage extends StatefulWidget {
  const AgvReportPage({super.key});
  @override State<AgvReportPage> createState() => _AgvReportPageState();
}

class _AgvReportPageState extends State<AgvReportPage> {
  Map? _d;
  String _err = "";
  int _days = 7;
  bool _loading = true;

  @override
  void initState() { super.initState(); _load(); }

  Future<void> _load() async {
    setState(() { _loading = true; _err = ""; });
    final r = await AuthApi.agvReport(_days);
    if (!mounted) return;
    if (r["ok"] == true) setState(() { _d = r; _loading = false; });
    else { setState(() { _loading = false; _err = (r["msg"] ?? "加载失败").toString(); }); }
  }

  @override
  Widget build(BuildContext context) {
    final cars = List<Map>.from(_d?["cars"] ?? const []);
    final heat = List.from(_d?["heat"] ?? const []);
    final heatDays = List<String>.from(_d?["heatDays"] ?? const []);
    final maxN = cars.isEmpty ? 1 : (cars.first["n"] as num?)?.toInt() ?? 1;
    int heatMax = 1;
    for (final row in heat) { for (final v in (row as List)) { final n = (v as num?)?.toInt() ?? 0; if (n > heatMax) heatMax = n; } }
    return Scaffold(
      backgroundColor: const Color(0xFFF2F4F8),
      appBar: AppBar(backgroundColor: const Color(0xFF283593), title: const Text("AGV 效率报表", style: TextStyle(fontSize: 16)), actions: [
        IconButton(icon: const Icon(Icons.refresh, color: Colors.white), onPressed: _load),
      ], bottom: PreferredSize(preferredSize: const Size.fromHeight(40), child: Container(color: const Color(0xFF283593),
        padding: const EdgeInsets.only(bottom: 6), child: Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          const Text("统计窗口 ", style: TextStyle(color: Colors.white70, fontSize: 12)),
          for (final d in [1, 7, 30]) Padding(padding: const EdgeInsets.symmetric(horizontal: 4),
            child: ChoiceChip(label: Text(d == 1 ? "今日" : "近$d日"), selected: _days == d, onSelected: (_) { setState(() => _days = d); _load(); },
              visualDensity: VisualDensity.compact, backgroundColor: Colors.white24, selectedColor: Colors.white,
              labelStyle: TextStyle(color: _days == d ? const Color(0xFF283593) : Colors.white, fontSize: 12))),
        ])))),
      body: _loading
        ? const Center(child: CircularProgressIndicator())
        : _err.isNotEmpty && _d == null
          ? Center(child: Text(_err, style: const TextStyle(color: Colors.red)))
          : RefreshIndicator(onRefresh: _load, child: ListView(padding: const EdgeInsets.all(10), children: [
              Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
                child: Row(children: [
                  Expanded(child: _mini("总任务", "${_d?["totalN"] ?? 0}", const Color(0xFF283593))),
                  Expanded(child: _mini("平均耗时", "${_fmtDur((_d?["avgDur"] as num?)?.toInt() ?? 0)}", const Color(0xFF00838F))),
                  Expanded(child: _mini("参与车辆", "${cars.length} 台", Colors.teal)),
                ])),
              const SizedBox(height: 10),
              Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text("各车任务量（出库/入库 · 平均单次耗时）", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  const SizedBox(height: 8),
                  if (cars.isEmpty) const Padding(padding: EdgeInsets.all(16), child: Center(child: Text("窗口内暂无AGV任务记录", style: TextStyle(color: Colors.grey)))),
                  ...cars.map((c) {
                    final n = (c["n"] as num?)?.toInt() ?? 0;
                    final car = (c["car"] as num?)?.toInt() ?? 0;
                    return Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Row(children: [
                      SizedBox(width: 56, child: Text("AGV${car.toString().padLeft(2, "0")}", style: const TextStyle(fontSize: 12, fontFamily: "monospace", fontWeight: FontWeight.w600))),
                      Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(4),
                        child: LinearProgressIndicator(value: n / maxN, minHeight: 14, backgroundColor: const Color(0xFFECEFF1), color: const Color(0xFF3949AB)))),
                      SizedBox(width: 108, child: Text(" $n次(${(c["out"] as num?)?.toInt() ?? 0}出/${(c["in"] as num?)?.toInt() ?? 0}入) ${_fmtDur((c["avgDur"] as num?)?.toInt() ?? 0)}",
                        style: const TextStyle(fontSize: 11, color: Colors.blueGrey))),
                    ]));
                  }),
                ])),
              const SizedBox(height: 10),
              if (heat.isNotEmpty) Container(padding: const EdgeInsets.all(12), decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const Text("搬运热力（近7日 × 时段）", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  const SizedBox(height: 8),
                  SingleChildScrollView(scrollDirection: Axis.horizontal, child: Row(children: [
                    const SizedBox(width: 38),
                    for (var h = 0; h < 24; h++) SizedBox(width: 13, child: Text(h % 6 == 0 ? "$h" : "", style: const TextStyle(fontSize: 8.5, color: Colors.grey))),
                  ])),
                  for (var d = 0; d < heat.length && d < heatDays.length; d++) Row(children: [
                    SizedBox(width: 38, child: Text(heatDays[d], style: const TextStyle(fontSize: 9.5, color: Colors.blueGrey))),
                    for (var h = 0; h < 24; h++)
                      Container(width: 13, height: 13, margin: const EdgeInsets.all(0.5),
                        decoration: BoxDecoration(borderRadius: BorderRadius.circular(2),
                          color: _heatColor((((heat[d] as List?)?.elementAt(h) as num?)?.toInt() ?? 0) / heatMax))),
                  ]),
                  const SizedBox(height: 4),
                  const Text("颜色越深搬运越密集；空白=该时段无任务", style: TextStyle(fontSize: 10.5, color: Colors.grey)),
                ])),
              const SizedBox(height: 60),
            ])),
    );
  }

  static Color _heatColor(double r) {
    if (r <= 0) return const Color(0xFFEEF1F6);
    // 浅蓝→深蓝渐变
    final t = r.clamp(0.15, 1.0);
    return Color.lerp(const Color(0xFFBBDEFB), const Color(0xFF1A237E), t)!;
  }

  static String _fmtDur(int s) => s <= 0 ? "-" : (s >= 60 ? "${(s / 60).toStringAsFixed(1)}分" : "$s秒");

  Widget _mini(String label, String v, Color c) => Column(children: [
    Text(v, style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: c)),
    Text(label, style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
  ]);
}
