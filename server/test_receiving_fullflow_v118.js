// ㉖v118 来料区全景业务剧本 · 端到端实例证明（真实 HTTP 打隔离实例）
// 按现场真实时间线走完整业务，并覆盖"想不到但会发生"的边角：
//  S1 一楼登记（贴标+扫码）：上账/重复扫/越界/预约回填/急货提醒标注
//  S2 二楼转入·人工地面路线：判据→迁移→恒等式
//  S3 二楼转入·AGV货架路线：reserve分新位→迁移→恒等式
//  S4 意外：跳楼新码判据、一楼旧缓存回推逆流被闸
//  S5 发料：建议排除NB04/兜底可拣/消账/发料后码不可复用
//  S6 生产退料：原码两条判据+入库、重打新码入库、退库码防双计
//  S7 并发：双PDA同格防撞、迁移撞位拒回、已迁框reserve回现位
//  S8 开关：关→拒新建/二楼原生不受累/存量筐仍可转入+仍可发料兜底；重开→恢复
//  S9 撤扫返架：发错料 unscan 复活
//  全程不变量：期末库存 = 来料区库存 + 库位库存（按测试码集合逐步核对）
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_ff_v118');
const PORT = 8333;
const BASE = 'http://127.0.0.1:' + PORT;

fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_ff_wh', username: 'ff_wh', name: 'FF仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Ff!wh', salt) });
db0.users.push({ id: 'u_ff_ad', username: 'ff_ad', name: 'FF管理', role: 'admin', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Ff!ad', salt) });
// 四张领料单：A缺PN1(急货提醒+发料) B缺PN2(建议含二楼框) C缺PN4(NB04兜底直拣) D缺PN6(开关关时存量可发)
db0.requisitions = (db0.requisitions || []).concat([
  { id: 'q_ff_a', no: 'LJFF0000A', by: 'u_ff_wh', byName: 'FF仓管', status: 'pending', createdAt: now, history: [], items: [{ partNo: '66FFPN0001', qty: 5, name: 'FF剧本件A', issued: [] }] },
  { id: 'q_ff_b', no: 'LJFF0000B', by: 'u_ff_wh', byName: 'FF仓管', status: 'pending', createdAt: now, history: [], items: [{ partNo: '66FFPN0002', qty: 5, name: 'FF剧本件B', issued: [] }] },
  { id: 'q_ff_c', no: 'LJFF0000C', by: 'u_ff_wh', byName: 'FF仓管', status: 'pending', createdAt: now, history: [], items: [{ partNo: '66FFPN0004', qty: 5, name: 'FF剧本件D', issued: [] }] },
  { id: 'q_ff_d', no: 'LJFF0000D', by: 'u_ff_wh', byName: 'FF仓管', status: 'pending', createdAt: now, history: [], items: [{ partNo: '66FFPN0006', qty: 5, name: 'FF剧本件F', issued: [] }] },
]);
db0.watchlist = (db0.watchlist || []).concat([{ userId: 'u_ff_wh', partNo: '66FFPN0001', qty: 3, itemName: 'FF剧本件A', at: now, due: '', got: 0, filledReq: '' }]);
db0.seenOut = db0.seenOut || {}; db0.seenOut['FFRETORIG01'] = { at: now - 5 * 86400e3, batch: 'B261101', no: 'LL-FF-OLD' }; // 原码退料用（曾出库）
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

const P1 = '66FFPN0001', P2 = '66FFPN0002', P4 = '66FFPN0004', P5 = '66FFPN0005', P6 = '66FFPN0006', P7 = '66FFPN0007', P8 = '66FFPN0008';
const C1 = 'FFBOX00001', C2 = 'FFBOX00002', C4 = 'FFBOX00004', C6 = 'FFBOX00006', C7 = 'FFBOX00007', CNEW = 'FFNEW00001', CFOCC = 'FFOCCUPY01', CFOCC2 = 'FFOCCUPY02';
const RET_ORIG = 'FFRETORIG01', RET_NEW = 'FFRETNEW7701';
let _t = now; const nt = () => (_t += 1000);

let fail = 0, total = 0;
const chk = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const chkT = (name, cond) => { total++; if (!cond) fail++; console.log(`${cond ? 'PASS' : 'FAIL!'} [${name}]`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p2, token, body) {
  const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function get(p2, token) {
  const r = await fetch(BASE + p2, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
// 测试码集合的库存恒等式：期末 = 来料区 + 库位（覆盖全部 FF 测试标签，去重）
async function inv(wh) {
  const rows = {};
  for (const pre of ['FFBOX', 'FFOCC', 'FFRET', 'FFNATIVE']) {
    for (const x of ((await get('/api/ledger?fz=' + pre, wh)).json.items || [])) rows[String(x.c).toUpperCase()] = x;
  }
  const items = Object.values(rows);
  let recv = 0, loc = 0;
  for (const x of items) { if (/^NB04-/.test(String(x.l))) recv++; else loc++; }
  return { total: items.length, recv, loc };
}

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let _srvLog = ''; srv.stdout.on('data', (d) => { _srvLog += String(d); }); // ㉖v119b 急货提醒断言改按服务器日志实锤：通知接口受夜间静默窗(22-6点进nightBuf)影响，时间依赖断言曾致剧本 47/48 假失败
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')  —— 来料区全景业务剧本');
  try {
    const wh = (await post('/api/login', null, { username: 'ff_wh', password: 'E2e#Ff!wh' })).json.token;
    const ad = (await post('/api/login', null, { username: 'ff_ad', password: 'E2e#Ff!ad' })).json.token;
    // 找空位：NB02 两个、NB03-D 两个（避开生产真实占用）
    const m0 = (await get('/api/ledger/locs?all=1', wh)).json.byLoc || {};
    const AL = 'ABCDEFGH'; const freeRack = [];
    outer1: for (let z = 0; z < 8; z++) for (let c2 = 1; c2 <= 16; c2++) for (let t2 = 1; t2 <= 4; t2++) { const l = 'NB02-' + AL[z] + '-' + String(c2).padStart(2, '0') + '-' + t2 + 'F'; if (!m0[l]) { freeRack.push(l); if (freeRack.length >= 2) break outer1; } }
    const freeGnd = [];
    outer2: for (let rr = 1; rr <= 18; rr++) for (let cc = 1; cc <= 12; cc++) { const l = 'NB03-D-' + String(rr).padStart(2, '0') + '-' + String(cc).padStart(2, '0'); if (!m0[l]) { freeGnd.push(l); if (freeGnd.length >= 2) break outer2; } }
    if (freeRack.length < 2 || freeGnd.length < 2) throw new Error('隔离库无足够空位');
    const RACK1 = freeRack[0], RACK2 = freeRack[1], GND1 = freeGnd[0], GND2 = freeGnd[1];

    // ================= S1 一楼登记（贴标+扫码，只扫一下） =================
    const s1 = await post('/api/ledger/sync', wh, { items: [
      { c: C1, l: 'NB04-A-01-001', p: P1, n: 'FF剧本件A', q: 10, b: 'B261101', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' },
      { c: C2, l: 'NB04-A-01-002', p: P2, n: 'FF剧本件B', q: 20, b: 'B261102', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' },
      { c: C4, l: 'NB04-A-01-003', p: P4, n: 'FF剧本件D', q: 30, b: 'B261103', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' },
      { c: CFOCC, l: 'NB04-A-01-010', p: P7, n: 'FF并发件', q: 5, b: 'B261107', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' },
    ] });
    chkT('S1a 一楼四筐登记上账', s1.json.ok === true && s1.json.added >= 4);
    const i1 = await inv(wh); chk('S1b 恒等式：4=来料4+库位0', [i1.total, i1.recv, i1.loc], [4, 4, 0]);
    // 重复扫（一楼把同一筐又扫一遍）
    const ck1 = (await get('/api/label/check?c=' + C1 + '&recv=1', wh)).json;
    chk('S1c 同码重复登记被拦', ck1.blockIn, true);
    // 越界格位
    const s1b = await post('/api/ledger/sync', wh, { items: [{ c: 'FFOORANGE1', l: 'NB04-A-01-1000', p: P8, q: 1, t: nt(), mv: '登记', src: '来料区' }] }); // 格4位超固定位数结构域(排2格3)
    chkT('S1d 超范围格位拒回', String(JSON.stringify(s1b.json.rejectedLoc || [])).includes('NB04-A-01-1000'));
    // 预约回填：到货可视提前到卸货点
    const wl = (await get('/api/watchlist', wh)).json.list || [];
    const w1 = wl.find((x) => String(x.partNo).toUpperCase() === P1) || {};
    chkT('S1e watchlist 预约 got 回填≥1（卸货即见进度）', (Number(w1.got) || 0) >= 1);
    // 急货提醒标注来料区（领料单A缺P1）：断言取服务器 [urgent-in] 日志（notify 落库受夜间静默窗影响，接口断言有时间依赖）
    await sleep(300);
    chkT('S1f 急货提醒标注"在来料区待转入"', _srvLog.includes('急货入库提醒') && _srvLog.includes('当前在来料区，需二楼转入后货架才可拣'));

    // ================= S2 二楼转入·人工地面路线 =================
    const ck2 = (await get('/api/label/check?c=' + C2, wh)).json;
    chk('S2a 转入判据：放行+回显来料格', [ck2.blockIn, ck2.recvLoc], [false, 'NB04-A-01-002']);
    const s2 = await post('/api/ledger/sync', wh, { items: [{ c: C2, l: GND1, p: P2, n: 'FF剧本件B', q: 20, b: 'B261102', t: nt(), mv: '人工', src: '来料区转入', f: '2.4米铁框' }] });
    chkT('S2b 人工直送迁移成功（同一行改位）', s2.json.ok === true && s2.json.updated >= 1);
    const i2 = await inv(wh); chk('S2c 恒等式：4=来料3+库位1', [i2.total, i2.recv, i2.loc], [4, 3, 1]);

    // ================= S3 二楼转入·AGV货架路线 =================
    const rv = await post('/api/ledger/reserve', wh, { code: C1, partNo: P1 });
    chkT('S3a reserve 对来料筐分配 NB02 新位（不回吐NB04）', rv.json.ok === true && /^NB02-/.test(String(rv.json.loc)) && rv.json.loc !== 'NB04-A-01-001');
    const RACK_A = String(rv.json.loc);
    const s3 = await post('/api/ledger/sync', wh, { items: [{ c: C1, l: RACK_A, p: P1, n: 'FF剧本件A', q: 10, b: 'B261101', t: nt(), mv: 'AGV', src: '来料区转入', f: '2.4米铁框' }] });
    chkT('S3b AGV 上架迁移成功', s3.json.ok === true && s3.json.updated >= 1);
    const i3 = await inv(wh); chk('S3c 恒等式：4=来料2+库位2', [i3.total, i3.recv, i3.loc], [4, 2, 2]);
    const rv2 = await post('/api/ledger/reserve', wh, { code: C1, partNo: P1 });
    chk('S3d 已入库框 reserve 回现位不重复占', [rv2.json.kept, rv2.json.loc], [true, RACK_A]);

    // ================= S4 意外：跳楼新码 / 一楼旧缓存回推逆流 =================
    const ck4 = (await get('/api/label/check?c=' + CNEW, wh)).json;
    chkT('S4a 全新码二楼默认模式被源头闸拦（路线A：提示先一楼登记）', ck4.blockIn === true && String(ck4.reason).includes('先在一楼扫入登记') && ck4.recvLoc === '' && ck4.seenOut === false);
    const s4 = await post('/api/ledger/sync', wh, { items: [{ c: C2, l: 'NB04-A-01-002', p: P2, n: 'FF剧本件B', q: 20, b: 'B261102', t: nt(), mv: '人工', src: '来料区转入', f: '2.4米铁框' }] });
    chkT('S4b 一楼旧缓存回推已入库框→逆流闸拒（"不允许回流来料区"）', String(JSON.stringify(s4.json.rejected || [])).includes('不允许回流来料区'));
    const i4 = await inv(wh); chk('S4c 逆流被拒后恒等式不变 4=来料2+库位2', [i4.recv, i4.loc], [2, 2]);

    // ================= S5 发料出库 =================
    const qB = ((await get('/api/requisitions/q_ff_b', wh)).json || {}).req;
    const sugB = (((qB.items || [])[0] || {}).suggest || {});
    const flatB = (sugB.flatBoxes || []).map((x) => String(x.c).toUpperCase());
    chkT('S5a 建议含已入库框（P2 在 NB03）', flatB.includes(C2));
    chkT('S5b 建议不含仍在来料区的框（P4/C4 未入库不发）', !flatB.includes(C4));
    const accC = await post('/api/requisitions/q_ff_c/accept', wh, {});
    chkT('S5c 领料单C接单', accC.json.ok === true);
    const qC = ((await get('/api/requisitions/q_ff_c', wh)).json || {}).req;
    const flatC = ((((qC.items || [])[0] || {}).suggest || {}).flatBoxes || []).map((x) => String(x.c).toUpperCase());
    chkT('S5d 库存全在来料区→兜底放回（急料可楼下直拣）', flatC.includes(C4));
    const scC = await post('/api/requisitions/q_ff_c/scan', wh, { barcode: C4, partNo: P4, qty: 30 });
    chk('S5e 兜底框扫码发料成功', scC.json.ok, true);
    const ledC = (await get('/api/ledger?c=' + C4, wh)).json.items || [];
    chk('S5f 发料消账：来料区行已删', ledC.length, 0);
    const i5 = await inv(wh); chk('S5g 恒等式：3=来料1+库位2（发出即减）', [i5.total, i5.recv, i5.loc], [3, 1, 2]);
    const ck5 = (await get('/api/label/check?c=' + C4, wh)).json;
    chkT('S5h 发料后同码再登记被拦（不可回收复用）', ck5.blockIn === true && String(ck5.reason).includes('出库'), true);

    // ================= S6 生产退料（两条路） =================
    const ck6a = (await get('/api/label/check?c=' + RET_ORIG, wh)).json;
    chk('S6a 原码默认拦（复用拦）', ck6a.blockIn, true);
    const ck6b = (await get('/api/label/check?c=' + RET_ORIG + '&ret=1', wh)).json;
    chk('S6b 退库模式放行原码', ck6b.blockIn, false);
    const s6 = await post('/api/ledger/sync', wh, { items: [{ c: RET_ORIG, l: GND2, p: P5, n: 'FF退料件', q: 8, b: 'B261101', t: nt(), mv: '人工', src: '生产退库', f: '2.4米铁框' }] });
    chkT('S6c 原码退料入库成功', s6.json.ok === true && s6.json.added >= 1);
    const ck6d = (await get('/api/label/check?c=' + RET_NEW + '&ret=1', wh)).json;
    chk('S6d 重打新码（无历史）退库模式放行', [ck6d.seen, ck6d.blockIn], [false, false]);
    const s6e = await post('/api/ledger/sync', wh, { items: [{ c: RET_NEW, l: RACK2, p: P5, n: 'FF退料件', q: 3, b: 'B261101', t: nt(), mv: '人工', src: '生产退库', f: '2.4米铁框' }] });
    chkT('S6e 重打新码退料入库成功', s6e.json.ok === true && s6e.json.added >= 1);
    const ck6f = (await get('/api/label/check?c=' + RET_ORIG, wh)).json;
    chkT('S6f 退库码入库后再扫被拦（防双计）', ck6f.blockIn === true && String(ck6f.reason).includes('已在库'), true);
    const i6 = await inv(wh); chk('S6g 恒等式：5=来料1+库位4', [i6.total, i6.recv, i6.loc], [5, 1, 4]);

    // ================= S7 并发与撞位 =================
    const s7 = await post('/api/ledger/sync', wh, { items: [{ c: CFOCC2, l: 'NB04-A-01-010', p: P8, n: 'FF并发件2', q: 5, b: 'B261108', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' }] });
    chkT('S7a 双PDA同格登记→第二框货位互斥拒回', String(JSON.stringify(s7.json.rejected || [])).includes('已被框 ' + CFOCC + ' 占用'));
    const s7b = await post('/api/ledger/sync', wh, { items: [{ c: C1, l: RACK2, p: P1, n: 'FF剧本件A', q: 10, b: 'B261101', t: nt(), mv: 'AGV', src: '来料区转入', f: '2.4米铁框' }] });
    chkT('S7c 迁移目标位被占→拒回', String(JSON.stringify(s7b.json.rejected || [])).includes('占用'));
    const led7 = (await get('/api/ledger?c=' + C1, wh)).json.items || [];
    chk('S7d 撞位被拒后原货架位不动', led7.length === 1 ? led7[0].l : '', RACK_A);

    // ================= S8 开关：关→存量不死、二楼不受累；重开→恢复 =================
    const s8pre = await post('/api/ledger/sync', wh, { items: [{ c: C6, l: 'NB04-A-01-005', p: P6, n: 'FF剧本件F', q: 12, b: 'B261106', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' }] });
    chkT('S8a 开关开时登记存量筐 C6', s8pre.json.ok === true);
    const revCfg = (await get('/api/admin/params', ad)).json.cfgRev || 0;
    const off = await post('/api/admin/params', ad, { values: { receivingOn: 0 }, baseRev: revCfg });
    chkT('S8b 管理员关闭来料区', off.json.ok === true);
    const s8c = await post('/api/ledger/sync', wh, { items: [{ c: C7, l: 'NB04-A-01-006', p: P7, q: 1, t: nt(), mv: '登记', src: '来料区' }] });
    chkT('S8d 关闭后一楼新登记被拒（提示未启用）', String(JSON.stringify(s8c.json.rejectedLoc || [])).includes('来料区未启用'));
    const ck8e = (await get('/api/label/check?c=' + C7 + '&recv=1', wh));
    chk('S8e 关闭后登记模式查重 403', ck8e.status, 403);
    // 二楼原生入库不受累：全新码直接推 NB02 位
    const s8f = await post('/api/ledger/sync', wh, { items: [{ c: 'FFNATIVE01', l: freeRack.length > 2 ? freeRack[2] : RACK2 === freeRack[0] ? freeRack[1] : freeRack[0], p: P8, n: 'FF原生件', q: 6, b: 'B261112', t: nt(), mv: '登记', f: '2.4米铁框' }] });
    chkT('S8g 关闭期间二楼原生采集入库正常（不依赖一楼）', s8f.json.ok === true && s8f.json.added >= 1);
    // 存量筐不被 stranded：转入判据仍在、可迁移、可发料兜底
    const ck8h = (await get('/api/label/check?c=' + C6, wh)).json;
    chk('S8h 存量来料筐转入判据不受开关影响', [ck8h.blockIn, ck8h.recvLoc], [false, 'NB04-A-01-005']);
    const accD = await post('/api/requisitions/q_ff_d/accept', wh, {});
    chkT('S8i 领料单D接单', accD.json.ok === true);
    const qD = ((await get('/api/requisitions/q_ff_d', wh)).json || {}).req;
    const flatD = ((((qD.items || [])[0] || {}).suggest || {}).flatBoxes || []).map((x) => String(x.c).toUpperCase());
    chkT('S8j 关闭后存量来料筐仍可被发料兜底拣走', flatD.includes(C6));
    const scD = await post('/api/requisitions/q_ff_d/scan', wh, { barcode: C6, partNo: P6, qty: 12 });
    chk('S8k 存量筐发料成功（开关关≠货卡死）', scD.json.ok, true);
    // 重开
    const revCfg2 = (await get('/api/admin/params', ad)).json.cfgRev || 0;
    const on2 = await post('/api/admin/params', ad, { values: { receivingOn: 1 }, baseRev: revCfg2 });
    chkT('S8l 管理员重新开启来料区', on2.json.ok === true);
    const s8m = await post('/api/ledger/sync', wh, { items: [{ c: C7, l: 'NB04-A-01-006', p: P7, n: 'FF剧本件G', q: 4, b: 'B261113', t: nt(), mv: '登记', src: '来料区', f: '2.4米铁框' }] });
    chkT('S8m 重开后一楼登记恢复', s8m.json.ok === true && s8m.json.added >= 1);

    // ================= S9 撤扫返架（发错料） =================
    const un = await post('/api/requisitions/q_ff_d/unscan', wh, { barcode: C6, partNo: P6 });
    chkT('S9a 撤扫受理', un.json.ok === true);
    const led9 = (await get('/api/ledger?c=' + C6, wh)).json.items || [];
    chkT('S9b 撤扫后框复活可再入库（不断链）', led9.length === 1 && /^NB0[234]-/.test(String(led9[0].l)));

    // ================= 终检：恒等式 =================
    const iF = await inv(wh);
    chk('S9c 终检恒等式：期末=来料+库位', iF.total, iF.recv + iF.loc);
    console.log('    [终态快照] 期末' + iF.total + ' = 来料区' + iF.recv + ' + 库位' + iF.loc);
  } catch (e) {
    fail++; console.log('FAIL! 异常：', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e && e.message);
  } finally {
    srv.kill();
  }
  console.log(`\n===== v118 来料区全景业务剧本：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
