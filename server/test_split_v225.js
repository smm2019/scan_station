// ㉖v225 拆框能力 端到端验证（服务端契约；隔离实例，生产库零写入）
// 背景：整托登记后现场要"拆框分位"根本拆不动（11-23 N26J220047 实锤）。三层焊点：
//   ①PDA push 只要缓存带旧托号就焊住；②服务器 5044 多机字段保护把空托号又继承回来；③同托/同件兄弟连坐搬位。
// 修法：协议约定 PDA 对"人工确认拆出"的框显式发 pid:""（空串）。服务器：
//   ①显式空串 → 新行 pid 清空（真拆出）；②缺 pid 字段（旧PDA/普通重登）→ 照常继承旧托号（v99 语义不变）；
//   ③带拆框声明的框改位不再拖同托/同件兄弟连坐。本测试一次 POST 用 A/B/C/D 四组独立标签覆盖全场景。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_sp_v225'), PORT = Number(process.env.HS_PORT || 9955);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 150) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
(async () => {
  let srv;
  const killTree = () => { try { if (srv && srv.exitCode === null) cp.execSync(`taskkill /pid ${srv.pid} /T /F`, { stdio: 'ignore', windowsHide: true }); } catch (_) {} };
  try {
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    const probe = await Promise.race([
      fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1200) }).then(() => 'busy')
        .catch((e) => ((e && (e.name === 'AbortError' || e.name === 'TimeoutError')) ? 'busy' : 'free')),
      sleep(1800).then(() => 'free')
    ]);
    if (probe === 'busy') throw new Error('端口 ' + PORT + ' 被占用——HS_PORT 换端口重跑');
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!225';
    // 四组各占一格，两框同托同格同件：A=旧PDA改位(应继承+兄弟连坐) B=声明改位(应清托+兄弟不动)
    // C=声明不改位(仅摘托号) D=旧PDA不改位(应继承=多机字段保护不破)
    const row = (c, pid, l, p, t) => ({ c, pid, l, p, n: p, q: 1000, f: '纸箱', mv: '人工', src: l, t, by: '首登', rec: t });
    const T0 = Date.now() - 900000;
    const db0 = {
      users: [{ id: 'u_sp225', username: 'sp_u', name: '拆框测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [],
      requisitions: [], outbound: {}, scanlog: {}, agvQueue: [], agvTasks: {}, carEvents: [], inspects: [],
      features: { material: {}, warehouse: { collect: true }, inspector: {}, admin: { collect: true, location_reg: true, agv_control: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {},
      ledger: [
        row('SIB1A', 'TPA', 'NB03-E-16-05', 'PNA', T0), row('SIB2A', 'TPA', 'NB03-E-16-05', 'PNA', T0),
        row('SIB1B', 'TPB', 'NB03-F-16-05', 'PNB', T0), row('SIB2B', 'TPB', 'NB03-F-16-05', 'PNB', T0),
        row('SIB1C', 'TPC', 'NB03-G-16-05', 'PNC', T0), row('SIB2C', 'TPC', 'NB03-G-16-05', 'PNC', T0),
        row('SIB1D', 'TPD', 'NB03-H-16-05', 'PND', T0), row('SIB2D', 'TPD', 'NB03-H-16-05', 'PND', T0),
      ],
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'sp_u', password: PW, dev: 'SP', kind: 'pda' })).json.token;
    C('护栏 管理员登录', !!tk); if (!tk) throw new Error('登录失败');

    // 改位/摘托必须带【新登记时刻】：v186 旧骨架改位闸会拦"t 不新于服务器"的回灌
    //（该闸防的正是 N26J220047 骨架覆盖事故，测试如实模拟现场重扫重登=新时刻）
    const T1 = Date.now();
    const items = [
      { c: 'SIB1A', l: 'NB02-A-01-1F', p: 'PNA', q: 1000, f: '纸箱', mv: '人工', t: T1 },                         // 无 pid 字段=旧PDA改位
      { c: 'SIB1B', l: 'NB02-A-02-1F', p: 'PNB', q: 1000, f: '纸箱', mv: '人工', t: T1, pid: '' },                 // 声明改位
      { c: 'SIB1C', l: 'NB03-G-16-05', p: 'PNC', q: 1000, f: '纸箱', mv: '人工', t: T1, pid: '' },                 // 声明重登（目标=原位，仅摘托号）
      { c: 'SIB1D', l: 'NB03-H-16-05', p: 'PND', q: 1000, f: '纸箱', mv: '人工', t: T0 },                          // 无 pid 字段不改位
    ];
    const rs = await post('/api/ledger/sync', tk, { items, del: [], epoch: '' });
    C('护栏 同步被受理', rs.json.ok === true, JSON.stringify(rs.json).slice(0, 120));
    C('护栏 无货位冲突拒回', !Array.isArray(rs.json.rejected) || rs.json.rejected.length === 0, JSON.stringify(rs.json.rejected || []));

    // 从磁盘读回落库账本逐行断言（saveDbAsync 防抖异步落盘：轮询等 C 组清托落账再读，防读到旧文件假失败）
    let dbA = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); } catch (_) { continue; }
      const _c = (dbA.ledger || []).find((x) => String(x.c).toUpperCase() === 'SIB1C');
      if (_c && String(_c.pid || '') === '') break;
    }
    const L = {}; for (const x of (dbA ? dbA.ledger : [])) L[String(x.c).toUpperCase()] = x;
    const pidOf = (k) => (L[k] ? String(L[k].pid || '') : '(缺行)');
    const locOf = (k) => (L[k] ? String(L[k].l || '') : '(缺行)');

    // ★ 组A：旧PDA缺字段改位 → 继承旧托号 + 同托兄弟连坐搬位（v99/v198 旧行为逐字回归）
    C('★★ ① 旧PDA缺pid改位→SIB1A 继承旧托号 TPA（不被洗空）', pidOf('SIB1A') === 'TPA', 'pid=' + pidOf('SIB1A'));
    C('★★ ① 旧PDA改位→SIB1A 改到新货架格', locOf('SIB1A') === 'NB02-A-01-1F', 'l=' + locOf('SIB1A'));
    C('★★ ② 同托未声明→兄弟 SIB2A 照常连坐搬到同格', locOf('SIB2A') === 'NB02-A-01-1F' && pidOf('SIB2A') === 'TPA', 'l=' + locOf('SIB2A') + ' pid=' + pidOf('SIB2A'));

    // ★★★ 组B：声明拆框改位 → 本框清托号 + 兄弟不连坐（v225 核心）
    C('★★★ ③ 拆框声明(pid:"")→SIB1B 托号被清空（真拆出）', pidOf('SIB1B') === '', 'pid=[' + pidOf('SIB1B') + ']');
    C('★★★ ③ 拆框声明→兄弟 SIB2B 留在原格不被拖走', locOf('SIB2B') === 'NB03-F-16-05' && pidOf('SIB2B') === 'TPB', 'l=' + locOf('SIB2B') + ' pid=' + pidOf('SIB2B'));
    C('★★ ③ 拆框框改位落库到目标货架格', locOf('SIB1B') === 'NB02-A-02-1F', 'l=' + locOf('SIB1B'));

    // ★★★ 组C：声明拆框不改位 → 仅摘托号，兄弟原地不动（现场"两木箱先各自独立"第一步）
    C('★★★ ④ 拆框声明(不改位)→SIB1C 托号清空、货位不变', pidOf('SIB1C') === '' && locOf('SIB1C') === 'NB03-G-16-05', 'pid=[' + pidOf('SIB1C') + '] l=' + locOf('SIB1C'));
    C('★★★ ④ 兄弟 SIB2C 托号/货位纹丝未动', pidOf('SIB2C') === 'TPC' && locOf('SIB2C') === 'NB03-G-16-05', 'pid=' + pidOf('SIB2C') + ' l=' + locOf('SIB2C'));

    // ★ 组D：旧PDA缺字段不改位 → 继承旧托号（v99 多机字段保护零回归，最防"洗数据"）
    C('★★ ⑤ 旧PDA缺pid不改位→SIB1D 继承 TPD 不被洗', pidOf('SIB1D') === 'TPD' && locOf('SIB1D') === 'NB03-H-16-05', 'pid=' + pidOf('SIB1D'));
    C('★ D组兄弟 SIB2D 不受影响', pidOf('SIB2D') === 'TPD' && locOf('SIB2D') === 'NB03-H-16-05', 'pid=' + pidOf('SIB2D'));

    C('★ 进程存活', (await fetch(BASE + '/api/health')).ok === true);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    killTree();
    await sleep(400);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
