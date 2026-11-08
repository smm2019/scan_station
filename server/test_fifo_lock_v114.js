// ㉖v114·A+C FIFO漂移修复验证（只读复算，跑 server.js 真实 pickSuggest 函数体）
// 用真实 db.json 中 6608453824 的账本 + LL2026110609390449 的 sugCodes，复算锁定态白名单，
// 对比旧贪心是否还会把盖章框挤出（漂移）——证明 A 生效后盖章池全程可扫、幽灵码仍拦。
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const SRV = path.join(__dirname, 'server.js');
const txt = fs.readFileSync(SRV, 'utf8');
const lines = txt.split(/\r?\n/);
let fail = 0, total = 0;
const T = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); };

function grab(startSig, endSig) {
  let s = -1; for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith(startSig)) { s = i; break; }
  if (s < 0) throw new Error('未找到起始: ' + startSig);
  let e = -1; for (let i = s + 1; i < lines.length; i++) if (lines[i].trim().startsWith(endSig)) { e = i; break; }
  if (e < 0) throw new Error('未找到结束: ' + endSig);
  return lines.slice(s, e).join('\n');
}

const src = [
  grab('function boxKeyOf', 'function groupLedgerBoxes'),
  grab('function groupLedgerBoxes', 'function agvMapOf'),
  grab('function pickSuggest', 'function reqView'),
  grab('function trimLastLot', 'function pickSuggest'), // ㉖v126 同批末段最小覆盖修剪：pickSuggest 新增依赖，沙箱须一并注入
  grab('function countActive', 'function countBusyLegs'), // ㉖v123 盘点冻结集：pickSuggest 新增 countFrozenSet 依赖，沙箱须一并注入真实函数体（生产库无 counts 时返回空集，行为同旧版）
].join('\n');

const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
const PN = '6608453824', NO = 'LL2026110609390449';
const it0 = db.requisitions.find((x) => x.no === NO).items.find((i) => String(i.partNo).toUpperCase() === PN);
const sugCodes = (it0.sugCodes || []).map((c) => String(c).toUpperCase());
const issAll = (it0.issued || []).map((e) => String(typeof e === 'string' ? e : (e.c || '')).toUpperCase());

const ctx = { console, Math, Number, String, Object, Array, JSON, Set, Map, Boolean, isNaN, parseInt, parseFloat, Date, RegExp, db,
  ledgerView: () => db.ledger }; // 账本已自带 b（批次），无需 printLot 兜底
vm.createContext(ctx);
vm.runInContext(src + '\nglobalThis.__f={pickSuggest,boxKeyOf,groupLedgerBoxes};', ctx);
const F = ctx.__f;

// 该零件账本在架码（含件数/批次），供构造"某时刻已扫集"
const onShelf = db.ledger.filter((x) => String(x.p || '').toUpperCase() === PN).map((x) => ({ c: String(x.c).toUpperCase(), q: Number(x.q) || 0, b: String(x.b || ''), l: x.l }));
const stampedStillOnShelf = sugCodes.filter((c) => onShelf.some((x) => x.c === c)); // 接单盖章过、至今仍在架未扫的框 = 旧版被漂移挤出的那批

console.log('\n盖章框总数=' + sugCodes.length, ' 其中仍在架=' + stampedStillOnShelf.length + ':', stampedStillOnShelf.join('/'));

// ===== 断言1：锁定态下，"已扫一部分"后仍在架的盖章框必须还在 sugAll（不漂移、可继续扫）=====
const _excl1 = new Set(issAll.slice(0, 11)); // 模拟发了11码（复刻10:39前后）
const sg1 = F.pickSuggest(PN, 351 - 230, _excl1, {}, sugCodes); // need=121，正是当时拦138的场景
T('A1 锁定态生效(locked=true)', sg1.locked, true);
const sugAll1 = new Set((sg1.sugAll || []).map((c) => String(c).toUpperCase()));
// 138 当时被拦：它在盖章集、仍在架、且未扫 → A 后必须在 sugAll
const c138 = 'N26J310138';
const unscannedStamped1 = stampedStillOnShelf.filter((c) => !_excl1.has(c));
let missing1 = unscannedStamped1.filter((c) => !sugAll1.has(c));
T('A2 全部「未扫的盖章框」都锁定可扫（含138，不再被挤出）', missing1, []);
T('A3 138 在锁定白名单内（旧版此处误拦）', sugAll1.has(c138), true);

// ===== 断言2：稳定性 —— 随着继续扫码，sugAll 只收缩于"已扫"的，绝不无故丢掉未扫盖章框 =====
const _excl2 = new Set(issAll.slice(0, 14));
const sg2 = F.pickSuggest(PN, 351 - 325, _excl2, {}, sugCodes); // need=26
const sugAll2 = new Set((sg2.sugAll || []).map((c) => String(c).toUpperCase()));
const stillStamped = stampedStillOnShelf.filter((c) => !_excl2.has(c) && onShelf.some((x) => x.c === c));
T('A4 剩余需求极小时，未扫的盖章框仍在 sugAll（够数即停只影响显示，不影响可扫）', stillStamped.every((c) => sugAll2.has(c)), true);

// ===== 断言3：幽灵码（未盖章、非叫车、非建议）仍在 sugAll 之外 → 强制力没被削弱 =====
const ghostCandidates = onShelf.map((x) => x.c).filter((c) => !sugCodes.includes(c));
T('A5 账本里非盖章的在架码（如152/141/11-05新批）不进入锁定白名单', ghostCandidates.every((c) => !sugAll1.has(c)), true);
console.log('  非盖章在架码:', ghostCandidates.join('/'), '—— 这些仍会被严格FIFO拦（符合预期）');

// ===== 断言4：旧单兼容 —— 不传 sugCodes 走原贪心（无 locked）=====
const sgLegacy = F.pickSuggest(PN, 121, new Set(issAll.slice(0, 11)), {}, undefined);
T('A6 无盖章清单(旧单)回落贪心：locked 非真', !!sgLegacy.locked, false);

// ===== 断言5：末框最小化在锁定态不参与（否则又挤框）—— 显示 boxes 应=池内够数即停的前几框，均∈盖章集 =====
const boxCodes = (sg1.boxes || []).flatMap((bx) => (bx.codes || []).map((c) => String(c).toUpperCase()));
T('A7 锁定态显示框全部∈盖章集（不会被末框最小化换成非盖章新框）', boxCodes.every((c) => sugCodes.includes(c)), true);

// ===== 断言6：C 文案分支判据仍在 —— _isLater 由账本批次与最早建议批次比较（此处只验函数不抛异常+返回结构）=====
T('A8 锁定返回含 flatBoxes/total/over/need 结构', ['flatBoxes', 'total', 'over', 'need', 'sugAll'].every((k) => k in sg1), true);

console.log('\n===== v114 FIFO漂移修复验证 ' + (total - fail) + '/' + total + ' 通过 =====');
process.exit(fail ? 1 : 0);
