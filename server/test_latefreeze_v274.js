// ㉖v274 冻结增强·回溯近24h迟签也冻 取证（堵陈明"先签收超期单再下新单"绕过）
// 断言：①近24h迟签(签收时长>阈值)→下单被冻 ②快签(时长<阈值)→不冻 ③迟签超24h→不冻(窗口外)
//   ④当前手里超期未签收→仍冻(原语义保留) ⑤陈明模式(先签超期单再下单)→被冻
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_latefreeze_v274');
const PORT = 8471, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
const mkU = (id, name) => db0.users.push({ id, username: id, name, role: 'material', enabled: true, salt, passHash: hp('E2e#L4!' + id.slice(-1), salt) });
mkU('u_late', '迟签者'); mkU('u_fast', '快签者'); mkU('u_old', '旧迟签'); mkU('u_hold', '囤单者'); mkU('u_chen', '陈明式');
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0, gateMode: 0, freezeOn: 1, freezeOverMin: 120, freezeMin: 120, throttleN: 0 });
const now = Date.now(), MIN = 60000;
db0.requisitions = (db0.requisitions || []).filter((r) => !String(r.no).startsWith('LLV274'));
const mkR = (no, by, readyAgoMin, confirmAgoMin, status) => ({ id: 'q_' + no, no, by, byName: by, status: status || 'done', createdAt: new Date(now - (readyAgoMin + 60) * MIN).toISOString(), readyAt: now - readyAgoMin * MIN, confirmedAt: confirmAgoMin != null ? new Date(now - confirmAgoMin * MIN).toISOString() : undefined, history: [], items: [{ partNo: 'V274P', itemName: '件', qty: 10, issued: [] }] });
// 迟签者：100分钟前签收，但备齐是400分钟前 → 签收时长300>120 → 迟签，且在24h内
db0.requisitions.push(mkR('LLV274LATE', 'u_late', 400, 100));
// 快签者：100分钟前签收，备齐130分钟前 → 时长30<120 → 不冻
db0.requisitions.push(mkR('LLV274FAST', 'u_fast', 130, 100));
// 旧迟签：25小时前签收(窗口外)，时长300 → 不冻
db0.requisitions.push(mkR('LLV274OLD', 'u_old', 25 * 60 + 300, 25 * 60));
// 囤单者：手里ready超期未签收(400分钟前备齐,无confirm) → 冻
db0.requisitions.push(mkR('LLV274HOLD', 'u_hold', 400, null, 'ready'));
// 陈明式：先签超期单(备齐400分钟前,10分钟前签收=时长390>120)，手里无ready → 应被回溯冻
db0.requisitions.push(mkR('LLV274CHEN', 'u_chen', 400, 10));
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const gate = async (u) => { const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#L4!' + u.slice(-1) }) })).json()).token; return (await (await fetch(BASE + '/api/requisitions/gate', { headers: { Authorization: 'Bearer ' + tk } })).json()); };
  try {
    const gl = await gate('u_late'); chkT('★①近24h迟签→冻', gl.freeze && gl.freeze.frozen === true, JSON.stringify(gl.freeze));
    const gf = await gate('u_fast'); chkT('★②快签→不冻', !(gf.freeze && gf.freeze.frozen), JSON.stringify(gf.freeze));
    const go = await gate('u_old'); chkT('③迟签超24h→不冻', !(go.freeze && go.freeze.frozen), JSON.stringify(go.freeze));
    const gh = await gate('u_hold'); chkT('④手里超期未签收→仍冻', gh.freeze && gh.freeze.frozen === true, JSON.stringify(gh.freeze));
    const gc = await gate('u_chen'); chkT('★⑤陈明式(先签超期再下单)→被回溯冻', gc.freeze && gc.freeze.frozen === true, JSON.stringify(gc.freeze));
    console.log(`\n===== v274 回溯迟签冻结取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
