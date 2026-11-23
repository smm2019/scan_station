// ㉖v232 消息详情·单条已读端点 端到端验证（隔离实例，生产库零写入）
// 背景：消息中心改造（用户点名两端：①点消息进详情 ②据内容跳功能）。Web 详情页点开即单条已读，
//   服务端补 /api/notifications/read。红线=只动本人消息——夹具故意让 u_self 与 u_other 的消息用同一个 id。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, '_ro_v232'), PORT = Number(process.env.HS_PORT || 9965);
const BASE = 'http://127.0.0.1:' + PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 140) + ']' : ''}`); };
const post = async (p2, tk, body) => { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const get2 = async (p2, tk) => { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
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
    const mk = (id, name, role) => { const salt = crypto.randomBytes(16).toString('hex'); return { id, username: id, name, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('E2e#Ro!232', salt, 32).toString('hex') }; };
    const PW = 'E2e#Ro!232';
    const db0 = {
      users: [mk('u_self', '本测试人', 'admin'), mk('u_other', '他人测试', 'admin')],
      sessions: {}, devices: {}, ops: [], notifications: [
        { id: 'nX', to: 'u_self', type: 'ghost_out', text: '本人消息X（应与同id他人消息隔离）', reqId: '', time: new Date().toISOString(), read: false },
        { id: 'nX', to: 'u_other', type: 'ghost_out', text: '他人消息X（同id，不得被本人置读）', reqId: '', time: new Date().toISOString(), read: false },
        { id: 'nY', to: 'u_self', type: 'watch_in', text: '本人消息Y（未点，应保持未读）', reqId: '', time: new Date().toISOString(), read: false },
      ],
      requisitions: [], outbound: {}, ledger: [], scanlog: {}, agvQueue: [], inspects: [], seenIn: {}, seenOut: {},
      features: { material: {}, warehouse: {}, inspector: {}, admin: { admin_panel: true } },
      rcsConfig: null, wmasConfig: null, rcsStations: {},
    };
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
    srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { SELFTEST_NO_LIVE: '1', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', killTree);
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(600) })).ok; } catch (_) {} }
    C('护栏 实例就绪', up); if (!up) throw new Error('实例未起');
    const tk = (await post('/api/login', null, { username: 'u_self', password: PW, dev: 'RO', kind: 'web' })).json.token;
    C('护栏 登录', !!tk); if (!tk) throw new Error('登录失败');

    const r1 = await post('/api/notifications/read', tk, { id: 'nX' });
    C('★★ ① 单条置读被受理', r1.json.ok === true && r1.json.marked === 1, JSON.stringify(r1.json));

    // 轮询等异步防抖落盘（v225 教训），判据=本人 nY 尚未读但 nX 已读
    let dbA = null;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      try { dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); } catch (_) { continue; }
      const s = (dbA.notifications || []).find((x) => x.to === 'u_self' && x.id === 'nX');
      if (s && s.read === true) break;
    }
    const readOf = (to, id) => { const x = (dbA.notifications || []).find((y) => y.to === to && y.id === id); return x ? x.read : '(缺)'; };
    C('★★★ ② 本人 nX 已落库置读', readOf('u_self', 'nX') === true, 'read=' + readOf('u_self', 'nX'));
    C('★★★ ② 他人同 id nX 纹丝未动（只动本人红线）', readOf('u_other', 'nX') === false, 'read=' + readOf('u_other', 'nX'));
    C('★★ ③ 本人未点的 nY 保持未读', readOf('u_self', 'nY') === false, 'read=' + readOf('u_self', 'nY'));

    const un = await get2('/api/notifications/unread', tk);
    C('★★ ④ 未读计数随单条已读衰减（本人2条-nX已读=1；他人消息不计入本人未读）', un.json.unread === 1, 'unread=' + un.json.unread); // 手算修正：期望曾误写2(把他人nX混入)，产品口径=仅本人,实测1正确

    const r5 = await post('/api/notifications/read', tk, { id: 'nope-not-exist' });
    C('★★ ⑤ 查无 id 返回 ok:false 静默不报错', r5.status === 200 && r5.json.ok === false, JSON.stringify(r5.json));
    const r6 = await post('/api/notifications/read', tk, {});
    C('★ ⑥ 缺 id → 400', r6.status === 400, 'st=' + r6.status);
    // 幂等：再点一次已读的 nX → ok:true 不报错（readall 同款宽容语义）
    const r7 = await post('/api/notifications/read', tk, { id: 'nX' });
    C('★ ⑦ 重复置读幂等（已读再点 ok:true）', r7.json.ok === true, JSON.stringify(r7.json));

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
