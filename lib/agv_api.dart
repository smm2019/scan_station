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

  static Future<void> save(
      {required String host,
      required String portal,
      required String account,
      required String pwd}) async {
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

  static String _uuid() =>
      DateTime.now().microsecondsSinceEpoch.toRadixString(16);

  static Future<Map<String, dynamic>?> _raw(
      String method, String path, String? body, String? token) async {
    final cfg = await AgvConfig.get();
    HttpClient? client;
    try {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
      final req =
          await client.openUrl(method, Uri.parse("http://${cfg["host"]}$path"));
      req.headers.set("Accept", "*/*");
      if (body != null) req.headers.contentType = ContentType.json;
      if (token != null) req.headers.set("token", token);
      if (body != null) req.write(body);
      final resp = await req.close().timeout(_timeout);
      final text = await resp.transform(utf8.decoder).join().timeout(_timeout);
      dynamic j;
      // RCS后端会把 Double.NaN 序列化成裸 NaN/Infinity（非法JSON），解析前先替换成null
      var cleaned = text;
      if (cleaned.contains("NaN") || cleaned.contains("Infinity")) {
        cleaned = cleaned
            .replaceAll(RegExp(r':\s*-?(?:NaN|Infinity)(?=[,}\]])'), ':null')
            .replaceAll(RegExp(r'\[\s*-?(?:NaN|Infinity)(?=[,\]])'), '[null');
      }
      try {
        j = jsonDecode(cleaned);
      } catch (_) {
        j = null;
      }
      return {
        "status": resp.statusCode,
        "json": j is Map<String, dynamic> ? j : null,
        "text": text
      };
    } catch (e) {
      return {"status": 0, "json": null, "text": "$e"};
    } finally {
      client?.close(force: true);
    }
  }

  /// 登录并缓存 token（12h 留 1h 余量）；失败返回 null
  static Future<String?> login() async {
    final cfg = await AgvConfig.get();
    if ((cfg["account"] ?? "").isEmpty || (cfg["pwd"] ?? "").isEmpty)
      return null;
    final r = await _raw(
        "POST",
        "/login",
        jsonEncode({
          "username": cfg["account"],
          "password": cfg["pwd"],
          "captcha": "12345",
          "uuid": _uuid()
        }),
        null);
    final j = r?["json"];
    if (j is Map && j["code"] == 0 && j["data"] is Map) {
      final t = (j["data"] as Map)["token"]?.toString() ?? "";
      if (t.isNotEmpty) {
        final sp = await SharedPreferences.getInstance();
        await sp.setString(AgvConfig.keyToken, t);
        await sp.setInt(AgvConfig.keyTokenExp,
            DateTime.now().millisecondsSinceEpoch + 11 * 3600 * 1000);
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
      if (m.contains("未登录") ||
          m.contains("登录已过期") ||
          m.contains("token") ||
          m.contains("Token")) return true;
    }
    return false;
  }

  /// AGV系统请求：自动带token，过期静默重登一次。返回 {ok,data} / {ok:false,msg}
  static Future<Map<String, dynamic>> req(String method, String path,
      {Map? body, String? rawBody}) async {
    var t = await token();
    if (t == null) return {"ok": false, "msg": "AGV系统未登录：请到 设置→AGV调度系统 填写账号密码"};
    final b = rawBody ?? (body == null ? null : jsonEncode(body));
    var r = await _raw(method, path, b, t);
    if (_authFail(r)) {
      t = await login();
      if (t == null) return {"ok": false, "msg": "AGV系统登录失效且自动重登失败"};
      r = await _raw(method, path, b, t);
    }
    if (r == null) return {"ok": false, "msg": "AGV系统无响应"};
    final j = r["json"];
    if (j is Map && j["code"] == 0) return {"ok": true, "data": j["data"]};
    final msg = (j is Map ? j["msg"]?.toString() : null) ??
        "HTTP ${r["status"]} ${r["text"]}";
    return {"ok": false, "msg": msg};
  }

  // ---------- 业务查询（全部只读，不下发任何控制指令） ----------
  static List<Map> _decodeList(dynamic data) {
    if (data is String) {
      try {
        data = jsonDecode(data);
      } catch (_) {
        return [];
      }
    }
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
      if (s != null) {
        m["currentSite"] = s["currentSite"];
        if (s["executeTaskNo"] != null) m["execTaskNo"] = s["executeTaskNo"];
      }
      out.add(m);
    }
    return out;
  }

  /// 交管锁资源：{landmarkLocks:{landmarkOwners:{点位:车},totalLocked}, zoneLocks:{zoneList:[{zoneId,remarks,carNumber,lockCars,blockedCars}]}}
  static Future<Map> traffic() async {
    final r = await req("GET", "/agv/debug/getLockResourceListForStatus");
    return r["ok"] == true && r["data"] is Map ? Map.of(r["data"] as Map) : {};
  }

  // ---------- 任务操作（写操作：与调度大屏同款按钮；detailId 0=取货 1=卸货） ----------
  static const taskOps = {
    "resetPick": {"label": "重置取货", "tip": "让该车重新执行取货动作", "danger": false},
    "resetPut": {"label": "重置卸货", "tip": "让该车重新执行卸货动作", "danger": false},
    "recoverPick": {
      "label": "恢复取货",
      "tip": "恢复已重置/异常的取货节点继续执行",
      "danger": false
    },
    "recoverPut": {
      "label": "恢复卸货",
      "tip": "恢复已重置/异常的卸货节点继续执行",
      "danger": false
    },
    "top": {"label": "置顶", "tip": "该任务插到调度队列最前，优先派车", "danger": false},
    "cancelTop": {"label": "取消置顶", "tip": "恢复该任务正常排队顺序", "danger": false},
    "delete": {"label": "删除任务", "tip": "删除该未执行任务，AGV 不会再执行它", "danger": true},
  };
  static Future<Map<String, dynamic>> taskAction(String op, String dispatchNo,
      {int detailId = 0}) async {
    if (dispatchNo.isEmpty) return {"ok": false, "msg": "缺少任务号"};
    final enc = Uri.encodeComponent(dispatchNo);
    switch (op) {
      case "resetPick":
        return req("GET", "/task/resetTask?dispatchNo=$enc&detailId=0");
      case "resetPut":
        return req("GET", "/task/resetTask?dispatchNo=$enc&detailId=1");
      case "recoverPick":
        return req("GET", "/task/recoverTask?dispatchNo=$enc&detailId=0");
      case "recoverPut":
        return req("GET", "/task/recoverTask?dispatchNo=$enc&detailId=1");
      case "top":
        return req("POST", "/task/taskToTop", rawBody: '"$dispatchNo"');
      case "cancelTop":
        return req("POST", "/task/taskToCancelTop", rawBody: '"$dispatchNo"');
      case "delete":
        return req("DELETE", "/task/deleteByDispatchNo",
            rawBody: '"$dispatchNo"');
      default:
        return {"ok": false, "msg": "未知操作"};
    }
  }

  /// 解除交管：强制释放指定点位的交管锁（车被死锁卡住时用）
  static Future<Map<String, dynamic>> unlockStation(String landmarkCode) async {
    if (landmarkCode.isEmpty) return {"ok": false, "msg": "缺点位号"};
    return req("GET",
        "/agv/debug/unlockStation?landmarkCode=${Uri.encodeComponent(landmarkCode)}");
  }

  // ---------- 车辆控制（写操作：参数=车辆IP，与调度系统大屏同款按钮） ----------
  /// action: charge充电 / standby待命 / reset清除任务 / stop急停 / start启动
  static const carActions = {
    "charge": {
      "path": "/agv/carToCharge",
      "label": "去充电",
      "tip": "给该车创建充电任务",
      "danger": false
    },
    "standby": {
      "path": "/agv/carToStandby",
      "label": "回待命",
      "tip": "给该车创建待命任务",
      "danger": false
    },
    "reset": {
      "path": "/agv/resetCar",
      "label": "清除任务",
      "tip": "清空该车当前任务（车会原地停下等待）",
      "danger": true
    },
    "stop": {
      "path": "/agv/stopAgv",
      "label": "急停",
      "tip": "立即停车，需人工或启动恢复",
      "danger": true
    },
    "start": {
      "path": "/agv/startAgv",
      "label": "启动",
      "tip": "恢复该车运行",
      "danger": false
    },
  };
  static Future<Map<String, dynamic>> carAction(
      String action, String ip) async {
    final a = carActions[action];
    if (a == null || ip.isEmpty) return {"ok": false, "msg": "参数错误"};
    return req("PUT", "${a["path"]}?ip=${Uri.encodeComponent(ip)}");
  }

  /// 站台状态（走自己的鉴权服务器：服务器60秒轮询RCS汇总，含"有货/占用中/空闲"）
  static Future<Map> stations() async {
    final r = await AuthApi.rcsStations();
    return r["ok"] == true ? r : {};
  }

  /// 容错取数值：RCS部分字段返回字符串（如"nan"、"99.5"），强转num会崩，统一走解析
  static double? asNum(dynamic v) {
    if (v is num) return v.toDouble();
    if (v is String) return double.tryParse(v);
    return null;
  }

  /// 站台任务时间线：建单(接到指令)→接令(车出发)→叉出/叉离→放架；每步发生即点亮，未发生不显示
  static String stationTimeline(Map? s) {
    final dir = s?["dir"]?.toString() ?? "out";
    final bd = asNum(s?["buildAt"]),
        st = asNum(s?["startAt"]),
        pk = asNum(s?["pickAt"]),
        pt = asNum(s?["putAt"]);
    final seg = <String>[];
    if (bd != null && bd > 0) seg.add("建单 ${fmtClock(bd)}");
    if (st != null && st > 0) seg.add("接令 ${fmtClock(st)}");
    if (pk != null && pk > 0)
      seg.add("${dir == "in" ? "叉离" : "叉出"} ${fmtClock(pk)}");
    if (pt != null && pt > 0) seg.add("放架 ${fmtClock(pt)}");
    return seg.join("·");
  }

  // ---------- 状态文案 ----------
  static const taskStateText = {
    -2: "已放弃",
    -1: "已挂起",
    0: "待执行",
    1: "执行中",
    2: "已完成",
    5: "已超时",
    6: "已清除"
  };
  static String taskStateOf(dynamic s) {
    final v = s is int ? s : int.tryParse("$s") ?? 99;
    return taskStateText[v] ?? "状态$v";
  }

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
      case "idle":
        return "空闲";
      case "running":
        return "执行中";
      case "pause":
        return "暂停";
      case "error":
        return "错误";
      default:
        return c["carState"]?.toString() ?? "未知";
    }
  }

  /// 被交管等待的车 agvId 集合（任一交管区 blockedCars）
  static Set<int> blockedIds(Map traffic) {
    final out = <int>{};
    final zl = traffic["zoneLocks"];
    if (zl is Map && zl["zoneList"] is List) {
      for (final z in (zl["zoneList"] as List).whereType<Map>()) {
        final arr =
            z["blockedCars"] is List ? z["blockedCars"] as List : const [];
        for (final e in arr) {
          if (e is Map && e["agvId"] is int)
            out.add(e["agvId"] as int);
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
    try {
      final m = jsonDecode(s);
      return m is Map ? m : {};
    } catch (_) {
      return {};
    }
  }

  /// yyyyMMddHHmmss → MM-dd HH:mm
  static String fmtT(dynamic s) {
    final v = "$s";
    if (v.length >= 12)
      return "${v.substring(4, 6)}-${v.substring(6, 8)} ${v.substring(8, 10)}:${v.substring(10, 12)}";
    return v.isEmpty ? "-" : v;
  }

  /// epoch毫秒 → HH:mm
  static String fmtClock(double ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms.toInt());
    return "${d.hour.toString().padLeft(2, "0")}:${d.minute.toString().padLeft(2, "0")}";
  }

  /// RCS时间戳 "20261006162951" → epoch毫秒（无效返回0）
  static double rcsTs(String s) {
    if (s.length < 14) return 0;
    return DateTime(
            int.parse(s.substring(0, 4)),
            int.parse(s.substring(4, 6)),
            int.parse(s.substring(6, 8)),
            int.parse(s.substring(8, 10)),
            int.parse(s.substring(10, 12)),
            int.parse(s.substring(12, 14)))
        .millisecondsSinceEpoch
        .toDouble();
  }

  /// 任务节点时间 [叉出起点时刻, 到达终点时刻]（epoch毫秒，0=该节点未完成/无数据）
  static List<double> nodeTimesOf(Map t) {
    double pick = 0, put = 0;
    for (final d in (t["taskDetailList"] as List? ?? const [])) {
      if (d is! Map) continue;
      if (num.tryParse(d["state"].toString())?.toInt() != 2)
        continue; // 只认已完成节点
      final ms = rcsTs(d["finishTime"]?.toString() ?? "");
      if (ms == 0) continue;
      final op = num.tryParse(d["operType"].toString())?.toInt() ?? -1;
      if (op == 0)
        pick = ms;
      else if (op == 1) put = ms;
    }
    return [pick, put];
  }

  /// 任务时间线：建单→接令→叉出→放架；未放架时按进度标注 排队中/取货中/送货中
  static String taskTimeline(Map t) {
    final bd = rcsTs(t["buildTime"]?.toString() ?? ""),
        ex = rcsTs(t["exeTime"]?.toString() ?? "");
    final nt = nodeTimesOf(t);
    final seg = <String>[];
    if (bd > 0) seg.add("建单 ${fmtClock(bd)}");
    if (ex > 0) seg.add("接令 ${fmtClock(ex)}");
    if (nt[0] > 0) seg.add("叉出 ${fmtClock(nt[0])}");
    if (nt[1] > 0)
      seg.add("放架 ${fmtClock(nt[1])}");
    else if (ex > 0)
      seg.add(nt[0] > 0 ? "送货中" : "取货中");
    else if (bd > 0) seg.add("排队中");
    return seg.join(" · ");
  }
}

// ===================== AGV模块主页面：任务 / 车辆 / 交管 / 实时界面 =====================
class AgvMonitorPage extends StatefulWidget {
  const AgvMonitorPage({super.key});
  @override
  State<AgvMonitorPage> createState() => _AgvMonitorPageState();
}

class _AgvMonitorPageState extends State<AgvMonitorPage>
    with AutomaticKeepAliveClientMixin {
  List<Map> _tasks = [], _done = [], _cars = [];
  Map _traffic = {};
  Map<String, String> _cargo = {}; // 任务起点货位 → 账本反查的货物描述（零件号×数量）
  List<Map> _stations = []; // 站台状态（服务器轮询RCS：有货/占用中/空闲）
  bool _stationsOn = false; // 服务器RCS轮询已开启（on标志）：列表为空但on=true=全空闲，不是未就绪
  Map<String, int> _holdAvg = {}; // 站台历史平均占用分钟数（释放预测）
  List<Map> _transfer = []; // 移库任务（服务器队列中 type=transfer 项）
  bool _loading = false, _showDone = false, _loaded = false;
  String _err = "";
  Timer? _timer;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
    _timer = Timer.periodic(const Duration(seconds: 15), (_) {
      if (mounted) _load(silent: true);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _load({bool silent = false}) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      if (!silent) _err = "";
    });
    final tk = await AgvApi.token();
    if (tk == null) {
      if (mounted)
        setState(() {
          _loading = false;
          _err = "未登录：请到 设置 → AGV调度系统 填写账号密码";
        });
      return;
    }
    try {
      final rs = await Future.wait([
        AgvApi.tasksRunning(),
        AgvApi.cars(),
        AgvApi.traffic(),
        AgvApi.tasksDone(),
        AuthApi.rcsStations()
      ]);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _loaded = true;
        _tasks = rs[0] as List<Map>;
        _cars = rs[1] as List<Map>;
        _traffic = rs[2] as Map;
        _done = rs[3] as List<Map>;
        final st = rs[4];
        _stations = st is Map && st["stations"] is List
            ? List<Map>.from(st["stations"] as List)
            : [];
        _stationsOn = st is Map && st["on"] == true;
        if (st is Map && st["holdAvg"] is Map)
          _holdAvg = (st["holdAvg"] as Map)
              .map((k, v) => MapEntry(k.toString(), (v as num).toInt()));
        _transfer = st is Map && st["queue"] is List
            ? (st["queue"] as List).whereType<Map>().where((q) => q["type"] == "transfer").toList()
            : [];
        _err = "";
      });
      unawaited(_buildCargo());
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _err = "AGV数据加载异常：$e";
      });
    }
  }

  /// 反查货物：AGV 只知"搬托盘"，货由任务起点货位回查本机货位账本得到（零件号/数量/标签）
  Future<void> _buildCargo() async {
    try {
      final locs = <String>{
        for (final t in [..._tasks, ..._done.take(10)])
          if ((AgvApi.taskRoute(t)["startPoint"] ?? "").toString().isNotEmpty)
            AgvApi.taskRoute(t)["startPoint"].toString().toUpperCase()
      };
      if (locs.isEmpty) return;
      final placements = await _globalIsar.shelfPlacements.where().findAll();
      final infos = {
        for (final e in await _globalIsar.labelInfos.where().findAll())
          e.goodsCode: e
      };
      final byLoc = <String, List<String>>{};
      for (final p in placements) {
        final k = p.loc.toUpperCase();
        if (locs.contains(k))
          byLoc.putIfAbsent(k, () => []).add(p.goodsCode.toUpperCase());
      }
      final out = <String, String>{};
      for (final l in locs) {
        final codes = byLoc[l];
        if (codes == null || codes.isEmpty) {
          out[l] = "账本无此位货物";
          continue;
        }
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
        parts.add(partTxt.isNotEmpty
            ? "$partTxt·${_fmtInvNum(sum.roundToDouble())}件"
            : "未补齐物料");
        out[l] = "${parts.join(" / ")}（标签 ${codes.join("/")}）";
      }
      if (!mounted) return;
      setState(() => _cargo = out);
    } catch (e) {
      debugPrint("[agv] 货物反查失败：$e");
    }
  }

  Map<int, String> get _carName => {
        for (final c in _cars)
          if (c["agvId"] is int)
            c["agvId"] as int: (c["carName"]?.toString() ?? "AGV${c["agvId"]}")
      };

  bool get _canCtl => Auth.can("agv_control"); // 车辆控制/清台：按角色功能开关（设置里可在线调整）
  void _toast(String s) {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(s), duration: const Duration(seconds: 3)));
  }

  /// 车辆控制：确认弹窗（危险操作红色警示）→ 下发 → 提示结果并刷新
  Future<void> _ctrlCar(Map c, String action) async {
    final a = AgvApi.carActions[action];
    if (a == null) return;
    final ip = (c["carIp"] ?? "").toString();
    if (ip.isEmpty) {
      _toast("该车没有IP信息，无法控制");
      return;
    }
    final danger = a["danger"] == true;
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: Text(danger ? "⚠️ ${a["label"]}" : "${a["label"]}",
                  style: TextStyle(color: danger ? Colors.red : null)),
              content: Text(
                  "对 ${c["carName"] ?? ip}（$ip）下发「${a["label"]}」？\n${a["tip"]}\n\n注意：这是对真实车辆的指令，请确认现场安全。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    style: danger
                        ? FilledButton.styleFrom(backgroundColor: Colors.red)
                        : null,
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认下发"))
              ],
            ));
    if (ok != true || !mounted) return;
    final r = await AgvApi.carAction(action, ip);
    _toast(r["ok"] == true
        ? "✅ ${a["label"]}：指令已下发"
        : "❌ ${a["label"]}失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  /// 任务操作：确认弹窗（删除红色警示）→ 下发 → 提示并刷新
  Future<void> _taskAct(Map t, String op) async {
    final a = AgvApi.taskOps[op];
    if (a == null) return;
    final no = "${t["dispatchNo"] ?? ""}";
    final danger = a["danger"] == true;
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: Text(danger ? "⚠️ ${a["label"]}" : "${a["label"]}",
                  style: TextStyle(color: danger ? Colors.red : null)),
              content: Text(
                  "对任务 $no 执行「${a["label"]}」？\n${a["tip"]}\n\n注意：这会改变真实 AGV 调度。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    style: danger
                        ? FilledButton.styleFrom(backgroundColor: Colors.red)
                        : null,
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认"))
              ],
            ));
    if (ok != true || !mounted) return;
    final r = await AgvApi.taskAction(op, no);
    _toast(r["ok"] == true
        ? "✅ ${a["label"]}：已执行"
        : "❌ ${a["label"]}失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  Widget _taskOpBtn(Map t, String op) {
    final a = AgvApi.taskOps[op]!, danger = a["danger"] == true;
    final color = danger ? Colors.red : const Color(0xFF1565C0);
    return ActionChip(
        avatar: Icon(danger ? Icons.delete_outline : Icons.tune,
            size: 14, color: color),
        label: Text(a["label"].toString(),
            style: TextStyle(
                fontSize: 10.5, color: color, fontWeight: FontWeight.w600)),
        visualDensity: VisualDensity.compact,
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        onPressed: () => _taskAct(t, op));
  }

  Widget _ctrlBtn(Map c, String act) {
    final a = AgvApi.carActions[act]!, danger = a["danger"] == true;
    final color = danger
        ? Colors.red
        : (act == "charge" ? Colors.teal : const Color(0xFF1565C0));
    return ActionChip(
        avatar: Icon(
            danger
                ? Icons.dangerous_outlined
                : (act == "charge"
                    ? Icons.bolt
                    : (act == "start"
                        ? Icons.play_arrow
                        : (act == "stop"
                            ? Icons.stop_circle_outlined
                            : Icons.home_outlined))),
            size: 15,
            color: color),
        label: Text(a["label"].toString(),
            style: TextStyle(
                fontSize: 11, color: color, fontWeight: FontWeight.w600)),
        visualDensity: VisualDensity.compact,
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        onPressed: () => _ctrlCar(c, act));
  }

  /// 人工清台：现场已取走但系统未识别（如人工直接搬走）时，仓管确认后即刻转空闲
  Future<void> _clearStation(String code) async {
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("人工清台"),
              content: Text("确认站台 $code 上的货已被取走？\n确认后站台立即转为空闲（不影响AGV与领料单数据）。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认清台"))
              ],
            ));
    if (ok != true || !mounted) return;
    final r = await AuthApi.rcsClear(code);
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ 清台失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  /// 人工标记占用：现场有货/有托盘停在台上但系统显示空闲时，防止别人再叫车撞台
  Future<void> _markBusy(String code) async {
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("标记占用"),
              content: Text(
                  "确认站台 $code 现场已有货/被占用？\n标记后 30 分钟内叫车选台会显示为不可用（超时后系统状态自动接管）。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认占用"))
              ],
            ));
    if (ok != true || !mounted) return;
    final r = await AuthApi.rcsClear(code, state: "有货");
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ 标记失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final blocked = AgvApi.blockedIds(_traffic);
    final online = _cars
        .where((c) => c["communicationBreak"] != true && c["enable"] == 1)
        .length;
    final running = _cars.where((c) => c["carState"] == "running").length;
    final idle = _cars.where((c) => c["carState"] == "idle").length;
    return Column(children: [
      // 顶部统计条（对齐调度大屏口径）
      Container(
          color: const Color(0xFF102A43),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Row(children: [
            _statChip(Icons.wifi, "$online/${_cars.length}在线", Colors.green),
            _statChip(Icons.play_circle, "$running执行中", Colors.lightBlueAccent),
            _statChip(Icons.pause_circle, "$idle空闲", Colors.teal),
            _statChip(Icons.block, "${blocked.length}被交管",
                blocked.isEmpty ? Colors.blueGrey : Colors.orangeAccent),
            const Spacer(),
            if (_loading)
              const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Colors.cyan)),
            IconButton(
                tooltip: "货架移库（AGV整架搬位）",
                icon: const Icon(Icons.swap_horiz,
                    color: Colors.cyanAccent, size: 22),
                onPressed: _showTransfer),
            IconButton(
                icon:
                    const Icon(Icons.refresh, color: Colors.white70, size: 20),
                onPressed: _loading ? null : () => _load()),
          ])),
      if (_err.isNotEmpty)
        Container(
            width: double.infinity,
            color: const Color(0xFFFFF3E0),
            padding: const EdgeInsets.all(8),
            child: Text(_err,
                style:
                    const TextStyle(fontSize: 12, color: Color(0xFFE65100)))),
      Expanded(
          child: !_loaded && _err.isEmpty
              ? const Center(child: CircularProgressIndicator())
              : DefaultTabController(
                  length: 5,
                  child: Column(children: [
                    const TabBar(
                        labelColor: Color(0xFF1565C0),
                        unselectedLabelColor: Color(0xFF90A4AE),
                        indicatorColor: Colors.cyan,
                        tabs: [
                          Tab(text: "任务"),
                          Tab(text: "车辆"),
                          Tab(text: "站台"),
                          Tab(text: "交管"),
                          Tab(text: "实时界面")
                        ]),
                    Expanded(
                        child: TabBarView(
                            physics:
                                const NeverScrollableScrollPhysics(), // 内层只点不滑，横滑留给外层换模块
                            children: [
                          _taskList(),
                          _carList(blocked),
                          _stationList(),
                          _trafficView(blocked),
                          _portalView(),
                        ])),
                  ]))),
    ]);
  }

  Widget _statChip(IconData ic, String txt, Color color) => Padding(
      padding: const EdgeInsets.only(right: 10),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(ic, size: 14, color: color),
        const SizedBox(width: 3),
        Text(txt,
            style: TextStyle(
                fontSize: 12, color: color, fontWeight: FontWeight.bold))
      ]));

  Widget _tag(String txt, Color color) => Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
      decoration: BoxDecoration(
          color: color.withOpacity(0.12),
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: color.withOpacity(0.5))),
      child: Text(txt,
          style: TextStyle(
              fontSize: 11, color: color, fontWeight: FontWeight.w600)));

  // ---- 任务页签 ----
  Widget _taskList() {
    final names = _carName;
    Widget card(Map t, {bool done = false}) {
      final rt = AgvApi.taskRoute(t);
      final st = t["taskState"];
      final no = "${t["dispatchNo"] ?? ""}";
      final sp = (rt["startPoint"] ?? "").toString().toUpperCase();
      final cargo = _cargo[sp];
      final isCharge = rt["taskType"]?.toString() == "CHARGE" ||
          "${t["taskType"] ?? ""}" == "CHARGE";
      return Container(
          margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFE3E8F0)),
              boxShadow: const [
                BoxShadow(
                    color: Color(0x14000000),
                    blurRadius: 4,
                    offset: Offset(0, 1))
              ]),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                  child: Text(no,
                      style: const TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 13))),
              Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                      color: AgvApi.taskStateColor(st),
                      borderRadius: BorderRadius.circular(10)),
                  child: Text(AgvApi.taskStateOf(st),
                      style:
                          const TextStyle(color: Colors.white, fontSize: 11))),
            ]),
            const SizedBox(height: 6),
            Text("${rt["startPoint"] ?? "?"}  →  ${rt["endPoint"] ?? "?"}",
                style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF1565C0))),
            const SizedBox(height: 4),
            Text(
                "车：${names[t["exeAgvId"]] ?? (t["exeAgvId"] == null ? "未分配" : "AGV${t["exeAgvId"]}")}　托盘：${rt["palletType"] ?? t["palletType"] ?? "-"}　类型：${rt["taskType"] ?? t["taskType"] ?? "-"}",
                style: const TextStyle(fontSize: 11, color: Color(0xFF607D8B))),
            // 货物：AGV系统只知搬托盘，零件号/数量按起点货位反查本机货位账本（充电任务无货）
            if (isCharge)
              Text("货物：—（充电任务）",
                  style: const TextStyle(
                      fontSize: 11,
                      color: Color(0xFF26A69A),
                      fontWeight: FontWeight.w600))
            else if (cargo != null)
              Text("货物：$cargo",
                  style: const TextStyle(
                      fontSize: 11,
                      color: Color(0xFF26A69A),
                      fontWeight: FontWeight.w600))
            else if (sp.isEmpty)
              const Text("货物：—",
                  style: TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))
            else
              Text("货物：起点 $sp 未入账本/账本未同步，无法反查",
                  style:
                      const TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
            Text(
                "创建 ${AgvApi.fmtT(t["buildTime"])}　执行 ${AgvApi.fmtT(t["exeTime"])}${done && t["finishTime"] != null ? "　完成 ${AgvApi.fmtT(t["finishTime"])}" : ""}",
                style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
            if (!done && AgvApi.taskTimeline(t).isNotEmpty)
              Padding(
                  padding: const EdgeInsets.only(top: 3),
                  child: Text("⏱ ${AgvApi.taskTimeline(t)}",
                      style: const TextStyle(
                          fontSize: 11,
                          color: Color(0xFF1565C0),
                          fontWeight: FontWeight.w600))),
            // 任务操作按钮（与调度大屏同款；仅 agv_control 权限可见；置顶/删除仅待执行，执行中删除会车停半路）
            if (_canCtl && !isCharge)
              Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Wrap(
                      spacing: 5,
                      runSpacing: 3,
                      children: done
                          ? [
                              _taskOpBtn(t, "recoverPick"),
                              _taskOpBtn(t, "recoverPut")
                            ]
                          : [
                              if (st == 0) _taskOpBtn(t, "top"),
                              if (st == 0) _taskOpBtn(t, "delete"),
                              _taskOpBtn(t, "resetPick"),
                              _taskOpBtn(t, "resetPut")
                            ])),
          ]));
    }

    final act = _tasks
        .where((t) => (t["taskState"] == 0 || t["taskState"] == 1))
        .toList();
    return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
      if (_transfer.isNotEmpty) ...[
        Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: Text("移库任务（${_transfer.length}）", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.deepOrange))),
        ..._transfer.map((q) => Padding(padding: const EdgeInsets.fromLTRB(12, 4, 12, 0), child: Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: Colors.deepOrange.shade50, borderRadius: BorderRadius.circular(8), border: Border.all(color: Colors.deepOrange.shade200)), child: Row(children: [
          const Icon(Icons.swap_horiz, size: 18, color: Colors.deepOrange),
          const SizedBox(width: 8),
          Expanded(child: Text("${(q["from"] ?? "?")} → ${(q["to"] ?? "?")}${(q["code"] ?? "").toString().isNotEmpty ? "  ${q["code"]}" : ""}", style: const TextStyle(fontSize: 13, fontFamily: "monospace", fontWeight: FontWeight.w600))),
          Text("${q["state"] ?? ""}", style: const TextStyle(fontSize: 12, color: Colors.deepOrange, fontWeight: FontWeight.bold)),
          if (q["state"] == "已下发" || q["state"] == "排队") IconButton(icon: const Icon(Icons.close, size: 18, color: Colors.red), onPressed: () => _cancelTransfer(q)),
        ])))),
      ],
      Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
          child: Text("进行中任务（${act.length}）",
              style:
                  const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      if (act.isEmpty)
        const Padding(
            padding: EdgeInsets.all(24),
            child: Center(
                child: Text("当前没有进行中任务",
                    style: TextStyle(color: Colors.blueGrey)))),
      ...act.map((t) => card(t)),
      Padding(
          padding: const EdgeInsets.fromLTRB(12, 14, 12, 0),
          child: Text("最近历史（${_done.length}）",
              style:
                  const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      TextButton(
          onPressed: () => setState(() => _showDone = !_showDone),
          child: Text(_showDone ? "收起" : "展开最近10条")),
      if (_showDone) ..._done.take(10).map((t) => card(t, done: true)),
    ]);
  }

  // ---- 车辆页签（字段对齐调度大屏：连接/车辆/驾驶/执行状态+坐标+锁定资源+告警） ----
  Widget _carList(Set<int> blocked) {
    if (_cars.isEmpty)
      return const Center(
          child:
              Text("无车辆数据（检查登录/网络）", style: TextStyle(color: Colors.blueGrey)));
    return ListView(
        padding: const EdgeInsets.only(bottom: 16),
        children: _cars.map((c) {
          final id = c["agvId"];
          final online = c["communicationBreak"] != true && c["enable"] == 1;
          final power = AgvApi.asNum(c["power"]) ?? 0;
          final speed = AgvApi.asNum(c["speed"]) ?? 0;
          final taskNo =
              (c["execTaskNo"] ?? c["executeTaskNo"])?.toString() ?? "";
          final x = AgvApi.asNum(c["x"]), y = AgvApi.asNum(c["y"]);
          final lockLands = (c["routeLockLands"] as List?)?.join(", ") ?? "";
          final err = (c["errorMessage"] ?? "").toString();
          // 执行状态：急停/人工停止 > 充电 > 执行任务 > 空闲
          String exe;
          if (c["emergencyButton"] == true)
            exe = "急停中";
          else if (c["manualStop"] == true)
            exe = "人工停止";
          else if (c["charging"] == true)
            exe = c["fullCharged"] == true ? "充电完成" : "充电中";
          else if (taskNo.isNotEmpty)
            exe = "执行 $taskNo";
          else
            exe = "无任务";
          Color exeColor = exe == "急停中" || exe == "人工停止"
              ? Colors.red
              : (exe.contains("充电")
                  ? Colors.teal
                  : (exe.contains("执行") ? Colors.lightBlue : Colors.blueGrey));
          Widget kv(String k, String v, [Color? vc]) => Expanded(
              child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 1),
                  child: RichText(
                      text: TextSpan(
                          style: const TextStyle(fontSize: 11),
                          children: [
                        TextSpan(
                            text: "$k  ",
                            style: const TextStyle(color: Color(0xFF90A4AE))),
                        TextSpan(
                            text: v,
                            style: TextStyle(
                                color: vc ?? const Color(0xFF263238),
                                fontWeight: FontWeight.w600))
                      ]))));
          return Container(
              margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: const Color(0xFFE3E8F0))),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Text("${c["carName"] ?? "AGV$id"}",
                          style: const TextStyle(
                              fontWeight: FontWeight.bold, fontSize: 14)),
                      const SizedBox(width: 6),
                      Text("${c["carIp"] ?? ""}",
                          style: const TextStyle(
                              fontSize: 11, color: Color(0xFF90A4AE))),
                      const Spacer(),
                      if (blocked.contains(id)) _tag("被交管", Colors.deepOrange),
                      if (c["lock"] == true) _tag("已锁定", Colors.red),
                      _tag(online ? "在线" : "离线",
                          online ? Colors.green : Colors.grey),
                      _tag(
                          AgvApi.carStateOf(c),
                          online
                              ? (c["carState"] == "running"
                                  ? Colors.lightBlue
                                  : Colors.teal)
                              : Colors.grey),
                    ]),
                    const SizedBox(height: 4),
                    Row(children: [
                      kv("驾驶", c["autoMode"] == true ? "自动" : "手动"),
                      kv("车型", "${c["carModel"] ?? "-"}"),
                      kv("货叉高",
                          "${(AgvApi.asNum(c["forkHeight"]) ?? 0).toStringAsFixed(2)}m"),
                    ]),
                    Row(children: [
                      kv("执行", exe, exeColor),
                      kv("速度", "${speed.toStringAsFixed(2)} m/s"),
                      kv("区域", "R${c["ownRegionId"] ?? "-"}"),
                    ]),
                    const SizedBox(height: 4),
                    Row(children: [
                      const Text("电量",
                          style: TextStyle(
                              fontSize: 11, color: Color(0xFF607D8B))),
                      const SizedBox(width: 4),
                      Expanded(
                          child: ClipRRect(
                              borderRadius: BorderRadius.circular(3),
                              child: LinearProgressIndicator(
                                  value: power / 100,
                                  minHeight: 8,
                                  color: power <= 20
                                      ? Colors.red
                                      : (power <= 40
                                          ? Colors.orange
                                          : Colors.green),
                                  backgroundColor: const Color(0xFFECEFF1)))),
                      const SizedBox(width: 4),
                      Text("${power.round()}%",
                          style: const TextStyle(fontSize: 11)),
                    ]),
                    const SizedBox(height: 2),
                    Text(
                        "当前地标 ${c["currentSite"] ?? "-"}${x != null && y != null ? "（${x.toStringAsFixed(1)}, ${y.toStringAsFixed(1)}）" : ""}",
                        style: const TextStyle(
                            fontSize: 11, color: Color(0xFF607D8B))),
                    if (lockLands.isNotEmpty)
                      Text("锁定资源集：$lockLands",
                          style: const TextStyle(
                              fontSize: 11, color: Color(0xFF607D8B))),
                    Builder(builder: (_) {
                      final warns = <String>[
                        if (c["communicationBreak"] == true) "通讯断开",
                        if (c["emergencyButton"] == true) "急停按下",
                        if (c["manualStop"] == true) "人工停止",
                        if (c["lowPower"] == true) "低电量",
                        if (c["lock"] == true) "已锁定",
                        if (err.isNotEmpty) err,
                      ];
                      if (warns.isEmpty) return const SizedBox.shrink();
                      return Container(
                          margin: const EdgeInsets.only(top: 4),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 3),
                          decoration: BoxDecoration(
                              color: Colors.red.shade50,
                              borderRadius: BorderRadius.circular(4),
                              border: Border.all(color: Colors.red.shade200)),
                          child: Text("⚠ ${warns.join(" · ")}",
                              style: const TextStyle(
                                  fontSize: 11,
                                  color: Colors.red,
                                  fontWeight: FontWeight.w600)));
                    }),
                    if (_canCtl)
                      Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Wrap(spacing: 6, runSpacing: 4, children: [
                            for (final act in const [
                              "charge",
                              "standby",
                              "reset",
                              "stop",
                              "start"
                            ])
                              _ctrlBtn(c, act),
                          ])),
                  ]));
        }).toList());
  }

  // ---- 站台页签：出库到站=有货(需尽快扫码清台)，AGV正送/正取=占用中，其余空闲 ----
  Widget _stationList() {
    const all = ['05', '06', '07', '08', '09', '10', '11', '12'];
    final m = {for (final s in _stations) s["station"]?.toString(): s};
    if (_stations.isEmpty && !_stationsOn) {
      return const Padding(
          padding: EdgeInsets.all(24),
          child: Center(
              child: Text(
                  "站台状态未就绪：确认服务器已收到 RCS 配置（PDA设置→AGV调度系统→测试登录会自动同步），且与AGV系统同网段",
                  style: TextStyle(color: Colors.blueGrey),
                  textAlign: TextAlign.center)));
    }
    Color cOf(String st) => st == "有货"
        ? const Color(0xFFE65100)
        : (st == "占用中" ? const Color(0xFF1565C0) : Colors.green);
    IconData iOf(String st) => st == "有货"
        ? Icons.inventory_2
        : (st == "占用中" ? Icons.local_shipping : Icons.check_circle_outline);
    return GridView.count(
        crossAxisCount: 2,
        childAspectRatio: 1.32,
        padding: const EdgeInsets.all(10),
        mainAxisSpacing: 8,
        crossAxisSpacing: 8,
        children: all.map((n) {
          final code = "NB02-CK-$n";
          final s = m[code];
          final st = s?["state"]?.toString() ?? "空闲";
          final c = cOf(st);
          final tl = AgvApi.stationTimeline(s);
          return Container(
              padding: const EdgeInsets.all(9),
              decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: c.withOpacity(0.6), width: 1.2)),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Icon(iOf(st), size: 15, color: c),
                      const SizedBox(width: 4),
                      Expanded(
                          child: Text("CK-$n",
                              style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  fontSize: 13.5))),
                      Text(st,
                          style: TextStyle(
                              color: c,
                              fontWeight: FontWeight.bold,
                              fontSize: 12.5))
                    ]),
                    const SizedBox(height: 3),
                    Text(
                        st == "有货"
                            ? "货位 ${s?["label"] ?? "-"}${(s?["goods"] ?? "").toString().isNotEmpty ? " · ${s?["goods"]}" : ""}"
                            : (st == "占用中"
                                ? "${s?["dir"] == "in" ? "入库取走中" : "出库在途"} ${s?["via"] ?? ""}"
                                : "可正常叫车/入库"),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 10.5,
                            height: 1.25,
                            color: st == "空闲" ? Colors.blueGrey : c)),
                    // 时间线：每步发生即点亮（建单→接令→叉出/叉离→放架；有货末尾追加到站）
                    if (tl.isNotEmpty)
                      Expanded(
                          child: Padding(
                              padding: const EdgeInsets.only(top: 2),
                              child: Text(
                                  tl +
                                      (st == "有货"
                                          ? "·到站 ${AgvApi.fmtT(s!["since"])}${(_holdAvg[code] ?? 0) > 0 ? "\n预计约 ${_holdAvg[code]} 分钟清台（历史均值）" : ""}"
                                          : (st == "占用中" &&
                                                  (AgvApi.asNum(s?["putAt"]) ??
                                                          0) ==
                                                      0
                                              ? "·进行中"
                                              : "")),
                                  maxLines: 3,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      fontSize: 9.5,
                                      height: 1.35,
                                      color: st == "有货"
                                          ? const Color(0xFF90A4AE)
                                          : c)))),
                    if (st == "有货" && _canCtl)
                      Align(
                          alignment: Alignment.centerRight,
                          child: GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTap: () => _clearStation(code),
                              child: const Padding(
                                  padding: EdgeInsets.fromLTRB(6, 2, 2, 2),
                                  child: Text("清台",
                                      style: TextStyle(
                                          fontSize: 11.5,
                                          color: Color(0xFF1565C0),
                                          fontWeight: FontWeight.bold))))),
                    if (st == "空闲" && _canCtl) ...[
                      const Spacer(),
                      Align(
                          alignment: Alignment.centerRight,
                          child: GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTap: () => _markBusy(code),
                              child: const Padding(
                                  padding: EdgeInsets.fromLTRB(6, 2, 2, 2),
                                  child: Text("标记占用",
                                      style: TextStyle(
                                          fontSize: 10.5,
                                          color: Color(0xFFE65100),
                                          fontWeight: FontWeight.bold))))),
                    ],
                  ]));
        }).toList());
  }

  // ---- 交管页签：车辆级实时堵点（对齐调度大屏口径）+ 解除交管 ----
  Widget _trafficView(Set<int> blocked) {
    final names = _carName;
    final lm = _traffic["landmarkLocks"];
    final owners = lm is Map && lm["landmarkOwners"] is Map
        ? Map.of(lm["landmarkOwners"] as Map)
        : <dynamic, dynamic>{};
    final zl = _traffic["zoneLocks"];
    final zones = zl is Map && zl["zoneList"] is List
        ? (zl["zoneList"] as List).whereType<Map>().toList()
        : <Map>[];
    Widget row(String k, String v) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          SizedBox(
              width: 84,
              child: Text(k,
                  style:
                      const TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))),
          Expanded(child: Text(v, style: const TextStyle(fontSize: 12)))
        ]));
    // 被拦停车辆：交管等待集合 ∪ 车辆 pause/lock 状态（zoneList的lockCars实测常年为空，不可用）
    final jam = _cars
        .where((c) =>
            blocked.contains(c["agvId"]) ||
            c["carState"] == "pause" ||
            c["lock"] == true)
        .toList();
    String zoneOf(String land) {
      for (final z in zones) {
        if (z["junctionLandmarkCodes"].toString().split(",").contains(land)) {
          final rm = z["remarks"]?.toString() ?? "";
          return rm.isNotEmpty ? rm : "交管区${z["zoneId"]}";
        }
      }
      return "非交管区";
    }

    String carNameOf(dynamic cid) {
      final i = cid is int ? cid : int.tryParse("$cid");
      return names[i] ?? "AGV${(i ?? 0).toString().padLeft(2, "0")}";
    }

    final myId = jam.map((c) => "${c["agvId"]}").toSet();
    return ListView(padding: const EdgeInsets.only(bottom: 16), children: [
      Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
          child: Text(
              "被拦停 ${jam.length} 台 · 锁定点位 ${owners.length} · 交管区 ${zones.length} 个",
              style: TextStyle(
                  fontWeight: FontWeight.bold,
                  fontSize: 13,
                  color: jam.isEmpty ? Colors.green : Colors.red.shade700))),
      if (jam.isEmpty)
        const Padding(
            padding: EdgeInsets.all(20),
            child: Center(
                child: Text("当前没有被交管拦停的车辆",
                    style: TextStyle(color: Colors.green, fontSize: 13)))),
      ...jam.map((c) {
        final site = "${c["currentSite"] ?? ""}";
        final lockers = ((c["routeLockLands"] as List?) ?? const [])
            .map((e) => e.toString())
            .where((l) => owners[l] != null && !myId.contains("${owners[l]}"))
            .toList();
        return Container(
            margin: const EdgeInsets.fromLTRB(10, 5, 10, 0),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.red.shade200)),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Text("${c["carName"] ?? "AGV${c["agvId"]}"}",
                    style: const TextStyle(
                        fontWeight: FontWeight.bold, fontSize: 14)),
                const SizedBox(width: 6),
                _tag(c["carState"] == "pause" ? "暂停等待" : "被交管锁住", Colors.red),
                const Spacer(),
                if (_canCtl && site.isNotEmpty)
                  ActionChip(
                      avatar: const Icon(Icons.lock_open,
                          size: 14, color: Colors.deepOrange),
                      label: const Text("解除交管",
                          style: TextStyle(
                              fontSize: 10.5,
                              color: Colors.deepOrange,
                              fontWeight: FontWeight.w600)),
                      visualDensity: VisualDensity.compact,
                      materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      onPressed: () => _unlockStation(site)),
              ]),
              row("当前点位", "$site（${zoneOf(site)}）"),
              row(
                  "拦停它的前车",
                  lockers.isEmpty
                      ? "—"
                      : lockers
                          .map((l) => "$l→${carNameOf(owners[l])}")
                          .join("、")),
            ]));
      }),
      if (owners.isNotEmpty)
        Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
            child: Text("点位占用明细（${owners.length}）",
                style: const TextStyle(
                    fontWeight: FontWeight.bold, fontSize: 13))),
      if (owners.isNotEmpty)
        Container(
            margin: const EdgeInsets.fromLTRB(10, 6, 10, 0),
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFFE3E8F0))),
            child: Wrap(
                spacing: 8,
                runSpacing: 4,
                children: owners.entries
                    .map((e) => Text("${e.key}→${carNameOf(e.value)}",
                        style: const TextStyle(
                            fontSize: 11, color: Color(0xFF455A64))))
                    .toList())),
      Padding(
          padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
          child: Text("交管区配置（${zones.length}）",
              style:
                  const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
      ...zones.map((z) => Container(
          margin: const EdgeInsets.fromLTRB(10, 5, 10, 0),
          padding: const EdgeInsets.all(9),
          decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFE3E8F0))),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(
                  child: Text("${z["remarks"] ?? "交管区${z["zoneId"]}"}",
                      style: const TextStyle(
                          fontWeight: FontWeight.bold, fontSize: 12.5))),
              _tag("通行限${z["carNumber"] ?? 1}车", Colors.blueGrey),
            ]),
            Text("点位：${z["junctionLandmarkCodes"] ?? "-"}",
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style:
                    const TextStyle(fontSize: 10.5, color: Color(0xFF90A4AE))),
          ]))),
    ]);
  }

  /// 货架移库（货位→货位 / 货位→地面暂存）：表单 → 二次确认 → 服务器建CARRY任务
  Future<void> _showTransfer() async {
    final fromC = TextEditingController(),
        toC = TextEditingController(),
        palC = TextEditingController();
    bool toGround = false, dry = false;
    InputDecoration di(String hint) => InputDecoration(
        isDense: true, border: const OutlineInputBorder(), hintText: hint);
    final choice = await showDialog<String>(
        context: context,
        builder: (ctx) => StatefulBuilder(builder: (ctx2, setDlg) {
              return AlertDialog(
                title: const Text("🔄 货架移库"),
                content: SingleChildScrollView(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                  TextField(
                      controller: fromC,
                      textCapitalization: TextCapitalization.characters,
                      decoration: di("起点货位（如 NB02-A-08-2F）")),
                  const SizedBox(height: 8),
                  TextField(
                      controller: toC,
                      textCapitalization: TextCapitalization.characters,
                      decoration: di("终点货位 / 地面暂存位")),
                  const SizedBox(height: 8),
                  TextField(
                      controller: palC,
                      textCapitalization: TextCapitalization.characters,
                      decoration: di("货架类型（选填，留空按账本自动匹配）")),
                  CheckboxListTile(
                      value: toGround,
                      onChanged: (v) => setDlg(() => toGround = v ?? false),
                      title: const Text("终点是地面暂存位",
                          style: TextStyle(fontSize: 13)),
                      dense: true,
                      controlAffinity: ListTileControlAffinity.leading),
                  CheckboxListTile(
                      value: dry,
                      onChanged: (v) => setDlg(() => dry = v ?? false),
                      title: const Text("仅演算不真下发（试参数）",
                          style: TextStyle(fontSize: 13)),
                      dense: true,
                      controlAffinity: ListTileControlAffinity.leading),
                ])),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(ctx2),
                      child: const Text("取消")),
                  FilledButton(
                      onPressed: () => Navigator.pop(
                          ctx2, dry ? "dry" : (toGround ? "goG" : "go")),
                      child: const Text("下一步")),
                ],
              );
            }));
    if (choice == null || !mounted) return;
    final from = fromC.text.trim().toUpperCase(),
        to = toC.text.trim().toUpperCase();
    if (from.isEmpty || to.isEmpty) {
      _toast("❌ 起点/终点货位不能为空");
      return;
    }
    if (choice != "dry") {
      final ok = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
                title: const Text("⚠️ 确认移库",
                    style: TextStyle(color: Colors.deepOrange)),
                content: Text(
                    "将呼叫AGV把 $from 上的货架整架移到 $to。\n\n请确认该货位确有此架、移库路径无人停留。到位后记得用「位置登记」更新账本。确认下发？"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text("取消")),
                  FilledButton(
                      style: FilledButton.styleFrom(
                          backgroundColor: Colors.deepOrange),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text("确认下发"))
                ],
              ));
      if (ok != true || !mounted) return;
    }
    final r = await AuthApi.agvTransfer(
        from: from,
        to: to,
        kind: choice == "goG" ? "toGround" : "shelf2shelf",
        palletType: palC.text.trim(),
        dry: choice == "dry");
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ ${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
    LocalLog.op('移库', r["ok"] == true ? '$from→$to 已下发' : '$from→$to 失败');
  }

  Future<void> _cancelTransfer(Map q) async {
    final yes = await showDialog<bool>(context: context, builder: (ctx) => AlertDialog(
      title: const Text("取消移库", style: TextStyle(color: Colors.red)),
      content: Text("取消移库 ${(q["from"] ?? "?")} → ${(q["to"] ?? "?")}？\n\n若AGV已叉出货架则无法撤回，需人工归位。"),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("再想想")),
        FilledButton(style: FilledButton.styleFrom(backgroundColor: Colors.red), onPressed: () => Navigator.pop(ctx, true), child: const Text("确认取消"))],
    ));
    if (yes != true || !mounted) return;
    final r = await AuthApi.agvTransferCancel((q["at"] ?? "").toString());
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ ${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
    LocalLog.op('移库取消', r["ok"] == true ? '已请求取消' : '取消失败');
  }

  /// 解除交管：二次确认（红色警示）→ 释放点位交管锁 → 刷新
  Future<void> _unlockStation(String land) async {
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("⚠️ 解除交管", style: TextStyle(color: Colors.red)),
              content: Text(
                  "强制释放点位 $land 的交管锁？\n\n该操作会让被拦车辆跳过交管等待继续行驶，请确认现场无车占路，否则有碰撞风险。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("取消")),
                FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: Colors.red),
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认解除"))
              ],
            ));
    if (ok != true || !mounted) return;
    final r = await AgvApi.unlockStation(land);
    _toast(r["ok"] == true ? "✅ 点位 $land 交管锁已解除" : "❌ 解除失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
  }

  // ---- 实时界面页签 ----
  Widget _portalView() {
    return Center(
        child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
      const Icon(Icons.map_outlined, size: 56, color: Color(0xFF00897B)),
      const SizedBox(height: 10),
      const Text("AGV 实时地图（车间2D视图）",
          style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold)),
      const SizedBox(height: 4),
      const Text("车辆位置/货架占用/站台状态/交管堵点，10秒自动刷新",
          style: TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
      const SizedBox(height: 16),
      ElevatedButton.icon(
          icon: const Icon(Icons.phone_android),
          label: const Text("原厂PDA版（推荐）"),
          style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF00897B),
              foregroundColor: Colors.white,
              padding:
                  const EdgeInsets.symmetric(horizontal: 22, vertical: 12)),
          onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                  builder: (_) =>
                      const AgvWebViewPage(spaRoute: "/home-pda")))),
      const SizedBox(height: 10),
      OutlinedButton.icon(
          icon: const Icon(Icons.map, size: 18, color: Color(0xFF00897B)),
          label: const Text("业务叠加地图（含站台占用/释放预测）",
              style: TextStyle(fontSize: 12, color: Color(0xFF00897B))),
          onPressed: () => Navigator.push(
              context, MaterialPageRoute(builder: (_) => const AgvMapPage()))),
      const SizedBox(height: 14),
      const Icon(Icons.monitor, size: 40, color: Color(0xFF37474F)),
      const SizedBox(height: 6),
      const Text("哈工库讯 AGV 实时调度大屏（原厂网页版）",
          style: TextStyle(fontSize: 13, color: Color(0xFF607D8B))),
      const SizedBox(height: 4),
      FutureBuilder<Map<String, String>>(
          future: AgvConfig.get(),
          builder: (_, s) => Text(
              "门户 ${s.data?["portal"] ?? AgvConfig.defaultPortal} · 自动登录",
              style: const TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))),
      const SizedBox(height: 16),
      ElevatedButton.icon(
          icon: const Icon(Icons.open_in_new),
          label: const Text("打开实时调度界面"),
          style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF1565C0),
              foregroundColor: Colors.white,
              padding:
                  const EdgeInsets.symmetric(horizontal: 22, vertical: 12)),
          onPressed: () => Navigator.push(context,
              MaterialPageRoute(builder: (_) => const AgvWebViewPage()))),
      const SizedBox(height: 8),
      const Text("地图/任务/交管实时画面，含车辆定位",
          style: TextStyle(fontSize: 11, color: Color(0xFF90A4AE))),
    ]));
  }
}

// ===================== AGV实时调度界面（WebView，注入token自动登录） =====================
class AgvWebViewPage extends StatefulWidget {
  final String spaRoute; // 非空=SPA内路由（如 /home-pda 原厂手机版）；nginx无回退，先载根路径再前端跳转
  const AgvWebViewPage({super.key, this.spaRoute = ""});
  @override
  State<AgvWebViewPage> createState() => _AgvWebViewPageState();
}

class _AgvWebViewPageState extends State<AgvWebViewPage> {
  late final WebViewController _ctrl;
  bool _loading = true, _injected = false, _spaDone = false;

  @override
  void initState() {
    super.initState();
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0B1220))
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) {
          if (mounted) setState(() => _loading = true);
        },
        onPageFinished: (_) async {
          if (!_injected) {
            _injected = true;
            final tk = await AgvApi.token();
            final cfg = await AgvConfig.get();
            if (tk != null && tk.isNotEmpty && mounted) {
              // 哈工库讯前端从 sessionStorage["v1@CacheToken"] 读token；注入后重载根路径即免登录直达大屏
              // （实测 nginx 未配 history 回退，/home-index 等子路径直访404，只能从根路径进）
              await _ctrl.runJavaScript(
                  "try{sessionStorage.setItem('v1@CacheToken',JSON.stringify({token:'$tk'}));}catch(e){}");
              await _ctrl.loadRequest(
                  Uri.parse("http://${cfg["portal"]}/")); // 重载使前端读到token
              return;
            }
          }
          // token已注入且根路径加载完成：SPA内路由（如/home-pda）用pushState+popstate跳转（nginx无回退不能直访子路径）
          if (widget.spaRoute.isNotEmpty && !_spaDone && mounted) {
            _spaDone = true;
            await _ctrl.runJavaScript(
                "history.pushState({},'','${widget.spaRoute}');window.dispatchEvent(new PopStateEvent('popstate'));");
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
      appBar: AppBar(
          title: const Text("AGV实时调度界面",
              style: TextStyle(color: Colors.white, fontSize: 16)),
          backgroundColor: const Color(0xFF101A2E),
          iconTheme: const IconThemeData(color: Colors.white),
          actions: [
            IconButton(
                tooltip: "重新加载并登录",
                icon: const Icon(Icons.refresh, color: Colors.white),
                onPressed: () {
                  _injected = false;
                  setState(() => _loading = true);
                  _ctrl.reload();
                })
          ]),
      body: Stack(children: [
        WebViewWidget(controller: _ctrl),
        if (_loading)
          const Center(child: CircularProgressIndicator(color: Colors.cyan)),
      ]),
    );
  }
}

// ===================== AGV调度系统设置页 =====================
class AgvSettingPage extends StatefulWidget {
  const AgvSettingPage({super.key});
  @override
  State<AgvSettingPage> createState() => _AgvSettingPageState();
}

class _AgvSettingPageState extends State<AgvSettingPage> {
  final _hostCtrl = TextEditingController();
  final _portalCtrl = TextEditingController();
  final _accCtrl = TextEditingController();
  final _pwdCtrl = TextEditingController();
  String _msg = "";
  bool _ok = false, _busy = false;
  String _mode = "dry"; // 一键叫车调度模式：dry演算 / live真实下发
  bool _syncing = false;

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
      final st = await AuthApi.rcsStations();
      if (mounted && st["ok"] == true)
        setState(() => _mode = st["mode"]?.toString() ?? "dry");
    });
  }

  @override
  void dispose() {
    _hostCtrl.dispose();
    _portalCtrl.dispose();
    _accCtrl.dispose();
    _pwdCtrl.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_hostCtrl.text.trim().isEmpty || _portalCtrl.text.trim().isEmpty) {
      setState(() {
        _ok = false;
        _msg = "地址不能为空";
      });
      return;
    }
    await AgvConfig.save(
        host: _hostCtrl.text,
        portal: _portalCtrl.text,
        account: _accCtrl.text,
        pwd: _pwdCtrl.text);
    setState(() {
      _ok = true;
      _msg = "已保存";
    });
  }

  Future<void> _test() async {
    setState(() {
      _busy = true;
      _msg = "";
    });
    await AgvConfig.save(
        host: _hostCtrl.text,
        portal: _portalCtrl.text,
        account: _accCtrl.text,
        pwd: _pwdCtrl.text);
    final t = await AgvApi.login();
    if (t != null) {
      // 同步凭据到鉴权服务器：服务器20秒代轮询RCS → 到站催扫通知 + 站台占用面板
      final s = await AuthApi.rcsConfigSync(
          host: _hostCtrl.text.trim(),
          account: _accCtrl.text.trim(),
          pwd: _pwdCtrl.text);
      if (s["ok"] != true) debugPrint("[rcs] 配置同步失败：${s["msg"]}");
      // 同步WMAS账号给调度器（一键叫车真实下发通道）；失败不阻断RCS同步结果
      final wCfg = await WmasConfig.get();
      if ((wCfg["account"] ?? "").isNotEmpty &&
          (wCfg["pwd"] ?? "").isNotEmpty) {
        final ws = await AuthApi.agvWmasConfig(
            host: wCfg["host"] ?? "",
            account: wCfg["account"] ?? "",
            pwd: wCfg["pwd"] ?? "");
        if (ws["ok"] != true) debugPrint("[wmas] 调度器账号同步失败：${ws["msg"]}");
      }
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ok = t != null;
      _msg = t == null
          ? "登录失败：检查地址/账号/密码（或AGV系统离线）"
          : "登录成功 ✅ token已缓存（12小时）；服务器轮询+调度器凭据已同步";
    });
  }

  Future<void> _setMode(String m) async {
    setState(() {
      _syncing = true;
    });
    final r = await AuthApi.agvSetMode(m);
    if (!mounted) return;
    setState(() {
      _syncing = false;
      if (r["ok"] == true) _mode = m;
    });
    if (r["ok"] != true)
      setState(() {
        _ok = false;
        _msg = "模式切换失败：${r["msg"]}";
      });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
        appBar: AppBar(title: const Text("AGV调度系统设置")),
        body: ListView(padding: const EdgeInsets.all(14), children: [
          const Text("调度API地址（登录与数据查询）",
              style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
          TextField(
              controller: _hostCtrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                  hintText: "10.96.23.8:9091", border: OutlineInputBorder())),
          const SizedBox(height: 12),
          const Text("实时界面门户地址（WebView大屏）",
              style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
          TextField(
              controller: _portalCtrl,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                  hintText: "10.96.23.8:8181", border: OutlineInputBorder())),
          const SizedBox(height: 12),
          const Text("账号 / 密码",
              style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
          TextField(
              controller: _accCtrl,
              decoration: const InputDecoration(
                  hintText: "登录账号（如 root）", border: OutlineInputBorder())),
          const SizedBox(height: 8),
          TextField(
              controller: _pwdCtrl,
              obscureText: true,
              decoration: const InputDecoration(
                  hintText: "登录密码", border: OutlineInputBorder())),
          const SizedBox(height: 14),
          Row(children: [
            Expanded(
                child: OutlinedButton(
                    onPressed: _busy ? null : _save, child: const Text("保存"))),
            const SizedBox(width: 10),
            Expanded(
                child: ElevatedButton(
                    onPressed: _busy ? null : _test,
                    child: Text(_busy ? "登录中…" : "测试登录"))),
          ]),
          if (_msg.isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(_msg,
                    style: TextStyle(
                        color: _ok ? Colors.green : Colors.red, fontSize: 13))),
          const SizedBox(height: 16),
          const Divider(),
          const SizedBox(height: 8),
          const Text("一键叫车 · 站台自动排队",
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
          const SizedBox(height: 4),
          Row(children: [
            Expanded(
                child: OutlinedButton.icon(
                    onPressed: _syncing ? null : () => _setMode("dry"),
                    icon: Icon(Icons.science_outlined,
                        size: 16,
                        color: _mode == "dry" ? Colors.teal : Colors.grey),
                    label: Text("演算模式${_mode == "dry" ? " ✓" : ""}",
                        style: TextStyle(
                            fontSize: 12,
                            color: _mode == "dry" ? Colors.teal : null)))),
            const SizedBox(width: 8),
            Expanded(
                child: OutlinedButton.icon(
                    onPressed: _syncing
                        ? null
                        : () async {
                            final yes = await showDialog<bool>(
                                context: context,
                                builder: (ctx) => AlertDialog(
                                      title: const Text("⚠️ 切换为真实下发"),
                                      content: const Text(
                                          "切换后，领料单「一键叫车」将真实向 WMAS 下发 AGV 搬运任务并自动分配站台。\n\n请确认现场 AGV 可安全执行、WMAS 账号已在设置页配置。\n\n确定切换？"),
                                      actions: [
                                        TextButton(
                                            onPressed: () =>
                                                Navigator.pop(ctx, false),
                                            child: const Text("取消")),
                                        FilledButton(
                                            style: FilledButton.styleFrom(
                                                backgroundColor: Colors.red),
                                            onPressed: () =>
                                                Navigator.pop(ctx, true),
                                            child: const Text("确认切换"))
                                      ],
                                    ));
                            if (yes == true) await _setMode("live");
                          },
                    icon: Icon(Icons.bolt,
                        size: 16,
                        color: _mode == "live" ? Colors.red : Colors.grey),
                    label: Text("真实下发${_mode == "live" ? " ✓" : ""}",
                        style: TextStyle(
                            fontSize: 12,
                            color: _mode == "live" ? Colors.red : null)))),
          ]),
          const SizedBox(height: 10),
          const Text(
              "说明：token 12小时有效，过期自动重登；验证码为系统万能码已内置。RCS 负责状态查询与站台面板，一键叫车的任务下发走 WMAS（需先在 WMAS(AGV)设置 配好账号）。演算模式只排计划不下发，验证分配逻辑无误后再切真实下发。",
              style: TextStyle(fontSize: 11, color: Colors.blueGrey)),
        ]));
  }
}
