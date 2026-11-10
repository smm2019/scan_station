// ㉖v133 项目字典行级编辑（改名+挂/解绑零件）· 实例证明
// 用户痛点：项目码清单每行只有"删码"，项目名全是"—"没法改，零件挂错只能删码重建或走文本批量——"找不到修改和删除的地方"
// 事实：projDict[code].nm 字段 v101 起就有（GET /api/proj 也回传），但从未给过编辑入口；本次补 /api/proj/upd + 网页"✎ 修改"弹窗
// 证明面：
// U1 改名：upd nm → GET list 回传新名；空串=清除名
// U2 补挂：add 一个已有其它项目的零件 → 多值合并（原归属保留）；重复挂幂等
// U3 解绑：del → 该零件此码移除、其它码不动；唯一码则整行删除
// U4 校验：码不存在 400；material 角色 403；超长 pn 拒
// U5 联动：改名后 /api/proj 的 map 不受影响（只动字典名）
// F  前端锚点：修改按钮、弹窗函数、_pjNm 缓存、pjAddGo/pjTog/pjRender
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_proj_v133');
const PORT = 8399, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v3wh', username: 'v133_wh', name: 'V133仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V3!wh', salt) });
db0.users.push({ id: 'u_v3mt', username: 'v133_mt', name: 'V133线边', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V3!mt', salt) });
const CA = 'V133AA1', CB = 'V133BB2';
db0.projDict = Object.assign(db0.projDict || {}, { [CA]: { nm: '', at: now }, [CB]: { nm: '旧名B', at: now } });
db0.projMap = Object.assign(db0.projMap || {}, { '88V133PN001': [CA], '88V133PN002': [CA, CB], '88V133PN003': [CB] });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(p, tk, opt) { const r = await fetch(BASE + p, { method: (opt && opt.method) || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, ...(opt && opt.body ? { body: JSON.stringify(opt.body) } : {}) }); return r.json(); }
let PASS = 0, FAIL = 0;
function chk(t, a, b, note) { const ok = JSON.stringify(a) === JSON.stringify(b); ok ? PASS++ : FAIL++; console.log(`  ${ok ? '✅' : '❌'} ${t}` + (ok ? '' : `\n     期望=${JSON.stringify(b)} 实际=${JSON.stringify(a)}${note ? ' ' + note : ''}`)); }
(async () => {
  const srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env: Object.assign({}, process.env, { PORT, HOST: '127.0.0.1', DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => log += d); srv.stderr.on('data', (d) => log += d);
  await sleep(2600);
  const lg = await req('/api/login', null, { method: 'POST', body: { username: 'v133_wh', password: 'E2e#V3!wh' } });
  const TK = lg.token || (lg.data && lg.data.token);
  const lm = await req('/api/login', null, { method: 'POST', body: { username: 'v133_mt', password: 'E2e#V3!mt' } });
  const TKM = lm.token || (lm.data && lm.data.token);
  console.log('===== U1 改名 =====');
  let j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CA, nm: '吉利V133甲' } });
  chk('U1a upd 返回 renamed', [j.ok, j.renamed], [true, true]);
  let g = await req('/api/proj', TK); const la = g.list.find((x) => x.code === CA);
  chk('U1b GET list 回传新名', la && la.nm, '吉利V133甲');
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CA, nm: '   ' } });
  g = await req('/api/proj', TK);
  chk('U1c 空串=清除名（幂等 renamed=false 再改同值）', [j.ok, g.list.find((x) => x.code === CA).nm], [true, '']);
  console.log('===== U2 补挂（多值合并）=====');
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CB, add: ['88V133PN001'] } });
  g = await req('/api/proj', TK);
  chk('U2a PN001 挂 CB 后保留 CA（多值）', g.map['88V133PN001'].slice().sort(), [CA, CB].sort());
  chk('U2b add 计数', [j.ok, j.add], [true, 1]);
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CB, add: ['88V133PN001'] } });
  chk('U2c 重复挂幂等 add=0', [j.ok, j.add], [true, 0]);
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CB, add: ['88V133NEW9'] } });
  g = await req('/api/proj', TK);
  chk('U2d 新零件号可挂', [j.add, (g.map['88V133NEW9'] || []).includes(CB)], [1, true]);
  console.log('===== U3 解绑 =====');
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CA, del: ['88V133PN002'] } });
  g = await req('/api/proj', TK);
  chk('U3a PN002 解 CA 留 CB', g.map['88V133PN002'], [CB]);
  chk('U3b del 计数', [j.ok, j.del], [true, 1]);
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CA, del: ['88V133PN001'] } }); // PN001 唯一码=CA（U2 后是 [CA,CB]… 实际 CA 唯一的是无）→ 改用只挂CA的：PN001 已双码，验证整行删除用新零件
  g = await req('/api/proj', TK);
  chk('U3c PN001 解 CA 后剩 CB', g.map['88V133PN001'], [CB]);
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CB, del: ['88V133PN001'] } });
  g = await req('/api/proj', TK);
  chk('U3d 唯一码解绑后整行删除', g.map['88V133PN001'] === undefined, true);
  console.log('===== U4 校验与权限 =====');
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: 'NOPE99', nm: 'x' } });
  chk('U4a 码不存在 400 语义', [j.ok, j.msg], [false, '项目码不存在']);
  j = await req('/api/proj/upd', TKM, { method: 'POST', body: { code: CA, nm: 'x' } });
  chk('U4b material 角色 403 语义', String(j.msg || '').includes('仅仓管员'), true);
  j = await req('/api/proj/upd', TK, { method: 'POST', body: { code: CA, add: ['X'.repeat(45)] } });
  g = await req('/api/proj', TK);
  chk('U4c 超长零件号被过滤不入库', [j.add, Object.keys(g.map).some((k) => k.length > 40)], [0, false]);
  console.log('===== U5 联动与留痕 =====');
  g = await req('/api/proj', TK);
  chk('U5a 改名不动 map（PN003 仍挂 CB）', g.map['88V133PN003'], [CB]);
  await sleep(900);
  const dbF = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const opsHit = JSON.stringify(dbF.ops || {}).includes('编辑 ' + CA);
  chk('U5b 操作留痕落库（pushOps 编辑记录）', opsHit, true);
  console.log('===== F 前端锚点 =====');
  const html = fs.readFileSync(path.join(__dirname, 'public/console.html'), 'utf8');
  chk('F1 清单行修改按钮', html.includes("onclick=\"projEdit('${_esc(x.code)}')\">✎ 修改"), true);
  chk('F2 编辑弹窗与提交函数', [html.includes('async function projEdit(code)'), html.includes('async function projEditGo(btn)')], [true, true]);
  chk('F3 _pjNm 缓存回填项目名', html.includes('window._pjNm={};for(const x of (j.list||[]))'), true);
  chk('F4 补挂输入与幂等提示', [html.includes('function pjAddGo()'), html.includes('所选零件已挂在本项目下')], [true, true]);
  chk('F5 解绑/撤销切换 pjTog', html.includes('function pjTog(pn)'), true);
  chk('F6 已挂列表过滤渲染 pjRender', html.includes('function pjRender()'), true);
  console.log('===== G 服务健康 =====');
  chk('G1 无未捕获异常', /Uncaught|TypeError: .*proj\/upd/.test(log), false);
  srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v133 项目字典行级编辑 实例证明 ${PASS}/${PASS + FAIL} ${FAIL ? 'FAIL' : 'PASS'} =====`);
  process.exit(FAIL ? 1 : 0);
})().catch((e) => { console.error('RUNNER', e); process.exit(2); });
