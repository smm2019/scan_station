// ㉖v107 档案页逐框四态 · 判据复刻 + 现场回放 + 源码断言
// 复刻 RequisitionCache.saveIssued（含新增 pending 集）与 loadPartProfile 四态判定（Node版）
const fs = require('fs'), path = require('path');
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

// ===== 缓存复刻 =====
function saveIssued(reqs) {
  const set = new Set(), pending = new Set();
  const active = ['accepted', 'ready', 'done'];
  for (const r of reqs) {
    if (!active.includes(r.status)) continue;
    const finished = r.status === 'ready' || r.status === 'done';
    for (const it of r.items || []) {
      const cs = (it.issued || []).map((x) => String(typeof x === 'string' ? x : (x.c || '')).toUpperCase()).filter(Boolean);
      if (!finished && it.transferred !== true) { cs.forEach((c) => pending.add(c)); continue; }
      cs.forEach((c) => set.add(c));
    }
  }
  return { set, pending };
}
// ===== 四态复刻（与 Dart ppState 逐分支对应）=====
function ppState(b, ledOn, pendOut) {
  if (b.cancelled) return '作废';
  if (b.outTime != null) return '已出库';
  const onLed = ledOn == null ? b.outTime == null : ledOn.has(b.barcode);
  if (onLed) return b.inTime == null ? '账本存量' : '在库';
  if (pendOut.has(b.barcode)) return '已发未转';
  return '账外';
}

console.log('===== A. 缓存增存：已发未转集合 =====');
const reqs = [
  { status: 'accepted', items: [{ transferred: false, issued: [{ c: 'C_A1' }, { c: 'C_A2' }] }, { transferred: true, issued: [{ c: 'C_A3' }] }] },
  { status: 'ready', items: [{ transferred: true, issued: [{ c: 'C_B1' }] }] },
  { status: 'done', items: [{ transferred: true, issued: ['C_B2'] }] }, // 旧格式纯字符串
  { status: 'cancelled', items: [{ issued: [{ c: 'C_X' }] }] }, // 整单退回不扣
  { status: 'pending', items: [{ issued: [{ c: 'C_Y' }] }] }, // 未接单不扣
];
const cache = saveIssued(reqs);
T('A1 已出库剔除集=已转行+完成单', [...cache.set].sort(), ['C_A3', 'C_B1', 'C_B2']);
T('A2 已发未转集=备料中未转行', [...cache.pending].sort(), ['C_A1', 'C_A2']);
T('A3 取消/待接单不入任何集', [cache.set.has('C_X'), cache.pending.has('C_X'), cache.set.has('C_Y'), cache.pending.has('C_Y')], [false, false, false, false]);
T('A4 两集互斥（同行只会进一个）', [...cache.set].some((c) => cache.pending.has(c)), false);

console.log('\n===== B. 四态判定（6608225548 现场回放）=====');
// 现场实况：250225/250226 发料后卡单（不在账本、无出库记录、在已发未转集）；270036/310209 在账本
const ledOn = new Set((d.ledger || []).filter((x) => String(x.p || '') === '6608225548').map((x) => String(x.c).toUpperCase()));
const pend = new Set(['N26J250225', 'N26J250226']);
const mk = (c, extra) => ({ barcode: c, cancelled: false, outTime: null, inTime: '2026-10-25', ...extra });
T('B1 账本命中→在库', ppState(mk('N26J270036'), ledOn, pend), '在库');
T('B2 不在账本+已发未转→已发未转（旧版误标在库的主案）', ppState(mk('N26J250225'), ledOn, pend), '已发未转');
T('B3 不在账本+不在pending+无出库→账外', ppState(mk('N26J999999'), ledOn, pend), '账外');
T('B4 有出库记录→已出库（优先于账本命中，v98c口径不变）', ppState(mk('N26J250226', { outTime: '2026-11-04' }), ledOn, pend), '已出库');
T('B5 作废优先一切', ppState(mk('N26J250226', { cancelled: true }), ledOn, pend), '作废');
T('B6 离线回退（ledOn=null）：无出库记录=在架（旧行为不阻断）', ppState(mk('N26J250225'), null, pend), '在库');
T('B7 账本无流水框→账本存量', ppState(mk('N26J270036', { inTime: null }), ledOn, pend), '账本存量');
// 现场数字闭环：卡单期间 在库框数=账本命中数(2)，已发未转=2，合计展示不再矛盾
const boxes = ['N26J270036', 'N26J310209', 'N26J250225', 'N26J250226'].map((c) => mk(c));
const states = boxes.map((b) => ppState(b, ledOn, pend));
T('B8 现场4框判定=2在库+2已发未转（旧版4框全在库）', states, ['在库', '在库', '已发未转', '已发未转']);
T('B9 在库筛选只含2框（4→2 用户拍板口径）', states.filter((s) => s === '在库' || s === '账本存量').length, 2);
// v106 对账入账后：250225/250226 有出库记录 → 自动翻已出库
const pendAfter = new Set(); // 入账后行 transferred=true，pending 集清空
const ledAfter = ledOn;
T('B10 入账后两框翻已出库（pending集空+出库记录在）', ['N26J250225', 'N26J250226'].map((c) => ppState(mk(c, { outTime: '2026-11-05' }), ledAfter, pendAfter)), ['已出库', '已出库']);

console.log('\n===== C. 源码断言（实现与判据同步，防漂移）=====');
const rq = fs.readFileSync(path.join(__dirname, '../lib/requisition_page.dart'), 'utf8');
const iv = fs.readFileSync(path.join(__dirname, '../lib/inventory_stock_page.dart'), 'utf8');
T('C1 缓存增存 pending 键', /_kIssuedPending = "req_issued_pending_barcodes"/.test(rq), true);
T('C2 未转行入 pending 且不入 set', /pending\.addAll\(cs\);\s*continue;/.test(rq), true);
T('C3 已转行入 set（v107 改 addAll 语义保持）', /set\.addAll\(cs\);/.test(rq), true);
T('C4 loadIssuedPending 读取函数存在', /static Future<Set<String>> loadIssuedPending\(\)/.test(rq), true);
T('C5 inStock 收敛=账本命中（onLed 入条件）', /bool get inStock => !cancelled && outTime == null && onLed;/.test(iv), true);
T('C6 ppState 四态函数存在', /String get ppState/.test(iv), true);
T('C7 四态赋值：离线回退旧口径', /b\.onLed = ledOn == null \? b\.outTime == null : ledOn\.contains\(b\.barcode\.toUpperCase\(\)\);/.test(iv), true);
T('C8 pendingOut 定义（非在架·无出库·在pending集）', /b\.pendingOut = !b\.onLed && b\.outTime == null && pendOut\.contains\(b\.barcode\.toUpperCase\(\)\);/.test(iv), true);
T('C9 计数四分流（在库/已出库/pending/ghost）', /d\.pendingBoxes\+\+;[\s\S]{0,60}d\.ghostBoxes\+\+;/.test(iv), true);
T('C10 徽章四态化（已发未转琥珀+账外灰）', /"已发未转" => const _PpBadge\("已发未转", Color\(0xFFB26A00\)\)/.test(iv) && /_ => const _PpBadge\("账外", Color\(0xFF9E9E9E\)\)/.test(iv), true);
T('C11 头部如实展示两态计数', /已发未转 \$\{d\.pendingBoxes\} 框/.test(iv) && /账外 \$\{d\.ghostBoxes\} 框/.test(iv), true);
T('C12 在库筛选走 b.inStock（新语义自动收敛）', /_filter == "在库"\s*\?\s*b\.inStock/.test(iv), true);
T('C13 检验入口仍限真在库（inStock 已收敛自动生效）', /final isShelf = b\.inStock && RegExp/.test(iv), true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
