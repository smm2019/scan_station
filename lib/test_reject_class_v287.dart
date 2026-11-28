// ㉖v287 拒回分类安全线单测：拿 server.js 七类真实拒回文案模板逐条验证
// 旧缓存三类（可自动对齐）：5787 出库墓碑 / 5799 更新登记 / 5818 改位旧缓存
// 真冲突四类（必须原弹窗）：5744 格式不符 / 5791 裸键旧规则 / 5826 回流挡 / 5840 占格
import 'ledger_reject_class.dart';

int fail = 0, total = 0;
void chk(String n, bool cond, String why) {
  total++;
  if (!cond) {
    fail++;
    print('FAIL! [$n] ← $why');
  } else {
    print('PASS [$n]');
  }
}

void main() {
  // —— 旧缓存三类签名（与 server.js 5787/5799/5818 逐字对齐）——
  const old1 = 'N26K280128（该框已于 11/28 10:20 出库/作废，本机旧缓存回推被挡——无需重新登记，拉取一次自动清掉）';
  const old2 = 'N26K280083（服务器已有更新登记 11/28 11:03，本机旧缓存未生效——拉取对齐即可，无需重新登记）';
  const old3 = 'N26K280036（本机货位 NB04-A-01-023 是旧缓存——服务器已于 11/28 11:04 更新登记为 NB03-A-15-01，旧缓存改位不生效——拉取一次自动清掉，无需重新登记）';
  // —— 真冲突四类（与 server.js 5744/5791/5826/5840 逐字对齐）——
  const real1 = 'N26K290001（货位「NB02-CK-05」格式不符——应选 NB02-A-08-2F 这类货架位、NB03-B-13-07 这类地面格位或 NB04-A-01-003 这类来料格位，请到「位置登记」重新选择）';
  const real2 = 'N26K290002'; // 5791 裸键旧规则：只推码无文案
  const real3 = 'N26K290003（货位由 NB02-A-05-1F 改回来料区 NB04-A-01-010 被挡——已入库框不允许回流来料区，如需纠正请在管理端「账本修正」操作并填原因）';
  const real4 = 'N26K290004（目标货位 NB02-A-05-1F 已被框 N26K290099 占用）';
  const fmt = 'N26K290005（货位「H09」格式不符……）';

  chk('旧缓存单条→自动对齐', rejectAllOldCache([old3], const []), '');
  chk('旧缓存15条混合三类→自动对齐(11-28截图场景)', rejectAllOldCache([old1, old2, old3, old1, old2, old3, old1, old2, old3, old1, old2, old3, old1, old2, old3], const []), '');
  chk('★真冲突混入一条→不自动对齐(安全线:弹窗保留)', !rejectAllOldCache([old3, real4], const []), '');
  chk('★格式不符混入→不自动对齐', !rejectAllOldCache([old3, fmt], const []), '');
  chk('★回流挡→不自动对齐', !rejectAllOldCache([real3], const []), '');
  chk('★裸键旧规则→不自动对齐(无签名串)', !rejectAllOldCache([real2], const []), '');
  chk('★占格→不自动对齐', !rejectAllOldCache([real4], const []), '');
  chk('★格式拒回非空→不自动对齐(rejLocL闸)', !rejectAllOldCache([old3], [fmt]), '');
  chk('空列表→不自动对齐(无东西可对齐)', !rejectAllOldCache(const [], const []), '');
  chk('真冲突单条→不自动对齐', !rejectAllOldCache([real1], const []), '');
  print('\n===== v287 拒回分类安全线单测：${total - fail}/$total PASS =====');
  if (fail > 0) throw StateError('分类安全线破防');
}
