// ㉖v101 项目字典 · 端到端取证（真实 HTTP 打隔离实例）
// 覆盖：四端点鉴权、set 多值/新建码/清除、suggest 只读不写库、profile/stockRisk 带 projs、D2/D4 导出列、rm 解绑
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_proj_v101');
const PORT = 8323;
const BASE = 'http://127.0.0.1:' + PORT;

fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
// 测试隔离：主库可能已由用户真实配置 projDict/projMap（10/29 实测 4码179项），副本必须清空回"初始空字典"前提，
// 否则 S1/U3/U4"初始为空/建议不落库"断言被真实数据破坏（断言对象是端点行为，不是用户数据）
delete db0.projDict; delete db0.projMap;
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Prj!pw', salt) });
db0.users.push(mkU('u_e2e_prj_wh', 'e2e_prj_wh', 'E2E仓管', 'warehouse'), mkU('u_e2e_prj_mt', 'e2e_prj_mt', 'E2E物料员', 'material'));
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p, tk) { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})), text: null }; }
async function getText(p, tk) { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); const t = await r.text(); return { status: r.status, text: t }; }

(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); up = r.ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    const wh = (await post('/api/login', null, { username: 'e2e_prj_wh', password: 'E2e#Prj!pw' })).json.token;
    const mt = (await post('/api/login', null, { username: 'e2e_prj_mt', password: 'E2e#Prj!pw' })).json.token;
    const PN1 = '6608197902', PN2 = '8889037856'; // 真实字典零件

    // —— 鉴权 ——
    chk('G1 物料员可读 proj 清单', (await get('/api/proj', mt)).json.ok, true);
    const f1 = await post('/api/proj/set', mt, { items: [{ pn: PN1, codes: ['吉利E281'] }] });
    chk('G2 物料员写 proj 被拒 403', f1.status, 403);
    chk('G3 未登录读被拒', (await get('/api/proj', null)).status, 401);

    // —— 空态 ——
    const g0 = await get('/api/proj', wh);
    chk('S1 初始清单为空', [g0.json.list.length, Object.keys(g0.json.map || {}).length], [0, 0]);

    // —— suggest 只读不写库（安全闸门核心断言）——
    const sg = await post('/api/proj/suggest', wh, {});
    chk('U1 suggest 返回建议组', (sg.json.groups || []).length >= 5, true);
    chk('U2 吉利E281 组在建议中且件数≥100', (sg.json.groups || []).some((x) => x.code === '吉利E281' && x.n >= 100), true);
    chk('U3 suggest 不写库：map 仍空', Object.keys((await get('/api/proj', wh)).json.map || {}).length, 0);
    chk('U4 suggest 不写库：dict 仍空', (await get('/api/proj', wh)).json.list.length, 0);
    const sus = (sg.json.groups || []).find((x) => x.code === '吉利E281');
    chk('U5 变体组标 suspect', sus && sus.suspect, true);
    const f2 = await post('/api/proj/suggest', mt, {});
    chk('U6 物料员无权跑 suggest', f2.status, 403);

    // —— set：多值 + 新建码 + 格式闸 + 清除 ——
    const st1 = await post('/api/proj/set', wh, { items: [{ pn: PN1, codes: ['吉利E281', '吉利EX11'] }, { pn: PN2, codes: ['吉利E281'] }] });
    chk('W1 set 受理 2 项', [st1.json.ok, st1.json.set, st1.json.newCodes], [true, 2, 2]);
    await sleep(250);
    let dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('W2 多值归属落库', dd.projMap[PN1], ['吉利E281', '吉利EX11']);
    chk('W3 新码自动入清单', dd.projDict && dd.projDict['吉利E281'] !== undefined, true);
    const st2 = await post('/api/proj/set', wh, { items: [{ pn: 'TESTPN01', codes: ['纯字母码'] }, { pn: 'TESTPN02', codes: ['E281'] }] });
    chk('W4 非法码(无数字)计入无效且不落库', [st2.json.bad >= 1, (dd.projMap || {}).TESTPN01 === undefined], [true, true]);
    await sleep(250);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('W5 合法码照常入典', dd.projMap.TESTPN02, ['E281']);
    const st3 = await post('/api/proj/set', wh, { text: PN2 + ',\n' }); // 只给零件号不给码 = 清除
    chk('W6 空码清除归属', [st3.json.ok, st3.json.cleared], [true, 1]);
    await sleep(250);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('W7 清除后 map 无该零件', dd.projMap[PN2] === undefined, true);
    const st4 = await post('/api/proj/set', wh, { text: 'TESTPN03，吉利V446K' }); // 中文逗号 + 新码
    await sleep(300); // 等 save() 落盘后再读文件
    chk('W8 text 中文逗号解析', (JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).projMap || {}).TESTPN03, ['吉利V446K']);

    // —— profile / stockRisk 带 projs ——
    const pf = await get('/api/part/profile?pn=' + PN1, wh);
    chk('F1 档案返回所属项目', pf.json.projs, ['吉利E281', '吉利EX11']);
    const rk = await get('/api/stock/risk?days=60', wh);
    chk('F2 断料列表可查（前端本地pjOf过滤，后端不阻塞）', rk.json.ok, true);

    // —— D2 / D4 导出预览列 ——
    const d2 = await get('/api/export?ds=D2&preview=1', wh);
    chk('E1 D2 表头含所属项目', (d2.json.head || []).includes('所属项目'), true);
    const d4 = await get('/api/export?ds=D4&preview=1', wh);
    chk('E2 D4 表头含所属项目', (d4.json.head || []).includes('所属项目'), true);
    const d4full = await getText('/api/export?ds=D4&fmt=csv&from=2026-10-01&to=2026-12-31', wh);
    // PN1(6608197902)只在账本不在出库行，改断言真实出库单零件：给 8888002877（冷冲移仓单行）配码后应同现于行
    await post('/api/proj/set', wh, { items: [{ pn: '8888002877', codes: ['吉利E281'] }] });
    await sleep(300);
    const d4b = await getText('/api/export?ds=D4&fmt=csv&from=2026-10-01&to=2026-12-31', wh);
    const line = (d4b.text.split(/\r?\n/).find((l) => l.includes('8888002877')) || '').replace(/"/g, '');
    chk('E3 D4 CSV 项目列随行内容正确', line.includes('8888002877') && line.split(',')[4] === '吉利E281', true);

    // —— rm 解绑 ——
    const rm = await post('/api/proj/rm', wh, { code: '吉利EX11' });
    chk('R1 删码解绑 1 零件', [rm.json.ok, rm.json.unbind], [true, 1]);
    await sleep(250);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('R2 零件仅剩另一码', dd.projMap[PN1], ['吉利E281']);
    chk('R3 码从清单移除', dd.projDict['吉利EX11'] === undefined, true);

    // —— 幂等：同值重推不计改动 ——
    const st5 = await post('/api/proj/set', wh, { items: [{ pn: PN1, codes: ['吉利E281'] }] });
    chk('W9 同值重推幂等(set=0)', st5.json.set, 0);

    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill();
    await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
