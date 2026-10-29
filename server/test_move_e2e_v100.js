// ㉖v100 出库/移仓口径 · 端到端取证（真实 HTTP 打隔离实例）
// 流程：复制数据→注入测试账号→起服务→推1张线边出库单+1张冷冲移仓单→验证 counts/profile/outbound
//      三口径剔除移仓；再改参数 outWhKeys 验证"移仓"判定即时翻转（可配置清单核心卖点）
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_mv_v100');
const PORT = 8322;
const BASE = 'http://127.0.0.1:' + PORT;

fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
// 注入：仓管（推出库单）+ 管理员（改参数）
db0.users.push({ id: 'u_e2e_mv_wh', username: 'e2e_mv_wh', name: 'E2E仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Mv!wh', salt) });
db0.users.push({ id: 'u_e2e_mv_ad', username: 'e2e_mv_ad', name: 'E2E管理', role: 'admin', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Mv!ad', salt) });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

let fail = 0, total = 0;
const chk = (name, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${name}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, token, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function get(p, token) {
  const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    const wh = (await post('/api/login', null, { username: 'e2e_mv_wh', password: 'E2e#Mv!wh' })).json.token;
    const ad = (await post('/api/login', null, { username: 'e2e_mv_ad', password: 'E2e#Mv!ad' })).json.token;
    const now = Date.now();
    const PN = '66E2EMV001', TAG1 = 'E2EMVOUT01', TAG2 = 'E2EMVMOVE01';
    // 基线：推单前今日出库数
    const cBase = (await get('/api/counts', wh)).json.todayOut;

    // —— 注入两张单：1 线边出库 + 1 冷冲移仓 ——
    const ob = (no, to, tag) => ({ orderNo: no, createdAt: now, toLoc: to, operator: 'E2E仓管', status: 0, linkReqNo: '', items: [{ code: PN, name: 'E2E移仓取证件', qty: 50, barcode: tag, fromLoc: 'NB02-A-16-4F', move: '人工' }] });
    const p1 = await post('/api/outbound/sync', wh, ob('E2EMVDT0001', '焊-宁波-线边仓/焊-宁波-线边仓/焊-宁波-线边仓', TAG1));
    const p2 = await post('/api/outbound/sync', wh, ob('E2EMVDT0002', '焊-宁波-冷冲件仓/焊-宁波-冷冲件仓/焊-宁波-冷冲件仓', TAG2));
    chk('P1 两单推送受理', [p1.json.ok, p2.json.ok], [true, true]);
    await sleep(300);

    // —— /api/counts：推1出库+1移仓后 todayOut 只 +1（移仓不计）——
    const c1 = (await get('/api/counts', wh)).json;
    chk('C1 todayOut 只计线边单(+1，移仓剔除)', c1.todayOut - cBase, 1);

    // —— /api/outbound：每单现算 mv ——
    const ol = await get('/api/outbound?q=E2EMVDT', wh);
    const o1 = (ol.json.items || []).find((x) => x.orderNo === 'E2EMVDT0001');
    const o2 = (ol.json.items || []).find((x) => x.orderNo === 'E2EMVDT0002');
    chk('O1 线边单 mv=0', o1 && o1.mv, 0);
    chk('O2 冷冲单 mv=1', o2 && o2.mv, 1);

    // —— /api/part/profile：out 行带 mv、outTotal 剔移仓、mvTotal 单列 ——
    const pf = await get('/api/part/profile?pn=' + PN, wh);
    const outRows = (pf.json.out || []);
    const r1 = outRows.find((x) => x.tag === TAG1), r2 = outRows.find((x) => x.tag === TAG2);
    chk('F1 档案线边行 mv=0', r1 && r1.mv, 0);
    chk('F2 档案移仓行 mv=1', r2 && r2.mv, 1);
    chk('F3 outTotal=1(只计线边)', pf.json.outTotal, 1);
    chk('F4 mvTotal=1(移仓单列)', pf.json.mvTotal, 1);

    // —— 参数即时翻转：管理员把关键词改成"冷冲件仓" → 原移仓单变出库、线边单变移仓 ——
    const sp = await post('/api/admin/params', ad, { values: { outWhKeys: '冷冲件仓' }, baseRev: (await get('/api/admin/params', ad)).json.cfgRev });
    chk('S1 文本参数保存成功', sp.json.ok, true);
    const ol2 = await get('/api/outbound?q=E2EMVDT', wh);
    const o1b = (ol2.json.items || []).find((x) => x.orderNo === 'E2EMVDT0001');
    const o2b = (ol2.json.items || []).find((x) => x.orderNo === 'E2EMVDT0002');
    chk('S2 改参数后线边单变移仓 mv=1', o1b && o1b.mv, 1);
    chk('S3 改参数后冷冲单变出库 mv=0', o2b && o2b.mv, 0);
    const pf2 = await get('/api/part/profile?pn=' + PN, wh);
    chk('S4 档案口径同步翻转', [pf2.json.outTotal, pf2.json.mvTotal], [1, 1]); // 总数不变，角色互换
    // 回退默认
    await post('/api/admin/params', ad, { values: { outWhKeys: '线边仓' }, baseRev: (await get('/api/admin/params', ad)).json.cfgRev });

    // —— /api/me 下发关键词 ——
    const me = await get('/api/me', wh);
    chk('M1 me 下发 outWhKeys', me.json.outWhKeys, '线边仓');

    // —— 消账物理动作不受口径影响：seenOut 两标签都登记（移仓实物同样离库）——
    await sleep(300);
    const dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('X1 移仓标签同样登记 seenOut', [!!dd.seenOut[TAG1], !!dd.seenOut[TAG2]], [true, true]);

    // —— 呆滞/最近出库有意含移仓：D2 消费 lastOut 无 mv 过滤（代码注释已声明），此处以 profile 移仓行仍出现在列表验证"保留可见" ——
    chk('V1 移仓行保留在档案列表（标注可见非隐藏）', outRows.length, 2);

    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill();
    await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
