// ㉖v202b /api/rcs/stations 骨架化修复验证（PDA 截图"1-4号台通用/今出今回全0"实锤）
// 根因形态复刻：rcsStations 空表（全空闲常态）+ stnMeta 有真角色 → 旧版返回空 list、
// PDA 行查无数据塌默认"通用"+吞吐0。修后断言：12台恒有行、role=stnMeta 真值、动态字段回落安全。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  const TDIR = path.join(__dirname, '_tdata_stn202b');
  const PORT = Number(process.env[process.env.TZ === 'UTC' ? 'TZ_PORT' : 'ST_PORT'] || (9900 + Math.floor(Math.random() * 40)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
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
    rcsHoldStat: { 'NB02-CK-01': { sum: 50 * 36, n: 36 } }, // sum/n=50（分钟口径，修夹具此前 50*86400 算错致期望 120000）
    agvTasks: { T1: { ck: 'out', ep: 'NB02-CK-03', fin: now - 36e5 }, T2: { ck: 'in', sp: 'NB02-CK-03', fin: now - 72e5 }, T3: { ck: 'out', ep: 'NB02-CK-03', fin: now - 12 * D } }, // 3台今出1(T3昨日剔)
    agvQueue: [], inspects: [],
  };
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    const tk = up && (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'st_u', password: 'St#202' }) })).json()).token;
    C('护栏 启动+登录', up && !!tk, '');
    const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/rcs/stations', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const byK = {}; (j.stations || []).forEach((x) => { byK[x.station] = x; });
    C('T1 ★★★ 空动态表下恒 12 台全量行（旧版=list空数组→PDA塌默认）', j.ok === true && (j.stations || []).length === 12, 'n=' + (j.stations || []).length);
    C('T2 ★★★ 01台 role=in（stnMeta真值，非"通用"默认）', byK['NB02-CK-01'] && byK['NB02-CK-01'].role === 'in', JSON.stringify(byK['NB02-CK-01'] && { r: byK['NB02-CK-01'].role, a: byK['NB02-CK-01'].alias }));
    C('T3 02台 insp+别名透传；05台 off=true 可被PDA灰显', byK['NB02-CK-02'] && byK['NB02-CK-02'].role === 'insp' && byK['NB02-CK-02'].alias === '急停台' && byK['NB02-CK-05'] && byK['NB02-CK-05'].off === true, '');
    C('T4 吞吐按台挂真值：03台今出1今回1(昨日任务剔除)，01台今出0', byK['NB02-CK-03'] && byK['NB02-CK-03'].todayOut === 1 && byK['NB02-CK-03'].todayIn === 1 && byK['NB02-CK-01'] && byK['NB02-CK-01'].todayOut === 0, JSON.stringify(byK['NB02-CK-03'] && { o: byK['NB02-CK-03'].todayOut, i: byK['NB02-CK-03'].todayIn }));
    C('T5 均清台按台透传(01台=50分)', byK['NB02-CK-01'] && byK['NB02-CK-01'].holdAvg === 50, 'holdAvg=' + (byK['NB02-CK-01'] || {}).holdAvg);
    C('T6 无动态数据的台安全回落(state=空闲,无脏字段)', byK['NB02-CK-09'] && byK['NB02-CK-09'].state === '空闲' && byK['NB02-CK-09'].role === 'any' && Array.isArray(byK['NB02-CK-09'].codes), JSON.stringify(byK['NB02-CK-09'] && { s: byK['NB02-CK-09'].state, r: byK['NB02-CK-09'].role }));
    // 动态数据在场时照常透出（有货台的 label/codes 不丢）
    d0.rcsStations['NB02-CK-04'] = { state: '有货', label: '6608460402', codes: ['BXH1'], since: '2026-11-19 09:00' };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
    srv.kill(); await sleep(600);
    const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT + 1), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch('http://127.0.0.1:' + (PORT + 1) + '/api/health')).ok; } catch (_) {} }
    const tk2 = up2 && (await (await fetch('http://127.0.0.1:' + (PORT + 1) + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'st_u', password: 'St#202' }) })).json()).token;
    const j2 = await (await fetch('http://127.0.0.1:' + (PORT + 1) + '/api/rcs/stations', { headers: { Authorization: 'Bearer ' + tk2 } })).json();
    const b4 = ((j2.stations || []).find((x) => x.station === 'NB02-CK-04')) || {};
    C('T7 ★★★ 有动态数据的台字段不丢(有货/label/codes透出, 骨架不吃真值)', b4.state === '有货' && b4.label === '6608460402' && (b4.codes || []).includes('BXH1'), JSON.stringify({ s: b4.state, l: b4.label }));
    C('★ 无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out + ''), '');
    try { srv2.kill(); } catch (_) {}
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400); try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
