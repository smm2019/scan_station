part of 'main.dart';

// ===================== 采集页顺手登记扩展：货位主档 / AGV自动分配 / 货位picker / WMAS任务参数 =====================
// 主档不建表：NB02 由编码规则生成（8区×16架×4层=512），空位 = 主档 − 账本占用；
// NB03 按"每排12格位"规划渲染，A-11/C-11 两排带手动加的第13格位。
extension CollectionLedgerExt on _MainPageState {
  static const List<String> _lz = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  static const Set<String> _nb03R13 = {'NB03-A-11', 'NB03-C-11'}; //有13号加位的排

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

  ///AGV 目标货位自动分配：①同零件已占的架内空位（同件同架，AGV整架取放最优）
  ///②同零件所在区的空架空位 ③全局顺序兜底（A-01-1F 起集满靠前）。无可分配返回 null。
  Future<String?> nb02AutoAssign(String partNo) async {
    final byLoc = await _ledgerByLoc();
    final free = nb02MasterAll().where((l) => !byLoc.containsKey(l)).toList();
    if (free.isEmpty) return null;
    if (partNo.isNotEmpty) {
      final recs = await _isar.scanRecords.filter().mesPartNoEqualTo(partNo).findAll();
      final codes = recs.where((r) => !r.isCancel).map((r) => r.goodsCode.toUpperCase()).toSet();
      final shelves = <String>{};
      for (final e in byLoc.entries) {
        if (e.key.startsWith('NB02-') && e.key.length >= 9 && e.value.any((c) => codes.contains(c))) {
          shelves.add(e.key.substring(0, 9)); //NB02-A-08
        }
      }
      if (shelves.isNotEmpty) {
        final sorted = shelves.toList()..sort();
        for (final sh in sorted) {
          final cand = free.where((l) => l.startsWith(sh)).toList();
          if (cand.isNotEmpty) return cand.first;
        }
        //同件所在区优先（集中堆放）
        final zones = shelves.map((s) => s[5]).toSet();
        final sameZone = free.where((l) => l.length > 5 && zones.contains(l[5])).toList();
        if (sameZone.isNotEmpty) return sameZone.first;
      }
    }
    return free.first;
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
            const Text("货位账本登记", style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
            const SizedBox(width: 6),
            Text(isAgv ? "选填 · 点选/输入/AUTO" : "选填 · 点选空位生成", style: const TextStyle(fontSize: 12, color: Colors.grey)),
          ],
        ),
        const SizedBox(height: 4),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _ledgerLocCtrl,
                textCapitalization: TextCapitalization.characters,
                enabled: !_palletMode || _currentPalletId != null,
                decoration: InputDecoration(
                  hintText: _palletMode && _currentPalletId == null
                      ? "整托：先扫首件，再点选/填（如 NB02-A-08-2F）"
                      : (isAgv ? "货位编码 / 输AUTO自动分配" : "点右侧选位（如 NB03-B-13-07）"),
                  isDense: true,
                  border: const OutlineInputBorder(),
                ),
              ),
            ),
            const SizedBox(width: 6),
            if (isAgv) ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF8B93E0), foregroundColor: Colors.white),
              onPressed: () => setState(() => _ledgerLocCtrl.text = _ledgerLocCtrl.text.trim().toUpperCase() == 'AUTO' ? '' : 'AUTO'),
              child: const Text("自动"),
            ),
            const SizedBox(width: 4),
            ElevatedButton(
              style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
              onPressed: isAgv ? _pickNb02 : _pickNb03,
              child: const Text("选位"),
            ),
            if (isAgv) ...[
              const SizedBox(width: 6),
              ElevatedButton(
                style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF00897B), foregroundColor: Colors.white),
                onPressed: _showWmasCard,
                child: const Text("提交任务"),
              ),
            ],
          ],
        ),
      ],
    );
  }

  /// 地面区内自动分配格位：zone 形如 "B13"；返回该排第一个空位编码，满则 null
  Future<String?> nb03AutoSlot(String zone) async {
    if (zone.isEmpty || zone.length < 2) return null;
    final g = zone.substring(0, 1);
    final nn = zone.substring(1).padLeft(2, '0');
    final prefix = 'NB03-$g-$nn';
    final maxSlot = _nb03R13.contains(prefix) ? 13 : 12;
    final byLoc = await _ledgerByLoc();
    for (var s = 1; s <= maxSlot; s++) {
      final code = '$prefix-${s.toString().padLeft(2, '0')}';
      if (!byLoc.containsKey(code)) return code;
    }
    return null;
  }

  ///AUTO 解析：按本次 MES 零件号给 NB02 自动分配货位并回填；分配不到保留 AUTO 走格式提示。
  Future<void> _handleAutoLedger(String code) async {
    final rec = await _isar.scanRecords.filter().goodsCodeEqualTo(code.toUpperCase()).findFirst();
    final partNo = rec?.mesPartNo ?? "";
    final loc = await nb02AutoAssign(partNo);
    if (!mounted) return;
    if (loc == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("货架已无空位，无法自动分配，请改用选位或手输"), backgroundColor: Colors.orange));
      return;
    }
    setState(() => _ledgerLocCtrl.text = loc);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("自动分配货位：$loc（零件 $partNo）"), backgroundColor: const Color(0xFF00897B)));
  }

  ///NB02 picker：选区→16架×4层网格，占用显示标签，点空位回填
  Future<void> _pickNb02() async {
    final byLoc = await _ledgerByLoc();
    if (!mounted) return;
    String zone = _ledgerLocCtrl.text.length > 5 ? _ledgerLocCtrl.text[5] : 'A';
    if (!'ABCDEFGH'.contains(zone)) zone = 'A';
    final picked = await showDialog<String>(context: context, builder: (dctx) {
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
                    backgroundColor: full ? const Color(0xFFE0E0E0) : Colors.white,
                    foregroundColor: full ? Colors.grey.shade600 : const Color(0xFF3F51B5),
                    padding: const EdgeInsets.symmetric(vertical: 8),
                  ),
                  onPressed: () {
                    if (full) {
                      ScaffoldMessenger.of(bctx).showSnackBar(SnackBar(content: Text("$code 已占用：${occ.join('、')}"), backgroundColor: Colors.orange));
                    } else {
                      Navigator.pop(bctx, code);
                    }
                  },
                  child: Text(full ? "${f}F\n${occ.length}码" : "$f" + "F", style: const TextStyle(fontSize: 12)),
                ),
              ),
            ));
          }
          rows.add(Row(children: [
            SizedBox(width: 40, child: Text("$zone-$rr", style: const TextStyle(fontSize: 12, fontFamily: "monospace"))),
            Expanded(child: Row(children: cells)),
          ]));
          rows.add(const SizedBox(height: 3));
        }
        return AlertDialog(
          title: Text("选择 AGV 货架位（$zone 区）"),
          content: SizedBox(
            width: 380, height: 420,
            child: Column(children: [
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: _lz.map((z) => Padding(
                  padding: const EdgeInsets.only(right: 6),
                  child: ChoiceChip(label: Text(z), selected: z == zone, onSelected: (_) => setSt(() => zone = z)),
                )).toList()),
              ),
              const SizedBox(height: 6),
              Expanded(child: ListView(children: rows)),
            ]),
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(bctx), child: const Text("取消"))],
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
    final maxSlot = _nb03R13.contains(prefix) ? 13 : 12;
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
              foregroundColor: full ? Colors.grey.shade600 : const Color(0xFF3F51B5),
            ),
            onPressed: () {
              if (full) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("$code 已占用：${occ.join('、')}"), backgroundColor: Colors.orange));
              } else {
                Navigator.pop(context, code);
              }
            },
            child: Text(full ? "$s\n${occ.length}码" : "$s"),
          ),
        ),
      ));
    }
    final picked = await showDialog<String>(context: context, builder: (dctx) => AlertDialog(
      title: Text("选格位：$prefix（空 ${maxSlot - byLoc.keys.where((k) => k.startsWith('$prefix-')).length}/$maxSlot）"),
      content: SizedBox(width: 300, child: Wrap(children: cells)),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx), child: const Text("取消"))],
    ));
    if (picked != null && mounted) setState(() => _ledgerLocCtrl.text = picked);
  }

  void _toastGroundPickFirst() {
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先在上方选择地面货位（区+排），再点选格位"), backgroundColor: Colors.orange));
  }

  ///WMAS 任务卡：容器类型自动反查主档得容器编码；可一键提交建任务+下发，也可退化为复制三要素手填
  void _showWmasCard() {
    final st = _selectedStation ?? "";
    final loc = _ledgerLocCtrl.text.trim().toUpperCase();
    final ctype = _containerType ?? "";
    showDialog(context: context, builder: (dctx) => _WmasCardDialog(startPoint: st, endPoint: loc, containerType: ctype));
  }
}


/// WMAS 任务确认对话框：容器编码反查主档（多候选可选），提交=建任务+下发
class _WmasCardDialog extends StatefulWidget {
  final String startPoint, endPoint, containerType;
  const _WmasCardDialog({required this.startPoint, required this.endPoint, required this.containerType});
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
        if (list.isEmpty) _err = "容器主档里没有「${widget.containerType}」对应的容器编码，请核对容器类型或手动在WMAS建任务";
      });
    } catch (e) {
      if (mounted) setState(() { _loading = false; _err = "查容器主档失败：$e"; });
    }
  }

  Future<void> _submit() async {
    final cn = _picked ?? "";
    if (cn.isEmpty || _busy) return;
    setState(() => _busy = true);
    final r = await WmasTask.createCarry(startPoint: widget.startPoint, endPoint: widget.endPoint, containerNo: cn);
    if (!mounted) return;
    setState(() => _busy = false);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(r["ok"] == true ? "AGV任务：${r["msg"]}" : "AGV任务失败：${r["msg"]}"),
      backgroundColor: r["ok"] == true ? const Color(0xFF2E7D32) : Colors.red, duration: const Duration(seconds: 4)));
    if (r["ok"] == true) Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final ready = widget.startPoint.isNotEmpty && widget.endPoint.isNotEmpty && widget.endPoint != 'AUTO';
    final cn = _picked ?? "";
    final clip = [widget.startPoint, widget.endPoint, cn].where((s) => s.isNotEmpty && s != 'AUTO').join("\n");
    return AlertDialog(
      title: const Text("AGV 搬运任务（WMAS）"),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text("起始库位：${widget.startPoint.isEmpty ? "（未选站台）" : widget.startPoint}", style: const TextStyle(fontSize: 14)),
        Text("目标库位：${!ready ? (widget.endPoint.isEmpty ? "（未定）" : widget.endPoint) : widget.endPoint}", style: const TextStyle(fontSize: 14)),
        const SizedBox(height: 4),
        Text("容器类型：${widget.containerType.isEmpty ? "（未选）" : widget.containerType}", style: const TextStyle(fontSize: 13, color: Colors.grey)),
        const SizedBox(height: 6),
        if (_loading)
          const Row(children: [SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2)), SizedBox(width: 8), Text("查询容器主档…", style: TextStyle(fontSize: 12))])
        else if (_err.isNotEmpty)
          Text(_err, style: const TextStyle(fontSize: 12.5, color: Colors.deepOrange))
        else if (_cands.length == 1)
          Text("容器编码：$cn", style: const TextStyle(fontSize: 14, fontFamily: "monospace", color: Color(0xFF1A237E)))
        else
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("容器编码（${widget.containerType} 在主档有 ${_cands.length} 个，选架上这只）：", style: const TextStyle(fontSize: 12, color: Colors.grey)),
            const SizedBox(height: 4),
            SizedBox(height: 96, child: ListView.builder(
              shrinkWrap: true, itemCount: _cands.length,
              itemBuilder: (bc, i) => RadioListTile<String>(
                dense: true, contentPadding: EdgeInsets.zero, visualDensity: VisualDensity.compact,
                title: Text(_cands[i], style: const TextStyle(fontSize: 13, fontFamily: "monospace")),
                value: _cands[i], groupValue: _picked, onChanged: (v) => setState(() => _picked = v),
              ),
            )),
          ]),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text("关闭")),
        TextButton(
          onPressed: clip.split("\n").length < 3 ? null : () {
            Clipboard.setData(ClipboardData(text: clip));
            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已复制三要素（每行一项）"), backgroundColor: Color(0xFF2E7D32)));
          },
          child: const Text("复制手填")),
        ElevatedButton.icon(
          style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF00897B), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
          onPressed: (ready && cn.isNotEmpty && !_busy && !_loading) ? _submit : null,
          icon: _busy ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.send, size: 16),
          label: const Text("提交任务"),
        ),
      ],
    );
  }
}

// ===== 全局推送助手（采集页/领料发料/出库单/登记页共用） =====
Timer? _pushLedgerTimer;
void scheduleLedgerPush({int seconds = 30}) {
  _pushLedgerTimer?.cancel();
  _pushLedgerTimer = Timer(Duration(seconds: seconds), () async {
    final r = await ledgerPushNow();
    if (r["ok"] != true) debugPrint("[ledger] 自动同步失败：${r["msg"]}");
  });
}

Future<Map> ledgerPushNow() async {
  try {
    final all = await _globalIsar.shelfPlacements.where().findAll();
    if (all.isEmpty) return {"ok": false, "msg": "账本为空"};
    final infos = {for (final e in await _globalIsar.labelInfos.where().findAll()) e.goodsCode: e};
    final pids = {for (final e in await _globalIsar.recordExtras.where().findAll()) e.goodsCode: e.palletId}; // 托号：整托多码同框
    final items = all.map((p) {
      final i = infos[p.goodsCode];
      final pid = pids[p.goodsCode] ?? "";
      return {
        "c": p.goodsCode, "l": p.loc, "f": p.container, "t": p.assignedAt,
        if (pid.isNotEmpty) "pid": pid,
        if (i != null && !i.missing) ...{"p": i.partNo, "n": i.itemName, "q": i.qty, "b": i.lotNo},
      };
    }).toList();
    return await AuthApi.ledgerSync(items);
  } catch (e) {
    return {"ok": false, "msg": "$e"};
  }
}

/// 从账本查某标签当前货位（出库单补记原货位用），查不到返回空串
Future<String> ledgerLocOfCode(String code) async {
  try {
    if (code.isEmpty) return "";
    final sp = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(code.toUpperCase()).findAll();
    return sp.isNotEmpty ? sp.first.loc : "";
  } catch (_) { return ""; }
}

/// 从账本拣下这些标签（出库/发料用），并尽快推送电脑。找不到/已不在账本不报错。
Future<void> ledgerRemoveAndPush(Iterable<String> codes) async {
  try {
    await _globalIsar.writeTxn(() async {
      for (final c in codes) {
        final olds = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(c).findAll();
        if (olds.isNotEmpty) await _globalIsar.shelfPlacements.deleteAll(olds.map((e) => e.id).toList());
      }
    });
    scheduleLedgerPush(seconds: 8);
  } catch (e) {
    debugPrint("[ledger] 拣下失败：$e");
  }
}

Timer? _pushScanTimer;
void scheduleScanPush({int seconds = 60}) {
  _pushScanTimer?.cancel();
  _pushScanTimer = Timer(Duration(seconds: seconds), scanPushNow);
}

/// 采集流水全量推送电脑（含作废标记，按 标签|批次|时间 键去重）
Future<void> scanPushNow() async {
  try {
    final all = await _globalIsar.scanRecords.where().findAll();
    if (all.isEmpty) return;
    final extras = {for (final e in await _globalIsar.recordExtras.where().findAll()) e.goodsCode: e};
    final items = all.map((r) {
      final x = extras[r.goodsCode.toUpperCase()];
      return {
        "k": "${r.goodsCode}|${r.batchId}|${r.scanTime.millisecondsSinceEpoch}",
        "code": r.goodsCode, "wt": r.workType, "st": r.stationNo ?? "", "gl": r.groundLocation ?? "",
        "ct": r.containerType ?? "", "rm": r.remark, "batch": r.batchId, "cx": r.isCancel,
        "t": r.scanTime.millisecondsSinceEpoch, "pn": r.mesPartNo ?? "", "q": r.mesQty ?? 0,
        "mk": r.mesCreateTime ?? "", "op": x?.operator ?? "", "nm": x?.mesItemName ?? "",
        "lot": x?.mesLotNo ?? "", "pid": x?.palletId ?? "",
      };
    }).toList();
    final res = await AuthApi.scanlogSync(items);
    if (res["ok"] != true) debugPrint("[scanlog] 同步失败：${res["msg"]}");
  } catch (e) {
    debugPrint("[scanlog] 同步异常：$e");
  }
}

/// 单张出库单推送电脑（按单号去重覆盖，核对状态变化也会更新）
void outboundPushNow(OutboundOrder ob) {
  () async {
    try {
      final items = (jsonDecode(ob.itemsJson) as List);
      final res = await AuthApi.outboundSync({
        "orderNo": ob.orderNo, "createdAt": ob.createdAt, "toLoc": ob.toLoc, "operator": ob.operator,
        "status": ob.status, "linkReqNo": ob.linkReqNo, "items": items,
      });
      if (res["ok"] != true) debugPrint("[outbound] 同步失败：${res["msg"]}");
    } catch (e) {
      debugPrint("[outbound] 同步异常：$e");
    }
  }();
}
