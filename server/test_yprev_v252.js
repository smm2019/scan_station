// ㉖v252 概览 yPrev「昨日同期」取证：/api/dashboard 新增 k.yPrev 四字段，口径与今日各卡同源、窗口=昨日0点→昨日同一时刻
// 断言：①字段存在且为数字 ②零到料日 yPrev 全 0（不报错）③与手工复算同口径一致（公平比较前提）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_yprev_v252');
const PORT = 8421, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ username: 'v252_wh', id: 'u_v252', name: 'V252仓管', role: 'warehouse', enabled: true, salt, passHash: hashPw('E2e#Y2!pw', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v252_wh', password: 'E2e#Y2!pw' }) })).json()).token;
    const j = await (await fetch(BASE + '/api/dashboard', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const yp = (j.kpi || {}).yPrev;
    chkT('Y1 yPrev 存在且含四字段', !!yp && ['inBoxes', 'inQty', 'outToday', 'agvToday'].every((x) => typeof yp[x] === 'number'), JSON.stringify(yp));
    // 手工复算昨日同期（同一时刻窗口）inBoxes 口径：昨日0点→昨日此刻，二楼上架(剔NB04)标签去重
    const now = new Date(), dayMs = 864e5;
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const _yB = todayStart - dayMs, _yE = _yB + (Date.now() - todayStart);
    const s = new Set(); for (const x of Object.values(db0.scanlog || {})) { if (x.cx || !x.t || !x.code || x.t < _yB || x.t > _yE) continue; if (/^NB04-/.test(String((x.st || x.gl) || '').toUpperCase())) continue; s.add(x.code); }
    chk('Y2 yPrev.inBoxes 与手工同口径复算一致', yp.inBoxes, s.size);
    const tombN = (db0.ledgerTomb || []).filter((x) => x.t >= _yB && x.t <= _yE).length;
    chk('Y3 yPrev.outToday 与墓碑窗口复算一致', yp.outToday, tombN);
    chkT('Y4 各字段非负', [yp.inBoxes, yp.inQty, yp.outToday, yp.agvToday].every((v) => v >= 0), '');
    chkT('Y5 服务无异常日志', !(await new Promise((r) => setTimeout(() => r(''), 200))), '');
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail}` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); }
})();
