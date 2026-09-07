import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:csv/csv.dart';
import 'package:clipboard/clipboard.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:excel/excel.dart';
import 'package:isar/isar.dart';
import 'package:isar_flutter_libs/isar_flutter_libs.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:shelf/shelf.dart';
import 'package:shelf/shelf_io.dart' as shelf_io;
import 'package:shelf_cors_headers/shelf_cors_headers.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;
import 'package:vibration/vibration.dart';
import 'package:excel/excel.dart';
part 'main.g.dart';

//扫码记录数据库模型，版本固定适配Isar3.1
@collection
class ScanRecord {
  Id id = Isar.autoIncrement;
  late String barcode;
  late String remark;
  late int stationNo;
  late int timestamp;

  ScanRecord({
    required this.barcode,
    required this.remark,
    required this.stationNo,
    required this.timestamp,
  });
}

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Isar.initializeIsarCore(download: false);
  final Directory dir = await getApplicationDocumentsDirectory();
  await Isar.open([ScanRecordSchema], directory: dir.path);
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: "站台扫码工具",
      theme: ThemeData(primarySwatch: Colors.blue),
      home: const AppLockPage(),
      debugShowCheckedModeBanner: false,
    );
  }
}

//密码锁页面
class AppLockPage extends StatefulWidget {
  const AppLockPage({super.key});
  @override
  State<AppLockPage> createState() => _AppLockPageState();
}

class _AppLockPageState extends State<AppLockPage> {
  final TextEditingController _pwdCtrl = TextEditingController();
  String _savedPwd = "";

  @override
  void initState() {
    super.initState();
    _loadPassword();
  }

  Future<void> _loadPassword() async {
    final SharedPreferences sp = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _savedPwd = sp.getString("app_password") ?? "";
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_savedPwd.isEmpty) {
      return const ScanHomePage();
    }
    return Scaffold(
      appBar: AppBar(title: const Text("请输入应用密码")),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          children: [
            TextField(
              controller: _pwdCtrl,
              obscureText: true,
              decoration: const InputDecoration(labelText: "解锁密码"),
            ),
            const SizedBox(height: 20),
            ElevatedButton(
              onPressed: () async {
                if (_pwdCtrl.text == _savedPwd) {
                  Navigator.pushReplacement(
                    context,
                    MaterialPageRoute(builder: (_) => const ScanHomePage()),
                  );
                } else {
                  if (!mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("密码错误")));
                }
              },
              child: const Text("确认解锁"),
            ),
          ],
        ),
      ),
    );
  }
}

class ScanHomePage extends StatefulWidget {
  const ScanHomePage({super.key});
  @override
  State<ScanHomePage> createState() => _ScanHomePageState();
}

class _ScanHomePageState extends State<ScanHomePage> {
  late final Isar isar;
  final FlutterTts _tts = FlutterTts();
  final MobileScannerController _scanCtrl = MobileScannerController();

  int _selectStation = 1;
  bool _continuousScan = true;
  bool _multiSelectMode = false;
  final Set<int> _selectedIds = {};

  List<ScanRecord> _records = [];
  String _searchText = "";
  int? _filterStation;

  String _lastScanCode = "";
  int _lastScanTime = 0;
  static const int debounceMs = 1200;

  HttpServer? _wifiServer;
  String _wifiUrl = "";

  final TextEditingController _manualBarcodeCtrl = TextEditingController();
  final TextEditingController _manualRemarkCtrl = TextEditingController();
  final TextEditingController _pwdEditCtrl = TextEditingController();

  @override
  void initState() {
    super.initState();
    isar = Isar.getInstance()!;
    _tts.setLanguage("zh‑CN");
    _loadAllRecords();
    //PDA红外扫码监听，增加异常捕获，防止无PDA设备崩溃
    const MethodChannel pdaChannel = MethodChannel("com.pda.scanner/receiver");
    pdaChannel.setMethodCallHandler((call) async {
      try {
        if (call.method == "onBarcode") {
          final String code = call.arguments as String;
          await _handleNewBarcode(code);
        }
      } catch (_) {}
    });
  }

  Future<void> _loadAllRecords() async {
    final List<ScanRecord> rawList = await isar.scanRecords.where().findAll();
    List<ScanRecord> list = rawList.reversed.toList();

    if (_searchText.isNotEmpty) {
      list = list.where((r) => r.barcode.contains(_searchText) || r.remark.contains(_searchText)).toList();
    }
    if (_filterStation != null) {
      list = list.where((r) => r.stationNo == _filterStation).toList();
    }
    if (!mounted) return;
    setState(() => _records = list);
  }

  Future<void> _handleNewBarcode(String code) async {
    final int now = DateTime.now().millisecondsSinceEpoch;
    if (code == _lastScanCode && (now - _lastScanTime) < debounceMs) return;

    _lastScanCode = code;
    _lastScanTime = now;

    try {
      if (await Vibration.hasVibrator()) {
        Vibration.vibrate(duration: 80);
      }
    } catch (_) {}

    try {
      await _tts.speak(code);
    } catch (_) {}

    final ScanRecord rec = ScanRecord(
      barcode: code,
      remark: "",
      stationNo: _selectStation,
      timestamp: now,
    );
    await isar.writeTxn(() async => await isar.scanRecords.put(rec));
    await _loadAllRecords();

    if (!_continuousScan) {
      await _scanCtrl.stop();
    }
  }

  void _onBarcodeDetect(BarcodeCapture capture) {
    final Barcode? bc = capture.barcodes.firstOrNull;
    if (bc?.rawValue != null) {
      _handleNewBarcode(bc!.rawValue!);
    }
  }

  Future<void> _manualAddRecord() async {
    final String code = _manualBarcodeCtrl.text.trim();
    final String rem = _manualRemarkCtrl.text.trim();
    if (code.isEmpty) return;

    final ScanRecord rec = ScanRecord(
      barcode: code,
      remark: rem,
      stationNo: _selectStation,
      timestamp: DateTime.now().millisecondsSinceEpoch,
    );
    await isar.writeTxn(() async => await isar.scanRecords.put(rec));
    _manualBarcodeCtrl.clear();
    _manualRemarkCtrl.clear();
    await _loadAllRecords();
  }

  Future<void> _deleteSingle(int id) async {
    await isar.writeTxn(() async => await isar.scanRecords.delete(id));
    await _loadAllRecords();
  }

  Future<void> _batchDeleteSelected() async {
    await isar.writeTxn(() async {
      for (int id in _selectedIds) {
        await isar.scanRecords.delete(id);
      }
    });
    _selectedIds.clear();
    if (!mounted) return;
    setState(() => _multiSelectMode = false);
    await _loadAllRecords();
  }

  void _showClearAllDialog() {
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("确认清空全部记录？"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("取消")),
          TextButton(
            onPressed: () async {
              Navigator.pop(ctx);
              await isar.writeTxn(() async => await isar.scanRecords.clear());
              await _loadAllRecords();
            },
            style: ButtonStyle(foregroundColor: WidgetStateProperty.all(Colors.red)),
            child: const Text("确认清空"),
          ),
        ],
      ),
    );
  }

  Future<void> _copyAllToClipboard() async {
    String buffer = "";
    for (ScanRecord r in _records) {
      buffer += "${r.stationNo},${r.barcode},${r.remark}\n";
    }
    await FlutterClipboard.copy(buffer);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已全部复制至剪贴板，可直接粘贴WPS")));
  }

  Future<String?> _exportCsvFile() async {
    try {
      final DateTime now = DateTime.now();
      final String fileName = "scan_${now.year}${now.month}${now.day}_${now.hour}${now.minute}${now.second}.csv";
      List<List<dynamic>> dataRows = [["站台", "条码", "备注", "采集时间"]];
      for (ScanRecord r in _records) {
        dataRows.add([r.stationNo, r.barcode, r.remark, DateTime.fromMillisecondsSinceEpoch(r.timestamp).toString()]);
      }
      final String csvText = const ListToCsvConverter().convert(dataRows);
      final Directory? saveDir = await getExternalStorageDirectory();
      if (saveDir == null) return null;
      final File f = File(p.join(saveDir.path, fileName));
      await f.writeAsString(csvText);
      return f.path;
    } catch (_) {
      return null;
    }
  }

  Future<String?> _exportXlsxFile() async {
    try {
      final DateTime now = DateTime.now();
      final String fileName = "scan_${now.year}${now.month}${now.day}_${now.hour}${now.minute}${now.second}.xlsx";
      final Excel excel = Excel.createExcel();
      final Sheet sheet = excel["扫码记录"];
  sheet.appendRow([
  TextCellValue("站台"),
  TextCellValue("条码"),
  TextCellValue("备注"),
  TextCellValue("采集时间"),
]);
      for (ScanRecord r in _records) {
     sheet.appendRow([
  TextCellValue(r.stationNo.toString()),
  TextCellValue(r.barcode),
  TextCellValue(r.remark ?? ''),
  TextCellValue(DateTime.fromMillisecondsSinceEpoch(r.timestamp).toString()),
]);
      }
      final Directory? saveDir = await getExternalStorageDirectory();
      if (saveDir == null) return null;
      final File f = File(p.join(saveDir.path, fileName));
      await f.writeAsBytes(excel.encode()!);
      return f.path;
    } catch (_) {
      return null;
    }
  }

  Future<void> _startWifiServer() async {
    if (_wifiServer != null) return;
    try {
      final Handler handler = const Pipeline()
          .addMiddleware(corsHeaders())
          .addHandler((req) async {
        final csvPath = await _exportCsvFile();
        if (csvPath == null) return Response.internalServerError(body: "导出失败");
        final File f = File(csvPath);
        return Response.ok(await f.readAsBytes(), headers: {"Content‑Type": "text/csv", "Content‑Disposition": "attachment;filename=\"record.csv\""});
      });
      _wifiServer = await shelf_io.serve(handler, "0.0.0.0", 8080);
      _wifiUrl = "http://本机IP:8080";
      if (!mounted) return;
      setState(() {});
    } catch (_) {}
  }

  Future<void> _stopWifiServer() async {
    await _wifiServer?.close();
    _wifiServer = null;
    _wifiUrl = "";
    if (!mounted) return;
    setState(() {});
  }

  Future<void> _modifyAppPassword() async {
    final String newPwd = _pwdEditCtrl.text.trim();
    final SharedPreferences sp = await SharedPreferences.getInstance();
    await sp.setString("app_password", newPwd);
    _pwdEditCtrl.clear();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("密码已保存，留空即可关闭密码锁")));
  }

  @override
  void dispose() {
    _scanCtrl.dispose();
    _tts.stop();
    _stopWifiServer();
    _manualBarcodeCtrl.dispose();
    _manualRemarkCtrl.dispose();
    _pwdEditCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("站台扫码工具"),
        actions: [
          IconButton(onPressed: _copyAllToClipboard, icon: const Icon(Icons.copy)),
          IconButton(onPressed: _showClearAllDialog, icon: const Icon(Icons.delete_forever)),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            //站台选择
            const Text("选择站台（1‑8）", style: TextStyle(fontSize:16)),
            DropdownButton<int>(
              value: _selectStation,
              items: List.generate(8, (idx) => DropdownMenuItem(value: idx+1, child: Text("${idx+1}号站台"))),
              onChanged: (val) {
                if(val==null) return;
                setState(()=>_selectStation=val);
              },
            ),
            Row(
              children: [
                const Text("连续扫码"),
                Switch(value: _continuousScan, onChanged: (v)=>setState(()=>_continuousScan=v)),
              ],
            ),
            //扫码相机
            SizedBox(height:220,child:MobileScanner(controller:_scanCtrl,onDetect:_onBarcodeDetect)),
            //手动录入
            TextField(controller:_manualBarcodeCtrl,decoration:const InputDecoration(labelText:"手动输入条码")),
            TextField(controller:_manualRemarkCtrl,decoration:const InputDecoration(labelText:"备注信息")),
            ElevatedButton(onPressed:_manualAddRecord,child:const Text("手动添加记录")),
            const SizedBox(height:12),
            //搜索&筛选
            TextField(
              decoration:const InputDecoration(labelText:"搜索条码/备注"),
              onChanged:(s){_searchText=s;_loadAllRecords();},
            ),
            DropdownButton<int?>(
              value:_filterStation,
              hint:const Text("按站台筛选（不选=全部）"),
              items:[const DropdownMenuItem(value:null,child:Text("全部")),...List.generate(8,(i)=>DropdownMenuItem(value:i+1,child:Text("${i+1}站台")))],
              onChanged:(v){_filterStation=v;_loadAllRecords();},
            ),
            const SizedBox(height:10),
            Row(
              children:[
                ElevatedButton(onPressed:()async{await _exportCsvFile();},child:const Text("导出CSV")),
                const SizedBox(width:8),
                ElevatedButton(onPressed:()async{await _exportXlsxFile();},child:const Text("导出XLSX")),
              ],
            ),
            const SizedBox(height:10),
            _wifiServer==null
                ?ElevatedButton(onPressed:_startWifiServer,child:const Text("开启WiFi局域网下载"))
                :ElevatedButton(onPressed:_stopWifiServer,style:ElevatedButton.styleFrom(backgroundColor:Colors.orange),child:const Text("关闭WiFi服务")),
            Text(_wifiUrl),
            const SizedBox(height:10),
            TextField(controller:_pwdEditCtrl,decoration:const InputDecoration(labelText:"修改应用密码，留空关闭锁")),
            ElevatedButton(onPressed:_modifyAppPassword,child:const Text("保存密码设置")),
            const SizedBox(height:16),
            Row(
              mainAxisAlignment:MainAxisAlignment.spaceBetween,
              children:[
                Text("总记录：${_records.length}"),
                ElevatedButton(onPressed:()=>setState(()=>_multiSelectMode=!_multiSelectMode),child:Text(_multiSelectMode?"退出多选":"批量选择")),
              ],
            ),
            const SizedBox(height:8),
            if(_multiSelectMode)ElevatedButton(onPressed:_batchDeleteSelected,style:ElevatedButton.styleFrom(backgroundColor:Colors.red),child:const Text("删除选中项")),
            //记录列表
            ..._records.map((rec)=>ListTile(
              title:Text(rec.barcode),
              subtitle:Text("${rec.stationNo}站台｜备注：${rec.remark}"),
              trailing:_multiSelectMode
                  ?Checkbox(value:_selectedIds.contains(rec.id),onChanged:(ck){
                    if(ck==true){_selectedIds.add(rec.id);}else{_selectedIds.remove(rec.id);}
                    setState((){});
                  })
                  :Row(mainAxisSize:MainAxisSize.min,children:[IconButton(onPressed:()=>_deleteSingle(rec.id),icon:const Icon(Icons.delete)),]),
            )).toList(),
          ],
        ),
      ),
    );
  }
}
