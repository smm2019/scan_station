// ㉖v120b 来料区"关闭却扫得上"修复 · 端到端实例证明
// 现场事故（11/07 宋明明 PDA）：receivingOn=0 时来料档扫码，账本被源头闸拒，但采集流水照常落库
// （N26K030105@NB04-A-01-001，档案挂⚠️未登记）——根因=开关只闸了入账、没闸扫码。
// 修复三层：①locs?recv=1 下发 receivingOn（PDA 数据源）②PDA 入口/放格/保存链据此中止（流水账本都不落）
// ③服务器流水层体检留痕兜底（旧版 PDA/竞态窗口的幽灵可见可查）。本测试按事故时间线逐环节证明。
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_roff_v120b'); const PORT = 8351; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json')); fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_roff_w', username: 'roff_w', name: 'ROFF仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Rf!120b', salt) });
db0.users.push({ id: 'u_roff_a', username: 'roff_a', name: 'ROFF管理', role: 'admin', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Rfa!120b', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const PN = '66ROFFPN0001', CODE = 'ROFFBOX0001', CODE2 = 'ROFFBOX0002'; // CODE2=事故码：关期流水流入，重开后再登记应被"已有采集记录"拦（幽灵处置链证明）
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v120b 来料区关闭闸全链路证明');
  try {
    const wh = (await post('/api/login', null, { username: 'roff_w', password: 'E2e#Rf!120b' })).json.token;
    const ad = (await post('/api/login', null, { username: 'roff_a', password: 'E2e#Rfa!120b' })).json.token;
    const setOn = async (v) => { const rev = (await get('/api/admin/params', ad)).json.cfgRev || 0; return (await post('/api/admin/params', ad, { values: { receivingOn: v }, baseRev: rev })).json.ok === true; };
    // 动态取 NB04 空格位（复刻 nb01AutoSlot 行为，避免撞生产库存量行）+ 实时时刻（避免早于作废墓碑）
    const _used = new Set();
    const freeSlot = async (tk) => {
      const byLoc = (await get('/api/ledger/locs?recv=1', tk)).json.byLoc || {};
      for (let cc = 1; cc <= 720; cc++) {
        const s = 'NB04-A-01-' + String(cc).padStart(3, '0');
        if (!byLoc[s] && !_used.has(s)) { _used.add(s); return s; }
      }
      throw new Error('来料区无空测试格位');
    };

    // ===== R1 开关开：locs 下发 receivingOn=1，登记链路正常（PDA 据 1 显示模式卡）=====
    const L1 = (await get('/api/ledger/locs?recv=1', wh)).json;
    chk('R1a 开=locs 带 receivingOn:1', L1.receivingOn, 1);
    const slot1 = await freeSlot(wh); // 开时件落位动态取空（生产继承数据 NB04 存量 653 行，硬编码必撞互斥闸）
    const sp1 = await post('/api/ledger/sync', wh, { items: [{ c: CODE, l: slot1, p: PN, n: 'ROFF开时件', q: 10, b: 'B261107', t: now, mv: '登记', src: '来料区' }] });
    chkT('R1b 开时登记正常上账', sp1.json.ok === true && sp1.json.added >= 1);
    const ck1 = await get('/api/label/check?c=ROFFNEW001&recv=1', wh);
    chk('R1c 开时登记查重 200 放行', ck1.status, 200);

    // ===== R2 关闭开关：三处闸同步生效 =====
    chkT('R2a 管理员关闭开关', await setOn(0));
    const L2 = (await get('/api/ledger/locs?recv=1', wh)).json;
    chk('R2b 关=locs 下发 receivingOn:0（PDA 入口闸数据源）', L2.receivingOn, 0);
    const ck2 = await get('/api/label/check?c=ROFFNEW002&recv=1', wh);
    chk('R2c 关=登记查重 403（PDA 硬拦数据源）', ck2.status, 403);
    chkT('R2d 403 带明确原因文案', String((ck2.json || {}).msg || '').includes('来料区未启用'));
    const sp2 = await post('/api/ledger/sync', wh, { items: [{ c: 'ROFFNEW002', l: 'NB04-A-01-002', p: PN, q: 5, b: 'B261108', t: now + 1000, mv: '登记', src: '来料区' }] });
    chkT('R2e 关=账本源头拒（原有闸零回归）', String(JSON.stringify(sp2.json.rejectedLoc || [])).includes('来料区未启用'));
    // R2f 关键：旧版 PDA/竞态窗口流水仍会流入（原始证据铁律不拒收）——服务器必须留痕点名，供追查"关了怎么还扫上"
    const sl2 = await post('/api/scanlog/sync', wh, { items: [{ k: CODE2 + '|B261107|' + (now + 2000), code: CODE2, t: now + 2000, wt: 2, gl: 'NB04-A-01-005', st: '', ct: '筐', batch: 'B261107', pn: PN, q: 8, mk: '2026-11-07T10:00:00', op: 'ROFF仓管', nm: 'ROFF幽灵件', lot: 'B261107' }] });
    chkT('R2f 关期流水照常落库（证据不篡改，靠留痕可见）', sl2.json.ok === true);
    await sleep(400);
    const ops = (await get('/api/admin/ops?limit=50', ad)).json.list || [];
    const ghost = ops.find((o) => String(o.act || '').includes('来料区停用期误扫'));
    chkT('R2g 停用期误扫留痕进活动流（点名码+格位）', !!ghost && String(JSON.stringify(ghost)).includes(CODE2) && String(JSON.stringify(ghost)).includes('NB04-A-01-005'));

    // ===== R3 重开：登记恢复；幽灵码处置链证明（必须先作废流水）=====
    chkT('R3a 管理员重新开启', await setOn(1));
    const sp3 = await post('/api/ledger/sync', wh, { items: [{ c: 'ROFFNEW003', l: await freeSlot(wh), p: PN, n: 'ROFF重开件', q: 6, b: 'B261109', t: now + 3000, mv: '登记', src: '来料区' }] });
    chkT('R3b 重开后新码登记恢复', sp3.json.ok === true && sp3.json.added >= 1);
    const ckG = (await get('/api/label/check?c=' + CODE2 + '&recv=1', wh)).json;
    chk('R3c 幽灵码重开后再扫被拦（已有采集记录——处置=先作废那条流水）', [ckG.blockIn, String(ckG.reason).includes('采集记录')], [true, true]);
    const slList = (await get('/api/scanlog?limit=20000', wh)).json.items || [];
    const gKey = slList.find((s) => String(s.code || '').toUpperCase() === CODE2);
    if (gKey) await post('/api/scanlog/cancel', wh, { k: gKey.k || (CODE2 + '|B261107|' + (now + 2000)), cx: true });
    const ckG2 = (await get('/api/label/check?c=' + CODE2 + '&recv=1', wh)).json;
    chk('R3d 作废幽灵流水后同码可正常登记（处置闭环）', ckG2.blockIn, false);
    const sp4 = await post('/api/ledger/sync', wh, { items: [{ c: CODE2, l: await freeSlot(wh), p: PN, n: 'ROFF幽灵件', q: 8, b: 'B261107', t: Date.now(), mv: '登记', src: '来料区' }] });
    chkT('R3e 幽灵码补登记上账成功（时刻实时化避墓碑）', sp4.json.ok === true && sp4.json.added >= 1);

    // ===== R4 只读通道不受开关影响（残留 NB04 筐二楼仍可见可搬，v120 M7c 语义零回归）=====
    const L4 = (await get('/api/ledger/locs?recv=1', wh)).json;
    chkT('R4a 开状态下占用口径正常', Object.keys(L4.byLoc || {}).some((k) => k.startsWith('NB04-')));
    const ck4 = (await get('/api/label/check?c=' + CODE, wh)).json;
    chk('R4b 在库 NB04 筐转入判据正常回显', [ck4.blockIn, ck4.recvLoc], [false, slot1]);
  } catch (e) { fail++; console.log('FAIL! 异常：', e && e.message); }
  finally { srv.kill(); }

  // ===== R5 PDA 侧修复锚点（源码逐字校验，防漂移；PDA 逻辑本机不可运行，以契约+锚点双证）=====
  const mMain = fs.readFileSync(path.join(__dirname, '..', 'lib', 'main.dart'), 'utf8');
  const mLed = fs.readFileSync(path.join(__dirname, '..', 'lib', 'collection_ledger.dart'), 'utf8');
  const mSrv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const anchors = {
    'locs下发开关': mSrv.includes('receivingOn: receivingOn() ? 1 : 0'),
    '流水层停用期留痕': mSrv.includes('来料区停用期误扫'),
    'PDA探测方法': mMain.includes('Future<void> _probeReceivingOn()'),
    '探测先于恢复(时序)': mMain.includes('_probeReceivingOn().then((_) => _restoreWorkMode());'),
    '模式卡受开关': mMain.includes('Auth.can("receiving_reg") && _recvOn != 0'),
    '恢复受开关降级': mMain.includes('_recvOn != 0 && mounted) setState(() => _workType = 2)'),
    '查重403硬拦': mMain.includes('recv && r["_status"] == 403'),
    '放格读开关': mLed.includes('if (_recvOn == 0) { _recvOffFlag = true; return null; }'),
    '保存链区分未启用中止': mMain.includes('来料区已被管理员关闭'),
  };
  Object.entries(anchors).forEach(([k, v]) => chkT('R5 锚点·' + k, v));
  console.log(`\n===== v120b 来料区关闭闸实例证明：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
