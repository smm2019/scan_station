import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:isar/isar.dart';
// ignore: unused_import  ← Android 链接 Isar 原生库必需，勿删
import 'package:isar_flutter_libs/isar_flutter_libs.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:vibration/vibration.dart';
import 'package:path_provider/path_provider.dart';
import 'dart:io';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:mime/mime.dart';
import 'dart:convert';
import 'dart:async'; //app_auth 心跳 Timer
// =========【改动1：新增权限依赖导入】=========
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart'; //新增导入
// =========【👉 在这里粘贴 RSA加密 + mesLogin 代码！！】=========
import 'dart:typed_data';
import 'dart:ui' as ui; // ㉖v74 缺料反馈图片分享：RenderRepaintBoundary 截取 PNG
import 'package:flutter/rendering.dart'; // ㉖v74 RenderRepaintBoundary 类型（material 不导出）
import 'dart:math' as math; // 地图页三角函数（part文件共享主库导入）

import 'package:pointycastle/export.dart' hide Padding, State;
import 'package:pointycastle/asn1.dart';
import 'package:http/http.dart' as http;
import 'package:webview_flutter/webview_flutter.dart'; // AGV实时调度大屏WebView
import 'package:audioplayers/audioplayers.dart';
import 'package:archive/archive.dart';
import 'package:sherpa_onnx/sherpa_onnx.dart' as sherpa;
import 'package:flutter_local_notifications/flutter_local_notifications.dart'; // ⑭系统通知
import 'package:flutter_tts/flutter_tts.dart'; // ⑭系统TTS

part 'main.g.dart';
part 'web_service.dart'; // WiFi网页门户：批次列表/任意批次下载/基准CSV上传
part 'inventory_page.dart'; // 盘点模式：任务/基准绑定/扫码判定/差异报表
part 'app_auth.dart'; // 账号登录+角色+服务端鉴权：登录门禁/心跳/远程停用/用户管理
part 'direct_transfer_page.dart'; // MES直调：扫转入货位+物料标签累计，提交SaveTRBarcodes转单
part 'outbound_page.dart'; // 出库单：直调提交落库→逐箱扫码备料核销→导出对照
part 'location_reg_page.dart';
part 'wmas_api.dart';
part 'collection_ledger.dart'; // 位置登记：上架/移库/拣下统一入口 + WPS货架账本导入
part 'inventory_stock_page.dart'; // 库存：期初+入库流水(采集派生)-出库流水(直调派生)，货架库位占用登记
part 'requisition_page.dart'; // 领料单：物料员下单/签收，仓管接单/扫码发料，服务端状态机
part 'agv_api.dart'; // AGV调度系统(哈工库讯RCS)：任务/车辆/交管监控 + 实时大屏WebView + 设置
part 'local_log.dart'; // ⑤本地审计日志 + ⑦全局异常兜底落盘 + 审计查看页
part 'diag_page.dart'; // ⑥设备诊断页
part 'display_prefs_page.dart'; // 第3档 显示与扫码偏好（字号/聚焦/默认框型/领料默认值上云）
part 'inspect_page.dart'; // ㉖④ 检验模式：AGV下架检验→备注→原样归位
part 'tab_custom_page.dart'; // ㉖v53 首页模块自定义：页签顺序/显隐/使用习惯自学习
part 'loc_map_page.dart'; // ③货位占用可视化
part 'dash_page.dart'; // ⑥数据驾驶舱：KPI+7日趋势
part 'agv_map_page.dart'; // ①2D实时地图
part 'agv_report_page.dart'; // ⑦AGV效率报表
part 'update_page.dart'; // ⑬APK自动更新
part 'console_web_page.dart'; // ㉖⑯ 网页控制台驾驶舱（内嵌全功能）
part 'notify_service.dart'; // ⑭系统通知+语音播报
part 'shortage_report_page.dart'; // ㉖v74 缺料反馈：一键生成生产部格式缺料单，分享微信
part 'req_ledger_page.dart'; // ㉖v76 领料账本：时间窗消耗聚合/撑几天预警/一键续领/呆滞榜/报告分享

/// 未读消息计数（30秒轮询累加，打开消息中心清零；领料页铃铛角标用）
final ValueNotifier<int> kUnreadMsgs = ValueNotifier<int>(0);

/// ⑬全局导航key：更新弹窗用（App启动即可弹，不依赖某页面context）
final GlobalKey<NavigatorState> _globalNavigatorKey =
    GlobalKey<NavigatorState>();

/// 全局底部扫码条：固定在页面底部，扫码枪输入永远有落点；提交后由各页处理器清空回焦
class ScanBar extends StatelessWidget {
  final TextEditingController ctrl;
  final FocusNode focus;
  final String hint;
  final void Function(String) onSubmit;
  final VoidCallback? camera;
  const ScanBar(
      {super.key,
      required this.ctrl,
      required this.focus,
      required this.hint,
      required this.onSubmit,
      this.camera});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: EdgeInsets.fromLTRB(
          10, 8, 10, 8 + MediaQuery.of(context).padding.bottom),
      decoration: const BoxDecoration(
          color: Colors.white,
          border: Border(top: BorderSide(color: Color(0xFFE0E0E0)))),
      child: Row(children: [
        Expanded(
            child: TextField(
          controller: ctrl,
          focusNode: focus,
          autofocus: kAutoFocus, // 第3档 扫码自动聚焦开关
          textInputAction: TextInputAction.done,
          decoration: InputDecoration(
              hintText: hint,
              isDense: true,
              filled: true,
              fillColor: const Color(0xFFF2F3FA),
              prefixIcon: const Icon(Icons.qr_code_scanner,
                  size: 20, color: Color(0xFF515BD4)),
              border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(10),
                  borderSide: BorderSide.none),
              contentPadding: const EdgeInsets.symmetric(vertical: 11)),
          onSubmitted: (v) {
            final s = v.trim();
            if (s.isNotEmpty) onSubmit(s);
          },
        )),
        if (camera != null) ...[
          const SizedBox(width: 8),
          SizedBox(
              height: 42,
              child: ElevatedButton(
                  onPressed: camera,
                  style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF515BD4),
                      foregroundColor: Colors.white,
                      padding: const EdgeInsets.symmetric(horizontal: 12)),
                  child: const Text("相机", style: TextStyle(fontSize: 12)))),
        ],
      ]),
    );
  }
}
// ============粘贴刚刚更新好的rsaEncryptPemKey函数============

class MesConfig {
  static const String keyHost = "mes_host";
  static const String keyPort = "mes_port";
  static const keyAccount = "mes_account";
  static const keyPwd = "mes_pwd";
  static const keyToken = "mes_token";
  static const keyTimeout = "mes_timeout";
  // 新增两个key
  static const String keyModuleId = "mes_moduleId";
  static const String keyOrgId = "mes_orgId";

  // ========== 新增：登录返回的 OrgId、UserInfoId 等 ==========
  static const String keyMesOrgId = "mes_org_id";
  static const String keyMesUserId = "mes_user_id";
  static const String keyMesUserName = "mes_user_name";
  static const String keyMesDisplayName = "mes_display_name";
  static const String keyMesModuleId = "mes_module_id";

  //保存配置
  static Future<void> saveConfig({
    required String host,
    required String port,
    required String account,
    required String pwd,
    required String token,
    required int timeout,
    required String moduleId, //新增
    required String orgId, //新增
  }) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(keyHost, host);
    await sp.setString(keyPort, port);
    await sp.setString(keyAccount, account);
    await sp.setString(keyPwd, pwd);
    await sp.setString(keyToken, token);
    await sp.setInt(keyTimeout, timeout);
    // 新增保存
    await sp.setString(keyModuleId, moduleId);
    await sp.setString(keyOrgId, orgId);
  }

  //读取配置
  static Future<Map<String, dynamic>> getConfig() async {
    final sp = await SharedPreferences.getInstance();
    return {
      "host": sp.getString(keyHost) ?? "172.25.1.141",
      "port": sp.getString(keyPort) ?? "6689",
      "account": sp.getString(keyAccount) ?? "",
      "pwd": sp.getString(keyPwd) ?? "",
      "token": sp.getString(keyToken) ?? "",
      "timeout": sp.getInt(keyTimeout) ?? 10,
      //新增读取
      "moduleId": sp.getString(keyModuleId) ?? "",
      "orgId": sp.getString(keyOrgId) ?? "",
    };
  }

  // ========== 清除 Token（退出登录用） ==========
  static Future<void> clearToken() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(keyToken);
    await sp.remove(keyMesOrgId);
    await sp.remove(keyMesUserId);
    await sp.remove(keyMesUserName);
    await sp.remove(keyMesDisplayName);
    await sp.remove(keyMesModuleId);
  }

  // ========== 新增：保存登录成功后的用户信息 ==========
  static Future<void> saveLoginInfo({
    required String token,
    required String orgId,
    required String userId,
    required String userName,
    required String displayName,
    String moduleId = "",
  }) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(keyToken, token);
    await sp.setString(keyMesOrgId, orgId);
    await sp.setString(keyMesUserId, userId);
    await sp.setString(keyMesUserName, userName);
    await sp.setString(keyMesDisplayName, displayName);
    await sp.setString(keyMesModuleId, moduleId);
  }

  // ========== 新增：读取 MES Token ==========
  static Future<String> getToken() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getString(keyToken) ?? "";
  }

  // ========== 新增：读取登录返回的 OrgId ==========
  static Future<String> getOrgId() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getString(keyMesOrgId) ?? "";
  }

  // ========== 新增：读取登录下发的 ModuleId ==========
  static Future<String> getModuleId() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getString(keyMesModuleId) ?? "";
  }

  // ========== 新增：读取用户信息 ==========
  static Future<Map<String, String>> getUserInfo() async {
    final sp = await SharedPreferences.getInstance();
    return {
      "orgId": sp.getString(keyMesOrgId) ?? "",
      "userId": sp.getString(keyMesUserId) ?? "",
      "userName": sp.getString(keyMesUserName) ?? "",
      "displayName": sp.getString(keyMesDisplayName) ?? "",
    };
  }
}

// =========【MesConfig结束】=========

// ===================== 声音/震动设置（持久化） =====================
class AppSettings {
  static const String keySound = "app_sound_enabled";
  static const String keyVibration = "app_vibration_enabled";

  static Future<bool> getSoundEnabled() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getBool(keySound) ?? true;
  }

  static Future<bool> getVibrationEnabled() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getBool(keyVibration) ?? true;
  }

  static Future<void> setSoundEnabled(bool v) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(keySound, v);
  }

  static Future<void> setVibrationEnabled(bool v) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(keyVibration, v);
  }
}

// ===================== Isar数据库模型 =====================

@collection
class ScanRecord {
  Id id = Isar.autoIncrement;
  DateTime scanTime;
  int workType; //0=AGV站台模式，1=人工地面摆放模式
  String? stationNo; //【修改：由int?改为String，存储NB02-CK-05这类编码】

  String? groundLocation; //地面货位A1‑D18，仅模式1使用
  String goodsCode;
  String? containerType; // 新增这一行！用来存容器类型
  String remark;
  String batchId;
  bool isCancel = false; //标记：true=人工作废，保留原始数据，仅业务失效，不可用于站台占用校验
  //=====新增MES字段，只加这3行=====
  String? mesPartNo; //零件号 PartCode
  double? mesQty; //数量 QTY
  String? mesCreateTime; //MES DATETIME_CREATED
  ScanRecord({
    required this.scanTime,
    required this.workType,
    this.stationNo,
    this.groundLocation,
    required this.goodsCode,
    required this.remark,
    required this.batchId,
    this.isCancel = false,
    this.containerType, // 新增
// =========【BUG在这里！！】=========
    // 你构造函数写了 mesProduceDate，但类里面字段名字是 mesCreateTime，名字不一致！
    this.mesPartNo,
    this.mesQty,
    this.mesCreateTime, //把原来的 mesProduceDate 改成 mesCreateTime
  });
}

@collection
class BatchInfo {
  Id id = Isar.autoIncrement;
  String batchId;
  String createTime;
  List<String> usedStation = []; //【修改：由List<int>改为List<String>，存储站台编码】
  //====本次新增字段====
  String batchRemark = "";
  bool isArchived = false;
  int taskKind = 0; //0=采集批次，1=盘点任务（盘点独立于采集批次体系展示）
  //====盘点任务元数据（taskKind==1 时有效）====
  String invBookKey = ""; //绑定的账面基准 fileKey
  String invLocKey = ""; //绑定的货位基准 fileKey
  bool blindMode = true; //盲盘：现场不显示账面数量对照
  List<String> invScope = []; //循环盘点范围：货架前缀列表（如 MB02-A-01），空=全盘
  BatchInfo({
    required this.batchId,
    required this.createTime,
    this.batchRemark = "",
    this.isArchived = false,
    this.taskKind = 0,
    this.invBookKey = "",
    this.invLocKey = "",
    this.blindMode = true,
    this.invScope = const [],
  });
}

// ===================== 全局Isar实例 =====================
@collection
class RecordExtra {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  String goodsCode; // 关联 ScanRecord.goodsCode（货码唯一）
  String palletId = ""; // 托号，空串=非整托记录
  String mesItemName = ""; // 物料描述（MES返回名称字段）
  String mesLotNo = ""; // 批次（MES返回LOT_NO）
  String operator = ""; // 采集操作人（登录账号姓名，库存入库流水用）
  RecordExtra({
    required this.goodsCode,
    this.palletId = "",
    this.mesItemName = "",
    this.mesLotNo = "",
    this.operator = "",
  });
}
// ===================== 盘点·基准CSV解析 =====================

/// 解析一行CSV（支持双引号包裹、"" 转义、字段内含逗号）
List<String> _parseCsvLine(String line) {
  final out = <String>[];
  final cur = StringBuffer();
  bool inQuote = false;
  for (var i = 0; i < line.length; i++) {
    final ch = line[i];
    if (inQuote) {
      if (ch == '"') {
        if (i + 1 < line.length && line[i + 1] == '"') {
          cur.write('"');
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur.write(ch);
      }
    } else {
      if (ch == '"') {
        inQuote = true;
      } else if (ch == ',') {
        out.add(cur.toString().trim());
        cur.clear();
      } else {
        cur.write(ch);
      }
    }
  }
  out.add(cur.toString().trim());
  return out;
}

/// 列名匹配：在表头里找候选关键字（先精确包含，再模糊），返回列下标或-1
int _findCol(List<String> header, List<String> keys) {
  for (var k = 0; k < header.length; k++) {
    final h = header[k].replaceAll(RegExp(r"\s"), "");
    for (final key in keys) {
      if (h == key) return k;
    }
  }
  for (var k = 0; k < header.length; k++) {
    final h = header[k].replaceAll(RegExp(r"\s"), "");
    for (final key in keys) {
      if (h.contains(key)) return k;
    }
  }
  return -1;
}

/// 数量解析：容忍 "1,234.00"、"60"、空、"-"
double _parseQtyCell(String v) {
  var s = v.replaceAll(RegExp(r"[,\s]"), "").replaceAll("，", "");
  if (s.isEmpty || s == "-" || s == "—" || s == "/") return 0;
  return double.tryParse(s) ?? 0;
}

class BaselineParseResult {
  String kind = "unknown"; //book=账面基准 part=货位基准 unknown=未识别
  final List<BaselineBook> books = [];
  final List<BaselineLoc> locs = [];
  int dirtyRows = 0; //数量非法/关键字段缺失而跳过的行数
  String message = "";
}

/// 解析基准CSV并判定类型。book：零件号+库存类列；part：货位编码+零件号+数量
BaselineParseResult parseBaselineCsv(String rawContent, String fileKey) {
  final res = BaselineParseResult();
  var text = rawContent;
  if (text.isNotEmpty && text.codeUnitAt(0) == 0xFEFF)
    text = text.substring(1); //去BOM
  text = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  final lines = text.split("\n").where((l) => l.trim().isNotEmpty).toList();
  if (lines.length < 2) {
    res.kind = "unknown";
    res.message = "文件行数不足（需表头+数据行）";
    return res;
  }

  final header = _parseCsvLine(lines.first);
  final colPart = _findCol(header, [
    "零件号",
    "PartCode",
    "零件编号",
    "料号",
    "物料编码",
    "物料号",
    "Part No",
    "partno",
    "零件代码"
  ]);
  final colQty = _findCol(header,
      ["期末库存", "库存数量", "账面数量", "在库数量", "结存数量", "账面库存", "数量", "Qty", "库存"]);
  final colLoc = _findCol(
      header, ["货位编码", "货位", "库位", "库位编码", "货架位", "储位", "Location", "货位号"]);
  final colName =
      _findCol(header, ["物料名称", "零件名称", "品名", "物料描述", "MITEM_NAME", "名称"]);
  final colCode =
      _findCol(header, ["标签号", "货物标签", "货码", "标签", "LabelNo", "条码"]);

  final isLocBase = colLoc >= 0 && colPart >= 0 && colQty >= 0;
  final isBookBase = colPart >= 0 && colQty >= 0;
  if (isLocBase) {
    res.kind = "part";
  } else if (isBookBase) {
    res.kind = "book";
  } else {
    res.kind = "unknown";
    res.message =
        "未识别的基准表头。零件号列:${colPart >= 0 ? "已找到" : "缺失"}、数量列:${colQty >= 0 ? "已找到" : "缺失"}"
        "${colLoc >= 0 ? "、货位列:已找到(但缺零件号或数量列)" : ""}";
    return res;
  }

  final Map<String, BaselineBook> bookMap = {};
  final Map<String, BaselineLoc> locMap = {};
  for (var i = 1; i < lines.length; i++) {
    final cols = _parseCsvLine(lines[i]);
    String cell(int idx) => (idx >= 0 && idx < cols.length) ? cols[idx] : "";
    final part = cell(colPart);
    if (part.isEmpty) continue; //空零件号行直接忽略（多为小计/空行）
    final qty = _parseQtyCell(cell(colQty));
    if (res.kind == "book") {
      if (bookMap.containsKey(part)) {
        bookMap[part]!.bookQty += qty;
      } else {
        bookMap[part] = BaselineBook(
            fileKey: fileKey,
            partNo: part,
            itemName: cell(colName),
            bookQty: qty);
      }
    } else {
      final loc = cell(colLoc);
      if (loc.isEmpty) {
        res.dirtyRows++;
        continue;
      }
      final key = "$loc|$part";
      if (locMap.containsKey(key)) {
        final old = locMap[key]!;
        old.qty += qty;
        final gc = cell(colCode);
        if (gc.isNotEmpty && old.goodsCode.isEmpty) old.goodsCode = gc;
      } else {
        locMap[key] = BaselineLoc(
            fileKey: fileKey,
            locCode: loc,
            partNo: part,
            qty: qty,
            goodsCode: cell(colCode));
      }
    }
  }
  res.books.addAll(bookMap.values);
  res.locs.addAll(locMap.values);
  if (res.kind == "book" && res.books.isEmpty) {
    res.kind = "unknown";
    res.message = "表头可识别，但未解析到任何含零件号的数据行";
  }
  if (res.kind == "part" && res.locs.isEmpty) {
    res.kind = "unknown";
    res.message = "表头可识别，但未解析到任何含货位+零件号的数据行";
  }
  return res;
}

// ===================== 盘点·判定与差异计算 =====================

/// 单码判定结果（对应 InventoryScan.flag）
class InvJudge {
  final int flag;
  final String msg;
  final String level; //green/orange/yellow/red/purple
  const InvJudge(this.flag, this.level, this.msg);
}

/// 状态机判定（按优先级短路）。调用方需已完成重复码检测。
/// locBookQty: 该货位该零件的台账数量；scannedQtyInLoc: 本任务该货位该零件已扫合计（含本次）
InvJudge judgeInventory({
  required bool partInBook,
  required bool partInLoc,
  required double scannedQtyInLoc,
  required double locBookQty,
}) {
  if (!partInBook) {
    return const InvJudge(3, "red", "账外物料：该零件号账面基准中不存在");
  }
  if (!partInLoc) {
    return const InvJudge(4, "yellow", "串位提示：该货位台账无此零件，仍已记录");
  }
  if (locBookQty > 0 && scannedQtyInLoc > locBookQty) {
    return const InvJudge(5, "yellow", "超量：本货位该零件实扫已超台账数量");
  }
  return const InvJudge(0, "green", "正常");
}

/// 账面基准（零件号级）：来源=基础数据表导出CSV，fileKey=基准文件标识（文件名+mtime）
@collection
class BaselineBook {
  Id id = Isar.autoIncrement;
  String fileKey;
  @Index(unique: true)
  String partNo;
  String itemName = "";
  double bookQty = 0; //期末库存
  BaselineBook(
      {required this.fileKey,
      required this.partNo,
      this.itemName = "",
      this.bookQty = 0});
}

/// 货位基准（货位×零件级）：来源=二楼货架列表导出CSV
@collection
class BaselineLoc {
  Id id = Isar.autoIncrement;
  String fileKey;
  @Index()
  String locCode; //货位编码 NB02-A-01-1F
  @Index()
  String partNo;
  double qty = 0;
  String goodsCode = ""; //台账预登记货码（可空，仅参考，不做拦截）
  BaselineLoc(
      {required this.fileKey,
      required this.locCode,
      required this.partNo,
      this.qty = 0,
      this.goodsCode = ""});
}

/// 盘点扫描流水：一次盘点任务内每扫一码一行，独立于 ScanRecord，不污染采集数据
@collection
class InventoryScan {
  Id id = Isar.autoIncrement;
  @Index()
  String taskId; //盘点任务号（=BatchInfo.batchId，前缀INV）
  @Index()
  String goodsCode; //实扫货码
  String locCode = ""; //扫码时绑定的盘点货位
  DateTime scanTime;
  String partNo = ""; //MES反查
  String itemName = "";
  String lotNo = ""; //MES LOT_NO
  double qty = 0; //MES QTY
  int flag = 0; //判定：0正常 1重复 2MES无码 3账外料 4串位 5超量 6批次不符(挂起)
  String remark = "";
  InventoryScan(
      {required this.taskId,
      required this.goodsCode,
      required this.scanTime,
      this.locCode = ""});
}

// ===================== 全局Isar实例 =====================
late Isar _globalIsar;

// ===== ㉖v52 采集批次·全链路聚合（借鉴网页端批次详情，一次查询出全部派生指标）=====
// 一次批量读 scanRecords + recordExtras + shelfPlacements + outboundOrders，按框口径派生：
// 有效/作废、零件数、框数、件数合计、整托组数、在架数、已出库数、MES缺失数、容器分布、托明细。
class BatchAgg {
  final List<ScanRecord> records;
  final Map<String, RecordExtra> extraMap;
  final Map<String, String> locMap; // 标签→账本当前货位（在架）
  final Set<String> outCodes; // 已出库标签（出库台账∪领料已发缓存由调用方并入）
  int valid = 0, cancelled = 0, boxes = 0, pallets = 0, onShelf = 0, shipped = 0, noMes = 0;
  double qtySum = 0;
  final Set<String> partNos = {};
  final Map<String, int> containerDist = {};
  // 托明细：pid → {partNo, itemName, boxes, qty, codes, loc}
  final List<Map<String, dynamic>> palletRows = [];
  BatchAgg(this.records, this.extraMap, this.locMap, this.outCodes);
}

/// 核心派生：records 就地排序后一次遍历出全部指标。
/// 框口径与库存模块 computeStock 完全同源：托号优先 → 采集位+零件号 → 单码；同键合并计 1 框。
/// 在架/已出库按标签粒度计（流水进度视角，与记录卡逐行状态一致）。
BatchAgg _aggOf(List<ScanRecord> records, Map<String, RecordExtra> extraMap, Map<String, String> locMap, Set<String> outCodes) {
  records.sort((a, b) => a.scanTime.compareTo(b.scanTime));
  final agg = BatchAgg(records, extraMap, locMap, outCodes);
  final boxGroups = <String, List<ScanRecord>>{}; // 框键 → 标签（合并后 1 键 = 1 框）
  final byPallet = <String, Map<String, List<ScanRecord>>>{}; // 托 → 零件 → 标签（汇总行）
  for (final r in records) {
    final gc = r.goodsCode.toUpperCase();
    if (r.isCancel) {
      agg.cancelled++;
      continue;
    }
    agg.valid++;
    final pn = (r.mesPartNo ?? "").trim();
    if (pn.isEmpty) {
      agg.noMes++;
    } else {
      agg.partNos.add(pn);
      agg.qtySum += r.mesQty ?? 0;
    }
    final ct = (r.containerType ?? "").trim();
    if (ct.isNotEmpty) agg.containerDist[ct] = (agg.containerDist[ct] ?? 0) + 1;
    agg._slot(gc); // 标签粒度：在架 / 已出库
    final loc = r.workType == 0 ? (r.stationNo ?? "") : (r.groundLocation ?? "");
    final pid = extraMap[gc]?.palletId ?? "";
    final bk = pid.isNotEmpty
        ? "P|$pid"
        : (loc.isNotEmpty && pn.isNotEmpty ? "L|$loc|$pn" : "C|$gc");
    (boxGroups[bk] ??= []).add(r);
    if (pid.isNotEmpty) {
      ((byPallet[pid] ??= {})[pn.isEmpty ? "未知(MES未查到)" : pn] ??= []).add(r);
    }
  }
  agg.boxes = boxGroups.length;
  byPallet.forEach((pid, byPart) {
    agg.pallets++;
    byPart.forEach((pn, rs) {
      final first = rs.first;
      final names = rs.map((e) => extraMap[e.goodsCode.toUpperCase()]?.mesItemName ?? "").where((e) => e.isNotEmpty).toSet().join("；");
      agg.palletRows.add({
        "palletId": pid,
        "partNo": pn,
        "itemName": names,
        "n": rs.length, // 托内该零件标签码数（框合并前）
        "qty": rs.fold<double>(0, (s, e) => s + (e.mesQty ?? 0)),
        "codes": rs.map((e) => e.goodsCode).join("；"),
        "loc": locMap[first.goodsCode.toUpperCase()] ?? (first.stationNo ?? first.groundLocation ?? ""),
      });
    });
  });
  agg.palletRows.sort((a, b) => a["palletId"].toString().compareTo(b["palletId"].toString()));
  return agg;
}

Future<Map<String, RecordExtra>> _extraMapOf(Isar isar) async {
  final extras = await isar.recordExtras.where().findAll();
  return {for (final e in extras) e.goodsCode.toUpperCase(): e};
}
Future<Map<String, String>> _locMapOf(Isar isar) async {
  final ps = await isar.shelfPlacements.where().findAll();
  return {for (final p in ps) p.goodsCode.toUpperCase(): p.loc};
}
Future<Set<String>> _outCodesOf(Isar isar, Set<String>? issuedExtra) async {
  final outCodes = <String>{};
  for (final o in await isar.outboundOrders.where().findAll()) {
    try {
      for (final e in (jsonDecode(o.itemsJson) as List)) {
        outCodes.add(((e as Map)["barcode"]?.toString() ?? "").toUpperCase());
      }
    } catch (_) {}
  }
  if (issuedExtra != null) outCodes.addAll(issuedExtra.map((e) => e.toUpperCase()));
  return outCodes;
}

/// 单批次聚合（详情页用）
Future<BatchAgg> computeBatchAgg(Isar isar, String batchId, {Set<String>? issuedExtra}) async {
  final records = await isar.scanRecords.filter().batchIdEqualTo(batchId).findAll();
  return _aggOf(records, await _extraMapOf(isar), await _locMapOf(isar), await _outCodesOf(isar, issuedExtra));
}

/// 多批次聚合（历史页用）：四张表各一次全量读，逐批派生——消除逐卡 N+1 查询
Future<Map<String, BatchAgg>> computeBatchAggAll(Isar isar, List<String> batchIds, {Set<String>? issuedExtra}) async {
  final out = <String, BatchAgg>{};
  if (batchIds.isEmpty) return out;
  final all = await isar.scanRecords.where().findAll();
  final extraMap = await _extraMapOf(isar);
  final locMap = await _locMapOf(isar);
  final outCodes = await _outCodesOf(isar, issuedExtra);
  final idSet = batchIds.toSet();
  final byBatch = <String, List<ScanRecord>>{};
  for (final r in all) {
    if (idSet.contains(r.batchId)) (byBatch[r.batchId] ??= []).add(r);
  }
  for (final id in batchIds) {
    out[id] = _aggOf(byBatch[id] ?? [], extraMap, locMap, outCodes);
  }
  return out;
}

extension on BatchAgg {
  void _slot(String gc) {
    if (locMap.containsKey(gc)) {
      onShelf++;
    } else if (outCodes.contains(gc)) {
      shipped++;
    }
  }
}

String _fmtBatchQty(double q) =>
    q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);

Widget _kpiMini(String v, String t, Color c) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    decoration: BoxDecoration(
        color: c.withOpacity(.07),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: c.withOpacity(.25))),
    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(v, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: c)),
      Text(t, style: const TextStyle(fontSize: 9.5, color: Colors.black54)),
    ]));

// ===== 整托模式·末段子表：与主表同12列结构，按托聚合一行 =====
// 一行 = 一托×一个零件号：货物标签"; "拼接、MES数量累加、采集时间取该组首码、托号填列；
// 非整托有效记录逐码原样一行（托号留空）。本批次无整托记录时不输出该段。
String _buildPalletAggCsv(
    List<ScanRecord> records, Map<String, RecordExtra> extraMap) {
  String cf(String v) {
    if (v.contains(",") || v.contains("\"") || v.contains("\n"))
      return "\"${v.replaceAll("\"", "\"\"")}\"";
    return v;
  }

  String fq(double q) =>
      q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);
  final Map<String, List<ScanRecord>> groups = {}; //插入顺序=首扫时间顺序
  bool hasPallet = false;
  for (final r in records) {
    if (r.isCancel) continue;
    final pid = extraMap[r.goodsCode]?.palletId ?? "";
    if (pid.isEmpty) {
      groups.putIfAbsent("SINGLE|${r.goodsCode}|${r.id}", () => []).add(r);
    } else {
      hasPallet = true;
      final pn =
          (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
      groups.putIfAbsent("$pid|$pn", () => []).add(r);
    }
  }
  if (!hasPallet) return "";
  String s = "\n===整托汇总·主表同列版(一行=托+零件号，多码拼接、数量累加)===\n";
  s += "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期,托号\n";
  for (final entry in groups.entries) {
    final rs = entry.value;
    final first = rs.first;
    final timeStr = first.scanTime.toString().substring(0, 19);
    String st = "", gl = "", container = "", batch = "";
    for (final e in rs) {
      if (st.isEmpty) st = e.stationNo ?? "";
      if (gl.isEmpty) gl = e.groundLocation ?? "";
      if (container.isEmpty) container = e.containerType ?? "";
      if (batch.isEmpty) batch = e.mesCreateTime ?? "";
    }
    final codes = rs.map((e) => e.goodsCode).join("; ");
    final remarks = rs
        .map((e) => e.remark)
        .where((e) => e.trim().isNotEmpty)
        .toSet()
        .join("；");
    final pn = (first.mesPartNo?.isNotEmpty ?? false)
        ? first.mesPartNo!
        : (entry.key.contains("|") && !entry.key.startsWith("SINGLE|")
            ? entry.key.substring(entry.key.indexOf("|") + 1)
            : "");
    final totalQty = rs.fold<double>(0, (sum, e) => sum + (e.mesQty ?? 0));
    final pid = entry.key.startsWith("SINGLE|")
        ? ""
        : entry.key.substring(0, entry.key.indexOf("|"));
    s +=
        "$timeStr,${first.workType},${cf(st)},${cf(gl)},${cf(container)},${cf(codes)},${cf(remarks)},正常,${cf(pn)},${fq(totalQty)},${cf(batch)},${cf(pid)}\n";
  }
  return s;
}

// ===================== MES登录（手动登录与静默重登共用） =====================
/// 阶段1：获取RSA公钥与一次性KeyToken
Future<Map<String, String>?> getValidateKey2(
    String serverIp, String serverPort, String userId, int timeoutSec) async {
  try {
    final baseUrl = "http://$serverIp:$serverPort";
    final uri =
        Uri.parse("$baseUrl/platform/sign/getvalidatekey2?u=$userId&isweb=Y");
    final headers = {
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
      "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Culture": "zh-CN",
    };
    debugPrint("【阶段1】请求getvalidatekey2：$uri");
    final resp = await http
        .get(uri, headers: headers)
        .timeout(Duration(seconds: timeoutSec));
    debugPrint("【阶段1】接口返回code:${resp.statusCode}");
    if (resp.statusCode == 200) {
      final jsonObj = jsonDecode(resp.body);
      bool success = jsonObj["success"] ?? false;
      if (!success) {
        debugPrint("【阶段1】接口返回失败：${jsonObj["message"]}");
        return null;
      }
      final data = jsonObj["data"];
      String publicKey = data["PublicKey"];
      String keyToken = data["KeyToken"];
      debugPrint("【阶段1】获取公钥成功，KeyToken=$keyToken");
      return {
        "publicKey": publicKey,
        "keyToken": keyToken,
      };
    } else {
      debugPrint("【阶段1】http请求失败，status=${resp.statusCode}");
      return null;
    }
  } catch (e) {
    debugPrint("【阶段1】异常：$e");
    return null;
  }
}

/// 阶段2：公钥PEM→RSA(PKCS#1 v1.5)加密密码，返回Base64密文。失败抛异常（含诊断信息）
String rsaEncryptPassword(String pubPem, String plainPwd) {
  final diag = StringBuffer();
  String hexOf(List<int> b, int n) =>
      b.take(n).map((x) => x.toRadixString(16).padLeft(2, '0')).join(' ');
  diag.writeln("【诊断v2】公钥长度=${pubPem.length}");
  diag.writeln(
      "公钥原文(前100字符)=${pubPem.length > 100 ? pubPem.substring(0, 100) : pubPem}");
  try {
    var b64 = pubPem
        .replaceAll(r'\r\n', '')
        .replaceAll(r'\n', '')
        .replaceAll(r'\r', '')
        .replaceAll(RegExp(r'-----[a-zA-Z0-9 ]+-----'), '')
        .replaceAll(RegExp(r'[^A-Za-z0-9+/=]'), '');
    while (b64.length % 4 != 0) {
      b64 = "$b64="; // 补齐服务端可能省略的base64末尾padding
    }
    diag.writeln("清洗后base64长度=${b64.length}");
    var pemBytes = Uint8List.fromList(base64.decode(b64));
    diag.writeln("第一次解码后长度=${pemBytes.length} 前16字节=${hexOf(pemBytes, 16)}");
    // 防双重base64：若解出来仍是PEM文本（首字节0x2D即'-'），剥头后再解码一次
    if (pemBytes.isNotEmpty && pemBytes[0] == 0x2D) {
      final innerText = String.fromCharCodes(pemBytes);
      var innerB64 = innerText
          .replaceAll(RegExp(r'-----[a-zA-Z0-9 ]+-----'), '')
          .replaceAll(RegExp(r'[^A-Za-z0-9+/=]'), '');
      while (innerB64.length % 4 != 0) {
        innerB64 = "$innerB64=";
      }
      pemBytes = Uint8List.fromList(base64.decode(innerB64));
      diag.writeln(
          "检测到双重base64→第二次解码后长度=${pemBytes.length} 前16字节=${hexOf(pemBytes, 16)}");
    }
    // 解析 SubjectPublicKeyInfo: SEQUENCE { AlgorithmIdentifier, BIT STRING }
    final asn1Parser = ASN1Parser(pemBytes);
    final topLevel = asn1Parser.nextObject();
    diag.writeln("顶层类型=${topLevel.runtimeType}");
    if (topLevel is! ASN1Sequence ||
        topLevel.elements == null ||
        topLevel.elements!.length < 2) {
      throw Exception("顶层不是含≥2元素的SEQUENCE，实际类型=${topLevel.runtimeType}");
    }
    final topElements = topLevel.elements!;
    diag.writeln(
        "顶层元素数=${topElements.length} 类型=${topElements.map((x) => x.runtimeType).join(',')}");
    // SPKI第2个元素是BIT STRING：其value字节去掉首字节(unusedbits)才是内层RSAPublicKey
    final ASN1Sequence pubKeySeq;
    if (topElements[1] is ASN1BitString) {
      final bitString = topElements[1] as ASN1BitString;
      final innerDer = Uint8List.fromList(bitString.valueBytes!.sublist(1));
      diag.writeln(
          "走SPKI分支 内层长度=${innerDer.length} 前16字节=${hexOf(innerDer, 16)}");
      pubKeySeq = ASN1Parser(innerDer).nextObject() as ASN1Sequence;
    } else {
      diag.writeln("走裸RSAPublicKey分支");
      pubKeySeq = topLevel; // 兜底：服务端直接返回RSAPublicKey结构
    }
    final pubElements = pubKeySeq.elements;
    if (pubElements == null || pubElements.length < 2) {
      throw Exception("公钥PEM解析失败：公钥序列元素不足");
    }
    diag.writeln(
        "公钥序列元素数=${pubElements.length} 类型=${pubElements.map((x) => x.runtimeType).join(',')}");
    final int1 = pubElements[0] as ASN1Integer;
    final int2 = pubElements[1] as ASN1Integer;
    diag.writeln(
        "元素0位数=${int1.integer?.bitLength} 元素1位数=${int2.integer?.bitLength}");
    // 按数值大小自动识别：模数n是大数，指数e通常是65537
    final BigInt n =
        (int1.integer! > int2.integer!) ? int1.integer! : int2.integer!;
    final BigInt e =
        (int1.integer! > int2.integer!) ? int2.integer! : int1.integer!;
    diag.writeln("最终采用 模数位数=${n.bitLength} 指数=$e");
    debugPrint("【阶段2】模数位数=${n.bitLength} 指数=$e");
    // ⚠️pointycastle的RSAPublicKey构造函数参数顺序是(modulus, exponent)——模数在前！
    final pubKey = RSAPublicKey(n, e);
    // PKCS1-v1_5填充：直接实例化，不依赖注册表别名
    final cipher = PKCS1Encoding(RSAEngine())
      ..init(true, PublicKeyParameter<RSAPublicKey>(pubKey));
    // 执行加密并转为 Base64 字符串
    Uint8List dataRaw = Uint8List.fromList(utf8.encode(plainPwd));
    Uint8List encryptedRaw = cipher.process(dataRaw);
    final encryptedPwd = base64.encode(encryptedRaw);
    debugPrint("【阶段2成功】加密完成");
    return encryptedPwd;
  } catch (e, stack) {
    debugPrint("【阶段2 RSA加密异常】$e \n $stack");
    throw Exception("RSA加密失败：$e\n----诊断----\n$diag");
  }
}

/// 三阶段完整登录：返回 token/orgId/userId/userName/displayName/moduleId；失败抛异常（带诊断详情，供手动登录弹窗）
Future<Map<String, String>> mesPerformLogin({
  required String ip,
  required String port,
  required String account,
  required String pwd,
  required int timeoutSec,
}) async {
  // =========阶段1：获取RSA公钥 KeyToken=========
  final validateResult = await getValidateKey2(ip, port, account, timeoutSec);
  if (validateResult == null) {
    throw Exception("阶段1失败：获取公钥接口返回空，请检查账号/服务器地址");
  }
  final String keyToken = validateResult["keyToken"]!;
  // =========阶段2：RSA加密密码=========
  final String encryptedPwd =
      rsaEncryptPassword(validateResult["publicKey"]!, pwd);
  // =========阶段3：提交登录请求，获取token=========
  final String baseUrl = "http://$ip:$port";
  debugPrint("【阶段3】请求登录接口 $baseUrl/platform/sign/signin2");
  final loginResp = await http
      .post(
        Uri.parse("$baseUrl/platform/sign/signin2"),
        headers: {
          "Content-Type": "application/json;charset=utf-8",
          "Accept": "*/*",
          "Accept-Encoding": "gzip, deflate",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
          "Culture": "zh-CN",
          "EnterpriseId": "*",
          "X-TZ-Offset": "-480",
          "Referer": "$baseUrl/h5/login.html",
          "Origin": "$baseUrl",
          "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0 Safari/537.36 Edg/153.0.0",
        },
        body: jsonEncode([account, encryptedPwd, keyToken]),
      )
      .timeout(Duration(seconds: timeoutSec));
  if (loginResp.statusCode != 200) {
    throw Exception(
        "阶段3失败：登录接口Http状态码${loginResp.statusCode}，返回：${loginResp.body}");
  }
  final loginJson = jsonDecode(loginResp.body);
  if (loginJson["success"] != true) {
    throw Exception("阶段3失败：登录接口success=false，返回内容：${loginResp.body}");
  }
  final dataObj = loginJson["data"];
  if (dataObj is! Map) {
    throw Exception("阶段3失败：返回的data不是对象：${loginResp.body}");
  }
  // ===== token获取：实测鼎捷MES把token放在 signin2 响应头 "token"(小写)，优先取头，再兜底体 =====
  String token = "";
  for (final h in [
    "token",
    "access-token",
    "accesstoken",
    "x-token",
    "x-access-token",
    "authorization"
  ]) {
    final v = loginResp.headers[h];
    if (v != null && v.trim().isNotEmpty) {
      token = v
          .trim()
          .replaceFirst(RegExp(r'^Bearer\s+', caseSensitive: false), '');
      debugPrint("【阶段3】token来自响应头 $h");
      break;
    }
  }
  if (token.isEmpty) {
    for (final k in [
      "token",
      "Token",
      "access_token",
      "accessToken",
      "AccessToken"
    ]) {
      final v = dataObj[k]?.toString();
      if (v != null && v.isNotEmpty) {
        token = v;
        break;
      }
    }
  }
  if (token.isEmpty) {
    final headerDump =
        loginResp.headers.entries.map((e) => "${e.key}: ${e.value}").join("\n");
    throw Exception("阶段3失败：登录成功但响应体和响应头都没找到token。\n----响应头----\n$headerDump");
  }
  // ===== 用户信息解析：兼容camelCase与服务器实际的snake_case =====
  String pick(List<String> keys) {
    for (final k in keys) {
      final v = dataObj[k]?.toString();
      if (v != null && v.isNotEmpty) return v;
    }
    return "";
  }

  final String userId =
      pick(["userId", "user_id", "UserInfoId", "userinfo_id"]);
  final String userName = pick(["userName", "user_name"]);
  final String displayName = pick(["displayName", "display_name"]);
  String orgId = pick(["orgId", "org_id"]);
  if (orgId.isEmpty && dataObj["organizations"] is List) {
    // 从组织列表取默认组织（is_default=true 或 str_default=Y）
    final orgs = dataObj["organizations"] as List;
    for (final o in orgs) {
      if (o is Map &&
          (o["is_default"] == true || o["str_default"]?.toString() == "Y")) {
        orgId = o["id"]?.toString() ?? "";
        break;
      }
    }
    if (orgId.isEmpty && orgs.first is Map) {
      orgId = (orgs.first as Map)["id"]?.toString() ?? "";
    }
  }
  // 查询接口的 ModuleId 来自登录响应头
  final String loginModuleId = (loginResp.headers["moduleid"] ?? "").trim();
  debugPrint("【阶段3成功】token获取成功 orgId=$orgId ModuleId=$loginModuleId");
  return {
    "token": token,
    "orgId": orgId,
    "userId": userId,
    "userName": userName,
    "displayName": displayName,
    "moduleId": loginModuleId,
  };
}

/// 静默重登：用已存账号密码重走三阶段登录并刷新token。成功true；任何失败false（不弹窗不抛出）
Future<bool> mesSilentLogin() async {
  try {
    final cfg = await MesConfig.getConfig();
    final ip = cfg["host"].toString().trim();
    final port = cfg["port"].toString().trim();
    final account = cfg["account"].toString().trim();
    final pwd = cfg["pwd"].toString().trim();
    final int timeoutSec = (cfg["timeout"] as int?) ?? 10;
    if (ip.isEmpty || account.isEmpty || pwd.isEmpty) {
      debugPrint("MES静默重登跳过：账号/密码/地址未配置");
      return false;
    }
    final r = await mesPerformLogin(
        ip: ip, port: port, account: account, pwd: pwd, timeoutSec: timeoutSec);
    await MesConfig.saveLoginInfo(
      token: r["token"]!,
      orgId: r["orgId"]!,
      userId: r["userId"]!,
      userName: r["userName"]!,
      displayName: r["displayName"]!,
      moduleId: r["moduleId"]!,
    );
    debugPrint("MES静默重登成功");
    return true;
  } catch (e) {
    debugPrint("MES静默重登失败：$e");
    return false;
  }
}

// ===================== MES单码查询（采集页/盘点页共用；失效自动静默重登并重试一次） =====================
/// ㉖ 批次口径：以 MES 标签打印时间(DATETIME_CREATED)的日期为准。
/// 例 "2026-10-13T08:56:55" → "2026-10-13"。解析不出则回退 [fallback]（原 LOT_NO），绝不返回空。
String lotFromPrintDate(String printTime, String fallback) {
  final s = printTime.trim();
  final p = (int n) => n.toString().padLeft(2, '0');
  final m = RegExp(r'^(\d{4})[-/](\d{1,2})[-/](\d{1,2})').firstMatch(s);
  if (m != null) return '${m.group(1)}-${p(int.parse(m.group(2)!))}-${p(int.parse(m.group(3)!))}';
  if (s.isNotEmpty) {
    final dt = DateTime.tryParse(s);
    if (dt != null) return '${dt.year}-${p(dt.month)}-${p(dt.day)}';
  }
  return fallback;
}
/// 返回：成功 {ok:true, partNo, qty, createTime, itemName, lotNo[, relogin:true 表示本次经历了自动重登]}
///      失败 {ok:false, msg}；Token失效 msg 以"MES登录已失效"开头。
Future<Map<String, dynamic>> mesQueryLabel(String labelNo) async {
  var result = await _mesQueryOnce(labelNo);
  final String failMsg = result["msg"]?.toString() ?? "";
  final bool needRelogin = result["ok"] != true &&
      (failMsg.startsWith("MES登录已失效") || failMsg.startsWith("MES Token为空"));
  if (needRelogin) {
    debugPrint("MES查询失效，尝试静默重登…");
    final bool relogged = await mesSilentLogin();
    if (relogged) {
      result = await _mesQueryOnce(labelNo);
      if (result["ok"] == true) {
        result["relogin"] = true;
      }
    }
  }
  return result;
}

/// 单次查询（不含重登逻辑）
Future<Map<String, dynamic>> _mesQueryOnce(String labelNo) async {
  try {
    final mesCfg = await MesConfig.getConfig();
    String baseUrl = "http://${mesCfg["host"]}:${mesCfg["port"]}";
    String token = mesCfg["token"];
    if (token.isEmpty) return {'ok': false, 'msg': 'MES Token为空，请到设置页登录MES'};
    final uri = Uri.parse("$baseUrl/api/station/label/GetLableList")
        .replace(queryParameters: {
      "start": "0",
      "length": "20",
      "mitemCode": "",
      "mitemName": "",
      "warehouseCode": "",
      "baseCode": "",
      "baseName": "",
      "districtCode": "",
      "locCode": "",
      "supplierCode": "",
      "lotNo": "",
      "labelNo": labelNo,
      "status": "",
      "poNo": "",
      "bDate": "",
      "eDate": "",
      "warehouse": "",
      "mitemSize": "",
      "supplier": "",
    });
    final httpClient = HttpClient();
    final req = await httpClient.getUrl(uri);
    req.headers.set("Culture", "zh-CN");
    req.headers.set("EnterpriseId", "*");
    String moduleId = (mesCfg["moduleId"] ?? "").toString().trim();
    if (moduleId.isEmpty) moduleId = (await MesConfig.getModuleId()).trim();
    if (moduleId.isEmpty) moduleId = "CE7F61BD526C424996CF6CE00211B86A";
    String orgIdHdr = (mesCfg["orgId"] ?? "").toString().trim();
    if (orgIdHdr.isEmpty) orgIdHdr = (await MesConfig.getOrgId()).trim();
    req.headers.set("ModuleId", moduleId);
    req.headers.set("OrgId", orgIdHdr);
    req.headers.set("ModulePage", "/h5/pages/LABEL/MitemLabelQuery/index.html");
    req.headers.set("X-TZ-Offset", "-480");
    req.headers.set("Token", token);
    req.headers.set("Accept", "*/*");
    req.headers.set("Content-Type", "application/json; charset=utf-8");
    final resp = await req.close();
    final respBody = await resp.transform(utf8.decoder).join();
    if (resp.statusCode == 401 || resp.statusCode == 403) {
      return {
        'ok': false,
        'msg': 'MES登录已失效(HTTP ${resp.statusCode})，自动重登后仍失败，请到设置页重新登录MES'
      };
    }
    dynamic decoded;
    try {
      decoded = jsonDecode(respBody);
    } catch (_) {
      decoded = null;
    }
    if (decoded is! Map<String, dynamic>) {
      return {'ok': false, 'msg': 'MES登录已失效，响应非JSON，自动重登后仍失败，请到设置页重新登录MES'};
    }
    if (decoded["success"] == true && decoded["data"] != null) {
      final rawData = decoded["data"]["data"];
      final List rows =
          rawData is List ? rawData : (rawData is Map ? [rawData] : const []);
      if (rows.isEmpty)
        return {
          'ok': false,
          'found': false, // ㉖v69 明确"查无此码"（区别于网络/登录失败），采集/盘点据此禁止录入
          'msg':
              'MES查询结果为空(recordsTotal=${decoded["data"]["recordsTotal"]})，OrgId=$orgIdHdr ModuleId=$moduleId，请确认该货码在MES中有在库标签且组织范围正确'
        };
      final row = rows.first as Map;
      final String _ct = row["DATETIME_CREATED"]?.toString() ?? '';
      return {
        'ok': true,
        'partNo': (row["PartCode"] ?? row["MITEM_CODE"])?.toString() ?? '',
        'qty': (row["QTY"] as num?)?.toDouble() ?? 0,
        'createTime': _ct,
        'itemName':
            (row["MITEM_NAME"] ?? row["MitemName"] ?? row["mitemName"] ?? "")
                .toString(),
        // ㉖ 批次口径（用户拍板）：以 MES 标签打印日期为准（2026-10-13T08:56:55 → 2026-10-13）；
        // 打印时间缺失或不可解析时回退原 LOT_NO，绝不返回空。
        'lotNo': lotFromPrintDate(_ct,
            (row["LOT_NO"] ?? row["lotNo"] ?? "").toString()),
      };
    }
    final String msg = decoded["message"]?.toString() ?? '';
    final bool auth = RegExp(
            r"token|session|unauthor|forbidden|invalid|expire|过期|失效|未授权|未登录|重新登录|登录",
            caseSensitive: false)
        .hasMatch(msg);
    return {
      'ok': false,
      'msg': auth ? 'MES登录已失效：$msg，自动重登后仍失败，请到设置页重新登录MES' : 'MES接口返回异常：$msg'
    };
  } catch (e) {
    return {'ok': false, 'msg': 'MES查询异常：$e'};
  }
}

/// ㉖v69 标签号格式闸（采集录入/盘点共用，用户拍板）：必须 N 开头 + 总长恰好 10 位
/// 返回 null=合法；否则返回给用户看的拒绝原因
String? labelFormatErr(String code) {
  final c = code.trim().toUpperCase();
  if (c.isEmpty) return "标签号为空";
  if (!c.startsWith("N")) return "标签号「$c」不是 N 开头，请核对实物标签";
  if (c.length != 10) return "标签号「$c」长度 ${c.length} 位（要求 N+9 位共 10 位），请核对是否漏扫/多扫";
  return null;
}

// ===================== 盘点·任务/基准/差异服务 =====================
/// 盘点基准文件目录（与网页上传的 baseline/ 同目录）
Future<Directory> _inventoryBaselineDir() async {
  final docs = await getApplicationDocumentsDirectory();
  final dir = Directory('${docs.path}/baseline');
  if (!await dir.exists()) await dir.create(recursive: true);
  return dir;
}

/// 列出 baseline 目录下可用作基准的 CSV/TXT（按修改时间倒序）
Future<List<Map<String, dynamic>>> listBaselineFiles() async {
  final dir = await _inventoryBaselineDir();
  final files = dir.listSync().whereType<File>().where((f) {
    final n = f.path.toLowerCase();
    return n.endsWith('.csv') || n.endsWith('.txt');
  }).toList()
    ..sort((a, b) => b.statSync().modified.compareTo(a.statSync().modified));
  return files.map((f) {
    final st = f.statSync();
    final name = f.uri.pathSegments.last;
    final key = '$name@${st.modified.millisecondsSinceEpoch}';
    return {
      'name': name,
      'path': f.path,
      'fileKey': key,
      'size': st.size,
      'mtime': st.modified.toIso8601String()
    };
  }).toList();
}

/// 把某个基准文件解析入库（同名 fileKey 覆盖式重导：先删该 kind 旧数据再写）。
/// kind: book=账面基准 / part=货位基准
Future<BaselineParseResult> importBaselineFile(
    String path, String fileKey, String kind) async {
  final raw = await File(path).readAsString(encoding: utf8);
  final res = parseBaselineCsv(raw, fileKey);
  if (res.kind == "unknown") return res;
  await _globalIsar.writeTxn(() async {
    if (res.kind == "book") {
      await _globalIsar.baselineBooks.where().deleteAll();
      await _globalIsar.baselineBooks.putAll(res.books);
    } else {
      await _globalIsar.baselineLocs.where().deleteAll();
      await _globalIsar.baselineLocs.putAll(res.locs);
    }
  });
  return res;
}

// ===================== 程序入口 =====================
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // 错误显形：release下build抛异常不再灰屏，而是红字显示原因，便于现场定位
  ErrorWidget.builder = (FlutterErrorDetails d) => Container(
      color: const Color(0xFFFFEBEE),
      padding: const EdgeInsets.all(12),
      alignment: Alignment.topLeft,
      child: SingleChildScrollView(
          child: Text('界面渲染异常：\n${d.exception}',
              style: const TextStyle(color: Color(0xFFB71C1C), fontSize: 12))));
  await Isar.initializeIsarCore(download: true);
  final dir = await getApplicationDocumentsDirectory();
  _globalIsar = await Isar.open(
    [
      ScanRecordSchema,
      BatchInfoSchema,
      RecordExtraSchema,
      BaselineBookSchema,
      BaselineLocSchema,
      InventoryScanSchema,
      OutboundOrderSchema,
      InventoryOpeningSchema,
      ShelfPlacementSchema,
      LabelInfoSchema
    ],
    directory: dir.path,
  );
  await LocalLog.init(dir.path); // 日志先行：否则后续初始化异常无处可记
  LocalLog.pruneOld();
  await VoicePack.crashGuard(); // ⑯上次若崩在语音合成，本次自动禁用离线引擎
  await NotifyService.init(); // ⑭通知渠道+TTS预热
  LocalLog.op('启动', 'AGV货位采集器');
  // ⑦全局异常兜底：未捕获异常写审计日志，App 不闪退
  FlutterError.onError = (d) {
    FlutterError.presentError(d);
    LocalLog.err('Flutter', d.exception, d.stack);
  };
  WidgetsBinding.instance.platformDispatcher.onError = (e, s) {
    LocalLog.err('未捕获', e, s);
    return true;
  };
  try {
    final sp = await SharedPreferences.getInstance();
    kFontScaleN.value = kFontScaleOf(sp.getString("pd_font") ?? "std");
    kAutoFocus = sp.getBool("pd_focus") ?? true;
  } catch (_) {}
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: _globalNavigatorKey,
      title: "AGV货位采集器",
      theme: ThemeData(primarySwatch: Colors.blue),
      builder: (ctx, child) => ValueListenableBuilder<double>(
          valueListenable: kFontScaleN,
          child: child, // 修复：漏传 child 致 builder 的 ch 恒 null，ch! 必炸(真机全屏红)
          builder: (c2, v, ch) => MediaQuery(
              data:
                  MediaQuery.of(ctx).copyWith(textScaler: TextScaler.linear(v)),
              child: ch!)),
      home: const AuthGate(), //登录门禁：无有效会话显示登录页
      debugShowCheckedModeBanner: false,
    );
  }
}

class MainPage extends StatefulWidget {
  const MainPage({super.key});
  @override
  State<MainPage> createState() => _MainPageState();
}

class _MainPageState extends State<MainPage>
    with SingleTickerProviderStateMixin {
  late Isar _isar;
  String? _currentBatchId;
  int _workType = 0; //0 AGV站台，1人工地面
  String? _selectedStation; //【修改：存储编码 NB02-CK-05】
  String? _lastScanStation; // ㉖ 扫码保存后站台即清，留作手动「提交任务」回退
  String? _lastScanContainer; // ㉖ 容器类型同左
  String? _selectedGroundLoc;
  String? _containerType;
  // ㉖ 容器类型可配置：默认5项兜底，登录后从服务器拉取覆盖
  final List<Map<String, String>> _containers = [
    {"db": "1800*1200_2", "show": "1.8米铁框"},
    {"db": "1600*1100", "show": "1.6米铁框"},
    {"db": "2.4米铁框", "show": "2.4米铁框"},
    {"db": "华强铁框", "show": "华强铁框"},
    {"db": "托盘", "show": "托盘"},
  ];
  final TextEditingController _ledgerLocCtrl =
      TextEditingController(); //采集页顺手登记：货位账本编码（选填）
  Timer? _ledgerSyncTimer; //账本同步防抖：连扫攒一批再全量推
  String _autoCallTip = ""; // ㉒自动叫车结果状态条（常驻，防SnackBar被"采集保存成功"顶掉）
  String _autoCallCode = ""; // ㉖v69 提示条对应的货物标签号：队列刷新时校验任务是否还活着，没了就自动撤提示
  // ㉖ 采集页 AGV 队列：本账号活跃任务计数与明细（叫车结果/在途位置可见，与领料页同交互）
  List<Map> _myQueue = [];
  Map<String, int> _myQueueCnt = {};
  String _queueMode = "dry";
  Timer? _myQueueTimer;

  final TextEditingController _goodsInputCtrl = TextEditingController();
  final TextEditingController _remarkInputCtrl = TextEditingController();
  final FocusNode _goodsFocusNode = FocusNode(); //【新增】货码输入框焦点控制器
// 滚动控制器
  final ScrollController _mainScrollCtrl = ScrollController();
// GlobalKey 用于定位三个区域
  final GlobalKey _keyContainerArea = GlobalKey();
  final GlobalKey _keyLocationArea = GlobalKey();
  final GlobalKey _keyScanInputArea = GlobalKey();

  /// 滚动到指定GlobalKey组件
  Future<void> _scrollToKey(GlobalKey key) async {
    final ctx = key.currentContext;
    if (ctx == null) return;
    await Scrollable.ensureVisible(
      ctx,
      duration: const Duration(milliseconds: 350),
      alignment: 0.15, // 目标区域在视口偏上一点，方便查看
    );
  }

  //【修改区域列表，A~H】
  final List<String> _locGroup = ["A", "B", "C", "D", "E", "F", "G", "H"];
  String _curLocGroup = "A";
  //【修改标签列表，匹配截图标签】
  final List<String> _quickRemarkTags = ["设变件", "验证件", "海外版"];
  final List<String> _extraTags = ["易碎轻放", "优先入库", "需拍照留存"];
  // =========改动2‑1：单选变量替换为集合，支持多选标签=========
  final Set<String> _selectedTags = {};
  List<ScanRecord> _recordList = [];
  bool _isSaving = false;
  //====【布局改动新增变量：统计、折叠面板、Tab控制器】====
  int _normalCount = 0;
  int _cancelCount = 0;
  bool _recordPanelExpanded = false;
  late TabController _tabController;
  bool _showCollect = true,
      _showInv = true,
      _showDirect = true,
      _showReq = true,
      _showAgv = true,
      _showInsp = false; // 角色化Tab可见性（㉖④ 检验模式按 inspect_mode 权限）
  List<String> _tabKeys = const [];
  List<String> _selectedBatchIds = [];
  // ㉖v52 历史批次页：搜索/筛选/展开状态 + 聚合结果缓存（数据变更后置空重拉）
  String _histQ = "", _histF = "";
  bool _histExpand = false;
  Future<Map<String, dynamic>>? _histFut;
  void _histInvalidate() => _histFut = null;
  Future<Map<String, dynamic>> _loadBatchAgg() {
    return _histFut ??= () async {
      final batches = await _isar.batchInfos.where().findAll();
      final ids = batches.where((b) => b.taskKind == 0).map((b) => b.batchId).toList();
      final issued = await RequisitionCache.loadIssued();
      final agg = await computeBatchAggAll(_isar, ids, issuedExtra: issued);
      return {"batches": batches, "agg": agg};
    }();
  }
  // ===== 整托合并模式状态 =====
  bool _palletMode = false; //整托开关
  String? _currentPalletId; //当前托号（首码自动创建）
  List<Map<String, dynamic>> _palletSummary =
      []; //本托汇总 [{partNo,itemName,boxes,qty}]
  int _palletTotalBoxes = 0; //本托已扫框数
  String _fmtQty(double q) =>
      q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);

  HttpServer? _webServer;
  bool _webServiceRunning = false;
  String? _localIpAddress;
  static const int _webPort = 8090;
  Timer? _notifTimer; //领料通知轮询
  @override
  void initState() {
    super.initState();
    _isar = _globalIsar;
    //初始化Tab控制器：按角色动态生成（物料员只见库存/领料/AGV，仓管全量）
    final role = Auth.user?.role ?? "";
    final wh = role == 'warehouse' || role == 'admin';
    _showCollect = Auth.can("collect");
    _showInv = Auth.can("inventory");
    _showDirect = Auth.can("direct_transfer");
    _showReq = wh || Auth.can("requisition") || Auth.can("receive_confirm");
    _showAgv = wh || Auth.can("agv_monitor");
    _showInsp = Auth.can("inspect_mode");
    _tabKeys = [
      if (_showCollect) 'collect',
      if (_showCollect) 'history',
      if (_showInv) 'inv',
      if (_showDirect) 'direct',
      'stock',
      if (_showReq) 'req',
      if (_showAgv) 'agv',
      if (_showInsp) 'insp'
    ];
    _tabController = TabController(length: _tabKeys.length, vsync: this);
    _tabController.addListener(_onTabSettled); // ㉖v53 页签驻留计时
    TabCustom.enter(_tabKeys.first); // ㉖v53 起始页开始计时
    TabCustom.restore().then((_) => _applyCustomTabs()); // ㉖v53 应用自定义顺序/显隐
    kNotifTap.addListener(_onNotifTap); // ⑭点系统通知直达领料页
    _startNotifPolling();
    _restoreWorkMode(); // ②按登录账号恢复上次工作模式（AGV站台/人工地面）
    _loadContainers(); // ㉖ 容器类型从服务器拉取（新增框型免发版）
    _applyDefaultPallet(); // 第3档 按偏好预填默认框型（减少每托重复点选）
    // ㉖ 我的AGV任务：进页拉一次 + 叫车成功广播即时刷 + 30秒轮询跟进排队→在途→到站
    _loadMyQueue();
    kAgvQueueTick.addListener(_loadMyQueue);
    _myQueueTimer =
        Timer.periodic(const Duration(seconds: 30), (_) => _loadMyQueue());
    PrefsSync.changed.addListener(_onPrefsChanged); // ㉖B14 服务器偏好回写后刷新工作模式
    //【修复BUG：重启后统计为0】原写法 _loadLastBatch 与 _refreshRecord 并发执行，
    //刷新时批次号还没恢复，直接return导致看板0/0/0、记录共0条；改为串行初始化
    _initLoadData();
  }

  // ㉖v53 应用自定义页签顺序/显隐（restore 完成后；无自定义时保持默认零开销）
  Future<void> _applyCustomTabs() async {
    final keys = await TabCustom.resolve();
    if (!mounted || keys.length == _tabKeys.length && keys.every((k) => _tabKeys.contains(k)) && keys.join() == _tabKeys.join()) return;
    final cur = _tabKeys[_tabController.index];
    final old = _tabController;
    final ni = keys.indexOf(cur);
    _tabController = TabController(length: keys.length, vsync: this, initialIndex: ni < 0 ? 0 : ni);
    _tabController.addListener(_onTabSettled);
    old.removeListener(_onTabSettled);
    old.dispose();
    setState(() => _tabKeys = keys);
    TabCustom.enter(keys[_tabController.index]);
  }

  // ㉖v53 页签切换落定：结算上一页驻留时长，开始新页计时；顺带 60 秒节流上云
  int _lastTabFlush = 0;
  void _onTabSettled() {
    if (!_tabController.indexIsChanging) {
      // 动画结束才结算，滑过不算
      TabCustom.enter(_tabKeys[_tabController.index]);
      final now = DateTime.now().millisecondsSinceEpoch;
      if (now - _lastTabFlush > 60000) {
        _lastTabFlush = now;
        TabCustom.flush();
      }
    }
  }

  ///【修复BUG：新增】启动数据加载：先恢复当前批次号，再刷新记录列表与统计
  Future<void> _initLoadData() async {
    await _loadLastBatch(); // 恢复 _currentBatchId（或弹窗新建批次）
    if (!mounted) return;
    if (_currentBatchId == null) return; // 用户取消新建，保持空状态
    await _refreshRecord(); // 加载本批次采集记录
    await _refreshBatchStat(); // 刷新正常/作废统计
    if (_palletMode) await _refreshPalletSummary();
  }

  /// ㉖系统通知点击：按类型精准直达（领料详情/AGV/库存/检验/消息中心）
  void _onNotifTap() {
    final v = kNotifTap.value;
    if (v.isEmpty || !mounted) return;
    kNotifTap.value = "";
    _recountUnread();
    final head = v.split("@").first;
    final kind = head.contains("|") ? head.split("|").first : head;
    final rid = head.contains("|") ? head.split("|").last : "";
    String tab = "req";
    if (kind == "car_alarm" || kind == "transfer_done")
      tab = "agv";
    else if (kind == "watch_in" || kind == "stock_out")
      tab = "inv";
    else if (kind == "inspect")
      tab = "insp";
    else if (kind.isEmpty) {
      _openHub();
      return;
    }
    final i = _tabKeys.indexOf(tab);
    if (i >= 0) {
      _tabController.animateTo(i);
    } else if (_tabKeys.indexOf("req") >= 0)
      _tabController.animateTo(_tabKeys.indexOf("req"));
    if (rid.isNotEmpty && kind.startsWith("req"))
      kReqJump.value = "${rid}@${DateTime.now().millisecondsSinceEpoch}";
  }

  Future<void> _openHub() async {
    await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => MessageHubPage(
                  onOpenReq: () => _tabController.animateTo(
                      _tabKeys.indexOf("req") >= 0
                          ? _tabKeys.indexOf("req")
                          : 0),
                  onOpenAgv: () => _tabController.animateTo(
                      _tabKeys.indexOf("agv") >= 0
                          ? _tabKeys.indexOf("agv")
                          : (_tabKeys.indexOf("req") >= 0
                              ? _tabKeys.indexOf("req")
                              : 0)),
                )));
    _recountUnread();
  }

  /// ㉖v50 重算未读：直接用服务端 read 标志的权威计数（只读接口，不消耗已读）
  Future<void> _recountUnread() async {
    try {
      final r = await AuthApi.notificationsUnread();
      if (r["ok"] == true && mounted) {
        kUnreadMsgs.value = (r["unread"] as num?)?.toInt() ?? 0;
      }
    } catch (_) {}
  }

  /// 领料通知轮询：每30秒拉一次（㉖v50 只读不消耗），未读消息弹横幅，点击跳领料页
  void _startNotifPolling() {
    _notifTimer?.cancel();
    _notifTimer = Timer.periodic(
        const Duration(seconds: 30), (_) => _pollNotifications());
  }

  int _srvFails = 0; // G1 服务器失联计数：连续10次轮询失败(约5分钟)报警一次，恢复复位
  bool _srvDownWarned = false;
  Set<String> _bannerSeen = {}; // ㉖v50 已弹过横幅的消息 id（接口只读后防重复轰炸）
  final Map<String, String> _bannerDay = {}; // ㉖v54 类型→最近弹横幅日：每类每天只打扰一次，后续静默进消息中心
  Future<void> _pollNotifications() async {
    if (Auth.user == null) return;
    final r = await AuthApi.notifications();
    if (!mounted || r["ok"] != true) {
      _srvFails++;
      if (_srvFails >= 10 && !_srvDownWarned) {
        _srvDownWarned = true;
        unawaited(NotifyService.speak("服务器连接中断，请检查网络"));
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
              content: Text("⚠️ 服务器失联超过5分钟：同步与通知已暂停，请联系管理员检查服务器"),
              backgroundColor: Colors.redAccent,
              duration: Duration(seconds: 8)));
      }
      return;
    }
    if (_srvFails > 0) {
      _srvFails = 0;
      _srvDownWarned = false;
    }
    if (!mounted) return;
    final list = List<Map>.from(r["notifications"] ?? []);
    if (list.isEmpty) return;
    // ㉖v50 接口改只读后未读会常驻：按消息 id 本地去重，只对"本轮新出现"的弹横幅
    list.removeWhere((m) => _bannerSeen.contains(m["id"]?.toString() ?? ""));
    if (list.isEmpty) return;
    for (final m in list) {
      _bannerSeen.add(m["id"]?.toString() ?? "");
    }
    if (_bannerSeen.length > 600) {
      _bannerSeen = _bannerSeen.skip(_bannerSeen.length - 400).toSet();
    }
    // ㉖v53 三档分级：仅"弹横幅档"(=2)进横幅；静默档(=1)只更新角标不打扰，关闭档(=0)服务器不发
    final sp = await SharedPreferences.getInstance();
    int lvOf(Map m) {
      final key = RemindPrefs.keyOf(m["type"]?.toString() ?? "");
      return key == null ? 2 : RemindPrefs.levelOfSp(sp, key); // 未归类类型默认弹
    }
    final pop = list.where((m) => lvOf(m) == 2).toList();
    if (pop.isEmpty) return; // 本轮全是静默消息：角标靠服务端 unread 计数，无需任何横幅
    // ㉖v54 每类横幅每天只打扰一次：当日再来的同类自动静默（消息中心角标计数不变），car_alarm 安全底线豁免
    final _d0 = DateTime.now();
    final _today = "${_d0.year}-${_d0.month}-${_d0.day}";
    pop.removeWhere((m) { final k = m["type"]?.toString() ?? ""; return k != "car_alarm" && _bannerDay[k] == _today; });
    if (pop.isEmpty) return;
    for (final m in pop) { final _k = m["type"]?.toString() ?? ""; if (_k != "car_alarm") _bannerDay[_k] = _today; } // 本轮合并横幅已打扰，涉及类型当日不再弹
    final first = pop.first;
    final text = first["text"]?.toString() ?? "领料单有新消息";
    // ⑭系统通知（悬浮横幅/锁屏/息屏可达）：按类别开关，点击直达领料页
    final kind = first["type"]?.toString() ?? "";
    if (RemindPrefs.keyOf(kind) != null || kind == "inspect") {
      final rid = first["reqId"]?.toString() ?? "";
      final pno = first["partNo"]?.toString() ?? "";
      const _nt = {
        "req_new": "📥 新领料单",
        "req_timeout": "⏱ 领料超时",
        "req_reassign": "🔄 转派通知",
        "req_urge": "⏰ 催单提醒",
        "req_arrive": "📍 到站提醒",
        "req_accept": "🙋 接单动态",
        "req_ready": "✅ 备齐提醒",
        "req_ready_wh": "✅ 备齐动态",
        "req_done": "📦 签收动态",
        "req_confirm": "📦 签收动态",
        "req_reject": "⛔ 拒单动态",
        "req_cancel": "🚫 取消动态",
        "req_flow": "🔄 流转动态",
        "watch_in": "🔔 预约到料",
        "stock_out": "⚠️ 断料预警",
        "car_alarm": "🚨 车辆告警",
        "transfer_done": "🛒 移库完成",
        "night_digest": "🌙 夜间汇总"
      };
      unawaited(NotifyService.push(kind, _nt[kind] ?? "📦 领料提醒", text,
          payload: rid.isEmpty ? kind : (kind + "|" + rid)));
    }
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(pop.length > 1 ? "$text（共 ${pop.length} 条新消息）" : text,
          maxLines: 2, overflow: TextOverflow.ellipsis),
      backgroundColor: const Color(0xFF37474F),
      duration: const Duration(seconds: 6),
      action: SnackBarAction(
          label: "查看",
          textColor: Colors.amber,
          onPressed: () {
            _openHub(); // ㉖v50 直达消息中枢看详情；角标由服务端权威计数自动更新
          }),
    ));
  }

  @override
  void dispose() {
    TabCustom.flush(); // ㉖v53 退页结算驻留时长上云
    kNotifTap.removeListener(_onNotifTap);
    PrefsSync.changed.removeListener(_onPrefsChanged); // ㉖B14
    kAgvQueueTick.removeListener(_loadMyQueue); // ㉖ 队列刷新监听释放
    _myQueueTimer?.cancel();
    _notifTimer?.cancel();
    _tabController.removeListener(_onTabSettled); // ㉖v53
    _tabController.dispose();
    _goodsFocusNode.dispose(); //【新增】释放焦点资源
    _goodsInputCtrl.dispose();
    _remarkInputCtrl.dispose();
    _mainScrollCtrl.dispose(); //新增
    _ledgerSyncTimer?.cancel();
    _ledgerLocCtrl.dispose(); //采集页顺手登记资源
    super.dispose();
  }

  ///【MOD‑新增2：刷新正常/作废统计，替换原有统计】
  Future<void> _refreshBatchStat() async {
    if (_currentBatchId == null) return;
    final records = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .findAll();
    setState(() {
      _normalCount = records.where((r) => !r.isCancel).length;
      _cancelCount = records.where((r) => r.isCancel).length;
    });
  }

  ///【整托：刷新当前托汇总卡片，按零件号分组累加数量】
  Future<void> _refreshPalletSummary() async {
    if (!_palletMode || _currentPalletId == null) {
      setState(() {
        _palletSummary = [];
        _palletTotalBoxes = 0;
      });
      return;
    }
    //取本托所有未作废记录（含MES失败记录，零件号空归入"未知"）
    final palletCodes = await _isar.recordExtras
        .filter()
        .palletIdEqualTo(_currentPalletId!)
        .findAll();
    final codeSet = palletCodes.map((e) => e.goodsCode).toSet();
    final extraMap = {for (var e in palletCodes) e.goodsCode: e};
    final records = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .isCancelEqualTo(false)
        .findAll();
    final Map<String, Map<String, dynamic>> grouped = {};
    int totalBoxes = 0;
    for (final r in records) {
      if (!codeSet.contains(r.goodsCode)) continue;
      totalBoxes++;
      final pn =
          (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
      final g = grouped.putIfAbsent(
          pn, () => {"partNo": pn, "itemName": "", "boxes": 0, "qty": 0.0});
      g["boxes"] = (g["boxes"] as int) + 1;
      g["qty"] = (g["qty"] as double) + (r.mesQty ?? 0);
      final name = extraMap[r.goodsCode]?.mesItemName ?? "";
      if ((g["itemName"] as String).isEmpty && name.isNotEmpty)
        g["itemName"] = name;
    }
    final list = grouped.values.toList()
      ..sort((a, b) => (b["boxes"] as int).compareTo(a["boxes"] as int));
    setState(() {
      _palletSummary = list;
      _palletTotalBoxes = totalBoxes;
    });
  }

  ///【整托：结束当前托，释放货位/站台，准备开下一托】
  Future<void> _endPallet() async {
    if (_currentPalletId == null) return;
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("结束本托"),
        content: Text("本托已扫 $_palletTotalBoxes 框，确认结束并释放货位，开始下一托？"),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text("取消")),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text("确认结托")),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    // AGV站台：结托后该站台才算占用完毕，保留选中清除以便扫下一托
    setState(() {
      _currentPalletId = null;
      _palletSummary = [];
      _palletTotalBoxes = 0;
      _selectedStation = null;
      _lastScanStation = null;
      _lastScanContainer = null;
      _selectedGroundLoc = null;
      _containerType = null;
      _ledgerLocCtrl.clear(); //整托结托：顺手登记参数归零
    });
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text("本托已结束，请选择新货位开下一托")));
  }

  ///【整托：开关切换】
  Future<void> _togglePalletMode(bool on) async {
    if (on == _palletMode) return;
    if (!on && _currentPalletId != null) {
      final ok = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text("关闭整托模式"),
          content: const Text("当前托尚未结束，关闭将结束本托并释放货位，确认？"),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text("取消")),
            TextButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text("确认")),
          ],
        ),
      );
      if (ok != true || !mounted) return;
    }
    setState(() {
      _palletMode = on;
      _currentPalletId = null;
      _palletSummary = [];
      _palletTotalBoxes = 0;
      _selectedStation = null;
      _lastScanStation = null; // ㉖⑬ 切整托开关：回退记忆同步归零，防脏回退
      _lastScanContainer = null;
      _selectedGroundLoc = null;
      _containerType = null;
      _ledgerLocCtrl.clear(); //切整托开关：顺手登记参数归零
    });
  }

  Future<void> _loadLastBatch() async {
    List<BatchInfo> allBatch = await _isar.batchInfos.where().findAll();
    allBatch = allBatch.where((b) => b.taskKind == 0).toList(); //盘点任务不进入采集批次体系
    if (allBatch.isNotEmpty) {
      //只筛选未归档批次作为可采集候选
      final active = allBatch.where((b) => !b.isArchived).toList();
      if (active.isNotEmpty) {
        active.sort((a, b) => b.createTime.compareTo(a.createTime));
        setState(() {
          _currentBatchId = active.first.batchId;
        });
      }
    }
    // 无未归档批次时保持空状态：不弹框、不自动建批，由操作者本人点「+ 新建采集批次」创建
  }

  //====修改：新建批次弹窗，增加批次备注输入====
  Future<void> _createNewBatch() async {
    if (_webServiceRunning) {
      await stopWebService();
    }
    final TextEditingController batchRemarkCtrl = TextEditingController();
    final confirmCreate = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("新建采集批次"),
        content: TextField(
          controller: batchRemarkCtrl,
          decoration: InputDecoration(
            hintText: "填写备注，例: 3号库区 白班",
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text("取消")),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text("确认新建")),
        ],
      ),
    );
    if (confirmCreate != true) return;
    final nowStr = DateTime.now()
        .toString()
        .substring(0, 16)
        .replaceAll(" ", "-")
        .replaceAll(":", "");
    final newBatch = BatchInfo(
      batchId: "B$nowStr",
      createTime: DateTime.now().toString(),
      batchRemark: batchRemarkCtrl.text.trim(),
    );
    await _isar.writeTxn(() async {
      await _isar.batchInfos.put(newBatch);
    });
    LocalLog.op('新建批次', newBatch.batchId);
    setState(() {
      _currentBatchId = newBatch.batchId;
      _selectedStation = null;
      _lastScanStation = null;
      _lastScanContainer = null;
      _selectedGroundLoc = null;
      _selectedTags.clear(); //新建批次清空多选标签
      _ledgerLocCtrl.clear(); //顺手登记参数归零
      _remarkInputCtrl.clear();
      _containerType = null;
      // 新批次开始，结束未完成的托
      _currentPalletId = null;
      _palletSummary = [];
      _palletTotalBoxes = 0;
    });
    _refreshRecord();
    await _refreshBatchStat();
  }

  Future<BatchInfo?> _getCurrentBatch() async {
    if (_currentBatchId == null) return null;
    return await _isar.batchInfos
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .findFirst();
  }

  //====本次新增校验：禁止向已归档批次录入数据====
  Future<bool> _checkBatchArchived() async {
    final batch = await _getCurrentBatch();
    if (batch?.isArchived == true) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text("当前批次已归档，不可新增采集记录！")));
      }
      return true;
    }
    return false;
  }

  /// ㉖① 全局标签查重：服务器 labelSeen 权威（任何批次录过即拦）；断网降级本机 Isar 全批次。命中默认拒绝，可填原因强制继续（留痕）。
  Future<bool> _globalDupCheck(String code) async {
    final r = await AuthApi.labelCheck(code);
    if (r["net"] == true) {
      // 断网/服务不可达：降级查本机全部批次（未作废）
      final any = await _isar.scanRecords
          .filter()
          .goodsCodeEqualTo(code)
          .isCancelEqualTo(false)
          .findFirst();
      if (any != null) {
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(
                  "⚠ 离线模式：标签 $code 本机已录入过（批次 ${any.batchId}），已拦截；联网后以服务器全局查为准"),
              backgroundColor: Colors.orange));
        return true;
      }
      return false;
    }
    if (r["ok"] != true || r["blockIn"] != true) return false;
    final reason = (r["reason"] ?? "该标签已存在").toString();
    final ctl = TextEditingController();
    final res = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("⛔ 标签全局重复，已拦截"),
        content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(reason, style: const TextStyle(fontSize: 13.5)),
              const SizedBox(height: 4),
              Text("提示：全厂范围内该标签号不允许重复入账。若确认是系统误拦（如标签确实换了实物用途），由责任人填写原因后强制继续。",
                  style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
              const SizedBox(height: 8),
              TextField(
                  controller: ctl,
                  decoration: const InputDecoration(hintText: "强制继续必填原因"),
                  maxLines: 2),
            ]),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, "abort"),
              child: const Text("取消录入")),
          TextButton(
              onPressed: () => Navigator.pop(ctx, "force"),
              child: const Text("强制继续", style: TextStyle(color: Colors.red))),
        ],
      ),
    );
    if (res != "force") return true;
    final why = ctl.text.trim();
    ctl.dispose();
    if (why.isEmpty) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
            content: Text("强制继续必须填写原因"), backgroundColor: Colors.orange));
      return true;
    }
    LocalLog.op("重复标签强过", "$code 原因:$why");
    try {
      await AuthApi.labelForce(code, why);
    } catch (_) {} // 强过留痕进服务器活动流
    return false;
  }

  //【MOD‑Bug1修复：重置作废标记，解决连续录入12345后状态残留bug】
  Future<bool> _isCodeDuplicate(String code) async {
    final exist = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .goodsCodeEqualTo(code)
        .isCancelEqualTo(false)
        .findFirst();
    if (exist == null) return false;
    String posInfo = "";
    if (exist.workType == 0) {
      posInfo = "AGV站台${exist.stationNo}";
    } else {
      posInfo = "人工货位${exist.groundLocation}";
    }
    final res = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("该货码已登记"),
        content: Text(
            "货码：$code\n登记位置：$posInfo\n状态：${exist.isCancel ? "【已作废】" : "正常有效"}"),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, "view"),
            child: const Text("查看旧记录"),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, "cancelOld"),
            child: const Text("作废旧记录，新建本条"),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, "abort"),
            child: const Text("取消"),
          ),
        ],
      ),
    );
    if (res == "abort" || res == null) {
      return true;
    } else if (res == "view") {
      await showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text("旧记录详情"),
          content: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text("采集时间：${exist.scanTime.toString().substring(0, 19)}"),
                Text("作业类型：${exist.workType == 0 ? "AGV站台" : "人工货位"}"),
                Text("位置：$posInfo"),
                Text(
                    "零件号：${(exist.mesPartNo?.isNotEmpty ?? false) ? exist.mesPartNo : "无"}"),
                Text("数量：${exist.mesQty ?? "无"}"),
                Text("备注：${exist.remark.isNotEmpty ? exist.remark : "无"}"),
                Text("状态：${exist.isCancel ? "已作废" : "正常"}"),
              ],
            ),
          ),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx), child: const Text("关闭"))
          ],
        ),
      );
      return true;
    } else if (res == "cancelOld") {
      //每次操作独立标记，不会残留作废状态（修复Bug核心）
      bool tempCancelFlag = true;
      await _isar.writeTxn(() async {
        exist.isCancel = tempCancelFlag;
        await _isar.scanRecords.put(exist);
        if (exist.workType == 0 && exist.stationNo != null) {
          BatchInfo? batch = await _getCurrentBatch();
          if (batch != null) {
            List<String> mutableList = batch.usedStation.toList();

            mutableList.remove(exist.stationNo);
            batch.usedStation = mutableList;
            await _isar.batchInfos.put(batch);
          }
        }
      });
      LocalLog.op('作废旧记录', exist.goodsCode);
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(const SnackBar(content: Text("旧记录已标记作废，可录入新记录")));
      return false;
    }
    return true;
  }

  Future<void> _scanSuccessAction(
      {String mesPartNo = "", double qty = 0}) async {
    try {
      if (await AppSettings.getVibrationEnabled()) {
        if ((await Vibration.hasVibrator()) ?? false) {
          await Vibration.vibrate(duration: 80);
        }
      }
      // ⑭语音播报：零件号后四位+件数；开关关闭或无TTS引擎回退提示音
      bool said = false;
      if (await RemindPrefs.enabledByKey(RemindPrefs.kVoice) &&
          mesPartNo.isNotEmpty) {
        final tail = mesPartNo.length > 4
            ? mesPartNo.substring(mesPartNo.length - 4)
            : mesPartNo;
        final qs = qty == qty.roundToDouble()
            ? qty.toInt().toString()
            : qty.toStringAsFixed(1);
        said = await NotifyService.speak("$tail，$qs件");
      }
      if (!said && await AppSettings.getSoundEnabled()) {
        await SystemSound.play(SystemSoundType.click);
      }
    } catch (_) {}
  }

  Future<void> _saveRecord(String code) async {
    if (_isSaving) return;
    // ㉖v69 标签格式闸（用户拍板）：N开头+10位，不符禁止录入
    {
      final fmtErr = labelFormatErr(code);
      if (fmtErr != null) {
        if (mounted) {
          showDialog(
              context: context,
              builder: (dc) => AlertDialog(
                    icon: const Icon(Icons.block, color: Colors.red, size: 34),
                    title: const Text("标签号不符合规则"),
                    content: Text("$fmtErr\n\n规则：N 开头，总长 10 位。请核对实物标签或重新扫码。"),
                    actions: [
                      FilledButton(onPressed: () => Navigator.pop(dc), child: const Text("知道了"))
                    ],
                  ));
          _goodsInputCtrl.clear();
          _goodsFocusNode.requestFocus();
        }
        return;
      }
    }
    // 服务端功能门禁：角色未开通"采集录入"则拒绝保存
    if (!Auth.can("collect")) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text("${Auth.user?.roleName ?? "当前角色"}未开通采集录入权限，请联系管理员"),
            backgroundColor: Colors.red));
      _isSaving = false;
      return;
    }
    _isSaving = true;
// ==========【新增前置校验，从这里开始】==========
    try {
      //校验1：容器类型不能为空
      if (_containerType == null) {
        if (mounted)
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text("请先选择容器类型！")));
        await _scrollToKey(_keyContainerArea);
        _isSaving = false;
        return;
      }
      //校验2：货位/站台校验
      bool locationValid = false;
      if (_workType == 0) {
        locationValid = _selectedStation != null;
      } else {
        locationValid = _selectedGroundLoc != null;
      }
      if (!locationValid) {
        if (mounted)
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text("请先选择货位！")));
        await _scrollToKey(_keyLocationArea);
        _isSaving = false;
        return;
      }
    } catch (e) {
      debugPrint("校验滚动异常 $e");
    }
    // ==========【前置校验结束，下面原有代码保留不变】==========
    try {
      //归档拦截校验
      if (await _checkBatchArchived()) return;
      if (_currentBatchId == null) {
        if (mounted)
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text("未创建采集批次！")));
        return;
      }
      if (await _globalDupCheck(code)) return; // ㉖① 跨批次/跨设备全局查重（服务器权威，断网降级本机全库）
      if (await _isCodeDuplicate(code)) return;
      if (_workType == 0 && _selectedStation == null) {
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text("请先选择站台！")));
        }
        return;
      }
      if (_workType == 0) {
        final existStationRecord = await _isar.scanRecords
            .filter()
            .batchIdEqualTo(_currentBatchId!)
            .stationNoEqualTo(_selectedStation)
            .isCancelEqualTo(false)
            .findAll();
        // 整托模式：本托内的记录不算占用，允许同托多码共用站台；非本托记录仍拦截
        String? occupiedByOtherPallet;
        for (final rec in existStationRecord) {
          final extra = await _isar.recordExtras
              .filter()
              .goodsCodeEqualTo(rec.goodsCode)
              .findFirst();
          final recPallet = extra?.palletId ?? "";
          if (!(_palletMode &&
              _currentPalletId != null &&
              recPallet == _currentPalletId &&
              recPallet.isNotEmpty)) {
            occupiedByOtherPallet = rec.goodsCode;
            break;
          }
        }
        if (occupiedByOtherPallet != null) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text("${_selectedStation}站台已登记货物，不可再次使用！")));
          }
          return;
        }
      }
      if (_workType == 1 && _selectedGroundLoc == null) {
        if (mounted) {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text("请先选择地面货位！")));
        }
        return;
      }
      // =========改动2‑2：拼接多选标签=========
      String finalRemark = _selectedTags.join("｜");
      if (_remarkInputCtrl.text.isNotEmpty) {
        if (finalRemark.isNotEmpty) finalRemark += "｜";
        finalRemark += _remarkInputCtrl.text.trim();
      }
      // =========整托模式：首码自动建托号=========
      if (_palletMode && _currentPalletId == null) {
        final ts = DateTime.now();
        setState(() {
          _currentPalletId = "TP${ts.millisecondsSinceEpoch}";
        });
      }
      final String palletIdForSave =
          _palletMode ? (_currentPalletId ?? "") : "";

// ===================== MES接口请求【统一走 mesQueryLabel：失效自动静默重登并重试一次】=====================
      String? mesPartNo;
      double? mesQty;
      String? mesCreateTime;
      String mesItemName = "";
      String mesLotNo = "";
      try {
        final mesResult = await mesQueryLabel(code);
        if (mesResult["ok"] == true) {
          final String pn = mesResult["partNo"]?.toString() ?? "";
          final String ct = mesResult["createTime"]?.toString() ?? "";
          mesPartNo = pn.isEmpty ? null : pn;
          mesQty = (mesResult["qty"] as num?)?.toDouble();
          mesCreateTime = ct.isEmpty ? null : ct;
          mesItemName = mesResult["itemName"]?.toString() ?? "";
          mesLotNo = mesResult["lotNo"]?.toString() ?? "";
          if (mesResult["relogin"] == true) {
            // ㉖v80 降噪：续期成功静默（查询已正常，无需打断扫码）
          }
        } else if (mesResult["found"] == false) {
          // ㉖v69 查无此码（用户拍板）：弹窗并禁止录入，防错码/私码混入账本
          if (mounted) {
            showDialog(
                context: context,
                builder: (dc) => AlertDialog(
                      icon: const Icon(Icons.search_off,
                          color: Colors.deepOrange, size: 34),
                      title: const Text("MES 查无此标签"),
                      content: Text(
                          "标签「$code」在 MES 中查不到在库记录，已禁止录入。\n\n请核对：\n① 标签是否贴错/串托\n② 是否 MES 未打印入库的私码\n③ 重新扫码确认无误读"),
                      actions: [
                        FilledButton(
                            onPressed: () => Navigator.pop(dc),
                            child: const Text("知道了"))
                      ],
                    ));
            _goodsInputCtrl.clear();
            _goodsFocusNode.requestFocus();
          }
          return;
        } else if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
              SnackBar(content: Text("MES查询失败：${mesResult["msg"]}，仅保存本地采集信息")));
        }
      } catch (mesErr) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text("MES查询失败：${mesErr.toString()}，仅保存本地采集信息")));
        }
        //MES查询失败，字段保留null，不阻断保存流程
      }
      if (_palletMode &&
          _currentPalletId != null &&
          (mesPartNo?.isNotEmpty ?? false)) {
        // 非首码时：若零件号在本托未出现过，轻提示防误扫（不拦截）
        final codesInPallet = await _isar.recordExtras
            .filter()
            .palletIdEqualTo(_currentPalletId!)
            .findAll();
        final pCodes = codesInPallet.map((e) => e.goodsCode).toSet();
        final pRecords = await _isar.scanRecords
            .filter()
            .batchIdEqualTo(_currentBatchId!)
            .isCancelEqualTo(false)
            .findAll();
        final knownParts = pRecords
            .where((r) => pCodes.contains(r.goodsCode) && r.mesPartNo != null)
            .map((r) => r.mesPartNo)
            .toSet();
        if (knownParts.isNotEmpty && !knownParts.contains(mesPartNo)) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text("⚠️ 本托出现新零件号 $mesPartNo，请确认属于同一托")));
          }
        }
      }
      final rec = ScanRecord(
        scanTime: DateTime.now(),
        workType: _workType,
        stationNo: _workType == 0 ? _selectedStation : null,
        groundLocation: _workType == 1 ? _selectedGroundLoc : null,
        goodsCode: code,
        remark: finalRemark,
        batchId: _currentBatchId!,
        containerType: _containerType,
        //MES参数
        mesPartNo: mesPartNo,
        mesQty: mesQty,
        mesCreateTime: mesCreateTime,
      );
      await _isar.writeTxn(() async {
        await _isar.scanRecords.put(rec);
        // 扩展信息写入新表（同货码旧扩展记录先清掉，防作废重扫唯一索引冲突）
        await _isar.recordExtras.filter().goodsCodeEqualTo(code).deleteAll();
        final extraRec = RecordExtra(
          goodsCode: code,
          palletId: palletIdForSave,
          mesItemName: mesItemName,
          mesLotNo: mesLotNo,
          operator: Auth.user?.name ?? Auth.user?.username ?? "",
        );
        await _isar.recordExtras.put(extraRec);
        if (_workType == 0 && _selectedStation != null) {
          BatchInfo? batch = await _getCurrentBatch();
          if (batch != null) {
            List<String> mutableList = batch.usedStation.toList();

            if (!mutableList.contains(_selectedStation)) {
              mutableList.add(_selectedStation!);
              batch.usedStation = mutableList;
              await _isar.batchInfos.put(batch);
            }
          }
        }
      });
      LocalLog.op('扫码保存', code);
      await _scanSuccessAction(
          mesPartNo: rec.mesPartNo ?? "", qty: rec.mesQty ?? 0);
      _goodsInputCtrl.clear();
      final lastCtype = _containerType; // ㉖⑬ 清空前捕获容器，供手动「提交任务」
      setState(() {
        _selectedTags.clear(); //录入完成清空多选标签
        _remarkInputCtrl.clear();
        if (!_palletMode) {
          _containerType = null; // 新增：保存成功，容器类型取消选中
        }
        if (_workType == 1 && !_palletMode) {
          _selectedGroundLoc = null; // ✅人工模式，录入成功清空地面货位
        }
      });
      final autoCallSt =
          _workType == 0 ? (_selectedStation ?? "") : ""; // ⑳清空前捕获站台，供自动入库叫车
      if (_workType == 0 && !_palletMode) {
        setState(() {
          _selectedStation = null;
          _lastScanStation = autoCallSt.isEmpty ? null : autoCallSt; // ㉖ 手动提交回退
          _lastScanContainer = lastCtype;
        });
      }
      await _ledgerRegisterOnSave(code,
          autoCallStation: autoCallSt); //顺手登记货位账本（选填，不影响采集主流程）
      scheduleScanPush(); //采集流水定时同步电脑数据库
      await _refreshRecord();
      await _refreshBatchStat();
      await _refreshPalletSummary();
      // ㉖v80 扫码链路降噪：成功不弹条（震动+零件号语音即反馈），错误/漏选提醒全保留
      //【修复】保存后重挂扫码框焦点：节点可能自认为仍有焦点但原生输入连接已断，
      //PDA扫码枪按键进不来；先 unfocus 释放，再隔一帧重新申请，强制重建输入连接
      _goodsFocusNode.unfocus();
      if (kAutoFocus) {
        // 第3档 自动聚焦开：保存后重挂焦点；关则交还用户手动点框，防软键盘反复弹
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted && kAutoFocus) _goodsFocusNode.requestFocus();
            });
          }
        });
      }
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("保存异常：${e.toString()}")));
    } finally {
      _isSaving = false;
    }
  }

  ///采集页顺手登记：保存成功时若填了「货位账本编码」，把本标签（整托含兄弟码）写入账本，并预约全量同步电脑。
  ///留空则不写账本，与改动前行为完全一致；编码格式不符或货位已被他人占用时只提示不写入。
  Future<void> _ledgerRegisterOnSave(String code,
      {String autoCallStation = ""}) async {
    try {
      if (_ledgerLocCtrl.text.trim().toUpperCase() == 'AUTO') {
        //自动分配：先按零件号定货位并回填
        await _handleAutoLedger(code);
      }
      var loc = _ledgerLocCtrl.text.trim().toUpperCase();
      if (loc == 'AUTO') return; //AUTO 分配失败的情形，不写账本
      if (loc.isEmpty &&
          _workType == 1 &&
          (_selectedGroundLoc ?? "").isNotEmpty) {
        // 地面模式未填编码：在人选的区内自动分配第一个空格位
        final auto = await this.nb03AutoSlot(_selectedGroundLoc!);
        if (auto == null) {
          if (mounted)
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                content: Text("$_selectedGroundLoc 区 12 格位已满，请在货位账本登记框手动指定其他区"),
                backgroundColor: Colors.orange));
          return;
        }
        loc = auto;
        if (mounted) setState(() => _ledgerLocCtrl.text = auto);
        // ㉖v80 降噪：分配信息不弹条（后续"✅已入账"内联条已含货位）
      }
      if (loc.isEmpty) {
        // ㉖⑰ 修自动叫车被"必须填货位"绑架：AGV模式留空+自动叫车开 → 自动分配货位继续登记（否则下方叫车永远走不到）
        if (_workType == 0 &&
            autoCallStation.isNotEmpty &&
            await WmasConfig.autoCallEnabled()) {
          final recA = await _isar.scanRecords
              .filter()
              .goodsCodeEqualTo(code.toUpperCase())
              .findFirst();
          final auto = await nb02AutoAssign(recA?.mesPartNo ?? "", code: code.toUpperCase());
          if (auto == null) {
            if (mounted)
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text("货架已无空位：请手动登记货位后再「提交任务」"),
                  backgroundColor: Colors.orange));
            return;
          }
          loc = auto;
          if (mounted) setState(() => _ledgerLocCtrl.text = auto);
          // ㉖v80 降噪：联动分配信息不弹条（后续"✅已入账"内联条已含货位）；"货架已无空位"错误提醒保留
        } else {
          return;
        }
      }
      if (!RegExp(r'^NB0[23]-[A-H]-\d{1,2}-(\d{1,2}|[1-4]F)$').hasMatch(loc)) {
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content:
                  Text("货位编码「$loc」格式不符（例 NB02-A-08-2F / NB03-B-13-07），本筐未入账本"),
              backgroundColor: Colors.orange));
        return; //保留输入内容，改正后可直接重扫标签再保存
      }
      // ㉖v69c 模式与货位一致性闸：AGV站台模式目的地只能是 NB02 高架（AGV跑不到地面区），
      // 残留/误填的 NB03 地面码在此拦下，从源头杜绝"库位不在WMAS主档"叫车失败 + 账本污染
      if (_workType == 0 && loc.startsWith('NB03-')) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(
                  "AGV站台模式不能登记地面货位 $loc（AGV只到NB02高架）\n请点「选位」重选高架格或输 AUTO 自动分配"),
              backgroundColor: Colors.orange,
              duration: const Duration(seconds: 5)));
          _ledgerLocCtrl.clear();
        }
        return;
      }
      final ctype = _containerType ??
          _lastScanContainer ??
          ""; // ㉖⑳ 修自动叫车不触发：本函数在保存清空 _containerType 之后才被调用，须回退扫码时捕获的容器（与手动「提交任务」同口径）
      final oper = Auth.user?.name ?? Auth.user?.username ?? "采集页";
      final codes = <String>{code.toUpperCase()};
      if (_palletMode &&
          _currentPalletId != null &&
          _currentPalletId!.isNotEmpty) {
        final mates = await _isar.recordExtras
            .filter()
            .palletIdEqualTo(_currentPalletId!)
            .findAll();
        codes.addAll(mates.map((m) => m.goodsCode.toUpperCase())); //同托多码共用一个货位
      }
      //占用核对：该货位上不属于本托/本码的其他标签才算冲突
      // ㉖v82c 先清本机拼接幽灵行（"A; B; C"导入时代遗留，服务器早已拆单码/出库）：
      // 幽灵行占着空位→本地占用检查误报"已登记给 A; B; C"挡住正常入账（实测 B-02-3F 事故）
      final ghosts0 = (await _isar.shelfPlacements.where().findAll())
          .where((p) => p.goodsCode.contains(';') || p.goodsCode.contains('；'))
          .toList();
      if (ghosts0.isNotEmpty) {
        await _isar.writeTxn(() async {
          await _isar.shelfPlacements.deleteAll(ghosts0.map((e) => e.id).toList());
        });
      }
      var prior =
          await _isar.shelfPlacements.filter().locEqualTo(loc).findAll();
      var foreign = prior
          .where((p) => !codes.contains(p.goodsCode.toUpperCase()))
          .toList();
      if (foreign.isNotEmpty) {
        // 本机数据可能整体过期：强制与服务器对齐一次再复查，避免拿旧缓存误拦
        await ledgerPullMerge(force: true);
        prior = await _isar.shelfPlacements.filter().locEqualTo(loc).findAll();
        foreign = prior
            .where((p) => !codes.contains(p.goodsCode.toUpperCase()))
            .toList();
      }
      if (foreign.isNotEmpty) {
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content:
                  Text("$loc 已登记给 ${foreign.first.goodsCode}，本筐未入账本，请核对货位"),
              backgroundColor: Colors.orange));
        return;
      }
      final now = DateTime.now().millisecondsSinceEpoch;
      await _isar.writeTxn(() async {
        for (final c in codes) {
          final olds = await _isar.shelfPlacements
              .filter()
              .goodsCodeEqualTo(c)
              .findAll();
          await _isar.shelfPlacements.deleteAll(olds.map((e) => e.id).toList());
          await _isar.shelfPlacements.put(ShelfPlacement()
            ..goodsCode = c
            ..loc = loc
            ..container = ctype
            ..operator = oper
            ..assignedAt = now);
        }
      });
      if (_workType == 1) {
        // 采集流水地面位置升级为完整格位编码（原来只有 B13 区）；整托兄弟码一并更新
        for (final cG in codes) {
          final recsG =
              await _isar.scanRecords.filter().goodsCodeEqualTo(cG).findAll();
          for (final rg in recsG) {
            if (!rg.isCancel && rg.groundLocation != loc) {
              rg.groundLocation = loc;
              await _isar.writeTxn(() => _isar.scanRecords.put(rg));
              break;
            }
          }
        }
      }
      await ledgerUnmarkDeleted(codes); //重新登记→撤销本地墓碑，别台PDA拉取后复活本位
      if (!_palletMode) _ledgerLocCtrl.clear(); //登记成功后才清；整托多码保留复用同位
      _scheduleLedgerSync();
      // ㉖v80 扫码链路降噪：登记成功改内联提示条（原弹条盖住扫码视线）
      if (mounted) setState(() => _autoCallTip = "✅ 已入账 $loc（${codes.length} 码）");
      // ⑳扫码自动入库：账本登记成功后触发；校验链与手动提交一致，失败不影响账本
      if (_workType == 0 &&
          autoCallStation.isNotEmpty &&
          loc.startsWith('NB02-') &&
          ctype.isNotEmpty &&
          await WmasConfig.autoCallEnabled()) {
        if (_palletMode) {
          if (mounted) setState(() => _autoCallTip = "ℹ️ 整托模式：扫完本托请手动「提交任务」");
          // ㉖v80 降噪：整托提示已有常驻内联条，不再弹条
        } else {
          await _autoCallInbound(autoCallStation, loc, ctype);
        }
      }
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text("账本登记异常：$e（采集记录已保存）"),
            backgroundColor: Colors.orange));
    }
  }

  ///账本同步防抖（已升级为全局助手，支持发料/出库远程触发）
  void _scheduleLedgerSync() => scheduleLedgerPush(seconds: 30);
  //【优化一：数字转编码 5→NB02-CK-05】
  Future<void> onStationTap(int stationNum) async {
    final batch = await _getCurrentBatch();
    if (batch == null) return;
    String stationCode = "NB02-CK-${stationNum.toString().padLeft(2, "0")}";
    if (batch.usedStation.contains(stationCode)) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text("${stationNum}号站台已使用，无法选择！")));
      }
      return;
    }
    setState(() {
      _selectedStation = stationCode;
    });
  }

  void _selectGroundLoc(int num) {
    setState(() {
      _selectedGroundLoc = "${_curLocGroup}${num}";
    });
  }

  // ㉖v52 本批次记录：全链路映射预取 + 批内搜索筛选状态
  Map<String, RecordExtra> _recEx = {};
  Map<String, String> _recLoc = {};
  Set<String> _recOut = {};
  String _recQ = "", _recF = "";

  Future<void> _refreshRecord() async {
    if (_currentBatchId == null) return;
    List<ScanRecord> all = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .findAll();
    all.sort((a, b) => b.scanTime.compareTo(a.scanTime));
    final ex = await _extraMapOf(_isar);
    final lm = await _locMapOf(_isar);
    final oc = await _outCodesOf(_isar, await RequisitionCache.loadIssued());
    //【修复BUG：此处强制setState，保证数据变更立刻刷新界面，解决保存成功看不到记录】
    setState(() {
      _recordList = all;
      _recEx = ex;
      _recLoc = lm;
      _recOut = oc;
      _histInvalidate(); // ㉖v52 扫码/作废/恢复都会走到这里：历史批次聚合缓存同步失效
    });
  }

  //====修改：支持多批次合并导出｜改动2：函数改为异步，移除同步查询｜整托：托号列+汇总段
  Future<String> _generateCsvText({List<String>? targetBatchIds}) async {
    String csvField(String v) {
      //含逗号/引号的字段加引号转义，保证台账不串列
      if (v.contains(",") || v.contains("\""))
        return "\"${v.replaceAll("\"", "\"\"")}\"";
      return v;
    }

    String header =
        "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期,托号\n";

    String content = header;
    List<ScanRecord> targetRecords = [];
    if (targetBatchIds != null && targetBatchIds.isNotEmpty) {
      for (var bid in targetBatchIds) {
        final list =
            await _isar.scanRecords.filter().batchIdEqualTo(bid).findAll();
        targetRecords.addAll(list);
      }
    } else {
      targetRecords = _recordList;
    }
    targetRecords.sort((a, b) => a.scanTime.compareTo(b.scanTime));
    //预取所有扩展信息（托号/物料名）
    final extras = await _isar.recordExtras.where().findAll();
    final Map<String, RecordExtra> extraMap = {
      for (var e in extras) e.goodsCode: e
    };
    for (var r in targetRecords) {
      String timeStr = r.scanTime.toString().substring(0, 19);
      String wt = r.workType.toString();
      String st = r.stationNo ?? "";
      String gl = r.groundLocation ?? "";
      String container = r.containerType ?? "";

      String code = r.goodsCode;
      String rem = r.remark;
      String statusText = r.isCancel ? "作废" : "正常";
      String pn = r.mesPartNo ?? "";
      String qty = r.mesQty?.toString() ?? "";
      String pd = r.mesCreateTime ?? "";
      String pid = extraMap[code]?.palletId ?? "";
      content +=
          "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText,$pn,$qty,$pd,$pid\n";
    }
    // ===== 整托汇总段：一行 = 托(货位)+零件号；同零件号多码标签号拼接、数量累加 =====
    final Map<String, List<ScanRecord>> palletGroups = {};
    for (final r in targetRecords) {
      if (r.isCancel) continue;
      final pid = extraMap[r.goodsCode]?.palletId ?? "";
      if (pid.isEmpty) continue;
      palletGroups.putIfAbsent(pid, () => []).add(r);
    }
    if (palletGroups.isNotEmpty) {
      content += "\n===整托汇总(一行=托+零件号)===\n";
      content += "托号,作业类型,站台编号,地面货位编码,容器类型,零件号,物料名称,框数,标签号(分号分隔),数量合计\n";
      final keys = palletGroups.keys.toList()..sort();
      for (final pid in keys) {
        final rs = palletGroups[pid]!
          ..sort((a, b) => a.scanTime.compareTo(b.scanTime));
        // 同托内按零件号再分组
        final Map<String, List<ScanRecord>> byPart = {};
        for (final r in rs) {
          final pn =
              (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
          byPart.putIfAbsent(pn, () => []).add(r);
        }
        for (final entry in byPart.entries) {
          final rowsOfPart = entry.value;
          final codes = rowsOfPart.map((e) => e.goodsCode).join("；");
          final names = rowsOfPart
              .map((e) => extraMap[e.goodsCode]?.mesItemName ?? "")
              .where((e) => e.isNotEmpty)
              .toSet()
              .join("；");
          final totalQty =
              rowsOfPart.fold<double>(0, (s, e) => s + (e.mesQty ?? 0));
          final loc0 = rowsOfPart.first;
          content +=
              "${csvField(pid)},${loc0.workType},${csvField(loc0.stationNo ?? "")},${csvField(loc0.groundLocation ?? "")},${csvField(loc0.containerType ?? "")},${csvField(entry.key)},${csvField(names)},${rowsOfPart.length},${csvField(codes)},${_fmtQty(totalQty)}\n";
        }
      }
    }
    // ===== 整托末段子表：主表同12列，按托聚合一行 =====
    content += _buildPalletAggCsv(targetRecords, extraMap);
    return content;
  }

  Future<void> _saveCsvToFile({List<String>? batchIds}) async {
    String csvText = await _generateCsvText(targetBatchIds: batchIds);
    final dir = await getExternalStorageDirectory();
    if (dir == null) return;
    String suffix = batchIds != null ? "多批次合并" : (_currentBatchId ?? "");
    String filePath = "${dir.path}/采集_${suffix}.csv";
    File file = File(filePath);
    await file.writeAsString(csvText, encoding: utf8);
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("文件已保存：$filePath")));
    }
  }

  Future<String?> _getLocalIp() async {
    try {
      final interfaces = await NetworkInterface.list(
        includeLoopback: false,
        includeLinkLocal: false,
      );
      for (var interface in interfaces) {
        final name = interface.name.toLowerCase();
        if (name.contains('rmnet') || name.contains('mobile')) continue;
        for (var addr in interface.addresses) {
          if (addr.type == InternetAddressType.IPv4) {
            return addr.address;
          }
        }
      }
    } catch (e) {
      debugPrint("获取网卡IP异常:$e");
    }
    return null;
  }

  Future<void> startWebService() async {
    if (_webServiceRunning) return;
    // 读本机网卡 IP 无需附近设备权限（那是扫描其他设备用的），直接取 IP：
    final ip = await _getLocalIp();
    if (ip == null) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(content: Text("未获取到局域网IP，请确认已连接WiFi，并关闭移动数据")));
      return;
    }
    _localIpAddress = ip;
    // ===== 网页门户：批次列表 / 任意批次下载 / 基准CSV上传（原"一律返回当前批次CSV"已升级） =====
    final handler = createCollectWebService(
      csvForBatches: (ids) =>
          _generateCsvText(targetBatchIds: ids.isEmpty ? null : ids),
      currentBatchId: () => _currentBatchId,
    );
    try {
      _webServer = await shelf_io.serve(handler, "0.0.0.0", _webPort);
      setState(() {
        _webServiceRunning = true;
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text("传输服务已开启，地址：http://${ip}:${_webPort}")));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text("端口启动失败：${e.toString()}，请使用复制导出模式")));
      }
      return;
    }
  }

  Future<void> stopWebService() async {
    if (_webServer != null) {
      await _webServer!.close();
      _webServer = null;
    }
    setState(() {
      _webServiceRunning = false;
      _localIpAddress = null;
    });
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text("局域网传输服务已关闭")));
    }
  }

  void _openCameraScan() async {
    bool scannedHandled = false;
    final result = await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        insetPadding: EdgeInsets.zero,
        contentPadding: EdgeInsets.zero,
        content: SizedBox(
          width: 300,
          height: 350,
          child: MobileScanner(
            onDetect: (capture) {
              if (scannedHandled) return;
              final barcodes = capture.barcodes;
              if (barcodes.isNotEmpty && barcodes.first.rawValue != null) {
                scannedHandled = true;
                final String code = barcodes.first.rawValue!.trim();
                Navigator.pop(ctx, code);
              }
            },
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text("关闭"))
        ],
      ),
    );
    if (result != null && result.toString().trim().isNotEmpty) {
      await _saveRecord(result.toString().trim());
    }
  }

  Widget _buildStationPanel() {
    return FutureBuilder<BatchInfo?>(
      future: _getCurrentBatch(),
      builder: (ctx, snapshot) {
        List<String> used = snapshot.data?.usedStation ?? [];
        // ㉖ 12个站台(含启用一二三四号台)，三行每行4个：[1,2,3,4] / [5,6,7,8] / [9,10,11,12]
        final List<List<int>> stationRows = [
          [1, 2, 3, 4],
          [5, 6, 7, 8],
          [9, 10, 11, 12]
        ];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: stationRows
              .map((rowStationList) {
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: rowStationList
                        .map((num) {
                          String stationCode =
                              "NB02-CK-${num.toString().padLeft(2, "0")}";
                          bool locked = used.contains(stationCode);
                          bool selected = _selectedStation == stationCode;
                          return SizedBox(
                            width: 80,
                            height: 64,
                            child: ElevatedButton(
                              style: ElevatedButton.styleFrom(
                                  backgroundColor: locked
                                      ? Colors.amber.shade600
                                      : (selected
                                          ? Color(0xFF515BD4)
                                          : Colors.white),
                                  foregroundColor:
                                      selected ? Colors.white : Colors.black87,
                                  shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(12)),
                                  elevation: 2),
                              onPressed:
                                  locked ? null : () => onStationTap(num),
                              child:
                                  Text("$num号", style: TextStyle(fontSize: 18)),
                            ),
                          );
                        })
                        .toList()
                        .cast<Widget>(),
                  ),
                );
              })
              .toList()
              .cast<Widget>(),
        );
      },
    );
  }

  Widget _buildGroundLocPanel() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        //【A~H区域选择：横向滚动】
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: _locGroup
                .map((g) => Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: ChoiceChip(
                        label: Text(g),
                        selected: _curLocGroup == g,
                        onSelected: (s) => setState(() => _curLocGroup = g),
                      ),
                    ))
                .toList()
                .cast<Widget>(),
          ),
        ),
        const SizedBox(height: 8),
        // ========= 货位数字区域：横向滚动 + 两行布局 =========
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 第一行：1~9
              Row(
                children: List.generate(9, (i) {
                  int n = i + 1;
                  String locCode = "$_curLocGroup$n";
                  bool isSelected = _selectedGroundLoc == locCode;
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    child: SizedBox(
                      width: 42,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor:
                              isSelected ? Color(0xFF515BD4) : Colors.white,
                          foregroundColor:
                              isSelected ? Colors.white : Colors.black,
                          elevation: 2,
                        ),
                        onPressed: () => _selectGroundLoc(n),
                        child: Text("$n", style: TextStyle(fontSize: 16)),
                      ),
                    ),
                  );
                }),
              ),
              const SizedBox(height: 6),
              // 第二行：10~18
              Row(
                children: List.generate(9, (i) {
                  int n = i + 10;
                  String locCode = "$_curLocGroup$n";
                  bool isSelected = _selectedGroundLoc == locCode;
                  return Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 3),
                    child: SizedBox(
                      width: 42,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor:
                              isSelected ? Color(0xFF515BD4) : Colors.white,
                          foregroundColor:
                              isSelected ? Colors.white : Colors.black,
                          elevation: 2,
                        ),
                        onPressed: () => _selectGroundLoc(n),
                        child: Text("$n", style: TextStyle(fontSize: 16)),
                      ),
                    ),
                  );
                }),
              ),
            ],
          ),
        ),
        const SizedBox(height: 10),
        Text("已选货位：${_selectedGroundLoc ?? "未选择"}")
      ],
    );
  }

  Widget _buildContainerButton(
      {required String showText, required String dbValue}) {
    bool selected = _containerType == dbValue;
    return SizedBox(
      height: 48,
      child: ElevatedButton(
        style: ElevatedButton.styleFrom(
          backgroundColor: selected ? Color(0xFF515BD4) : Colors.white,
          foregroundColor: selected ? Colors.white : Colors.black87,
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          elevation: 2,
        ),
        onPressed: () {
          setState(() {
            if (_containerType == dbValue) {
              _containerType = null;
            } else {
              _containerType = dbValue;
            }
          });
        },
        child: Text(showText, style: TextStyle(fontSize: 15)),
      ),
    );
  }

  //【㉖v52 本批次采集记录重做：借鉴网页流水的紧凑行 + 全链路状态（在架/已出库/托组/作废）+ 批内搜索筛选】
  String _recStatusOf(ScanRecord r) {
    if (r.isCancel) return "cx";
    final gc = r.goodsCode.toUpperCase();
    if (_recOut.contains(gc)) return "out";
    if (_recLoc.containsKey(gc)) return "shelf";
    return "wait";
  }

  Widget _buildRecordList() {
    if (_recordList.isEmpty) {
      return const Padding(
          padding: EdgeInsets.all(20),
          child: Center(child: Text("本批次暂无采集记录", style: TextStyle(color: Colors.grey))));
    }
    final k = _recQ.trim().toLowerCase();
    int nShelf = 0, nOut = 0, nCx = 0, nWait = 0;
    for (final r in _recordList) {
      final s = _recStatusOf(r);
      if (s == "shelf") nShelf++; else if (s == "out") nOut++; else if (s == "cx") nCx++; else nWait++;
    }
    var list = _recordList;
    if (k.isNotEmpty) {
      list = list.where((r) =>
          r.goodsCode.toLowerCase().contains(k) ||
          (r.mesPartNo ?? "").toLowerCase().contains(k) ||
          r.remark.toLowerCase().contains(k) ||
          (_recEx[r.goodsCode.toUpperCase()]?.mesItemName ?? "").toLowerCase().contains(k)).toList();
    }
    if (_recF == "shelf") list = list.where((r) => _recStatusOf(r) == "shelf").toList();
    else if (_recF == "out") list = list.where((r) => _recStatusOf(r) == "out").toList();
    else if (_recF == "cx") list = list.where((r) => r.isCancel).toList();
    Widget chip(String key, String txt, Color c) => ChoiceChip(
        label: Text(txt, style: TextStyle(fontSize: 10.5, color: _recF == key ? Colors.white : c)),
        selected: _recF == key, showCheckmark: false, selectedColor: c,
        labelPadding: const EdgeInsets.symmetric(horizontal: 4),
        onSelected: (_) => setState(() => _recF = _recF == key ? "" : key));
    final shown = list.take(60).toList();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Row(children: [
              Expanded(
                  child: TextField(
                onChanged: (v) => setState(() => _recQ = v),
                style: const TextStyle(fontSize: 13),
                decoration: InputDecoration(
                    hintText: "本批内搜 标签/零件/物料/备注",
                    isDense: true, filled: true, fillColor: Colors.white,
                    prefixIcon: const Icon(Icons.search, size: 17),
                    suffixIcon: _recQ.isEmpty ? null : IconButton(
                        icon: const Icon(Icons.clear, size: 15),
                        onPressed: () => setState(() => _recQ = "")),
                    contentPadding: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8))),
              )),
            ])),
        Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Wrap(spacing: 6, runSpacing: 4, children: [
              chip("shelf", '🟩在架$nShelf', const Color(0xFF2E7D32)),
              chip("out", '🟧已出库$nOut', Colors.deepOrange),
              if (nWait > 0) chip("wait", '⬜未入位$nWait', Colors.blueGrey),
              chip("cx", '✖作废$nCx', Colors.red),
            ])),
        if (shown.isEmpty)
          const Padding(padding: EdgeInsets.all(16), child: Center(child: Text("没有符合条件的记录", style: TextStyle(color: Colors.grey, fontSize: 12.5))))
        else
          ...shown.map((r) {
            final gc = r.goodsCode.toUpperCase();
            final ex = _recEx[gc];
            final st = _recStatusOf(r);
            final pid = ex?.palletId ?? "";
            final pn = (r.mesPartNo ?? "").trim();
            final nm = ex?.mesItemName ?? "";
            final lot = lotFromPrintDate(r.mesCreateTime ?? "", ex?.mesLotNo ?? "");
            final pos = r.workType == 0 ? (r.stationNo ?? "?") : (r.groundLocation ?? "?");
            final curLoc = _recLoc[gc] ?? "";
            final stTag = st == "cx"
                ? const Text("✖作废", style: TextStyle(fontSize: 10.5, color: Colors.red, fontWeight: FontWeight.w600))
                : st == "out"
                    ? const Text("🟧已出库", style: TextStyle(fontSize: 10.5, color: Colors.deepOrange, fontWeight: FontWeight.w600))
                    : st == "shelf"
                        ? const Text("🟩在架", style: TextStyle(fontSize: 10.5, color: Color(0xFF2E7D32), fontWeight: FontWeight.w600))
                        : const Text("⬜待入位", style: TextStyle(fontSize: 10.5, color: Colors.blueGrey));
            return Container(
              margin: const EdgeInsets.symmetric(vertical: 3),
              padding: const EdgeInsets.fromLTRB(10, 7, 6, 7),
              decoration: BoxDecoration(
                  color: st == "cx" ? Colors.red.shade50 : Colors.white,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: st == "cx" ? Colors.red.shade200 : const Color(0xFFE8EAF2))),
              child: Row(children: [
                Expanded(
                  child: InkWell(
                    onTap: () => Navigator.push(context, MaterialPageRoute(builder: (_) => ScanRecordDetailPage(record: r))),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          Flexible(
                              child: Text(r.goodsCode,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                      fontSize: 14.5, fontWeight: FontWeight.w700,
                                      decoration: st == "cx" ? TextDecoration.lineThrough : null,
                                      color: st == "cx" ? Colors.red.shade400 : Colors.black87))),
                          const SizedBox(width: 6),
                          stTag,
                        ]),
                        Text(
                            "${pn.isEmpty ? "⚠️MES未查到" : pn + (nm.isEmpty ? "" : " $nm")}" +
                                (r.mesQty != null ? " · ${_fmtBatchQty(r.mesQty!)}件" : "") +
                                (lot.isNotEmpty ? " · 批$lot" : "") +
                                (pid.isNotEmpty ? " · 托$pid" : ""),
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 11, color: pn.isEmpty ? Colors.orange.shade800 : Colors.blueGrey)),
                        Text(
                            "${r.containerType ?? "未选容器"} · $pos" +
                                (curLoc.isNotEmpty && curLoc != pos ? " · 现$curLoc" : "") +
                                (r.remark.isNotEmpty ? " · ${r.remark}" : "") +
                                " · ${r.scanTime.toString().substring(11, 16)}",
                            maxLines: 1, overflow: TextOverflow.ellipsis,
                            style: TextStyle(fontSize: 10.5, color: Colors.grey.shade600)),
                      ],
                    ),
                  ),
                ),
                TextButton(
                  style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8), minimumSize: const Size(44, 36),
                      foregroundColor: r.isCancel ? Colors.green : Colors.red),
                  onPressed: () async {
                    if (!r.isCancel) {
                      final confirm = await showDialog<bool>(
                        context: context,
                        builder: (ctx) => AlertDialog(
                          title: const Text("作废本条采集"),
                          content: Text(
                              "作废 = 业务失效但留痕可恢复（不物理删除）。\n\n若该标签本批次仅此一条生效采集：同步从货位账本拣下（消账）、释放占用站台、解除全局防重（可重新扫码纠错）。\n\n标签 ${r.goodsCode}"),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认作废", style: TextStyle(color: Colors.red))),
                          ],
                        ),
                      );
                      if (confirm != true) return;
                      await scanRecordCancel(_isar, r);
                    } else {
                      final confirm = await showDialog<bool>(
                        context: context,
                        builder: (ctx) => AlertDialog(
                          title: const Text("恢复本条采集"),
                          content: Text("恢复为生效记录；若作废期间已消账，将按原货位重新登记账本。\n\n标签 ${r.goodsCode}"),
                          actions: [
                            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认恢复", style: TextStyle(color: Colors.green))),
                          ],
                        ),
                      );
                      if (confirm != true) return;
                      await scanRecordRestore(_isar, r);
                    }
                    await _refreshRecord();
                    await _refreshBatchStat();
                  },
                  child: Text(r.isCancel ? "恢复" : "作废", style: const TextStyle(fontSize: 12.5)),
                ),
              ]),
            );
          }),
        if (list.length > 60)
          Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Center(child: Text("仅显示最近 60 条（共 ${list.length}），完整记录点上方批次号进详情", style: TextStyle(fontSize: 11, color: Colors.grey.shade600)))),
      ],
    );
  }

  //====㉖v52 历史批次页重做：一次聚合全链路指标（借鉴网页批次统计），搜索+筛选+KPI，卡片信息密度对齐实际作业====
  Widget _buildHistoryBatchPage() {
    return FutureBuilder<Map<String, dynamic>>(
      future: _loadBatchAgg(),
      builder: (ctx, snap) {
        if (snap.connectionState != ConnectionState.done)
          return const Center(child: CircularProgressIndicator());
        if (snap.hasError)
          return Center(child: Text("加载失败：${snap.error}", style: const TextStyle(color: Colors.red)));
        final data = snap.data!;
        final aggOf = data["agg"] as Map<String, BatchAgg>;
        var batches = (data["batches"] as List<BatchInfo>)
            .where((b) => b.taskKind == 0)
            .toList();
        batches.sort((a, b) => b.createTime.compareTo(a.createTime)); // 最新在上
        // 搜索 + 状态筛选
        final k = _histQ.trim().toLowerCase();
        if (k.isNotEmpty) {
          batches = batches.where((b) {
            final a = aggOf[b.batchId];
            return b.batchId.toLowerCase().contains(k) ||
                b.batchRemark.toLowerCase().contains(k) ||
                (a != null && a.partNos.any((p) => p.toLowerCase().contains(k))) ||
                (a != null && a.records.any((r) => r.goodsCode.toLowerCase().contains(k)));
          }).toList();
        }
        final doing = batches.where((b) => !b.isArchived).length;
        final archAll = batches.where((b) => b.isArchived).length;
        // KPI 随搜索后集合统计（与列表所见一致）；再套状态筛选得 shown
        int tRecords = 0, tBoxes = 0, tPallets = 0, tOnShelf = 0, tShipped = 0, tNoMes = 0;
        double tQty = 0;
        for (final b in batches) {
          final a = aggOf[b.batchId];
          if (a == null) continue;
          tRecords += a.valid; tBoxes += a.boxes; tPallets += a.pallets;
          tOnShelf += a.onShelf; tShipped += a.shipped; tNoMes += a.noMes; tQty += a.qtySum;
        }
        if (_histF == "doing") batches = batches.where((b) => !b.isArchived).toList();
        else if (_histF == "arch") batches = batches.where((b) => b.isArchived).toList();
        final shown = _histExpand ? batches : batches.take(15).toList();
        Widget chip(String key, String txt, Color c) => ChoiceChip(
            label: Text(txt, style: TextStyle(fontSize: 11, color: _histF == key ? Colors.white : c)),
            selected: _histF == key, showCheckmark: false, selectedColor: c,
            labelPadding: const EdgeInsets.symmetric(horizontal: 5),
            onSelected: (_) => setState(() => _histF = _histF == key ? "" : key));
        return Column(
          children: [
            // KPI 汇总条
            Container(
                width: double.infinity,
                color: Colors.white,
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 4),
                child: Wrap(spacing: 7, runSpacing: 5, children: [
                  _kpiMini('${batches.length}', '批次${_histQ.isNotEmpty || _histF.isNotEmpty ? "·筛" : ""}', const Color(0xFF515BD4)),
                  _kpiMini('$tRecords', '有效记录', const Color(0xFF00897B)),
                  _kpiMini('$tBoxes', '框', const Color(0xFF3949AB)),
                  if (tPallets > 0) _kpiMini('$tPallets', '整托', const Color(0xFF7B1FA2)),
                  _kpiMini(_fmtBatchQty(tQty), '件数', const Color(0xFF2E7D32)),
                  _kpiMini('$tOnShelf', '在架', const Color(0xFF43A047)),
                  _kpiMini('$tShipped', '已出库', Colors.deepOrange),
                  if (tNoMes > 0) _kpiMini('$tNoMes', 'MES缺失', const Color(0xFFE53935)),
                ])),
            // 搜索 + 筛选 + 全选
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 0),
              child: Row(children: [
                Expanded(
                    child: TextField(
                  onChanged: (v) => setState(() => _histQ = v),
                  decoration: InputDecoration(
                      hintText: "搜批次号/备注/零件号/标签号",
                      isDense: true, filled: true, fillColor: Colors.white,
                      prefixIcon: const Icon(Icons.search, size: 19),
                      suffixIcon: _histQ.isEmpty ? null : IconButton(
                          icon: const Icon(Icons.clear, size: 17),
                          onPressed: () => setState(() => _histQ = "")),
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8))),
                )),
              ]),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 0),
              child: Row(children: [
                chip("doing", '进行中 $doing', const Color(0xFF4056D6)),
                const SizedBox(width: 6),
                chip("arch", '已归档 $archAll', Colors.grey),
                const Spacer(),
                Checkbox(
                  visualDensity: VisualDensity.compact, materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  value: batches.isNotEmpty && _selectedBatchIds.length == batches.length,
                  onChanged: (sel) => setState(() {
                    _selectedBatchIds = sel == true ? batches.map((b) => b.batchId).toList() : [];
                  }),
                ),
                const Text("全选", style: TextStyle(fontSize: 12.5)),
                SizedBox(width: 6),
                Text("已选:${_selectedBatchIds.length}", style: const TextStyle(fontSize: 12)),
              ]),
            ),
            Expanded(
              child: shown.isEmpty
                  ? Center(child: Text(k.isNotEmpty || _histF.isNotEmpty ? "没有符合条件的批次" : "暂无采集批次", style: const TextStyle(color: Colors.grey)))
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      itemCount: shown.length + (_histExpand || batches.length <= 15 ? 0 : 1),
                      itemBuilder: (ctx, idx) {
                        if (idx >= shown.length)
                          return Padding(
                              padding: const EdgeInsets.symmetric(vertical: 6),
                              child: Center(
                                  child: TextButton.icon(
                                      onPressed: () => setState(() => _histExpand = true),
                                      icon: const Icon(Icons.expand_more, size: 18),
                                      label: Text("展开全部 ${batches.length} 个批次（当前显示前 15）"))));
                        final b = shown[idx];
                        final a = aggOf[b.batchId] ?? BatchAgg([], {}, {}, {});
                        Widget statusWidget = Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(
                              color: b.isArchived ? Colors.grey.shade200 : const Color(0xFFE8EDFF),
                              borderRadius: BorderRadius.circular(8)),
                          child: Text(b.isArchived ? "已归档" : "进行中",
                              style: TextStyle(color: b.isArchived ? Colors.grey : const Color(0xFF4056D6), fontSize: 11)),
                        );
                        final ctDist = a.containerDist.entries.toList()
                          ..sort((x, y) => y.value.compareTo(x.value));
                        return Container(
                          margin: const EdgeInsets.only(bottom: 8),
                          padding: const EdgeInsets.fromLTRB(6, 10, 12, 10),
                          decoration: BoxDecoration(
                              color: Colors.white,
                              borderRadius: BorderRadius.circular(12),
                              boxShadow: const [BoxShadow(color: Colors.black12, blurRadius: 3)]),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Checkbox(
                                visualDensity: VisualDensity.compact, materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                value: _selectedBatchIds.contains(b.batchId),
                                onChanged: (sel) => setState(() {
                                  if (sel == true) { _selectedBatchIds.add(b.batchId); } else { _selectedBatchIds.remove(b.batchId); }
                                }),
                              ),
                              Expanded(
                                child: InkWell(
                                  onTap: () => Navigator.push(context, MaterialPageRoute(builder: (ctx) => BatchDetailPage(batch: b))),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(children: [
                                        Flexible(child: Text(b.batchId, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold, overflow: TextOverflow.ellipsis))),
                                        const SizedBox(width: 8),
                                        statusWidget,
                                      ]),
                                      const SizedBox(height: 3),
                                      Text("🕒 ${b.createTime.substring(0, 16)}${b.batchRemark.isNotEmpty ? "  📝 ${b.batchRemark}" : ""}",
                                          maxLines: 1, overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(fontSize: 11.5, color: Colors.black87)),
                                      const SizedBox(height: 3),
                                      // 全链路一行：框/托/件/零件 → 在架/出库/作废
                                      Text(
                                          "📦 ${a.boxes}框" +
                                              (a.pallets > 0 ? "（${a.pallets}托）" : "") +
                                              " · ${_fmtBatchQty(a.qtySum)}件 · ${a.partNos.length}种" +
                                              (a.cancelled > 0 ? " · 作废${a.cancelled}" : "") +
                                              (a.noMes > 0 ? " · ⚠️MES缺${a.noMes}" : ""),
                                          style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
                                      Text("🟩在架 ${a.onShelf} · 🟧已出库 ${a.shipped}" +
                                              (ctDist.isNotEmpty ? " · ${ctDist.take(2).map((e) => "${e.key}×${e.value}").join(" ")}" : ""),
                                          style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
                                    ],
                                  ),
                                ),
                              ),
                              Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  SizedBox(
                                    width: 64,
                                    child: TextButton(
                                      style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 2)),
                                      onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (ctx) => BatchDetailPage(batch: b))),
                                      child: const Text("详情", style: TextStyle(fontSize: 12.5)),
                                    ),
                                  ),
                                  if (!b.isArchived)
                                    SizedBox(
                                      width: 64,
                                      child: TextButton(
                                        style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 2), foregroundColor: Colors.grey.shade700),
                                        onPressed: () async {
                                          final ok = await showDialog<bool>(
                                              context: context,
                                              builder: (ctx) => AlertDialog(
                                                      title: const Text("归档批次"),
                                                      content: const Text("归档后无法新增采集记录，确认归档？"),
                                                      actions: [
                                                        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                                                        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认归档")),
                                                      ]));
                                          if (ok == true) {
                                            await _isar.writeTxn(() async {
                                              b.isArchived = true;
                                              await _isar.batchInfos.put(b);
                                            });
                                            setState(_histInvalidate);
                                          }
                                        },
                                        child: const Text("归档", style: TextStyle(fontSize: 12.5)),
                                      ),
                                    ),
                                  if (!b.isArchived)
                                    SizedBox(
                                      width: 64,
                                      child: TextButton(
                                        style: TextButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 2), foregroundColor: Colors.red),
                                        onPressed: () async {
                                          final ok = await showDialog<bool>(
                                              context: context,
                                              builder: (ctx) => AlertDialog(
                                                      title: const Text("删除批次"),
                                                      content: Text("警告！会永久删除该批次全部采集数据（${a.records.length} 条），不可恢复！"),
                                                      actions: [
                                                        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                                                        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认删除", style: TextStyle(color: Colors.red))),
                                                      ]));
                                          if (ok == true) {
                                            await _isar.writeTxn(() async {
                                              final delCodes = await _isar.scanRecords.filter().batchIdEqualTo(b.batchId).findAll();
                                              await _isar.scanRecords.filter().batchIdEqualTo(b.batchId).deleteAll();
                                              for (final dr in delCodes) {
                                                await _isar.recordExtras.filter().goodsCodeEqualTo(dr.goodsCode).deleteAll();
                                              }
                                              await _isar.batchInfos.delete(b.id);
                                            });
                                            AuthApi.scanlogDeleteBatch(b.batchId);
                                            if (_currentBatchId == b.batchId) {
                                              await _loadLastBatch();
                                              await _refreshBatchStat();
                                            }
                                            setState(_histInvalidate);
                                          }
                                        },
                                        child: const Text("删除", style: TextStyle(fontSize: 12.5)),
                                      ),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        );
                      },
                    ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: Row(
                children: [
                  Expanded(
                    child: SizedBox(
                      height: 48,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                            backgroundColor: Colors.grey.shade200,
                            foregroundColor: Colors.black87),
                        onPressed: _selectedBatchIds.isEmpty
                            ? null
                            : () async {
                                for (var bid in _selectedBatchIds) {
                                  final batch = await _isar.batchInfos
                                      .filter()
                                      .batchIdEqualTo(bid)
                                      .findFirst();
                                  if (batch != null && !batch.isArchived) {
                                    await _isar.writeTxn(() async {
                                      batch.isArchived = true;
                                      await _isar.batchInfos.put(batch);
                                    });
                                  }
                                }
                                setState(() {
                                  _selectedBatchIds.clear();
                                  _histInvalidate();
                                });
                              },
                        child: const Text("批量归档"),
                      ),
                    ),
                  ),
                  SizedBox(width: 10),
                  Expanded(
                    child: SizedBox(
                      height: 48,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: _selectedBatchIds.isNotEmpty
                              ? Color(0xFF515BD4)
                              : Colors.grey.shade300,
                        ),
                        onPressed: _selectedBatchIds.isEmpty
                            ? null
                            : () async {
                                await _saveCsvToFile(
                                    batchIds: _selectedBatchIds);
                                setState(() => _selectedBatchIds.clear());
                              },
                        child: const Text("批量导出"),
                      ),
                    ),
                  )
                ],
              ),
            )
          ],
        );
      },
    );
  }

  Future<void> _exportCsvFile() async {
    LocalLog.op('导出CSV');
    await _saveCsvToFile();
  }

  Future<void> _toggleWifiServer() async {
    LocalLog.op('WiFi服务', _webServiceRunning ? '关闭' : '开启');
    if (_webServiceRunning) {
      await stopWebService();
    } else {
      await startWebService();
    }
  }

  // ㉖v53 按自定义页签顺序取页（采集页大块自原内联 children 平移至此）
  Widget _tabPage(String k) {
    switch (k) {
      case 'history':
        return _buildHistoryBatchPage();
      case 'inv':
        return const InventoryHomePage();
      case 'direct':
        return const DirectTransferPage();
      case 'stock':
        return const InventoryStockPage();
      case 'req':
        return const RequisitionPage();
      case 'agv':
        return const AgvMonitorPage();
      case 'insp':
        return const InspectPage();
      default:
        return 
            Column(children: [
              Expanded(
                  child: SingleChildScrollView(
                controller: _mainScrollCtrl,
                padding: const EdgeInsets.all(12),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    //【MOD‑新增2｜替换为截图样式3个统计卡片】
                    Row(
                      children: [
                        Expanded(
                          child: _statItem("正常", "$_normalCount",
                              Color(0xFFE8F5E9), Colors.green),
                        ),
                        SizedBox(width: 10),
                        Expanded(
                          child: _statItem("作废", "$_cancelCount",
                              Color(0xFFFFEBEE), Colors.red),
                        ),
                        SizedBox(width: 10),
                        Expanded(
                          child: _statItem(
                              "本批合计",
                              "${_normalCount + _cancelCount}",
                              Color(0xFFE8EAF6),
                              Color(0xFF515BD4),
                              isCircle: true),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      height: 52,
                      child: ElevatedButton(
                        style: ElevatedButton.styleFrom(
                          backgroundColor: Color(0xFF515BD4),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(12)),
                          padding: const EdgeInsets.symmetric(
                              vertical: 8), // 增加垂直内边距，防止文字紧贴上下边缘
                        ),
                        onPressed: () => _createNewBatch(),
                        child: const Text(
                          "+ 新建采集批次",
                          style: TextStyle(
                            fontSize: 16,
                            color: Colors.white, // 强制白色文字，提升和紫色背景对比度，解决看不清
                            fontWeight: FontWeight.w500, // 字重加粗，文字更清晰
                          ),
                        ),
                      ),
                    ),

                    const SizedBox(height: 16),
                    const Text("作业模式",
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 6),
                    Row(
                      children: [
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              // AGV模式点击逻辑写这里
                            },
                            child: _workModeCard(0, "AGV站台模式", "AGV站台扫码采集"),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: InkWell(
                            onTap: () {
                              // 人工模式点击逻辑写这里
                            },
                            child: _workModeCard(1, "人工地面摆放", "人工地堆托盘扫码"),
                          ),
                        ),
                      ],
                    ),

// ===== 整托合并模式：开关 + 当前托汇总卡片 =====
                    Container(
                      margin: const EdgeInsets.only(top: 12),
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 6),
                      decoration: BoxDecoration(
                        color: _palletMode
                            ? const Color(0xFFF0FFF4)
                            : Colors.white,
                        borderRadius: BorderRadius.circular(12),
                        border: Border.all(
                            color: _palletMode
                                ? Colors.green.shade300
                                : Colors.grey.shade300),
                      ),
                      child: Row(
                        children: [
                          const Text("整托合并模式",
                              style: TextStyle(
                                  fontSize: 15, fontWeight: FontWeight.w500)),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                                _palletMode
                                    ? (_currentPalletId == null
                                        ? "已开启，扫码自动开托"
                                        : "当前托：$_currentPalletId")
                                    : "一托多码按零件号累加数量",
                                style: TextStyle(
                                    fontSize: 12, color: Colors.grey.shade600),
                                overflow: TextOverflow.ellipsis),
                          ),
                          if (_palletMode && _currentPalletId != null)
                            TextButton(
                                onPressed: _endPallet,
                                child: const Text("结束本托",
                                    style:
                                        TextStyle(color: Color(0xFF515BD4)))),
                          Switch(
                              value: _palletMode,
                              activeColor: Colors.green,
                              onChanged: _togglePalletMode),
                        ],
                      ),
                    ),
                    if (_palletMode && _palletTotalBoxes > 0)
                      Container(
                        width: double.infinity,
                        margin: const EdgeInsets.only(top: 8),
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFF7F8FF),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: const Color(0xFFC7CDF0)),
                        ),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text("当前托汇总（已扫 $_palletTotalBoxes 框）",
                                style: const TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.bold,
                                    color: Color(0xFF515BD4))),
                            const SizedBox(height: 6),
                            ..._palletSummary.map((g) => Padding(
                                  padding:
                                      const EdgeInsets.symmetric(vertical: 2),
                                  child: Text(
                                      "${g["partNo"]}  ${g["itemName"].toString().isNotEmpty ? g["itemName"] : ""}  ${g["boxes"]}框  数量合计：${_fmtQty(g["qty"] as double)}",
                                      style: const TextStyle(fontSize: 13)),
                                )),
                          ],
                        ),
                      ),

                    const SizedBox(height: 12),
                    Container(
                      key: _keyContainerArea,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text("容器类型",
                              style: TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.w500)),
                          const SizedBox(height: 6),
                          SingleChildScrollView(
                            scrollDirection: Axis.horizontal,
                            child: Row(
                              children: [
                                for (final m in _containers) ...[
                                  _buildContainerButton(
                                      showText: m["show"] ?? "",
                                      dbValue: m["db"] ?? ""),
                                  const SizedBox(width: 8),
                                ],
                                if (Auth.can(
                                    "location_reg")) // ㉖ 容器类型管理（新增框型免发版）
                                  SizedBox(
                                    height: 48,
                                    child: OutlinedButton(
                                      onPressed: _manageContainers,
                                      style: OutlinedButton.styleFrom(
                                        foregroundColor: Colors.blueGrey,
                                        side: BorderSide(
                                            color: Colors.grey.shade400),
                                        shape: RoundedRectangleBorder(
                                            borderRadius:
                                                BorderRadius.circular(12)),
                                      ),
                                      child: const Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Icon(Icons.tune, size: 18),
                                            SizedBox(width: 4),
                                            Text("管理",
                                                style: TextStyle(fontSize: 14)),
                                          ]),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),

                    Container(
                      key: _keyLocationArea,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text("选择货位 *",
                              style: TextStyle(
                                  fontSize: 16, fontWeight: FontWeight.w500)),
                          const SizedBox(height: 6),
                          if (_workType == 0) _buildStationPanel(),
                          if (_workType == 1) _buildGroundLocPanel(),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),

                    const SizedBox(height: 12),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        const Text("备注标签",
                            style: TextStyle(
                                fontSize: 16, fontWeight: FontWeight.w500)),
                        Text("可多选 · 冲突项目自动互斥",
                            style: TextStyle(fontSize: 12, color: Colors.grey)),
                      ],
                    ),
                    const SizedBox(height: 8),
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          //第一组 quickRemarkTags
                          ..._quickRemarkTags
                              .map((tag) => Padding(
                                    padding: const EdgeInsets.only(right: 10),
                                    child: FilterChip(
                                      label: Text(tag),
                                      selected: _selectedTags.contains(tag),
                                      onSelected: (sel) {
                                        setState(() {
                                          if (sel) {
                                            _selectedTags.add(tag);
                                          } else {
                                            _selectedTags.remove(tag);
                                          }
                                        });
                                      },
                                    ),
                                  ))
                              .toList()
                              .cast<Widget>(),
                          //第二组 extraTags，接在同一行后面
                          ..._extraTags
                              .map((tag) => Padding(
                                    padding: const EdgeInsets.only(right: 6),
                                    child: FilterChip(
                                      label: Text(tag,
                                          style: TextStyle(fontSize: 12)),
                                      selected: _selectedTags.contains(tag),
                                      onSelected: (sel) {
                                        setState(() {
                                          if (sel) {
                                            _selectedTags.add(tag);
                                          } else {
                                            _selectedTags.remove(tag);
                                          }
                                        });
                                      },
                                    ),
                                  ))
                              .toList()
                              .cast<Widget>(),
                        ],
                      ),
                    ),

                    const SizedBox(height: 12),
                    TextField(
                      controller: _remarkInputCtrl,
                      decoration: const InputDecoration(
                          hintText: "自定义补充备注（可选）",
                          border: OutlineInputBorder(),
                          isDense: true),
                    ),
                    const SizedBox(height: 4),
                    _buildLedgerExtras(), // ㉖⑬ 账本登记挪表单底部：输入框整行不再被挤
                    const Divider(),
                    InkWell(
                      onTap: () {
                        setState(() {
                          _recordPanelExpanded = !_recordPanelExpanded;
                        });
                      },
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Row(
                            children: [
                              const Text("本批次采集记录",
                                  style: TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w500)),
                              SizedBox(width: 8),
                              Text("共 ${_recordList.length}条",
                                  style: TextStyle(
                                      fontSize: 13, color: Colors.grey)),
                              const SizedBox(width: 8),
                              ValueListenableBuilder<int>(
                                  valueListenable: kScanSync,
                                  builder: (_, st, __) => Text(
                                      st == 0
                                          ? "☁ 已同步"
                                          : (st == 1 ? "⏳ 同步中" : "🔄 重试中"),
                                      style: TextStyle(
                                          fontSize: 11.5,
                                          color: st == 0
                                              ? Colors.green
                                              : Colors.orange))),
                            ],
                          ),
                          Icon(_recordPanelExpanded
                              ? Icons.expand_less
                              : Icons.expand_more),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    // =========【修改：移除固定高度，改用自适应+最大高度约束】 =========
                    if (_recordPanelExpanded) _buildRecordList(),

                    const SizedBox(height: 16),
                  ],
                ),
              )),
              ScanBar(
                  ctrl: _goodsInputCtrl,
                  focus: _goodsFocusNode,
                  hint: "扫描或输入货物条码",
                  camera: _openCameraScan,
                  onSubmit: (s) => WidgetsBinding.instance
                      .addPostFrameCallback((_) => _saveRecord(s))),
            ])
      ;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Color(0xFF515BD4),
        toolbarHeight: 5, // 原来标题没了，把顶部栏高度压低
        bottom: TabBar(
          controller: _tabController,
          isScrollable: true,
          tabAlignment: TabAlignment.start, // 7个页签可横滑，标签不再被压成一个字
          labelColor: Colors.white, //选中文字白色
          labelStyle: TextStyle(fontWeight: FontWeight.bold), //选中加粗
          unselectedLabelColor: Color(0xFFD0D4F8), //未选中浅白色
          indicatorColor: Colors.white,
          tabs: [for (final k in _tabKeys) Tab(text: TabCustom.titles[k] ?? k)],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [for (final k in _tabKeys) _tabPage(k)],
      ),
      bottomNavigationBar: ValueListenableBuilder<int>(
          valueListenable: kUnreadMsgs,
          builder: (_, unread, __) => BottomNavigationBar(
                items: [
                  const BottomNavigationBarItem(
                      icon: SizedBox.shrink(), label: "采集"),
                  BottomNavigationBarItem(
                      icon: const SizedBox.shrink(),
                      label: unread > 0 ? "消息·$unread" : "消息"),
                  const BottomNavigationBarItem(
                      icon: SizedBox.shrink(), label: "设置"),
                ],
                currentIndex: 0,
                type: BottomNavigationBarType.fixed,
                showSelectedLabels: true,
                showUnselectedLabels: true,
                onTap: (idx) async {
                  if (idx == 0) {
                    final ci = _tabKeys.indexOf('collect'); // ㉖v53 采集可能被用户挪位，按键定位
                    if (ci >= 0) _tabController.animateTo(ci);
                  } else if (idx == 1) {
                    // ㉑消息中枢：分组卡片流，点消息跳领料页
                    await Navigator.push(
                        context,
                        MaterialPageRoute(
                            builder: (_) => MessageHubPage(
                                  onOpenReq: () => _tabController.animateTo(
                                      _tabKeys.indexOf('req') >= 0
                                          ? _tabKeys.indexOf('req')
                                          : 0),
                                  onOpenAgv: () => _tabController.animateTo(
                                      _tabKeys.indexOf('agv') >= 0
                                          ? _tabKeys.indexOf('agv')
                                          : 0),
                                )));
                    // 已读时间戳落盘后重算未读（进页面看过即消，不再无脑清零）
                    _recountUnread();
                  } else if (idx == 2) {
                    //跳转设置菜单页（导出功能已并入此页顶部）
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                          builder: (context) => SettingsMenuPage(
                                onWifi: _toggleWifiServer,
                              )),
                    );
                  }
                },
              )),
    );
  }

  //统计卡片组件
  Widget _statItem(String title, String num, Color bg, Color txtColor,
      {bool isCircle = false}) {
    return Container(
      padding: EdgeInsets.all(12),
      decoration:
          BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
      child: Column(
        children: [
          isCircle
              ? Container(
                  width: 40,
                  height: 40,
                  decoration:
                      BoxDecoration(color: txtColor, shape: BoxShape.circle),
                  child: Center(
                      child: Text(num,
                          style: TextStyle(
                              color: Colors.white,
                              fontSize: 18,
                              fontWeight: FontWeight.bold))),
                )
              : Text(num,
                  style: TextStyle(
                      fontSize: 22,
                      fontWeight: FontWeight.bold,
                      color: txtColor)),
          const SizedBox(height: 4),
          Text(title, style: const TextStyle(fontSize: 13)),
        ],
      ),
    );
  }

  /// ㉖ 容器类型从服务器拉取（失败静默保留默认5项）
  Future<void> _loadContainers() async {
    final r = await AuthApi.containersGet();
    if (!mounted || r["ok"] != true) return;
    final ts = List<Map>.from(r["types"] ?? []);
    if (ts.isEmpty) return;
    setState(() {
      _containers
        ..clear()
        ..addAll(ts
            .map((t) => {
                  "db": t["db"]?.toString() ?? "",
                  "show": t["show"]?.toString() ?? ""
                })
            .where((m) => m["db"]!.isNotEmpty && m["show"]!.isNotEmpty));
    });
    _applyDefaultPallet(); // 配置到手后补跑默认框型（防 initState 竞态：新框型设为默认时首轮列表还是兜底值）
  }

  /// ㉖ 容器类型管理弹层（仓管/管理员）：增删改，保存全端生效
  Future<void> _manageContainers() async {
    final edit = _containers.map((m) => Map<String, String>.of(m)).toList();
    // 每行两个 controller（显示名/落库值）：一次建好并随行增删同步维护，避免重建丢焦点与泄漏
    final ctrls = <List<TextEditingController>>[
      for (final m in edit)
        [
          TextEditingController(text: m["show"]),
          TextEditingController(text: m["db"]),
        ]
    ];
    void addRow() {
      edit.add({"db": "", "show": ""});
      ctrls.add([TextEditingController(), TextEditingController()]);
    }

    void rmRow(int i) {
      for (final c in ctrls[i]) {
        c.dispose();
      }
      ctrls.removeAt(i);
      edit.removeAt(i);
    }

    final saved = await showModalBottomSheet<List<Map<String, String>>>(
        context: context,
        isScrollControlled: true,
        builder: (mc) => StatefulBuilder(
            builder: (mc2, setSt) => SafeArea(
                child: Padding(
                    padding: EdgeInsets.fromLTRB(
                        14, 12, 14, MediaQuery.of(mc2).viewInsets.bottom + 12),
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      const Text("容器类型管理（保存后全端生效）",
                          style: TextStyle(
                              fontSize: 16, fontWeight: FontWeight.bold)),
                      const SizedBox(height: 4),
                      const Text("落库值同时用于 WMAS 容器编码匹配（容器编码包含该关键字即命中），请与主档命名对齐",
                          style: TextStyle(fontSize: 11, color: Colors.grey)),
                      const SizedBox(height: 8),
                      Flexible(
                          child: ListView(
                              shrinkWrap: true,
                              children: List.generate(edit.length, (i) {
                                final m = edit[i];
                                return Row(children: [
                                  Expanded(
                                      child: TextField(
                                    controller: ctrls[i][0],
                                    onChanged: (v) => m["show"] = v,
                                    decoration: const InputDecoration(
                                        labelText: "显示名",
                                        isDense: true,
                                        border: OutlineInputBorder()),
                                  )),
                                  const SizedBox(width: 6),
                                  Expanded(
                                      flex: 2,
                                      child: TextField(
                                        controller: ctrls[i][1],
                                        onChanged: (v) => m["db"] = v,
                                        decoration: const InputDecoration(
                                            labelText: "落库值/匹配关键字",
                                            isDense: true,
                                            border: OutlineInputBorder()),
                                      )),
                                  IconButton(
                                      onPressed: () => setSt(() => rmRow(i)),
                                      icon: const Icon(
                                          Icons.remove_circle_outline,
                                          color: Colors.red)),
                                ]);
                              }))),
                      Row(children: [
                        TextButton.icon(
                            onPressed: () => setSt(addRow),
                            icon: const Icon(Icons.add, size: 18),
                            label: const Text("加一项")),
                        const Spacer(),
                        TextButton(
                            onPressed: () => Navigator.pop(mc2),
                            child: const Text("取消")),
                        FilledButton(
                            onPressed: () {
                              final ok = <Map<String, String>>[];
                              final seen = <String>{};
                              for (final m in edit) {
                                final dbv = (m["db"] ?? "").trim(),
                                    sh = (m["show"] ?? "").trim();
                                if (dbv.isEmpty || sh.isEmpty) continue;
                                if (!seen.add(dbv.toUpperCase())) continue;
                                ok.add({"db": dbv, "show": sh});
                              }
                              if (ok.isEmpty) {
                                ScaffoldMessenger.of(mc2).showSnackBar(
                                    const SnackBar(
                                        content: Text("至少保留一项且显示名/落库值不能留空")));
                                return;
                              }
                              Navigator.pop(mc2, ok);
                            },
                            child: const Text("保存")),
                      ]),
                    ])))));
    for (final pair in ctrls) {
      for (final c in pair) {
        c.dispose();
      }
    } // 弹层关闭统一释放（含保存/取消/下滑关闭所有路径）
    if (saved == null || saved.isEmpty || !mounted) return;
    final r = await AuthApi.containersSet(saved);
    if (!mounted) return;
    if (r["ok"] == true) {
      setState(() {
        _containers
          ..clear()
          ..addAll(saved);
        if (!_containers.any((m) => m["db"] == _containerType)) {
          _containerType = null; // 原选中项被删：清空防脏值
        }
      });
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text("容器类型已保存，全端下次进入采集页生效"),
          backgroundColor: Color(0xFF2E7D32)));
    } else {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text("保存失败：${r["msg"] ?? "?"}"),
          backgroundColor: Colors.red));
    }
  }

  /// ②按登录账号记住/恢复工作模式（0=AGV站台 1=人工地面）
  Future<void> _restoreWorkMode() async {
    final sp = await SharedPreferences.getInstance();
    final v = sp.getInt('worktype_' + (Auth.user?.id ?? ''));
    if (v == 1 && mounted) setState(() => _workType = 1);
  }

  /// 第3档 按偏好预填默认框型（仅在尚未选择时；全机偏好）㉖ 合法值跟随服务器容器类型配置
  Future<void> _applyDefaultPallet() async {
    final sp = await SharedPreferences.getInstance();
    final p = sp.getString("pd_defPallet") ?? "";
    if (p.isEmpty || _containerType != null || !mounted) return;
    if (_containers.any((m) => m["db"] == p))
      setState(() => _containerType = p);
  }

  void _saveWorkMode(int type) {
    SharedPreferences.getInstance()
        .then((sp) => sp.setInt("worktype_" + (Auth.user?.id ?? ""), type))
        .then((_) => PrefsSync.pushAll()); // ㉖B14 工作模式上云
  }

  /// ㉖B14 服务器偏好回写本地后，刷新工作模式选择
  void _onPrefsChanged() {
    if (!mounted) return;
    _applyCustomTabs(); // ㉖v53 服务器回写的页签布局即时重建
    SharedPreferences.getInstance().then((sp) {
      final v = sp.getInt("worktype_" + (Auth.user?.id ?? ""));
      if (mounted && v != _workType)
        setState(() {
          _workType = v == 1 ? 1 : 0;
          _lastScanStation = null;
          _lastScanContainer = null;
          if (_workType == 1)
            _selectedStation = null;
          else
            _selectedGroundLoc = null;
        });
    });
  }

  //作业模式卡片组件
  Widget _workModeCard(int type, String title, String sub) {
    bool selected = _workType == type;
    return InkWell(
      onTap: () {
        setState(() {
          _workType = type;
          _saveWorkMode(type); // ②记住本账号工作模式
          _lastScanStation = null;
          _lastScanContainer = null;
          _ledgerLocCtrl.clear(); // ㉖v69c 切模式清空货位编码输入框：地面NB03残留会流进AGV模式致叫车"库位不在WMAS主档"
          if (type == 0) {
            _selectedGroundLoc = null;
          } else {
            _selectedStation = null;
          }
          _containerType = null;
          // 切换作业模式：结束当前托，防止跨托串号
          _currentPalletId = null;
          _palletSummary = [];
          _palletTotalBoxes = 0;
        });
      },
      child: Container(
        padding: const EdgeInsets.symmetric(
            horizontal: 12, vertical: 10), // ← 改这里，上下内边距缩小
        decoration: BoxDecoration(
            color: selected ? Color(0xFFF0F0FF) : Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
                color: selected ? Color(0xFF515BD4) : Colors.grey.shade200,
                width: selected ? 2 : 1)),
        child: Column(
          mainAxisSize: MainAxisSize.min, // 关键！让Column高度自适应内容，不自动撑高
          children: [
            Text(title,
                style: TextStyle(
                    fontSize: 16,
                    fontWeight: selected ? FontWeight.bold : FontWeight.normal,
                    color: selected ? Color(0xFF515BD4) : Colors.black87)),
            SizedBox(height: 4),
          ],
        ),
      ),
    );
  }
}

class BatchDetailPage extends StatefulWidget {
  final BatchInfo batch;
  const BatchDetailPage({super.key, required this.batch});
  @override
  State<BatchDetailPage> createState() => _BatchDetailPageState();
}

class _BatchDetailPageState extends State<BatchDetailPage> {
  late Isar _isar;
  List<ScanRecord> _records = [];
  BatchAgg? _agg; // ㉖v52 全链路聚合（汇总头+整托表）
  bool _isLoading = true;
  bool _palletOpen = false;
  String _dq = "", _df = "";

  @override
  void initState() {
    super.initState();
    _isar = _globalIsar;
    _loadRecords();
  }

  Future<void> _loadRecords() async {
    setState(() {
      _isLoading = true;
    });
    try {
      final agg = await computeBatchAgg(_isar, widget.batch.batchId,
          issuedExtra: await RequisitionCache.loadIssued());
      _records = agg.records.reversed.toList();
      _agg = agg;
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text("加载异常: $e")),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _deleteRecord(ScanRecord r) async {
    // ㉖⑭ 物理删除改作废/恢复：留痕可逆，联动消账/重建与全局防重释放
    final cancel = !r.isCancel;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(cancel ? "作废本条采集" : "恢复本条采集"),
        content: Text(cancel
            ? "作废 = 业务失效但留痕可恢复；该标签无其他生效采集时同步消账、释放站台、解除防重。\n\n标签 ${r.goodsCode}"
            : "恢复为生效记录；作废期间已消账的按原货位重新登记。\n\n标签 ${r.goodsCode}"),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text("取消")),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: Text(cancel ? "确认作废" : "确认恢复",
                  style: TextStyle(color: cancel ? Colors.red : Colors.green))),
        ],
      ),
    );
    if (confirm != true) return;
    if (cancel) {
      await scanRecordCancel(_isar, r);
    } else {
      await scanRecordRestore(_isar, r);
    }
    await _loadRecords();
  }

  Future<void> _exportThisBatch() async {
    String csvField(String v) {
      if (v.contains(",") || v.contains("\""))
        return "\"${v.replaceAll("\"", "\"\"")}\"";
      return v;
    }

    //【修改这里，增加MES三列｜整托：托号列+汇总段】
    String header =
        "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期,托号\n";
    String content = header;
    List<ScanRecord> targetRecords = _records;
    targetRecords.sort((a, b) => a.scanTime.compareTo(b.scanTime));
    final extras = await _isar.recordExtras.where().findAll();
    final Map<String, RecordExtra> extraMap = {
      for (var e in extras) e.goodsCode: e
    };
    for (var r in targetRecords) {
      String timeStr = r.scanTime.toString().substring(0, 19);
      String wt = r.workType.toString();
      String st = r.stationNo ?? "";
      String gl = r.groundLocation ?? "";
      String container = r.containerType ?? "";
      String code = r.goodsCode;
      String rem = r.remark;
      String statusText = r.isCancel ? "作废" : "正常";
      //新增MES
      String pn = r.mesPartNo ?? "";
      String qty = r.mesQty?.toString() ?? "";
      String pd = r.mesCreateTime ?? "";
      String pid = extraMap[code]?.palletId ?? "";
      content +=
          "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText,$pn,$qty,$pd,$pid\n";
    }
    // 整托汇总段：一行 = 托(货位)+零件号
    final Map<String, List<ScanRecord>> palletGroups = {};
    for (final r in targetRecords) {
      if (r.isCancel) continue;
      final pid = extraMap[r.goodsCode]?.palletId ?? "";
      if (pid.isEmpty) continue;
      palletGroups.putIfAbsent(pid, () => []).add(r);
    }
    if (palletGroups.isNotEmpty) {
      content += "\n===整托汇总(一行=托+零件号)===\n";
      content += "托号,作业类型,站台编号,地面货位编码,容器类型,零件号,物料名称,框数,标签号(分号分隔),数量合计\n";
      final keys = palletGroups.keys.toList()..sort();
      for (final pid in keys) {
        final rs = palletGroups[pid]!
          ..sort((a, b) => a.scanTime.compareTo(b.scanTime));
        final Map<String, List<ScanRecord>> byPart = {};
        for (final r in rs) {
          final pn =
              (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
          byPart.putIfAbsent(pn, () => []).add(r);
        }
        for (final entry in byPart.entries) {
          final rowsOfPart = entry.value;
          final codes = rowsOfPart.map((e) => e.goodsCode).join("；");
          final names = rowsOfPart
              .map((e) => extraMap[e.goodsCode]?.mesItemName ?? "")
              .where((e) => e.isNotEmpty)
              .toSet()
              .join("；");
          final totalQty =
              rowsOfPart.fold<double>(0, (s, e) => s + (e.mesQty ?? 0));
          final loc0 = rowsOfPart.first;
          content +=
              "${csvField(pid)},${loc0.workType},${csvField(loc0.stationNo ?? "")},${csvField(loc0.groundLocation ?? "")},${csvField(loc0.containerType ?? "")},${csvField(entry.key)},${csvField(names)},${rowsOfPart.length},${csvField(codes)},${_fmtQtyLocal(totalQty)}\n";
        }
      }
    }
    // ===== 整托末段子表：主表同12列，按托聚合一行 =====
    content += _buildPalletAggCsv(targetRecords, extraMap);
    final dir = await getExternalStorageDirectory();
    if (dir == null) return;
    String filePath = "${dir.path}/采集_${widget.batch.batchId}.csv";
    File file = File(filePath);
    await file.writeAsString(content, encoding: utf8);
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text("文件已保存：$filePath")));
    }
  }

  String _fmtQtyLocal(double q) =>
      q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);

  @override
  Widget build(BuildContext context) {
    bool archived = widget.batch.isArchived;
    return Scaffold(
      appBar: AppBar(
        title:
            Text("${widget.batch.batchId} ${archived ? "【已归档‑只读】" : "【进行中】"}"),
        backgroundColor: const Color(0xFF515BD4),
        actions: [
          TextButton(
            onPressed: _exportThisBatch,
            child: const Text("导出CSV", style: TextStyle(color: Colors.white)),
          )
        ],
      ),
      body: RefreshIndicator(
        onRefresh: _loadRecords,
        child: _buildBody(archived), // ✅ 把archived传进函数
      ),
    );
  }

  // ✅ 新增参数 bool archived
  Widget _buildBody(bool archived) {
    if (_isLoading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_records.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 300),
          Center(child: Text("该批次暂无采集记录")),
        ],
      );
    }
    final a = _agg;
    // ㉖v52 全链路汇总头（借鉴网页批次详情）：指标 + 可展开整托明细表
    final head = a == null
        ? const SizedBox.shrink()
        : Container(
            width: double.infinity,
            color: Colors.white,
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 2),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Wrap(spacing: 7, runSpacing: 5, children: [
                _kpiMini('${a.valid}', '有效记录', const Color(0xFF00897B)),
                _kpiMini('${a.boxes}', '框', const Color(0xFF3949AB)),
                if (a.pallets > 0) _kpiMini('${a.pallets}', '整托', const Color(0xFF7B1FA2)),
                _kpiMini(_fmtBatchQty(a.qtySum), '件数', const Color(0xFF2E7D32)),
                _kpiMini('${a.partNos.length}', '零件种', const Color(0xFF515BD4)),
                _kpiMini('${a.onShelf}', '在架', const Color(0xFF43A047)),
                _kpiMini('${a.shipped}', '已出库', Colors.deepOrange),
                if (a.cancelled > 0) _kpiMini('${a.cancelled}', '作废', Colors.red),
                if (a.noMes > 0) _kpiMini('${a.noMes}', 'MES缺失', const Color(0xFFE53935)),
              ]),
              if (a.containerDist.isNotEmpty)
                Padding(
                    padding: const EdgeInsets.only(top: 2),
                    child: Text("容器：${a.containerDist.entries.map((e) => "${e.key}×${e.value}").join("  ")}",
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600))),
              if (a.palletRows.isNotEmpty)
                InkWell(
                    onTap: () => setState(() => _palletOpen = !_palletOpen),
                    child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 6),
                        child: Row(children: [
                          Icon(_palletOpen ? Icons.expand_less : Icons.expand_more, size: 18, color: const Color(0xFF7B1FA2)),
                          const SizedBox(width: 4),
                          Text("🛢 整托汇总 ${a.palletRows.length} 组（托×零件一行）",
                              style: const TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: Color(0xFF7B1FA2))),
                        ]))),
              if (_palletOpen)
                ...a.palletRows.map((p) => Container(
                    margin: const EdgeInsets.only(bottom: 4),
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                    decoration: BoxDecoration(color: const Color(0xFFF3E9FB), borderRadius: BorderRadius.circular(8)),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text("${p["palletId"]} · ${p["partNo"]}${(p["itemName"] as String).isNotEmpty ? " ${p["itemName"]}" : ""}",
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                      Text("${p["n"]}码 · ${_fmtBatchQty((p["qty"] as num).toDouble())}件 · 位置:${p["loc"]}",
                          style: const TextStyle(fontSize: 11, color: Colors.blueGrey)),
                      Text("${p["codes"]}", maxLines: 1, overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 10.5, color: Colors.grey.shade600, fontFamily: "monospace")),
                    ]))),
            ]));
    var list = _records;
    final dk = _dq.trim().toLowerCase();
    if (dk.isNotEmpty) {
      list = list.where((r) =>
          r.goodsCode.toLowerCase().contains(dk) ||
          (r.mesPartNo ?? "").toLowerCase().contains(dk) ||
          (_agg?.extraMap[r.goodsCode.toUpperCase()]?.mesItemName ?? "").toLowerCase().contains(dk)).toList();
    }
    if (_df == "cx") list = list.where((r) => r.isCancel).toList();
    else if (_df == "valid") list = list.where((r) => !r.isCancel).toList();
    return Column(children: [
      head,
      Padding(
          padding: const EdgeInsets.fromLTRB(10, 4, 10, 0),
          child: Row(children: [
            Expanded(
                child: TextField(
              onChanged: (v) => setState(() => _dq = v),
              style: const TextStyle(fontSize: 13),
              decoration: InputDecoration(
                  hintText: "搜标签/零件/物料", isDense: true, filled: true, fillColor: Colors.white,
                  prefixIcon: const Icon(Icons.search, size: 17),
                  suffixIcon: _dq.isEmpty ? null : IconButton(
                      icon: const Icon(Icons.clear, size: 15), onPressed: () => setState(() => _dq = "")),
                  contentPadding: const EdgeInsets.symmetric(vertical: 6, horizontal: 8),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(8))),
            )),
            const SizedBox(width: 6),
            PopupMenuButton<String>(
                icon: const Icon(Icons.filter_alt_outlined, size: 20),
                tooltip: "按状态筛选",
                onSelected: (v) => setState(() => _df = v == _df ? "" : v),
                itemBuilder: (c) => const [
                  PopupMenuItem(value: "valid", child: Text("仅正常")),
                  PopupMenuItem(value: "cx", child: Text("仅作废")),
                  PopupMenuItem(value: "", child: Text("全部状态")),
                ]),
          ])),
      Expanded(
        child: list.isEmpty
            ? const Center(child: Text("没有符合条件的记录", style: TextStyle(color: Colors.grey)))
            : ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: list.length,
      itemBuilder: (c, idx) {
        var r = list[idx];
        String posTxt =
            r.workType == 0 ? "站台${r.stationNo}" : "货位${r.groundLocation}";
        String timeTxt = r.scanTime.toString().substring(0, 19);
        return Card(
          margin: const EdgeInsets.only(bottom: 8),
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        "货码：${r.goodsCode}",
                        style: const TextStyle(
                            fontSize: 18, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Text("📍 $posTxt｜容器:${r.containerType ?? "未选择"}"),
                      Text("⏱ 采集时间：$timeTxt"),
                      Text("📝 备注：${r.remark.isNotEmpty ? r.remark : "无"}"),
                      const SizedBox(height: 4),
                      Text(
                        r.isCancel ? "⚠️ 已作废" : "✅ 正常",
                        style: TextStyle(
                            color: r.isCancel ? Colors.red : Colors.green),
                      ),
                    ],
                  ),
                ),
                // 右侧按钮区域：【查看】 + 【删除】
                Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextButton(
                      onPressed: () {
                        // 点击查看，打开ScanRecordDetailPage，把r传过去
                        Navigator.push(
                          context,
                          MaterialPageRoute(
                              builder: (ctx) =>
                                  ScanRecordDetailPage(record: r)),
                        );
                      },
                      child: const Text("查看"),
                    ),
                    if (!archived)
                      TextButton(
                        style: TextButton.styleFrom(
                            foregroundColor:
                                r.isCancel ? Colors.green : Colors.red),
                        onPressed: () => _deleteRecord(r),
                        child: Text(r.isCancel ? "恢复" : "作废"),
                      ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    ),
      ),
    ]);
  }
}

// ==========【新增页面：ScanRecordDetailPage 放在这里，BatchDetailPage后面】==========
class ScanRecordDetailPage extends StatefulWidget {
  final ScanRecord record;
  const ScanRecordDetailPage({super.key, required this.record});

  @override
  State<ScanRecordDetailPage> createState() => _ScanRecordDetailPageState();
}

class _ScanRecordDetailPageState extends State<ScanRecordDetailPage> {
  @override
  Widget build(BuildContext context) {
    final r = widget.record;
    String posTxt =
        r.workType == 0 ? "站台${r.stationNo}" : "货位${r.groundLocation}";
    String timeTxt = r.scanTime.toString().substring(0, 19);
    return Scaffold(
      appBar: AppBar(
        title: const Text("采集记录详情"),
        backgroundColor: const Color(0xFF515BD4),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              "货码：${r.goodsCode}",
              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 12),
            _detailItem("作业位置", posTxt),
            FutureBuilder<ShelfPlacement?>(
              future: _globalIsar.shelfPlacements
                  .filter()
                  .goodsCodeEqualTo(r.goodsCode.toUpperCase())
                  .findFirst(),
              builder: (ctx, s) => _detailItem(
                  "当前货位(账本)",
                  !s.hasData
                      ? "…"
                      : ((s.data?.loc ?? "").isEmpty ? "未登记" : s.data!.loc)),
            ),
            _detailItem("容器类型", r.containerType ?? "未选择"),
            _detailItem("采集时间", timeTxt),
            _detailItem("备注", r.remark.isNotEmpty ? r.remark : "无"),
            _detailItem("记录状态", r.isCancel ? "⚠️ 已作废" : "✅ 正常"),
            _detailItem("MES零件号", r.mesPartNo ?? "无"),
            _detailItem("MES数量", r.mesQty?.toString() ?? "无"),
            _detailItem("MES生产日期", r.mesCreateTime ?? "无"),
            FutureBuilder<RecordExtra?>(
              future: _globalIsar.recordExtras
                  .filter()
                  .goodsCodeEqualTo(r.goodsCode.toUpperCase())
                  .findFirst(),
              builder: (ctx, ex) {
                if (!ex.hasData) return const SizedBox.shrink();
                final e = ex.data!;
                return Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _detailItem(
                          "托盘号", e.palletId.isEmpty ? "（单件，非整托）" : e.palletId),
                      if (e.palletId.isNotEmpty)
                        FutureBuilder<List<RecordExtra>>(
                          future: _globalIsar.recordExtras
                              .filter()
                              .palletIdEqualTo(e.palletId)
                              .findAll(),
                          builder: (ctx2, s2) => _detailItem(
                              "同托标签",
                              s2.hasData
                                  ? s2.data!.map((x) => x.goodsCode).join("、")
                                  : "…"),
                        ),
                      if ((e.mesItemName ?? "").isNotEmpty)
                        _detailItem("物料名称", e.mesItemName),
                      if (lotFromPrintDate(r.mesCreateTime ?? "", e.mesLotNo)
                          .isNotEmpty)
                        _detailItem(
                            "批次",
                            lotFromPrintDate(r.mesCreateTime ?? "", e.mesLotNo)),
                      if ((e.operator ?? "").isNotEmpty)
                        _detailItem("采集人", e.operator),
                    ]);
              },
            ),
            if (r.workType == 0)
              FutureBuilder<Map>(
                future: _fetchAgvChain(r),
                builder: (ctx, f2) {
                  final d = f2.data;
                  if (d == null)
                    return _detailItem(
                        "AGV搬运链路",
                        f2.connectionState == ConnectionState.done
                            ? "无AGV任务记录（人工搬运或历史已清理）"
                            : "查询中…");
                  if (d.isEmpty)
                    return _detailItem("AGV搬运链路", "无AGV任务记录（人工搬运或历史已清理）");
                  return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        _detailItem("搬运路线", "${d["sp"]} → ${d["ep"]}"),
                        _detailItem(
                            "服务车辆",
                            (d["car"] ?? "").isEmpty
                                ? "未分配/未知"
                                : d["car"].toString()),
                        _detailItem("任务状态", (d["state"] ?? "").toString()),
                        if ((d["tl"] ?? "").toString().isNotEmpty)
                          _detailItem("节点时间", d["tl"].toString()),
                        if (d["chain"] is Map && (d["chain"] as Map).isNotEmpty)
                          _detailItem("出库链路", (() {
                            final ch = d["chain"] as Map;
                            final _fm = (Object? v) {
                              final n = v is num ? v.toInt() : 0;
                              if (n == 0) return "";
                              final dt = DateTime.fromMillisecondsSinceEpoch(n);
                              final p = (int x) => x.toString().padLeft(2, "0");
                              return "${p(dt.month)}-${p(dt.day)} ${p(dt.hour)}:${p(dt.minute)}";
                            };
                            const steps = [
                              ["created", "下单"],
                              ["accept", "接单"],
                              ["issue", "发料"],
                              ["call", "叫车"],
                              ["enqueue", "入队"],
                              ["dispatch", "下发"],
                              ["exe", "接令"],
                              ["pick", "叉出"],
                              ["arrive", "到站"],
                              ["transfer", "转MES"],
                              ["confirm", "签收"]
                            ];
                            final parts = <String>[];
                            for (final e in steps) {
                              final s = _fm(ch[e[0]]);
                              if (s.isNotEmpty) parts.add("${e[1]}$s");
                            }
                            return parts.join(" → ");
                          })()),
                      ]);
                },
              ),
          ],
        ),
      ),
    );
  }

  /// 反查该货码的AGV搬运链路：服务器（队列+任务沉淀）查询，失败静默返回空
  Future<Map> _fetchAgvChain(ScanRecord r) async {
    final code = r.goodsCode.toUpperCase();
    final server = await AuthStore.serverUrl();
    final tk = await AuthStore.token();
    if (server.isEmpty || tk.isEmpty) return {};
    try {
      final resp = await http.get(Uri.parse("$server/api/agv/taskOf?c=$code"),
          headers: {
            "Authorization": "Bearer $tk"
          }).timeout(const Duration(seconds: 6));
      final j = jsonDecode(utf8.decode(resp.bodyBytes));
      if (j is Map && j["ok"] == true && j["task"] is Map) {
        final t = j["task"] as Map;
        final carId = t["car"];
        return {
          "sp": t["sp"] ?? "?",
          "ep": t["ep"] ?? "?",
          "car": carId is num
              ? "AGV${carId.toInt().toString().padLeft(2, "0")}"
              : "",
          "state": t["stateText"] ?? "",
          "tl": t["tl"] ?? "",
          "chain": j["chain"] is Map
              ? Map.of(j["chain"] as Map)
              : const <String, dynamic>{}
        };
      }
    } catch (_) {}
    return {};
  }

  Widget _detailItem(String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
              width: 90,
              child: Text("$label：",
                  style: TextStyle(fontWeight: FontWeight.w500, fontSize: 16))),
          Expanded(child: Text(value, style: TextStyle(fontSize: 16))),
        ],
      ),
    );
  }
}

// ===================== 设置菜单主页 =====================
bool get _isWhRole =>
    Auth.user?.role == 'warehouse' ||
    Auth.user?.role == 'admin'; // 设置页系统配置类条目仅仓管/管理员可见

class SettingsMenuPage extends StatelessWidget {
  final Future<void> Function()? onWifi;
  const SettingsMenuPage({super.key, this.onWifi});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("设置"),
        backgroundColor: const Color(0xFF515BD4),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const SysStatusCard(),
          if (_isWhRole && onWifi != null)
            _settingTile(context,
                icon: Icons.phone_android_outlined,
                color: Colors.deepOrange,
                title: "WiFi局域网服务",
                subtitle: "开启后电脑浏览器下载采集CSV",
                onTap: () => onWifi!()),
          const Divider(height: 24),
          _settingTile(
            context,
            icon: Icons.person_outline,
            color: const Color(0xFF515BD4),
            title: "账号与权限",
            subtitle: "改名 / 改密 / 我的登录设备 / 用户与功能管理 / 退出登录",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const AccountPage())),
          ),
          _settingTile(
            context,
            icon: Icons.text_fields,
            color: const Color(0xFF7E57C2),
            title: "显示与扫码偏好",
            subtitle: "字号档位 / 自动聚焦 / 默认框型 / 领料默认值（存服务器换设备跟随）",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const DisplayPrefsPage())),
          ),
          _settingTile(
            context,
            icon: Icons.dashboard_customize_outlined,
            color: const Color(0xFF00897B),
            title: "首页模块自定义",
            subtitle: "页签排序 / 隐藏 / 按使用习惯自动排（存服务器换设备跟随）",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const TabCustomPage())),
          ),
          if (Auth.can("location_reg"))
            _settingTile(
              context,
              icon: Icons.shelves,
              color: Colors.teal,
              title: "位置登记",
              subtitle: "上架 / 移库 / 拣下 / 导入WPS货架账本",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const LocationRegPage())),
            )
          else
            _settingTile(
              context,
              icon: Icons.cloud_download,
              color: Colors.teal,
              title: "拉取货位账本",
              subtitle: "从电脑服务器合并最新账本（库存/领料选件用）",
              onTap: () async {
                final r = await ledgerPullMerge(force: true); // ㉖ 手动入口强制拉，不受20秒节流跳过
                if (!context.mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                    content: Text(r["ok"] == true
                        ? "账本已合并：新增 ${r["added"]} · 更新 ${r["updated"]} · 删除 ${r["deleted"]}（共 ${r["total"]} 条）"
                        : "拉取失败：${r["msg"]}"),
                    backgroundColor:
                        r["ok"] == true ? Colors.green : Colors.red));
              },
            ),
          if (_isWhRole)
            _settingTile(
              context,
              icon: Icons.dns_outlined,
              color: const Color(0xFF3F51B5),
              title: "MES服务器设置",
              subtitle: "服务地址 / 账号登录 / 退出登录",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const MesSettingPage())),
            ),
          _settingTile(
            context,
            icon: Icons.dashboard_outlined,
            color: const Color(0xFF5C6BC0),
            title: "控制台驾驶舱",
            subtitle: "站台看板 / 零件档案 / 流水追溯 / 导出 / 设备异常（内嵌网页全功能）",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const ConsoleWebPage())),
          ),
          if (_isWhRole)
            _settingTile(
              context,
              icon: Icons.local_shipping_outlined,
              color: const Color(0xFF00897B),
              title: "WMAS(AGV)设置",
              subtitle: "调度服务地址 / 一键建任务账号",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const WmasSettingPage())),
            ),
          if (_isWhRole)
            _settingTile(
              context,
              icon: Icons.smart_toy_outlined,
              color: const Color(0xFF37474F),
              title: "AGV调度系统(哈工库讯)",
              subtitle: "登录账号 / 实时大屏地址（AGV模块数据源）",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const AgvSettingPage())),
            ),
          if (Auth.can("agv_monitor"))
            _settingTile(
              context,
              icon: Icons.insights_outlined,
              color: const Color(0xFF3949AB),
              title: "数据驾驶舱",
              subtitle: "今日出入库/AGV/站台 实时KPI与7日趋势",
              onTap: () => Navigator.push(
                  context, MaterialPageRoute(builder: (_) => const DashPage())),
            ),
          if (Auth.can("agv_monitor"))
            _settingTile(
              context,
              icon: Icons.speed_outlined,
              color: const Color(0xFF283593),
              title: "AGV效率报表",
              subtitle: "各车任务量/平均耗时/7×24搬运热力",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const AgvReportPage())),
            ),
          if (Auth.can("agv_monitor"))
            _settingTile(
              context,
              icon: Icons.grid_view_outlined,
              color: const Color(0xFF00897B),
              title: "货位占用图",
              subtitle: "AGV货架/地面库位 实时在库热力视图",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const LocMapPage())),
            ),
          if (_isWhRole)
            _settingTile(
              context,
              icon: Icons.monitor_heart_outlined,
              color: const Color(0xFF455A64),
              title: "设备诊断",
              subtitle: "数据库/网络/权限自查 · 异常日志导出",
              onTap: () => Navigator.push(
                  context, MaterialPageRoute(builder: (_) => const DiagPage())),
            ),
          _settingTile(
            context,
            icon: Icons.volume_up_outlined,
            color: Colors.teal,
            title: "通知与语音",
            subtitle: "系统通知/悬浮横幅/自定义铃声/扫码语音播报(离线包可下载)",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const SoundVibrationPage())),
          ),
          if (_isWhRole)
            _settingTile(
              context,
              icon: Icons.fact_check_outlined,
              color: const Color(0xFF6D4C41),
              title: "操作审计日志",
              subtitle: "关键操作流水 / 一键导出排查",
              onTap: () => Navigator.push(context,
                  MaterialPageRoute(builder: (_) => const AuditLogPage())),
            ),
          _settingTile(
            context,
            icon: Icons.system_update_alt,
            color: const Color(0xFF00897B),
            title: "检查更新",
            subtitle:
                "当前 v${AppUpdater.localVersion}+${AppUpdater.localBuild} · 手动查询服务器新版本",
            onTap: () => AppUpdater.checkAtLaunch(manual: true),
          ),
        ],
      ),
    );
  }

  Widget _settingTile(BuildContext context,
      {required IconData icon,
      required Color color,
      required String title,
      required String subtitle,
      required VoidCallback onTap}) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: ListTile(
        leading: CircleAvatar(
            backgroundColor: color.withOpacity(0.12),
            child: Icon(icon, color: color)),
        title: Text(title,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
        subtitle: Text(subtitle,
            style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
        trailing: const Icon(Icons.chevron_right, color: Colors.grey),
        onTap: onTap,
      ),
    );
  }
}

// ===================== 声音和震动设置页 =====================
class SoundVibrationPage extends StatefulWidget {
  const SoundVibrationPage({super.key});
  @override
  State<SoundVibrationPage> createState() => _SoundVibrationPageState();
}

class _SoundVibrationPageState extends State<SoundVibrationPage> {
  bool _sound = true;
  bool _vibration = true;
  bool _voice = true;
  // ㉖v53 三档：2=弹横幅+声音 1=静默进中心 0=关闭（默认值在 _load 按 RemindPrefs 兜底）
  int _nNew = 2,
      _nUrge = 2,
      _nArrive = 2,
      _nResult = 1,
      _nWatch = 1,
      _nStock = 2,
      _nCar = 2,
      _nInsp = 2;
  double _rate = 0.55;
  bool _loaded = false;
  bool _notifGranted = false;
  bool? _ttsOk;

  @override
  void initState() {
    super.initState();
    _load();
    PrefsSync.changed.addListener(_load); // ㉖B14 服务器回写后刷新开关状态
  }

  final ValueNotifier<double> _vpProg = ValueNotifier<double>(-1);
  @override
  void dispose() {
    PrefsSync.changed.removeListener(_load);
    _vpProg.dispose();
    super.dispose();
  }

  Future<void> _voicePackAction() async {
    final installed = await VoicePack.installed();
    if (!mounted) return;
    if (installed) {
      final dis = await VoicePack.disabled();
      if (!mounted) return;
      if (dis) {
        final yes = await showDialog<bool>(
            context: context,
            builder: (c2) => AlertDialog(
                  title: const Text("离线引擎已停用（崩溃保护）",
                      style: TextStyle(color: Colors.orange)),
                  content: const Text(
                      "上次在语音合成时异常退出，已自动降级为数字拼播。\n\n如确认是偶发问题可重新启用；再次崩溃会再次自动停用。"),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(c2, false),
                        child: const Text("保持停用")),
                    FilledButton(
                        onPressed: () => Navigator.pop(c2, true),
                        child: const Text("重新启用"))
                  ],
                ));
        if (yes == true) {
          await VoicePack.setDisabled(false);
          if (mounted) setState(() {});
        }
        return;
      }
      final yes = await showDialog<bool>(
          context: context,
          builder: (c2) => AlertDialog(
                title: const Text("离线语音包已安装"),
                content: const Text("约64MB模型在本地，无系统TTS时自动启用。删除后回落数字拼播。"),
                actions: [
                  TextButton(
                      onPressed: () => Navigator.pop(c2, false),
                      child: const Text("关闭")),
                  TextButton(
                      onPressed: () => Navigator.pop(c2, true),
                      child:
                          const Text("删除", style: TextStyle(color: Colors.red)))
                ],
              ));
      if (yes == true) {
        await VoicePack.remove();
        if (mounted) setState(() {});
      }
      return;
    }
    final yes = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
              title: const Text("下载离线语音包？"),
              content: const Text(
                  "从局域网服务器下载约64MB中文语音模型（仅一次，不耗外网流量）。下载中可继续使用，完成后无系统TTS的设备扫码播报自动升级为真人音色。"),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(c2, false),
                    child: const Text("取消")),
                FilledButton(
                    onPressed: () => Navigator.pop(c2, true),
                    child: const Text("下载"))
              ],
            ));
    if (yes != true || !mounted) return;
    _vpProg.value = 0;
    final r = await VoicePack.download((p) => _vpProg.value = p);
    _vpProg.value = -1;
    if (!mounted) return;
    setState(() {});
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(r["ok"] == true
            ? '语音包已安装，点「试听语音播报」验证'
            : '下载失败：' + (r["msg"] ?? "").toString()),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.red));
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    setState(() {
      _sound = sp.getBool(AppSettings.keySound) ?? true;
      _vibration = sp.getBool(AppSettings.keyVibration) ?? true;
      _voice = sp.getBool(RemindPrefs.kVoice) ?? true;
      _nNew = RemindPrefs.levelOfSp(sp, RemindPrefs.kNew);
      _nUrge = RemindPrefs.levelOfSp(sp, RemindPrefs.kUrge);
      _nArrive = RemindPrefs.levelOfSp(sp, RemindPrefs.kArrive);
      _nResult = RemindPrefs.levelOfSp(sp, RemindPrefs.kResult);
      _nWatch = RemindPrefs.levelOfSp(sp, RemindPrefs.kWatch);
      _nStock = RemindPrefs.levelOfSp(sp, RemindPrefs.kStock);
      _nCar = RemindPrefs.levelOfSp(sp, RemindPrefs.kCar);
      _nInsp = RemindPrefs.levelOfSp(sp, RemindPrefs.kInsp);
      _rate = sp.getDouble('remind_speech_rate') ?? 0.55;
      _loaded = true;
    });
    _notifGranted = await NotifyService.notificationsEnabled();
    _ttsOk = await NotifyService.ttsAvailable();
    if (mounted) setState(() {});
  }

  // ㉖v53 三档分级保存：2弹横幅 1静默进中心 0关闭（同步界面绑定字段防弹回）
  Future<void> _setLv(String key, int v) async {
    await RemindPrefs.setLevelKey(key, v);
    PrefsSync.pushAll();
    setState(() {
      if (key == RemindPrefs.kNew)
        _nNew = v;
      else if (key == RemindPrefs.kUrge)
        _nUrge = v;
      else if (key == RemindPrefs.kArrive)
        _nArrive = v;
      else if (key == RemindPrefs.kResult)
        _nResult = v;
      else if (key == RemindPrefs.kWatch)
        _nWatch = v;
      else if (key == RemindPrefs.kStock)
        _nStock = v;
      else if (key == RemindPrefs.kCar)
        _nCar = v;
      else if (key == RemindPrefs.kInsp)
        _nInsp = v;
    });
  }

  Future<void> _setKey(String key, bool v) async {
    await RemindPrefs.setEnabled(key, v);
    PrefsSync.pushAll(); // ㉖B14 提醒订阅/语音开关上云（fire-and-forget）
    setState(() {
      // 同步界面绑定字段：否则Switch读旧值弹回，表现为关不掉
      if (key == RemindPrefs.kVoice) _voice = v;
    });
  }

  // ㉖v53 三档选择器：一行类别 + 三个档位 chip（弹横幅/静默/关闭）
  Widget _lvChip(int cur, int v, String label, String key) => Expanded(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 3),
          child: ChoiceChip(
            padding: const EdgeInsets.symmetric(vertical: 7),
            label: Text(label,
                textAlign: TextAlign.center,
                style: TextStyle(
                    fontSize: 12.5,
                    fontWeight: cur == v ? FontWeight.w600 : FontWeight.normal,
                    color: cur == v ? Colors.white : Colors.blueGrey)),
            selected: cur == v,
            showCheckmark: false,
            selectedColor:
                v == 2 ? const Color(0xFF515BD4) : v == 1 ? const Color(0xFF78909C) : const Color(0xFF90A4AE),
            backgroundColor: const Color(0xFFF0F2F7),
            onSelected: (_) => _setLv(key, v),
          ),
        ),
      );
  Widget _lvCard(String key, int val, String title, String sub, {bool allowOff = true}) => Card(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(sub, style: const TextStyle(fontSize: 12, color: Colors.grey)),
              const SizedBox(height: 8),
              Row(children: [
                _lvChip(val, 2, "弹横幅", key),
                _lvChip(val, 1, "静默", key),
                if (allowOff) _lvChip(val, 0, "关闭", key),
              ]),
            ],
          ),
        ),
      );

  Future<void> _askNotifPerm() async {
    final ok = await NotifyService.ensurePermission();
    if (!mounted) return;
    setState(() => _notifGranted = ok);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text(ok ? "通知权限已开启" : "未获得通知权限：请到系统设置→应用→通知里手动开启"),
        backgroundColor: ok ? Colors.green : Colors.orange));
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded)
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return Scaffold(
      appBar: AppBar(
        title: const Text("通知与提醒"),
        backgroundColor: const Color(0xFF515BD4),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            color: _notifGranted ? null : const Color(0xFFFFF3E0),
            child: ListTile(
              leading: Icon(Icons.notifications_active,
                  color: _notifGranted ? Colors.green : Colors.orange),
              title: Text(_notifGranted ? "系统通知已开启" : "系统通知未开启",
                  style: const TextStyle(
                      fontSize: 15, fontWeight: FontWeight.w600)),
              subtitle: Text(
                  _notifGranted
                      ? "待接单/催单/到站提醒将以悬浮横幅+锁屏通知送达，铃声为闹钟音量"
                      : "息屏/后台收不到提醒，点此去授权",
                  style: const TextStyle(fontSize: 12)),
              trailing: _notifGranted ? null : const Icon(Icons.chevron_right),
              onTap: _notifGranted ? null : _askNotifPerm,
            ),
          ),
          const SizedBox(height: 8),
          const Padding(
              padding: EdgeInsets.fromLTRB(4, 8, 4, 6),
              child: Text("提醒类别 · 三档分级（弹横幅=悬浮+铃声打扰｜静默=只进消息中心亮角标不打扰｜关闭=不接收）",
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                      color: Colors.blueGrey))),
          _lvCard(RemindPrefs.kNew, _nNew, "待接单提醒", "新领料单/超时放开/转派给你"),
          _lvCard(RemindPrefs.kUrge, _nUrge, "催单提醒", "领料员催接单/催备料"),
          _lvCard(RemindPrefs.kArrive, _nArrive, "到站催扫提醒", "货架到站台超时未扫码发料"),
          _lvCard(RemindPrefs.kResult, _nResult, "结果动态提醒", "接单/备齐/签收/驳回/取消/归位闭环"),
          _lvCard(RemindPrefs.kWatch, _nWatch, "预约到料提醒", "关注的零件入库时通知（库存页·我的预约）"),
          _lvCard(RemindPrefs.kStock, _nStock, "断料预警提醒", "零件在架清零时通知仓管与相关物料员"),
          _lvCard(RemindPrefs.kCar, _nCar, "车辆告警提醒", "AGV急停/通讯断开/故障/低电，恢复时复位（安全底线：最低静默，不可关）", allowOff: false),
          _lvCard(RemindPrefs.kInsp, _nInsp, "检验协助提醒", "检验员发单/出结论请求协助、超时催办"),
          const SizedBox(height: 8),
          const Padding(
              padding: EdgeInsets.fromLTRB(4, 8, 4, 6),
              child: Text("扫码反馈",
                  style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.bold,
                      color: Colors.blueGrey))),
          Card(
            color: _ttsOk == false ? const Color(0xFFFFF3E0) : null,
            child: SwitchListTile(
              value: _voice,
              activeColor: const Color(0xFF00897B),
              title:
                  const Text("语音播报（零件号后四位+件数）", style: TextStyle(fontSize: 15)),
              subtitle: Text(
                  _ttsOk == false
                      ? "⚠️本机未检测到TTS引擎，将回退提示音"
                      : "例：扫 6608453824 → 播报「3824，25件」",
                  style: const TextStyle(fontSize: 12)),
              onChanged: (v) async {
                await _setKey(RemindPrefs.kVoice, v);
                if (v) await NotifyService.speak("测试播报");
              },
            ),
          ),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 4),
              child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                        "播报语速：${_rate < 0.45 ? "慢" : _rate > 0.65 ? "快" : "中"}",
                        style: const TextStyle(fontSize: 14)),
                    Slider(
                      value: _rate,
                      min: 0.3,
                      max: 0.9,
                      activeColor: const Color(0xFF00897B),
                      onChanged: (v) => setState(() => _rate = v),
                      onChangeEnd: (v) async {
                        await RemindPrefs.setRate(v);
                        PrefsSync.pushAll(); // ㉖B14 语速上云
                        await NotifyService.speak("3824，25件");
                      },
                    ),
                  ]),
            ),
          ),
          Card(
              child: SwitchListTile(
                  value: _sound,
                  activeColor: const Color(0xFF515BD4),
                  title:
                      const Text("提示音（无语音时兜底）", style: TextStyle(fontSize: 15)),
                  subtitle: const Text("语音播报关闭或不可用时，扫码成功播放",
                      style: TextStyle(fontSize: 12)),
                  onChanged: (v) async {
                    await AppSettings.setSoundEnabled(v);
                    setState(() => _sound = v);
                  })),
          Card(
              child: SwitchListTile(
                  value: _vibration,
                  activeColor: const Color(0xFF515BD4),
                  title: const Text("扫码成功震动", style: TextStyle(fontSize: 15)),
                  onChanged: (v) async {
                    await AppSettings.setVibrationEnabled(v);
                    setState(() => _vibration = v);
                    if (v) {
                      try {
                        if ((await Vibration.hasVibrator()) ?? false)
                          await Vibration.vibrate(duration: 120);
                      } catch (_) {}
                    }
                  })),
          const SizedBox(height: 16),
          ElevatedButton.icon(
            style: ElevatedButton.styleFrom(
                backgroundColor: const Color(0xFF515BD4),
                foregroundColor: Colors.white,
                minimumSize: const Size(double.infinity, 48)),
            onPressed: () async {
              await NotifyService.test();
              if (!mounted) return;
              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                  content: Text("已发测试通知：看横幅与听铃声（息屏测试请先锁屏再等30秒轮询）"),
                  backgroundColor: Colors.green));
            },
            icon: const Icon(Icons.volume_up),
            label: const Text("发送测试通知（验证铃声/横幅/锁屏）"),
          ),
          const SizedBox(height: 10),
          Card(
              child: ListTile(
                  dense: true,
                  leading: const Icon(Icons.cloud_download_outlined,
                      color: Color(0xFF3949AB)),
                  title: const Text('离线语音包（无系统TTS设备可选）',
                      style: TextStyle(fontSize: 14)),
                  subtitle: FutureBuilder<String>(
                      future: NotifyService.engineLabel(),
                      builder: (cc, ss) => Text(
                          ss.hasData ? '当前播报引擎：' + ss.data! : '检测中…',
                          style: const TextStyle(fontSize: 11.5))),
                  trailing: ValueListenableBuilder<double>(
                      valueListenable: _vpProg,
                      builder: (cc, v, __) => v >= 0 && v < 100
                          ? SizedBox(
                              width: 60,
                              child: LinearProgressIndicator(
                                  value: v / 100, minHeight: 6))
                          : const Icon(Icons.chevron_right)),
                  onTap: _voicePackAction)),
          const SizedBox(height: 10),
          ElevatedButton.icon(
            style: ElevatedButton.styleFrom(
                backgroundColor: Colors.grey.shade200,
                foregroundColor: Colors.black87,
                minimumSize: const Size(double.infinity, 48)),
            onPressed: () => NotifyService.speak("3824，25件"),
            icon: const Icon(Icons.record_voice_over),
            label: const Text("试听语音播报"),
          ),
          const SizedBox(height: 8),
          const Text(
              "提醒铃声：把任意 wav 命名为 reminder.wav 放到 APK 的 res/raw/reminder 即为自定义铃声（当前用占位音，可联系管理员替换）。",
              style: TextStyle(fontSize: 11, color: Colors.grey)),
        ],
      ),
    );
  }
}

// ===================== ㉑ 消息中枢：分组卡片流（仿系统信息App会话列表） =====================
// ===================== ㉖ 消息中枢（会话式两级：一级分类列表·二级明细，看过红点消失） =====================
const _kHubGroups = <Map<String, dynamic>>[
  {
    "key": "work",
    "name": "派单与超时",
    "types": ["req_new", "req_timeout", "req_reassign"],
    "icon": Icons.assignment_add,
    "color": Color(0xFF515BD4)
  },
  {
    "key": "urge",
    "name": "催单",
    "types": ["req_urge"],
    "icon": Icons.alarm,
    "color": Color(0xFFE65100)
  },
  {
    "key": "flow",
    "name": "接单与进度",
    "types": [
      "req_accept",
      "req_ready",
      "req_ready_wh",
      "req_done",
      "req_confirm",
      "req_reject",
      "req_cancel",
      "req_flow"
    ],
    "icon": Icons.local_shipping,
    "color": Color(0xFF00897B)
  },
  {
    "key": "arrive",
    "name": "到站与移库",
    "types": ["req_arrive", "transfer_done"],
    "icon": Icons.inbox,
    "color": Color(0xFFFF8F00)
  },
  {
    "key": "car",
    "name": "车辆告警",
    "types": ["car_alarm"],
    "icon": Icons.error,
    "color": Color(0xFFD32F2F)
  },
  {
    "key": "insp",
    "name": "检验协助",
    "types": ["inspect"],
    "icon": Icons.fact_check_outlined,
    "color": Color(0xFF7B1FA2)
  },
  {
    "key": "stock",
    "name": "断料与预约",
    "types": ["stock_out", "watch_in"],
    "icon": Icons.inventory_2,
    "color": Color(0xFF546E7A)
  },
  {
    "key": "other",
    "name": "其他与系统",
    "types": [],
    "icon": Icons.notifications_none,
    "color": Color(0xFF9E9E9E)
  },
];
const _kHubKnown = {
  "req_new",
  "req_timeout",
  "req_reassign",
  "req_urge",
  "req_accept",
  "req_ready",
  "req_ready_wh",
  "req_done",
  "req_confirm",
  "req_reject",
  "req_cancel",
  "req_flow",
  "req_arrive",
  "transfer_done",
  "car_alarm",
  "stock_out",
  "watch_in",
};

class MessageHubPage extends StatefulWidget {
  final VoidCallback onOpenReq;
  final VoidCallback? onOpenAgv; // ㉖v50 车辆告警一键直达 AGV 看板
  const MessageHubPage({super.key, required this.onOpenReq, this.onOpenAgv});
  @override
  State<MessageHubPage> createState() => _MessageHubPageState();
}

class _MessageHubPageState extends State<MessageHubPage> {
  List<Map> _msgs = [];
  bool _loading = true;
  String _err = "";

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (mounted)
      setState(() {
        _loading = true;
        _err = "";
      });
    final r = await AuthApi.notificationsHistory(limit: 100);
    if (!mounted) return;
    if (r["ok"] == true) {
      final list = List<Map>.from(r["notifications"] ?? []);
      list.sort((a, b) =>
          (b["time"] ?? "").toString().compareTo((a["time"] ?? "").toString()));
      setState(() {
        _msgs = list;
        _loading = false;
      });
    } else {
      setState(() {
        _loading = false;
        _err = (r["msg"] ?? "加载失败").toString();
      });
    }
  }

  List<Map> _of(Map g) {
    final ts = List<String>.from(g["types"] ?? []);
    return _msgs.where((m) {
      final tp = m["type"]?.toString() ?? "";
      return ts.isEmpty ? !_kHubKnown.contains(tp) : ts.contains(tp);
    }).toList();
  }

  int _tsOf(Map m) =>
      DateTime.tryParse(m["time"]?.toString() ?? "")?.millisecondsSinceEpoch ??
      0;

  /// ㉖v50 未处理车辆告警：急停/红牌/升级且尚无"恢复/已认领"跟进 → 置顶提醒
  bool _carUnresolved(Map m) {
    if ((m["type"]?.toString() ?? "") != "car_alarm") return false;
    final t = m["text"]?.toString() ?? "";
    if (t.startsWith("✅") || t.contains("已恢复") || t.contains("已认领")) {
      return false;
    }
    final mt = RegExp(r'AGV(\d+)').firstMatch(t)?.group(1);
    for (final x in _msgs) {
      if ((x["type"]?.toString() ?? "") != 'car_alarm') continue;
      final xt = x["text"]?.toString() ?? '';
      if (!(xt.startsWith('✅') || xt.contains('已恢复') || xt.contains('已认领'))) {
        continue;
      }
      if (mt == null || mt.isEmpty || xt.contains('AGV$mt')) {
        if (_tsOf(x) > _tsOf(m)) return false;
      }
    }
    return true;
  }

  String _rel(String t) {
    final d = DateTime.tryParse(t);
    if (d == null) return "";
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return "刚刚";
    if (diff.inMinutes < 60) return "${diff.inMinutes}分钟前";
    if (diff.inHours < 24) return "${diff.inHours}小时前";
    if (diff.inDays < 2) return "昨天";
    if (diff.inDays < 8) return "${diff.inDays}天前";
    return "${d.month}月${d.day}日";
  }

  void _openGroup(Map g) async {
    final ms = _of(g);
    await Navigator.push(
        context,
        MaterialPageRoute(
            builder: (_) => _HubThreadPage(
                title: g["name"] as String,
                icon: g["icon"] as IconData,
                color: g["color"] as Color,
                msgs: ms,
                onJumpReq: () {
                  Navigator.of(context).pop();
                  widget.onOpenReq();
                })));
    final ts = List<String>.from(g["types"] ?? []);
    if (ts.isNotEmpty) unawaited(AuthApi.notificationsReadGroup(ts));
    if (mounted) _load();
  }

  Future<void> _readAll() async {
    await AuthApi.notificationsReadAll();
    if (mounted) _load();
  }

  /// ㉖v50 未处理车辆告警置顶卡：不管下面堆了多少普通消息，急停/红牌永远第一屏可见
  Widget _hubCarAlert(List<Map> alerts, VoidCallback onTap) {
    final oldest = alerts
        .map(_tsOf)
        .reduce((a, b) => a < b ? a : b);
    final waitMin =
        ((DateTime.now().millisecondsSinceEpoch - oldest) / 60000).floor();
    final waitTxt = waitMin < 1
        ? '刚刚'
        : waitMin < 60
            ? '已等 ${waitMin} 分钟'
            : '已等 ${(waitMin / 60).floor()} 小时';
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      color: const Color(0xFFFFEBEE),
      shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: Color(0xFFD32F2F), width: 1.4)),
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(children: [
                const Icon(Icons.error, color: Color(0xFFD32F2F), size: 20),
                const SizedBox(width: 6),
                const Text("未处理车辆告警",
                    style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFFB71C1C))),
                const SizedBox(width: 8),
                Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 7, vertical: 1),
                    decoration: BoxDecoration(
                        color: const Color(0xFFD32F2F),
                        borderRadius: BorderRadius.circular(9)),
                    child: Text("${alerts.length} 条 · $waitTxt",
                        style: const TextStyle(
                            fontSize: 10.5, color: Colors.white))),
                const Spacer(),
                const Icon(Icons.chevron_right,
                    size: 18, color: Color(0xFFD32F2F)),
              ]),
              for (final m in alerts.take(3))
                Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Text(m["text"]?.toString() ?? "",
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                          fontSize: 12.5, color: Color(0xFF7f1d1d))),
                ),
              if (alerts.length > 3)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text("…另有 ${alerts.length - 3} 条，点此查看全部",
                      style: const TextStyle(
                          fontSize: 11, color: Color(0xFF9a3412))),
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final totalUnread =
        _msgs.where((m) => m["read"] != true).length;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
          title: Row(mainAxisSize: MainAxisSize.min, children: [
            const Text("消息",
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold)),
            if (totalUnread > 0)
              Container(
                  margin: const EdgeInsets.only(left: 8),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                  decoration: BoxDecoration(
                      color: Colors.redAccent,
                      borderRadius: BorderRadius.circular(10)),
                  child: Text("$totalUnread 未读",
                      style:
                          const TextStyle(fontSize: 11, color: Colors.white))),
          ]),
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white,
          actions: [
            if (totalUnread > 0)
              TextButton(
                  onPressed: _readAll,
                  child: const Text("清未读",
                      style: TextStyle(color: Colors.white, fontSize: 13))),
            IconButton(
                tooltip: "刷新",
                icon: const Icon(Icons.refresh),
                onPressed: _load)
          ]),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _err.isNotEmpty
              ? Center(
                  child: Text(_err, style: const TextStyle(color: Colors.red)))
              : _msgs.isEmpty
                  ? const Center(
                      child: Text("暂无消息", style: TextStyle(color: Colors.grey)))
                  : ListView(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      children: [
                          // ㉖v50 未处理车辆告警永远置顶：再多的普通消息也不许淹没它
                          if (_of(_kHubGroups[4]).any(_carUnresolved))
                            _hubCarAlert(
                                _of(_kHubGroups[4])
                                    .where(_carUnresolved)
                                    .toList(),
                                _openCarAlarm),
                          for (final g in _kHubGroups)
                            if (_of(g).isNotEmpty)
                              Builder(builder: (_) {
                                final ms = _of(g);
                                final key = g["key"] as String;
                                final color = g["color"] as Color;
                                final un =
                                    ms.where((m) => m["read"] != true).length;
                                final latest = ms.first;
                                return Card(
                                  margin: const EdgeInsets.symmetric(
                                      horizontal: 10, vertical: 4),
                                  child: ListTile(
                                    onTap: () => _openGroup(g),
                                    leading: Stack(
                                        clipBehavior: Clip.none,
                                        children: [
                                          CircleAvatar(
                                              backgroundColor:
                                                  color.withOpacity(0.12),
                                              child: Icon(g["icon"] as IconData,
                                                  size: 21, color: color)),
                                          if (un > 0)
                                            Positioned(
                                                right: -4,
                                                top: -4,
                                                child: Container(
                                                    padding: const EdgeInsets
                                                        .symmetric(
                                                        horizontal: 5,
                                                        vertical: 1),
                                                    decoration: BoxDecoration(
                                                        color: Colors.red,
                                                        borderRadius:
                                                            BorderRadius
                                                                .circular(9)),
                                                    child: Text("$un",
                                                        style: const TextStyle(
                                                            fontSize: 10,
                                                            color: Colors.white,
                                                            fontWeight:
                                                                FontWeight
                                                                    .bold)))),
                                        ]),
                                    title: Row(children: [
                                      Text(g["name"] as String,
                                          style: TextStyle(
                                              fontSize: 14.5,
                                              fontWeight: un > 0
                                                  ? FontWeight.bold
                                                  : FontWeight.w500,
                                              color: un > 0
                                                  ? Colors.black87
                                                  : Colors.black54)),
                                      const SizedBox(width: 6),
                                      Text("(${ms.length})",
                                          style: const TextStyle(
                                              fontSize: 12,
                                              color: Colors.grey)),
                                    ]),
                                    subtitle: Text(
                                        latest["text"]?.toString() ?? "",
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                            fontSize: 12,
                                            color: un > 0
                                                ? Colors.blueGrey.shade700
                                                : Colors.blueGrey)),
                                    trailing: Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Text(
                                              _rel(latest["time"]?.toString() ??
                                                  ""),
                                              style: const TextStyle(
                                                  fontSize: 11,
                                                  color: Colors.grey)),
                                          const Icon(Icons.chevron_right,
                                              size: 18, color: Colors.grey),
                                        ]),
                                  ),
                                );
                              }),
                          const SizedBox(height: 6),
                          const Center(
                              child: Text(
                                  "急停/红牌等未处理车辆告警自动置顶；进入分类看过或点右上「清未读」，红点即消失",
                                  style: TextStyle(
                                      fontSize: 11, color: Colors.grey))),
                        ]),
    );
  }

  void _openCarAlarm() {
    Navigator.of(context).pop();
    (widget.onOpenAgv ?? widget.onOpenReq)(); // 与系统通知点击同路由：car_alarm→agv
  }
}

class _HubThreadPage extends StatelessWidget {
  final String title;
  final IconData icon;
  final Color color;
  final List<Map> msgs;
  final VoidCallback onJumpReq;
  const _HubThreadPage(
      {required this.title,
      required this.icon,
      required this.color,
      required this.msgs,
      required this.onJumpReq});

  String _rel(String t) {
    final d = DateTime.tryParse(t);
    if (d == null) return "";
    final diff = DateTime.now().difference(d);
    if (diff.inMinutes < 1) return "刚刚";
    if (diff.inMinutes < 60) return "${diff.inMinutes}分钟前";
    if (diff.inHours < 24) return "${diff.inHours}小时前";
    if (diff.inDays < 2) return "昨天";
    if (diff.inDays < 8) return "${diff.inDays}天前";
    return "${d.month}月${d.day}日 ${d.hour.toString().padLeft(2, "0")}:${d.minute.toString().padLeft(2, "0")}";
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7FA),
      appBar: AppBar(
          title: Text("$title（${msgs.length}）",
              style:
                  const TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          backgroundColor: const Color(0xFF515BD4),
          foregroundColor: Colors.white),
      body: msgs.isEmpty
          ? const Center(
              child: Text("该分类暂无消息", style: TextStyle(color: Colors.grey)))
          : ListView(
              padding: const EdgeInsets.symmetric(vertical: 8),
              children: [
                  for (final m in msgs)
                    Card(
                        margin: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        child: ListTile(
                          leading: CircleAvatar(
                              radius: 16,
                              backgroundColor: color.withOpacity(0.12),
                              child: Icon(icon, size: 17, color: color)),
                          title: Text(m["text"]?.toString() ?? "",
                              style:
                                  const TextStyle(fontSize: 13, height: 1.35)),
                          subtitle: Padding(
                              padding: const EdgeInsets.only(top: 3),
                              child: Text(_rel(m["time"]?.toString() ?? ""),
                                  style: const TextStyle(
                                      fontSize: 11, color: Colors.grey))),
                          trailing: (m["reqId"]?.toString() ?? "").isNotEmpty
                              ? const Icon(Icons.chevron_right,
                                  size: 20, color: Color(0xFF515BD4))
                              : null,
                          onTap: (m["reqId"]?.toString() ?? "").isEmpty
                              ? null
                              : onJumpReq,
                        )),
                ]),
    );
  }
}

class MesSettingPage extends StatefulWidget {
  const MesSettingPage({super.key});

  @override
  State<MesSettingPage> createState() => _MesSettingPageState();
}

class _MesSettingPageState extends State<MesSettingPage> {
  final TextEditingController hostCtrl = TextEditingController();
  final TextEditingController portCtrl = TextEditingController();
  final TextEditingController timeoutCtrl = TextEditingController();
  final TextEditingController accountCtrl = TextEditingController();
  final TextEditingController pwdCtrl = TextEditingController();
  //新增
  final TextEditingController moduleIdCtrl = TextEditingController();
  final TextEditingController orgIdCtrl = TextEditingController();
  bool _pwdVisible = false;
  String? _token;

  @override
  void initState() {
    super.initState();
    _loadConfig();
  }

  Future<void> _loadConfig() async {
    final cfg = await MesConfig.getConfig();
    setState(() {
      hostCtrl.text = cfg["host"];
      portCtrl.text = cfg["port"];
      timeoutCtrl.text = cfg["timeout"].toString();
      accountCtrl.text = cfg["account"];
      pwdCtrl.text = cfg["pwd"];
      //新增
      moduleIdCtrl.text = cfg["moduleId"];
      orgIdCtrl.text = cfg["orgId"];
    });
  }
  // getValidateKey2 / RSA加密 / 三阶段登录 已提取为顶层共用函数（手动登录与静默重登共用）

  // ========== MES登录方法（复用顶层 mesPerformLogin，失败弹窗含诊断详情） ==========
  Future<bool> _testMesLogin() async {
    final int timeoutSec = int.tryParse(timeoutCtrl.text) ?? 10;
    // 先保存表单配置
    await MesConfig.saveConfig(
      host: hostCtrl.text,
      port: portCtrl.text,
      account: accountCtrl.text,
      pwd: pwdCtrl.text,
      token: "",
      timeout: timeoutSec,
      moduleId: moduleIdCtrl.text.trim(),
      orgId: orgIdCtrl.text.trim(),
    );
    try {
      final r = await mesPerformLogin(
        ip: hostCtrl.text.trim(),
        port: portCtrl.text.trim(),
        account: accountCtrl.text.trim(),
        pwd: pwdCtrl.text.trim(),
        timeoutSec: timeoutSec,
      );
      _token = r["token"];
      debugPrint("【阶段3成功】获取token：${r["token"]}");
      await MesConfig.saveLoginInfo(
        token: r["token"]!,
        orgId: r["orgId"]!,
        userId: r["userId"]!,
        userName: r["userName"]!,
        displayName: r["displayName"]!,
        moduleId: r["moduleId"]!,
      );
      await MesConfig.saveConfig(
        host: hostCtrl.text,
        port: portCtrl.text,
        account: accountCtrl.text,
        pwd: pwdCtrl.text,
        token: r["token"]!,
        timeout: timeoutSec,
        moduleId: moduleIdCtrl.text.trim(),
        orgId: orgIdCtrl.text.trim(),
      );
      return true;
    } catch (e) {
      String errMsg = e.toString();
      debugPrint("MES登录异常:$errMsg");
      if (mounted) {
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text("❌ 登录失败"),
            content: SingleChildScrollView(
              child:
                  SelectableText(errMsg, style: const TextStyle(fontSize: 12)),
            ),
            actions: [
              TextButton(
                  onPressed: () => Navigator.pop(ctx), child: const Text("关闭")),
            ],
          ),
        );
      }
      return false;
    }
  }

  @override
  void dispose() {
    hostCtrl.dispose();
    portCtrl.dispose();
    timeoutCtrl.dispose();
    accountCtrl.dispose();
    pwdCtrl.dispose();
    //新增释放
    moduleIdCtrl.dispose();
    orgIdCtrl.dispose();

    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("MES服务器设置"),
        backgroundColor: const Color(0xFF515BD4),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text("通信协议：HTTP", style: TextStyle(fontSize: 16)),
            const SizedBox(height: 8),
            TextField(
              controller: hostCtrl,
              decoration: const InputDecoration(
                labelText: "MES服务地址",
                hintText: "例：172.25.1.141",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: portCtrl,
              decoration: const InputDecoration(
                labelText: "端口号",
                hintText: "例：6689",
                border: OutlineInputBorder(),
              ),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 10),
            TextField(
              controller: timeoutCtrl,
              decoration: const InputDecoration(
                labelText: "请求超时(秒)",
                hintText: "默认10",
                border: OutlineInputBorder(),
              ),
              keyboardType: TextInputType.number,
            ),
            const SizedBox(height: 16),
            const Divider(),
            const Text(
              "MES账号登录",
              style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: accountCtrl,
              decoration: const InputDecoration(
                labelText: "账号",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: pwdCtrl,
              obscureText: !_pwdVisible,
              decoration: InputDecoration(
                labelText: "密码",
                border: const OutlineInputBorder(),
                suffixIcon: IconButton(
                  icon: Icon(
                      _pwdVisible ? Icons.visibility : Icons.visibility_off),
                  onPressed: () => setState(() => _pwdVisible = !_pwdVisible),
                ),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: moduleIdCtrl,
              decoration: const InputDecoration(
                labelText: "ModuleId",
                hintText: "MES接口ModuleId",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: orgIdCtrl,
              decoration: const InputDecoration(
                labelText: "OrgId",
                hintText: "MES接口OrgId",
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.grey.shade600,
                    ),
                    onPressed: () async {
                      // 测试连通性
                      try {
                        final int timeoutSec =
                            int.tryParse(timeoutCtrl.text) ?? 10;
                        final uri = Uri.parse(
                            "http://${hostCtrl.text}:${portCtrl.text}");
                        final client = HttpClient();
                        final req = await client
                            .getUrl(uri)
                            .timeout(Duration(seconds: timeoutSec));
                        final resp = await req.close();
                        if (resp.statusCode >= 200 && resp.statusCode < 300) {
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text("✅ 服务器连通成功")),
                            );
                          }
                        } else {
                          if (mounted) {
                            ScaffoldMessenger.of(context).showSnackBar(
                              const SnackBar(content: Text("⚠️ 服务器可达，但返回异常")),
                            );
                          }
                        }
                      } catch (e) {
                        if (mounted) {
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text("❌ 连接失败：$e")),
                          );
                        }
                      }
                    },
                    child: const Text("测试连通"),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF515BD4),
                    ),
                    onPressed: () async {
                      bool loginOk = await _testMesLogin();
                      if (!mounted) return;
                      if (loginOk) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text("✅ MES登录成功，Token已保存")),
                        );
                      } else {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text("❌ MES登录失败，请检查账号/地址")),
                        );
                      }
                    },
                    child: const Text("登录MES"),
                  ),
                )
              ],
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.blueAccent,
                ),
                onPressed: () async {
                  final int timeoutSec = int.tryParse(timeoutCtrl.text) ?? 10;
                  await MesConfig.saveConfig(
                    host: hostCtrl.text,
                    port: portCtrl.text,
                    account: accountCtrl.text,
                    pwd: pwdCtrl.text,
                    token: "",
                    timeout: timeoutSec,
                    moduleId: moduleIdCtrl.text.trim(),
                    orgId: orgIdCtrl.text.trim(),
                  );
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text("✅ 配置保存成功")),
                    );
                  }
                },
                child: const Text("仅保存配置（不登录）"),
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.red.shade100,
                  foregroundColor: Colors.red,
                ),
                onPressed: () async {
                  final bool? ok = await showDialog<bool>(
                    context: context,
                    builder: (ctx) => AlertDialog(
                      title: const Text("退出登录"),
                      content: const Text("确认退出当前 MES 登录吗？退出后需重新登录才能查询标签信息。"),
                      actions: [
                        TextButton(
                            onPressed: () => Navigator.pop(ctx, false),
                            child: const Text("取消")),
                        TextButton(
                            onPressed: () => Navigator.pop(ctx, true),
                            child: const Text("确认退出")),
                      ],
                    ),
                  );
                  if (ok != true) return;
                  await MesConfig.clearToken();
                  _token = null;
                  if (mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text("✅ 已退出登录，Token已清除")),
                    );
                  }
                },
                child: const Text("退出登录"),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ===================== ㉖ 系统连接状态卡：服务器 / MES / RCS(AGV调度) / WMAS(任务下发) =====================
class SysStatusCard extends StatefulWidget {
  const SysStatusCard({super.key});
  @override
  State<SysStatusCard> createState() => _SysStatusCardState();
}

class _SysStatusCardState extends State<SysStatusCard> {
  bool _busy = false;
  String _srv = "", _mes = "", _rcs = "", _wm = "";
  Color _c(String st) => st.startsWith("✅")
      ? Colors.green
      : (st.startsWith("⚠")
          ? Colors.orange
          : (st.startsWith("❌") ? Colors.red : Colors.grey));

  @override
  void initState() {
    super.initState();
    _probe();
  }

  Future<void> _probe() async {
    setState(() => _busy = true);
    // 服务器 + RCS/WMAS（一次 sysstatus 拿全）
    String srv = "检测中…", rcs = "检测中…", wm = "检测中…";
    try {
      final me = await AuthApi.me();
      srv = me["ok"] == true ? "✅ 已连接（鉴权正常）" : "❌ ${me["msg"] ?? "不可达"}";
    } catch (e) {
      srv = "❌ 不可达";
    }
    try {
      final r = await AuthApi.sysStatus();
      if (r["ok"] == true) {
        final rc = Map.from(r["rcs"] ?? {});
        final wmj = Map.from(r["wmas"] ?? {});
        rcs = rc["cfg"] != true
            ? "⚠ 未配置（任意PDA「AGV调度系统」填账号即同步）"
            : (rc["ok"] == true ? "✅ 在线（轮询中）" : "❌ 已配置但轮询中断（地址不通/账号失效）");
        wm = wmj["cfg"] != true
            ? "⚠ 未配置（检验下架/归位/一键叫车不可用）"
            : (wmj["ok"] == true
                ? "✅ 账号在线，可下发任务"
                : "❌ 登录失败/凭据失效（去「WMAS(AGV)设置」重测）");
      } else {
        rcs = "⚠ 服务器未升级（无状态接口）";
        wm = rcs;
      }
    } catch (_) {
      rcs = "⚠ 查询失败";
      wm = rcs;
    }
    // MES：本机配置 + token 时效
    String mes = "检测中…";
    try {
      final sp = await SharedPreferences.getInstance();
      final host = sp.getString(MesConfig.keyHost) ?? "";
      final tok = sp.getString(MesConfig.keyToken) ?? "";
      if (host.isEmpty) {
        mes = "⚠ 未配置服务地址（去「MES服务器设置」）";
      } else if (tok.isEmpty) {
        mes = "⚠ 已配置未登录（去「MES服务器设置」登录）";
      } else {
        mes = "✅ 已配置并登录（$host）";
      }
    } catch (_) {
      mes = "⚠ 读取失败";
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _srv = srv;
      _mes = mes;
      _rcs = rcs;
      _wm = wm;
    });
  }

  Widget _row(String icon, String name, String st) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [
          SizedBox(
              width: 26,
              child: Text(icon, style: const TextStyle(fontSize: 14))),
          SizedBox(
              width: 62,
              child: Text(name,
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w600))),
          Expanded(
              child: Text(st.isEmpty ? "…" : st,
                  style: TextStyle(fontSize: 12, color: _c(st)))),
        ]),
      );

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Expanded(
                child: Text("系统连接状态",
                    style:
                        TextStyle(fontSize: 15, fontWeight: FontWeight.bold))),
            _busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2))
                : IconButton(
                    icon: const Icon(Icons.refresh, size: 20),
                    tooltip: "重新检测",
                    onPressed: _probe),
          ]),
          _row("🖥", "服务器", _srv),
          _row("🏭", "MES", _mes),
          _row("🤖", "RCS", _rcs),
          _row("🚚", "WMAS", _wm),
          const SizedBox(height: 2),
          const Text(
              "RCS=AGV状态监控（地图/站台/告警）；WMAS=任务下发（检验/叫车/移库）。RCS/WMAS 凭据在任意 PDA 配置一次即全端共享。",
              style: TextStyle(fontSize: 10.5, color: Colors.blueGrey)),
        ]),
      ),
    );
  }
}
