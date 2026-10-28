part of 'main.dart';
// ===================== 账号登录 + 角色 + 服务端鉴权（App侧） =====================
// 与 server/server.js 配套：登录发 token，/api/me 心跳，停用/过期强制回登录页。
// 离线宽限：心跳遇网络错误时，凭 lastVerifiedAt 24 小时内可继续使用（缓存角色与功能开关）。

/// ㉒G11 服务器时钟偏移（毫秒）：本机显示时间统一校正用；心跳/登录时更新
int kClockOffsetMs = 0;
// ---- 第3档 PDA显示偏好：字号档位(响应式即时生效)/扫码自动聚焦 ----
final ValueNotifier<double> kFontScaleN =
    ValueNotifier(1.0); // std=1.0 lg=1.18 xl=1.35
bool kAutoFocus = true;
double kFontScaleOf(String f) => f == 'lg'
    ? 1.18
    : f == 'xl'
        ? 1.35
        : 1.0;

class AuthUser {
  final String id, username, name, role;
  final bool mustChangePw;
  const AuthUser(
      {required this.id,
      required this.username,
      required this.name,
      required this.role,
      this.mustChangePw = false});
  factory AuthUser.fromJson(Map j) => AuthUser(
      id: (j["id"] ?? "").toString(),
      username: (j["username"] ?? "").toString(),
      name: (j["name"] ?? "").toString(),
      role: (j["role"] ?? "material").toString(),
      mustChangePw: j["mustChangePw"] == true);
  Map<String, dynamic> toJson() => {
        "id": id,
        "username": username,
        "name": name,
        "role": role,
        "mustChangePw": mustChangePw
      };
  String get roleName => role == "admin"
      ? "管理员"
      : (role == "warehouse"
          ? "仓管员"
          : (role == "inspector" ? "检验员" : "物料员"));
}

/// 会话持久化（SharedPreferences）
class AuthStore {
  static const _kServer = "auth_server_url";
  static const _kToken = "auth_token";
  static const _kUser = "auth_user_json";
  static const _kFeatures = "auth_features_json";
  static const _kVerified = "auth_last_verified_ms";
  static const offlineGraceMs = 24 * 3600 * 1000; // 网络异常时的离线宽限期

  static Future<String> serverUrl() async =>
      (await SharedPreferences.getInstance()).getString(_kServer) ?? "";
  static Future<void> setServerUrl(String v) async =>
      (await SharedPreferences.getInstance()).setString(_kServer, v.trim());
  static Future<String> token() async =>
      (await SharedPreferences.getInstance()).getString(_kToken) ?? "";
  static Future<AuthUser?> user() async {
    final s = (await SharedPreferences.getInstance()).getString(_kUser);
    if (s == null || s.isEmpty) return null;
    try {
      return AuthUser.fromJson(jsonDecode(s));
    } catch (_) {
      return null;
    }
  }

  static Future<Map<String, bool>> features() async {
    final s = (await SharedPreferences.getInstance()).getString(_kFeatures);
    if (s == null || s.isEmpty) return {};
    try {
      return Map<String, bool>.from(jsonDecode(s));
    } catch (_) {
      return {};
    }
  }

  static Future<int> lastVerifiedMs() async =>
      (await SharedPreferences.getInstance()).getInt(_kVerified) ?? 0;
  static Future<void> saveSession(
      String token, AuthUser u, Map features) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kToken, token);
    await sp.setString(_kUser, jsonEncode(u.toJson()));
    await sp.setString(
        _kFeatures, jsonEncode(Map<String, bool>.from(features)));
    await sp.setInt(_kVerified, DateTime.now().millisecondsSinceEpoch);
  }

  static Future<void> markVerified() async =>
      (await SharedPreferences.getInstance())
          .setInt(_kVerified, DateTime.now().millisecondsSinceEpoch);
  static Future<void> clearSession() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kToken);
    await sp.remove(_kUser);
    await sp.remove(_kFeatures);
    await sp.remove(_kVerified);
  }
}

/// 服务端 API 封装（10 秒超时）
class AuthApi {
  static Future<Map> _req(String method, String path,
      {Map? body, String? token, String? serverOverride, int timeoutSec = 10}) async {
    final base = (serverOverride ?? await AuthStore.serverUrl())
        .replaceFirst(RegExp(r"/+$"), "");
    if (base.isEmpty) return {"ok": false, "net": true, "msg": "未配置服务器地址"};
    final uri = Uri.parse("$base$path");
    final headers = {"Content-Type": "application/json; charset=utf-8"};
    if (token != null) headers["Authorization"] = "Bearer $token";
    try {
      late http.Response resp;
      final req = http.Request(method, uri)..headers.addAll(headers);
      if (body != null) req.body = jsonEncode(body);
      resp = await http.Response.fromStream(
          await req.send().timeout(Duration(seconds: timeoutSec)));
      Map j;
      try {
        j = jsonDecode(utf8.decode(resp.bodyBytes));
      } catch (_) {
        j = {"ok": false, "msg": "服务器返回异常(${resp.statusCode})"};
      }
      j["_status"] = resp.statusCode;
      return j;
    } catch (e) {
      return {"ok": false, "net": true, "msg": "无法连接服务器：$e"};
    }
  }

  /// v56 设备标识：与 errlog 同口径（PDA-随机5位，持久化），登录/上报共用一台一码
  static Future<String> deviceId() async {
    final sp = await SharedPreferences.getInstance();
    var dev = sp.getString('errlog_dev') ?? '';
    if (dev.isEmpty) {
      dev = 'PDA-' +
          DateTime.now()
              .millisecondsSinceEpoch
              .remainder(100000)
              .toString()
              .padLeft(5, '0');
      await sp.setString('errlog_dev', dev);
    }
    return dev;
  }

  static Future<Map> login(String server, String username, String password) async =>
      _req("POST", "/api/login",
          body: {
            "username": username,
            "password": password,
            "dev": await deviceId(),
            "kind": "pda"
          },
          serverOverride: server);
  static Future<Map> me() async =>
      _req("GET", "/api/me", token: await AuthStore.token());
  // ㉖⑯ 内嵌网页免登录：用原生会话换发一枚不绑设备指纹的网页 token
  static Future<Map> webSession() async =>
      _req("POST", "/api/web/session", token: await AuthStore.token());
  static Future<void> logout() async {
    final t = await AuthStore.token();
    if (t.isNotEmpty) await _req("POST", "/api/logout", token: t);
    await AuthStore.clearSession();
  }

  static Future<Map> changePassword(String oldPw, String newPw) async =>
      _req("POST", "/api/change_password",
          body: {"oldPassword": oldPw, "newPassword": newPw},
          token: await AuthStore.token());
  // ㉖v67 个人中心：改自己姓名（验原密码）+ 我的登录设备/会话（本人可看可踢）
  static Future<Map> changeName(String pw, String name) async => _req("POST",
      "/api/change_name",
      body: {"password": pw, "name": name},
      token: await AuthStore.token());
  static Future<Map> myDevices() async =>
      _req("GET", "/api/me/devices", token: await AuthStore.token());
  static Future<Map> kickDevice(String dev) async =>
      _req("POST", "/api/me/devices/kick",
          body: {"dev": dev}, token: await AuthStore.token());
  static Future<Map> users() async =>
      _req("GET", "/api/users", token: await AuthStore.token());
  static Future<Map> createUser(
          String username, String name, String password, String role) async =>
      _req("POST", "/api/users",
          body: {
            "username": username,
            "name": name,
            "password": password,
            "role": role
          },
          token: await AuthStore.token());
  static Future<Map> updateUser(String id, Map patch) async =>
      _req("PATCH", "/api/users/$id",
          body: patch, token: await AuthStore.token());
  static Future<Map> deleteUser(String id) async =>
      _req("DELETE", "/api/users/$id", token: await AuthStore.token());
  static Future<Map> config() async =>
      _req("GET", "/api/config", token: await AuthStore.token());
  static Future<Map> setFeatures(Map features, {bool? autoDispatch}) async =>
      _req("PATCH", "/api/config",
          body: {
            "features": features,
            if (autoDispatch != null) "autoDispatch": autoDispatch
          },
          token: await AuthStore.token());

  // ---- 领料单 ----
  static Future<Map> reqCreate(List<Map> items, String remark,
          {String assigneeId = "",
          bool rush = false,
          String needDate = ""}) async =>
      _req("POST", "/api/requisitions",
          body: {
            "items": items,
            "remark": remark,
            "assigneeId": assigneeId,
            "rush": rush,
            if (needDate.isNotEmpty) "needDate": needDate
          },
          token: await AuthStore.token());

  /// 可选仓管员列表（新建单"指定仓管员"用）
  static Future<Map> reqWarehouseUsers() async =>
      _req("GET", "/api/requisitions/warehouse-users",
          token: await AuthStore.token());
  /// ㉖v62 建单提效：本人近60天常领清单（频次×最近排序，带上次数量与在架托数）
  static Future<Map> reqFrequent() async =>
      _req("GET", "/api/requisitions/frequent", token: await AuthStore.token());
  /// ㉖v62 产线模板：列表（本人私有+同事共享）
  static Future<Map> tplList() async =>
      _req("GET", "/api/req-templates", token: await AuthStore.token());
  static Future<Map> tplSave(String name, List<Map> items, bool shared, {String id = ""}) async =>
      _req("POST", "/api/req-templates",
          token: await AuthStore.token(),
          body: {"name": name, "items": items, "shared": shared, if (id.isNotEmpty) "id": id});
  static Future<Map> tplDelete(String id) async => _req(
      "DELETE", "/api/req-templates?id=$id", token: await AuthStore.token());
  static Future<void> tplUse(String id) async => _req(
      "POST", "/api/req-templates/$id/use", token: await AuthStore.token());
  static Future<Map> reqList({String scope = ""}) async => _req("GET",
      scope.isEmpty ? "/api/requisitions" : "/api/requisitions?scope=$scope",
      token: await AuthStore.token());
  /// ㉖v98 单张全量（详情弹层打开时拉一次带 suggest 取货建议；列表 lite 化配套）
  static Future<Map> reqOne(String id) async =>
      _req("GET", "/api/requisitions/${Uri.encodeComponent(id)}",
          token: await AuthStore.token());
  /// ㉖v52 备料排队看板：my=本人某单号则返回该单排位；留空返回全员排队全景
  static Future<Map> reqQueue({String my = ""}) async => _req(
      "GET",
      my.isEmpty
          ? "/api/requisitions/queue"
          : "/api/requisitions/queue?my=${Uri.encodeComponent(my)}",
      token: await AuthStore.token());
  static Future<Map> reqAction(String id, String action, [Map? body]) async =>
      _req("POST", "/api/requisitions/$id/$action",
          body: body ?? {}, token: await AuthStore.token());
  // 设置转入货位（loc）；行级转单回写(transfer)/跳过(skip) 直接走 reqAction
  static Future<Map> reqSetLoc(String id, Map to) async =>
      reqAction(id, "loc", {
        "locCode": to["LOC_CODE"],
        "locName": to["LOC_NAME"],
        "warehouseCode": to["WAREHOUSE_CODE"],
        "warehouseName": to["WAREHOUSE_NAME"],
        "districtCode": to["DISTRICT_CODE"],
        "districtName": to["DISTRICT_NAME"],
      });
  static Future<Map> notifications() async =>
      _req("GET", "/api/notifications", token: await AuthStore.token());

  /// ㉖v50 角标专用：服务端权威未读数（只读，绝不消耗已读）
  static Future<Map> notificationsUnread({int limit = 50}) async =>
      _req("GET", "/api/notifications/unread?limit=$limit",
          token: await AuthStore.token());

  /// 消息中心：本人最近历史通知（只读，不消耗未读）
  static Future<Map> notificationsHistory({int limit = 30}) async =>
      _req("GET", "/api/notifications/history?limit=$limit",
          token: await AuthStore.token());

  /// ㉖v50 消息中枢二级页：看完该分类 → 服务端标记该类已读（红点精准消失）
  static Future<Map> notificationsReadGroup(List<String> types) async =>
      _req("POST", "/api/notifications/readgroup",
          body: {"types": types}, token: await AuthStore.token());

  /// ㉖v50 消息中枢"清未读"按钮：本人全部通知标记已读
  static Future<Map> notificationsReadAll() async =>
      _req("POST", "/api/notifications/readall",
          body: {}, token: await AuthStore.token());

  // ---- 货位账本同步（PDA ↔ 电脑服务器，增量合并：新者胜+墓碑删除） ----
  /// items: [{c:标签, l:货位, f:料框, t:毫秒, pid:托号}]；del: [{c:标签, t:删除时间}] 墓碑
  static Future<Map> ledgerSync(List<Map> items,
          {List<Map> del = const [], String epoch = ""}) async =>
      _req("POST", "/api/ledger/sync",
          body: {
            "items": items,
            "del": del,
            if (epoch.isNotEmpty) "epoch": epoch
          }, // ㉖v69 世代：服务器据此拦旧缓存防污染新账本
          token: await AuthStore.token());

  /// 拉取电脑服务器上的账本全量（公开只读；含墓碑，PDA 合并用）
  static Future<Map> ledgerGet() async => _req("GET", "/api/ledger");
  /// ㉖v69 零件全集背书（字典∪账本∪流水∪出库∪领料）：缺料反馈判零库存的地基
  static Future<Map> partsBacking() async =>
      _req("GET", "/api/parts/backing", token: await AuthStore.token());
  static Future<Map> ledgerGetByCode(String c) async =>
      _req("GET", "/api/ledger?c=" + Uri.encodeComponent(c),
          token: await AuthStore.token());
  // ---- 采集流水 / 出库单同步（流水按键增量合并；删批次单独上报） ----
  static Future<Map> scanlogSync(List items) async =>
      _req("POST", "/api/scanlog/sync",
          body: {"items": items}, token: await AuthStore.token());
  static Future<Map> scanlogDeleteBatch(String batch) async =>
      _req("POST", "/api/scanlog/delete",
          body: {"batch": batch}, token: await AuthStore.token());
  // ---- RCS(哈工库讯AGV)：配置同步（服务器代轮询做催扫/站台面板）+ 站台状态查询 ----
  static Future<Map> rcsConfigSync(
          {required String host,
          required String account,
          required String pwd}) async =>
      _req("POST", "/api/rcs/config",
          body: {"host": host, "account": account, "pwd": pwd},
          token: await AuthStore.token());
  static Future<Map> rcsStations() async =>
      _req("GET", "/api/rcs/stations", token: await AuthStore.token());
  // ㉖⑯ 站台看板富数据（今日吞吐/平均清台/占用明细/身份），PDA 站台详情弹层用
  static Future<Map> stBoard() async =>
      _req("GET", "/api/agv/stboard", token: await AuthStore.token());
  // ㉖ 保存站台身份（别名/用途/停用，仓管·管理员）
  static Future<Map> stMeta(String station,
          {String? alias, String? role, bool? off, int? cfgRev}) async =>
      _req("POST", "/api/agv/stmeta",
          body: {
            "station": station,
            if (alias != null) "alias": alias,
            if (role != null) "role": role,
            if (off != null) "off": off,
            if (cfgRev != null) "cfgRev": cfgRev,
          },
          token: await AuthStore.token());
  static Future<Map> rcsMap() async =>
      _req("GET", "/api/rcs/map", token: await AuthStore.token());
  static Future<Map> rcsNet() async =>
      _req("GET", "/api/rcs/net", token: await AuthStore.token());
  static Future<Map> rcsClear(String station, {String state = "空闲"}) async =>
      _req("POST", "/api/rcs/clear",
          body: {"station": station, "state": state},
          token: await AuthStore.token());
  // ===== AGV 出库排队（一键叫车→服务器调度器自动分配站台） =====
  static Future<Map> agvQueueEnqueue(
          {required String reqId,
          required String reqNo,
          required List<Map> items}) async =>
      _req("POST", "/api/agv/queue",
          body: {"reqId": reqId, "reqNo": reqNo, "items": items},
          token: await AuthStore.token());
  static Future<Map> agvQueueCancel(List<String> codes,
          {String reqId = ""}) async =>
      _req("POST", "/api/agv/queue/cancel",
          body: reqId.isEmpty ? {"codes": codes} : {"reqId": reqId},
          token: await AuthStore.token());
  static Future<Map> agvQueuePrio(String code, {bool off = false}) async =>
      _req("POST", "/api/agv/queue/prio",
          body: {"code": code, "off": off},
          token: await AuthStore.token()); // ㉖ 排队项置顶/取消置顶（与网页队列控制台同款）
  static Future<Map> agvSetMode(String mode) async =>
      _req("POST", "/api/agv/mode",
          body: {"mode": mode}, token: await AuthStore.token());
  static Future<Map> agvWmasConfig(
          {required String host,
          required String account,
          required String pwd}) async =>
      _req("POST", "/api/agv/wmas-config",
          body: {"host": host, "account": account, "pwd": pwd},
          token: await AuthStore.token());
  // 零件档案：拉服务器全厂流水/出库单（B）+ 单框AGV链路（A补充）
  static Future<Map> scanlogGet({int limit = 5000}) async =>
      _req("GET", "/api/scanlog?limit=$limit", token: await AuthStore.token());
  static Future<Map> outboundGet() async =>
      _req("GET", "/api/outbound", token: await AuthStore.token());
  static Future<Map> agvTaskOf(String code) async =>
      _req("GET", "/api/agv/taskOf?c=${Uri.encodeComponent(code)}",
          token: await AuthStore.token());
  // ㉖v68 全链路聚合（对齐网页版）：任意种子（框码/零件号/出库单/领料单/AGV任务）→ 时间线事件流
  static Future<Map> trace(String q) async =>
      _req("GET", "/api/trace?q=${Uri.encodeComponent(q)}",
          token: await AuthStore.token());
  // ㉖v68 服务器侧零件档案（按框归并在架+采集+出库明细+在途领料需求）
  static Future<Map> partProfile(String pn) async =>
      _req("GET", "/api/part/profile?pn=${Uri.encodeComponent(pn)}",
          token: await AuthStore.token());
  // ⑮预约来料 + 地面排格数  ㉖v94n 预约升级：qty=预订框数(0=仅提醒)，due=期望到货日，auto=够数自动开领料单
  static Future<Map> watchlistGet() async =>
      _req("GET", "/api/watchlist", token: await AuthStore.token());
  static Future<Map> watchlistSet(String partNo, bool on,
      {int qty = 0, String itemName = "", String due = "", bool auto = true}) async =>
      _req("POST", "/api/watchlist",
          body: {
            "partNo": partNo, "on": on,
            if (on) "qty": qty,
            if (on && itemName.isNotEmpty) "itemName": itemName,
            if (on && due.isNotEmpty) "due": due,
            if (on) "auto": auto
          },
          token: await AuthStore.token());
  static Future<Map> groundSlotsGet() async =>
      _req("GET", "/api/ground-slots", token: await AuthStore.token());
  static Future<Map> groundSlotsSet(List entries) async =>
      _req("POST", "/api/ground-slots",
          body: {"entries": entries}, token: await AuthStore.token());
  static Future<Map> agvAlarms() async =>
      _req("GET", "/api/agv/alarms", token: await AuthStore.token()); // 活动告警列表
  static Future<Map> agvAlarmAck(String id) async =>
      _req("POST", "/api/agv/alarm/ack",
          body: {"id": id}, token: await AuthStore.token()); // 认领
  // ㉕T2 盘点结果上收（服务器落库供网页查看与D10导出）
  static Future<Map> invReport(Map payload) async =>
      _req("POST", "/api/inventory/report",
          body: payload, token: await AuthStore.token());
  static Future<Map> ttsModelInfo() async =>
      _req("GET", "/api/tts/info", token: await AuthStore.token());
  static Future<Map> setPrefs(Map body) async => _req("POST", "/api/prefs",
      body: body, token: await AuthStore.token()); // ㉖B14 偏好上云
  // ㉖① 标签全局查重（采集入库前调用）
  static Future<Map> labelCheck(String c) async =>
      _req("GET", "/api/label/check?c=" + Uri.encodeComponent(c),
          token: await AuthStore.token());
  static Future<Map> labelForce(String c, String why) async =>
      _req("POST", "/api/label/force",
          body: {"code": c, "why": why}, token: await AuthStore.token());
  // ㉖⑭ 采集作废释放全局防重（作废联动调用，允许同标签重扫纠错）
  static Future<Map> labelUnsee(String c) async =>
      _req("POST", "/api/label/unsee",
          body: {"code": c}, token: await AuthStore.token());
  // ㉖④ 检验模式三接口
  static Future<Map> inspectList() async =>
      _req("GET", "/api/inspect/list", token: await AuthStore.token());
  static Future<Map> inspectStart(String from, String note,
          {String station = ""}) async =>
      _req("POST", "/api/inspect/start",
          body: {
            "from": from,
            "note": note,
            if (station.isNotEmpty) "station": station
          },
          token: await AuthStore.token());
  static Future<Map> sysStatus() async =>
      _req("GET", "/api/sysstatus", token: await AuthStore.token());
  static Future<Map> inspectSearch(String pn) async =>
      _req("GET", "/api/inspect/search?pn=" + Uri.encodeComponent(pn),
          token: await AuthStore.token());
  // v55 检验态批量查询（库存页徽章/检验下架按钮用）
  static Future<Map> inspectStatus(List<String> codes) async =>
      _req("POST", "/api/inspect/status",
          body: {"codes": codes}, token: await AuthStore.token());
  static Future<Map> inspectReturn(String id, String note) async =>
      _req("POST", "/api/inspect/return",
          body: {"id": id, "note": note}, token: await AuthStore.token());
  static Future<Map> inspectAssist(String id, {String station = ""}) async =>
      _req("POST", "/api/inspect/assist",
          body: {"id": id, if (station.isNotEmpty) "station": station},
          token: await AuthStore.token());
  static Future<Map> inspectCancel(String id) async =>
      _req("POST", "/api/inspect/cancel",
          body: {"id": id}, token: await AuthStore.token()); // ㉖ 取消检验工单（未叉货直接作废；途中先撤AGV任务）
  static Future<Map> inspectVerdict(String id, String verdict, String note,
          {String retReason = ""}) async =>
      _req("POST", "/api/inspect/verdict",
          body: {
            "id": id,
            "verdict": verdict,
            "note": note,
            if (retReason.isNotEmpty) "retReason": retReason
          },
          token: await AuthStore.token());
  static Future<Map> dashboard() async =>
      _req("GET", "/api/dashboard", token: await AuthStore.token());
  static Future<Map> agvFunnel(int days) async =>
      _req("GET", "/api/agv/funnel?days=$days", token: await AuthStore.token());
  static Future<Map> agvReport(int days) async =>
      _req("GET", "/api/agv/report?days=$days", token: await AuthStore.token());
  static Future<Map> outboundSync(Map order) async =>
      _req("POST", "/api/outbound/sync",
          body: order, token: await AuthStore.token());
  // AGV 叫车占位：同容器（15分钟）或同站台（60秒内）已有占位则拒绝，两台PDA并发点击只放行一个
  static Future<Map> agvClaim(
          {required String container,
          required String station,
          required String fromLoc}) async =>
      _req("POST", "/api/agv/claim",
          body: {
            "container": container,
            "station": station,
            "fromLoc": fromLoc
          },
          token: await AuthStore.token());
  // ㉖⑰ 统一搬运任务：入库/出库叫车全部经服务器入队再下发（队列控制台/流水线/链路全可见）
  static Future<Map> agvCarry(
          {required String from,
          required String to,
          required String dir, // in=站台→货架 out=货架→站台
          String code = "",
          String palletType = "",
          String container = ""}) async =>
      _req("POST", "/api/agv/carry",
          timeoutSec: 25, // ㉖v94i 叫车走服务器全链（容器占用+主档+建任务多次 WMAS 往返），WMAS 恢复期 10 秒必超时假失败
          body: {
            "from": from,
            "to": to,
            "dir": dir,
            if (code.isNotEmpty) "code": code,
            if (palletType.isNotEmpty) "palletType": palletType,
            if (container.isNotEmpty) "container": container,
          },
          token: await AuthStore.token());
  static Future<Map> agvCarryState(String taskNo) async =>
      _req("GET", "/api/agv/carryState?t=" + Uri.encodeComponent(taskNo),
          token: await AuthStore.token());
  // ㉖⑰ 服务器权威货架占用（入库自动分配货位用，多PDA统一）
  static Future<Map> ledgerLocs() async =>
      _req("GET", "/api/ledger/locs", token: await AuthStore.token());
  // ㉖v54 原子预占分配：服务器算位+锁位一体（多PDA并发不撞位）
  static Future<Map> ledgerReserve(String code, String partNo) async =>
      _req("POST", "/api/ledger/reserve",
          body: {"code": code, "partNo": partNo},
          token: await AuthStore.token());
  // ㉖ 容器类型配置：读（采集页按钮数据源）/ 整表保存（仓管·管理员）
  static Future<Map> containersGet() async =>
      _req("GET", "/api/containers", token: await AuthStore.token());
  static Future<Map> containersSet(List<Map> types) async =>
      _req("POST", "/api/containers",
          body: {"types": types}, token: await AuthStore.token());
  // 货架移库：起终点人工指定，服务器复用出库下发通道建CARRY任务（dry=1仅演算）
  static Future<Map> agvTransfer(
          {required String from,
          required String to,
          String kind = "shelf2shelf",
          String palletType = "",
          bool dry = false}) async =>
      _req("POST", "/api/agv/transfer",
          body: {
            "from": from,
            "to": to,
            "kind": kind,
            "palletType": palletType,
            if (dry) "dry": "1"
          },
          token: await AuthStore.token());
  static Future<Map> agvTransferCancel(String id) async =>
      _req("POST", "/api/agv/transfer/cancel",
          body: {"id": id}, token: await AuthStore.token());
  static Future<void> agvRelease(
      {required String container, required String station}) async {
    try {
      await _req("POST", "/api/agv/release",
          body: {"container": container, "station": station},
          token: await AuthStore.token());
    } catch (_) {}
  }
}

/// 全局会话（AuthGate 启动时填充；MainPage 等直接读静态成员）
class Auth {
  static AuthUser? user;
  static Map<String, bool> features = {};
  static bool get isAdmin => user?.role == "admin";
  static bool can(String feature) =>
      user != null && (features[feature] ?? false);
}

// ===================== 启动门禁 =====================
class AuthGate extends StatefulWidget {
  const AuthGate({super.key});
  @override
  State<AuthGate> createState() => _AuthGateState();
}

class _AuthGateState extends State<AuthGate> with WidgetsBindingObserver {
  int _stage = 0; // 0=校验中 1=需登录 2=已放行
  String _kickMsg = "";
  Timer? _beat;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) => _bootstrap());
  }

  @override
  void dispose() {
    _beat?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState st) {
    if (st == AppLifecycleState.resumed && _stage == 2) {
      _heartbeat(); // 回前台立刻校验，停用即时感知
      if (scanPushPending) unawaited(scanPushNow()); // ㉖⑭ 断网期间积压的流水，回前台立即补推
      if (ledgerPushPending) unawaited(ledgerPushNow()); // ㉖⑰ 积压的账本同样回前台补推
    }
  }

  Future<void> _bootstrap() async {
    final token = await AuthStore.token();
    final u = await AuthStore.user();
    if (token.isEmpty || u == null) {
      if (mounted) setState(() => _stage = 1);
      return;
    }
    final r = await AuthApi.me();
    if (!mounted) return;
    if (r["ok"] == true) {
      _apply(r);
      setState(() => _stage = 2);
      _startBeat();
      LocalLog.op('登录', '自动续期');
      Future.delayed(const Duration(seconds: 3),
          () => AppUpdater.checkAtLaunch()); // 冷启动自动续期成功→静默查APK更新
    } else if (r["net"] == true) {
      // 网络异常 → 离线宽限
      final v = await AuthStore.lastVerifiedMs();
      if (DateTime.now().millisecondsSinceEpoch - v <
          AuthStore.offlineGraceMs) {
        Auth.user = u;
        Auth.features = await AuthStore.features();
        setState(() => _stage = 2);
        _startBeat();
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("离线模式：连不上鉴权服务器，24小时内暂可用"),
            backgroundColor: Colors.orange));
      } else {
        if (mounted) setState(() => _stage = 1);
      }
    } else {
      await AuthStore.clearSession();
      if (mounted)
        setState(() {
          _stage = 1;
          _kickMsg = (r["msg"] ?? "请重新登录").toString();
        });
    }
  }

  void _apply(Map r) {
    final st = DateTime.tryParse(r["serverTime"]?.toString() ?? "");
    if (st != null)
      kClockOffsetMs = st
          .toUtc()
          .difference(DateTime.now().toUtc())
          .inMilliseconds; // ㉒G11 服务器-本机偏差
    Auth.user = AuthUser.fromJson(Map<String, dynamic>.from(r["user"]));
    Auth.features = Map<String, bool>.from(r["features"] ?? {});
    AuthStore.markVerified();
    if (r["prefs"] != null)
      PrefsSync.applyFromServer(r["prefs"]); // ㉖B14 服务器偏好回写本地（不await，防心跳卡顿）
    unawaited(LocalLog.uploadErrs()); // ㉖⑩ 心跳顺带补传本地异常日志（失败静默）
  }

  void _startBeat() {
    _beat?.cancel();
    _beat = Timer.periodic(const Duration(minutes: 5), (_) => _heartbeat());
  }

  Future<void> _heartbeat() async {
    final r = await AuthApi.me();
    if (!mounted) return;
    if (r["ok"] == true) {
      _apply(r);
      return;
    }
    if (r["net"] == true) return; // 网络抖动不踢，等宽限期
    _beat?.cancel();
    await AuthStore.clearSession();
    setState(() {
      _stage = 1;
      _kickMsg =
          (r["code"] == "disabled" ? "账号已被管理员停用" : "登录已过期，请重新登录").toString();
    });
  }

  void _onLoggedIn() {
    setState(() {
      _stage = 2;
      _kickMsg = "";
    });
    _startBeat();
  }

  @override
  Widget build(BuildContext context) {
    if (_stage == 0)
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    if (_stage == 1)
      return LoginPage(kickMsg: _kickMsg, onLoggedIn: _onLoggedIn);
    return MainPage(key: ValueKey(Auth.user?.id ?? "anon"));
  }
}

// ===================== 登录页 =====================
class LoginPage extends StatefulWidget {
  final String kickMsg;
  final VoidCallback onLoggedIn;
  const LoginPage({super.key, required this.kickMsg, required this.onLoggedIn});
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _serverCtrl = TextEditingController();
  final _userCtrl = TextEditingController();
  final _pwCtrl = TextEditingController();
  bool _busy = false;
  bool _pwVisible = false;

  @override
  void initState() {
    super.initState();
    AuthStore.serverUrl().then((v) {
      if (mounted && v.isNotEmpty) _serverCtrl.text = v;
    });
  }

  @override
  void dispose() {
    _serverCtrl.dispose();
    _userCtrl.dispose();
    _pwCtrl.dispose();
    super.dispose();
  }

  Future<void> _login() async {
    final server = _serverCtrl.text.trim(),
        u = _userCtrl.text.trim(),
        p = _pwCtrl.text;
    if (server.isEmpty || u.isEmpty || p.isEmpty) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text("服务器地址、账号、密码都要填")));
      return;
    }
    setState(() => _busy = true);
    await AuthStore.setServerUrl(server);
    final r = await AuthApi.login(server, u, p);
    if (!mounted) return;
    setState(() => _busy = false);
    if (r["ok"] == true) {
      final lu = AuthUser.fromJson(Map<String, dynamic>.from(r["user"]));
      final lf = Map<String, bool>.from(r["features"] ?? {});
      await AuthStore.saveSession(r["token"], lu, lf);
      LocalLog.op('登录', lu.name);
      // 修复：登录成功必须立即刷新全局会话，否则 Auth.user 仍是上次登录账号的残留
      Auth.user = lu;
      Auth.features = lf;
      if (r["prefs"] != null)
        await PrefsSync.applyFromServer(r["prefs"]); // ㉖B14 登录即拉回个人偏好
      Future.delayed(const Duration(seconds: 3),
          () => AppUpdater.checkAtLaunch()); // ⑬登录后静默检查APK更新
      widget.onLoggedIn();
      if (Auth.user!.mustChangePw) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("首次登录，请尽快在 设置→账号与权限 修改密码"),
            backgroundColor: Colors.orange));
      }
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text((r["msg"] ?? "登录失败").toString()),
          backgroundColor: Colors.red));
    }
  }

  InputDecoration _dec(String label, IconData icon) => InputDecoration(
      labelText: label,
      labelStyle: const TextStyle(fontSize: 13, color: Colors.blueGrey),
      prefixIcon: Icon(icon, size: 20, color: const Color(0xFF515BD4)),
      filled: true,
      fillColor: const Color(0xFFF1F3FA),
      border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none),
      enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: BorderSide.none),
      focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFF515BD4), width: 1.6)),
      isDense: true,
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        decoration: const BoxDecoration(
            gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0xFFE8EBFA), Color(0xFFF6F7FC), Color(0xFFEFF5F4)])),
        child: SafeArea(
            child: Center(
                child: SingleChildScrollView(
          padding: const EdgeInsets.all(22),
          child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                      width: 74,
                      height: 74,
                      decoration: BoxDecoration(
                          gradient: const LinearGradient(
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                              colors: [Color(0xFF515BD4), Color(0xFF7C86E8)]),
                          borderRadius: BorderRadius.circular(22),
                          boxShadow: const [
                            BoxShadow(
                                color: Color(0x40515BD4),
                                blurRadius: 22,
                                offset: Offset(0, 10))
                          ]),
                      child: const Icon(Icons.warehouse_outlined,
                          size: 40, color: Colors.white)),
                  const SizedBox(height: 14),
                  const Text("AGV货位采集器",
                      style: TextStyle(
                          fontSize: 23,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1,
                          color: Color(0xFF232B45))),
                  const SizedBox(height: 4),
                  const Text("账号登录 · 权限管理",
                      style: TextStyle(color: Colors.blueGrey, fontSize: 13)),
                  const SizedBox(height: 26),
                  Container(
                      padding: const EdgeInsets.fromLTRB(18, 20, 18, 20),
                      decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(18),
                          boxShadow: const [
                            BoxShadow(
                                color: Color(0x14203050),
                                blurRadius: 26,
                                offset: Offset(0, 8))
                          ]),
                      child: Column(children: [
                        if (widget.kickMsg.isNotEmpty)
                          Container(
                            width: double.infinity,
                            margin: const EdgeInsets.only(bottom: 14),
                            padding: const EdgeInsets.all(12),
                            decoration: BoxDecoration(
                                color: Colors.red.shade50,
                                borderRadius: BorderRadius.circular(10),
                                border: Border.all(color: Colors.red.shade200)),
                            child: Text(widget.kickMsg,
                                style: TextStyle(
                                    color: Colors.red.shade700, fontSize: 13)),
                          ),
                        TextField(
                            controller: _serverCtrl,
                            decoration: _dec(
                                "鉴权服务器（如 http://172.25.1.99:8098）",
                                Icons.dns_outlined),
                            keyboardType: TextInputType.url),
                        const SizedBox(height: 12),
                        TextField(
                            controller: _userCtrl,
                            decoration: _dec("账号", Icons.person_outline),
                            textInputAction: TextInputAction.next),
                        const SizedBox(height: 12),
                        TextField(
                            controller: _pwCtrl,
                            obscureText: !_pwVisible,
                            onSubmitted: (_) => _busy ? null : _login(),
                            decoration: _dec("密码", Icons.lock_outline)
                                .copyWith(
                                    suffixIcon: IconButton(
                                        icon: Icon(
                                            _pwVisible
                                                ? Icons.visibility_off
                                                : Icons.visibility,
                                            size: 20),
                                        onPressed: () => setState(
                                            () => _pwVisible = !_pwVisible)))),
                        const SizedBox(height: 18),
                        SizedBox(
                            width: double.infinity,
                            height: 48,
                            child: DecoratedBox(
                                decoration: BoxDecoration(
                                    gradient: const LinearGradient(
                                        colors: [
                                          Color(0xFF515BD4),
                                          Color(0xFF6D76E0)
                                        ]),
                                    borderRadius: BorderRadius.circular(13),
                                    boxShadow: const [
                                      BoxShadow(
                                          color: Color(0x33515BD4),
                                          blurRadius: 14,
                                          offset: Offset(0, 6))
                                    ]),
                                child: Material(
                                    color: Colors.transparent,
                                    child: InkWell(
                                        borderRadius: BorderRadius.circular(13),
                                        onTap: _busy ? null : _login,
                                        child: Center(
                                            child: _busy
                                                ? const SizedBox(
                                                    width: 22,
                                                    height: 22,
                                                    child:
                                                        CircularProgressIndicator(
                                                            strokeWidth: 2.5,
                                                            color:
                                                                Colors.white))
                                                : const Text("登 录",
                                                    style: TextStyle(
                                                        fontSize: 16,
                                                        fontWeight:
                                                            FontWeight.w600,
                                                        color: Colors.white,
                                                        letterSpacing: 6))))),
                            )),
                      ])),
                  const SizedBox(height: 18),
                  Text("v${AppUpdater.localVersion}+${AppUpdater.localBuild} · 豪斯特仓储协同",
                      style: const TextStyle(
                          fontSize: 11, color: Color(0xFF9AA6BC))),
                ],
              )),
        ))),
      ),
    );
  }
}

// ===================== 账号与权限（设置页入口） =====================
// ㉖v68 与"个人中心"合并为单页单入口：改名（验原密码）/改密（复用弹窗）/我的登录设备与会话 + 用户管理/角色功能/退出
class AccountPage extends StatefulWidget {
  const AccountPage({super.key});
  @override
  State<AccountPage> createState() => _AccountPageState();
}

class _AccountPageState extends State<AccountPage> {
  Map? _dev; // /api/me/devices 结果
  bool _devBusy = false;

  Future<void> _loadDev() async {
    setState(() => _devBusy = true);
    final r = await AuthApi.myDevices();
    if (!mounted) return;
    setState(() {
      _devBusy = false;
      _dev = r;
    });
  }

  @override
  void initState() {
    super.initState();
    _loadDev();
  }

  Future<void> _doRename() async {
    final u = Auth.user;
    if (u == null) return;
    final pw = TextEditingController(), nm = TextEditingController(text: u.name);
    final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
            title: const Text("修改姓名"),
            content: SizedBox(
                width: 320,
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  TextField(
                      controller: pw,
                      obscureText: true,
                      decoration: const InputDecoration(
                          labelText: "当前密码",
                          isDense: true,
                          border: OutlineInputBorder())),
                  const SizedBox(height: 10),
                  TextField(
                      controller: nm,
                      decoration: const InputDecoration(
                          labelText: "新姓名（2-20字）",
                          isDense: true,
                          border: OutlineInputBorder())),
                ])),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(c, false),
                  child: const Text("取消")),
              FilledButton(
                  onPressed: () => Navigator.pop(c, true),
                  child: const Text("确认修改")),
            ]));
    if (ok != true) return;
    final r = await AuthApi.changeName(pw.text, nm.text.trim());
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(
            (r["msg"] ?? (r["ok"] == true ? "姓名已修改" : "修改失败")).toString()),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
    if (r["ok"] == true) {
      // 就地重建会话用户并回写缓存：静态成员 final 字段不能改，整体换新实例
      final nu = AuthUser(
          id: u.id,
          username: u.username,
          name: nm.text.trim(),
          role: u.role,
          mustChangePw: u.mustChangePw);
      Auth.user = nu;
      await AuthStore.saveSession(await AuthStore.token(), nu, Auth.features);
      setState(() {});
    }
  }

  Future<void> _kick(String dev, String label) async {
    final ok = await showDialog<bool>(
        context: context,
        builder: (c) => AlertDialog(
            title: const Text("下线该设备"),
            content: Text("确认下线「$label」？该设备需重新登录。"),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(c, false),
                  child: const Text("取消")),
              FilledButton(
                  onPressed: () => Navigator.pop(c, true),
                  child: const Text("确认下线")),
            ]));
    if (ok != true) return;
    final r = await AuthApi.kickDevice(dev);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(r["ok"] == true
            ? "已下线 ${r["kicked"]} 个会话"
            : (r["msg"] ?? "下线失败").toString()),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
    _loadDev();
  }

  @override
  Widget build(BuildContext context) {
    final u = Auth.user;
    if (u == null) return const Scaffold(body: Center(child: Text("未登录")));
    final sessions = (_dev?["sessions"] as List?) ?? [];
    return Scaffold(
      appBar: AppBar(
          title: const Text("账号与权限"),
          backgroundColor: const Color(0xFF515BD4)),
      body: ListView(padding: const EdgeInsets.all(16), children: [
        Card(
            child: ListTile(
          leading: CircleAvatar(
              backgroundColor: const Color(0xFF515BD4).withOpacity(0.12),
              child: Icon(Icons.person, color: const Color(0xFF515BD4))),
          title: Text("${u.name}（${u.username}）"),
          subtitle: Text("角色：${u.roleName} · 功能权限："
              "${Auth.features.entries.where((e) => e.value).length} 项开启"),
        )),
        if (u.mustChangePw)
          Container(
            margin: const EdgeInsets.only(top: 12),
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Colors.orange.shade200)),
            child: const Text("首次登录建议立即修改初始密码",
                style: TextStyle(color: Colors.deepOrange)),
          ),
        const SizedBox(height: 12),
        Card(
            child: Column(children: [
          ListTile(
              leading: const Icon(Icons.badge_outlined),
              title: const Text("修改姓名"),
              subtitle: const Text("需验证当前密码；改完本机即时生效"),
              trailing: const Icon(Icons.chevron_right),
              onTap: _doRename),
          const Divider(height: 1),
          ListTile(
              leading: const Icon(Icons.password),
              title: const Text("修改密码"),
              subtitle: const Text("需验证原密码；新密码至少6位"),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => showDialog(
                  context: context,
                  builder: (_) => const _ChangePwDialog())),
        ])),
        const SizedBox(height: 12),
        Card(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Row(children: [
                  const Text("我的登录设备",
                      style: TextStyle(fontWeight: FontWeight.bold)),
                  const Spacer(),
                  IconButton(
                      onPressed: _devBusy ? null : _loadDev,
                      icon: const Icon(Icons.refresh, size: 20)),
                ]),
              ),
              if (_devBusy && sessions.isEmpty)
                const Padding(
                    padding: EdgeInsets.all(16),
                    child: Center(
                        child: SizedBox(
                            width: 22,
                            height: 22,
                            child: CircularProgressIndicator(strokeWidth: 2)))),
              if (!_devBusy && _dev != null && sessions.isEmpty)
                const Padding(
                    padding: EdgeInsets.fromLTRB(16, 0, 16, 16),
                    child: Text("暂无其他登录会话",
                        style: TextStyle(color: Colors.grey))),
              for (final s in sessions)
                ListTile(
                  dense: true,
                  leading: Icon(
                      s["kind"] == "web"
                          ? Icons.computer
                          : Icons.phone_android,
                      size: 20,
                      color: const Color(0xFF515BD4)),
                  title: Text(
                      "${s["kind"] == "web" ? "网页" : "手持机"} · ${s["ip"]}"),
                  subtitle: Text(
                      "最近活跃 ${DateTime.fromMillisecondsSinceEpoch((s["lastSeen"] ?? 0) is int ? (s["lastSeen"] as int) : 0)}"
                      "${s["current"] == true ? "（当前设备）" : ""}"),
                  trailing: s["current"] == true
                      ? const Icon(Icons.check_circle,
                          size: 18, color: Colors.green)
                      : IconButton(
                          icon: const Icon(Icons.logout,
                              size: 20, color: Colors.red),
                          onPressed: () => _kick(
                              (s["dev"] ?? "").toString(),
                              "${s["kind"] == "web" ? "网页" : "手持机"} ${s["ip"]}")),
                ),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 4, 16, 12),
                child: Text("发现不是自己的设备？点红色按钮下线它，对方需重新登录。",
                    style: TextStyle(fontSize: 11, color: Colors.grey)),
              ),
            ])),
        const SizedBox(height: 12),
        if (u.role == "admin")
          Card(
              child: ListTile(
                  leading: const Icon(Icons.admin_panel_settings,
                      color: Color(0xFF3F51B5)),
                  title: const Text("用户与功能管理（管理员）"),
                  subtitle: const Text("建号/停用/角色与功能权限分配"),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.push(context,
                      MaterialPageRoute(builder: (_) => const UserManagePage())))),
        if (u.role == "admin") const SizedBox(height: 12),
        Card(
            child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
                padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: Text("当前角色功能",
                    style: TextStyle(fontWeight: FontWeight.bold))),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Wrap(spacing: 8, runSpacing: 8, children: [
                for (final e in {
                  "collect": "采集录入",
                  "inventory": "盘点模式",
                  "export": "导出下载",
                  "mes_query": "MES查询",
                  "direct_transfer": "直调转单",
                  "requisition": "领料下单",
                  "receive_confirm": "签收确认",
                  "location_reg": "位置登记",
                  "agv_monitor": "AGV监控",
                  "agv_control": "AGV车辆控制",
                  "admin_panel": "管理后台"
                }.entries)
                  Chip(
                    label: Text(e.value,
                        style: TextStyle(
                            fontSize: 12,
                            color: Auth.can(e.key)
                                ? const Color(0xFF3F51B5)
                                : Colors.grey)),
                    backgroundColor: Auth.can(e.key)
                        ? const Color(0xFF3F51B5).withOpacity(0.08)
                        : Colors.grey.withOpacity(0.08),
                    side: BorderSide(
                        color: Auth.can(e.key)
                            ? const Color(0xFF3F51B5).withOpacity(0.4)
                            : Colors.grey.shade300),
                  ),
              ]),
            ),
          ],
        )),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          icon: const Icon(Icons.logout, color: Colors.red),
          label: const Text("退出登录", style: TextStyle(color: Colors.red)),
          style: OutlinedButton.styleFrom(
              side: const BorderSide(color: Colors.red)),
          onPressed: () async {
            final yes = await showDialog<bool>(
                context: context,
                builder: (_) => AlertDialog(
                        title: const Text("退出登录"),
                        content: const Text("退出后需重新输入账号密码登录。"),
                        actions: [
                          TextButton(
                              onPressed: () => Navigator.pop(context, false),
                              child: const Text("取消")),
                          TextButton(
                              onPressed: () => Navigator.pop(context, true),
                              child: const Text("退出"))
                        ]));
            if (yes != true || !context.mounted) return;
            await AuthApi.logout();
            Auth.user = null;
            Auth.features = {}; // 清空全局会话，防残留身份
            if (!context.mounted) return;
            // 清会话后重建 AuthGate：无会话自动落到登录页
            Navigator.of(context, rootNavigator: true).pushAndRemoveUntil(
                MaterialPageRoute(builder: (_) => const AuthGate()),
                (r) => false);
          },
        ),
      ]),
    );
  }
}

class _ChangePwDialog extends StatefulWidget {
  const _ChangePwDialog();
  @override
  State<_ChangePwDialog> createState() => _ChangePwDialogState();
}

class _ChangePwDialogState extends State<_ChangePwDialog> {
  final _old = TextEditingController(),
      _new = TextEditingController(),
      _new2 = TextEditingController();
  bool _busy = false;
  @override
  void dispose() {
    _old.dispose();
    _new.dispose();
    _new2.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_new.text.length < 6) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text("新密码至少6位")));
      return;
    }
    if (_new.text != _new2.text) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text("两次输入的新密码不一致")));
      return;
    }
    setState(() => _busy = true);
    final r = await AuthApi.changePassword(_old.text, _new.text);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content:
            Text((r["msg"] ?? (r["ok"] == true ? "密码已修改" : "修改失败")).toString()),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
    if (r["ok"] == true) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text("修改密码"),
      content: SizedBox(
          width: 320,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
                controller: _old,
                obscureText: true,
                decoration: const InputDecoration(
                    labelText: "原密码",
                    isDense: true,
                    border: OutlineInputBorder())),
            const SizedBox(height: 10),
            TextField(
                controller: _new,
                obscureText: true,
                decoration: const InputDecoration(
                    labelText: "新密码（≥6位）",
                    isDense: true,
                    border: OutlineInputBorder())),
            const SizedBox(height: 10),
            TextField(
                controller: _new2,
                obscureText: true,
                decoration: const InputDecoration(
                    labelText: "确认新密码",
                    isDense: true,
                    border: OutlineInputBorder())),
          ])),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context), child: const Text("取消")),
        ElevatedButton(
            onPressed: _busy ? null : _submit,
            child: _busy
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : const Text("确定"))
      ],
    );
  }
}

// ===================== 管理员：用户与功能管理 =====================
class UserManagePage extends StatefulWidget {
  const UserManagePage({super.key});
  @override
  State<UserManagePage> createState() => _UserManagePageState();
}

class _UserManagePageState extends State<UserManagePage> {
  List _users = [];
  Map _features = {};
  Map _featureNames = const {};
  bool _autoDispatch = true; // 接单即派全局开关
  bool _loading = true;
  String _err = "";

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _err = "";
    });
    final ru = await AuthApi.users();
    final rc = await AuthApi.config();
    if (!mounted) return;
    if (ru["ok"] != true) {
      setState(() {
        _loading = false;
        _err = (ru["msg"] ?? "加载失败").toString();
      });
      return;
    }
    _users = List.from(ru["users"]);
    if (rc["ok"] == true) {
      _features = Map.from(rc["features"]);
      _featureNames = Map.from(rc["featureNames"] ?? {});
      _autoDispatch = rc["autoDispatch"] != false;
    }
    setState(() => _loading = false);
  }

  Future<void> _addUser() async {
    final uname = TextEditingController(),
        name = TextEditingController(),
        pw = TextEditingController();
    String role = "material";
    final ok = await showDialog<bool>(
        context: context,
        builder: (_) => StatefulBuilder(
            builder: (ctx, setS) => AlertDialog(
                  title: const Text("新建账号"),
                  content: SizedBox(
                      width: 320,
                      child: Column(mainAxisSize: MainAxisSize.min, children: [
                        TextField(
                            controller: uname,
                            decoration: const InputDecoration(
                                labelText: "登录账号（字母数字3-20位）",
                                isDense: true,
                                border: OutlineInputBorder())),
                        const SizedBox(height: 8),
                        TextField(
                            controller: name,
                            decoration: const InputDecoration(
                                labelText: "姓名",
                                isDense: true,
                                border: OutlineInputBorder())),
                        const SizedBox(height: 8),
                        TextField(
                            controller: pw,
                            decoration: const InputDecoration(
                                labelText: "初始密码（≥6位）",
                                isDense: true,
                                border: OutlineInputBorder())),
                        const SizedBox(height: 8),
                        DropdownButtonFormField<String>(
                            value: role,
                            decoration: const InputDecoration(
                                labelText: "角色",
                                isDense: true,
                                border: OutlineInputBorder()),
                            items: const [
                              DropdownMenuItem(
                                  value: "material", child: Text("物料员")),
                              DropdownMenuItem(
                                  value: "warehouse", child: Text("仓管员")),
                              DropdownMenuItem(
                                  value: "inspector", child: Text("检验员")),
                              DropdownMenuItem(
                                  value: "admin", child: Text("管理员"))
                            ],
                            onChanged: (v) =>
                                setS(() => role = v ?? "material")),
                      ])),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(ctx, false),
                        child: const Text("取消")),
                    ElevatedButton(
                        onPressed: () => Navigator.pop(ctx, true),
                        child: const Text("创建"))
                  ],
                )));
    if (ok != true || !mounted) return;
    final r = await AuthApi.createUser(
        uname.text.trim(), name.text.trim(), pw.text, role);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content:
            Text((r["msg"] ?? (r["ok"] == true ? "已创建" : "失败")).toString()),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
    uname.dispose();
    name.dispose();
    pw.dispose();
    _load();
  }

  Future<void> _toggleEnabled(Map u) async {
    final r =
        await AuthApi.updateUser(u["id"], {"enabled": !(u["enabled"] == true)});
    if (r["ok"] != true && mounted)
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text((r["msg"] ?? "操作失败").toString()),
          backgroundColor: Colors.red));
    _load();
  }

  Future<void> _resetPw(Map u) async {
    final pw = TextEditingController();
    final ok = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
              title: Text("重置 ${u["username"]} 的密码"),
              content: SizedBox(
                  width: 280,
                  child: TextField(
                      controller: pw,
                      decoration: const InputDecoration(
                          labelText: "新密码（≥6位）",
                          isDense: true,
                          border: OutlineInputBorder()))),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text("取消")),
                ElevatedButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text("重置"))
              ],
            ));
    if (ok == true && pw.text.length >= 6)
      await AuthApi.updateUser(u["id"], {"password": pw.text});
    pw.dispose();
    _load();
  }

  Future<void> _editFeatures() async {
    final copy = <String, Map<String, bool>>{};
    for (final e in _features.entries) {
      copy[e.key] = Map<String, bool>.from(e.value);
    }
    bool autoDispatch = _autoDispatch;
    await showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (ctx) => StatefulBuilder(builder: (ctx, setS) {
              const roleNames = {
                "material": "物料员",
                "warehouse": "仓管员",
                "inspector": "检验员",
                "admin": "管理员"
              };
              return Padding(
                  padding: EdgeInsets.fromLTRB(
                      16, 16, 16, MediaQuery.of(ctx).viewInsets.bottom + 16),
                  child: SizedBox(
                    height: 500,
                    width: double.infinity,
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text("功能开关（保存后各端心跳刷新，最迟5分钟生效）",
                              style: TextStyle(fontWeight: FontWeight.bold)),
                          const SizedBox(height: 8),
                          Expanded(
                              child: SingleChildScrollView(
                                  child: Column(children: [
                            Card(
                                margin: const EdgeInsets.only(bottom: 8),
                                child: Padding(
                                    padding: const EdgeInsets.all(12),
                                    child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          const Text("AGV 调度",
                                              style: TextStyle(
                                                  fontWeight: FontWeight.bold)),
                                          SwitchListTile(
                                            dense: true,
                                            contentPadding: EdgeInsets.zero,
                                            title: const Text(
                                                "接单即派（领料单被接单后货架框自动入AGV队列）",
                                                style: TextStyle(fontSize: 13)),
                                            subtitle: Text(
                                                autoDispatch
                                                    ? "仓管只管扫码发料，叫车由调度器自动排队"
                                                    : "关闭后需仓管在领料单手动一键叫车",
                                                style: const TextStyle(
                                                    fontSize: 11)),
                                            value: autoDispatch,
                                            onChanged: (v) =>
                                                setS(() => autoDispatch = v),
                                          ),
                                        ]))),
                            for (final role in copy.keys)
                              Card(
                                  child: Padding(
                                      padding: const EdgeInsets.all(12),
                                      child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            Text(roleNames[role] ?? role,
                                                style: const TextStyle(
                                                    fontWeight:
                                                        FontWeight.bold)),
                                            for (final f in copy[role]!.keys)
                                              SwitchListTile(
                                                dense: true,
                                                contentPadding: EdgeInsets.zero,
                                                title: Text(
                                                    _featureNames[f]
                                                            ?.toString() ??
                                                        f,
                                                    style: const TextStyle(
                                                        fontSize: 14)),
                                                value: copy[role]![f] ?? false,
                                                onChanged: (v) => setS(
                                                    () => copy[role]![f] = v),
                                              ),
                                          ]))),
                          ]))),
                          const SizedBox(height: 8),
                          Row(children: [
                            TextButton(
                                onPressed: () => Navigator.pop(ctx),
                                child: const Text("取消")),
                            const Spacer(),
                            ElevatedButton(
                                onPressed: () async {
                                  final r = await AuthApi.setFeatures(copy,
                                      autoDispatch: autoDispatch);
                                  if (ctx.mounted) {
                                    Navigator.pop(ctx);
                                    ScaffoldMessenger.of(ctx)
                                        .showSnackBar(
                                            SnackBar(
                                                content: Text((r["msg"] ??
                                                        (r["ok"] == true
                                                            ? "已保存"
                                                            : "保存失败"))
                                                    .toString()),
                                                backgroundColor: r["ok"] == true
                                                    ? Colors.green
                                                    : Colors.red));
                                  }
                                  _load();
                                },
                                child: const Text("保存")),
                          ]),
                        ]),
                  ));
            }));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("用户与功能管理"), actions: [
        IconButton(
            icon: const Icon(Icons.tune),
            tooltip: "功能开关",
            onPressed: _features.isEmpty ? null : _editFeatures),
        IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
      ]),
      floatingActionButton: FloatingActionButton.extended(
          onPressed: _addUser,
          icon: const Icon(Icons.person_add),
          label: const Text("新建账号")),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : (_err.isNotEmpty
              ? Center(
                  child: Text(_err, style: const TextStyle(color: Colors.red)))
              : ListView(children: [
                  for (final u in _users)
                    Card(
                        child: ListTile(
                      leading: CircleAvatar(
                          backgroundColor: (u["enabled"] == true
                                  ? Colors.green
                                  : Colors.grey)
                              .withOpacity(0.15),
                          child: Icon(
                              u["enabled"] == true ? Icons.check : Icons.block,
                              color: u["enabled"] == true
                                  ? Colors.green
                                  : Colors.grey,
                              size: 20)),
                      title: Text("${u["name"]}（${u["username"]}）"),
                      subtitle: Text("角色：${{
                            "material": "物料员",
                            "warehouse": "仓管员",
                            "admin": "管理员"
                          }[u["role"]] ?? u["role"]}${u["enabled"] == true ? "" : " · 已停用"}"),
                      trailing: PopupMenuButton<String>(
                          onSelected: (v) {
                            if (v == "toggle") _toggleEnabled(Map.from(u));
                            if (v == "pw") _resetPw(Map.from(u));
                            if (v == "del")
                              showDialog(
                                  context: context,
                                  builder: (_) => AlertDialog(
                                          title: Text("删除 ${u["username"]}？"),
                                          content:
                                              const Text("删除后该账号立即失效且不可恢复。"),
                                          actions: [
                                            TextButton(
                                                onPressed: () =>
                                                    Navigator.pop(context),
                                                child: const Text("取消")),
                                            TextButton(
                                                onPressed: () async {
                                                  await AuthApi.deleteUser(
                                                      u["id"]);
                                                  if (context.mounted)
                                                    Navigator.pop(context);
                                                  _load();
                                                },
                                                child: const Text("删除",
                                                    style: TextStyle(
                                                        color: Colors.red)))
                                          ]));
                          },
                          itemBuilder: (_) => const [
                                PopupMenuItem(
                                    value: "toggle", child: Text("启用/停用")),
                                PopupMenuItem(value: "pw", child: Text("重置密码")),
                                PopupMenuItem(
                                    value: "del", child: Text("删除账号")),
                              ]),
                    )),
                ])),
    );
  }
}

// ===================== ㉖B14 偏好云同步：工作模式/语速/语音开关/六类提醒订阅 =====================
class PrefsSync {
  static final ValueNotifier<int> changed = ValueNotifier(0); // 服务器→本地写完后通知UI刷新
  static bool _applying = false;

  /// 登录/me 回传的 prefs 落到本地（到达序新者胜：服务器端按字段at记录，这里整体覆盖本地展示值）
  static Future<void> applyFromServer(dynamic pv) async {
    if (pv is! Map || _applying) return;
    _applying = true;
    try {
      final sp = await SharedPreferences.getInstance();
      final uid = Auth.user?.id ?? "";
      if (pv["work"] != null && uid.isNotEmpty)
        await sp.setInt("worktype_$uid", pv["work"] == 1 ? 1 : 0);
      if (pv["rate"] != null) {
        final v = double.tryParse(pv["rate"].toString()) ?? 0.55;
        await sp.setDouble("remind_speech_rate", v.clamp(0.3, 0.9).toDouble());
      }
      if (pv["voice"] != null)
        await sp.setBool("remind_voice_scan", pv["voice"] != false);
      // 第3档 PDA个性化三项回写
      if (pv["pd_font"] != null)
        await sp.setString(
            "pd_font",
            ['std', 'lg', 'xl'].contains(pv["pd_font"].toString())
                ? pv["pd_font"].toString()
                : "std");
      if (pv["pd_focus"] != null)
        await sp.setBool("pd_focus", pv["pd_focus"] != false);
      if (pv["pd_defAssignee"] != null)
        await sp.setBool("pd_defAssignee", pv["pd_defAssignee"] != false);
      if (pv["pd_defPallet"] != null)
        await sp.setString("pd_defPallet", pv["pd_defPallet"].toString());
      if (pv["pd_dateOffset"] != null) {
        final dd = (int.tryParse(pv["pd_dateOffset"].toString()) ?? 0);
        await sp.setInt(
            "pd_dateOffset",
            dd < 0
                ? 0
                : dd > 90
                    ? 90
                    : dd);
      }
      final n = pv["notes"];
      // ㉖v53 首页模块自定义：顺序/显隐 + 用量 + 习惯开关（落本地，changed 触发主界面重建页签）
      await TabCustom.applyServer(pv["pd_tabs"], pv["pd_tabuse"], pv["pd_tab_auto"]);
      if (n is Map) {
        // ㉖v53 三档分级上云：notes 值兼容 true/false(旧) 与 0/1/2(新)；bool→level(2/0)
        Future<void> setLv(String spKey, dynamic v) async {
          if (v == null) return;
          final lv = v is bool ? (v ? 2 : 0) : ((v is num) ? v.toInt() : 2);
          await sp.setInt(spKey + '_lv', lv.clamp(0, 2));
        }
        await setLv("remind_req_new", n["req_new"]);
        await setLv("remind_req_urge", n["req_urge"]);
        await setLv("remind_req_arrive", n["req_arrive"]);
        await setLv("remind_req_result", n["req_flow"]);
        await setLv("remind_watch_in", n["watch_in"]);
        await setLv("remind_stock_out", n["stock_out"]);
        await setLv("remind_car_alarm", n["car_alarm"]);
        await setLv("remind_inspect", n["inspect"]);
      }
      kFontScaleN.value = kFontScaleOf(sp.getString("pd_font") ?? "std");
      kAutoFocus = sp.getBool("pd_focus") ?? true;
      changed.value++;
    } catch (_) {}
    _applying = false;
  }

  /// 本地任一改后全量上推（fire-and-forget，失败静默，下次改动再带上去）
  static Future<void> pushAll() async {
    if (_applying) return;
    try {
      final sp = await SharedPreferences.getInstance();
      final uid = Auth.user?.id ?? "";
      // ㉖v53 三档等级上云（0/1/2）；服务器 notes 字段向后兼容（web 端读 !==false 仍成立）
      int lvOf(String spKey) => RemindPrefs.levelOfSp(sp, spKey);
      final body = <String, dynamic>{
        "notes": {
          "req_new": lvOf("remind_req_new"),
          "req_urge": lvOf("remind_req_urge"),
          "req_arrive": lvOf("remind_req_arrive"),
          "req_flow": lvOf("remind_req_result"),
          "watch_in": lvOf("remind_watch_in"),
          "stock_out": lvOf("remind_stock_out"),
          "car_alarm": lvOf("remind_car_alarm"),
          "inspect": lvOf("remind_inspect"),
        },
        "rate": sp.getDouble("remind_speech_rate") ?? 0.55,
        "voice": sp.getBool("remind_voice_scan") ?? true,
        // 第3档 PDA个性化三项上推
        "pd_font": sp.getString("pd_font") ?? "std",
        "pd_focus": sp.getBool("pd_focus") ?? true,
        "pd_defAssignee": sp.getBool("pd_defAssignee") ?? true,
        "pd_defPallet": sp.getString("pd_defPallet") ?? "",
        "pd_dateOffset": sp.getInt("pd_dateOffset") ?? 0,
      };
      // ㉖v53 首页模块自定义随偏好全量上云
      try { body.addAll(await TabCustom.cloudPayload()); } catch (_) {}
      if (uid.isNotEmpty) body["work"] = sp.getInt("worktype_$uid") ?? 0;
      await AuthApi.setPrefs(body);
    } catch (_) {}
  }
}
