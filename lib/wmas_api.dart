part of 'main.dart';

// ===================== WMAS(AGV调度) 对接：登录/请求/主档缓存/一键建任务 =====================
// 协议来源：逆向 WMAS 前端 JS + 登录后只读实测（2026-10-04）。
// 登录 POST /api/auth/login {username,password} → data.token(JWT,12h)；请求头 Authorization: Bearer。
// 建任务 POST /api/logistics/agv-task；下发 POST /api/logistics/agv-task/dispatch {ids:[..]}。
// 库位归属(仓库/库区)从 wmsLocation/listAll 主档反查；容器编码由容器类型在容器主档反查。

class WmasConfig {
  static const keyHost = "wmas_host";
  static const keyAccount = "wmas_account";
  static const keyPwd = "wmas_pwd";
  static const keyToken = "wmas_token";
  static const keyTokenExp = "wmas_token_exp";
  static const defaultHost = "172.25.1.155:8080";

  static Future<Map<String, String>> get() async {
    final sp = await SharedPreferences.getInstance();
    return {
      "host": (sp.getString(keyHost) ?? defaultHost).trim(),
      "account": (sp.getString(keyAccount) ?? "").trim(),
      "pwd": sp.getString(keyPwd) ?? "",
    };
  }

  static Future<void> save({required String host, required String account, required String pwd}) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(keyHost, host.trim());
    await sp.setString(keyAccount, account.trim());
    await sp.setString(keyPwd, pwd);
    await sp.remove(keyToken);
    await sp.remove(keyTokenExp);
  }
}

class WmasApi {
  static const _timeout = Duration(seconds: 12);

  static Future<Map<String, dynamic>?> _raw(String method, String path, String? body, String? token) async {
    final cfg = await WmasConfig.get();
    HttpClient? client;
    try {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
      final uri = Uri.parse("http://${cfg["host"]}$path");
      final req = await client.openUrl(method, uri);
      req.headers.set("Accept", "*/*");
      if (body != null) req.headers.contentType = ContentType.json;
      if (token != null) req.headers.set("Authorization", "Bearer $token");
      if (body != null) req.write(body);
      final resp = await req.close().timeout(_timeout);
      final text = await resp.transform(utf8.decoder).join().timeout(_timeout);
      dynamic j;
      try { j = jsonDecode(text); } catch (_) { j = null; }
      return {"status": resp.statusCode, "json": j is Map<String, dynamic> ? j : null, "text": text};
    } catch (e) {
      return {"status": 0, "json": null, "text": "$e"};
    } finally {
      client?.close(force: true);
    }
  }

  /// 登录并缓存 token；账号密码未配置或失败返回 null
  static Future<String?> login() async {
    final cfg = await WmasConfig.get();
    if ((cfg["account"] ?? "").isEmpty || (cfg["pwd"] ?? "").isEmpty) return null;
    final r = await _raw("POST", "/api/auth/login", jsonEncode({"username": cfg["account"], "password": cfg["pwd"]}), null);
    final j = r?["json"];
    if (j is Map && j["success"] == true && j["data"] is Map) {
      final t = (j["data"] as Map)["token"]?.toString() ?? "";
      if (t.isNotEmpty) {
        final sp = await SharedPreferences.getInstance();
        await sp.setString(WmasConfig.keyToken, t);
        await sp.setInt(WmasConfig.keyTokenExp, DateTime.now().millisecondsSinceEpoch + 11 * 3600 * 1000); // JWT 12h，留 1h 余量
        return t;
      }
    }
    return null;
  }

  static bool _authFail(Map<String, dynamic>? r) {
    if (r == null) return false;
    if (r["status"] == 401 || r["status"] == 403) return true;
    final j = r["json"];
    if (j is Map) {
      final m = j["msg"]?.toString() ?? "";
      if (j["code"] == 401 || m.contains("登录已过期") || m.contains("未登录") || m.toLowerCase().contains("token")) return true;
    }
    return false;
  }

  /// WMAS 请求：自动带 token，失效静默重登一次。返回 {ok:true,data} / {ok:false,msg}
  static Future<Map<String, dynamic>> req(String method, String path, {Map? body}) async {
    final sp = await SharedPreferences.getInstance();
    var token = sp.getString(WmasConfig.keyToken) ?? "";
    final exp = sp.getInt(WmasConfig.keyTokenExp) ?? 0;
    if (token.isEmpty || DateTime.now().millisecondsSinceEpoch > exp) {
      final t = await login();
      if (t == null) return {"ok": false, "msg": "WMAS未登录：请到 设置→WMAS(AGV)设置 填写账号密码"};
      token = t;
    }
    var r = await _raw(method, path, body == null ? null : jsonEncode(body), token);
    if (_authFail(r)) {
      final t = await login();
      if (t == null) return {"ok": false, "msg": "WMAS登录失效且自动重登失败，请到设置页重新登录"};
      r = await _raw(method, path, body == null ? null : jsonEncode(body), t);
    }
    if (r == null) return {"ok": false, "msg": "WMAS无响应"};
    final j = r["json"];
    if (j is Map && j["success"] == true) return {"ok": true, "data": j["data"]};
    final msg = (j is Map ? j["msg"]?.toString() : null) ?? "HTTP ${r["status"]} ${r["text"]}";
    return {"ok": false, "msg": msg};
  }
}

/// WMAS 主档缓存：库位→仓库/库区、容器主档；1 小时自动刷新
class WmasMaster {
  static Map<String, Map<String, String>>? _loc;
  static int _locAt = 0;
  static List<Map>? _cont;
  static int _contAt = 0;

  static Future<void> _ensureLoc() async {
    if (_loc != null && DateTime.now().millisecondsSinceEpoch - _locAt < 3600 * 1000) return;
    final r = await WmasApi.req("GET", "/api/basicdata/wmsLocation/listAll");
    if (r["ok"] == true && r["data"] is List) {
      final m = <String, Map<String, String>>{};
      for (final e in (r["data"] as List).whereType<Map>()) {
        final code = e["locationCode"]?.toString().toUpperCase() ?? "";
        if (code.isEmpty) continue;
        m[code] = {"wh": e["warehouseCode"]?.toString() ?? "", "zone": e["zoneCode"]?.toString() ?? ""};
      }
      if (m.isNotEmpty) { _loc = m; _locAt = DateTime.now().millisecondsSinceEpoch; }
    }
  }

  static Future<Map<String, String>?> locationOf(String code) async {
    await _ensureLoc();
    return _loc?[code.toUpperCase()];
  }

  static Future<void> _ensureCont() async {
    if (_cont != null && DateTime.now().millisecondsSinceEpoch - _contAt < 3600 * 1000) return;
    final r = await WmasApi.req("GET", "/api/logistics/container/list?pageNum=1&pageSize=1000");
    if (r["ok"] == true && r["data"] is Map && (r["data"] as Map)["records"] is List) {
      _cont = List<Map>.from((r["data"] as Map)["records"] as List);
      _contAt = DateTime.now().millisecondsSinceEpoch;
    }
  }

  /// 容器类型 → 候选容器编码（主档里 containerCode 含类型串即候选，如 1800*1200_2 → NB-B1800*1200_2-00001）
  static Future<List<String>> containerCodesOf(String type) async {
    await _ensureCont();
    final t = type.trim().toUpperCase();
    if (t.isEmpty || _cont == null) return [];
    final out = _cont!.map((c) => c["containerCode"]?.toString() ?? "").where((s) => s.toUpperCase().contains(t)).toList();
    out.sort();
    return out;
  }
}

/// 一键建 AGV 搬运任务：起终点归属反查主档；建完自动下发（可选）
class WmasTask {
  static Future<Map<String, dynamic>> createCarry({
    required String startPoint,
    required String endPoint,
    required String containerNo,
    String refNo = "",
    bool dispatch = true,
  }) async {
    if (containerNo.trim().isEmpty) return {"ok": false, "msg": "容器编码不能为空"};
    final s = await WmasMaster.locationOf(startPoint);
    if (s == null) return {"ok": false, "msg": "起始库位「$startPoint」不在WMAS库位主档，请核对"};
    final e = await WmasMaster.locationOf(endPoint);
    if (e == null) return {"ok": false, "msg": "目标库位「$endPoint」不在WMAS库位主档，请核对"};
    final body = {
      "taskType": "CARRY",
      "warehouse": s["wh"], "startArea": s["zone"], "startPoint": startPoint.toUpperCase(),
      "endArea": e["zone"], "endPoint": endPoint.toUpperCase(),
      "containerNo": containerNo.trim(), "refNo": refNo.trim(),
    };
    final c = await WmasApi.req("POST", "/api/logistics/agv-task", body: body);
    if (c["ok"] != true) return {"ok": false, "msg": "建任务失败：${c["msg"]}"};
    String? id;
    final d = c["data"];
    if (d is Map) id = d["id"]?.toString();
    if ((id ?? "").isEmpty) {
      // 建任务响应没回 id：按容器号查最新一条 CREATED 兜底
      final q = await WmasApi.req("GET", "/api/logistics/agv-task/list?pageNum=1&pageSize=3&containerNo=${Uri.encodeComponent(containerNo.trim())}");
      if (q["ok"] == true && q["data"] is Map) {
        final recs = List<Map>.from((q["data"] as Map)["records"] ?? []);
        for (final rec in recs) {
          if (rec["status"]?.toString() == "CREATED") { id = rec["id"]?.toString(); break; }
        }
        id ??= recs.isNotEmpty ? recs.first["id"]?.toString() : null;
      }
    }
    if (!dispatch) return {"ok": true, "msg": "任务已创建（未下发）", "id": id};
    if ((id ?? "").isEmpty) return {"ok": true, "msg": "任务已创建，但未取到任务id，请在WMAS列表手动下发", "id": null};
    final dp = await WmasApi.req("POST", "/api/logistics/agv-task/dispatch", body: {"ids": [id]});
    if (dp["ok"] != true) return {"ok": true, "msg": "任务已创建，下发失败：${dp["msg"]}（请在WMAS手动下发）", "id": id};
    final warn = dp["data"];
    final tip = (warn is String && warn.trim().isNotEmpty) ? "已创建，下发提示：$warn" : "已创建并下发 ✅";
    return {"ok": true, "msg": "任务$tip", "id": id};
  }
}

/// WMAS(AGV) 设置页：地址 + 账号 + 密码 + 测试登录
class WmasSettingPage extends StatefulWidget {
  const WmasSettingPage({super.key});
  @override
  State<WmasSettingPage> createState() => _WmasSettingPageState();
}

class _WmasSettingPageState extends State<WmasSettingPage> {
  final _hostCtrl = TextEditingController();
  final _accCtrl = TextEditingController();
  final _pwdCtrl = TextEditingController();
  String _msg = "";
  bool _ok = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final cfg = await WmasConfig.get();
      if (!mounted) return;
      setState(() {
        _hostCtrl.text = cfg["host"] ?? WmasConfig.defaultHost;
        _accCtrl.text = cfg["account"] ?? "";
        _pwdCtrl.text = cfg["pwd"] ?? "";
      });
    });
  }

  @override
  void dispose() { _hostCtrl.dispose(); _accCtrl.dispose(); _pwdCtrl.dispose(); super.dispose(); }

  Future<void> _save() async {
    if (_hostCtrl.text.trim().isEmpty || _accCtrl.text.trim().isEmpty || _pwdCtrl.text.isEmpty) {
      setState(() { _ok = false; _msg = "三项都要填"; });
      return;
    }
    await WmasConfig.save(host: _hostCtrl.text, account: _accCtrl.text, pwd: _pwdCtrl.text);
    setState(() { _ok = true; _msg = "已保存"; });
  }

  Future<void> _test() async {
    if (_busy) return;
    setState(() { _busy = true; _msg = "登录中…"; });
    await WmasConfig.save(host: _hostCtrl.text, account: _accCtrl.text, pwd: _pwdCtrl.text);
    final t = await WmasApi.login();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ok = t != null;
      _msg = t != null ? "登录成功，token 已缓存（11小时有效）" : "登录失败：检查地址/账号/密码（或网络不通）";
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("WMAS(AGV)设置"), backgroundColor: const Color(0xFF00897B)),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        TextField(controller: _hostCtrl, decoration: const InputDecoration(labelText: "服务地址", hintText: "172.25.1.155:8080", border: OutlineInputBorder())),
        const SizedBox(height: 12),
        TextField(controller: _accCtrl, decoration: const InputDecoration(labelText: "账号（工号）", border: OutlineInputBorder())),
        const SizedBox(height: 12),
        TextField(controller: _pwdCtrl, obscureText: true, decoration: const InputDecoration(labelText: "密码", border: OutlineInputBorder())),
        const SizedBox(height: 16),
        Row(children: [
          Expanded(child: ElevatedButton(onPressed: _busy ? null : _save, style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF00897B), foregroundColor: Colors.white), child: const Text("保存"))),
          const SizedBox(width: 12),
          Expanded(child: OutlinedButton(onPressed: _busy ? null : _test, child: Text(_busy ? "登录中…" : "测试登录"))),
        ]),
        if (_msg.isNotEmpty) Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text(_msg, style: TextStyle(color: _ok ? Colors.green : Colors.red, fontWeight: FontWeight.w600)),
        ),
        const SizedBox(height: 12),
        const Text("说明：一键建AGV任务用本账号登录WMAS调度系统；token 约半天有效，失效自动重登。", style: TextStyle(fontSize: 12, color: Colors.grey)),
      ]),
    );
  }
}

/// 站台在途任务计数：查 WMAS 未完成（推送/调度/运输中）任务按目标站台统计。
/// 返回 {"NB02-CK-05": 2, ...}；查询失败返回空表不阻塞选台。
Future<Map<String, int>> wmasStationsBusy() async {
  final out = <String, int>{};
  for (final st in ['PUSHED', 'DISPATCHED', 'IN_TRANSIT']) {
    final r = await WmasApi.req("GET", "/api/logistics/agv-task/list?pageNum=1&pageSize=100&status=$st");
    if (r["ok"] == true && r["data"] is Map) {
      for (final t in List<Map>.from((r["data"] as Map)["records"] ?? [])) {
        final ep = t["endPoint"]?.toString().toUpperCase() ?? "";
        if (ep.contains('-CK-')) out[ep] = (out[ep] ?? 0) + 1;
      }
    }
  }
  return out;
}

/// 领料出库叫车窗：货架位 → 人工选空闲站台 → 建 CARRY 任务（架→台）并下发。
/// 站台物理占用 WMAS 与自己都不知道，故必须人选；窗内给出"在途任务数"参考。
class AgvCallDialog extends StatefulWidget {
  final String fromLoc, containerType, label;
  final void Function(String, {bool err}) toast;
  const AgvCallDialog({required this.fromLoc, required this.containerType, required this.label, required this.toast});
  @override
  State<AgvCallDialog> createState() => _AgvCallDialogState();
}

class _AgvCallDialogState extends State<AgvCallDialog> {
  List<String> _cands = [];
  String? _picked;
  String? _station;
  Map<String, int> _busy = {};
  bool _loading = true;
  bool _sending = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final both = await Future.wait([
        WmasMaster.containerCodesOf(widget.containerType),
        wmasStationsBusy(),
      ]);
      if (!mounted) return;
      final cands = both[0] as List<String>;
      setState(() {
        _cands = cands;
        _picked = cands.length == 1 ? cands.first : null;
        _busy = both[1] as Map<String, int>;
        _loading = false;
      });
    } catch (e) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _submit() async {
    final stn = _station, cn = _picked;
    if (stn == null || (cn ?? '').isEmpty || _sending) return;
    setState(() => _sending = true);
    final r = await WmasTask.createCarry(startPoint: widget.fromLoc, endPoint: stn, containerNo: cn!);
    if (!mounted) return;
    setState(() => _sending = false);
    widget.toast("${r["ok"] == true ? "AGV出库任务：$stn ← ${widget.fromLoc}" : "叫车失败：${r["msg"]}"}", err: r["ok"] != true);
    if (r["ok"] == true) Navigator.pop(context, stn); // 回传站台：调用方登记"已叫AGV"
  }

  @override
  Widget build(BuildContext context) {
    const stations = ['05', '06', '07', '08', '09', '10', '11', '12'];
    return AlertDialog(
      title: Text("叫 AGV 出库\n${widget.fromLoc} → ？", style: const TextStyle(fontSize: 16)),
      content: SizedBox(width: 340, child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text("标签 ${widget.label}${widget.containerType.isEmpty ? "" : " · ${widget.containerType}"}", style: const TextStyle(fontSize: 12, color: Colors.grey)),
        const SizedBox(height: 8),
        const Text("站台（物理有无货物系统不知道，请肉眼确认后选择）：", style: TextStyle(fontSize: 12.5)),
        const SizedBox(height: 4),
        Wrap(spacing: 6, runSpacing: 6, children: stations.map((n) {
          final code = "NB02-CK-$n";
          final b = _busy[code] ?? 0;
          final sel = _station == code;
          return ChoiceChip(
            selected: sel,
            onSelected: (_) => setState(() => _station = code),
            label: Text(b > 0 ? "CK-$n\n在途$b" : "CK-$n", style: const TextStyle(fontSize: 12)),
            backgroundColor: sel ? const Color(0xFF00897B) : (b > 0 ? Colors.orange.shade100 : Colors.white),
          );
        }).toList()),
        const SizedBox(height: 10),
        if (_loading)
          const Row(children: [SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)), SizedBox(width: 8), Text("查容器主档…", style: TextStyle(fontSize: 12))])
        else if (_cands.isEmpty)
          TextField(
            decoration: InputDecoration(
              labelText: "容器编码（主档没查到「${widget.containerType}」，手输）",
              isDense: true, border: const OutlineInputBorder(),
            ),
            onChanged: (v) => setState(() => _picked = v.trim().isEmpty ? null : v.trim()),
          )
        else if (_cands.length == 1)
          Text("容器编码：${_cands.first}", style: const TextStyle(fontSize: 13, fontFamily: "monospace", color: Color(0xFF1A237E)))
        else
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("容器编码（${_cands.length} 个候选，选架上这只）：", style: const TextStyle(fontSize: 12, color: Colors.grey)),
            SizedBox(height: _cands.length > 3 ? 92 : 30*(_cands.length)+4, child: ListView.builder(
              shrinkWrap: true, itemCount: _cands.length,
              itemBuilder: (bc, i) => RadioListTile<String>(
                dense: true, contentPadding: EdgeInsets.zero, visualDensity: VisualDensity.compact,
                title: Text(_cands[i], style: const TextStyle(fontSize: 12.5, fontFamily: "monospace")),
                value: _cands[i], groupValue: _picked, onChanged: (v) => setState(() => _picked = v),
              ),
            )),
          ]),
      ])),
      actions: [
        TextButton(onPressed: () {
          Clipboard.setData(ClipboardData(text: widget.label));
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已复制标签"), backgroundColor: Color(0xFF2E7D32)));
        }, child: const Text("复制标签")),
        TextButton(onPressed: () => Navigator.pop(context), child: const Text("取消")),
        ElevatedButton.icon(
          style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF00897B), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
          onPressed: (_station != null && (_picked ?? '').isNotEmpty && !_sending && !_loading) ? _submit : null,
          icon: _sending ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.local_shipping, size: 16),
          label: const Text("叫车"),
        ),
      ],
    );
  }
}
