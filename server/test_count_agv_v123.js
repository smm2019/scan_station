// ㉖v123 货架AGV盘点（盲区随机抽盘）· 端到端实例证明（两阶段各自独立夹具，确定性）
// 阶段1：A 选框与工单生成 + B 冻结四处（发料硬拦/建议排除/carry拦/未冻结不误伤）
// 阶段2：C 状态机（toStation→atStation→scanned→归位入队、归位完成→done、串位mismatch、取消腿→回退pending）+ D 恒等式
// 阶段3：E 源码锚点 + F 运行日志无异常
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'tmp_e2e_count_v123'), PORT = 8411;
const BASE = 'http://127.0.0.1:' + PORT;
let total = 0, fail = 0;
const chk = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] ${ok ? '' : JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)}`); };
const chkT = (n, c) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]`); };
const DAY = 864e5;
const BLIND = [
  { code: 'CTB0000001', part: 'CTPART001', qty: 100, loc: 'NB02-A-01-1F', age: 20 },
  { code: 'CTB0000002', part: 'CTPART002', qty: 200, loc: 'NB02-A-02-1F', age: 25 },
  { code: 'CTB0000003', part: 'CTPART003', qty: 300, loc: 'NB02-A-03-1F', age: 30 },
  { code: 'CTB0000004', part: 'CTPART004', qty: 400, loc: 'NB02-A-04-1F', age: 35 },
  { code: 'CTB0000006', part: 'CTPART006', qty: 600, loc: 'NB02-A-06-1F', age: 40 },
]; // 5 盲区候选；countMax=2 → 抽2留≥3未冻结
function baseDb() {
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
  if (fs.existsSync(path.join(SRC, 'secret.key'))) fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
  const db = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
  const mk = (id, un, name, role) => { const salt = crypto.randomBytes(16).toString('hex'); db.users.push({ id, username: un, name, role, enabled: true, salt, passHash: crypto.scryptSync('E2e#Ct!123', salt, 32).toString('hex'), createdAt: new Date().toISOString() }); };
  mk('u_ct_wh', 'ct_wh', '盘点仓管', 'warehouse'); mk('u_ct_mat', 'ct_mat', '盘点物料', 'material');
  const now = Date.now();
  db.ledger = [];
  BLIND.forEach((b) => db.ledger.push({ c: b.code, l: b.loc, f: '1800*1200_2', t: now - b.age * DAY, p: b.part, n: '盘点件' + b.code.slice(-1), q: b.qty, b: '2026-10-01', pid: '', by: '夹具', rec: now - b.age * DAY }));
  db.ledger.push({ c: 'CTB0000005', l: 'NB02-B-01-1F', f: '1800*1200_2', t: now - 1 * 36e5, p: 'CTPART005', n: '盘点件5近期', q: 500, b: '2026-11-08', pid: '', by: '夹具', rec: now - 1 * 36e5 });
  db.params = Object.assign({}, db.params, { countMax: 2, countSamplePct: 100, countStaleDays: 7, countConc: 3, receivingOn: 0, reqHoursOn: 0, countAutoDeploy: 1 }); // P() 数字参数只认 number；reqHoursOn=0 关领料时段闸（夹具继承生产库该闸为开，非工作时段建单会被拒致 B 组假失败）；㉖v141 本套件状态机依赖自动发车流转，显式开启（生产默认0=人工拉取，由 v141 专项套件验证）
  db.counts = []; db.agvQueue = []; db.rcsStations = {};
  db.autoDispatch = false; db.agvDispatchMode = 'dry';
  delete db.rcsConfig; delete db.wmasConfig;
  return { db, now };
}
function writeDb(db) { fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db)); }
function startServer() {
  return new Promise((res) => {
    const p = cp.spawn('node', ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = ''; p.stdout.on('data', (d) => { buf += d; }); p.stderr.on('data', (d) => { buf += d; });
    p.__log = () => buf; setTimeout(() => res(p), 2200);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, p, tk, body) {
  const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, tk ? { Authorization: 'Bearer ' + tk } : {}), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
async function waitState(tk, id, want, maxMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const l = (await req('GET', '/api/count/list?all=1', tk)).json.list || [];
    const q = l.find((x) => x.id === id); if (q && want.includes(q.state)) return q;
    await sleep(2000);
  }
  return null;
}
const ctLedger = () => JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).ledger.filter((x) => String(x.c || '').startsWith('CTB')).map((x) => [x.c, x.l, x.q]).sort();

(async () => {
  let srv = null;
  try {
    // ========== 阶段1：选框 + 冻结 ==========
    { const { db } = baseDb(); writeDb(db); }
    srv = await startServer();
    const wh = (await req('POST', '/api/login', null, { username: 'ct_wh', password: 'E2e#Ct!123' })).json.token;
    const mat = (await req('POST', '/api/login', null, { username: 'ct_mat', password: 'E2e#Ct!123' })).json.token;
    if (!wh || !mat) throw new Error('登录失败');
    const snap0 = ctLedger();

    const c0 = (await req('GET', '/api/count/list', wh)).json;
    chk('A1 盲区候选=5（排除近期框CTB5）', c0.cand, 5);
    chk('A2 初始无工单', (c0.list || []).length, 0);
    const st = (await req('POST', '/api/count/start', wh, { pct: 100 })).json;
    chk('A3 全比例抽取受上限截断 picked=2', st.picked, 2);
    chk('A4 候选总数回显', st.total, 5);
    chkT('A5 工单初始 pending', st.list.every((q) => q.state === 'pending'));
    chkT('A6 工单带货位/零件/数量/滞留≥19天', st.list.every((q) => /^NB02-/.test(q.from) && q.part && q.qty > 0 && q.ageDays >= 19));
    const frozen = st.list.map((q) => q.code);
    chk('A7 已冻结框退出候选（5-2=3）', (await req('GET', '/api/count/list', wh)).json.cand, 3);
    chk('A8 发起会话后账本一字不动', ctLedger(), snap0);

    const f0 = st.list[0];
    const rq1 = (await req('POST', '/api/requisitions', mat, { items: [{ partNo: f0.part, itemName: f0.nm, qty: f0.qty }] })).json;
    const rid1 = (rq1.req || rq1).id;
    chkT('B1a 建单成功', !!rid1);
    chkT('B1b 接单成功', (await req('POST', '/api/requisitions/' + rid1 + '/accept', wh, {})).json.ok === true);
    const sc1 = (await req('POST', '/api/requisitions/' + rid1 + '/scan', wh, { barcode: f0.code, partNo: f0.part }));
    chk('B1c 冻结框发料被硬拦(400)', sc1.status, 400);
    chkT('B1d 拒因点名盘点', String(sc1.json.msg || '').includes('盘点'));
    const rv1 = (await req('GET', '/api/requisitions/' + rid1, wh)).json;
    const it0 = ((rv1.req || rv1).items || [])[0] || {};
    const sugCodes = ((it0.suggest || {}).boxes || []).flatMap((b) => b.codes || []);
    chkT('B2 取货建议排除冻结框', !sugCodes.includes(f0.code));
    const cy = (await req('POST', '/api/agv/carry', wh, { dir: 'out', code: f0.code, from: f0.from, to: 'NB02-CK-01' }));
    chkT('B3 carry 出库叫车拦冻结框', cy.json.ok !== true && String(cy.json.msg || '').includes('盘点'));
    const free = BLIND.find((b) => !frozen.includes(b.code));
    const rq2 = (await req('POST', '/api/requisitions', mat, { items: [{ partNo: free.part, itemName: '盘点件', qty: free.qty }] })).json;
    const rid2 = (rq2.req || rq2).id;
    chkT('B4a 未冻结框建单', !!rid2);
    chkT('B4b 未冻结框接单', (await req('POST', '/api/requisitions/' + rid2 + '/accept', wh, {})).json.ok === true);
    const sc2 = (await req('POST', '/api/requisitions/' + rid2 + '/scan', wh, { barcode: free.code, partNo: free.part, qty: free.qty }));
    if (sc2.json.ok !== true) console.log('DIAG B4c:', JSON.stringify(sc2.json).slice(0, 240));
    chkT('B4c 未冻结框正常发料（不误伤）', sc2.json.ok === true);
    srv.kill(); await sleep(500);

    // ========== 阶段2：状态机（独立夹具写死场景） ==========
    const { db: d2, now: n2 } = baseDb();
    const mkRec = (id, b, state, extra) => Object.assign({ id, sid: 'CS2', code: b.code, from: b.loc, part: b.part, nm: '盘点件', f: '1800*1200_2', qty: b.qty, ageDays: b.age, state, station: '', uid: 'u_ct_wh', by: '盘点仓管', at: n2, updAt: n2, taskNo: '', taskNo2: '', outQueued: 0, backQueued: 0, diff: null }, extra || {});
    const b1 = BLIND[0], b2 = BLIND[1], b3 = BLIND[2];
    d2.counts = [
      mkRec('cnt_1', b1, 'toStation', { station: 'NB02-CK-01', taskNo: 'T-1' }), // C1 到台→atStation
      mkRec('cnt_2', b2, 'scanned', { station: 'NB02-CK-02', backQueued: 1 }), // C4 归位完成→done
      mkRec('cnt_3', b3, 'atStation', { station: 'NB02-CK-03', arriveAt: n2 }), // C6 串位
      mkRec('cnt_4', { code: 'CTB0000005', part: 'CTPART005', qty: 500, loc: 'NB02-B-01-1F', age: 1 }, 'toStation', { station: 'NB02-CK-04', taskNo: 'T-4' }), // C8 取消腿
    ];
    d2.agvQueue = [
      { id: 'q1', code: b1.code, type: 'count', countId: 'cnt_1', fromLoc: b1.loc, station: 'NB02-CK-01', state: '已下发', sentAt: n2 - 60000, at: n2 - 60000, updAt: n2, wmsTask: 'T-1', trace: [] },
      { id: 'q2', code: b2.code, type: 'countback', countId: 'cnt_2', fromLoc: 'NB02-CK-02', station: b2.loc, state: '完成', dockAt: n2 - 30000, at: n2 - 300000, updAt: n2 - 30000, wmsTask: 'T-2', trace: [] },
      { id: 'q4', code: 'CTB0000005', type: 'count', countId: 'cnt_4', fromLoc: 'NB02-B-01-1F', station: 'NB02-CK-04', state: '排队', at: n2, updAt: n2, trace: [] },
    ];
    d2.rcsStations = { 'NB02-CK-01': { station: 'NB02-CK-01', state: '有货', codes: [b1.code], ts: n2 }, 'NB02-CK-03': { station: 'NB02-CK-03', state: '有货', codes: ['CTB0000005'], ts: n2 } };
    writeDb(d2);
    const snap2 = ctLedger();
    srv = await startServer();
    const wh2 = (await req('POST', '/api/login', null, { username: 'ct_wh', password: 'E2e#Ct!123' })).json.token;

    chkT('C1 站台有本框 → toStation推进atStation', !!(await waitState(wh2, 'cnt_1', ['atStation'], 45000)));
    const sn1 = (await req('POST', '/api/count/scan', wh2, { id: 'cnt_1', barcode: b1.code, mesQty: b1.qty })).json;
    chkT('C2 码对+数对 → scanned 相符', sn1.ok === true && sn1.match === true && sn1.qtyOk === true);
    const rt1 = (await req('POST', '/api/count/return', wh2, { id: 'cnt_1' })).json;
    chkT('C3 归位入队（dry=排队，停 scanned 等发车）', rt1.ok === true && rt1.rec.state === 'scanned');
    chkT('C4 归位腿完成+账原位 → returning→done', !!(await waitState(wh2, 'cnt_2', ['done'], 45000)));
    const led2 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).ledger;
    chkT('C5 done 后账本位置仍是原格（盘点不改账）', led2.some((x) => x.c === b2.code && x.l === b2.loc));
    const sn3 = (await req('POST', '/api/count/scan', wh2, { id: 'cnt_3', barcode: 'CTB0000005' })).json;
    chkT('C6 串位：扫到台上他框 → mismatch wrongBox', sn3.ok === true && sn3.match === false && sn3.rec.diff.kind === 'wrongBox');
    chkT('C7 mismatch 记录实扫框账位', sn3.rec.diff.scanned === 'CTB0000005' && sn3.rec.diff.scannedLoc === 'NB02-B-01-1F');
    const cx = (await req('POST', '/api/agv/queue/cancel', wh2, { codes: ['CTB0000005'] })).json;
    const q4 = (await req('GET', '/api/count/list?all=1', wh2)).json.list.find((x) => x.id === 'cnt_4');
    chkT('C8 取消排队腿 → 工单回退 pending 可重叫', cx.ok === true && q4.state === 'pending' && !q4.taskNo);
    chk('D1 状态机全程账本一字不动', ctLedger(), snap2);
    chkT('D2 盘点核对/归位未产生 CTB 出库单', Object.keys(JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).outbound || {}).filter((k) => JSON.stringify((JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8')).outbound || {})[k]).includes('CTB')).length === 0);

    // ========== 阶段3：源码锚点 + 日志 ==========
    const srcTxt = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const anchors = {
      '盲区候选排除近期框': srcTxt.includes('if (!r.lastT || r.lastT > cut) continue;'),
      '归位腿钉死原格 manualOnly': srcTxt.includes("manualOnly: leg === 'back'"),
      '终点纠正排除countback': srcTxt.includes("x.type !== 'countback'"),
      '重复货位防线含countback': srcTxt.includes("q.type === 'inbound' || q.type === 'countback'"),
      '绑定闸含盘点双腿': srcTxt.includes("q.type === 'count' || q.type === 'countback'"),
      'retire统一收口盘点回退': srcTxt.includes('countQueueRollback(q); // ㉖v123 盘点双腿取消/判死统一回退工单'),
      '发料硬闸点名盘点': srcTxt.includes('如确需发料请先在盘点页取消该单') || srcTxt.includes('请待盘点单结束后再扫'),
      '拣选排除冻结集': srcTxt.includes('const _fz = countFrozenSet();'),
    };
    for (const [k, v] of Object.entries(anchors)) chkT('E ' + k, v);
    const log = srv.__log ? srv.__log() : '';
    if (/ReferenceError|TypeError: |SyntaxError|uncaught/i.test(log)) { chkT('F1 服务日志无运行时异常', false); console.log(log.slice(0, 800)); } else chkT('F1 服务日志无运行时异常', true);
  } catch (e) {
    fail++; console.log('EXCEPTION:', e.message, e.stack && e.stack.slice(0, 500));
  } finally {
    if (srv) try { srv.kill(); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
    console.log(`===== 货架AGV盘点实例证明 ${total - fail}/${total} PASS =====`);
    process.exit(fail ? 1 : 0);
  }
})();
