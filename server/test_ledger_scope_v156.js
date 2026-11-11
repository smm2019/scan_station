// ㉖v156 出库台账补建安全边界 · 实例验证（用户要求：数据安全准确）
// 背景（11-11 11:17:46.369 实锤）：v120c 自查传 grace=0 意为"别拦我这一行"，实现却是【全表关宽限】；
// 而 3 分钟定时器由【上一次转单】挂下，扫到的却是【本次刚转 141 毫秒】的另一单行 → 误补镜像单
// SRV-DT20261111111746-5053，与 816 毫秒后 PDA 真单 DT20261111111747 重行 2 分 40 秒，11:20:26 才由去重删除。
// 修法：宽限恒定 5 分钟（grace=0 一律忽略）+ 自查限定 onlyReqNo+onlyPartNo 只查自己那一行 + 延迟 3→6 分钟。
//
// ★ 数据安全：本测试用 vm 沙箱跑真函数，但 db 全部为合成数据（N9 前缀），且 save/logErr/pushEvent/
//   feedDict 全部注入 mock —— 不写盘、不落 ops、不产生任何通知，对生产 db.json 零接触零风险。
const fs = require('fs');
const vm = require('vm');
const SRC = fs.readFileSync(__dirname + '/server.js', 'utf8').replace(/\r\n/g, '\n');

// ---- 抽真函数（顶层函数：闭合 } 独占一行）----
function extractTop(sig) {
  const i = SRC.indexOf(sig);
  if (i < 0) throw new Error('未找到 ' + sig);
  if (SRC.slice(i, SRC.indexOf('\n', i)).indexOf('}') > 0) return SRC.slice(i, SRC.indexOf('\n', i)); // 单行函数
  for (let j = i; j < SRC.length; j++) if (SRC.slice(j, j + 2) === '\n}' && (j + 2 >= SRC.length || SRC[j + 2] === '\n')) return SRC.slice(i, j + 2);
  throw new Error('闭合失败 ' + sig);
}
const FIX = extractTop('function outboundLedgerFix(opts) {');
const ISS = extractTop('function issuedOf(i) {');
let pass = 0, fail = 0;
const T = (id, cond, note) => { if (cond) { pass++; console.log('PASS ' + id + (note ? '  ' + note : '')); } else { fail++; console.log('FAIL ' + id + (note ? '  ' + note : '')); } };
T('F0 抽函数', FIX.length > 3000 && ISS.length > 60, FIX.length + 'B / ' + ISS.length + 'B');

const NOW = Date.now(), M = 60000;
const mkIt = (partNo, codes, ageMs) => ({ partNo, itemName: '测试件', qty: 1000, transferred: true, transferQty: codes.length * 100, transferAt: NOW - ageMs, transferBy: '测试', issued: codes.map((c, i) => ({ c, q: 100, l: 'NB02-C-16-2F', n: '测试件' })), agvCalled: [] });
const mkReq = (no, items) => ({ id: 'rq_' + no.slice(-4), no, status: 'done', toLoc: { WAREHOUSE_NAME: '线边仓' }, items });

function mkCtx(seed) {
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const db = Object.assign({ outbound: {}, requisitions: [], ledger: [], carEvents: [], itemDict: {} }, seed || {});
  return { log, db };
}
function run(db, opts, log, nowFixed) {
  nowFixed = nowFixed || NOW; // 默认冻结为用例基准时刻（mkIt 用 NOW 算 transferAt）
  // 可冻结时钟：new Date(x) 正常，Date.now()/new Date() 返回事故当刻（回放"补建当刻"必需）
  const RD = Date;
  function FD(...a) { return a.length ? new RD(...a) : new RD(nowFixed); }
  FD.now = () => nowFixed; FD.parse = RD.parse; FD.UTC = RD.UTC; FD.prototype = RD.prototype;
  const ctx = {
    db, console: { log: () => {} }, Date: FD, Math, Object, Array, String, Number, Set, RegExp, JSON, isNaN, parseInt, parseFloat,
    save: () => { log.saves++; },
    logErr: (w, e) => log.errors.push(w + ':' + e.message),
    pushEvent: (kind, who, msg) => log.events.push({ kind, who, msg }),
    feedDict: (c, n, src) => log.dicts.push(c),
    u_nameOf: () => '测试人',
  };
  vm.createContext(ctx);
  vm.runInContext(ISS + '\n' + FIX + '\nglobalThis.__run = () => outboundLedgerFix(__opts);', ctx);
  ctx.__opts = opts;
  return vm.runInContext('__run()', ctx);
}

// ============ N1 事故复演：刚转 141 毫秒的行不得被误补 ============
{
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const { db } = mkCtx({ requisitions: [mkReq('LL2026111110243696', [mkIt('6608465053', ['N9X000001'], 141)])] });
  const n = run(db, {}, log); // 别的转单挂下的自查/周期扫描（全表）
  const srvs = Object.keys(db.outbound).filter(k => k.startsWith('SRV-'));
  T('N1a 刚转141ms的行不被补建（镜像单不再产生）', srvs.length === 0 && n === 0, 'fixed=' + n + ' SRV=' + srvs.length);
  T('N1b 无补建即不落盘、无事件噪音', log.saves === 0 && log.events.length === 0);
}
{ // N5 grace=0 不可绕过
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const { db } = mkCtx({ requisitions: [mkReq('LL2026111110243696', [mkIt('6608465053', ['N9X000001'], 141)])] });
  const n = run(db, { grace: 0 }, log);
  T('N5 grace=0 被忽略，宽限不可绕过', Object.keys(db.outbound).length === 0 && n === 0);
}
// ============ N2 真缺台账（PDA 推送丢失）仍须补建：兜底不失效 ============
{
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const { db } = mkCtx({ requisitions: [mkReq('LL2026111100000002', [mkIt('6608466060', ['N9X000002'], 10 * M)])] });
  const n = run(db, { onlyReqNo: 'LL2026111100000002', onlyPartNo: '6608466060' }, log);
  const srvs = Object.keys(db.outbound).filter(k => k.startsWith('SRV-'));
  T('N2a 过宽限且台账缺失→补建成功', n === 1 && srvs.length === 1, srvs[0]);
  const o = srvs.length ? db.outbound[srvs[0]] : {};
  T('N2b 补建内容准确（1框/100件/原货位/关联领料单）',
    (o.items || []).length === 1 && o.items[0].barcode === 'N9X000002' && o.items[0].qty === 100 && o.items[0].fromLoc === 'NB02-C-16-2F' && o.linkReqNo === 'LL2026111100000002',
    JSON.stringify(o.items || []).slice(0, 90));
  T('N2c 补建留痕进事件流且落盘', log.events.some(e => e.kind === '出库台账补建') && log.saves === 1);
  T('N2d 补建时刻取转单时刻（非补建当刻）', Math.abs((o.createdAt || 0) - (NOW - 10 * M)) <= 1000, 'createdAt=' + o.createdAt);
}
// ============ N3 自查限定：A 单的自查绝不动 B 单的行 ============
{
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const { db } = mkCtx({
    requisitions: [
      mkReq('LL2026111100000003', [mkIt('6608466060', ['N9X000003'], 10 * M)]),
      mkReq('LL2026111100000004', [mkIt('6608466070', ['N9X000004'], 10 * M)]),
    ],
  });
  const n = run(db, { onlyReqNo: 'LL2026111100000003', onlyPartNo: '6608466060' }, log);
  const all = Object.values(db.outbound).flatMap(o => (o.items || []).map(i => i.barcode));
  T('N3a 只补自己单自己行', n === 1 && all.length === 1 && all[0] === 'N9X000003', '补建码=' + all.join(','));
  T('N3b 同批他单缺台账行未被触碰', all.indexOf('N9X000004') < 0);
}
// ============ N4 v103 安全边界不回归：框仍在账本(实物未出)不得坐实出库 ============
{
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const { db } = mkCtx({
    requisitions: [mkReq('LL2026111100000005', [mkIt('6608466080', ['N9X000005'], 10 * M)])],
    ledger: [{ c: 'N9X000005', l: 'NB02-A-04-1F', mv: 'AGV', t: NOW - M, by: '测试' }], // 撤扫退回+重上架：实物未出
  });
  const n = run(db, { onlyReqNo: 'LL2026111100000005', onlyPartNo: '6608466080' }, log);
  T('N4 框仍在账本→不补建（不误坐实出库）', n === 0 && Object.keys(db.outbound).length === 0);
}
// ============ N6 镜像去重（第二道防线）在限定调用下仍生效 ============
{
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const { db } = mkCtx({
    outbound: {
      'DT2026111100000006': { orderNo: 'DT2026111100000006', linkReqNo: 'LL2026111100000006', createdAt: NOW - 8 * M, status: 0, items: [{ barcode: 'N9X000006', qty: 100, code: '6608466090', fromLoc: 'NB02-C-16-2F' }] },
      'SRV-DTTEST-6': { orderNo: 'SRV-DTTEST-6', linkReqNo: 'LL2026111100000006', createdAt: NOW - 8 * M, status: 0, srvFix: 1, items: [{ barcode: 'N9X000006', qty: 100, code: '6608466090', fromLoc: 'NB02-C-16-2F' }] },
      'SRV-DT-KEEP': { orderNo: 'SRV-DT-KEEP', linkReqNo: 'LL9999999900000099', createdAt: NOW - 8 * M, status: 0, srvFix: 1, items: [{ barcode: 'N9X000009', qty: 100, code: '6608466099' }] }, // 无孪生→须保留
    },
    requisitions: [],
  });
  const n = run(db, { onlyReqNo: 'LL2026111100000006', onlyPartNo: '6608466090' }, log);
  T('N6a 限定调用下孪生镜像仍被删', !db.outbound['SRV-DTTEST-6']);
  T('N6b 真单零触碰', !!db.outbound['DT2026111100000006'] && db.outbound['DT2026111100000006'].items.length === 1);
  T('N6c 无孪生的历史正确补建单保留', !!db.outbound['SRV-DT-KEEP']);
  T('N6d 去重留痕点名镜像单', log.events.some(e => e.kind === '出库台账镜像去重' && String(e.who).indexOf('SRV-DTTEST-6') >= 0));
}
// ============ N7 生产实况回放（冻结时钟到事故当刻）============
{
  const transferAt = new Date('2026-11-11 11:17:46.228').getTime();
  const evAt = transferAt + 141;            // 补建事件实际发生时刻（差 141 毫秒）
  const prevTransferAt = new Date('2026-11-11 11:14:47').getTime(); // 挂下该定时器的那一单
  const mkRow = (c, q, l) => ({ c, q, l, n: '测试件' });
  const { db } = mkCtx({
    requisitions: [
      { id: 'rq_a', no: 'LL2026111110243696', status: 'done', toLoc: { WAREHOUSE_NAME: '线边仓' }, items: [{ partNo: '6608465053', itemName: '03-吉利E281右前纵后段', qty: 489, transferred: true, transferQty: 489, transferAt, transferBy: '宋明明', issued: [mkRow('N26K100000', 489, 'NB02-C-16-2F')], agvCalled: [] }] },
      { id: 'rq_b', no: 'LL20261111111447', status: 'done', toLoc: {}, items: [{ partNo: '6608466001', qty: 100, transferred: true, transferQty: 100, transferAt: prevTransferAt, transferBy: '宋明明', issued: [mkRow('N26K100001', 100, 'NB02-C-15-2F')], agvCalled: [] }] },
    ],
    outbound: { 'DT20261111111447': { orderNo: 'DT20261111111447', linkReqNo: 'LL20261111111447', createdAt: prevTransferAt + 400, status: 0, items: [{ barcode: 'N26K100001', qty: 100, code: '6608466001' }] } },
  });
  const log = { events: [], dicts: [], saves: 0, errors: [] };
  const n = run(db, {}, log, evAt); // 回放"上一单定时器到点"当刻的全表扫描
  T('N7a 实况回放：刚转141ms的行不被误补', n === 0 && Object.keys(db.outbound).filter(k => k.startsWith('SRV-')).length === 0, 'fixed=' + n);
  // 真单 816 毫秒后由 PDA 推送落库 → 台账唯一，不再重行
  db.outbound['DT20261111111747'] = { orderNo: 'DT20261111111747', linkReqNo: 'LL2026111110243696', createdAt: transferAt + 816, status: 0, items: [{ barcode: 'N26K100000', qty: 489, code: '6608465053', fromLoc: 'NB02-C-16-2F' }] };
  const n2 = run(db, { onlyReqNo: 'LL2026111110243696', onlyPartNo: '6608465053' }, log, transferAt + 6 * 60000); // 6 分钟后自查（跨过宽限）
  const rows = (Object.values(db.outbound).flatMap(o => o.items || [])).filter(i => i.barcode === 'N26K100000');
  T('N7b 真单落库后自查幂等：台账保持 1 行不重复', n2 === 0 && rows.length === 1, 'N26K100000 台账行数=' + rows.length);
}
console.log('\n结果: ' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
