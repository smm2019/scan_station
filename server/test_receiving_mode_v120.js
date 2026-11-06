// ㉖v120 来料区登记模式（PDA 第三档作业模式）· 服务器契约端到端证明
// PDA 来料模式的每个动作都落到这几个服务器调用上，本测试按 PDA 真实调用序列逐一证明：
//  M1 locs?recv=1 返回 占用表+recvRows+recvCols —— nb01AutoSlot 的数据源
//  M2 按 PDA 算法（R1-01→R1-02→…取首空）放格 → 推账本(mv=登记/src=来料区，workType==2 派生) → 上账成功
//  M3 两台 PDA 同刻抢同格 → 服务器货位互斥拒回（防撞格兜底证明）
//  M4 重复登记：labelCheck&recv=1 对 NB01 在库码 blockIn=true（一楼再扫同一筐被拦）
//  M5 二楼转入：labelCheck 无 recv 同码 blockIn=false + recvLoc 回显（同一行改位放行）
//  M6 区满：参数调 1×2 占满后 PDA 算法返回 null（登记中止提示清位）；调回恢复
//  M7 开关关：推 NB01 源头拒"来料区未启用"；locs?recv=1 仍可读（只读不伤）
//  M8 流水体检：wt=2 gl=NB01 不被 flowModeBad 误判错配
//  M9 退库契约：labelCheck&ret=1 对 seenOut 码放行（二楼退库模式数据面）
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_rmode_v120'); const PORT = 8341; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json')); fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_m120', username: 'm120_wh', name: 'M120来料仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Rm!120', salt) });
db0.users.push({ id: 'u_m120_ad', username: 'm120_ad', name: 'M120管理', role: 'admin', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Rm!ad', salt) });
db0.seenOut = db0.seenOut || {}; db0.seenOut['M120RET00001'] = { at: now - 5 * 86400e3, batch: 'B261101', no: 'LL-M120-OLD' };
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
// PDA nb01AutoSlot 算法复刻（collection_ledger.dart：服务器 byLoc 权威，R1-01→R1-12→R2-01… 取首空）
function pdaAutoSlot(byLoc, rows, cols) {
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) {
    const code = `NB01-R${r}-${String(c).padStart(2, '0')}`;
    if (!byLoc[code]) return code;
  }
  return null;
}
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v120 来料登记模式契约证明');
  try {
    const wh = (await post('/api/login', null, { username: 'm120_wh', password: 'E2e#Rm!120' })).json.token;
    const ad = (await post('/api/login', null, { username: 'm120_ad', password: 'E2e#Rm!ad' })).json.token;
    if (!ad) throw new Error('管理员登录失败');
    // ===== M1 locs?recv=1 三件套 =====
    const L1 = (await get('/api/ledger/locs?recv=1', wh)).json;
    chkT('M1a recv 口径返回 byLoc+recvRows+recvCols', L1.ok === true && L1.byLoc && typeof L1.recvRows === 'number' && typeof L1.recvCols === 'number');
    chk('M1b 默认参数 15×12', [L1.recvRows, L1.recvCols], [15, 12]);
    // ===== M2 PDA 算法放格 → 推账本（workType==2 派生 mv=登记/src=来料区） =====
    const slot1 = pdaAutoSlot(L1.byLoc, L1.recvRows, L1.recvCols);
    chkT('M2a 首空格为 NB01-R1-01', slot1 === 'NB01-R1-01');
    const sp2 = await post('/api/ledger/sync', wh, { items: [{ c: 'M120BOX0001', l: slot1, p: '66M120PN0001', n: 'M120来料件', q: 100, b: 'B261101', t: now, mv: '登记', src: '来料区', f: '筐' }] });
    chkT('M2b 登记上账成功', sp2.json.ok === true && sp2.json.added >= 1);
    const led2 = (await get('/api/ledger?c=M120BOX0001', wh)).json.items || [];
    chk('M2c 账本行 mv=登记 src=来料区', [led2.length === 1 ? led2[0].mv : '', led2.length === 1 ? led2[0].src : ''], ['登记', '来料区']);
    // ===== M3 双 PDA 同刻抢同格：第二台也算出 R1-01 → 服务器互斥拒 =====
    const L3 = (await get('/api/ledger/locs?recv=1', wh)).json;
    const slot3a = pdaAutoSlot(L3.byLoc, L3.recvRows, L3.recvCols);
    chkT('M3a 第二台 PDA 拉到最新占用后让位 R1-02', slot3a === 'NB01-R1-02');
    const sp3 = await post('/api/ledger/sync', wh, { items: [{ c: 'M120BOX0009', l: slot1, p: '66M120PN0009', n: 'M120抢格件', q: 5, b: 'B261109', t: now + 9000, mv: '登记', src: '来料区' }] }); // 旧缓存竞态：仍推 R1-01
    chkT('M3b 竞态抢同格被货位互斥闸拒回', String(JSON.stringify(sp3.json.rejected || [])).includes('已被框 M120BOX0001 占用'));
    // ===== M4/M5 同一码两楼两扫 =====
    const ck4 = (await get('/api/label/check?c=M120BOX0001&recv=1', wh)).json;
    chk('M4 一楼重复登记被拦（recv=1 不豁免）', ck4.blockIn, true);
    const ck5 = (await get('/api/label/check?c=M120BOX0001', wh)).json;
    chk('M5 二楼转入放行+回显格位（无 recv 豁免）', [ck5.blockIn, ck5.recvLoc], [false, slot1]);
    // ===== M6 区满：参数 1×2 占满 → PDA 算法 null =====
    const rev = (await get('/api/admin/params', ad)).json.cfgRev || 0;
    await post('/api/admin/params', ad, { values: { recvRows: 1, recvCols: 2 }, baseRev: rev });
    await post('/api/ledger/sync', wh, { items: [{ c: 'M120BOX0002', l: 'NB01-R1-02', p: '66M120PN0002', n: 'M120来料件2', q: 50, b: 'B261102', t: now + 2000, mv: '登记', src: '来料区' }] });
    const L6 = (await get('/api/ledger/locs?recv=1', wh)).json;
    chk('M6a 参数生效 1×2', [L6.recvRows, L6.recvCols], [1, 2]);
    chkT('M6b 两格占满→PDA 算法返回 null（登记中止提示清位）', pdaAutoSlot(L6.byLoc, L6.recvRows, L6.recvCols) === null);
    const rev6 = (await get('/api/admin/params', ad)).json.cfgRev || 0;
    await post('/api/admin/params', ad, { values: { recvRows: 15, recvCols: 12 }, baseRev: rev6 });
    const L6c = (await get('/api/ledger/locs?recv=1', wh)).json;
    chkT('M6c 调回 15×12 后算法恢复出格', pdaAutoSlot(L6c.byLoc, L6c.recvRows, L6c.recvCols) === 'NB01-R1-03');
    // ===== M7 开关关：源头拒 + 只读不伤 =====
    const rev7 = (await get('/api/admin/params', ad)).json.cfgRev || 0;
    await post('/api/admin/params', ad, { values: { receivingOn: 0 }, baseRev: rev7 });
    const sp7 = await post('/api/ledger/sync', wh, { items: [{ c: 'M120BOX0003', l: 'NB01-R2-01', p: '66M120PN0003', n: 'M120关后件', q: 5, b: 'B261103', t: now + 3000, mv: '登记', src: '来料区' }] });
    chkT('M7a 开关关推 NB01 源头拒（来料区未启用）', String(JSON.stringify(sp7.json.rejectedLoc || [])).includes('来料区未启用'));
    const ck7b = await get('/api/label/check?c=M120BOX0003&recv=1', wh);
    chk('M7b 开关关一楼登记查重 403', ck7b.status, 403);
    const L7c = (await get('/api/ledger/locs?recv=1', wh)).json;
    chkT('M7c 开关关 locs?recv=1 只读仍可用（存量筐二楼仍可见）', L7c.ok === true && !!L7c.byLoc[slot1]);
    const rev7d = (await get('/api/admin/params', ad)).json.cfgRev || 0;
    await post('/api/admin/params', ad, { values: { receivingOn: 1 }, baseRev: rev7d });
    // ===== M8 流水体检：wt=2 gl=NB01 不误判 =====
    const sk8 = await post('/api/scanlog/sync', wh, { items: [{ k: 'M120BOX0001|B261101|' + now, code: 'M120BOX0001', wt: 2, gl: slot1, st: '', ct: '筐', batch: 'B261101', pn: '66M120PN0001', q: 100, mk: '2026-11-01T08:00:00', op: 'M120来料仓管', nm: 'M120来料件', lot: 'B261101' }] });
    chkT('M8 wt=2 来料流水推送正常（flowModeBad 不误判错配）', sk8.json.ok === true);
    // ===== M9 退库契约 =====
    const ck9a = (await get('/api/label/check?c=M120RET00001', wh)).json;
    chk('M9a 退库原码默认拦（复用拦）', ck9a.blockIn, true);
    const ck9b = (await get('/api/label/check?c=M120RET00001&ret=1', wh)).json;
    chk('M9b ret=1 退库模式放行', ck9b.blockIn, false);
  } catch (e) { fail++; console.log('FAIL! 异常：', e && e.message); }
  finally { srv.kill(); }
  console.log(`\n===== v120 来料登记模式契约证明：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
