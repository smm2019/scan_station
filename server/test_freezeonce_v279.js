// ㉖v279 迟签单只追罚一次 + 开关解除保留冷却锚点 取证（张金飞11-26一上午同一批单冻3次实锤修复）
// 阶段1（旧库带病启动）：①启动迁移给存量追罚单补戳→解冻后不再追罚（张案复现不复发）
//   ②全新迟签单首犯必罚（罚时=基数×(1+1)）③开关关闭→放行且until归零lastUntil保命 ④重开→已罚单不重罚
// 阶段2（锚点滚出冷却+新迟签C+囤单D入库重启）：⑤C+D计罚、A/B戳住不追（罚时=基数×(1+2)数字铁证）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_freezeonce_v279');
const PORT = 8474, BASE = 'http://127.0.0.1:' + PORT;
const MIN = 60000, HOUR = 3600e3;
const now = Date.now();
const mkR = (no, readyAgoMin, confirmAgoMin, status) => ({ id: 'q_' + no, no, by: 'u_zj', byName: '张金飞', status: status || 'done', createdAt: new Date(now - (readyAgoMin + 60) * MIN).toISOString(), readyAt: now - readyAgoMin * MIN, confirmedAt: confirmAgoMin != null ? new Date(now - confirmAgoMin * MIN).toISOString() : undefined, history: [], items: [{ partNo: 'V279P', itemName: '件', qty: 10, issued: [] }] });
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_zj', username: 'u_zj', name: '张金飞', role: 'material', enabled: true, salt, passHash: hp('E2e#F9!j', salt) }); // 密码=前缀+用户名末字符（初版写!z与登录侧!j不一致→401假失败）
db0.users.push({ id: 'u_ad', username: 'u_ad', name: '管理员', role: 'admin', enabled: true, salt, passHash: hp('E2e#F9!d', salt) });
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0, gateMode: 0, throttleN: 0, freezeOn: 1, freezeOverMin: 180, freezeLateH: 12, freezeMin: 15 });
db0.requisitions = []; delete db0.latePunished;
// 张案复现：A 迟签已罚过（旧格式冻结记录、无戳），B 迟签未罚（新线索）
db0.requisitions.push(mkR('LLV279A', 500, 300)); // 迟签200分>180，A在冻结overs里
db0.requisitions.push(mkR('LLV279B', 400, 200)); // 迟签200分>180，未追罚
db0.reqFreeze = { u_zj: { until: now - 2 * HOUR, at: now - 3 * HOUR, reason: 'late', overs: ['LLV279A'] } }; // 旧格式：无lastUntil
delete db0.mesCred;
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const spawnSrv = () => cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
(async () => {
  let logs = '';
  const boot = async (srv) => { srv.stdout.on('data', (b) => { logs += b.toString(); }); let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} } return up; };
  let srv = spawnSrv();
  if (!(await boot(srv))) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#F9!' + u.slice(-1) }) })).json()).token;
  const waitGate = async () => { for (let i = 0; i < 60; i++) { const rr = await fetch(BASE + '/api/requisitions/gate').catch(() => null); if (rr && rr.status !== 503) return; await sleep(1000); } throw new Error('自愈窗60秒未释放'); }; // 探针无token：窗内连登录也503，带token探测会401≠503立即break=等待无效（本轮实锤）
  await waitGate(); // ㉖自愈窗等待必须【先于登录】：窗内tok拿到的token是undefined，后续全401
  const tkZ = await tok('u_zj'), tkA = await tok('u_ad');
  const gate = async () => (await (await fetch(BASE + '/api/requisitions/gate', { headers: { Authorization: 'Bearer ' + tkZ } })).json());
  const setP = async (values) => { const cur = await (await fetch(BASE + '/api/admin/params', { headers: { Authorization: 'Bearer ' + tkA } })).json(); return (await (await fetch(BASE + '/api/admin/params', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkA }, body: JSON.stringify({ values, cfgRev: cur.cfgRev }) })).json()); };
  const readDisk = () => JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  try {
    await sleep(1200); // 迁移+落盘
    const d1 = readDisk();
    chkT('①迁移启动补戳+日志', !!d1.latePunished && !!d1.latePunished.LLV279A && /\[freeze-fix\]/.test(logs), JSON.stringify(d1.latePunished || {}).slice(0, 120));
    const g1 = await gate(); // 冻结已过期(2h前结束)：A有戳不追，只有B新账→罚1张
    chkT('★①解冻后已罚单不追(罚时=15×2分)', g1.freeze && g1.freeze.frozen === true && Math.abs((g1.freeze.until - Date.now()) / MIN - 30) < 2, JSON.stringify(g1.freeze)); // 若A被误追罚→15×3=45分
    await sleep(900);
    const d2 = readDisk();
    chkT('②新迟签B本轮计罚打戳', !!d2.latePunished.LLV279B && !!d2.latePunished.LLV279A, JSON.stringify(d2.latePunished));
    // ③开关关闭：放行 + until归零 + lastUntil锚点保命
    await setP({ freezeOn: 0 });
    const g2 = await gate();
    chkT('③开关关闭→放行', !(g2.freeze && g2.freeze.frozen), JSON.stringify(g2.freeze));
    await sleep(900);
    const d3 = readDisk(), e3 = (d3.reqFreeze || {}).u_zj || {};
    // ㉖v279 自纠后语义：锚点整体钳到解除时刻（未来罚时不残留=被解除者不被过度冷却，缓冲60分钟从解除刻起算）
    chkT('★③解除保留锚点(until=0,0<lastUntil<=now)', e3.until === 0 && Number(e3.lastUntil) > 0 && Number(e3.lastUntil) <= Date.now(), JSON.stringify(e3));
    // ④重开开关：迟签单全有戳→不重罚
    await setP({ freezeOn: 1 });
    const g3 = await gate();
    chkT('★④重开开关→同一批迟签单不再追罚', !(g3.freeze && g3.freeze.frozen), JSON.stringify(g3.freeze));
    // ==== 阶段2：锚点滚出冷却 + 新迟签C + 囤单D ====
    srv.kill(); await sleep(800);
    const d4 = readDisk();
    d4.reqFreeze.u_zj = { until: 0, lastUntil: now - 90 * MIN, reason: 'late', overs: [] }; // 模拟罚时锚点已过90分钟(出60分冷却)
    d4.params = Object.assign(d4.params || {}, { freezeOn: 1 }); // ④重开开关的save防抖未及落盘即被kill（调试实锤盘上freezeOn=0）——夹具显式补回
    d4.requisitions.push(mkR('LLV279C', 300, 10)); // 新迟签290>180，无戳
    d4.requisitions.push(mkR('LLV279D', 300, null, 'ready')); // 手里囤单超期未签收
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d4));
    srv = spawnSrv();
    chkT('阶段2重启就绪', await boot(srv), '');
    await waitGate(); // 阶段2重启后自愈窗再开
    const g4 = await gate();
    const mins = g4.freeze && g4.freeze.until ? (g4.freeze.until - Date.now()) / MIN : -1;
    chkT('★⑤新迟签C+囤单D计罚(15×3=45分)且A/B不追罚', g4.freeze && g4.freeze.frozen === true && Math.abs(mins - 45) < 2, 'mins=' + mins.toFixed(1) + '（若A/B被追罚则75）');
    let d5 = {}; for (let i = 0; i < 24; i++) { await sleep(250); d5 = readDisk(); if ((d5.latePunished || {}).LLV279C) break; } // C戳落盘轮询（save防抖慢日900ms越界）
    chkT('⑤b戳不丢且C入戳D不入(囤单给改正机会)', !!d5.latePunished.LLV279A && !!d5.latePunished.LLV279C && !d5.latePunished.LLV279D, JSON.stringify(d5.latePunished));
    console.log(`\n===== v279 迟签只罚一次取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
