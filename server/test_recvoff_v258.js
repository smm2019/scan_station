// ㉖v258 来料区关闭态审计：receivingOn=0 时整套两楼流转惰性 + v255/v257 新功能与开关交互正确（用户 11-25 问"关闭会不会出问题"）
// 剧本：开→造楼下存量 → 关 → ①存量转入判据仍放行(S8h 语义+新码不受源头闸) ②v255 档案 recv 桶照报 ③v257 trace final 橙点破
//       ④一楼登记 403 硬闸 ⑤关闭期误扫 NB04 账本拒登+留痕 ⑥新码直采二楼不受累 → 重开 → 登记恢复
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_off_v258');
const PORT = 8438, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ username: 'v258_ad', id: 'u_v258', name: 'V258管理', role: 'admin', enabled: true, salt, passHash: hp('E2e#O8!pw', salt) });
// 楼下存量：用干净测试码（避开生产占位）——开关开时登记
const BOX = 'V258BOX001', NEWC = 'V258NEW001', SLOT = 'NB04-A-09-101'; // A-09-101：默认参数(1排720格)外的排→开态登记也测范围闸？不——默认 recvRows=1 会拒。改用 A-01 段空位动态找
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  let _rev = 0; const setOn = async (v) => { _rev = (await (await fetch(BASE + '/api/admin/params', { headers: { Authorization: 'Bearer ' + tk } })).json()).cfgRev || 0; return (await (await fetch(BASE + '/api/admin/params', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ values: { receivingOn: v }, baseRev: _rev }) })).json()); };
  const post = async (p, b) => (await (await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify(b) })).json());
  const getj = async (p) => (await (await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + tk } })).json());
  let tk = '';
  try {
    tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v258_ad', password: 'E2e#O8!pw' }) })).json()).token;
    // 动态找空 NB04 格（默认参数范围内）
    const L = (await getj('/api/ledger/locs?recv=1')).byLoc || {};
    let slot = ''; for (let c = 100; c <= 130 && !slot; c++) { const k = 'NB04-A-01-' + String(c).padStart(3, '0'); if (!L[k]) slot = k; }
    chkT('A0 找到空格位（前提）', !!slot, slot);
    // 开态登记楼下存量
    const r1 = await post('/api/ledger/sync', { items: [{ c: BOX, l: slot, p: 'V258PN0001', n: 'V258样本', q: 100, b: 'B261125', t: Date.now(), mv: '登记', src: '来料区', f: '2.4米铁框' }] });
    chkT('A1 开态登记成功（前提）', r1.ok === true && r1.added >= 1, JSON.stringify(r1).slice(0, 120));
    // ===== 关闭 =====
    chkT('B0 管理员关闭来料区', (await setOn(0)).ok === true, '');
    // B1 存量转入判据仍放行（不看开关，S8h 语义延续到 v257 契约）
    const ck = await getj('/api/label/check?c=' + BOX);
    chkT('B1 关态存量转入判据放行+recvLoc 回显', ck.ok === true && ck.blockIn === false && ck.recvLoc === slot.toUpperCase(), JSON.stringify([ck.blockIn, ck.recvLoc]));
    // B2 v255 档案 recv 桶关态照报（拆桶按账本不按开关——货还压在楼下是事实）
    const pr = await getj('/api/part/profile?pn=V258PN0001');
    chkT('B2 关态档案 recv 桶照报 1 框', pr.ok === true && pr.recv && pr.recv.boxes === 1 && pr.recv.qty === 100, JSON.stringify(pr.recv));
    // B3 v257 trace final 关态点破楼下（转入通道关着仍指引正确：等开启或位置登记）
    const tr = await getj('/api/trace?q=' + BOX);
    chkT('B3 关态 trace final 点破一楼滞留', /一楼|来料/.test(tr.final || '') && /E65100/i.test(tr.finalCol || ''), tr.final + '|' + tr.finalCol);
    // B4 一楼登记模式 403 硬闸（PDA 入口同步隐藏前，旧版/竞态扫也被服务器拦）
    const r4 = await fetch(BASE + '/api/label/check?c=' + NEWC + '&recv=1', { headers: { Authorization: 'Bearer ' + tk } });
    chkT('B4 关态登记查重 403', r4.status === 403, String(r4.status));
    // B5 旧版PDA 硬扫 NB04 上账 → 账本拒登（关态 recvSlotOk 一律 false）+ 点名
    const r5 = await post('/api/ledger/sync', { items: [{ c: NEWC, l: 'NB04-A-01-102', p: 'V258PN0002', q: 5, t: Date.now(), mv: '登记', src: '来料区' }] });
    chkT('B5 关态 NB04 上账被拒+点名未启用', (r5.rejectedLoc || []).some((s) => /未启用/.test(s)), JSON.stringify(r5.rejectedLoc || r5).slice(0, 160));
    // B6 新码二楼直采不受累（关闭=整套惰性回单楼模式，源头闸休眠）
    const M = (await getj('/api/ledger/locs?all=1')).byLoc || {};
    let gnd = ''; for (let r2 = 17; r2 <= 18 && !gnd; r2++) for (let c2 = 1; c2 <= 12 && !gnd; c2++) { const k = 'NB03-G-' + String(r2).padStart(2, '0') + '-' + String(c2).padStart(2, '0'); if (!M[k]) gnd = k; }
    const r6 = await post('/api/ledger/sync', { items: [{ c: NEWC, l: gnd, p: 'V258PN0002', n: 'V258新码', q: 5, b: 'B261125', t: Date.now(), mv: '人工', src: 'E2E', f: '2.4米铁框' }] });
    chkT('B6 关态新码二楼直采正常（源头闸休眠）', r6.ok === true && r6.added >= 1, JSON.stringify(r6).slice(0, 140));
    // B7 滞留清扫关态惰性（源码级：!receivingOn return）
    const ssrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('B7 滞留清扫关态直接 return（不轰炸）', /if \(!receivingOn\(\)\) return; \/\/ ㉖v118/.test(ssrc), '');
    // ===== 重开 =====
    chkT('C0 重新开启', (await setOn(1)).ok === true, '');
    const r8 = await post('/api/ledger/sync', { items: [{ c: 'V258BOX002', l: 'NB04-A-01-103', p: 'V258PN0003', n: 'V258重开', q: 9, b: 'B261125', t: Date.now(), mv: '登记', src: '来料区' }] });
    chkT('C1 重开后一楼登记恢复', r8.ok === true && r8.added >= 1, JSON.stringify(r8).slice(0, 120));
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail}` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
