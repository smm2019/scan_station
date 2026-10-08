part of 'main.dart';

// ===================== 本地审计日志（⑤）+ 全局异常兜底落盘（⑦） =====================
// 按天 JSONL 文件（追加写、崩溃也留痕、一键导出即拷文件），记录关键操作与异常。
// 不新增 Isar 集合：审计本质是只追加流水，文件比数据库表更适合导出排查，且免代码生成风险。
class LocalLog {
  static String _dir = '';
  static bool _ready = false;

  static Future<void> init(String appDocPath) async {
    try {
      _dir = '$appDocPath/audit';
      await Directory(_dir).create(recursive: true);
      _ready = true;
    } catch (_) {
      _ready = false;
    }
  }

  static String _pad2(int n) => n.toString().padLeft(2, '0');
  static String _today() {
    final d = DateTime.now();
    return '${d.year}${_pad2(d.month)}${_pad2(d.day)}';
  }
  static String _file([String? day]) => '$_dir/ops-${day ?? _today()}.jsonl';

  /// 记一条操作：event=事件名，detail=详情（含对象/数量等）。操作人自动取当前登录账号。
  static void op(String event, [String detail = '']) {
    try {
      if (!_ready) return;
      final line = jsonEncode({
        't': DateTime.now().toString(),
        'u': Auth.user?.name ?? Auth.user?.username ?? '未登录',
        'e': event,
        if (detail.isNotEmpty) 'd': detail,
      });
      File(_file()).writeAsStringSync('$line\n', mode: FileMode.append, flush: true);
    } catch (_) {}
  }

  /// 记一条异常（⑦全局兜底调用）。
  static void err(String where, Object e, [StackTrace? s]) =>
      op('异常', '$where: $e${s != null ? " | ${s.toString().split("\n").take(3).join(" ")}" : ""}');

  /// 读最近 limit 条（跨当天及历史文件，最新在前）。
  static List<String> readRecent([int limit = 200]) {
    try {
      if (!_ready) return [];
      final files = Directory(_dir).listSync().whereType<File>().toList()
        ..sort((a, b) => a.path.compareTo(b.path));
      final out = <String>[];
      for (final f in files.reversed) {
        final lines = f.readAsLinesSync();
        for (var i = lines.length - 1; i >= 0 && out.length < limit; i--) {
          if (lines[i].trim().isNotEmpty) out.add(lines[i]);
        }
        if (out.length >= limit) break;
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  /// 导出全部审计日志为单文件（存到下载目录），返回路径；无日志返回 null。
  static Future<String?> exportAll() async {
    try {
      if (!_ready) return null;
      final files = Directory(_dir).listSync().whereType<File>().toList()
        ..sort((a, b) => a.path.compareTo(b.path));
      if (files.isEmpty) return null;
      final sb = StringBuffer();
      for (final f in files) {
        sb.writeln('# ${f.path}');
        sb.writeln(f.readAsStringSync());
      }
      final ext = await getExternalStorageDirectory();
      final base = ext ?? await getApplicationDocumentsDirectory();
      final out = File('${base.path}/审计日志-${_today()}.jsonl');
      out.writeAsStringSync(sb.toString());
      return out.path;
    } catch (_) {
      return null;
    }
  }

  /// 清理 30 天前的审计文件（防无限增长）。
  static void pruneOld({int keepDays = 30}) {
    try {
      if (!_ready) return;
      final cutoff = DateTime.now().subtract(Duration(days: keepDays));
      final cutName = 'ops-${cutoff.year}${_pad2(cutoff.month)}${_pad2(cutoff.day)}';
      for (final f in Directory(_dir).listSync().whereType<File>()) {
        final name = f.uri.pathSegments.last; // ops-YYYYMMDD.jsonl
        if (name.startsWith('ops-') && name.length >= 12 && name.substring(4, 12).compareTo(cutName.substring(4, 12)) < 0) {
          try { f.deleteSync(); } catch (_) {}
        }
      }
    } catch (_) {}
  }
}

/// 审计日志查看页：展示最近操作流水，一键导出发开发排查。
class AuditLogPage extends StatefulWidget {
  const AuditLogPage({super.key});
  @override State<AuditLogPage> createState() => _AuditLogPageState();
}
class _AuditLogPageState extends State<AuditLogPage> {
  List<String> _lines = [];
  String _type = "全部";
  final _qCtrl = TextEditingController();
  @override
  void initState() { super.initState(); _reload(); }
  @override void dispose() { _qCtrl.dispose(); super.dispose(); }
  void _reload() => setState(() => _lines = LocalLog.readRecent(300));
  bool _match(String raw) {
    try {
      final e = ((jsonDecode(raw) as Map)["e"] ?? "").toString();
      if (_type == "异常" && !e.contains("异常")) return false;
      if (_type == "启动" && e != "启动") return false;
      if (_type == "登录" && e != "登录") return false;
      if (_type == "操作" && (e.contains("异常") || e == "启动" || e == "登录")) return false;
      final q = _qCtrl.text.trim();
      if (q.isNotEmpty && !raw.contains(q)) return false;
      return true;
    } catch (_) { return _qCtrl.text.trim().isEmpty; }
  }
  List<String> get _shown => _lines.where(_match).toList();

  String _pretty(String raw) {
    try {
      final m = jsonDecode(raw) as Map;
      final t = (m['t'] ?? '').toString();
      return "${t.length >= 16 ? t.substring(5, 16).replaceFirst("T", " ") : t}  ${m['u'] ?? ''}  ${m['e'] ?? ''}${(m['d'] ?? '').toString().isNotEmpty ? "  · ${m['d']}" : ""}";
    } catch (_) { return raw; }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(title: const Text("操作审计日志", style: TextStyle(fontSize: 16)), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: _reload),
        IconButton(icon: const Icon(Icons.ios_share), tooltip: "导出全部", onPressed: () async {
          final p = await LocalLog.exportAll();
          if (!context.mounted) return;
          if (p == null) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("暂无日志可导出"), backgroundColor: Colors.orange)); return; }
          await Clipboard.setData(ClipboardData(text: p));
          if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("已导出并复制路径：\n$p"), backgroundColor: Colors.green, duration: const Duration(seconds: 6)));
        }),
      ]),
      body: Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(10, 8, 10, 4), child: TextField(controller: _qCtrl, onChanged: (_) => setState(() => {}), decoration: const InputDecoration(isDense: true, prefixIcon: Icon(Icons.search, size: 18), hintText: "搜索标签/操作/人", contentPadding: EdgeInsets.symmetric(horizontal: 10, vertical: 6), border: OutlineInputBorder()))),
        Padding(padding: const EdgeInsets.symmetric(horizontal: 10), child: Wrap(spacing: 6, runSpacing: 4, children: ["全部", "操作", "登录", "启动", "异常"].map((t) => ChoiceChip(label: Text(t, style: const TextStyle(fontSize: 12)), selected: _type == t, onSelected: (_) => setState(() => _type = t))).toList())),
        const SizedBox(height: 4),
        Expanded(
          child: _shown.isEmpty
              ? Center(child: Text(_lines.isEmpty ? "暂无审计记录" : "无匹配记录", style: const TextStyle(color: Colors.grey)))
              : ListView.builder(
                  padding: const EdgeInsets.all(8),
                  itemCount: _shown.length,
                  itemBuilder: (_, i) => Padding(
                    padding: const EdgeInsets.symmetric(vertical: 3, horizontal: 6),
                    child: Text(_pretty(_shown[i]), style: const TextStyle(fontSize: 12, fontFamily: "monospace")),
                  ),
                ),
        ),
      ]),
    );
  }
}
