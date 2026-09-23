import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:isar/isar.dart';
import 'package:isar_flutter_libs/isar_flutter_libs.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:vibration/vibration.dart';
import 'package:path_provider/path_provider.dart';
import 'dart:io';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:mime/mime.dart';
import 'dart:convert';
// =========【改动1：新增权限依赖导入】=========
import 'package:permission_handler/permission_handler.dart';
import 'package:shared_preferences/shared_preferences.dart'; //新增导入
// =========【👉 在这里粘贴 RSA加密 + mesLogin 代码！！】=========
import 'dart:typed_data';

import 'package:pointycastle/export.dart' hide Padding, State;
import 'package:pointycastle/asn1.dart';
import 'package:http/http.dart' as http;


part 'main.g.dart';
part 'web_service.dart'; // WiFi网页门户：批次列表/任意批次下载/基准CSV上传
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
    required String moduleId,   //新增
    required String orgId,      //新增
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
  String? mesPartNo;      //零件号 PartCode
  double? mesQty;         //数量 QTY
  String? mesCreateTime;  //MES DATETIME_CREATED
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
  BatchInfo({
    required this.batchId,
    required this.createTime,
    this.batchRemark = "",
    this.isArchived = false,
  });
}

// ===================== 全局Isar实例 =====================
@collection
class RecordExtra {
  Id id = Isar.autoIncrement;
  @Index(unique: true)
  String goodsCode; // 关联 ScanRecord.goodsCode（货码唯一）
  String palletId = "";   // 托号，空串=非整托记录
  String mesItemName = ""; // 物料描述（MES返回名称字段）
  String mesLotNo = "";    // 批次（MES返回LOT_NO）
  RecordExtra({
    required this.goodsCode,
    this.palletId = "",
    this.mesItemName = "",
    this.mesLotNo = "",
  });
}
// ===================== 全局Isar实例 =====================
late Isar _globalIsar;

// ===== 整托模式·末段子表：与主表同12列结构，按托聚合一行 =====
// 一行 = 一托×一个零件号：货物标签"; "拼接、MES数量累加、采集时间取该组首码、托号填列；
// 非整托有效记录逐码原样一行（托号留空）。本批次无整托记录时不输出该段。
String _buildPalletAggCsv(List<ScanRecord> records, Map<String, RecordExtra> extraMap) {
  String cf(String v) {
    if (v.contains(",") || v.contains("\"") || v.contains("\n")) return "\"${v.replaceAll("\"", "\"\"")}\"";
    return v;
  }
  String fq(double q) => q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);
  final Map<String, List<ScanRecord>> groups = {}; //插入顺序=首扫时间顺序
  bool hasPallet = false;
  for (final r in records) {
    if (r.isCancel) continue;
    final pid = extraMap[r.goodsCode]?.palletId ?? "";
    if (pid.isEmpty) {
      groups.putIfAbsent("SINGLE|${r.goodsCode}|${r.id}", () => []).add(r);
    } else {
      hasPallet = true;
      final pn = (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
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
    final remarks = rs.map((e) => e.remark).where((e) => e.trim().isNotEmpty).toSet().join("；");
    final pn = (first.mesPartNo?.isNotEmpty ?? false) ? first.mesPartNo! : (entry.key.contains("|") && !entry.key.startsWith("SINGLE|") ? entry.key.substring(entry.key.indexOf("|") + 1) : "");
    final totalQty = rs.fold<double>(0, (sum, e) => sum + (e.mesQty ?? 0));
    final pid = entry.key.startsWith("SINGLE|") ? "" : entry.key.substring(0, entry.key.indexOf("|"));
    s += "$timeStr,${first.workType},${cf(st)},${cf(gl)},${cf(container)},${cf(codes)},${cf(remarks)},正常,${cf(pn)},${fq(totalQty)},${cf(batch)},${cf(pid)}\n";
  }
  return s;
}
// ===================== 程序入口 =====================
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Isar.initializeIsarCore(download: true);
  final dir = await getApplicationDocumentsDirectory();
  _globalIsar = await Isar.open(
    [ScanRecordSchema, BatchInfoSchema, RecordExtraSchema],
    directory: dir.path,
  );
  runApp(const MyApp());
}
class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "AGV货位采集器",
      theme: ThemeData(primarySwatch: Colors.blue),
      home: const MainPage(),
      debugShowCheckedModeBanner: false,
    );
  }
}
class MainPage extends StatefulWidget {
  const MainPage({super.key});
  @override
  State<MainPage> createState() => _MainPageState();
}
class _MainPageState extends State<MainPage> with SingleTickerProviderStateMixin {
  late Isar _isar;
  String? _currentBatchId;
  int _workType = 0; //0 AGV站台，1人工地面
  String? _selectedStation; //【修改：存储编码 NB02-CK-05】
  String? _selectedGroundLoc;
String? _containerType;

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
  List<String> _selectedBatchIds = [];
  // ===== 整托合并模式状态 =====
  bool _palletMode = false;                     //整托开关
  String? _currentPalletId;                     //当前托号（首码自动创建）
  List<Map<String, dynamic>> _palletSummary = []; //本托汇总 [{partNo,itemName,boxes,qty}]
  int _palletTotalBoxes = 0;                    //本托已扫框数
  String _fmtQty(double q) => q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);

  HttpServer? _webServer;
  bool _webServiceRunning = false;
  String? _localIpAddress;
  static const int _webPort = 8090;
  @override
  void initState() {
    super.initState();
    _isar = _globalIsar;
    //初始化Tab控制器
    _tabController = TabController(length: 2, vsync: this);
    //【修复BUG：重启后统计为0】原写法 _loadLastBatch 与 _refreshRecord 并发执行，
    //刷新时批次号还没恢复，直接return导致看板0/0/0、记录共0条；改为串行初始化
    _initLoadData();
  }
  ///【修复BUG：新增】启动数据加载：先恢复当前批次号，再刷新记录列表与统计
  Future<void> _initLoadData() async {
    await _loadLastBatch();          // 恢复 _currentBatchId（或弹窗新建批次）
    if (!mounted) return;
    if (_currentBatchId == null) return; // 用户取消新建，保持空状态
    await _refreshRecord();           // 加载本批次采集记录
    await _refreshBatchStat();        // 刷新正常/作废统计
    if (_palletMode) await _refreshPalletSummary();
  }
  @override
  void dispose() {
    _tabController.dispose();
    _goodsFocusNode.dispose(); //【新增】释放焦点资源
    _goodsInputCtrl.dispose();
    _remarkInputCtrl.dispose();
_mainScrollCtrl.dispose(); //新增
    super.dispose();
  }
  ///【MOD‑新增2：刷新正常/作废统计，替换原有统计】
  Future<void> _refreshBatchStat() async {
    if (_currentBatchId == null) return;
    final records = await _isar.scanRecords.filter().batchIdEqualTo(_currentBatchId!).findAll();
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
      final pn = (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
      final g = grouped.putIfAbsent(pn, () => {"partNo": pn, "itemName": "", "boxes": 0, "qty": 0.0});
      g["boxes"] = (g["boxes"] as int) + 1;
      g["qty"] = (g["qty"] as double) + (r.mesQty ?? 0);
      final name = extraMap[r.goodsCode]?.mesItemName ?? "";
      if ((g["itemName"] as String).isEmpty && name.isNotEmpty) g["itemName"] = name;
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
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认结托")),
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
      _selectedGroundLoc = null;
      _containerType = null;
    });
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("本托已结束，请选择新货位开下一托")));
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
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
            TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
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
      _selectedGroundLoc = null;
      _containerType = null;
    });
  }
  Future<void> _loadLastBatch() async {
    List<BatchInfo> allBatch = await _isar.batchInfos.where().findAll();
    if(allBatch.isNotEmpty){
      //只筛选未归档批次作为可采集候选
  final active = allBatch.where((b)=>!b.isArchived).toList();
      if(active.isNotEmpty){
        active.sort((a, b) => b.createTime.compareTo(a.createTime));
        setState(() {
          _currentBatchId = active.first.batchId;
        });
      }else{
        await _createNewBatch();
      }
    } else {
      await _createNewBatch();
    }
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
          TextButton(onPressed: ()=>Navigator.pop(ctx,false), child: const Text("取消")),
          TextButton(onPressed: ()=>Navigator.pop(ctx,true), child: const Text("确认新建")),
        ],
      ),
    );
    if(confirmCreate != true) return;
    final nowStr = DateTime.now().toString().substring(0, 16).replaceAll(" ", "-").replaceAll(":", "");
    final newBatch = BatchInfo(
      batchId: "B$nowStr",
      createTime: DateTime.now().toString(),
      batchRemark: batchRemarkCtrl.text.trim(),
    );
    await _isar.writeTxn(() async {
      await _isar.batchInfos.put(newBatch);
    });
    setState(() {
      _currentBatchId = newBatch.batchId;
      _selectedStation = null;
      _selectedGroundLoc = null;
      _selectedTags.clear(); //新建批次清空多选标签
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
    return await _isar.batchInfos.filter().batchIdEqualTo(_currentBatchId!).findFirst();
  }
  //====本次新增校验：禁止向已归档批次录入数据====
  Future<bool> _checkBatchArchived() async{
    final batch = await _getCurrentBatch();
    if(batch?.isArchived == true){
      if(mounted){
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("当前批次已归档，不可新增采集记录！")));
      }
      return true;
    }
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
        content: Text("货码：$code\n登记位置：$posInfo\n状态：${exist.isCancel ? "【已作废】" : "正常有效"}"),
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
                Text("采集时间：${exist.scanTime.toString().substring(0,19)}"),
                Text("作业类型：${exist.workType==0?"AGV站台":"人工货位"}"),
                Text("位置：$posInfo"),
                Text("零件号：${(exist.mesPartNo?.isNotEmpty ?? false) ? exist.mesPartNo : "无"}"),
                Text("数量：${exist.mesQty ?? "无"}"),
                Text("备注：${exist.remark.isNotEmpty?exist.remark:"无"}"),
                Text("状态：${exist.isCancel?"已作废":"正常"}"),
              ],
            ),
          ),
          actions: [TextButton(onPressed: ()=>Navigator.pop(ctx), child: const Text("关闭"))],
        ),
      );
      return true;
    } else if (res == "cancelOld") {
      //每次操作独立标记，不会残留作废状态（修复Bug核心）
      bool tempCancelFlag = true;
      await _isar.writeTxn(() async {
        exist.isCancel = tempCancelFlag;
        await _isar.scanRecords.put(exist);
        if(exist.workType == 0 && exist.stationNo != null){
          BatchInfo? batch = await _getCurrentBatch();
          if(batch != null){
                       List<String> mutableList = batch.usedStation.toList();

            mutableList.remove(exist.stationNo);
            batch.usedStation = mutableList;
            await _isar.batchInfos.put(batch);
          }
        }
      });
      if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("旧记录已标记作废，可录入新记录")));
      return false;
    }
    return true;
  }
  Future<void> _scanSuccessAction() async {
    try {
      if (await AppSettings.getVibrationEnabled()) {
        if ((await Vibration.hasVibrator()) ?? false) {
          await Vibration.vibrate(duration: 80);
        }
      }
      if (await AppSettings.getSoundEnabled()) {
        await SystemSound.play(SystemSoundType.click);
      }
    } catch (_) {}
  }
  Future<void> _saveRecord(String code) async {
    if(_isSaving) return;
    _isSaving = true;
// ==========【新增前置校验，从这里开始】==========
    try {
      //校验1：容器类型不能为空
      if (_containerType == null) {
        if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先选择容器类型！")));
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
        if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先选择货位！")));
        await _scrollToKey(_keyLocationArea);
        _isSaving = false;
        return;
      }
    } catch (e) {
      debugPrint("校验滚动异常 $e");
    }
    // ==========【前置校验结束，下面原有代码保留不变】==========
    try{
      //归档拦截校验
      if(await _checkBatchArchived()) return;
      if (_currentBatchId == null) {
        if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("未创建采集批次！")));
        return;
      }
      if (await _isCodeDuplicate(code)) return;
      if (_workType == 0 && _selectedStation == null) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先选择站台！")));
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
          final extra = await _isar.recordExtras.filter().goodsCodeEqualTo(rec.goodsCode).findFirst();
          final recPallet = extra?.palletId ?? "";
          if (!(_palletMode && _currentPalletId != null && recPallet == _currentPalletId && recPallet.isNotEmpty)) {
            occupiedByOtherPallet = rec.goodsCode;
            break;
          }
        }
        if (occupiedByOtherPallet != null) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("${_selectedStation}站台已登记货物，不可再次使用！")));
          }
          return;
        }
      }
      if (_workType == 1 && _selectedGroundLoc == null) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先选择地面货位！")));
        }
        return;
      }
      // =========改动2‑2：拼接多选标签=========
      String finalRemark = _selectedTags.join("｜");
      if(_remarkInputCtrl.text.isNotEmpty){
        if(finalRemark.isNotEmpty) finalRemark += "｜";
        finalRemark += _remarkInputCtrl.text.trim();
      }
      // =========整托模式：首码自动建托号=========
      if (_palletMode && _currentPalletId == null) {
        final ts = DateTime.now();
        setState(() {
          _currentPalletId = "TP${ts.millisecondsSinceEpoch}";
        });
      }
      final String palletIdForSave = _palletMode ? (_currentPalletId ?? "") : "";

// ===================== MES接口请求【替换为GET版本，适配抓包接口】=====================
String? mesPartNo;
double? mesQty;
String? mesCreateTime;
String mesItemName = "";
String mesLotNo = "";
try {
  final mesCfg = await MesConfig.getConfig();
  String baseUrl = "http://${mesCfg["host"]}:${mesCfg["port"]}";
  String token = mesCfg["token"];
  if(token.isEmpty) throw Exception("MES Token为空，请先在设置页登录MES");
  // 重点：接口名修正为 GetLableList（抓包原始拼写，少a，否则404）
  final uri = Uri.parse("$baseUrl/api/station/label/GetLableList").replace(queryParameters: {
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
    "labelNo": code,
    "status": "",
    "poNo": "",
    "bDate": "",
    "eDate": "",
    "warehouse": "",
    "mitemSize": "",
    "supplier": "",
  });
  final httpClient = HttpClient();
  final mesRequest = await httpClient.getUrl(uri);
  // 【全部复制抓包拿到的请求头】
  mesRequest.headers.set("Culture","zh-CN");
  mesRequest.headers.set("EnterpriseId","*");
  // 改为从配置读取，不再硬编码ModuleId/OrgId；手填框为空时回退到登录下发值/抓包实测值，避免空请求头被服务端过滤成0条
  String moduleId = (mesCfg["moduleId"] ?? "").toString().trim();
  if (moduleId.isEmpty) moduleId = (await MesConfig.getModuleId()).trim();
  if (moduleId.isEmpty) moduleId = "CE7F61BD526C424996CF6CE00211B86A"; // 抓包实测：标签查询模块ID
  String orgIdHdr = (mesCfg["orgId"] ?? "").toString().trim();
  if (orgIdHdr.isEmpty) orgIdHdr = (await MesConfig.getOrgId()).trim();
  mesRequest.headers.set("ModuleId", moduleId);
  mesRequest.headers.set("OrgId", orgIdHdr);
  mesRequest.headers.set("ModulePage","/h5/pages/LABEL/MitemLabelQuery/index.html");
  mesRequest.headers.set("X-TZ-Offset","-480");
  mesRequest.headers.set("Token", token);
  mesRequest.headers.set("Accept","*/*");
  mesRequest.headers.set("Content-Type","application/json; charset=utf-8");

  final resp = await mesRequest.close();
  final respBody = await resp.transform(utf8.decoder).join();
  final int httpCode = resp.statusCode;

  // ===== Token失效识别①：HTTP状态码 401/403；②响应体不是JSON（错误页/空内容）=====
  bool tokenInvalid = false;
  Map<String,dynamic>? mesJson;
  if(httpCode == 401 || httpCode == 403){
    tokenInvalid = true;
  } else {
    try {
      final decoded = jsonDecode(respBody);
      if(decoded is Map<String,dynamic>) mesJson = decoded;
    } catch (_) {
      mesJson = null; //解析失败按失效/服务异常处理，不再抛FormatException
    }
    if(mesJson == null) tokenInvalid = true;
  }

  //解析抓包返回的JSON结构：分页结构 data.recordsTotal + data.data 数组，取第一条记录；兼容单对象形态
  String? mesErrMsg;
  bool msgComplete = false; //true=消息已自带完整上下文，直接显示；false=需加"MES查询失败："前缀
  if(tokenInvalid){
    final String previewRaw = respBody.trim();
    final String preview = previewRaw.isEmpty
        ? "(空响应)"
        : (previewRaw.length > 100 ? "${previewRaw.substring(0,100)}…" : previewRaw);
    mesErrMsg = "MES登录已失效(HTTP $httpCode)，请到设置页重新登录MES。服务器返回：$preview";
    msgComplete = true;
  } else {
    final Map<String,dynamic> json = mesJson!;
    if(json["success"] == true && json["data"] != null){
      final rawData = json["data"]["data"];
      final List rows = rawData is List ? rawData : (rawData is Map ? [rawData] : const []);
      if(rows.isEmpty){
        mesErrMsg = "查询结果为空(recordsTotal=${json["data"]["recordsTotal"]})，OrgId=$orgIdHdr ModuleId=$moduleId，请确认该货码在MES中有在库标签且组织范围正确";
      } else {
        final row = rows.first as Map;
        // 零件号取 PartCode（如 6608462082-A）；MITEM_CODE 是物料码，仅作兜底
        mesPartNo = (row["PartCode"] ?? row["MITEM_CODE"])?.toString();
        mesQty = (row["QTY"] as num?)?.toDouble();
        mesCreateTime = row["DATETIME_CREATED"]?.toString();
        mesItemName = (row["MITEM_NAME"] ?? row["MitemName"] ?? row["mitemName"] ?? "").toString();
        mesLotNo = (row["LOT_NO"] ?? row["lotNo"] ?? "").toString();
      }
    } else {
      // ===== Token失效识别③：success=false 且 message 指向会话/授权问题 =====
      final String msg = json["message"]?.toString() ?? "";
      final bool msgLooksLikeAuth = RegExp(
        r"token|session|unauthor|forbidden|invalid|expire|过期|失效|未授权|未登录|重新登录|登录",
        caseSensitive: false,
      ).hasMatch(msg);
      if(msgLooksLikeAuth){
        mesErrMsg = "MES登录已失效：$msg，请到设置页重新登录MES";
        msgComplete = true;
      } else {
        mesErrMsg = "接口返回异常 success=${json["success"]} message=$msg";
      }
    }
  }
  if(mesErrMsg != null && mounted){
    final String tip = msgComplete ? mesErrMsg : "MES查询失败：$mesErrMsg，仅保存本地采集信息";
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(tip)));
  }
} catch (mesErr) {
  if(mounted){
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("MES查询失败：${mesErr.toString()}，仅保存本地采集信息"))
    );
  }
  //MES查询失败，字段保留null，不阻断保存流程
}


      if(_palletMode && _currentPalletId != null && (mesPartNo?.isNotEmpty ?? false)){
        // 非首码时：若零件号在本托未出现过，轻提示防误扫（不拦截）
        final codesInPallet = await _isar.recordExtras.filter().palletIdEqualTo(_currentPalletId!).findAll();
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
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("⚠️ 本托出现新零件号 $mesPartNo，请确认属于同一托")));
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
        );
        await _isar.recordExtras.put(extraRec);
        if(_workType ==0 && _selectedStation != null){
          BatchInfo? batch = await _getCurrentBatch();
          if(batch != null){
             List<String> mutableList = batch.usedStation.toList();

            if(!mutableList.contains(_selectedStation)){
              mutableList.add(_selectedStation!);
              batch.usedStation = mutableList;
              await _isar.batchInfos.put(batch);
            }
          }
        }
      });
      await _scanSuccessAction();
      _goodsInputCtrl.clear();
      setState((){
        _selectedTags.clear(); //录入完成清空多选标签
        _remarkInputCtrl.clear();
        if (!_palletMode) {
          _containerType = null; // 新增：保存成功，容器类型取消选中
        }
        if(_workType == 1 && !_palletMode){
          _selectedGroundLoc = null; // ✅人工模式，录入成功清空地面货位
        }
      });
      if(_workType ==0 && !_palletMode){
        setState((){
          _selectedStation = null;
        });
      }
      await _refreshRecord();
      await _refreshBatchStat();
      await _refreshPalletSummary();
      if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("采集保存成功")));
      //【新增】保存完成，自动激活输入框，准备PDA下一次扫码
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if(mounted){
          _goodsFocusNode.requestFocus();
        }
      });
    }catch(e){
      if(mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("保存异常：${e.toString()}")));
    }finally{
      _isSaving = false;
    }
  }
  //【优化一：数字转编码 5→NB02-CK-05】
  Future<void> onStationTap(int stationNum) async {
    final batch = await _getCurrentBatch();
    if (batch == null) return;
    String stationCode = "NB02-CK-${stationNum.toString().padLeft(2,"0")}";
    if (batch.usedStation.contains(stationCode)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("${stationNum}号站台已使用，无法选择！")));
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
  Future<void> _refreshRecord() async {
    if (_currentBatchId == null) return;
    List<ScanRecord> all = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .findAll();
    all.sort((a,b)=>b.scanTime.compareTo(a.scanTime));
    //【修复BUG：此处强制setState，保证数据变更立刻刷新界面，解决保存成功看不到记录】
    setState(() {
      _recordList = all;
    });
  }
  //====修改：支持多批次合并导出｜改动2：函数改为异步，移除同步查询｜整托：托号列+汇总段
  Future<String> _generateCsvText({List<String>? targetBatchIds}) async {
  String csvField(String v){ //含逗号/引号的字段加引号转义，保证台账不串列
    if (v.contains(",") || v.contains("\"")) return "\"${v.replaceAll("\"", "\"\"")}\"";
    return v;
  }
  String header = "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期,托号\n";


    String content = header;
    List<ScanRecord> targetRecords = [];
    if(targetBatchIds != null && targetBatchIds.isNotEmpty){
      for(var bid in targetBatchIds){
        final list = await _isar.scanRecords.filter().batchIdEqualTo(bid).findAll();
        targetRecords.addAll(list);
      }
    }else{
      targetRecords = _recordList;
    }
    targetRecords.sort((a,b)=>a.scanTime.compareTo(b.scanTime));
    //预取所有扩展信息（托号/物料名）
    final extras = await _isar.recordExtras.where().findAll();
    final Map<String,RecordExtra> extraMap = {for (var e in extras) e.goodsCode: e};
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
content += "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText,$pn,$qty,$pd,$pid\n";


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
        final rs = palletGroups[pid]!..sort((a,b)=>a.scanTime.compareTo(b.scanTime));
        // 同托内按零件号再分组
        final Map<String, List<ScanRecord>> byPart = {};
        for (final r in rs) {
          final pn = (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
          byPart.putIfAbsent(pn, () => []).add(r);
        }
        for (final entry in byPart.entries) {
          final rowsOfPart = entry.value;
          final codes = rowsOfPart.map((e) => e.goodsCode).join("；");
          final names = rowsOfPart.map((e) => extraMap[e.goodsCode]?.mesItemName ?? "").where((e) => e.isNotEmpty).toSet().join("；");
          final totalQty = rowsOfPart.fold<double>(0, (s, e) => s + (e.mesQty ?? 0));
          final loc0 = rowsOfPart.first;
          content += "${csvField(pid)},${loc0.workType},${csvField(loc0.stationNo ?? "")},${csvField(loc0.groundLocation ?? "")},${csvField(loc0.containerType ?? "")},${csvField(entry.key)},${csvField(names)},${rowsOfPart.length},${csvField(codes)},${_fmtQty(totalQty)}\n";
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
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("文件已保存：$filePath")));
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
    final wifiPermStatus = await Permission.nearbyWifiDevices.request();
    if(!wifiPermStatus.isGranted){
      if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("需要附近设备权限，才能读取WiFi地址")));
      return;
    }
    final ip = await _getLocalIp();
    if (ip == null) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("未获取到局域网IP，请确认已连接WiFi，并关闭移动数据")));
      return;
    }
    _localIpAddress = ip;
    // ===== 网页门户：批次列表 / 任意批次下载 / 基准CSV上传（原"一律返回当前批次CSV"已升级） =====
    final handler = createCollectWebService(
      csvForBatches: (ids) => _generateCsvText(targetBatchIds: ids.isEmpty ? null : ids),
      currentBatchId: () => _currentBatchId,
    );
    try {
      _webServer = await shelf_io.serve(handler, "0.0.0.0", _webPort);
      setState(() {
        _webServiceRunning = true;
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("传输服务已开启，地址：http://${ip}:${_webPort}")));
      }
    } catch (e) {
      if(mounted){
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("端口启动失败：${e.toString()}，请使用复制导出模式")));
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
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("局域网传输服务已关闭")));
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
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭"))],
      ),
    );
    if(result != null && result.toString().trim().isNotEmpty){
      await _saveRecord(result.toString().trim());
    }
  }
  Widget _buildStationPanel() {
    return FutureBuilder<BatchInfo?>(
      future: _getCurrentBatch(),
      builder: (ctx, snapshot) {
        List<String> used = snapshot.data?.usedStation ?? [];
        // 8个站台，两行，每行4个：[5,6,7,8] / [9,10,11,12]
        final List<List<int>> stationRows = [
          [5,6,7,8],
          [9,10,11,12]
        ];
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: stationRows.map((rowStationList){
            return Padding(
              padding: const EdgeInsets.only(bottom:12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: rowStationList.map((num) {
                  String stationCode = "NB02-CK-${num.toString().padLeft(2,"0")}";
                  bool locked = used.contains(stationCode);
                  bool selected = _selectedStation == stationCode;
                  return SizedBox(
                    width: 80,
                    height: 64,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: locked ? Colors.amber.shade600 : (selected ? Color(0xFF515BD4) : Colors.white),
                        foregroundColor: selected ? Colors.white : Colors.black87,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        elevation: 2
                      ),
                      onPressed: locked ? null : () => onStationTap(num),
                      child: Text("$num号",style: TextStyle(fontSize:18)),
                    ),
                  );
                }).toList().cast<Widget>(),
              ),
            );
          }).toList().cast<Widget>(),
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
          children: _locGroup.map((g) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: ChoiceChip(
              label: Text(g),
              selected: _curLocGroup == g,
              onSelected: (s) => setState(() => _curLocGroup = g),
            ),
          )).toList().cast<Widget>(),
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
                  padding: const EdgeInsets.symmetric(horizontal:3),
                  child: SizedBox(
                    width: 42,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: isSelected ? Color(0xFF515BD4) : Colors.white,
                        foregroundColor: isSelected ? Colors.white : Colors.black,
                        elevation:2,
                      ),
                      onPressed: () => _selectGroundLoc(n),
                      child: Text("$n",style: TextStyle(fontSize:16)),
                    ),
                  ),
                );
              }),
            ),
            const SizedBox(height:6),
            // 第二行：10~18
            Row(
              children: List.generate(9, (i) {
                int n = i + 10;
                String locCode = "$_curLocGroup$n";
                bool isSelected = _selectedGroundLoc == locCode;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal:3),
                  child: SizedBox(
                    width: 42,
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor: isSelected ? Color(0xFF515BD4) : Colors.white,
                        foregroundColor: isSelected ? Colors.white : Colors.black,
                        elevation:2,
                      ),
                      onPressed: () => _selectGroundLoc(n),
                      child: Text("$n",style: TextStyle(fontSize:16)),
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

  Widget _buildContainerButton({required String showText,required String dbValue}){
    bool selected = _containerType == dbValue;
    return SizedBox(
      height:48,
      child: ElevatedButton(
        style: ElevatedButton.styleFrom(
          backgroundColor: selected ? Color(0xFF515BD4) : Colors.white,
          foregroundColor: selected ? Colors.white : Colors.black87,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          elevation:2,
        ),
        onPressed: (){
          setState(() {
            if(_containerType == dbValue){
              _containerType = null;
            }else{
              _containerType = dbValue;
            }
          });
        },
        child: Text(showText,style: TextStyle(fontSize:15)),
      ),
    );
  }

  //【MOD‑Bug2｜完整替换此函数】
  Widget _buildRecordList() {
    if(_recordList.isEmpty){
      return const Center(child:Text("本批次暂无采集记录"));
    }
    return ListView.builder(
      shrinkWrap: true,
    physics: const NeverScrollableScrollPhysics(), // 改动这里
      itemCount: _recordList.length,
      itemBuilder: (ctx, idx) {
        var r = _recordList[idx];
        String posTxt;
        if (r.workType == 0) {
          posTxt = "站台${r.stationNo}";
        } else {
          posTxt = "货位${r.groundLocation}";
        }
        String timeTxt = r.scanTime.toString().substring(0, 19);
        return Container(
          margin: EdgeInsets.symmetric(vertical: 6),
          padding: EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            boxShadow: [BoxShadow(color: Colors.black12, blurRadius:2)]
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text("${r.goodsCode}",style: TextStyle(fontSize:20,fontWeight: FontWeight.bold)),
                    SizedBox(height:4),
                    Text("📍 $posTxt｜容器:${r.containerType ?? "未选择"} ⏱ $timeTxt"),

                    SizedBox(height:4),
                    Text("📝 ${r.remark.isNotEmpty ? r.remark : "无"}"),
                  ],
                ),
              ),
              Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Container(
                    padding: EdgeInsets.symmetric(horizontal:8,vertical:3),
                    decoration: BoxDecoration(
                      color: r.isCancel ? Colors.red.shade100 : Colors.green.shade100,
                      borderRadius: BorderRadius.circular(8)
                    ),
                    child: Text(r.isCancel?"作废":"正常",style: TextStyle(color: r.isCancel?Colors.red:Colors.green)),
                  ),
                  if(!r.isCancel)
                    TextButton(
                      style: TextButton.styleFrom(foregroundColor: Colors.red),
                      onPressed: () async {
                        final confirm = await showDialog<bool>(
                          context: context,
                          builder: (ctx) => AlertDialog(
                            title: const Text("删除记录"),
                            content: const Text("确定删除本条采集记录？"),
                            actions: [
                              TextButton(onPressed: ()=>Navigator.pop(ctx,false), child: const Text("取消")),
                              TextButton(onPressed: ()=>Navigator.pop(ctx,true), child: const Text("确认")),
                            ],
                          ),
                        );
                        if(confirm != true) return;
                        await _isar.writeTxn(() async {
                          await _isar.scanRecords.delete(r.id);
                          if(r.workType ==0 && r.stationNo != null){
                            BatchInfo? batch = await _getCurrentBatch();
                            if(batch != null){
                              List<String> mutable = batch.usedStation.toList();
                              mutable.remove(r.stationNo);
                              batch.usedStation = mutable;
                              await _isar.batchInfos.put(batch);
                            }
                          }
                        });
                        await _refreshRecord();
                        await _refreshBatchStat();
                      },
                      child: const Text("删除",style: TextStyle(fontSize:14)),
                    ),
                ],
              )
            ],
          ),
        );
      },
    );
  }
  //====本次【修改重点】历史批次页面【完全对齐截图布局】====
  Widget _buildHistoryBatchPage(){
    return FutureBuilder<List<BatchInfo>>(
      future: _isar.batchInfos.where().findAll().then((list){
        list.sort((a,b)=>b.createTime.compareTo(a.createTime)); //按创建时间倒序，最新在上
        return list;
      }),
      builder: (ctx,snap){
        if(!snap.hasData) return const Center(child: CircularProgressIndicator());
        final batches = snap.data!;
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal:12,vertical:8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Row(
                    children: [
                      Checkbox(
                        value: _selectedBatchIds.length == batches.length && batches.isNotEmpty,
                        onChanged: (sel){
                          setState(() {
                            if(sel == true){
                                                         _selectedBatchIds = batches.map((b)=>b.batchId).toList();

                            }else{
                              _selectedBatchIds.clear();
                            }
                          });
                        },
                      ),
                      const Text("全选"),
                      SizedBox(width:12),
                      Text("已选: ${_selectedBatchIds.length}个"),
                    ],
                  ),
                ],
              ),
            ),
            Expanded(
              child: ListView.builder(
                padding: EdgeInsets.symmetric(horizontal:12),
                itemCount: batches.length,
                itemBuilder: (ctx,idx){
                  final b = batches[idx];
                  Future<int> getCount()async{
                    return await _isar.scanRecords.filter().batchIdEqualTo(b.batchId).count();
                  }
                  return FutureBuilder<int>(
                    future:getCount(),
                    builder: (ctx,countSnap){
                      final recCount = countSnap.data ?? 0;
                      //状态标签样式完全匹配截图
                      Widget statusWidget;
                      if(b.isArchived){
                        statusWidget = Container(
                          padding: EdgeInsets.symmetric(horizontal:8,vertical:3),
                          decoration: BoxDecoration(color:Colors.grey.shade200,borderRadius:BorderRadius.circular(8)),
                          child:Text("已归档",style:TextStyle(color:Colors.grey)),
                        );
                      }else{
                        statusWidget = Container(
                          padding: EdgeInsets.symmetric(horizontal:8,vertical:3),
                          decoration: BoxDecoration(color:Color(0xFFE8EDFF),borderRadius:BorderRadius.circular(8)),
                          child:Text("进行中",style:TextStyle(color:Color(0xFF4056D6))),
                        );
                      }
                      return Container(
                        margin: EdgeInsets.only(bottom:10),
                        padding: EdgeInsets.all(14),
                        decoration:BoxDecoration(
                          color:Colors.white,
                          borderRadius:BorderRadius.circular(14),
                          boxShadow:[BoxShadow(color:Colors.black12,blurRadius:4)]
                        ),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Checkbox(
                              value: _selectedBatchIds.contains(b.batchId),
                              onChanged: (sel){
                                setState(() {
                                  if(sel == true){
                                    _selectedBatchIds.add(b.batchId);
                                  }else{
                                    _selectedBatchIds.remove(b.batchId);
                                  }
                                });
                              },
                            ),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Row(
                                    children: [
                                      Expanded(child:Text(b.batchId,style:TextStyle(fontSize:16,fontWeight:FontWeight.bold,overflow:TextOverflow.ellipsis))),
                                      SizedBox(width:8),
                                      statusWidget
                                    ],
                                  ),
                                  SizedBox(height:4),
                                  Text("🕒 ${b.createTime.substring(0,16)}"),
                                  SizedBox(height:4),
                                  Text("📂 $recCount 条记录  📍 ${b.batchRemark.isNotEmpty?b.batchRemark:"无货位信息"}"),
                                ],
                              ),
                            ),
                            SizedBox(width:8),
                            Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                SizedBox(
                                  width:70,
                                  child:ElevatedButton(
                                    style:ElevatedButton.styleFrom(padding:EdgeInsets.symmetric(vertical:4)),
                              onPressed: () {
  Navigator.push(
    context,
    MaterialPageRoute(builder: (ctx) => BatchDetailPage(batch: b)),
  );
},
                                    child:const Text("查看",style:TextStyle(fontSize:12)),
                                  ),
                                ),
                                if(!b.isArchived)
                                SizedBox(
                                  width:70,
                                  child:ElevatedButton(
                                    style:ElevatedButton.styleFrom(padding:EdgeInsets.symmetric(vertical:4),backgroundColor:Colors.grey.shade200,foregroundColor:Colors.black87),
                                    onPressed:()async{
                                      final ok = await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(title:const Text("归档批次"),content:const Text("归档后无法新增采集记录，确认归档？"),actions:[
                                        TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text("取消")),
                                        TextButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text("确认归档")),
                                      ]));
                                      if(ok==true){
                                        await _isar.writeTxn(()async{
                                          b.isArchived = true;
                                          await _isar.batchInfos.put(b);
                                        });
                                        setState((){});
                                      }
                                    },
                                    child:const Text("归档",style:TextStyle(fontSize:12)),
                                  ),
                                ),
                                SizedBox(
                                  width:70,
                                  child:ElevatedButton(
                                    style:ElevatedButton.styleFrom(padding:EdgeInsets.symmetric(vertical:4),backgroundColor:Colors.red.shade100,foregroundColor:Colors.red),
                                    onPressed:()async{
                                      final ok = await showDialog<bool>(context:context,builder:(ctx)=>AlertDialog(title:const Text("删除批次"),content:const Text("警告！会永久删除该批次所有采集数据，不可恢复！"),actions:[
                                        TextButton(onPressed:()=>Navigator.pop(ctx,false),child:const Text("取消")),
                                        TextButton(onPressed:()=>Navigator.pop(ctx,true),child:const Text("确认删除")),
                                      ]));
                                      if(ok==true){
                                        await _isar.writeTxn(()async{
                                          // 先收集货码，连带清理扩展表，防托号串批
                                          final delCodes = await _isar.scanRecords.filter().batchIdEqualTo(b.batchId).findAll();
                                          await _isar.scanRecords.filter().batchIdEqualTo(b.batchId).deleteAll();
                                          for(final dr in delCodes){
                                            await _isar.recordExtras.filter().goodsCodeEqualTo(dr.goodsCode).deleteAll();
                                          }
                                          await _isar.batchInfos.delete(b.id);
                                        });
                                        //如果删除的是当前批次，则自动切换可用批次
                                        if(_currentBatchId == b.batchId){
                                          await _loadLastBatch();
                                          await _refreshBatchStat();
                                        }
                                        setState((){});
                                      }
                                    },
                                    child:const Text("删除",style:TextStyle(fontSize:12)),
                                  ),
                                ),
                              ],
                            )
                          ],
                        ),
                      );
                    },
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
                      height:48,
                      child:ElevatedButton(
                        style:ElevatedButton.styleFrom(backgroundColor:Colors.grey.shade200,foregroundColor:Colors.black87),
                        onPressed: _selectedBatchIds.isEmpty ? null : ()async{
                          for(var bid in _selectedBatchIds){
                            final batch = await _isar.batchInfos.filter().batchIdEqualTo(bid).findFirst();
                            if(batch != null && !batch.isArchived){
                              await _isar.writeTxn(()async{
                                batch.isArchived = true;
                                await _isar.batchInfos.put(batch);
                              });
                            }
                          }
                          setState(()=>_selectedBatchIds.clear());
                        },
                        child: const Text("批量归档"),
                      ),
                    ),
                  ),
                  SizedBox(width:10),
                  Expanded(
                    child:SizedBox(
                      height:48,
                      child:ElevatedButton(
                        style:ElevatedButton.styleFrom(
                          backgroundColor:_selectedBatchIds.isNotEmpty ? Color(0xFF515BD4) : Colors.grey.shade300,
                        ),
                        onPressed: _selectedBatchIds.isEmpty ? null : ()async{
                          await _saveCsvToFile(batchIds: _selectedBatchIds);
                          setState(()=>_selectedBatchIds.clear());
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
    await _saveCsvToFile();
  }
  Future<void> _toggleWifiServer() async {
    if (_webServiceRunning) {
      await stopWebService();
    } else {
      await startWebService();
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
          labelColor: Colors.white, //选中文字白色
          labelStyle: TextStyle(fontWeight: FontWeight.bold), //选中加粗
          unselectedLabelColor: Color(0xFFD0D4F8), //未选中浅白色
          indicatorColor: Colors.white,
          tabs: const [
            Tab(text: "采集录入"),
            Tab(text: "历史批次"),
          ],
        ),
      ),
      body: TabBarView(
        controller: _tabController,
        children: [
          //采集录入页面
        SingleChildScrollView(
  controller: _mainScrollCtrl,
  padding: const EdgeInsets.all(12),
  child: Column(

              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                //【MOD‑新增2｜替换为截图样式3个统计卡片】
                Row(
                  children: [
                    Expanded(
                      child: _statItem("正常", "$_normalCount",Color(0xFFE8F5E9),Colors.green),
                    ),
                    SizedBox(width:10),
                    Expanded(
                      child: _statItem("作废", "$_cancelCount",Color(0xFFFFEBEE),Colors.red),
                    ),
                    SizedBox(width:10),
                    Expanded(
                      child: _statItem("本批合计", "${_normalCount+_cancelCount}",Color(0xFFE8EAF6),Color(0xFF515BD4),isCircle:true),
                    ),
                  ],
                ),
              const SizedBox(height:16),
SizedBox(
  width: double.infinity,
  height:52,
  child: ElevatedButton(
    style:ElevatedButton.styleFrom(
      backgroundColor:Color(0xFF515BD4),
      shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(12)),
      padding: const EdgeInsets.symmetric(vertical: 8), // 增加垂直内边距，防止文字紧贴上下边缘
    ),
    onPressed: ()=>_createNewBatch(),
    child: const Text(
      "+ 新建采集批次",
      style:TextStyle(
        fontSize:16,
        color: Colors.white, // 强制白色文字，提升和紫色背景对比度，解决看不清
        fontWeight: FontWeight.w500, // 字重加粗，文字更清晰
      ),
    ),
  ),
),

const SizedBox(height:16),
const Text("作业模式",style:TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
const SizedBox(height:6),
Row(
  children: [
    Expanded(
      child: InkWell(
        onTap: (){
          // AGV模式点击逻辑写这里
        },
        child: _workModeCard(0,"AGV站台模式","AGV站台扫码采集"),
      ),
    ),
    const SizedBox(width:10),
    Expanded(
      child: InkWell(
        onTap: (){
          // 人工模式点击逻辑写这里
        },
        child: _workModeCard(1,"人工地面摆放","人工地堆托盘扫码"),
      ),
    ),
  ],
),

// ===== 整托合并模式：开关 + 当前托汇总卡片 =====
Container(
  margin: const EdgeInsets.only(top:12),
  padding: const EdgeInsets.symmetric(horizontal:12, vertical:6),
  decoration: BoxDecoration(
    color: _palletMode ? const Color(0xFFF0FFF4) : Colors.white,
    borderRadius: BorderRadius.circular(12),
    border: Border.all(color: _palletMode ? Colors.green.shade300 : Colors.grey.shade300),
  ),
  child: Row(
    children: [
      const Text("整托合并模式",style: TextStyle(fontSize:15,fontWeight: FontWeight.w500)),
      const SizedBox(width:6),
      Expanded(
        child: Text(_palletMode ? (_currentPalletId==null ? "已开启，扫码自动开托" : "当前托：$_currentPalletId") : "一托多码按零件号累加数量",
          style: TextStyle(fontSize:12,color:Colors.grey.shade600),overflow: TextOverflow.ellipsis),
      ),
      if (_palletMode && _currentPalletId != null)
        TextButton(onPressed: _endPallet, child: const Text("结束本托",style: TextStyle(color:Color(0xFF515BD4)))),
      Switch(value: _palletMode, activeColor: Colors.green, onChanged: _togglePalletMode),
    ],
  ),
),
if (_palletMode && _palletTotalBoxes > 0)
  Container(
    width: double.infinity,
    margin: const EdgeInsets.only(top:8),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: const Color(0xFFF7F8FF),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: const Color(0xFFC7CDF0)),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text("当前托汇总（已扫 $_palletTotalBoxes 框）",style: const TextStyle(fontSize:14,fontWeight: FontWeight.bold,color:Color(0xFF515BD4))),
        const SizedBox(height:6),
        ..._palletSummary.map((g) => Padding(
          padding: const EdgeInsets.symmetric(vertical:2),
          child: Text("${g["partNo"]}  ${g["itemName"].toString().isNotEmpty ? g["itemName"] : ""}  ${g["boxes"]}框  数量合计：${_fmtQty(g["qty"] as double)}",
            style: const TextStyle(fontSize:13)),
        )),
      ],
    ),
  ),

               const SizedBox(height:12),
Container(
  key: _keyContainerArea,
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text("容器类型",style: TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
      const SizedBox(height:6),
      SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            _buildContainerButton(showText:"1.8米铁框",dbValue:"1800*1200_2"),
            const SizedBox(width:8),
            _buildContainerButton(showText:"1.6米铁框",dbValue:"1600*1100"),
            const SizedBox(width:8),
            _buildContainerButton(showText:"2.4米铁框",dbValue:"2.4米铁框"),
            const SizedBox(width:8),
            _buildContainerButton(showText:"华强铁框",dbValue:"华强铁框"),
            const SizedBox(width:8),
            _buildContainerButton(showText:"托盘",dbValue:"托盘"),
          ],
        ),
      ),
    ],
  ),
),
const SizedBox(height:12),

 Container(
  key: _keyLocationArea,
  child: Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      const Text("选择货位 *",style: TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
      const SizedBox(height:6),
      if (_workType == 0) _buildStationPanel(),
      if (_workType == 1) _buildGroundLocPanel(),
    ],
  ),
),
const SizedBox(height: 12),

                const Text("扫码录入",style: TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
                const SizedBox(height:4),
                Container(
                 padding: EdgeInsets.symmetric(horizontal:12, vertical:8),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Colors.grey.shade300)
                  ),
                  child: Column(
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _goodsInputCtrl,
                              focusNode: _goodsFocusNode,
                              decoration: const InputDecoration(
                                hintText: "扫描或输入货物条码",
                                border: InputBorder.none
                              ),
                              onSubmitted: (txt) {
                                WidgetsBinding.instance.addPostFrameCallback((_) async {
                                  String code = txt.trim();
                                  if (code.isNotEmpty) await _saveRecord(code);
                                });
                              },
                            ),
                          ),
                          const SizedBox(width: 8),
                          ElevatedButton(
                            style:ElevatedButton.styleFrom(backgroundColor:Color(0xFF515BD4)),
                            onPressed: _openCameraScan,
                            child: const Text("相机扫码"),
                          ),
                        ],
                      ),
                      //【优化二：移除底部提示小字】
                    ],
                  ),
                ),
         const SizedBox(height:16),
Row(
  mainAxisAlignment: MainAxisAlignment.spaceBetween,
  children: [
    const Text("备注标签",style: TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
    Text("可多选 · 冲突项目自动互斥",style:TextStyle(fontSize:12,color:Colors.grey)),
  ],
),
const SizedBox(height:8),
SingleChildScrollView(
  scrollDirection: Axis.horizontal,
  child: Row(
    children: [
      //第一组 quickRemarkTags
      ..._quickRemarkTags.map((tag)=>Padding(
        padding: const EdgeInsets.only(right:10),
        child: FilterChip(
          label:Text(tag),
          selected:_selectedTags.contains(tag),
          onSelected:(sel){
            setState(() {
              if(sel){
                _selectedTags.add(tag);
              }else{
                _selectedTags.remove(tag);
              }
            });
          },
        ),
      )).toList().cast<Widget>(),
      //第二组 extraTags，接在同一行后面
      ..._extraTags.map((tag)=>Padding(
        padding: const EdgeInsets.only(right:6),
        child: FilterChip(
          label:Text(tag,style:TextStyle(fontSize:12)),
          selected:_selectedTags.contains(tag),
          onSelected:(sel){
            setState(() {
              if(sel){
                _selectedTags.add(tag);
              }else{
                _selectedTags.remove(tag);
              }
            });
          },
        ),
      )).toList().cast<Widget>(),
    ],
  ),
),


                const SizedBox(height:12),
                TextField(
                  controller:_remarkInputCtrl,
                  decoration:const InputDecoration(
                    hintText:"自定义补充备注（可选）",
                    border:OutlineInputBorder(),
                    isDense:true
                  ),
                ),
                const SizedBox(height: 12),
                const Divider(),
                InkWell(
                  onTap: (){
                    setState(() {
                      _recordPanelExpanded = !_recordPanelExpanded;
                    });
                  },
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          const Text("本批次采集记录",style: TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
                          SizedBox(width:8),
                          Text("共 ${_recordList.length}条",style:TextStyle(fontSize:13,color:Colors.grey)),
                        ],
                      ),
                      Icon(_recordPanelExpanded ? Icons.expand_less : Icons.expand_more),
                    ],
                  ),
                ),
                const SizedBox(height:6),
                // =========【修改：移除固定高度，改用自适应+最大高度约束】 =========
             if(_recordPanelExpanded)
  _buildRecordList(),

                const SizedBox(height:80),
              ],
            ),
          ),
                  //历史批次页面
          _buildHistoryBatchPage()
        ],
      ),
    bottomNavigationBar: BottomNavigationBar(
        items: const [
          BottomNavigationBarItem(icon: SizedBox.shrink(), label: "采集"),
          BottomNavigationBarItem(icon: SizedBox.shrink(), label: "导出"),
          BottomNavigationBarItem(icon: SizedBox.shrink(), label: "设置"),
        ],
        currentIndex: 0,
        type: BottomNavigationBarType.fixed,
        showSelectedLabels: true,
        showUnselectedLabels: true,
        onTap: (idx) async{
          if(idx ==0){
            _tabController.animateTo(0);
          }else if(idx ==1){
            await showMenu(context: context,
                position: const RelativeRect.fromLTRB(100,500,100,100),
                items: [
                  PopupMenuItem(value: "copy", child: Text("复制CSV内容")),
                  PopupMenuItem(value: "export", child: Text("导出CSV文件")),
                  PopupMenuItem(value: "wifi", child: Text("开启WiFi局域网服务")),
                ]).then((val)async{
              switch(val){
                case "copy":
                  final csv = await _generateCsvText();
                  await Clipboard.setData(ClipboardData(text: csv));
                  break;
                case "export":
                  await _exportCsvFile();
                  break;
                case "wifi":
                  await _toggleWifiServer();
                  break;
              }
            });
          }
      else if(idx ==2){
  //跳转设置菜单页（内含MES服务器设置、声音震动设置等）
  Navigator.push(
    context,
    MaterialPageRoute(builder: (context)=>const SettingsMenuPage()),
  );
}

        },
      ),
    );

  }

  //统计卡片组件
  Widget _statItem(String title,String num,Color bg,Color txtColor,{bool isCircle=false}){
    return Container(
      padding: EdgeInsets.all(12),
      decoration: BoxDecoration(
        color:bg,
        borderRadius:BorderRadius.circular(12)
      ),
      child:Column(
        children: [
          isCircle?
          Container(
            width:40,
            height:40,
            decoration:BoxDecoration(color:txtColor,shape:BoxShape.circle),
            child:Center(child:Text(num,style:TextStyle(color:Colors.white,fontSize:18,fontWeight:FontWeight.bold))),
          )
          :Text(num,style:TextStyle(fontSize:22,fontWeight:FontWeight.bold,color:txtColor)),
          const SizedBox(height:4),
          Text(title,style:const TextStyle(fontSize:13)),
        ],
      ),
    );
  }

  //作业模式卡片组件
  Widget _workModeCard(int type,String title,String sub){
    bool selected = _workType == type;
    return InkWell(
      onTap:(){
        setState(() {
          _workType = type;
          if(type ==0){
            _selectedGroundLoc = null;
          }else{
            _selectedStation = null;
          }
_containerType = null;
          // 切换作业模式：结束当前托，防止跨托串号
          _currentPalletId = null;
          _palletSummary = [];
          _palletTotalBoxes = 0;

        });
      },
      child:Container(
       padding: const EdgeInsets.symmetric(horizontal:12, vertical:10), // ← 改这里，上下内边距缩小
        decoration:BoxDecoration(
          color: selected ? Color(0xFFF0F0FF) : Colors.white,
          borderRadius:BorderRadius.circular(12),
          border: Border.all(color: selected ? Color(0xFF515BD4):Colors.grey.shade200,width:selected?2:1)
        ),
        child:Column(
mainAxisSize: MainAxisSize.min, // 关键！让Column高度自适应内容，不自动撑高
          children:[
                       Text(title,style:TextStyle(fontSize:16,fontWeight:selected?FontWeight.bold:FontWeight.normal,color:selected?Color(0xFF515BD4):Colors.black87)),
            SizedBox(height:4),
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
  bool _isLoading = true;

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
      final list = await _isar.scanRecords
          .filter()
          .batchIdEqualTo(widget.batch.batchId)
          .findAll();
      list.sort((a, b) => b.scanTime.compareTo(a.scanTime));
      _records = list;
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
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("删除记录"),
        content: const Text("确定删除本条采集记录？"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认")),
        ],
      ),
    );
    if (confirm != true) return;
    await _isar.writeTxn(() async {
      await _isar.scanRecords.delete(r.id);
      if (r.workType == 0 && r.stationNo != null) {
        BatchInfo? b = await _isar.batchInfos
            .filter()
            .batchIdEqualTo(widget.batch.batchId)
            .findFirst();
        if (b != null) {
            List<String> mut = b.usedStation.toList();

          mut.remove(r.stationNo);
          b.usedStation = mut;
          await _isar.batchInfos.put(b);
        }
      }
    });
    await _loadRecords();
  }

Future<void> _exportThisBatch() async {
  String csvField(String v){
    if (v.contains(",") || v.contains("\"")) return "\"${v.replaceAll("\"", "\"\"")}\"";
    return v;
  }
  //【修改这里，增加MES三列｜整托：托号列+汇总段】
  String header = "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期,托号\n";
  String content = header;
  List<ScanRecord> targetRecords = _records;
  targetRecords.sort((a, b) => a.scanTime.compareTo(b.scanTime));
  final extras = await _isar.recordExtras.where().findAll();
  final Map<String,RecordExtra> extraMap = {for (var e in extras) e.goodsCode: e};
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
    content += "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText,$pn,$qty,$pd,$pid\n";
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
      final rs = palletGroups[pid]!..sort((a,b)=>a.scanTime.compareTo(b.scanTime));
      final Map<String, List<ScanRecord>> byPart = {};
      for (final r in rs) {
        final pn = (r.mesPartNo?.isNotEmpty ?? false) ? r.mesPartNo! : "未知(MES未查到)";
        byPart.putIfAbsent(pn, () => []).add(r);
      }
      for (final entry in byPart.entries) {
        final rowsOfPart = entry.value;
        final codes = rowsOfPart.map((e) => e.goodsCode).join("；");
        final names = rowsOfPart.map((e) => extraMap[e.goodsCode]?.mesItemName ?? "").where((e) => e.isNotEmpty).toSet().join("；");
        final totalQty = rowsOfPart.fold<double>(0, (s, e) => s + (e.mesQty ?? 0));
        final loc0 = rowsOfPart.first;
        content += "${csvField(pid)},${loc0.workType},${csvField(loc0.stationNo ?? "")},${csvField(loc0.groundLocation ?? "")},${csvField(loc0.containerType ?? "")},${csvField(entry.key)},${csvField(names)},${rowsOfPart.length},${csvField(codes)},${_fmtQtyLocal(totalQty)}\n";
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("文件已保存：$filePath")));
  }
}

  String _fmtQtyLocal(double q) => q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);


  @override
  Widget build(BuildContext context) {
    bool archived = widget.batch.isArchived;
    return Scaffold(
      appBar: AppBar(
        title: Text("${widget.batch.batchId} ${archived ? "【已归档‑只读】" : "【进行中】"}"),
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
    return ListView.builder(
      padding: const EdgeInsets.all(12),
      itemCount: _records.length,
      itemBuilder: (c, idx) {
        var r = _records[idx];
        String posTxt = r.workType == 0 ? "站台${r.stationNo}" : "货位${r.groundLocation}";
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
                        style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Text("📍 $posTxt｜容器:${r.containerType ?? "未选择"}"),
                      Text("⏱ 采集时间：$timeTxt"),
                      Text("📝 备注：${r.remark.isNotEmpty ? r.remark : "无"}"),
                      const SizedBox(height: 4),
                      Text(
                        r.isCancel ? "⚠️ 已作废" : "✅ 正常",
                        style: TextStyle(color: r.isCancel ? Colors.red : Colors.green),
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
                          MaterialPageRoute(builder: (ctx) => ScanRecordDetailPage(record: r)),
                        );
                      },
                      child: const Text("查看"),
                    ),
                    if (!archived && !r.isCancel)
                      TextButton(
                        style: TextButton.styleFrom(foregroundColor: Colors.red),
                        onPressed: () => _deleteRecord(r),
                        child: const Text("删除"),
                      ),
                  ],
                ),
              ],
            ),
          ),
        );
      },
    );
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
    String posTxt = r.workType == 0 ? "站台${r.stationNo}" : "货位${r.groundLocation}";
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
            const SizedBox(height:12),
            _detailItem("作业位置", posTxt),
            _detailItem("容器类型", r.containerType ?? "未选择"),
            _detailItem("采集时间", timeTxt),
            _detailItem("备注", r.remark.isNotEmpty ? r.remark : "无"),
            _detailItem("记录状态", r.isCancel ? "⚠️ 已作废" : "✅ 正常"),
            _detailItem("MES零件号", r.mesPartNo ?? "无"),
_detailItem("MES数量", r.mesQty?.toString() ?? "无"),
_detailItem("MES生产日期", r.mesCreateTime ?? "无"),

          ],
        ),
      ),
    );
  }

  Widget _detailItem(String label, String value){
    return Padding(
      padding: const EdgeInsets.symmetric(vertical:6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width:90,child:Text("$label：",style: TextStyle(fontWeight: FontWeight.w500,fontSize:16))),
          Expanded(child:Text(value,style: TextStyle(fontSize:16))),
        ],
      ),
    );
  }
}
// ===================== 设置菜单主页 =====================
class SettingsMenuPage extends StatelessWidget {
  const SettingsMenuPage({super.key});

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
          _settingTile(
            context, icon: Icons.cloud_outlined, color: const Color(0xFF515BD4),
            title: "MES服务器设置", subtitle: "服务地址 / 账号登录 / 退出登录",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const MesSettingPage())),
          ),
          _settingTile(
            context, icon: Icons.volume_up_outlined, color: Colors.teal,
            title: "声音和震动设置", subtitle: "扫码成功提示音与震动开关",
            onTap: () => Navigator.push(context,
                MaterialPageRoute(builder: (_) => const SoundVibrationPage())),
          ),
          _settingTile(
            context, icon: Icons.phone_android_outlined, color: Colors.deepOrange,
            title: "WiFi局域网服务", subtitle: "开启后电脑浏览器下载采集CSV",
            onTap: () {
              // 通过回调方式不可靠，直接提示用户到"导出"菜单开启
              ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text("请在底部「导出」菜单中开启 WiFi 局域网服务")));
            },
          ),
          _settingTile(
            context, icon: Icons.info_outline, color: Colors.blueGrey,
            title: "关于", subtitle: "AGV货位采集器",
            onTap: () => showDialog(context: context, builder: (ctx) => AlertDialog(
              title: const Text("关于"),
              content: const Text("AGV货位采集器 v1.0\n适配工业PDA\n支持MES标签查询与整托合并采集"),
              actions: [TextButton(onPressed: ()=>Navigator.pop(ctx), child: const Text("关闭"))],
            )),
          ),
        ],
      ),
    );
  }

  Widget _settingTile(BuildContext context, {required IconData icon, required Color color,
      required String title, required String subtitle, required VoidCallback onTap}) {
    return Card(
      margin: const EdgeInsets.only(bottom:12),
      child: ListTile(
        leading: CircleAvatar(backgroundColor: color.withOpacity(0.12), child: Icon(icon, color: color)),
        title: Text(title, style: const TextStyle(fontSize:16, fontWeight: FontWeight.w500)),
        subtitle: Text(subtitle, style: TextStyle(fontSize:12, color: Colors.grey.shade600)),
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
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final s = await AppSettings.getSoundEnabled();
    final v = await AppSettings.getVibrationEnabled();
    setState(() { _sound = s; _vibration = v; _loaded = true; });
  }

  Future<void> _preview() async {
    if (_sound) await SystemSound.play(SystemSoundType.click);
    if (_vibration) {
      try { if ((await Vibration.hasVibrator()) ?? false) await Vibration.vibrate(duration: 120); } catch (_) {}
    }
  }

  @override
  Widget build(BuildContext context) {
    if (!_loaded) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    return Scaffold(
      appBar: AppBar(
        title: const Text("声音和震动设置"),
        backgroundColor: const Color(0xFF515BD4),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: SwitchListTile(
              title: const Text("扫码成功提示音", style: TextStyle(fontSize:16)),
              subtitle: const Text("每次采集保存成功后播放提示音", style: TextStyle(fontSize:12)),
              value: _sound,
              activeColor: const Color(0xFF515BD4),
              onChanged: (v) async {
                await AppSettings.setSoundEnabled(v);
                setState(() => _sound = v);
                if (v) await SystemSound.play(SystemSoundType.click);
              },
            ),
          ),
          Card(
            child: SwitchListTile(
              title: const Text("扫码成功震动", style: TextStyle(fontSize:16)),
              subtitle: const Text("每次采集保存成功后震动反馈", style: TextStyle(fontSize:12)),
              value: _vibration,
              activeColor: const Color(0xFF515BD4),
              onChanged: (v) async {
                await AppSettings.setVibrationEnabled(v);
                setState(() => _vibration = v);
                if (v) {
                  try { if ((await Vibration.hasVibrator()) ?? false) await Vibration.vibrate(duration: 120); } catch (_) {}
                }
              },
            ),
          ),
          const SizedBox(height:16),
          ElevatedButton.icon(
            style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade200, foregroundColor: Colors.black87, minimumSize: const Size(double.infinity, 48)),
            onPressed: _preview,
            icon: const Icon(Icons.play_arrow),
            label: const Text("试听测试（按当前开关反馈一次）"),
          ),
        ],
      ),
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
  // =========【独立提取到类顶层：获取公钥接口】=========
  Future<Map<String, String>?> getValidateKey2(String serverIp, String serverPort, String userId, int timeoutSec) async {
    try {
      final baseUrl = "http://$serverIp:$serverPort";
      final uri = Uri.parse("$baseUrl/platform/sign/getvalidatekey2?u=$userId&isweb=Y");
      final headers = {
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Culture": "zh-CN",
      };
      debugPrint("【阶段1】请求getvalidatekey2：$uri");
      // 增加timeout（解决问题4）
      final resp = await http.get(uri, headers: headers).timeout(Duration(seconds: timeoutSec));
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

  // ========== MES登录方法（放在State内部，与build平级） ==========
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
  final ip = hostCtrl.text.trim();
  final port = portCtrl.text.trim();
  String baseUrl = "http://$ip:$port";
  try {
    // =========阶段1：获取RSA公钥 KeyToken=========
    final validateResult = await getValidateKey2(ip, port, accountCtrl.text.trim(), timeoutSec);
    if(validateResult == null){
      throw Exception("阶段1失败：获取公钥接口返回空，请检查账号/服务器地址");
    }
    final String keyToken = validateResult["keyToken"]!;
    String pubPem = validateResult["publicKey"]!;
    debugPrint("【阶段2】开始RSA加密密码，原始PEM=$pubPem");
    // =====【诊断v2】全程收集关键数据，失败时弹窗展示，截图即可定位 =====
    final diag = StringBuffer();
    String hexOf(List<int> b, int n) =>
        b.take(n).map((x) => x.toRadixString(16).padLeft(2, '0')).join(' ');
    diag.writeln("【诊断v2】公钥长度=${pubPem.length}");
    diag.writeln("公钥原文(前100字符)=${pubPem.length > 100 ? pubPem.substring(0, 100) : pubPem}");
    // =========阶段2：RSA加密密码=========
    String encryptedPwd = "";
    try{
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
        diag.writeln("检测到双重base64→第二次解码后长度=${pemBytes.length} 前16字节=${hexOf(pemBytes, 16)}");
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
      diag.writeln("顶层元素数=${topElements.length} 类型=${topElements.map((x) => x.runtimeType).join(',')}");
      // SPKI第2个元素是BIT STRING：其value字节去掉首字节(unusedbits)才是内层RSAPublicKey
      final ASN1Sequence pubKeySeq;
      if (topElements[1] is ASN1BitString) {
        final bitString = topElements[1] as ASN1BitString;
        final innerDer = Uint8List.fromList(bitString.valueBytes!.sublist(1));
        diag.writeln("走SPKI分支 内层长度=${innerDer.length} 前16字节=${hexOf(innerDer, 16)}");
        pubKeySeq = ASN1Parser(innerDer).nextObject() as ASN1Sequence;
      } else {
        diag.writeln("走裸RSAPublicKey分支");
        pubKeySeq = topLevel; // 兜底：服务端直接返回RSAPublicKey结构
      }
      final pubElements = pubKeySeq.elements;
      if(pubElements == null || pubElements.length <2){
        throw Exception("公钥PEM解析失败：公钥序列元素不足");
      }
      diag.writeln("公钥序列元素数=${pubElements.length} 类型=${pubElements.map((x) => x.runtimeType).join(',')}");
      final int1 = pubElements[0] as ASN1Integer;
      final int2 = pubElements[1] as ASN1Integer;
      diag.writeln("元素0位数=${int1.integer?.bitLength} 元素1位数=${int2.integer?.bitLength}");
      // 按数值大小自动识别：模数n是大数，指数e通常是65537
      final BigInt n = (int1.integer! > int2.integer!) ? int1.integer! : int2.integer!;
      final BigInt e = (int1.integer! > int2.integer!) ? int2.integer! : int1.integer!;
      diag.writeln("最终采用 模数位数=${n.bitLength} 指数=$e");
      debugPrint("【阶段2】模数位数=${n.bitLength} 指数=$e");
      // ⚠️pointycastle的RSAPublicKey构造函数参数顺序是(modulus, exponent)——模数在前！
      // 之前误写成RSAPublicKey(e, n)，把17位的指数当成模数，导致"Input data too large"
      final pubKey = RSAPublicKey(n, e);
      // PKCS1-v1_5填充：直接实例化，不依赖注册表别名
      final cipher = PKCS1Encoding(RSAEngine())
        ..init(true, PublicKeyParameter<RSAPublicKey>(pubKey));
      // 执行加密并转为 Base64 字符串
      Uint8List dataRaw = Uint8List.fromList(utf8.encode(pwdCtrl.text.trim()));
      Uint8List encryptedRaw = cipher.process(dataRaw);
      encryptedPwd = base64.encode(encryptedRaw);
      debugPrint("【阶段2成功】加密完成，加密后密码：$encryptedPwd");
    }catch(e,stack){
      debugPrint("【阶段2 RSA加密异常】$e \n $stack");
      throw Exception("RSA加密失败：$e\n----诊断----\n$diag");
    }
    // =========阶段2结束=========
    // =========阶段3：提交登录请求，获取token=========
    debugPrint("【阶段3】请求登录接口 $baseUrl/platform/sign/signin2");
    final loginResp = await http.post(
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0 Safari/537.36 Edg/153.0.0",
      },
      body: jsonEncode([accountCtrl.text.trim(), encryptedPwd, keyToken]),
    ).timeout(Duration(seconds: timeoutSec));
    if (loginResp.statusCode != 200) {
      throw Exception("阶段3失败：登录接口Http状态码${loginResp.statusCode}，返回：${loginResp.body}");
    }
    final loginJson = jsonDecode(loginResp.body);
    if(loginJson["success"] != true){
      throw Exception("阶段3失败：登录接口success=false，返回内容：${loginResp.body}");
    }
    final dataObj = loginJson["data"];
    if (dataObj is! Map) {
      throw Exception("阶段3失败：返回的data不是对象：${loginResp.body}");
    }
    // ===== token获取：实测鼎捷MES把token放在 signin2 响应头 "token"(小写)，优先取头，再兜底体 =====
    String token = "";
    for (final h in ["token", "access-token", "accesstoken", "x-token", "x-access-token", "authorization"]) {
      final v = loginResp.headers[h];
      if (v != null && v.trim().isNotEmpty) {
        token = v.trim().replaceFirst(RegExp(r'^Bearer\s+', caseSensitive: false), '');
        debugPrint("【阶段3】token来自响应头 $h");
        break;
      }
    }
    if (token.isEmpty) {
      // 兜底：个别版本可能把token放在响应体
      for (final k in ["token", "Token", "access_token", "accessToken", "AccessToken"]) {
        final v = dataObj[k]?.toString();
        if (v != null && v.isNotEmpty) { token = v; break; }
      }
    }
    if (token.isEmpty) {
      final headerDump = loginResp.headers.entries.map((e) => "${e.key}: ${e.value}").join("\n");
      throw Exception("阶段3失败：登录成功但响应体和响应头都没找到token。\n----响应头----\n$headerDump");
    }
    _token = token;
    debugPrint("【阶段3成功】获取token：$token");

    // ===== 用户信息解析：兼容camelCase与服务器实际的snake_case =====
    String pick(List<String> keys) {
      for (final k in keys) {
        final v = dataObj[k]?.toString();
        if (v != null && v.isNotEmpty) return v;
      }
      return "";
    }
    final String userId = pick(["userId", "user_id", "UserInfoId", "userinfo_id"]);
    final String userName = pick(["userName", "user_name"]);
    final String displayName = pick(["displayName", "display_name"]);
    String orgId = pick(["orgId", "org_id"]);
    if (orgId.isEmpty && dataObj["organizations"] is List) {
      // 从组织列表取默认组织（is_default=true 或 str_default=Y）
      final orgs = dataObj["organizations"] as List;
      for (final o in orgs) {
        if (o is Map && (o["is_default"] == true || o["str_default"]?.toString() == "Y")) {
          orgId = o["id"]?.toString() ?? "";
          break;
        }
      }
      if (orgId.isEmpty && orgs.first is Map) {
        orgId = (orgs.first as Map)["id"]?.toString() ?? "";
      }
    }
    debugPrint("【阶段3】userId=$userId userName=$userName displayName=$displayName orgId=$orgId");
    // 网页端查询接口的 ModuleId 来自登录响应头，此处一并保存供 GetLableList 请求头使用
    final String loginModuleId = (loginResp.headers["moduleid"] ?? "").trim();
    debugPrint("【阶段3】响应头ModuleId=$loginModuleId");
    await MesConfig.saveLoginInfo(
      token: token,
      orgId: orgId,
      userId: userId,
      userName: userName,
      displayName: displayName,
      moduleId: loginModuleId,
    );
    await MesConfig.saveConfig(
      host: hostCtrl.text,
      port: portCtrl.text,
      account: accountCtrl.text,
      pwd: pwdCtrl.text,
      token: token,
      timeout: timeoutSec,
      moduleId: moduleIdCtrl.text.trim(),
      orgId: orgIdCtrl.text.trim(),
    );
    return true;
  } catch (e) {
    String errMsg = e.toString();
    debugPrint("MES登录异常:$errMsg");
    if(mounted){
      showDialog(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text("❌ 登录失败"),
          content: SingleChildScrollView(
            child: SelectableText(errMsg, style: const TextStyle(fontSize: 12)),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭")),
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
                  icon: Icon(_pwdVisible ? Icons.visibility : Icons.visibility_off),
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
                        final int timeoutSec = int.tryParse(timeoutCtrl.text) ?? 10;
                        final uri = Uri.parse("http://${hostCtrl.text}:${portCtrl.text}");
                        final client = HttpClient();
                        final req = await client.getUrl(uri).timeout(Duration(seconds: timeoutSec));
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
                        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                        TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认退出")),
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
