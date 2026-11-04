// ㉖v103 四项修复（格数上限/占用率/登记人/库存页布局）· 判据复刻 + 现场数据回放
const d = require('./data/db.json');
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }

console.log('===== A. 登记人保留判据（合并端新语义）=====');
// 复刻：货位没变→保留原 by；新行/改位→写推送人
function mergeBy(old, it, pushUser) { return (old && String(old.l || '').toUpperCase() === String(it.l || '').toUpperCase()) ? (String(old.by || '') || pushUser) : pushUser; }
T('A1 同位重推（字段修正）保留原登记人', mergeBy({ l: 'NB03-E-11-55', by: '刘向轩' }, { l: 'NB03-E-11-55', f: '塑料筐' }, '胡明锵'), '刘向轩');
T('A2 改位→登记人=推送人（新位置新登记）', mergeBy({ l: 'NB02-A-01-1F', by: '刘向轩' }, { l: 'NB02-B-05-2F' }, '胡明锵'), '胡明锵');
T('A3 新行→登记人=推送人', mergeBy(null, { l: 'NB03-C-02-05' }, '宋明明'), '宋明明');
T('A4 原by为空→兜底推送人', mergeBy({ l: 'NB03-C-02-05', by: '' }, { l: 'NB03-C-02-05' }, '宋明明'), '宋明明');
T('A5 大小写货位一致也保留', mergeBy({ l: 'nb03-c-02-05', by: '卫革' }, { l: 'NB03-C-02-05' }, '金先发'), '卫革');
// 270462 事故回放：刘向轩扫入→胡明锵设备重推 f 字段修正
T('A6 事故回放：270462 被胡明锵重推后仍=刘向轩', mergeBy({ l: 'NB03-E-11-55', by: '刘向轩' }, { l: 'NB03-E-11-55', f: '华强塑料筐', mv: '人工' }, '胡明锵'), '刘向轩');

console.log('\n===== B. 存量登记人修复迁移判据（复刻 ledgerByFixV103）=====');
function byFix(ledger, seenIn, users) {
  const names = new Set((users || []).map((x) => String(x.name || '')));
  let n = 0; const out = [];
  for (const x of ledger || []) {
    const c = String(x.c || '').toUpperCase(), si = (seenIn || {})[c];
    if (!si || !si.by || !names.has(si.by) || si.by === '系统管理员') continue;
    if (String(si.l || '').toUpperCase() !== String(x.l || '').toUpperCase()) continue;
    if (String(x.by || '') === si.by) continue;
    out.push({ c, from: x.by, to: si.by }); n++;
  }
  return { n, out };
}
// ㉖v105 取证加固：主库已被生产服务跑过 ledgerByFixV103（被洗行=0）——构造【修复前态】副本：
// 把"出生位=当前位、出生by=真人（非系统管理员）"的行 by 洗成金先发（模拟推送人覆盖），命中数=注入数
const dPre = JSON.parse(JSON.stringify(d));
let _nWash = 0;
{
  const names = new Set((dPre.users || []).map((x) => String(x.name || '')));
  for (const x of dPre.ledger || []) {
    const si = (dPre.seenIn || {})[String(x.c).toUpperCase()];
    if (!si || !si.by || !names.has(si.by) || si.by === '系统管理员' || si.by === '金先发') continue;
    if (String(si.l || '').toUpperCase() !== String(x.l || '').toUpperCase()) continue;
    x.by = '金先发'; _nWash++;
  }
}
const bf = byFix(dPre.ledger, dPre.seenIn, dPre.users);
T('B1 修复前态命中=注入被洗行数' + _nWash + '（三重判据零误伤）', bf.n, _nWash);
T('B2 系统管理员署名排除（回填非真人）', bf.out.some((e) => e.to === '系统管理员'), false);
T('B3 移过位的行不动（判据②）', (() => { // 抽验：出生位≠当前位的行绝不出现在修复集
  const fixed = new Set(bf.out.map((e) => e.c));
  for (const x of dPre.ledger || []) { const si = (dPre.seenIn || {})[String(x.c).toUpperCase()]; if (si && String(si.l || '').toUpperCase() !== String(x.l || '').toUpperCase() && fixed.has(String(x.c).toUpperCase())) return false; }
  return true;
})(), true);
const bf2 = byFix(bf.out.length ? (dPre.ledger || []).map((x) => { const f = bf.out.find((e) => e.c === String(x.c).toUpperCase()); return f ? { ...x, by: f.to } : x; }) : dPre.ledger, dPre.seenIn, dPre.users);
T('B4 修复后二次跑幂等（0命中）', bf2.n, 0);
T('B5 主库现态=已修正（被洗行=0，两态闭环）', byFix(d.ledger, d.seenIn, d.users).n, 0);
const x90 = (d.ledger || []).find((y) => y.c === 'N26J270462');
T('B6 事故标签270462 现网登记人=刘向轩（不可变事实）', x90 && x90.by, '刘向轩');

console.log('\n===== C. 占用率分母补空架（复刻 ctSlotStats 新口径）=====');
const P = (k, def) => (d.params || {})[k] !== undefined ? (d.params || {})[k] : def;
function occStats(ledger, rackCfg, gndCfg) {
  const byBox = {};
  for (const x of ledger || []) { const L = String(x.l || '').toUpperCase(); (byBox[L] = byBox[L] || []).push(x); }
  const rows = {};
  for (const [loc, boxes] of Object.entries(byBox)) {
    const p = loc.split('-'); if (p.length < 4) continue;
    const tier = p.slice(3).join('-'), rack = /\dF$/.test(tier);
    const rowid = rack ? p[0] + '-' + p[1] : p.slice(0, 3).join('-');
    const label = rack ? rowid + ' · ' + tier : rowid + ' 排';
    const col = rack ? (Number(p[2]) || 0) : (Number(tier) || 0);
    const R = rows[label] = rows[label] || { zone: p[0], rack, rowid, cells: {}, max: 0 };
    R.cells[col] = { loc, boxes }; if (col > R.max) R.max = col;
  }
  // 地面补空排（旧逻辑保留）
  const G = gndCfg || {}, gZr = G.zoneRows || {}, gList = G.lists || {}, gOff = G.offs || {};
  const rowsOfZone = (z) => { const v = gZr[z]; return v === undefined || v === null || !Number.isFinite(Number(v)) ? Math.max(1, Number(G.rows) || 18) : Math.max(0, Number(v) || 0); };
  const rowsArrOf = (z) => { const l = gList[z]; if (Array.isArray(l) && l.length) return l.map((r) => Number(r)); return Array.from({ length: rowsOfZone(z) }, (_, i) => i + 1); };
  const zn = new Set(); Object.values(rows).forEach((R) => { if (!R.rack) zn.add(R.rowid.split('-').slice(0, 2).join('-')); });
  Object.keys(gList).forEach((z) => { if (Array.isArray(gList[z]) && gList[z].length) zn.add('NB03-' + z); });
  Object.keys(gZr).forEach((z) => { if (Number(gZr[z]) > 0) zn.add('NB03-' + z); });
  if (Object.keys(gOff).length || Object.keys(gZr).length || Object.keys(gList).length || G.rows) {
    zn.forEach((rowid) => { const z = String(rowid).split('-')[1] || ''; rowsArrOf(z).forEach((i) => { const rowid2 = rowid + '-' + String(i).padStart(2, '0'); const label = rowid2 + ' 排'; if (!rows[label]) rows[label] = { zone: rowid.split('-')[0], rack: false, rowid: rowid2, tier: String(i), cells: {}, max: 0, off: !!gOff[rowid2], over: false }; }); });
  }
  // ㉖v103 高架补空架空层（新）
  const RK = rackCfg || {}; const rc = Math.min(8, Math.max(1, Number(RK.count) || 8)), rt = Math.max(1, Number(RK.tiers) || 4), RL = 'ABCDEFGH';
  for (let zi = 0; zi < rc; zi++) { const z = RL[zi]; for (let t = 1; t <= rt; t++) { const rowid = 'NB02-' + z, tier = t + 'F', label = rowid + ' · ' + tier; if (!rows[label]) rows[label] = { zone: 'NB02', rack: true, rowid, tier, cells: {}, max: 0 }; } }
  const rackMax = {}; Object.values(rows).forEach((R) => { if (R.rack) rackMax[R.rowid] = Math.max(rackMax[R.rowid] || 0, R.max); });
  const zoneSt = {}; let total = 0, used = 0;
  Object.keys(rows).forEach((k) => { const R = rows[k];
    R.hi = R.rack ? Math.max(RK.cols || 0, rackMax[R.rowid] || R.max) : Math.max(R.max, Number((G.slots || {})[R.rowid]) || G.cols || 12);
    if (R.off) return;
    const n = R.hi, o = Object.keys(R.cells).length; total += n; used += o;
    const z = zoneSt[R.zone] = zoneSt[R.zone] || { t: 0, u: 0 }; z.t += n; z.u += o; });
  return { zoneSt, total, used };
}
const rackCfg = { count: P('rackCount', 8), cols: P('rackCols', 16), tiers: P('rackTiers', 4) };
const gndCfg = { rows: P('gndRows', 18), cols: P('gndCols', 12), zoneRows: d.gndZoneRows || {}, lists: d.gndZoneList || {}, offs: d.gndRowOff || {}, slots: d.groundSlots || {} };
// ㉖v105 取证加固：占用率分子随账本每天变动，"46%/238"这类实况值不能写死。
// 用【合成账本】做确定性断言：只放 A架1层1列 一个框 → 分母必=512（8架×4层×16列）、分子=1、占用率=0%（1/512）
const synthLed = [{ c: 'SYN00000001', l: 'NB02-A-01-1F', q: 10 }];
const ocS = occStats(synthLed, rackCfg, { rows: 0, cols: 12, zoneRows: {}, lists: {}, offs: {}, slots: {} });
T('C1 合成账本：NB02 分母=满配512（8架×4层×16列，空架空层全补齐）', ocS.zoneSt.NB02.t, 512);
T('C2 合成账本：分子=1（仅A架1层1列有框）', ocS.zoneSt.NB02.u, 1);
// 合成两框占两格 → 2/512=0%；再验证补架后旧口径对照（只数有货层=1层×16列=16，1/16=6% 虚高）
const ocS2 = occStats([{ c: 'S1', l: 'NB02-A-01-1F', q: 1 }, { c: 'S2', l: 'NB02-A-02-1F', q: 1 }], rackCfg, { rows: 0, cols: 12, zoneRows: {}, lists: {}, offs: {}, slots: {} });
T('C3 合成两框：分子=2、分母仍512（补架不随有货层数变化）', [ocS2.zoneSt.NB02.u, ocS2.zoneSt.NB02.t], [2, 512]);
// 主库实况：只做自洽断言（不锁会漂移的具体数值）
const oc = occStats(d.ledger, rackCfg, gndCfg);
T('C4 主库分母恒=512+地面满配（结构自洽，与账本内容无关）', oc.zoneSt.NB02.t, 512);
T('C5 主库分子≤分母且>0（占用率合法区间）', oc.zoneSt.NB02.u > 0 && oc.zoneSt.NB02.u <= oc.zoneSt.NB02.t, true);
T('C6 主库占用率必低于旧口径（分母补大分子不变）', (() => {
  // 旧口径=只数有货架层：按主库现算有货层数×16
  const layers = new Set();
  for (const x of d.ledger || []) { const p = String(x.l || '').toUpperCase().split('-'); if (p[0] === 'NB02' && p.length >= 4 && /\dF$/.test(p.slice(3).join('-'))) layers.add(p[0] + '-' + p[1] + '-' + p.slice(3).join('-')); }
  const oldDen = layers.size * (rackCfg.cols || 16);
  return oc.zoneSt.NB02.u / oc.zoneSt.NB02.t < oc.zoneSt.NB02.u / oldDen;
})(), true);

console.log('\n===== D. 格数上限 60→200（三端口径一致）=====');
const fs = require('fs'), path = require('path');
const sv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), pd = fs.readFileSync(path.join(__dirname, '../lib/location_reg_page.dart'), 'utf8'), web = fs.readFileSync(path.join(__dirname, 'public/console.html'), 'utf8');
T('D1 服务器保存校验 1~200', /v < 1 \|\| v > 200\) \{ delete db\.groundSlots\[k\]/.test(sv), true);
T('D2 服务器参数 max=200', /gndCols:.*max: 200/.test(sv), true);
T('D3 PDA 单排输入校验 1~200', /v < 1 \|\| v > 200/.test(pd) && /格数需 1~200/.test(pd), true);
T('D4 PDA 批量校验 1~200', /批量格数需 1~200/.test(pd), true);
T('D5 PDA 加钮上限 200', /rows\[k\]! < 200/.test(pd), true);
T('D6 网页校验 c>200', /c<1\|\|c>200/.test(web), true);
T('D7 网页正则支持三位数', /\(\\d\{1,3\}\)\$/.test(web), true);
T('D8 三端无残留"格数1~60"表述（rackCols/分钟等无关60参数不算）', /(格数需 1~60|批量格数需 1~60|格数 1~60|1~60 外=恢复|hintText: "1~60"|c<1\|\|c>60\b|v > 60\) \{ delete db\.groundSlots|if \(rows\[k\]! < 60\))/.test(sv + pd + web), false);

console.log('\n===== E. 库存页分散度移除（源码判据）=====');
const iv = fs.readFileSync(path.join(__dirname, '../lib/inventory_stock_page.dart'), 'utf8');
T('E1 按分散度chip已删（无 chip(\'loc\' 调用、无 loc 状态值；注释文字不算）', /chip\('loc'|_flt == "loc"|_flt = "loc"/.test(iv), false);
T('E2 _flt=="loc" 排序分支已删', /_flt == "loc"/.test(iv), false);
T('E3 chip行改 Wrap 换行布局', /child: Wrap\(spacing: 6, runSpacing: 6/.test(iv), true);
T('E4 缺料分享按钮仍在（未误删）', /缺料分享/.test(iv), true);
T('E5 项目下拉仍在', /全部项目/.test(iv), true);

console.log(fail === 0 ? '\n===== 全部 PASS，合计 ' + total + ' 项 =====' : '\n===== ' + fail + '/' + total + ' 失败 =====');
process.exit(fail === 0 ? 0 : 1);
