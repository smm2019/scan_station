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
      String method, String path, String? body, String? token,
      {bool plain = false}) async {
    final cfg = await AgvConfig.get();
    HttpClient? client;
    try {
      client = HttpClient()..connectionTimeout = const Duration(seconds: 6);
      final req =
          await client.openUrl(method, Uri.parse("http://${cfg["host"]}$path"));
      req.headers.set("Accept", "*/*");
      if (body != null) {
        req.headers.contentType = plain
            ? ContentType("text", "plain", charset: "utf-8")
            : ContentType.json;
      }
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
    // ㉖v161 让位期内不自动登录：本方法被领料页"实时任务"每次刷新调用，退出后若继续重登，
    // 会把现场人员刚在 AGV 网页建立的会话踢掉（同账号后登录者踢前者）。返回 null 由调用方空值分支提示。
    if (await AgvAuthYield.on()) return null;
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
      {Map? body, String? rawBody, bool plain = false}) async {
    var t = await token();
    if (t == null) return {"ok": false, "msg": "AGV系统未登录：请到 设置→AGV调度系统 填写账号密码"};
    final b = rawBody ?? (body == null ? null : jsonEncode(body));
    var r = await _raw(method, path, b, t, plain: plain);
    if (_authFail(r)) {
      t = await login();
      if (t == null) return {"ok": false, "msg": "AGV系统登录失效且自动重登失败"};
      r = await _raw(method, path, b, t, plain: plain);
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
        // ㉑门户封装实证：V.delete(url,no)→axios{method:DELETE,data:no字符串原样直发}。
        // 两处偏差致500：①置顶此前用POST（门户是DELETE）；②body带JSON引号→后端@RequestBody String拿到脏值查无任务。
        // 现对齐门户：DELETE + 裸文本body，并附查询参数双保险（@RequestParam也能命中）。
        return req("DELETE", "/task/taskToTop?dispatchNo=$enc",
            rawBody: dispatchNo, plain: true);
      case "cancelTop":
        return req("DELETE", "/task/taskToCancelTop?dispatchNo=$enc",
            rawBody: dispatchNo, plain: true);
      case "delete":
        return req("DELETE", "/task/deleteByDispatchNo?dispatchNo=$enc",
            rawBody: dispatchNo, plain: true);
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
    // ㉖v280 重定位：车与实车位置对不上（被推走/人工挪动）时让车重报坐标。
    // 实测 RCS 端点=PUT /agv/relocationAgv?ip=；本方法走 RCS 直连（与去充电等同款），网页端走服务器代理，指令同源。
    "reloc": {
      "path": "/agv/relocationAgv",
      "label": "重定位",
      "tip": "让车重新自报位置。请确认实车没叉着货再执行；车短暂自检，不影响任务队列",
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

  /// ㉖v280 车辆细态（镜像服务器 carPhaseTxt，优先级/判据同源，注释同步改）：
  /// 急停>人工停>被交管>离线>告警>充电>业务阶段(去取货/去放架/放架收尾/排队待接)>自主导航(去充电/返航待命)>车体状态>空闲
  /// rt=该车当前运行任务原始行(_tasks 里 exeAgvId 匹配)，可 null；节点戳用现成 nodeTimesOf
  static String carPhase(Map c, Map? rt, bool blocked, bool hasAlarm) {
    if (c["emergencyButton"] == true) return "急停";
    if (c["manualStop"] == true) return "人工停";
    if (blocked) return "被交管";
    if (c["communicationBreak"] == true || c["enable"] != 1) return "离线";
    if (hasAlarm) return "告警";
    if (c["charging"] == true) return c["fullCharged"] == true ? "充满" : "充电";
    final no = (rt?["dispatchNo"] ?? c["execTaskNo"] ?? c["executeTaskNo"] ?? "").toString();
    if (no.isEmpty) {
      switch (c["carState"]?.toString()) {
        case "pause": return "暂停";
        case "error": return "故障";
        default: return "空闲";
      }
    }
    final tt = (rt?["taskType"] ?? "").toString().toUpperCase();
    // 自主导航（回待命/去充电）：UUID调度号或任务类型直判（低电=去充电，RCS lowPower 权威，兜底电量25%）
    if (tt == "CHARGE" || tt == "STANDBY" || RegExp(r"^[0-9a-fA-F]{8}-").hasMatch(no)) {
      final low = c["lowPower"] == true || ((AgvApi.asNum(c["power"]) ?? 0) > 0 && (AgvApi.asNum(c["power"]) ?? 100) <= 25);
      return tt == "CHARGE" || low ? "去充电" : "返航待命";
    }
    final st = int.tryParse("${rt?["taskState"] ?? 1}") ?? 1;
    if (st == 2) return "放架收尾";
    if (st == 0) return "排队待接";
    if (rt == null) return "去取货"; // 车自报任务号但运行任务表暂无此车行（15秒刷新竞态窗）→ 粗判取货段，rt! 会空引用崩溃（自纠）
    final nt = AgvApi.nodeTimesOf(rt);
    if (nt[0] > 0 && nt[1] == 0) return "去放架"; // 货已在车上
    return "去取货";
  }

  /// 细态配色（与网页 stColOf 同系：出事红/交管橙/充电黄/导航青/业务蓝/空闲绿）
  static Color carPhaseColor(String p, bool online) {
    if (!online) return Colors.grey;
    switch (p) {
      case "急停": case "人工停": case "故障": return Colors.red;
      case "被交管": return Colors.deepOrange;
      case "告警": return const Color(0xFFAD1457);
      case "充电": case "去充电": case "充满": return const Color(0xFFF9A825);
      case "返航待命": return const Color(0xFF26A69A);
      case "去放架": case "放架收尾": return const Color(0xFF00ACC1);
      case "排队待接": return const Color(0xFF7E57C2);
      case "去取货": return const Color(0xFF1E88E5);
      case "暂停": return const Color(0xFF8E24AA);
      default: return online ? Colors.teal : Colors.grey;
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
  List<Map> _alarms = []; // ㉑活动车辆告警（认领按钮数据源，服务器 /api/agv/alarms）
  Map _traffic = {};
  Map<String, String> _cargo = {}; // 任务起点货位 → 账本反查的货物描述（零件号×数量）
  List<Map> _stations = []; // 站台状态（服务器轮询RCS：有货/占用中/空闲）
  bool _stationsOn = false; // 服务器RCS轮询已开启（on标志）：列表为空但on=true=全空闲，不是未就绪
  Map<String, int> _holdAvg = {}; // 站台历史平均占用分钟数（释放预测）
  List<Map> _transfer = []; // 移库任务（服务器队列中 type=transfer 项）
  bool _loading = false, _showDone = false, _loaded = false;
  int _doneN = 30; // ㉖最近历史展开条数：默认30，可"加载更多"每次+50
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
        AuthApi.rcsStations(),
        AuthApi.agvAlarms()
            .catchError((_) => <String, dynamic>{}) // 告警列表失败不阻塞主刷新
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
        final al = rs[5];
        _alarms = al is Map && al["list"] is List
            ? List<Map>.from(al["list"] as List)
            : _alarms;
        if (st is Map && st["holdAvg"] is Map)
          _holdAvg = (st["holdAvg"] as Map)
              .map((k, v) => MapEntry(k.toString(), (v as num).toInt()));
        _transfer = st is Map && st["queue"] is List
            ? (st["queue"] as List)
                .whereType<Map>()
                .where((q) => q["type"] == "transfer")
                .toList()
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

  /// 反查货物：AGV 只知"搬托盘"，货由任务货位回查本机货位账本得到（零件号/数量/标签）
  /// ㉖v91 起点+终点都收（入库任务起点=站台，账本永不登记站台位，旧版只查起点必报"无此位货物"误导）；站台位(-CK-)剔除
  Future<void> _buildCargo() async {
    try {
      final locs = <String>{};
      for (final t in [..._tasks, ..._done.take(10)]) {
        final rt = AgvApi.taskRoute(t);
        for (final k in ["startPoint", "endPoint"]) {
          final v = (rt[k] ?? "").toString().toUpperCase();
          if (v.isNotEmpty && !v.contains('-CK-'))
            locs.add(v); // 站台非存储位，反查只会假报无货
        }
      }
      if (locs.isEmpty) return;
      // ㉖v93f 服务器权威账本优先：本机 shelfPlacements 只在采集页保存/拉取时同步，AGV 页 15 秒刷新从不拉取——
      // 作废重扫/他机出库消账后本机缓存与实账脱节，任务卡反查显示旧框（10/24 15:28 复盘：A-02-3F 装 230121 却显示上午已出库的 200244）
      Map<String, List<Map>> srvLoc = {};
      try {
        final lr = await AuthApi.ledgerGet();
        if (lr["ok"] == true && lr["items"] is List) {
          for (final x in (lr["items"] as List).whereType<Map>()) {
            final l0 = (x["l"] ?? "").toString().toUpperCase();
            if (l0.isNotEmpty && locs.contains(l0))
              (srvLoc[l0] = srvLoc[l0] ?? <Map>[]).add(x);
          }
        }
      } catch (_) {}
      if (srvLoc.isNotEmpty) {
        final out = <String, String>{};
        srvLoc.forEach((l, rows) {
          out[l] = rows.map((x) {
            final p = (x["p"] ?? "").toString();
            final q = ((x["q"] as num?) ?? 0).toDouble();
            return (p.isNotEmpty ? p + "·" + _fmtInvNum(q) + "件" : "未补齐物料") +
                "（标签 " +
                (x["c"] ?? "").toString() +
                "）";
          }).join(" ");
        });
        if (!mounted) return;
        setState(() => _cargo = out);
        return;
      }
      // 服务器不可达：回退本机缓存旧口径（可能滞后，但聊胜于无）
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
        // ㉖v91 不再塞"账本无此位货物"占位串：出库完成框已离架、账本无货是正常态，
        // 旧版把它当货物信息青色显示易误导；无货由渲染层按 done/未同步 分场景措辞
        if (codes == null || codes.isEmpty) continue;
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

  /// ㉑认领车辆告警：确认后调服务器 ack（落库处理人+停止升级+广播全体），失败提示
  Future<void> _ackAlarm(dynamic aid, String fp) async {
    final yes = await showDialog<bool>(
        context: context,
        builder: (dc) => AlertDialog(
              title: Text("认领 AGV${aid.toString().padLeft(2, '0')} 告警？"),
              content: Text("$fp\n\n认领后停止升级催办，并通知全体仓管你正在处理。",
                  style: const TextStyle(fontSize: 13)),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dc, false),
                    child: const Text("取消")),
                FilledButton(
                    style: FilledButton.styleFrom(
                        backgroundColor: Colors.deepOrange),
                    onPressed: () => Navigator.pop(dc, true),
                    child: const Text("确认认领"))
              ],
            ));
    if (yes != true || !mounted) return;
    final r = await AuthApi.agvAlarmAck(aid.toString());
    if (!mounted) return;
    if (r["ok"] == true) {
      _toast("🙋 已认领，升级催办已停止");
      _load(silent: true);
    } else
      _toast("认领失败：${r["msg"]}");
  }

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
    if (r["ok"] == true) {
      _toast("✅ ${a["label"]}：已执行");
    } else {
      final m = r["msg"]?.toString() ?? "";
      _toast(m.contains("服务器内部异常") || m.contains("500")
          ? "❌ ${a["label"]}失败：任务可能已被调度器认领或车辆离线（当前0/4在线时常见），请先恢复车辆通讯再试，或到调度网页端处理"
          : "❌ ${a["label"]}失败：$m");
    }
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
        : (act == "charge"
            ? Colors.teal
            : (act == "reloc" ? const Color(0xFF3949AB) : const Color(0xFF1565C0)));
    return ActionChip(
        avatar: Icon(
            danger
                ? Icons.dangerous_outlined
                : (act == "charge"
                    ? Icons.bolt
                    : (act == "reloc"
                        ? Icons.my_location_outlined
                        : (act == "start"
                            ? Icons.play_arrow
                            : (act == "stop"
                                ? Icons.stop_circle_outlined
                                : Icons.home_outlined)))),
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
      final ep = (rt["endPoint"] ?? "").toString().toUpperCase();
      // ㉖v91 存储位=起终点中非站台(-CK-)的那个：入库起点是站台→取终点货架位；出库终点是站台→取起点货架位。
      // 旧版只查起点，入库任务起点=站台（账本永不登记站台）必误报"无此位货物"
      final _stn = (String s) => s.contains('-CK-');
      final stLoc = (!_stn(sp) && sp.isNotEmpty)
          ? sp
          : ((!_stn(ep) && ep.isNotEmpty) ? ep : "");
      final cargo = _cargo[stLoc];
      final isCharge = rt["taskType"]?.toString() == "CHARGE" ||
          "${t["taskType"] ?? ""}" == "CHARGE";
      // 调度号为UUID = 车辆自主导航任务（回待命点/去充电），非业务搬运；业务任务调度号是LL单号
      final isNav = RegExp(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-").hasMatch(no);
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
            isNav
                ? const Text("🧭 车辆自主导航（回待命点/去充电）· 非搬运任务",
                    style: TextStyle(
                        fontSize: 13,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF26A69A)))
                : Text(
                    "${rt["startPoint"] ?? "?"}  →  ${rt["endPoint"] ?? "?"}",
                    style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: Color(0xFF1565C0))),
            const SizedBox(height: 4),
            Text(
                isNav
                    ? "车：${names[t["exeAgvId"]] ?? (t["exeAgvId"] == null ? "未分配" : "AGV${t["exeAgvId"]}")}"
                    : "车：${names[t["exeAgvId"]] ?? (t["exeAgvId"] == null ? "未分配" : "AGV${t["exeAgvId"]}")}　托盘：${rt["palletType"] ?? t["palletType"] ?? "-"}　类型：${rt["taskType"] ?? t["taskType"] ?? "-"}",
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
            else if (stLoc.isEmpty)
              const Text("货物：—",
                  style: TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))
            else if (done)
              Text("货物：搬运已完成，框已离位（$stLoc 现无货）",
                  style:
                      const TextStyle(fontSize: 11, color: Color(0xFF90A4AE)))
            else
              Text("货物：$stLoc 暂无账本记录（未入账/账本未同步）",
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
            if (_canCtl && !isCharge && !isNav)
              Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Wrap(
                      spacing: 5,
                      runSpacing: 3,
                      // ㉑严格按原厂分状态：待执行=置顶/取消置顶+删除；执行中=重置取货/重置卸货；已完成=恢复取货/恢复卸货
                      children: done
                          ? [
                              _taskOpBtn(t, "recoverPick"),
                              _taskOpBtn(t, "recoverPut")
                            ]
                          : st == 0
                              ? [
                                  _taskOpBtn(
                                      t,
                                      (t["taskPriority"] as num?)?.toInt() == 11
                                          ? "cancelTop"
                                          : "top"),
                                  _taskOpBtn(t, "delete"),
                                ]
                              : [
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
        Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
            child: Text("移库任务（${_transfer.length}）",
                style: const TextStyle(
                    fontWeight: FontWeight.bold,
                    fontSize: 13,
                    color: Colors.deepOrange))),
        ..._transfer.map((q) => Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
            // ㉖v198d 移库任务卡可展开时间线（检验工单同款）：服务器 trace 数组
            // （排队原因/自动选台依据/WMAS下发结果/失败原因）逐条带时刻展开，
            // 现场看得懂"为什么还没发"与"台是谁选的"。
            child: Container(
                decoration: BoxDecoration(
                    color: Colors.deepOrange.shade50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.deepOrange.shade200)),
                child: ExpansionTile(
                    tilePadding: const EdgeInsets.symmetric(horizontal: 10),
                    childrenPadding: const EdgeInsets.fromLTRB(14, 0, 10, 10),
                    leading: const Icon(Icons.swap_horiz,
                        size: 18, color: Colors.deepOrange),
                    title: Text(
                        "${(q["from"] ?? "?")} → ${(q["to"]?.toString() ?? "").isNotEmpty ? q["to"] : (q["autoStn"] == 1 ? "待自动选台" : "?")}${(q["code"] ?? "").toString().isNotEmpty ? "  ${q["code"]}" : ""}",
                        style: const TextStyle(
                            fontSize: 13,
                            fontFamily: "monospace",
                            fontWeight: FontWeight.w600)),
                    subtitle: Text(
                        "${q["state"] ?? ""}${q["stage"] != null ? " · ${q["stage"]}" : ""} · ${(q["by"] ?? "").toString()}发起",
                        style: const TextStyle(
                            fontSize: 11.5,
                            color: Colors.deepOrange,
                            fontWeight: FontWeight.bold)),
                    trailing: (q["state"] == "已下发" || q["state"] == "排队")
                        ? IconButton(
                            icon: const Icon(Icons.close,
                                size: 18, color: Colors.red),
                            onPressed: () => _cancelTransfer(q))
                        : const Icon(Icons.expand_more,
                            size: 18, color: Colors.grey),
                    children: [
                      // ㉖v198g 已送达/在送途中的框被人搬走 → 一键收口（去向弹层+站台立释）
                      if (["已下发", "到站", "完成"].contains(q["state"]))
                        Align(
                          alignment: Alignment.centerLeft,
                          child: Padding(
                              padding: const EdgeInsets.only(bottom: 6),
                              child: OutlinedButton.icon(
                                  style: OutlinedButton.styleFrom(
                                      foregroundColor: const Color(0xFFEF6C00),
                                      visualDensity: VisualDensity.compact),
                                  onPressed: () => _removeTransfer(q),
                                  icon: const Icon(Icons.move_down, size: 16),
                                  label: const Text("人已移走 · 收口",
                                      style: TextStyle(fontSize: 12.5)))),
                        ),
                      Align(
                          alignment: Alignment.centerLeft,
                          child: Text((() {
                            final tr = ((q["trace"] as List?) ?? [])
                                .map((e) => e.toString())
                                .toList()
                              ..reversed;
                            return tr.isEmpty
                                ? "暂无调度留痕"
                                : tr.map((e) => "· $e").join("\n");
                          })(),
                              style: const TextStyle(
                                  fontSize: 11.5,
                                  height: 1.6,
                                  color: Colors.blueGrey))),
                      if (q["err"]?.toString().isNotEmpty == true)
                        Align(
                            alignment: Alignment.centerLeft,
                            child: Text("⚠ ${q["err"]}",
                                style: const TextStyle(
                                    fontSize: 11.5, color: Colors.red))),
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
          onPressed: () => setState(() {
                _showDone = !_showDone;
                if (_showDone) _doneN = 30;
              }),
          child: Text(_showDone ? "收起" : "展开最近$_doneN条")),
      if (_showDone) ..._done.take(_doneN).map((t) => card(t, done: true)),
      if (_showDone && _doneN < _done.length)
        TextButton(
            onPressed: () => setState(() => _doneN += 50),
            child: Text("加载更多（已显示 $_doneN / ${_done.length}）")),
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
          // ㉖v280 该车当前运行任务原始行（exeAgvId 匹配，与地图/服务器同源判据），供细态推导
          final Map? _rt = _tasks.cast<Map?>().firstWhere(
              (t) => t != null && "${t["exeAgvId"]}" == "$id" && (t["taskState"] == 0 || t["taskState"] == 1),
              orElse: () => null);
          final _hasAl = _alarms.any((a) => "${a["id"]}" == "$id");
          final phase = AgvApi.carPhase(c, _rt, blocked.contains(id), _hasAl);
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
                      _tag(phase, AgvApi.carPhaseColor(phase, online)), // ㉖v280 阶段级细态（去取货/去放架/返航待命…），旧版只有"空闲/执行中"粗态
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
                      final aid = c["agvId"];
                      final am = _alarms
                          .where((a) => a["id"].toString() == aid.toString())
                          .firstOrNull;
                      final ackBy = (am?["ackBy"] ?? "").toString();
                      return Container(
                          margin: const EdgeInsets.only(top: 4),
                          padding: const EdgeInsets.symmetric(
                              horizontal: 6, vertical: 3),
                          decoration: BoxDecoration(
                              color: ackBy.isNotEmpty
                                  ? Colors.orange.shade50
                                  : Colors.red.shade50,
                              borderRadius: BorderRadius.circular(4),
                              border: Border.all(
                                  color: ackBy.isNotEmpty
                                      ? Colors.orange.shade200
                                      : Colors.red.shade200)),
                          child: Row(children: [
                            Expanded(
                                child: Text("⚠ ${warns.join(" · ")}",
                                    style: TextStyle(
                                        fontSize: 11,
                                        color: ackBy.isNotEmpty
                                            ? Colors.deepOrange
                                            : Colors.red,
                                        fontWeight: FontWeight.w600))),
                            if (_canCtl && am != null && ackBy.isEmpty)
                              Padding(
                                  padding: const EdgeInsets.only(left: 4),
                                  child: ActionChip(
                                      visualDensity: VisualDensity.compact,
                                      backgroundColor: Colors.deepOrange,
                                      label: const Text("认领",
                                          style: TextStyle(
                                              fontSize: 10.5,
                                              color: Colors.white)),
                                      onPressed: () =>
                                          _ackAlarm(aid, warns.join(" · ")))),
                            if (ackBy.isNotEmpty)
                              Padding(
                                  padding: const EdgeInsets.only(left: 4),
                                  child: Text("🙋$ackBy",
                                      style: const TextStyle(
                                          fontSize: 10.5,
                                          color: Colors.deepOrange,
                                          fontWeight: FontWeight.w600))),
                          ]));
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
                              "start",
                              "reloc"
                            ])
                              _ctrlBtn(c, act),
                          ])),
                  ]));
        }).toList());
  }

  // ---- 站台页签：出库到站=有货(需尽快扫码清台)，AGV正送/正取=占用中，其余空闲 ----
  Widget _stationList() {
    const all = [
      '01',
      '02',
      '03',
      '04',
      '05',
      '06',
      '07',
      '08',
      '09',
      '10',
      '11',
      '12'
    ]; // ㉖ 启用一二三四号台：站台卡扩为12台
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
        : ((st == "占用中" || st == "待核实")
            ? const Color(0xFF1565C0)
            : Colors.green); // ㉖v286 待核实=到站框号未确认，占派车窗→同占用蓝，防误显绿色可叫车
    IconData iOf(String st) => st == "有货"
        ? Icons.inventory_2
        : ((st == "占用中" || st == "待核实")
            ? Icons.local_shipping
            : Icons.check_circle_outline);
    // ㉖v202 横条列表（用户点名：方块卡一屏只放 4 台、大片空壳）：每行一台、一屏 8~10 台，
    // 左状态色条快扫定位，行内补齐以前只有网页看板才有的信息：站台角色/今出·今回/均清台时长。
    const roleCn = {"any": "通用", "out": "出库专用", "in": "入库专用", "insp": "检验专用"};
    return ListView.separated(
        padding: const EdgeInsets.fromLTRB(10, 8, 10, 16),
        itemCount: all.length,
        separatorBuilder: (_, __) => const SizedBox(height: 6),
        itemBuilder: (bc, ix) {
          final n = all[ix];
          final code = "NB02-CK-$n";
          final s = m[code];
          final off = s?["off"] == true; // ㉖⑫ 停用台灰显
          final alias = (s?["alias"] ?? "").toString();
          final role = roleCn[(s?["role"] ?? "any").toString()] ?? "通用";
          final st = off ? "已停用" : (s?["state"]?.toString() ?? "空闲");
          final c = off ? Colors.blueGrey : cOf(st);
          final tl = AgvApi.stationTimeline(s);
          final tOut = (AgvApi.asNum(s?["todayOut"]) ?? 0).toInt();
          final tIn = (AgvApi.asNum(s?["todayIn"]) ?? 0).toInt();
          final _ha = (AgvApi.asNum(s?["holdAvg"]) ?? 0).toInt();
          final hAvg = _ha > 0 ? _ha : (_holdAvg[code] ?? 0);
          final _inspL = (s?["inspOrders"] as List?) ?? const [];
          final _tfM = s?["tfLedger"] as Map?;
          // 逻辑挂单徽标（v198g 语义不变）：物理空闲≠可用——检验工单挂着/拉下架送达待搬都点名
          final badges = [
            if (_inspL.isNotEmpty)
              "🔎检验${_inspL.map((e) => ((e as Map?)?["code"] ?? "")).take(2).join(" ")}${_inspL.length > 2 ? "等${_inspL.length}单" : ""}",
            if (_tfM != null)
              "⬇️待搬${((_tfM["codes"] as List?) ?? const []).join(" ")}",
          ];
          // 状态明细行：有货=货位/货名+到站+预计清台；占用=方向+时间线；空闲=可行动提示
          final sub = st == "有货"
              ? "货位 ${s?["label"] ?? "-"}${(s?["goods"] ?? "").toString().isNotEmpty ? " · ${s?["goods"]}" : ""} · 到站 ${AgvApi.fmtT(s?["since"])}${hAvg > 0 ? " · 预计约 ${hAvg} 分钟清台" : ""}"
              : (st == "占用中"
                  ? "${s?["dir"] == "in" ? "入库取走中" : "出库在途"}${(s?["via"] ?? "").toString().isNotEmpty ? " ${s?["via"]}" : ""}${tl.isNotEmpty ? " · $tl" : (AgvApi.asNum(s?["putAt"]) ?? 0) == 0 ? " · 进行中" : ""}"
                  : (st == "待核实" // ㉖v286 到站框号未确认：占派车窗30分钟内自动复核
                      ? "到站待核实 · 框号未确认，暂不派新单"
                      : (off
                          ? "已停用 · 叫车选台自动排除"
                          : "可正常叫车/入库${tl.isNotEmpty ? " · $tl" : ""}")));
          return GestureDetector(
              onTap: () => _stDetail(code), // ㉖⑯ 点横条弹站台详情（吞吐/占用明细/身份编辑）
              child: Container(
                  decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(9),
                      border: Border.all(color: c.withOpacity(0.35), width: 1),
                      boxShadow: const [
                        BoxShadow(
                            color: Color(0x0A000000),
                            blurRadius: 3,
                            offset: Offset(0, 1))
                      ]),
                  clipBehavior: Clip.antiAlias,
                  child: IntrinsicHeight(
                      child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                        Container(width: 4, color: c), // 左状态色条：空闲绿/占用蓝/有货橙，快扫定位
                        Expanded(
                            child: Padding(
                                padding:
                                    const EdgeInsets.fromLTRB(9, 6, 6, 6),
                                child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Row(children: [
                                        Icon(off ? Icons.block : iOf(st),
                                            size: 15, color: c),
                                        const SizedBox(width: 5),
                                        Text(
                                            alias.isEmpty
                                                ? "$n号台"
                                                : "$alias·$n号",
                                            style: const TextStyle(
                                                fontWeight: FontWeight.bold,
                                                fontSize: 14)),
                                        const SizedBox(width: 5),
                                        Text(role,
                                            style: TextStyle(
                                                fontSize: 9.5,
                                                fontWeight: FontWeight.w600,
                                                color: role == "通用"
                                                    ? Colors.blueGrey
                                                    : const Color(
                                                        0xFF1565C0))),
                                        const Spacer(),
                                        Text(st,
                                            style: TextStyle(
                                                color: c,
                                                fontWeight: FontWeight.bold,
                                                fontSize: 13)),
                                        if (st == "有货" && _canCtl)
                                          GestureDetector(
                                              behavior:
                                                  HitTestBehavior.opaque,
                                              onTap: () =>
                                                  _clearStation(code),
                                              child: const Padding(
                                                  padding: EdgeInsets.fromLTRB(
                                                      10, 2, 4, 2),
                                                  child: Text("清台",
                                                      style: TextStyle(
                                                          fontSize: 12,
                                                          color: Color(
                                                              0xFF1565C0),
                                                          fontWeight:
                                                              FontWeight
                                                                  .bold)))),
                                        if (st == "空闲" &&
                                            _canCtl &&
                                            !off)
                                          GestureDetector(
                                              behavior:
                                                  HitTestBehavior.opaque,
                                              onTap: () =>
                                                  _markBusy(code),
                                              child: const Padding(
                                                  padding: EdgeInsets.fromLTRB(
                                                      10, 2, 4, 2),
                                                  child: Text("标记占用",
                                                      style: TextStyle(
                                                          fontSize: 11.5,
                                                          color: Color(
                                                              0xFFE65100),
                                                          fontWeight:
                                                              FontWeight
                                                                  .bold)))),
                                      ]),
                                      const SizedBox(height: 2),
                                      Text(sub,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: TextStyle(
                                              fontSize: 11,
                                              height: 1.25,
                                              color: st == "空闲" || off
                                                  ? Colors.blueGrey
                                                  : c)),
                                      if (badges.isNotEmpty ||
                                          tOut + tIn > 0 ||
                                          hAvg > 0)
                                        Padding(
                                            padding:
                                                const EdgeInsets.only(top: 3),
                                            child: Wrap(
                                                spacing: 6,
                                                runSpacing: 2,
                                                children: [
                                                  Text(
                                                      "今出 $tOut · 今回 $tIn",
                                                      style: const TextStyle(
                                                          fontSize: 10,
                                                          color: Color(
                                                              0xFF607D8B))),
                                                  if (hAvg > 0)
                                                    Text(
                                                        "均清台 ${hAvg >= 60 ? "${(hAvg / 60).toStringAsFixed(1)}时" : "$hAvg分"}",
                                                        style: const TextStyle(
                                                            fontSize: 10,
                                                            color: Color(
                                                                0xFFB26A00),
                                                            fontWeight:
                                                                FontWeight
                                                                    .w600)),
                                                  for (final b in badges)
                                                    Text(b,
                                                        style: const TextStyle(
                                                            fontSize: 10,
                                                            color: Color(
                                                                0xFFB26A00),
                                                            fontWeight:
                                                                FontWeight
                                                                    .w600)),
                                                ])),
                                    ])
                                ))
                            ]))));
        });
  }

  // ---- ㉖⑯ 站台详情弹层（网页看板搬到 PDA：今日吞吐/平均清台/占用明细/身份编辑）----
  Future<void> _stDetail(String code) async {
    Map? d;
    try {
      final j = await AuthApi.stBoard();
      final list = (j["list"] as List?)?.whereType<Map>() ?? [];
      for (final x in list) {
        if (x["code"]?.toString() == code) {
          d = x;
          break;
        }
      }
    } catch (_) {}
    if (!mounted) return;
    if (d == null) {
      _toast("站台数据加载失败");
      return;
    }
    final dd = d; // 闭包内不可直接用可空 d（非最终变量无空安全提升）
    final alias = (dd["alias"] ?? "").toString();
    final role = (dd["role"] ?? "any").toString();
    final off = dd["off"] == true;
    final st = off ? "已停用" : (dd["state"]?.toString() ?? "空闲");
    const roleCn = {"any": "通用", "out": "出库专用", "in": "入库专用", "insp": "检验专用"};
    Color cOf(String s) => s == "有货"
        ? const Color(0xFFE65100)
        : (s == "占用中" ? const Color(0xFF1565C0) : Colors.green);
    final cc = off ? Colors.blueGrey : cOf(st);
    final q = (d["queue"] as List?)?.whereType<Map>() ?? [];
    final isp = (d["insp"] as List?)?.whereType<Map>() ?? [];
    const inspCn = {
      "waitOut": "🤝待协助下架",
      "toStation": "下架途中",
      "atStation": "站台待检",
      "waitBack": "🤝待协助归位",
      "returning": "归位途中",
      "waitReturn": "🔁待退货出账"
    };
    await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(16))),
        builder: (ctx) => Padding(
            padding: const EdgeInsets.fromLTRB(18, 14, 18, 22),
            child: SingleChildScrollView(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                  Row(children: [
                    Container(
                        width: 11,
                        height: 11,
                        decoration:
                            BoxDecoration(color: cc, shape: BoxShape.circle)),
                    const SizedBox(width: 8),
                    Expanded(
                        child: Text(
                            alias.isEmpty
                                ? code
                                : "$alias  (${code.split("-").last}号台)",
                            style: const TextStyle(
                                fontSize: 17, fontWeight: FontWeight.bold))),
                    Text(st,
                        style: TextStyle(
                            color: cc,
                            fontWeight: FontWeight.bold,
                            fontSize: 14))
                  ]),
                  const SizedBox(height: 4),
                  Text(
                      "用途 ${roleCn[role] ?? role} · 编码 $code${off ? " · 已停用（不参与任何分配）" : ""}",
                      style: const TextStyle(
                          fontSize: 11.5, color: Colors.blueGrey)),
                  const SizedBox(height: 12),
                  Row(children: [
                    _stStat("今日出库", "${dd["todayOut"] ?? 0}", "框"),
                    _stStat("今日入库", "${dd["todayIn"] ?? 0}", "框"),
                    _stStat(
                        "平均清台",
                        (dd["holdAvg"] ?? 0) > 0 ? "${dd["holdAvg"]}" : "-",
                        "分钟"),
                  ]),
                  const SizedBox(height: 12),
                  if (st == "有货")
                    Text(
                        "📦 框在台待清：${dd["label"] ?? "-"}${(dd["goods"] ?? "").toString().isNotEmpty ? " · ${dd["goods"]}" : ""}${(dd["codes"] as List?)?.isNotEmpty == true ? " · 共 ${(dd["codes"] as List).length} 框" : ""} · 扫码后自动叉回",
                        style: const TextStyle(fontSize: 12.5)),
                  if (st == "占用中" && (dd["via"] ?? "").toString().isNotEmpty)
                    Text(
                        "🤖 AGV 搬运中（${dd["dir"] == "in" ? "入库取走" : "出库送达"}）· 任务 ${dd["via"]}",
                        style: const TextStyle(fontSize: 12.5)),
                  if (st == "占用中" && dd["manual"] == true)
                    const Text("✋ 人工占用（叫车拦截中）",
                        style: TextStyle(fontSize: 12.5)),
                  if (q.isEmpty && isp.isEmpty && st == "空闲")
                    const Text("✅ 当前无占用，可正常叫车/入库",
                        style: TextStyle(fontSize: 12.5, color: Colors.green)),
                  if (q.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text("排队队列（${q.length}）",
                        style: const TextStyle(
                            fontSize: 12, fontWeight: FontWeight.bold)),
                    ...q.map((e) => Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                            "· ${e["code"] ?? "-"} · ${(e["state"] ?? "").toString()}${(e["by"] ?? "").toString().isNotEmpty ? " · ${e["by"]}" : ""}${(e["reqNo"] ?? "").toString().isNotEmpty ? " · 单${e["reqNo"]}" : ""}",
                            style: const TextStyle(
                                fontSize: 11.5, color: Colors.black87)))),
                  ],
                  if (isp.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text("检验占用（${isp.length}）",
                        style: const TextStyle(
                            fontSize: 12, fontWeight: FontWeight.bold)),
                    ...isp.map((e) => Padding(
                        padding: const EdgeInsets.only(top: 3),
                        child: Text(
                            "· ${e["code"] ?? "-"} · ${inspCn[e["state"]] ?? e["state"] ?? ""}${(e["by"] ?? "").toString().isNotEmpty ? " · ${e["by"]}" : ""}",
                            style: const TextStyle(
                                fontSize: 11.5, color: Colors.black87)))),
                  ],
                  if (_canCtl) ...[
                    const SizedBox(height: 16),
                    SizedBox(
                        width: double.infinity,
                        child: FilledButton.tonalIcon(
                            onPressed: () {
                              Navigator.pop(ctx);
                              _stCfg(code, alias, role, off);
                            },
                            icon: const Icon(Icons.tune, size: 18),
                            label: const Text("编辑站台身份（别名/用途/停用）"))),
                  ] else
                    const SizedBox(height: 6),
                ]))));
  }

  Widget _stStat(String k, String v, String unit) => Expanded(
          child: Column(children: [
        Text(v,
            style: const TextStyle(fontSize: 19, fontWeight: FontWeight.bold)),
        Text("$k($unit)",
            style: const TextStyle(fontSize: 10.5, color: Colors.blueGrey))
      ]));

  // ---- ㉖⑯ 编辑站台身份：别名/用途/停用，保存后全端生效 ----
  Future<void> _stCfg(
      String code, String alias0, String role0, bool off0) async {
    final ac = TextEditingController(text: alias0);
    var role = role0, off = off0;
    const roleCn = {"any": "通用", "out": "出库专用", "in": "入库专用", "insp": "检验专用"};
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => StatefulBuilder(
            builder: (ctx, setS) => AlertDialog(
                  title: Text("站台设置 · ${code.split("-").last}号台"),
                  content: Column(mainAxisSize: MainAxisSize.min, children: [
                    TextField(
                        controller: ac,
                        maxLength: 12,
                        decoration: const InputDecoration(
                            labelText: "别名（留空恢复默认编码）",
                            hintText: "如：一号发货台 / 退货暂存",
                            counterText: "")),
                    const SizedBox(height: 6),
                    DropdownButtonFormField<String>(
                        value: role,
                        decoration: const InputDecoration(labelText: "用途"),
                        items: roleCn.entries
                            .map((e) => DropdownMenuItem(
                                value: e.key, child: Text(e.value)))
                            .toList(),
                        onChanged: (v) => setS(() => role = v ?? role)),
                    SwitchListTile(
                        contentPadding: EdgeInsets.zero,
                        title:
                            const Text("停用此站台", style: TextStyle(fontSize: 14)),
                        subtitle: const Text("停用后不参与任何自动分配",
                            style: TextStyle(fontSize: 11)),
                        value: off,
                        onChanged: (v) => setS(() => off = v)),
                  ]),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, false),
                        child: const Text("取消")),
                    FilledButton(
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text("保存"))
                  ],
                )));
    if (ok != true || !mounted) return;
    try {
      final r = await AuthApi.stMeta(code,
          alias: ac.text.trim(), role: role, off: off);
      if (r["ok"] == true) {
        _toast("✅ 站台设置已保存（全端生效）");
        _load(silent: true);
      } else {
        _toast("保存失败：${r["msg"] ?? "未知错误"}");
      }
    } catch (e) {
      _toast("保存失败：$e");
    }
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

  Future<void> _cancelTransfer(Map q) async {
    final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("取消移库", style: TextStyle(color: Colors.red)),
              content: Text(
                  "取消移库 ${(q["from"] ?? "?")} → ${(q["to"] ?? "?")}？\n\n若AGV已叉出货架则无法撤回，需人工归位。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(ctx, false),
                    child: const Text("再想想")),
                FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: Colors.red),
                    onPressed: () => Navigator.pop(ctx, true),
                    child: const Text("确认取消"))
              ],
            ));
    if (yes != true || !mounted) return;
    final r = await AuthApi.agvTransferCancel((q["at"] ?? "").toString());
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ ${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
    LocalLog.op('移库取消', r["ok"] == true ? '已请求取消' : '取消失败');
  }

  /// ㉖v198g 拉下架「人已移走收口」：AGV 已把框放上站台（已下发≈已在送/已到台，到站=已送达），
  /// 人把框搬去地面/货架后 → 去向弹层（检验收口同款，可选地面空格）→ 二次确认 →
  /// 账本随单改位（整框随改）+ 队列项收口 + 站台立即释放。
  Future<void> _removeTransfer(Map q) async {
    final code = (q["code"] ?? "").toString();
    final stn = (q["to"] ?? "").toString();
    if (!mounted) return;
    final loc = await removeLocDialog(context, code, stn.isEmpty ? "站台" : stn);
    if (loc == null || loc.trim().isEmpty || !mounted) return;
    final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
                title: const Text("确认人工收口", style: TextStyle(fontSize: 16)),
                content: Text(
                    "确认 $code 已由人工搬离 ${stn.isEmpty ? "站台" : stn}，现实际在 $loc ？\n\n"
                    "将同时完成：账本改位→$loc（整框标签随改）＋ 拉下架任务结束 ＋ 站台立即释放，并记入审计。"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text("返回")),
                  FilledButton(
                      style: FilledButton.styleFrom(
                          backgroundColor: const Color(0xFFEF6C00)),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: const Text("确认收口",
                          style: TextStyle(color: Colors.white)))
                ]));
    if (yes != true || !mounted) return;
    final r = await AuthApi.agvTransferRemove(
        id: (q["at"] ?? "").toString(), code: code, station: stn, loc: loc);
    if (!mounted) return;
    _toast(r["ok"] == true ? "✅ ${r["msg"]}" : "❌ 收口失败：${r["msg"]}");
    if (r["ok"] == true) _load(silent: true);
    LocalLog.op('拉下架收口', r["ok"] == true ? '$code→$loc 已收口' : '$code 收口失败');
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
      OutlinedButton.icon(
          icon: const Icon(Icons.map, size: 18, color: Color(0xFF00897B)),
          label: const Text("AGV 实时地图（网页版·横屏·捏合缩放）",
              style: TextStyle(fontSize: 12, color: Color(0xFF00897B))),
          onPressed: () => Navigator.push(context,
              MaterialPageRoute(builder: (_) => const AgvWebMapPage()))),
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

// ===================== ㉖v123c 网页版AGV实时地图（WebView横屏）：/agvmap 独立移动端页，捏合精细缩放/平移/点选明细 =====================
class AgvWebMapPage extends StatefulWidget {
  const AgvWebMapPage({super.key});
  @override
  State<AgvWebMapPage> createState() => _AgvWebMapPageState();
}

class _AgvWebMapPageState extends State<AgvWebMapPage> {
  late final WebViewController _ctrl;
  bool _loading = true;
  String _err = "";

  @override
  void initState() {
    super.initState();
    // 进入本页强制横屏，退出恢复全方向（项目内首个方向锁，成对设置防泄漏到其它页面）
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0B1220))
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) {
          if (mounted) setState(() => _loading = true);
        },
        onWebResourceError: (e) {
          if (e.errorCode >= -4) return; // 子资源小错忽略
          if (mounted)
            setState(() {
              _loading = false;
              _err = "页面加载失败：${e.description ?? "网络异常"}（确认服务器已更新并重启）";
            });
        },
        onPageFinished: (_) {
          if (mounted) setState(() => _loading = false);
        },
      ));
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    super.dispose();
  }

  Future<void> _boot() async {
    setState(() {
      _err = "";
      _loading = true;
    });
    final base = (await AuthStore.serverUrl()).replaceFirst(RegExp(r"/+$"), "");
    if (base.isEmpty) {
      if (mounted) setState(() => _err = "未配置服务器地址（先去「MES服务器设置」）");
      return;
    }
    // 与 ConsoleWebPage 同模式：原生会话换发不绑指纹的网页 token，?t= 免登录接管
    final j = await AuthApi.webSession();
    final tk = j["ok"] == true ? (j["token"] ?? "").toString() : "";
    if (tk.isEmpty) {
      if (mounted) setState(() => _err = "会话换发失败：${j["msg"] ?? "请重新登录后再试"}");
      return;
    }
    await _ctrl
        .loadRequest(Uri.parse("$base/agvmap?t=${Uri.encodeComponent(tk)}"));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
          child: Stack(children: [
        WebViewWidget(controller: _ctrl),
        Positioned(
          top: 4,
          left: 6,
          child: GestureDetector(
              onTap: () => Navigator.pop(context),
              child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                  decoration: BoxDecoration(
                      color: const Color(0xCC101A2E),
                      borderRadius: BorderRadius.circular(6)),
                  child: const Text("← 返回",
                      style: TextStyle(color: Colors.white, fontSize: 12)))),
        ),
        if (_loading)
          const Center(child: CircularProgressIndicator(color: Colors.cyan)),
        if (_err.isNotEmpty)
          Center(
              child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(_err,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                          color: Color(0xFFFF8A80), fontSize: 13)))),
      ])),
    );
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
  bool _yielding = false; // ㉖v161 是否处于「退出登录让位中」：决定按钮显示 退出登录/恢复登录

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      final cfg = await AgvConfig.get();
      // ㉖v161 读取让位状态（await 必须在 setState 外）
      final yld = await AgvAuthYield.on();
      final left = yld ? await AgvAuthYield.leftMin() : 0;
      if (!mounted) return;
      setState(() {
        _hostCtrl.text = cfg["host"] ?? AgvConfig.defaultHost;
        _portalCtrl.text = cfg["portal"] ?? AgvConfig.defaultPortal;
        _accCtrl.text = cfg["account"] ?? "";
        _pwdCtrl.text = cfg["pwd"] ?? "";
        _yielding = yld;
        if (yld) {
          _ok = true;
          _msg = AgvAuthYield.msgOf(left);
        }
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
    // ㉖v162 旧实现只写本机就报"已保存"：服务器轮询 RCS、代发 AGV 叫车用的都是它自己那份凭据，
    // 不推过去=改了等于没改（与 WMAS 设置页同一缺陷）。同步失败必须显式警告，不能让绿色"已保存"掩盖。
    final err = await agvSyncBothToServer(alsoRcs: true);
    if (!mounted)
      return; // ㉖v98b 保存为await，期间弹窗可能已关：setState前守卫（v97 PDA-34660同款病）
    final yld = await AgvAuthYield.on();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ok = err == null;
      _yielding = yld;
      _msg = err == null
          ? "已保存并同步服务器（服务器代轮询 RCS / 代发叫车，配置已生效）"
          : "⚠️ $err。叫车与到站催扫由服务器发起，仍会用旧凭据失败";
    });
  }

  /// ㉖v161 退出 / 恢复登录（与 WMAS 设置页共用 agvAuthToggle，方向按当前让位状态自动判别）
  Future<void> _logout() async {
    setState(() {
      _busy = true;
      _msg = "";
    });
    // ㉖v161 方向（退出 / 恢复）由 agvAuthToggle 按当前状态判别，与 WMAS 设置页共用同一入口
    final r = await agvAuthToggle(context);
    if (!mounted) return;
    if (r['cancelled'] == true) {
      setState(() => _busy = false); // 用户取消：任何一侧状态都没动过
      return;
    }
    final yielding = await AgvAuthYield.on(); // 以本机最终状态判定，不靠文案猜
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ok = r['ok'] == true;
      _msg = r['msg']?.toString() ?? '';
    });
    if (_ok) _yielding = yielding;
  }

  Future<void> _test() async {
    setState(() {
      _busy = true;
      _msg = "保存并同步…";
    });
    await AgvConfig.save(
        host: _hostCtrl.text,
        portal: _portalCtrl.text,
        account: _accCtrl.text,
        pwd: _pwdCtrl.text);
    // ㉖v162 ①同步不再挂在"本机 RCS 登录成功"之后：本机连不上调度系统与"服务器该换新凭据"是两件
    //   独立的事，旧写法让 RCS 离线时 WMAS 新密码也永远推不到服务器（与 11-12 同一类病）。
    // ②旧写法同步失败只 debugPrint，界面照样显示"凭据已同步"= 误导性提示，现场据此以为好了。
    final err = await agvSyncBothToServer(alsoRcs: true);
    if (!mounted) return;
    if (err != null && await AgvAuthYield.on()) {
      // 服务器没更新且仍在让位期 → 本机登录成功也毫无意义（叫车由服务器发起），
      // 而且会把现场人员正在用的会话踢掉。绝不登录，如实说明。
      setState(() {
        _busy = false;
        _ok = false;
        _msg = "未执行登录：$err，且当前处于退出登录让位期（登录会把现场正在用的会话踢掉）";
      });
      return;
    }
    setState(() => _msg = "登录中…");
    final t = await AgvApi.login();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _ok = t != null && err == null;
      // 本机通 / 服务器通 两个维度分开讲：绿色"成功"绝不能掩盖服务器仍在用旧凭据
      _msg = t == null
          ? "登录失败：检查地址/账号/密码（或AGV系统离线）${err == null ? '' : "；另：$err"}"
          : (err == null
              ? "登录成功 ✅ token已缓存（12小时）；服务器轮询+调度器凭据已同步"
              : "⚠️ 本机登录成功（凭据是对的），但 $err——叫车与到站催扫由服务器发起，仍会失败，请按提示处理");
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
            const SizedBox(width: 10),
            Expanded(
                // ㉖v161 退出/恢复登录：与 WMAS 设置页同一入口（账号被网页端共用时反复 401，退出=服务器与本机一起让位）；
                // 让位中本按钮变「恢复登录」，免得现场以为只能等到期或重启服务器才能叫车。
                child: OutlinedButton(
                    onPressed: _busy ? null : _logout,
                    style: OutlinedButton.styleFrom(
                        foregroundColor: _yielding
                            ? const Color(0xFF00897B)
                            : const Color(0xFFB71C1C),
                        side: BorderSide(
                            color: _yielding
                                ? const Color(0xFF00897B)
                                : const Color(0xFFB71C1C))),
                    child: Text(_yielding ? "恢复登录" : "退出登录"))),
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

/// 货架移库（货位→货位 / 货位→地面暂存）：表单 → 二次确认 → 服务器建CARRY任务
Future<void> showTransferDialog(BuildContext context,
    {void Function()? onDone}) async {
  final fromC = TextEditingController(), palC = TextEditingController();
  bool dry = false; // ㉖v197 原 toGround 勾选随"地面直送"伪功能移除
  // ㉖v198d 终点三模式（对齐检验下架）：0=自动分配空闲台（服务器判据下发时刻现算）
  // 1=手动指定CK站台（清单来自 /api/agv/transfer-stations，占用台带原因灰显）
  // 2=手填货架格（NB02 货架→货架移库旧能力保留）
  int toMode = 0;
  String pickedStn = "";
  final toShelfC = TextEditingController();
  List<Map> stnList = [];
  bool stnLoading = false;
  String stnErr = "";
  List<String> pickedBoxes = []; // ㉖v199 弹窗→外层带出的勾选框列表（起点框留空时批量下发）
  // ㉖v199 选框（用户实需：弹窗里没有零件号输入处、没有项目批量下拉）：
  // 零件/标签模糊查 或 项目批量下拉 → 结果列表勾选 → 起点自动回填/多框批量下发。
  // 行判据与网页 pjmvFill 逐字同口径（项目→零件号集 + /^NB02-/ + 排 -CK-|-RK- 台挂行）。
  final qC = TextEditingController();
  final projCodes = <Map>[]; // [{code,nm}]
  Map<String, List> projMap = {}; // 零件→项目码列表
  bool projLoaded = false;
  String projErr = "";
  String projSel = "";
  List<Map> rows = []; // [{l,pn,nm,codes:[..]}]
  final sel = <String>{}; // 勾选的货架格位集合（默认全选）
  bool rowsLoading = false;
  String rowsErr = "";
  InputDecoration di(String hint) => InputDecoration(
      isDense: true, border: const OutlineInputBorder(), hintText: hint);
  final choice = await showDialog<String>(
      context: context,
      builder: (ctx) => StatefulBuilder(builder: (ctx2, setDlg) {
            Future<void> loadStns() async {
              setDlg(() {
                stnLoading = true;
                stnErr = "";
              });
              final r = await AuthApi.agvTransferStations();
              setDlg(() {
                stnLoading = false;
                if (r["ok"] == true && r["list"] is List) {
                  stnList = (r["list"] as List).whereType<Map>().toList();
                } else {
                  stnErr = r["msg"]?.toString() ?? "站台清单拉取失败";
                }
              });
            }

            // 项目字典（码表+映射）：首次展开批量下拉时懒加载，失败可重试（网页 pjLoad 同款）
            Future<void> loadProj() async {
              setDlg(() {
                projErr = "";
              });
              final r = await AuthApi.projDict();
              setDlg(() {
                if (r["ok"] == true) {
                  projLoaded = true;
                  projCodes
                    ..clear()
                    ..addAll(((r["list"] as List?) ?? []).whereType<Map>());
                  projMap = ((r["map"] as Map?) ?? {}).map(
                      (k, v) => MapEntry(k.toString(), (v as List?) ?? []));
                  if (projCodes.isEmpty) projErr = "项目字典为空（先到网页「项目映射」维护）";
                } else {
                  projErr = r["msg"]?.toString() ?? "项目字典拉取失败";
                }
              });
            }

            // 选框查询：项目码→零件号集→账本在架货架行（判据与网页 pjmvFill 逐字一致）
            Future<void> doSearch(String mode) async {
              if (mode == "q" && qC.text.trim().isEmpty && projSel.isEmpty) {
                setDlg(() {
                  rowsErr = "输入零件号/标签查询，或用上方项目批量下拉";
                  rows = [];
                });
                return;
              }
              setDlg(() {
                rowsLoading = true;
                rowsErr = "";
                rows = [];
                sel.clear();
              });
              List items = [];
              final tfL = <String>{}, tfC = <String>{}; // ㉖v199e 在途移库起点/框码（与网页 pjmvFill 同判据）：已在拉下架途中的框不再列出，勾了才被服务器双闸拒=误导
              try {
                final r = mode == "proj"
                    ? await AuthApi.ledgerGet()
                    : await AuthApi.ledgerFuzzy(qC.text.trim());
                items = (r["items"] as List?) ?? [];
                for (final t in (r["inTf"] as List? ?? []).whereType<Map>()) {
                  tfL.add((t["from"] ?? "").toString().toUpperCase());
                  tfC.add((t["code"] ?? "").toString().toUpperCase());
                }
              } catch (_) {
                setDlg(() {
                  rowsLoading = false;
                  rowsErr = "账本拉取失败（服务器不通？）";
                });
                return;
              }
              Set<String>? pns;
              if (mode == "proj") {
                pns = {};
                for (final e in projMap.entries) {
                  if (e.value
                      .map((c) => c.toString().toUpperCase())
                      .contains(projSel)) pns.add(e.key.toUpperCase());
                }
              }
              final bx = <String, Map>{};
              for (final it in items.whereType<Map>()) {
                final pn = (it["p"] ?? "").toString().toUpperCase();
                final l = (it["l"] ?? "").toString().toUpperCase();
                if (!l.startsWith("NB02-") ||
                    l.contains("-CK-") ||
                    l.contains("-RK-") ||
                    tfL.contains(l) ||
                    tfC.contains((it["c"] ?? "").toString().toUpperCase()))
                  continue; // 在架AGV货架框才有拉下架意义（台挂=待搬、地面/来料=AGV通道不适用）；㉖v199e 排已在途（排队/下发中/已下发）起点与框码（与网页pjmvFill逐字同口径）
                if (pns != null && !pns.contains(pn)) continue;
                final b = bx.putIfAbsent(
                    l,
                    () => {
                          "l": l,
                          "pn": pn,
                          "nm": (it["n"] ?? "").toString(),
                          "codes": <String>[]
                        });
                (b["codes"] as List)
                    .add((it["c"] ?? "").toString().toUpperCase());
              }
              rows = bx.values.toList()
                ..sort((a, b) => a["l"].compareTo(b["l"]));
              sel.addAll(rows.map((x) => x["l"] as String)); // 默认全选（网页同款）
              setDlg(() {
                rowsLoading = false;
                rowsErr = rows.isEmpty
                    ? (mode == "proj"
                        ? "该项目当前没有在架货架框（都在地面/来料区或已出库）"
                        : "没有匹配「${qC.text.trim()}」的在架货架框")
                    : "";
              });
            }

            return AlertDialog(
              title: const Text("🔄 货架移库 / 拉下架"),
              content: SingleChildScrollView(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                TextField(
                    controller: fromC,
                    textCapitalization: TextCapitalization.characters,
                    decoration: di("起点货架格（可留空，用下方选框代替）")),
                const SizedBox(height: 8),
                // —— ㉖v199 选框区：零件/标签模糊 或 项目批量（用户点名缺的两样）——
                Row(children: [
                  Expanded(
                    child: TextField(
                        controller: qC,
                        textCapitalization: TextCapitalization.characters,
                        onSubmitted: (_) => doSearch("q"),
                        decoration: di("🔍 零件号/标签模糊查（回车）")),
                  ),
                  const SizedBox(width: 6),
                  ElevatedButton(
                      style: ElevatedButton.styleFrom(
                          visualDensity: VisualDensity.compact),
                      onPressed: rowsLoading
                          ? null
                          : () => doSearch(
                              qC.text.trim().isEmpty && projSel.isNotEmpty
                                  ? "proj"
                                  : "q"),
                      child:
                          const Text("查询", style: TextStyle(fontSize: 12.5))),
                ]),
                const SizedBox(height: 6),
                // 项目批量下拉（懒加载字典；选中即出该项目全部在架框列表）
                InkWell(
                  onTap: () async {
                    if (!projLoaded && projErr.isEmpty) await loadProj();
                    if (!context.mounted) return;
                    final pick = await showModalBottomSheet<String>(
                        context: context,
                        isScrollControlled: true,
                        builder: (bc) => SafeArea(
                            child: SizedBox(
                                height: 340,
                                child: projErr.isNotEmpty
                                    ? Center(
                                        child: Column(
                                            mainAxisAlignment:
                                                MainAxisAlignment.center,
                                            children: [
                                            Text(projErr,
                                                style: const TextStyle(
                                                    fontSize: 12,
                                                    color: Colors.orange)),
                                            TextButton(
                                                onPressed: () =>
                                                    Navigator.pop(bc),
                                                child: const Text("关闭")),
                                          ]))
                                    : Column(children: [
                                        Padding(
                                          padding: const EdgeInsets.symmetric(
                                              vertical: 8),
                                          child: Text("按项目批量选框",
                                              style: const TextStyle(
                                                  fontWeight: FontWeight.bold)),
                                        ),
                                        Expanded(
                                            child: ListView(
                                                shrinkWrap: true,
                                                children: [
                                              for (final p in projCodes)
                                                ListTile(
                                                  dense: true,
                                                  leading: const Icon(
                                                      Icons
                                                          .folder_copy_outlined,
                                                      size: 18),
                                                  title: Text(
                                                      "${p["code"]}${(p["nm"] ?? "").toString().isNotEmpty ? " · ${p["nm"]}" : ""}",
                                                      style: const TextStyle(
                                                          fontSize: 13.5)),
                                                  onTap: () => Navigator.pop(
                                                      bc, p["code"].toString()),
                                                ),
                                            ])),
                                      ]))));
                    if (pick != null && pick.isNotEmpty) {
                      setDlg(() => projSel = pick);
                      await doSearch("proj");
                    }
                  },
                  child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(
                          horizontal: 10, vertical: 9),
                      decoration: BoxDecoration(
                          border: Border.all(color: Colors.grey.shade400),
                          borderRadius: BorderRadius.circular(6)),
                      child: Row(children: [
                        const Icon(Icons.folder_copy_outlined,
                            size: 16, color: Colors.blueGrey),
                        const SizedBox(width: 6),
                        Expanded(
                            child: Text(
                                projSel.isEmpty
                                    ? "项目批量下拉：选项目码 → 该项目全部在架框"
                                    : "项目：$projSel（重选可换）",
                                style: TextStyle(
                                    fontSize: 12.5,
                                    color: projSel.isEmpty
                                        ? Colors.grey
                                        : Colors.black87))),
                        const Icon(Icons.arrow_drop_down,
                            size: 20, color: Colors.grey),
                      ])),
                ),
                // 选框结果：勾选=要拉的框（默认全选）。起点框留空时按勾选批量下发；
                // 起点框填了值则单框模式（勾选区忽略）。
                if (rowsLoading)
                  const Padding(
                      padding: EdgeInsets.all(10),
                      child: LinearProgressIndicator())
                else if (rows.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Container(
                      constraints: const BoxConstraints(maxHeight: 190),
                      decoration: BoxDecoration(
                          border: Border.all(color: Colors.grey.shade300),
                          borderRadius: BorderRadius.circular(6)),
                      child: Column(children: [
                        Padding(
                            padding: const EdgeInsets.fromLTRB(8, 6, 8, 2),
                            child: Row(children: [
                              Text(
                                  "在架 ${rows.length} 框 · 已选 ${sel.length}（台满自动排队接力）",
                                  style: const TextStyle(
                                      fontSize: 11.5,
                                      color: Colors.blueGrey,
                                      fontWeight: FontWeight.w600)),
                              const Spacer(),
                              TextButton(
                                  style: TextButton.styleFrom(
                                      visualDensity: VisualDensity.compact,
                                      padding: EdgeInsets.zero),
                                  onPressed: () => setDlg(() {
                                        if (sel.length == rows.length) {
                                          sel.clear();
                                        } else {
                                          sel.addAll(rows
                                              .map((x) => x["l"] as String));
                                        }
                                      }),
                                  child: Text(
                                      sel.length == rows.length ? "全不选" : "全选",
                                      style: const TextStyle(fontSize: 12))),
                            ])),
                        Expanded(
                            child: ListView.builder(
                                shrinkWrap: true,
                                itemCount: rows.length,
                                itemBuilder: (_, i) {
                                  final x = rows[i];
                                  final cs = (x["codes"] as List);
                                  return CheckboxListTile(
                                    dense: true,
                                    visualDensity: VisualDensity.compact,
                                    contentPadding: const EdgeInsets.symmetric(
                                        horizontal: 8),
                                    controlAffinity:
                                        ListTileControlAffinity.leading,
                                    value: sel.contains(x["l"]),
                                    onChanged: (v) => setDlg(() {
                                      if (v == true) {
                                        sel.add(x["l"] as String);
                                      } else {
                                        sel.remove(x["l"]);
                                      }
                                    }),
                                    title: Text(
                                        "${x["l"]}　${x["pn"]}${(x["nm"] ?? "").toString().isNotEmpty ? " ${x["nm"]}" : ""}",
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                            fontSize: 12.5,
                                            fontFamily: "monospace")),
                                    subtitle: Text(
                                        "标签 ${cs.take(2).join(' ')}${cs.length > 2 ? ' 等${cs.length}码' : ''}",
                                        style: const TextStyle(
                                            fontSize: 10.5,
                                            color: Colors.grey)),
                                  );
                                })),
                      ])),
                ] else if (rowsErr.isNotEmpty)
                  Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(rowsErr,
                          style: const TextStyle(
                              fontSize: 11.5, color: Colors.orange))),
                const SizedBox(height: 10),
                // —— 终点模式三选（检验下架同款：可自动、可手动、留痕透明）——
                Row(children: [
                  for (final e in [
                    const {"v": 0, "t": "自动分配空闲台"},
                    const {"v": 1, "t": "手动选CK站台"},
                    const {"v": 2, "t": "货架格（手填）"}
                  ]) ...[
                    ChoiceChip(
                        label: Text(e["t"] as String,
                            style: const TextStyle(fontSize: 12)),
                        selected: toMode == e["v"],
                        onSelected: (_) {
                          setDlg(() => toMode = e["v"] as int);
                          if (toMode == 1 && stnList.isEmpty && !stnLoading) {
                            loadStns();
                          }
                        }),
                    const SizedBox(width: 6),
                  ]
                ]),
                const SizedBox(height: 8),
                if (toMode == 0)
                  const Padding(
                      padding: EdgeInsets.symmetric(vertical: 4),
                      child: Text(
                          "下发时刻由服务器按空闲口径现算选台（未停用·非入库/检验专用·看板空闲·无队列与检验占台）；暂无空闲台时自动排队，台释放后按序发车。",
                          style: TextStyle(
                              fontSize: 11.5,
                              color: Colors.blueGrey,
                              height: 1.5))),
                if (toMode == 1)
                  Container(
                      constraints: const BoxConstraints(maxHeight: 230),
                      child: stnLoading
                          ? const Padding(
                              padding: EdgeInsets.all(14),
                              child: LinearProgressIndicator())
                          : stnErr.isNotEmpty
                              ? Column(children: [
                                  Text(stnErr,
                                      style: const TextStyle(
                                          fontSize: 12, color: Colors.orange)),
                                  TextButton(
                                      onPressed: loadStns,
                                      child: const Text("重试")),
                                ])
                              : ListView(shrinkWrap: true, children: [
                                  for (final s in stnList)
                                    ListTile(
                                      dense: true,
                                      visualDensity: VisualDensity.compact,
                                      enabled: s["ok"] == true,
                                      leading: Icon(
                                          s["ok"] == true
                                              ? Icons.pin_drop
                                              : Icons.pin_drop_outlined,
                                          size: 18,
                                          color: s["ok"] == true
                                              ? const Color(0xFF00897B)
                                              : Colors.grey),
                                      title: Text(
                                          "${s["alias"]?.toString().isNotEmpty == true ? "${s["alias"]} · " : ""}${s["code"]}",
                                          style: TextStyle(
                                              fontSize: 13.5,
                                              fontFamily: "monospace",
                                              color: s["ok"] == true
                                                  ? null
                                                  : Colors.grey,
                                              fontWeight: pickedStn == s["code"]
                                                  ? FontWeight.bold
                                                  : FontWeight.normal)),
                                      trailing: s["ok"] == true
                                          ? (pickedStn == s["code"]
                                              ? const Icon(Icons.check_circle,
                                                  size: 18,
                                                  color: Color(0xFF00897B))
                                              : null)
                                          : Text("${s["why"]}",
                                              style: const TextStyle(
                                                  fontSize: 11,
                                                  color: Colors.grey)),
                                      onTap: s["ok"] == true
                                          ? () {
                                              // ㉖v199e 修"选完台弹窗整个消失、报起点必填"（11-17 实锤）：
                                              // 旧 onTap 直接 pop(go) 是单框旧流程遗留——弹窗关了 pickedBoxes
                                              // 还没被底部按钮带出=空，外层判"起点空+无勾选"直接拒。
                                              // 现在只记选中态（该行即刻打✓），下发交底部按钮统一收口。
                                              setDlg(() => pickedStn =
                                                  s["code"].toString());
                                            }
                                          : null,
                                    ),
                                ])),
                if (toMode == 2)
                  TextField(
                      controller: toShelfC,
                      textCapitalization: TextCapitalization.characters,
                      decoration: di("目标货架格（如 NB02-B-12-3F）")),
                const SizedBox(height: 8),
                TextField(
                    controller: palC,
                    textCapitalization: TextCapitalization.characters,
                    decoration: di("货架类型（选填，留空按账本自动匹配）")),
                // ㉖v197 移除「终点是地面暂存位」勾选：AGV 地面区不可达（RCS 沉淀数千条任务
                // 0 条含 NB03 端、账本移库改账留痕 0 条=地面直送从未成功过一框）。
                // 货架→地面正确动线：本表单拉到 CK 站台 → 人工转地面 → 位置登记收账；
                // 地面上架：人工搬到 CK 站台 → 采集录入 AGV 模式（见下方提示）
                const Padding(
                  padding: EdgeInsets.only(top: 2),
                  child: Text(
                      "地面框上架请走「采集录入·AGV模式」（人工搬到CK台再扫）；"
                      "移库仅支持 货架→货架 / 货架→CK站台",
                      style: TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
                ),
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
                    onPressed: () {
                      // 起点框留空=批量模式：把勾选带出去（模式0无需选台；模式1需先点选一台）
                      pickedBoxes =
                          fromC.text.trim().isEmpty ? sel.toList() : [];
                      Navigator.pop(
                          ctx2, dry ? "dry" : "go"); // ㉖v197 goG（终点地面）分支随伪功能移除
                    },
                    child: Text(fromC.text.trim().isEmpty
                        ? (toMode == 1 && pickedStn.isEmpty
                            ? "选一个站台"
                            : (sel.isEmpty ? "勾选要拉的框" : "批量拉 ${sel.length} 框"))
                        : "下一步")),
              ],
            );
          }));
  if (choice == null || !context.mounted) return;
  final from = fromC.text.trim().toUpperCase();
  final to = toMode == 0
      ? "AUTO"
      : toMode == 1
          ? pickedStn
          : toShelfC.text.trim().toUpperCase();
  final batch = from.isEmpty && pickedBoxes.isNotEmpty; // 起点框留空+有勾选=批量
  if (!batch && (from.isEmpty || to.isEmpty)) {
    if (context.mounted)
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text("❌ 起点货位必填（或勾选框走批量）；终点请选台/填格")));
    return;
  }
  if (batch && toMode == 2) {
    if (context.mounted)
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content:
              Text("❌ 批量只能拉往 CK 站台（一个货架格放不下多框）——请改「自动分配」或「手动选台」，或填起点走单框移库")));
    return;
  }
  if (batch) {
    // —— 批量拉下架：逐框下发，服务器并发闸门排队+台满接力（与网页 pjmvSubmit 同语义）——
    void tb(String m, [bool errN = false]) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(m),
          backgroundColor: errN ? Colors.red : null,
          duration: const Duration(seconds: 2)));
    }

    final toDisp = toMode == 0 ? "自动分配空闲台" : to;
    final okN = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
                title: const Text("⚠️ 确认批量拉下架",
                    style: TextStyle(color: Colors.deepOrange)),
                content: Text("共 ${pickedBoxes.length} 框 → $toDisp\n\n"
                    "每框一条任务：货架 → CK 站台（${toMode == 0 ? "空闲台自动分配，" : ""}台满自动排队接力：前一框到台被你清走后，调度器自动发下一框）。\n"
                    "到台后：人工把框转去地面 + 「位置登记」收账，或 AGV 页「人已移走」一键收口。\n\n确认下发？"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(ctx, false),
                      child: const Text("取消")),
                  FilledButton(
                      style: FilledButton.styleFrom(
                          backgroundColor: Colors.deepOrange),
                      onPressed: () => Navigator.pop(ctx, true),
                      child: Text("下发 ${pickedBoxes.length} 框",
                          style: const TextStyle(color: Colors.white)))
                ]));
    if (okN != true || !context.mounted) return;
    tb("⏳ 批量下发中（0/${pickedBoxes.length}）");
    int ok = 0, failN = 0;
    final failMsgs = <String>[];
    for (int i = 0; i < pickedBoxes.length; i++) {
      if (!context.mounted) break;
      final r = await AuthApi.agvTransfer(
          from: pickedBoxes[i],
          to: to,
          kind: "shelf2shelf",
          palletType: palC.text.trim(),
          dry: choice == "dry");
      if (r["ok"] == true) {
        ok++;
      } else {
        failN++;
        failMsgs.add("${pickedBoxes[i]}：${r["msg"]}");
      }
      if (!context.mounted) break;
      tb("⏳ 批量下发中（${i + 1}/${pickedBoxes.length}）");
    }
    if (!context.mounted) return;
    tb(
        failN == 0
            ? "✅ 批量拉下架已下发 $ok 框${choice == "dry" ? "（演算）" : ""}——到台后人工转地面+「位置登记」收账"
            : "⚠️ 成功 $ok / 失败 $failN：${failMsgs.take(3).join('；')}",
        failN > 0);
    LocalLog.op('移库批量', '${choice == "dry" ? "演算" : "下发"} 成$ok 败$failN');
    if (ok > 0) onDone?.call();
    return;
  }
  final toDisp = to == "AUTO" ? "自动分配空闲台" : to;
  if (choice != "dry") {
    final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("⚠️ 确认移库",
                  style: TextStyle(color: Colors.deepOrange)),
              content: Text(
                  "将呼叫AGV把 $from 上的货架整架移到 $toDisp。\n\n请确认该货位确有此架、移库路径无人停留。AGV 确认到位后账本会自动更新位置（无需再手工登记）。确认下发？"),
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
    if (ok != true || !context.mounted) return;
  }
  final r = await AuthApi.agvTransfer(
      from: from,
      to: to,
      kind: "shelf2shelf", // ㉖v197 地面直送伪功能移除：本表单仅 货架→货架/货架→CK站台（AGV 地面区不可达）
      palletType: palC.text.trim(),
      dry: choice == "dry");
  if (context.mounted)
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(r["ok"] == true
            ? "✅ ${r["msg"]}${r["to"]?.toString().isNotEmpty == true && toMode == 0 ? "（已选台 ${r["to"]}）" : ""}"
            : "❌ ${r["msg"]}")));
  if (r["ok"] == true) onDone?.call();
  LocalLog.op('移库', r["ok"] == true ? '$from→$toDisp 已下发' : '$from→$toDisp 失败');
}
