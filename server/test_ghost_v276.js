// ㉖v276 幽灵出库延迟复核 + 发料前强推 取证（处方③④，0254 案 26s 直穿实锤）
// 断言：①出库时无出生证据→进 ghostPending 待复核，不立即告警（防直穿误报）
//   ②宽限期内流水到达→直穿闭环：补 seenIn 出生证明（D9 不断链）+ 队列清空 + 无 ghost_out 告警
//   ③三轮复核仍无出生证据→真幽灵 ghost_out 必达告警
//   ④PDA 发料提交前强推在位（ledgerPushPending→ledgerPushNow + scanPushNow）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_ghost_v276');
const PORT = 8473, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v276', username: 'v276_w', name: 'V276仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#G6!w', salt) });
db0.params = Object.assign(db0.params || {}, { outConsumeLedger: 1 });
db0.ghostPending = [];
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
  const readDb = () => JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  try {
    const tk = (await post('/api/login', null, { username: 'v276_w', password: 'E2e#G6!w' })).token;
    // ① 出库一个从未入账的码 → 待复核不立即告警
    const ob = await post('/api/outbound/sync', tk, { orderNo: 'DTV276A', createdAt: Date.now(), toLoc: '焊-宁波-线边仓', operator: 'v276_w', items: [{ code: 'V276PN', barcode: 'V276GHOST1', qty: 10, fromLoc: 'NB03-C-12-01' }] });
    await sleep(900); // save 防抖120ms+异步写队列，落盘约500ms
    let d = readDb();
    chkT('★①无出生证据→ghostPending待复核', (d.ghostPending || []).some((e) => e.c === 'V276GHOST1'), JSON.stringify(d.ghostPending));
    const notif0 = await getj('/api/notifications', tk);
    chkT('①b不立即发ghost_out告警', !(notif0.notifications || []).some((n) => n.type === 'ghost_out' && /V276GHOST1/.test(n.text || '')), '');
    // ② 宽限期内流水到达 → 直穿闭环 + 补 seenIn
    await post('/api/scanlog/sync', tk, { items: [{ k: 'V276GHOST1|B|1', code: 'V276GHOST1', wt: 1, gl: 'NB03-C-12-01', st: '', cx: false, t: Date.now() - 20000, q: 10, pn: 'V276PN', batch: 'B', op: 'V276仓管' }] });
    await sleep(900);
    d = readDb();
    chkT('★②流水到达→直穿闭环队列清空', !(d.ghostPending || []).some((e) => e.c === 'V276GHOST1'), JSON.stringify(d.ghostPending));
    chkT('★②b补seenIn出生证明(D9不断链)', !!(d.seenIn || {})['V276GHOST1'], JSON.stringify((d.seenIn || {})['V276GHOST1']));
    const notif1 = await getj('/api/notifications', tk);
    chkT('②c闭环无ghost_out告警', !(notif1.notifications || []).some((n) => n.type === 'ghost_out' && /V276GHOST1/.test(n.text || '')), '');
    // ③ 真幽灵：出库另一个码，不给出生证据。复核定时器60s/轮、宽限90s×3轮≈270s，等真实周期（内存态不可外改）
    await post('/api/outbound/sync', tk, { orderNo: 'DTV276B', createdAt: Date.now(), toLoc: '焊-宁波-线边仓', operator: 'v276_w', items: [{ code: 'V276PN2', barcode: 'V276REAL', qty: 5, fromLoc: 'NB03-C-12-02' }] });
    console.log('…等待真实复核周期（60s/轮、宽限90s×3轮交错，约6分钟）');
    await sleep(375000);
    const notif2 = await getj('/api/notifications', tk);
    chkT('★③三轮复核无出生证据→真幽灵告警必达', (notif2.notifications || []).some((n) => n.type === 'ghost_out' && /V276REAL/.test(n.text || '')), JSON.stringify((notif2.notifications || []).filter((n) => n.type === 'ghost_out').map((n) => (n.text || '').slice(0, 60))));
    // ④ PDA 发料前强推在位
    const rq = fs.readFileSync(path.join(__dirname, '..', 'lib', 'requisition_page.dart'), 'utf8').replace(/\s+/g, ' ');
    chkT('④PDA发料提交前强推在位', rq.includes('if (ledgerPushPending) { try { await ledgerPushNow(); } catch (_) {} }') && rq.includes('try { await scanPushNow(); } catch (_) {}'), '');
    console.log(`\n===== v276 幽灵延迟复核+发料强推取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
