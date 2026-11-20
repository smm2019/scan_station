// ㉖v217 地面排取货路线 纯逻辑验证（dart run 直跑，脱 App/脱服务器）
import '../lib/pick_route.dart';

int _fail = 0, _total = 0;
void ck(String name, bool cond, [Object? info]) {
  _total++;
  if (!cond) _fail++;
  print('${cond ? '✅' : '❌'} $name${info != null ? '  [$info]' : ''}');
}

void main() {
  // 造一张贴近生产的单：4 零件行，框散落 A-11/A-13/A-12/C-15 + AGV货架框 + 已叫车地面框 + 已扫框
  final items = <Map<String, dynamic>>[
    {
      'partNo': '8041', 'itemName': '顶盖前横梁', 'issued': [
        {'c': 'N26OLD0001', 'q': 200} // 已扫 → 不再列
      ],
      'suggest': {
        'flatBoxes': [
          {'c': 'N26A110001', 'l': 'NB03-A-11-03', 'q': 300, 'agv': ''},
          {'c': 'N26A130001', 'l': 'NB03-A-13-07', 'q': 300, 'agv': ''}, // 同零件跨排
          {'c': 'N26AGV0001', 'l': 'NB02-B-05-3F', 'q': 326, 'agv': ''}, // 货架框→剔
          {'c': 'N26OLD0001', 'l': 'NB03-A-11-01', 'q': 200, 'agv': ''}, // 已扫→剔
        ]
      }
    },
    {
      'partNo': '9967', 'itemName': '后纵梁', 'issued': [],
      'suggest': {
        'flatBoxes': [
          {'c': 'N26A110002', 'l': 'NB03-A-11-05', 'q': 250, 'agv': ''},
          {'c': 'N26A110003', 'l': 'NB03-A-11-02', 'q': 250, 'agv': ''}, // 位号2应排在5前
          {'c': 'N26CALL001', 'l': 'NB03-A-12-04', 'q': 180, 'agv': 'NB02-CK-09'}, // 已叫车地面框→剔(去台取)
        ]
      }
    },
    {
      'partNo': '2066', 'itemName': '连接板', 'issued': [],
      'suggest': {
        'flatBoxes': [
          {'c': 'N26A120001', 'l': 'NB03-A-12-09', 'q': 120, 'agv': ''},
        ]
      }
    },
    {
      'partNo': '3739', 'itemName': '加强板', 'issued': [],
      'suggest': {
        'flatBoxes': [
          {'c': 'N26C150001', 'l': 'NB03-C-15-02', 'q': 90, 'agv': ''},
          {'c': 'N26A110001', 'l': 'NB03-A-11-03', 'q': 300, 'agv': ''}, // 与8041重复码→全局去重
        ]
      }
    },
  ];

  final route = buildPickRoute(items);
  final keys = route.rows.map((r) => r.key).toList();
  print('排顺序：${keys.join(' → ')}');

  ck('★ 排键顺序正确（A-11→A-12→A-13→C-15，区字母+排号升序）',
      keys.join(',') == 'A-11,A-12,A-13,C-15', keys.join(','));
  ck('★ 剔除货架框+已叫车+已扫（skipped 计 NB02 与叫车共2，已扫走 issued 分支不计skipped）',
      route.skippedAgv == 2, 'skipped=${route.skippedAgv}');
  ck('★ 总框数=地面未扫未叫车架（A-11×3, A-12×1, A-13×1, C-15×1 = 6）',
      route.totalBoxes == 6, 'total=${route.totalBoxes}');

  final a11 = route.rows.firstWhere((r) => r.key == 'A-11');
  ck('★★★ 行内跨排正确分派：8041 的框分别落到 A-11 和 A-13（不是整行绑一个排）',
      a11.items.any((x) => x.code == 'N26A110001') &&
          route.rows.firstWhere((r) => r.key == 'A-13').items.any((x) => x.code == 'N26A130001' && x.partNo == '8041'));
  ck('★★ A-11 排内含多零件（8041 + 9967），自动切行前提成立',
      a11.parts.length == 2, 'parts=${a11.parts}');
  ck('★★ A-11 排内按位号升序（位2 < 位3 < 位5）',
      a11.items.map((x) => x.slot).toList().join(',') == '2,3,5', a11.items.map((x) => x.slot).join(','));
  final dupA11 = a11.items.where((x) => x.code == 'N26A110001').length;
  ck('★★ 全局按标签去重：A-11 不含 3739 重复列的 N26A110001', dupA11 == 1, 'dup=$dupA11');
  ck('★ 每框带 partNo（供界面点击自动切发料目标行）',
      route.rows.every((r) => r.items.every((x) => x.partNo.isNotEmpty)));
  ck('★ 已扫标签 N26OLD0001 不出现在任何排',
      route.rows.every((r) => r.items.every((x) => x.code != 'N26OLD0001')));
  ck('★ 空单返回空路线', buildPickRoute([]).isEmpty && buildPickRoute([{'partNo': 'X', 'suggest': {'flatBoxes': []}}]).isEmpty);
  ck('★ 无 partNo/无 suggest 脏行不崩', buildPickRoute([{'foo': 1}, '不是map', {'partNo': ''}]).isEmpty);

  print('\n结果: ${_total - _fail} 通过 / $_fail 失败');
}
