part of 'main.dart';

// ===================== ① 2D实时地图：路网+车辆+货架占用+站台+堵点（CustomPaint自绘） =====================
class AgvMapPage extends StatefulWidget {
  const AgvMapPage({super.key});
  @override State<AgvMapPage> createState() => _AgvMapPageState();
}

class _AgvMapPageState extends State<AgvMapPage> {
  Map? _snap;
  Map? _net; // 静态路网（地标/边）
  String _err = "";
  Timer? _timer;
  double _zoom = 1.0, _ox = 0, _oy = 0;
  double _zoomStart = 1.0; // 捏合手势起始倍率（d.scale是相对手势起点的累计值，必须乘基准而非逐帧累乘）

  @override
  void initState() {
    super.initState();
    _load();
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => _load()); // 10秒刷新
  }
  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  Future<void> _load() async {
    final r = await AuthApi.rcsMap();
    if (!mounted) return;
    if (r["ok"] == true) {
      setState(() { _snap = r; _err = ""; });
      if (_net == null) { final n = await AuthApi.rcsNet(); if (n["ok"] == true && mounted) setState(() => _net = n); }
    } else setState(() => _err = (r["msg"] ?? "加载失败").toString());
  }

  @override
  Widget build(BuildContext context) {
    final net = _net, snap = _snap;
    return Scaffold(
      backgroundColor: const Color(0xFF0B1220),
      appBar: AppBar(backgroundColor: const Color(0xFF101A2E), title: const Text("AGV 实时地图", style: TextStyle(fontSize: 16, color: Colors.white)),
        iconTheme: const IconThemeData(color: Colors.white),
        actions: [
          IconButton(icon: const Icon(Icons.refresh, color: Colors.white70), onPressed: _load),
          Padding(padding: const EdgeInsets.only(right: 12), child: Center(child: Text(
            snap == null ? "" : "${(List<Map>.from(snap["cars"] ?? [])).where((c) => c["online"] == true).length}台在线 · ${reqTimeLocal(snap["at"])}",
            style: const TextStyle(fontSize: 10.5, color: Colors.white54)))),
        ]),
      body: _err.isNotEmpty && snap == null
        ? Center(child: Text(_err, style: const TextStyle(color: Colors.redAccent, fontSize: 13)))
        : net == null || snap == null
          ? const Center(child: CircularProgressIndicator(color: Colors.cyan))
          : (net["ready"] != true
            ? const Center(child: Text("路网构建中（服务器启动后约1分钟就绪）", style: TextStyle(color: Colors.white54)))
            : GestureDetector(
                onScaleStart: (_) => _zoomStart = _zoom,
                onScaleUpdate: (d) { if (d.scale != 1.0) setState(() => _zoom = (_zoomStart * d.scale).clamp(0.4, 10.0)); if (d.focalPointDelta.distance > 0) setState(() { _ox += d.focalPointDelta.dx; _oy += d.focalPointDelta.dy; }); },
                onDoubleTap: () => setState(() { _zoom = 1.0; _ox = 0; _oy = 0; }),
                child: CustomPaint(size: Size.infinite, painter: _MapPainter(net, snap, _zoom, _ox, _oy)),
              )),
    );
  }
}

class _MapPainter extends CustomPainter {
  final Map net, snap; final double zoom, ox, oy;
  _MapPainter(this.net, this.snap, this.zoom, this.ox, this.oy);

  @override
  void paint(Canvas canvas, Size size) {
    final lands = (net["lands"] as Map).cast<String, dynamic>();
    final edges = List.from(net["edges"] ?? []);
    if (lands.isEmpty) return;
    // 世界坐标范围 → 画布适配
    double minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (final l in lands.values) {
      final x = (l["x"] as num).toDouble(), y = (l["y"] as num).toDouble();
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    final pad = 30.0;
    final sc = ((size.width - pad * 2) / (maxX - minX).clamp(1, 1e9)) < ((size.height - pad * 2) / (maxY - minY).clamp(1, 1e9))
        ? (size.width - pad * 2) / (maxX - minX) : (size.height - pad * 2) / (maxY - minY);
    Offset w2c(num x, num y) => Offset(pad + (x.toDouble() - minX) * sc, size.height - pad - (y.toDouble() - minY) * sc);
    canvas.save();
    canvas.translate(size.width / 2 + ox, size.height / 2 + oy);
    canvas.scale(zoom);
    canvas.translate(-size.width / 2, -size.height / 2);
    // 路网边
    final pEdge = Paint()..color = const Color(0x337089B8)..strokeWidth = 1.2;
    for (final e in edges) {
      final a = lands[e[0]] as Map?, b = lands[e[1]] as Map?;
      if (a == null || b == null) continue;
      canvas.drawLine(w2c(a["x"], a["y"]), w2c(b["x"], b["y"]), pEdge);
    }
    // 货架占用（橙点，点大小=框数）
    final pShelf = Paint()..color = const Color(0xFFFFA726);
    for (final s in List<Map>.from(snap["shelf"] ?? [])) {
      final l = lands[s["land"]] as Map?; if (l == null) continue;
      canvas.drawCircle(w2c(l["x"], l["y"]), 3.2, pShelf);
    }
    // 站台（绿空/蓝占用/橙有货）
    for (final st in List<Map>.from(snap["stations"] ?? [])) {
      final l = lands[st["land"]] as Map?; if (l == null) continue;
      final state = st["state"]?.toString() ?? "";
      canvas.drawCircle(w2c(l["x"], l["y"]), 5, Paint()..color = state == "有货" ? const Color(0xFFFF6D00) : (state == "占用中" ? const Color(0xFF29B6F6) : const Color(0xFF66BB6A)));
      _txt(canvas, w2c(l["x"], l["y"]) + const Offset(6, -6), (st["code"] ?? "").toString().split("-").last, 8.5, Colors.white70);
    }
    // 交管锁点（红圈闪烁感：静态红）
    final pJam = Paint()..color = const Color(0xFFFF5252)..style = PaintingStyle.stroke..strokeWidth = 2;
    for (final j in List<Map>.from(snap["jam"] ?? [])) {
      final l = lands[j["land"]] as Map?; if (l == null) continue;
      canvas.drawCircle(w2c(l["x"], l["y"]), 6, pJam);
    }
    // 车辆（三角朝向=航向）
    for (final c in List<Map>.from(snap["cars"] ?? [])) {
      final x = (c["x"] as num?)?.toDouble(), y = (c["y"] as num?)?.toDouble();
      if (x == null || y == null) continue;
      final ctr = w2c(x, y);
      final yaw = ((c["yaw"] as num?)?.toDouble() ?? 0);
      final p = Path();
      const r = 7.0;
      for (var i = 0; i < 3; i++) {
        final a = yaw + i * 2.094 - 1.5708; // 三角形顶点沿航向
        final pt = ctr + Offset(r * math.cos(a), -r * math.sin(a));
        i == 0 ? p.moveTo(pt.dx, pt.dy) : p.lineTo(pt.dx, pt.dy);
      }
      p.close();
      final online = c["online"] == true;
      canvas.drawPath(p, Paint()..color = online ? (c["state"] == "running" ? const Color(0xFF42A5F5) : const Color(0xFF26A69A)) : Colors.grey);
      _txt(canvas, ctr + const Offset(9, 3), "${c["name"] ?? c["id"]}", 9, online ? Colors.white : Colors.grey);
      final site = c["site"]?.toString() ?? "";
      if (site.isNotEmpty) _txt(canvas, ctr + const Offset(9, 13), site, 7.5, const Color(0xFF90A4AE));
    }
    canvas.restore();
    // 图例
    _txt(canvas, const Offset(12, 12), "● 货架有货(橙)  ● 站台: 绿空/蓝占用/橙有货  ▲ 车辆  ◎ 交管锁点(红)", 10, const Color(0xFFB0BEC5));
  }

  void _txt(Canvas canvas, Offset at, String s, double sz, Color color) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(fontSize: sz, color: color)), textDirection: TextDirection.ltr)..layout();
    tp.paint(canvas, at);
  }

  @override
  bool shouldRepaint(covariant _MapPainter old) => true;
}
