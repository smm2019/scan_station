part of 'main.dart';

// ===================== ㉖v243 强制升级闸门（用户拍板：防拖延不更新导致旧版缺陷持续造数据） =====================
// 拦截层级=只拦进业务（取包/登录通道照常=绝不自锁死，实测 /api/app/download 走登录 token 天然满足）；
// 版本线=管理员参数 minBuild 手动定线（0=关，默认不拦任何人；传新包验证后再提线）；
// 断网容错=离线宽限：本机曾在"当时要求线"下达标过→连不上服务器照常干活，恢复后重校验。
class UpgradeGate {
  static int minBuild = 0; // 服务器下发（登录/心跳每次以服务器为准覆盖；0=闸门关）
  static bool _showing = false; // 同 build 只弹一页，心跳重复下发不叠页
  static const _kMin = 'gate_min_build'; // 最近一次服务器下发的线（重启/离线判据持久化）

  /// 服务器下发值入口（登录成功/心跳 _apply 调用）：达标记凭证；低于线弹全屏闸门
  static void check(int mb) {
    minBuild = mb; // 以服务器每次下发为准：0=关闸（管理员调回=立即失效），旧服务器无字段=0=无闸门
    final c = _globalNavigatorKey.currentContext;
    if (c != null) {
      unawaited(SharedPreferences.getInstance().then((sp) => sp.setInt(_kMin, mb))); // 线持久化：重启后离线判据仍知道线在哪
    }
    if (AppUpdater.localBuild >= mb) return;
    if (_showing || c == null) return;
    _showing = true;
    // 推一帧再 push：调用点可能处 setState 同帧（心跳/登录回调），防"build 中 push"竞态
    Future.delayed(Duration.zero, () {
      final ctx = _globalNavigatorKey.currentContext;
      if (ctx == null) { _showing = false; return; }
      Navigator.of(ctx).push(MaterialPageRoute(builder: (_) => const _UpgradeGatePage())).whenComplete(() => _showing = false);
    });
  }

  /// 网络异常分支的离线宽限判据（AuthGate 续期/心跳 net 分支调用，await 后方可 setState 导航）：
  /// 线持久化在 gate_min_build——断网/重启后仍知道线在哪；build≥线=照常干活（离线宽限本意），
  /// build<线=揣着旧包断网也绕不过闸；闸门从未开过（无字段/0）=无要求照常放行。
  static Future<bool> offlineOk() async {
    final sp = await SharedPreferences.getInstance();
    final line = sp.getInt(_kMin) ?? 0;
    if (line <= 0) return true; // 无闸门记录=无要求（新装/闸门从未开）
    return AppUpdater.localBuild >= line;
  }
}

class _UpgradeGatePage extends StatelessWidget {
  const _UpgradeGatePage();
  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false, // 闸门页禁返回键/侧滑——只拦业务，升级或等管理员关线前不放行
      child: Scaffold(
        backgroundColor: const Color(0xFFF3F4FB),
        body: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(26),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 46),
                const Icon(Icons.system_update, size: 64, color: Color(0xFF515BD4)),
                const SizedBox(height: 18),
                const Text("需要更新后才能继续使用",
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 21, fontWeight: FontWeight.w800, color: Color(0xFF232B4A))),
                const SizedBox(height: 10),
                Text("管理员已把最低可用版本提升到 v1.0.0+${UpgradeGate.minBuild}，\n当前设备版本 v${AppUpdater.localVersion}+${AppUpdater.localBuild} 存在已知问题，请更新后继续。",
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 13.5, height: 1.6, color: Color(0xFF5A6478))),
                const SizedBox(height: 30),
                FilledButton.icon(
                  style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, minimumSize: const Size.fromHeight(52)),
                  icon: const Icon(Icons.download_rounded),
                  label: const Text("立即更新", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
                  onPressed: () async {
                    final sp = await SharedPreferences.getInstance();
                    if (!context.mounted) return;
                    await AppUpdater._download(context, UpgradeGate.minBuild, sp); // 同库复用现成下载器（进度条+断点+调起安装）
                  },
                ),
                const SizedBox(height: 14),
                const Text("更新完成并重新打开 App 即自动放行；若服务器暂无新包，请联系管理员。",
                    textAlign: TextAlign.center,
                    style: TextStyle(fontSize: 11.5, color: Color(0xFF8A93A8))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
