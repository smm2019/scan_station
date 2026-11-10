// ㉖v138 参数配置扩展 · 实例证明（4个"写死→可调"参数）
// 专业取舍：先拿真实生产数据验证每个候选参数的价值，砍掉伪需求（长尾过滤：告急件日均<1的0件），
//   只留有实锤的4个——建议清单上限(默认30时136告急被藏106)、建议排序(截断下决定可见集)、
//   选框封顶(有件建议23逼近写死24)、货位预占时长(并发落账慢撞格)。全部默认值=旧硬编码值=零行为变更。
// 手法：cap/sort 用隔离多实例(启动前写死params)做真行为断言；pickMaxBoxes/reserveTtlMs 抽源码进 vm 跑纯逻辑；
//   参数定义/分组/默认/活引用清零用源码锚点。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), vm = require('vm');
const SRC = path.join(__dirname, 'data'), PORT0 = 8404;
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now(), obAt = now - 7 * 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 150)} want=${String(JSON.stringify(w)).slice(0, 150)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };

// 纯净夹具：清空生产数据，造 5 种确定性场景（PNA断供/PNB低库存/PNC充足/PND在途抵扣/PNE部分在途）
function buildDb(extra) {
  const db = JSON.parse(fs.readFileSync(path.join(SRC, 'db.json'), 'utf8'));
  db.users.push({ id: 'u_v38', username: 'v138_mt', name: 'V138线边', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V38!mt', salt) });
  db.params = Object.assign(db.params || {}, { reqSuggestOn: 1, reqSuggestDays: 14, reqSuggestCover: 3 }, extra || {});
  db.outbound = {}; db.ledger = []; db.requisitions = []; db.seenOut = {};
  const oi = (code, qty, bc) => ({ code, qty, barcode: bc, name: '件' + code });
  db.outbound.OBA = { orderNo: 'OBA', createdAt: obAt, items: [oi('PNA', 700, 'BX1'), oi('PNA', 700, 'BX2')] }; // 日均100 无库存→days0 boxes1
  db.outbound.OBB = { orderNo: 'OBB', createdAt: obAt, items: [oi('PNB', 140, 'BX3')] }; // 日均10 账本1框×20→days2 boxes1
  db.outbound.OBC = { orderNo: 'OBC', createdAt: obAt, items: [oi('PNC', 140, 'BX4')] }; // 日均10 账本10框×100→days100 不告急
  db.outbound.OBD = { orderNo: 'OBD', createdAt: obAt, items: [oi('PND', 140, 'BX5')] }; // 日均10 在途40→days4 不告急
  db.outbound.OBE = { orderNo: 'OBE', createdAt: obAt, items: [oi('PNE', 140, 'BX6')] }; // 日均10 账本5+在途10→days1.5 boxes3
  const led = (c, l, p, q, pid) => ({ c, l, f: '', t: now, p, n: '件' + p, q, b: 'B138', pid, mv: '人工', src: '', by: 'x', rec: now, hist: [] });
  db.ledger.push(led('LB1', 'NB02-A-01-1F', 'PNB', 20, 'PB1'));
  for (let i = 1; i <= 10; i++) db.ledger.push(led('LC' + i, `NB02-A-${String(i + 1).padStart(2, "0")}-1F`, 'PNC', 100, 'PC' + i));
  db.ledger.push(led('LE1', 'NB02-A-20-1F', 'PNE', 5, 'PE1'));
  db.requisitions.push({ id: 'rqD', no: 'LLDUP0001', by: 'u_v38', byName: 'V138线边', status: 'pending', createdAt: new Date(now).toISOString(), items: [{ partNo: 'PND', itemName: '在途', qty: 40, issued: [] }] });
  db.requisitions.push({ id: 'rqE', no: 'LLE1000001', by: 'u_v38', byName: 'V138线边', status: 'accepted', createdAt: new Date(now).toISOString(), items: [{ partNo: 'PNE', itemName: '部分在途', qty: 10, issued: [] }] });
  return db;
}
async function runWith(extra, port) {
  const TDIR = path.join(__dirname, 'data_e2e_params_v138_' + port);
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(buildDb(extra)));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + port + '/api/health')).ok; } catch (_) {} }
  if (!up) { srv.kill('SIGKILL'); throw new Error('实例未就绪 ' + port); }
  const tk = (await (await fetch('http://127.0.0.1:' + port + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v138_mt', password: 'E2e#V38!mt' }) })).json()).token;
  const j = await (await fetch('http://127.0.0.1:' + port + '/api/requisitions/suggest', { headers: { Authorization: 'Bearer ' + tk } })).json();
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  return j;
}

(async () => {
  console.log('== A组 cap/sort 多实例行为（隔离进程，启动前写死 params） ==');
  // A1 默认(cap30 sort0)：告急3件全返回，days升序 PNA(0)<PNE(1.5)<PNB(2)
  const d = await runWith({}, PORT0);
  chk('A1 默认 cap=30 sort=0', [d.cap, d.sort, d.total], [30, 0, 3]);
  chk('A1b 默认顺序=最急先(PNA,PNE,PNB)', (d.list || []).map((x) => x.pn), ['PNA', 'PNE', 'PNB']);
  // A2 cap=2 截断
  const c2 = await runWith({ reqSuggestMax: 2 }, PORT0 + 1);
  chk('A2 cap=2 只返回2件但 total 仍3', [c2.list.length, c2.total, c2.cap], [2, 3, 2]);
  chk('A2b cap=2 取排序前2(PNA,PNE)', (c2.list || []).map((x) => x.pn), ['PNA', 'PNE']);
  // A3 cap=0 不限全给
  const c0 = await runWith({ reqSuggestMax: 0 }, PORT0 + 2);
  chk('A3 cap=0 不限·全3件返回', [c0.list.length, c0.cap], [3, 0]);
  // A4 sort=1 建议框数降序：PNE(3)>PNA(1)=PNB(1)，同框二级 days 升序 PNA<PNB
  const s1 = await runWith({ reqSuggestSort: 1 }, PORT0 + 3);
  chk('A4 sort=1 框数降序(PNE,PNA,PNB)', (s1.list || []).map((x) => x.pn), ['PNE', 'PNA', 'PNB']);
  // A5 sort=2 日均消耗降序：PNA(100)>PNB(10)=PNE(10)，同级 days 升序 PNE<PNB
  const s2 = await runWith({ reqSuggestSort: 2 }, PORT0 + 4);
  chk('A5 sort=2 日均降序(PNA,PNE,PNB)', (s2.list || []).map((x) => x.pn), ['PNA', 'PNE', 'PNB']);

  console.log('== B组 参数定义/分组/默认（源码锚点） ==');
  const sj = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  chkT('B1 reqSuggestMax 定义·默认30·领料闸门组', /reqSuggestMax:\s*\{ grp: '领料闸门'[^}]*d: 30/.test(sj), '');
  chkT('B2 reqSuggestSort 定义·默认0·领料闸门组', /reqSuggestSort:\s*\{ grp: '领料闸门'[^}]*d: 0/.test(sj), '');
  chkT('B3 pickMaxBoxes 定义·默认24·调度策略组', /pickMaxBoxes:\s*\{ grp: '调度策略'[^}]*d: 24/.test(sj), '');
  chkT('B4 reserveTtlMin 定义·默认10·存储配置组', /reserveTtlMin:\s*\{ grp: '存储配置'[^}]*d: 10/.test(sj), '');

  console.log('== C组 pickMaxBoxes 封顶纯逻辑（抽源码进 vm） ==');
  {
    const m = sj.match(/Math\.max\(4, Number\(P\(\)\.pickMaxBoxes\) \|\| 24\)/);
    chkT('C1 封顶表达式在位且读参数', !!m, '');
    if (m) {
      const fn = new Function('P', 'return (' + m[0] + ');');
      chk('C2 默认(参数缺省)→24', fn(() => ({})), 24);
      chk('C3 传40→40', fn(() => ({ pickMaxBoxes: 40 })), 40);
      chk('C4 传0→兜底24', fn(() => ({ pickMaxBoxes: 0 })), 24);
      chk('C5 传2→下限钳到4', fn(() => ({ pickMaxBoxes: 2 })), 4);
    }
  }

  console.log('== D组 reserveTtlMs 纯逻辑 + 活引用清零 ==');
  {
    const m = sj.match(/function resTtlMs\(\)[^{]*\{[^}]*\}/);
    chkT('D1 resTtlMs 函数定义在位', !!m && m[0].includes('reserveTtlMin'), '');
    if (m) {
      const ctx = vm.createContext({ Math, Number });
      vm.runInContext(m[0] + ';this.f=resTtlMs;', ctx);
      ctx.P = () => ({}); chk('D2 默认→600000ms(10分)', ctx.f(), 600000);
      ctx.P = () => ({ reserveTtlMin: 15 }); chk('D3 传15→900000ms', ctx.f(), 900000);
      ctx.P = () => ({ reserveTtlMin: 0 }); chk('D4 传0→兜底10分', ctx.f(), 600000);
      ctx.P = () => ({ reserveTtlMin: -5 }); chk('D5 负值→下限钳1分', ctx.f(), 60000);
    }
    // 活代码里 RES_TTL_MS 比较用法必须清零（只剩注释提及）
    const liveUse = sj.split(/\r?\n/).filter((l) => /RES_TTL_MS/.test(l) && !/^\s*\/\//.test(l) && !/RES_TTL_MS 常量/.test(l));
    chk('D6 活代码 RES_TTL_MS 引用=0（全改 resTtlMs()）', liveUse.length, 0);
    chkT('D7 pruneReserve 调 resTtlMs()', /function pruneReserve[\s\S]{0,200}resTtlMs\(\)/.test(sj), '');
    chkT('D8 账本释放处调 resTtlMs()', sj.includes('> resTtlMs()) delete db.locReserve[l]'), '');
  }

  console.log(`\n===== v138 参数配置扩展实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
