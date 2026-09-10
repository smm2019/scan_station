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

class _MainPageState extends State<MainPage> {
  late Isar _isar;
  String? _currentBatchId;
  int _workType = 0; //0 AGV站台，1人工地面
  int? _selectedStation;
  String? _selectedGroundLoc;
  final TextEditingController _goodsInputCtrl = TextEditingController();
  final TextEditingController _remarkInputCtrl = TextEditingController();
  final List<String> _quickRemarkTags = ["完好", "外包装破损", "待复核", "空托"];
  String? _selectedQuickTag;

  List<ScanRecord> _recordList = [];
  bool _isSaving = false;

  //====本次新增：页面导航、批量导出多选集合====
  int _pageIndex = 0; //0采集主页，1历史批次页面
  List<String> _selectedBatchIds = [];

  final List<String> _locGroup = ["A", "B", "C", "D"];
  String _curLocGroup = "A";

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
          decoration: const InputDecoration(hintText="填写备注，例：3号库区 白班", border: OutlineInputBorder()),
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
      _selectedQuickTag = null;
      _remarkInputCtrl.clear();
      _pageIndex = 0; //切回采集主页
    });
    _refreshRecord();
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
        if(_workType ==0 && _selectedStation != null){
          BatchInfo? batch = await _getCurrentBatch();
          if(batch != null){
            List<int> mutableList = batch.usedStation.toList();
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
        _selectedQuickTag = null;
        _remarkInputCtrl.clear();
      });

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
    setState(() {
      _recordList = all;
    });
  }

  //====修改：支持多批次合并导出｜改动2：函数改为异步，移除同步查询
  Future<String> _generateCsvText({List<String>? targetBatchIds}) async {
    String header = "采集时间,作业类型,站台编号,地面货位编码,货物标签,备注\n";
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
      String st = r.stationNo?.toString() ?? "";
      String gl = r.groundLocation ?? "";
      String code = r.goodsCode;
      String rem = r.remark;
      content += "$timeStr,$wt,$st,$gl,$code,$rem\n";
    }
    return content;
  }

  Future<void> _saveCsvToFile({List<String>? batchIds}) async {
    String csvText = await _generateCsvText(targetBatchIds: batchIds);
    final dir = await getExternalStorageDirectory();
    if (dir == null) return;
    String suffix = batchIds!=null ? "多批次合并" : _currentBatchId;
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

  //====本次新增：历史批次页面====
  Widget _buildHistoryBatchPage(){
    return FutureBuilder<List<BatchInfo>>(
      future: _isar.batchInfos.where().findAll(),
      builder: (ctx,snap){
        if(!snap.hasData) return const Center(child: CircularProgressIndicator());
        final batches = snap.data!;
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(8.0),
              child: Row(
                children: [
                  ElevatedButton(
                    onPressed: ()async{
                      await _saveCsvToFile(batchIds: _selectedBatchIds);
                      setState(()=>_selectedBatchIds.clear());
                    },
                    child: const Text("批量导出选中批次"),
                  ),
                  const SizedBox(width:8),
                  Text("已选：${_selectedBatchIds.length}个"),
                ],
              ),
            ),
            Expanded(
              child: ListView.builder(
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
                      return CheckboxListTile(
                        title: Text("${b.batchId} ${b.isArchived?"【已归档】":"【进行中】"}"),
                        subtitle: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text("创建：${b.createTime.substring(0,16)}｜记录条数：$recCount"),
                            Text("批次备注：${b.batchRemark.isNotEmpty?b.batchRemark:"无备注"}"),
                          ],
                        ),
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
                        secondary: Row(
                          mainAxisSize:MainAxisSize.min,
                          children: [
                            //切换查看该批次
                            TextButton(onPressed:()async{
                              setState(() {
                                _currentBatchId = b.batchId;
                                _pageIndex =0;
                                _selectedStation=null;
                                _selectedGroundLoc=null;
                              });
                              await _refreshRecord();
                            },child:const Text("查看")),
                            //归档按钮，仅未归档可用
                            if(!b.isArchived)
                            TextButton(onPressed:()async{
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
                            },child:const Text("归档")),
                            //删除批次
                            TextButton(onPressed:()async{
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
                                }
                                setState((){});
                              }
                            },style:TextButton.styleFrom(foregroundColor:Colors.red),child:const Text("删除")),
                          ],
                        ),
                      );
                    },
                  );
                },
              ),
            ),
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
      //改动1：重构AppBar，适配PDA窄屏，按钮不会溢出消失
      appBar: AppBar(
        backgroundColor: Colors.blue,
        title: Text(_pageIndex ==1 ? "历史批次" : "AGV货位采集器"),
        actions: [
          TextButton(
            onPressed: _createNewBatch,
            child: const Text("新批次", style: TextStyle(color: Colors.white, fontSize: 14)),
          ),
          TextButton(
            onPressed: ()=>setState((){
              _pageIndex =1;
              _selectedBatchIds.clear();
            }),
            child: const Text("历史批次", style: TextStyle(color: Colors.white, fontSize: 14)),
          ),
          PopupMenuButton<String>(
            color: Colors.white,
            onSelected: (val) async {
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
            },
            itemBuilder: (ctx) => const [
              PopupMenuItem(value: "copy", child: Text("复制")),
              PopupMenuItem(value: "export", child: Text("导出文件")),
              PopupMenuItem(value: "wifi", child: Text("WiFi服务")),
            ],
          ),
        ],
      ),
      body: _pageIndex == 1 ? _buildHistoryBatchPage() : Padding(
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
