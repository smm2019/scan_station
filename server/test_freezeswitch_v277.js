// ㉖v277 冻结开关即时解除 + 迟签回溯窗口参数化 取证（v279 语义更新版）
// 断言：①开关关闭→已在冻结中的人立即放行 ②解除落盘=until归零+lastUntil锚点保留(v279)，重启不复活
//   ③开关重开→迟签已罚不追(v279戳) ④回溯窗口=0→迟签不冻但手里超期未签收仍冻(囤单不受冷却豁免)
//   ⑤回溯窗口=2h→3h前签收落窗口外 ⑥窗口=24h→同一单被冻(参数真生效) ⑦管理员不受约束
//   ⑧文案按成因分流(迟签说"签收超期"非"未签收")
// 防串台（11-26 三连假阳性教训）：随机端口 + spawn 进程早退 fail-fast（残留实例占端口时新实例
// 会被 v69 幻影守卫静默退出，请求流打到残留旧实例上→断言拿旧状态，必须立刻识破而不是假跑）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_freezeswitch_v277');
const PORT = 8500 + (process.pid % 30), BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
const mkU = (id, name, role) => db0.users.push({ id, username: id, name, role: role || 'material', enabled: true, salt, passHash: hp('E2e#S7!' + id.slice(-1), salt) });
mkU('u_sw_late', '迟签开关者'); mkU('u_sw_hold', '囤单开关者'); mkU('u_sw_win', '窗口验证者'); mkU('u_sw_adm', '管理员对照', 'admin');
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0, gateMode: 0, freezeOn: 1, freezeOverMin: 120, freezeMin: 120, freezeLateH: 24, throttleN: 0 });
const now = Date.now(), MIN = 60000;
db0.requisitions = (db0.requisitions || []).filter((r) => !String(r.no).startsWith('LLV277'));
const mkR = (no, by, readyAgoMin, confirmAgoMin, status) => ({ id: 'q_' + no, no, by, byName: by, status: status || 'done', createdAt: new Date(now - (readyAgoMin + 60) * MIN).toISOString(), readyAt: now - readyAgoMin * MIN, confirmedAt: confirmAgoMin != null ? new Date(now - confirmAgoMin * MIN).toISOString() : undefined, history: [], items: [{ partNo: 'V277P', itemName: '件', qty: 10, issued: [] }] });
db0.requisitions.push(mkR('LLV277LATE', 'u_sw_late', 400, 100)); // 迟签300>120，24h窗口内
db0.requisitions.push(mkR('LLV277HOLD', 'u_sw_hold', 400, null, 'ready')); // 手里超期未签收
db0.requisitions.push(mkR('LLV277WIN', 'u_sw_win', 500, 180)); // 迟签320，签收时刻3h前（测窗口2h/24h）
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const env = { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR };
  let srv = null, srvDead = 0;
  const spawnSrv = () => { srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] }); srv.on('exit', (code) => { srvDead = code; }); return srv; };
  spawnSrv();
  const boot = async () => { for (let i = 0; i < 60; i++) { if (srvDead) throw new Error('服务进程提前退出(code=' + srvDead + ')——端口 ' + PORT + ' 疑被残留实例占用'); await sleep(250); try { if ((await fetch(BASE + '/api/health')).ok) return true; } catch (_) {} } throw new Error('服务60轮未就绪(端口' + PORT + ')'); };
  await boot();
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#S7!' + u.slice(-1) }) })).json()).token;
  const gate = async (u) => (await (await fetch(BASE + '/api/requisitions/gate', { headers: { Authorization: 'Bearer ' + await tok(u) } })).json());
  const setP = async (values) => { const tk = await tok('u_sw_adm'); const cur = (await (await fetch(BASE + '/api/admin/params', { headers: { Authorization: 'Bearer ' + tk } })).json()); return (await (await fetch(BASE + '/api/admin/params', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ values, cfgRev: cur.cfgRev }) })).json()); };
  const frozen = (j) => !!(j.freeze && j.freeze.frozen);
  try {
    // 基线：开关开、窗口24h → 迟签者与囤单者都被冻（迟签单此刻入罚戳）
    const a1 = await gate('u_sw_late'); chkT('基线·迟签被冻', frozen(a1), JSON.stringify(a1.freeze));
    const a2 = await gate('u_sw_hold'); chkT('基线·囤单被冻', frozen(a2), JSON.stringify(a2.freeze));
    // ⑧文案分流走真实下单出口（gate 只回 frozen/until，文案在 POST 409 里）
    const tkLate = await tok('u_sw_late');
    const r8 = await fetch(BASE + '/api/requisitions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkLate }, body: JSON.stringify({ items: [{ partNo: 'V277P', itemName: '件', qty: 10 }] }) });
    const j8 = await r8.json();
    chkT('⑧迟签被拦且文案说"签收超期"非"未签收"', r8.status === 409 && j8.code === 'freeze' && /签收超期/.test(String(j8.msg || '')) && !/分钟未签收/.test(String(j8.msg || '')), r8.status + ' ' + JSON.stringify(j8).slice(0, 200));
    // ★①关闭开关 → 已冻的人立即放行
    const sp = await setP({ freezeOn: 0 }); chkT('参数写入成功', sp.ok === true, JSON.stringify(sp).slice(0, 160));
    const b1 = await gate('u_sw_late'); chkT('★①开关关闭→迟签者立即解冻', !frozen(b1), JSON.stringify(b1.freeze));
    const b2 = await gate('u_sw_hold'); chkT('★①开关关闭→囤单者立即解冻', !frozen(b2), JSON.stringify(b2.freeze));
    // 轮询等落盘（save防抖+写序队列，最长6秒）：直到 u_sw_late 解除状态出现
    let disk = {};
    for (let i = 0; i < 24; i++) { await sleep(250); disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); const e = (disk.reqFreeze || {}).u_sw_late; if (e && e.until === 0) break; }
    // ★②v279 新语义：解除不删记录——until归零+lastUntil锚点钳制到解除时刻（防开关测试重置冷却→连环冻）
    const _h1 = (disk.reqFreeze || {}).u_sw_late || {}, _h2 = (disk.reqFreeze || {}).u_sw_hold || {};
    chkT('★②解除落盘·锚点保留(until=0,0<lastUntil<=now)', _h1.until === 0 && Number(_h1.lastUntil) > 0 && Number(_h1.lastUntil) <= Date.now() && _h2.until === 0 && Number(_h2.lastUntil) > 0, JSON.stringify({ late: _h1, hold: _h2 }).slice(0, 260));
    // ★②b重启不复活
    srv.kill(); srvDead = 0; await sleep(700);
    spawnSrv(); await boot();
    const c1 = await gate('u_sw_late'); chkT('★②b重启后仍放行(不复活)', !frozen(c1), JSON.stringify(c1.freeze));
    // ★③重开开关 → 已罚迟签单不追（v279：迟签罚一不罚二；窗口功能由⑤⑥ win 首罚证明）
    await setP({ freezeOn: 1 });
    const d1 = await gate('u_sw_late'); chkT('★③重开开关→迟签已罚不追(戳生效)', !frozen(d1), JSON.stringify(d1.freeze));
    // ④窗口=0 → 迟签不冻（已罚+窗口0双重）、囤单仍冻（囤单=进行时违规，冷却不豁免）
    await setP({ freezeOn: 0 }); await gate('u_sw_late'); await gate('u_sw_hold'); await gate('u_sw_win');
    await setP({ freezeOn: 1, freezeLateH: 0 });
    const e1 = await gate('u_sw_late'); chkT('④回溯窗口0→迟签不冻', !frozen(e1), JSON.stringify(e1.freeze));
    const e2 = await gate('u_sw_hold'); chkT('④回溯窗口0→手里超期仍冻(囤单不受冷却豁免)', frozen(e2), JSON.stringify(e2.freeze));
    // ⑤窗口=2h：win 3h前签收落窗口外
    await setP({ freezeOn: 0 }); await gate('u_sw_win'); await setP({ freezeOn: 1, freezeLateH: 2 });
    const f1 = await gate('u_sw_win'); chkT('⑤窗口2h→3h前迟签不冻', !frozen(f1), JSON.stringify(f1.freeze));
    // ⑥窗口=24h：win 同一单被首罚（证明参数真生效+首罚功能未损）
    await setP({ freezeOn: 0 }); await gate('u_sw_win'); await setP({ freezeOn: 1, freezeLateH: 24 });
    const g1 = await gate('u_sw_win'); chkT('★⑥窗口24h→win首罚被冻', frozen(g1), JSON.stringify(g1.freeze));
    // ⑦管理员不受约束
    const h1 = await gate('u_sw_adm'); chkT('⑦管理员不受冻结约束', !frozen(h1), JSON.stringify(h1.freeze));
    console.log(`\n===== v277 冻结开关/回溯窗口取证(v279语义)：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { if (srv) srv.kill(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
