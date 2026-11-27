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
  bool _pts = false; // ㉖v189 点位号显隐（用户对照 RCS 官方图要求）：地标号+灰点，默认关防全图密扰

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
          IconButton(
            icon: Icon(_pts ? Icons.tag : Icons.drive_file_rename_outline, color: _pts ? Colors.amber : Colors.white70),
            tooltip: _pts ? "隐藏点位号" : "显示点位号（对照 RCS 官方图）",
            onPressed: () => setState(() => _pts = !_pts)),
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
                child: CustomPaint(size: Size.infinite, painter: _MapPainter(net, snap, _zoom, _ox, _oy, _pts)),
              )),
    );
  }
}

class _MapPainter extends CustomPainter {
  final Map net, snap; final double zoom, ox, oy; final bool pts;
  _MapPainter(this.net, this.snap, this.zoom, this.ox, this.oy, this.pts);

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
    // ㉖v189 点位号（用户对照 RCS 官方图）：灰点+地标号全量渲染，开启后密集处靠双指放大细看；
    // 画在所有业务元素之前（边之后最先画）=货架/站台/堵点/充电/车辆全部压在其上层，不遮挡实时信息
    if (pts) {
      final pDot = Paint()..color = const Color(0xFF90A4AE);
      for (final e in lands.entries) {
        final l = e.value as Map;
        final x = l["x"], y = l["y"];
        if (x == null || y == null) continue;
        final c = w2c(x, y);
        canvas.drawCircle(c, 2.6, pDot);
        _txt(canvas, c + const Offset(0, -6), e.key, 7.5, const Color(0xFFB0BEC5));
      }
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
    // 充电桩（landType=6：黄芯红圈；旧服务器无t字段时按实测地标号兜底）
    for (final e in lands.entries) {
      final l = e.value as Map;
      final t = l["t"];
      final isChg = t != null ? t == 6 : (e.key == "1729" || e.key == "1730");
      if (!isChg) continue;
      final c = w2c(l["x"], l["y"]);
      canvas.drawCircle(c, 5, Paint()..color = const Color(0xFFFFD600));
      canvas.drawCircle(c, 7.5, Paint()..color = const Color(0xFFD50000)..style = PaintingStyle.stroke..strokeWidth = 2);
      _txt(canvas, c + const Offset(9, 3), "充电", 8, const Color(0xFFFFD600));
    }
    // 车辆（三角朝向=航向）
    for (final c in List<Map>.from(snap["cars"] ?? [])) {
      final x = (c["x"] as num?)?.toDouble(), y = (c["y"] as num?)?.toDouble();
      if (x == null || y == null) continue;
      final ctr = w2c(x, y);
      // ㉖v191 ①RCS yaw 单位是【度】(实测最大179.98，旧版直接当弧度做cos/sin=车头近乎随机指向的根因，AGV06图实锤) ②车头对齐RCS官方图约定=航向+下发偏移(默认180°,现场实锤两端与RCS反向;参数可校正)
      final yawDeg = ((c["yaw"] as num?)?.toDouble() ?? 0) + ((snap["yawOfsDeg"] as num?)?.toDouble() ?? 180);
      final yaw = yawDeg * 3.141592653589793 / 180;
      final p = Path();
      const r = 7.0;
      for (var i = 0; i < 3; i++) {
        final a = yaw + i * 2.094 - 1.5708; // 三角形顶点沿航向
        final pt = ctr + Offset(r * math.cos(a), -r * math.sin(a));
        i == 0 ? p.moveTo(pt.dx, pt.dy) : p.lineTo(pt.dx, pt.dy);
      }
      p.close();
      final online = c["online"] == true;
      // ㉖v280 车体颜色+文字标签都跟随细态（stx=服务器单源推导：去取货/去放架/返航待命/充电/被交管/急停…）
      // 旧版只有"蓝=running/青=其他"两档，看不出车在干什么；红描边只留给离线，出事(急停/告警)加粗红圈
      final stx = (c["stx"] ?? "").toString();
      final carCol = !online
          ? Colors.grey
          : (stx == '急停' || stx == '人工停' || stx == '故障'
              ? const Color(0xFFE53935)
              : stx == '被交管'
                  ? const Color(0xFFFF6D00)
                  : stx == '告警'
                      ? const Color(0xFFAD1457)
                      : stx == '充电' || stx == '去充电' || stx == '充满'
                          ? const Color(0xFFF9A825)
                          : stx == '返航待命'
                              ? const Color(0xFF26A69A)
                              : stx == '去放架' || stx == '放架收尾'
                                  ? const Color(0xFF00ACC1)
                                  : stx == '排队待接'
                                      ? const Color(0xFF7E57C2)
                                      : stx == '去取货' || stx == '执行中'
                                          ? const Color(0xFF1E88E5)
                                          : const Color(0xFF26A69A));
      canvas.drawPath(p, Paint()..color = carCol);
      if (stx == '急停' || stx == '告警' || stx == '故障') {
        canvas.drawCircle(ctr, 11, Paint()
          ..color = const Color(0xFFE53935)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2);
      }
      _txt(canvas, ctr + const Offset(9, 3), "${c["name"] ?? c["id"]}", 9, online ? Colors.white : Colors.grey);
      if (stx.isNotEmpty) _txt(canvas, ctr + const Offset(9, 13), stx, 7.5, carCol); // 第一行位给状态（最想知道的）
      final site = c["site"]?.toString() ?? "";
      if (site.isNotEmpty) _txt(canvas, ctr + const Offset(9, 22), site, 7, const Color(0xFF90A4AE));
    }
    canvas.restore();
    // 图例
    _txt(canvas, const Offset(12, 12), "● 货架有货(橙)  ● 站台: 绿空/蓝占用/橙有货  ▲ 车辆  ◎ 交管锁点(红)  ⚡充电桩(黄芯红圈)", 10, const Color(0xFFB0BEC5));
  }

  void _txt(Canvas canvas, Offset at, String s, double sz, Color color) {
    final tp = TextPainter(text: TextSpan(text: s, style: TextStyle(fontSize: sz, color: color)), textDirection: TextDirection.ltr)..layout();
    tp.paint(canvas, at);
  }

  @override
  bool shouldRepaint(covariant _MapPainter old) => true;
}
