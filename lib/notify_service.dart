part of 'main.dart';

// ===================== ⑭ 系统通知 + 语音播报 =====================
// 通知：flutter_local_notifications 高优先级渠道（悬浮横幅/锁屏/息屏可见），
//       铃声用 res/raw/reminder.wav（可自行替换同名文件，无需改代码）。
// 语音四级兜底：系统TTS → 离线引擎(sherpa-onnx+局域网语音包) → 预置数字拼播(APK自带) → 提示音。
// 提醒开关按类别持久化在 SharedPreferences，关闭=不发系统通知（应用内横幅保留）。

final ValueNotifier<String> kNotifTap = ValueNotifier<String>(''); // 通知点击 → 携带领料单id，主页监听跳页

class NotifyService {
  static final FlutterLocalNotificationsPlugin _n = FlutterLocalNotificationsPlugin();
  static final FlutterTts _tts = FlutterTts();
  static bool _ttsReady = false;
  static bool _ttsTried = false;
  static int _nid = 0;

  static const String chId = 'req_remind';
  static const String chName = '领料提醒';

  static Future<void> init() async {
    try {
      await _n.initialize(
        const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')),
        onDidReceiveNotificationResponse: (r) {
          final p = r.payload ?? '';
          if (p.isNotEmpty) kNotifTap.value = '$p@${DateTime.now().millisecondsSinceEpoch}';
        },
      );
      await (await _n.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>())?.createNotificationChannel(
        const AndroidNotificationChannel(chId, chName, description: '待接单/催单/到站等领料提醒，悬浮横幅+锁屏+提示音', importance: Importance.max),
      );
    } catch (e) {
      debugPrint('[notify] 初始化失败：$e');
    }
  }

  static AndroidNotificationDetails _android(String id, String name, String desc, {required bool playSound}) => AndroidNotificationDetails(
        id,
        name,
        channelDescription: desc,
        importance: Importance.max,
        priority: Priority.high,
        category: AndroidNotificationCategory.message,
        visibility: NotificationVisibility.public, // 锁屏显示内容
        playSound: playSound,
        sound: playSound ? const RawResourceAndroidNotificationSound('reminder') : null,
        enableVibration: true,
        audioAttributesUsage: AudioAttributesUsage.alarm, // 走闹钟音量通道，车间更听得见
        styleInformation: const BigTextStyleInformation(''),
      );

  /// 申请 Android13+ 通知权限；返回是否已授权
  static Future<bool> ensurePermission() async {
    try {
      final p = await _n.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      final granted = await p?.areNotificationsEnabled();
      if (granted == true) return true;
      final ok = await p?.requestNotificationsPermission();
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  static Future<bool> notificationsEnabled() async {
    try {
      final p = await _n.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
      return await p?.areNotificationsEnabled() ?? false;
    } catch (_) {
      return false;
    }
  }

  /// 发一条系统通知（按类别开关决定是否发声/是否发出）
  static Future<void> push(String kind, String title, String body, {String payload = ''}) async {
    if (!await RemindPrefs.enabled(kind)) return;
    try {
      await _n.show(++_nid % 100000, title, body, NotificationDetails(android: _android(chId, chName, '领料提醒', playSound: true)), payload: payload);
    } catch (e) {
      debugPrint('[notify] 发送失败：$e');
    }
  }

  /// 测试通知（设置页验证铃声与横幅效果）
  static Future<void> test() async {
    try {
      await _n.show(99001, '🔔 提醒音测试', '收到这条说明通知与铃声正常。车间里能听见就OK。', NotificationDetails(android: _android(chId, chName, '领料提醒', playSound: true)));
    } catch (e) {
      debugPrint('[notify] 测试失败：$e');
    }
  }

  // ---------- 语音播报（四级兜底） ----------
  /// 播报引擎状态文案：系统TTS / 离线引擎 / 数字拼播 / 无
  static Future<String> engineLabel() async {
    if (await ttsAvailable()) return "系统语音引擎";
    if (await VoicePack.disabled()) return "离线引擎已停用（崩溃保护）· 数字拼播";
    if (await VoicePack.ready()) return "离线语音引擎";
    return "数字拼播（自带）";
  }

  /// 播报一段文本；四级兜底，全失败返回false由调用方回退提示音
  static Future<bool> speak(String text) async {
    // ① 系统TTS
    if (await ttsAvailable()) {
      try {
        await _tts.setSpeechRate(await Reminds.speechRate());
        await _tts.stop();
        await _tts.speak(text);
        return true;
      } catch (_) {}
    }
    // ② 离线引擎（sherpa-onnx，模型包从局域网服务器下载一次）
    final off = await VoicePack.speak(text);
    if (off) return true;
    // ③ 预置数字拼播（APK自带wav，数字/件/十百千逐字连播）
    return await _speakDigits(text);
  }

  static Future<bool> ttsAvailable() async {
    if (_ttsTried) return _ttsReady;
    _ttsTried = true;
    try {
      final langs = await _tts.getLanguages;
      _ttsReady = langs != null && langs.isNotEmpty;
      if (_ttsReady) {
        await _tts.setLanguage('zh-CN');
        await _tts.setSpeechRate(await Reminds.speechRate());
        await _tts.setVolume(1.0);
        await _tts.setPitch(1.0);
      }
    } catch (_) {
      _ttsReady = false;
    }
    return _ttsReady;
  }

  /// 数字拼播：全部字符可映射为自带样本才播；含无法念的字返回false（交给上层）
  static final Map<String, String> _digMap = {
    '0': 'voice/d0.wav', '1': 'voice/d1.wav', '2': 'voice/d2.wav', '3': 'voice/d3.wav', '4': 'voice/d4.wav',
    '5': 'voice/d5.wav', '6': 'voice/d6.wav', '7': 'voice/d7.wav', '8': 'voice/d8.wav', '9': 'voice/d9.wav',
    '零': 'voice/d0.wav', '一': 'voice/d1.wav', '二': 'voice/d2.wav', '三': 'voice/d3.wav', '四': 'voice/d4.wav',
    '五': 'voice/d5.wav', '六': 'voice/d6.wav', '七': 'voice/d7.wav', '八': 'voice/d8.wav', '九': 'voice/d9.wav',
    '十': 'voice/d10.wav', '百': 'voice/d100.wav', '千': 'voice/d1000.wav', '件': 'voice/jian.wav',
  };

  static Future<bool> _speakDigits(String text) async {
    final clips = <String>[];
    for (final cu in text.runes) {
      final ch = String.fromCharCode(cu);
      if (ch == '，' || ch == ',' || ch == '、' || ch == ' ') {
        if (clips.isNotEmpty && clips.last != '#') clips.add('#');
        continue;
      }
      final f = _digMap[ch];
      if (f == null) return false; // 有念不了的字：不半截播报
      clips.add(f);
    }
    if (clips.isEmpty) return false;
    try {
      final p = AudioPlayer();
      await p.setReleaseMode(ReleaseMode.stop);
      for (final c in clips) {
        if (c == '#') {
          await Future.delayed(const Duration(milliseconds: 140));
          continue;
        }
        await p.play(AssetSource(c));
        await p.onPlayerComplete.first.timeout(const Duration(seconds: 2), onTimeout: () {});
      }
      await p.dispose();
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<void> stopTts() async {
    try {
      await _tts.stop();
    } catch (_) {}
    VoicePack.stop();
  }
}

/// ⑯离线语音包：模型放局域网服务器，PDA 下载一次解压即用（sherpa-onnx piper 中文）
class VoicePack {
  static const _dirName = 'tts_model';
  static const _flagKey = 'vp_disabled'; // 崩溃保护：持久禁用离线引擎
  static const _sentFile = '.vp_trying'; // 哨兵：合成中崩溃则残留

  static Future<String> _sentPath() async {
    final b = await getApplicationDocumentsDirectory();
    return '${b.path}/$_sentFile';
  }

  static Future<bool> disabled() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getBool(_flagKey) ?? false;
  }

  static Future<void> setDisabled(bool v) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(_flagKey, v);
    if (v) { _broken = true; _inited = false; _tts = null; }
    else { _broken = false; _inited = false; _tts = null; }
  }

  /// 启动时调用：哨兵残留 = 上次进程在语音合成中异常退出（原生崩溃，Dart捕获不到）→ 本次起永久禁用离线引擎
  static Future<void> crashGuard() async {
    try {
      final f = File(await _sentPath());
      if (!f.existsSync()) return;
      try { f.deleteSync(); } catch (_) {}
      if (!await disabled()) {
        await setDisabled(true);
        LocalLog.op('语音包停用', '检测到上次在离线语音合成中异常退出，已自动降级为数字拼播（可在设置页重新启用）');
      }
    } catch (_) {}
  }
  static dynamic _tts; // OfflineTts（避免未装包设备启动即崩，全部 try/catch 内使用）
  static bool _inited = false;
  static bool _broken = false;
  static final AudioPlayer _player = AudioPlayer();

  static Future<String> dirPath() async {
    final base = await getApplicationDocumentsDirectory();
    return '${base.path}/$_dirName';
  }

  /// 模型文件是否就位（只查关键文件，不依赖引擎加载）
  static Future<bool> installed() async {
    try {
      final d = await dirPath();
      return File('$d/model.onnx').existsSync() && File('$d/tokens.txt').existsSync();
    } catch (_) {
      return false;
    }
  }

  static Future<bool> ready() async {
    if (_broken || await disabled()) return false;
    return await installed();
  }

  /// 引擎懒加载；失败标记 _broken 不再重试（本次进程内）
  static Future<bool> _ensureEngine() async {
    if (_inited) return _tts != null;
    if (_broken || await disabled() || !await installed()) return false;
    try {
      sherpa.initBindings();
      final d = await dirPath();
      final tts = sherpa.OfflineTts(
        sherpa.OfflineTtsConfig(
          model: sherpa.OfflineTtsModelConfig(
            vits: sherpa.OfflineTtsVitsModelConfig(model: '$d/model.onnx', tokens: '$d/tokens.txt', dataDir: '$d/espeak-ng-data'),
            numThreads: 2,
          ),
        ),
      );
      _tts = tts;
      _inited = true;
      return true;
    } catch (e) {
      debugPrint('[voicepack] 引擎加载失败：$e');
      _broken = true;
      return false;
    }
  }

  static Future<bool> speak(String text) async {
    if (_broken || await disabled()) return false;
    File? sent;
    try {
      sent = File(await _sentPath());
      sent.writeAsStringSync(DateTime.now().toIso8601String()); // 哨兵先行：引擎加载阶段崩溃（低内存设备）也能被下次启动识别
      LocalLog.op('语音合成', text);
    } catch (_) {}
    if (!await _ensureEngine()) {
      try { sent?.deleteSync(); } catch (_) {} // Dart层可恢复的加载失败：撤哨兵不误判
      return false;
    }
    try {
      final speed = (0.5 + (await RemindPrefs.rateVal()) * 1.1).clamp(0.6, 2.0);
      final audio = _tts.generate(text: text, speed: speed) as sherpa.GeneratedAudio;
      final samples = (audio.samples as List).cast<double>();
      if (samples.isEmpty) return false;
      final dir = await getTemporaryDirectory();
      final wav = '${dir.path}/vp_${DateTime.now().millisecondsSinceEpoch}.wav';
      File(wav).writeAsBytesSync(_pcmToWav16(samples, (_tts.sampleRate as int)));
      await _player.stop();
      await _player.setReleaseMode(ReleaseMode.stop);
      await _player.play(DeviceFileSource(wav));
      await _player.onPlayerComplete.first.timeout(const Duration(seconds: 8), onTimeout: () {});
      try { File(wav).deleteSync(); } catch (_) {}
      try { sent?.deleteSync(); } catch (_) {} // 成功：撤哨兵
      return true;
    } catch (e) {
      try { sent?.deleteSync(); } catch (_) {} // Dart异常可恢复：撤哨兵，不误判崩溃
      debugPrint('[voicepack] 合成失败：$e');
      LocalLog.op('语音合成失败', '$e');
      return false;
    }
  }

  static void stop() {
    try {
      _player.stop();
    } catch (_) {}
  }

  /// Float32采样 → 16bit PCM WAV 字节
  static List<int> _pcmToWav16(List<double> samples, int rate) {
    final n = samples.length;
    final buf = ByteData(44 + n * 2);
    void wstr(int off, String s) {
      for (var i = 0; i < s.length; i++) {
        buf.setUint8(off + i, s.codeUnitAt(i));
      }
    }
    wstr(0, 'RIFF');
    buf.setUint32(4, 36 + n * 2, Endian.little);
    wstr(8, 'WAVE');
    wstr(12, 'fmt ');
    buf.setUint32(16, 16, Endian.little);
    buf.setUint16(20, 1, Endian.little);
    buf.setUint16(22, 1, Endian.little);
    buf.setUint32(24, rate, Endian.little);
    buf.setUint32(28, rate * 2, Endian.little);
    buf.setUint16(32, 2, Endian.little);
    buf.setUint16(34, 16, Endian.little);
    wstr(36, 'data');
    buf.setUint32(40, n * 2, Endian.little);
    for (var i = 0; i < n; i++) {
      var v = (samples[i] * 32767).round();
      if (v > 32767) v = 32767;
      if (v < -32768) v = -32768;
      buf.setInt16(44 + i * 2, v, Endian.little);
    }
    return buf.buffer.asUint8List();
  }

  /// 从服务器下载语音包zip并解压（进度回调0~100）
  static Future<Map> download(void Function(double p)? onProgress) async {
    try {
      final server = await AuthStore.serverUrl();
      final tk = await AuthStore.token();
      if (server.isEmpty || tk.isEmpty) return {"ok": false, "msg": "未登录"};
      final info = await AuthApi.ttsModelInfo();
      if (info["ok"] != true) return {"ok": false, "msg": "服务器未放置语音包"};
      final total = (info["size"] as num?)?.toDouble() ?? 0;
      final client = http.Client();
      final req = http.Request("GET", Uri.parse("$server/api/tts/model"))..headers["Authorization"] = "Bearer $tk";
      final resp = await client.send(req).timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) {
        client.close();
        return {"ok": false, "msg": "HTTP ${resp.statusCode}"};
      }
      final base = await getApplicationDocumentsDirectory();
      final zipPath = '${base.path}/tts-model.zip';
      final f = File(zipPath);
      if (f.existsSync()) f.deleteSync();
      final sink = f.openWrite();
      var got = 0;
      await for (final chunk in resp.stream) {
        sink.add(chunk);
        got += chunk.length;
        if (total > 0 && onProgress != null) onProgress(got * 100.0 / total);
      }
      await sink.flush();
      await sink.close();
      client.close();
      // 解压到 tts_model/（先清旧目录）
      final dir = '${base.path}/tts_model';
      try {
        Directory(dir).deleteSync(recursive: true);
      } catch (_) {}
      final bytes = await f.readAsBytes();
      final archive = ZipDecoder().decodeBytes(bytes);
      for (final e in archive) {
        if (!e.isFile) continue;
        final name = e.name.replaceAll('\\', '/');
        if (name.isEmpty || name.contains('..')) continue;
        final outFile = File('$dir/$name');
        await outFile.create(recursive: true);
        await outFile.writeAsBytes(e.content as List<int>);
      }
      try {
        f.deleteSync();
      } catch (_) {}
      // espeak-ng-data 子目录在zip里是带路径的，上面拍平会破坏它——重新处理：zip内保留相对路径
      _inited = false;
      _broken = false;
      return {"ok": true, "msg": "语音包已安装"};
    } catch (e) {
      return {"ok": false, "msg": "$e"};
    }
  }

  static Future<void> remove() async {
    try {
      final d = await dirPath();
      Directory(d).deleteSync(recursive: true);
    } catch (_) {}
    _tts = null;
    _inited = false;
    _broken = false;
  }
}

/// 提醒开关与语速持久化
class RemindPrefs {
  static const _kVoice = 'remind_voice_scan'; // 扫码语音播报
  static const _kRate = 'remind_speech_rate'; // 语速
  static const _kNew = 'remind_req_new'; // 待接单
  static const _kUrge = 'remind_req_urge'; // 催单
  static const _kArrive = 'remind_req_arrive'; // 到站催扫
  static const _kResult = 'remind_req_result'; // 结果动态（接单/备齐/签收/驳回/取消/转派）
  static const _kWatch = 'remind_watch_in'; // ⑮预约到料
  static const _kStock = 'remind_stock_out'; // ⑮断料预警

  /// 通知类型 → 开关键（未列出的类型默认不弹系统通知）
  static String? keyOf(String type) => switch (type) {
        'req_new' || 'req_timeout' || 'req_reassign' => _kNew,
        'req_urge' => _kUrge,
        'req_arrive' => _kArrive,
        'req_accept' || 'req_ready' || 'req_ready_wh' || 'req_done' || 'req_reject' || 'req_cancel' => _kResult,
        'watch_in' => _kWatch,
        'stock_out' => _kStock,
        _ => null,
      };

  static Future<bool> enabled(String kind) async {
    final k = keyOf(kind);
    if (k == null) return false;
    final sp = await SharedPreferences.getInstance();
    return sp.getBool(k) ?? true;
  }

  static Future<bool> enabledByKey(String key) async {
    final sp = await SharedPreferences.getInstance();
    return sp.getBool(key) ?? true;
  }

  static Future<void> setEnabled(String key, bool v) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(key, v);
  }

  static const kVoice = _kVoice;
  static const kNew = _kNew;
  static const kUrge = _kUrge;
  static const kArrive = _kArrive;
  static const kResult = _kResult;
  static const kWatch = _kWatch;
  static const kStock = _kStock;

  static Future<double> rateVal() async {
    final sp = await SharedPreferences.getInstance();
    return sp.getDouble(_kRate) ?? 0.55;
  }

  static Future<void> setRate(double v) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setDouble(_kRate, v);
  }
}

/// 供 NotifyService 读取语速（0.0~1.0，FlutterTts 用）
class Reminds {
  static Future<double> speechRate() async => RemindPrefs.rateVal();
}
