// ㉖v199e "来料区停用期误扫"体检只判本次新流入（用户实锤：3框11-07扫、11-08已出库，
// 旧版把 PDA 每次【全量回灌】的历史 NB04 流水当停用期新流入重报，11-17 一天留痕 239 次）
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_recv199e');
  const PORT = Number(process.env.RCV_PORT || (8900 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const OLD = 'N26K070094', FRESH = 'N26K990111';
  const kOld = OLD + '|B2026-11-07-1613|1794100985000'; // 11-07 的旧 NB04 流水（服务器已存有此键）
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_wh', username: 'wh_u', name: '测试仓管', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Rc#199', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    d0.features.warehouse.collect = true;
    d0.params = Object.assign({}, d0.params || {}); d0.params.receivingOn = 0; // 来料区停用（生产实况=0）
    d0.scanlog = { [kOld]: { k: kOld, code: OLD, wt: 2, gl: 'NB04-A-01-001', t: Date.now() - 10 * 864e5, cx: false, batch: 'B2026-11-07-1613', op: '测试仓管' } };
    d0.ledger = []; d0.ledgerTomb = []; d0.ops = []; d0.notifications = []; d0.seenIn = {}; d0.seenOut = {};
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    const tk = up && (await API('/api/login', { method: 'POST', body: { username: 'wh_u', password: 'Rc#199' } }, null)).token;
    C('护栏 实例启动+登录', up && !!tk, '');
    const misCnt = () => (JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).ops || []).filter((o) => /来料区停用期误扫/.test(String(o.act || ''))).length;

    // ① 复现现场：PDA 全量回灌那 1 条历史 NB04 流水（键已存在）→ 不得留痕
    const r1 = await API('/api/scanlog/sync', { method: 'POST', body: { items: [{ k: kOld, code: OLD, wt: 2, gl: 'NB04-A-01-001', t: Date.now() - 10 * 864e5, batch: 'B2026-11-07-1613', cx: false }] } }, tk);
    await sleep(4600); // save 防抖~4s
    C('R0 历史回灌受理', r1.ok === true, 'ok=' + r1.ok);
    C('R1 ★★★ 历史回灌不再重报（旧版每次合并都留痕=239次噪声）', misCnt() === 0, '留痕=' + misCnt());

    // ② 真的在停用期新扫一条 NB04（24h 内、键不存在）→ 照常点名
    const kNew = FRESH + '|B-NOW|' + Date.now();
    const r2 = await API('/api/scanlog/sync', { method: 'POST', body: { items: [{ k: kNew, code: FRESH, wt: 2, gl: 'NB04-A-01-002', t: Date.now(), batch: 'B-NOW', cx: false }] } }, tk);
    await sleep(4600);
    C('R2 停用期真新扫照常点名', r2.ok === true && misCnt() === 1, 'ok=' + r2.ok + ' 留痕=' + misCnt());

    // ③ 再回灌同一批（含刚那条，现在键已存在）→ 不重复报
    await API('/api/scanlog/sync', { method: 'POST', body: { items: [{ k: kNew, code: FRESH, wt: 2, gl: 'NB04-A-01-002', t: Date.now(), batch: 'B-NOW', cx: false }, { k: kOld, code: OLD, wt: 2, gl: 'NB04-A-01-001', t: Date.now() - 10 * 864e5, batch: 'B2026-11-07-1613', cx: false }] } }, tk);
    await sleep(4600);
    C('R3 ★★★ 二次回灌不重复吵（留痕仍=1）', misCnt() === 1, '留痕=' + misCnt());

    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-8).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
