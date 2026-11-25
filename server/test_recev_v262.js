// ㉖v262 流水接收审计取证：同键推送必打 recvEv（谁/哪台设备/服务器IP/服务器到达毫秒），真覆盖才产 hist
// 剧本：①首推=新流入 recvEv[0] 完整 ②同键改 gl 重推=hist+1 且 recvEv 前插 ③同内容回灌=不产 hist 但 recvEv 仍记 ④cap5
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_recev_v262');
const PORT = 8443, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ username: 'v262_wh', id: 'u_v262', name: 'V262仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#W2!pw', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  const C = 'V262TEST001', t0 = Date.now() - 60000;
  const key = C + '|B262|' + t0;
  const push = async (gl) => (await (await fetch(BASE + '/api/scanlog/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ items: [{ k: key, code: C, t: t0, q: 50, gl, st: '', wt: 1, cx: false, op: 'V262仓管', batch: 'B262' }] }) })).json());
  let tk = '';
  try {
    tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v262_wh', password: 'E2e#W2!pw' }) })).json()).token;
    // ① 首推
    chkT('①首推受理', (await push('NB03-C-12-01')).ok === true, '');
    let row = (await (await fetch(BASE + '/api/scanlog?c=' + C, { headers: { Authorization: 'Bearer ' + tk } })).json()).items[0] || {};
    const e0 = (row.recvEv || [])[0] || {};
    chkT('★①recvEv 四要素齐（by/ip/at 有值，dev 允许空=登录未带设备号）', (row.recvEv || []).length === 1 && e0.by === 'V262仓管' && /\d/.test(String(e0.ip || '')) && e0.at > 1e12, JSON.stringify(row.recvEv));
    // ② 改 gl 重推（真覆盖）
    await sleep(50); await push('NB03-C-12-02');
    row = (await (await fetch(BASE + '/api/scanlog?c=' + C, { headers: { Authorization: 'Bearer ' + tk } })).json()).items[0] || {};
    chkT('★②真覆盖=hist+1 且 recvEv 前插(最新在前)', (row.hist || []).length === 1 && String(row.hist[0].gl) === 'NB03-C-12-01' && (row.recvEv || []).length === 2 && row.recvEv[0].at >= row.recvEv[1].at, JSON.stringify({ h: row.hist, r: (row.recvEv || []).length }));
    // ③ 同内容回灌：不产 hist、recvEv 仍记（接收事实留痕）
    await sleep(50); await push('NB03-C-12-02');
    row = (await (await fetch(BASE + '/api/scanlog?c=' + C, { headers: { Authorization: 'Bearer ' + tk } })).json()).items[0] || {};
    chkT('③同内容回灌=hist 不增、recvEv 仍记', (row.hist || []).length === 1 && (row.recvEv || []).length === 3, JSON.stringify({ h: (row.hist || []).length, r: (row.recvEv || []).length }));
    // ④ cap5
    for (let i = 0; i < 4; i++) { await sleep(40); await push('NB03-C-12-0' + (3 + i)); }
    row = (await (await fetch(BASE + '/api/scanlog?c=' + C, { headers: { Authorization: 'Bearer ' + tk } })).json()).items[0] || {};
    chkT('④cap：hist≤3、recvEv≤5', (row.hist || []).length <= 3 && (row.recvEv || []).length === 5, JSON.stringify({ h: (row.hist || []).length, r: (row.recvEv || []).length }));
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail}` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
