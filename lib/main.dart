import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:csv/csv.dart';
import 'package:share_plus/share_plus.dart';
import 'package:flutter/services.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '站台扫码工具',
      theme: ThemeData(primarySwatch: Colors.blue),
      home: const ScanPage(),
    );
  }
}

class ScanRecord {
  final int station;
  final String code;
  final DateTime time;
  ScanRecord({required this.station, required this.code, required this.time});
}

class ScanPage extends StatefulWidget {
  const ScanPage({super.key});

  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  int? selectedStation;
  List<ScanRecord> records = [];
  bool isScanning = false;
  MobileScannerController scannerController = MobileScannerController();

  void onBarcodeDetect(BarcodeCapture capture) {
    if (!isScanning) return;
    final bar = capture.barcodes.firstOrNull;
    if (bar?.rawValue == null) return;
    final content = bar!.rawValue!;
    if(selectedStation == null){
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先选择站台1‑8")));
      return;
    }
    setState(() {
      records.add(ScanRecord(
        station: selectedStation!,
        code: content,
        time: DateTime.now(),
      ));
      isScanning = false;
    });
    scannerController.stop();
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("扫码成功：$content")));
  }

  Future<void> exportClipboard() async {
    List<List<dynamic>> csvData = [["站台","扫码内容","时间"]];
    for(var r in records){
      csvData.add([r.station, r.code, r.time.toString()]);
    }
    String csvStr = const ListToCsvConverter().convert(csvData);
    await Clipboard.setData(ClipboardData(text: csvStr));
    if(mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已复制全部数据到剪贴板")));
  }

  Future<void> exportFile() async {
    List<List<dynamic>> csvData = [["站台","扫码内容","时间"]];
    for(var r in records){
      csvData.add([r.station, r.code, r.time.toString()]);
    }
    String csvStr = const ListToCsvConverter().convert(csvData);
    await SharePlus.instance.share(text: csvStr, subject: "站台扫码记录.csv");
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text("站台扫码工具")),
      body: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text("选择站台(1‑8)", style: TextStyle(fontSize:16)),
            const SizedBox(height:8),
            Wrap(
              spacing:8,
              children: List.generate(8, (index){
                int s = index+1;
                return ElevatedButton(
                  style: ElevatedButton.styleFrom(
                    backgroundColor: selectedStation==s ? Colors.blue : Colors.grey,
                  ),
                  onPressed: ()=>setState(()=>selectedStation=s),
                  child: Text("$s号站台"),
                );
              }),
            ),
            const SizedBox(height:12),
            if(isScanning)
              SizedBox(height:220, child: MobileScanner(controller: scannerController, onDetect: onBarcodeDetect))
            else
              ElevatedButton(
                onPressed: selectedStation==null ? null : (){
                  setState(()=>isScanning=true);
                  scannerController.start();
                },
                child: const Text("开始扫码"),
              ),
            const SizedBox(height:12),
            Row(
              children: [
                ElevatedButton(onPressed: exportClipboard, child: const Text("导出剪贴板")),
                const SizedBox(width:10),
                ElevatedButton(onPressed: exportFile, child: const Text("导出表格文件")),
              ],
            ),
            const SizedBox(height:10),
            Expanded(
              child: records.isEmpty
                ? const Center(child: Text("暂无扫码记录"))
                : ListView.builder(
                  itemCount: records.length,
                  itemBuilder: (ctx,i){
                    var item = records[i];
                    return ListTile(
                      title: Text("${item.station}号站台 | ${item.code}"),
                      subtitle: Text(item.time.toString()),
                    );
                  },
                ),
            )
          ],
        ),
      ),
    );
  }

  @override
  void dispose() {
    scannerController.dispose();
    super.dispose();
  }
}