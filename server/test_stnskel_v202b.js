// ㉖v202b /api/rcs/stations 骨架化修复验证（PDA 截图"1-4号台通用/今出今回全0"实锤）
// 根因形态复刻：rcsStations 空表（全空闲常态）+ stnMeta 有真角色 → 旧版返回空 list、
// PDA 行查无数据塌默认"通用"+吞吐0。修后断言：12台恒有行、role=stnMeta 真值、动态字段回落安全。
// CI 稳健化（11-19 selftest 仅 T7 FAIL 实锤·两条竞态都封死）：
// ① 端口撞车：旧版随机 9900+ 且 T7 第二实例撞 PORT+1 → 改 9700 独占段 + 逐端口顺延重试。
// ② 落盘覆盖竞态（真凶）：server 的 SIGINT/SIGTERM 处理器 gracefulExit 会把【内存态 db】flush 回
//    db.json。旧写法"改档→kill→重启"时，第一实例退出存盘把新写的 rcsStations 覆盖回内存旧值；
//    T1~T6 读的是旧库断言不变侥幸全绿，T7 恰读被覆盖掉的 CK-04 → 只有 T7 挂（本地时序快、CI 慢触发）。
//    改法：T7 用【独立数据目录副本】起第二实例，kill 第一实例的存盘与断言彻底解耦，不再依赖时序。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  const TDIR = path.join(__dirname, '_tdata_stn202b');
  const TDIR2 = path.join(__dirname, '_tdata_stn202b_b');
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.rmSync(TDIR2, { recursive: true, force: true });
  // 起服+等就绪；端口被占自动顺延（最多 30 个），返回 {p,s}
  const spawnUp = async (dir, start) => {
    for (let p = start; p < start + 30; p++) {
      const s = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(p), HOST: '127.0.0.1', DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let ok = false;
      for (let i = 0; i < 24 && !ok; i++) { await sleep(250); try { ok = (await fetch('http://127.0.0.1:' + p + '/api/health')).ok; } catch (_) {} }
      if (ok) return { p, s };
      try { s.kill('SIGKILL'); } catch (_) {}
      await sleep(300);
    }
    throw new Error('连续 30 个端口无实例可起（环境异常）');
  };
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now(), D = 864e5;
  const d0 = {
    users: [{ id: 'u_a', username: 'st_u', name: '站台测试', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('St#202', salt, 32).toString('hex') }],
    features: {}, sessions: {}, devices: {}, ops: [], exports: [], requisitions: [], outbound: {}, ledger: [], scanlog: {}, inventories: [], notifications: [],
    rcsStations: {}, // ★ 全空闲常态=空对象（旧版此形态返回空 list）
    rcsConfig: { host: '10.0.0.9', user: 'x', pwd: 'enc1:x' },
    stnMeta: {
      'NB02-CK-01': { alias: '', role: 'in', off: false, by: '系统管理员', at: now },
      'NB02-CK-02': { alias: '急停台', role: 'insp', off: false, by: 'x', at: now },
      'NB02-CK-05': { alias: '', role: 'any', off: true, by: 'x', at: now },
    },
    rcsHoldStat: { 'NB02-CK-01': { sum: 50 * 36, n: 36 } }, // sum/n=50（分钟口径；此前误写 50*86400 致期望 120000）
    agvTasks: { T1: { ck: 'out', ep: 'NB02-CK-03', fin: now - 36e5 }, T2: { ck: 'in', sp: 'NB02-CK-03', fin: now - 72e5 }, T3: { ck: 'out', ep: 'NB02-CK-03', fin: now - 12 * D } }, // 03台今出1(T3昨日剔)
    agvQueue: [], inspects: [],
  };
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  let srv = null, srv2 = null;
  try {
    const r1 = await spawnUp(TDIR, 9700); srv = r1.s; const PORT = r1.p;
    let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
    const tk = (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'st_u', password: 'St#202' }) })).json()).token;
    C('护栏 启动+登录（端口 ' + PORT + '）', !!tk, '');
    const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/rcs/stations', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const byK = {}; (j.stations || []).forEach((x) => { byK[x.station] = x; });
    C('T1 ★★★ 空动态表下恒 12 台全量行（旧版=list空数组→PDA塌默认）', j.ok === true && (j.stations || []).length === 12, 'n=' + (j.stations || []).length);
    C('T2 ★★★ 01台 role=in（stnMeta真值，非"通用"默认）', byK['NB02-CK-01'] && byK['NB02-CK-01'].role === 'in', JSON.stringify(byK['NB02-CK-01'] && { r: byK['NB02-CK-01'].role, a: byK['NB02-CK-01'].alias }));
    C('T3 02台 insp+别名透传；05台 off=true 可被PDA灰显', byK['NB02-CK-02'] && byK['NB02-CK-02'].role === 'insp' && byK['NB02-CK-02'].alias === '急停台' && byK['NB02-CK-05'] && byK['NB02-CK-05'].off === true, '');
    C('T4 吞吐按台挂真值：03台今出1今回1(昨日任务剔除)，01台今出0', byK['NB02-CK-03'] && byK['NB02-CK-03'].todayOut === 1 && byK['NB02-CK-03'].todayIn === 1 && byK['NB02-CK-01'] && byK['NB02-CK-01'].todayOut === 0, JSON.stringify(byK['NB02-CK-03'] && { o: byK['NB02-CK-03'].todayOut, i: byK['NB02-CK-03'].todayIn }));
    C('T5 均清台按台透传(01台=50分)', byK['NB02-CK-01'] && byK['NB02-CK-01'].holdAvg === 50, 'holdAvg=' + (byK['NB02-CK-01'] || {}).holdAvg);
    C('T6 无动态数据的台安全回落(state=空闲,无脏字段)', byK['NB02-CK-09'] && byK['NB02-CK-09'].state === '空闲' && byK['NB02-CK-09'].role === 'any' && Array.isArray(byK['NB02-CK-09'].codes), JSON.stringify(byK['NB02-CK-09'] && { s: byK['NB02-CK-09'].state, r: byK['NB02-CK-09'].role }));
    // T7 动态数据在场照常透出：用【独立目录副本】起第二实例（不共用 TDIR → 第一实例退出存盘覆盖不到它）
    const d2 = JSON.parse(JSON.stringify(d0));
    d2.rcsStations['NB02-CK-04'] = { state: '有货', label: '6608460402', codes: ['BXH1'], since: '2026-11-19 09:00' };
    fs.mkdirSync(TDIR2, { recursive: true });
    fs.writeFileSync(path.join(TDIR2, 'db.json'), JSON.stringify(d2));
    try { srv.kill('SIGKILL'); } catch (_) {}
    srv = null; await sleep(400);
    const r2 = await spawnUp(TDIR2, PORT + 1); srv2 = r2.s;
    const tk2 = (await (await fetch('http://127.0.0.1:' + r2.p + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'st_u', password: 'St#202' }) })).json()).token;
    const j2 = await (await fetch('http://127.0.0.1:' + r2.p + '/api/rcs/stations', { headers: { Authorization: 'Bearer ' + tk2 } })).json();
    const b4 = ((j2.stations || []).find((x) => x.station === 'NB02-CK-04')) || {};
    C('T7 ★★★ 有动态数据的台字段不丢(有货/label/codes透出, 骨架不吃真值·独立目录防覆盖竞态)', b4.state === '有货' && b4.label === '6608460402' && (b4.codes || []).includes('BXH1'), JSON.stringify({ s: b4.state, l: b4.label }));
    C('★ 无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out + ''), '');
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); } finally {
    try { if (srv) srv.kill('SIGKILL'); } catch (_) {}
    try { if (srv2) srv2.kill('SIGKILL'); } catch (_) {}
    await sleep(300);
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(TDIR2, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
