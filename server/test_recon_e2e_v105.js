// ㉖v105 A+B 转单对账 · 服务器端到端取证（真实 HTTP 打隔离实例）
// 覆盖：①纯对账入账（codes全框+recon全框）→ 记账400、留痕、单据进ready待签收
//      ②部分对账（recon=1框）→ 留痕点名该框、其余走正常记账
//      ③不带recon的普通转单 → 行为与v103完全一致（零回归）
//      ④竞态守卫仍生效（codes不含的issued框自动回滚）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_recon_v105');
const PORT = 8334, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users.push({ id: 'u_rcn', username: 'e2e_rcn_wh', name: 'E2E对账', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Rcn!pw', salt) });
delete db0.reqRaceFixedV103; delete db0.ledgerQtyFixedV103; delete db0.ledgerByFixedV103;
// 注入三张 accepted 单（模拟 11/4 卡单形态：issued 有框、未 transferred；框均已消位=实物离架）
db0.requisitions.push(
  { id: 'rq_rcn_pure', no: 'LL-E2E-RCN-PURE', by: 'u_rcn', byName: 'E2E对账', status: 'accepted', acceptedBy: 'E2E对账', acceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(), toLoc: { WAREHOUSE_NAME: '焊-宁波-线边仓', DISTRICT_NAME: 'A109', LOC_NAME: 'A109-1' }, rush: false, note: '', history: [], items: [{ partNo: '88E2ERCN01', itemName: 'E2E对账件', qty: 400, issued: [{ c: 'E2ERCN0001', q: 200, l: 'NB02-A-16-4F' }, { c: 'E2ERCN0002', q: 200, l: 'NB02-B-16-4F' }], transferred: false, skipped: false, agvCalled: [] }] },
  { id: 'rq_rcn_part', no: 'LL-E2E-RCN-PART', by: 'u_rcn', byName: 'E2E对账', status: 'accepted', acceptedBy: 'E2E对账', acceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(), toLoc: { WAREHOUSE_NAME: '焊-宁波-线边仓', DISTRICT_NAME: 'A109', LOC_NAME: 'A109-1' }, rush: false, note: '', history: [], items: [{ partNo: '88E2ERCN02', itemName: 'E2E部分件', qty: 400, issued: [{ c: 'E2ERCN0003', q: 200, l: 'NB02-C-16-4F' }, { c: 'E2ERCN0004', q: 200, l: 'NB02-D-16-4F' }], transferred: false, skipped: false, agvCalled: [] }] },
  { id: 'rq_rcn_norm', no: 'LL-E2E-RCN-NORM', by: 'u_rcn', byName: 'E2E对账', status: 'accepted', acceptedBy: 'E2E对账', acceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(), toLoc: { WAREHOUSE_NAME: '焊-宁波-线边仓', DISTRICT_NAME: 'A109', LOC_NAME: 'A109-1' }, rush: false, note: '', history: [], items: [{ partNo: '88E2ERCN03', itemName: 'E2E普通件', qty: 200, issued: [{ c: 'E2ERCN0005', q: 200, l: 'NB02-E-16-4F' }], transferred: false, skipped: false, agvCalled: [] }] },
  { id: 'rq_rcn_race', no: 'LL-E2E-RCN-RACE', by: 'u_rcn', byName: 'E2E对账', status: 'accepted', acceptedBy: 'E2E对账', acceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(), toLoc: { WAREHOUSE_NAME: '焊-宁波-线边仓', DISTRICT_NAME: 'A109', LOC_NAME: 'A109-1' }, rush: false, note: '', history: [], items: [{ partNo: '88E2ERCN04', itemName: 'E2E竞态件', qty: 400, issued: [{ c: 'E2ERCN0006', q: 200, l: 'NB02-A-15-4F' }, { c: 'E2ERCN0007', q: 200, l: 'NB02-B-15-4F' }], transferred: false, skipped: false, agvCalled: [] }] },
);
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
function startSrv() { const sv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] }); const log = []; sv.stdout.on('data', (b) => log.push(b.toString())); sv.stderr.on('data', (b) => log.push(b.toString())); sv.__log = () => log.join(''); return sv; }
async function waitUp() { for (let i = 0; i < 40; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) {} } return false; }
const load = () => JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const hist = (rid, re) => (load().requisitions.find((x) => x.id === rid).history || []).filter((h) => re.test(String(h.text || '')));
(async () => {
  const srv = startSrv();
  if (!(await waitUp())) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    await sleep(9500);
    const tk = (await post('/api/login', null, { username: 'e2e_rcn_wh', password: 'E2e#Rcn!pw' })).json.token;
    console.log('\n=== R1 纯对账入账（11/4 卡单修复路径）===');
    const r1 = await post('/api/requisitions/rq_rcn_pure/transfer', tk, { partNo: '88E2ERCN01', codes: [{ c: 'E2ERCN0001', q: 200 }, { c: 'E2ERCN0002', q: 200 }], recon: ['E2ERCN0001', 'E2ERCN0002'] });
    await sleep(500);
    const it1 = load().requisitions.find((x) => x.id === 'rq_rcn_pure').items[0];
    chk('R1a 受理并转单成功', r1.json.ok, true);
    chk('R1b 记账=400件（codes全框口径）', [it1.transferred, it1.transferQty], [true, 400]);
    chk('R1c 对账留痕点名两框', hist('rq_rcn_pure', /对账入账：框 E2ERCN0001\/E2ERCN0002/).length, 1);
    chk('R1d 正常转单留痕并存', hist('rq_rcn_pure', /^转MES 88E2ERCN01 实发400件/).length, 1);
    chk('R1e 出库承诺登记两框', (() => { const s = load().seenOut; return [!!s['E2ERCN0001'], !!s['E2ERCN0002']]; })(), [true, true]);
    chk('R1f 单据进ready待签收（finalize打勾）', load().requisitions.find((x) => x.id === 'rq_rcn_pure').status, 'ready');
    console.log('\n=== R2 部分对账（recon=1框）===');
    const r2 = await post('/api/requisitions/rq_rcn_part/transfer', tk, { partNo: '88E2ERCN02', codes: [{ c: 'E2ERCN0003', q: 200 }, { c: 'E2ERCN0004', q: 200 }], recon: ['E2ERCN0003'] });
    await sleep(500);
    const it2 = load().requisitions.find((x) => x.id === 'rq_rcn_part').items[0];
    chk('R2a 受理', r2.json.ok, true);
    chk('R2b 记账=400件', [it2.transferred, it2.transferQty], [true, 400]);
    chk('R2c 留痕只点名对账框', hist('rq_rcn_part', /对账入账：框 E2ERCN0003（?[^0-9]/).length + hist('rq_rcn_part', /对账入账：框 E2ERCN0003$/).length, 1);
    console.log('\n=== R3 不带recon普通转单（零回归）===');
    const r3 = await post('/api/requisitions/rq_rcn_norm/transfer', tk, { partNo: '88E2ERCN03', codes: [{ c: 'E2ERCN0005', q: 200 }] });
    await sleep(500);
    const it3 = load().requisitions.find((x) => x.id === 'rq_rcn_norm').items[0];
    chk('R3a 受理记账200件', [r3.json.ok, it3.transferred, it3.transferQty], [true, true, 200]);
    chk('R3b 无对账留痕（旧行为零变化）', hist('rq_rcn_norm', /对账入账/).length, 0);
    console.log('\n=== R4 竞态守卫与recon共存（codes漏框仍回滚）===');
    // 单4（启动前注入）：issued=[0006,0007]，codes只传[0006]，无recon → 0007 应被回滚（v103 守卫不受 recon 影响）
    const r4 = await post('/api/requisitions/rq_rcn_race/transfer', tk, { partNo: '88E2ERCN04', codes: [{ c: 'E2ERCN0006', q: 200 }] });
    await sleep(500);
    const it4 = load().requisitions.find((x) => x.id === 'rq_rcn_race').items[0];
    chk('R4a codes不含的框被回滚、记账按codes', [r4.json.ok, it4.transferQty, (it4.issued || []).length], [true, 200, 1]);
    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill(); await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
