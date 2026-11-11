// ㉖v148 网页建单常领一键加 + 再来一单 + 手机适配 · 实例证明
// 用户问：网页除了预约，有没有再来一单、常领？——查实：两个都没有（PDA 早就有，网页漏配）。
// 补齐：①建单弹窗顶部"⚡常领"横滑条（同源 /api/requisitions/frequent，60天频次排序，
//   chip=后6位×N框，断料≤3天红标；点击=上次件数换算框数填入空行/追加行）；
//   ②单据抽屉底部"🔁 再来一单"（有 requisition 权限才显示，与 PDA 同则；原单件数换算回框数预填）；
//   ③手机适配：横滑条 flex 不压缩+惯性滚动+32px 触摸热区+按下反馈。
// 证明面：
//  F组 nFreqPreload/nFreqAdd 沙箱行为（chip 渲染/换算/红标/空数据不占位/填空行/追加行/无均值兜底）
//  E组 端点真实调用（material 造 60 天历史，list 字段与排序断言）
//  P组 再来一单预填换算锚点（件数→框数 ceil、无均值原值、字典缺失计数提示）
//  M组 手机适配与事故哨兵（List.from 残留清零——本批实施时曾混入 Dart 语法被哨兵抓出）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), vm = require('vm');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_nfreq'), PORT = 8418, BASE = 'http://127.0.0.1:' + PORT;
const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 170)} want=${String(JSON.stringify(w)).slice(0, 170)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function grabFn(name) {
  const m = html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\s*\\{'));
  if (!m) return null;
  const start = m.index; let depth = 0; const i = html.indexOf('{', start);
  for (let j = i; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}') { depth--; if (!depth) return html.slice(start, j + 1); } }
  return null;
}
console.log('== F组 常领条沙箱行为 ==');
{
  const fPre = grabFn('nFreqPreload'), fAdd = grabFn('nFreqAdd');
  chkT('F0 两函数可抽取', !!fPre && !!fAdd, '');
  const mkRow = (pn) => { const els = { '.npn': { value: pn || '' }, '.nnm': { value: '' }, '.nqty': { value: '' } }; return { querySelector: (s) => els[s], _els: els }; };
  let elFreq, box, apiCalls = [], toastLog = [];
  const win = { _dictCache: [{ pn: 'PN000001', nm: '件一', perBoxQty: 100, boxes: 5 }, { pn: 'PN000002', nm: '件二', perBoxQty: 0, boxes: 0 }], _nFreq: [], _nrowTpl: () => '<div></div>' };
  const ctx = vm.createContext({
    window: win, Math, Number, String, JSON, Object, Array, Promise, RegExp, console,
    api: (p) => { apiCalls.push(p); return Promise.resolve(p.includes('frequent') ? { ok: true, list: win.__freqList || [] } : { ok: true }); },
    dictLoad: () => { return Promise.resolve(); },
    document: { getElementById: (id) => id === 'nfreq' ? elFreq : id === 'nitems' ? box : null },
    T: (m) => toastLog.push(m), _esc: (s) => String(s), nrowHint: () => {},
  });
  vm.runInContext(fPre + '\n' + fAdd + ';globalThis.__pre=nFreqPreload;globalThis.__add=nFreqAdd;', ctx);
  (async () => {
    // F1 无数据=整条不占位
    win.__freqList = []; elFreq = { innerHTML: '' };
    await vm.runInContext('__pre()', ctx);
    chk('F1 无常领历史不渲染', elFreq.innerHTML, '');
    // F2 渲染：框数换算(300件/100=3框)、红标(daysLeft=2)、chip 数
    win.__freqList = [
      { pn: 'PN000001', nm: '件一', n: 8, lastQty: 300, daysLeft: 20, inBoxes: 5 },
      { pn: 'PN000002', nm: '件二', n: 3, lastQty: 60, daysLeft: 2, inBoxes: 0 },
    ];
    elFreq = { innerHTML: '' };
    await vm.runInContext('__pre()', ctx);
    chkT('F2 chip1 换算 300件÷100=3框', elFreq.innerHTML.includes('000001×3框'), elFreq.innerHTML.slice(0, 150));
    chkT('F3 chip2 无均值兜底原值60 + 断料红标', elFreq.innerHTML.includes('×60框') && elFreq.innerHTML.includes('nfchip risk') && elFreq.innerHTML.includes('仅剩2天'), '');
    chkT('F4 title 含频次/在架托数', elFreq.innerHTML.includes('60天领8次') && elFreq.innerHTML.includes('在架5框'), '');
    // F5 点击填空行（第一行 npn 空）
    box = { _rows: [mkRow(''), mkRow('PN9')], querySelectorAll: (s) => s === '.nrow' ? box._rows : [], insertAdjacentHTML: () => {}, lastElementChild: null };
    win._nFreq = win.__freqList;
    vm.runInContext('__add("PN000001")', ctx);
    chk('F5 优先填空行：值回填', [box._rows[0]._els['.npn'].value, box._rows[0]._els['.nqty'].value, box._rows[0]._els['.nnm'].value], ['PN000001', 3, '件一']);
    chk('F5b 已有行不动', box._rows[1]._els['.npn'].value, 'PN9');
    // F6 无空行→追加
    box = { _rows: [mkRow('PXA')], querySelectorAll: (s) => s === '.nrow' ? box._rows : [], insertAdjacentHTML(pos, h) { const r = mkRow(''); box._rows.push(r); box.lastElementChild = r; }, lastElementChild: null };
    vm.runInContext('__add("PN000002")', ctx);
    chk('F6 无空行追加新行并填值', [box._rows.length, box._rows[1]._els['.npn'].value, box._rows[1]._els['.nqty'].value], [2, 'PN000002', 60]);
  })().catch((e) => { console.log(e.stack); fail++; total++; });
}
console.log('== P组 再来一单预填换算锚点 ==');
chkT('P1 newReqDlg 收 prefill 参数', html.includes('async function newReqDlg(prefill)'), '');
chkT('P2 预填换算=件数÷均值向上取整(与PDA _boxesFromPieces 同式)', /per>0\?Math\.max\(1,Math\.ceil\(\(Number\(pieces\)\|\|0\)\/per\)\)/.test(html), '');
chkT('P3 无均值兜底原值当件数', html.includes(':Math.max(1,Number(pieces)||1);'), '');
chkT('P4 字典缺失计数并提示', html.includes('if(!d)miss++') && html.includes('个零件字典已无档案'), '');
chkT('P5 reqAgain 抽屉入口：关抽屉→预填新建', /function reqAgain\(id\)\{const r=\(window\._reqs/.test(html) && html.includes('newReqDlg(pf)'), '');
chkT('P6 按钮权限与PDA同则(requisition+有行)', html.includes("requisition&&(r.items||[]).length") && html.includes('🔁 再来一单'), '');
console.log('== M组 手机适配与事故哨兵 ==');
chkT('M1 横滑条不压缩+惯性滚动', html.includes('.nfreq{display:flex;gap:5px;overflow-x:auto') && html.includes('-webkit-overflow-scrolling:touch'), '');
chkT('M2 chip flex:0 0 auto 不被挤扁+32px 触摸热区', html.includes('.nfchip{flex:0 0 auto') && html.includes('min-height:32px'), '');
chkT('M3 按下反馈(手机无 hover)', html.includes('.nfchip:active{background:var(--pri);color:#fff}'), '');
chkT('M4 断料红标样式在位', html.includes('.nfchip.risk{border-color:var(--warn)'), '');
chkT('M5 Dart 语法残留清零（本批事故哨兵：List.from 曾混入 JS）', !/List\.from\(/.test(html), '');
console.log('== E组 端点真实调用 ==');
(async () => {
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
  const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex');
  const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
  const now = Date.now();
  db0.users.push({ id: 'u_nq', username: 'nq_mt', name: '常领线边', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Nq!148', salt) });
  db0.requisitions = (db0.requisitions || []).filter((r) => r.by !== 'u_nq');
  const mkRq = (no, dayOff, pn, qty) => ({ id: 'rq_' + no, no, by: 'u_nq', byName: '常领线边', status: 'done', createdAt: new Date(now - dayOff * 864e5).toISOString(), items: [{ partNo: pn, itemName: '常领件' + pn.slice(-2), qty, issued: [], sugCodes: [] }], history: [] });
  for (let i = 1; i <= 5; i++) db0.requisitions.push(mkRq('LLNQ' + i, i * 3, 'NQPNA', 200)); // PNA 5次
  db0.requisitions.push(mkRq('LLNQ6', 10, 'NQPNB', 80)); // 1次
  db0.requisitions.push(mkRq('LLNQ7', 75, 'NQPNB', 80)); // 75天前=窗外，不计
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill('SIGKILL'); process.exit(1); }
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nq_mt', password: 'E2e#Nq!148' }) })).json()).token;
    const j = await (await fetch(BASE + '/api/requisitions/frequent', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const a = (j.list || []).find((x) => x.pn === 'NQPNA') || {};
    chk('E1 60天窗口聚合：PNA 5次/上次200件', [a.n, a.lastQty], [5, 200]);
    chk('E2 频次高在前(PNA先于PNB)', (j.list || []).map((x) => x.pn), ['NQPNA', 'NQPNB']);
    chk('E3 窗外单不计(PNB 仅1次非2)', (j.list || []).find((x) => x.pn === 'NQPNB').n, 1);
    chkT('E4 字段齐(daysLeft/inBoxes 供红标与title)', 'daysLeft' in (j.list || [])[0] && 'inBoxes' in (j.list || [])[0], '');
    const uncaught = log.join('').split('\n').filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
    chkT('Z 服务日志无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 150));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  setTimeout(() => { console.log(`\n===== v148 网页常领与再来一单实例证明 ${total - fail}/${total} PASS =====`); process.exit(fail ? 1 : 0); }, 300); // 等 F 组异步沙箱跑完
})();
