part of 'main.dart';

// ㉖v98c 物料号补录工具：连续扫标签 → 查 MES 取 MITEM_CODE → 批量上收服务器沉淀"零件号→物料号"字典。
// 用途：存量老标签采集时没存物料号，导出表物料号列为空；本工具让仓管空闲时扫一圈货架标签，
// 同零件号的所有老标签在导出时自动回补（字典级）。单批最多500条，重复扫描自动去重。
class MitemBackfillPage extends StatefulWidget {
  const MitemBackfillPage({super.key});
  @override
  State<MitemBackfillPage> createState() => _MitemBackfillPageState();
}

class _MitemBackfillPageState extends State<MitemBackfillPage> {
  final TextEditingController _scanCtrl = TextEditingController();
  final FocusNode _scanFocus = FocusNode();
  final Set<String> _seen = {}; // 本次已扫标签（大写去重）
  final List<Map<String, String>> _pending = []; // [{c,pn,mc}] 待上传
  int _notFound = 0; // MES查无此码
  int _mesFail = 0; // MES查询失败/无物料号
  bool _busy = false;
  bool _uploading = false;

  @override
  void dispose() {
    _scanCtrl.dispose();
    _scanFocus.dispose();
    super.dispose();
  }

  void _refocus() {
    _scanCtrl.clear();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scanFocus.requestFocus();
    });
  }

  Future<void> _onScan(String raw) async {
    final code = raw.trim().toUpperCase();
    if (code.isEmpty || _busy) return;
    final fmtErr = labelFormatErr(code);
    if (fmtErr != null) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(fmtErr), backgroundColor: Colors.orange, duration: const Duration(seconds: 2)));
        _refocus();
      }
      return;
    }
    if (_seen.contains(code)) return; // 重复扫描静默跳过
    _seen.add(code);
    setState(() => _busy = true);
    String pn = "", mc = "";
    bool found = false;
    try {
      final r = await mesQueryLabel(code);
      if (r["ok"] == true) {
        found = true;
        pn = (r["partNo"] ?? "").toString();
        mc = (r["mitemCode"] ?? "").toString();
      } else if (r["found"] != false) {
        _mesFail++; // 网络/登录失败（非"查无此码"）
      } else {
        _notFound++;
      }
    } catch (_) {
      _mesFail++;
    }
    if (!mounted) return; // ㉖v98b 防崩守卫：查MES期间关页则静默退出
    if (found && mc.isNotEmpty) {
      _pending.add({"c": code, "pn": pn, "mc": mc});
    } else if (found) {
      _mesFail++; // 查到标签但MES没给物料号
    }
    setState(() => _busy = false);
    _refocus();
  }

  Future<void> _upload() async {
    if (_pending.isEmpty || _uploading) return;
    setState(() => _uploading = true);
    int sent = 0;
    String? err;
    try {
      for (var i = 0; i < _pending.length; i += 500) {
        final chunk = _pending.sublist(i, i + 500 > _pending.length ? _pending.length : i + 500);
        final res = await AuthApi.mitemBatch(chunk);
        if (!mounted) return; // ㉖v98b 防崩守卫
        if (res["ok"] == true) {
          sent += chunk.length;
        } else {
          err = res["msg"]?.toString() ?? "上传失败";
          break;
        }
      }
    } catch (e) {
      err = "上传异常：$e";
    }
    if (!mounted) return;
    setState(() {
      _uploading = false;
      if (err == null) {
        _pending.clear();
        _seen.clear();
        _notFound = 0;
        _mesFail = 0;
      }
    });
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(err == null ? "已上收 $sent 条，字典已更新（同零件号老标签导出自动带物料号）" : "上传中断：$err（已保留未传数据，可重试）"),
        backgroundColor: err == null ? Colors.green : Colors.red,
        duration: const Duration(seconds: 3)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("物料号补录"), actions: [
        if (_pending.isNotEmpty)
          IconButton(
              tooltip: "清空本次未上传",
              icon: const Icon(Icons.delete_sweep),
              onPressed: () => setState(() {
                    _pending.clear();
                    _seen.clear();
                    _notFound = 0;
                    _mesFail = 0;
                  })),
      ]),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextField(
              controller: _scanCtrl,
              focusNode: _scanFocus,
              autofocus: true,
              enabled: !_uploading,
              onSubmitted: _onScan,
              decoration: InputDecoration(
                labelText: "扫标签号（连续扫描）",
                hintText: "扫码枪对准货架标签即可，自动去重",
                border: const OutlineInputBorder(),
                prefixIcon: const Icon(Icons.qr_code_scanner),
              ),
            ),
            const SizedBox(height: 8),
            Text("本次已补 ${_pending.length} 条 · 查无 ${_notFound} · 失败 ${_mesFail}",
                style: const TextStyle(fontSize: 13, color: Colors.grey)),
            const SizedBox(height: 4),
            const Text("说明：同零件号的所有老标签，导出库位表/流水时物料号列自动回补；无需逐框重扫。",
                style: TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
            const SizedBox(height: 8),
            Expanded(
              child: _pending.isEmpty
                  ? const Center(child: Text("扫第一个标签开始", style: TextStyle(color: Colors.grey)))
                  : ListView.builder(
                      itemCount: _pending.length,
                      itemBuilder: (_, i) {
                        final e = _pending[_pending.length - 1 - i]; // 最新在前
                        return ListTile(
                          dense: true,
                          title: Text("${e["c"]} → ${e["mc"]}", style: const TextStyle(fontFamily: "monospace", fontSize: 13)),
                          subtitle: Text("零件号 ${e["pn"]}", style: const TextStyle(fontSize: 11)),
                        );
                      },
                    ),
            ),
            const SizedBox(height: 8),
            FilledButton.icon(
              onPressed: (_pending.isEmpty || _uploading) ? null : _upload,
              icon: _uploading ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.cloud_upload),
              label: Text(_uploading ? "上传中…" : "上收服务器（${_pending.length} 条）"),
            ),
          ],
        ),
      ),
    );
  }
}
