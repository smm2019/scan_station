// ㉖v102 预约自动开单件数换算 · 端到端取证（真实 HTTP 打隔离实例：推账本→stockWatchScan→bookingFulfill）
// 复现 10/30 现场事故：陈明预订2框、到料2框(300件/框)→ 旧版开单 qty=2"件"→建议报"严重超发白搬298件"
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_booking_v102');
const PORT = 8328, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
// 双账号复刻实况：预订人=物料员（requisition 权限归物料员，warehouse 为 false 会走 no-perm 转告分支不开单）；推账本=仓管
db0.users.push({ id: 'u_bk_mt', username: 'e2e_bk_mt', name: 'E2E预订人', role: 'material', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Bk!pw', salt) });
db0.users.push({ id: 'u_bk_wh', username: 'e2e_bk_wh', name: 'E2E仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Bk!pw', salt) });
// 预置两条数量预订（2框）：PN1 账本带件数(300/框)、PN2 账本件数为0（回退路径）
db0.watchlist = [
  { userId: 'u_bk_mt', partNo: '88E2EBK001', itemName: 'E2E预订件甲', qty: 2, auto: true, due: '', at: Date.now() - 1000 },
  { userId: 'u_bk_mt', partNo: '88E2EBK002', itemName: 'E2E预订件乙', qty: 2, auto: true, due: '', at: Date.now() - 1000 },
];
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p, tk) { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  srv.stdout.on('data', (b) => log.push(b.toString())); srv.stderr.on('data', (b) => log.push(b.toString()));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    const tk = (await post('/api/login', null, { username: 'e2e_bk_wh', password: 'E2e#Bk!pw' })).json.token; // 仓管：推账本触发入库
    const tkm = (await post('/api/login', null, { username: 'e2e_bk_mt', password: 'E2e#Bk!pw' })).json.token; // 预订人（物料员）：读本人领料单
    const ep = db0.ledgerEpoch, now = Date.now();
    // 动态找5个确定空闲货位（主库真实账本可能已占固定样例位，货位互斥闸会正确拦截，非本次验证对象）
    const occ = new Set(db0.ledger.map((x) => String(x.l || '').toUpperCase()));
    const cands = [];
    for (const z of ['A', 'B', 'C', 'D']) for (let r = 16; r >= 1 && cands.length < 8; r--) for (const f of ['4F', '3F']) { const k = `NB02-${z}-${String(r).padStart(2, '0')}-${f}`; if (!occ.has(k)) cands.push(k); }
    const FL = cands.slice(0, 5);
    if (FL.length < 5) { console.log('FAIL! 空货位不足'); process.exit(1); }
    const it = (c, l, q) => ({ c, l, f: '1800*1200_2', t: now, q, p: '88E2EBK001', n: 'E2E预订件甲', b: '2026-10-30', pid: '', mv: '登记', src: 'E2E' });
    const it2 = (c, l, q) => ({ c, l, f: '1800*1200_2', t: now, q, p: '88E2EBK002', n: 'E2E预订件乙', b: '2026-10-30', pid: '', mv: '登记', src: 'E2E' });
    // —— 场景1：预订2框，到料2框×300件 ——
    const p1 = await post('/api/ledger/sync', tk, { epoch: ep, items: [it('E2EBK0001', FL[0], 300), it('E2EBK0002', FL[1], 300)], del: [] });
    chk('B1 两框上账受理', p1.json.added, 2);
    await sleep(1500);
    let reqs = (await get('/api/requisitions', tkm)).json;
    let list = Array.isArray(reqs) ? reqs : (reqs.reqs || reqs.list || []);
    const r1 = list.find((r) => (r.items || []).some((i) => i.partNo === '88E2EBK001') && r.fromBooking === true);
    chk('B2 自动开单已生成', !!r1, true);
    chk('B3 需求件数=600（修复目标；旧版此处=2）', r1 && r1.items[0].qty, 600);
    chk('B4 备注含件数说明', r1 && /600 件/.test(r1.remark || ''), true);
    chk('B5 流转记录含"开单 600 件"', r1 && /开单 600 件/.test((r1.history || []).map((h) => h.text).join('|')), true);
    chk('B6 预订进度字段落库gotQty=600', (() => { const dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')); const w = (dd.watchlist || []).find((x) => x.partNo === '88E2EBK001'); return w && [w.got, w.gotQty, !!w.filledReq]; })(), [2, 600, true]);
    chk('B7 服务日志实证件数路径', /\[booking\] 88E2EBK001 够数自动开单 LL\d+ qty=600\(件数\)/.test(log.join('')), true);
    // —— 场景2：账本件数为0（取不到件数）→ 回退框数并标注请核对 ——
    const p2 = await post('/api/ledger/sync', tk, { epoch: ep, items: [it2('E2EBK0003', FL[2], 0), it2('E2EBK0004', FL[3], 0)], del: [] });
    chk('C1 两框(q=0)上账受理', p2.json.added, 2);
    await sleep(1500);
    reqs = (await get('/api/requisitions', tkm)).json;
    list = Array.isArray(reqs) ? reqs : (reqs.reqs || reqs.list || []);
    const r2 = list.find((r) => (r.items || []).some((i) => i.partNo === '88E2EBK002') && r.fromBooking === true);
    chk('C2 回退单已生成', !!r2, true);
    chk('C3 回退 qty=框数2', r2 && r2.items[0].qty, 2);
    chk('C4 回退标注请核对', r2 && /件数未知暂按框数，请核对/.test((r2.history || []).map((h) => h.text).join('|')), true);
    // —— 防重复开单闸不受影响：再推一框同零件1 → 已有未完单，不再开新单 ——
    const p3 = await post('/api/ledger/sync', tk, { epoch: ep, items: [it('E2EBK0005', FL[4], 300)], del: [] });
    chk('D1 第三框上账受理', p3.json.added, 1);
    await sleep(1500);
    reqs = (await get('/api/requisitions', tkm)).json;
    list = Array.isArray(reqs) ? reqs : (reqs.reqs || reqs.list || []);
    const dup = list.filter((r) => (r.items || []).some((i) => i.partNo === '88E2EBK001') && r.fromBooking === true);
    chk('D2 未重复开单（仍1张）', dup.length, 1);
    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill(); await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
