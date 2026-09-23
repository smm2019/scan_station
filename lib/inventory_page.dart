// ===== 盘点模式 UI：任务列表 / 新建任务 / 盘点扫码 / 差异报表 =====
// 本文件是 main.dart 的 part，共享同一库：可直接使用 BatchInfo、InventoryScan、
// BaselineBook/Loc、judgeInventory、mesQueryLabel、_globalIsar 等。
// 设计依据《盘点模式设计方案》M1：双Tab入口、任务制、先绑货位再扫货码、
// 盲盘默认开、判定状态机（0正常/1重复/2MES无码/3账外料/4串位/5超量）。

part of 'main.dart';

// ===================== 盘点·差异计算与报表 =====================

class InvPartDiff {
  final String partNo;
  String itemName;
  double bookQty;
  double realQty;
  int realBoxes;
  int outsideBoxes; //账外料(flag3)计数，不并入realQty
  double outsideQty;
  int warnFlag = 0; //7=双基准矛盾（货位台账合计≠账面基准）
  InvPartDiff(this.partNo, this.itemName, this.bookQty)
      : realQty = 0, realBoxes = 0, outsideBoxes = 0, outsideQty = 0;
}

class InvLocDiff {
  final String locCode;
  final String partNo;
  final String itemName;
  double bookQty;
  double realQty;
  int realBoxes;
  InvLocDiff(this.locCode, this.partNo, this.itemName, this.bookQty)
      : realQty = 0, realBoxes = 0;
}

class InvDiffResult {
  final List<InvPartDiff> parts = [];
  final List<InvLocDiff> locs = [];
  final List<InventoryScan> mesFail = [];
  final List<InventoryScan> dup = [];
  int totalScans = 0;
  int validScans = 0;
}

Future<InvDiffResult> computeInvDiff(BatchInfo task) async {
  final r = InvDiffResult();
  final scans = await _globalIsar.inventoryScans
      .filter().taskIdEqualTo(task.batchId).findAll();
  scans.sort((a, b) => a.scanTime.compareTo(b.scanTime));
  r.totalScans = scans.length;
  for (final s in scans) {
    if (s.flag == 1) r.dup.add(s);
    if (s.flag == 2) r.mesFail.add(s);
  }
  final valid = scans.where((s) => s.flag != 1 && s.flag != 2).toList();
  r.validScans = valid.length;
  final books = await _globalIsar.baselineBooks.where().findAll();
  final locBase = await _globalIsar.baselineLocs.where().findAll();

  //零件号级：账面基准 ∪ 实扫出现过的零件号（账外料）
  final Map<String, InvPartDiff> pMap = {};
  for (final b in books) {
    pMap[b.partNo] = InvPartDiff(b.partNo, b.itemName, b.bookQty);
  }
  final Map<String, double> locAgg = {}; //货位基准按零件号合计（双基准矛盾检测）
  for (final l in locBase) {
    locAgg[l.partNo] = (locAgg[l.partNo] ?? 0) + l.qty;
  }
  for (final s in valid) {
    final d = pMap[s.partNo];
    if (d == null) continue;
    if (s.flag == 3) { d.outsideBoxes++; d.outsideQty += s.qty; }
    else { d.realQty += s.qty; d.realBoxes++; }
    if (d.itemName.isEmpty) d.itemName = s.itemName;
  }
  for (final s in valid) {
    if (!pMap.containsKey(s.partNo)) {
      final d = InvPartDiff(s.partNo, s.itemName, 0)
        ..realQty = s.qty ..realBoxes = 1;
      pMap[s.partNo] = d;
    }
  }
  pMap.forEach((pn, d) {
    final la = locAgg[pn];
    if (la != null && (la - d.bookQty).abs() > 1e-6) d.warnFlag = 7;
  });
  r.parts.addAll(pMap.values);
  r.parts.sort((a, b) {
    final da = (a.realQty - a.bookQty + a.outsideQty).abs();
    final db = (b.realQty - b.bookQty + b.outsideQty).abs();
    return db.compareTo(da);
  });

  //货位级：货位基准行 ∪ 实扫(货位,零件)组合
  final Map<String, InvLocDiff> lMap = {};
  for (final l in locBase) {
    final k = '${l.locCode}|${l.partNo}';
    final d = lMap.putIfAbsent(k, () => InvLocDiff(l.locCode, l.partNo, l.goodsCode, 0));
    d.bookQty += l.qty;
  }
  for (final s in valid) {
    final k = '${s.locCode}|${s.partNo}';
    final d = lMap.putIfAbsent(k, () => InvLocDiff(s.locCode, s.partNo, s.itemName, 0));
    if (s.flag != 3) { d.realQty += s.qty; d.realBoxes++; }
  }
  r.locs.addAll(lMap.values);
  r.locs.sort((a, b) {
    final da = (a.realQty - a.bookQty).abs();
    final db = (b.realQty - b.bookQty).abs();
    if (db != da) return db.compareTo(da);
    return a.locCode.compareTo(b.locCode);
  });
  return r;
}

/// 疑似串位配对：同零件号 A货位亏 -N、B货位盈 +N → 返回标注文本 map（key=loc|part）
Map<String, String> invPairMoveSuggest(InvDiffResult d) {
  final out = <String, String>{};
  final byPart = <String, List<InvLocDiff>>{};
  for (final l in d.locs) {
    byPart.putIfAbsent(l.partNo, () => []).add(l);
  }
  for (final entry in byPart.entries) {
    final negs = entry.value.where((l) => l.bookQty > 0 && (l.realQty - l.bookQty) < -1e-6).toList()
      ..sort((a, b) => (a.realQty - a.bookQty).compareTo(b.realQty - b.bookQty));
    final poss = entry.value.where((l) => (l.realQty - l.bookQty) > 1e-6).toList()
      ..sort((a, b) => (b.realQty - b.bookQty).compareTo(a.realQty - a.bookQty));
    var pi = 0;
    for (final n in negs) {
      var need = n.bookQty - n.realQty;
      while (need > 1e-6 && pi < poss.length) {
        final p = poss[pi];
        final give = p.realQty - p.bookQty;
        if (give <= 1e-6) { pi++; continue; }
        final mv = need < give ? need : give;
        out['${n.locCode}|${n.partNo}'] = '疑似串位 → ${p.locCode} 移 ${_fmtInvNum(mv)}';
        out['${p.locCode}|${p.partNo}'] = '疑似串位 ← ${n.locCode} 移回 ${_fmtInvNum(mv)}';
        need -= mv;
        p.realQty -= mv; //已配平部分不再重复配对
        if ((p.realQty - p.bookQty).abs() <= 1e-6) pi++;
      }
    }
  }
  return out;
}

String _fmtInvNum(double q) => q == q.roundToDouble() ? q.toInt().toString() : q.toStringAsFixed(2);

String _invCsvField(String v) {
  if (v.contains(",") || v.contains("\"") || v.contains("\n")) return "\"${v.replaceAll("\"", "\"\"")}\"";
  return v;
}

/// 生成差异报表 CSV（零件级 + 货位级 + 异常清单）
String buildInvDiffCsv(BatchInfo task, InvDiffResult d) {
  final mv = invPairMoveSuggest(d);
  String s = "盘点任务,${_invCsvField(task.batchId)},${_invCsvField(task.batchRemark)},基准版本 账面:${_invCsvField(task.invBookKey)} 货位:${_invCsvField(task.invLocKey)}\n";
  s += "\n===零件号级差异(对齐基础数据表)===\n";
  s += "零件号,物料名称,期末库存,实盘数量,差异数量,账外扫入,差异类型,双基准矛盾\n";
  for (final p in d.parts) {
    final diff = p.realQty - p.bookQty;
    String type;
    if (diff.abs() < 1e-6 && p.outsideBoxes == 0) type = "正常";
    else if (diff < -1e-6) type = "盘亏";
    else if (diff > 1e-6) type = "盘盈";
    else type = "正常(有账外扫入)";
    if (p.outsideBoxes > 0 && p.bookQty == 0 && p.realBoxes == 0) type = "账外料";
    s += "${_invCsvField(p.partNo)},${_invCsvField(p.itemName)},${_fmtInvNum(p.bookQty)},${_fmtInvNum(p.realQty)},${_fmtInvNum(diff)},${p.outsideBoxes > 0 ? _fmtInvNum(p.outsideQty) : ''},$type,${p.warnFlag == 7 ? '货位台账合计≠账面，先核两版账' : ''}\n";
  }
  s += "\n===货位级差异(对齐货架列表)===\n";
  s += "货位编码,零件号,台账数量,实盘数量,差异,定位/建议\n";
  for (final l in d.locs) {
    final diff = l.realQty - l.bookQty;
    final note = mv['${l.locCode}|${l.partNo}'] ?? '';
    s += "${_invCsvField(l.locCode)},${_invCsvField(l.partNo)},${_fmtInvNum(l.bookQty)},${_fmtInvNum(l.realQty)},${_fmtInvNum(diff)},${_invCsvField(note)}\n";
  }
  s += "\n===异常清单===\n";
  if (d.mesFail.isEmpty && d.dup.isEmpty) {
    s += "无异常\n";
  } else {
    for (final f in d.mesFail) {
      s += "MES无码,${_invCsvField(f.goodsCode)},${_invCsvField(f.locCode)},${f.scanTime.toString().substring(0, 19)},${_invCsvField(f.remark)}\n";
    }
    for (final p in d.dup) {
      s += "重复码,${_invCsvField(p.goodsCode)},${_invCsvField(p.locCode)},${p.scanTime.toString().substring(0, 19)},已在同任务扫过\n";
    }
  }
  return s;
}

Future<String> saveInvDiffCsv(BatchInfo task, InvDiffResult d) async {
  final csv = buildInvDiffCsv(task, d);
  final dir = await getExternalStorageDirectory();
  if (dir == null) throw Exception("无法获取应用存储目录");
  final file = File("${dir.path}/盘点_${task.batchId}.csv");
  await file.writeAsString(csv, encoding: utf8);
  return file.path;
}

// ===================== 盘点·首页（任务列表） =====================

class InventoryHomePage extends StatefulWidget {
  const InventoryHomePage({super.key});
  @override
  State<InventoryHomePage> createState() => _InventoryHomePageState();
}

class _InventoryHomePageState extends State<InventoryHomePage> {
  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<BatchInfo>>(
      future: _globalIsar.batchInfos.where().findAll().then((list) {
        list = list.where((b) => b.taskKind == 1).toList();
        list.sort((a, b) => b.createTime.compareTo(a.createTime));
        return list;
      }),
      builder: (ctx, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        final tasks = snap.data!;
        return Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                  onPressed: () async {
                    final created = await Navigator.push<bool>(ctx, MaterialPageRoute(builder: (_) => const _InvTaskCreatePage()));
                    if (created == true && mounted) setState(() {});
                  },
                  icon: const Icon(Icons.add),
                  label: const Text("新建盘点任务"),
                ),
              ),
            ),
            Expanded(
              child: tasks.isEmpty
                  ? const Center(child: Text("暂无盘点任务，点击上方新建\n（盘点前请先在网页门户上传两份基准CSV）", textAlign: TextAlign.center, style: TextStyle(fontSize: 13, color: Colors.grey)))
                  : ListView.builder(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      itemCount: tasks.length,
                      itemBuilder: (ctx, i) {
                        final t = tasks[i];
                        return FutureBuilder<int>(
                          future: _globalIsar.inventoryScans.filter().taskIdEqualTo(t.batchId).count(),
                          builder: (ctx, cs) {
                            final cnt = cs.data ?? 0;
                            return Card(
                              child: ListTile(
                                leading: Icon(t.isArchived ? Icons.task_alt : Icons.fact_check_outlined, color: t.isArchived ? Colors.green : const Color(0xFF515BD4)),
                                title: Text(t.batchRemark.isEmpty ? t.batchId : t.batchRemark, style: const TextStyle(fontWeight: FontWeight.w600)),
                                subtitle: Text("${t.createTime.substring(0, 16)}  ·  已扫 $cnt 码  ·  ${t.blindMode ? "盲盘" : "监督"}\n账面基准:${t.invBookKey.isEmpty ? "未绑定" : "已绑定"} 货位基准:${t.invLocKey.isEmpty ? "未绑定" : "已绑定"}", style: const TextStyle(fontSize: 12)),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () async {
                                  if (t.isArchived) {
                                    await Navigator.push(ctx, MaterialPageRoute(builder: (_) => _InvDiffPage(task: t)));
                                  } else {
                                    await Navigator.push(ctx, MaterialPageRoute(builder: (_) => _InvScanPage(task: t)));
                                  }
                                  if (mounted) setState(() {});
                                },
                              ),
                            );
                          },
                        );
                      },
                    ),
            ),
          ],
        );
      },
    );
  }
}

// ===================== 盘点·新建任务（三步） =====================

class _InvTaskCreatePage extends StatefulWidget {
  const _InvTaskCreatePage();
  @override
  State<_InvTaskCreatePage> createState() => _InvTaskCreatePageState();
}

class _InvTaskCreatePageState extends State<_InvTaskCreatePage> {
  final _nameCtrl = TextEditingController();
  bool _blind = true;
  String _bookKey = "", _bookName = "", _locKey = "", _locName = "";
  String _bookInfo = "", _locInfo = "";
  int _step = 0;

  @override
  void dispose() {
    _nameCtrl.dispose();
    super.dispose();
  }

  Future<void> _pickBaseline(bool isBook) async {
    final files = await listBaselineFiles();
    if (!mounted) return;
    if (files.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("baseline 目录暂无文件，请先在电脑浏览器打开 App 显示地址的网页门户，上传两份台账导出的 CSV")));
      return;
    }
    final picked = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          children: [
            const Padding(padding: EdgeInsets.all(14), child: Text("选择基准文件（即导出的台账）", style: TextStyle(fontWeight: FontWeight.bold))),
            ...files.map((f) => ListTile(
                  title: Text(f["name"] as String),
                  subtitle: Text("${(((f["size"] as int)) / 1024).toStringAsFixed(0)} KB · ${((f["mtime"] as String)).substring(0, 16)}"),
                  onTap: () => Navigator.pop(ctx, f["path"] as String),
                )),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    final fname = picked.split(RegExp(r"[\\/]")).last;
    final key = "$fname@${File(picked).statSync().modified.millisecondsSinceEpoch}";
    final res = await importBaselineFile(picked, key, isBook ? "book" : "part");
    if (!mounted) return;
    final want = isBook ? "book" : "part";
    if (res.kind == "unknown") {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("解析失败：${res.message}")));
      return;
    }
    if (res.kind != want) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(isBook ? "该文件被识别为货位基准（含货位列），请到下方选货位基准槽位" : "该文件被识别为账面基准（无货位列），请选上方账面基准槽位")));
      return;
    }
    setState(() {
      if (isBook) {
        _bookKey = key; _bookName = fname;
        _bookInfo = "零件 ${res.books.length} 个${res.dirtyRows > 0 ? "，跳过脏行 ${res.dirtyRows}" : ""}";
      } else {
        _locKey = key; _locName = fname;
        _locInfo = "货位×零件 ${res.locs.length} 行${res.dirtyRows > 0 ? "，跳过脏行 ${res.dirtyRows}" : ""}";
      }
    });
  }

  Widget _slotTile(String label, String picked, String info, bool isBook, Color color) {
    return Card(
      color: picked.isEmpty ? null : color.withOpacity(0.08),
      child: ListTile(
        leading: Icon(picked.isEmpty ? Icons.upload_file : Icons.check_circle, color: picked.isEmpty ? Colors.grey : color),
        title: Text(label, style: const TextStyle(fontWeight: FontWeight.w600)),
        subtitle: Text(picked.isEmpty ? "点击选择台账导出CSV（需先在网页门户上传到手机）" : "$picked\n$info", style: const TextStyle(fontSize: 12)),
        onTap: () => _pickBaseline(isBook),
      ),
    );
  }

  Future<void> _create() async {
    final name = _nameCtrl.text.trim().isEmpty ? "盘点${DateTime.now().toString().substring(5, 10).replaceAll("-", "")}" : _nameCtrl.text.trim();
    final ts = DateTime.now();
    final task = BatchInfo(
      batchId: "INV${ts.millisecondsSinceEpoch}",
      createTime: ts.toString(),
      batchRemark: name,
      taskKind: 1,
      invBookKey: _bookKey,
      invLocKey: _locKey,
      blindMode: _blind,
    );
    await _globalIsar.batchInfos.put(task);
    if (!mounted) return;
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => _InvScanPage(task: task)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(backgroundColor: const Color(0xFF515BD4), title: Text("新建盘点任务（${_step + 1}/3）")),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_step == 0) ...[
              TextField(
                controller: _nameCtrl,
                decoration: const InputDecoration(labelText: "任务名称", hintText: "例：二楼A货架 9月盘点", border: OutlineInputBorder()),
              ),
              const SizedBox(height: 14),
              SwitchListTile(
                value: _blind,
                activeColor: const Color(0xFF515BD4),
                title: const Text("盲盘模式", style: TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text(_blind ? "现场不显示账面数量与差额，防止「扫到账面数就停」掩盖盘亏" : "监督模式：扫码后同时显示该货位该零件台账数量"),
                onChanged: (v) => setState(() => _blind = v),
              ),
            ],
            if (_step == 1) ...[
              const Padding(padding: EdgeInsets.only(bottom: 8), child: Text("第一步先上传：电脑浏览器打开 App 显示的门户地址 → 上传两份台账导出 CSV", style: TextStyle(fontSize: 12, color: Colors.grey))),
              _slotTile("① 账面基准（基础数据表导出）", _bookName, _bookInfo, true, const Color(0xFF515BD4)),
              const SizedBox(height: 10),
              _slotTile("② 货位基准（二楼货架列表导出，可选）", _locName, _locInfo, false, Colors.teal),
              const SizedBox(height: 8),
              const Text("说明：货位基准可不选——缺失时只能对总量盘盈盘亏，无法定位串位。同零件号重复行自动累加。", style: TextStyle(fontSize: 12, color: Colors.grey)),
            ],
            if (_step == 2) ...[
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text("任务名：${_nameCtrl.text.trim().isEmpty ? "（自动生成：盘点+日期）" : _nameCtrl.text.trim()}"),
                      const SizedBox(height: 6),
                      Text("模式：${_blind ? "盲盘" : "监督"}"),
                      const SizedBox(height: 6),
                      Text("账面基准：${_bookName.isEmpty ? "⚠️未选择（无法判定账外料）" : "$_bookName（$_bookInfo）"}"),
                      const SizedBox(height: 6),
                      Text("货位基准：${_locName.isEmpty ? "未选择（不做串位/超量判定）" : "$_locName（$_locInfo）"}"),
                      const SizedBox(height: 6),
                      const Text("⚠️ 盘点期间请冻结出入库，否则产生虚假盘亏。", style: TextStyle(color: Colors.red, fontSize: 12)),
                    ],
                  ),
                ),
              ),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                if (_step > 0) Expanded(child: OutlinedButton(onPressed: () => setState(() => _step--), child: const Text("上一步"))),
                if (_step > 0) const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
                    onPressed: _step == 2
                        ? (_bookKey.isEmpty && _locKey.isEmpty ? null : _create)
                        : () {
                            if (_step == 1 && _bookKey.isEmpty && _locKey.isEmpty) {
                              ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("至少选择一个基准文件")));
                              return;
                            }
                            setState(() => _step++);
                          },
                    child: Text(_step == 2 ? "创建并开始盘点" : "下一步"),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

// ===================== 盘点·扫码页 =====================

class _InvScanPage extends StatefulWidget {
  final BatchInfo task;
  const _InvScanPage({required this.task});
  @override
  State<_InvScanPage> createState() => _InvScanPageState();
}

class _InvScanPageState extends State<_InvScanPage> {
  final _codeCtrl = TextEditingController();
  final _codeFocus = FocusNode();
  String _curLoc = "";
  bool _busy = false;
  final List<InventoryScan> _recent = [];
  InvJudge? _lastJudge;
  String _lastCode = "";

  @override
  void initState() {
    super.initState();
    _loadRecent();
  }

  @override
  void dispose() {
    _codeCtrl.dispose();
    _codeFocus.dispose();
    super.dispose();
  }

  Future<List<String>> _locOptions() async {
    final locs = await _globalIsar.baselineLocs.where().findAll();
    return locs.map((e) => e.locCode).toSet().toList()..sort();
  }

  Future<void> _pickLoc() async {
    final opts = await _locOptions();
    if (!mounted) return;
    if (opts.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("货位基准未绑定或无货位数据，请在创建任务时绑定货位基准")));
      return;
    }
    final sel = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          children: [
            const Padding(padding: EdgeInsets.all(14), child: Text("选择当前盘点货位", style: TextStyle(fontWeight: FontWeight.bold))),
            ...opts.map((o) => ListTile(
                  title: Text(o),
                  trailing: o == _curLoc ? const Icon(Icons.check, color: Color(0xFF515BD4)) : null,
                  onTap: () => Navigator.pop(ctx, o),
                )),
          ],
        ),
      ),
    );
    if (sel != null && mounted) setState(() => _curLoc = sel);
  }

  Future<void> _loadRecent() async {
    final rows = await _globalIsar.inventoryScans
        .filter().taskIdEqualTo(widget.task.batchId).sortByScanTimeDesc().limit(30).findAll();
    if (!mounted) return;
    setState(() => _recent
      ..clear()
      ..addAll(rows.reversed)); //按时间正序展示，最新在列表底部
  }

  Future<void> _submit(String code) async {
    if (_busy) return;
    code = code.trim();
    if (code.isEmpty) return;
    if (_curLoc.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先绑定当前盘点货位！")));
      return;
    }
    _busy = true;
    try {
      // 1. 重复码检测（同任务）
      final dupRows = await _globalIsar.inventoryScans
          .filter().taskIdEqualTo(widget.task.batchId).goodsCodeEqualTo(code).findAll();
      final rec = InventoryScan(taskId: widget.task.batchId, goodsCode: code, scanTime: DateTime.now(), locCode: _curLoc);
      InvJudge judge;
      if (dupRows.isNotEmpty) {
        rec.flag = 1;
        judge = InvJudge(1, "red", "重复码：本任务已扫过（${dupRows.first.locCode} ${dupRows.first.scanTime.toString().substring(11, 16)}），不计数量");
      } else {
        // 2. MES 反查
        final mes = await mesQueryLabel(code);
        if (mes["ok"] != true) {
          rec.flag = 2;
          rec.remark = mes["msg"].toString();
          judge = InvJudge(2, "purple", "MES无此码（${mes["msg"]}），已挂起待复核");
        } else {
          rec.partNo = mes["partNo"];
          rec.itemName = mes["itemName"];
          rec.lotNo = mes["lotNo"];
          rec.qty = mes["qty"];
          // 3. 账内外 + 串位 + 超量
          final bookHit = await _globalIsar.baselineBooks.filter().partNoEqualTo(rec.partNo).findAll();
          final locHit = await _globalIsar.baselineLocs
              .filter().locCodeEqualTo(_curLoc).partNoEqualTo(rec.partNo).findAll();
          double scannedInLoc = rec.qty;
          final priorRows = await _globalIsar.inventoryScans
              .filter().taskIdEqualTo(widget.task.batchId).locCodeEqualTo(_curLoc).partNoEqualTo(rec.partNo).findAll();
          for (final s in priorRows.where((s) => s.flag != 1)) {
            scannedInLoc += s.qty;
          }
          final locBook = locHit.fold<double>(0, (sum, e) => sum + e.qty);
          if (bookHit.isEmpty && !locHit.isEmpty) {
            //货位台账有、总账没有 → 双基准矛盾，按账外料口径记，并备注
            rec.flag = 3;
            rec.remark = "双基准矛盾：总账无此零件但货位台账登记";
            judge = InvJudge(3, "red", "⚠️双基准矛盾：总账基准查无「${rec.partNo}」，但货位台账有登记——先核两份账谁旧了");
          } else if (bookHit.isEmpty) {
            rec.flag = 3;
            judge = InvJudge(3, "red", "账外物料：零件「${rec.partNo}」不在账面基准，仍已记录");
          } else {
            rec.partNo = bookHit.first.partNo; //统一以基准写法为准（大小写差异归一）
            judge = judgeInventory(
              partInBook: true,
              partInLoc: !locHit.isEmpty,
              scannedQtyInLoc: scannedInLoc,
              locBookQty: locBook,
            );
            rec.flag = judge.flag;
            if (judge.flag == 4) judge = InvJudge(4, "yellow", "串位提示：货位「$_curLoc」台账无零件「${rec.partNo}」，仍已记录");
            if (judge.flag == 5) {
              judge = widget.task.blindMode
                  ? InvJudge(5, "yellow", "超量提示：「$_curLoc」该零件实扫已超台账（盲盘，账面数结束后可见）")
                  : InvJudge(5, "yellow", "超量提示：「$_curLoc」该零件已扫 ${_fmtInvNum(scannedInLoc)}，台账 ${_fmtInvNum(locBook)}");
            }
            if (judge.flag == 0 && !_curLoc.isEmpty) {
              judge = InvJudge(0, "green", "正常：${rec.partNo} ${_fmtInvNum(rec.qty)} 件 @ $_curLoc");
            }
          }
        }
      }
      await _globalIsar.inventoryScans.put(rec);
      // 震动/声音提示：异常强提醒
      try {
        if (judge.level == "red" || judge.level == "purple") {
          if (await Vibration.hasVibrator() ?? false) await Vibration.vibrate(duration: 220);
        } else if (await Vibration.hasVibrator() ?? false) {
          await Vibration.vibrate(duration: 80);
        }
        await SystemSound.play(judge.level == "green" ? SystemSoundType.click : SystemSoundType.alert);
      } catch (_) {}
      setState(() {
        _lastJudge = judge;
        _lastCode = code;
        _recent.add(rec);
        _codeCtrl.clear();
      });
      _codeFocus.requestFocus();
    } finally {
      _busy = false;
    }
  }

  Future<void> _openCamera() async {
    bool handled = false;
    final result = await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        insetPadding: EdgeInsets.zero,
        contentPadding: EdgeInsets.zero,
        content: SizedBox(
          width: 300, height: 350,
          child: MobileScanner(
            onDetect: (capture) {
              if (handled) return;
              final bars = capture.barcodes;
              if (bars.isNotEmpty && bars.first.rawValue != null) {
                handled = true;
                Navigator.pop(ctx, bars.first.rawValue!.trim());
              }
            },
          ),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭"))],
      ),
    );
    if (result != null) await _submit(result.toString());
  }

  Color _levelColor(String lv) => switch (lv) {
        "green" => const Color(0xFF1E9E6A),
        "yellow" => const Color(0xFFD97706),
        "red" => const Color(0xFFC0392B),
        "purple" => const Color(0xFF7C3AED),
        _ => Colors.grey,
      };

  Future<void> _finishTask() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("结束盘点任务"),
        content: const Text("结束后进入差异报表，之后不可再扫描。确认结束？"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("继续盘点")),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认结束")),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final task = widget.task;
    task.isArchived = true;
    await _globalIsar.batchInfos.put(task);
    if (!mounted) return;
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => _InvDiffPage(task: task)));
  }

  @override
  Widget build(BuildContext context) {
    final total = _recent.length;
    final abnormal = _recent.where((s) => s.flag != 0).length;
    final inLoc = _recent.where((s) => s.locCode == _curLoc && s.flag != 1).length;
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF515BD4),
        title: Text("盘点 · ${widget.task.batchRemark}", overflow: TextOverflow.ellipsis),
        actions: [
          IconButton(tooltip: "任务信息", icon: const Icon(Icons.info_outline), onPressed: () => showDialog(context: context, builder: (ctx) => AlertDialog(
            title: const Text("任务基准"),
            content: Text("账面基准：${widget.task.invBookKey.isEmpty ? "未绑定" : widget.task.invBookKey}\n货位基准：${widget.task.invLocKey.isEmpty ? "未绑定" : widget.task.invLocKey}\n模式：${widget.task.blindMode ? "盲盘" : "监督"}"),
            actions: [TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭"))],
          ))),
          IconButton(tooltip: "刷新", onPressed: _loadRecent, icon: const Icon(Icons.refresh)),
          IconButton(tooltip: "结束任务", onPressed: _finishTask, icon: const Icon(Icons.flag)),
        ],
      ),
      body: Column(
        children: [
          //货位绑定芯片
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
            child: Row(
              children: [
                Expanded(
                  child: InkWell(
                    onTap: _pickLoc,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                        color: _curLoc.isEmpty ? Colors.red.shade50 : const Color(0xFFE8EAF6),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: _curLoc.isEmpty ? Colors.red : const Color(0xFF515BD4)),
                      ),
                      child: Row(
                        children: [
                          Icon(Icons.location_on, size: 18, color: _curLoc.isEmpty ? Colors.red : const Color(0xFF515BD4)),
                          const SizedBox(width: 6),
                          Expanded(child: Text(_curLoc.isEmpty ? "未绑定货位，点击选择（必须先绑货位才能扫码）" : "当前货位：$_curLoc（点击更换）", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _curLoc.isEmpty ? Colors.red : const Color(0xFF3949AB)))),
                          const Icon(Icons.swap_horiz, size: 18),
                        ],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            child: Row(
              children: [
                _chip("本货位 $inLoc", const Color(0xFFE8EAF6), const Color(0xFF3949AB)),
                const SizedBox(width: 8),
                _chip("总扫码 $total", Colors.grey.shade200, Colors.black87),
                const SizedBox(width: 8),
                _chip("异常 $abnormal", abnormal > 0 ? Colors.red.shade50 : Colors.green.shade50, abnormal > 0 ? Colors.red : Colors.green),
              ],
            ),
          ),
          //扫码输入行
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _codeCtrl,
                    focusNode: _codeFocus,
                    autofocus: true,
                    enabled: _curLoc.isNotEmpty,
                    textInputAction: TextInputAction.done,
                    decoration: InputDecoration(
                      hintText: _curLoc.isEmpty ? "请先绑定货位" : "扫码枪扫货物标签 / 手输后回车",
                      border: const OutlineInputBorder(),
                      isDense: true,
                      prefixIcon: const Icon(Icons.qr_code_scanner),
                    ),
                    onSubmitted: _submit,
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: _curLoc.isEmpty ? null : _openCamera,
                  style: IconButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
                  icon: const Icon(Icons.photo_camera),
                ),
              ],
            ),
          ),
          //最近一次判定大字卡
          if (_lastJudge != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: _levelColor(_lastJudge!.level).withOpacity(0.10),
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: _levelColor(_lastJudge!.level)),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(_lastJudge!.flag == 0 ? Icons.check_circle : Icons.warning_amber, color: _levelColor(_lastJudge!.level), size: 20),
                        const SizedBox(width: 6),
                        Expanded(child: Text(_lastJudge!.msg, style: TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: _levelColor(_lastJudge!.level)))),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text("码：$_lastCode", style: const TextStyle(fontSize: 12, color: Colors.black87)),
                  ],
                ),
              ),
            ),
          //历史流水（最新在上）
          Expanded(
            child: _recent.isEmpty
                ? const Center(child: Text("尚无扫描记录", style: TextStyle(color: Colors.grey)))
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    reverse: true,
                    itemCount: _recent.length,
                    itemBuilder: (ctx, i) {
                      final s = _recent[i];
                      final lv = s.flag == 0 ? "green" : (s.flag == 4 || s.flag == 5) ? "yellow" : (s.flag == 2 ? "purple" : "red");
                      return ListTile(
                        dense: true,
                        leading: CircleAvatar(radius: 12, backgroundColor: _levelColor(lv), child: Text("${s.flag}", style: const TextStyle(fontSize: 11, color: Colors.white))),
                        title: Text("${s.goodsCode}${s.partNo.isEmpty ? "" : "  →  ${s.partNo}"}", style: const TextStyle(fontSize: 13, fontFamily: "monospace")),
                        subtitle: Text("${s.scanTime.toString().substring(11, 19)}  @${s.locCode}  ${_fmtInvNum(s.qty)}${s.remark.isEmpty ? "" : "  ${s.remark}"}", style: const TextStyle(fontSize: 11)),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _chip(String t, Color bg, Color fg) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(20)),
        child: Text(t, style: TextStyle(fontSize: 12, color: fg, fontWeight: FontWeight.w600)),
      );
}

// ===================== 盘点·差异报表页 =====================

class _InvDiffPage extends StatefulWidget {
  final BatchInfo task;
  const _InvDiffPage({required this.task});
  @override
  State<_InvDiffPage> createState() => _InvDiffPageState();
}

class _InvDiffPageState extends State<_InvDiffPage> {
  late Future<InvDiffResult> _future;

  @override
  void initState() {
    super.initState();
    _future = computeInvDiff(widget.task);
  }

  Future<void> _export() async {
    try {
      final d = await _future;
      final path = await saveInvDiffCsv(widget.task, d);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("差异报表已保存：$path")));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("保存失败：$e")));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF515BD4),
        title: Text("差异报表 · ${widget.task.batchRemark}", overflow: TextOverflow.ellipsis),
        actions: [IconButton(tooltip: "导出CSV", onPressed: _export, icon: const Icon(Icons.save_alt))],
      ),
      body: FutureBuilder<InvDiffResult>(
        future: _future,
        builder: (ctx, snap) {
          if (!snap.hasData) return const Center(child: CircularProgressIndicator());
          final d = snap.data!;
          final mv = invPairMoveSuggest(d);
          final diffParts = d.parts.where((p) => (p.realQty - p.bookQty).abs() > 1e-6 || p.outsideBoxes > 0 || p.warnFlag != 0).toList();
          final diffLocs = d.locs.where((l) => (l.realQty - l.bookQty).abs() > 1e-6).toList();
          return ListView(
            padding: const EdgeInsets.all(12),
            children: [
              Card(
                color: const Color(0xFFE8EAF6),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Wrap(spacing: 14, runSpacing: 6, children: [
                    Text("总扫码 ${d.totalScans}", style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text("有效 ${d.validScans}", style: const TextStyle(color: Colors.green)),
                    Text("重复 ${d.dup.length}", style: const TextStyle(color: Colors.red)),
                    Text("MES无码 ${d.mesFail.length}", style: const TextStyle(color: const Color(0xFF7C3AED))),
                    Text("零件差异 ${diffParts.length} 项", style: TextStyle(color: Colors.deepOrange.shade700)),
                    Text("货位差异 ${diffLocs.length} 行", style: TextStyle(color: Colors.deepOrange.shade700)),
                  ]),
                ),
              ),
              const Padding(padding: EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text("零件号级差异", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
              if (diffParts.isEmpty) const Padding(padding: EdgeInsets.only(left: 8), child: Text("全部账实相符 🎉", style: TextStyle(color: Colors.green)))
              else ...diffParts.map((p) {
                final diff = p.realQty - p.bookQty;
                return Card(
                  child: ListTile(
                    dense: true,
                    title: Text("${p.partNo}  ${p.itemName}", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    subtitle: Text("账面 ${_fmtInvNum(p.bookQty)} / 实盘 ${_fmtInvNum(p.realQty)}${p.outsideBoxes > 0 ? "（另账外扫入 ${p.outsideBoxes} 码 ${_fmtInvNum(p.outsideQty)}）" : ""}${p.warnFlag == 7 ? "\n⚠️双基准矛盾：货位台账合计≠账面，先核账" : ""}", style: const TextStyle(fontSize: 12)),
                    trailing: Text(diff > 1e-6 ? "盘盈 +${_fmtInvNum(diff)}" : diff < -1e-6 ? "盘亏 ${_fmtInvNum(diff)}" : (p.outsideBoxes > 0 ? "账外" : "—"), style: TextStyle(color: diff > 0 ? Colors.orange : diff < 0 ? Colors.red : Colors.grey, fontWeight: FontWeight.bold, fontSize: 13)),
                  ),
                );
              }),
              const Padding(padding: EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text("货位级差异（疑似串位已配对标注）", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
              if (diffLocs.isEmpty) const Padding(padding: EdgeInsets.only(left: 8), child: Text("货位级无差异", style: TextStyle(color: Colors.green)))
              else ...diffLocs.map((l) {
                final diff = l.realQty - l.bookQty;
                final note = mv['${l.locCode}|${l.partNo}'];
                return Card(
                  child: ListTile(
                    dense: true,
                    title: Text("${l.locCode}  ${l.partNo}", style: const TextStyle(fontSize: 13)),
                    subtitle: Text("台账 ${_fmtInvNum(l.bookQty)} / 实盘 ${_fmtInvNum(l.realQty)}${note != null ? "\n💡$note" : ""}", style: const TextStyle(fontSize: 12)),
                    trailing: Text(diff > 0 ? "+${_fmtInvNum(diff)}" : _fmtInvNum(diff), style: TextStyle(color: diff > 0 ? Colors.orange : Colors.red, fontWeight: FontWeight.bold)),
                  ),
                );
              }),
              const SizedBox(height: 16),
              SizedBox(
                width: double.infinity,
                height: 48,
                child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
                  onPressed: _export,
                  icon: const Icon(Icons.save_alt),
                  label: const Text("导出差异报表 CSV（保存到 Download 目录）"),
                ),
              ),
              const SizedBox(height: 10),
            ],
          );
        },
      ),
    );
  }
}
