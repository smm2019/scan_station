//相机扫码弹窗
void _openCameraScan() {
  bool scannedHandled = false;
  showDialog(
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
              _goodsInputCtrl.text = code;
              Navigator.pop(ctx);
              //短暂延时，等待弹窗销毁完成，再执行保存
              Future.delayed(const Duration(milliseconds:150),(){
                _saveRecord(code);
              });
            }
          },
        ),
      ),
      actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭"))],
    ),
  );
}