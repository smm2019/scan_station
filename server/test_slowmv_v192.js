// ㉖v192 呆滞排行滞留口径修复（rec→t）· 实例证明
// 现场实锤（11-16 三截图）：红牌 96 框滞留≥14天、库存页"88天5小时"，呆滞排行却"共0种"——三口径打架。
// 根因（账本原文取证）：排行用 Number(l.rec||l.t)，而 rec=账本合并记账时刻（ledgerSync 每次任意设备整表推送即刷
// rec0），生产 842 行里 t≥14天的 113 框【全部】rec<14天 → 排行整体失明。红牌/库存页用 t（登记时刻=物理移动）都对。
// ★真跑理由：修复效果必须用【生产账本实况】证明（排行0→百级、与红牌框数对得上），夹具造不出这个分布。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  // 先离线用生产库复算三口径基线（等值复现截图：红牌96、排行修复前0、修复后>0）
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const now = Date.now();
  let byT = 0, byRec = 0, both = {};
  for (const l of db.ledger || []) {
    const t = Number(l.t) || 0, rec = Number(l.rec) || 0;
    const ageT = Math.floor((now - t) / 864e5), ageR = Math.floor((now - rec) / 864e5);
    if (ageT >= 14) { byT++; both[String(l.p || '').toUpperCase()] = 1; }
    if (ageR >= 14) byRec++;
  }
  C('★★★ 生产实况复现：按t口径≥14天>0 且 按rec口径=0（截图"96框vs0种"的成因分布）', byT > 0 && byRec === 0, `t口径框=${byT} rec口径框=${byRec} 聚合零件种=${Object.keys(both).length}`);

  // 真跑：隔离实例带登录调排行接口，断言修复后返回>0、minDays 参数生效、字段齐
  const crypto = require('crypto');
  const TDIR = path.join(__dirname, '_tdata_slow192');
  const PORT = Number(process.env.SM_PORT || (8400 + Math.floor(Math.random() * 500)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
  { const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const salt = crypto.randomBytes(16).toString('hex');
    db0.users.push({ id: 'u_sm', username: 'sm_u', name: '呆滞测试仓', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: crypto.scryptSync('Sm#192', salt, 32).toString('hex') });
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0)); }
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    C('护栏 实例启动', up, '');
    const tk = up && (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sm_u', password: 'Sm#192' }) })).json()).token;
    C('护栏 登录取 token', !!tk, '');
    const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/slow-moving?minDays=14', { headers: { Authorization: 'Bearer ' + tk } })).json();
    C('★★★ 修复后排行恢复：total>0（截图0种→真实种数）', j.ok === true && j.total > 0, 'total=' + j.total);
    C('★★★ 与离线复算一致（种数=聚合零件数）', j.total === Object.keys(both).length, `接口=${j.total} 复算=${Object.keys(both).length}`);
    const it0 = (j.list || [])[0] || {};
    C('★★ 行字段齐（cells/qty/maxAge/codes 渲染依赖）', ['pn', 'cells', 'qty', 'maxAge', 'codes'].every((k) => it0[k] !== undefined), Object.keys(it0).join(','));
    C('★★ maxAge 与库存页"最长滞留"同量级（≥14且≤400天）', (j.list || []).every((a) => a.maxAge >= 14 && a.maxAge <= 400), 'topMaxAge=' + it0.maxAge);
    const j2 = await (await fetch('http://127.0.0.1:' + PORT + '/api/slow-moving?minDays=60', { headers: { Authorization: 'Bearer ' + tk } })).json();
    C('★★ 阈值参数生效：60天档 ≤ 14天档', j2.ok === true && j2.total <= j.total, `60d=${j2.total} 14d=${j.total}`);
    C('★ 进程无未捕获异常', !/Unhandled|TypeError/.test(out), out.split('\n').slice(-3).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-8).join('\n'));
  } finally {
    srv.kill(); await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
