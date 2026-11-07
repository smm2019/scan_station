// ㉖v122 流水作废双向同步 + 地面格数覆盖空窗 · 实例证明
// 现场事故（11-07 18:43）：网页作废三框后，PDA 本机旧"正常"缓存回灌把服务器状态覆盖回"正常"，
//   app 列表显示正常、网页显示作废，两端各说各话；且"分配货位有问题导致未生效"=连扫多框撞同格。
// 另案（11-07 17:57）：B-13 配置 18 格、实占 13 格，App 选格位只画 12 格显示"空 -1/12"。
// 证明面：
//  A1 普通推送（cxAt=0）不带旧缓存复活能力：服务器已作废 → 压回 cx=true + cxKept 回传
//  A2 PDA 主动恢复（cxAt>服务器cxA）→ 接受恢复，不压回
//  A3 PDA 主动作废（cxAt>0）→ 接受作废并登记 cxB/cxA
//  A4 并发：服务器作废时刻晚于 PDA 操作时刻 → 压回服务器态（服务器权威）
//  A5 首次新行（无历史 cxA）→ 不受保护块影响，正常入库
//  A6 同键重复推送状态一致 → 不进 cxKept（防无谓回写）
//  B1 locs?recv=1 带 recvReserve=1（PDA 走原子占位的开关）
//  B2 连扫三框原子占位必得三个不同格（撞格根因）
//  B3 幂等：同标签重复申请回同格
//  B4 地面格数覆盖：groundSlots[B-13]=18 经 groundslots 端点原样下发（PDA 读到 18 的数据源）
//  C1 PDA 侧修复锚点逐字校验（本机无法运行 Flutter，以源码在位+契约双证）
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_cx_v122'); const PORT = 8355; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_cx_w', username: 'cx_wh', name: 'CX仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Cx!122', salt) });
db0.users.push({ id: 'u_cx_a', username: 'cx_ad', name: 'CX管理', role: 'admin', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Cxa!122', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
db0.groundSlots = Object.assign(db0.groundSlots || {}, { 'NB03-B-13': 18 }); // 现场真实配置副本
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const T1 = 'CXBOX00001', T2 = 'CXBOX00002', T3 = 'CXBOX00003', T4 = 'CXBOX00004', T5 = 'CXBOX00005';
const K1 = T1 + '|B261107|1000', K2 = T2 + '|B261107|2000', K3 = T3 + '|B261107|3000', K4 = T4 + '|B261107|4000', K5 = T5 + '|B261107|5000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
async function post(p2, tk, body) { const r = await fetch(BASE + p2, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p2, tk) { const r = await fetch(BASE + p2, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
// 模拟 PDA 流水推送（items 带 cx/cxAt，与 scanPushNow 同构）
const push = (tk, list) => post('/api/scanlog/sync', tk, { items: list.map((e) => Object.assign({ code: e.k.split('|')[0], wt: 1, gl: 'NB03-B-13-01', batch: 'B261107', t: Number(e.k.split('|')[2]), pn: '66CXPX0001', q: 10, nm: 'CX取证件', op: 'CX仓管' }, e)) });
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v122 作废双向同步+格数覆盖证明');
  try {
    const wh = (await post('/api/login', null, { username: 'cx_wh', password: 'E2e#Cx!122' })).json.token;
    const ad = (await post('/api/login', null, { username: 'cx_ad', password: 'E2e#Cxa!122' })).json.token;

    // ===== A5 首次推送（无历史）正常入库 =====
    const p0 = await push(wh, [{ k: K1, cx: false }, { k: K2, cx: false }, { k: K3, cx: false }, { k: K4, cx: false }, { k: K5, cx: false }]);
    chkT('A5 首次推送五框正常入库', p0.json.ok === true && p0.json.pushed === 5);
    chk('A6 状态一致不进 cxKept', p0.json.cxKept || [], []);

    // ===== A1 网页作废 T1 → PDA 旧缓存（cx=false, cxAt=0）回灌被压回 =====
    const c1 = await post('/api/scanlog/cancel', ad, { k: K1, cx: true });
    chkT('A1a 网页作废受理', c1.json.ok === true);
    const p1 = await push(wh, [{ k: K1, cx: false }]); // 模拟 PDA 本机仍是"正常"的旧行重推
    chk('A1b 旧缓存回灌被压回作废态', ((await get('/api/scanlog?limit=20000', wh)).json.items.find((x) => String(x.code).toUpperCase() === T1) || {}).cx, true);
    chk('A1c cxKept 回传 [k,true] 供 PDA 回写本机', p1.json.cxKept, [[K1, true]]);

    // ===== A3 PDA 主动作废 T2（cxAt=新时刻）→ 服务器接受 =====
    const tOp = Date.now();
    const p2 = await push(wh, [{ k: K2, cx: true, cxAt: tOp }]);
    chk('A3a PDA 主动作废被接受', ((await get('/api/scanlog?limit=20000', wh)).json.items.find((x) => String(x.code).toUpperCase() === T2) || {}).cx, true);
    chk('A3b 主动作废不触发回传（本机已是该态）', p2.json.cxKept || [], []);

    // ===== A2 PDA 主动恢复 T2（cxAt 晚于服务器 cxA）→ 接受恢复 =====
    const tOp2 = Date.now() + 5000;
    const p3 = await push(wh, [{ k: K2, cx: false, cxAt: tOp2 }]);
    chk('A2a PDA 主动恢复被接受（旧保护块会误压回，新者胜修好）', ((await get('/api/scanlog?limit=20000', wh)).json.items.find((x) => String(x.code).toUpperCase() === T2) || {}).cx, false);
    chk('A2b 恢复不触发回传', p3.json.cxKept || [], []);

    // ===== A4 并发：服务器作废时刻晚于 PDA 操作时刻 → 服务器权威压回 =====
    await post('/api/scanlog/cancel', ad, { k: K3, cx: true }); // 服务器此刻作废（cxA=now，晚于下面伪造的 cxAt）
    const p4 = await push(wh, [{ k: K3, cx: false, cxAt: Date.now() - 60000 }]); // PDA 带 1 分钟前的旧操作时刻推"正常"
    chk('A4a 服务器态更新→压回作废', ((await get('/api/scanlog?limit=20000', wh)).json.items.find((x) => String(x.code).toUpperCase() === T3) || {}).cx, true);
    chk('A4b 压回并回传供本机对齐', p4.json.cxKept, [[K3, true]]);

    // ===== A6 从未做过权威动作的键（cxA=0）普通推送不受影响 =====
    const p5 = await push(wh, [{ k: K5, cx: false }]);
    chk('A6b 无权威动作键正常覆盖（零误伤）', [p5.json.ok === true, (p5.json.cxKept || []).length], [true, 0]);

    // ===== B 来料区原子占位（"分配货位有问题"根因）=====
    const L = (await get('/api/ledger/locs?recv=1', wh)).json;
    chk('B1 locs?recv=1 声明 recvReserve=1', L.recvReserve, 1);
    const r1 = await post('/api/ledger/reserve', wh, { code: 'CXAT0000001', recv: 1 });
    const r2 = await post('/api/ledger/reserve', wh, { code: 'CXAT0000002', recv: 1 });
    const r3 = await post('/api/ledger/reserve', wh, { code: 'CXAT0000003', recv: 1 });
    const slots = [r1.json.loc, r2.json.loc, r3.json.loc];
    chkT('B2 连扫三框必得三个不同格（旧版全给同一格）', r1.json.ok && r2.json.ok && r3.json.ok && new Set(slots).size === 3);
    const r1b = await post('/api/ledger/reserve', wh, { code: 'CXAT0000001', recv: 1 });
    chk('B3 同标签重复申请幂等回同格', r1b.json.loc, r1.json.loc);

    // ===== B4 地面格数覆盖数据源 =====
    const gs = (await get('/api/ground-slots', wh)).json;
    chk('B4 groundslots 原样下发 B-13=18（PDA 读到 18 的数据源）', (gs.slots || {})['NB03-B-13'], 18);

    // ===== C PDA 侧修复锚点（本机无法运行 Flutter，源码在位校验）=====
    const mLed = fs.readFileSync(path.join(__dirname, '..', 'lib', 'collection_ledger.dart'), 'utf8');
    const mMain = fs.readFileSync(path.join(__dirname, '..', 'lib', 'main.dart'), 'utf8');
    const mSrv = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const anchors = {
      '格数持久化到SP': mLed.includes('gnd_slots_v122'),
      '格数启动恢复': mLed.includes('Future<void> gSlotsRestore()') && mMain.includes('gSlotsRestore();'),
      'picker打开前同步刷新': mLed.includes('await pullGroundSlots(); // ㉖v122 打开弹层前同步刷新格数覆盖'),
      '自动分配前同步刷新': mLed.includes('await pullGroundSlots(); // ㉖v122 分配前确保格数覆盖最新'),
      '推送附带cxAt': mLed.includes('"cxAt": _cxLocalOpAt[_sk] ?? 0'),
      '主动操作时刻登记': mLed.includes('_cxLocalOpAt[scanlogKeyOf(r)] = DateTime.now().millisecondsSinceEpoch'),
      'cxKept回写本机': mLed.includes('final kept = res["cxKept"]'),
      '回写后清登记': mLed.includes('_cxLocalOpAt.removeWhere'),
      '服务器snap带cxAt': mSrv.includes('cxAt: Number(it.cxAt) || 0'),
      '服务器新者胜仲裁': mSrv.includes('const srvOp = Number(old.cxA) || 0, cliOp = Number(v.cxAt) || 0'),
      '服务器回传cxKept': mSrv.includes('cxKept: _cxKept'),
    };
    Object.entries(anchors).forEach(([k, v]) => chkT('C 锚点·' + k, v));
  } catch (e) { fail++; console.log('FAIL! 异常：', e && e.message); }
  finally { srv.kill(); }
  console.log(`\n===== v122 作废双向同步+格数覆盖实例证明：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
