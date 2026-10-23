part of 'main.dart';

// ===================== 采集页顺手登记扩展：货位主档 / AGV自动分配 / 货位picker / WMAS任务参数 =====================
// 主档不建表：NB02 由编码规则生成（8区×16架×4层=512），空位 = 主档 − 账本占用；
// NB03 按"每排12格位"规划渲染，A-11/C-11 两排带手动加的第13格位。
final Set<String> _colCalled = {}; // 本会话已叫车的货位（防重复叫车）
final ValueNotifier<int> kAgvQueueTick = ValueNotifier(0); // ㉖ 叫车成功后广播刷新采集页队列

extension CollectionLedgerExt on _MainPageState {
  static const List<String> _lz = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  static Map<String, int> _gSlots = {}; // ⑮地面排格数覆盖（服务器拉取，缺省12）
  static int _lowTier = 3; // ㉖v80 入库常用层上限（服务器"调度策略"参数，1~4；AUTO分配硬约束层圈）
  static int nb03SlotMax(String prefix) => _gSlots[prefix] ?? 12;

  ///NB02 全主档 512 格位（区→架→层顺序，兜底分配即按此"集满靠前排"）
  List<String> nb02MasterAll() {
    final out = <String>[];
    for (final z in _lz) {
      for (var r = 1; r <= 16; r++) {
        final rr = r.toString().padLeft(2, '0');
        for (var f = 1; f <= 4; f++) {
          out.add('NB02-$z-$rr-$f' + 'F');
        }
      }
    }
    return out;
  }

  Future<Map<String, List<String>>> _ledgerByLoc() async {
    final rows = await _isar.shelfPlacements.where().findAll();
    final map = <String, List<String>>{};
    for (final p in rows) {
      map.putIfAbsent(p.loc.toUpperCase(), () => []).add(p.goodsCode);
    }
    return map;
  }

  /// 常用层优先（层数上限=服务器参数 _lowTier）：候选里先取层号≤N的，层圈全占才退高层
  String? _preferLow3(List<String> cands) {
    for (final l in cands) {
      if (l.length >= 2) {
        final f = int.tryParse(l[l.length - 2]) ?? 9; // 编码末位是F，倒数第二位是层号
        if (f <= _lowTier) return l;
      }
    }
    return cands.isEmpty ? null : cands.first;
  }

  ///AGV 目标货位自动分配：①同零件已占的架内空位（同件同架，AGV整架取放最优）
  ///②同零件所在区的空架空位 ③全局顺序兜底（A-01-1F 起集满靠前）。无可分配返回 null。
  ///㉖v54 首选服务器原子预占（多PDA并发拿不同格，根治5~15秒撞位窗口）；仅网络不通降级本机口径
  Future<String?> nb02AutoAssign(String partNo, {String code = ''}) async {
    if (code.isNotEmpty) {
      try {
        final rv = await AuthApi.ledgerReserve(code, partNo);
        if (rv["ok"] == true && (rv["loc"] as String?)?.isNotEmpty == true) {
          return (rv["loc"] as String).toUpperCase();
        }
        if (rv["_status"] == 200) return null; // 服务器明确说没空位：如实返回（404老服务器/异常继续走本机旧口径）
      } catch (e) {
        LocalLog.err('自动分配·服务器预占不可达降级本机', e); // 网络异常：降级旧口径
      }
    }
    final byLoc = await _ledgerByLoc();
    try {
      final lv = await AuthApi.ledgerLocs();
      if (lv["ok"] == true && lv["byLoc"] is Map) {
        (lv["byLoc"] as Map).forEach((k, v) {
          final codes = (v as List).map((e) => e.toString()).toList();
          byLoc.update(k.toString(), (l) => [...l, ...codes],
              ifAbsent: () => codes);
        });
      }
    } catch (e) {
      LocalLog.err('自动分配空位·服务器不可达降级本机', e); // ㉖ 降级留痕
    } // 服务器不可达：降级本机口径
    var free = nb02MasterAll().where((l) => !byLoc.containsKey(l)).toList();
    if (free.isEmpty) return null;
    // v80 常用层硬约束（与服务器同款）：同架/同区集中也只在层圈内挑，圈满才上高层
    final fl = free.where((l) => ((int.tryParse(l[l.length - 2]) ?? 9) <= _lowTier)).toList();
    if (fl.isNotEmpty) free = fl;
    if (partNo.isNotEmpty) {
      final recs =
          await _isar.scanRecords.filter().mesPartNoEqualTo(partNo).findAll();
      final codes = recs
          .where((r) => !r.isCancel)
          .map((r) => r.goodsCode.toUpperCase())
          .toSet();
      final shelves = <String>{};
      for (final e in byLoc.entries) {
        if (e.key.startsWith('NB02-') &&
            e.key.length >= 9 &&
            e.value.any((c) => codes.contains(c))) {
          shelves.add(e.key.substring(0, 9)); //NB02-A-08
        }
      }
      if (shelves.isNotEmpty) {
        final sorted = shelves.toList()..sort();
        for (final sh in sorted) {
          final cand = free.where((l) => l.startsWith(sh)).toList();
          if (cand.isNotEmpty) return _preferLow3(cand);
        }
        //同件所在区优先（集中堆放）
        final zones = shelves.map((s) => s[5]).toSet();
        final sameZone =
            free.where((l) => l.length > 5 && zones.contains(l[5])).toList();
        if (sameZone.isNotEmpty) return _preferLow3(sameZone);
      }
    }
    return _preferLow3(free);
  }

  ///货位账本登记区 UI（采集页"选择货位"下方）：编码框 +  picker + 自动 + 容器编码 + WMAS任务卡
  Widget _buildLedgerExtras() {
    final isAgv = _workType == 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 8),
        Row(
          children: [
            const Text("货位账本登记",
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
            const SizedBox(width: 6),
            Text(isAgv ? "选填 · 点选/输入/AUTO" : "选填 · 点选空位生成",
                style: const TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ),
        const SizedBox(height: 4),
        TextField(
          controller: _ledgerLocCtrl,
          textCapitalization: TextCapitalization.characters,
          enabled: !_palletMode || _currentPalletId != null,
          decoration: InputDecoration(
            hintText: _palletMode && _currentPalletId == null
                ? "整托：先扫首件，再点选/填（如 NB02-A-08-2F）"
                : (isAgv ? "货位编码 / 输AUTO自动分配" : "点「选位」挑空位（如 NB03-B-13-07）"),
            isDense: true,
            border: const OutlineInputBorder(),
          ),
        ),
        const SizedBox(height: 6),
        Row(
          children: [
            if (isAgv)
              ElevatedButton(
                style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF8B93E0),
                    foregroundColor: Colors.white),
                onPressed: () => setState(() => _ledgerLocCtrl.text =
                    _ledgerLocCtrl.text.trim().toUpperCase() == 'AUTO'
                        ? ''
                        : 'AUTO'),
                child: const Text("自动"),
              ),
            const SizedBox(width: 6),
            Expanded(
              child: ElevatedButton(
                style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF515BD4),
                    foregroundColor: Colors.white),
                onPressed: isAgv ? _pickNb02 : _pickNb03,
                child: const Text("选位"),
              ),
            ),
            if (isAgv) ...[
              const SizedBox(width: 6),
              Expanded(
                flex: 2,
                child: ElevatedButton(
                  style: ElevatedButton.styleFrom(
                      backgroundColor: const Color(0xFF00897B),
                      foregroundColor: Colors.white),
                  onPressed: () => _showWmasCard(),
                  child: const Text("提交任务"),
                ),
              ),
            ],
          ],
        ),
        if (_autoCallTip.isNotEmpty)
          Padding(
              padding: const EdgeInsets.only(top: 5),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                decoration: BoxDecoration(
                    color: (_autoCallTip.startsWith("🚗") || _autoCallTip.startsWith("✅"))
                        ? const Color(0xFFE8F5E9)
                        : (_autoCallTip.startsWith("⚠️")
                            ? const Color(0xFFFFF3E0)
                            : const Color(0xFFECEFF1)),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(
                        color: (_autoCallTip.startsWith("🚗") || _autoCallTip.startsWith("✅"))
                            ? Colors.green.shade200
                            : (_autoCallTip.startsWith("⚠️")
                                ? Colors.orange.shade200
                                : Colors.blueGrey.shade200))),
                child: Text(_autoCallTip,
                    style: TextStyle(
                        fontSize: 11.5,
                        color: (_autoCallTip.startsWith("🚗") || _autoCallTip.startsWith("✅"))
                            ? Colors.green.shade800
                            : (_autoCallTip.startsWith("⚠️")
                                ? Colors.orange.shade900
                                : Colors.blueGrey))),
              )),
        // ㉖ 我的AGV任务统计行（AGV模式常驻：有任务看进度，没任务也留入口随时查叫车结果；与领料页同交互）
        if (isAgv)
          Padding(
              padding: const EdgeInsets.only(top: 6),
              child: InkWell(
                  onTap: _showMyQueueSheet,
                  borderRadius: BorderRadius.circular(8),
                  child: Container(
                      width: double.infinity,
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 7),
                      decoration: BoxDecoration(
                          color: const Color(0xFFE8F0FE),
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: const Color(0xFFB3C7F0))),
                      child: Row(children: [
                        const Text("🚛", style: TextStyle(fontSize: 14)),
                        const SizedBox(width: 6),
                        Expanded(
                            child: Text(
                                _myQueue.isEmpty
                                    ? "我的AGV任务：暂无活跃任务（叫车后排队/在途/到站实时显示在这）"
                                    : "我的AGV任务：${_qSeg("排队")}排 · ${_qSeg("下发中") + _qSeg("已下发")}在途 · ${_qSeg("到站")}到站${_qSeg("失败") > 0 ? " · ${_qSeg("失败")}失败" : ""}",
                                style: const TextStyle(
                                    fontSize: 12.5,
                                    fontWeight: FontWeight.w600,
                                    color: Color(0xFF1A237E)))),
                        Text(_queueMode == "live" ? "真实下发" : "演算模式",
                            style: TextStyle(
                                fontSize: 10.5,
                                color: _queueMode == "live"
                                    ? Colors.green.shade700
                                    : Colors.grey)),
                        const Icon(Icons.chevron_right,
                            size: 18, color: Color(0xFF1A237E)),
                      ])))),
      ],
    );
  }

  int _qSeg(String st) => _myQueueCnt[st] ?? 0;

  /// ㉖ 拉取本账号活跃AGV任务（叫车结果与在途位置在采集页可见）
  Future<void> _loadMyQueue() async {
    final me = Auth.user?.name ?? "";
    if (me.isEmpty) return;
    try {
      final r = await AuthApi.rcsStations();
      if (!mounted || r["ok"] != true) return;
      final mine = List<Map>.from(r["queue"] ?? [])
          .where((q) => q["by"]?.toString() == me)
          .toList();
      final cnt = <String, int>{};
      for (final q in mine) {
        final s = q["state"]?.toString() ?? "?";
        cnt[s] = (cnt[s] ?? 0) + 1;
      }
      // ㉖v69 提示条存活校验：叫车成功提示对应的货物，其队列项已被删除/已完成 → 提示自动撤销（防"任务没了还显示叫车成功"）
      if (_autoCallTip.startsWith("🚗") && _autoCallCode.isNotEmpty) {
        final alive = mine.any((q) =>
            (q["code"] ?? "").toString().toUpperCase() == _autoCallCode &&
            q["state"] != "完成");
        if (!alive) {
          _autoCallTip = "";
          _autoCallCode = "";
        }
      }
      setState(() {
        _myQueue = mine;
        _myQueueCnt = cnt;
        _queueMode = r["mode"]?.toString() ?? "dry";
      });
    } catch (e) {
      LocalLog.err('队列状态刷新', e); // ㉖ 静默失败留痕：自动上报控制后台"设备异常"
    }
  }

  /// ㉖ 我的AGV任务面板：每框 起点→目的地/状态/等待时长/失败原因，排队与失败可取消
  void _showMyQueueSheet() {
    _loadMyQueue();
    showModalBottomSheet(
        context: context,
        isScrollControlled: true,
        builder: (mctx) => StatefulBuilder(
            builder: (mctx2, setSt) => SafeArea(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Padding(
                      padding: const EdgeInsets.fromLTRB(12, 12, 4, 0),
                      child: Row(children: [
                        const Expanded(
                            child: Text("我的 AGV 任务",
                                style: TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 15))),
                        Text(_queueMode == "live" ? "真实下发" : "演算模式（不发车）",
                            style: TextStyle(
                                fontSize: 11.5,
                                color: _queueMode == "live"
                                    ? Colors.green.shade700
                                    : Colors.orange.shade800)),
                        TextButton(
                            onPressed: () async {
                              await _loadMyQueue();
                              setSt(() {});
                            },
                            child: const Text("刷新")),
                      ])),
                  Flexible(
                    child: ListView(
                        shrinkWrap: true,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        children: [
                          for (final q in _myQueue)
                            ListTile(
                              dense: true,
                              leading: CircleAvatar(
                                  radius: 15,
                                  backgroundColor: switch (
                                      q["state"]?.toString()) {
                                    "排队" => const Color(0xFFE3F2FD),
                                    "下发中" || "已下发" => const Color(0xFFFFF3E0),
                                    "到站" => const Color(0xFFE8F5E9),
                                    "完成" => const Color(0xFFE8F5E9),
                                    "失败" => const Color(0xFFFFEBEE),
                                    _ => const Color(0xFFFAFAFA)
                                  },
                                  child: Text(
                                      switch (q["state"]?.toString()) {
                                        "排队" => "排",
                                        "下发中" || "已下发" => "途",
                                        "到站" => "站",
                                        "完成" => "✔",
                                        "失败" => "✕",
                                        _ => "·"
                                      },
                                      style: const TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.bold))),
                              title: Text(
                                  "${q["code"] ?? "?"}  ${q["fromLoc"] ?? q["from"] ?? "?"} → ${(() {
                                    final s0 = (q["station"] ?? "").toString();
                                    final s1 =
                                        (q["stationManual"] ?? "").toString();
                                    final t = s0.isNotEmpty ? s0 : s1;
                                    return t.isEmpty
                                        ? "待分配"
                                        : (t.contains("-CK-")
                                            ? t.split("-").last + "号台"
                                            : t);
                                  })()}",
                                  style: const TextStyle(
                                      fontSize: 13, fontFamily: "monospace")),
                              subtitle: Text(
                                  "${q["state"] ?? ""} · 等 ${_qWaitOf(q)}${(q["err"] ?? "").toString().isNotEmpty ? " · ${q["err"]}" : ""}${(q["reqNo"] ?? "").toString().isNotEmpty ? " · 单${q["reqNo"]}" : ""}",
                                  style: TextStyle(
                                      fontSize: 11,
                                      color:
                                          (q["err"] ?? "").toString().isNotEmpty
                                              ? Colors.red.shade600
                                              : Colors.grey)),
                              trailing: (q["state"] == "排队" ||
                                      q["state"] == "失败")
                                  ? TextButton(
                                      onPressed: () async {
                                        final r = await AuthApi.agvQueueCancel(
                                            [(q["code"] ?? "").toString()]);
                                        if (!mctx2.mounted) return;
                                        ScaffoldMessenger.of(mctx2)
                                            .showSnackBar(SnackBar(
                                                content: Text(r["ok"] == true
                                                    ? "已取消排队 ${q["code"]}"
                                                    : "取消失败：${r["msg"]}")));
                                        await _loadMyQueue();
                                        setSt(() {});
                                      },
                                      child: const Text("取消",
                                          style: TextStyle(
                                              fontSize: 12,
                                              color: Colors.redAccent)))
                                  : null,
                            ),
                          if (_myQueue.isEmpty)
                            const Padding(
                                padding: EdgeInsets.all(24),
                                child: Center(
                                    child: Text(
                                        "暂无进行中的AGV任务\n叫车后这里实时显示排队/在途/到站",
                                        textAlign: TextAlign.center,
                                        style: TextStyle(color: Colors.grey)))),
                        ]),
                  ),
                  TextButton(
                      onPressed: () => Navigator.pop(mctx2),
                      child: const Text("关闭")),
                ]))));
  }

  /// 等待时长人性化（秒→分→时），按每条任务各自的入队时刻
  String _qWaitOf(Map q) {
    final at = q["at"];
    final s = (DateTime.now().millisecondsSinceEpoch -
            (at is num ? at.toInt() : 0)) ~/
        1000;
    if (s < 60) return "${s < 0 ? 0 : s}秒";
    if (s < 3600) return "${(s / 60).round()}分";
    return "${(s / 3600).round()}时";
  }

  /// 地面区内自动分配格位：zone 形如 "B13"；返回该排第一个空位编码，满则 null
  Future<String?> nb03AutoSlot(String zone) async {
    if (zone.isEmpty || zone.length < 2) return null;
    final g = zone.substring(0, 1);
    final nn = zone.substring(1).padLeft(2, '0');
    final prefix = 'NB03-$g-$nn';
    final maxSlot = nb03SlotMax(prefix);
    final byLoc = await _ledgerByLoc();
    for (var s = 1; s <= maxSlot; s++) {
      final code = '$prefix-${s.toString().padLeft(2, '0')}';
      if (!byLoc.containsKey(code)) return code;
    }
    return null;
  }

  ///AUTO 解析：按本次 MES 零件号给 NB02 自动分配货位并回填；分配不到保留 AUTO 走格式提示。
  Future<void> _handleAutoLedger(String code) async {
    final rec = await _isar.scanRecords
        .filter()
        .goodsCodeEqualTo(code.toUpperCase())
        .findFirst();
    final partNo = rec?.mesPartNo ?? "";
    final loc = await nb02AutoAssign(partNo, code: code.toUpperCase());
    if (!mounted) return;
    if (loc == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text("货架已无空位，无法自动分配，请改用选位或手输"),
          backgroundColor: Colors.orange));
      return;
    }
    setState(() => _ledgerLocCtrl.text = loc);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text("自动分配货位：$loc（零件 $partNo）"),
        backgroundColor: const Color(0xFF00897B)));
  }

  ///NB02 picker：选区→16架×4层网格，占用显示标签，点空位回填
  Future<void> _pickNb02() async {
    final byLoc = await _ledgerByLoc();
    if (!mounted) return;
    String zone = _ledgerLocCtrl.text.length > 5 ? _ledgerLocCtrl.text[5] : 'A';
    if (!'ABCDEFGH'.contains(zone)) zone = 'A';
    final picked = await showDialog<String>(
        context: context,
        builder: (dctx) {
          return StatefulBuilder(builder: (bctx, setSt) {
            final rows = <Widget>[];
            for (var r = 1; r <= 16; r++) {
              final rr = r.toString().padLeft(2, '0');
              final cells = <Widget>[];
              for (var f = 1; f <= 4; f++) {
                final code = 'NB02-$zone-$rr-$f' + 'F';
                final occ = byLoc[code];
                final full = occ != null && occ.isNotEmpty;
                cells.add(Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 2),
                    child: ElevatedButton(
                      style: ElevatedButton.styleFrom(
                        backgroundColor:
                            full ? const Color(0xFFE0E0E0) : Colors.white,
                        foregroundColor: full
                            ? Colors.grey.shade600
                            : const Color(0xFF3F51B5),
                        padding: const EdgeInsets.symmetric(vertical: 8),
                      ),
                      onPressed: () {
                        if (full) {
                          ScaffoldMessenger.of(bctx).showSnackBar(SnackBar(
                              content: Text("$code 已占用：${occ.join('、')}"),
                              backgroundColor: Colors.orange));
                        } else {
                          Navigator.pop(bctx, code);
                        }
                      },
                      child: Text(full ? "${f}F\n${occ.length}码" : "$f" + "F",
                          style: const TextStyle(fontSize: 12)),
                    ),
                  ),
                ));
              }
              rows.add(Row(children: [
                SizedBox(
                    width: 40,
                    child: Text("$zone-$rr",
                        style: const TextStyle(
                            fontSize: 12, fontFamily: "monospace"))),
                Expanded(child: Row(children: cells)),
              ]));
              rows.add(const SizedBox(height: 3));
            }
            return AlertDialog(
              title: Text("选择 AGV 货架位（$zone 区）"),
              content: SizedBox(
                width: 380,
                height: 420,
                child: Column(children: [
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                        children: _lz
                            .map((z) => Padding(
                                  padding: const EdgeInsets.only(right: 6),
                                  child: ChoiceChip(
                                      label: Text(z),
                                      selected: z == zone,
                                      onSelected: (_) => setSt(() => zone = z)),
                                ))
                            .toList()),
                  ),
                  const SizedBox(height: 6),
                  Expanded(child: ListView(children: rows)),
                ]),
              ),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(bctx),
                    child: const Text("取消"))
              ],
            );
          });
        });
    if (picked != null && mounted) setState(() => _ledgerLocCtrl.text = picked);
  }

  ///NB03 picker：沿用已选地面区排（如 B13），渲染该排 12（+13）格位空位
  Future<void> _pickNb03() async {
    final gl = _selectedGroundLoc; // 形如 B13
    if (gl == null || gl.isEmpty) {
      _toastGroundPickFirst();
      return;
    }
    final g = gl.substring(0, 1);
    final num = gl.substring(1).padLeft(2, '0');
    final prefix = 'NB03-$g-$num';
    final maxSlot = nb03SlotMax(prefix);
    final byLoc = await _ledgerByLoc();
    if (!mounted) return;
    final cells = <Widget>[];
    for (var s = 1; s <= maxSlot; s++) {
      final code = '$prefix-${s.toString().padLeft(2, '0')}';
      final occ = byLoc[code];
      final full = occ != null && occ.isNotEmpty;
      cells.add(SizedBox(
        width: 64,
        child: Padding(
          padding: const EdgeInsets.all(3),
          child: ElevatedButton(
            style: ElevatedButton.styleFrom(
              backgroundColor: full ? const Color(0xFFE0E0E0) : Colors.white,
              foregroundColor:
                  full ? Colors.grey.shade600 : const Color(0xFF3F51B5),
            ),
            onPressed: () {
              if (full) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(
                    content: Text("$code 已占用：${occ.join('、')}"),
                    backgroundColor: Colors.orange));
              } else {
                Navigator.pop(context, code);
              }
            },
            child: Text(full ? "$s\n${occ.length}码" : "$s"),
          ),
        ),
      ));
    }
    final picked = await showDialog<String>(
        context: context,
        builder: (dctx) => AlertDialog(
              title: Text(
                  "选格位：$prefix（空 ${maxSlot - byLoc.keys.where((k) => k.startsWith('$prefix-')).length}/$maxSlot）"),
              content: SizedBox(width: 300, child: Wrap(children: cells)),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(dctx),
                    child: const Text("取消"))
              ],
            ));
    if (picked != null && mounted) setState(() => _ledgerLocCtrl.text = picked);
  }

  void _toastGroundPickFirst() {
    if (mounted)
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text("请先在上方选择地面货位（区+排），再点选格位"),
          backgroundColor: Colors.orange));
  }

  /// 最近一次入账的货位（扫码保存后输入框会清空，叫车时回退取它）
  Future<String> _latestRegLoc() async {
    final rows = await _isar.shelfPlacements.where().findAll();
    if (rows.isEmpty) return "";
    rows.sort((a, b) => b.assignedAt.compareTo(a.assignedAt));
    return rows.first.loc.toUpperCase();
  }

  /// ⑳扫码自动入库叫车：与手动「提交任务」同校验链（会话防重/容器主档反查）；失败只提示不动账本
  Future<void> _autoCallInbound(String st, String loc, String ctype) async {
    try {
      if (_colCalled.contains(loc)) {
        if (mounted) setState(() => _autoCallTip = "ℹ️ $loc 本会话已叫过车（防重复）");
        return;
      }
      final cands = await WmasMaster.containerCodesOf(ctype);
      if (cands.isEmpty) {
        if (mounted)
          setState(() => _autoCallTip = "⚠️ 自动叫车未发：主档无「$ctype」容器｜请手动「提交任务」");
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text("自动叫车未发：主档无「$ctype」容器编码，请手动「提交任务」"),
              backgroundColor: Colors.orange));
        return;
      }
      String cn = cands.first;
      if (cands.length > 1) {
        //多候选不猜：弹轻选择（取消则留手动），避免自动模式拿错容器
        if (!mounted) return;
        final picked = await showDialog<String>(
            context: context,
            builder: (dc) => AlertDialog(
                  title: const Text("选择容器编码（自动叫车）"),
                  content: SizedBox(
                      width: 300,
                      height: (cands.length > 8 ? 8 : cands.length) * 44 + 30,
                      child: ListView(
                          children: cands
                              .map((c) => RadioListTile<String>(
                                  dense: true,
                                  contentPadding: EdgeInsets.zero,
                                  title: Text(c,
                                      style: const TextStyle(
                                          fontSize: 13,
                                          fontFamily: "monospace")),
                                  value: c,
                                  groupValue: null,
                                  onChanged: (v) => Navigator.pop(dc, v)))
                              .toList())),
                  actions: [
                    TextButton(
                        onPressed: () => Navigator.pop(dc),
                        child: const Text("取消（稍后手动提交）"))
                  ],
                ));
        if (picked == null) {
          if (mounted)
            setState(() => _autoCallTip = "ℹ️ 已取消容器选择，未叫车｜可手动「提交任务」");
          return;
        }
        cn = picked;
      }
      final codes0 = (await _ledgerByLoc())[loc] ?? const <String>[];
      final r = await AuthApi.agvCarry(
          from: st,
          to: loc,
          dir: "in",
          code: codes0.isNotEmpty ? codes0.first : "",
          palletType: ctype,
          container: cn); // ㉖⑰ 统一走服务器入队下发：队列/流水线/链路全可见
      if (r["ok"] == true) {
        _colCalled.add(loc);
        kAgvQueueTick.value++; // ㉖ 叫车成功→采集页队列统计即时刷新
        LocalLog.op('自动入库叫车', "$st→$loc 容器$cn");
        if (mounted) {
          _autoCallCode = (codes0.isNotEmpty ? codes0.first : "").toUpperCase(); // ㉖v69 记录货物码：任务被删/完成时提示条自动撤销
          setState(() => _autoCallTip = "🚗 自动叫车成功：$st → $loc（容器 $cn）");
        }
        if (mounted)
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text("🚗 自动叫车：${r["msg"]}"),
              backgroundColor: const Color(0xFF2E7D32),
              duration: const Duration(seconds: 3)));
      } else if (mounted) {
        setState(() => _autoCallTip = "⚠️ 自动叫车失败：${r["msg"]}｜可手动「提交任务」");
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(
            content: Text("自动叫车失败：${r["msg"]}（账本已登记，可手动「提交任务」）"),
            backgroundColor: Colors.orange,
            duration: const Duration(seconds: 5)));
      }
    } catch (e) {
      debugPrint('[auto-call] $e');
      if (mounted) setState(() => _autoCallTip = "⚠️ 自动叫车异常：$e");
    }
  }

  ///WMAS 任务卡：叫车前先强制校验"该货位已扫码入账"，从流程上杜绝"叫了车忘扫码"；本会话已叫过的货位禁止重复叫车
  /// 手动「提交任务」叫车弹窗。㉖v85d 结托复用：可传入清空前捕获的三要素（stPre/locPre/ctypePre），
  /// 并在叫车成功后回调 onDone（结托场景=释放货位），使「结托+叫车」成为原子操作，消除顺序陷阱。
  Future<void> _showWmasCard(
      {String stPre = "",
      String locPre = "",
      String ctypePre = "",
      void Function()? onDone}) async {
    var st = stPre.isNotEmpty
        ? stPre
        : (_selectedStation ?? _lastScanStation ?? ""); // ㉖⑬ 扫码后站台选中态已清，回退本框扫码时的站台
    var loc = locPre.isNotEmpty
        ? locPre
        : _ledgerLocCtrl.text.trim().toUpperCase();
    if (loc.isEmpty || loc == 'AUTO')
      loc = await _latestRegLoc(); // 扫码后输入框清空→回退最近入账货位
    var ctype = ctypePre.isNotEmpty
        ? ctypePre
        : (_containerType ?? _lastScanContainer ?? ""); // ㉖⑬ 容器同左回退
    void warn(String m) {
      if (mounted)
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(m), backgroundColor: Colors.orange));
    }

    if (st.isEmpty) return warn("请先选择起始站台");
    if (loc.isEmpty) return warn("还没有扫码入账的货位——请先扫描货物标签，再叫车");
    // ㉖v69c 地面货位防呆：AGV 只跑 站台↔NB02高架，NB03地面区不在AGV作业区（WMAS主档无此库位，发了必被弹回）
    if (!loc.startsWith('NB02-')) {
      warn("地面货位 $loc 不在AGV作业区：AGV只跑 站台↔NB02高架。账本已登记，这框请人工摆到地面位即可");
      return;
    }
    if (_colCalled.contains(loc))
      return warn("货位 $loc 本会话已叫过车，请勿重复；如需重叫请先到AGV系统核对该托盘任务");
    final codes = (await _ledgerByLoc())[loc] ?? const <String>[];
    if (codes.isEmpty) return warn("货位 $loc 还没有扫码入账——请先扫描货物标签，再叫车（防止叫车忘扫码）");
    // ㉖v79c 叫车对象校验：旧版直接取"该货位账本首码"，输入框残留上一单货位时会把别框当本框叫车
    // （事故还原：扫N26J220220入账被占失败→点提交→拿残留位D-16-1F的首码SYS000254建任务→AGV按错框名义搬运）
    // 现以最近一次生效扫码为准：该码必须在目标货位账本里，否则拒绝并提示重选
    final allRecs = await _isar.scanRecords.where().findAll();
    allRecs.sort((a, b) => b.scanTime.compareTo(a.scanTime));
    String expect = "";
    for (final r in allRecs) {
      if (!r.isCancel) {
        expect = r.goodsCode.toUpperCase();
        break;
      }
    }
    if (expect.isNotEmpty && !codes.map((c) => c.toUpperCase()).contains(expect)) {
      return warn("刚扫的框 $expect 并不在货位 $loc（该位是 ${codes.join('/')}）\n货位框可能残留上一单——请点「选位」重选本次货位，或先扫标签入账再提交");
    }
    if (!mounted) return;
    showDialog(
        context: context,
        builder: (dctx) => _WmasCardDialog(
            startPoint: st,
            endPoint: loc,
            containerType: ctype,
            cargoCodes: codes,
            onCalled: onDone));
  }
}

/// WMAS 任务确认对话框：容器编码反查主档（多候选可选），提交=建任务+下发
class _WmasCardDialog extends StatefulWidget {
  final String startPoint, endPoint, containerType;
  final List<String> cargoCodes;
  final void Function()? onCalled; // ㉖v85d 结托场景：叫车成功后释放货位（原子化）
  const _WmasCardDialog(
      {required this.startPoint,
      required this.endPoint,
      required this.containerType,
      this.cargoCodes = const [],
      this.onCalled});
  @override
  State<_WmasCardDialog> createState() => _WmasCardDialogState();
}

class _WmasCardDialogState extends State<_WmasCardDialog> {
  List<String> _cands = [];
  String? _picked;
  bool _loading = true;
  bool _busy = false;
  String _err = "";

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  Future<void> _resolve() async {
    try {
      final list = await WmasMaster.containerCodesOf(widget.containerType);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _cands = list;
        _picked = list.length == 1 ? list.first : null;
        if (list.isEmpty)
          _err = "容器主档里没有「${widget.containerType}」对应的容器编码，请核对容器类型或手动在WMAS建任务";
      });
    } catch (e) {
      if (mounted)
        setState(() {
          _loading = false;
          _err = "查容器主档失败：$e";
        });
    }
  }

  Future<void> _submit() async {
    final cn = _picked ?? "";
    if (cn.isEmpty || _busy) return;
    setState(() => _busy = true);
    final r = await AuthApi.agvCarry(
        from: widget.startPoint,
        to: widget.endPoint,
        dir: "in",
        code: widget.cargoCodes.isNotEmpty ? widget.cargoCodes.first : "",
        palletType: widget.containerType,
        container: cn); // ㉖⑰ 手动提交同样入服务器队列（全链路可见+防重）
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content:
            Text(r["ok"] == true ? "AGV任务：${r["msg"]}" : "AGV任务失败：${r["msg"]}"),
        backgroundColor: r["ok"] == true ? const Color(0xFF2E7D32) : Colors.red,
        duration: const Duration(seconds: 4)));
    if (r["ok"] == true) {
      _colCalled.add(widget.endPoint);
      kAgvQueueTick.value++; // ㉖ 叫车成功→采集页队列统计即时刷新
      Navigator.pop(context);
      widget.onCalled?.call(); // ㉖v85d 结托场景：叫车成功才释放货位，一次点击闭环
    }
  }

  @override
  Widget build(BuildContext context) {
    final ready = widget.startPoint.isNotEmpty &&
        widget.endPoint.isNotEmpty &&
        widget.endPoint != 'AUTO';
    final cn = _picked ?? "";
    final clip = [widget.startPoint, widget.endPoint, cn]
        .where((s) => s.isNotEmpty && s != 'AUTO')
        .join("\n");
    return AlertDialog(
      title: const Text("AGV 搬运任务（WMAS）"),
      content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                "起始库位：${widget.startPoint.isEmpty ? "（未选站台）" : widget.startPoint}",
                style: const TextStyle(fontSize: 14)),
            Text(
                "目标库位：${!ready ? (widget.endPoint.isEmpty ? "（未定）" : widget.endPoint) : widget.endPoint}",
                style: const TextStyle(fontSize: 14)),
            const SizedBox(height: 4),
            Text(
                "容器类型：${widget.containerType.isEmpty ? "（未选）" : widget.containerType}",
                style: const TextStyle(fontSize: 13, color: Colors.grey)),
            if (widget.cargoCodes.isNotEmpty)
              Text("货物标签：${widget.cargoCodes.join("、")}",
                  style:
                      const TextStyle(fontSize: 13, color: Color(0xFF1A237E))),
            const SizedBox(height: 6),
            if (_loading)
              const Row(children: [
                SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 8),
                Text("查询容器主档…", style: TextStyle(fontSize: 12))
              ])
            else if (_err.isNotEmpty)
              Text(_err,
                  style:
                      const TextStyle(fontSize: 12.5, color: Colors.deepOrange))
            else if (_cands.length == 1)
              Text("容器编码：$cn",
                  style: const TextStyle(
                      fontSize: 14,
                      fontFamily: "monospace",
                      color: Color(0xFF1A237E)))
            else
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                    "容器编码（${widget.containerType} 在主档有 ${_cands.length} 个，选架上这只）：",
                    style: const TextStyle(fontSize: 12, color: Colors.grey)),
                const SizedBox(height: 4),
                SizedBox(
                    height: 96,
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: _cands.length,
                      itemBuilder: (bc, i) => RadioListTile<String>(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        visualDensity: VisualDensity.compact,
                        title: Text(_cands[i],
                            style: const TextStyle(
                                fontSize: 13, fontFamily: "monospace")),
                        value: _cands[i],
                        groupValue: _picked,
                        onChanged: (v) => setState(() => _picked = v),
                      ),
                    )),
              ]),
          ]),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context), child: const Text("关闭")),
        TextButton(
            onPressed: clip.split("\n").length < 3
                ? null
                : () {
                    Clipboard.setData(ClipboardData(text: clip));
                    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
                        content: Text("已复制三要素（每行一项）"),
                        backgroundColor: Color(0xFF2E7D32)));
                  },
            child: const Text("复制手填")),
        ElevatedButton.icon(
          style: ElevatedButton.styleFrom(
              backgroundColor: const Color(0xFF00897B),
              foregroundColor: Colors.white,
              disabledBackgroundColor: Colors.grey.shade300),
          onPressed:
              (ready && cn.isNotEmpty && !_busy && !_loading) ? _submit : null,
          icon: _busy
              ? const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Colors.white))
              : const Icon(Icons.send, size: 16),
          label: const Text("提交任务"),
        ),
      ],
    );
  }
}

// ===== 全局推送助手（采集页/领料发料/出库单/登记页共用） =====
Timer? _pushLedgerTimer;
bool _ledgerPushPending = false; // ㉖⑰ 有未推送的账本变更
bool get ledgerPushPending => _ledgerPushPending;
// ㉖v69 账本世代：服务器整表替换（数据迁移）会盖世代章；本机世代不符先清旧缓存再同步，防旧账本残留本机/推回服务器
const _kLedgerEpoch = "ledger_epoch_v69";
String? _ledgerEpochSeen; // 本进程已对齐的世代；null=尚未对齐
void scheduleLedgerPush({int seconds = 15}) {
  _ledgerPushPending = true;
  // ㉖⑰ 节流不重置：原实现每次登记重置定时器，连续扫码账本永远推不出去（网页"查不到新料"根因）
  if (_pushLedgerTimer?.isActive == true) return;
  _pushLedgerTimer = Timer(Duration(seconds: seconds), ledgerPushNow);
}

void _ledgerPushRetry() {
  _pushLedgerTimer?.cancel();
  _pushLedgerTimer = Timer(const Duration(seconds: 30), ledgerPushNow);
}

Future<Map> ledgerPushNow() async {
  try {
    // ㉖v69 世代闸：本机世代与服务器不符（服务器账本被整表替换过）→ 先拉取对齐（拉取侧清旧缓存）再重试推送
    final sp0 = await SharedPreferences.getInstance();
    final ep0 = sp0.getString(_kLedgerEpoch) ?? "";
    if (ep0.isNotEmpty && _ledgerEpochSeen != ep0) {
      final pr = await ledgerPullMerge(force: true);
      if (pr["ok"] == true && (sp0.getString(_kLedgerEpoch) ?? "") == ep0) {
        _ledgerEpochSeen = ep0;
        return ledgerPushNow();
      }
      _ledgerPushRetry();
      return {"ok": false, "msg": "账本世代不一致，对齐失败，稍后自动重试"};
    }
    final all = await _globalIsar.shelfPlacements.where().findAll();
    final infos = {
      for (final e in await _globalIsar.labelInfos.where().findAll())
        e.goodsCode: e
    };
    final pids = {
      for (final e in await _globalIsar.recordExtras.where().findAll())
        e.goodsCode.toUpperCase(): e.palletId
    }; // 托号：整托多码同框（㉖ 键统一大写：扩展表存扫码原样，账本存大写，此前大小写不一致致托号丢失）
    // 入库搬运方式：采集流水 workType 0=AGV站台(来站=stationNo) 1=人工地面(来源=groundLocation)；无流水=手工登记
    final mvMap = <String, String>{}, srcMap = <String, String>{};
    final pnMap = <String, String>{},
        nmMap = <String, String>{},
        lotMap = <String, String>{},
        qMap = <String, double>{}; // ㉖ 零件信息回退源（LabelInfo 未缓存时用）
    final recs = await _globalIsar.scanRecords.where().findAll();
    recs.sort((a, b) => a.scanTime.compareTo(b.scanTime));
    final exMap = {
      for (final e in await _globalIsar.recordExtras.where().findAll())
        e.goodsCode.toUpperCase(): e
    }; // ㉖ 键统一大写（与 pids 同源同因）
    for (final r in recs) {
      if (r.isCancel) continue;
      final up = r.goodsCode.toUpperCase();
      if (r.workType == 0) {
        mvMap[up] = "AGV";
        srcMap[up] = r.stationNo ?? "";
      } else {
        mvMap[up] = "人工";
        srcMap[up] = r.groundLocation ?? "";
      }
      if ((r.mesPartNo ?? "").isNotEmpty) pnMap[up] = r.mesPartNo!;
      if ((r.mesQty ?? 0) > 0) qMap[up] = r.mesQty!;
      final ex = exMap[up];
      if ((ex?.mesItemName ?? "").isNotEmpty) nmMap[up] = ex!.mesItemName;
      // ㉖ 批次口径：优先用本机已存的 MES 标签打印时间派生（存量记录重推即自动改新口径，无需重查MES）
      final _ml = r.mesCreateTime ?? "";
      if (_ml.isNotEmpty || (ex?.mesLotNo ?? "").isNotEmpty) {
        lotMap[up] = lotFromPrintDate(_ml, ex?.mesLotNo ?? "");
      }
    }
    final items = all.map((p) {
      final up = p.goodsCode.toUpperCase();
      final i = infos[up];
      final pid = pids[up] ?? "";
      final mv = mvMap[up] ?? "登记";
      final src = srcMap[up] ?? "";
      // ㉖ 零件信息回退：LabelInfo 缓存仅由"服务器拉取合并"填充，本机新扫的框还没有缓存 →
      // 必须回退本机采集流水/扩展表的 MES 结果，否则网页货位账本零件号/物料/数量全空（看似"没显示该货位有货"）
      final _ok = i != null && !i.missing;
      final pn =
          _ok && (i.partNo as String).isNotEmpty ? i.partNo : (pnMap[up] ?? "");
      final nm = _ok && i.itemName.isNotEmpty ? i.itemName : (nmMap[up] ?? "");
      final lot = (lotMap[up] ?? "").isNotEmpty
          ? lotMap[up]!
          : (_ok ? lotFromPrintDate(i.createTime, i.lotNo) : "");
      final qty = _ok && i.qty > 0 ? i.qty : (qMap[up] ?? 0);
      return {
        "c": p.goodsCode,
        "l": p.loc,
        "f": p.container,
        "t": p.assignedAt,
        "mv": mv,
        if (src.isNotEmpty) "src": src,
        if (pid.isNotEmpty) "pid": pid,
        if (pn.isNotEmpty) "p": pn,
        if (nm.isNotEmpty) "n": nm,
        if (qty > 0) "q": qty,
        if (lot.isNotEmpty) "b": lot,
      };
    }).toList();
    final del = await ledgerTombs();
    if (items.isEmpty && del.isEmpty) return {"ok": false, "msg": "账本为空"};
    final r = await AuthApi.ledgerSync(items, del: del,
        epoch: sp0.getString(_kLedgerEpoch) ?? ""); // ㉖v69 带世代：服务器据此拦旧缓存
    // ⑲改位冲突提示：推送被他人更新数据压过的标签=本机登记未生效，弹窗提醒重新登记
    final rej = r["rejected"];
    if (r["ok"] == true && rej is List && rej.isNotEmpty) {
      debugPrint('[ledger] 冲突标签: $rej');
      final ctx = _globalNavigatorKey.currentContext;
      if (ctx != null) {
        unawaited(showDialog(
            context: ctx,
            builder: (dc) => AlertDialog(
                  icon: const Icon(Icons.sync_problem,
                      color: Colors.orange, size: 34),
                  title: const Text("货位登记冲突"),
                  content: Text(
                      "${rej.length} 个标签的登记未生效（被其他设备更新的数据覆盖，或目标货位已被别的框占用）：\n${rej.take(8).join("\n")}${rej.length > 8 ? " …" : ""}\n\n请到「位置登记」重新登记这些框的实际货位（先拉取对齐），并和同事核对现场。"),
                  actions: [
                    FilledButton(
                        onPressed: () => Navigator.pop(dc),
                        child: const Text("知道了"))
                  ],
                )));
      }
    }
    if (r["ok"] == true) {
      await ledgerClearSentTombs(del); // 服务器已合并，本地释放已上报墓碑
      _ledgerPushPending = false; // ㉖⑰ 推送成功清 pending
      _ledgerEpochSeen = sp0.getString(_kLedgerEpoch) ?? ""; // ㉖v69 推送成功=与当前世代对齐
    } else {
      if (r["code"] == "epochStale") {
        _ledgerEpochSeen = null; // ㉖v69 双保险：被服务器世代闸拦下 → 强制重新对齐清旧缓存
        unawaited(ledgerPullMerge(force: true));
      }
      _ledgerPushRetry(); // 失败30秒后自动重试
    }
    return r;
  } catch (e) {
    _ledgerPushRetry(); // ㉖⑰ 异常同样自动重试，防断网期间账本滞留本机
    return {"ok": false, "msg": "$e"};
  }
}

// ===== 账本删除墓碑：本地删除记入并随推送上报，避免"整表替换"误删别台PDA的数据 =====
const _kLedgerTombs = "ledger_tombstones";

Future<Map<String, int>> _loadTombs() async {
  final sp = await SharedPreferences.getInstance();
  final s = sp.getString(_kLedgerTombs) ?? "";
  if (s.isEmpty) return {};
  try {
    final m = jsonDecode(s) as Map<String, dynamic>;
    return m.map((k, v) => MapEntry(k, (v as num).toInt()));
  } catch (_) {
    return {};
  }
}

Future<void> _saveTombs(Map<String, int> m) async {
  final sp = await SharedPreferences.getInstance();
  if (m.length > 8000) {
    // 只留最新8000条，防无限膨胀
    final e = m.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    m = Map.fromEntries(e.take(8000));
  }
  await sp.setString(_kLedgerTombs, jsonEncode(m));
}

/// 记删除墓碑（拣下/整框拣下/导入替换掉的旧标签）
Future<void> ledgerMarkDeleted(Iterable<String> codes) async {
  final m = await _loadTombs();
  final now = DateTime.now().millisecondsSinceEpoch;
  var changed = false;
  for (final c in codes) {
    final up = c.toUpperCase();
    if (up.isNotEmpty) {
      m[up] = now;
      changed = true;
    }
  }
  if (changed) await _saveTombs(m);
}

/// 重新登记某标签 → 撤销其墓碑（服务器端同样"比墓碑新即复活"）
Future<void> ledgerUnmarkDeleted(Iterable<String> codes) async {
  final m = await _loadTombs();
  var changed = false;
  for (final c in codes) {
    if (m.remove(c.toUpperCase()) != null) changed = true;
  }
  if (changed) await _saveTombs(m);
}

Future<List<Map>> ledgerTombs() async {
  final m = await _loadTombs();
  return m.entries.map((e) => {"c": e.key, "t": e.value}).toList();
}

Future<void> ledgerClearSentTombs(List<Map> sent) async {
  if (sent.isEmpty) return;
  final m = await _loadTombs();
  for (final d in sent) {
    final c = d["c"]?.toString() ?? "";
    final t = (d["t"] as num?)?.toInt() ?? 0;
    if ((m[c] ?? 0) <= t) m.remove(c); // 仅清已上报的；期间又删过则保留新墓碑
  }
  await _saveTombs(m);
}

/// 从账本查某标签当前货位（出库单补记原货位用），查不到返回空串
Future<String> ledgerLocOfCode(String code) async {
  try {
    if (code.isEmpty) return "";
    final sp = await _globalIsar.shelfPlacements
        .filter()
        .goodsCodeEqualTo(code.toUpperCase())
        .findAll();
    return sp.isNotEmpty ? sp.first.loc : "";
  } catch (_) {
    return "";
  }
}

/// 从电脑服务器拉取账本并**增量合并**进本机（物料员/新PDA看库存的关键：本机没采集也能有数据）。
/// 规则与服务器一致：标签级"登记时间新者胜"；服务器墓碑比本机新→本机消位并落墓碑。
/// ⑮拉取地面排格数配置（随账本拉取顺带刷新，改动低频）
Future<void> pullGroundSlots() async {
  try {
    final r = await AuthApi.groundSlotsGet();
    if (r["ok"] == true) {
      CollectionLedgerExt._gSlots = Map<String, int>.from((r["slots"] as Map)
          .map((k, v) => MapEntry(k.toString(), (v as num).toInt())));
      final lt = r["lowTier"]; // ㉖v80 常用层上限随配置同步
      if (lt is num && lt >= 1 && lt <= 4) CollectionLedgerExt._lowTier = lt.toInt();
    }
  } catch (e) {
    LocalLog.err('拉取地面排格数', e); // ㉖ 静默失败留痕
  }
}

int _ledgerPullAtMs = 0; // ㉖ 上次【成功】拉取合并的毫秒时刻（跨页面共享，防多页重复打服务器）
DateTime? ledgerLastSyncAt; // 上次成功同步时刻（库存页头展示）
Future<Map> ledgerPullMerge({bool force = false}) async {
  try {
    final _nowMs = DateTime.now().millisecondsSinceEpoch;
    if (!force && _nowMs - _ledgerPullAtMs < 20000) {
      return {"ok": true, "skipped": 1, "added": 0, "updated": 0, "deleted": 0, "total": -1}; // 20秒内刚拉过：静默跳过
    }
    final r = await AuthApi.ledgerGet();
    if (r["ok"] != true)
      return {"ok": false, "msg": (r["msg"] ?? "拉取失败").toString()};
    // ㉖v69 世代对齐：服务器世代变化（账本整表替换）→ 先清空本机旧缓存（含墓碑/已发料缓存）再合并，杜绝新旧叠加
    final epSrv = (r["epoch"] ?? "").toString();
    if (epSrv.isNotEmpty) {
      final sp = await SharedPreferences.getInstance();
      if ((sp.getString(_kLedgerEpoch) ?? "") != epSrv) {
        await _globalIsar.writeTxn(() async {
          await _globalIsar.shelfPlacements.where().deleteAll();
          await _globalIsar.labelInfos.where().deleteAll();
          await _globalIsar.scanRecords.where().deleteAll();
          await _globalIsar.recordExtras.where().deleteAll();
          await _globalIsar.outboundOrders.where().deleteAll();
        });
        await sp.remove("req_issued_barcodes"); // 领料已发料缓存（与 requisition_page 私有常量同值）
        await _saveTombs({}); // 旧墓碑会挡住新账本行拉入，一并清
        await sp.setString(_kLedgerEpoch, epSrv);
      }
      _ledgerEpochSeen = epSrv;
    }
    final items = List<Map>.from(r["items"] ?? []);
    final tomb = List<Map>.from(r["tomb"] ?? []);
    final local = await _globalIsar.shelfPlacements.where().findAll();
    // ㉖v82 清理本机遗留拼接行（"A; B"）：服务器已拆单码且不再存拼接行，这类本地行是导入时代遗留的幽灵数据——
    // 每次推送被服务器拆行命中墓碑，旧版触发"货位登记冲突"弹窗死循环；拉取时直接删除
    final ghosts = local.where((p) => p.goodsCode.contains(';') || p.goodsCode.contains('；')).toList();
    if (ghosts.isNotEmpty) {
      await _globalIsar.writeTxn(() async {
        await _globalIsar.shelfPlacements.deleteAll(ghosts.map((e) => e.id).toList());
      });
      local.removeWhere(ghosts.contains);
    }
    final localMap = {for (final p in local) p.goodsCode.toUpperCase(): p};
    final tombMap = await _loadTombs();
    var added = 0, updated = 0, deleted = 0;
    final upserts = <ShelfPlacement>[];
    final infoUpserts = <LabelInfo>[];
    final rmIds = <int>{};
    final tombAdds = <String, int>{};
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final x in items) {
      final c = (x["c"] ?? "").toString().trim().toUpperCase();
      final l = (x["l"] ?? "").toString().trim().toUpperCase();
      if (c.isEmpty || l.isEmpty) continue;
      final t = (x["t"] as num?)?.toInt() ?? 0;
      if ((tombMap[c] ?? 0) >= t && t > 0) continue; // 本机已删除且更新 → 不复活
      final me = localMap[c];
      if (me != null && me.assignedAt >= t) continue; // 本机登记时间更新 → 保留本机
      upserts.add(ShelfPlacement()
        ..goodsCode = c
        ..loc = l
        ..container = (x["f"] ?? "").toString()
        ..operator = (x["by"] ?? "拉取合并").toString()
        ..assignedAt = t > 0 ? t : now);
      final pn = (x["p"] ?? "").toString().toUpperCase();
      if (pn.isNotEmpty) {
        infoUpserts.add(LabelInfo()
          ..goodsCode = c
          ..partNo = pn
          ..itemName = (x["n"] ?? "").toString()
          ..qty = (x["q"] as num?)?.toDouble() ?? 0
          ..lotNo = (x["b"] ?? "").toString()
          ..missing = false
          ..syncedAt = now);
      }
      if (me == null)
        added++;
      else {
        rmIds.add(me.id);
        updated++;
      }
    }
    // 服务器墓碑比本机新 → 本机消位并落墓碑（别台拣下的框这里同步消失）
    for (final d in tomb) {
      final c = (d["c"] ?? "").toString().trim().toUpperCase();
      final t = (d["t"] as num?)?.toInt() ?? 0;
      if (c.isEmpty || t == 0) continue;
      final me = localMap[c];
      if (me != null && me.assignedAt > t) continue; // 本机后来重新登记 → 保留
      if (me != null) {
        rmIds.add(me.id);
        deleted++;
      }
      if ((tombMap[c] ?? 0) < t) tombAdds[c] = t;
    }
    await _globalIsar.writeTxn(() async {
      if (rmIds.isNotEmpty)
        await _globalIsar.shelfPlacements.deleteAll(rmIds.toList());
      if (upserts.isNotEmpty) await _globalIsar.shelfPlacements.putAll(upserts);
      if (infoUpserts.isNotEmpty) {
        for (final e in infoUpserts) {
          await _globalIsar.labelInfos
              .filter()
              .goodsCodeEqualTo(e.goodsCode)
              .deleteAll();
        }
        await _globalIsar.labelInfos.putAll(infoUpserts);
      }
    });
    if (tombAdds.isNotEmpty) {
      final m = await _loadTombs();
      m.addAll(tombAdds);
      await _saveTombs(m);
    }
    unawaited(pullGroundSlots()); // ⑮顺带刷新地面排格数
    _ledgerPullAtMs = DateTime.now().millisecondsSinceEpoch;
    ledgerLastSyncAt = DateTime.now();
    return {
      "ok": true,
      "added": added,
      "updated": updated,
      "deleted": deleted,
      "total": items.length
    };
  } catch (e) {
    LocalLog.err('账本拉取合并', e); // ㉖ 静默自动刷新的失败也留痕（返回值 ok:false 供调用方提示）
    return {"ok": false, "msg": "$e"};
  }
}

/// 从账本拣下这些标签（出库/发料用），并尽快推送电脑。找不到/已不在账本不报错。
Future<void> ledgerRemoveAndPush(Iterable<String> codes) async {
  try {
    final gone = <String>[];
    await _globalIsar.writeTxn(() async {
      for (final c in codes) {
        final olds = await _globalIsar.shelfPlacements
            .filter()
            .goodsCodeEqualTo(c)
            .findAll();
        if (olds.isNotEmpty) {
          gone.add(c);
          await _globalIsar.shelfPlacements
              .deleteAll(olds.map((e) => e.id).toList());
        }
      }
    });
    if (gone.isNotEmpty)
      await ledgerMarkDeleted(gone); // 记墓碑：服务器合并时同步删除，别台PDA可拉取感知
    scheduleLedgerPush(seconds: 8);
  } catch (e) {
    debugPrint("[ledger] 拣下失败：$e");
  }
}

/// 整框拣下：发料/出库扫到任一标签，同框兄弟码（同托号，或无托号时同货位+同零件号）一并消位。
/// 与库存框键口径一致，避免"一框两码只消一码"导致账面仍显示在库。
Future<void> ledgerRemoveBoxAndPush(String code) async {
  final up = code.toUpperCase();
  final codes = <String>{up};
  try {
    final extra = await _globalIsar.recordExtras
        .filter()
        .goodsCodeEqualTo(up)
        .findFirst();
    final pid = extra?.palletId ?? "";
    if (pid.isNotEmpty) {
      final mates = await _globalIsar.recordExtras
          .filter()
          .palletIdEqualTo(pid)
          .findAll();
      codes.addAll(mates.map((m) => m.goodsCode.toUpperCase()));
    } else {
      final self = await _globalIsar.shelfPlacements
          .filter()
          .goodsCodeEqualTo(up)
          .findAll();
      final info = await _globalIsar.labelInfos
          .filter()
          .goodsCodeEqualTo(up)
          .findFirst();
      if (self.isNotEmpty && info != null && info.partNo.isNotEmpty) {
        final all = await _globalIsar.shelfPlacements.where().findAll();
        for (final p in all) {
          if (p.loc != self.first.loc) continue;
          final i = await _globalIsar.labelInfos
              .filter()
              .goodsCodeEqualTo(p.goodsCode)
              .findFirst();
          if (i != null && i.partNo == info.partNo)
            codes.add(p.goodsCode.toUpperCase());
        }
      }
    }
  } catch (e) {
    debugPrint("[ledger] 整框扩展失败（仅拣本码）：$e");
  }
  await ledgerRemoveAndPush(codes);
}

Timer? _pushScanTimer;
bool _scanPushPending = false; // ㉖ 有未推送的流水变更
final ValueNotifier<int> kScanSync = ValueNotifier(0); // 0=已同步 1=待同步 2=失败重试中
bool get scanPushPending => _scanPushPending;
void scheduleScanPush({int seconds = 15}) {
  _scanPushPending = true;
  kScanSync.value = 1;
  // ㉖⑭ 节流不重置：已在等就让它到点触发。原实现每次扫码重置60秒定时器，连续扫码流水永远推不出去（网页"很晚才显示"根因）
  if (_pushScanTimer?.isActive == true) return;
  _pushScanTimer = Timer(Duration(seconds: seconds), scanPushNow);
}

void _scanPushRetry() {
  _pushScanTimer?.cancel();
  _pushScanTimer =
      Timer(const Duration(seconds: 30), scanPushNow); // 失败30秒后自动重试
}

/// 采集流水全量推送电脑（含作废标记，按 标签|批次|时间 键去重）
Future<void> scanPushNow() async {
  try {
    final all = await _globalIsar.scanRecords.where().findAll();
    if (all.isEmpty) return;
    final extras = {
      for (final e in await _globalIsar.recordExtras.where().findAll())
        e.goodsCode: e
    };
    final items = all.map((r) {
      final x = extras[r.goodsCode.toUpperCase()];
      return {
        "k": "${r.goodsCode}|${r.batchId}|${r.scanTime.millisecondsSinceEpoch}",
        "code": r.goodsCode,
        "wt": r.workType,
        "st": r.stationNo ?? "",
        "gl": r.groundLocation ?? "",
        "ct": r.containerType ?? "",
        "rm": r.remark,
        "batch": r.batchId,
        "cx": r.isCancel,
        "t": r.scanTime.millisecondsSinceEpoch,
        "pn": r.mesPartNo ?? "",
        "q": r.mesQty ?? 0,
        "mk": r.mesCreateTime ?? "",
        "op": x?.operator ?? "",
        "nm": x?.mesItemName ?? "",
        // ㉖ 批次口径：按 MES 标签打印时间派生，缺失回退原 LOT_NO
        "lot": lotFromPrintDate(r.mesCreateTime ?? "", x?.mesLotNo ?? ""),
        "pid": x?.palletId ?? "",
      };
    }).toList();
    final res = await AuthApi.scanlogSync(items);
    if (res["ok"] == true) {
      _scanPushPending = false;
      kScanSync.value = 0; // ㉖⑭ 推送成功：状态归零，网页30秒内可见
    } else {
      debugPrint("[scanlog] 同步失败：${res["msg"]}");
      kScanSync.value = 2;
      _scanPushRetry();
    }
  } catch (e) {
    debugPrint("[scanlog] 同步异常：$e");
    kScanSync.value = 2;
    _scanPushRetry();
  }
}

// ===== ㉖⑭ 采集记录作废/恢复（替代物理删除：留痕可逆，网页流水同步显示）=====
/// 作废一条采集记录：标记 isCancel + 释放站台 + 联动整框消账 + 撤回全局防重 + 立即推流水
Future<void> scanRecordCancel(Isar isar, ScanRecord r) async {
  await isar.writeTxn(() async {
    r.isCancel = true;
    await isar.scanRecords
        .put(r); // ㉖ Isar3.x 对象无 save() 方法，用集合 put 更新（CI analyze 抓出）
    if (r.workType == 0 && r.stationNo != null) {
      final batch =
          await isar.batchInfos.filter().batchIdEqualTo(r.batchId).findFirst();
      if (batch != null) {
        final mut = batch.usedStation.toList()..remove(r.stationNo);
        batch.usedStation = mut;
        await isar.batchInfos.put(batch);
      }
    }
  });
  final up = r.goodsCode.toUpperCase();
  // 本地 scanRecords 存扫码原样大小写，按本条记录的值查同码是否还有生效采集
  final stillActive = await isar.scanRecords
      .filter()
      .goodsCodeEqualTo(r.goodsCode)
      .isCancelEqualTo(false)
      .findFirst();
  if (stillActive == null) {
    // 该标签已无生效采集：整框从账本拣下(墓碑同步服务器) + 撤回 seenIn 防重允许重扫
    await ledgerRemoveBoxAndPush(up);
    unawaited(AuthApi.labelUnsee(up));
    unawaited(AuthApi.agvQueueCancel([up])); // ㉖v69 作废即撤车：该货物在排队/已下发的AGV任务同步取消，防车白跑一趟
  }
  unawaited(scanPushNow()); // 作废即刻上墙，网页入库流水秒级变"作废"
}

/// 恢复一条已作废记录：清标记 + 若账本无此码则按原货位重建登记 + 立即推流水
Future<void> scanRecordRestore(Isar isar, ScanRecord r) async {
  await isar.writeTxn(() async {
    r.isCancel = false;
    await isar.scanRecords.put(r); // ㉖ 同作废：Isar3.x 用 put 更新
    if (r.workType == 0 && r.stationNo != null) {
      final batch =
          await isar.batchInfos.filter().batchIdEqualTo(r.batchId).findFirst();
      if (batch != null && !batch.usedStation.contains(r.stationNo)) {
        batch.usedStation = [...batch.usedStation, r.stationNo!];
        await isar.batchInfos.put(batch);
      }
    }
  });
  final up = r.goodsCode.toUpperCase();
  final inLedger =
      await isar.shelfPlacements.filter().goodsCodeEqualTo(up).findFirst();
  if (inLedger == null) {
    // 作废期间已消账：按采集记录原货位重建（AGV=站台 人工=地面格位）
    final loc = (r.workType == 0 ? r.stationNo : r.groundLocation) ?? "";
    if (loc.isNotEmpty &&
        RegExp(r'^NB0[23]-[A-H]-\d{1,2}-(\d{1,2}|[1-4]F)$').hasMatch(loc)) {
      final extra =
          await isar.recordExtras.filter().goodsCodeEqualTo(up).findFirst();
      await isar.writeTxn(() async {
        await isar.shelfPlacements.put(ShelfPlacement()
          ..goodsCode = up
          ..loc = loc
          ..container = r.containerType ?? ""
          ..operator = extra?.operator ?? (Auth.user?.name ?? "恢复重建")
          ..assignedAt = DateTime.now().millisecondsSinceEpoch);
      });
      await ledgerUnmarkDeleted([up]); // 撤销墓碑，服务器"比墓碑新即复活"
      scheduleLedgerPush(seconds: 5);
    }
  }
  unawaited(scanPushNow()); // 恢复即刻回写，网页流水变回"正常"
}

/// 单张出库单推送电脑（按单号去重覆盖，核对状态变化也会更新）
void outboundPushNow(OutboundOrder ob) {
  () async {
    try {
      final items = (jsonDecode(ob.itemsJson) as List);
      final res = await AuthApi.outboundSync({
        "orderNo": ob.orderNo,
        "createdAt": ob.createdAt,
        "toLoc": ob.toLoc,
        "operator": ob.operator,
        "status": ob.status,
        "linkReqNo": ob.linkReqNo,
        "items": items,
      });
      if (res["ok"] != true) debugPrint("[outbound] 同步失败：${res["msg"]}");
    } catch (e) {
      debugPrint("[outbound] 同步异常：$e");
    }
  }();
}
