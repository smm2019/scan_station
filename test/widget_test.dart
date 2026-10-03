// 占位单元测试。
// 原模板测试引用 package:scan_station/main.dart（包名不存在，真实包名是 agv_collector）
// 和不存在的 MyApp 类，属于从未生效过的脚手架残留，导致 CI 静态检查报 error。
// 后续需要真实测试时再按实际组件补充。
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('sanity placeholder', () {
    expect(1 + 1, 2);
  });
}
