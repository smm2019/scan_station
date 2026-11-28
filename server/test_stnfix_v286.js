// ㉖v286 站台错挂/到站误判/零时刻假节点/发料即清台 四修取证（11-28 双案复刻）
// 案1 N26K250180：发料早于到站→旧版到站反查空→后续轮询把"后来的货架框"错挂站台（CK-09 假占用2小时）
//   新语义：到站写入即被发料清台判定清掉=台面即时释放（不再假占用）
// 案2 N26K280057：被错挂后 agvStage 无条件信站台→"已下发"强判"到站待清台"（PDA绿标 vs 队列两张嘴）
// 断言：①三级来源纯函数(队列项filter收全>issued>账本反查含诱饵) ②空证据写待核实 ③发料早于到站=到站即清
// ④stage收紧(未叉=3/叉起=4/到站+卸放=5) ⑤trace零时刻假节点丢弃 ⑥摘框清台(同台账保住→摘空才清)
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), http = require('http'), vm = require('vm');
const TDIR = path.join(__dirname, 'data_e2e_stnfix_v286');
const PORT = 8486, MPORT = 8487, BASE = 'http://127.0.0.1:' + PORT;
let fail = 0, total = 0;
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
// ---- 纯函数段（三级来源）vm 直测：不依赖轮询时序 ----
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const m = src.match(/function stnCodesFor\(d, dn, sp\) \{[\s\S]*?\n\}/);
if (!m) { console.log('FAIL! 未抽取到 stnCodesFor'); process.exit(1); }
const ctx = {}; vm.createContext(ctx); vm.runInContext(m[0], ctx);
const F = ctx.stnCodesFor;
const D0 = { agvQueue: [{ code: 'Q1', wmsTask: 'AGV-X-0001', fromLoc: 'NB02-Z-01-1F', type: 'outbound' }, { code: 'Q2', wmsTask: 'AGV-X-0001', fromLoc: 'NB02-Z-01-1F', type: 'outbound' }], requisitions: [{ items: [{ issued: [{ c: 'I1', l: 'NB02-Z-01-1F' }] }] }], ledger: [{ c: 'L1', l: 'NB02-Z-01-1F' }] };
chkT('★①级①队列项filter收全同任务多框', JSON.stringify(F(D0, 'X-0001', 'NB02-Z-01-1F')) === '["Q1","Q2"]', JSON.stringify(F(D0, 'X-0001', 'NB02-Z-01-1F')));
const D1 = { agvQueue: [{ code: 'QQ', wmsTask: 'AGV-X-0002', fromLoc: 'NB02-Y-01-1F', type: 'outbound' }], requisitions: [{ items: [{ issued: [{ c: 'I1', l: 'NB02-Z-01-1F' }] }] }], ledger: [{ c: 'L1', l: 'NB02-Z-01-1F' }, { c: 'L2', l: 'NB02-Z-01-1F' }] };
chkT('★①级②issued优先于账本反查(诱饵L1/L2不串)', JSON.stringify(F(D1, 'X-9999', 'NB02-Z-01-1F')) === '["I1"]', JSON.stringify(F(D1, 'X-9999', 'NB02-Z-01-1F')));
const D2 = { agvQueue: [], requisitions: [], ledger: [{ c: 'L1', l: 'NB02-Z-01-1F' }, { c: 'L2', l: 'NB02-Z-01-1F' }] };
chkT('★①级③账本反查兜底(全收在位框)', JSON.stringify(F(D2, 'X-9999', 'NB02-Z-01-1F')) === '["L1","L2"]', JSON.stringify(F(D2, 'X-9999', 'NB02-Z-01-1F')));
chkT('①级①入库腿不串出库匹配', JSON.stringify(F({ agvQueue: [{ code: 'IN', wmsTask: 'AGV-X-0003', fromLoc: 'NB02-Z-01-1F', type: 'inbound' }], requisitions: [], ledger: [] }, 'X-0003', 'NB02-Z-01-1F')) === '[]', '');
// ---- agvStage 纯函数直测（到站判据+案2根因场景）----
const m2 = src.match(/function agvStage\(q\) \{[\s\S]*?\n\}/); if (!m2) { console.log('FAIL! 未抽取到 agvStage'); process.exit(1); }
const ctx2 = {}; vm.createContext(ctx2); vm.runInContext(m2[0], ctx2); const AG = ctx2.agvStage;
ctx2.db = { rcsRun: [{ no: 'AGV-20261128-0060', putAt: 111, pickAt: 99 }], rcsStations: { 'NB02-CK-12': { state: '有货', codes: ['A03'] } } };
chkT('④stage:到站+卸放证据+站台佐证→5', AG({ state: '到站', code: 'A03', wmsTask: 'AGV-20261128-0060' }) === 5, String(AG({ state: '到站', code: 'A03', wmsTask: 'AGV-20261128-0060' })));
ctx2.db = { rcsRun: [{ no: 'AGV-20261128-0050', putAt: 0, pickAt: 99 }], rcsStations: { 'NB02-CK-09': { state: '有货', codes: ['A02'] } } };
chkT('★案2根因:已下发+站台错挂有货+未卸放→4在途非5(旧版此场景强判5)', AG({ state: '已下发', code: 'A02', wmsTask: 'AGV-20261128-0050' }) === 4, String(AG({ state: '已下发', code: 'A02', wmsTask: 'AGV-20261128-0050' })));
// ---- 端到端 ----
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = (db0.users || []).filter((u) => u.role === 'admin');
db0.users.push({ id: 'u_ad', username: 'u_ad', name: '管理员', role: 'admin', enabled: true, salt, passHash: hp('E2e#W6!d', salt) });
db0.users.push({ id: 'u_wh', username: 'u_wh', name: '仓管甲', role: 'warehouse', enabled: true, salt, passHash: hp('E2e#W6!w', salt) });
db0.params = Object.assign(db0.params || {}, { pollSec: 3, agvDispatchMode: 'dry' });
db0.rcsConfig = { host: '127.0.0.1:' + MPORT, account: 't', pwd: 'enc1:x' };
db0.rcsToken = 'TKV286'; db0.rcsTokenExp = Date.now() + 3600e3;
db0.agvQueue = [
  { code: 'A02', wmsTask: 'AGV-20261128-0050', state: '已下发', station: 'NB02-CK-11', fromLoc: 'NB02-A-15-3F', type: 'outbound', at: Date.now() - 300000, sentAt: Date.now() - 200000 },
  { code: 'A02', wmsTask: 'AGV-20261128-0055', state: '到站', station: 'NB02-CK-05', fromLoc: 'NB02-A-15-3F', type: 'outbound', at: Date.now() - 500000, sentAt: Date.now() - 450000 },
  { code: 'A03', wmsTask: 'AGV-20261128-0060', state: '到站', station: 'NB02-CK-12', fromLoc: 'NB02-B-01-1F', type: 'outbound', at: Date.now() - 900000, sentAt: Date.now() - 800000 },
  { code: 'A10', wmsTask: 'AGV-20261128-0095', state: '已下发', station: 'NB02-CK-06', fromLoc: 'NB02-F-01-1F', type: 'outbound', at: Date.now() - 50000, sentAt: Date.now() - 30000 },
  { code: 'A21', wmsTask: 'AGV-20261128-0090', state: '已下发', station: 'NB02-CK-10', fromLoc: 'NB02-E-01-1F', type: 'outbound', at: Date.now() - 700000, sentAt: Date.now() - 650000 },
  { code: 'A29', wmsTask: 'AGV-20261128-0090', state: '已下发', station: 'NB02-CK-10', fromLoc: 'NB02-E-01-1F', type: 'outbound', at: Date.now() - 700000, sentAt: Date.now() - 650000 },
];
db0.requisitions = [{ id: 'q1', no: 'LLV286T1', by: 'u_x', byName: '测试', status: 'ready', items: [{ partNo: 'P286', qty: 180, issued: [{ c: 'A01', q: 180, l: 'NB02-B-01-1F' }], transferred: false }], createdAt: new Date().toISOString() }];
db0.ledger = [
  { c: 'A02', l: 'NB02-A-15-3F', q: 60, f: '托盘', t: Date.now() - 3600e3 }, // A位真框未发料（0055到站写入应保住）
  { c: 'A05', l: 'NB02-A-15-3F', q: 60, f: '托盘', t: Date.now() - 3600e3 }, // A位诱饵（级③反查会带出它，级①不会）
  { c: 'A06', l: 'NB02-C-01-1F', q: 60, f: '托盘', t: Date.now() - 3600e3 }, // C位诱饵+真框同在（反查全收语义）
  { c: 'A04', l: 'NB02-C-01-1F', q: 50, f: '托盘', t: Date.now() - 3600e3 },
  { c: 'A11', l: 'NB02-F-01-1F', q: 60, f: '托盘', t: Date.now() - 3600e3 }, // F位诱饵（0095应取A10）
  { c: 'A29', l: 'NB02-E-01-1F', q: 80, f: '托盘', t: Date.now() - 3600e3 }, // E位未发料框：摘框清台的'保住同台账'前提
];
db0.rcsStations = {}; db0.rcsDone = {}; db0.rcsCleared = {}; db0.rcsManual = {}; db0.seenOut = {}; db0.agvTasks = {}; db0.agvArch = []; db0.scanlog = {};
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const T28 = (ago) => { const d = new Date(Date.now() - ago); const p = (n) => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
const SUSP = (sp, ep) => JSON.stringify({ startPoint: sp, endPoint: ep });
const N0 = (op, ago) => ({ state: 2, operType: op, finishTime: T28(ago) });
const TASKS = [
  { dispatchNo: 'AGV-20261128-0011', taskState: 2, exeAgvId: 5, suspensionMsg: SUSP('NB02-B-01-1F', 'NB02-CK-09'), finishTime: T28(540000), buildTime: T28(660000), exeTime: T28(600000), taskDetailList: [N0(0, 600000), N0(1, 540000)], palletType: '1800*1200_2' }, // 案1：发料早于到站→到站即清
  { dispatchNo: 'AGV-20261128-0050', taskState: 1, exeAgvId: 6, suspensionMsg: SUSP('NB02-A-15-3F', 'NB02-CK-11'), buildTime: T28(200000), taskDetailList: [], palletType: '1800*1200_2' }, // 接令未叉：stage3+零时刻用例
  { dispatchNo: 'AGV-20261128-0060', taskState: 2, exeAgvId: 7, suspensionMsg: SUSP('NB02-B-01-1F', 'NB02-CK-12'), finishTime: T28(60000), buildTime: T28(180000), exeTime: T28(120000), taskDetailList: [N0(0, 120000), N0(1, 60000)], palletType: '1800*1200_2' }, // 到站+卸放→stage5
  { dispatchNo: 'AGV-20261128-0070', taskState: 2, exeAgvId: 8, suspensionMsg: SUSP('NB02-C-01-1F', 'NB02-CK-07'), finishTime: T28(30000), buildTime: T28(90000), exeTime: T28(60000), taskDetailList: [N0(0, 60000), N0(1, 30000)], palletType: '托盘' }, // 级③反查
  { dispatchNo: 'AGV-20261128-0080', taskState: 2, exeAgvId: 8, suspensionMsg: SUSP('NB02-D-01-1F', 'NB02-CK-08'), finishTime: T28(30000), buildTime: '', exeTime: '', taskDetailList: [], palletType: '托盘' }, // 全空→待核实
  { dispatchNo: 'AGV-20261128-0095', taskState: 1, exeAgvId: 9, suspensionMsg: SUSP('NB02-F-01-1F', 'NB02-CK-06'), buildTime: T28(40000), exeTime: T28(35000), taskDetailList: [N0(0, 30000)], palletType: '托盘' }, // 叉起在途→stage4
  { dispatchNo: 'AGV-20261128-0055', taskState: 2, exeAgvId: 3, suspensionMsg: SUSP('NB02-A-15-3F', 'NB02-CK-05'), finishTime: T28(400000), buildTime: T28(500000), exeTime: T28(450000), taskDetailList: [N0(0, 450000), N0(1, 400000)], palletType: '托盘' }, // 级①e2e：完成态+队列项A02+A位诱饵A05
  { dispatchNo: 'AGV-20261128-0090', taskState: 2, exeAgvId: 4, suspensionMsg: SUSP('NB02-E-01-1F', 'NB02-CK-10'), finishTime: T28(500000), buildTime: T28(700000), exeTime: T28(650000), taskDetailList: [N0(0, 650000), N0(1, 500000)], palletType: '1800*1200_2' }, // 同台账两框
];
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/login') return send({ code: 0, data: { token: 'TKV286' } });
  const RUN = TASKS.filter((t) => t.taskState !== 2), DONE = TASKS.filter((t) => t.taskState === 2); // 真机形态：run=在途 done=已完成
  if (u.pathname === '/task/getTaskInfo') return send({ code: 0, data: JSON.stringify(RUN) });
  if (u.pathname === '/task/getDoneTaskList') return send({ code: 0, data: JSON.stringify(DONE) });
  if (u.pathname === '/agv/debug/getLockResourceListForStatus') return send({ code: 0, data: { zoneLocks: { zoneList: [] }, landmarkLocks: { landmarkOwners: {} } } });
  send({ code: 0, data: [] });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await new Promise((r) => mock.listen(MPORT, '127.0.0.1', r));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'ignore', 'ignore'] });
  let up = false; for (let i = 0; i < 60 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); mock.close(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  // 自愈窗：无鉴权探针等 503 消失（登录端点也在窗内！上上轮 undefined-token 全 401 教训）
  let gate = 503; for (let i = 0; i < 40 && gate === 503; i++) { gate = (await fetch(BASE + '/api/rcs/stations')).status; if (gate === 503) await sleep(1000); }
  chkT('自愈窗释放', gate !== 503, 'HTTP' + gate);
  const tok = async (u) => (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'E2e#W6!' + u.slice(-1) }) })).json()).token;
  const tkA = await tok('u_ad'), tkW = await tok('u_wh');
  const api = (p, o = {}) => fetch(BASE + p, { headers: { Authorization: 'Bearer ' + (o.t || tkA), 'Content-Type': 'application/json' }, method: o.method || 'GET', body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  await sleep(4000); // ≥1轮轮询
  try {
    const stn = await api('/api/rcs/stations');
    const S = {}; for (const s of stn.stations || []) S[s.station] = s;
    chkT('★③发料早于到站=到站即清(案1根治:旧版假占用2h)', !S['NB02-CK-09'] || S['NB02-CK-09'].state !== '有货', JSON.stringify(S['NB02-CK-09'] || '无记录').slice(0, 120));
    chkT('★①级①生效:CK-05=[A02]非[A02,A05](级①压过反查,诱饵未串)', JSON.stringify((S['NB02-CK-05'] || {}).codes) === '["A02"]', JSON.stringify((S['NB02-CK-05'] || {}).codes));
    chkT('①在途占用态本就不带codes(语义正确非缺陷)', (S['NB02-CK-11'] || {}).state === '占用中' && !((S['NB02-CK-11'] || {}).codes || []).length, JSON.stringify(S['NB02-CK-11'] || {}).slice(0,120));
    chkT('★①级③生效:CK-07含真框A04(反查全收)', ((S['NB02-CK-07'] || {}).codes || []).includes('A04') && (S['NB02-CK-07'] || {}).state === '有货', JSON.stringify((S['NB02-CK-07'] || {}).codes));
    chkT('★②空证据:CK-08=待核实(三级皆空)', (S['NB02-CK-08'] || {}).state === '待核实' && !((S['NB02-CK-08'] || {}).codes || []).length, JSON.stringify(S['NB02-CK-08'] || {}).slice(0, 120));
    chkT('②待核实非空闲(占派车窗)', (S['NB02-CK-08'] || {}).state !== '空闲', (S['NB02-CK-08'] || {}).state);
    chkT('★⑥同台账两框都入:CK-10=[A21,A29]', JSON.stringify((S['NB02-CK-10'] || {}).codes || []) === '["A21","A29"]', JSON.stringify((S['NB02-CK-10'] || {}).codes));
    const g = (code) => (stn.queue || []).find((q) => q.code === code); // stations 接口 queue 出口带 stage
    chkT('★④stage收紧:已下发未叉(A02)→3(旧版被错挂强判5)', g('A02') && g('A02').stage === 3, JSON.stringify(g('A02') || {}).slice(0, 130));
    chkT('④stage:叉起在途(A10)→4', g('A10') && g('A10').stage === 4, JSON.stringify((g('A10') || {}).stage));

    const tr1 = await api('/api/trace?q=A02');
    const t1 = (tr1.events || []).map((e) => e.title || '');
    chkT('★⑤零时刻假节点丢弃(A02无开始执行/叉取/放置)', !t1.some((t) => /AGV开始执行|叉取货物|放置到位/.test(t)) && t1.some((t) => /AGV建任务/.test(t)), JSON.stringify(t1.slice(0, 8)));
    await api('/api/outbound/sync', { method: 'POST', t: tkW, body: { orderNo: 'DT286A', createdAt: Date.now(), items: [{ barcode: 'A21', qty: 180, partNo: 'P286' }] } });
    await sleep(1200);
    const s2 = await api('/api/rcs/stations'); const S2 = {}; for (const s of s2.stations || []) S2[s.station] = s;
    chkT('★⑥摘框:发A01后CK-10仍有货且只剩[A29]', (S2['NB02-CK-10'] || {}).state === '有货' && JSON.stringify((S2['NB02-CK-10'] || {}).codes) === '["A29"]', JSON.stringify(S2['NB02-CK-10'] || {}).slice(0, 130));
    await api('/api/outbound/sync', { method: 'POST', t: tkW, body: { orderNo: 'DT286B', createdAt: Date.now(), items: [{ barcode: 'A29', qty: 100, partNo: 'P286' }] } });
    await sleep(1200);
    const s3 = await api('/api/rcs/stations'); const S3 = {}; for (const s of s3.stations || []) S3[s.station] = s;
    chkT('⑥摘空才清台:发A29后CK-10释放', !S3['NB02-CK-10'] || S3['NB02-CK-10'].state !== '有货', JSON.stringify(S3['NB02-CK-10'] || '已清'));
    console.log(`\n===== v286 站台四修取证：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack || e); process.exitCode = 1; } finally { srv.kill(); mock.close(); await sleep(300); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
