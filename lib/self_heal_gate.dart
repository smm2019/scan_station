part of 'main.dart';

// ===================== ㉖v283 系统自愈门禁（SelfHealGate）=====================
// 需求：系统崩溃/断网/断电重启期间，PDA 全屏显示"系统自愈中"并禁止一切操作，自愈成功后才放行。
// 权威判据在服务端（/api/health 的 boot 就绪状态机），本门禁只负责：探活→渲染状态→锁/放。
//
// 三层防护，缺一即漏（对应"数据安全 > 可用性 > 便利"）：
//  ① 服务端 503 硬闸：自愈期业务接口一律拒（防旧版 APK/直接调接口绕过客户端锁）——真正的数据闸在服务端。
//  ② 本门禁全屏覆盖页：视觉锁 + 吞掉所有交互（PopScope 禁返回/侧滑）。
//  ③ _saveRecord 等业务入口硬拦截：扫码枪直触保存不经 UI，必须在数据写入点也挡（SelfHealGate.blocked）。
//
// 断网口径（现场拍板，2026-11-27）：断网与崩溃同等全锁——离线分不了格（服务器原子占位）、MES 交不上、
//  跨设备查重降级只查本机，扫了必白干或产脏数据。故断网禁一切录入/提交；已落本机待推队列的记录原样保留，
//  锁页显示待推条数，恢复后自动上账，不清本地、不要求重扫这部分。
class SelfHealGate {
  // ---- 状态（供 UI 与业务入口同步读取，无需 await）----
  static bool blocked = true; // fail-safe 默认锁：首次探活确认服务器就绪才放行，堵住"冷启动首次探活返回前"的扫码空窗（服务端 503 之外的第二道）
  static String mode = 'ok'; // ok=正常 | healing=自愈中(服务器应答但 boot.ready=false) | waiting=等待服务(连不上)
  static List<String> pending = []; // 未完成的自愈步骤（中文标签，来自服务端 boot.pending）
  static int total = 0; // 总步骤数（boot.total）
  static int done = 0; // 已完成数 = total - pending.length
  static Map? recovered; // 数据回滚取证（boot.recovered：from/reason/emptyDb）
  static bool agvDown = false; // RCS 通道断（boot.rcs.down）：仅禁 AGV 动作，不全锁
  static bool rescueLimited = false; // 看门狗限速停救（boot.rescue.limited）：锁页转"人工介入"且永不自动解锁
  static int ageSec = 0; // 服务端本次启动至今秒数（用于"已等待"计时基线）

  // ---- 探活节奏与防抖 ----
  static Timer? _timer;
  static int _netFailStreak = 0; // 连续连不上计数（达阈值才进 waiting，防 Wi-Fi 漫游瞬断弹全屏）
  static int _readyStreak = 0; // 连续 ready 计数（达 2 次才解锁，防半就绪抖动放进业务）
  static bool _everOk = false; // 本次进程是否成功探活过：冷启动即失联时【立即锁】，不等 3 次阈值
  static bool _everUnlocked = false; // 是否已放行过一次：放行后转"连续2次确认"防抖，冷启动首次放行走决定性快速路径
  static DateTime? _lockSince; // 本地锁定起始时刻（已等待计时用；服务端 ageSec 为基线，本地兜底断网场景）
  static bool _showing = false; // 同态只弹一页，重复探活不叠页
  static const int _netFailThreshold = 3; // 连续 3 次探活失败（约 15 秒）才判 waiting
  static const int _readyThreshold = 2; // 连续 2 次 ready（约 6 秒）才解锁

  /// 启动周期探活（MainPage.initState 调用）。5 秒一轮：够快感知自愈完成，又不至于压垮服务器。
  static void start() {
    stop();
    unawaited(_probe()); // 立即探一次，冷启动即知状态
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => unawaited(_probe()));
  }

  static void stop() {
    _timer?.cancel();
    _timer = null;
  }

  /// 单次探活：读 /api/health → 更新状态 → 决定锁/放/覆盖页
  static Future<void> _probe() async {
    Map r;
    try {
      r = await AuthApi.health();
    } catch (_) {
      r = {"ok": false, "net": true};
    }

    final boot = (r["ok"] == true && r["boot"] is Map) ? Map.from(r["boot"]) : null;

    // ㉖v283 修正（11-27 现场误锁实锤）：服务器【应答正常但无 boot 字段】=旧版服务器
    // （v283 之前，无自愈硬闸，业务完全可用）→ 视为就绪、放行，不锁。
    // 旧逻辑把"200 无 boot"落进下方失联分支，新 APK 遇未重启的旧服务会被误锁"等待服务恢复中"——
    // 与网页端同根因（发版错位窗口：网页/APK 先更新，服务进程后重启）。
    if (r["ok"] == true && boot == null) {
      _netFailStreak = 0;
      _everOk = true;
      recovered = null;
      rescueLimited = false;
      agvDown = false;
      if (blocked) {
        _unlock(); // 旧服务器无自愈概念=完全可用，立即放行
      } else {
        _setMode('ok');
      }
      return;
    }

    if (boot != null) {
      // 服务器应答：以 boot 就绪状态机为唯一权威
      _netFailStreak = 0;
      _everOk = true; // 标记本进程已成功探活过（此后短抖动才用 3 次阈值防误锁）
      total = (boot["total"] as num?)?.toInt() ?? 0;
      pending = (boot["pending"] as List?)?.map((e) => e.toString()).toList() ?? [];
      done = total > 0 ? (total - pending.length) : 0;
      recovered = boot["recovered"] is Map ? Map.from(boot["recovered"]) : null;
      rescueLimited = boot["rescue"] is Map && (boot["rescue"]["limited"] == true);
      ageSec = (boot["ageSec"] as num?)?.toInt() ?? 0;
      final rcs = boot["rcs"] is Map ? Map.from(boot["rcs"]) : null;
      agvDown = rcs != null && rcs["down"] == true;
      final ready = boot["ready"] == true;

      if (ready) {
        _readyStreak++;
        // 首次探活决定性：冷启动服务器本就正常时，第一次探到 ready 立即放行——
        // 不为"连续2次确认"多等一轮（否则 fail-safe 默认锁会让正常启动出现约6秒"无遮罩却拒扫"的困惑态）。
        // 连续2次确认仅用于运行中 healing→ready 的抖动切换（防半就绪放进业务）。
        final firstProbeDecisive = !_everUnlocked && _readyStreak == 1;
        if ((firstProbeDecisive || _readyStreak >= _readyThreshold) && blocked) {
          _unlock();
        } else if (!blocked) {
          _setMode('ok'); // 正常态：不锁，保持 agvDown 供分级禁用 AGV 动作
        }
      } else {
        _readyStreak = 0;
        _lock('healing'); // 应答但未就绪=自愈中，立即锁
      }
      return;
    }

    // 连不上服务器（net 或无 boot 字段）
    _readyStreak = 0;
    _netFailStreak++;
    // 冷启动即失联（本进程从未探活成功）=立即锁：不给"启动后十几秒空窗"留录入机会（数据安全优先）。
    // 已探活成功过后的短抖动才用 3 次阈值防误锁（现场 Wi-Fi 漫游常见）。
    if (!_everOk || _netFailStreak >= _netFailThreshold) {
      _lock('waiting'); // 持续失联=等待服务恢复
    }
    // 未达阈值：维持现状（正常态下短抖动不惊扰；已锁态下继续锁）
  }

  static void _setMode(String m) {
    if (mode == m) return;
    mode = m;
  }

  /// 进入锁定：置 blocked、记起始时刻、弹全屏覆盖页
  static void _lock(String m) {
    _setMode(m);
    if (!blocked) {
      blocked = true;
      _lockSince = DateTime.now();
    }
    _showOverlay();
  }

  /// 解锁：清 blocked、关覆盖页、静默拉取权威数据（复用 v107"拉取即自愈"通道）
  static void _unlock() {
    blocked = false;
    _everUnlocked = true; // 已放行过一次：此后 healing→ready 切换走"连续2次确认"防抖，不再走首次决定性快速路径
    _readyStreak = 0;
    _netFailStreak = 0;
    _lockSince = null;
    _setMode('ok');
    _hideOverlay();
    // 解锁瞬间补推积压 + 拉权威数据，避免用户对着断网前的旧界面继续操作
    try {
      if (scanPushPending) unawaited(scanPushNow());
      if (ledgerPushPending) unawaited(ledgerPushNow());
    } catch (_) {}
    // 通知主页刷新（清掉可能残留的过期行/冲突指纹）
    try { kSelfHealUnlocked.value = DateTime.now().millisecondsSinceEpoch; } catch (_) {}
  }

  /// 已锁定时长（秒）：优先用服务端 ageSec（本次启动至今），断网无服务端数据时用本地 _lockSince
  static int lockedSeconds() {
    if (mode == 'healing' && ageSec > 0) return ageSec;
    final s = _lockSince;
    if (s == null) return 0;
    return DateTime.now().difference(s).inSeconds;
  }

  static String _fmtDuration(int sec) {
    if (sec < 0) sec = 0;
    final m = sec ~/ 60, s = sec % 60;
    return m > 0 ? '$m 分 $s 秒' : '$s 秒';
  }

  // ---- 覆盖页管理（用全局导航键 push 全屏路由，与 UpgradeGate 同通道但独立标志防叠页）----
  static Route? _overlayRoute;
  static void _showOverlay() {
    if (_showing) { _refreshOverlay(); return; }
    final nav = _globalNavigatorKey.currentState;
    if (nav == null) return;
    _showing = true;
    Future.delayed(Duration.zero, () {
      final n = _globalNavigatorKey.currentState;
      if (n == null) { _showing = false; return; }
      final route = MaterialPageRoute(
        fullscreenDialog: true,
        builder: (_) => const _SelfHealPage(),
      );
      _overlayRoute = route;
      n.push(route).whenComplete(() { _showing = false; _overlayRoute = null; });
    });
  }

  static void _hideOverlay() {
    final nav = _globalNavigatorKey.currentState;
    final route = _overlayRoute;
    if (nav != null && route != null && route.isActive) {
      nav.removeRoute(route);
    }
    _overlayRoute = null;
    _showing = false;
  }

  // 覆盖页在锁定期内每秒刷新计时与清单（不重建路由，只通知 State）
  static final ValueNotifier<int> _tick = ValueNotifier<int>(0);
  static void _refreshOverlay() { _tick.value++; }

  // ---- UI 片段（供 _SelfHealPage 渲染；与 SelfHealGate 状态同源）----

  /// 全部自愈步骤的中文标签全集，必须与服务端 BOOT_STEPS 一致（server.js:145 附近）。
  /// 服务端只下发 pending（未完成项），前端用全集对照 pending 渲染"已完成✔/进行中…"清单。
  static const List<String> _allStepLabels = [
    '数据库加载与启动自愈',
    '当日备份与安全副本',
    '出库台账补建与键名归一',
    '粗码滞留巡检',
    '全量巡检',
    '账实不变量自检',
    '失联设备清扫',
  ];

  static List<Widget> _allStepsWidgets() {
    final pendingSet = pending.toSet();
    final out = <Widget>[];
    for (final label in _allStepLabels) {
      final isDone = !pendingSet.contains(label);
      out.add(Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Icon(isDone ? Icons.check_circle_rounded : Icons.radio_button_unchecked,
                size: 18, color: isDone ? const Color(0xFF2E9E4F) : const Color(0xFFB9BFD6)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(label,
                  style: TextStyle(
                      fontSize: 13,
                      color: isDone ? const Color(0xFF5A6478) : const Color(0xFF232B4A),
                      fontWeight: isDone ? FontWeight.w400 : FontWeight.w600)),
            ),
          ],
        ),
      ));
    }
    return out;
  }

  static Widget _recoveredWidget() {
    final rec = recovered ?? {};
    final from = (rec['from'] ?? '').toString();
    final reason = (rec['reason'] ?? '').toString();
    final emptyDb = rec['emptyDb'] == true;
    final head = emptyDb
        ? '⚠ 未找到可用备份，已创建空库'
        : '🔄 检测到上次异常关闭，数据已自动回滚';
    final detail = emptyDb
        ? '请立即从外部备份恢复数据后再继续使用！'
        : '回滚自：${from.isEmpty ? "（未知来源）" : from}${reason.isEmpty ? "" : "\n原因：$reason"}';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: emptyDb ? const Color(0xFFFDECEA) : const Color(0xFFFFF4E5),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: emptyDb ? const Color(0xFFF3B8B0) : const Color(0xFFF0D9A8))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(head,
              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700,
                  color: emptyDb ? const Color(0xFFC0392B) : const Color(0xFF8A6D1F))),
          const SizedBox(height: 4),
          Text(detail, style: TextStyle(fontSize: 12, height: 1.5,
              color: emptyDb ? const Color(0xFFA0342A) : const Color(0xFF8A6D1F))),
        ],
      ),
    );
  }

  static Widget _rescueHint(int sec) {
    // 限速停救=永不自动解锁，必须转人工；否则超时也只是提示看门狗救援进行中
    final limited = rescueLimited;
    final txt = limited
        ? '⛔ 自动救援已暂停：1 小时内已重启 2 次仍异常。请联系管理员人工处理——\nservices.msc → HSAuthServer 重启服务；日志见服务器 data\\logs\\service-error.log。'
        : (sec >= 600
            ? '⚠ 自愈时间偏长，看门狗自动救援可能已介入。若长时间无进展，请联系管理员检查服务器。'
            : '看门狗自动救援进行中（每 5 分钟一轮），请稍候。');
    final red = limited || sec >= 600;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
          color: red ? const Color(0xFFFDECEA) : const Color(0xFFEAF0FE),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: red ? const Color(0xFFF3B8B0) : const Color(0xFFC3CFF7))),
      child: Text(txt,
          style: TextStyle(fontSize: 12.5, height: 1.55,
              color: red ? const Color(0xFFC0392B) : const Color(0xFF33518F))),
    );
  }
}

// 解锁通知（主页监听后刷新数据）
final ValueNotifier<int> kSelfHealUnlocked = ValueNotifier<int>(0);

/// 全屏自愈锁页：零按钮、事件驱动自动解锁，只显示真实阶段清单+计时（不做假倒计时）
class _SelfHealPage extends StatefulWidget {
  const _SelfHealPage();
  @override
  State<_SelfHealPage> createState() => _SelfHealPageState();
}

class _SelfHealPageState extends State<_SelfHealPage> {
  Timer? _t;
  @override
  void initState() {
    super.initState();
    // 每秒刷新计时；同时监听 SelfHealGate._tick（探活更新清单时触发重绘）
    _t = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
    SelfHealGate._tick.addListener(_onTick);
  }
  void _onTick() { if (mounted) setState(() {}); }
  @override
  void dispose() {
    _t?.cancel();
    SelfHealGate._tick.removeListener(_onTick);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final waiting = SelfHealGate.mode == 'waiting';
    final sec = SelfHealGate.lockedSeconds();
    final title = waiting ? '等待服务恢复中' : '系统自愈中';
    final icon = waiting ? Icons.cloud_off_rounded : Icons.autorenew_rounded;
    const color = Color(0xFF515BD4);

    return PopScope(
      canPop: false, // 禁返回键/侧滑：自愈成功前不放行（与 v243 升级闸门同策略）
      child: Scaffold(
        backgroundColor: const Color(0xFFF3F4FB),
        body: SafeArea(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(26),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 40),
                Center(
                  child: SizedBox(
                    width: 76, height: 76,
                    child: waiting
                        ? Icon(icon, size: 72, color: color)
                        : const CircularProgressIndicator(strokeWidth: 6, color: color),
                  ),
                ),
                const SizedBox(height: 24),
                Text(title,
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Color(0xFF232B4A))),
                const SizedBox(height: 10),
                Text(
                    waiting
                        ? '连不上服务器，正在等待服务恢复。\n此期间已暂停录入与提交，请勿关机或退出。'
                        : '服务器正在启动自检与数据自愈，请稍候。\n此期间已暂停录入与提交，完成后自动恢复。',
                    textAlign: TextAlign.center,
                    style: const TextStyle(fontSize: 13.5, height: 1.6, color: Color(0xFF5A6478))),
                const SizedBox(height: 18),
                // 已等待计时（真实计时，非假倒计时）
                Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                    decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10), border: Border.all(color: const Color(0xFFE3E6F2))),
                    child: Text('已等待 ${SelfHealGate._fmtDuration(sec)}',
                        style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700, color: Color(0xFF232B4A))),
                  ),
                ),
                const SizedBox(height: 22),
                // 自愈阶段清单（仅自愈中有服务端清单时展示；等待服务时无清单，显示探测提示）
                if (!waiting && SelfHealGate.total > 0) ...[
                  Text('自愈进度 ${SelfHealGate.done}/${SelfHealGate.total}',
                      style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: Color(0xFF5A6478))),
                  const SizedBox(height: 8),
                  ...SelfHealGate._allStepsWidgets(),
                ] else if (waiting) ...[
                  const Text('正在探测服务器…',
                      textAlign: TextAlign.center,
                      style: TextStyle(fontSize: 12.5, color: Color(0xFF8A93A8))),
                ],
                // 数据回滚取证（数据安全红线：数据被动过必须看得见）
                if (SelfHealGate.recovered != null) ...[
                  const SizedBox(height: 18),
                  SelfHealGate._recoveredWidget(),
                ],
                // 待推记录提示（断网不清本地，恢复后自动上账）
                if (scanPushPending || ledgerPushPending) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: const Color(0xFFEAF6EC), borderRadius: BorderRadius.circular(10)),
                    child: const Text('📦 断网前已保存的记录完整保留在本机，恢复后会自动上账，无需重扫。',
                        style: TextStyle(fontSize: 12.5, height: 1.5, color: Color(0xFF2E7D32))),
                  ),
                ],
                // 升级提示节奏：>3 分钟看门狗救援；>10 分钟或限速=红字人工介入
                if (sec >= 180 || SelfHealGate.rescueLimited) ...[
                  const SizedBox(height: 18),
                  SelfHealGate._rescueHint(sec),
                ],
                const SizedBox(height: 30),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
