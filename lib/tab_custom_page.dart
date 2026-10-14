part of 'main.dart';

// ============ ㉖v53 首页模块自定义：页签顺序/显隐 + 使用习惯自学习（驻留计时） ============
// 设计（结合 PDA 实际）：
//  · 权限仍是硬边界——角色没有的功能绝不进可定制清单（自定义≠越权）
//  · "采集"与"库存"为作业锚点强制常驻（底部栏"采集"跳转与通知直达依赖 index 语义，防自锁）
//  · 每次切页签记驻留时长（进页计时、离开结算），近7天累计 → 可选"按使用习惯排序"
//  · 顺序/显隐/用量/开关 全部经 PrefsSync 上云，换设备登录即跟随；本地 SharedPreferences 兜底离线
class TabCustom {
  static const Map<String, String> titles = {
    'collect': '采集录入',
    'history': '历史批次',
    'inv': '盘点',
    'direct': '直调',
    'stock': '库存',
    'req': '领料',
    'agv': 'AGV',
    'insp': '检验',
  };
  static const Map<String, String> descs = {
    'collect': '扫码采集 · 货位登记 · 叫车',
    'history': '批次全链路 · 作废恢复 · 导出',
    'inv': '盘点任务 · 差异报表 · 改账',
    'direct': 'MES 直调转单 · 去向核对',
    'stock': '实时库存 · 流水 · 预约 · 占用图',
    'req': '领料下单 · 排队看板 · 签收',
    'agv': 'AGV 任务/车辆/交管/大屏',
    'insp': '检验工单 · 退库出账',
  };
  static const Set<String> pinned = {'collect', 'stock'}; // 作业锚点：不可隐藏

  static const _kOrder = 'pd_tabs_order'; // 本地键：顺序（含隐藏标记）
  static const _kHidden = 'pd_tabs_hidden';
  static const _kUse = 'pd_tabuse';
  static const _kAuto = 'pd_tab_auto';

  // 驻留计时状态
  static String _cur = '';
  static int _curAt = 0;
  static bool _dirty = false;

  /// 角色可用页签（权限硬边界）
  static List<String> allowed() {
    final wh = Auth.user?.role == 'warehouse' || Auth.user?.role == 'admin';
    return [
      if (Auth.can("collect")) 'collect',
      if (Auth.can("collect")) 'history',
      if (Auth.can("inventory")) 'inv',
      if (Auth.can("direct_transfer")) 'direct',
      'stock',
      if (wh || Auth.can("requisition") || Auth.can("receive_confirm")) 'req',
      if (wh || Auth.can("agv_monitor")) 'agv',
      if (Auth.can("inspect_mode")) 'insp',
    ];
  }

  static Future<Map<String, dynamic>> _load() async {
    final sp = await SharedPreferences.getInstance();
    List<String> order = [];
    try {
      final raw = sp.getString(_kOrder);
      if (raw != null && raw.isNotEmpty) order = (jsonDecode(raw) as List).map((e) => e.toString()).toList();
    } catch (_) {}
    List<String> hidden = [];
    try {
      final raw = sp.getString(_kHidden);
      if (raw != null && raw.isNotEmpty) hidden = (jsonDecode(raw) as List).map((e) => e.toString()).toList();
    } catch (_) {}
    return {'order': order, 'hidden': hidden, 'auto': sp.getBool(_kAuto) ?? false};
  }

  /// 计算最终页签序列：权限过滤 → 应用自定义顺序/显隐 → 缺失键补尾 → 锚点强制在场
  static Future<List<String>> resolve() async {
    final allow = allowed();
    final cfg = await _load();
    final order = (cfg['order'] as List).map((e) => e.toString()).toList();
    final hidden = (cfg['hidden'] as Set).map((e) => e.toString()).toSet().difference(pinned);
    List<String> out = [];
    for (final k in order) {
      if (allow.contains(k) && !hidden.contains(k) && !out.contains(k)) out.add(k);
    }
    for (final k in allow) {
      if (!hidden.contains(k) && !out.contains(k)) out.add(k);
    }
    for (final k in ['collect', 'stock']) {
      // 锚点兜底：即使被隐藏/乱序也保证在场（collect 在前）
      if (allow.contains(k) && !out.contains(k)) out.insert(k == 'collect' ? 0 : (out.contains('collect') ? 1 : 0), k);
    }
    if ((cfg['auto'] as bool) && out.length > 2) out = _sortByUse(out);
    return out;
  }

  /// 按近7天驻留时长降序（锚点不动，其余重排；无用量数据保持原序）
  static List<String> _sortByUse(List<String> keys) {
    final use = _useMap();
    final movable = keys.where((k) => !pinned.contains(k)).toList();
    if (movable.every((k) => (use[k] ?? 0) <= 0)) return keys;
    movable.sort((a, b) => (use[b] ?? 0).compareTo(use[a] ?? 0));
    final out = <String>[];
    int mi = 0;
    for (final k in keys) {
      if (pinned.contains(k))
        out.add(k);
    else
        out.add(movable[mi++]);
    }
    return out;
  }

  static Map<String, int> _useMap() {
    try {
      final raw = _useRaw;
      if (raw.isEmpty) return {};
      final m = jsonDecode(raw) as Map<String, dynamic>;
      final cutoff = DateTime.now().subtract(const Duration(days: 7)).millisecondsSinceEpoch;
      final out = <String, int>{};
      m.forEach((k, v) {
        // 值形态 {day:ms}：只累计近7天
        if (v is Map) {
          int s = 0;
          v.forEach((d, ms) {
            final day = int.tryParse(d.toString()) ?? 0;
            if (day >= (cutoff / 864e5).floor()) s += (ms as num?)?.toInt() ?? 0;
          });
          out[k] = s;
        }
      });
      return out;
    } catch (_) {
      return {};
    }
  }

  static String _useRaw = '';
  static Map<String, Map<String, int>> _use = {}; // {key:{"日序号":ms}}

  /// 进入页签：结算上一个 + 开始计时
  static void enter(String key) {
    final now = DateTime.now().millisecondsSinceEpoch;
    settle(now);
    _cur = key;
    _curAt = now;
  }

  /// 结算当前驻留时长（切页/退后台/关闭时调）
  static void settle([int? at]) {
    final now = at ?? DateTime.now().millisecondsSinceEpoch;
    if (_cur.isNotEmpty && _curAt > 0) {
      final ms = now - _curAt;
      if (ms > 800 && ms < 10 * 60000) {
        // 800ms 以下视为误触滑过；>10min 视为挂机不结算
        final d = (now / 864e5).floor().toString();
        ((_use[_cur] ??= {})[d] ??= 0);
        _use[_cur]![d] = _use[_cur]![d]! + ms;
        _dirty = true;
        _prune(now);
      }
    }
    _cur = '';
    _curAt = 0;
  }

  static void _prune(int now) {
    final cutoff = (now / 864e5).floor() - 7;
    _use.removeWhere((k, m) {
      m.removeWhere((d, _) => (int.tryParse(d) ?? 0) < cutoff);
      return m.isEmpty;
    });
  }

  /// 把累计写本地并上云（静默失败，下次改动再带）
  static Future<void> flush() async {
    settle();
    if (!_dirty) return;
    _dirty = false;
    try {
      final sp = await SharedPreferences.getInstance();
      _useRaw = jsonEncode(_use);
      await sp.setString(_kUse, _useRaw);
      PrefsSync.pushAll();
    } catch (_) {}
  }

  static Future<void> restore() async {
    final sp = await SharedPreferences.getInstance();
    _useRaw = sp.getString(_kUse) ?? '';
    try {
      if (_useRaw.isNotEmpty) {
        final m = jsonDecode(_useRaw) as Map<String, dynamic>;
        _use = m.map((k, v) => MapEntry(k, (v as Map).map((d, ms) => MapEntry(d.toString(), (ms as num).toInt()))));
      }
    } catch (_) {}
  }

  /// 保存自定义（顺序+隐藏），并上云
  static Future<void> save(List<String> order, List<String> hidden) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kOrder, jsonEncode(order));
    await sp.setString(_kHidden, jsonEncode(hidden));
    await sp.setBool(_kAuto, _autoOn);
    PrefsSync.pushAll();
  }

  static bool _autoOn = false;
  static bool get autoOn => _autoOn;
  static Future<void> setAuto(bool v) async {
    _autoOn = v;
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(_kAuto, v);
    PrefsSync.pushAll();
  }

  static Future<bool> loadAuto() async {
    final sp = await SharedPreferences.getInstance();
    _autoOn = sp.getBool(_kAuto) ?? false;
    return _autoOn;
  }

  /// 服务器回写：把 pd_tabs(JSON {order:[],hidden:[]}) / pd_tabuse / pd_tab_auto 落本地
  static Future<void> applyServer(dynamic tabsJson, dynamic useJson, dynamic auto) async {
    final sp = await SharedPreferences.getInstance();
    if (tabsJson is String && tabsJson.isNotEmpty) {
      try {
        final m = jsonDecode(tabsJson) as Map<String, dynamic>;
        await sp.setString(_kOrder, jsonEncode(m['order'] ?? []));
        await sp.setString(_kHidden, jsonEncode(m['hidden'] ?? []));
      } catch (_) {}
    }
    if (useJson is String && useJson.isNotEmpty) {
      await sp.setString(_kUse, useJson);
      _useRaw = useJson;
      try {
        final m = jsonDecode(useJson) as Map<String, dynamic>;
        _use = m.map((k, v) => MapEntry(k, (v as Map).map((d, ms) => MapEntry(d.toString(), (ms as num).toInt()))));
      } catch (_) {}
    }
    if (auto != null) {
      _autoOn = auto == true;
      await sp.setBool(_kAuto, _autoOn);
    }
  }

  /// 上云 payload（PrefsSync.pushAll 调用）
  static Future<Map<String, dynamic>> cloudPayload() async {
    final sp = await SharedPreferences.getInstance();
    final out = <String, dynamic>{};
    final order = sp.getString(_kOrder);
    final hidden = sp.getString(_kHidden);
    if (order != null || hidden != null) {
      out['pd_tabs'] = jsonEncode({
        'order': order == null ? [] : (jsonDecode(order) as List),
        'hidden': hidden == null ? [] : (jsonDecode(hidden) as List),
      });
    }
    final use = sp.getString(_kUse);
    if (use != null && use.isNotEmpty) out['pd_tabuse'] = use;
    out['pd_tab_auto'] = sp.getBool(_kAuto) ?? false;
    return out;
  }

  static Future<void> reset() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kOrder);
    await sp.remove(_kHidden);
    await sp.setBool(_kAuto, false);
    _autoOn = false;
    PrefsSync.pushAll();
  }
}

// ---------- 模块自定义设置页：拖拽排序 + 显隐开关 + 习惯排序 ----------
class TabCustomPage extends StatefulWidget {
  const TabCustomPage({super.key});
  @override
  State<TabCustomPage> createState() => _TabCustomPageState();
}

class _TabCustomPageState extends State<TabCustomPage> {
  List<String> _order = []; // 可定制全集（含隐藏项，隐藏排可见区之后）
  final Set<String> _hidden = {};
  bool _auto = false;
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final allow = TabCustom.allowed();
    final sp = await SharedPreferences.getInstance();
    List<String> saved = [];
    try {
      final raw = sp.getString('pd_tabs_order');
      if (raw != null && raw.isNotEmpty) saved = (jsonDecode(raw) as List).map((e) => e.toString()).toList();
    } catch (_) {}
    try {
      final raw = sp.getString('pd_tabs_hidden');
      if (raw != null && raw.isNotEmpty) _hidden.addAll((jsonDecode(raw) as List).map((e) => e.toString()));
    } catch (_) {}
    final list = <String>[...saved.where(allow.contains), ...allow.where((k) => !saved.contains(k))];
    // 隐藏项移到尾部分区
    list.sort((a, b) {
      final ha = _hidden.contains(a) ? 1 : 0, hb = _hidden.contains(b) ? 1 : 0;
      return ha != hb ? ha.compareTo(hb) : 0;
    });
    _auto = sp.getBool('pd_tab_auto') ?? false;
    if (mounted) setState(() { _order = list; _ready = true; });
  }

  Future<void> _persist() async {
    await TabCustom.save(_order.where((k) => !_hidden.contains(k)).toList(), _hidden.toList());
  }

  void _move(int i, int j) {
    if (i < 0 || j < 0 || i >= _order.length || j >= _order.length) return;
    setState(() {
      final k = _order.removeAt(i);
      _order.insert(j, k);
    });
    _persist();
  }

  @override
  Widget build(BuildContext context) {
    if (!_ready) return const Scaffold(body: Center(child: CircularProgressIndicator()));
    final use = TabCustom._useMap();
    final maxUse = use.values.fold<int>(1, (a, b) => a > b ? a : b);
    return Scaffold(
      backgroundColor: const Color(0xFFF4F5FB),
      appBar: AppBar(
        backgroundColor: const Color(0xFF515BD4),
        title: const Text("首页模块自定义"),
        actions: [
          IconButton(
            tooltip: "恢复默认",
            icon: const Icon(Icons.restart_alt, color: Colors.white),
            onPressed: () async {
              await TabCustom.reset();
              if (!context.mounted) return;
              setState(() { _hidden.clear(); _auto = false; });
              await _load();
              if (context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已恢复默认布局，回到首页生效")));
              }
            },
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(12),
        children: [
          Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(10)),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text("按使用习惯自动排序", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14.5)),
                      const SizedBox(height: 2),
                      Text("近 7 天在哪个模块待得最久，它就往前排（采集/库存为作业锚点固定不动）",
                          style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600)),
                    ],
                  ),
                ),
                Switch(
                  value: _auto,
                  activeColor: const Color(0xFF515BD4),
                  onChanged: (v) async {
                    await TabCustom.setAuto(v);
                    setState(() => _auto = v);
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          if (_auto)
            Padding(
              padding: const EdgeInsets.only(left: 4, bottom: 8),
              child: Text("习惯权重（拖拽手动排序将按你排的为准）", style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
            ),
          ...List.generate(_order.length, (i) {
            final k = _order[i];
            final hid = _hidden.contains(k);
            final pin = TabCustom.pinned.contains(k);
            final u = use[k] ?? 0;
            return Card(
              margin: const EdgeInsets.symmetric(vertical: 4),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
              child: ListTile(
                dense: true,
                leading: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      padding: EdgeInsets.zero,
                      iconSize: 20,
                      icon: Icon(Icons.arrow_upward, color: i == 0 || _order[i - 1] == 'collect' && k == 'collect' ? Colors.grey.shade300 : const Color(0xFF515BD4)),
                      onPressed: () => _move(i, i - 1),
                    ),
                  ],
                ),
                title: Row(
                  children: [
                    Text(TabCustom.titles[k] ?? k,
                        style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15, color: hid ? Colors.grey : Colors.black87, decoration: hid ? TextDecoration.lineThrough : null)),
                    if (pin)
                      const Padding(
                        padding: EdgeInsets.only(left: 6),
                        child: Icon(Icons.push_pin, size: 14, color: Colors.orange),
                      ),
                    if (u > 0)
                      Padding(
                        padding: const EdgeInsets.only(left: 8),
                        child: Text("7日用 ${(u / 3600e3).clamp(0.01, 99).toStringAsFixed(1)}h",
                            style: TextStyle(fontSize: 10.5, color: Colors.grey.shade500)),
                      ),
                  ],
                ),
                subtitle: Text(TabCustom.descs[k] ?? "", style: TextStyle(fontSize: 11.5, color: Colors.grey.shade500)),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (u > 0)
                      SizedBox(
                        width: 34,
                        child: LinearProgressIndicator(value: u / maxUse, minHeight: 4, color: const Color(0xFF515BD4), backgroundColor: Colors.grey.shade200),
                      ),
                    IconButton(
                      iconSize: 20,
                      icon: Icon(Icons.arrow_downward, color: i == _order.length - 1 ? Colors.grey.shade300 : const Color(0xFF515BD4)),
                      onPressed: () => _move(i, i + 1),
                    ),
                    Switch(
                      value: !hid,
                      activeColor: const Color(0xFF515BD4),
                      onChanged: pin
                          ? null
                          : (v) {
                              setState(() => v ? _hidden.remove(k) : _hidden.add(k));
                              _persist();
                            },
                    ),
                  ],
                ),
              ),
            );
          }),
          const SizedBox(height: 8),
          Text("提示：隐藏只是从首页拿掉，功能权限不变；换台 PDA 登录后布局自动跟随。",
              style: TextStyle(fontSize: 11.5, color: Colors.grey.shade500)),
          const SizedBox(height: 30),
        ],
      ),
    );
  }
}
