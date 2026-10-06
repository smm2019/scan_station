part of 'main.dart';

// ===================== AGV调度系统(哈工库讯RCS)模块：登录/任务/车辆/交管监控 =====================
// 协议来源：抓包 + Swagger(/v3/api-docs) + 前端JS逆向 + 只读实测（2026-10-05）。
// 登录 POST http://<host>/login {username,password,captcha,uuid} → data.token（12h有效；验证码万能码12345，uuid任意）
// 业务请求头：token: <token>；响应 {code:0,msg,data}，code!=0 即失败
// 进行中任务 GET /task/getTaskInfo ｜ 历史任务 GET /task/getDoneTaskList（data为JSON字符串需二次解码）
// 车辆信息 GET /uds/car/getCarInfoList ｜ 车辆当前点位 GET /agv/debug/getCarListForStatus
// 交管锁 GET /agv/debug/getLockResourceListForStatus（landmarkOwners点位占用 + zoneLocks区lockCars/blockedCars）
// 任务详情 suspensionMsg 为JSON字符串：{taskId,startPoint,endPoint,palletType,taskType}
// 状态枚举（前端源码）：taskState -2已放弃/-1已挂起/0待执行/1执行中/2已完成/5已超时/6已清除
// carState: idle空闲 / running执行中 / pause暂停 / 其他=错误；communicationBreak=true 通讯断开
// 实时界面：WebView 打开门户 /home-index，注入 sessionStorage token 自动登录
// 后续派活预留：POST /api/v1/agv/task（任务下发接口已确认存在，body格式接入时实测）

class AgvConfig {
  static const keyHost = "agv_host"; // 调度API 地址端口
  static const keyPortal = "agv_portal"; // 实时大屏门户 地址端口
  static const keyAccount = "agv_account";
  static const keyPwd = "agv_pwd";
  static const keyToken = "agv_token";
  static const keyTokenExp = "agv_token_exp";
  static const defaultHost = "10.96.23.8:9091";
  static const defaultPortal = "10.96.23.8:8181";

  static Future<Map<String, String>> get() async {
    final sp = await SharedPreferences.getInstance();
    return {
      "host": (sp.getString(keyHost) ?? defaultHost).trim(),
      "portal": (sp.getString(keyPortal) ?? defaultPortal).trim(),
      "account": (sp.getString(keyAccount) ?? "").trim(),
      "pwd": sp.getString(keyPwd) ?? "",
    };
  }

  static Future<void> save({required String host, required String portal, required String account, required String pwd}) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(keyHost, host.trim());
    await sp.setString(keyPortal, portal.trim());
    await sp.setString(keyAccount, account.trim());
    await sp.setString(keyPwd, pwd);
    await sp.remove(keyToken);
    await sp.remove(keyTokenExp);
  }
}

class AgvApi {
  static const _timeout = Duration(seconds: 10);

  static String _uuid() => DateTime.now().microsecondsSinceEpoch.toRadixString(16);

  static Future<Map<String, dynamic>?> _raw(String method, String path, String? body, String? token) async {
    final cfg = await AgvConfig.get();
    HttpClient? client;
    try {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
      final req = await client.openUrl(method, Uri.parse("http://${cfg["host"]}$path"));
      req.headers.set("Accept", "*/*");
      if (body != null) req.headers.contentType = ContentType.json;
      if (token != null) req.headers.set("token", token);
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

  /// 登录并缓存 token（12h 留 1h 余量）；失败返回 null
  static Future<String?> login() async {
    final cfg = await AgvConfig.get();
    if ((cfg["account"] ?? "").isEmpty || (cfg["pwd"] ?? "").isEmpty) return null;
    final r = await _raw("POST", "/login",
        jsonEncode({"username": cfg["account"], "password": cfg["pwd"], "captcha": "12345", "uuid": _uuid()}), null);
    final j = r?["json"];
    if (j is Map && j["code"] == 0 && j["data"] is Map) {
      final t = (j["data"] as Map)["token"]?.toString() ?? "";
      if (t.isNotEmpty) {
        final sp = await SharedPreferences.getInstance();
        await sp.setString(AgvConfig.keyToken, t);
        await sp.setInt(AgvConfig.keyTokenExp, DateTime.now().millisecondsSinceEpoch + 11 * 3600 * 1000);
        return t;
      }
    }
    return null;
  }

  /// 有效 token（过期自动重登）
  static Future<String?> token() async {
    final sp = await SharedPreferences.getInstance();
    final t = sp.getString(AgvConfig.keyToken) ?? "";
    final exp = sp.getInt(AgvConfig.keyTokenExp) ?? 0;
    if (t.isNotEmpty && DateTime.now().millisecondsSinceEpoch <= exp) return t;
    return login();
  }

  static bool _authFail(Map<String, dynamic>? r) {
    if (r == null) return false;
    if (r["status"] == 401 || r["status"] == 403) return true;
    final j = r["json"];
    if (j is Map) {
      final m = j["msg"]?.toString() ?? "";
      if (m.contains("未登录") || m.contains("登录已过期") || m.contains("token") || m.contains("Token")) return true;
    }
    return false;
  }

  /// AGV系统请求：自动带token，过期静默重登一次。返回 {ok,data} / {ok:false,msg}
  static Future<Map<String, dynamic>> req(String method, String path, {Map? body}) async {
    var t = await token();
    if (t == null) return {"ok": false, "msg": "AGV系统未登录：请到 设置→AGV调度系统 填写账号密码"};
    var r = await _raw(method, path, body == null ? null : jsonEncode(body), t);
    if (_authFail(r)) {
      t = await login();
      if (t == null) return {"ok": false, "msg": "AGV系统登录失效且自动重登失败"};
      r = await _raw(method, path, body == null ? null : jsonEncode(body), t);
    }
    if (r == null) return {"ok": false, "msg": "AGV系统无响应"};
    final j = r["json"];
    if (j is Map && j["code"] == 0) return {"ok": true, "data": j["data"]};
    final msg = (j is Map ? j["msg"]?.toString() : null) ?? "HTTP ${r["status"]} ${r["text"]}";
    return {"ok": false, "msg": msg};
  }

  // ---------- 业务查询（全部只读，不下发任何控制指令） ----------
  static List<Map> _decodeList(dynamic data) {
    if (data is String) { try { data = jsonDecode(data); } catch (_) { return []; } }
    if (data is List) return data.whereType<Map>().toList();
    return [];
  }

  /// 进行中任务（待执行+执行中）
  static Future<List<Map>> tasksRunning() async {
    final r = await req("GET", "/task/getTaskInfo");
    return r["ok"] == true ? _decodeList(r["data"]) : [];
  }

  /// 历史任务（已完成/超时/清除等）
  static Future<List<Map>> tasksDone() async {
    final r = await req("GET", "/task/getDoneTaskList");
    return r["ok"] == true ? _decodeList(r["data"]) : [];
  }

  /// 车辆信息合并：基础状态 + 当前点位/执行任务号
  static Future<List<Map>> cars() async {
    final a = await req("GET", "/uds/car/getCarInfoList");
    if (a["ok"] != true || a["data"] is! List) return [];
    final b = await req("GET", "/agv/debug/getCarListForStatus");
    final site = <int, Map>{};
    if (b["ok"] == true && b["data"] is List) {
      for (final e in (b["data"] as List).whereType<Map>()) {
        final id = e["agvId"];
        if (id is int) site[id] = e;
      }
    }
    final out = <Map>[];
    for (final c in (a["data"] as List).whereType<Map>()) {
      final m = Map.of(c);
      final s = site[c["agvId"]];
      if (s != null) { m["currentSite"] = s["currentSite"]; if (s["executeTaskNo"] != null) m["execTaskNo"] = s["executeTaskNo"]; }
      out.add(m);
    }
    return out;
  }

  /// 交管锁资源：{landmarkLocks:{landmarkOwners:{点位:车},totalLocked}, zoneLocks:{zoneList:[{zoneId,remarks,carNumber,lockCars,blockedCars}]}}
  static Future<Map> traffic() async {
    final r = await req("GET", "/agv/debug/getLockResourceListForStatus");
    return r["ok"] == true && r["data"] is Map ? Map.of(r["data"] as Map) : {};
  }

  // ---------- 车辆控制（写操作：参数=车辆IP，与调度系统大屏同款按钮） ----------
  /// action: charge充电 / standby待命 / reset清除任务 / stop急停 / start启动
  static const carActions = {
    "charge": {"path": "/agv/carToCharge", "label": "去充电", "tip": "给该车创建充电任务", "danger": false},
    "standby": {"path": "/agv/carToStandby", "label": "回待命", "tip": "给该车创建待命任务", "danger": false},
    "reset": {"path": "/agv/resetCar", "label": "清除任务", "tip": "清空该车当前任务（车会原地停下等待）", "danger": true},
    "stop": {"path": "/agv/stopAgv", "label": "急停", "tip": "立即停车，需人工或启动恢复", "danger": true},
    "start": {"path": "/agv/startAgv", "label": "启动", "tip": "恢复该车运行", "danger": false},
  };
  static Future<Map<String, dynamic>> carAction(String action, String ip) async {
    final a = carActions[action];
    if (a == null || ip.isEmpty) return {"ok": false, "msg": "参数错误"};
    return req("PUT", "${a["path"]}?ip=${Uri.encodeComponent(ip)}");
  }

  /// 站台状态（走自己的鉴权服务器：服务器60秒轮询RCS汇总，含"有货/占用中/空闲"）
  static Future<Map> stations() async {
    final r = await AuthApi.rcsStations();
    return r["ok"] == true ? r : {};
  }

  // ---------- 状态文案 ----------
  static const taskStateText = {-2: "已放弃", -1: "已挂起", 0: "待执行", 1: "执行中", 2: "已完成", 5: "已超时", 6: "已清除"};
  static String taskStateOf(dynamic s) { final v = s is int ? s : int.tryParse("$s") ?? 99; return taskStateText[v] ?? "状态$v"; }
  static Color taskStateColor(dynamic s) {
    final v = s is int ? s : int.tryParse("$s") ?? 99;
    if (v == 1) return const Color(0xFF1565C0);
    if (v == 0) return const Color(0xFFEF6C00);
    if (v == 2) return Colors.green;
    if (v == -1 || v == 5 || v == -2 || v == 6) return Colors.red;
    return Colors.blueGrey;
  }
  static String carStateOf(Map c) {
    if (c["communicationBreak"] == true) return "通讯断开";
    switch (c["carState"]?.toString()) {
      case "idle": return "空闲";
      case "running": return "执行中";
      case "pause": return "暂停";
      case "error": return "错误";
      default: return c["carState"]?.toString() ?? "未知";
    }
  }
  /// 被交管等待的车 agvId 集合（任一交管区 blockedCars）
  static Set<int> blockedIds(Map traffic) {
    final out = <int>{};
    final zl = traffic["zoneLocks"];
    if (zl is Map && zl["zoneList"] is List) {
      for (final z in (zl["zoneList"] as List).whereType<Map>()) {
        final arr = z["blockedCars"] is List ? z["blockedCars"] as List : const [];
        for (final e in arr) {
          if (e is Map && e["agvId"] is int) out.add(e["agvId"] as int);
          else if (e is int) out.add(e);
        }
      }
    }
    return out;
  }
  /// 任务起终点：suspensionMsg 二次解码 {startPoint,endPoint,palletType,taskType}
  static Map taskRoute(Map t) {
    final s = t["suspensionMsg"]?.toString() ?? "";
    if (s.isEmpty) return {};
    try { final m = jsonDecode(s); return m is Map ? m : {}; } catch (_) { return {}; }
  }
  /// yyyyMMddHHmmss → MM-dd HH:mm
  static String fmtT(dynamic s) {
    final v = "$s";
    if (v.length >= 12) return "${v.substring(4, 6)}-${v.substring(6, 8)} ${v.substring(8, 10)}:${v.substring(10, 12)}";
    return v.isEmpty ? "-" : v;
  }
}

// ===================== AGV模块主页面：任务 / 车辆 / 交管 / 实时界面 =====================
class AgvMonitorPage extends StatefulWidget {
  const AgvMonitorPage({super.key});
  @override State<AgvMonitorPage> createState() => _AgvMonitorPageState();
}

class _AgvMonitorPageState extends State<AgvMonitorPage> with AutomaticKeepAliveClientMixin {
  List<Map> _tasks = [], _done = [], _cars = [];
  Map _traffic = {};
  Map<String, String> _cargo = {}; // 任务起点货位 → 账本反查的货物描述（零件号×数量）
  List<Map> _stations = []; // 站台状态（服务器轮询RCS：有货/占用中/空闲）
  bool _loading = false, _showDone = false, _loaded = false;
  String _err = "";
  Timer? _timer;

  @override bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) { if (mounted) _load(silent: true); });
  }

  @override
  void dispose() { _timer?.cancel(); super.dispose(); }

  Future<void> _load({bool silent = false}) async {
    if (_loading) return;
    setState(() { _loading = true; if (!silent) _err = ""; });
    final tk = await AgvApi.token();
    if (tk == null) {
      if (mounted) setState(() { _loading = false; _err = "未登录：请到 设置 → AGV调度系统 填写账号密码"; });
      return;
    }
    final rs = await Future.wait([AgvApi.tasksRunning(), AgvApi.cars(), AgvApi.traffic(), AgvApi.tasksDone(), AuthApi.rcsStations()]);
    if (!mounted) return;
    setState(() {
      _loading = false; _loaded = true;
      _tasks = rs[0] as List<Map>; _cars = rs[1] as List<Map>; _traffic = rs[2] as Map; _done = rs[3] as List<Map>;
      final st = rs[4]; _stations = st is Map && st["stations"] is List ? List<Map>.from(st["stations"] as List) : [];
      _err = "";
    });
    unawaited(_buildCargo());
  }

  /// 反查货物：AGV 只知"搬托盘"，货由任务起点货位回查本机货位账本得到（零件号/数量/标签）
  Future<void> _buildCargo() async {
    try {
      final locs = <String>{
        for (final t in [..._tasks, ..._done.take(10)])
          if ((AgvApi.taskRoute(t)["startPoint"] ?? "").toString().isNotEmpty) AgvApi.taskRoute(t)["startPoint"].toString().toUpperCase()
      };
      if (locs.isEmpty) return;
      final placements = await _globalIsar.shelfPlacements.where().findAll();
      final infos = {for (final e in await _globalIsar.labelInfos.where().findAll()) e.goodsCode: e};
      final byLoc = <String, List<String>>{};
      for (final p in placements) {
        final k = p.loc.toUpperCase();
        if (locs.contains(k)) byLoc.putIfAbsent(k, () => []).add(p.goodsCode.toUpperCase());
      }
      final out = <String, String>{};
      for (final l in locs) {
        final codes = byLoc[l];
        if (codes == null || codes.isEmpty) { out[l] = "账本无此位货物"; continue; }
        final parts = <String>[];
        double sum = 0;
        String partTxt = "";
        for (final c in codes) {
          final i = infos[c];
          if (i != null && !i.missing && i.partNo.isNotEmpty) {
            if (partTxt.isEmpty) partTxt = i.partNo;
            sum += i.qty;
            if (i.partNo != partTxt) partTxt = "$partTxt等";
          }
        }
        parts.add(partTxt.isNotEmpty ? "$partTxt·${_fmtInvNum(sum.roundToDouble())}件" : "未补齐物料");
        out[l] = "${parts.join(" / ")}（标签 ${codes.join("/")}）";
      }
      if (!mounted) return;
      setState(() => _cargo = out);
    } catch (e) {
      debugPrint("[agv] 货物反查失败：$e");
    }
  }

  Map<int, String> get _carName => {for (final c in _cars) if (c["agvId"] is int) c["agvId"] as int: (c["carName"]?.toString() ?? "AGV${c["agvId"]}")};

  bool get _canCtl { final r = Auth.user?.role ?? ""; return r == "warehouse" || r == "admin"; } // 仅仓管/管理员可下发车辆控制
  void _toast(String s) { if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(s), duration: const Duration(seconds: 3))); }

  /// 车辆控制：确认弹窗（危险操作红色警示）→ 下发 → 提示结果并刷新
  Future<void> _ctrlCar(Map c, String action) async {
    final a = AgvApi.carActions[action];
    if (a == null) return;
    final ip = (c["carIp"] ?? "").toString();
    if (ip.isEmpty) { _toast("该车没有IP信息，无法控制"); return; }
    final danger = a["danger"] == true;
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: Text(danger ? "⚠️ ${a["label"]}" : "${a["label"]}", style: TextStyle(color: danger ? Colors.red : null)),
      content: Text("对 ${c["carName"] ?? ip}（$ip）下发「${a["label"]}」？\n${a["tip"]}\n\n注意：这是对真实车辆的指令，请确认现场安全。"),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        FilledButton(style: danger ? FilledButton.styleFrom(backgroundColor: Colors.red) : null, onPressed: () => Navigator.pop(ctx, true), child: const Text("确认下发"))],
    ));
    if (ok != true || !mounted) return;
    final r = await AgvApi.carAction(action, ip);
    _toast(r["ok"] == true ? "✅ ${a["label"]}：指令已下发" : "❌ ${a["label"]}失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  Widget _ctrlBtn(Map c, String act) {
    final a = AgvApi.carActions[act]!, danger = a["danger"] == true;
    final color = danger ? Colors.red : (act == "charge" ? Colors.teal : const Color(0xFF1565C0));
    return ActionChip(avatar: Icon(danger ? Icons.dangerous_outlined : (act == "charge" ? Icons.bolt : (act == "start" ? Icons.play_arrow : (act == "stop" ? Icons.stop_circle_outlined : Icons.home_outlined))), size: 15, color: color),
      label: Text(a["label"].toString(), style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600)),
      visualDensity: VisualDensity.compact, materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      onPressed: () => _ctrlCar(c, act));
  }

  /// 人工清台：现场已取走但系统未识别（如人工直接搬走）时，仓管确认后即刻转空闲
  Future<void> _clearStation(String code) async {
    final ok = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text("人工清台"),
      content: Text("确认站台 $code 上的货已被取走？\n确认后站台立即转为空闲（不影响AGV与领料单数据）。"),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
        FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认清台"))],
    ));
    if (ok != true || !mounted) return;
    final r = await AuthApi.rcsClear(code);
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ 清台失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final blocked = AgvApi.blockedIds(_traffic);
    final online = _cars.where((c) => c["communicationBreak"] != true && c["enable"] == 1).length;
    final running = _cars.where((c) => c["carState"] == "running").length;
    final idle = _cars.where((c) => c["carState"] == "idle").length;
    return Column(children: [
      // 顶部统计条（对齐调度大屏口径）
      Container(color: const Color(0xFF102A43), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: Row(children: [
          _statChip(Icons.wifi, "$online/${_cars.length}在线", Colors.green),
          _statChip(Icons.play_circle, "$running执行中", Colors.lightBlueAccent),
          _statChip(Icons.pause_circle, "$idle空闲", Colors.teal),
          _statChip(Icons.block, "${blocked.length}被交管", blocked.isEmpty ? Colors.blueGrey : Colors.orangeAccent),
          const Spacer(),
          if (_loading) const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.cyan)),
          IconButton(icon: const Icon(Icons.refresh, color: Colors.white70, size: 20), onPressed: _loading ? null : () => _load()),
        ])),
      if (_err.isNotEmpty) Container(width: double.infinity, color: const Color(0xFFFFF3E0), padding: const EdgeInsets.all(8),
        child: Text(_err, style: const TextStyle(fontSize: 12, color: Color(0xFFE65100)))),
      Expanded(child: !_loaded && _err.isEmpty
        ? const Center(child: CircularProgressIndicator())
        : DefaultTabController(length: 5, child: Column(children: [
            const TabBar(labelColor: Colors.white, unselectedLabelColor: Color(0xFF90A4AE), indicatorColor: Colors.cyan, tabs: [
              Tab(text: "任务"), Tab(text: "车辆"), Tab(text: "站台"), Tab(text: "交管"), Tab(text: "实时界面")]),
            Expanded(child: TabBarView(
              physics: const NeverScrollableScrollPhysics(), // 内层只点不滑，横滑留给外层换模块
              children: [
              _taskList(), _carList(blocked), _stationList(), _trafficView(blocked), _portalView(),
            ])),
          ]))),
    ]);
  }

  Widget _statChip(IconData ic, String txt, Color color) => Padding(padding: const EdgeInsets.only(right: 10),
    child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(ic, size: 14, color: color), const SizedBox(width: 3), Text(txt, style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.bold))]));

  Widget _tag(String txt, Color color) => Container(margin: const EdgeInsets.only(right: 4), padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(color: color.withOpacity(0.12), borderRadius: BorderRadius.circular(4), border: Border.all(color: color.withOpacity(0.5))),
    child: Text(txt, style: TextStyle(fontSize: 11, color: color, fontWeight: FontWeight.w600)));

  // ---- 任务页签 ----
  Widget _taskList() {
    final names = _carName;
    Widget card(Map t, {bool done = false}) {
      final rt = AgvApi.taskRoute(t);
      final st = t["taskState"];
      final no = "${t["dispatchNo"] ?? ""}";
      final sp = (rt["startPoint"] ?? "").toString().toUpperCase();
      final cargo = _cargo[sp];
      final isCharge = rt["taskType"]?.toString() == "CHARGE" || "${t["taskType"] ?? ""}" == "CHARGE";
      return Container(margin: const EdgeInsets.fromLTRB(10, 6, 10, 0), padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFE3E8F0)),
          boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 4, offset: Offset(0, 1))]),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(no, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
            Container(padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2), decoration: BoxDecoration(color: AgvApi.taskStateColor(st), borderRadius: BorderRadius.circular(10)),
              child: Text(AgvApi.taskStateOf(st), style: const TextStyle(color: Colors.white, fontSize: 11))),
          ]),
          const SizedBox(height: 6),
          Text("${rt["startPoint"] ?? "?"}  →  ${rt["endPoint"] ?? "?"}", style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Color(0xFF1565C0))),
          const SizedBox(height: 4),
          Text("车：${names[t["exeAgvId"]] ?? (t["exeAgvId"] == null ? "未分配" : "AGV${t["exeAgvId"]}")}　托盘：${rt["palletType"] ?? t["palletType"] ?? "-"}　类型：${rt["taskType"] ?? t["taskType"] ?? "-"}",
            style: const TextStyle(fontSize: 11, color: Color(0xFF607D8B))),
          // 货物：AGV系统只知搬托盘，零件号/数量按起点货位反查本机货位账本（充电任务无货）
          if (isCharge)
            Text("货物：—（充电任务）", style: const TextStyle(fontSize: 11, color: Color(0xFF26A69A), fontWeight: FontWeight.w600))
          else if (cargo != null)
            Text("货物：$cargo", style: const TextStyle(fontSize: 11, color: Color(0xFF26A69A), fontWeight: FontWeight.w600))
          else if (sp.isEmpty)
            const Text("货物：—", style: TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))
          else
            Text("货物：起点 $sp 未入账本/账本未同步，无法反查", style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
          Text("创建 ${AgvApi.fmtT(t["buildTime"])}　执行 ${AgvApi.fmtT(t["exeTime"])}${done && t["finishTime"] != null ? "　完成 ${AgvApi.fmtT(t["finishTime"])}" : ""}",
            style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
        ]));
    }
    final act = _tasks.where((t) => (t["taskState"] == 0 || t["taskState"] == 1)).toList();
    return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
      Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 0), child: Text("进行中任务（${act.length}）", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      if (act.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text("当前没有进行中任务", style: TextStyle(color: Colors.blueGrey)))),
      ...act.map((t) => card(t)),
      Padding(padding: const EdgeInsets.fromLTRB(12, 14, 12, 0), child: Text("最近历史（${_done.length}）", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      TextButton(onPressed: () => setState(() => _showDone = !_showDone), child: Text(_showDone ? "收起" : "展开最近10条")),
      if (_showDone) ..._done.take(10).map((t) => card(t, done: true)),
    ]);
  }

  // ---- 车辆页签 ----
  Widget _carList(Set<int> blocked) {
    if (_cars.isEmpty) return const Center(child: Text("无车辆数据（检查登录/网络）", style: TextStyle(color: Colors.blueGrey)));
    return ListView(padding: const EdgeInsets.only(bottom: 16), children: _cars.map((c) {
      final id = c["agvId"];
      final online = c["communicationBreak"] != true && c["enable"] == 1;
      final power = (c["power"] as num?)?.toDouble() ?? 0;
      final speed = (c["speed"] as num?)?.toDouble() ?? 0;
      final taskNo = (c["execTaskNo"] ?? c["executeTaskNo"])?.toString() ?? "";
      return Container(margin: const EdgeInsets.fromLTRB(10, 6, 10, 0), padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFE3E8F0))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text("${c["carName"] ?? "AGV$id"}", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
            const SizedBox(width: 6),
            Text("${c["carIp"] ?? ""}", style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
            const Spacer(),
            if (blocked.contains(id)) _tag("被交管", Colors.deepOrange),
            if (c["lock"] == true) _tag("已锁定", Colors.red),
            _tag(online ? "在线" : "离线", online ? Colors.green : Colors.grey),
            _tag(AgvApi.carStateOf(c), online ? (c["carState"] == "running" ? Colors.lightBlue : Colors.teal) : Colors.grey),
          ]),
          const SizedBox(height: 6),
          Row(children: [
            SizedBox(width: 110, child: Row(children: [
              const Text("电量", style: TextStyle(fontSize: 11, color: Color(0xFF607D8B))),
              const SizedBox(width: 4),
              Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(3), child: LinearProgressIndicator(value: power / 100, minHeight: 8,
                color: power <= 20 ? Colors.red : (power <= 40 ? Colors.orange : Colors.green), backgroundColor: const Color(0xFFECEFF1)))),
              const SizedBox(width: 4),
              Text("${power.round()}%", style: const TextStyle(fontSize: 11)),
            ])),
            const SizedBox(width: 12),
            Text("速度 ${speed.toStringAsFixed(2)} m/s", style: const TextStyle(fontSize: 11, color: Color(0xFF607D8B))),
          ]),
          const SizedBox(height: 2),
          Text("当前点位 ${c["currentSite"] ?? "-"}${taskNo.isNotEmpty ? "　任务 $taskNo" : ""}",
            style: const TextStyle(fontSize: 11, color: Color(0xFF607D8B))),
          if (_canCtl) Padding(padding: const EdgeInsets.only(top: 6),
            child: Wrap(spacing: 6, runSpacing: 4, children: [
              for (final act in const ["charge", "standby", "reset", "stop", "start"])
                _ctrlBtn(c, act),
            ])),
        ]));
    }).toList());
  }

  // ---- 站台页签：出库到站=有货(需尽快扫码清台)，AGV正送/正取=占用中，其余空闲 ----
  Widget _stationList() {
    const all = ['05', '06', '07', '08', '09', '10', '11', '12'];
    final m = {for (final s in _stations) s["station"]?.toString(): s};
    if (_stations.isEmpty) {
      return const Padding(padding: EdgeInsets.all(24), child: Center(child: Text("站台状态未就绪：确认服务器已收到 RCS 配置（PDA设置→AGV调度系统→测试登录会自动同步），且与AGV系统同网段", style: TextStyle(color: Colors.blueGrey), textAlign: TextAlign.center)));
    }
    Color cOf(String st) => st == "有货" ? const Color(0xFFE65100) : (st == "占用中" ? const Color(0xFF1565C0) : Colors.green);
    IconData iOf(String st) => st == "有货" ? Icons.inventory_2 : (st == "占用中" ? Icons.local_shipping : Icons.check_circle_outline);
    return GridView.count(crossAxisCount: 2, childAspectRatio: 1.9, padding: const EdgeInsets.all(10), mainAxisSpacing: 8, crossAxisSpacing: 8,
      children: all.map((n) {
        final code = "NB02-CK-$n";
        final s = m[code];
        final st = s?["state"]?.toString() ?? "空闲";
        final c = cOf(st);
        return Container(padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: c.withOpacity(0.6), width: 1.2)),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [Icon(iOf(st), size: 16, color: c), const SizedBox(width: 4),
              Expanded(child: Text("CK-$n", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14))),
              Text(st, style: TextStyle(color: c, fontWeight: FontWeight.bold, fontSize: 13))]),
            const Spacer(),
            Text(st == "有货" ? "货位 ${s?["label"] ?? "-"}${(s?["goods"] ?? "").toString().isNotEmpty ? " · ${s?["goods"]}" : ""}" : (st == "占用中" ? "任务 ${s?["via"] ?? ""}" : "可正常叫车/入库"),
              maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 10.5, color: st == "空闲" ? Colors.blueGrey : c)),
            if (st == "有货" && (s?["since"] ?? "").toString().isNotEmpty) Row(children: [
              Expanded(child: Text("到站 ${AgvApi.fmtT(s!["since"])}", style: const TextStyle(fontSize: 10, color: Color(0xFF90A4AE)))),
              if (_canCtl) GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => _clearStation(code),
                child: const Padding(padding: EdgeInsets.fromLTRB(6, 2, 2, 2), child: Text("清台", style: TextStyle(fontSize: 11, color: Color(0xFF1565C0), fontWeight: FontWeight.bold)))),
            ]),
          ]));
      }).toList());
  }

  // ---- 交管页签 ----
  Widget _trafficView(Set<int> blocked) {
    final names = _carName;
    final lm = _traffic["landmarkLocks"];
    final owners = lm is Map && lm["landmarkOwners"] is Map ? Map.of(lm["landmarkOwners"] as Map) : <dynamic, dynamic>{};
    final zl = _traffic["zoneLocks"];
    final zones = zl is Map && zl["zoneList"] is List ? (zl["zoneList"] as List).whereType<Map>().toList() : <Map>[];
    Widget row(String k, String v) => Padding(padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(children: [SizedBox(width: 70, child: Text(k, style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))), Expanded(child: Text(v, style: const TextStyle(fontSize: 12)))]));
    String carOf(dynamic e) => e is Map ? (names[e["agvId"]] ?? "${e["agvId"]}") : "$e";
    return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
      if (_traffic.isEmpty) const Padding(padding: EdgeInsets.all(24), child: Center(child: Text("无交管数据", style: TextStyle(color: Colors.blueGrey)))),
      if (_traffic.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
        child: Text("交管区 ${zones.length} 个 · 被交管等待 ${blocked.length} 台 · 锁定点位 ${owners.length}", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      ...zones.map((z) {
        final lock = (z["lockCars"] is List ? z["lockCars"] as List : const []).map(carOf).join("、");
        final blk = (z["blockedCars"] is List ? z["blockedCars"] as List : const []).map(carOf).join("、");
        return Container(margin: const EdgeInsets.fromLTRB(10, 6, 10, 0), padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFE3E8F0))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text("${z["remarks"] ?? "交管区${z["zoneId"]}"}", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
              _tag("通行限${z["carNumber"] ?? 1}车", Colors.blueGrey),
            ]),
            row("点位", "${z["junctionLandmarkCodes"] ?? "-"}"),
            row("占行车辆", lock.isEmpty ? "—" : lock),
            row("等待车辆", blk.isEmpty ? "—" : blk),
          ]));
      }),
      if (owners.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(12, 12, 12, 0), child: Text("点位占用明细（${owners.length}）", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      if (owners.isNotEmpty) Container(margin: const EdgeInsets.fromLTRB(10, 6, 10, 0), padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFE3E8F0))),
        child: Wrap(spacing: 8, runSpacing: 4, children: owners.entries.map((e) => Text("${e.key}→${names[e.value] ?? "车${e.value}"}", style: const TextStyle(fontSize: 11, color: Color(0xFF455A64)))).toList())),
    ]);
  }

  // ---- 实时界面页签 ----
  Widget _portalView() {
    return Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const Icon(Icons.monitor, size: 56, color: Color(0xFF37474F)),
      const SizedBox(height: 10),
      const Text("哈工库讯 AGV 实时调度大屏", style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
      const SizedBox(height: 4),
      FutureBuilder<Map<String, String>>(future: AgvConfig.get(), builder: (_, s) => Text("门户 ${s.data?["portal"] ?? AgvConfig.defaultPortal} · 自动登录", style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))),
      const SizedBox(height: 16),
      ElevatedButton.icon(icon: const Icon(Icons.open_in_new), label: const Text("打开实时调度界面"), style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF1565C0), foregroundColor: Colors.white, padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 12)),
        onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const AgvWebViewPage()))),
      const SizedBox(height: 8),
      const Text("地图/任务/交管实时画面，含车辆定位", style: TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
    ]));
  }
}

// ===================== AGV实时调度界面（WebView，注入token自动登录） =====================
class AgvWebViewPage extends StatefulWidget {
  const AgvWebViewPage({super.key});
  @override State<AgvWebViewPage> createState() => _AgvWebViewPageState();
}

class _AgvWebViewPageState extends State<AgvWebViewPage> {
  late final WebViewController _ctrl;
  bool _loading = true, _injected = false;

  @override
  void initState() {
    super.initState();
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0B1220))
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) { if (mounted) setState(() => _loading = true); },
        onPageFinished: (_) async {
          if (!_injected) {
            _injected = true;
            final tk = await AgvApi.token();
            final cfg = await AgvConfig.get();
            if (tk != null && tk.isNotEmpty && mounted) {
              // 哈工库讯前端从 sessionStorage["v1@CacheToken"] 读token；注入后重载根路径即免登录直达大屏
              // （实测 nginx 未配 history 回退，/home-index 等子路径直访404，只能从根路径进）
              await _ctrl.runJavaScript("try{sessionStorage.setItem('v1@CacheToken',JSON.stringify({token:'$tk'}));}catch(e){}");
              await _ctrl.loadRequest(Uri.parse("http://${cfg["portal"]}/"));
              return;
            }
          }
          if (mounted) setState(() => _loading = false);
        },
      ));
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final cfg = await AgvConfig.get();
      await _ctrl.loadRequest(Uri.parse("http://${cfg["portal"]}/"));
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(title: const Text("AGV实时调度界面", style: TextStyle(color: Colors.white, fontSize: 16)),
        backgroundColor: const Color(0xFF101A2E), iconTheme: const IconThemeData(color: Colors.white),
        actions: [IconButton(tooltip: "重新加载并登录", icon: const Icon(Icons.refresh, color: Colors.white), onPressed: () { _injected = false; setState(() => _loading = true); _ctrl.reload(); })]),
      body: Stack(children: [
        WebViewWidget(controller: _ctrl),
        if (_loading) const Center(child: CircularProgressIndicator(color: Colors.cyan)),
      ]),
    );
  }
}

// ===================== AGV调度系统设置页 =====================
class AgvSettingPage extends StatefulWidget {
  const AgvSettingPage({super.key});
  @override State<AgvSettingPage> createState() => _AgvSettingPageState();
}

class _AgvSettingPageState extends State<AgvSettingPage> {
  final _hostCtrl = TextEditingController();
  final _portalCtrl = TextEditingController();
  final _accCtrl = TextEditingController();
  final _pwdCtrl = TextEditingController();
  String _msg = "";
  bool _ok = false, _busy = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final cfg = await AgvConfig.get();
      if (!mounted) return;
      setState(() {
        _hostCtrl.text = cfg["host"] ?? AgvConfig.defaultHost;
        _portalCtrl.text = cfg["portal"] ?? AgvConfig.defaultPortal;
        _accCtrl.text = cfg["account"] ?? "";
        _pwdCtrl.text = cfg["pwd"] ?? "";
      });
    });
  }

  @override
  void dispose() { _hostCtrl.dispose(); _portalCtrl.dispose(); _accCtrl.dispose(); _pwdCtrl.dispose(); super.dispose(); }

  Future<void> _save() async {
    if (_hostCtrl.text.trim().isEmpty || _portalCtrl.text.trim().isEmpty) { setState(() { _ok = false; _msg = "地址不能为空"; }); return; }
    await AgvConfig.save(host: _hostCtrl.text, portal: _portalCtrl.text, account: _accCtrl.text, pwd: _pwdCtrl.text);
    setState(() { _ok = true; _msg = "已保存"; });
  }

  Future<void> _test() async {
    setState(() { _busy = true; _msg = ""; });
    await AgvConfig.save(host: _hostCtrl.text, portal: _portalCtrl.text, account: _accCtrl.text, pwd: _pwdCtrl.text);
    final t = await AgvApi.login();
    if (t != null) {
      // 同步凭据到鉴权服务器：服务器60秒代轮询RCS → 到站催扫通知 + 站台占用面板
      final s = await AuthApi.rcsConfigSync(host: _hostCtrl.text.trim(), account: _accCtrl.text.trim(), pwd: _pwdCtrl.text);
      if (s["ok"] != true) debugPrint("[rcs] 配置同步失败：${s["msg"]}");
    }
    if (!mounted) return;
    setState(() { _busy = false; _ok = t != null; _msg = t == null ? "登录失败：检查地址/账号/密码（或AGV系统离线）" : "登录成功 ✅ token已缓存（12小时）${t != null ? "；服务器轮询已开启（催扫+站台面板）" : ""}"; });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(appBar: AppBar(title: const Text("AGV调度系统设置")), body: ListView(padding: const EdgeInsets.all(14), children: [
      const Text("调度API地址（登录与数据查询）", style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
      TextField(controller: _hostCtrl, keyboardType: TextInputType.url, decoration: const InputDecoration(hintText: "10.96.23.8:9091", border: OutlineInputBorder())),
      const SizedBox(height: 12),
      const Text("实时界面门户地址（WebView大屏）", style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
      TextField(controller: _portalCtrl, keyboardType: TextInputType.url, decoration: const InputDecoration(hintText: "10.96.23.8:8181", border: OutlineInputBorder())),
      const SizedBox(height: 12),
      const Text("账号 / 密码", style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
      TextField(controller: _accCtrl, decoration: const InputDecoration(hintText: "登录账号（如 root）", border: OutlineInputBorder())),
      const SizedBox(height: 8),
      TextField(controller: _pwdCtrl, obscureText: true, decoration: const InputDecoration(hintText: "登录密码", border: OutlineInputBorder())),
      const SizedBox(height: 14),
      Row(children: [
        Expanded(child: OutlinedButton(onPressed: _busy ? null : _save, child: const Text("保存"))),
        const SizedBox(width: 10),
        Expanded(child: ElevatedButton(onPressed: _busy ? null : _test, child: Text(_busy ? "登录中…" : "测试登录"))),
      ]),
      if (_msg.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_msg, style: TextStyle(color: _ok ? Colors.green : Colors.red, fontSize: 13))),
      const SizedBox(height: 10),
      const Text("说明：token 12小时有效，过期自动重登；验证码为系统万能码已内置。AGV模块展示任务/车辆/交管数据并提供实时大屏。", style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
    ]));
  }
}
