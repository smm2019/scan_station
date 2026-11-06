// ㉖v118 来料区（NB01）登记/转入/退库/排除拣选 · 端到端取证（真实 HTTP 打隔离实例）
// 覆盖设计逻辑全链路：
//   1) 一楼登记：NB01 行合法上账；越界格位（R5-01）被 locStrict 拒回
//   2) 转入查重：普通模式对 NB01 在库码放行（recvLoc 回显）；recv=1 登记模式重复扫仍拦
//   3) 退库豁免：有 seenOut 历史码 blockIn=true；&ret=1 生产退库模式豁免
//   4) 预占修正：NB01 在库码 reserve 分配 NB02 新位（不回吐旧位）
//   5) 发料建议：默认排除 NB01（同零件有 NB02 货时）；库存全在来料区时兜底放回
//   6) 严格FIFO扫码：NB01 框不在建议清单→拦；兜底放行框→可扫
//   7) 迁移方向：正向 NB01→NB02 成功；逆流 NB02→NB01 合并拒回
//   8) 项目地面区映射：读写/校验/清除
//   9) locs?recv=1 来料区占用口径
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_recv_v118');
const PORT = 8331;
const BASE = 'http://127.0.0.1:' + PORT;

fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
const PN1 = '66E118PN0001', PN2 = '66E118PN0002';
db0.users.push({ id: 'u_e118_wh', username: 'e118_wh', name: 'E118来料仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Rcv!118', salt) });
db0.users.push({ id: 'u_e118_ad', username: 'e118_ad', name: 'E118管理', role: 'admin', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Adm!118', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 }); // 默认开启来料区，既有断言在启用态运行
db0.requisitions = (db0.requisitions || []).concat([
  { id: 'q_e118a', no: 'LJE11800001', by: 'u_e118_wh', byName: 'E118来料仓管', status: 'pending', createdAt: now, history: [], items: [{ partNo: PN1, qty: 5, name: 'E118来料取证件A', issued: [] }] },
  { id: 'q_e118b', no: 'LJE11800002', by: 'u_e118_wh', byName: 'E118来料仓管', status: 'pending', createdAt: now, history: [], items: [{ partNo: PN2, qty: 5, name: 'E118来料取证件B', issued: [] }] },
]);
db0.seenOut = db0.seenOut || {}; db0.seenOut['E118RETURNC3'] = { at: now - 7 * 86400e3, batch: 'B261028', no: 'LL-E118-OLD' };
db0.projDict = db0.projDict || {}; db0.projDict['吉利E2E118'] = { nm: 'E118取证项目', at: now };
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

const TAG_R1 = 'E118RECVR1', TAG_R2 = 'E118RECV2', TAG_BAD = 'E118RECVBAD', TAG_BAD2 = 'E118RECVBAD2', TAG_R4 = 'E118RECVR4', TAG_R3 = 'E118RETURNC3', TAG_N2B = 'E118NB02BOX';

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

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    const wh = (await post('/api/login', null, { username: 'e118_wh', password: 'E2e#Rcv!118' })).json.token;
    const ad = (await post('/api/login', null, { username: 'e118_ad', password: 'E2e#Adm!118' })).json.token;
    // —— 找两个 NB02 空位（账本+预占均无）——
    const m0 = (await get('/api/ledger/locs?all=1', wh)).json.byLoc || {};
    const AL = 'ABCDEFGH'; const free = [];
    for (let z = 0; z < 8 && free.length < 2; z++) for (let c2 = 1; c2 <= 16 && free.length < 2; c2++) for (let t2 = 1; t2 <= 4 && free.length < 2; t2++) {
      const loc = 'NB02-' + AL[z] + '-' + String(c2).padStart(2, '0') + '-' + t2 + 'F';
      if (!m0[loc]) free.push(loc);
    }
    if (free.length < 2) throw new Error('测试环境无两个连续空货架位');
    const LOC_X = free[0], LOC_Y = free[1];

    // ===== 1. 一楼登记：NB01 合法上账 + 超参数范围拒回（默认15行×12列=180格）=====
    const p1 = await post('/api/ledger/sync', wh, { items: [
      { c: TAG_R1, l: 'NB01-R1-03', p: PN1, n: 'E118来料取证件A', q: 10, b: 'B261101', t: now, mv: '登记', src: '来料区', f: '2.4米铁框' },
      { c: TAG_R2, l: 'NB01-R2-07', p: PN2, n: 'E118来料取证件B', q: 20, b: 'B261102', t: now, mv: '登记', src: '来料区', f: '2.4米铁框' },
      { c: TAG_R4, l: 'NB01-R15-12', p: PN1, n: 'E118来料取证件A', q: 4, b: 'B261104', t: now, mv: '登记', src: '来料区', f: '2.4米铁框' }, // 180格边界内
      { c: TAG_BAD, l: 'NB01-R16-01', p: PN2, q: 5, t: now, mv: '登记', src: '来料区' }, // 行超 recvRows
      { c: TAG_BAD2, l: 'NB01-R1-13', p: PN2, q: 5, t: now, mv: '登记', src: '来料区' }, // 列超 recvCols
    ] });
    chkT('R1a 登记推送受理', p1.json.ok === true);
    chkT('R1b 行超限(R16)被参数范围闸拒回', String(JSON.stringify(p1.json.rejectedLoc || [])).includes('NB01-R16-01'));
    chkT('R1b2 列超限(R1-13)被拒回且提示当前参数', String(JSON.stringify(p1.json.rejectedLoc || [])).includes('NB01-R1-13') && String(JSON.stringify(p1.json.rejectedLoc || [])).includes('15 行 × 12 列'));
    const led1 = (await get('/api/ledger?l=NB01', wh)).json;
    chk('R1c 来料区在账 3 行(含180格边界)', led1.count, 3);

    // ===== 2. 转入查重：普通放行 / 登记模式仍拦 =====
    const ck1 = (await get('/api/label/check?c=' + TAG_R1, wh)).json;
    chk('R2a 普通模式转入放行', ck1.blockIn, false);
    chk('R2b 回显来料区转入位 recvLoc', ck1.recvLoc, 'NB01-R1-03');
    const ck2 = (await get('/api/label/check?c=' + TAG_R1 + '&recv=1', wh)).json;
    chk('R2c 一楼登记模式重复扫仍拦', ck2.blockIn, true);

    // ===== 3. 退库豁免：seenOut 码默认拦 / ret=1 放行 =====
    const ck3 = (await get('/api/label/check?c=' + TAG_R3, wh)).json;
    chk('R3a 出库历史码默认拦复用', ck3.blockIn, true);
    const ck4 = (await get('/api/label/check?c=' + TAG_R3 + '&ret=1', wh)).json;
    chk('R3b 退库模式豁免放行', ck4.blockIn, false);

    // ===== 5. 发料建议：兜底放回 / 默认排除 =====
    const qa = ((await get('/api/requisitions/q_e118a', wh)).json || {}).req; // PN1 只在 NB01 → 兜底放回
    const sugA = ((qa && qa.items ? qa.items[0] : {}) || {}).suggest || {};
    const flatA = (sugA.flatBoxes || []).map((x) => String(x.c).toUpperCase());
    chkT('R5a 库存全在来料区→兜底建议放回 NB01 框', flatA.includes(TAG_R1));
    // PN2 二楼补基准框（批次 B261103 晚于来料框 B261102——未过滤时 FIFO 必选 NB01 框）
    const p4 = await post('/api/ledger/sync', wh, { items: [
      { c: TAG_N2B, l: LOC_X, p: PN2, n: 'E118来料取证件B', q: 30, b: 'B261103', t: now, mv: 'AGV', f: '2.4米铁框' },
    ] });
    chkT('R4a PN2 基准框上账', p4.json.ok === true);
    const qb = ((await get('/api/requisitions/q_e118b', wh)).json || {}).req;
    const sugB = ((qb && qb.items ? qb.items[0] : {}) || {}).suggest || {};
    const flatB = (sugB.flatBoxes || []).map((x) => String(x.c).toUpperCase());
    chk('R5b 有二楼货时建议排除来料区框（FIFO 首框应为 NB02 基准框）', flatB[0], TAG_N2B);
    chkT('R5c 来料区框完全不出现在建议清单', !flatB.includes(TAG_R2));
    const rv = await post('/api/ledger/reserve', wh, { code: TAG_R1, partNo: PN1 });
    chkT('R4b reserve 受理', rv.json.ok === true);
    chkT('R4c 分配位为 NB02 非回吐 NB01', /^NB02-[A-H]-/.test(String(rv.json.loc || '')) && String(rv.json.loc).indexOf('NB01') !== 0);
    const LOC_MV = String(rv.json.loc);

    // ===== 6. 严格FIFO扫码：NB01 框不在白名单→拦；兜底框→可扫 =====
    const acc1 = await post('/api/requisitions/q_e118b/accept', wh, {});
    chkT('R6a 领料单B接单', acc1.json.ok === true);
    const sc1 = await post('/api/requisitions/q_e118b/scan', wh, { barcode: TAG_R2, partNo: PN2, qty: 20 });
    chk('R6b 扫来料区框被拦（未入库不可直拣）', sc1.json.ok, false);
    chkT('R6b2 拒因确为FIFO建议闸（非件数缺失）', String(sc1.json.msg || '').includes('不在本单建议框'));
    const acc2 = await post('/api/requisitions/q_e118a/accept', wh, {});
    chkT('R6c 领料单A接单', acc2.json.ok === true);
    const sc2 = await post('/api/requisitions/q_e118a/scan', wh, { barcode: TAG_R1, partNo: PN1, qty: 10 });
    chk('R6d 兜底放行框可扫码发料', sc2.json.ok, true);

    // ===== 7. 迁移方向：正向 NB01→NB02 成功；逆流被闸 =====
    // TAG_R1 已被 R6d 发料消账 → 换新码走迁移：把 TAG_R2 二楼入库（模拟转入提交）
    const mv1 = await post('/api/ledger/sync', wh, { items: [
      { c: TAG_R2, l: LOC_MV, p: PN2, n: 'E118来料取证件B', q: 20, b: 'B261102', t: now + 5000, mv: '人工', src: '来料区转入', f: '2.4米铁框' },
    ] });
    chkT('R7a 正向迁移受理', mv1.json.ok === true);
    const led7 = (await get('/api/ledger?c=' + TAG_R2, wh)).json.items || [];
    chk('R7b 迁移后货位为新货架位', led7.length === 1 ? led7[0].l : '', LOC_MV);
    const mv2 = await post('/api/ledger/sync', wh, { items: [
      { c: TAG_R2, l: 'NB01-R3-01', p: PN2, n: 'E118来料取证件B', q: 20, b: 'B261102', t: now + 9000, mv: '人工', src: '来料区转入', f: '2.4米铁框' },
    ] });
    chkT('R7c 逆流(NB02→NB01)被方向闸拒回', String(JSON.stringify(mv2.json)).includes('不允许回流来料区'));
    const led7b = (await get('/api/ledger?c=' + TAG_R2, wh)).json.items || [];
    chk('R7d 逆流后仍在货架位', led7b.length === 1 ? led7b[0].l : '', LOC_MV);

    // ===== 8. 项目地面区映射 =====
    const gs1 = await post('/api/proj/ground/set', wh, { code: '吉利E2E118', zone: 'D' });
    chkT('R8a 配置项目地面区', gs1.json.ok === true);
    const gg = (await get('/api/proj/ground', wh)).json;
    chk('R8b 读回映射', gg.map['吉利E2E118'], 'D');
    const gs2 = await post('/api/proj/ground/set', wh, { code: '吉利E2E118', zone: 'Z' });
    chk('R8c 非法区字母拒', gs2.json.ok, false);
    const gs3 = await post('/api/proj/ground/set', wh, { code: '吉利E2E118', zone: '' });
    chkT('R8d 清除映射', gs3.json.ok === true);
    const gg2 = (await get('/api/proj/ground', wh)).json;
    chk('R8e 清除后不再返回该区', gg2.map['吉利E2E118'], undefined);

    // ===== 9. locs?recv=1 来料区占用口径 =====
    // TAG_R1 已在 R6d 发料消账（NB01 行随之删除）→ 补登记一筐专用占用框
    await post('/api/ledger/sync', wh, { items: [
      { c: 'E118RECVOCC', l: 'NB01-R1-03', p: PN2, q: 7, b: 'B261109', t: Date.now(), mv: '登记', src: '来料区' },
    ] });
    const lr = (await get('/api/ledger/locs?recv=1', wh)).json.byLoc || {};
    chkT('R9a 来料区占用含 R1-03(新登记框)', (lr['NB01-R1-03'] || []).includes('E118RECVOCC'));
    chkT('R9b 已迁移行不再占来料格', !(lr['NB01-R2-07'] || []).includes(TAG_R2));
    chkT('R9c 不含货架位键', !Object.keys(lr).some((k) => k.indexOf('NB02-') === 0));

    // ===== 10. 来料区总开关：关闭后拒新建、但残留筐仍可二楼搬走 =====
    const off = await post('/api/admin/params', ad, { values: { receivingOn: 0 }, baseRev: ((await get('/api/admin/params', ad)).json.cfgRev) });
    chkT('R10a 管理员关闭来料区开关', off.json.ok === true);
    const pOff = await post('/api/ledger/sync', wh, { items: [
      { c: 'E118OFFNEW', l: 'NB01-R1-05', p: PN1, q: 3, b: 'B261110', t: Date.now(), mv: '登记', src: '来料区' },
    ] });
    chkT('R10b 关闭后新建 NB01 被拒', String(JSON.stringify(pOff.json.rejectedLoc || [])).includes('E118OFFNEW'));
    chkT('R10c 拒因提示来料区未启用', String(JSON.stringify(pOff.json.rejectedLoc || [])).includes('来料区未启用'));
    const ckOff = await get('/api/label/check?c=E118OFFNEW&recv=1', wh);
    chk('R10d 关闭后一楼登记模式查重 403', ckOff.status, 403);
    // 残留筐 E118RECVOCC 仍在 NB01-R1-03：二楼普通查重仍走转入豁免（不受开关影响，防 stranded）
    const ckRes = (await get('/api/label/check?c=E118RECVOCC', wh)).json;
    chk('R10e 关闭后残留来料筐转入仍放行', ckRes.blockIn, false);
    chk('R10f 关闭后仍回显转入判据 recvLoc', ckRes.recvLoc, 'NB01-R1-03');
    const mvOff = await post('/api/ledger/sync', wh, { items: [
      { c: 'E118RECVOCC', l: LOC_Y, p: PN2, n: 'E118来料取证件B', q: 7, b: 'B261109', t: Date.now() + 20000, mv: '人工', src: '来料区转入', f: '2.4米铁框' },
    ] });
    chkT('R10g 关闭后残留筐仍可迁移到 NB02', mvOff.json.ok === true && mvOff.json.updated >= 1);
    const ledOff = (await get('/api/ledger?c=E118RECVOCC', wh)).json.items || [];
    chk('R10h 迁移后落 NB02 新位', ledOff.length === 1 ? ledOff[0].l : '', LOC_Y);
  } catch (e) {
    fail++; console.log('FAIL! 异常：', e && e.message);
  } finally {
    srv.kill();
  }
  console.log(`\n===== v118 来料区端到端：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true }); // 与同类 e2e 测试同惯例：跑完清理隔离数据目录
  process.exit(fail ? 1 : 0);
})();
