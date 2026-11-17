// ㉖v199e D6 只导出车辆/交管类事件（用户实锤：AGV异常事件导出混入 FIFO违反/超发确认/幽灵出库 等业务留痕）
// 白名单=告警/恢复/红牌/升级/已认领/堵点/堵点解除/低电/低电恢复/超时；业务kind(无白名单)必须全被排除
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_exp199e');
  const PORT = Number(process.env.EXP_PORT || (8700 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Exp#199', salt, 32).toString('hex') });
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [mkU('u_ad', 'ad_u', '测试管理', 'admin')];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    // 车辆类 + 业务类混装（覆盖用户截图里出现的全部污染 kind）
    const now = Date.now();
    d0.carEvents = [
      { ts: now - 500000, kind: '告警', who: 'AGV06', msg: '车辆告警：钢IO检测到障碍物' },
      { ts: now - 400000, kind: '恢复', who: 'AGV06', msg: '告警已恢复' },
      { ts: now - 300000, kind: '堵点', who: 'AGV08', msg: '交管被卡：13' },
      { ts: now - 299000, kind: '堵点解除', who: 'AGV08', msg: '交管放行' },
      { ts: now - 200000, kind: 'FIFO违反', who: '', msg: '领料单扫入晚批次' },
      { ts: now - 199000, kind: 'FIFO拦截', who: '', msg: '严格FIFO拦截' },
      { ts: now - 190000, kind: '超发确认', who: '', msg: '超发确认放行' },
      { ts: now - 180000, kind: '幽灵出库', who: '', msg: '账本显示已在但查无叫车' },
      { ts: now - 170000, kind: '改位冲突', who: '', msg: '推送被他人更新压过' },
      { ts: now - 160000, kind: '出库台账补建', who: '', msg: '补建台账' },
      { ts: now - 150000, kind: '拉下架账实核对', who: '', msg: 'moved=0 账实不符' },
      { ts: now - 140000, kind: '盘点下架超时', who: '', msg: '盘点腿超时' },
    ];
    d0.carAlarms = []; d0.rcsJam = {}; d0.rcsLowBat = {};
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    const tk = up && (await API('/api/login', { method: 'POST', body: { username: 'ad_u', password: 'Exp#199' } }, null)).token;
    C('护栏 实例启动+登录', up && !!tk, '');
    const j = await API('/api/export?ds=D6&preview=1', {}, tk);
    const rows = j.sample || []; // 预览返回 sample(样例行)+total，非 rows（首版测试取错键=假失败）
    C('R1 D6 导出成功', j.ok === true && Array.isArray(rows), 'total=' + j.total + ' sample=' + rows.length);
    const kinds = new Set(rows.map((r) => String(r[1] || ''))); // 列1=类型
    const want = ['告警', '恢复', '堵点', '堵点解除'];
    const bad = ['FIFO违反', 'FIFO拦截', '超发确认', '幽灵出库', '改位冲突', '出库台账补建', '拉下架账实核对', '盘点下架超时'];
    C('R2 ★★★ 车辆类全保留', want.every((k) => kinds.has(k)), '含=' + [...kinds].join(','));
    C('R3 ★★★ 业务留痕全排除', bad.every((k) => !kinds.has(k)), '混入=' + bad.filter((k) => kinds.has(k)).join(','));
    C('R4 total=车辆类4条（业务8条已剔）', (j.total || 0) === 4, 'n=' + j.total);
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-8).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
