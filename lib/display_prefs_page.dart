part of 'main.dart';

// ===================== 第3档 显示与扫码偏好页 =====================
// 字号档位 / 扫码自动聚焦 / 默认框型 / 领料默认值（沿用指定·到货日期偏移）
// 全部经 PrefsSync 存服务器，换设备/重装登录自动跟随。
class DisplayPrefsPage extends StatefulWidget {
  const DisplayPrefsPage({super.key});
  @override
  State<DisplayPrefsPage> createState() => _DisplayPrefsPageState();
}

class _DisplayPrefsPageState extends State<DisplayPrefsPage> {
  String _font = "std";
  bool _focus = true, _defAssignee = true;
  String _pallet = "";
  int _offset = 0;
  static const _pallets = [
    ["", "不预填（每托手选）"],
    ["1800*1200_2", "1.8米铁框"],
    ["1600*1100", "1.6米铁框"],
    ["2.4米铁框", "2.4米铁框"],
    ["华强铁框", "华强铁框"],
    ["托盘", "托盘"],
  ];
  static const _fonts = [
    ["std", "标准"],
    ["lg", "大"],
    ["xl", "特大"],
  ];
  static const _offs = [0, 1, 2, 3, 5, 7];

  @override
  void initState() {
    super.initState();
    _load();
    PrefsSync.changed.addListener(_load); // 服务器回写后刷新
  }

  @override
  void dispose() {
    PrefsSync.changed.removeListener(_load);
    super.dispose();
  }

  Future<void> _load() async {
    final sp = await SharedPreferences.getInstance();
    if (!mounted) return;
    setState(() {
      _font = sp.getString("pd_font") ?? "std";
      _focus = sp.getBool("pd_focus") ?? true;
      _defAssignee = sp.getBool("pd_defAssignee") ?? true;
      _pallet = sp.getString("pd_defPallet") ?? "";
      _offset = sp.getInt("pd_dateOffset") ?? 0;
    });
  }

  Future<void> _set(String key, dynamic v) async {
    final sp = await SharedPreferences.getInstance();
    if (v is String) {
      await sp.setString(key, v);
    } else if (v is bool) {
      await sp.setBool(key, v);
    } else if (v is int) {
      await sp.setInt(key, v);
    }
    if (key == "pd_font") kFontScaleN.value = kFontScaleOf(v); // 字号即时生效
    if (key == "pd_focus") kAutoFocus = v; // 聚焦开关即时生效
    if (mounted) setState(() {});
    PrefsSync.pushAll(); // 上云（fire-and-forget）
  }

  @override
  Widget build(BuildContext context) {
    final fs = kFontScaleN.value;
    double sz(double base) => base * fs;
    return Scaffold(
      appBar: AppBar(
          title: const Text("显示与扫码偏好"),
          backgroundColor: const Color(0xFF515BD4)),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
              child: Padding(
            padding: const EdgeInsets.all(14),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text("界面字号",
                  style:
                      TextStyle(fontSize: sz(15), fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text("车间强光或远距离看屏可选大字号，切换后立即全局生效",
                  style: TextStyle(fontSize: sz(12), color: Colors.grey)),
              const SizedBox(height: 10),
              Wrap(spacing: 10, children: [
                for (final f in _fonts)
                  ChoiceChip(
                      label: Text(f[1], style: TextStyle(fontSize: sz(14))),
                      selected: _font == f[0],
                      onSelected: (_) => _set("pd_font", f[0])),
              ]),
            ]),
          )),
          const SizedBox(height: 10),
          Card(
              child: SwitchListTile(
                  value: _focus,
                  activeColor: const Color(0xFF515BD4),
                  title: Text("扫码框自动聚焦", style: TextStyle(fontSize: sz(15))),
                  subtitle: Text("开：每单保存后扫码框自动回到焦点，连扫更顺；关：不反复弹软键盘，需要时手动点框",
                      style: TextStyle(fontSize: sz(12))),
                  onChanged: (v) => _set("pd_focus", v))),
          const SizedBox(height: 10),
          Card(
              child: Padding(
            padding: const EdgeInsets.all(14),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text("默认框型",
                  style:
                      TextStyle(fontSize: sz(15), fontWeight: FontWeight.w600)),
              Text("建托后自动预选该框型，减少重复点选；仍可临时改选或取消",
                  style: TextStyle(fontSize: sz(12), color: Colors.grey)),
              const SizedBox(height: 10),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final p in _pallets)
                  ChoiceChip(
                      label: Text(p[1], style: TextStyle(fontSize: sz(13.5))),
                      selected: _pallet == p[0],
                      onSelected: (_) => _set("pd_defPallet", p[0])),
              ]),
            ]),
          )),
          const SizedBox(height: 10),
          Card(
              child: Padding(
            padding: const EdgeInsets.all(14),
            child:
                Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text("领料单默认值",
                  style:
                      TextStyle(fontSize: sz(15), fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  value: _defAssignee,
                  activeColor: const Color(0xFF515BD4),
                  title:
                      Text("建单默认沿用上次指定的仓管", style: TextStyle(fontSize: sz(14))),
                  subtitle: Text("关：每次建单默认「不指定，谁接都可以」",
                      style: TextStyle(fontSize: sz(12))),
                  onChanged: (v) => _set("pd_defAssignee", v)),
              const Divider(height: 20),
              Text("期望到货日期默认 = 今天 + N 天（建单时可改，填 0 即当天）",
                  style: TextStyle(fontSize: sz(14))),
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final o in _offs)
                  ChoiceChip(
                      label: Text(o == 0 ? "当天" : "+$o 天",
                          style: TextStyle(fontSize: sz(13.5))),
                      selected: _offset == o,
                      onSelected: (_) => _set("pd_dateOffset", o)),
              ]),
            ]),
          )),
          const SizedBox(height: 14),
          Text("以上偏好存在服务器，换设备或重装登录后自动跟随；扫码播报与提醒订阅在「通知与语音」页，同样已上云。",
              style: TextStyle(fontSize: sz(12), color: Colors.grey)),
        ],
      ),
    );
  }
}
