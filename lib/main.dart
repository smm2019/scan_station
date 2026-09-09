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
  int? stationNo; //站台5‑12，仅模式0使用
  String? groundLocation; //地面货位A1‑D18，仅模式1使用
  String goodsCode;
  String remark;
  String batchId;

  ScanRecord({
    required this.scanTime,
    required this.workType,
    this.stationNo,
    this.groundLocation,
    required this.goodsCode,
    required this.remark,
    required this.batchId,
  });
}

@collection
class BatchInfo {
  Id id = Isar.autoIncrement;
  String batchId;
  String createTime;
  List<int> usedStation = []; //本批次已经使用过的站台编号

  BatchInfo({
    required this.batchId,
    required this.createTime,
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

class _MainPageState extends State<MainPage> {
  late Isar _isar;
  String? _currentBatchId;
  int _workType = 0; //0 AGV站台，1人工地面
  int? _selectedStation;
  String? _selectedGroundLoc;
  final TextEditingController _goodsInputCtrl = TextEditingController();
  //====【本次新增：备注相关控制器与变量】====
  final TextEditingController _remarkInputCtrl = TextEditingController();
  final List<String> _quickRemarkTags = ["完好", "外包装破损", "待复核", "空托"];
  String? _selectedQuickTag;

  List<ScanRecord> _recordList = [];
  bool _isSaving = false; //新增：保存互斥锁

  //地面货位分组
  final List<String> _locGroup = ["A", "B", "C", "D"];
  String _curLocGroup = "A";

  //局域网Web服务
  HttpServer? _webServer;
  bool _webServiceRunning = false;
  String? _localIpAddress;
  static const int _webPort = 8090; //【修改】更换端口

  @override
  void initState() {
    super.initState();
    _isar = _globalIsar;
    _loadLastBatch();
    _refreshRecord();
  }

  //读取最近批次：内存排序，彻底避开Isar版本API差异
  Future<void> _loadLastBatch() async {
    List<BatchInfo> allBatch = await _isar.batchInfos.where().findAll();
    if(allBatch.isNotEmpty){
      allBatch.sort((a, b) => b.createTime.compareTo(a.createTime));
      setState(() {
        _currentBatchId = allBatch.first.batchId;
      });
    } else {
      await _createNewBatch();
    }
  }

  //新建批次，重置状态，关闭web服务
  Future<void> _createNewBatch() async {
    if (_webServiceRunning) {
      await stopWebService();
    }
    final nowStr = DateTime.now().toString().substring(0, 16).replaceAll(" ", "-").replaceAll(":", "");
    final newBatch = BatchInfo(batchId: "B$nowStr", createTime: DateTime.now().toString());
    await _isar.writeTxn(() async {
      await _isar.batchInfos.put(newBatch);
    });
    setState(() {
      _currentBatchId = newBatch.batchId;
      _selectedStation = null;
      _selectedGroundLoc = null;
      //新建批次清空备注
      _selectedQuickTag = null;
      _remarkInputCtrl.clear();
    });
    _refreshRecord();
  }

  Future<BatchInfo?> _getCurrentBatch() async {
    if (_currentBatchId == null) return null;
    return await _isar.batchInfos.filter().batchIdEqualTo(_currentBatchId!).findFirst();
  }

  //校验货码在本批次是否重复
  Future<bool> _isCodeDuplicate(String code) async {
    final exist = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .goodsCodeEqualTo(code)
        .findFirst();
    if (exist != null) {
      String posInfo = "";
      if (exist.workType == 0) {
        posInfo = "AGV站台${exist.stationNo}号";
      } else {
        posInfo = "人工货位${exist.groundLocation}";
      }
      if (mounted) {
        showDialog(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text("重复标签提示"),
            content: Text("该货码【${code}】已登记，位置：$posInfo"),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("确定"))],
          ),
        );
      }
      return true;
    }
    return false;
  }

  //扫码震动反馈
  Future<void> _scanSuccessAction() async {
    try {
      if ((await Vibration.hasVibrator()) ?? false) {
        await Vibration.vibrate(duration: 80);
      }
    } catch (_) {}
  }

  /// 新版逻辑：点击站台仅选中；扫码保存成功后站台才锁定占用并取消选中
  Future<void> _saveRecord(String code) async {
    if(_isSaving) return;
    _isSaving = true;
    try{
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

      //AGV模式校验：该站台是否已经登记过货物（一站一码）
      if (_workType == 0) {
        final existStationRecord = await _isar.scanRecords
            .filter()
            .batchIdEqualTo(_currentBatchId!)
            .stationNoEqualTo(_selectedStation)
            .findFirst();
        if (existStationRecord != null) {
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("${_selectedStation}号站台已登记货物，不可再次使用！")));
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

      //====【本次新增：拼接备注文本】====
      String finalRemark = "";
      if(_selectedQuickTag != null){
        finalRemark = _selectedQuickTag!;
      }
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
      );

      await _isar.writeTxn(() async {
        await _isar.scanRecords.put(rec);
        // ==========【核心修复】Isar读出的list是固定长度，必须toList复制可变列表 ==========
        if(_workType ==0 && _selectedStation != null){
          BatchInfo? batch = await _getCurrentBatch();
          if(batch != null){
            List<int> mutableList = batch.usedStation.toList(); //拷贝为可变列表
            if(!mutableList.contains(_selectedStation)){
              mutableList.add(_selectedStation!);
              batch.usedStation = mutableList; //赋值回对象
              await _isar.batchInfos.put(batch);
            }
          }
        }
      });

      await _scanSuccessAction();
      _goodsInputCtrl.clear();
      //保存后清空备注选择与自定义输入
      setState((){
        _selectedQuickTag = null;
        _remarkInputCtrl.clear();
      });

      //AGV模式保存成功后，手动清空选中站台
      if(_workType ==0){
        setState((){
          _selectedStation = null;
        });
      }

      await _refreshRecord();
      if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("采集保存成功")));
    }catch(e){
      if(mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("保存异常：${e.toString()}")));
    }finally{
      _isSaving = false;
    }
  }

  //【修复】调整赋值顺序，等待数据库校验完成后再变更状态，消除时序差
  Future<void> onStationTap(int stationNum) async {
    final batch = await _getCurrentBatch();
    if (batch == null) return;
    if (batch.usedStation.contains(stationNum)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("${stationNum}号站台已使用，无法选择！")));
      }
      return;
    }
    setState(() {
      _selectedStation = stationNum;
    });
  }

  //人工模式货位选择
  void _selectGroundLoc(int num) {
    setState(() {
      _selectedGroundLoc = "${_curLocGroup}${num}";
    });
  }

//刷新当前批次记录列表，内存排序，不移除选中状态
  Future<void> _refreshRecord() async {
    if (_currentBatchId == null) return;
    List<ScanRecord> all = await _isar.scanRecords
        .filter()
        .batchIdEqualTo(_currentBatchId!)
        .findAll();
    all.sort((a,b)=>b.scanTime.compareTo(a.scanTime));
    setState(() {
      _recordList = all;
    });
  }

  //生成CSV文本
  String _generateCsvText() {
    String header = "采集时间,作业类型,站台编号,地面货位编码,货物标签,备注\n";
    String content = header;
    for (var r in _recordList) {
      String timeStr = r.scanTime.toString().substring(0, 19);
      String wt = r.workType.toString();
      String st = r.stationNo?.toString() ?? "";
      String gl = r.groundLocation ?? "";
      String code = r.goodsCode;
      String rem = r.remark;
      content += "$timeStr,$wt,$st,$gl,$code,$rem\n";
    }
    return content;
  }

  //导出本地CSV文件
  Future<void> _saveCsvToFile() async {
    String csvText = _generateCsvText();
    final dir = await getExternalStorageDirectory();
    if (dir == null) return;
    String filePath = "${dir.path}/采集_${_currentBatchId}.csv";
    File file = File(filePath);
    await file.writeAsString(csvText, encoding: utf8);
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("文件已保存：$filePath")));
    }
  }

  // =========【改动2：完全重写该函数，过滤蜂窝网卡，只读取WiFi】=========
  Future<String?> _getLocalIp() async {
    try {
      final interfaces = await NetworkInterface.list(
        includeLoopback: false,
        includeLinkLocal: false,
      );
      for (var interface in interfaces) {
        final name = interface.name.toLowerCase();
        //rmnet代表移动蜂窝网络，直接跳过；仅保留wifi/wlan工业无线网卡
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

  // =========【改动3：函数开头增加Android14动态权限申请；同时修正响应头非法减号】=========
  Future<void> startWebService() async {
    if (_webServiceRunning) return;
    //Android14‑16工业PDA必备附近设备权限，用于读取WiFi网卡列表
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
      final csvContent = _generateCsvText();
      return Response.ok(csvContent, headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": "attachment;filename=agv_data_${_currentBatchId}.csv"
      });
    });
    try {
      // 关键改动：绑定0.0.0.0，监听全部网卡，不再仅绑定局域网IP
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

  //相机扫码弹窗：移除多余输入框赋值
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

  //修改3：站台更换为5‑12
  Widget _buildStationPanel() {
    return FutureBuilder<BatchInfo?>(
      future: _getCurrentBatch(),
      builder: (ctx, snapshot) {
        List<int> used = snapshot.data?.usedStation ?? [];
        List<int> stationList = [5,6,7,8,9,10,11,12];
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: stationList.map((num) {
            bool locked = used.contains(num);
            bool selected = _selectedStation == num;
            return SizedBox(
              width: 70,
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                  backgroundColor: locked ? Colors.amber.shade600 : (selected ? Colors.blueAccent : Colors.grey.shade400)
                ),
                onPressed: locked ? null : () => onStationTap(num),
                child: Text("$num号"),
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
        Row(
          children: _locGroup.map((g) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: ChoiceChip(
              label: Text(g),
              selected: _curLocGroup == g,
              onSelected: (s) => setState(() => _curLocGroup = g),
            ),
          )).toList(),
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

  //修改1：删除按钮改为文字【删除】；修改2：删除AGV记录自动释放站台
  Widget _buildRecordList() {
    return Expanded(
      child: ListView.builder(
        itemCount: _recordList.length,
        itemBuilder: (ctx, idx) {
          var r = _recordList[idx];
          String posTxt;
          if (r.workType == 0) {
            posTxt = "站台${r.stationNo}号";
          } else {
            posTxt = "货位${r.groundLocation}";
          }
          String timeTxt = r.scanTime.toString().substring(0, 19);
          return ListTile(
            title: Text("货码：${r.goodsCode}｜$posTxt"),
            subtitle: Text("采集时间：$timeTxt｜备注：${r.remark.isNotEmpty ? r.remark : "无"}"),
            trailing: TextButton(
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
                  // AGV记录：释放站台
                  if(r.workType ==0 && r.stationNo != null){
                    BatchInfo? batch = await _getCurrentBatch();
                    if(batch != null){
                      List<int> mutable = batch.usedStation.toList();
                      mutable.remove(r.stationNo);
                      batch.usedStation = mutable;
                      await _isar.batchInfos.put(batch);
                    }
                  }
                });
                await _refreshRecord();
              },
              child: const Text("删除",style: TextStyle(fontSize:14)),
            ),
          );
        },
      ),
    );
  }

  //=====【新增函数，修复CI报错】=====
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
  //====================================

  @override
  Widget build(BuildContext context) {
    return Scaffold(
    appBar: AppBar(
  backgroundColor: Colors.blue,
  // 移除title，全部使用文字按钮规避图标bug
  actions: [
    TextButton(
      onPressed: _createNewBatch,
      child: const Text(
        "新批次",
        style: TextStyle(color: Colors.white, fontSize: 14),
      ),
    ),
    TextButton(
      onPressed: () async {
        final csv = _generateCsvText();
        await Clipboard.setData(ClipboardData(text: csv));
      },
      child: const Text(
        "复制",
        style: TextStyle(color: Colors.white, fontSize: 14),
      ),
    ),
    TextButton(
      onPressed: _exportCsvFile,
      child: const Text(
        "导出文件",
        style: TextStyle(color: Colors.white, fontSize: 14),
      ),
    ),
    TextButton(
      onPressed: _toggleWifiServer,
      child: const Text(
        "WiFi服务",
        style: TextStyle(color: Colors.white, fontSize: 14),
      ),
    ),
  ],
),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Text("作业模式："),
                const SizedBox(width: 10),
                ChoiceChip(
                  label: const Text("AGV站台模式"),
                  selected: _workType == 0,
                  onSelected: (s) => setState(() {
                    _workType = 0;
                    _selectedGroundLoc = null;
                  }),
                ),
                const SizedBox(width: 8),
                ChoiceChip(
                  label: const Text("人工地面摆放"),
                  selected: _workType == 1,
                  onSelected: (s) => setState(() {
                    _workType = 1;
                    _selectedStation = null;
                  }),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (_workType == 0) _buildStationPanel(),
            if (_workType == 1) _buildGroundLocPanel(),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _goodsInputCtrl,
                    decoration: const InputDecoration(hintText: "PDA红外扫码自动填入，也可手动输入货码", border: OutlineInputBorder()),
                    onSubmitted: (txt) {
                      WidgetsBinding.instance.addPostFrameCallback((_) async {
                        String code = txt.trim();
                        if (code.isNotEmpty) await _saveRecord(code);
                      });
                    },
                  ),
                ),
                const SizedBox(width: 8),
                ElevatedButton(onPressed: _openCameraScan, child: const Text("相机扫码")),
              ],
            ),
            //====【本次新增：备注快捷标签+自定义输入区域】====
            const SizedBox(height:10),
            const Text("备注标签："),
            const SizedBox(height:6),
            Wrap(
              spacing:6,
              children:_quickRemarkTags.map((tag)=>ChoiceChip(
                label:Text(tag),
                selected:_selectedQuickTag==tag,
                onSelected:(sel){
                  setState(() {
                    if(sel){
                      _selectedQuickTag=tag;
                    }else{
                      _selectedQuickTag=null;
                    }
                  });
                },
              )).toList(),
            ),
            const SizedBox(height:8),
            TextField(
              controller:_remarkInputCtrl,
              decoration:const InputDecoration(hintText:"自定义补充备注（可选）",border:OutlineInputBorder(),isDense:true),
            ),
            //=============================================
            const SizedBox(height: 12),
            const Divider(),
            const Text("本批次采集记录"),
            _buildRecordList()
          ],
        ),
      ),
    );
  }
}
