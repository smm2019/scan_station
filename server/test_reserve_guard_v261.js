// ㉖v261 AUTO 分配 NB04 预占回吐泄漏根治取证（11-25 N26K250023 两人两机连环案）
// 剧本：①一楼 reserve(recv=1) 放 NB04 格并预占 → ②账本未推达（30秒窗）二楼 AUTO reserve →
// 修复前回吐 NB04（kept=true 畸形源头），修复后必须分 NB02 新位且日志留痕
// ③一楼幂等重扫（recv=1 同码）必须仍回同格（v122 不跳格语义不破坏）④已迁 NB02 的框幂等回现位不受 guard 误伤
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_resv_v261');
const PORT = 8441, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ username: 'v261_wh', id: 'u_v261', name: 'V261仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#V1!pw', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  const CODE = 'V261TEST001', CODE2 = 'V261TEST002';
  const rv = async (body) => (await (await fetch(BASE + '/api/ledger/reserve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify(body) })).json());
  let tk = '';
  try {
    tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v261_wh', password: 'E2e#V1!pw' }) })).json()).token;
    // ① 一楼放 NB04 格（放格+预占 5 分钟）
    const r1 = await rv({ code: CODE, recv: 1 });
    chkT('①一楼放格成功 NB04-*（前提）', r1.ok === true && /^NB04-/.test(String(r1.loc || '')), JSON.stringify(r1));
    const nb04Loc = String(r1.loc || '');
    // ② 关键断言：账本未推达窗内，二楼 AUTO 分配绝不回吐 NB04 预占格
    const r2 = await rv({ code: CODE, partNo: 'V261PN0001' });
    chkT('★★②AUTO 不回吐 NB04 预占（泄漏根治）', r2.ok === true && /^NB02-/.test(String(r2.loc || '')) && r2.kept !== true, JSON.stringify(r2));
    chkT('②b guard 日志留痕', log.join('').includes('[reserve-guard]') && log.join('').includes(CODE), '');
    // ③ 一楼幂等重扫必须回同格（v122 语义不破坏）
    const r3 = await rv({ code: CODE, recv: 1 });
    chkT('★③一楼幂等重扫仍回同 NB04 格', r3.ok === true && String(r3.loc) === nb04Loc, JSON.stringify(r3));
    // ④ 已迁 NB02 的框 AUTO 幂等回现位（NB02 预占复用不受 guard 误伤）
    const r4a = await rv({ code: CODE2, partNo: 'V261PN0002' });
    const r4b = await rv({ code: CODE2, partNo: 'V261PN0002' });
    chkT('★④NB02 预占幂等复用正常（误伤检查）', r4a.ok === true && /^NB02-/.test(String(r4a.loc || '')) && r4b.ok === true && String(r4b.loc) === String(r4a.loc) && r4b.kept === true, JSON.stringify([r4a, r4b]));
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail}` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
