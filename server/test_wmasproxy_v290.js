// ㉖v290 WMAS只读代理+网页建单行货位/上次领料 取证
// 掉线根因（11-28 17:30-17:44 告警风暴实锤）：WMAS同账号后登录踢前者；服务器+每台PDA各自登录
// =N+1会话互挤。根治=PDA只读查询收口 /api/wmas/proxy（服务器单会话）。
// 断言：①代理白名单只读路径通 ②写路径/任意路径403 ③未配置WMAS如实报错不崩
// ④dict.locs 货位排分布正确（去末段层/格号、按框数降序、NB04计入） ⑤req/last 网页可用（发料日口径）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), http = require('http');
const TDIR = path.join(__dirname, 'data_e2e_wmasproxy_v290');
const PORT = 8493, MPORT = 8494, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_mt', username: 'u_mt', name: '物料员', role: 'material', enabled: true, salt, passHash: hp('E2e#P0!t', salt) });
db0.users.push({ id: 'u_ad', username: 'u_ad', name: '管理员', role: 'admin', enabled: true, salt, passHash: hp('E2e#P0!d', salt) });
db0.features = db0.features || {}; for (const r of ['material', 'warehouse', 'admin']) db0.features[r] = Object.assign(db0.features[r] || {}, { requisition: true, agv_control: true });
// mock WMAS：登录发token；容器列表回1条；记录登录次数（互挤根因取证）
let loginN = 0, validTk = '';
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/auth/login') { loginN++; validTk = 'TK' + loginN; return send({ code: 200, success: true, data: { token: validTk } }); }
  if (req.headers.authorization !== 'Bearer ' + validTk) return send({ code: 401, msg: '有其他用户登录该账号，请及时修改密码', errCode: 'B-00004' });
  if (u.pathname === '/api/logistics/container/list') return send({ success: true, data: { records: [{ containerCode: 'NB-B1800-00001' }] } });
  if (u.pathname === '/api/basicdata/wmsLocation/listAll') return send({ success: true, data: [{ locationCode: 'NB02-A-15-3F', warehouseCode: 'W1', zoneCode: 'A' }] });
  if (u.pathname === '/api/logistics/agv-task/list') return send({ success: true, data: { records: [] } });
  send({ success: false, msg: 'no route' });
});
db0.wmasConfig = { host: '127.0.0.1:' + MPORT, account: 't', pwd: 'plainpwd' }; // 明文（启动walkSec自动转密）：假enc1密文会被decSec解成空串→登录必败（夹具自误实锤）
// 账本：同零件三框两排+一楼一框（locs聚合用例）；同托双码=1框
db0.ledger = [
  { c: 'V290A1', l: 'NB02-A-15-3F', p: 'P290', q: 100, f: 'T1', t: Date.now() - 3600e3 },
  { c: 'V290A2', l: 'NB02-A-15-2F', p: 'P290', q: 100, f: 'T1', t: Date.now() - 3600e3 },
  { c: 'V290B1', l: 'NB03-D-11-01', p: 'P290', q: 60, f: 'T2', t: Date.now() - 3600e3 },
  { c: 'V290C1', l: 'NB04-A-01-013', p: 'P290', q: 60, f: 'T3', t: Date.now() - 3600e3 },
];
db0.itemDict = Object.assign(db0.itemDict || {}, { P290: { nm: '测试件290', src: 'test' } });
// 已发料历史单（req/last用例：发料日=readyAt优先）
db0.requisitions = [{ id: 'q290', no: 'LLV290', by: 'u_mt', byName: '物料员', status: 'done', createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), readyAt: Date.now() - 2 * 864e5, confirmedAt: new Date(Date.now() - 864e5).toISOString(), items: [{ partNo: 'P290', qty: 200, issued: [{ c: 'OLD1', q: 200 }] }] }];
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  await new Promise((r) => mock.listen(MPORT, '127.0.0.1', r));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); mock.close(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  for (let i = 0; i < 60; i++) { const rr = await fetch(BASE + '/api/requisitions/gate').catch(() => null); if (rr && rr.status !== 503) break; await sleep(1000); } // 自愈窗
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#P0!' + u.slice(-1) }) })).json()).token;
  const tkM = await tok('u_mt');
  const api = (p, o = {}) => fetch(BASE + p, { headers: { Authorization: 'Bearer ' + (o.t || tkM), 'Content-Type': 'application/json' }, method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined }).then(async (r) => ({ st: r.status, j: await r.json() }));
  try {
    // ① 白名单只读代理通（物料员可用——主档查询是建单/叫车前置，非管理操作）
    const p1 = await api('/api/wmas/proxy', { method: 'POST', body: { path: '/api/logistics/container/list?pageNum=1&pageSize=1000' } });
    chkT('★①代理容器主档通', p1.j.ok === true && ((p1.j.data || {}).records || []).length === 1, JSON.stringify(p1.j).slice(0, 120));
    const p2 = await api('/api/wmas/proxy', { method: 'POST', body: { path: '/api/basicdata/wmsLocation/listAll' } });
    chkT('①代理库位主档通', p2.j.ok === true, JSON.stringify(p2.j).slice(0, 100));
    const p3 = await api('/api/wmas/proxy', { method: 'POST', body: { path: '/api/logistics/agv-task/list?pageNum=1&pageSize=100&status=PUSHED' } });
    chkT('①代理任务列表通', p3.j.ok === true, JSON.stringify(p3.j).slice(0, 100));
    // ② 写路径/任意路径拒
    const p4 = await api('/api/wmas/proxy', { method: 'POST', body: { path: '/api/logistics/agv-task' } });
    chkT('★②写路径403', p4.st === 403, p4.st + ' ' + JSON.stringify(p4.j).slice(0, 80));
    const p5 = await api('/api/wmas/proxy', { method: 'POST', body: { path: '/api/auth/login' } });
    chkT('②登录路径403(防绕过单会话)', p5.st === 403, String(p5.st));
    const p6 = await api('/api/wmas/proxy', { method: 'POST', body: { path: '/etc/passwd' } });
    chkT('②任意路径403', p6.st === 403, String(p6.st));
    // ③ 单会话证据：三次代理只登录一次（token复用）
    chkT('★③三次代理仅1次登录(单会话复用)', loginN === 1, 'loginN=' + loginN);
    // ④ dict.locs
    const d1 = await api('/api/dict?q=P290');
    const it = (d1.j.list || []).find((x) => x.pn === 'P290') || {};
    const locs = it.locs || [];
    const mA = locs.find((x) => x.l === 'NB02-A-15'), mD = locs.find((x) => x.l === 'NB03-D-11'), mR = locs.find((x) => x.l === 'NB04-A-01');
    chkT('★④locs排分布(去层/格号,框数正确)', mA && mA.n === 2 && mD && mD.n === 1 && mR && mR.n === 1, JSON.stringify(locs));
    chkT('④recvBoxes一楼框标注仍在', it.recvBoxes === 1 && it.boxes === 4, JSON.stringify({ boxes: it.boxes, recv: it.recvBoxes }));
    // ⑤ req/last 发料日口径
    const l1 = await api('/api/req/last?items=P290');
    const last = (l1.j.map || {}).P290 || {};
    const wantT = db0.requisitions[0].readyAt;
    chkT('★⑤上次领料=发料日(readyAt)非签收日', last.t === wantT && last.qty === 200 && last.by === '物料员', JSON.stringify(last));
    console.log(`\n===== v290 WMAS代理收口+建单行信息取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); mock.close(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
