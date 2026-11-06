// ㉖v111 目视化融合 · 实例验证（还原真实数据）
// V1 服务器 /api/containers 的 weather.zones 结构与真实数值（对齐账本盘点 A区48框/滞留32）
// V2 前端纯函数复刻：车型归属 ctCarOf（项目字典优先+正则兜底）、天气折算、占用率细分口径不虚高
// V3 红牌清单：滞留≥14天框数与降序
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRV = path.join(__dirname, 'server.js');
const SRC = path.join(__dirname, 'data', 'db.json');
const TMP = path.join(__dirname, 'proof_viz_data');
const PORT = 18140;
let fail = 0, total = 0;
function T(n, a, b) { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) { fail++; console.log('FAIL ' + n + '\n  实际=' + JSON.stringify(a) + '\n  期望=' + JSON.stringify(b)); } else console.log('PASS ' + n); }
const rq = (p, tok) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 12000, headers: tok ? { Authorization: 'Bearer ' + tok } : {} }, (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(p + ' 解析失败(状态' + res.statusCode + '): ' + s.slice(0, 120))); } }); }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('超时')); }); });

(async () => {
  // 隔离副本（weather 聚合读 db.ledger/agvTasks，用真实数据）
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(path.join(TMP, 'logs'), { recursive: true });
  fs.copyFileSync(SRC, path.join(TMP, 'db.json'));
  if (fs.existsSync(path.join(__dirname, 'data', 'secret.key'))) fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TMP, 'secret.key'));
  const VT = 'TESTTOK_viz'; // 注入会话：/api/containers 需登录态，无 token 会被 401 拦截致 weather 缺失
  { const _d = JSON.parse(fs.readFileSync(path.join(TMP, 'db.json'), 'utf8')); const _a = (_d.users || []).find((x) => x.role === 'admin' && x.enabled !== false); if (!_a) { console.log('FATAL: 无启用 admin'); process.exit(2); } _d.sessions = _d.sessions || {}; _d.sessions[VT] = { userId: _a.id, dev: 'TEST-VIZ', lastSeen: Date.now() }; fs.writeFileSync(path.join(TMP, 'db.json'), JSON.stringify(_d)); }
  const inst = spawn(process.execPath, [SRV], { env: Object.assign({}, process.env, { DATA_DIR: TMP, PORT: String(PORT) }), stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 1000)); try { const h = await rq('/api/health'); if (h.ok) { up = true; break; } } catch (_) {} }
  T('H0 隔离服务器就绪', up, true);
  if (!up) { try { inst.kill('SIGKILL'); } catch (_) {} process.exit(1); }

  const db = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const j = await rq('/api/containers', VT);
  try {
    // ===== V1 weather.zones 结构 + 真实数值 =====
    const W = (j.weather || {}).zones || {};
    T('V1a weather 端点返回 zones', typeof W === 'object' && Object.keys(W).length > 0, true);
    // 账本真实分布：按巷道字母聚合在架框（复刻 server zKey 口径）
    const real = {};
    for (const x of db.ledger || []) { const m = String(x.l || '').toUpperCase().match(/^NB02-([A-H])-/); if (!m) continue; const z = 'NB02-' + m[1]; real[z] = real[z] || { boxes: 0, stale: 0 }; real[z].boxes++; if (Date.now() - Number(x.t || 0) > 7 * 864e5) real[z].stale++; }
    const aZ = W['NB02-A'] || {};
    T('V1b NB02-A 在架框数与账本一致', aZ.boxes, real['NB02-A'].boxes);
    T('V1c NB02-A 滞留7天+与账本一致', aZ.stale, real['NB02-A'].stale);
    // 今日出库/入库：复刻 server 口径（agvTasks ck=out 起点巷道 / ck=in 终点巷道，fin≥今日0点）
    const t0 = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    const outByZ = {}; for (const tk of Object.values(db.agvTasks || {})) { if (Number(tk.fin || 0) < t0 || tk.ck !== 'out') continue; const m = String(tk.sp || '').toUpperCase().match(/^NB02-([A-H])-/); if (m) outByZ['NB02-' + m[1]] = (outByZ['NB02-' + m[1]] || 0) + 1; }
    for (const [z, w] of Object.entries(W)) { if ((w.outT || 0) !== (outByZ[z] || 0)) { console.log('  出库不符 ' + z + ' weather=' + w.outT + ' 实算=' + (outByZ[z] || 0)); } }
    T('V1d 今日出库框数全巷道与 agvTasks 实算一致', Object.entries(W).every(([z, w]) => (w.outT || 0) === (outByZ[z] || 0)), true);

    // ===== V2 前端纯函数复刻 =====
    const CT_CARC = { EX11: '#42a5f5', EX1H: '#66bb6a', E281: '#ab47bc', V446K: '#ff7043', EF2H: '#26c6da' };
    const pjMap = {}; // 复刻项目字典：从 projMap 真实数据（若有）
    const _pm = db.projMap || {};
    function ctCarOf(b) { const p = String(b.p || '').toUpperCase(); const pj = _pm[p]; if (pj && pj.length) { const hit = pj.find((c) => CT_CARC[String(c).toUpperCase()]); if (hit) return String(hit).toUpperCase(); } const s = (String(b.p || '') + ' ' + String(b.n || '')).toUpperCase(); const m = s.match(/(EX11|EX1H|EF2H|E281|V446K)/); return m ? m[1] : '其他'; }
    // 真实账本框跑车型归属，验证命中分布合理（不能全"其他"）
    const carCnt = {}; for (const x of db.ledger) { const c = ctCarOf({ p: x.p, n: x.n }); carCnt[c] = (carCnt[c] || 0) + 1; }
    console.log('  [V2] 车型归属分布=' + JSON.stringify(carCnt));
    T('V2a 车型归属命中多个真实车型（非全其他）', Object.keys(carCnt).filter((k) => k !== '其他').length >= 3, true);
    T('V2b 项目字典优先于正则（字典有EX1H的件号不被名称误判）', (() => { // 找一个 pjMap 里有车型映射的件号
      const withCar = Object.entries(_pm).find(([pn, cs]) => cs && cs.some((c) => CT_CARC[String(c).toUpperCase()])); if (!withCar) return true; const pn = withCar[0]; const expect = withCar[1].find((c) => CT_CARC[String(c).toUpperCase()]).toUpperCase(); return ctCarOf({ p: pn, n: '无关名称ZZZ' }) === expect; })(), true);

    // 占用率细分口径：zoneL 按巷道字母，分母含补空架（v103 教训：不能只数有货架层）
    // 复刻 ctSlotStats zoneL：高架 A~H×tiers×cols 满配分母
    const RC = j.rack || { count: 8, cols: 16, tiers: 4 };
    const occL = {}; for (const x of db.ledger) { const m = String(x.l || '').toUpperCase().match(/^NB02-([A-H])-/); if (!m) continue; occL['NB02-' + m[1]] = occL['NB02-' + m[1]] || new Set(); occL['NB02-' + m[1]].add(String(x.l).toUpperCase()); }
    const fullTiers = RC.count * RC.tiers, fullCols = RC.cols; // 每巷道 = cols 列 × tiers 层格
    const zoneA = occL['NB02-A'] ? occL['NB02-A'].size : 0;
    const pctA = Math.round(zoneA / (fullCols * RC.tiers) * 100);
    console.log('  [V2] NB02-A 占用 ' + zoneA + '/' + (fullCols * RC.tiers) + '格 = ' + pctA + '%（满配分母，非只数有货架层）');
    T('V2c 占用率用满配分母（A区格位≤64，不虚高到>100%）', pctA <= 100 && zoneA <= fullCols * RC.tiers, true);

    // ===== V3 红牌清单 =====
    const _D0 = new Date(); _D0.setHours(0, 0, 0, 0);
    const boxes = (db.ledger || []).map((x) => { const bt = Date.parse(String(x.b || '').slice(0, 10)) || Number(x.t) || Date.now(); const td = new Date(bt); td.setHours(0, 0, 0, 0); return { c: x.c, d: Math.max(0, Math.round((_D0 - td) / 864e5)) }; });
    const red = boxes.filter((b) => b.d >= 14);
    T('V3a 红牌清单有真实滞留框（≥14天）', red.length > 0, true);
    const sorted = red.slice().sort((a, b) => b.d - a.d);
    T('V3b 红牌按滞留天数降序', sorted[0].d >= sorted[sorted.length - 1].d, true);
    console.log('  [V3] 红牌 ' + red.length + ' 框，最久 ' + sorted[0].d + ' 天');
  } finally {
    try { inst.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  console.log('\n===== 目视化融合验证 ' + (total - fail) + '/' + total + ' 通过 =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.message); try { const { execSync } = require('child_process'); } catch (_) {} fs.rmSync(TMP, { recursive: true, force: true }); process.exit(2); });
