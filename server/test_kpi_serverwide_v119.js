// ㉖v119 在库四卡全厂口径 · 端到端取证（真实 HTTP 打隔离实例）
// 治的病：两台 PDA 库存页四卡各算本机快照（588 vs 592）与网页看板（594）三方互异，
//         v99 只统一了今日卡，四卡始终本机口径→"反复修改反复出现"。
// 断言：/api/counts 新四字段与 /api/dashboard 同源同值；与账本手工按框键重算一致；
//       同托多码=1框、空零件号计框不计种类、滞留168h边界、迁移不改框数。
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_kpi_v119');
const PORT = 8335;
const BASE = 'http://127.0.0.1:' + PORT;

fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_k119_wh', username: 'k119_wh', name: 'K119仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Kpi!119', salt) });
db0.params = Object.assign(db0.params || {}, { receivingOn: 1 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

const P1 = '66K119PN0001', P2 = '66K119PN0002', P3 = '66K119PN0003';
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
// 与服务器同源的框键（boxKeyOf 抄录）：托号优先→位+件→单码
const boxKeyOf = (x) => { const pid = String(x.pid || '').toUpperCase(); if (pid) return 'P|' + pid; const l = String(x.l || '').toUpperCase(), p = String(x.p || '').toUpperCase(); return (l && p) ? 'L|' + l + '|' + p : 'C|' + String(x.c).toUpperCase(); };

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v119 四卡全厂口径取证');
  try {
    const wh = (await post('/api/login', null, { username: 'k119_wh', password: 'E2e#Kpi!119' })).json.token;
    // 基线（真实账本存量）
    const c0 = (await get('/api/counts', wh)).json;
    chkT('K0a counts 下发四字段（非 undefined）', ['stockBoxes', 'stockQty', 'stockParts', 'stockStale7'].every((k) => typeof c0[k] === 'number'));
    const d0 = (await get('/api/dashboard', wh)).json;
    chk('K0b 与网页看板 stockBoxes 同源同值', c0.stockBoxes, (d0.kpi || {}).stockBoxes);
    // 手工重算基线（账本视图口径：空零件号行由流水回填后才计种类——直接按 ledger 原始行重算允许差在回填项，用 items 全量）
    const led0 = (await get('/api/ledger', wh)).json.items || [];
    const bx0 = new Set(led0.map(boxKeyOf));
    chk('K0c 与账本手工按框键重算一致', c0.stockBoxes, bx0.size);

    // 注入：同托两码(1框) + 单码框 + 空零件号框 + 8天前滞留框
    const tNew = now - 60000, tOld = now - 8 * 86400e3;
    const items = [
      { c: 'K119BOX00001', l: 'NB04-A-01-001', p: P1, n: 'K119件一', q: 100, b: 'B261101', t: tNew, mv: '登记', src: '来料区', pid: 'K119PAL1' },
      { c: 'K119BOX00002', l: 'NB04-A-01-002', p: P1, n: 'K119件一', q: 200, b: 'B261101', t: tNew, mv: '登记', src: '来料区', pid: 'K119PAL1' }, // 同托→并1框
      { c: 'K119BOX00003', l: 'NB04-A-01-003', p: P2, n: 'K119件二', q: 50, b: 'B261102', t: tNew, mv: '登记', src: '来料区' },
      { c: 'K119BOX00004', l: 'NB04-A-01-004', p: '', n: '', q: 30, b: '', t: tNew, mv: '登记', src: '来料区' }, // 空零件号：计框计件不增种类
      { c: 'K119BOX00005', l: 'NB04-A-01-005', p: P3, n: 'K119件三', q: 10, b: 'B261020', t: tOld, mv: '登记', src: '来料区' }, // 8天滞留
    ];
    const sp = await post('/api/ledger/sync', wh, { items });
    chkT('K1a 注入 5 行上账', sp.json.ok === true && sp.json.added >= 5);
    const c1 = (await get('/api/counts', wh)).json;
    const d1 = (await get('/api/dashboard', wh)).json;
    chk('K1b counts 与看板同源同值（注入后）', c1.stockBoxes, (d1.kpi || {}).stockBoxes);
    chk('K1c 同托两码=1框：净增 4 框', c1.stockBoxes - c0.stockBoxes, 4);
    chk('K1d 数量净增=Σq(100+200+50+30+10)', c1.stockQty - c0.stockQty, 390);
    chk('K1e 种类净增=3（P1/P2/P3；空件号框不增）', c1.stockParts - c0.stockParts, 3);
    chk('K1f 滞留7天+净增=1（8天框）', c1.stockStale7 - c0.stockStale7, 1);

    // 迁移不改框数：K119BOX00003 来料区→NB02（同一行改位）
    const mv = await post('/api/ledger/sync', wh, { items: [{ c: 'K119BOX00003', l: 'NB02-A-01-1F', p: P2, n: 'K119件二', q: 50, b: 'B261102', t: now, mv: '人工', src: '来料区转入' }] });
    chkT('K2a 迁移受理', mv.json.ok === true);
    const c2 = (await get('/api/counts', wh)).json;
    chk('K2b 迁移前后框数不变（同一行改位非增删）', c2.stockBoxes, c1.stockBoxes);
    chk('K2c 迁移前后数量不变', c2.stockQty, c1.stockQty);

    // 出库消账：删 K119BOX00001/2（整托两码）→ 框数 −1（同托并框）、数量 −300
    const del = await post('/api/ledger/sync', wh, { items: [], del: [{ c: 'K119BOX00001', t: now + 50000 }, { c: 'K119BOX00002', t: now + 50000 }] });
    chkT('K3a 消账受理', del.json.ok === true && del.json.delApplied >= 2);
    const c3 = (await get('/api/counts', wh)).json;
    chk('K3b 同托两码消账=净减1框', c3.stockBoxes, c2.stockBoxes - 1);
    chk('K3c 消账数量-300', c3.stockQty, c2.stockQty - 300);
    const d3 = (await get('/api/dashboard', wh)).json;
    chk('K3d 消账后两端口径仍一致', c3.stockBoxes, (d3.kpi || {}).stockBoxes);
  } catch (e) {
    fail++; console.log('FAIL! 异常：', e && e.message);
  } finally {
    srv.kill();
  }
  console.log(`\n===== v119 四卡全厂口径取证：${total - fail}/${total} PASS =====`);
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
