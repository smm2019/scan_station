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
  // ㉖v94t 差异定位：账面/实扫分别落在哪些货位、账外扫是哪些码（回答"现场明明对得上为何报差异"）
  final Map<String, double> realLoc = {}; //实扫 货位→件数（账外扫不计）
  final Map<String, double> bookLoc = {}; //货位台账基准 货位→件数
  final List<String> outsideDetail = []; //账外扫入明细 "标签@货位"
  int liveBoxes = -1; //本机最新账本在架框数（-1=无账本数据不显示；循环盘按同范围过滤）
  double liveQty = 0; //最新账本在架件数
  int liveStn = 0; //压站台框数（loc含-CK-，物理在但不在货架）
  final Map<String, int> liveLoc = {}; //最新账本：货位→在架框数
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
  // ㉖v94t 差异定位：本位实扫到的标签码（"码|件数"），供报表"定位/建议"使用
  final List<String> labels = [];
  int outsideBoxes = 0;
  final List<String> outsideLabels = [];
  int liveN = -1; //本机最新货位账本：此位在架框数（-1=无账本数据）
  final List<String> bookLabels = []; //基准台账此位预登记的标签码（实扫未扫到时可点名）
  InvLocDiff(this.locCode, this.partNo, this.itemName, this.bookQty)
      : realQty = 0, realBoxes = 0;
}

/// 循环盘点：货位编码→货架前缀（去掉末尾 -1F/-2F 层号；无层号则整码即货架）
String invShelfOf(String locCode) {
  final m = RegExp(r"^(.*)-\d+F$").firstMatch(locCode.trim());
  return m != null ? m.group(1)! : locCode.trim();
}
String invZoneOf(String locCode) {
  final c = locCode.trim().toUpperCase();
  if (c.startsWith('NB03-')) {
    final seg = c.split('-');
    if (seg.length >= 3) return seg.sublist(0, 3).join('-');
  }
  if (c.startsWith('NB04-')) {
    // ㉖v120d 来料区按"区-排"分组（NB04-A-01-003 → NB04-A-01）：盘点圈范围=整排
    final seg = c.split('-');
    if (seg.length >= 3) return seg.sublist(0, 3).join('-');
  }
  return invShelfOf(c);
}
bool invLocInScope(String locCode, List<String> scope) {
  if (scope.isEmpty) return true;
  return scope.contains(invZoneOf(locCode)) || scope.contains(locCode.trim().toUpperCase()) || scope.contains(invShelfOf(locCode));
}

/// ㉖v86 盘点选位弹窗返回值：zone 非空=整区盘点（扫码自动归位），否则 loc=单货位盘点
class _LocSel {
  final String zone;
  final String loc;
  const _LocSel({this.zone = "", this.loc = ""});
}

class InvDiffResult {
  final List<InvPartDiff> parts = [];
  final List<InvLocDiff> locs = [];
  final List<InventoryScan> mesFail = [];
  final List<InventoryScan> dup = [];
  final List<InventoryScan> outsideScope = []; //flag6：登记在未盘点货架，单列清单不盘盈亏
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
  final valid = scans.where((s) => s.flag != 1 && s.flag != 2 && s.flag != 6).toList();
  r.validScans = valid.length;
  r.outsideScope.addAll(scans.where((s) => s.flag == 6));
  final books = await _globalIsar.baselineBooks.where().findAll();
  var locBase = await _globalIsar.baselineLocs.where().findAll();
  // 循环盘点：货位基准按范围过滤，报表只覆盖范围内零件/货位
  final scope = task.invScope;
  if (scope.isNotEmpty) {
    locBase = locBase.where((l) => invLocInScope(l.locCode, scope)).toList();
  }

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
    final d = pMap.putIfAbsent(s.partNo, () => InvPartDiff(s.partNo, s.itemName, 0));
    if (s.flag == 3) {
      d.outsideBoxes++;
      d.outsideQty += s.qty;
      d.outsideDetail.add('${s.goodsCode}@${s.locCode}');
    } else {
      d.realQty += s.qty;
      d.realBoxes++;
      final lc = s.locCode.trim().toUpperCase();
      d.realLoc[lc] = (d.realLoc[lc] ?? 0) + s.qty;
    }
    if (d.itemName.isEmpty) d.itemName = s.itemName;
  }
  // 差异定位：把货位台账基准按零件→货位拆到每行，供报表逐位对比（账面总数对不上时一眼看出差在哪个位）
  for (final l in locBase) {
    final d = pMap[l.partNo];
    if (d != null) {
      final lc = l.locCode.trim().toUpperCase();
      d.bookLoc[lc] = (d.bookLoc[lc] ?? 0) + l.qty;
    }
  }
  // ㉖v94t 与本机最新货位账本交叉核对：基准是建单时刻点拍的快照（实时账本模式）或CSV导入，盘点期间账本继续周转即与基准脱节
  final sps = await _globalIsar.shelfPlacements.where().findAll();
  final byCodeLabels = <String, double>{}; //标签→件数（MES缓存）
  final byCodePart = <String, String>{}; //标签→零件号（大写，与pMap键归一口径一致）
  if (sps.isNotEmpty) {
    final lis = await _globalIsar.labelInfos.where().findAll();
    for (final li in lis) {
      final cd = li.goodsCode.trim().toUpperCase();
      byCodeLabels[cd] = li.qty;
      byCodePart[cd] = li.partNo.trim().toUpperCase();
    }
  }
  final locBoxCount = <String, int>{}; //最新账本：货位→在架框数
  final pIdx = <String, InvPartDiff>{for (final e in pMap.entries) e.key.toUpperCase(): e.value}; //大小写归一索引：基准CSV写法与账本MES写法可能不一致
  if (sps.isNotEmpty) {
    for (final d in pMap.values) {
      d.liveBoxes = 0; //有账本数据：先归零，下面逐框累加（保持-1=本机无账本，不显示）
    }
  }
  for (final e in sps) {
    final cd = e.goodsCode.trim().toUpperCase();
    final lc = e.loc.trim().toUpperCase();
    if (lc.isEmpty) continue;
    // 循环盘点：账本侧同口径按范围过滤，否则"全仓在架数"远大于"局部实盘数"必然误判
    final inScope = scope.isEmpty || invLocInScope(lc, scope) || lc.contains('-CK-');
    if (inScope) locBoxCount[lc] = (locBoxCount[lc] ?? 0) + 1;
    final pn = byCodePart[cd] ?? "";
    if (pn.isEmpty || !inScope) continue;
    final d = pIdx[pn];
    if (d == null) continue;
    if (d.liveBoxes < 0) d.liveBoxes = 0;
    final q = byCodeLabels[cd] ?? 0;
    if (lc.contains('-CK-')) {
      d.liveStn++; //压站台：物理在架/在台面上，但不算货架在架框
    } else {
      d.liveBoxes++;
      d.liveQty += q;
      d.liveLoc[lc] = (d.liveLoc[lc] ?? 0) + 1;
    }
  }
  if (scope.isEmpty) {
    pMap.forEach((pn, d) {
      final la = locAgg[pn];
      if (la != null && (la - d.bookQty).abs() > 1e-6) d.warnFlag = 7;
    });
  } else {
    // 循环盘：账面改用范围内货位台账合计（全局账面 vs 局部实盘会造成假盘亏）
    final inScopeParts = locAgg.keys.toSet();
    pMap.removeWhere((pn, d) => !inScopeParts.contains(pn) && d.realBoxes == 0 && d.outsideBoxes == 0);
    pMap.forEach((pn, d) {
      if (inScopeParts.contains(pn)) d.bookQty = locAgg[pn] ?? 0;
    });
  }
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
    final gl = l.goodsCode.trim().toUpperCase();
    if (gl.isNotEmpty && !d.bookLabels.contains(gl)) d.bookLabels.add(gl);
  }
  for (final s in valid) {
    final k = '${s.locCode}|${s.partNo}';
    final d = lMap.putIfAbsent(k, () => InvLocDiff(s.locCode, s.partNo, s.itemName, 0));
    if (s.flag != 3) {
      d.realQty += s.qty;
      d.realBoxes++;
      d.labels.add('${s.goodsCode}|${_fmtInvNum(s.qty)}');
    } else {
      d.outsideBoxes++;
      d.outsideLabels.add('${s.goodsCode}|${_fmtInvNum(s.qty)}');
    }
  }
  // ㉖v94t 货位级定位：回填本机最新账本此位在架框数（区别于基准台账，供"基准滞后 vs 实物真少"判定）
  // ㉖v95 键可能比账本格位粗（整区归位行键=区名如 NB03-C-11、架级基准行=货架名）：精确查不到时按前缀聚合，防误报"此位已空"
  for (final d in lMap.values) {
    if (sps.isEmpty) {
      d.liveN = -1;
      continue;
    }
    final lc = d.locCode.trim().toUpperCase();
    var n = locBoxCount[lc] ?? -1;
    if (n < 0) {
      n = 0;
      locBoxCount.forEach((k, v) {
        if (k.startsWith('$lc-')) n += v;
      });
    }
    d.liveN = n;
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

/// ㉖v94t 零件级差异"定位/建议"：回答"账面说少了，实物到底在哪、是真少了还是基准旧了"
String invPartLocate(InvPartDiff p) {
  final diff = p.realQty - p.bookQty;
  final out = <String>[];
  final boxesMatch = p.liveBoxes >= 0 && p.liveBoxes == p.realBoxes;
  if (diff < -1e-6) {
    // 盘亏方向：用最新货位账本裁决"基准旧/漏扫" vs "真缺货"
    if (boxesMatch && (p.liveQty - p.realQty).abs() <= 1e-6) {
      out.add("框数与件数都和最新货位账本一致——实物都在，是基准快照滞后（快照生成后账本又周转/他台未同步），重新生成基准开新盘点即可");
    } else if (boxesMatch) {
      out.add("框数与最新账本一致（都是 ${p.realBoxes} 码）——框都在，差的是每框件数：可能共用/换过标签或 MES 数量有出入，按实扫标签逐码核对件数");
    } else if (p.liveBoxes > 0) {
      out.add("最新账本在架 ${p.liveBoxes} 码（${_fmtInvNum(p.liveQty)} 件）${p.liveStn > 0 ? "，另 ${p.liveStn} 码压站台" : ""}——与实盘 ${p.realBoxes} 码有出入，先按下方位置逐位核实物");
    } else if (p.liveBoxes == 0) {
      if (p.liveStn > 0) {
        out.add("货架账本已无此零件，但最新账本显示 ${p.liveStn} 码压着站台——货多半被拉到站台未清/未出账，先去站台查台面");
      } else {
        out.add("最新货位账本也已无此零件在架——亏空大概率已出库未走扫码，查近日出库流水/直调单");
      }
    }
    if (p.liveLoc.isNotEmpty) {
      final parts = p.liveLoc.entries.toList()..sort((a, b) => b.value.compareTo(a.value) != 0 ? b.value.compareTo(a.value) : a.key.compareTo(b.key));
      out.add("账本此零件在架：${parts.take(5).map((e) => "${e.key}×${e.value}").join("、")}${parts.length > 5 ? " 等${parts.length}位" : ""}");
    }
    // 整区盘点实扫键可能是区级(NB03-C-11)而基准是格级(NB03-C-11-06)：前缀匹配防误报
    final _bl = p.bookLoc.keys.toList();
    final _rl = p.realLoc.keys.toList();
    final realOnly = _rl.where((lc) => !_bl.any((b) => b == lc || b.startsWith('$lc-'))).toList()..sort();
    if (realOnly.isNotEmpty) out.add("扫到货但基准未登记的位：${realOnly.take(4).join("、")}${realOnly.length > 4 ? " 等${realOnly.length}位" : ""}（可能已移库）");
    final bookOnly = _bl.where((bl) => !_rl.any((lc) => bl == lc || bl.startsWith('$lc-'))).toList()..sort();
    if (bookOnly.isNotEmpty) out.add("基准登记但一码未扫的位：${bookOnly.take(4).join("、")}${bookOnly.length > 4 ? " 等${bookOnly.length}位" : ""}——优先去这些位补扫");
  } else if (diff > 1e-6) {
    if (p.liveBoxes > 0 && p.liveBoxes < p.realBoxes) {
      out.add("实盘比基准多，且最新账本仅 ${p.liveBoxes} 码——可能实货已取走、扫码时框还压在该位，核实后走「应用货位差异」改账");
    } else if (boxesMatch && p.bookLoc.isNotEmpty) {
      final _bl2 = p.bookLoc.keys.toList();
      final extra = p.realLoc.keys.where((lc) => !_bl2.any((b) => b == lc || b.startsWith('$lc-'))).toList()..sort();
      out.add("框数件数都与最新账本一致（${p.realBoxes} 码）——实物都在架，是基准快照生成时本机账本就缺这些框（拉取未合并/他台未推送），非真盘盈${extra.isNotEmpty ? "：多出位在 ${extra.take(4).join("、")}${extra.length > 4 ? " 等${extra.length}位" : ""}" : ""}；重新生成基准开新盘点即可");
    } else {
      out.add("盘盈：实扫位 ${p.realLoc.keys.take(4).join("、")} vs 基准位 ${p.bookLoc.keys.take(4).join("、")}——核对该位是否出库未消账或货移入未登记");
    }
  }
  if (p.outsideDetail.isNotEmpty) out.add("账外扫入 ${p.outsideDetail.length} 码：${p.outsideDetail.take(4).join("、")}${p.outsideDetail.length > 4 ? " 等" : ""}");
  return out.join("\n");
}

/// ㉖v94t 货位级差异"定位/建议"：点名未扫到的标签、并用最新账本区分"基准旧/漏扫"与"真缺"
String invLocLocate(InvLocDiff l, String? moveNote) {
  final out = <String>[];
  if (moveNote != null) out.add(moveNote);
  final scanned = l.labels.map((e) => e.split("|").first.toUpperCase()).toSet();
  final diff = l.realQty - l.bookQty;
  if (diff < -1e-6) {
    final miss = l.bookLabels.where((c) => !scanned.contains(c)).toList();
    if (miss.isNotEmpty) out.add("基准列了但未扫到：${miss.take(5).join("、")}${miss.length > 5 ? " 等${miss.length}码" : ""}");
    if (l.liveN > 0) {
      out.add("最新账本此位仍有 ${l.liveN} 码在架——实物多半还在，属漏扫或基准版本旧，先去本位复核");
    } else if (l.liveN == 0 && l.bookLabels.isNotEmpty) {
      out.add("最新账本此位已空——差的 ${_fmtInvNum(-diff)} 件大概率已出库未扫码");
    }
  } else if (diff > 1e-6) {
    final extra = scanned.where((c) => !l.bookLabels.contains(c)).toList()..sort();
    if (extra.isNotEmpty && l.bookLabels.isNotEmpty) out.add("比基准多扫的码：${extra.take(5).join("、")}${extra.length > 5 ? " 等${extra.length}码" : ""}");
    if (l.liveN >= 0) out.add("最新账本此位 ${l.liveN} 码——实扫 ${l.realBoxes} 码${l.realBoxes == l.liveN ? "与账本吻合：基准台账旧了，改基准重盘或直接应用改账" : "与账本不符：按标签逐码核实物"}");
    out.add("亏空走 MES 调整，盘盈同样走 MES；本按钮只改位置");
  }
  if (l.outsideLabels.isNotEmpty) out.add("另账外扫入：${l.outsideLabels.take(4).join("、")}${l.outsideLabels.length > 4 ? " 等${l.outsideLabels.length}码" : ""}");
  // 相符且无账外且无串位配对才返空；注意 invPairMoveSuggest 会把已配平行的 realQty 减到≈bookQty（diff≈0），串位提示必须保留
  if (out.isEmpty || (diff.abs() <= 1e-6 && l.outsideLabels.isEmpty && moveNote == null)) return "";
  return out.join("\n");
}

String _invCsvField(String v) {
  if (v.contains(",") || v.contains("\"") || v.contains("\n")) return "\"${v.replaceAll("\"", "\"\"")}\"";
  return v;
}

/// 生成差异报表 CSV（零件级 + 货位级 + 异常清单）
String buildInvDiffCsv(BatchInfo task, InvDiffResult d) {
  final mv = invPairMoveSuggest(d);
  String s = "盘点任务,${_invCsvField(task.batchId)},${_invCsvField(task.batchRemark)},基准版本 账面:${_invCsvField(task.invBookKey)} 货位:${_invCsvField(task.invLocKey)},范围:${_invCsvField(task.invScope.isEmpty ? "全盘" : task.invScope.join("/"))}\n";
  // ㉖v174 点名盘：头行加应扫/未盘到摘要，并单列未盘到清单（导出即带"该在的都在吗"结论）
  if (task.invPickMode == 1) {
    s += "点名盘,应扫${task.invPickCodes.length}框";
    try {
      if (task.invMissJson.isNotEmpty) {
        final miss = jsonDecode(task.invMissJson) as List;
        // ㉖v174b/c 按最新账本+AGV工单结果三分类：miss 仍在架未扫到 / gone 已出库（正常）/ agvDiff AGV核对不符（须处理）
        final agvBad = miss.where((m) => (m as Map)['st'] == 'agvDiff').toList();
        final real = miss.where((m) { final st = (m as Map)['st']; return st != 'gone' && st != 'agvDiff'; }).toList();
        final gone = miss.where((m) => (m as Map)['st'] == 'gone').toList();
        s += miss.isEmpty
            ? ",全部盘到\n"
            : ",仍在架未扫到${real.length}框,已出库${gone.length}框${agvBad.isNotEmpty ? ",AGV核对不符${agvBad.length}框" : ""}\n";
        if (agvBad.isNotEmpty) {
          s += "\n===AGV通道核对不符(须人工处理后方可结案)===\n";
          s += "货物标签,零件号,账本货位,不符原因\n";
          for (final m in agvBad) {
            final mm = m as Map;
            s += "${_invCsvField(mm['c'])},${_invCsvField(mm['p'])},${_invCsvField(mm['l'])},${_invCsvField(mm['r'])}\n";
          }
        }
        if (real.isNotEmpty) {
          s += "\n===点名盘未盘到清单(账本仍在架却没扫到:疑似缺失/串位/架未拉到位,请现场复核)===\n";
          s += "货物标签,零件号,账本货位,处理建议\n";
          for (final m in real) {
            final mm = m as Map;
            s += "${_invCsvField(mm['c'])},${_invCsvField(mm['p'])},${_invCsvField(mm['l'])},${_invCsvField("找到实物→位置登记重扫归位；确不在架→库存页消账；架还没拉来→叫车拉架后补扫")}\n";
          }
        }
        if (gone.isNotEmpty) {
          s += "\n===盘点期间已出库或已消账(正常流转,不计缺失)===\n";
          s += "货物标签,零件号\n";
          for (final m in gone) {
            final mm = m as Map;
            s += "${_invCsvField(mm['c'])},${_invCsvField(mm['p'])}\n";
          }
        }
      } else { s += ",未结束(无未盘到数据)\n"; }
    } catch (_) { s += "\n"; }
  } else { s += "\n"; }
  s += "\n===零件号级差异(对齐基础数据表)===\n";
  s += "零件号,物料名称,期末库存,实盘数量,差异数量,账外扫入,差异类型,最新账本在架,双基准矛盾,定位/建议\n";
  for (final p in d.parts) {
    final diff = p.realQty - p.bookQty;
    String type;
    if (diff.abs() < 1e-6 && p.outsideBoxes == 0) type = "正常";
    else if (diff < -1e-6) type = "盘亏";
    else if (diff > 1e-6) type = "盘盈";
    else type = "正常(有账外扫入)";
    if (p.outsideBoxes > 0 && p.bookQty == 0 && p.realBoxes == 0) type = "账外料";
    final live = p.liveBoxes < 0 ? "无账本" : "${p.liveBoxes}码/${_fmtInvNum(p.liveQty)}件${p.liveStn > 0 ? "+${p.liveStn}码压站台" : ""}";
    s += "${_invCsvField(p.partNo)},${_invCsvField(p.itemName)},${_fmtInvNum(p.bookQty)},${_fmtInvNum(p.realQty)},${_fmtInvNum(diff)},${p.outsideBoxes > 0 ? _fmtInvNum(p.outsideQty) : ''},$type,$live,${p.warnFlag == 7 ? '货位台账合计≠账面，先核两版账' : ''},${_invCsvField(invPartLocate(p))}\n";
  }
  s += "\n===货位级差异(对齐货架列表)===\n";
  s += "货位编码,零件号,台账数量,实盘数量,差异,最新账本此位框数,实扫标签码,定位/建议\n";
  for (final l in d.locs) {
    final diff = l.realQty - l.bookQty;
    final note = invLocLocate(l, mv['${l.locCode}|${l.partNo}']);
    s += "${_invCsvField(l.locCode)},${_invCsvField(l.partNo)},${_fmtInvNum(l.bookQty)},${_fmtInvNum(l.realQty)},${_fmtInvNum(diff)},${l.liveN < 0 ? '无账本' : l.liveN},${_invCsvField(l.labels.join(" "))},${_invCsvField(note)}\n";
  }
  if (d.outsideScope.isNotEmpty) {
    s += "\n===范围外清单(登记在未盘点货架，不计盘盈亏，待人工核对)===\n";
    s += "货物标签,扫描货位,零件号,数量,备注\n";
    for (final o in d.outsideScope) {
      s += "${_invCsvField(o.goodsCode)},${_invCsvField(o.locCode)},${_invCsvField(o.partNo)},${_fmtInvNum(o.qty)},${_invCsvField(o.remark)}\n";
    }
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

// ===== ㉖v174 点名盘点：三种输入统一展开成【应扫标签清单】 =====
// 用户诉求：货架盘点能指定"零件号 / 标签号 / 货位"点名盘，盘完必须回答"该在的都在吗"。
// 设计：零件号与货位最终都落到本机在架占位（shelfPlacements，刚与服务器账本合并）上取码，
//   零件号→码经 LabelInfo.partNo 反查；标签号直接校验在架。展开成一份码清单后，
//   扫码判定与"未盘到"计算只需比对这一份清单，三种输入在数据层归一、UI 不分裂。
// 返回 {codes: 应扫清单(大写去重)，warn: 人读警示行（查无/无在架/不在架的说明）}
Future<Map<String, dynamic>> buildPickPlan(String raw) async {
  final toks = raw
      .split(RegExp(r'[\s,;，、；\n]+'))
      .map((e) => e.trim().toUpperCase())
      .where((e) => e.isNotEmpty)
      .toSet()
      .toList();
  final codes = <String>{};
  final warn = <String>[];
  if (toks.isEmpty) return {'codes': <String>[], 'warn': ['未输入任何零件号/货位/标签号']};
  // 与服务器账本对齐后再取清单：点名盘的意义=核对"账上该在的"，基准必须是全厂最新
  await ledgerPullMerge(force: true);
  final sp = await _globalIsar.shelfPlacements.where().findAll();
  final spByCode = <String, ShelfPlacement>{};
  for (final p in sp) {
    spByCode[p.goodsCode.trim().toUpperCase()] = p;
  }
  final labelRows = await _globalIsar.labelInfos.where().findAll();
  final pnToCodes = <String, List<String>>{};
  for (final e in labelRows) {
    final pn = e.partNo.trim().toUpperCase();
    if (pn.isEmpty) continue;
    (pnToCodes[pn] ??= <String>[]).add(e.goodsCode.trim().toUpperCase());
  }
  final locRe = RegExp(r'^NB0[234]-[A-H]-\d{1,2}(-(\d{1,2}|[1-4]F))?$');
  final codeRe = RegExp(r'^N[A-Z0-9]{9}$');
  int nPart = 0, nLoc = 0, nCode = 0;
  for (final t in toks) {
    if (locRe.hasMatch(t)) {
      nLoc++;
      // 货位：区/排（NB02-A）按前缀，完整格位精确等值——与 invLocInScope 语义一致的宽口径
      final hits = sp.where((p) => p.loc.trim().toUpperCase() == t || p.loc.trim().toUpperCase().startsWith('$t-')).toList();
      if (hits.isEmpty) { warn.add('货位 $t 当前无在架框（账本无或已全部出库）'); }
      for (final h in hits) { codes.add(h.goodsCode.trim().toUpperCase()); }
      if (hits.isNotEmpty) warn.add('货位 $t → ${hits.length} 框');
    } else if (codeRe.hasMatch(t)) {
      nCode++;
      if (spByCode.containsKey(t)) { codes.add(t); } else { warn.add('标签 $t 账本无在架记录（可能已出库/未同步），仍列入应扫（扫到=账外实物，重要信号）'); codes.add(t); }
    } else {
      nPart++;
      final cs = (pnToCodes[t] ?? <String>[]).where((c) => spByCode.containsKey(c)).toList();
      final off = (pnToCodes[t] ?? <String>[]).where((c) => !spByCode.containsKey(c)).length;
      if (cs.isEmpty) {
        warn.add(pnToCodes.containsKey(t) ? '零件 $t 有 ${pnToCodes[t]!.length} 个标签但均无在架记录（已全部出库？）' : '零件 $t 本机标签档案查无（请核对零件号）');
      } else {
        codes.addAll(cs);
        warn.add('零件 $t → ${cs.length} 框在架${off > 0 ? "（另有 $off 个标签不在架，未列入）" : ""}');
      }
    }
  }
  if (codes.isEmpty) warn.add('⚠️ 展开后应扫清单为空：请检查输入');
  // ㉖v174b 搬运计划（AGV 货架要整架拉到台站才能扫）：按【货架单元】分组计拉架趟数。
  //   NB02 货架框：一个货架单元(NB02-A-05 这种)整架拉一趟，架内 1F~4F 多框共享一趟；
  //   NB03/NB04 地面框：人到格位直扫，无搬运；台站框(loc 含 CK)：本就在站台，顺手盘。
  List<String> shelfCodes = const []; // ㉖v174c 应扫中的 AGV 货架框（整合发起"盲区抽盘"通道搬运用）
  {
    int gnd = 0, stn = 0, shelfBox = 0;
    final shelfCnt = <String, int>{};
    final sCodes = <String>[];
    for (final c in codes) {
      final p = spByCode[c];
      if (p == null) continue;
      final loc = p.loc.trim().toUpperCase();
      if (loc.contains('-CK-')) { stn++; }
      else if (loc.startsWith('NB02-')) { shelfBox++; sCodes.add(c); final sh = invShelfOf(loc); shelfCnt[sh] = (shelfCnt[sh] ?? 0) + 1; }
      else gnd++;
    }
    shelfCodes = sCodes;
    if (shelfCnt.isNotEmpty) {
      final sl = shelfCnt.entries.toList()..sort((a, b) => a.key.compareTo(b.key));
      warn.add('🚛 搬运计划：AGV货架 $shelfBox 框在 ${shelfCnt.length} 个货架上 → 需拉 ${shelfCnt.length} 趟（${sl.take(5).map((e) => '${e.key}:${e.value}框').join('、')}${sl.length > 5 ? ' 等' : ''}）');
      warn.add('　→ 可在任务卡点「AGV搬运」指定这些框发起盲区抽盘通道（拉架到台站→核对→钉死归位），也可人工先叫车拉架再扫');
    }
    if (gnd > 0) warn.add('👣 地面/来料区 $gnd 框：人到格位直接扫，无需叫车');
    if (stn > 0) warn.add('🏭 已在站台 $stn 框：顺手盘');
  }
  warn.insert(0, '输入 ${toks.length} 条（零件$nPart · 货位$nLoc · 标签$nCode）→ 应扫 ${codes.length} 框');
  return {'codes': codes.toList()..sort(), 'warn': warn, 'shelf': shelfCodes};
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
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
              child: SizedBox(
                width: double.infinity,
                height: 48,
                child: OutlinedButton.icon(
                  style: OutlinedButton.styleFrom(foregroundColor: const Color(0xFF515BD4), side: const BorderSide(color: Color(0xFF515BD4)), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
                  onPressed: () => Navigator.push(ctx, MaterialPageRoute(builder: (_) => const ShelfCountPage())),
                  icon: const Icon(Icons.inventory),
                  label: const Text("货架AGV盘点 · 盲区抽盘"),
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
                              margin: const EdgeInsets.symmetric(vertical: 5),
                              child: ListTile(
                                contentPadding: const EdgeInsets.fromLTRB(10, 6, 4, 6),
                                isThreeLine: true,
                                leading: Icon(t.isArchived ? Icons.task_alt : Icons.fact_check_outlined, color: t.isArchived ? Colors.green : const Color(0xFF515BD4)),
                                title: Row(children: [
                                  Expanded(
                                      child: Text(t.batchRemark.isEmpty ? t.batchId : t.batchRemark,
                                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                                          maxLines: 1, overflow: TextOverflow.ellipsis)),
                                  Text(t.createTime.substring(5, 16),
                                      style: const TextStyle(fontSize: 11, color: Colors.blueGrey)),
                                ]),
                                // ㉖v96 布局压缩：旧版把全部货位码平铺进副标题，长清单撑爆卡片（10/25 实拍一屏只见两个任务）
                                subtitle: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Wrap(spacing: 5, runSpacing: 3, children: [
                                        _invTag("已扫 $cnt 码", const Color(0xFF1A237E), const Color(0xFFE8F0FE)),
                                        _invTag(t.blindMode ? "盲盘" : "监督", Colors.brown, Colors.orange.shade50),
                                        _invTag(t.invScope.isEmpty ? "全盘" : "循环盘 ${t.invScope.length} 区", const Color(0xFF00695C), const Color(0xFFE0F2F1)),
                                        _invTag("基准${(t.invBookKey.isEmpty ? 0 : 1) + (t.invLocKey.isEmpty ? 0 : 1)}/2", t.invBookKey.isEmpty && t.invLocKey.isEmpty ? Colors.red.shade700 : Colors.green.shade700, t.invBookKey.isEmpty && t.invLocKey.isEmpty ? Colors.red.shade50 : Colors.green.shade50),
                                      ]),
                                      if (t.invScope.isNotEmpty)
                                        Padding(
                                            padding: const EdgeInsets.only(top: 2),
                                            child: Text(t.invScope.join(" "),
                                                style: const TextStyle(fontSize: 10.5, color: Colors.black54, fontFamily: "monospace"),
                                                maxLines: 2,
                                                overflow: TextOverflow.ellipsis)),
                                    ]),
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

/// ㉖v96 盘点任务卡彩色小徽章
Widget _invTag(String txt, Color fg, Color bg) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1.5),
    decoration: BoxDecoration(
        color: bg, borderRadius: BorderRadius.circular(5)),
    child: Text(txt,
        style: TextStyle(fontSize: 10.5, color: fg, fontWeight: FontWeight.w600)));

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
  final Set<String> _scope = {};
  String _scopeType = ""; //盘点类型 shelf=货架NB02 ground=地面NB03 空=混合/全盘
  int _step = 0;
  bool _useLive = false; // 基准来源：true=系统实时在库账本快照（免上传CSV），false=上传两份台账CSV
  String _liveInfo = ""; // 实时快照结果描述（零件数/货位行数）
  // ㉖v174 点名盘点：step2 顶部切换 范围盘(0)/点名盘(1)
  int _pickMode = 0;
  final _pickCtrl = TextEditingController(); // 零件号/货位/标签号混贴（每行或逗号分隔）
  bool _pickBusy = false; // 正在展开清单
  List<String> _pickCodes = const []; // 展开出的应扫清单
  List<String> _pickWarn = const []; // 展开警示行（查无/无在架/命中框数）

  @override
  void dispose() {
    _nameCtrl.dispose();
    _pickCtrl.dispose();
    super.dispose();
  }

  // ㉖v174 展开点名清单：把输入框里的零件号/货位/标签号统一展开成应扫标签清单（含警示行）
  Future<void> _expandPick() async {
    setState(() => _pickBusy = true);
    try {
      final r = await buildPickPlan(_pickCtrl.text);
      if (!mounted) return;
      setState(() {
        _pickCodes = List<String>.from(r['codes'] ?? const []);
        _pickWarn = List<String>.from(r['warn'] ?? const []);
        _pickBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _pickBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("展开清单失败：$e"), backgroundColor: Colors.orange));
    }
  }

  // ㉖v174 点名盘 step2 界面：零件号/货位/标签号混贴输入 + 展开预览（应扫数 + 命中/警示）
  List<Widget> _pickStep2() => [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              const Text("输入要盘的货（每行一个或逗号分隔；零件号 / 完整货位 / 标签号 可混贴）", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              TextField(
                controller: _pickCtrl,
                maxLines: 5,
                minLines: 2,
                decoration: const InputDecoration(
                  hintText: "6608225326\nNB02-A-05-1F\nN26K120203",
                  isDense: true,
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Row(children: [
                FilledButton.icon(
                  onPressed: _pickBusy ? null : _expandPick,
                  icon: _pickBusy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.rule_folder, size: 18),
                  label: const Text("展开清单"),
                  style: FilledButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white),
                ),
                const SizedBox(width: 10),
                Text(_pickCodes.isEmpty ? "尚未展开" : "应扫 ${_pickCodes.length} 框", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _pickCodes.isEmpty ? Colors.grey : const Color(0xFF2E7D32))),
              ]),
              if (_pickWarn.isNotEmpty) ...[
                const SizedBox(height: 8),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(color: const Color(0xFFF1F5F9), borderRadius: BorderRadius.circular(8)),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: _pickWarn.map((w) => Text(w, style: const TextStyle(fontSize: 12, height: 1.6, fontFamily: "monospace"))).toList()),
                ),
              ],
              const SizedBox(height: 6),
              const Text("结束盘点时，清单内未扫到的会列为「未盘到」（疑似缺失/串位/未同步）。", style: TextStyle(fontSize: 12, color: Colors.grey)),
            ]),
          ),
        ),
      ];

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
    BaselineParseResult res;
    try {
      res = await importBaselineFile(picked, key, isBook ? "book" : "part");
    } catch (e) {
      if (!mounted) return;
      final isFmt = e.toString().contains("FormatException") || e.toString().contains("utf-8") || e.toString().contains("Invalid UTF-8");
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(isFmt
          ? "「$fname」不是UTF-8编码（多为WPS直接另存的ANSI/GBK格式）。请用最新版网页门户重新上传，会自动转码。"
          : "导入失败：$e")));
      return;
    }
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
    // ㉖v174 点名盘：建任务前把输入展开成应扫清单，展开为空则拦停（防建成空点名任务白盘一场）
    // ㉖v181 货架范围盘合流：勾选细化到层格位后，建单前同样展开应扫清单（复用 buildPickPlan
    // 货位 token），invPickMode=1 走点名盘执行链路、invAgvMode=1 标记 NB02 框走 AGV 台站
    // 核对通道（拉架→核对→钉死归位，人不去货架前）——用户定标：盲区抽盘就是货架盘标准。
    List<String> pickCodes = const [], pickShelf = const [];
    int agvMode = 0;
    String rawInput = "";
    if (_pickMode == 1) {
      if (_pickBusy) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("正在展开清单，请稍候…"), backgroundColor: Colors.blueGrey));
        return;
      }
      final r = await buildPickPlan(_pickCtrl.text);
      pickCodes = List<String>.from(r['codes'] ?? const []);
      pickShelf = List<String>.from(r['shelf'] ?? const []); // ㉖v174c 其中属 AGV 货架的框（整合"盲区抽盘"通道发起搬运用）
      rawInput = _pickCtrl.text.trim();
      if (pickCodes.isEmpty) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("点名清单展开后为空：请检查零件号/货位/标签号是否正确"), backgroundColor: Colors.orange));
        return;
      }
    } else if (_scopeType == 'shelf' && _scope.isNotEmpty) {
      final r = await buildPickPlan(_scope.join(","));
      pickCodes = List<String>.from(r['codes'] ?? const []);
      pickShelf = List<String>.from(r['shelf'] ?? const []);
      rawInput = _scope.join(", ");
      agvMode = 1;
      if (pickCodes.isEmpty) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("勾选格位展开后无在架框（可能已全部出库或账本未同步），请回第二步核对"), backgroundColor: Colors.orange));
        return;
      }
    }
    final task = BatchInfo(
      batchId: "INV${ts.millisecondsSinceEpoch}",
      createTime: ts.toString(),
      batchRemark: name,
      taskKind: 1,
      invBookKey: _bookKey,
      invLocKey: _locKey,
      blindMode: _blind,
      invScope: _scope.toList(),
      invPickMode: _pickMode == 1 || agvMode == 1 ? 1 : 0,
      invPickRaw: rawInput,
      invPickCodes: pickCodes,
      invPickShelf: pickShelf,
      invAgvMode: agvMode,
    );
    try {
      await _globalIsar.writeTxn(() async {
        await _globalIsar.batchInfos.put(task);
      });
    } catch (e) {
      if (!mounted) return;
      final s = e.toString();
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        duration: const Duration(seconds: 6),
        content: Text(s.contains("No space") || s.contains("disk") || s.contains("Read-only")
            ? "创建失败：手机存储空间不足或目录只读（$e）"
            : "创建失败：$e"),
      ));
      return;
    }
    if (!mounted) return;
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => _InvScanPage(task: task)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(backgroundColor: const Color(0xFF515BD4), title: Text("新建盘点任务（${_step + 1}/4）")),
      body: Column(
        children: [
          Expanded(
            child: SingleChildScrollView(
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
              Card(
                color: _useLive ? const Color(0xFFE8F5E9) : null,
                child: SwitchListTile(
                  value: _useLive,
                  activeColor: Colors.teal,
                  title: const Text("用系统实时在库账本当基准", style: TextStyle(fontWeight: FontWeight.w600, fontSize: 14)),
                  subtitle: Text(_useLive
                      ? "免上传CSV：创建时自动快照当前在库账本（地面+货架全覆盖）作为账面与货位基准\n口径与库存页完全一致；请先确认各台PDA已同步"
                      : "开启后无需上传台账CSV，直接用系统账本对账；关闭则走下方上传两份CSV的老流程",
                      style: const TextStyle(fontSize: 12)),
                  onChanged: (v) => setState(() { _useLive = v; _liveInfo = ""; }),
                ),
              ),
              const SizedBox(height: 10),
              if (_useLive) ...[
                if (_liveInfo.isEmpty)
                  const Card(child: Padding(padding: EdgeInsets.all(14), child: Text("创建任务时会自动生成实时快照：\n· 账面基准 = 各零件在库数量合计\n· 货位基准 = 各货位×零件在库数量（含 NB03 地面格位）\n\n注意：快照以本台PDA合并后的账本为准，创建前请确保各台都同步过。", style: TextStyle(fontSize: 13, height: 1.5))))
                else
                  Card(child: Padding(padding: const EdgeInsets.all(14), child: Text("✅ 已生成实时快照：$_liveInfo", style: const TextStyle(fontSize: 13, color: Colors.teal, fontWeight: FontWeight.w600)))),
              ] else ...[
                const Padding(padding: EdgeInsets.only(bottom: 8), child: Text("第一步先上传：电脑浏览器打开 App 显示的门户地址 → 上传两份台账导出 CSV", style: TextStyle(fontSize: 12, color: Colors.grey))),
                _slotTile("① 账面基准（基础数据表导出）", _bookName, _bookInfo, true, const Color(0xFF515BD4)),
                const SizedBox(height: 10),
                _slotTile("② 货位基准（二楼货架列表导出，可选）", _locName, _locInfo, false, Colors.teal),
                const SizedBox(height: 8),
                const Text("说明：货位基准可不选——缺失时只能对总量盘盈盘亏，无法定位串位。同零件号重复行自动累加。", style: TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ],
            if (_step == 2) ...[
              // ㉖v174 盘点方式：范围盘（圈货架/排）或 点名盘（指定零件号/标签号/货位）
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text("盘点方式", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Wrap(spacing: 8, children: [
                      ChoiceChip(label: const Text("范围盘（按货架/排圈定）"), selected: _pickMode == 0, onSelected: (_) => setState(() => _pickMode = 0)),
                      ChoiceChip(label: const Text("点名盘（指定零件号/标签/货位）"), selected: _pickMode == 1, onSelected: (_) => setState(() => _pickMode = 1)),
                    ]),
                  ]),
                ),
              ),
              const SizedBox(height: 8),
              if (_pickMode == 1) ..._pickStep2() else ...[
              if (_locKey.isEmpty)
                const Card(child: Padding(padding: EdgeInsets.all(14), child: Text("未绑定货位基准，无法圈定范围，本次为全盘盘点。\n想做循环盘点请在第二步绑定货位基准。", style: TextStyle(fontSize: 13))))
              else
                FutureBuilder<(List<BaselineLoc>, List<ShelfPlacement>)>(
                  future: () async {
                    final a = await _globalIsar.baselineLocs.filter().fileKeyEqualTo(_locKey).findAll();
                    final b = await _globalIsar.shelfPlacements.where().findAll(); // ㉖v181 格位框数=账本在架码数（与展开清单同源）
                    return (a, b);
                  }(),
                  builder: (ctx, sn) {
                    if (!sn.hasData) return const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
                    final locs = sn.data!.$1.map((e) => e.locCode.trim().toUpperCase()).where((c) => c.isNotEmpty).toSet();
                    // ㉖v181 货架类型细化到层格位（用户：盘点区域要具体到格位）：NB02 按货架
                    // 分组→组内列 1F~4F 层格位，货架行=整架全选三态；层行显示账本在架框数。
                    // 全部排除 -CK- 站台码（出库缓存/检验站台不是货架，判据与服务端 locStation 同源）。
                    final shelfGroups = <String, List<String>>{};
                    if (_scopeType == 'shelf') {
                      for (final c in locs) {
                        if (!c.startsWith('NB02-') || c.contains('-CK-')) continue;
                        (shelfGroups[invShelfOf(c)] ??= <String>[]).add(c);
                      }
                      for (final l in shelfGroups.values) { l.sort(); }
                    }
                    final zones = _scopeType == 'shelf' ? const <String>[] : locs.where((c) { if (_scopeType.isEmpty) return true; if (!c.startsWith(_scopeType == 'shelf' ? 'NB02' : _scopeType == 'ground' ? 'NB03' : 'NB04')) return false; return !c.contains('-CK-'); }).map(invZoneOf).toSet().toList()..sort(); // ㉖v120 三类前缀映射（原二元判断会把来料区误归地面）
                    // 每格位在架框数=账本在架码数（㉖v181：与创建时 buildPickPlan 展开同源于
                    // shelfPlacements——基线货位行是"位×零件"不是码行，数它会把"1框多零件"算成
                    // 多框，勾选时显示的框数与展开结果不一致=又一次承诺与结果不符）
                    final boxCnt = <String, int>{};
                    for (final p in sn.data!.$2) {
                      final l = p.loc.trim().toUpperCase();
                      if (l.isEmpty) continue;
                      boxCnt[l] = (boxCnt[l] ?? 0) + 1;
                    }
                    int nCell = 0, nBox = 0; final Set<String> nShelf = {};
                    for (final z in _scope) { final b = boxCnt[z] ?? 0; if (b > 0) { nCell++; nBox += b; nShelf.add(invShelfOf(z)); } }
                    return Card(
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          if (_scopeType != 'shelf') ...[
                            const Text("第一步：选择盘点类型", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 6),
                          ],
                          if (_scopeType != 'shelf')
                            Wrap(spacing: 8, children: [
                              ChoiceChip(label: const Text("AGV货架 NB02"), selected: _scopeType == 'shelf', onSelected: (_) => setState(() { _scopeType = 'shelf'; _scope.clear(); })),
                              ChoiceChip(label: const Text("地面库位 NB03"), selected: _scopeType == 'ground', onSelected: (_) => setState(() { _scopeType = 'ground'; _scope.clear(); })),
                              ChoiceChip(label: const Text("来料区 NB04"), selected: _scopeType == 'recv', onSelected: (_) => setState(() { _scopeType = 'recv'; _scope.clear(); })), // ㉖v120 来料区班末对账=按行圈盘
                              ChoiceChip(label: const Text("混合/全盘"), selected: _scopeType.isEmpty, onSelected: (_) => setState(() { _scopeType = ''; _scope.clear(); })),
                            ])
                          else
                            Row(children: [
                              const Text("盘点类型：", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                              ChoiceChip(label: const Text("改选其他类型"), selected: false, onSelected: (_) => setState(() { _scopeType = ''; _scope.clear(); })),
                            ]),
                          if (_scopeType.isEmpty)
                            const Padding(padding: EdgeInsets.only(top: 8), child: Text("未选类型：本次全盘（货架+地面全覆盖），无需勾区域。", style: TextStyle(fontSize: 12, color: Colors.grey)))
                          else if (_scopeType == 'shelf') ...[
                            const SizedBox(height: 10),
                            const Text("第二步：勾选要盘的货架格位（展开货架勾层，或点货架行整架全选）", style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            Text("已勾 ${_scope.length} 格位 · 实有 $nBox 框 · 需拉 ${nShelf.length} 趟 → 创建后自动展开应扫清单，AGV 逐框拉架到台站核对→钉死归位（人不去货架前）", style: const TextStyle(fontSize: 11.5, color: Color(0xFF3949AB))),
                            const SizedBox(height: 4),
                            if (shelfGroups.isEmpty)
                              const Text("货位基准中没有货架格位数据", style: TextStyle(fontSize: 12, color: Colors.grey))
                            else
                              Column(children: shelfGroups.entries.map((en) {
                                final cells = en.value;
                                final on = _scope.where(cells.contains).length;
                                return ExpansionTile(
                                  tilePadding: EdgeInsets.zero,
                                  initiallyExpanded: cells.length <= 2,
                                  title: InkWell(
                                    onTap: () => setState(() {
                                      if (on == cells.length) { _scope.removeAll(cells); } else { _scope.addAll(cells); }
                                    }),
                                    child: Row(children: [
                                      SizedBox(width: 24, child: Checkbox(value: on == cells.length ? true : (on > 0 ? null : false), tristate: true, onChanged: (_) => setState(() { if (on == cells.length) { _scope.removeAll(cells); } else { _scope.addAll(cells); } }))),
                                      const SizedBox(width: 4),
                                      Text(en.key, style: const TextStyle(fontSize: 13, fontFamily: "monospace", fontWeight: FontWeight.w700)),
                                      const SizedBox(width: 8),
                                      Text("共 ${cells.length} 层 · ${cells.fold<int>(0, (s, c) => s + (boxCnt[c] ?? 0))} 框在架", style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
                                    ]),
                                  ),
                                  children: cells.map((c) => CheckboxListTile(
                                    dense: true, contentPadding: const EdgeInsets.only(left: 24), controlAffinity: ListTileControlAffinity.leading,
                                    title: Text("$c　${boxCnt[c] ?? 0} 框", style: const TextStyle(fontSize: 12.5, fontFamily: "monospace")),
                                    value: _scope.contains(c),
                                    onChanged: (v) => setState(() { if (v == true) { _scope.add(c); } else { _scope.remove(c); } }),
                                  )).toList(),
                                );
                              }).toList()),
                          ] else ...[
                            const SizedBox(height: 10),
                            Text("第二步：勾选要盘的${_scopeType == 'recv' ? '来料区行（班末对账勾全部行）' : '地面排（如 NB03-A-13）'}", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                            const SizedBox(height: 4),
                            if (zones.isEmpty)
                              const Text("货位基准中没有该类型的库位数据", style: TextStyle(fontSize: 12, color: Colors.grey))
                            else
                              // ㉖v181 修②：原 maxHeight300 内层滚动嵌在外层 SingleChildScrollView 里
                              // ——Flutter 双层同轴滚动不联动，内层列表经常滚不动，F-02 之后的项看不见
                              // 也点不着（11-14 现场截图实锤）。候选直接铺进外层滚动流，整页一处滚。
                              Column(children: zones.map((z) => CheckboxListTile(
                                dense: true, contentPadding: EdgeInsets.zero, controlAffinity: ListTileControlAffinity.leading,
                                title: Text(z, style: const TextStyle(fontSize: 13, fontFamily: "monospace")),
                                value: _scope.contains(z),
                                onChanged: (v) => setState(() { if (v == true) { _scope.add(z); } else { _scope.remove(z); } }),
                              )).toList()),
                          ],
                        ]),
                      ),
                    );
                  },
                ),
              const SizedBox(height: 8),
              const Text("范围外货架/排的零件即使账面有数，也不会出现在差异报表里，不会造成假盘亏。", style: TextStyle(fontSize: 12, color: Colors.grey)),
              ],
            ],
            if (_step == 3) ...[
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
                      if (_pickMode == 1) ...[
                        Text("盘点方式：点名盘 · 应扫 ${_pickCodes.length} 框"),
                        const SizedBox(height: 6),
                        Text("点名输入：${_pickCtrl.text.trim().replaceAll(RegExp(r'\s+'), " / ")}", style: const TextStyle(fontSize: 12, fontFamily: "monospace")),
                        const SizedBox(height: 6),
                      ] else ...[
                        Text("盘点类型：${_scopeType == 'shelf' ? "AGV货架（格位级 · AGV拉架台站核对）" : _scopeType == 'ground' ? "地面库位" : _scopeType == 'recv' ? "来料区" : "混合/全盘"}"),
                        const SizedBox(height: 6),
                        Text("盘点范围：${_scope.isEmpty ? "全盘" : _scopeType == 'shelf' ? "循环盘 · ${_scope.length} 个格位（${_scope.map(invShelfOf).toSet().join("、")}）" : "循环盘 · ${_scope.join("、")}"}"),
                        const SizedBox(height: 6),
                        if (_scopeType == 'shelf' && _scope.isNotEmpty) ...[
                          const Text("创建时自动展开应扫清单 → 任务卡「AGV搬运」逐框发起：AGV 取框到站台 → 到台扫码核对 → 钉死归位；核对相符自动算已盘到。", style: TextStyle(fontSize: 12, color: Color(0xFF3949AB))),
                          const SizedBox(height: 6),
                        ],
                      ],
                      const Text("⚠️ 盘点期间请冻结出入库，否则产生虚假盘亏。", style: TextStyle(color: Colors.red, fontSize: 12)),
                    ],
                  ),
                ),
              ),
            ],
                ],
              ),
            ),
          ),
          // ㉖v174f 向导按钮固定屏幕底部：此前按钮排在内容最末，第二步选 AGV货架/地面库位 时
          // 长列表把按钮推出屏幕，且手势落在区域列表上只滚内层（限高300）、外层滚不动 →
          // 按钮"消失"无法进入下一步（混合/全盘内容短侥幸可见=用户截图三张实证）。固定后永在。
          Container(
            padding: EdgeInsets.fromLTRB(14, 10, 14, 10 + MediaQuery.of(context).padding.bottom),
            decoration: BoxDecoration(color: Theme.of(context).scaffoldBackgroundColor, border: Border(top: BorderSide(color: Colors.black12))),
            child: Row(
              children: [
                if (_step > 0) Expanded(child: OutlinedButton(onPressed: () => setState(() => _step--), child: const Text("上一步"))),
                if (_step > 0) const SizedBox(width: 10),
                Expanded(
                  child: ElevatedButton(
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
                    onPressed: _step == 3 ? _create : _next,
                    child: Text(_step == 3 ? "创建并开始盘点" : "下一步"),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// 下一步：实时模式在离开基准步时生成快照（口径=库存页在库合计；空账本拦截防误盘）
  Future<void> _next() async {
    if (_step == 2 && _pickMode == 0 && _scopeType.isNotEmpty && _scope.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("已选盘点类型但未勾选任何区域：请至少勾一个，或改选「混合/全盘」"), backgroundColor: Colors.orange));
      return;
    }
    if (_step == 1 && _useLive && _liveInfo.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("正在生成实时账本快照（含与电脑账本合并）…"), backgroundColor: Colors.blueGrey));
      try {
        final r = await buildLiveBaseline();
        final books = r["books"] as int, locs = r["locs"] as int;
        if (books == 0) {
          if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("快照为空：系统账本里没有任何在库零件，请先同步/导入账本再盘"), backgroundColor: Colors.orange, duration: Duration(seconds: 5)));
          return;
        }
        // ㉖v94u 快照留痕：拉取失败或本机行数落后服务器 → 当场提醒基准可能缺行
        String warn = "";
        try {
          final m = (r["meta"] as Map?) ?? {};
          if (m["pullOk"] != true) {
            warn = "\n⚠️与电脑账本合并失败（${m["msg"]}），快照基于本机旧账本";
          } else {
            final st = (m["srvTotal"] as num?)?.toInt() ?? -1, lr = (m["localRows"] as num?)?.toInt() ?? -1;
            if (st >= 0 && lr >= 0 && lr < st) warn = "\n⚠️本机账本 $lr 行 < 服务器 $st 行（v${m["srvRev"]}），快照可能缺框——建议先在各台PDA同步后重建基准";
          }
        } catch (_) {}
        if (!mounted) return;
        setState(() {
          _bookKey = _locKey = r["key"].toString();
          _bookName = _locName = "系统实时账本";
          _bookInfo = "零件 $books 个"; _locInfo = "货位行 $locs 条";
          _liveInfo = "零件 $books 个 · 货位行 $locs 条$warn";
        });
      } catch (e) {
        if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("快照生成失败：$e"), backgroundColor: Colors.red));
        return;
      }
    }
    if (!mounted) return;
    setState(() => _step++);
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
  String _curZone = ""; // ㉖v86 整区盘点：非空=绑定的货区，扫码后按台账自动归位到区内具体货位
  bool get _bound => _curLoc.isNotEmpty || _curZone.isNotEmpty;
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
    final scope = widget.task.invScope;
    return locs.map((e) => e.locCode).toSet().where((c) => invLocInScope(c, scope)).toList()..sort();
  }

  Future<void> _pickLoc() async {
    final opts = await _locOptions();
    if (!mounted) return;
    if (opts.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("货位基准未绑定或无货位数据，请在创建任务时绑定货位基准")));
      return;
    }
    // ㉖v86 两段式：整区盘点（推荐，免逐位切换）/ 单货位盘点（原有精确口径）
    final zones = opts.map(invZoneOf).toSet().toList()..sort();
    final sel = await showModalBottomSheet<_LocSel>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          children: [
            const Padding(padding: EdgeInsets.fromLTRB(14, 14, 14, 4), child: Text("整区盘点 · 自动归位（推荐）", style: TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF00695C)))),
            Padding(padding: const EdgeInsets.fromLTRB(14, 0, 14, 6), child: Text("绑定货区后连续扫码，系统按台账把每框自动归到区内登记货位；零件不在该区台账时挂本区并提示串位", style: TextStyle(fontSize: 11.5, color: Colors.grey))),
            ...zones.map((z) => ListTile(
                  dense: true,
                  leading: const Icon(Icons.dashboard_outlined, color: Color(0xFF00897B), size: 20),
                  title: Text(z, style: const TextStyle(fontFamily: "monospace")),
                  subtitle: Text("${opts.where((c) => invZoneOf(c) == z).length} 个货位", style: const TextStyle(fontSize: 11)),
                  trailing: z == _curZone ? const Icon(Icons.check, color: Color(0xFF515BD4)) : null,
                  onTap: () => Navigator.pop(ctx, _LocSel(zone: z)),
                )),
            const Divider(height: 20),
            const Padding(padding: EdgeInsets.fromLTRB(14, 4, 14, 4), child: Text("单货位盘点（精确口径，逐位扫码时手选）", style: TextStyle(fontWeight: FontWeight.bold))),
            ...opts.map((o) => ListTile(
                  dense: true,
                  title: Text(o, style: const TextStyle(fontFamily: "monospace")),
                  onTap: () => Navigator.pop(ctx, _LocSel(loc: o)),
                )),
          ],
        ),
      ),
    );
    if (sel != null && mounted) setState(() {
      _curZone = sel.zone;
      _curLoc = sel.loc;
    });
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
    // ㉖v69 标签格式闸（与采集同口径）：N开头+10位，不符禁止录入
    final fmtErr = labelFormatErr(code);
    if (fmtErr != null) {
      if (mounted) {
        showDialog(
            context: context,
            builder: (dc) => AlertDialog(
                  icon: const Icon(Icons.block, color: Colors.red, size: 34),
                  title: const Text("标签号不符合规则"),
                  content: Text("$fmtErr\n\n规则：N 开头，总长 10 位。请核对实物标签或重新扫码。"),
                  actions: [
                    FilledButton(onPressed: () => Navigator.pop(dc), child: const Text("知道了"))
                  ],
                ));
      }
      return;
    }
    if (!_bound) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("请先绑定盘点货位或货区！")));
      return;
    }
    // ㉖v174 点名盘：扫到【应扫清单外】的框 → 弹窗确认（仍记录=清单外实物，照常入账+备注；取消=不记）
    bool pickOffList = false;
    if (widget.task.invPickMode == 1) {
      final upCode = code.trim().toUpperCase();
      if (!widget.task.invPickCodes.map((e) => e.trim().toUpperCase()).contains(upCode)) {
        pickOffList = true;
        final keep = await showDialog<bool>(
          context: context,
          builder: (dc) => AlertDialog(
            icon: const Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 34),
            title: const Text("不在点名清单内"),
            content: Text("标签 $upCode 不在本任务应扫清单（${widget.task.invPickCodes.length} 框）内。\n可能是：串位/挪架/清单展开后新入的框。\n\n「仍记录」= 照常入账并备注清单外；「不记录」= 丢弃本次扫码。"),
            actions: [
              TextButton(onPressed: () => Navigator.pop(dc, false), child: const Text("不记录")),
              FilledButton(onPressed: () => Navigator.pop(dc, true), child: const Text("仍记录")),
            ],
          ),
        ) ?? false;
        if (!keep || !mounted) return;
      }
    }
    _busy = true;
    try {
      // 1. 重复码检测（同任务）
      final dupRows = await _globalIsar.inventoryScans
          .filter().taskIdEqualTo(widget.task.batchId).goodsCodeEqualTo(code).findAll();
      // ㉖v86 整区盘点：先挂区名占位，MES 反查拿到零件号后归位到区内具体货位（单货位模式行为不变）
      final rec = InventoryScan(taskId: widget.task.batchId, goodsCode: code, scanTime: DateTime.now(), locCode: _curLoc.isNotEmpty ? _curLoc : _curZone);
      InvJudge judge;
      if (dupRows.isNotEmpty) {
        rec.flag = 1;
        judge = InvJudge(1, "red", "重复码：本任务已扫过（${dupRows.first.locCode} ${dupRows.first.scanTime.toString().substring(11, 16)}），不计数量");
      } else {
        // 2. MES 反查
        final mes = await mesQueryLabel(code);
        if (mes["found"] == false) {
          // ㉖v69 查无此码（用户拍板）：弹窗禁止录入，不再挂起入账
          if (mounted) {
            showDialog(
                context: context,
                builder: (dc) => AlertDialog(
                      icon: const Icon(Icons.search_off, color: Colors.deepOrange, size: 34),
                      title: const Text("MES 查无此标签"),
                      content: Text("标签「$code」在 MES 中查不到在库记录，已禁止录入盘点。\n\n请核对标签是否贴错/串托，或重新扫码确认无误读。"),
                      actions: [
                        FilledButton(onPressed: () => Navigator.pop(dc), child: const Text("知道了"))
                      ],
                    ));
          }
          return;
        }
        if (mes["ok"] != true) {
          rec.flag = 2;
          rec.remark = mes["msg"].toString();
          judge = InvJudge(2, "purple", "MES无此码（${mes["msg"]}），已挂起待复核");
        } else {
          rec.partNo = mes["partNo"];
          rec.itemName = mes["itemName"];
          rec.lotNo = mes["lotNo"];
          rec.qty = mes["qty"];
          // ㉖v97 串位防错闸：单货位模式下核对该标签货位账本登记位，与当前绑定位不符→现场三选一确认
          //（修"在 -03 扫了 -05 的标签整框记到 -03，造成一边假盈一边假亏"）
          if (_curLoc.isNotEmpty) {
            var spHits = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(code).findAll();
            final up = code.trim().toUpperCase();
            if (up != code) spHits = [...spHits, ...await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(up).findAll()];
            final spLoc = spHits.map((e) => e.loc.trim().toUpperCase()).firstWhere((l) => l.isNotEmpty, orElse: () => "");
            if (spLoc.isNotEmpty && spLoc != _curLoc.trim().toUpperCase()) {
              final pick = await showDialog<int>(
                  context: context,
                  builder: (dc) => AlertDialog(
                      icon: const Icon(Icons.warning_amber_rounded, color: Colors.orange, size: 34),
                      title: const Text("标签登记位与当前盘点位不符"),
                      content: Text("标签「$code」货位账本登记在：\n　$spLoc\n当前绑定盘点位：\n　$_curLoc\n\n请核对实物此刻在哪个格位再选择（选错会造成两边假盈亏）。", style: const TextStyle(fontSize: 13, height: 1.5)),
                      actions: [
                        TextButton(onPressed: () => Navigator.pop(dc, 2), child: const Text("取消，重扫")),
                        TextButton(onPressed: () => Navigator.pop(dc, 0), child: Text("确认在 $_curLoc")),
                        FilledButton(onPressed: () => Navigator.pop(dc, 1), child: Text("按账本位 $spLoc 盘")),
                      ]));
              if (pick == null || pick == 2) {
                if (mounted) setState(() => _codeCtrl.clear());
                return; // 取消：不录入
              }
              if (pick == 1) {
                _curLoc = spLoc;
                rec.locCode = spLoc; // 本条记录同步改挂账本位（rec 在弹窗前已创建）
                setState(() {});
              } // 切到账本登记位继续
            }
          }
          // 3. 账内外 + 串位 + 超量
          final bookHit = await _globalIsar.baselineBooks.filter().partNoEqualTo(rec.partNo).findAll();
          // ㉖v98 整区/整架归位（地面货位实际是绑 NB03-B-12 整架扫，不逐格位绑）：
          // 首选按货位账本中"该标签"的登记格位精确归位（账本一框一位，同零件两框各归 -03/-05，
          // 修旧版按零件号归位把两框全堆第一格 → 一格虚盈他格虚亏）；账本查无再按零件号台账轮转兜底
          String effLoc = _curLoc;
          if (_curLoc.isEmpty && _curZone.isNotEmpty) {
            String? tagLoc;
            try {
              final up0 = code.trim().toUpperCase();
              var spHits = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(code).findAll();
              if (up0 != code) spHits = [...spHits, ...await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(up0).findAll()];
              for (final sp in spHits) {
                final l = sp.loc.trim().toUpperCase();
                if (l.isNotEmpty && invZoneOf(l) == _curZone) { tagLoc = l; break; }
              }
            } catch (_) {}
            if (tagLoc != null) {
              effLoc = tagLoc;
              rec.locCode = tagLoc; // 标签级归位：报表/差异按账本格位聚合
            } else {
              final zoneRows = ((await _globalIsar.baselineLocs
                          .filter().partNoEqualTo(rec.partNo).findAll())
                      .where((e) => invZoneOf(e.locCode) == _curZone)
                      .map((e) => e.locCode.trim().toUpperCase())
                      .toSet()
                      .toList())
                ..sort();
              if (zoneRows.isNotEmpty) {
                // 同零件在本区登记多格：第 N 框归第 N 格（轮转），不再全堆第一格
                final prior = await _globalIsar.inventoryScans
                    .filter().taskIdEqualTo(widget.task.batchId).findAll();
                final used = prior
                    .where((s) => s.flag != 1 && s.flag != 2 && (s.partNo ?? "").trim().toUpperCase() == (rec.partNo ?? "").trim().toUpperCase() && invZoneOf(s.locCode) == _curZone)
                    .length;
                effLoc = zoneRows[used % zoneRows.length];
                rec.locCode = effLoc;
                if (zoneRows.length > 1) rec.remark = "账本无此标签登记位，按台账轮转归至 ${zoneRows.join("、")}";
              } else {
                // 零件在本区台账无登记位：挂区名（串位提示显示"货区「NB03-A-11」"而非空货位）
                effLoc = _curZone;
              }
            }
          }
          final locHit = await _globalIsar.baselineLocs
              .filter().locCodeEqualTo(effLoc).partNoEqualTo(rec.partNo).findAll();
          double scannedInLoc = rec.qty;
          final priorRows = await _globalIsar.inventoryScans
              .filter().taskIdEqualTo(widget.task.batchId).locCodeEqualTo(effLoc).partNoEqualTo(rec.partNo).findAll();
          for (final s in priorRows.where((s) => s.flag != 1)) {
            scannedInLoc += s.qty;
          }
          final locBook = locHit.fold<double>(0, (sum, e) => sum + e.qty);
          // 循环盘点：零件登记在未盘点货架 → flag6 范围外（不计盘盈亏，报表单列）
          bool outScope = false;
          final scope = widget.task.invScope;
          if (scope.isNotEmpty && bookHit.isNotEmpty && locHit.isEmpty) {
            final allRows = await _globalIsar.baselineLocs.filter().partNoEqualTo(rec.partNo).findAll();
            if (allRows.isNotEmpty && !allRows.any((e) => invLocInScope(e.locCode, scope))) {
              outScope = true;
              rec.flag = 6;
              rec.remark = "台账登记于${allRows.map((e) => e.locCode).take(3).join("、")}${allRows.length > 3 ? "等" : ""}（未盘点货架）";
              judge = InvJudge(6, "cyan", "范围外：「${rec.partNo}」登记在未盘点货架，已记录待核对");
            }
          }
          if (outScope) {
            // 范围外：保持 flag6，不进盘盈亏
            judge = InvJudge(6, "cyan", "范围外：「${rec.partNo}」登记在未盘点货架，已记录待核对");
          } else if (bookHit.isEmpty && !locHit.isEmpty && widget.task.invBookKey.isNotEmpty) {
            //货位台账有、总账没有 → 双基准矛盾，按账外料口径记，并备注
            rec.flag = 3;
            rec.remark = "双基准矛盾：总账无此零件但货位台账登记";
            judge = InvJudge(3, "red", "⚠️双基准矛盾：总账基准查无「${rec.partNo}」，但货位台账有登记——先核两份账谁旧了");
          } else if (bookHit.isEmpty) {
            if (widget.task.invBookKey.isEmpty) {
              rec.flag = 0;
              judge = InvJudge(0, "green", "已记录：${rec.partNo} ${_fmtInvNum(rec.qty)} 件 @ $effLoc（未绑账面基准，不判账外/超量）");
            } else {
              rec.flag = 3;
              judge = InvJudge(3, "red", "账外物料：零件「${rec.partNo}」不在账面基准，仍已记录");
            }
          } else {
            rec.partNo = bookHit.first.partNo; //统一以基准写法为准（大小写差异归一）
            judge = judgeInventory(
              partInBook: true,
              partInLoc: !locHit.isEmpty,
              scannedQtyInLoc: scannedInLoc,
              locBookQty: locBook,
            );
            rec.flag = judge.flag;
            if (judge.flag == 4) judge = InvJudge(4, "yellow", "串位提示：${effLoc == _curZone ? "货区「$_curZone」" : "货位「$effLoc」"}台账无零件「${rec.partNo}」，仍已记录");
            if (judge.flag == 5) {
              judge = widget.task.blindMode
                  ? InvJudge(5, "yellow", "超量提示：「$effLoc」该零件实扫已超台账（盲盘，账面数结束后可见）")
                  : InvJudge(5, "yellow", "超量提示：「$effLoc」该零件已扫 ${_fmtInvNum(scannedInLoc)}，台账 ${_fmtInvNum(locBook)}");
            }
            if (judge.flag == 0 && effLoc.isNotEmpty) {
              final autoTag = _curLoc.isEmpty && _curZone.isNotEmpty ? "（自动归位）" : "";
              judge = InvJudge(0, "green", "正常：${rec.partNo} ${_fmtInvNum(rec.qty)} 件 @ $effLoc$autoTag");
            }
          }
        }
      }
      if (pickOffList) rec.remark = (rec.remark.isEmpty ? "" : "${rec.remark} ") + "清单外扫入"; // ㉖v174 点名盘：清单外仍记录→留痕（拼接防被后续留证备注覆盖）
      await _globalIsar.writeTxn(() async {
        await _globalIsar.inventoryScans.put(rec);
      });
      // 震动/声音提示：异常强提醒
      try {
        if (judge.level == "red" || judge.level == "purple") {
          if (await Vibration.hasVibrator() ?? false) await Vibration.vibrate(duration: 220);
        } else if (await Vibration.hasVibrator() ?? false) {
          await Vibration.vibrate(duration: 80);
        }
        await SystemSound.play(judge.level == "green" ? SystemSoundType.click : SystemSoundType.alert);
      } catch (_) {}
      if (!mounted) return; // ㉖v98b 震动/音效均为 await，期间页面可能已退出：setState 前守卫
      setState(() {
        _lastJudge = judge;
        _lastCode = code;
        _recent.add(rec);
        _codeCtrl.clear();
      });
      if (judge.level == "red" || judge.level == "purple") _offerEvidence(code, rec, judge.msg); // ④异常拍照留证
      _codeFocus.requestFocus();
    } finally {
      _busy = false;
    }
  }

  /// ④异常留证：把异常元数据（货位/标签/原因/操作人/时间）写入审计日志，并引导现场用PDA相机拍照，
  /// 照片时间戳与审计记录交叉对应即成证据链。零新增依赖（不引入相机插件，规避构建风险）。
  Future<void> _offerEvidence(String code, InventoryScan rec, String why) async {
    if (!mounted) return;
    LocalLog.op('盘点异常', '${rec.locCode} 标签$code · $why'); // 无论是否拍照，异常先落审计
    final note = await showDialog<String>(context: context, builder: (ctx) {
      final c = TextEditingController();
      return AlertDialog(
        title: const Text("⚠ 异常留证"),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text("货位 ${rec.locCode}\n标签 $code\n$why", style: const TextStyle(fontSize: 13, height: 1.5)),
          const SizedBox(height: 8),
          const Text("可用 PDA 自带相机拍现场照片，照片与下方备注会写入审计日志便于追溯。", style: TextStyle(fontSize: 11.5, color: Colors.grey)),
          const SizedBox(height: 6),
          TextField(controller: c, maxLines: 2, decoration: const InputDecoration(hintText: "备注（可选，如“实物少2件”）", border: OutlineInputBorder(), isDense: true)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text("关闭")),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim()), child: const Text("记录备注")),
        ],
      );
    });
    if (note != null && note.isNotEmpty) {
      rec.remark = (rec.remark.isEmpty ? "" : "${rec.remark} ") + "留证:$note";
      await _globalIsar.writeTxn(() => _globalIsar.inventoryScans.put(rec));
      LocalLog.op('异常留证备注', '${rec.locCode} $code · $note');
      if (mounted) { setState(() { _recent.removeWhere((x) => x.id == rec.id); _recent.add(rec); }); }
    }
  }

  Future<void> _openCamera() async {
    // ㉖v120 改用共享相机实现：合法码才返回（盘点提交同样过 labelFormatErr，谓词同口径）
    final code = await cameraScanDialog(context, valid: (c) => labelFormatErr(c) == null);
    if (code != null && code.trim().isNotEmpty) await _submit(code.trim());
  }

  Color _levelColor(String lv) => switch (lv) {
        "green" => const Color(0xFF1E9E6A),
        "yellow" => const Color(0xFFD97706),
        "red" => const Color(0xFFC0392B),
        "purple" => const Color(0xFF7C3AED),
        "cyan" => const Color(0xFF0891B2),
        _ => Colors.grey,
      };

  // ㉖v174c 整合：点名任务中的 AGV 货架框 → 走"盲区抽盘"通道发起拉架（同一双腿/核对/钉死归位状态机）。
  //   工单挂 pickBatch=本任务号，结束任务时核对结果自动回流未盘到清单（相符=算盘到，不符=单列）。
  Future<void> _agvTransport() async {
    final codes = widget.task.invPickShelf;
    if (codes.isEmpty) return;
    final go = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
              title: const Text("AGV 搬运发起"),
              content: Text("本任务有 ${codes.length} 个 AGV 货架框（在架清单中）。\n"
                  "将逐框建搬运工单：AGV 取框到站台 → 到台扫码核对 → 归位回原格（钉死原格位）。\n"
                  "· 到台核对在工单看板做；核对相符的框，结束任务时自动算「已盘到」\n"
                  "· 已在盘点/搬运中的框会自动跳过并说明原因\n\n确认发起？"),
              actions: [
                TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("取消")),
                FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("发起")),
              ],
            ));
    if (go != true || !mounted) return;
    setState(() => _busy = true);
    try {
      // ㉖v181 分批发起：服务端单请求 codes 上限 200（超出静默截断）——范围盘拉架勾两三架
      // 即可达数百框，一次性提交会丢单且无声无息。每片 180 留余量，逐片提交聚合结果。
      int okN = 0;
      final fails = <dynamic>[];
      String? netErr;
      for (int i = 0; i < codes.length; i += 180) {
        final chunk = codes.sublist(i, i + 180 > codes.length ? codes.length : i + 180);
        try {
          final r = await AuthApi.countStart(codes: chunk, pickBatch: widget.task.batchId);
          if (r["ok"] == true) {
            okN += ((r["list"] as List?) ?? const []).length;
            fails.addAll(((r["out"] as List?) ?? const []).where((x) => (x as Map)["ok"] != true));
          } else {
            netErr = r["msg"]?.toString();
          }
        } catch (e) { netErr = "$e"; }
        if (!mounted) return;
      }
      String msg;
      if (netErr == null || okN > 0) {
        msg = "已发起 $okN/$codes.length 框";
        if (fails.isNotEmpty) {
          final det = fails.take(3).map((f) { final fm = f as Map; return '${fm["code"]}(${fm["msg"]})'; }).join('、');
          msg += "，跳过 ${fails.length}：$det${fails.length > 3 ? ' 等' : ''}";
        }
        if (netErr != null) msg += "｜部分批次异常：$netErr";
      } else {
        msg = "发起失败：$netErr";
      }
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: okN > 0 ? const Color(0xFF2E7D32) : Colors.orange, duration: const Duration(seconds: 6)));
      if (okN > 0 && mounted) await Navigator.push(context, MaterialPageRoute(builder: (_) => const ShelfCountPage())); // 跳工单看板跟进发车/核对/归位
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("AGV 搬运发起异常：$e"), backgroundColor: Colors.red));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _finishTask() async {
    final task = widget.task;
    // ㉖v174 点名盘：结束前算「未盘到」= 应扫清单 − 本任务有效扫到（重复码/MES无码不算扫到）
    //   意义：把"该在的都在吗"这个此前只能靠人记忆的判断题，变成系统当场给出的清单。
    // ㉖v174b AGV 货架盘点要"拉架到台站→扫→送回"，一轮可能几十分钟，期间框可能被正常领走；
    //   故结束前【重新与服务器账本对齐】再按最新状态定性，分两类：
    //     gone=最新账本已无此框（已出库/已消账）→ 正常流转，不算缺失、只告知
    //     miss=账本仍在架却没扫到 → 真需现场复核（缺失/串位/还没拉过来）
    //   不这么做的后果：搬运耗时越久误报越多，点名盘会被现场当成"净报错"而弃用。
    String missJson = task.invMissJson;
    int missN = 0, goneN = 0, agvOkN = 0, agvBadN = 0;
    if (task.invPickMode == 1) {
      await ledgerPullMerge(force: true); // 取全厂最新账（含本任务期间的出库/移位）
      final scans = await _globalIsar.inventoryScans.filter().taskIdEqualTo(task.batchId).findAll();
      final got = <String>{};
      for (final s in scans) {
        if (s.flag != 1 && s.flag != 2) got.add(s.goodsCode.trim().toUpperCase());
      }
      final lp = await _globalIsar.labelInfos.where().findAll();
      final pnOf = <String, String>{for (final e in lp) e.goodsCode.trim().toUpperCase(): e.partNo};
      final spp = await _globalIsar.shelfPlacements.where().findAll();
      final locOf = <String, String>{for (final e in spp) e.goodsCode.trim().toUpperCase(): e.loc};
      // ㉖v174c 整合回流：本任务经"盲区抽盘通道"发起的 AGV 工单结果（到台核对由服务器工单记录，
      //   不进本地 inventoryScans）——已核对相符=等同盘到剔除；核对不符=单列 agvDiff 待处理；
      //   在途/未完=保持未盘到并标注工单状态。拉取失败=按无 AGV 通道处理（离线场景不卡死）。
      final agvBy = <String, Map>{};
      try {
        final cr = await AuthApi.countList(all: true);
        for (final q in ((cr["list"] as List?) ?? const [])) {
          final m = q as Map;
          if ((m["pickBatch"] ?? "").toString() != task.batchId) continue;
          final cd = (m["code"] ?? "").toString().trim().toUpperCase();
          final prev = agvBy[cd];
          if (prev == null || (num.tryParse('${m["at"]}') ?? 0) > (num.tryParse('${prev["at"]}') ?? 0)) agvBy[cd] = m; // 同码多单取最新
        }
      } catch (_) {}
      final rows = <Map<String, String>>[];
      for (final c in task.invPickCodes.map((e) => e.trim().toUpperCase()).toSet()) {
        if (got.contains(c)) continue;
        final q = agvBy[c];
        if (q != null) {
          final st = (q["state"] ?? "").toString();
          final df = q["diff"] is Map ? q["diff"] as Map : null;
          if ((st == "done" || st == "returning") && df == null) { agvOkN++; continue; } // AGV 通道核对相符（归位中/已归位）=已盘到
          if (st == "mismatch" || (st == "scanned" && df != null)) {
            agvBadN++;
            rows.add({"c": c, "p": pnOf[c] ?? "", "l": locOf[c] ?? "", "st": "agvDiff",
              "r": df == null ? "AGV核对不符" : (df["kind"] == "qty" ? "数量不符：账${df["expect"]}/实${df["actual"]}" : "站台实扫 ${df["scanned"]}（非本单框）")});
            continue;
          }
          // 工单未完（待发车/在途/到台未扫/超时/取消）：仍算未盘到，标注卡在哪一步
          final stillInQ = locOf.containsKey(c);
          if (stillInQ) missN++; else goneN++;
          rows.add({"c": c, "p": pnOf[c] ?? "", "l": locOf[c] ?? "", "st": stillInQ ? "miss" : "gone", "r": "AGV工单未完成[${st}]"});
          continue;
        }
        final stillIn = locOf.containsKey(c);
        if (stillIn) missN++; else goneN++;
        rows.add({"c": c, "p": pnOf[c] ?? "", "l": locOf[c] ?? "", "st": stillIn ? "miss" : "gone"});
      }
      missJson = jsonEncode(rows);
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text("结束盘点任务"),
        content: Text(task.invPickMode == 1
            ? "点名盘：应扫 ${task.invPickCodes.length} 框"
                "${agvOkN > 0 ? "，其中 AGV 通道已核对 $agvOkN 框" : ""}\n"
                "· 仍在架未扫到：$missN 框 ${missN > 0 ? "（需现场复核：缺失/串位/架还没拉过来）" : ""}\n"
                "· 已出库或已消账：$goneN 框（盘点期间正常流转，不算缺失）"
                "${agvBadN > 0 ? "\n· ⚠ AGV 核对不符：$agvBadN 框（请看清单备注，人工处理后方可结案）" : ""}"
                "${missN == 0 && goneN == 0 && agvBadN == 0 ? "\n全部盘到 ✅" : ""}\n\n结束后进入差异报表，之后不可再扫描。确认结束？"
            : "结束后进入差异报表，之后不可再扫描。确认结束？"),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("继续盘点")),
          TextButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("确认结束")),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    task.isArchived = true;
    if (task.invPickMode == 1) task.invMissJson = missJson;
    await _globalIsar.writeTxn(() async {
      await _globalIsar.batchInfos.put(task);
    });
    if (!mounted) return;
    Navigator.pushReplacement(context, MaterialPageRoute(builder: (_) => _InvDiffPage(task: task)));
  }

  @override
  Widget build(BuildContext context) {
    final total = _recent.length;
    final abnormal = _recent.where((s) => s.flag != 0).length;
    final inLoc = _curLoc.isNotEmpty
        ? _recent.where((s) => s.locCode == _curLoc && s.flag != 1).length
        : _recent.where((s) => (s.locCode == _curZone || invZoneOf(s.locCode) == _curZone) && s.flag != 1).length; // ㉖v86 整区模式按区聚合
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
                        color: _bound ? const Color(0xFFE8EAF6) : Colors.red.shade50,
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: _bound ? const Color(0xFF515BD4) : Colors.red),
                      ),
                      child: Row(
                        children: [
                          Icon(_curLoc.isEmpty ? Icons.dashboard : Icons.location_on, size: 18, color: _bound ? const Color(0xFF515BD4) : Colors.red),
                          const SizedBox(width: 6),
                          Expanded(child: Text(_curLoc.isNotEmpty ? "当前货位：$_curLoc（点击更换）" : (_curZone.isNotEmpty ? "整区盘点：$_curZone · 自动归位（点击更换）" : "未绑定，点击选择货区（整区·推荐）或货位"), style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: _bound ? const Color(0xFF3949AB) : Colors.red))),
                          // ㉖v174c 整合：点名任务含 AGV 货架框 → 一键经"盲区抽盘"通道发起拉架（拉架→核对→钉死归位），进度在工单看板
                          if (widget.task.invPickMode == 1 && widget.task.invPickShelf.isNotEmpty)
                            IconButton(tooltip: "AGV搬运（${widget.task.invPickShelf.length} 货架框）", onPressed: _agvTransport, icon: const Icon(Icons.local_shipping, size: 20, color: Color(0xFF3949AB))),
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
                _chip(_curLoc.isNotEmpty ? "本货位 $inLoc" : "本区已扫 $inLoc", const Color(0xFFE8EAF6), const Color(0xFF3949AB)),
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
                    enabled: _bound,
                    textInputAction: TextInputAction.done,
                    decoration: InputDecoration(
                      hintText: _bound ? "扫码枪扫货物标签 / 手输后回车" : "请先绑定货区或货位",
                      border: const OutlineInputBorder(),
                      isDense: true,
                      prefixIcon: const Icon(Icons.qr_code_scanner),
                    ),
                    onSubmitted: _submit,
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  onPressed: _bound ? _openCamera : null,
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
                      final lv = s.flag == 0 ? "green" : (s.flag == 4 || s.flag == 5) ? "yellow" : s.flag == 2 ? "purple" : s.flag == 6 ? "cyan" : "red";
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
    if (widget.task.isArchived == true) _invUpload(); // ㉕T2 已结束任务：打开报表即上收（幂等覆盖同批次）
  }

  /// ㉕T2 盘点结果上收电脑服务器（网页盘点页与D10导出数据源）；失败静默，本地不受影响
  Future<void> _invUpload({bool applied = false}) async {
    try {
      final d = await computeInvDiff(widget.task);
      final t = widget.task;
      final nowMs = DateTime.now().millisecondsSinceEpoch;
      // ㉖v95 实时基准留痕随报告上收（网页端可见"快照生成时本机账本就落后"）
      Object? liveMeta;
      if (t.invBookKey.startsWith('LIVE@')) {
        try {
          final sp = await SharedPreferences.getInstance();
          final raw = sp.getString("inv_live_meta_${t.invBookKey}");
          if (raw != null && raw.isNotEmpty) liveMeta = jsonDecode(raw);
        } catch (_) {}
      }
      await AuthApi.invReport({
        "batchId": t.batchId, "remark": t.batchRemark, "scope": t.invScope.join(","),
        "pickRaw": t.invPickRaw, "pickMiss": t.invMissJson, // ㉖v174 点名盘：原始输入+未盘到清单随报告上收
        "blind": t.blindMode, "bookKey": t.invBookKey, "locKey": t.invLocKey,
        "at": nowMs, "totalScans": d.totalScans, "validScans": d.validScans,
        "mesFail": d.mesFail.length, "dup": d.dup.length, "outside": d.outsideScope.length,
        "applied": applied, "applyTime": applied ? nowMs : 0,
        if (liveMeta != null) "liveMeta": liveMeta,
        "parts": d.parts.map((p) => {"pn": p.partNo, "nm": p.itemName, "book": p.bookQty, "real": p.realQty, "boxes": p.realBoxes, "out": p.outsideBoxes, "warn": p.warnFlag}).toList(),
        // ㉖v123b 标签级明细随货位行上收：codes实扫 / outCodes账外 / bookCodes基准应到（各"码|件数"，账外与应到无件数则仅码）
        "locs": d.locs.map((l) => {"loc": l.locCode, "pn": l.partNo, "book": l.bookQty, "real": l.realQty, "boxes": l.realBoxes, "codes": l.labels, "outCodes": l.outsideLabels, "bookCodes": l.bookLabels}).toList(),
      });
      LocalLog.op('盘点上收', '${t.batchId}${applied ? "（已改账版）" : ""}');
    } catch (_) {}
  }
  bool _applying = false; // 应用差异改账进行中

  /// 应用盘点实扫到货位账本：以实物为准修正位置（改位/补登记），绝不自动删除任何记录
  Future<void> _applyDiff() async {
    final scans = (await _globalIsar.inventoryScans.filter().taskIdEqualTo(widget.task.batchId).findAll())
      ..sort((a, b) => a.scanTime.compareTo(b.scanTime));
    final valid = scans.where((s) => s.flag != 1 && s.flag != 2 && s.locCode.trim().isNotEmpty && s.goodsCode.trim().isNotEmpty).toList();
    if (!mounted) return;
    if (valid.isEmpty) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("没有可应用的实扫记录（重复码与MES无码已排除）"))); return; }
    final latest = <String, InventoryScan>{};
    for (final s in valid) { latest[s.goodsCode.trim().toUpperCase()] = s; }
    final ledger = await _globalIsar.shelfPlacements.where().findAll();
    final byCode = <String, ShelfPlacement>{};
    for (final e in ledger) { byCode[e.goodsCode.trim().toUpperCase()] = e; }
    final moves = <String, String>{}, adds = <String, String>{};
    latest.forEach((code, s) {
      final loc = s.locCode.trim().toUpperCase();
      final cur = byCode[code];
      if (cur == null) { adds[code] = loc; } else if (cur.loc.trim().toUpperCase() != loc) { moves[code] = loc; }
    });
    // 盘亏（账本在范围内但未扫到）仅统计提示，不自动删除：漏扫与真缺货无法区分
    final scope = widget.task.invScope;
    int miss = 0;
    for (final e in ledger) {
      final c = e.goodsCode.trim().toUpperCase();
      if (latest.containsKey(c)) continue;
      if (scope.isNotEmpty && !invLocInScope(e.loc, scope)) continue;
      miss++;
    }
    if (moves.isEmpty && adds.isEmpty) { ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("货位账本与实盘已一致，无需修正"), backgroundColor: Colors.green)); return; }
    final samples = moves.entries.take(6).map((e) => "${e.key}  ${byCode[e.key]?.loc ?? "?"} → ${e.value}").join("\n");
    final yes = await showDialog<bool>(context: context, builder: (dctx) => AlertDialog(
      title: const Text("应用货位差异到账本"),
      content: SizedBox(width: 340, child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text("以本次实盘为准修正货位账本：", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
        const SizedBox(height: 6),
        Text("· 改位 ${moves.length} 码（串位/移位）", style: const TextStyle(fontSize: 13, color: Color(0xFFE65100))),
        Text("· 补登记 ${adds.length} 码（账本无此框）", style: const TextStyle(fontSize: 13, color: Colors.green)),
        Text("· 未扫到 $miss 码：只提示不删除（漏扫与缺货无法区分，缺货请走 MES 调整）", style: const TextStyle(fontSize: 12, color: Colors.grey)),
        if (samples.isNotEmpty) ...[
          const SizedBox(height: 8),
          Text("改位样例：\n$samples${moves.length > 6 ? "\n…共 ${moves.length} 条" : ""}", style: const TextStyle(fontSize: 11, fontFamily: "monospace", color: Colors.blueGrey)),
        ],
        const SizedBox(height: 8),
        Text("修正后自动同步电脑服务器，其他 PDA 拉取即生效。操作写入审计日志。", style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey)),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(dctx, false), child: const Text("取消")),
        FilledButton(style: FilledButton.styleFrom(backgroundColor: const Color(0xFF2E7D32)), onPressed: () => Navigator.pop(dctx, true), child: const Text("确认修正"))],
    ));
    if (yes != true || !mounted) return;
    setState(() => _applying = true);
    final now = DateTime.now().millisecondsSinceEpoch;
    final oper = Auth.user?.name ?? "盘点修正";
    try {
      await _globalIsar.writeTxn(() async {
        for (final e in {...moves, ...adds}.entries) {
          final olds = await _globalIsar.shelfPlacements.filter().goodsCodeEqualTo(e.key).findAll();
          await _globalIsar.shelfPlacements.deleteAll(olds.map((x) => x.id).toList());
          await _globalIsar.shelfPlacements.put(ShelfPlacement()
            ..goodsCode = e.key ..loc = e.value
            ..container = byCode[e.key]?.container ?? ""
            ..operator = oper ..assignedAt = now);
        }
      });
      await ledgerUnmarkDeleted([...moves.keys, ...adds.keys]);
      final r = await ledgerPushNow();
      LocalLog.op('盘点改账', '${widget.task.batchId} 改位${moves.length} 补登记${adds.length}${r["ok"] == true ? " 已同步" : " 同步失败"}');
      _invUpload(applied: true); // ㉕T2 改账后上收带已应用标记版
      if (!mounted) return;
      setState(() { _applying = false; _future = computeInvDiff(widget.task); });
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text("已修正 ${moves.length + adds.length} 码（改位 ${moves.length} · 补登记 ${adds.length}）${r["ok"] == true ? "，已同步电脑" : "，同步失败：${r["msg"]}（本地已生效，可稍后手动同步）"}${miss > 0 ? "；未扫到 $miss 码请人工核实" : ""}"),
        backgroundColor: r["ok"] == true ? Colors.green : Colors.orange, duration: const Duration(seconds: 6)));
    } catch (e) {
      if (!mounted) return;
      setState(() => _applying = false);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text("修正失败：$e"), backgroundColor: Colors.red));
    }
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
                    if (widget.task.invScope.isNotEmpty) Text("范围：${widget.task.invScope.join("/")}", style: const TextStyle(color: Color(0xFF0891B2), fontWeight: FontWeight.bold)),
                    if (widget.task.invPickMode == 1) () {
                      // ㉖v174b 点名盘摘要：按结束前最新账本拆"仍在架未扫到(真需复核)/期间已出库(正常)"
                      int r = 0, g = 0;
                      try { if (widget.task.invMissJson.isNotEmpty) { for (final m in (jsonDecode(widget.task.invMissJson) as List)) { if ((m as Map)['st'] == 'gone') { g++; } else { r++; } } } } catch (_) {}
                      return Text("点名盘 应扫 ${widget.task.invPickCodes.length}${widget.task.invMissJson.isEmpty ? "" : (r + g == 0 ? "/全部盘到" : "/未扫到${r + g}(真$r·出库$g)")}", style: TextStyle(color: r > 0 ? const Color(0xFFE65100) : const Color(0xFF0891B2), fontWeight: FontWeight.bold));
                    }(),
                    if (d.outsideScope.isNotEmpty) Text("范围外 ${d.outsideScope.length} 码", style: const TextStyle(color: Color(0xFF0891B2))),
                  ]),
                ),
              ),
              // ㉖v174 点名盘：未盘到清单（结束任务时已回写 invMissJson）——点名盘的核心产出
              // ㉖v174b 按结束前最新账本拆两类：st=miss 仍在架却没扫到（真需复核）/ st=gone 盘点期间
              //   已出库或已消账（AGV 拉架耗时长，期间被正常领走属正常流转，不算缺失、只告知）
              if (widget.task.invPickMode == 1) ...[
                () {
                  List<dynamic> miss = const [];
                  try { if (widget.task.invMissJson.isNotEmpty) miss = jsonDecode(widget.task.invMissJson) as List; } catch (_) {}
                  final agvBad = miss.where((m) => (m as Map)['st'] == 'agvDiff').toList(); // ㉖v174c AGV 通道核对不符（须人工处理）
                  final real = miss.where((m) { final s = (m as Map)['st']; return s != 'gone' && s != 'agvDiff'; }).toList();
                  final gone = miss.where((m) => (m as Map)['st'] == 'gone').toList();
                  final allGot = miss.isEmpty;
                  final row = (dynamic m, {bool dim = false}) {
                    final mm = m as Map;
                    final rr = (mm['r'] ?? "").toString();
                    return Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text("▸ ${mm['c']}", style: TextStyle(fontFamily: "monospace", fontSize: 12.5, fontWeight: FontWeight.w600, color: dim ? Colors.grey : null, decoration: dim ? TextDecoration.lineThrough : null)),
                      const SizedBox(width: 8),
                      Expanded(child: Text("${mm['p']?.toString().isEmpty ?? true ? "零件未知" : mm['p']}${dim ? "（已出库/消账）" : "  @${mm['l']?.toString().isEmpty ?? true ? "账本无货位" : mm['l']}"}${rr.isNotEmpty ? "\n　　$rr" : ""}", style: TextStyle(fontSize: 12, color: dim ? Colors.grey : (mm['st'] == 'agvDiff' ? const Color(0xFFC62828) : Colors.black87)))),
                    ]));
                  };
                  return Card(
                    color: allGot ? const Color(0xFFE8F5E9) : agvBad.isNotEmpty ? const Color(0xFFFFEBEE) : real.isEmpty ? const Color(0xFFF1F8E9) : const Color(0xFFFFF3E0),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(allGot ? "点名盘点：应扫 ${widget.task.invPickCodes.length} 框，全部盘到 ✅"
                            : agvBad.isNotEmpty ? "点名盘：⚠ ${agvBad.length} 框 AGV 核对不符（红列，须人工处理后方可结案）${real.isNotEmpty ? "，另 ${real.length} 框仍在架未扫到" : ""}"
                            : real.isEmpty ? "点名盘点：应扫 ${widget.task.invPickCodes.length} 框，未扫到 ${gone.length} 框均为盘点期间正常出库/消账，无缺失 ✅"
                            : "点名盘：应扫 ${widget.task.invPickCodes.length} 框，${real.length} 框仍在架未扫到（需复核），另 ${gone.length} 框期间已出库（正常）",
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 14, color: agvBad.isNotEmpty ? const Color(0xFFC62828) : allGot || real.isEmpty ? Colors.green : const Color(0xFFE65100))),
                        if (agvBad.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text("AGV 通道核对不符（${agvBad.length} 框）：", style: const TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, color: Color(0xFFC62828))),
                          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 160), child: SingleChildScrollView(child: Column(children: agvBad.map((m) => row(m)).toList()))),
                        ],
                        if (real.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 220), child: SingleChildScrollView(child: Column(children: real.map((m) => row(m)).toList()))),
                          const SizedBox(height: 4),
                          const Text("处理：找到实物→用「位置登记」重扫归位；确不在架→到库存页消账；货架还没拉到台站→叫车拉架后补扫。", style: TextStyle(fontSize: 11.5, color: Colors.grey)),
                        ],
                        if (gone.isNotEmpty) ...[
                          const SizedBox(height: 6),
                          Text("盘点期间已出库/消账 $gone.length 框（正常流转，不计缺失）：", style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
                          ConstrainedBox(constraints: const BoxConstraints(maxHeight: 120), child: SingleChildScrollView(child: Column(children: gone.map((m) => row(m, dim: true)).toList()))),
                        ],
                      ]),
                    ),
                  );
                }(),
              ],
              const Padding(padding: EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text("零件号级差异", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
              if (diffParts.isEmpty) const Padding(padding: EdgeInsets.only(left: 8), child: Text("全部账实相符 🎉", style: TextStyle(color: Colors.green)))
              else ...diffParts.map((p) {
                final diff = p.realQty - p.bookQty;
                final loc = invPartLocate(p);
                return Card(
                  child: ListTile(
                    dense: true,
                    title: Text("${p.partNo}  ${p.itemName}", style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                    subtitle: Text("账面 ${_fmtInvNum(p.bookQty)} / 实盘 ${_fmtInvNum(p.realQty)}${p.liveBoxes >= 0 ? " / 最新账本在架 ${p.liveBoxes} 码${p.liveStn > 0 ? "+${p.liveStn} 压站台" : ""}" : ""}${p.outsideBoxes > 0 ? "（另账外扫入 ${p.outsideBoxes} 码 ${_fmtInvNum(p.outsideQty)}）" : ""}${p.warnFlag == 7 ? "\n⚠️双基准矛盾：货位台账合计≠账面，先核账" : ""}${loc.isNotEmpty ? "\n📍$loc" : ""}", style: const TextStyle(fontSize: 12)),
                    trailing: Text(diff > 1e-6 ? "盘盈 +${_fmtInvNum(diff)}" : diff < -1e-6 ? "盘亏 ${_fmtInvNum(diff)}" : (p.outsideBoxes > 0 ? "账外" : "—"), style: TextStyle(color: diff > 0 ? Colors.orange : diff < 0 ? Colors.red : Colors.grey, fontWeight: FontWeight.bold, fontSize: 13)),
                  ),
                );
              }),
              const Padding(padding: EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text("货位级差异（疑似串位已配对标注）", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
              if (diffLocs.isEmpty) const Padding(padding: EdgeInsets.only(left: 8), child: Text("货位级无差异", style: TextStyle(color: Colors.green)))
              else ...diffLocs.map((l) {
                final diff = l.realQty - l.bookQty;
                final loc = invLocLocate(l, mv['${l.locCode}|${l.partNo}']);
                return Card(
                  child: ListTile(
                    dense: true,
                    title: Text("${l.locCode}  ${l.partNo}", style: const TextStyle(fontSize: 13)),
                    subtitle: Text("台账 ${_fmtInvNum(l.bookQty)} / 实盘 ${_fmtInvNum(l.realQty)}${l.liveN >= 0 ? " / 账本现 ${l.liveN} 码" : ""}${l.labels.isNotEmpty ? "\n实扫：${l.labels.take(6).join("、")}${l.labels.length > 6 ? " 等${l.labels.length}码" : ""}" : ""}${loc.isNotEmpty ? "\n💡$loc" : ""}", style: const TextStyle(fontSize: 12)),
                    trailing: Text(diff > 0 ? "+${_fmtInvNum(diff)}" : _fmtInvNum(diff), style: TextStyle(color: diff > 0 ? Colors.orange : Colors.red, fontWeight: FontWeight.bold)),
                  ),
                );
              }),
              if (d.outsideScope.isNotEmpty) ...[
                const Padding(padding: EdgeInsets.fromLTRB(4, 14, 4, 6), child: Text("范围外清单（登记在未盘点货架，不计盘盈亏）", style: TextStyle(fontWeight: FontWeight.bold, fontSize: 15))),
                ...d.outsideScope.map((o) => Card(
                  child: ListTile(
                    dense: true,
                    leading: const Icon(Icons.help_outline, color: Color(0xFF0891B2), size: 20),
                    title: Text("${o.goodsCode}  →  ${o.partNo}", style: const TextStyle(fontSize: 13, fontFamily: "monospace")),
                    subtitle: Text("${o.scanTime.toString().substring(5, 16)}  @${o.locCode}  ${_fmtInvNum(o.qty)}  ${o.remark}", style: const TextStyle(fontSize: 11)),
                  ),
                )),
              ],
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
              if (Auth.can("location_reg")) ...[
                const SizedBox(height: 10),
                SizedBox(
                  width: double.infinity,
                  height: 48,
                  child: ElevatedButton.icon(
                    style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF2E7D32), foregroundColor: Colors.white, disabledBackgroundColor: Colors.grey.shade300),
                    onPressed: _applying ? null : _applyDiff,
                    icon: _applying
                        ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                        : const Icon(Icons.playlist_add_check),
                    label: Text(_applying ? "正在修正…" : "应用货位差异到账本（以实盘为准 · 同步各PDA）"),
                  ),
                ),
                const SizedBox(height: 4),
                const Padding(padding: EdgeInsets.fromLTRB(4, 0, 4, 0), child: Text("数量差异（盘盈/盘亏）请走 MES 调整流程，本按钮只改货位位置", style: TextStyle(fontSize: 11, color: Colors.grey))),
              ],
              const SizedBox(height: 10),
            ],
          );
        },
      ),
    );
  }
}

// ===== ㉖v123 货架AGV盘点（盲区随机抽盘）：发起会话→AGV取框到站台→扫码核对→归位原格 =====
// 独立于人工盘点任务模型：AGV 双腿搬运 + 服务器工单状态机，本页面只做看板与到台操作。
class ShelfCountPage extends StatefulWidget {
  const ShelfCountPage({super.key});
  @override
  State<ShelfCountPage> createState() => _ShelfCountPageState();
}

class _ShelfCountPageState extends State<ShelfCountPage> {
  List<Map> _list = [];
  int _cand = 0, _busy = 0, _conc = 3;
  bool _loading = false, _busyOp = false;
  Timer? _timer;
  String _err = "";

  @override
  void initState() {
    super.initState();
    _refresh();
    _timer = Timer.periodic(const Duration(seconds: 6), (_) => _refresh()); // 看板轮询（AGV 到台/归位由服务器推进）
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final r = await AuthApi.countList(all: true);
    if (!mounted) return;
    if (r["ok"] == true) {
      setState(() {
        _list = List<Map>.from((r["list"] as List?) ?? []);
        _cand = (r["cand"] as num?)?.toInt() ?? 0;
        _busy = (r["busy"] as num?)?.toInt() ?? 0;
        _conc = (r["conc"] as num?)?.toInt() ?? 3;
        _err = "";
      });
    } else setState(() => _err = (r["msg"] ?? "看板加载失败").toString());
  }

  Future<void> _start() async {
    final ok = await showDialog<bool>(context: context, builder: (c) => AlertDialog(
      title: const Text("发起盲区随机抽盘"),
      content: Text("从滞留≥7天、近期未被出入库验证的货架框中随机抽取。\n当前盲区候选框：$_cand 个\n会话上限与并发由服务器参数控制。\n\nAGV 会把框取到站台，你到台扫码核对后归位回原格。\n\n确认发起？"),
      actions: [TextButton(onPressed: () => Navigator.pop(c, false), child: const Text("取消")), ElevatedButton(onPressed: () => Navigator.pop(c, true), child: const Text("发起"))],
    ));
    if (ok != true) return;
    setState(() => _loading = true);
    final r = await AuthApi.countStart();
    setState(() => _loading = false);
    if (r["ok"] == true) { _snack("已发起：抽取 ${(r["picked"] as num?)?.toInt() ?? 0} 框（候选 ${r["total"]}）"); _refresh(); }
    else _snack((r["msg"] ?? "发起失败").toString(), err: true);
  }

  // 到台核对：红外扫码枪优先（扫到自动回车提交）→ 相机/手输兜底 → MES 反查件数 → 提交服务器比对
  static const _kCam = '__CAM__'; // 红外框空提交/点相机 = 走相机
  Future<void> _scan(Map q) async {
    final raw = await _scanInputBox(q);
    if (raw == null) return; // 取消
    var code = raw == _kCam ? null : raw;
    if (code == null) code = await cameraScanDialog(context, valid: (c) => labelFormatErr(c) == null) ?? await _inputCode();
    if (code == null || code.isEmpty) return;
    setState(() => _busyOp = true);
    int mesQty = -1;
    final mr = await mesQueryLabel(code);
    if (mr["ok"] == true) mesQty = (mr["qty"] as num?)?.toInt() ?? -1;
    final r = await AuthApi.countScan(q["id"].toString(), code, mesQty: mesQty);
    setState(() => _busyOp = false);
    if (r["ok"] == true) { _snack((r["msg"] ?? "已核对").toString(), err: r["match"] != true); _refresh(); }
    else _snack((r["msg"] ?? "核对失败").toString(), err: true);
  }

  // 红外扫码框：autofocus 接扫码枪 HID 输入，扫到自动回车提交（与主盘点页扫码同款）；相机/取消有出口
  Future<String?> _scanInputBox(Map q) {
    final ctl = TextEditingController();
    return showDialog<String>(context: context, builder: (c) => AlertDialog(
      title: Text("核对 ${q["code"]}"),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text("原格 ${q["from"]} · 账面 ${q["qty"]}件${(q["station"] ?? "").toString().isNotEmpty ? " · 已到 ${q["station"]}" : ""}\n\n请用红外扫描枪对准框上标签扫码（扫到自动提交）；红外无反应可点「相机」。", style: const TextStyle(fontSize: 12.5)),
        const SizedBox(height: 8),
        TextField(controller: ctl, autofocus: true, keyboardType: TextInputType.text, textInputAction: TextInputAction.done,
          decoration: const InputDecoration(hintText: "N 开头 10 位 / 红外扫码", border: OutlineInputBorder()),
          onSubmitted: (v) => Navigator.pop(c, v.trim().isEmpty ? _kCam : v.trim())),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c), child: const Text("取消")),
        TextButton(onPressed: () => Navigator.pop(c, _kCam), child: const Text("📷相机")),
        FilledButton(onPressed: () => Navigator.pop(c, ctl.text.trim().isEmpty ? _kCam : ctl.text.trim()), child: const Text("提交")),
      ],
    ));
  }

  // 工单时间线：合并工单自带时间戳（发起/到台/核对/归位/闭环）+ 两腿 AGV 调度 trace，只读展示
  void _showTimeline(Map q) {
    final lt = (q["legTrace"] as Map?) ?? const {};
    final outT = (lt["out"] as List?) ?? const [];
    final backT = (lt["back"] as List?) ?? const [];
    final diff = (q["diff"] as Map?) ?? const {};
    final st = q["state"]?.toString() ?? "";
    String tn(dynamic v) { final n = v is num ? v.toInt() : 0; if (n <= 0) return ""; final d = DateTime.fromMillisecondsSinceEpoch(n); final p = (int x) => x.toString().padLeft(2, "0"); return "${d.month}/${d.day} ${p(d.hour)}:${p(d.minute)}:${p(d.second)}"; }
    final N = <List<Object?>>[]; // [标题, 时间文本, 说明, Color?]
    void add(String t, dynamic ms, {String sub = "", Color? col}) => N.add([t, tn(ms), sub, col]);
    final _pb = (q["pickBatch"] ?? "").toString();
    add(_pb.isNotEmpty ? "📋 点名盘发起AGV搬运" : "📋 发起盲区抽盘", q["at"], sub: (_pb.isNotEmpty ? "点名批次 $_pb · " : "") + "${q["by"] ?? ""} · 原格 ${q["from"]} · 账面 ${q["qty"]}件 · 滞留${q["ageDays"]}天", col: const Color(0xFF3949AB));
    for (final e in outT) add("🚚 下架调度", null, sub: e.toString());
    if (tn(q["arriveAt"]).isNotEmpty) add("🏁 框已到站台 ${q["station"] ?? ""}", q["arriveAt"], col: const Color(0xFF00897B));
    else if (st == "toStation" || st == "pending") add("⏳ 取货在途 / 待发车（尚未到台）", null, sub: "AGV 正把框取往站台");
    if (tn(q["scanAt"]).isNotEmpty) {
      final wrong = diff["kind"] == "wrongBox";
      add(wrong ? "⚠ 核对不符：站台框非本单框" : "🔎 扫码核对", q["scanAt"],
        sub: wrong ? "期望 ${diff["expect"]} · 实扫 ${diff["scanned"]}${(diff["scannedLoc"] ?? "").toString().isNotEmpty ? "（账本在 ${diff["scannedLoc"]}）" : ""}"
            : diff["kind"] == "qty" ? "标签相符，数量不符：账 ${diff["expect"]} / 实 ${diff["actual"]}"
            : "标签相符、数量核对通过",
        col: (wrong || diff["kind"] == "qty") ? const Color(0xFFC62828) : const Color(0xFF2E7D32));
    }
    if (st == "mismatch") add("⚠ 不符·待人工处置", null, sub: "确认实物位置后点「取消」结束本单", col: const Color(0xFFC62828));
    for (final e in backT) add("🔙 归位调度", null, sub: e.toString());
    if (tn(q["retAt"]).isNotEmpty) add("📤 归位任务发车", q["retAt"], sub: "回原格 ${q["from"]}（钉死原格，不 AUTO 改派）", col: const Color(0xFFE65100));
    if (st == "done") add("✅ 归位到位·闭环", q["doneAt"], sub: "框已回到 ${q["from"]}", col: const Color(0xFF2E7D32));
    else if (st == "canceled") add("🚫 已取消", q["doneAt"], sub: (q["err"] ?? "人工取消").toString(), col: const Color(0xFF455A64));
    else if (st == "stuck") add("⏰ 超时·请核查", null, sub: (q["err"] ?? "超时").toString(), col: const Color(0xFF6A1B9A));
    showDialog(context: context, builder: (c) => AlertDialog(
      title: Text("📜 盘点工单时间线  ${q["code"]}"),
      content: SizedBox(width: double.maxFinite, child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final x in N) Padding(padding: const EdgeInsets.symmetric(vertical: 5), child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Container(width: 3, height: 30, margin: const EdgeInsets.only(right: 9), color: (x[3] as Color?) ?? const Color(0xFFB0BEC5)),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(x[0] as String, style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: (x[3] as Color?) ?? const Color(0xFF37474F))),
            if ((x[1] as String).isNotEmpty || (x[2] as String).isNotEmpty)
              Text([x[1] as String, x[2] as String].where((e) => e.isNotEmpty).join(" · "), style: const TextStyle(fontSize: 11.5, color: Colors.grey)),
          ])),
        ])),
        const Divider(height: 18),
        const Text("节点时间取工单时间戳；调度行为下架/归位两腿 AGV 队列留痕。核对为只读验证，不改账本；差异请走「修正 / 返架」。", style: TextStyle(fontSize: 11, color: Colors.grey)),
      ]))),
      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text("关闭"))],
    ));
  }

  Future<void> _doReturn(Map q) async {
    setState(() => _busyOp = true);
    final r = await AuthApi.countReturn(q["id"].toString());
    setState(() => _busyOp = false);
    if (r["ok"] == true) { _snack("归位任务已下发，回 ${q["from"]}"); _refresh(); }
    else _snack((r["msg"] ?? "归位失败").toString(), err: true);
  }

  /// ㉖v141 人工拉取发车：点「🚚 发车」才下发该框下架腿（AGV 取框上站台）；默认模式下系统不自动预下架
  Future<void> _deploy(Map q) async {
    setState(() => _busyOp = true);
    final r = await AuthApi.countDeploy(id: q["id"].toString());
    setState(() => _busyOp = false);
    if (r["ok"] == true) { _snack("🚚 ${q["code"]} 下架腿已下发，AGV 取框中", err: false); _refresh(); }
    else _snack((r["msg"] ?? "发车失败").toString(), err: true);
  }

  Future<void> _doCancel(Map q) async {
    final why = await _inputCode(title: "取消原因（选填）", hint: "如：急需发料先解冻");
    setState(() => _busyOp = true);
    final r = await AuthApi.countCancel(q["id"].toString(), why ?? "");
    setState(() => _busyOp = false);
    if (r["ok"] == true) { _snack("已取消，该框解冻"); _refresh(); }
    else _snack((r["msg"] ?? "取消失败").toString(), err: true);
  }

  Future<String?> _inputCode({String title = "输入标签码", String hint = "N 开头 10 位"}) async {
    final ctl = TextEditingController();
    return showDialog<String>(context: context, builder: (c) => AlertDialog(
      title: Text(title),
      content: TextField(controller: ctl, autofocus: true, keyboardType: TextInputType.text, decoration: InputDecoration(hintText: hint)),
      actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text("取消")), ElevatedButton(onPressed: () => Navigator.pop(c, ctl.text.trim()), child: const Text("确定"))],
    ));
  }

  void _snack(String m, {bool err = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.deepOrange : const Color(0xFF43A047)));
  }

  static const _stColor = {"pending": Colors.grey, "toStation": Color(0xFF1E88E5), "atStation": Color(0xFFFB8C00), "scanned": Color(0xFF43A047), "returning": Color(0xFF00897B), "done": Colors.green, "mismatch": Colors.red, "taskGone": Colors.red, "canceled": Colors.blueGrey, "stuck": Colors.purple};
  static const _stText = {"pending": "待发车", "toStation": "取货在途", "atStation": "到台待扫", "scanned": "已核对·待归位", "returning": "归位在途", "done": "完成", "mismatch": "不符·待处置", "taskGone": "任务消失", "canceled": "已取消", "stuck": "超时·请核查"};

  @override
  Widget build(BuildContext context) {
    final active = _list.where((q) => !["done", "canceled"].contains(q["state"])).toList();
    final closed = _list.where((q) => ["done", "canceled"].contains(q["state"])).toList();
    return Scaffold(
      appBar: AppBar(title: const Text("货架AGV盘点 · 盲区抽盘"), backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white,
        actions: [IconButton(onPressed: _refresh, icon: const Icon(Icons.refresh))]),
      body: Column(children: [
        Container(padding: const EdgeInsets.fromLTRB(12, 10, 12, 10), color: const Color(0xFFF3F4FB),
          child: Row(children: [
            Expanded(child: Text("盲区候选 $_cand 框 · 双腿在途 $_busy/$_conc", style: const TextStyle(fontSize: 13, color: Color(0xFF3949AB)))),
            ElevatedButton.icon(onPressed: _loading ? null : _start, icon: _loading ? const SizedBox(width: 15, height: 15, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.play_arrow), label: const Text("发起抽盘"), style: ElevatedButton.styleFrom(backgroundColor: const Color(0xFF515BD4), foregroundColor: Colors.white)),
          ])),
        if (_err.isNotEmpty) Padding(padding: const EdgeInsets.all(8), child: Text(_err, style: const TextStyle(color: Colors.red, fontSize: 12))),
        Expanded(child: active.isEmpty && closed.isEmpty
            ? const Center(child: Text("暂无盘点工单\n点右上「发起抽盘」从盲区框随机抽取", textAlign: TextAlign.center, style: TextStyle(fontSize: 13, color: Colors.grey)))
            : RefreshIndicator(onRefresh: _refresh, child: ListView(padding: const EdgeInsets.all(10), children: [
                if (active.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(2, 2, 2, 6), child: Text("进行中 ${active.length}", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13))),
                ...active.map(_card),
                if (closed.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(2, 12, 2, 6), child: Text("已结束 ${closed.length}", style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13, color: Colors.grey))),
                ...closed.map(_card),
              ]))),
      ]),
    );
  }

  Widget _card(Map q) {
    final st = q["state"]?.toString() ?? "";
    final col = _stColor[st] ?? Colors.grey;
    final canScan = st == "atStation" || st == "stuck"; // 到台/超时待扫=可核对
    final canRet = st == "scanned"; // 已核对=可归位
    return Card(margin: const EdgeInsets.symmetric(vertical: 5), child: ListTile(
      isThreeLine: true,
      onTap: () => _showTimeline(q), // 整卡点击=看时间线（右下图标提示）
      leading: CircleAvatar(radius: 15, backgroundColor: col.withOpacity(0.15), child: Text(_stText[st]?.substring(0, 1) ?? "?", style: TextStyle(color: col, fontSize: 12))),
      title: Row(children: [
        Flexible(child: Text("${q["code"]} · ${q["part"]}", style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600))),
        const Spacer(),
        const Icon(Icons.timeline, size: 17, color: Color(0xFF515BD4)),
      ]),
      subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text("原格 ${q["from"]}${q["station"] != null && q["station"].toString().isNotEmpty ? " → ${q["station"]}" : ""} · 账面 ${q["qty"]}件 · 滞留${q["ageDays"]}天", style: const TextStyle(fontSize: 12)),
        Row(children: [
          Text(_stText[st] ?? st, style: TextStyle(fontSize: 12, color: col, fontWeight: FontWeight.w600)),
          // ㉖v141 人工拉取发车：待发车工单点「🚚 发车」才下发下架腿（默认模式下系统不自动预下架）
          if (st == "pending" && ((q["outQueued"] as num?)?.toInt() ?? 0) == 0) ...[const SizedBox(width: 8), TextButton(onPressed: _busyOp ? null : () => _deploy(q), style: TextButton.styleFrom(foregroundColor: const Color(0xFF00897B)), child: const Text("🚚 发车"))],
          if (canScan) ...[const SizedBox(width: 8), TextButton(onPressed: _busyOp ? null : () => _scan(q), child: const Text("扫码核对"))],
          if (canRet) ...[const SizedBox(width: 8), TextButton(onPressed: _busyOp ? null : () => _doReturn(q), child: const Text("归位"))],
          if (["pending", "toStation", "atStation", "scanned", "mismatch", "taskGone", "stuck"].contains(st)) ...[const SizedBox(width: 8), TextButton(onPressed: _busyOp ? null : () => _doCancel(q), style: TextButton.styleFrom(foregroundColor: Colors.red), child: const Text("取消"))],
        ]),
      ]),
    ));
  }
}
