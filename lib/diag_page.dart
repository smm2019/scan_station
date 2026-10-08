part of 'main.dart';

// ===================== ⑥ 内置诊断页：现场排障一键自查 =====================
// 零新增依赖：记录数/文件大小用 Isar+dart:io，网卡IP用 NetworkInterface，权限用 permission_handler。
class DiagPage extends StatefulWidget {
  const DiagPage({super.key});
  @override State<DiagPage> createState() => _DiagPageState();
}

class _DiagPageState extends State<DiagPage> {
  List<List<String>> _rows = [];
  bool _loading = true;
  String _err = "";

  @override
  void initState() { super.initState(); _collect(); }

  Future<void> _collect() async {
    setState(() { _loading = true; _err = ""; });
    final out = <List<String>>[];
    void add(String k, String v) => out.add([k, v]);
    try {
      add("APP版本", "1.0.0+2");
      add("系统", "${Platform.operatingSystem} ${Platform.operatingSystemVersion}");
      add("设备主机名", Platform.localHostname);
      final isar = _globalIsar;
      add("采集记录", "${await isar.scanRecords.where().count()} 条");
      add("批次数", "${await isar.batchInfos.where().count()} 个");
      add("货位账本", "${await isar.shelfPlacements.where().count()} 条");
      add("标签物料缓存", "${await isar.labelInfos.where().count()} 条");
      add("出库单", "${await isar.outboundOrders.where().count()} 张");
      add("盘点流水", "${await isar.inventoryScans.where().count()} 条");
      final dir = await getApplicationDocumentsDirectory();
      int dbBytes = 0;
      try {
        for (final f in dir.listSync(recursive: true).whereType<File>()) {
          if (f.uri.pathSegments.last.endsWith(".isar")) dbBytes += f.lengthSync();
        }
      } catch (_) {}
      add("Isar数据库", "${(dbBytes / 1024 / 1024).toStringAsFixed(1)} MB");
      int auditBytes = 0, auditFiles = 0;
      try {
        final ad = Directory('${dir.path}/audit');
        if (ad.existsSync()) for (final f in ad.listSync().whereType<File>()) { auditBytes += f.lengthSync(); auditFiles++; }
      } catch (_) {}
      add("审计日志", "$auditFiles 个文件 · ${(auditBytes / 1024).toStringAsFixed(0)} KB");
      try {
        final ifs = await NetworkInterface.list(type: InternetAddressType.IPv4);
        add("本机IP", ifs.expand((e) => e.addresses.map((a) => "${e.name} ${a.address}")).join("；"));
      } catch (e) { add("本机IP", "读取失败：$e"); }
      final server = await AuthStore.serverUrl();
      add("鉴权服务器", server.isEmpty ? "未配置" : server);
      if (server.isNotEmpty) {
        try {
          final t0 = DateTime.now();
          final r = await http.get(Uri.parse("$server/api/rcs/stations")).timeout(const Duration(seconds: 5));
          add("服务器连通", "HTTP ${r.statusCode} · ${DateTime.now().difference(t0).inMilliseconds}ms（401=正常需登录）");
        } catch (e) { add("服务器连通", "不通：$e"); }
      }
      try {
        add("相机权限", (await Permission.camera.status).isGranted ? "已授予" : "未授予");
        add("通知权限", (await Permission.notification.status).isGranted ? "已授予" : "未授予");
      } catch (e) { add("权限读取", "异常：$e"); }
      add("当前账号", "${Auth.user?.name ?? "-"}（${Auth.user?.role ?? "-"}）");
      add("已开通功能", (Auth.features.entries.where((e) => e.value).map((e) => e.key).toList()).join("、"));
    } catch (e) {
      _err = "采集异常：$e";
    }
    if (!mounted) return;
    setState(() { _rows = out; _loading = false; });
  }

  Future<void> _export() async {
    final p = await LocalLog.exportAll();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(p == null ? "暂无审计日志可导出" : "已导出：$p"),
      backgroundColor: p == null ? Colors.orange : Colors.green, duration: const Duration(seconds: 6)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(title: const Text("设备诊断", style: TextStyle(fontSize: 16)), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: _collect),
        IconButton(icon: const Icon(Icons.ios_share), tooltip: "导出审计日志", onPressed: _export),
      ]),
      body: _loading
        ? const Center(child: CircularProgressIndicator())
        : ListView(padding: const EdgeInsets.all(12), children: [
            if (_err.isNotEmpty) Card(child: Padding(padding: const EdgeInsets.all(10), child: Text(_err, style: const TextStyle(color: Colors.red, fontSize: 12)))),
            ..._rows.map((e) => Card(margin: const EdgeInsets.symmetric(vertical: 3), child: ListTile(
              dense: true,
              title: Text(e[0], style: const TextStyle(fontSize: 12, color: Colors.blueGrey, fontWeight: FontWeight.w600)),
              subtitle: Text(e[1], style: const TextStyle(fontSize: 12.5, fontFamily: "monospace")),
            ))),
            const SizedBox(height: 8),
            OutlinedButton.icon(onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AuditLogPage())),
              icon: const Icon(Icons.fact_check_outlined, size: 18), label: const Text("查看操作审计流水")),
          ]),
    );
  }
}
