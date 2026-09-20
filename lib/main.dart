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
import 'dart:convert';
import 'dart:io';
// =========【改动1：新增权限依赖导入】=========
import 'package:permission_handler/permission_handler.dart';

import 'package:shared_preferences/shared_preferences.dart'; //新增导入
// =========【👉 在这里粘贴 RSA加密 + mesLogin 代码！！】=========
import 'dart:typed_data';

import 'package:pointycastle/pointycastle.dart' as pc;
import 'package:pointycastle/asymmetric/api.dart' as pc;

import 'package:asn1lib/asn1lib.dart';
import 'package:http/http.dart' as http;
import 'package:xml/xml.dart';

part 'main.g.dart';


/// 解析MES返回的 <RSAKeyValue> XML公钥，提取Modulus、Exponent，RSA PKCS#1 v1.5加密
String rsaEncryptXmlRsaKey(String plainText, String xmlBody) {
  final xmlDoc = XmlDocument.parse(xmlBody);
  // 提取Modulus、Exponent
  String modulusBase64 = xmlDoc.findAllElements("Modulus").first.text;
  String exponentBase64 = xmlDoc.findAllElements("Exponent").first.text;

  Uint8List modBytes = base64.decode(modulusBase64);
  Uint8List expBytes = base64.decode(exponentBase64);

  BigInt modulus = BigInt.parse(
    modBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
    radix: 16,
  );
  BigInt exponent = BigInt.parse(
    expBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join(),
    radix: 16,
  );

  pc.RSAPublicKey pubKey = pc.RSAPublicKey(modulus, exponent);
  final cipher = pc.AsymmetricBlockCipher('RSA/PKCS1');
  final pc.PublicKeyParameter param = pc.PublicKeyParameter(pubKey);
  cipher.init(true, param);
  Uint8List rawData = Uint8List.fromList(utf8.encode(plainText));
  Uint8List encryptedBytes = cipher.process(rawData);
  return base64.encode(encryptedBytes);
}

/// MES登录主流程
Future<String> mesLogin(String username, String password, String baseUrl) async {
  // 1. 获取XML格式RSA公钥
  final validateResp = await http.get(
    Uri.parse("$baseUrl/platform/sign/getvalidatekey2"),
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0",
    },
  );
  if(validateResp.statusCode != 200){
    throw Exception("获取公钥接口请求失败，http状态码：${validateResp.statusCode}");
  }
  // =========重点改动：返回是XML，不是JSON！=========
  String xmlContent = validateResp.body;
  String keyToken = "";
  // 部分MES接口XML里同时包含KeyToken节点，自行适配节点名
  try{
    final xmlDoc = XmlDocument.parse(xmlContent);
    keyToken = xmlDoc.findAllElements("KeyToken").first.text;
  }catch(e){
    throw Exception("XML解析KeyToken失败:$e");
  }
  // 密码RSA加密
  String encryptedPwd = rsaEncryptXmlRsaKey(password, xmlContent);

  // 2. 登录接口
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0",
    },
    body: jsonEncode([username, encryptedPwd, keyToken]),
  );
  if(loginResp.statusCode != 200){
    throw Exception("登录接口请求失败，http状态码：${loginResp.statusCode}");
  }
  final loginJson = jsonDecode(loginResp.body);
  String token = loginJson["data"]["token"];
  return token;
}
// =========【粘贴结束】=========

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

  //清除token
  static Future<void> clearToken() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(keyToken);
  }
}
// =========【MesConfig结束】=========
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
late Isar _globalIsar;
// ===================== 程序入口 =====================
void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Isar.initializeIsarCore(download: true);
  final dir = await getApplicationDocumentsDirectory();
  _globalIsar = await Isar.open(
    [ScanRecordSchema, BatchInfoSchema],
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

  HttpServer? _webServer;
  bool _webServiceRunning = false;
  String? _localIpAddress;
  static const int _webPort = 8090;
  @override
  void initState() {
    super.initState();
    _isar = _globalIsar;
    _loadLastBatch();
    _refreshRecord();
    //初始化Tab控制器
    _tabController = TabController(length: 2, vsync: this);
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
      if ((await Vibration.hasVibrator()) ?? false) {
        await Vibration.vibrate(duration: 80);
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
            .findFirst();
        if (existStationRecord != null) {
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

// ===================== MES接口请求【替换为GET版本，适配抓包接口】=====================
String? mesPartNo;
double? mesQty;
String? mesCreateTime;
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
  // 改为从配置读取，不再硬编码ModuleId/OrgId
  mesRequest.headers.set("ModuleId", mesCfg["moduleId"] ?? "");
  mesRequest.headers.set("OrgId", mesCfg["orgId"] ?? "");
  mesRequest.headers.set("ModulePage","/h5/pages/LABEL/MitemLabelQuery/index.html");
  mesRequest.headers.set("X-TZ-Offset","-480");
  mesRequest.headers.set("Token", token);
  mesRequest.headers.set("Accept","*/*");
  mesRequest.headers.set("Content-Type","application/json; charset=utf-8");

  final resp = await mesRequest.close();
  final respBody = await resp.transform(utf8.decoder).join();
  final Map<String,dynamic> mesJson = jsonDecode(respBody);
  //解析抓包返回的JSON结构
  if(mesJson["success"] == true && mesJson["data"] != null && mesJson["data"]["data"] != null){
    // 抓包返回 data.data 是单个对象，不是数组，修正此处！
    final row = mesJson["data"]["data"];
    mesPartNo = row["MITEM_CODE"]?.toString();
    mesQty = (row["QTY"] as num?)?.toDouble();
    mesCreateTime = row["DATETIME_CREATED"]?.toString();
  }
} catch (mesErr) {
  if(mounted){
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text("MES查询失败：${mesErr.toString()}，仅保存本地采集信息"))
    );
  }
  //MES查询失败，字段保留null，不阻断保存流程
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
_containerType = null; // 新增：保存成功，容器类型取消选中
if(_workType == 1){
          _selectedGroundLoc = null; // ✅人工模式，录入成功清空地面货位
        }
      });
      if(_workType ==0){
        setState((){
          _selectedStation = null;
        });
      }
      await _refreshRecord();
      await _refreshBatchStat();
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
  //====修改：支持多批次合并导出｜改动2：函数改为异步，移除同步查询
  Future<String> _generateCsvText({List<String>? targetBatchIds}) async {
  String header = "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期\n";


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
content += "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText,$pn,$qty,$pd\n";


    }
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
    final handler = Pipeline().addHandler((Request req) async {
      final csvContent = await _generateCsvText();
      return Response.ok(csvContent, headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": "attachment;filename=agv_data_${_currentBatchId}.csv"
      });
    });
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
                }).toList(),
              ),
            );
          }).toList(),
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
          )).toList(),
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
      future: _isar.batchInfos.where().findAll(),
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
                                          await _isar.scanRecords.filter().batchIdEqualTo(b.batchId).deleteAll();
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
      )),
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
      )),
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
  //跳转MES服务器配置页面
  Navigator.push(
    context,
    MaterialPageRoute(builder: (context)=>const MesSettingPage()),
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
  //【修改这里，增加MES三列】
  String header = "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态,MES零件号,MES数量,MES生产日期\n";
  String content = header;
  List<ScanRecord> targetRecords = _records;
  targetRecords.sort((a, b) => a.scanTime.compareTo(b.scanTime));
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
    content += "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText,$pn,$qty,$pd\n";
  }
  final dir = await getExternalStorageDirectory();
  if (dir == null) return;
  String filePath = "${dir.path}/采集_${widget.batch.batchId}.csv";
  File file = File(filePath);
  await file.writeAsString(content, encoding: utf8);
  if (mounted) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("文件已保存：$filePath")));
  }
}


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

  // ========== MES登录方法（放在State内部，与build平级） ==========
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
    debugPrint("【阶段1】开始请求获取公钥接口 $baseUrl/platform/sign/getvalidatekey2");
    final validateResp = await http.get(
      Uri.parse("$baseUrl/platform/sign/getvalidatekey2"),
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0",
      },
    ).timeout(Duration(seconds: timeoutSec));

    if (validateResp.statusCode != 200) {
      throw Exception("阶段1失败：获取公钥接口Http状态码${validateResp.statusCode}，返回：${validateResp.body}");
    }
final xmlDoc = XmlDocument.parse(validateResp.body);
String keyToken = xmlDoc.findAllElements("KeyToken").first.text;
debugPrint("【阶段1成功】XML解析公钥、keyToken完成");
  

    // =========阶段2：RSA加密密码=========
    debugPrint("【阶段2】开始RSA加密密码");
 
    String encryptedPwd = rsaEncryptXmlRsaKey(pwdCtrl.text.trim(), validateResp.body);
    debugPrint("【阶段2成功】加密完成，加密后密码：$encryptedPwd");

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
    if(loginJson["data"] == null || loginJson["data"]["token"] == null){
      throw Exception("阶段3失败：登录成功但是没有返回token，返回：${loginResp.body}");
    }
    String token = loginJson["data"]["token"];
    _token = token;
    debugPrint("【阶段3成功】获取token：$token");

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
    //弹窗展示详细错误信息
    if(mounted){
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text("❌登录失败：$errMsg"),
          duration: const Duration(seconds: 6),
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
          ],
        ),
      ),
    );
  }
}