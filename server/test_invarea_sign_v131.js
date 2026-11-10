// ㉖v131 盘点区域可见 + 网页签收 + 手机建单行重排 · 实例证明
// 用户三痛点：①网页盘点列表/D10 看不到盘了哪些区域（数据里 scope 一直有，只是没显示）②网页领料抽屉没有"确认收到货物"
// （线边角色 material 有 requisition+receive_confirm 权限，能建单却不能签收，只能回 PDA/等仓管）③手机网页建单行零件号被挤成"6608255268…"看不全
// 实现：①invAreas(r) 顶层共享函数（实扫货位∪scope 巷道前缀，NB03-H 粒度），list 接口+D10 总览共用；网页列表加"盘点区域"列（货架会话行从工单 from 聚合）
// ②抽屉尾部 status==ready 且 receive_confirm 权限显示签收按钮，POST /api/requisitions/:id/confirm（与 PDA 同接口）
// ③640px 媒体查询 .nrow 换行：零件号 flex:1 100% 独占整行（16px 字号看全 10 位），物料名 flex:2，框数 flex:1.1，提示独占行
// 证明面：
// A1 真实库批次 invAreas 口径 = locs∪scope 巷道并集且排序去重
// A2 list 接口返回 areas 字段（真实批次 INV1794105480219 期望 NB03-F NB03-G NB03-H）
// A3 D10 盘点总览含"盘点区域"列且行数对齐
// A4 无 scope 无 locs 的批次 areas 空串不报错
// B1 抽屉签收按钮渲染条件锚点（ready+receive_confirm）
// B2 confirm 接口权限：material 可签（真实库 features 判定），warehouse 不可（403）
// B3 非 ready 状态签收被拒（400 状态机）
// B4 签收成功 status→done + confirmedBy 留痕
// C1 手机行 CSS：.npn flex:1 100% 独占整行
// C2 .nrow flex-wrap 生效
// C3 提示独占行 .nhint flex:1 100%
// D1 网页列表表头含盘点区域列，colspan=8
// D2 货架会话行区域聚合自工单 from
// E1 服务日志无运行时异常
const fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const PORT = 8397, HOST = '127.0.0.1';
const TDIR = path.join(__dirname, 'data_e2e_invarea_v131');
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const crypto = require('crypto');
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
// 安全注入：副本库改 dry 模式+关时段闸+注入测试账号+预置一张 ready 单（不走建单→接单→备齐链，防误触派车/闸门）
const _now = Date.now();
db0.params = db0.params || {}; db0.params.agvDispatchMode = 'dry'; db0.params.reqHoursOn = 0;
db0.users = db0.users || [];
db0.users.push({ id: 'u_vw', username: 'v131_wh', name: 'V131仓管', role: 'warehouse', enabled: true, createdAt: _now, mustChangePw: false, salt, passHash: hashPw('V131#Wh!a', salt) });
db0.users.push({ id: 'u_vm', username: 'v131_mat', name: 'V131线边', role: 'material', enabled: true, createdAt: _now, mustChangePw: false, salt, passHash: hashPw('V131#Mt!b', salt) });
db0.requisitions = db0.requisitions || [];
db0.requisitions.push({ id: 'rq_v131', no: 'LLV131TEST0001', by: 'u_vm', byName: 'V131线边', status: 'ready', createdAt: new Date().toISOString(), items: [{ partNo: '6608453824', itemName: '证明件', qty: 100, issued: [{ c: 'N26V131001', q: 100 }] }], history: [] });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { cwd: __dirname, env: Object.assign({}, process.env, { PORT: String(PORT), HOST, DATA_DIR: TDIR }), stdio: ['ignore', 'pipe', 'pipe'] });
let LOG = ''; srv.stdout.on('data', (d) => { LOG += d }); srv.stderr.on('data', (d) => { LOG += d });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); ok ? pass++ : fail++; console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : `  期望=${JSON.stringify(exp)} 实得=${JSON.stringify(got)}`)); };
const chkT = (n, v, why) => { v ? pass++ : fail++; console.log((v ? '  ✅ ' : '  ❌ ') + n + (v ? '' : '  ←' + why)); };
let TK_WH = '', TK_MAT = '';
const api = (p, opt, tk) => { const o = Object.assign({}, opt || {}); if (o.body) o.body = JSON.stringify(o.body); return fetch('http://' + HOST + ':' + PORT + p, Object.assign({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk } }, o)).then((r) => r.json()); };

(async () => {
  await sleep(1800);
  const login = async (un, pw) => (await fetch('http://' + HOST + ':' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: un, password: pw, fp: 'e2e' }) })).json();
  const lw = await login('v131_wh', 'V131#Wh!a'), lm = await login('v131_mat', 'V131#Mt!b');
  TK_WH = lw.token || ''; TK_MAT = lm.token || '';
  chkT('L0 测试账号登录成功（仓管+线边）', !!TK_WH && !!TK_MAT, JSON.stringify(lw).slice(0, 120));
  const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
  const sj = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

  // ===== A 盘点区域口径 =====
  console.log('A1-A4 区域摘要口径（invAreas 与真实库）');
  const j1 = await api('/api/inventory/list?limit=100', null, TK_WH); // 盘点权限闸：warehouse 有 inventory 特性
  chkT('A0 列表接口调用成功', j1.ok === true, JSON.stringify(j1).slice(0, 140));
  const b1 = (j1.list || []).find((x) => x.batchId === 'INV1794105480219');
  chkT('A1 真实批次列表返回含 areas 字段', b1 && typeof b1.areas === 'string', JSON.stringify(b1 && Object.keys(b1)));
  chk('A2 该批次区域=巷道粒度13条（实扫货位并scope，排序去重；v133 对齐APP）', (b1.areas || '').split(' ').sort().join(' '), 'NB03-F-05 NB03-F-07 NB03-F-08 NB03-F-09 NB03-G-06 NB03-G-08 NB03-G-09 NB03-H-07 NB03-H-08 NB03-H-09 NB03-H-10 NB03-H-11 NB03-H-12');
  const d10 = await api('/api/export?ds=D10&fmt=json', null, TK_WH); // 导出是 GET；D10 需仓管/管理员（material 被 403）
  const ovSheet = ((d10.sheets || []).find((s) => s.name === '盘点总览') || {});
  chk('A3 D10 盘点总览含"盘点区域"列', ovSheet.headers ? ovSheet.headers.includes('盘点区域') : false, true);
  chk('A4 D10 区域列值与 list.areas 同口径（首行比对）', (() => { if (!ovSheet.headers) return false; const i = ovSheet.headers.indexOf('盘点区域'); const row0 = (ovSheet.rows || [])[0]; const l0 = (j1.list || [])[0]; return row0 && l0 ? String(row0[i]) === String(l0.areas) : true; })(), true);
  // 空批次容错：构造无 locs 无 scope 的批次走 list（服务重启前直改副本库不可行，改调函数级验证）
  const mInv = sj.match(/function invAreas\(r\)[\s\S]*?return \[\.\.\.s\]\.sort\(\)\.join\(' '\); \}/);
  chkT('A5 invAreas 为顶层共享函数（list 与 D10 单一实现）', !!mInv, '未找到函数定义');
  if (mInv) { const fn = new Function('r', mInv[0].replace('function invAreas(r) ', 'return function(r){').replace(/\}$/, '}') + '};')(); } // 语法自检
  { // 空输入不抛错
    let err = null; try { const vm = require('vm'); const ctx = vm.createContext({}); vm.runInContext(mInv[0], ctx); ctx.invAreas({}); ctx.invAreas({ locs: [{ loc: 'NB02-A-01-1F' }], scope: '' }); ctx.invAreas({ locs: [], scope: 'NB03-H-12,NB03-H-10' }); } catch (e) { err = e.message }
    chk('A6 invAreas 空/混合输入不抛错', err, null);
    const vm2 = require('vm'); const ctx2 = vm2.createContext({}); vm2.runInContext(mInv[0], ctx2);
    chk('A7 纯格位货位归并巷道粒度（NB02-A-01-1F→NB02-A-01）', ctx2.invAreas({ locs: [{ loc: 'NB02-A-01-1F' }, { loc: 'NB02-A-05-2F' }], scope: '' }), 'NB02-A-01 NB02-A-05');
    chk('A8 scope 巷道串解析（NB03-H-12,NB03-H-10 排序去重）', ctx2.invAreas({ locs: [], scope: 'NB03-H-12,NB03-H-10' }), 'NB03-H-10 NB03-H-12');
  }

  // ===== B 网页签收（预置 ready 单 rq_v131，只测签收链） =====
  console.log('B1-B8 签收通道（与 PDA 同接口）');
  chk('B1 material 角色有签收权限（生产 features 实况）', (db0.features.material || {}).receive_confirm, true);
  chk('B2 warehouse 角色无签收权限（权限模型两侧一致）', ((db0.features.warehouse || {}).receive_confirm === false), true);
  const bad0 = await api('/api/requisitions/rq_v131/confirm', { method: 'POST', body: {} }, TK_WH);
  chk('B3 warehouse 签收被权限拒（未开通签收确认）', bad0.ok === false && /签收/.test(bad0.msg || ''), true);
  const bad1 = await api('/api/requisitions/rq_v131/accept', { method: 'POST', body: {} }, TK_MAT);
  chkT('B4 状态机前置有效（ready 单不可再接单，证明态校验在位）', bad1.ok === false, JSON.stringify(bad1).slice(0, 120));
  const okc = await api('/api/requisitions/rq_v131/confirm', { method: 'POST', body: {} }, TK_MAT);
  chkT('B5 material 签收成功（与 PDA 同接口同权限判定）', okc.ok === true, JSON.stringify(okc).slice(0, 140));
  await sleep(700); // save() 120ms 防抖 + 异步落盘
  const dbEnd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const rr = (dbEnd.requisitions || []).find((x) => x.id === 'rq_v131');
  chk('B6 签收后 status=done 且 confirmedBy/confirmedAt 落库', rr && rr.status === 'done' && !!rr.confirmedBy && !!rr.confirmedAt, true);
  chk('B7 签收留痕进工单历史（hpush）', !!(rr.history || []).find((h) => /签收确认/.test(h.text || '')), true);
  const twice = await api('/api/requisitions/rq_v131/confirm', { method: 'POST', body: {} }, TK_MAT);
  chk('B8 重复签收被状态机拒（不可签收）', twice.ok === false && /不可签收/.test(twice.msg || ''), true);

  // ===== C/D 前端锚点 =====
  console.log('C1-C3 手机建单行重排 / D1-D2 网页区域列锚点');
  chk('C1 零件号独占整行（flex:1 100%）', html.includes('.nrow .npn{flex:1 100%!important;min-width:0!important}'), true);
  chk('C2 行容器允许换行', html.includes('.nrow{gap:5px!important;flex-wrap:wrap}'), true);
  chk('C3 换算提示独占行', html.includes('.nrow .nhint{flex:1 100%!important}'), true);
  chk('D1 盘点列表表头含盘点区域列', html.includes('<th>盘点区域</th>'), true);
  chk('D2 空表占位 colspan 同步为 8', html.includes('colspan=8 style="color:var(--sub)">暂无盘点任务'), true);
  chk('D3 货架会话行区域聚合自工单 from（巷道粒度）', /racks:new Set\(\)[\s\S]{0,240}match\(\/\^NB0\\d-\[A-H\]-\\d\{2\}\//.test(html), true);
  chk('D4 抽屉签收按钮渲染条件（ready+receive_confirm）', html.includes("r.status=='ready'&&(U.features||{}).receive_confirm"), true);
  chk('D5 签收走 PDA 同款接口 /confirm', html.includes("'/api/requisitions/'+id+'/confirm'"), true);

  // ===== E 日志 =====
  console.log('E1 服务日志');
  const errLines = LOG.split('\n').filter((l) => /Error|异常|undefined is not|TypeError|ReferenceError/.test(l) && !/sysErr|自身异常/.test(l));
  chk('E1 无运行时异常', errLines.slice(0, 2).join(' | '), '');

  console.log(`\n===== v131 盘点区域+网页签收+手机建单 实例证明 ${pass}/${pass + fail} PASS =====`);
  srv.kill('SIGKILL');
  fs.rmSync(TDIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
