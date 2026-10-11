// ===================== ㉖④ 检验模式页（AGV 下架检验 → 备注 → 原样归位） =====================
class InspectPage extends StatefulWidget {
  const InspectPage({super.key});
  @override
  State<InspectPage> createState() => _InspectPageState();
}

class _InspectPageState extends State<InspectPage>
    with AutomaticKeepAliveClientMixin {
  final TextEditingController _codeCtrl = TextEditingController();
  List<Map> _list = [];
  bool _loading = false, _loaded = false;
  String _err = "";
  Timer? _timer;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
    _timer =
        Timer.periodic(const Duration(seconds: 20), (_) => _load(silent: true));
  }

  @override
  void dispose() {
    _timer?.cancel();
    _codeCtrl.dispose();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (!silent && mounted) setState(() => _loading = true);
    final r = await AuthApi.inspectList();
    if (!mounted) return;
    setState(() {
      _loading = false;
      _loaded = true;
      if (r["ok"] == true) {
        _list = List<Map>.from(r["list"] ?? []);
        _err = "";
      } else if (!silent) {
        _err = (r["msg"] ?? "加载失败").toString();
      }
    });
  }

  String _stText(String s) => switch (s) {
        "toStation" => "🚚 下架途中",
        "atStation" => "📍 站台待检",
        "returning" => "🔙 归位途中",
        "done" => "✅ 已归位",
        "stuck" => "⚠️ 超时待核",
        "cancel" => "已取消",
        _ => s,
      };

  Future<void> _start() async {
    final code = _codeCtrl.text.trim().toUpperCase();
    if (code.isEmpty) {
      _toast("请先扫描或输入框标签号");
      return;
    }
    // 事由
    final why = await _prompt("检验事由备注（将记入工单与留痕）", "");
    if (why == null) return;
    if (why.trim().isEmpty) {
      _toast("检验事由必填");
      return;
    }
    // 先查标签当前货位
    final lg = await AuthApi.ledgerGetByCode(code);
    if (!mounted) return;
    final items = List<Map>.from(lg["items"] ?? []);
    if (lg["ok"] != true || items.isEmpty) {
      _toast("该标签不在库（账本无此框），无法检验下架");
      return;
    }
    final loc = (items.first["l"] ?? "").toString();
    final part = (items.first["p"] ?? "").toString();
    if (loc.isEmpty) {
      _toast("查不到该框当前货位");
      return;
    }
    final yes = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
                title: const Text("确认检验下架"),
                content: Text(
                    "标签 $code\n零件 $part\n当前货位 $loc\n\n将派 AGV 把整框叉到空闲站台，检验完成后在本页点「归位」送回原货位 $loc。"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2, false),
                      child: const Text("取消")),
                  FilledButton(
                      onPressed: () => Navigator.pop(c2, true),
                      child: const Text("发起下架")),
                ]));
    if (yes != true || !mounted) return;
    final r = await AuthApi.inspectStart(loc, why.trim());
    if (!mounted) return;
    if (r["ok"] == true) {
      final rec = Map.from(r["rec"] ?? {});
      _toast("✅ 已下架 ${rec['code'] ?? code} → ${rec['station'] ?? '站台'}，到台后通知");
      _codeCtrl.clear();
      _load();
    } else {
      _toast("发起失败：${r["msg"] ?? "未知错误"}");
    }
  }

  Future<void> _ret(Map q) async {
    final note = await _prompt("检验结果备注（必填，将记入工单留痕）", "");
    if (note == null || note.trim().isEmpty) return;
    final r = await AuthApi.inspectReturn(q["id"].toString(), note.trim());
    if (!mounted) return;
    _toast(r["ok"] == true ? "✅ 归位任务已下发，AGV 送回后自动完成" : "失败：${r["msg"]}");
    if (r["ok"] == true) _load();
  }

  Future<String?> _prompt(String title, String init) async {
    final ctl = TextEditingController(text: init);
    final res = await showDialog<String>(
        context: context,
        builder: (c2) => AlertDialog(
                title: Text(title, style: const TextStyle(fontSize: 16)),
                content: TextField(
                    controller: ctl,
                    maxLines: 2,
                    autofocus: true,
                    decoration: const InputDecoration(hintText: "填写内容")),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2),
                      child: const Text("取消")),
                  FilledButton(
                      onPressed: () => Navigator.pop(c2, ctl.text),
                      child: const Text("确定")),
                ]));
    ctl.dispose();
    return res;
  }

  void _toast(String s) {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(s),
          backgroundColor: s.startsWith("✅")
              ? Colors.green
              : (s.startsWith("失败") || s.startsWith("⚠")
                  ? Colors.red
                  : Colors.blueGrey)));
  }

  Widget _card(Map q) {
    final st = (q["state"] ?? "").toString();
    final mins = st == "atStation"
        ? ((DateTime.now().millisecondsSinceEpoch -
                    ((q["arriveAt"] ?? q["at"]) as num).toInt()) /
                60000)
            .round()
        : 0;
    return Card(
      margin: const EdgeInsets.fromLTRB(10, 0, 10, 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: Text("${q["code"] ?? ""}",
                    style: const TextStyle(
                        fontWeight: FontWeight.bold,
                        fontFamily: "monospace",
                        fontSize: 15))),
            Text(_stText(st),
                style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: st == "atStation"
                        ? Colors.orange
                        : (st == "done"
                            ? Colors.green
                            : (st == "stuck" ? Colors.red : Colors.blueGrey)))),
          ]),
          const SizedBox(height: 4),
          Text("${q["from"] ?? ""} ⇄ ${q["station"] ?? ''}",
              style: const TextStyle(fontSize: 13)),
          Text(
              "${q["part"] ?? ""}${q["nm"] != null && (q["nm"].toString()).isNotEmpty ? " · ${q["nm"]}" : ""}",
              style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
          if (q["note"] != null && (q["note"].toString()).isNotEmpty)
            Text("事由：${q["note"]}",
                style: const TextStyle(fontSize: 12, color: Colors.grey)),
          if (q["note2"] != null && (q["note2"].toString()).isNotEmpty)
            Text("检验：${q["note2"]}",
                style: const TextStyle(fontSize: 12, color: Colors.teal)),
          if (q["err"] != null && (q["err"].toString()).isNotEmpty)
            Text("${q["err"]}",
                style: const TextStyle(fontSize: 12, color: Colors.red)),
          if (mins > 0)
            Text("已在站台等待约 $mins 分钟",
                style:
                    const TextStyle(fontSize: 11, color: Colors.orangeAccent)),
          const SizedBox(height: 6),
          Row(children: [
            Expanded(
                child: Text(
                    "${q["by"] ?? ""} · ${((q["at"] ?? 0) as num).toInt() > 0 ? DateTime.fromMillisecondsSinceEpoch((q["at"] as num).toInt()).toString().substring(5, 16) : ""}",
                    style: const TextStyle(fontSize: 11, color: Colors.grey))),
            if (st == "atStation")
              FilledButton.icon(
                  onPressed: () => _ret(q),
                  icon: const Icon(Icons.restore, size: 18),
                  label: const Text("检验完·归位"),
                  style: FilledButton.styleFrom(
                      backgroundColor: const Color(0xFF00897B),
                      padding: const EdgeInsets.symmetric(horizontal: 14))),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Column(children: [
      Container(
        width: double.infinity,
        color: const Color(0xFFF3F4FB),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
                child: TextField(
                    controller: _codeCtrl,
                    textInputAction: TextInputAction.done,
                    decoration: const InputDecoration(
                        hintText: "扫描或输入要检验的框标签号",
                        isDense: true,
                        prefixIcon: Icon(Icons.qr_code_scanner, size: 20),
                        border: OutlineInputBorder(),
                        filled: true,
                        fillColor: Colors.white))),
            const SizedBox(width: 8),
            ElevatedButton(
                onPressed: _loading ? null : _start,
                style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF515BD4),
                    foregroundColor: Colors.white),
                child: const Text("下架检验")),
          ]),
          const SizedBox(height: 6),
          Text(
              "流程：扫框标签 → AGV 叉到空闲站台 → 现场检验 → 本页点「检验完·归位」→ AGV 送回原货位并自动核对到账。检验期间该框不可出库叫车。",
              style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
        ]),
      ),
      Expanded(
        child: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.symmetric(vertical: 10),
            children: [
              if (_err.isNotEmpty)
                Padding(
                    padding: const EdgeInsets.all(20),
                    child: Text("加载失败：$_err　重试点下拉",
                        textAlign: TextAlign.center,
                        style:
                            const TextStyle(color: Colors.red, fontSize: 13))),
              if (_list.isEmpty && _loaded && _err.isEmpty)
                const Padding(
                    padding: EdgeInsets.all(30),
                    child: Center(
                        child: Text("暂无检验工单",
                            style: TextStyle(color: Colors.grey)))),
              Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                  child: Text("检验工单（${_list.length}）",
                      style: const TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 13))),
              ..._list.map(_card),
            ],
          ),
        ),
      ),
    ]);
  }
}
