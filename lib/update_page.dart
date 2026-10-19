part of 'main.dart';

// ===================== ⑬ APK 自动更新：版本检查 + 下载进度 + 调起系统安装 =====================
class AppUpdater {
  static const localVersion = "1.0.0"; // 与 pubspec version 一致，发版同步改
  static const localBuild = 71; // 与 pubspec +N 一致，发版同步改
  static const _ch = MethodChannel("app.installer");
  static bool _asked = false;
  static void _m(String m, {bool err = true}) {
    final c = nav.currentContext;
    if (c != null) _toast(c, m, err: err);
  }

  static GlobalKey<NavigatorState> get nav => _globalNavigatorKey;

  /// 登录后延迟检查：有新版弹窗（下次再说/立即更新）；任何失败完全静默不打扰
  static Future<void> checkAtLaunch({bool manual = false}) async {
    if (!manual && _asked) return;
    _asked = true;
    try {
      final server = await AuthStore.serverUrl();
      if (server.isEmpty) {
        if (manual) _m("未配置服务器地址，无法检查更新");
        return;
      }
      final r = await http.get(Uri.parse("$server/api/app/version"), headers: {
        "Authorization": "Bearer ${await AuthStore.token()}"
      }).timeout(const Duration(seconds: 6));
      final j = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
      if (j["ok"] != true || j["has"] != true) {
        if (manual)
          _m(j["ok"] != true ? "检查失败：${j["msg"] ?? "服务器异常"}" : "服务器暂无可更新的安装包");
        return;
      }
      final build = (j["build"] as num?)?.toInt() ?? 0;
      // 本机基准：pubspec常量 与 上次成功调起安装的build 取大者（防更新后重复提示）
      final sp = await SharedPreferences.getInstance();
      if (build <= localBuild) {
        if (manual) _m("当前已是最新版本 v$localVersion+$localBuild", err: false);
        return;
      }
      final ctx = nav.currentContext;
      if (ctx == null) return;
      final mb = ((j["size"] as num?)?.toInt() ?? 0) / 1048576;
      final go = await showDialog<bool>(
          context: ctx,
          builder: (c) => AlertDialog(
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(16)),
                insetPadding:
                    const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
                title: Row(children: [
                  const Icon(Icons.system_update_alt,
                      color: Colors.blueGrey, size: 26),
                  const SizedBox(width: 8),
                  Expanded(
                      child: Text("发现新版本",
                          style: const TextStyle(
                              fontSize: 18, fontWeight: FontWeight.bold))),
                ]),
                content: SingleChildScrollView(
                    child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                      Row(children: [
                        Text("v${j["version"] ?? localVersion}+$build",
                            style: const TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.bold,
                                color: Color(0xFF1565C0))),
                        const SizedBox(width: 10),
                        Text("当前 v$localVersion+$localBuild",
                            style: const TextStyle(
                                fontSize: 13, color: Colors.grey)),
                      ]),
                      const SizedBox(height: 8),
                      Text(
                          "安装包大小约 ${mb.toStringAsFixed(1)} MB，建议在 WiFi/车间局域网环境下更新。",
                          style: const TextStyle(fontSize: 14, height: 1.5)),
                      const SizedBox(height: 6),
                      const Text("点「立即更新」后自动下载并调起安装，全程约 1 分钟，数据不会丢失。",
                          style: TextStyle(
                              fontSize: 13,
                              color: Colors.blueGrey,
                              height: 1.5)),
                    ])),
                actionsPadding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
                actions: [
                  // actions 容器(OverflowBar)不是 Flex，Expanded 必须包在 Row 里，否则 release 下 ParentData 类型错误直接崩
                  Row(children: [
                    Expanded(
                        child: OutlinedButton(
                            onPressed: () => Navigator.pop(c, false),
                            style: OutlinedButton.styleFrom(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 14),
                                side: const BorderSide(color: Colors.grey)),
                            child: const Text("下次再说",
                                style: TextStyle(fontSize: 15)))),
                    const SizedBox(width: 10),
                    Expanded(
                        flex: 2,
                        child: FilledButton(
                            onPressed: () => Navigator.pop(c, true),
                            style: FilledButton.styleFrom(
                                padding:
                                    const EdgeInsets.symmetric(vertical: 14),
                                backgroundColor: const Color(0xFF1565C0)),
                            child: const Text("立即更新",
                                style: TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.bold)))),
                  ]),
                ],
              ));
      if (go == true) await _download(ctx, build, sp);
    } catch (e) {
      if (manual) _m("检查更新失败：$e");
    }
  }

  static Future<void> _download(
      BuildContext context, int build, SharedPreferences sp) async {
    final server = await AuthStore.serverUrl();
    if (server.isEmpty) {
      _toast(context, "未配置服务器地址");
      return;
    }
    final dir = await getExternalStorageDirectory() ??
        await getApplicationDocumentsDirectory();
    final save = File("${dir.path}/update-release.apk");
    if (sp.getInt('dl_build') == build && await save.exists()) {
      final ok0 =
          await _ch.invokeMethod<bool>("installApk", {"path": save.path}) ??
              false;
      _toast(context,
          ok0 ? "已下载过，直接调起安装器，请在弹窗确认安装" : "调起安装失败，请手动安装 update-release.apk",
          err: !ok0);
      return;
    }
    try {
      if (save.existsSync()) save.deleteSync();
    } catch (_) {}
    final pct = ValueNotifier<List<double>>([-1, 0, 0]);
    var dlgClosed = false;
    unawaited(showDialog(
        context: context,
        barrierDismissible: false,
        builder: (_) => _DlDialog(pct)).then((_) => dlgClosed = true));
    try {
      final client = http.Client();
      final req = http.Request("GET", Uri.parse("$server/api/app/download"))
        ..headers["Authorization"] = "Bearer ${await AuthStore.token()}";
      final resp = await client.send(req).timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) {
        client.close();
        if (!dlgClosed) _pop();
        _toast(context, "下载失败：HTTP ${resp.statusCode}");
        return;
      }
      final total = int.tryParse(resp.headers["content-length"] ?? "") ?? 0;
      final sink = save.openWrite();
      var got = 0;
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        got += chunk.length;
        if (total > 0)
          pct.value = [got * 100.0 / total, got / 1048576.0, total / 1048576.0];
      }
      await sink.flush();
      await sink.close();
      client.close();
      pct.value = [100, got / 1048576.0, total / 1048576.0];
      await Future.delayed(const Duration(milliseconds: 400));
      if (!dlgClosed) _pop();
      final ok =
          await _ch.invokeMethod<bool>("installApk", {"path": save.path}) ??
              false;
      if (ok) await sp.setInt('dl_build', build);
      _toast(
          context, ok ? "已调起系统安装器，请在弹窗确认安装" : "调起安装失败，请手动安装 update-release.apk",
          err: !ok);
    } catch (e) {
      if (!dlgClosed) _pop();
      _toast(context, "更新失败：$e");
    }
  }

  static void _pop() {
    final c = nav.currentContext;
    if (c != null && Navigator.canPop(c)) Navigator.pop(c);
  }

  static void _toast(BuildContext c, String m, {bool err = true}) {
    if (!c.mounted) return;
    ScaffoldMessenger.of(c).showSnackBar(SnackBar(
        content: Text(m),
        backgroundColor: err ? Colors.red : Colors.green,
        duration: const Duration(seconds: 5)));
  }
}

class _DlDialog extends StatelessWidget {
  final ValueNotifier<List<double>> pct;
  const _DlDialog(this.pct);
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      title: Row(children: const [
        Icon(Icons.downloading, color: Color(0xFF1565C0), size: 26),
        SizedBox(width: 8),
        Text("正在下载更新",
            style: TextStyle(fontSize: 17, fontWeight: FontWeight.bold))
      ]),
      content: ValueListenableBuilder<List<double>>(
          valueListenable: pct,
          builder: (_, v, __) =>
              Column(mainAxisSize: MainAxisSize.min, children: [
                LinearProgressIndicator(
                    value: v[0] < 0 ? null : v[0] / 100,
                    minHeight: 14,
                    borderRadius: BorderRadius.circular(7)),
                const SizedBox(height: 10),
                Text(
                    v[0] < 0
                        ? "连接服务器…"
                        : "${v[0].toStringAsFixed(1)}%　已下载 ${v[1].toStringAsFixed(1)} / ${v[2] > 0 ? v[2].toStringAsFixed(1) : "?"} MB",
                    style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.bold,
                        color: Color(0xFF1565C0))),
                const SizedBox(height: 6),
                const Text("请勿退出应用，下载完成后自动调起安装",
                    style: TextStyle(fontSize: 12.5, color: Colors.grey)),
              ])),
    );
  }
}
