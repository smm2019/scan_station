part of 'main.dart';

// ===================== ⑬ APK 自动更新：版本检查 + 下载进度 + 调起系统安装 =====================
class AppUpdater {
  static const localVersion = "1.0.0"; // 与 pubspec version 一致，发版同步改
  static const localBuild = 18;         // 与 pubspec +N 一致，发版同步改
  static const _ch = MethodChannel("app.installer");
  static bool _asked = false;
  static void _m(String m, {bool err = true}) { final c = nav.currentContext; if (c != null) _toast(c, m, err: err); }

  static GlobalKey<NavigatorState> get nav => _globalNavigatorKey;

  /// 登录后延迟检查：有新版弹窗（下次再说/立即更新）；任何失败完全静默不打扰
  static Future<void> checkAtLaunch({bool manual = false}) async {
    if (!manual && _asked) return;
    _asked = true;
    try {
      final server = await AuthStore.serverUrl();
      if (server.isEmpty) { if (manual) _m("未配置服务器地址，无法检查更新"); return; }
      final r = await http.get(Uri.parse("$server/api/app/version"), headers: {"Authorization": "Bearer ${await AuthStore.token()}"})
          .timeout(const Duration(seconds: 6));
      final j = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
      if (j["ok"] != true || j["has"] != true) { if (manual) _m(j["ok"] != true ? "检查失败：${j["msg"] ?? "服务器异常"}" : "服务器暂无可更新的安装包"); return; }
      final build = (j["build"] as num?)?.toInt() ?? 0;
      // 本机基准：pubspec常量 与 上次成功调起安装的build 取大者（防更新后重复提示）
      final sp = await SharedPreferences.getInstance();
      if (build <= localBuild) { if (manual) _m("当前已是最新版本 v$localVersion+$localBuild", err: false); return; }
      final ctx = nav.currentContext;
      if (ctx == null) return;
      final mb = ((j["size"] as num?)?.toInt() ?? 0) / 1048576;
      final go = await showDialog<bool>(context: ctx, builder: (c) => AlertDialog(
        title: const Text("发现新版本"),
        content: Text("v${j["version"] ?? localVersion}+$build（当前 v$localVersion+$localBuild · ${mb.toStringAsFixed(1)} MB）\n\n建议更新以获得最新功能与修复。"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text("下次再说")),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text("立即更新")),
        ],
      ));
      if (go == true) await _download(ctx, build, sp);
    } catch (e) { if (manual) _m("检查更新失败：$e"); }
  }

  static Future<void> _download(BuildContext context, int build, SharedPreferences sp) async {
    final server = await AuthStore.serverUrl();
    if (server.isEmpty) { _toast(context, "未配置服务器地址"); return; }
    final dir = await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory();
    final save = File("${dir.path}/update-release.apk");
    if (sp.getInt('dl_build') == build && await save.exists()) {
      final ok0 = await _ch.invokeMethod<bool>("installApk", {"path": save.path}) ?? false;
      _toast(context, ok0 ? "已下载过，直接调起安装器，请在弹窗确认安装" : "调起安装失败，请手动安装 update-release.apk", err: !ok0);
      return;
    }
    try { if (save.existsSync()) save.deleteSync(); } catch (_) {}
    final pct = ValueNotifier<double>(-1);
    var dlgClosed = false;
    unawaited(showDialog(context: context, barrierDismissible: false, builder: (_) => _DlDialog(pct)).then((_) => dlgClosed = true));
    try {
      final client = http.Client();
      final req = http.Request("GET", Uri.parse("$server/api/app/download"))..headers["Authorization"] = "Bearer ${await AuthStore.token()}";
      final resp = await client.send(req).timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) { client.close(); if (!dlgClosed) _pop(); _toast(context, "下载失败：HTTP ${resp.statusCode}"); return; }
      final total = int.tryParse(resp.headers["content-length"] ?? "") ?? 0;
      final sink = save.openWrite();
      var got = 0;
      await for (final chunk in resp.stream) {
        sink.add(chunk); got += chunk.length;
        if (total > 0) pct.value = got * 100.0 / total;
      }
      await sink.flush(); await sink.close(); client.close();
      pct.value = 100;
      await Future.delayed(const Duration(milliseconds: 400));
      if (!dlgClosed) _pop();
      final ok = await _ch.invokeMethod<bool>("installApk", {"path": save.path}) ?? false;
      if (ok) await sp.setInt('dl_build', build);
      _toast(context, ok ? "已调起系统安装器，请在弹窗确认安装" : "调起安装失败，请手动安装 update-release.apk", err: !ok);
    } catch (e) {
      if (!dlgClosed) _pop();
      _toast(context, "更新失败：$e");
    }
  }

  static void _pop() { final c = nav.currentContext; if (c != null && Navigator.canPop(c)) Navigator.pop(c); }
  static void _toast(BuildContext c, String m, {bool err = true}) {
    if (!c.mounted) return;
    ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.red : Colors.green, duration: const Duration(seconds: 5)));
  }
}

class _DlDialog extends StatelessWidget {
  final ValueNotifier<double> pct;
  const _DlDialog(this.pct);
  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text("正在下载更新"),
      content: ValueListenableBuilder<double>(valueListenable: pct, builder: (_, v, __) => Column(mainAxisSize: MainAxisSize.min, children: [
        LinearProgressIndicator(value: v < 0 ? null : v / 100, minHeight: 10),
        const SizedBox(height: 8),
        Text(v < 0 ? "连接服务器…" : "已完成 ${v.toStringAsFixed(1)}%", style: const TextStyle(fontSize: 12, color: Colors.blueGrey)),
      ])),
    );
  }
}
