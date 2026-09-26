part of 'main.dart';

// ===================== MES 直调（WMS DirectTransfer 原生复刻） =====================
// 接口逆向自 http://…/h5/m/pages/WMS/DirectTransfer.html（chunk-01450737.js）：
//  GET  /api/v1/invwarehousetransfer/getwarehousemodelinfo?loccode=   → 转入货位信息
//  GET  /api/v1/rawtransfer/GetBarCodeInfoOnHand?barcode=&warehouseCode=&districtCode=&locCode= → 标签在库信息
//  GET  /api/v1/aps/common/getBizPermission → DIRECT_TRANS_MULTI_SCAN 单次置码限制
//  POST /api/v1/rawtransfer/SaveTRBarcodes  {details:[{MITEM_ID,MITEM_CODE,MITEM_NAME,UOM,REQ_QTY,Barcodes[],TO_*_CODE,isCheckSap}]}
class DirectTransferPage extends StatefulWidget {
  const DirectTransferPage({super.key});
  @override
  State<DirectTransferPage> createState() => _DirectTransferPageState();
}

class _DirectTransferPageState extends State<DirectTransferPage> {
  final _locCtrl = TextEditingController();
  final _labelCtrl = TextEditingController();
  final _locFocus = FocusNode();
  final _labelFocus = FocusNode();
  bool _busy = false;        // 查询中
  bool _submitting = false;  // 提交中
  bool _checkSap = false;    // SAP库存校验
  bool _singleScanOnly = false; // 权限：仅允许单次置码
  Map<String, String> _to = {}; // WAREHOUSE/DISTRICT/LOC 的 CODE+NAME
  List<Map<String, dynamic>> _rows = []; // 按零件号聚合：{MITEM_ID,MITEM_CODE,MITEM_NAME,UOM,REQ_QTY,Barcodes:[]}

  @override
  void initState() {
    super.initState();
    _loadBizPermission();
  }

  @override
  void dispose() {
    _locCtrl.dispose(); _labelCtrl.dispose(); _locFocus.dispose(); _labelFocus.dispose();
    super.dispose();
  }

  void _toast(String msg, {bool err = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: err ? Colors.red : Colors.green));
  }

  // ---------- 请求通道（带 Token 失效静默重登重试一次） ----------
  Map<String, String> _baseHeaders(Map cfg) {
    String moduleId = (cfg["moduleId"] ?? "").toString().trim();
    if (moduleId.isEmpty) moduleId = _cachedLoginModuleId;
    if (moduleId.isEmpty) moduleId = "CE7F61BD526C424996CF6CE00211B86A";
    String orgId = (cfg["orgId"] ?? "").toString().trim();
    if (orgId.isEmpty) orgId = _cachedLoginOrgId;
    return {
      "Token": (cfg["token"] ?? "").toString(),
      "ModuleId": moduleId,
      "OrgId": orgId,
      "EnterpriseId": "*",
      "Culture": "zh-CN",
      "X-TZ-Offset": "-480",
      "ModulePage": "/h5/m/pages/WMS/DirectTransfer.html",
      "Accept": "*/*",
      "Content-Type": "application/json; charset=utf-8",
    };
  }

  // 登录下发的 ModuleId/OrgId 缓存（避免每次请求异步读 SharedPreferences）
  String _cachedLoginModuleId = "";
  String _cachedLoginOrgId = "";
  Future<void> _refreshCfgCache() async {
    _cachedLoginModuleId = (await MesConfig.getModuleId()).trim();
    _cachedLoginOrgId = (await MesConfig.getOrgId()).trim();
  }

  Future<dynamic> _req(String method, String path, {Map<String, String>? query, Map? body, bool retried = false}) async {
    final cfg = await MesConfig.getConfig();
    final base = "http://${cfg["host"]}:${cfg["port"]}";
    var uri = Uri.parse("$base$path");
    if (query != null) uri = uri.replace(queryParameters: query);
    HttpClientResponse resp;
    try {
      if (method == "GET") {
        final req = await HttpClient().getUrl(uri).timeout(const Duration(seconds: 15));
        _baseHeaders(cfg).forEach((k, v) => req.headers.set(k, v));
        resp = await req.close().timeout(const Duration(seconds: 15));
      } else {
        final req = await HttpClient().postUrl(uri).timeout(const Duration(seconds: 15));
        _baseHeaders(cfg).forEach((k, v) => req.headers.set(k, v));
        req.write(jsonEncode(body ?? {}));
        resp = await req.close().timeout(const Duration(seconds: 20));
      }
    } catch (e) {
      throw Exception("网络请求失败：$e");
    }
    final bodyStr = await resp.transform(utf8.decoder).join();
    // Token 失效 → 静默重登后重试一次
    if ((resp.statusCode == 401 || resp.statusCode == 403) && !retried) {
      if (await mesSilentLogin()) {
        await _refreshCfgCache();
        return _req(method, path, query: query, body: body, retried: true);
      }
      throw Exception("MES登录已失效，自动续期失败，请到设置页重新登录");
    }
    dynamic j;
    try { j = jsonDecode(bodyStr); } catch (_) { throw Exception("服务器返回异常(${resp.statusCode})"); }
    if (j is Map && j["success"] == false) {
      final m = j["message"];
      String msg = m is Map ? (m["content"]?.toString() ?? "") : (m?.toString() ?? "");
      throw Exception(msg.isEmpty ? "接口返回失败" : msg);
    }
    return j;
  }

  // 解包 {success,data} 的 data
  Future<Map?> _getData(String path, Map<String, String> query) async {
    final j = await _req("GET", path, query: query);
    if (j is Map) {
      final d = j["data"];
      if (d is Map) return Map<String, dynamic>.from(d);
      if (d == null && j["success"] == true) return null;
    }
    return null;
  }

  // ---------- 业务动作 ----------
  Future<void> _loadBizPermission() async {
    try {
      await _refreshCfgCache();
      final d = await _getData("/api/v1/aps/common/getBizPermission", {});
      if (d != null && d.containsKey("DIRECT_TRANS_MULTI_SCAN") && mounted) {
        setState(() => _singleScanOnly = d["DIRECT_TRANS_MULTI_SCAN"] == true);
      }
    } catch (_) { /* 权限接口失败不阻塞使用 */ }
  }

  /// 扫转入货位
  Future<void> _scanLoc() async {
    final code = _locCtrl.text.trim();
    if (code.isEmpty) { _toast("请先扫描转入货位"); return; }
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final d = await _getData("/api/v1/invwarehousetransfer/getwarehousemodelinfo", {"loccode": code});
      if (d == null) { _toast("货位查询无信息：$code"); return; }
      setState(() {
        _to = {
          "WAREHOUSE_CODE": d["WAREHOUSE_CODE"]?.toString() ?? "",
          "WAREHOUSE_NAME": d["WAREHOUSE_NAME"]?.toString() ?? "",
          "DISTRICT_CODE": d["DISTRICT_CODE"]?.toString() ?? "",
          "DISTRICT_NAME": d["DISTRICT_NAME"]?.toString() ?? "",
          "LOC_CODE": d["LOC_CODE"]?.toString() ?? "",
          "LOC_NAME": d["LOC_NAME"]?.toString() ?? "",
        };
        _rows = []; // 换货位清空已扫清单（防串单）
      });
      _labelFocus.requestFocus();
    } catch (e) {
      _toast("货位查询失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 扫物料标签
  Future<void> _scanLabel() async {
    final code = _labelCtrl.text.trim();
    if (_labelCtrl.text.isNotEmpty) _labelCtrl.clear();
    if (code.isEmpty) return;
    if (_to["LOC_CODE"] == null || _to["LOC_CODE"]!.isEmpty) { _toast("请先扫描转入货位"); return; }
    if (_busy) return;
    // 重复码检查
    for (final r in _rows) {
      if ((r["Barcodes"] as List).any((b) => (b["SCAN_BARCODE"] ?? b["LABEL_NO"])?.toString() == code)) {
        _toast("标签 $code 已扫描过，请勿重复"); return;
      }
    }
    if (_singleScanOnly && _rows.isNotEmpty) { _toast("当前权限不支持多次扫码置码"); return; }
    setState(() => _busy = true);
    try {
      final d = await _getData("/api/v1/rawtransfer/GetBarCodeInfoOnHand", {
        "barcode": code,
        "warehouseCode": _to["WAREHOUSE_CODE"] ?? "",
        "districtCode": _to["DISTRICT_CODE"] ?? "",
        "locCode": _to["LOC_CODE"] ?? "",
      });
      if (d == null) { _toast("找不到该物料标签：$code"); return; }
      final labelNo = (d["SCAN_BARCODE"] ?? d["LABEL_NO"] ?? code).toString();
      final label = Map<String, dynamic>.from(d)..["SCAN_BARCODE"] = labelNo;
      final qty = (d["QTY"] as num?)?.toDouble() ?? 0;
      setState(() {
        final idx = _rows.indexWhere((r) => r["MITEM_CODE"] == d["MITEM_CODE"]);
        if (idx >= 0) {
          final row = _rows[idx];
          row["REQ_QTY"] = (row["REQ_QTY"] as double) + qty;
          (row["Barcodes"] as List).add(label);
        } else {
          _rows.add({
            "MITEM_ID": d["MITEM_ID"],
            "MITEM_CODE": d["MITEM_CODE"],
            "MITEM_NAME": d["MITEM_DESC"] ?? d["MITEM_NAME"] ?? "",
            "UOM": d["UOM"] ?? "",
            "REQ_QTY": qty,
            "Barcodes": [label],
          });
        }
      });
    } catch (e) {
      _toast("标签查询失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// 查看/删除某零件号下的标签明细
  Future<void> _showRowDetail(int rowIdx) async {
    final row = _rows[rowIdx];
    final codes = (row["Barcodes"] as List).map((b) => b["SCAN_BARCODE"].toString()).toList();
    final del = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text("${row["MITEM_CODE"]} 明细"),
        content: SizedBox(width: 300, child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text("共 ${codes.length} 张标签，数量合计 ${row["REQ_QTY"]}"),
          const SizedBox(height: 8),
          ...codes.map((c) => ListTile(
            dense: true, title: Text(c, style: const TextStyle(fontSize: 13)),
            trailing: TextButton(style: TextButton.styleFrom(foregroundColor: Colors.red),
              onPressed: () => Navigator.pop(ctx, c), child: const Text("删除")),
          )),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭")),
          TextButton(style: TextButton.styleFrom(foregroundColor: Colors.red),
            onPressed: () => Navigator.pop(ctx, "__ALL__"), child: const Text("整行删除")),
        ],
      ),
    );
    if (del == null || !mounted) return;
    setState(() {
      if (del == "__ALL__") {
        _rows.removeAt(rowIdx);
      } else {
        final r = _rows[rowIdx];
        (r["Barcodes"] as List).removeWhere((b) => b["SCAN_BARCODE"].toString() == del);
        if ((r["Barcodes"] as List).isEmpty) {
          _rows.removeAt(rowIdx);
        } else {
          r["REQ_QTY"] = (r["Barcodes"] as List).fold<double>(0, (s, b) => s + ((b["QTY"] as num?)?.toDouble() ?? 0));
        }
      }
    });
  }

  /// 提交直调单
  Future<void> _submit() async {
    if (_submitting) return;
    if (_rows.isEmpty) { _toast("请扫描标签"); return; }
    if ((_to["WAREHOUSE_CODE"] ?? "").isEmpty || (_to["DISTRICT_CODE"] ?? "").isEmpty || (_to["LOC_CODE"] ?? "").isEmpty) {
      _toast("请扫描转入货位"); return;
    }
    final yes = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text("确认提交直调"),
      content: Text("转入：${_to["WAREHOUSE_NAME"]} / ${_to["DISTRICT_NAME"]} / ${_to["LOC_NAME"]}\n共 ${_rows.length} 种物料、${_rows.fold<int>(0, (s, r) => s + (r["Barcodes"] as List).length)} 张标签"),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("提交")),
      ],
    ));
    if (yes != true || !mounted) return;
    setState(() => _submitting = true);
    try {
      final details = _rows.map((r) {
        final m = Map<String, dynamic>.from(r);
        m["TO_WAREHOUSE_CODE"] = _to["WAREHOUSE_CODE"];
        m["TO_DISTRICT_CODE"] = _to["DISTRICT_CODE"];
        m["TO_LOC_CODE"] = _to["LOC_CODE"];
        m["isCheckSap"] = _checkSap;
        return m;
      }).toList();
      await _req("POST", "/api/v1/rawtransfer/SaveTRBarcodes", body: {"details": details});
      _toast("提交成功", err: false);
      setState(() { _rows = []; _to = {}; _locCtrl.clear(); });
      _locFocus.requestFocus();
    } catch (e) {
      _toast("提交失败：${e.toString().replaceFirst("Exception: ", "")}");
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  InputDecoration _dec(String label) => InputDecoration(
    labelText: label, isDense: true, border: const OutlineInputBorder(), contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 12));

  @override
  Widget build(BuildContext context) {
    // 服务端功能门禁
    if (!Auth.can("direct_transfer")) {
      return const Center(child: Text("当前角色未开通「直调」权限，请联系管理员", style: TextStyle(color: Colors.grey)));
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Row(children: [
          const Text("MES直调", style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(width: 8),
          if (_singleScanOnly) const Chip(label: Text("单次置码", style: TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact),
        ]),
        const SizedBox(height: 10),
        // 转入货位
        Row(children: [
          Expanded(child: TextField(
            controller: _locCtrl, focusNode: _locFocus, enabled: !_busy && !_submitting,
            decoration: _dec("扫描转入货位 *"),
            onSubmitted: (_) => _scanLoc(),
          )),
          const SizedBox(width: 8),
          SizedBox(width: 72, child: ElevatedButton(onPressed: (_busy || _submitting) ? null : _scanLoc, child: const Text("查询"))),
        ]),
        if ((_to["LOC_CODE"] ?? "").isNotEmpty) Container(
          margin: const EdgeInsets.only(top: 8), padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: const Color(0xFFF0F4FF), borderRadius: BorderRadius.circular(8)),
          child: Text("转入：${_to["WAREHOUSE_NAME"]} ｜ ${_to["DISTRICT_NAME"]} ｜ ${_to["LOC_NAME"]}（${_to["LOC_CODE"]}）",
              style: const TextStyle(fontSize: 13, color: Color(0xFF3F51B5))),
        ),
        const SizedBox(height: 10),
        // 扫标签
        TextField(
          controller: _labelCtrl, focusNode: _labelFocus, enabled: !_busy && !_submitting,
          decoration: _dec("扫描物料标签（扫入后自动累计数量）"),
          onSubmitted: (_) => _scanLabel(),
        ),
        SwitchListTile(
          dense: true, contentPadding: EdgeInsets.zero,
          title: const Text("开启SAP库存校验", style: TextStyle(fontSize: 14)),
          value: _checkSap, onChanged: (v) => setState(() => _checkSap = v),
        ),
        const SizedBox(height: 4),
        // 已扫清单
        if (_rows.isEmpty)
          const Padding(padding: EdgeInsets.symmetric(vertical: 24), child: Center(child: Text("暂无已扫标签", style: TextStyle(color: Colors.grey))))
        else
          ...List.generate(_rows.length, (i) {
            final r = _rows[i];
            return Card(
              margin: const EdgeInsets.symmetric(vertical: 4),
              child: ListTile(
                dense: true,
                title: Text("${r["MITEM_CODE"]}  ${r["MITEM_NAME"]}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500)),
                subtitle: Text("${(r["Barcodes"] as List).length} 张标签 · 数量 ${r["REQ_QTY"]} ${r["UOM"]}", style: const TextStyle(fontSize: 12)),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => _showRowDetail(i),
              ),
            );
          }),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: OutlinedButton.icon(
            onPressed: (_submitting || _rows.isEmpty) ? null : () async {
              final yes = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
                title: const Text("清空"), content: const Text("清空当前货位与所有已扫标签？"),
                actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                  TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("清空", style: TextStyle(color: Colors.red)))]));
              if (yes == true && mounted) setState(() { _rows = []; _to = {}; _locCtrl.clear(); _labelCtrl.clear(); });
            },
            icon: const Icon(Icons.delete_outline, size: 18), label: const Text("清空"),
          )),
          const SizedBox(width: 10),
          Expanded(flex: 2, child: ElevatedButton.icon(
            style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, minimumSize: const Size(0, 44)),
            onPressed: _submitting ? null : _submit,
            icon: _submitting ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.send),
            label: Text(_submitting ? "提交中…" : "提交直调单"),
          )),
        ]),
        const SizedBox(height: 40),
      ],
    );
  }
}
