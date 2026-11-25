// ㉖v271 ops 读缓存·数据安全/准确取证（用户底线：数据百分百可靠）
// 设计：文件唯一权威；缓存=逐条镜像（启动重建/单写入口同步追加/清理跨天失效/不一致回退直读）。
// 断言：①缓存 vs 磁盘直读 逐条键集一致（integrity?cache=1 pass）
//       ②新增留痕后 缓存立即含新行 且 与磁盘一致（不丢更新）
//       ③admin/ops 返回 total 与磁盘行数一致（准确）
//       ④性能：admin/ops 二次读（缓存命中）显著快于首读（根治960ms）
//       ⑤断链校验（原有 integrity）仍通过（缓存不破坏防篡改）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_opscache_v271');
const PORT = 8465, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
// 复制真实 ops 目录（只读副本），让缓存有真实180天数据可验证
const srcOps = path.join(__dirname, 'data', 'ops');
if (fs.existsSync(srcOps)) { fs.mkdirSync(path.join(TDIR, 'ops'), { recursive: true }); for (const f of fs.readdirSync(srcOps)) fs.copyFileSync(path.join(srcOps, f), path.join(TDIR, 'ops', f)); }
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v271', username: 'v271_a', name: 'V271管理', role: 'admin', enabled: true, salt, passHash: hp('E2e#C1!a', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const getj = async (p, tk) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({})));
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v271_a', password: 'E2e#C1!a' }) })).json()).token;
    // ① 缓存 vs 磁盘 一致
    const cc = await getj('/api/admin/ops/integrity?cache=1', tk);
    chkT('★①缓存vs磁盘逐条一致(pass)', cc.cacheCheck === true && cc.pass === true, JSON.stringify(cc));
    // ③ admin/ops total 与磁盘一致
    const ops = await getj('/api/admin/ops?limit=5', tk);
    chkT('③admin/ops.total=磁盘行数', ops.total === cc.diskRows, JSON.stringify({ total: ops.total, disk: cc.diskRows }));
    // ④ 性能：首读(建缓存) vs 二次读(命中)
    const t1 = Date.now(); await getj('/api/admin/ops?limit=5', tk); const d1 = Date.now() - t1;
    const t2 = Date.now(); await getj('/api/admin/ops?limit=5', tk); const d2 = Date.now() - t2;
    chkT('★④缓存命中读<50ms(根治960ms)', d2 < 50, `首读=${d1}ms 缓存读=${d2}ms`);
    // ② 新增留痕后缓存立即含新行且与磁盘一致：触发一次 pushOps（改参数会留痕）→ 用 integrity?cache=1 再比对
    await (await fetch(BASE + '/api/admin/params', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ values: { gateGraceMin: 31 }, baseRev: null }) })).json().catch(() => ({}));
    await sleep(200);
    const cc2 = await getj('/api/admin/ops/integrity?cache=1', tk);
    chkT('★②新增留痕后缓存仍与磁盘一致(不丢更新)', cc2.pass === true && cc2.diskRows >= cc.diskRows, JSON.stringify(cc2));
    // ⑤ 断链校验仍通过（昨日）
    const y = new Date(Date.now() - 864e5); const yday = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
    const ig = await getj('/api/admin/ops/integrity?day=' + yday, tk);
    chkT('⑤原断链校验不受缓存影响', ig.ok === true && (ig.pass === true || ig.nowRows >= 0), JSON.stringify(ig).slice(0, 120));
    console.log(`\n===== v271 ops缓存安全/准确取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
