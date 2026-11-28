// ㉖v287 账本推送拒回分类（独立库文件：part 文件不可被测试直接 import，抽此供单测锁安全线）
/// 判据=拒回条目【全部】带服务端旧缓存签名（server.js 5787 出库墓碑挡 / 5799 服务器已有更新登记 /
/// 5818 改位旧缓存 三类文案，均含"拉取一次自动清掉"或"拉取对齐即可"）且无货位格式拒回。
/// 混入任一其他文案（5840 占格 / 5826 回流挡 / 5744 格式不符 / 5791 裸键旧规则）→ false 走原弹窗，
/// 真冲突绝不自动对齐吞掉（安全线，用户 11-28 拍板"保证数据安全和准确"）。
bool rejectAllOldCache(List<String> rejL, List<String> rejLocL) =>
    rejLocL.isEmpty &&
    rejL.isNotEmpty &&
    rejL.every((s) =>
        s.contains('拉取一次自动清掉') || s.contains('拉取对齐即可'));
