// ㉖v145 网页建单弹窗产线模板（载入/存为）· 实例证明
// 用户实锤：网页新建领料单没有"存为产线模板/载入模板"入口，PDA 有——两端建单能力不对等。
// 补齐：弹窗工具条加 载入下拉+载入+存为模板+共享勾选；口径与 PDA v71b 定死一致（items.qty=框数）。
// 证明面：
//  A组 契约匹配：用网页同款 body 结构真实 POST /api/req-templates → GET 回读 items 原样、use=0 → use 计数 +1
//  A2 编辑原地更新（带 id）与共享位透传
//  B组 nTplSave 收集逻辑（vm 沙箱 mock DOM）：空行剔除/零件号大写/qty>0 过滤/共享位透传/无有效行拒
//  C组 nTplLoad 填充逻辑（vm 沙箱）：按模板行数重建行、三值回填、use 上报、空模板兜底两行
//  D组 弹窗接线锚点：工具条四件、preload 调用、_esc 复用
//  Z  服务日志无未捕获异常
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), vm = require('vm');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_ntpl'), PORT = 8417, BASE = 'http://127.0.0.1:' + PORT;
const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_nt', username: 'nt_wh', name: '模板仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Nt!145', salt) });
db0.reqTemplates = (db0.reqTemplates || []).filter((t) => t.by !== 'u_nt');
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 180)} want=${String(JSON.stringify(w)).slice(0, 180)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
// —— vm 沙箱：从 console.html 抽三个新函数 + 依赖，mock DOM ——
function grabFn(name) {
  const m = html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\)\\s*\\{'));
  if (!m) return null;
  const start = m.index; let depth = 0, i = html.indexOf('{', start);
  for (let j = i; j < html.length; j++) { if (html[j] === '{') depth++; else if (html[j] === '}') { depth--; if (!depth) return html.slice(start, j + 1); } }
  return null;
}
function mkRow(pn, nm, q) { // mock 一行 DOM
  const els = { '.npn': { value: pn }, '.nnm': { value: nm }, '.nqty': { value: q } };
  return { querySelector: (s) => els[s] };
}
function mkBox(rows) { const box = { innerHTML: '', _rows: [], lastElementChild: null, insertAdjacentHTML(pos, h) { const r = mkRow('', '', ''); this._rows.push(r); this.lastElementChild = r; }, querySelector: (s) => s === '.nrow' ? this._rows : null }; return box; }
function mkDoc(rows, box, selVal, sharedChecked) {
  return {
    getElementById: (id) => id === 'nitems' ? box : id === 'ntpl_sel' ? { value: selVal } : id === 'ntpl_sh' ? { checked: sharedChecked } : null,
    querySelectorAll: (s) => s === '#nitems .nrow' ? rows : [],
  };
}
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill('SIGKILL'); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v145 网页模板证明');
  const req = async (method, p, tk, body) => { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    const tk = (await req('POST', '/api/login', null, { username: 'nt_wh', password: 'E2e#Nt!145' })).json.token;
    // ===== A组 网页请求体与接口契约匹配（真实 HTTP） =====
    const a1 = await req('POST', '/api/req-templates', tk, { name: '总装线日常料', items: [{ partNo: '88AE145001', itemName: '面板件', qty: 3 }, { partNo: '88AE145002', itemName: '支架件', qty: 2 }], shared: true });
    chkT('A1 网页同款 body 保存成功', a1.json.ok === true && !!a1.json.id, JSON.stringify(a1.json).slice(0, 120));
    const tid = a1.json.id;
    let g1 = (await req('GET', '/api/req-templates', tk)).json.list.find((x) => x.id === tid);
    chk('A1b 回读 items=框数口径原样', [[g1.items[0].partNo, g1.items[0].qty], [g1.items[1].partNo, g1.items[1].qty], g1.shared, g1.use], [['88AE145001', 3], ['88AE145002', 2], true, 0]);
    await req('POST', '/api/req-templates/' + tid + '/use', tk, {});
    g1 = (await req('GET', '/api/req-templates', tk)).json.list.find((x) => x.id === tid);
    chk('A1c 载入后 use 计数=1（与 PDA 载入同口径）', g1.use, 1);
    const a2 = await req('POST', '/api/req-templates', tk, { name: '总装线日常料v2', items: [{ partNo: '88AE145001', itemName: '面板件', qty: 5 }], shared: false, id: tid });
    g1 = (await req('GET', '/api/req-templates', tk)).json.list.find((x) => x.id === tid);
    chkT('A2 带 id 原地编辑生效（改名/行数/共享）', a2.json.ok === true && g1.name === '总装线日常料v2' && g1.items.length === 1 && g1.shared === false, JSON.stringify([g1.name, g1.items.length, g1.shared]));
    // ===== B组 nTplSave 收集逻辑（vm 沙箱） =====
    {
      const fns = ['nTplSave', 'nTplLoad', 'nTplPreload'].map(grabFn);
      chkT('B0 三函数源码可抽取', fns.every(Boolean), '');
      const calls = []; let promptAns = '夜班线模板', rows, box, selVal, sharedC, apiLog = [], tLog = [];
      const ctx = vm.createContext({
        document: { getElementById: (id) => id === 'ntpl_sel' ? { value: selVal } : id === 'ntpl_sh' ? { checked: sharedC } : id === 'nitems' ? box : null, querySelectorAll: (s) => s === '#nitems .nrow' ? rows : [] },
        prompt: () => promptAns, api: (p, o) => { apiLog.push([p, (o && o.method) || 'GET', o && o.body]); return Promise.resolve({ ok: true, id: 'rt_x', list: [] }); },
        T: (m) => tLog.push(m), _esc: (s) => String(s), window: { _nrowTpl: () => '<div></div>' }, nTplPreload: () => {}, nrowHint: () => {},
        Number, String, JSON, Object, Array, Promise, RegExp, Math, console,
      });
      vm.runInContext(fns[0] + ';' + fns[1] + ';' + fns[2] + ';globalThis.__save=nTplSave;globalThis.__load=nTplLoad;', ctx);
      rows = [mkRow('88a145001', '面板', '3'), mkRow('', '', '5'), mkRow('88a145002', '支架', '0'), mkRow('88a145003', '支架2', '2')];
      sharedC = true;
      await vm.runInContext('__save()', ctx);
      const bodySent = apiLog[0] && apiLog[0][2];
      chk('B1 空零件号/qty=0 行剔除、大写归一（3有效行）', bodySent && [bodySent.items.length, bodySent.items[0].partNo, bodySent.items[0].qty, bodySent.items[1].partNo], [2, '88A145001', 3, '88A145003']);
      chk('B2 共享位透传与接口路径', apiLog[0] && [apiLog[0][0], apiLog[0][1], bodySent.shared, bodySent.name], ['/api/req-templates', 'POST', true, '夜班线模板']);
      tLog = []; apiLog = [];
      rows = [mkRow('', '', ''), mkRow('x', 'y', '0')];
      await vm.runInContext('__save()', ctx);
      chk('B3 无有效行拒绝提交（不发请求）', [apiLog.length, tLog.length > 0 && /没有有效行/.test(tLog[0])], [0, true]);
      // ===== C组 nTplLoad 填充逻辑（vm 沙箱） =====
      tLog = []; apiLog = [];
      ctx.window._nTpls = [{ id: 'rt_9', name: '日常料', items: [{ partNo: 'P1', itemName: '件一', qty: 4 }, { partNo: 'P2', itemName: '件二', qty: 1 }], shared: true }];
      selVal = 'rt_9'; box = mkBox();
      await vm.runInContext('__load()', ctx);
      chk('C1 按模板行数重建并回填三值', [box._rows.length, box._rows[0].querySelector('.npn').value, box._rows[0].querySelector('.nqty').value, box._rows[1].querySelector('.nnm').value], [2, 'P1', 4, '件二']);
      chk('C2 载入上报 use 计数', apiLog.some((a) => a[0] === '/api/req-templates/rt_9/use' && a[1] === 'POST'), true);
      selVal = 'nope'; box = mkBox();
      await vm.runInContext('__load()', ctx);
      chk('C3 未选中模板提示不重建', [apiLog.length, box._rows.length], [1, 0]);
    }
    // ===== D组 弹窗接线锚点 =====
    chkT('D1 工具条四件在位（下拉/载入/存为/共享）', html.includes('id="ntpl_sel"') && html.includes('onclick="nTplLoad()"') && html.includes('onclick="nTplSave()"') && html.includes('id="ntpl_sh"'), '');
    chkT('D2 弹窗打开即预取模板列表', /nTplPreload\(\); \/\/ ㉖v145 预取产线模板列表/.test(html), '');
    chkT('D3 载入行后触发换算提示 nrowHint', html.includes('nrowHint(r.querySelector') || /try\{nrowHint\(r\.querySelector\('\.nqty'\)\)\}catch/.test(html), '');
    const uncaught = log.join('').split('\n').filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
    chkT('Z 服务日志无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 200));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  srv.kill('SIGKILL');
  fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v145 网页产线模板实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
