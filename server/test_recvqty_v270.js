// ㉖v270 来料区"来了多少/还压多少"件数闭环取证
// 背景：设置来料区的目的=让人知道料来了多少、料在哪里。v269 前概览只有标签数卡，
//   "多少"的车间语义=件数（一框50件与一框2400件只看框数判断不了到货进度）→ 补件数两卡+副标+PDA汇总行。
// 断言：①dashboard kpi 带 recvTodayQty/pendRecvQty 且与夹具手工复算一致
//       ②yPrev 带 recvToday/recvTodayQty（昨日同期公平对照）
//       ③counts 带 recvBoxes(按托去重)/recvQty/recvTodayQty
//       ④网页 KARR 含两新卡+标签卡件数副标；cell 支持第5参副标
//       ⑤PDA 全宽汇总行+recv 筛选在位（格式化免疫）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_recvqty_v270');
const PORT = 8463, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v270', username: 'v270_w', name: 'V270仓管', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#Q0!w', salt) });
const now = Date.now();
// 清掉今日既有流水/账本 NB04 干扰，夹具自造（断言不随现场漂移）
db0.scanlog = db0.scanlog || {};
for (const k of Object.keys(db0.scanlog)) { const s = db0.scanlog[k]; if (String(s.code).startsWith('V270')) delete db0.scanlog[k]; }
db0.ledger = (db0.ledger || []).filter((x) => !String(x.c).startsWith('V270'));
// 今日来料：V270A 100件 + V270B 200件（同托双码=1框）；昨日同窗来料 V270Y 50件
db0.scanlog['V270A|B|' + (now - 3600e3)] = { code: 'V270A', wt: 2, gl: 'NB04-A-09-301', st: '', cx: false, t: now - 3600e3, q: 100, pn: 'V270PA', op: 'V270', batch: 'B270' };
db0.scanlog['V270B|B|' + (now - 3500e3)] = { code: 'V270B', wt: 2, gl: 'NB04-A-09-302', st: '', cx: false, t: now - 3500e3, q: 200, pn: 'V270PB', op: 'V270', batch: 'B270', pid: 'V270T1' };
db0.scanlog['V270B2|B|' + (now - 3400e3)] = { code: 'V270B2', wt: 2, gl: 'NB04-A-09-302', st: '', cx: false, t: now - 3400e3, q: 200, pn: 'V270PB', op: 'V270', batch: 'B270', pid: 'V270T1' };
const yBase = new Date(); yBase.setHours(0, 0, 0, 0); const yT = yBase.getTime() - 864e5 + 3600e3;
db0.scanlog['V270Y|B|' + yT] = { code: 'V270Y', wt: 2, gl: 'NB04-A-09-303', st: '', cx: false, t: yT, q: 50, pn: 'V270PY', op: 'V270', batch: 'B270' };
// 当前仍停 NB04：A(100) + B托(200+200=400件,1框) → pendRecvQty=500, recvBoxes=2
db0.ledger.push({ c: 'V270A', l: 'NB04-A-09-301', p: 'V270PA', q: 100, t: now - 3600e3 });
db0.ledger.push({ c: 'V270B', l: 'NB04-A-09-302', p: 'V270PB', q: 200, t: now - 3500e3, pid: 'V270T1' });
db0.ledger.push({ c: 'V270B2', l: 'NB04-A-09-302', p: 'V270PB', q: 200, t: now - 3400e3, pid: 'V270T1' });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const ws = (s) => String(s).replace(/\s+/g, ' ');
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v270_w', password: 'E2e#Q0!w' }) })).json()).token;
    const dash = await (await fetch(BASE + '/api/dashboard', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const k = dash.kpi || {};
    // ① 今日来料件数=100+200+200=500（每码最新行）；待转入件数=500
    chkT('★①recvTodayQty=今日来料件数(夹具复算500)', k.recvTodayQty === 500, JSON.stringify(k.recvTodayQty));
    chkT('★①b pendRecvQty=当前压楼下方件数(500)', k.pendRecvQty === 500, JSON.stringify(k.pendRecvQty));
    chkT('①c 标签卡口径不变 recvToday=3', k.recvToday === 3, JSON.stringify(k.recvToday));
    // ② 昨日同期
    chkT('★②yPrev.recvTodayQty=昨日同窗来料件数50', (k.yPrev || {}).recvTodayQty === 50 && (k.yPrev || {}).recvToday === 1, JSON.stringify(k.yPrev));
    // ③ counts：recvBoxes 按托去重=2（A框+B托），recvQty=500，recvTodayQty=500
    const ct = await (await fetch(BASE + '/api/counts', { headers: { Authorization: 'Bearer ' + tk } })).json();
    chkT('★③counts.recvBoxes=2(同托双码去重)', ct.recvBoxes === 2, JSON.stringify(ct.recvBoxes));
    chkT('③b counts.recvQty=500', ct.recvQty === 500, JSON.stringify(ct.recvQty));
    chkT('③c counts.recvTodayQty=500', ct.recvTodayQty === 500, JSON.stringify(ct.recvTodayQty));
    // ④ 网页：两新卡+副标+cell第5参
    const h = ws(fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8'));
    chkT('★④KARR含今日来料件数/待转入件数两卡', h.includes("['今日来料件数',k.recvTodayQty||0") && h.includes("['待转入件数',k.pendRecvQty||0"), '');
    chkT('④b 标签卡带件数副标', h.includes("(k.recvTodayQty||0).toLocaleString()+' 件'") && h.includes("(k.pendRecvQty||0).toLocaleString()+' 件'"), '');
    chkT('④c cell支持副标第5参且渲染传入', h.includes('const cell=(n,t,c,fn,sub)=>') && h.includes('cell(x[1],x[0],x[2],x[3],x[4])'), '');
    // ⑤ PDA：全宽汇总行+recv筛选
    const iv = ws(fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_stock_page.dart'), 'utf8'));
    chkT('★⑤PDA全宽汇总行(框·件同显)', iv.includes("Text('🏜 一楼待转入'") && iv.includes("'$rb 框 · ${_fmtInvNum(rq)} 件'"), '');
    chkT('⑤b recv筛选在位', iv.includes('_flt == "recv"') && iv.includes('rows.where((r) => r.recvBoxes > 0)'), '');
    chkT('⑤c counts解析带recv字段', iv.includes('"recvBoxes": ((r["recvBoxes"] as num?) ?? -1).toInt()'), '');
    console.log(`\n===== v270 来料件数闭环取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.message); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
