// ㉖v217 地面排取货路线（纯计算模块，独立库文件——非 part of main.dart，可 dart run 脱 App 单测）
// 背景（用户实拍 + 近14天 185 张单动线重放实锤）：一张领料单多零件、多框、散在多个地面排时，
//   仓管按零件行原序发料 → 同一排离开又折回（回头路），实测均值 0.48 次/单、极端单一趟折返 7 次。
//   原以为"单内按当前建议排重排零件行"可解，实测只降到 0.32——因为行级重排救不了
//   ①"同一零件行的框跨两排"和②"未发行的框排会变"：行的代表排本身就散，硬凑顺序省不了。
// 本模块定位：**以排为主键**重排取货动线（走到一排把该排该发的一次扫完再挪排），
//   不改任何扫码/MES/FIFO 逻辑——产出的每框都带 partNo，供界面"自动切发料目标行"后复用原 _scanIssue()。
// 口径与红线：
//   · 只纳二楼地面 NB03（NB02 货架框走 AGV 不走路，自动剔；NB04 一楼来料区另层，不在本动线）；
//   · 已扫(issued)/已叫车(agv 非空，框在途往站台送、去台取非去排) 的框剔除；
//   · 排间顺序：区字母升序→排号数字升序（现场走一遍若物理邻接不同，界面留手动重排口，不猜）；
//   · 排内顺序：位号升序（顺排走）；
//   · 同排多零件并列展示，每框标所属零件行 → 点击扫码自动记到正确行。
library pick_route;

class PickItem {
  final String code; // 标签号
  final String partNo; // 所属零件行
  final String itemName;
  final double qty; // 该框件数（建议值）
  final int slot; // 排内位号（NB03-区-排-位 的第4段，无=0）
  final bool called; // 已叫车（正常不纳，字段留全）
  PickItem(this.code, this.partNo, this.itemName, this.qty, this.slot, this.called);
}

class PickRow {
  final String zone; // 区字母 A/B/C…
  final int row; // 排号 11/12…
  final String key; // "A-11"
  final List<PickItem> items; // 按位号升序
  PickRow(this.zone, this.row, this.key, this.items);
  int get boxCount => items.length;
  double get qtySum => items.fold<double>(0, (s, x) => s + x.qty);
  List<String> get parts => items.map((x) => x.partNo).toSet().toList();
}

class PickRoute {
  final List<PickRow> rows; // 排间有序
  final int skippedAgv; // 剔除的货架/在途框数（透明，防"框少了"困惑）
  PickRoute(this.rows, this.skippedAgv);
  int get totalBoxes => rows.fold<int>(0, (s, r) => s + r.boxCount);
  bool get isEmpty => rows.isEmpty;
}

/// 解析地面货位 → (区,排,位)；非 NB03 地面返 null
_Loc? parseGround(String loc) {
  final m = RegExp(r'^NB03-([A-Z])-(\d+)(?:-(\d+))?').firstMatch(loc.toUpperCase().trim());
  if (m == null) return null;
  return _Loc(m.group(1)!, int.parse(m.group(2)!), int.tryParse(m.group(3) ?? '') ?? 0);
}

class _Loc {
  final String zone;
  final int row;
  final int slot;
  _Loc(this.zone, this.row, this.slot);
}

/// 从领料单 items（每行含 suggest）提取地面排取货路线。
/// items 结构对齐服务器 reqView：it.partNo / it.itemName / it.issued /
///   it.suggest.{flatBoxes|boxes}[].{c,l,q,agv}。缺字段容错。
PickRoute buildPickRoute(List items) {
  final grouped = <String, PickRow>{};
  final rowItems = <String, List<PickItem>>{};
  final seen = <String>{}; // 全局按标签去重（一框只列一次）
  var skipped = 0;
  for (final raw in items) {
    if (raw is! Map) continue;
    final partNo = raw['partNo']?.toString() ?? '';
    final itemName = raw['itemName']?.toString() ?? '';
    if (partNo.isEmpty) continue;
    // 已扫标签集（兼容旧纯字符串与新 {c,q} 结构）
    final issued = <String>{};
    for (final e in (raw['issued'] as List? ?? const [])) {
      final c = (e is Map ? (e['c']?.toString() ?? '') : e.toString()).toUpperCase().trim();
      if (c.isNotEmpty) issued.add(c);
    }
    final sg = raw['suggest'];
    if (sg is! Map) continue;
    final boxes = (sg['flatBoxes'] as List?) ?? (sg['boxes'] as List?);
    if (boxes == null) continue;
    for (final b in boxes) {
      if (b is! Map) continue;
      final code = (b['c']?.toString() ?? '').toUpperCase().trim();
      if (code.isEmpty || seen.contains(code) || issued.contains(code)) continue;
      final agv = (b['agv']?.toString() ?? '').trim();
      final loc = b['l']?.toString() ?? '';
      final gz = parseGround(loc);
      if (gz == null) {
        // NB02 货架/台挂/来料区等——不走路，计入剔除（货架框走 AGV）
        if (loc.toUpperCase().startsWith('NB02') || agv.isNotEmpty) skipped++;
        continue;
      }
      if (agv.isNotEmpty) {
        skipped++; // 已叫车的地面框在途往站台送，去台取非去排
        continue;
      }
      seen.add(code);
      final key = '${gz.zone}-${gz.row}';
      (rowItems[key] ??= []).add(PickItem(code, partNo, itemName, (b['q'] as num?)?.toDouble() ?? 0, gz.slot, false));
    }
  }
  final keys = rowItems.keys.toList()
    ..sort((a, b) {
      final za = parseGround('NB03-$a')!, zb = parseGround('NB03-$b')!; // 键即 A-11，可逆解析
      if (za.zone != zb.zone) return za.zone.compareTo(zb.zone);
      return za.row - zb.row;
    });
  final rows = keys.map((k) {
    final list = (rowItems[k]!)..sort((x, y) => x.slot != y.slot ? x.slot - y.slot : x.partNo.compareTo(y.partNo));
    final za = parseGround('NB03-$k')!;
    return PickRow(za.zone, za.row, k, list);
  }).toList();
  grouped.addAll({for (final r in rows) r.key: r});
  return PickRoute(rows, skipped);
}
