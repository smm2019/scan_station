// ㉖v141 盘点下架腿人工拉取发车 · 实例证明
// 用户两条实锤推翻 v140 执行窗方案：①不要自动预下架（框何时上站台必须由人决定）；②夜间 AGV 关机断电
//   ——任何"系统自己决定何时发车"的机制（黑名单/白名单窗）都不该存在。
// 落地：countAutoDeploy 默认 0=人工拉取：状态机不再自动下发下架腿，工单停在 pending；
//   人经 /api/count/deploy 逐框或整会话「🚚 发车」才叫 AGV（受双腿并发上限、仓管/管理员权限、审计留痕）；
//   开关 1=旧自动行为（三老套件夹具已显式开启保流转可复现）。归位腿本就人触发不受影响。
// 证明面：
//  D组 deploy 接口行为（真 HTTP 隔离实例）：单框发车→toStation/已下发；批量→逐框；并发满→拒并点名；
//     非 pending 重复发→无可发车；无权限角色→403；审计 pushOps 留痕
//  N组 默认不自动：autoDeploy=0 实例建单后等两轮状态机 busy=0、工单保持 pending（=不自动预下架的直接证据）
//  A组 开关=1 自动发车回归（旧行为保留）
//  S组 透出与三端锚点：list.autoDeploy、网页单框+批量按钮、PDA 发车方法、参数默认0
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), PORT0 = 8414;
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0, fail = 0;
const chk = (n, a, b) => { total++; const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] ${ok ? '' : 'got=' + JSON.stringify(a).slice(0, 130) + ' want=' + JSON.stringify(b).slice(0, 130)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };

function mkFixture(extraParams) {
  const db = JSON.parse(fs.readFileSync(path.join(SRC, 'db.json'), 'utf8'));
  db.users.push({ id: 'u_dp_wh', username: 'dp_wh', name: '发车仓管', role: 'warehouse', enabled: true, salt, passHash: hashPw('E2e#Dp!141', salt), createdAt: new Date().toISOString() });
  db.users.push({ id: 'u_dp_mat', username: 'dp_mat', name: '发车物料', role: 'material', enabled: true, salt, passHash: hashPw('E2e#Dp!141', salt), createdAt: new Date().toISOString() });
  const now = Date.now();
  db.ledger = [];
  for (let i = 1; i <= 4; i++) db.ledger.push({ c: 'DPB000000' + i, l: 'NB02-H-' + String(10 + i).padStart(2, '0') + '-1F', f: '1800*1200_2', t: now - 10 * 864e5, p: 'DPPART00' + i, n: '拉取件' + i, q: 100, b: '2026-10-01', pid: '', by: '夹具', rec: now - 10 * 864e5 });
  db.params = Object.assign({}, db.params, { countMax: 4, countSamplePct: 100, countStaleDays: 7, countConc: 2, receivingOn: 0, reqHoursOn: 0 }, extraParams || {});
  db.counts = []; db.agvQueue = []; db.rcsStations = {};
  db.autoDispatch = false; db.agvDispatchMode = 'dry';
  delete db.rcsConfig; delete db.wmasConfig;
  return { db, TDIR: path.join(__dirname, 'tmp_e2e_deploy_v141_' + PORT0 + '_' + Math.random().toString(36).slice(2, 6)) };
}
async function start(extraParams, port) {
  const { db, TDIR } = mkFixture(extraParams);
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  const BASE = 'http://127.0.0.1:' + port;
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { srv.kill('SIGKILL'); throw new Error('实例未就绪 ' + port); }
  const req = async (method, p, tk, body) => { const r = await fetch(BASE + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, tk ? { Authorization: 'Bearer ' + tk } : {}), body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json().catch(() => ({}))) }; };
  const wh = (await req('POST', '/api/login', null, { username: 'dp_wh', password: 'E2e#Dp!141' })).json.token;
  const mat = (await req('POST', '/api/login', null, { username: 'dp_mat', password: 'E2e#Dp!141' })).json.token;
  return { srv, TDIR, BASE, req, wh, mat, log };
}
const stop = (i) => { i.srv.kill('SIGKILL'); fs.rmSync(i.TDIR, { recursive: true, force: true }); };

(async () => {
  console.log('== N组 默认=人工拉取：不自动预下架（直接证据） ==');
  {
    const i = await start({}, PORT0); // 不设 countAutoDeploy → 走默认0
    const st = (await i.req('POST', '/api/count/start', i.wh, { pct: 100 })).json;
    chkT('N1 建单成功4框', st.ok === true && st.picked === 4, JSON.stringify(st).slice(0, 120));
    await sleep(33000); // 状态机 15 秒两轮+余量：旧版此刻早已自动下发，新版必须纹丝不动
    const l = (await i.req('GET', '/api/count/list?all=1', i.wh)).json;
    chk('N2 两轮状态机后 busy=0（下架腿零自动下发）', l.busy, 0);
    chk('N3 工单全部保持 pending 且 outQueued=0', l.list.map((x) => [x.state, x.outQueued]), [['pending', 0], ['pending', 0], ['pending', 0], ['pending', 0]]);
    chk('N4 list 透出 autoDeploy=0', l.autoDeploy, 0);
    stop(i);
  }

  console.log('== D组 deploy 人工发车接口行为 ==');
  {
    const i = await start({}, PORT0 + 1);
    const st = (await i.req('POST', '/api/count/start', i.wh, { pct: 100 })).json;
    const ids = st.list.map((x) => x.id);
    // D1 单框发车
    const d1 = (await i.req('POST', '/api/count/deploy', i.wh, { id: ids[0] })).json;
    chkT('D1a 单框发车成功', d1.ok === true && d1.done === 1, JSON.stringify(d1).slice(0, 140));
    let l = (await i.req('GET', '/api/count/list?all=1', i.wh)).json;
    const q0 = l.list.find((x) => x.id === ids[0]);
    chkT('D1b 工单进 toStation/pending 流转态（dry=已入队）', ['toStation', 'pending'].includes(q0.state) && l.busy >= 1, 'state=' + q0.state + ' busy=' + l.busy);
    // D2 整会话批量（剩余3框，conc=2 → 第3框并发满被点名拒发）
    const d2 = (await i.req('POST', '/api/count/deploy', i.wh, { sid: st.sid })).json;
    chkT('D2a 批量响应含逐框结果', d2.ok === true && Array.isArray(d2.list) && d2.list.length === 3, JSON.stringify(d2).slice(0, 160));
    const refused = (d2.list || []).filter((x) => !x.ok);
    chkT('D2b 并发上限 conc=2 生效：D1已占1+批量发1=满，剩2框拒发点名（拒' + refused.length + '）', refused.length === 2 && refused.every((x) => /并发已满/.test(x.msg || '')), JSON.stringify(d2.list).slice(0, 220));
    // D3 非 pending 重复发 → 无可发车
    const d3 = (await i.req('POST', '/api/count/deploy', i.wh, { id: ids[0] })).json;
    chk('D3 已发车工单重复发→无可发车', d3.ok === false && /无可发车/.test(d3.msg || ''), true);
    // D4 权限：material 403
    const d4 = await i.req('POST', '/api/count/deploy', i.mat, { sid: st.sid });
    chk('D4 物料角色发车被拒 403', d4.status, 403);
    // D5 审计留痕（save 120ms 防抖+异步落盘，读盘前等待）
    await sleep(800);
    const dbEnd = JSON.parse(fs.readFileSync(path.join(i.TDIR, 'db.json'), 'utf8'));
    const ops = (dbEnd.ops || []).filter((o) => /盘点发车/.test(String(o.act || '')));
    chkT('D5 pushOps 审计留痕（发车动作可查）', ops.length >= 1, JSON.stringify(ops.map((o) => o.act)).slice(0, 120));
    stop(i);
  }

  console.log('== A组 开关=1 自动发车回归（旧行为保留） ==');
  {
    const i = await start({ countAutoDeploy: 1 }, PORT0 + 2);
    const st = (await i.req('POST', '/api/count/start', i.wh, { pct: 100 })).json;
    chkT('A1 建单成功', st.ok === true && st.picked === 4, JSON.stringify(st).slice(0, 100));
    await sleep(33000);
    const l = (await i.req('GET', '/api/count/list?all=1', i.wh)).json;
    chk('A2 自动模式两轮后 busy=conc 上限2（无需人工）', l.busy, 2);
    chk('A3 透出 autoDeploy=1', l.autoDeploy, 1);
    stop(i);
  }

  console.log('== S组 三端锚点与残留清零 ==');
  {
    const sj = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8');
    const inv = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inventory_page.dart'), 'utf8');
    const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'app_auth.dart'), 'utf8');
    chkT('S1 参数默认0=人工拉取', /countAutoDeploy: \{[^}]*d: 0/.test(sj), '');
    chkT('S2 状态机自动分支含开关前置', sj.includes('!q.outQueued && P().countAutoDeploy && countBusyLegs() < conc'), '');
    chkT('S3 v140 执行窗全清零（参数/函数/透出无残留）', !/countRunWin|countOutWinOk|outWinOk|inTimeWin/.test(sj) && !/peakHold|peakWin|outWinOk|runWin/.test(html), '');
    chkT('S4 网页单框+批量发车入口', html.includes('🚚 发车') && html.includes('🚚 批量发车') && html.includes('/api/count/deploy'), '');
    chkT('S5 PDA 发车按钮与方法', inv.includes('🚚 发车') && inv.includes('_deploy(') && auth.includes('countDeploy'), '');
    chkT('S6 deploy 接口权限与批量语义在位', sj.includes("p === '/api/count/deploy'") && sj.includes('仅仓管员/管理员可发车'), '');
  }
  console.log(`\n===== v141 人工拉取发车实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(e.stack); console.log(`===== v141 异常终止 ${total - fail}/${total} =====`); process.exit(1); });
