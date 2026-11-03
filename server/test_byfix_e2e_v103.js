// ㉖v103 登记人修复 + 格数上限200 · 端到端取证（真实 HTTP 打隔离实例）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_byfix_v103');
const PORT = 8333, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users.push({ id: 'u_byf', username: 'e2e_byf_wh', name: 'E2E登记', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Byf!pw', salt) });
delete db0.ledgerByFixedV103; delete db0.gscCleanedV101; delete db0.opFixedV101; delete db0.ledgerQtyFixedV103; delete db0.reqRaceFixedV103; // 副本清全部开关，迁移真实重跑
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
function startSrv() { const sv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] }); const log = []; sv.stdout.on('data', (b) => log.push(b.toString())); sv.stderr.on('data', (b) => log.push(b.toString())); sv.__log = () => log.join(''); return sv; }
async function waitUp() { for (let i = 0; i < 40; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) {} } return false; }
const load = () => JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
(async () => {
  let srv = startSrv();
  if (!(await waitUp())) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    await sleep(1200);
    let dd = load();
    console.log('\n=== A. 存量登记人修复迁移 ===');
    const m = (srv.__log().match(/恢复被洗掉的登记人 (\d+) 行/) || [])[1];
    chk('A1 迁移日志实证命中497行', +m, 497);
    chk('A2 270462 登记人=刘向轩（出生人，事故标签）', (dd.ledger.find((x) => x.c === 'N26J270462') || {}).by, '刘向轩');
    chk('A3 系统管理员署名行未被改成回填名', (() => { const x = dd.ledger.find((y) => ((dd.seenIn || {})[String(y.c).toUpperCase()] || {}).by === '系统管理员'); return !x || x.by !== '系统管理员'; })(), true);
    chk('A4 开关持久', dd.ledgerByFixedV103, 1);
    const tk = (await post('/api/login', null, { username: 'e2e_byf_wh', password: 'E2e#Byf!pw' })).json.token;
    const ep = dd.ledgerEpoch, now = Date.now();
    console.log('\n=== B. 合并端登记人保留（新语义）===');
    // B1 同位重推仅改容器字段 → by 保留原登记人
    const row = dd.ledger.find((x) => String(x.l).startsWith('NB03-'));
    const b1 = await post('/api/ledger/sync', tk, { epoch: ep, items: [{ c: row.c, l: row.l, f: 'E2E改容器', t: row.t, p: row.p, n: row.n, q: row.q, b: row.b, pid: row.pid || '', mv: row.mv, src: row.src }], del: [] });
    await sleep(500); dd = load();
    chk('B1 同位重推受理', b1.json.ok, true);
    chk('B2 同位字段修正不洗登记人（仍=出生人）', (dd.ledger.find((x) => x.c === row.c) || {}).by, ((dd.seenIn || {})[row.c] || {}).by || row.by);
    // B3 改位 → by=推送人（E2E登记）
    const occ = new Set(dd.ledger.map((x) => String(x.l).toUpperCase()));
    const free = ['NB02-A-16-4F', 'NB02-B-16-4F', 'NB02-C-16-4F'].filter((l) => !occ.has(l))[0];
    await post('/api/ledger/sync', tk, { epoch: ep, items: [{ c: row.c, l: free, f: 'E2E改容器', t: now, p: row.p, n: row.n, q: row.q, b: row.b, pid: row.pid || '', mv: row.mv, src: row.src }], del: [] });
    await sleep(500); dd = load();
    chk('B3 改位后登记人=推送人（新位置新登记）', (dd.ledger.find((x) => x.c === row.c) || {}).by, 'E2E登记');
    console.log('\n=== C. 格数上限 200（保存端点）===');
    const c1 = await post('/api/ground-slots', tk, { entries: [{ prefix: 'NB03-A-99', count: 150 }] });
    await sleep(400); dd = load();
    chk('C1 count=150 被接受（旧版当越界删除）', [(c1.json.ok), (dd.groundSlots || {})['NB03-A-99']], [true, 150]);
    const c2 = await post('/api/ground-slots', tk, { entries: [{ prefix: 'NB03-A-99', count: 250 }] });
    await sleep(400); dd = load();
    chk('C2 count=250 越界=删除恢复默认', (dd.groundSlots || {})['NB03-A-99'], undefined);
    const c3 = await post('/api/ground-slots', tk, { entries: [{ prefix: 'NB03-A-99', count: 0 }] });
    await sleep(400); dd = load();
    chk('C3 count=0 删除语义保留', (dd.groundSlots || {})['NB03-A-99'], undefined);
    console.log('\n=== D. 幂等：二次启动不重复修复 ===');
    await sleep(400);
    srv.kill(); await sleep(600); try { srv.kill('SIGKILL'); } catch (_) {}
    const s2 = startSrv(); srv = s2;
    chk('D1 二次启动就绪', await waitUp(), true);
    await sleep(1200);
    chk('D2 登记人修复静默（不重复跑）', /\[ledger-by\] v103 按出生登记恢复/.test(srv.__log()), false);
    dd = load();
    chk('D3 修复值跨重启不漂移', (dd.ledger.find((x) => x.c === 'N26J270462') || {}).by, '刘向轩');
    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    try { srv.kill('SIGKILL'); } catch (_) {}
    await sleep(400);
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
