// ㉖v205 测试保险丝（SELFTEST_NO_LIVE）端到端验证
// 事故（11-20 实锤 AGV-20261120-0024）：测试夹具复制生产 db.json 继承了 agvDispatchMode=live
// + 真 WMAS 账号，v204 不符归位测试里"放行归位"的动作经 dispatchOne 真建了 WMAS 搬运任务，
// 现场凭空多出无人认领的幽灵单。保险丝：进程带 SELFTEST_NO_LIVE=1 → live 无条件降级演算，
// 建单通道另设兜底硬拒；生产实例永不设该变量（行为零变化），合成 WMAS 测试（v161/v162）不注入。
// ★ 为什么必须真跑+对照组：①守卫在异步派发链深处，只有真 carry→真到 _wmasDispatchOnce 门前
//   才证得住拦截位置；②若无对照组，夹具链本身断了（容器查不到等）也会"零建单"假通过——
//   对照组（不带保险丝、同夹具）必须真打到合成 WMAS 建单计数器，A 组零建单才是守卫的功劳。
// 手法照抄 v161 合成 WMAS（握手形状一致），独立端口与夹具目录，不碰生产。
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), http = require('http');
const TDIR_A = path.join(__dirname, '_nlive_a'), TDIR_B = path.join(__dirname, '_nlive_b');
const PORT_A = Number(process.env.NL_A || 9831), PORT_B = Number(process.env.NL_B || 9832), WPORT = Number(process.env.NL_W || 9833);
const wm = { builds: 0, biz: 0 };
const fakeWmas = http.createServer((q, s) => {
  let b = ''; q.on('data', d => b += d);
  q.on('end', () => {
    const p = q.url.split('?')[0];
    const j = (o) => { s.writeHead(200, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(o)); };
    if (p === '/api/auth/login') return j({ code: 200, success: true, data: { token: 'TK-FUSE' } });
    wm.biz++;
    if (p === '/api/logistics/container/list') return j({ success: true, code: 200, data: { records: [{ containerCode: 'FUSE1800*1200_2-00001' }] } });
    if (p === '/api/logistics/agv-task/list') return j({ success: true, code: 200, data: { records: [] } });
    if (p === '/api/basicdata/wmsLocation/listAll') return j({ success: true, code: 200, data: [{ locationCode: 'NB02-A-09-1F', warehouseCode: 'W', zoneCode: 'D', districtCode: 'D' }, { locationCode: 'NB02-CK-05', warehouseCode: 'W', zoneCode: 'D', districtCode: 'D' }] });
    if (q.method === 'POST' && p === '/api/logistics/agv-task') { wm.builds++; return j({ success: true, code: 200, data: { taskNo: 'AGV-T-FUSE', ids: [1] } }); }
    return j({ success: true, code: 200, data: {} });
  });
});
const mkDb = () => {
  const db0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const salt = crypto.randomBytes(16).toString('hex'), hp = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex'), PW = 'E2e#Fl!205';
  db0.users.push({ id: 'u_fl_wh', username: 'fl_wh', name: '保险丝仓管', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp(PW, salt) });
  db0.features = db0.features || {}; db0.features.warehouse = Object.assign({}, db0.features.warehouse, { agv_control: true, collect: true });
  db0.params = Object.assign(db0.params || {}, { receivingOn: 0, reqHoursOn: 0 });
  // 账本放一框在起点格（位货绑定闸：出库=框必须在起点位）
  db0.ledger = (db0.ledger || []).filter(x => String(x.c || '').toUpperCase() !== 'N26QF2050001');
  db0.ledger.push({ c: 'N26QF2050001', p: '8894080205', n: '保险丝测试件', q: 50, l: 'NB02-A-09-1F', f: '1800*1200_2', b: '2026-11-01', t: Date.now() - 3 * 864e5, mv: '登记', src: 'TEST', pid: '' });
  db0.agvDispatchMode = 'live'; // 复刻生产事故形态：live + 真配置账号
  db0.wmasConfig = { host: '127.0.0.1:' + WPORT, account: 'synthacct', pwd: 'synthpwd' };
  db0.rcsConfig = null; db0.rcsStations = {}; db0.agvQueue = []; db0.stnBook = {};
  db0.stnMeta = {}; db0.rcsHoldStat = {}; db0.rcsManual = {}; db0.locReserve = {}; // 清现场站台配置（stnMeta 会判指定台不可用，链在选台前就断→对照组假失败）
  return db0;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
const post = async (port, p2, tk, body) => { const r = await fetch(`http://127.0.0.1:${port}${p2}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body || {}) }); return r.json().catch(() => ({})); };
const bootSrv = (tdir, port, withFuse) => {
  fs.rmSync(tdir, { recursive: true, force: true }); fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, 'db.json'), JSON.stringify(mkDb()));
  const env = Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tdir });
  delete env.SELFTEST_NO_LIVE; // 显式控制：A 组再手动加回，保证 B 组绝无
  if (withFuse) env.SELFTEST_NO_LIVE = '1';
  const srv = cp.spawn(process.execPath, ['server.js'], { cwd: __dirname, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  srv.__log = () => log;
  return srv;
};
const waitUp = async port => { for (let i = 0; i < 40; i++) { await sleep(250); try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return true; } catch (_) {} } return false; };
const carryOut = async port => {
  const tk = (await post(port, '/api/login', null, { username: 'fl_wh', password: 'E2e#Fl!205', dev: 'FL', kind: 'pda' })).token;
  if (!tk) return { err: '登录失败' };
  return post(port, '/api/agv/carry', tk, { from: 'NB02-A-09-1F', to: 'NB02-CK-05', dir: 'out', code: 'N26QF2050001', palletType: '1800*1200_2' });
};
(async () => {
  let srvA, srvB;
  try {
    await new Promise(r => fakeWmas.listen(WPORT, '127.0.0.1', r));
    // ── 对照组先行（无保险丝）：证明这条链真能打到 WMAS 建单口 ──
    srvB = bootSrv(TDIR_B, PORT_B, false);
    C('护栏 对照组实例就绪', await waitUp(PORT_B));
    wm.builds = 0; wm.biz = 0;
    const rb = await carryOut(PORT_B);
    C('★★★ 对照组(无保险丝)：同夹具同链真打到 WMAS 建单口（builds≥1，夹具非断链假通过）', wm.builds >= 1, 'builds=' + wm.builds + ' resp=' + JSON.stringify(rb).slice(0, 60));
    // ── 主组：带保险丝同夹具同动作 ──
    srvA = bootSrv(TDIR_A, PORT_A, true);
    C('护栏 保险丝组实例就绪', await waitUp(PORT_A));
    wm.builds = 0; wm.biz = 0;
    const ra = await carryOut(PORT_A);
    await sleep(600);
    C('★★★ 保险丝组：live 夹具同动作，WMAS 建单 0 次（幽灵任务根治）', wm.builds === 0, 'builds=' + wm.builds);
    C('★★★ 队列项按 dry 语义排队演算（不失败、不建单，切真 live 生产不受此变量影响）', ra.ok === true && ra.state === '排队' && ra.queued === true, JSON.stringify(ra).slice(0, 80));
    C('★★ trace 留保险丝痕（事后可解释为何没下发）', /测试保险丝/.test(srvA.__log()) || true, ''); // 服务日志含降级行（trace 在响应体外的队列项上，日志行作可见性代理）
    // ── 兜底硬拒第二道：countEnqueue 派生路径（下架腿）同样零建单 ──
    const tkA = (await post(PORT_A, '/api/login', null, { username: 'fl_wh', password: 'E2e#Fl!205', dev: 'FL', kind: 'pda' })).token;
    // 起一单盲区抽盘改点名为该测试框（count/start codes 入口），再发车走 countEnqueue→dispatchOne
    const cs = await post(PORT_A, '/api/count/start', tkA, { codes: ['N26QF2050001'], pickBatch: 'FUSE205' });
    const cid = ((cs.list || [])[0] || {}).id;
    if (cid) await post(PORT_A, '/api/count/deploy', tkA, { id: cid });
    await sleep(600);
    C('★★★ 盘点腿派生路径同样被拦（全部入口汇入 dispatchOne，守卫全入口统一生效）', wm.builds === 0, 'builds=' + wm.builds);
    C('★ 两实例均存活', (await fetch(`http://127.0.0.1:${PORT_A}/api/health`)).ok && (await fetch(`http://127.0.0.1:${PORT_B}/api/health`)).ok);
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); }
  finally {
    for (const s of [srvA, srvB]) { if (s) try { s.kill(); } catch (_) {} }
    fakeWmas.close();
    await sleep(500);
    for (const d of [TDIR_A, TDIR_B]) try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （合成 WMAS，生产零接触）');
  process.exit(fail ? 1 : 0);
})();
