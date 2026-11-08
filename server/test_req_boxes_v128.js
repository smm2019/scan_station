// ㉖v128 网页建单框数口径 + iPhone 适配 · 实例证明
// 需求：网页领料建单对齐 APP——填【框数】非件数（v71b 拍板口径，杜绝"填10框提交变10件"）；
//       为苹果手机 Safari 网页下单做适配（无安卓机场景）
// 实现：/api/dict 每零件下发 perBoxQty(在架件数÷在架框数，boxKeyOf 同托去重)/boxes；
//       网页建单行=框数输入+实时"≈N件"换算+联想带在架框数；提交按 框×均值 换算（无均值兜底原值当件数，对齐 PDA:687）；
//       超在架量提交前同单位(件)比对警示；CSS：viewport-fit=cover/safe-area/iOS 16px 防聚焦缩放/触摸热区/键盘弹出滚动提交钮
// 证明面：
//  D1 同托多码=1框：pid 相同两码(100+50)与第三码(200) → boxes=2 perBoxQty=175
//  D2 无托号按货位+零件分框：三个不同格位码 → boxes=3，均值=件数和/3（0.1 取整）
//  D3 无在架零件不下发两字段（前端兜底路径的数据前提）
//  D4 字典滞后零件（账本有/字典无）也带出均值（联想合并账本同源）
//  F 换算公式锚点：per>0→round(框×均值)、否则原值当件数（与 PDA requisition_page:687 同式）
//  V iPhone 适配锚点：viewport-fit/safe-area/16px/热区/nreqbtn
//  G 弹窗文案锚点：框数口径说明+placeholder+联想在架框数+超量同单位比对
const fs = require('fs'); const path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const SRC = path.join(__dirname, 'data'); const TDIR = path.join(__dirname, 'data_e2e_v128'); const PORT = 8372; const BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex'); const hp = (pw) => crypto.scryptSync(pw, salt, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v8', username: 'v8_wh', name: 'V128仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hp('E2e#V8!128') });
db0.ledger = [
  // PNV128A：同托两码(100+50)=1框 + 另一托200=1框 → boxes=2 件350 均175
  { c: 'V8A0000001', l: 'NB02-A-01-1F', q: 100, p: 'PNV128A', n: '甲件', b: '2026-10-01', pid: 'V8PA1', f: '1600*1100', t: now, by: '夹具', rec: now, hist: [] },
  { c: 'V8A0000002', l: 'NB02-A-01-1F', q: 50, p: 'PNV128A', n: '甲件', b: '2026-10-01', pid: 'V8PA1', f: '1600*1100', t: now, by: '夹具', rec: now, hist: [] },
  { c: 'V8A0000003', l: 'NB02-A-02-1F', q: 200, p: 'PNV128A', n: '甲件', b: '2026-10-01', pid: 'V8PA2', f: '1600*1100', t: now, by: '夹具', rec: now, hist: [] },
  // PNV128B：三个无托号不同格位(10/20/31) → boxes=3 件61 均 20.3（61/3=20.333→0.1取整20.3）
  { c: 'V8B0000001', l: 'NB03-A-01-01', q: 10, p: 'PNV128B', n: '乙件', b: '2026-10-02', pid: '', f: '', t: now, by: '夹具', rec: now, hist: [] },
  { c: 'V8B0000002', l: 'NB03-A-01-02', q: 20, p: 'PNV128B', n: '乙件', b: '2026-10-02', pid: '', f: '', t: now, by: '夹具', rec: now, hist: [] },
  { c: 'V8B0000003', l: 'NB03-A-01-03', q: 31, p: 'PNV128B', n: '乙件', b: '2026-10-02', pid: '', f: '', t: now, by: '夹具', rec: now, hist: [] },
  // PNV128D：账本有但字典无（滞后零件）→ 联想合并源也要带均值
  { c: 'V8D0000001', l: 'NB02-C-01-2F', q: 66, p: 'PNV128D', n: '丁件', b: '2026-10-03', pid: 'V8PD1', f: '', t: now, by: '夹具', rec: now, hist: [] },
];
db0.itemDict = { PNV128A: { nm: '甲件', src: '夹具', at: now }, PNV128B: { nm: '乙件', src: '夹具', at: now } }; // D 不在字典
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v128 网页建单框数口径证明');
  try {
    const wh = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v8_wh', password: 'E2e#V8!128' }) })).json()).token;
    const j = await (await fetch(BASE + '/api/dict', { headers: { Authorization: 'Bearer ' + wh } })).json();
    const by = {}; for (const x of j.list || []) by[x.pn] = x;
    chk('D1 同托多码=1框：A件 boxes=2', [by.PNV128A.boxes, by.PNV128A.perBoxQty], [2, 175]);
    chk('D2 无托号按位分框：B件 boxes=3 均20.3', [by.PNV128B.boxes, by.PNV128B.perBoxQty], [3, 20.3]);
    chk('D3 无在架零件（夹具外真实件抽查）不下发两字段', (() => { const x = (j.list || []).find((y) => !/^PNV128/.test(y.pn) && !((db0.ledger || []).some((l) => String(l.p).toUpperCase() === y.pn))); return x ? [x.boxes === undefined, x.perBoxQty === undefined] : ['no-such-item', true]; })(), [true, true]);
    chk('D4 字典滞后零件仍带均值（账本联想合并同源）', [by.PNV128D.boxes, by.PNV128D.perBoxQty, by.PNV128D.nm], [1, 66, '丁件']);
    // 换算公式复算（与前端 newReqGo 同式）：填3框A件 → 3×175=525件；填2框B件 → 2×20.3=41（round）；无均值零件填8 → 8件
    const conv = (q, per) => per > 0 ? Math.round(q * per) : q;
    chk('F1 框×均值换算（A件3框→525件）', conv(3, by.PNV128A.perBoxQty), 525);
    chk('F2 均值非整也正确取整（B件2框→41件）', conv(2, by.PNV128B.perBoxQty), 41);
    chk('F3 无均值兜底原值当件数（对齐PDA:687）', conv(8, 0), 8);
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  // ===== 前端锚点 =====
  const h = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
  chkT('G1 行模板改框数口径（placeholder/提示/换算钩子）', h.includes('placeholder="框数 *"') && h.includes('oninput="nrowHint(this)"') && h.includes('1框=发料最小单位'));
  chkT('G2 提交换算与 PDA 同式（per>0?round(q×per):q）', h.includes('qty:per>0?Math.round(q*per):q'));
  chkT('G3 联想项带在架框数与件/框均值', h.includes("'在架'+x.boxes+'框'") && h.includes("x.perBoxQty+'件/框'"));
  chkT('G4 超在架量提交前警示且同单位(件)比对', h.includes('i.qty>i.avail*i.perBox') && h.includes('超过当前在架量'));
  chkT('G5 提示行含在架框数与超框标记', h.includes('≈') && h.includes('⚠超在架框数') && h.includes('无每框均值 · 按 '));
  chkT('V1 viewport-fit=cover（safe-area 前提）', h.includes('viewport-fit=cover'));
  chkT('V2 safe-area 底部留白（导航/正文/弹窗/toast 四处）', h.includes('env(safe-area-inset-bottom)') && (h.match(/env\(safe-area-inset-bottom\)/g) || []).length >= 4);
  chkT('V3 iOS 输入 16px 防聚焦放大', h.includes('input,select,textarea{font-size:16px!important}'));
  chkT('V4 触摸热区（pill/弹窗输入最小高）', h.includes('.pill{min-height:34px}') && h.includes('.dlg input,.dlg select{min-height:38px}'));
  chkT('V5 勾选框不吃最小高度（防变形）', h.includes('.dlg .row input[type=checkbox]{min-height:auto;width:auto}'));
  chkT('V6 键盘弹出提交按钮滚动可见', h.includes("id=\"nreqbtn\"") && h.includes('nrowFocus'));
  chkT('V7 数字输入 inputmode=numeric（iOS 数字键盘）', h.includes('inputmode="numeric"'));
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v128 网页建单框数口径+iPhone适配实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
