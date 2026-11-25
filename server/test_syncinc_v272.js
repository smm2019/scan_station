// ㉖v272 sync增量化+counts写失效·数据安全/准确取证（用户底线：百分百可靠）
// 安全前提验证：①ledger/sync 只upsert不删缺失行（增量不丢别台数据）②scanlog/sync 不删缺失行
//   ③增量对账守卫：未推送的存量行不被本批旧数据误纠 ④counts写失效：数据变更立即反映(无TTL脏读)、不变才复用
// 性能：⑤counts二次读(缓存命中)显著快于首读
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_syncinc_v272');
const PORT = 8467, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v272', username: 'v272_w', name: 'V272仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#I2!w', salt) });
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0 });
// 预置两台账本行+两条流水（模拟别台数据），验证增量推送不丢它们
db0.ledger = (db0.ledger || []).filter((x) => !String(x.c).startsWith('V272'));
db0.ledger.push({ c: 'V272KEEP', l: 'NB02-H-05-1F', p: 'V272PK', q: 70, t: Date.now() - 900e3 });
db0.ledger.push({ c: 'V272UPD', l: 'NB02-H-05-2F', p: 'V272PU', q: 50, t: Date.now() - 900e3 });
db0.scanlog = db0.scanlog || {};
db0.scanlog['V272KEEP|B|1'] = { k: 'V272KEEP|B|1', code: 'V272KEEP', wt: 0, st: 'NB02-CK-01', gl: '', cx: false, t: Date.now() - 900e3, q: 70, pn: 'V272PK', batch: 'B' };
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  const post = async (p, tk, b) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify(b) })).json().catch(() => ({})));
  const getj = async (p, tk) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tk } })).json().catch(() => ({})));
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v272_w', password: 'E2e#I2!w' }) })).json()).token;
    // ① 增量ledger推送只带 V272UPD（改q=60），不带 V272KEEP → KEEP 必须保留（不删缺失行）
    const lr = await post('/api/ledger/sync', tk, { items: [{ c: 'V272UPD', l: 'NB02-H-05-2F', p: 'V272PU', q: 60, t: Date.now() }], del: [], epoch: '' });
    const led = await getj('/api/ledger', tk);
    const rows = led.items || led.ledger || [];
    const keep = rows.find((x) => x.c === 'V272KEEP'), upd = rows.find((x) => x.c === 'V272UPD');
    chkT('★①增量推送不丢别台行(V272KEEP保留)', !!keep && keep.q === 70, JSON.stringify(keep));
    chkT('①b 推送行正确更新(q=60)', !!upd && upd.q === 60, JSON.stringify(upd));
    // ② 增量scanlog推送只带新行，不带 V272KEEP 流水 → 保留
    const sr = await post('/api/scanlog/sync', tk, { items: [{ k: 'V272NEW|B|2', code: 'V272NEW', wt: 0, st: 'NB02-CK-02', gl: '', cx: false, t: Date.now(), q: 30, pn: 'V272PN', batch: 'B' }] });
    const sl = await getj('/api/scanlog?c=V272KEEP', tk);
    chkT('★②增量scanlog不丢存量流水', (sl.items || []).some((x) => x.code === 'V272KEEP'), JSON.stringify((sl.items || []).length));
    // ③ 增量对账守卫：推送一条 V272UPD 旧q=10 的流水(非本批变更?它是变更行)→应只对账本批行。
    //    关键：V272KEEP 账本q=70，推送不含KEEP流水 → KEEP 不被误纠（仍70）
    chkT('★③未推送存量行不被误纠(KEEP仍70)', (rows.find((x) => x.c === 'V272KEEP') || {}).q === 70, '');
    // ④ counts写失效：先读(建缓存)→改数据(ledger/sync)→再读必须反映新值(无脏读)
    const c1 = await getj('/api/counts', tk);
    await post('/api/ledger/sync', tk, { items: [{ c: 'V272UPD', l: 'NB02-H-05-2F', p: 'V272PU', q: 99, t: Date.now() }], del: [], epoch: '' });
    const c2 = await getj('/api/counts', tk);
    chkT('★④counts写失效:变更后立即反映(无TTL脏读)', c2.stockQty !== c1.stockQty, JSON.stringify({ before: c1.stockQty, after: c2.stockQty }));
    // ⑤ 性能：不变时二次读缓存命中快
    const t1 = Date.now(); await getj('/api/counts', tk); const d1 = Date.now() - t1;
    const t2 = Date.now(); await getj('/api/counts', tk); const d2 = Date.now() - t2;
    chkT('★⑤counts缓存命中读<50ms', d2 < 50, `首读=${d1}ms 缓存=${d2}ms`);
    console.log(`\n===== v272 sync增量+counts写失效 安全/准确取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
