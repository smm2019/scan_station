part of 'main.dart';

// ===================== ㉖⑯ 网页控制台驾驶舱：PDA 内嵌全功能网页（站台看板/零件档案/流水追溯/导出/设备异常/控制后台） =====================
// 复用 AgvWebViewPage 的 token 注入模式：原生会话换发一枚不绑设备指纹的网页 token，
// 以 /console?t= 打开网页，网页 boot 自动接管登录态；手机竖屏/横屏自适应（网页本身已有响应式）。
class ConsoleWebPage extends StatefulWidget {
  const ConsoleWebPage({super.key});
  @override
  State<ConsoleWebPage> createState() => _ConsoleWebPageState();
}

class _ConsoleWebPageState extends State<ConsoleWebPage> {
  late final WebViewController _ctrl;
  bool _loading = true, _injected = false;
  String _err = "";

  @override
  void initState() {
    super.initState();
    _ctrl = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFF0B1220))
      ..setNavigationDelegate(NavigationDelegate(
        onPageStarted: (_) {
          if (mounted) setState(() => _loading = true);
        },
        onWebResourceError: (e) {
          if (e.errorCode >= -4) return; // 子资源小错忽略
          if (mounted)
            setState(() {
              _loading = false;
              _err = "页面加载失败：${e.description ?? "网络异常"}";
            });
        },
        onPageFinished: (_) {
          if (mounted) setState(() => _loading = false);
        },
      ));
    WidgetsBinding.instance.addPostFrameCallback((_) => _boot());
  }

  Future<void> _boot() async {
    setState(() {
      _err = "";
      _loading = true;
    });
    final base = (await AuthStore.serverUrl()).replaceFirst(RegExp(r"/+$"), "");
    if (base.isEmpty) {
      if (mounted) setState(() => _err = "未配置服务器地址（先去「MES服务器设置」）");
      return;
    }
    final j = await AuthApi.webSession();
    final tk = j["ok"] == true ? (j["token"] ?? "").toString() : "";
    if (tk.isEmpty || !mounted) {
      if (mounted) setState(() => _err = "会话换发失败：${j["msg"] ?? "请重新登录后再试"}");
      return;
    }
    _injected = true;
    await _ctrl
        .loadRequest(Uri.parse("$base/console?t=${Uri.encodeComponent(tk)}"));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
          title: const Text("📟 控制台驾驶舱",
              style: TextStyle(color: Colors.white, fontSize: 16)),
          backgroundColor: const Color(0xFF101A2E),
          iconTheme: const IconThemeData(color: Colors.white),
          actions: [
            IconButton(
                tooltip: "重新加载",
                icon: const Icon(Icons.refresh, color: Colors.white),
                onPressed: _boot),
          ]),
      body: Stack(children: [
        WebViewWidget(controller: _ctrl),
        if (_loading)
          const Center(child: CircularProgressIndicator(color: Colors.cyan)),
        if (_err.isNotEmpty)
          Container(
              color: const Color(0xE6101A2E),
              alignment: Alignment.center,
              child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.wifi_off,
                        color: Colors.orangeAccent, size: 40),
                    const SizedBox(height: 10),
                    Text(_err,
                        textAlign: TextAlign.center,
                        style:
                            const TextStyle(color: Colors.white, fontSize: 13)),
                    const SizedBox(height: 14),
                    TextButton(
                        onPressed: _boot,
                        child: const Text("重试",
                            style: TextStyle(color: Colors.cyan))),
                  ])))
      ]),
    );
  }
}
