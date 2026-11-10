// ㉖v129 领料单筛选人性化 · 实例证明
// 痛点（用户截图）：满屏"已备齐"绿徽章，分不清刚备好的还是 8 小时/8 天没人签收；筛选芯片"待接单/备料中"
//   藏在长列表后且 0 时消失，看不出"卡在哪个环节"。
// 改动（lib/requisition_page.dart，纯前端）：
//   ① _stNames ready 叫法统一"已备齐"（旧 chip 写"待签收"，与卡片徽章两张嘴）
//   ② 流程三段恒定前置：📥待接单→🔧备料中→📦已备齐（0 也显示，一眼定位卡点）
//   ③ chip 计数按语义着色：待接单>0 橙(有活没人接)/备料中蓝/已备齐青(催签收)/急料红
//   ④ 卡片新增"卡在这一步多久"：⏳已等待/🔧已备料/📦待签收 + 超阈值橙色加粗
//      阈值：pending≥30分、accepted≥60分、ready≥30分；时刻回退链 readyAt→acceptedAt→createdAt
//   ⑤ isThreeLine 自适应：有等待行时交 ListTile 自算高度，防裁切
// 手法：Node 复刻 reqWaitHint 逐字同逻辑（含 ISO串/数字毫秒/缺失回退/未来时刻容错），跑真实 db.json
const fs = require('fs'); const path = require('path');
const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };
const TT = (n, c) => { total++; if (!c) { fail++; console.log('FAIL ' + n); } else console.log('PASS ' + n); };

// ===== 复刻 reqWaitHint（与 Dart 逐字同逻辑）=====
const WARN = { pending: 30, accepted: 60, ready: 30 };
const LABEL = { pending: '⏳ 已等待', accepted: '🔧 已备料', ready: '📦 待签收' };
function reqDurCn(min) {
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟';
  const h = Math.floor(min / 60), mm = min % 60;
  if (h < 24) return mm === 0 ? h + ' 小时' : h + ' 小时 ' + mm + ' 分';
  return Math.floor(h / 24) + ' 天' + (h % 24) + ' 小时';
}
function reqWaitHint(r, now) {
  const st = String(r.status || '');
  const msOfV = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') return v > 0 ? v : null;
    const s = String(v); if (!s) return null;
    const t = Date.parse(s); return isNaN(t) ? null : t;
  };
  let from = null;
  if (st === 'pending') from = msOfV(r.createdAt);
  else if (st === 'accepted') from = msOfV(r.acceptedAt) || msOfV(r.createdAt);
  else if (st === 'ready') from = msOfV(r.readyAt) || msOfV(r.acceptedAt) || msOfV(r.createdAt);
  else return null;
  if (!from || from <= 0) return null;
  const m = Math.round((now - from) / 60000);
  if (m < 0) return null;
  const over = m >= WARN[st];
  return { txt: LABEL[st] + ' ' + reqDurCn(m), over, min: m };
}
const now = Date.now();

// ===== ① 真实数据：现网在办单全部应被点名 =====
{
  const live = (d.requisitions || []).filter((r) => ['pending', 'accepted', 'ready'].includes(r.status));
  const hints = live.map((r) => ({ no: r.no, st: r.status, h: reqWaitHint(r, now) }));
  TT('R1 现网在办单全部能算出时长（无 null=字段回退链有效）', hints.every((x) => x.h !== null));
  const readyOver = hints.filter((x) => x.st === 'ready' && x.h.over);
  TT('R2 现网 ready 单全部超 30 分阈值（截图痛点：绿徽章看不出卡了几小时）', hints.filter((x) => x.st === 'ready').length > 0 && readyOver.length === hints.filter((x) => x.st === 'ready').length);
  const worst = hints.filter((x) => x.h).sort((a, b) => b.h.min - a.h.min)[0];
  console.log('  [现网实况] 在办 ' + live.length + ' 张，最久一张：' + worst.st + ' ' + worst.h.txt);
  TT('R3 最久单时长可读（含"天/小时"中文格式）', /天|小时|分钟|刚刚/.test(worst.h.txt));
}
// ===== ② 阈值边界单测 =====
{
  const mk = (st, minAgo, ex) => Object.assign({ status: st, createdAt: new Date(now - minAgo * 60000).toISOString() }, ex || {});
  T('B1 pending 29 分不警示', reqWaitHint(mk('pending', 29), now).over, false);
  T('B2 pending 30 分警示（含边界）', reqWaitHint(mk('pending', 30), now).over, true);
  T('B3 accepted 59 分不警示', reqWaitHint(mk('accepted', 59), now).over, false);
  T('B4 accepted 60 分警示', reqWaitHint(mk('accepted', 60), now).over, true);
  T('B5 ready 31 分警示', reqWaitHint(mk('ready', 31), now).over, true);
  T('B6 刚刚(<1分)显示"刚刚"且不警示', (() => { const h = reqWaitHint(mk('pending', 0), now); return [h.txt.endsWith('刚刚'), h.over]; })(), [true, false]);
}
// ===== ③ 字段回退链与容错 =====
{
  // readyAt 数字毫秒 + acceptedAt ISO 串混合（生产两种格式并存，v94r 前数字后 ISO）
  const r1 = { status: 'ready', createdAt: new Date(now - 120 * 60000).toISOString(), acceptedAt: new Date(now - 100 * 60000).toISOString(), readyAt: now - 60 * 60000 };
  const h1 = reqWaitHint(r1, now);
  T('C1 优先取 readyAt（60分而非下单120分）', h1.min, 60);
  const r2 = { status: 'ready', createdAt: new Date(now - 200 * 60000).toISOString(), acceptedAt: new Date(now - 90 * 60000).toISOString() };
  T('C2 无 readyAt 回退 acceptedAt', reqWaitHint(r2, now).min, 90);
  const r3 = { status: 'ready', createdAt: new Date(now - 70 * 60000).toISOString() };
  T('C3 两者皆无回退 createdAt', reqWaitHint(r3, now).min, 70);
  T('C4 done 态返回 null（终态不显示时长）', reqWaitHint({ status: 'done', createdAt: new Date(now - 9999 * 60000).toISOString() }, now), null);
  T('C5 cancelled 态返回 null', reqWaitHint({ status: 'cancelled', createdAt: new Date(now - 10 * 60000).toISOString() }, now), null);
  T('C6 未来时刻容错（时钟偏差返回 null 不显示负数）', reqWaitHint({ status: 'pending', createdAt: new Date(now + 5 * 60000).toISOString() }, now), null);
  T('C7 全空时刻返回 null', reqWaitHint({ status: 'accepted' }, now), null);
  T('C8 空串时刻不误算（createdAt="" 且无其它）', reqWaitHint({ status: 'pending', createdAt: '' }, now), null);
  T('C9 acceptedAt=0 视为缺失回退 createdAt', reqWaitHint({ status: 'accepted', acceptedAt: 0, createdAt: new Date(now - 45 * 60000).toISOString() }, now).min, 45);
}
// ===== ④ 时长中文格式 =====
{
  T('D1 59分', reqDurCn(59), '59 分钟');
  T('D2 60分整点', reqDurCn(60), '1 小时');
  T('D3 90分', reqDurCn(90), '1 小时 30 分');
  T('D4 23时59分', reqDurCn(1439), '23 小时 59 分');
  T('D5 25时→天', reqDurCn(1500), '1 天1 小时');
  T('D6 0分=刚刚', reqDurCn(0), '刚刚');
}
// ===== ⑤ 源码锚点（Dart 侧改动在位）=====
{
  const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'requisition_page.dart'), 'utf8');
  TT('E1 ready 叫法统一已备齐', dart.includes("'ready': '已备齐'") && !dart.includes("'ready': '待签收'"));
  TT('E2 流程三段恒定前置（0也显示）', dart.includes('["pending", "📥待接单"]') && dart.includes('["accepted", "🔧备料中"]') && dart.includes('["ready", "📦已备齐"]') && dart.includes('...flow,'));
  TT('E3 计数语义着色', dart.includes('case "pending": return Colors.deepOrange') && dart.includes('case "ready": return Colors.teal'));
  TT('E4 在办态其余状态去重（flow 已含不再出）', dart.includes('!flow.any((f) => f[0] == e.key)'));
  TT('E5 卡片等待时长行在位', dart.includes('final waitH = reqWaitHint(r);') && dart.includes('if (waitH != null)'));
  TT('E6 阈值与回退链在位', dart.includes('warnMin = 30') && dart.includes('warnMin = 60') && dart.includes('msOfV(r["readyAt"]) ?? msOfV(r["acceptedAt"]) ?? msOfV(r["createdAt"])'));
  TT('E7 自适应高度防裁切', dart.includes('isThreeLine: waitH == null'));
  TT('E8 ISO串/数字毫秒双兼容', dart.includes('if (v is num) return v.toInt() > 0 ? v.toInt() : null;'));
  TT('E9 未来时刻负数防护', dart.includes('if (m < 0) return null;'));
}
console.log('\n===== v129 领料筛选人性化 实例证明 ' + (total - fail) + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
