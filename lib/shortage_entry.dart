part of 'main.dart';

// ===================== ㉖v177 缺料入口（跨模块联动·一期） =====================
// 目标：把缺料反馈从"独立页的一次性外发"变成贯穿领料全程的信号——
//   ①建单搜不到零件号 ②库存页搜不到/零库存 ③零件档案页 ④产线模板缺料行 → 统一走本模块。
// 一期边界（用户拍板"分两期：先入口，再闭环"）：服务端零改动、不落任何台账；
//   只做「自动带真实缺口数 + 复用既有分享管线」。闭环（缺料实体/核销/热度）二期再做。
// 缺口数口径（用户选定能力①）：在架框/件=服务器货位账本（全厂口径，与缺料页同源，
//   框键 pid|l|c 归并同缺料页 :118）；在途需求=活跃领料单(pending/accepted/ready)未发件数；
//   建议补框=ceil(缺口/每框均值)，均值优先现架均值、零在架用字典历史均值，均无则保守 1 框并标注。
// 文案：与 ShortageReportPage._feedText 同字段同默认值（读同一组 SharedPreferences 键 sr_*），
//   两端产物格式一致，微信群里不会看到两种"豪斯特缺料单"。
// 诚实边界：拉数失败绝不弹"0 框"假数据——降级为询问用户是否裸文案发送。

/// 末次领料可回溯窗口（天）：由服务端 /api/req/last 下发实际归档窗口（reqArchDays，默认 365），
/// 文案里"近 N 天内无人领过"必须用这个真实值，不能端上硬编一个数字糊弄现场。
int _shortLastWindow = 365;

/// 单零件缺口快照（全厂口径，服务端权威数据现算，非本机 Isar 快照）
class _ShortGap {
  final String pn, nm;
  final int boxes; // 全厂在架框数
  final double qty; // 全厂在架件数
  final double perBox; // 每框均值（0=无从知晓）
  final double demand; // 在途领料需求未发件数
  final int demandDocs; // 在途需求单数
  final bool backed; // 系统是否"认识"此号（字典/全集背书）
  final bool noData; // ㉖v177 降级模式：服务器数据没拉到，展示与文案都不得写"0 框"假数
  // ㉖v179 末次领料（全厂口径，服务端 /api/req/last 算；null=窗口内无记录，≠从未领过）
  int lastT = 0;
  double lastQty = 0;
  String lastBy = "", lastNo = "";
  _ShortGap(this.pn, this.nm, this.boxes, this.qty, this.perBox, this.demand,
      this.demandDocs, this.backed, {this.noData = false});

  /// 末次领料三态（严格区分，不许谎报）：
  ///  lastT>0 有记录 · lastT==0 服务端查过确实无记录 · lastT<0 未知（服务未重启/降级），整行不显示
  bool get hasLast => lastT > 0;
  String get lastTxt {
    if (noData || lastT < 0) return ""; // 未知≠无记录：绝不把"服务未重启"写成"近一年无人领过"
    if (lastT == 0) return "上次领用：近$_shortLastWindow 天内无人领过";
    final d = DateTime.fromMillisecondsSinceEpoch(lastT);
    return "上次领用：${d.month.toString().padLeft(2, "0")}-${d.day.toString().padLeft(2, "0")} "
        "${_fmtInvNum(lastQty)} 件（$lastBy${lastNo.isNotEmpty ? " $lastNo" : ""}）";
  }

  /// 距上次领用天数；-1=不显示（未知或窗口内无记录）
  int get lastDaysAgo => lastT <= 0 ? -1 : DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(lastT)).inDays;

  // ★ 缺口=未满足的在途需求（11-14 修：旧版零在架分支把 demand 塞进 gapQty，
  //   致"零在架+零需求"落进"属催办"分支、对 0 库存显示"缺口已被在架覆盖"=假话）
  double get gapQty => demand - qty > 0 ? demand - qty : 0;
  /// "建议补"行四分支（写人话，杜绝"零在架却称已覆盖"类自相矛盾）：
  ///  有缺口 → 折框/不折框；无缺口但有在架有需求 → 催发料；无缺口无需求 → 整行不出现（沉默胜过错说）
  String get suggestTxt {
    if (noData) return "发送时缺口数据不可用，仅基础字段";
    final g = gapQty;
    if (g > 0) {
      final s = suggestBoxes;
      return s > 0
          ? "缺 ${_fmtInvNum(g)} 件 · 建议补 ≥$s 框（均值 ${_fmtInvNum(perBox)} 件/框）"
          : "缺 ${_fmtInvNum(g)} 件（当前无每框均值，不折框数以免误导）";
    }
    if (boxes > 0 && demand > 0) return "在架够本次需求，不缺货——请催仓管发料";
    return ""; // 无缺口且无在途需求：不写判断句（旧版此处"缺口已被在架覆盖，属催办"歧义太大）
  }

  String get stockTxt => noData
      ? "缺口数据未核算（服务器暂不可用）"
      : boxes > 0
          ? "全厂在架 ${_fmtInvNum(boxes.toDouble())} 框 · ${_fmtInvNum(qty)} 件"
          : "全厂零在架${backed ? "" : "（系统档案查无此号，可能新项目/新零件）"}";
  String get demandTxt => noData ? "" : (demand > 0 ? "｜在途需求 ${_fmtInvNum(demand)} 件（$demandDocs 单在等）" : "");
  // ★ 只在"知道每框均值"时折框数。字典对零在架零件不下发 perBoxQty（server.js:5292 只在有在架时算），
  //   而零在架恰恰最常反馈——此时折框必错（缺口 5000 件也说"建议 1 框"），宁可不给框数只报件数。
  int get suggestBoxes => (gapQty > 0 && perBox > 0) ? (gapQty / perBox).ceil().clamp(1, 999).toInt() : 0;
}

/// 拉全厂缺口快照；整体失败返回 null（调用方必须降级，不得当 0 处理）
Future<Map<String, _ShortGap>?> shortGapLoad(List<String> pns) async {
  final want = pns.map((s) => s.trim().toUpperCase()).where((s) => s.isNotEmpty).toSet();
  if (want.isEmpty) return {};
  try {
    // 1) 字典：名称 + 历史均值 + 认识与否（一次请求）
    Map<String, String> nm = {};
    final histPer = <String, double>{};
    bool dictOk = false;
    try {
      final dj = await AuthApi._req("GET", "/api/dict", token: await AuthStore.token());
      if (dj["ok"] == true) {
        dictOk = true;
        for (final x in List<Map>.from(dj["list"] ?? [])) {
          final p = (x["pn"] ?? "").toString().toUpperCase();
          if (!want.contains(p)) continue;
          nm[p] = (x["nm"] ?? "").toString();
          final pb = (x["perBoxQty"] as num?)?.toDouble() ?? 0;
          if (pb > 0) histPer[p] = pb;
        }
      }
    } catch (_) {}
    // 2) 全厂账本：在架框/件（响应键=items；框键 pid优先→loc|pn→code，与缺料页 :114-120 同源）
    final led = await AuthApi.ledgerGet();
    if (led["ok"] != true) return null;
    final gBox = <String, Set<String>>{}, gQty = <String, double>{};
    for (final r in List<Map>.from(led["items"] ?? [])) {
      final p = (r["p"] ?? "").toString().trim().toUpperCase();
      if (!want.contains(p)) continue;
      final pid = (r["pid"] ?? "").toString().toUpperCase();
      final loc = (r["l"] ?? "").toString().toUpperCase();
      final code = (r["c"] ?? "").toString().toUpperCase();
      (gBox[p] ??= <String>{}).add(pid.isNotEmpty ? "P|$pid" : (loc.isNotEmpty ? "L|$loc|$p" : "C|$code"));
      gQty[p] = (gQty[p] ?? 0) + ((r["q"] as num?)?.toDouble() ?? 0);
    }
    // 3) 末次领料 + 全厂在途需求（㉖v179 一次请求，服务端全厂口径）
    // ★ 不能在端上算需求：reqList 对物料员只返回本人单，同事在等的单看不见 → "在途需求"系统性偏少。
    //   服务端未重启时 /api/req/last 会 404 → 回退旧的本人口径（偏少但好过显示 0），并记 downgraded 供文案标注。
    final dem = <String, double>{}, demDoc = <String, int>{};
    Map lastMap = {};
    bool lastSrvOk = false; // true=拿到全厂口径（末次领料与需求都可信）
    try {
      final lj = await AuthApi.reqLast(want.join(','));
      if (lj["ok"] == true) {
        lastSrvOk = true;
        if (lj["map"] is Map) lastMap = lj["map"] as Map;
        _shortLastWindow = (lj["windowDays"] as num?)?.toInt() ?? _shortLastWindow;
        if (lj["demand"] is Map) {
          for (final e in (lj["demand"] as Map).entries) {
            final p = e.key.toString(), v = e.value;
            if (v is Map) {
              dem[p] = (v["qty"] as num?)?.toDouble() ?? 0;
              demDoc[p] = (v["docs"] as num?)?.toInt() ?? 0;
            }
          }
        }
      }
    } catch (_) {}
    if (!lastSrvOk) {
      // 回退：本人可见单的在途需求（旧口径，服务未重启时用）
      final reqJ = await AuthApi.reqList();
      if (reqJ["ok"] == true) {
        const active = {"pending", "accepted", "ready"};
        for (final r in List<Map>.from(reqJ["reqs"] ?? [])) {
          if (!active.contains(r["status"])) continue;
          for (final it in List<Map>.from(r["items"] ?? [])) {
            final p = (it["partNo"] ?? "").toString().toUpperCase();
            if (!want.contains(p)) continue;
            final issued = List.from(it["issued"] ?? []).fold<double>(0, (s, e) => s + (((e is Map ? e["q"] : 0) as num?)?.toDouble() ?? 0));
            final left = ((it["qty"] as num?)?.toDouble() ?? 0) - issued;
            if (left > 0) {
              dem[p] = (dem[p] ?? 0) + left;
              demDoc[p] = (demDoc[p] ?? 0) + 1;
            }
          }
        }
      }
    }
    // 4) 背书：字典命中即认识；字典没拉到才问全集（省一次请求）
    Set<String>? backing;
    if (!dictOk) {
      try {
        final bj = await AuthApi.partsBacking();
        backing = Set.from(List<Map>.from(bj["list"] ?? []).map((x) => (x["pn"] ?? "").toString().toUpperCase()));
      } catch (_) {}
    }
    final out = <String, _ShortGap>{};
    for (final p in want) {
      final boxes = gBox[p]?.length ?? 0;
      final qty = gQty[p] ?? 0;
      final g = _ShortGap(p, nm[p] ?? "", boxes, qty,
          boxes > 0 && qty > 0 ? qty / boxes : (histPer[p] ?? 0),
          dem[p] ?? 0, demDoc[p] ?? 0,
          dictOk ? nm.containsKey(p) : (backing?.contains(p) ?? false));
      if (lastSrvOk && lastMap[p] is Map) {
        final m = lastMap[p] as Map; // 仅在服务端确认"查过且无记录"时才留空（回退态不填，避免误显示"无记录"）
        g.lastT = (m["t"] as num?)?.toInt() ?? 0;
        g.lastQty = (m["qty"] as num?)?.toDouble() ?? 0;
        g.lastBy = (m["by"] ?? "").toString();
        g.lastNo = (m["no"] ?? "").toString();
      } else if (!lastSrvOk) {
        g.lastT = -1; // 回退态：末次领料未知（不显示该行，也不谎报"无记录"）
      }
      out[p] = g;
    }
    return out;
  } catch (_) {
    return null;
  }
}

/// 字典片段查询（入口①②"搜不到"时用）：一次 /api/dict 拿到匹配零件 + 在架框数。
/// 用途=分清两种"搜不到"：档案里有号但 boxes=0（真缺货，该反馈）／档案里根本没有（新项目或输错）。
/// 注意本列表按名称/号片段模糊匹配，boxes 为服务器实时在架框数（非本机快照）。
Future<List<Map<String, dynamic>>> shortDictFind(String kw, {int limit = 8}) async {
  final k = kw.trim().toLowerCase();
  if (k.length < 3) return const [];
  try {
    final dj = await AuthApi._req("GET", "/api/dict", token: await AuthStore.token());
    if (dj["ok"] != true) return const [];
    final hit = <Map<String, dynamic>>[];
    for (final x in List<Map>.from(dj["list"] ?? [])) {
      final pn = (x["pn"] ?? "").toString();
      final nm = (x["nm"] ?? "").toString();
      if (!pn.toLowerCase().contains(k) && !nm.toLowerCase().contains(k)) continue;
      hit.add({"pn": pn, "nm": nm, "boxes": (x["boxes"] as num?)?.toInt() ?? 0, "per": (x["perBoxQty"] as num?)?.toDouble() ?? 0});
      if (hit.length >= 200) break; // 先收全再排序，防超大字典整表外溢
    }
    hit.sort((a, b) => (a["boxes"] as int) - (b["boxes"] as int)); // 零在架排前（反馈最可能用到）
    return hit.take(limit).toList();
  } catch (_) {
    return const [];
  }
}

/// 生成缺料文案：字段与默认值同 ShortageReportPage._feedText（键同源 sr_*）
Future<String> shortFeedText(List<_ShortGap> rows, String desc) async {
  final sp = await SharedPreferences.getInstance();
  final unit = sp.getString("sr_feedback_unit") ?? "鄞州豪斯特生产部";
  final duty = sp.getString("sr_duty_unit") ?? "鄞州豪斯特运营部";
  final conf = sp.getString("sr_confirmer") ?? "宋明明";
  final at = (sp.getString("sr_at_names") ?? "Eleven、星光熠熠、雪哥儿")
      .split(RegExp(r"[、,，;；\s]+")).where((s) => s.trim().isNotEmpty).map((s) => "@${s.trim()}").join(" ");
  // ㉖v179 分享模板自定义：末次领用（日期+数量）是否随文案发出，默认显示（可在缺料页设置里关掉）
  final showLast = sp.getBool("sr_show_last") ?? true;
  final now = DateTime.now();
  final day = "${now.year}-${now.month.toString().padLeft(2, "0")}-${now.day.toString().padLeft(2, "0")}";
  return rows.map((g) => [
        "【缺料反馈】",
        "反馈日期：$day",
        "零件号：${g.pn}", // ㉖v180 改称零件号：本字段=partNo，项目里"物料号"专指 MES MITEM_CODE（见物料号补录），不可混用
        "物料名称：${g.nm.isEmpty ? "（档案无名称）" : g.nm}",
        g.stockTxt,
        if (g.demand > 0) "在途领料需求：${_fmtInvNum(g.demand)} 件（${g.demandDocs} 单在等）",
        // ㉖v180b 四分支：有缺口→折框/报件数；在架够需求→催发料；无缺口无需求→整行不出现
        //（旧版此处恒输出，零在架+零需求时会显示"缺口已被在架覆盖"=对 0 库存说货够了）
        if (g.suggestTxt.isNotEmpty) g.suggestTxt,
        // ㉖v179 末次领用（自定义开关 sr_show_last）：空串=未知态或服务未重启，整行不出现
        if (showLast && g.lastTxt.isNotEmpty) g.lastTxt,
        "异常描述：$desc",
        "反馈单位：$unit",
        "反馈人：${Auth.user?.name ?? ''}",
        "责任单位：$duty",
        "确认人：$conf",
        "确认日期：$day",
        at,
      ].join("\n")).join("\n\n");
}

const _shortShareCh = MethodChannel("app.installer");

/// 「搜不到」提示卡（入口①建单 / ②库存页共用）：区分三种情形，各给对应出口。
/// A) 档案有号且服务器零在架 → 真缺货：逐行反馈 / 一键反馈全部
/// B) 档案有号且服务器有货   → 本机快照滞后：提示同步后重试（绝不误报缺料）
/// C) 档案查无此号           → 新项目或输错：仍可反馈（文案标注档案无此号）
class ShortNotFoundCard extends StatefulWidget {
  final String keyword;
  final String extraHint;
  const ShortNotFoundCard({super.key, required this.keyword, this.extraHint = ""});
  @override
  State<ShortNotFoundCard> createState() => _ShortNotFoundCardState();
}

class _ShortNotFoundCardState extends State<ShortNotFoundCard> {
  bool _load = true;
  List<Map<String, dynamic>> _hits = const [];
  Map<String, Map> _prog = const {}; // ㉖v178 零件号→未处理反馈（回显"已反馈·谁在跟进"）

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run());
  }

  Future<void> _run() async {
    final h = await shortDictFind(widget.keyword);
    Map<String, Map> prog = {};
    try { // ㉖v178 顺带拉进度：已反馈过的直接显示状态，避免"我反馈了吗"反复重提
      final j = await AuthApi.shortList();
      if (j["ok"] == true) {
        for (final s in List<Map>.from(j["list"] ?? [])) {
          prog[(s["pn"] ?? "").toString().toUpperCase()] = s;
        }
      }
    } catch (_) {}
    if (mounted) setState(() { _hits = h; _prog = prog; _load = false; });
  }

  @override
  Widget build(BuildContext context) {
    final zero = _hits.where((x) => (x["boxes"] as int) <= 0).toList();
    final has = _hits.where((x) => (x["boxes"] as int) > 0).toList();
    // 已反馈状态行（未处理/已认领两态文案不同，核销的不在 open 列表=自然回到"可反馈"）
    String progTxt(String pn) {
      final s = _prog[pn.toUpperCase()];
      if (s == null) return "";
      final st = s["status"]?.toString();
      final n = (s["n"] as num?)?.toInt() ?? 1;
      if (st == "claimed") return "已反馈 · ${s["claimByName"] ?? "仓管"}跟进中${(s["eta"] ?? "").toString().isNotEmpty ? " · 预计 ${s["eta"]}" : ""}（$n 人催）";
      return "已反馈 · 待仓管认领（$n 人催）";
    }
    return Container(
        width: double.infinity,
        margin: const EdgeInsets.symmetric(vertical: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFFE3E8F0))),
        child: _load
            ? const Row(children: [
                SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)),
                SizedBox(width: 10),
                Text("正在核对全厂档案…", style: TextStyle(fontSize: 12.5, color: Colors.blueGrey))
              ])
            : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text("「${widget.keyword}」不在当前列表", style: const TextStyle(fontSize: 13.5, fontWeight: FontWeight.w700)),
                if (widget.extraHint.isNotEmpty)
                  Padding(padding: const EdgeInsets.only(top: 3), child: Text(widget.extraHint, style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey))),
                if (_hits.isEmpty) ...[
                  const Padding(
                      padding: EdgeInsets.only(top: 4),
                      child: Text("系统档案里查不到这个号——可能新项目/新零件，也可能输错了。", style: TextStyle(fontSize: 12))),
                  if (progTxt(widget.keyword).isNotEmpty)
                    Padding(padding: const EdgeInsets.only(top: 4), child: Text(progTxt(widget.keyword), style: const TextStyle(fontSize: 12, color: Color(0xFF1565C0)))),
                  const SizedBox(height: 6),
                  OutlinedButton.icon(
                      onPressed: () => shortageFeedback(context, [widget.keyword],
                          title: "缺料反馈（档案查无此号）",
                          defaultDesc: "系统档案查无此零件号（可能新项目/新零件），请核实并安排",
                          hint: "档案里没有此号：文案如实标注，收到的人第一步就会去核对"),
                      icon: const Icon(Icons.campaign_outlined, size: 16, color: Color(0xFFE65100)),
                      label: Text(progTxt(widget.keyword).isEmpty ? "还是反馈缺料" : "再催一次", style: const TextStyle(fontSize: 12.5))),
                ],
                if (has.isNotEmpty)
                  Padding(
                      padding: const EdgeInsets.only(top: 4),
                      child: Text(
                          "服务器显示其中 ${has.length} 项有货（如 ${has.first["pn"]} 在架 ${has.first["boxes"]} 框）——本机库存快照可能滞后，下拉刷新或与电脑端同步后再搜。（有货就说有货，不误报缺料）",
                          style: const TextStyle(fontSize: 12, color: Color(0xFF2E7D32)))),
                if (zero.isNotEmpty) ...[
                  const Padding(
                      padding: EdgeInsets.only(top: 6),
                      child: Text("档案里有这些号，但全厂在架 0 框——真缺货：", style: TextStyle(fontSize: 12, color: Color(0xFFE65100)))),
                  for (final z in zero)
                    Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Row(children: [
                          Expanded(
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text("${z["pn"]}  ${(z["nm"] ?? "").toString()}",
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 12, fontFamily: "monospace")),
                                if (progTxt(z["pn"].toString()).isNotEmpty)
                                  Text(progTxt(z["pn"].toString()), style: const TextStyle(fontSize: 11, color: Color(0xFF1565C0))),
                              ])),
                          TextButton(
                              onPressed: () => shortageFeedback(context, [z["pn"].toString()],
                                  hint: "来自「${widget.keyword}」搜索 · 全厂零在架"),
                              child: Text(progTxt(z["pn"].toString()).isEmpty ? "反馈" : "再催一次", style: const TextStyle(fontSize: 12))),
                        ])),
                  if (zero.length > 1)
                    Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: FilledButton.icon(
                            onPressed: () => shortageFeedback(context, zero.map((z) => z["pn"].toString()).toList(),
                                hint: "来自「${widget.keyword}」搜索 · 一键反馈 ${zero.length} 项零在架"),
                            style: FilledButton.styleFrom(
                                backgroundColor: const Color(0xFFE65100),
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6)),
                            icon: const Icon(Icons.share, size: 14),
                            label: Text("一键反馈这 ${zero.length} 项", style: const TextStyle(fontSize: 12)))),
                ],
              ]));
  }
}

/// 弹层：预览每行真实缺口 + 全局异常描述 → 分享(系统面板自选微信群)/复制
/// 弹层动作：0=取消 1=复制 2=分享 3=提交反馈（二期闭环，写入服务端可被认领/核销）
Future<void> showShortageSheet(BuildContext context, {required List<_ShortGap> rows, String title = "缺料反馈", String defaultDesc = "生产急需，请安排采购/到货", String hint = "", String src = "pda"}) async {
  // ㉖v181 有货判定统一交服务端（in_stock 闸，见 shortage 提交端点）：旧版端上
  // rows.every(有货) 判据既漏"一行真缺+一行有货"的混单，又与服务端兜底重复弹窗。
  // 端上只保留行内绿标提示（提交前就知道该行本不该按缺料处理），拦截判据单一来源。
  final descC = TextEditingController(text: defaultDesc);
  final go = await showModalBottomSheet<int>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => Padding(
          padding: EdgeInsets.fromLTRB(16, 14, 16, 16 + MediaQuery.of(ctx).viewInsets.bottom),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text("$title（${rows.length} 项）", style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
            if (hint.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 3), child: Text(hint, style: const TextStyle(fontSize: 11.5, color: Colors.blueGrey))),
            ConstrainedBox(
                constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * .38),
                child: SingleChildScrollView(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      for (final g in rows)
                        Container(
                            margin: const EdgeInsets.only(top: 8),
                            padding: const EdgeInsets.all(10),
                            decoration: BoxDecoration(color: const Color(0xFFF7F7FA), borderRadius: BorderRadius.circular(10)),
                            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                              Text("${g.pn}${g.nm.isNotEmpty ? " · ${g.nm}" : ""}", style: const TextStyle(fontFamily: "monospace", fontSize: 13, fontWeight: FontWeight.w700)),
                              Text(g.stockTxt + g.demandTxt, style: const TextStyle(fontSize: 12)),
                              // ㉖v180 有货行绿标：有在架且无缺口=不缺，正确动作是催发料而非报缺
                              if (!g.noData && g.boxes > 0 && g.gapQty <= 0)
                                const Text("🟢 全厂有货且不缺——要催的是发料，不是采购", style: TextStyle(fontSize: 12, color: Color(0xFF2E7D32))),
                              if (g.suggestTxt.isNotEmpty)
                                Text(g.suggestTxt, style: const TextStyle(fontSize: 12, color: const Color(0xFFE65100))),
                              // ㉖v179 末次领用+距今天数：距今越久越说明不是"刚领完"而是真断供
                              if (g.lastTxt.isNotEmpty)
                                Text(
                                    g.lastDaysAgo > 0
                                        ? "${g.lastTxt} · 已 ${g.lastDaysAgo} 天没领过"
                                        : g.lastTxt,
                                    style: TextStyle(fontSize: 12, color: g.lastDaysAgo >= 14 ? const Color(0xFFC62828) : const Color(0xFF546E7A))),
                            ])),
                    ]))),
            const SizedBox(height: 8),
            TextField(maxLines: 2, minLines: 1, style: const TextStyle(fontSize: 12.5), decoration: const InputDecoration(labelText: "异常描述（应用到所有行）", labelStyle: TextStyle(fontSize: 11), isDense: true, border: OutlineInputBorder()), controller: descC),
            const SizedBox(height: 10),
            // ㉖v178 二期：主按钮改为「提交反馈」——写进服务端才算闭环（仓管在「缺料反馈」页认领、
            // 到料自动核销并回执你）；分享微信仍保留（群里同步催办是现场真实动线，两者不互斥）
            SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                    onPressed: () => Navigator.pop(ctx, 3),
                    style: FilledButton.styleFrom(backgroundColor: const Color(0xFF515BD4), padding: const EdgeInsets.symmetric(vertical: 11)),
                    icon: const Icon(Icons.campaign_outlined, size: 18),
                    label: const Text("提交反馈（仓管处理，到料回执你）", style: TextStyle(fontSize: 13.5)))),
            const SizedBox(height: 6),
            Row(children: [
              Expanded(child: OutlinedButton(onPressed: () => Navigator.pop(ctx, 0), child: const Text("取消"))),
              const SizedBox(width: 6),
              Expanded(child: OutlinedButton.icon(onPressed: () => Navigator.pop(ctx, 1), icon: const Icon(Icons.copy, size: 15), label: const Text("复制", style: TextStyle(fontSize: 12.5)))),
              const SizedBox(width: 6),
              Expanded(
                  child: OutlinedButton.icon(
                      onPressed: () => Navigator.pop(ctx, 2),
                      icon: const Icon(Icons.share, size: 15, color: Color(0xFF07C160)),
                      label: const Text("分享微信", style: TextStyle(fontSize: 12.5)))),
            ]),
          ])));
  if (go == null || go == 0) {
    descC.dispose();
    return;
  }
  final desc = descC.text.trim().isEmpty ? defaultDesc : descC.text.trim();
  final txt = await shortFeedText(rows, desc);
  descC.dispose();
  if (!context.mounted) return;
  final ms = ScaffoldMessenger.of(context);
  if (go == 1) {
    await Clipboard.setData(ClipboardData(text: txt));
    ms.showSnackBar(const SnackBar(content: Text("缺料单已复制，可直接粘贴"), backgroundColor: Colors.green));
    return;
  }
  if (go == 2) {
    try {
      await _shortShareCh.invokeMethod("share", {"text": txt, "paths": <String>[]});
    } catch (e) {
      ms.showSnackBar(SnackBar(content: Text("分享失败：$e（可改用复制）"), backgroundColor: Colors.red.shade700));
    }
    return;
  }
  // go == 3 提交：逐条上报（服务端按零件归并计热度，同人重复=幂等不刷热度）
  // ㉖v181 有货判定以服务端为准（唯一口径，且堵住混单漏口——旧版端上 rows.every(有货)
  // 才提示，"一行真缺+一行有货"会静默放过）。服务端返回 code=in_stock 的行先收集，
  // 循环后统一点名确认：确认者带 forceStock 重试（标记囤货申请），拒绝者计入未提交。
  ms.showSnackBar(const SnackBar(content: Text("提交中…"), backgroundColor: Colors.blueGrey));
  int okN = 0, dupN = 0, failN = 0, skipN = 0;
  final msgs = <String>[];
  final inStock = <_ShortGap, String>{}; // 被有货闸拦下的行 → 服务端原因
  for (final g in rows) {
    try {
      final r = await AuthApi.shortSubmit(g.pn, g.nm, desc, src);
      if (r["ok"] == true) {
        if (r["dup"] == true) { dupN++; msgs.add("${g.pn} 你已反馈过（${r["status"] == "claimed" ? "${r["claimByName"]} 处理中" : "待仓管认领"}）"); }
        else { final isNew = r["created"] == true; okN++; msgs.add("${g.pn} ${isNew ? "已提交" : "热度+1（共 ${r["n"]} 人在催）"}"); }
      } else if (r["code"] == "in_stock") {
        inStock[g] = (r["msg"] ?? "全厂有货且不缺").toString();
      } else { failN++; msgs.add("${g.pn} 失败：${r["msg"]}"); }
    } catch (e) { failN++; msgs.add("${g.pn} 失败：$e"); }
  }
  if (inStock.isNotEmpty && context.mounted) {
    final its = inStock.keys.toList();
    final sure = await showDialog<bool>(
        context: context,
        builder: (c2) => AlertDialog(
            icon: const Icon(Icons.inventory_2_outlined, color: Colors.orange, size: 30),
            title: Text("${its.length} 项全厂有货，未提交", style: const TextStyle(fontSize: 16)),
            content: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              const Text("下列零件在架够当前需求，按缺料提交会让仓管误判为「要补货」：", style: TextStyle(fontSize: 13)),
              const SizedBox(height: 6),
              ConstrainedBox(constraints: const BoxConstraints(maxHeight: 150), child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    for (final g in its) Text("· ${g.pn} ${g.stockTxt}", style: const TextStyle(fontSize: 12, fontFamily: "monospace")),
                  ]))),
              const SizedBox(height: 8),
              const Text("确实需要提前囤货/凑整托 → 继续提交（仓管端标注「囤货申请」）；否则仅催发料。", style: TextStyle(fontSize: 12, color: Colors.blueGrey)),
            ]),
            actions: [
              TextButton(onPressed: () => Navigator.pop(c2, false), child: Text("不提交这${its.length}项")),
              FilledButton(onPressed: () => Navigator.pop(c2, true), child: const Text("确实要提前备货")),
            ]));
    if (sure == true) {
      for (final g in its) {
        try {
          final r = await AuthApi.shortSubmit(g.pn, g.nm, desc, src, forceStock: true);
          if (r["ok"] == true) {
            if (r["dup"] == true) dupN++; else okN++;
            msgs.add("${g.pn} 已按囤货申请提交");
          } else { failN++; msgs.add("${g.pn} 失败：${r["msg"]}"); }
        } catch (e) { failN++; msgs.add("${g.pn} 失败：$e"); }
      }
    } else {
      skipN = its.length;
    }
  }
  ms.showSnackBar(SnackBar(
      duration: const Duration(seconds: 6),
      backgroundColor: failN == 0 ? Colors.green : Colors.orange.shade800,
      content: Text("缺料反馈：新提交 $okN 项" + (dupN > 0 ? " · 重复 $dupN 项" : "") + (skipN > 0 ? " · 有货未提交 $skipN 项" : "") + (failN > 0 ? " · 失败 $failN 项" : "") + "\n" + msgs.take(3).join("\n"), style: const TextStyle(fontSize: 12.5))));
}

/// 入口统一动作：拉全厂缺口 → 预览弹层。失败不发假数据：询问后才裸文案发送。
Future<void> shortageFeedback(BuildContext context, List<String> pns, {String title = "缺料反馈", String defaultDesc = "生产急需，请安排采购/到货", String hint = ""}) async {
  final ms = ScaffoldMessenger.of(context);
  ms.showSnackBar(const SnackBar(content: Text("正在核算全厂缺口…"), backgroundColor: Colors.blueGrey));
  final gaps = await shortGapLoad(pns);
  if (!context.mounted) return;
  final list = pns.map((s) => s.trim().toUpperCase()).where((s) => s.isNotEmpty).toList();
  if (gaps == null) {
    final go = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
            icon: const Icon(Icons.cloud_off, color: Colors.orange, size: 30),
            title: const Text("缺口数据没拉到"),
            content: const Text("服务器账本/字典暂不可用，缺料单里将没有库存与需求数据（不会填假的 0）。仍可发送裸文案或先复制。"),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text("算了")),
              FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text("继续（不带数据）")),
            ]));
    if (go != true || !context.mounted) return;
    await showShortageSheet(context,
        rows: list.map((p) => _ShortGap(p, "", 0, 0, 0, 0, 0, true, noData: true)).toList(),
        title: title, defaultDesc: defaultDesc, hint: "注：发送时缺口数据不可用，仅基础字段");
    return;
  }
  await showShortageSheet(context,
      rows: list.map((p) => gaps[p] ?? _ShortGap(p, "", 0, 0, 0, 0, 0, false)).toList(),
      title: title, defaultDesc: defaultDesc, hint: hint);
}
