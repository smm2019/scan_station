// ㉖v103 账本件数对账 · 端到端取证（真实 HTTP 打隔离实例）
// 覆盖：①启动存量迁移纠正 11/3 现场虚高行 ②账本推送方向对账闸（旧缓存值被实测值覆盖）
//      ③流水推送方向对账（重扫即纠账本）④零误伤（无扫码行不动）⑤bump ledgerRev 缓存失效 ⑥幂等二启静默
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_qtyalign');
const PORT = 8330, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users.push({ id: 'u_qa', username: 'e2e_qa_wh', name: 'E2E对账', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Qa!pw', salt) });
delete db0.ledgerQtyFixedV103; // 副本清开关：主库若已被正式服务迁移过，继承开关会让隔离实例短路
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
function startSrv() { const sv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] }); const log = []; sv.stdout.on('data', (b) => log.push(b.toString())); sv.stderr.on('data', (b) => log.push(b.toString())); sv.__log = () => log.join(''); return sv; }
async function waitUp() { for (let i = 0; i < 40; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) {} } return false; }
(async () => {
  let srv = startSrv();
  if (!(await waitUp())) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    await sleep(900);
    let dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const rev0 = dd.ledgerRev || 0;
    console.log('\n=== A. 启动存量迁移（11/3 现场虚高行）===');
    chk('A1 迁移日志实证', /ledger-qty\] v103 按最新有效扫码纠正账本件数 \d+ 行/.test(srv.__log()), true);
    const m = (srv.__log().match(/纠正账本件数 (\d+) 行/) || [])[1];
    chk('A2 命中行数=1（全库零误伤实证）', +m, 1);
    chk('A3 N26J230463 300→220', (dd.ledger.find((x) => x.c === 'N26J230463') || {}).q, 220);
    chk('A4 兄弟码462未被误动(700)', (dd.ledger.find((x) => x.c === 'N26J230462') || {}).q, 700);
    chk('A5 该零件合计=920（与档案页一致）', dd.ledger.filter((x) => String(x.p || '').toUpperCase() === '8894153871').reduce((s, x) => s + (Number(x.q) || 0), 0), 920);
    // A6 基线必须取副本原值：迁移在 listen 回调内执行，服务就绪时已 bump 完，读文件拿到的 rev0 已是新值
    chk('A6 bump ledgerRev（缓存失效）', (dd.ledgerRev || 0) > (db0.ledgerRev || 0), true);
    chk('A7 幂等开关落库', dd.ledgerQtyFixedV103, 1);
    const readOps = () => { try { return fs.readdirSync(path.join(TDIR, 'ops')).map((f) => fs.readFileSync(path.join(TDIR, 'ops', f), 'utf8')).join('\n'); } catch (_) { return ''; } };
    const tk = (await post('/api/login', null, { username: 'e2e_qa_wh', password: 'E2e#Qa!pw' })).json.token;
    const ep = dd.ledgerEpoch, now = Date.now();
    console.log('\n=== B. 账本推送方向对账闸（旧缓存值不得覆盖实测）===');
    // 复刻事故：PDA 拿 LabelInfo 旧缓存 300 重推 → 应被最新有效扫码 220 纠正
    const p1 = await post('/api/ledger/sync', tk, { epoch: ep, items: [{ c: 'N26J230463', l: 'NB02-B-10-1F', f: '1800*1200_2', t: now, q: 300, p: '8894153871', n: 'E2E对账件', b: '2026-10-23', pid: 'TP1793693697545', mv: 'AGV', src: 'NB02-CK-05' }], del: [] });
    chk('B1 推送受理', p1.json.ok, true);
    await sleep(400);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('B2 账本仍是220（300被对账闸拦下）', (dd.ledger.find((x) => x.c === 'N26J230463') || {}).q, 220);
    chk('B3 活动流留痕件数对账（ops 落盘文件）', /件数对账/.test(readOps() + srv.__log()), true);
    console.log('\n=== C. 流水推送方向对账（重扫即纠账本）===');
    // 新标签：先入账本 500（无扫码），再推有效扫码 480 → 账本应被纠正
    const occ = new Set(dd.ledger.map((x) => String(x.l || '').toUpperCase()));
    const FL = ['NB02-A-16-4F', 'NB02-B-16-4F', 'NB02-C-16-4F'].filter((l) => !occ.has(l));
    if (!FL.length) { console.log('FAIL! 无空货位'); process.exit(1); }
    const a1 = await post('/api/ledger/sync', tk, { epoch: ep, items: [{ c: 'E2EAQ00001', l: FL[0], f: '1800*1200_2', t: now, q: 500, p: '88E2EAQ001', n: 'E2E对账试验件', b: '2026-11-03', pid: '', mv: '登记', src: '' }], del: [] });
    chk('C1 入账本500受理', a1.json.added, 1);
    await sleep(400);
    const a2 = await post('/api/scanlog/sync', tk, { items: [{ k: 'E2EAQ00001|B-E2E-QA|1', code: 'E2EAQ00001', wt: 1, st: '', gl: FL[0], ct: '1800*1200_2', rm: '', batch: 'B-E2E-QA', cx: false, t: now + 1000, pn: '88E2EAQ001', q: 480, mk: '', op: 'E2E对账', nm: 'E2E对账试验件', lot: '2026-11-03', mc: '', pid: '' }] });
    chk('C2 推有效扫码480受理', a2.json.ok, true);
    await sleep(400);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('C3 账本被流水对账纠正为480', (dd.ledger.find((x) => x.c === 'E2EAQ00001') || {}).q, 480);
    // 作废扫码不参与对账
    const a3 = await post('/api/scanlog/sync', tk, { items: [{ k: 'E2EAQ00001|B-E2E-QA|2', code: 'E2EAQ00001', wt: 1, st: '', gl: FL[0], ct: '', rm: '', batch: 'B-E2E-QA', cx: true, t: now + 9000, pn: '88E2EAQ001', q: 10, mk: '', op: 'E2E对账', nm: '', lot: '', mc: '', pid: '' }] });
    await sleep(400);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('C4 作废扫码(10件)不参与对账，账本仍480', (dd.ledger.find((x) => x.c === 'E2EAQ00001') || {}).q, 480);
    console.log('\n=== D. 零误伤：无扫码记录的行不受影响 ===');
    const a4 = await post('/api/ledger/sync', tk, { epoch: ep, items: [{ c: 'E2EAQ00002', l: FL[1], f: '1800*1200_2', t: now, q: 777, p: '88E2EAQ002', n: 'E2E无扫码件', b: '2026-11-03', pid: '', mv: '登记', src: '' }], del: [] });
    await sleep(400);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('D1 无扫码的账本行保留777（不被误改）', [(a4.json.added), (dd.ledger.find((x) => x.c === 'E2EAQ00002') || {}).q], [1, 777]);
    console.log('\n=== E. 幂等：二次启动不再迁移 ===');
    await sleep(400); // save 防抖落盘
    srv.kill(); await sleep(600); try { srv.kill('SIGKILL'); } catch (_) {}
    const s2 = startSrv(); srv = s2;
    chk('E1 二次启动就绪', await waitUp(), true);
    await sleep(900);
    chk('E2 二次启动迁移静默', /ledger-qty\] v103 按最新有效扫码纠正/.test(srv.__log()), false);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('E3 纠正值跨重启不漂移', (dd.ledger.find((x) => x.c === 'N26J230463') || {}).q, 220);
    chk('E4 对账后新增行不受影响', (dd.ledger.find((x) => x.c === 'E2EAQ00001') || {}).q, 480);
    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill(); await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
