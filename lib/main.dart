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

// ===================== Isar数据库模型 =====================
part 'main.g.dart';

@collection
class ScanRecord {
  Id id = Isar.autoIncrement;
  DateTime scanTime;
  int workType; //0=AGV站台模式，1=人工地面摆放模式
  String? stationNo; //【修改：由int?改为String，存储NB02-CK-05这类编码】
  String? groundLocation; //地面货位A1‑D18，仅模式1使用
  String goodsCode;
  String remark;
  String batchId;
  bool isCancel = false; //标记：true=人工作废，保留原始数据，仅业务失效，不可用于站台占用校验
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
      final rec = ScanRecord(
        scanTime: DateTime.now(),
        workType: _workType,
        stationNo: _workType == 0 ? _selectedStation : null,
        groundLocation: _workType == 1 ? _selectedGroundLoc : null,
        goodsCode: code,
        remark: finalRemark,
        batchId: _currentBatchId!,
containerType: _containerType,

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
   String header = "采集时间,作业类型,站台编号,地面货位编码,容器类型,货物标签,备注,记录状态\n";

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
      content += "$timeStr,$wt,$st,$gl,$container,$code,$rem,$statusText\n";

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
        //【优化三：水平滚动区域选择】
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child:Row(
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
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: List.generate(18, (i) {
            int n = i + 1;
            String locCode = "$_curLocGroup$n";
            bool isSelected = _selectedGroundLoc == locCode;
            return SizedBox(
              width: 42,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: isSelected ? Colors.blue : Colors.white,
                  foregroundColor: isSelected ? Colors.white : Colors.black,
                  elevation:2,
                ),
                onPressed: () => _selectGroundLoc(n),
                child: Text("$n",style: TextStyle(fontSize:16)),
              ),
            );
          }),
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
      physics: const AlwaysScrollableScrollPhysics(),
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
  //【新增：独立只读批次详情弹窗】
  Future<void> _showBatchReadOnlyDetail(BatchInfo targetBatch) async{
    List<ScanRecord> records = await _isar.scanRecords.filter().batchIdEqualTo(targetBatch.batchId).findAll();
    records.sort((a,b)=>b.scanTime.compareTo(a.scanTime));
    bool archived = targetBatch.isArchived;
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text("${targetBatch.batchId} ${archived ? "【已归档‑只读】" : "【进行中‑仅查看】"}"),
        content: SizedBox(
          width: double.maxFinite,
          height: 420,
          child: records.isEmpty
              ? const Center(child:Text("该批次暂无采集记录"))
              : ListView.builder(
                  itemCount: records.length,
                  itemBuilder: (c,idx){
                    var r = records[idx];
                    String posTxt = r.workType==0 ? "站台${r.stationNo}" : "货位${r.groundLocation}";
                    String timeTxt = r.scanTime.toString().substring(0,19);
                    return ListTile(
                      title: Text("货码：${r.goodsCode}｜$posTxt"),
                     subtitle: Text("采集时间：$timeTxt｜容器:${r.containerType ?? "未选择"}｜备注：${r.remark.isNotEmpty?r.remark:"无"}｜${r.isCancel?"⚠️已作废":"✅正常"}"),

                      trailing: (archived || r.isCancel)
                          ? null
                          : TextButton(
                              style:TextButton.styleFrom(foregroundColor:Colors.red),
                              onPressed:()async{
                                final confirm = await showDialog<bool>(context:context,builder:(cx)=>AlertDialog(title:const Text("删除记录"),content:const Text("确定删除本条采集记录？"),actions:[
                                  TextButton(onPressed:()=>Navigator.pop(cx,false),child:const Text("取消")),
                                  TextButton(onPressed:()=>Navigator.pop(cx,true),child:const Text("确认")),
                                ]));
                                if(confirm != true) return;
                                await _isar.writeTxn(()async{
                                  await _isar.scanRecords.delete(r.id);
                                  if(r.workType==0 && r.stationNo!=null){
                                    BatchInfo? b = await _isar.batchInfos.filter().batchIdEqualTo(targetBatch.batchId).findFirst();
                                    if(b!=null){
                                      List<String> mut = b.usedStation.toList();
                                      mut.remove(r.stationNo);
                                      b.usedStation = mut;
                                      await _isar.batchInfos.put(b);
                                    }
                                  }
                                });
                                Navigator.pop(ctx);
                              },
                              child:const Text("删除",style:TextStyle(fontSize:14)),
                            ),
                    );
                  }
                ),
        ),
        actions: [
          TextButton(onPressed:()async{
            await _saveCsvToFile(batchIds: [targetBatch.batchId]);
          }, child:const Text("导出本批次")),
          TextButton(onPressed:()=>Navigator.pop(ctx), child:const Text("返回")),
        ],
      ),
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
                                    onPressed:()async{
                                      await _showBatchReadOnlyDetail(b);
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
toolbarHeight: 15, // 原来标题没了，把顶部栏高度压低
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
      shape:RoundedRectangleBorder(borderRadius:BorderRadius.circular(12))
    ),
    onPressed: ()=>_createNewBatch(),
    child: const Text("+ 新建采集批次",style:TextStyle(fontSize:16)),
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
      _buildContainerButton(showText:"托盘",dbValue:"托盘"),
    ],
  ),
),
const SizedBox(height:12),

                const Text("选择货位 *",style: TextStyle(fontSize:16,fontWeight: FontWeight.w500)),
                const SizedBox(height:6),
                if (_workType == 0) _buildStationPanel(),
                if (_workType == 1) _buildGroundLocPanel(),
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
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxHeight: 420),
                    child: _buildRecordList(),
                  ),
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
          BottomNavigationBarItem(icon: Icon(Icons.home),label:"采集"),
          BottomNavigationBarItem(icon: Icon(Icons.download),label:"导出"),
          BottomNavigationBarItem(icon: Icon(Icons.settings),label:"设置"),
        ],
        currentIndex: 0,
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
          }else if(idx ==2){
            await showDialog(context: context, builder: (ctx)=>AlertDialog(
              title: const Text("设置"),
              content: const Text("可配置PDA扫码参数、导出格式"),
              actions: [TextButton(onPressed: ()=>Navigator.pop(ctx),child:const Text("关闭"))],
            ));
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
