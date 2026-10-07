part of 'main.dart';

// ===================== ⑥ 数据驾驶舱：今日KPI + 7日趋势 + AGV实况 =====================
// 数据源=服务器 /api/dashboard（登录即可看，纯只读聚合）；折线用 CustomPaint，零图表依赖。
class DashPage extends StatefulWidget {
  const DashPage({super.key});
  @override State<DashPage> createState() => _DashPageState();
}

class _DashPageState extends State<DashPage> with AutomaticKeepAliveClientMixin {
  Map? _data;
  String _err = "";
  Timer? _timer;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _load()); // ⑪自动刷新
  }
  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  Future<void> _load() async {
    final r = await AuthApi.dashboard();
    if (!mounted) return;
    if (r["ok"] == true) setState(() { _data = r; _err = ""; });
    else setState(() => _err = (r["msg"] ?? "加载失败").toString());
  }

  static String _fmtT(String iso) {
    final d = DateTime.tryParse(iso);
    if (d == null) return "";
    final lo = d.toLocal();
    return "${lo.month.toString().padLeft(2, "0")}-${lo.day.toString().padLeft(2, "0")} ${lo.hour.toString().padLeft(2, "0")}:${lo.minute.toString().padLeft(2, "0")}:${lo.second.toString().padLeft(2, "0")}";
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final k = (_data?["kpi"] as Map?) ?? const {};
    final trend = List<Map>.from(_data?["trend"] ?? const []);
    Widget tile(String label, String value, Color color, IconData icon) => Expanded(
      child: Container(margin: const EdgeInsets.all(4), padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 6, offset: const Offset(0, 2))]),
        child: Column(children: [
          Icon(icon, size: 18, color: color),
          const SizedBox(height: 4),
          Text(value, style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: color)),
          const SizedBox(height: 1),
          Text(label, style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
        ])),
    );
    int iv(String s) => (k[s] as num?)?.toInt() ?? 0;
    return Scaffold(
      backgroundColor: const Color(0xFFF2F4F8),
      appBar: AppBar(backgroundColor: const Color(0xFF3949AB), title: const Text("数据驾驶舱", style: TextStyle(fontSize: 16)),
        actions: [IconButton(icon: const Icon(Icons.refresh, color: Colors.white), onPressed: _load)],
        bottom: PreferredSize(preferredSize: const Size.fromHeight(22),
          child: Padding(padding: const EdgeInsets.only(left: 16, bottom: 6),
            child: Align(alignment: Alignment.centerLeft, child: Text(_data == null ? "" : "更新于 ${_fmtT(_data!["at"]?.toString() ?? "")} · 每30秒自动刷新",
              style: const TextStyle(fontSize: 10.5, color: Colors.white70))))),
      ),
      body: _err.isNotEmpty && _data == null
        ? Center(child: Text(_err, style: const TextStyle(color: Colors.red)))
        : RefreshIndicator(onRefresh: _load, child: ListView(padding: const EdgeInsets.all(8), children: [
            Row(children: [tile("今日入库(框)", "${iv('inBoxes')}", const Color(0xFF2E7D32), Icons.login), tile("今日出库(框)", "${iv('outToday')}", const Color(0xFFE65100), Icons.logout), tile("今日AGV搬运", "${iv('agvToday')}", const Color(0xFF1565C0), Icons.local_shipping), tile("AGV队列中", "${iv('agvQueue')}", const Color(0xFF6A1B9A), Icons.quiz_outlined)]),
            Row(children: [tile("在库(框)", "${iv('stockBoxes')}", const Color(0xFF00838F), Icons.inventory_2), tile("占用货位", "${iv('stockLocs')}", const Color(0xFF4E342E), Icons.grid_view), tile("待接单", "${iv('pending')}", Colors.orange, Icons.mark_email_unread_outlined), tile("备料中", "${iv('accepted')}", const Color(0xFF3949AB), Icons.pending)]),
            Row(children: [tile("站台在用", "${iv('stnBusy')}/${iv('stnTotal')}", iv('stnBusy') >= 7 ? Colors.red : Colors.teal, Icons.parking_outlined),
              Expanded(child: Container(margin: const EdgeInsets.all(4), padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
                decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 6, offset: const Offset(0, 2))]),
                child: Column(children: [
                  Icon(Icons.done_all, size: 18, color: Colors.green[700]),
                  const SizedBox(height: 4),
                  Text("${iv('ready')}", style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold, color: Colors.green[700])),
                  const SizedBox(height: 1),
                  const Text("待签收", style: TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
                ])))]),
            const SizedBox(height: 6),
            Container(padding: const EdgeInsets.fromLTRB(12, 12, 12, 6),
              decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.04), blurRadius: 6, offset: const Offset(0, 2))]),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: const [
                  Text("近 7 日出入库趋势（框）", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                  Spacer(),
                  Icon(Icons.circle, size: 8, color: Color(0xFF2E7D32)), Text(" 入 ", style: TextStyle(fontSize: 11)),
                  Icon(Icons.circle, size: 8, color: Color(0xFFE65100)), Text(" 出", style: TextStyle(fontSize: 11)),
                ]),
                const SizedBox(height: 8),
                SizedBox(height: 130, child: trend.isEmpty ? const Center(child: Text("暂无数据", style: TextStyle(color: Colors.grey))) : CustomPaint(size: Size.infinite, painter: _TrendPainter(trend))),
              ])),
            const SizedBox(height: 80),
          ])),
    );
  }
}

/// 迷你双折线（无坐标轴库依赖）：绿=入库 橙=出库，点值标注
class _TrendPainter extends CustomPainter {
  final List<Map> rows;
  _TrendPainter(this.rows);
  @override
  void paint(Canvas canvas, Size size) {
    if (rows.isEmpty) return;
    double maxV = 1;
    for (final r in rows) {
      final a = ((r["in"] as num?) ?? 0).toDouble(), b = ((r["out"] as num?) ?? 0).toDouble();
      if (a > maxV) maxV = a;
      if (b > maxV) maxV = b;
    }
    final dx = size.width / (rows.length - 1).clamp(1, 99);
    Offset pt(int i, num v) => Offset(i * dx, size.height - 18 - (v / maxV) * (size.height - 34));
    void line(String key, Color color) {
      final p = Path();
      for (var i = 0; i < rows.length; i++) {
        final v = ((rows[i][key] as num?) ?? 0).toDouble();
        final o = pt(i, v);
        i == 0 ? p.moveTo(o.dx, o.dy) : p.lineTo(o.dx, o.dy);
      }
      canvas.drawPath(p, Paint()..color = color..strokeWidth = 2..style = PaintingStyle.stroke..strokeCap = StrokeCap.round);
      for (var i = 0; i < rows.length; i++) {
        final v = ((rows[i][key] as num?) ?? 0).toDouble();
        final o = pt(i, v);
        canvas.drawCircle(o, 3, Paint()..color = color);
      }
    }
    line("in", const Color(0xFF2E7D32));
    line("out", const Color(0xFFE65100));
    final tp = TextPainter(textDirection: TextDirection.ltr);
    for (var i = 0; i < rows.length; i++) {
      tp.text = TextSpan(text: rows[i]["d"].toString(), style: const TextStyle(fontSize: 9.5, color: Colors.blueGrey));
      tp.layout();
      tp.paint(canvas, Offset(i * dx - tp.width / 2, size.height - 14));
    }
    // 峰值标注
    for (var i = 0; i < rows.length; i++) {
      for (final e in [("in", const Color(0xFF2E7D32)), ("out", const Color(0xFFE65100))]) {
        final v = ((rows[i][e.$1] as num?) ?? 0).toInt();
        if (v == 0) continue;
        tp.text = TextSpan(text: "$v", style: TextStyle(fontSize: 9, color: e.$2, fontWeight: FontWeight.bold));
        tp.layout();
        tp.paint(canvas, pt(i, v) - Offset(tp.width / 2, 14));
      }
    }
  }
  @override
  bool shouldRepaint(covariant _TrendPainter old) => true;
}
