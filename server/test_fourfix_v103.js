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
const bf = byFix(d.ledger, d.seenIn, d.users);
T('B1 全库命中497行（503被洗-6系统管理员回填署名，真人署名可修）', bf.n, 497);
T('B2 系统管理员署名排除（回填非真人）', bf.out.some((e) => e.to === '系统管理员'), false);
T('B3 移过位的行不动（判据②）', (() => { // 抽验：出生位≠当前位的行绝不出现在修复集
  const fixed = new Set(bf.out.map((e) => e.c));
  for (const x of d.ledger || []) { const si = (d.seenIn || {})[String(x.c).toUpperCase()]; if (si && String(si.l || '').toUpperCase() !== String(x.l || '').toUpperCase() && fixed.has(String(x.c).toUpperCase())) return false; }
  return true;
})(), true);
const bf2 = byFix(bf.out.length ? (d.ledger || []).map((x) => { const f = bf.out.find((e) => e.c === String(x.c).toUpperCase()); return f ? { ...x, by: f.to } : x; }) : d.ledger, d.seenIn, d.users);
T('B4 修复后二次跑幂等（0命中）', bf2.n, 0);
const x90 = (d.ledger || []).find((y) => y.c === 'N26J270462');
T('B5 270462 现网实况（by已被后续推送洗回？当前值）', x90 && x90.by, '刘向轩'); // 若已被修回刘向轩=11/3后无人洗；被洗则在修复集内

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
const oc = occStats(d.ledger, rackCfg, gndCfg);
T('C1 NB02 分母=满配512（8架×4层×16列）', oc.zoneSt.NB02.t, 512);
T('C2 NB02 占用率=46%（旧口径69%虚高23点）', Math.round(oc.zoneSt.NB02.u / oc.zoneSt.NB02.t * 100), 46);
T('C3 NB02 已用格数不变（分子不受影响）', oc.zoneSt.NB02.u, 238);
T('C4 NB03 分母含补空排（≥1728）', oc.zoneSt.NB03.t >= 1728, true);
T('C5 总格位=两区之和自洽', oc.total, oc.zoneSt.NB02.t + oc.zoneSt.NB03.t);

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
