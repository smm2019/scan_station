// ㉖v234 地面自动分格·同件豁免收紧（v225 叠格洞的服务端镜像）端到端验证（隔离实例，生产库零写入）
// 现场（11-23 N26J220042/47）：PDA 拆框后重采走"人工选排+服务器自动分格"，旧口径"同零件=同框"
//   把拆出的框自动分回旧账叠格（幂等回现位+占用豁免双通道）。收紧为：同件仅当与格内他框有
//   【共同非空托号】才算同框双码可共格；托号任一缺失一律视为占用，强制分新格。
// 夹具（F-11 排 8 格，账本只造一个"案发现场"格）：03 格=合法双码住户 A1/A2(共托 TPX) +
//   拆框违例者 C(pid='')叠在里面。断言值无关（不手算排号）：
//   A1 请求 → 幂等回 03 kept=true（合法住户不被违例者连累——端到端①抓出的半成品误伤点）
//   C  请求 → 必迁离 03 分新格，重请求幂等复用新格（现场主案 N26J220042）
//   D(同件无托号)/E(异件新码) → 各得空格且与住户/违例者零重叠（同件绝不共格）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_gnd_v234'), PORT = Number(process.env.HS_PORT || 9966);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 140) + ']' : ''}`); };
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
    const salt = crypto.randomBytes(16).toString('hex'), PW = 'E2e#Hs!234';
    const now = Date.now(), t0 = now - 86400000;
    const row = (c, l, p, pid) => ({ c, l, p, n: '测试件', q: 100, f: '纸箱', mv: '人工', src: l, pid, t: t0, rec: t0, by: '首登' });
    const db0 = {
      users: [{ id: 'u_gn234', username: 'gnd_u', name: '地面分格测试', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync(PW, salt, 32).toString('hex') }],
      sessions: {}, devices: {}, ops: [], notifications: [],
      requisitions: [], outbound: {}, scanlog: {}, agvQueue: [], inspects: [], seenIn: {}, seenOut: {},
      features: { material: {}, warehouse: { collect: true }, inspector: {}, admin: { collect: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {},
      groundSlots: { 'NB03-F-11': 8 },
      ledger: [
        row('NGA0000001', 'NB03-F-11-03', 'PNX', 'TPX'), row('NGA0000002', 'NB03-F-11-03', 'PNX', 'TPX'),
        row('NGC0000001', 'NB03-F-11-03', 'PNX', ''),
      ],
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'gnd_u', password: PW, dev: 'GN', kind: 'pda' })).json.token;
    C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');
    const rv = (code, partNo, pid) => post('/api/ledger/reserve', tk, { code, partNo, zone: 'F11', ...(pid ? { pid } : {}) });

    const rA = await rv('NGA0000001', 'PNX', 'TPX');
    C('★★★ ① 合法双码住户(共托TPX伙伴在03格)→幂等回现位03，绝不被同格违例者连累踢走', rA.json.ok === true && rA.json.loc === 'NB03-F-11-03' && rA.json.kept === true, JSON.stringify(rA.json));

    const rC = await rv('NGC0000001', 'PNX');
    const slotC = rC.json.loc || '';
    C('★★★ ② 拆框违例者(托号空与住户叠03)→幂等回现位被叠格例外拦截→强制迁离03分新格（★现场主案）', rC.json.ok === true && slotC !== 'NB03-F-11-03' && /^NB03-F-11-\d\d$/.test(slotC) && rC.json.kept !== true, JSON.stringify(rC.json));

    const rC2 = await rv('NGC0000001', 'PNX');
    C('★★ ③ 违例者重请求→幂等复用刚迁到的新格不二次跳格', rC2.json.ok === true && rC2.json.loc === slotC && rC2.json.kept === true, JSON.stringify(rC2.json));

    const rD = await rv('NGD0000001', 'PNX');
    C('★★★ ④ 同件无托号新码→绝不与03格住户共格(收紧豁免)，另得空格≠03≠违例者格', rD.json.ok === true && rD.json.loc !== 'NB03-F-11-03' && rD.json.loc !== slotC && /^NB03-F-11-\d\d$/.test(rD.json.loc || ''), JSON.stringify(rD.json));

    const rE = await rv('NGE0000001', 'PNY');
    const setE = [rA.json.loc, slotC, rD.json.loc, rE.json.loc];
    C('★★ ⑤ 异件新码→各框各格零重叠（03住户/违例者/同件/异件四者格号互不相同）', rE.json.ok === true && new Set(setE).size === 4, JSON.stringify(setE));

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
