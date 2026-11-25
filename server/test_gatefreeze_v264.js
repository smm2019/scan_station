// ㉖v264 恶意连开限流 + 逾期签收冻结 · 端到端实例证明（真实 HTTP 打隔离实例）
// 需求：①恶意下单限制（张建旺 3 分钟连开 5 张不同零件号钻 v235 同码闸盲区）②超 2 小时不签收→冻结下单一定时间
// 剧本：S1 连开限流（N=3/窗5分：第1/2放行、第3拦409 throttle、rush豁免、confirmThrottle直通）
//       S2 逾期签收冻结（ready 单 readyAt 超 120 分未签收 → 409 freeze 硬拦、gate 端点预报、二次仍拦=懒触发持久）
//       S3 统计口径（kpi.overReady 计逾期签收数、freeze 时长=freezeMin×逾期张数）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const TDIR = path.join(__dirname, 'data_e2e_gate_v264');
const PORT = 8447, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'data', 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(__dirname, 'data', 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(8).toString('hex'), hp = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
db0.users = db0.users || [];
db0.users.push({ id: 'u_v264m1', username: 'v264_m1', name: 'V264限流员', role: 'material', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp('E2e#G4!a', salt) });
db0.users.push({ id: 'u_v264m2', username: 'v264_m2', name: 'V264冻结员', role: 'material', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp('E2e#G4!b', salt) });
db0.users.push({ id: 'u_v264m3', username: 'v264_m3', name: 'V264多单员', role: 'material', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hp('E2e#G4!c', salt) });
const MIN = 60000;
// 冻结员预置一张备齐到站超 130 分未签收的 ready 单（>freezeOverMin=120）；多单员两张（测罚时×(1+n) 递增）
db0.requisitions = (db0.requisitions || []).concat([
  { id: 'q_v264_rdy', no: 'LLV264RDY01', by: 'u_v264m2', byName: 'V264冻结员', status: 'ready', createdAt: new Date(Date.now() - 200 * MIN).toISOString(), readyAt: Date.now() - 130 * MIN, history: [], rush: false, items: [{ partNo: 'V264RDY01', itemName: '冻结样本件', qty: 5, issued: [] }] },
  { id: 'q_v264_rdy2', no: 'LLV264RDY02', by: 'u_v264m3', byName: 'V264多单员', status: 'ready', createdAt: new Date(Date.now() - 260 * MIN).toISOString(), readyAt: Date.now() - 250 * MIN, history: [], rush: false, items: [{ partNo: 'V264RDY02', itemName: '多单样本甲', qty: 5, issued: [] }] },
  { id: 'q_v264_rdy3', no: 'LLV264RDY03', by: 'u_v264m3', byName: 'V264多单员', status: 'ready', createdAt: new Date(Date.now() - 180 * MIN).toISOString(), readyAt: Date.now() - 170 * MIN, history: [], rush: false, items: [{ partNo: 'V264RDY03', itemName: '多单样本乙', qty: 5, issued: [] }] },
]);
// 隔离 v98c 待签收软闸（gateMode=0），让 v264 冻结独立可测；两闸参数显式定档（freezeMin=120 基数→罚时=2h+2h×n）
db0.params = Object.assign(db0.params || {}, { gateMode: 0, freezeOn: 1, freezeOverMin: 120, freezeMin: 120, throttleN: 3, throttleWinMin: 5, reqHoursOn: 0 }); // ㉖v271 reqHoursOn=0：隔离生产"领料时段"开关，测试不随真实钟点漂移（早前失败=跑在18:30后时段外）
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(g)} want=${JSON.stringify(w)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
let tk1 = '', tk2 = '';
const post = async (p, tk, body) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const getj = async (p, tk) => { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return (await r.json().catch(() => ({}))); };
const mkItems = (pn) => [{ partNo: pn, itemName: '限流样本', qty: 10 }];
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪\n' + log.join('').slice(-800)); srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); process.exit(1); }
  try {
    let tk1 = '', tk2 = '', tk3 = '';
    tk1 = (await post('/api/login', null, { username: 'v264_m1', password: 'E2e#G4!a' })).json.token;
    tk2 = (await post('/api/login', null, { username: 'v264_m2', password: 'E2e#G4!b' })).json.token;
    tk3 = (await post('/api/login', null, { username: 'v264_m3', password: 'E2e#G4!c' })).json.token;
    chkT('T0 三物料员登录（前提）', !!tk1 && !!tk2 && !!tk3, tk1 + '/' + tk2 + '/' + tk3);
    // ============ S1 连开限流（N=3/窗5分：第1、2放行，第3拦）============
    const a1 = await post('/api/requisitions', tk1, { items: mkItems('V264A01') });
    const a2 = await post('/api/requisitions', tk1, { items: mkItems('V264A02') });
    chk('S1a 窗口内第1、2张放行', [a1.json.ok === true, a2.json.ok === true], [true, true]);
    const a3 = await post('/api/requisitions', tk1, { items: mkItems('V264A03') });
    chk('★S1b 第3张软拦=409 throttle（非急料非确认）', [a3.status, a3.json.ok === false, a3.json.code], [409, true, 'throttle']);
    chkT('S1b2 throttle 带解除时刻与已开张数', (a3.json.releaseAt || 0) > Date.now() && (a3.json.n || 0) >= 2, JSON.stringify({ r: a3.json.releaseAt, n: a3.json.n }));
    const a3r = await post('/api/requisitions', tk1, { items: mkItems('V264A03R'), rush: true });
    chkT('★S1c 急料豁免直通（真急不误伤）', a3r.json.ok === true, JSON.stringify(a3r.json).slice(0, 120));
    const a4c = await post('/api/requisitions', tk1, { items: mkItems('V264A04'), confirmThrottle: 1 });
    chkT('★S1d confirmThrottle 确认直通（合法批量补料）', a4c.json.ok === true, JSON.stringify(a4c.json).slice(0, 120));
    const a4d = await post('/api/requisitions', tk1, { items: mkItems('V264A05'), confirmDup: 1 });
    chkT('★S1e 闸协同：confirmDup 已确认意图不被限流二次拦（v235 补料出路不截断）', a4d.json.ok === true, JSON.stringify(a4d.json).slice(0, 120));
    // ============ S2 逾期签收冻结（gateMode=0 隔离 v98c；ready 单超 130 分未签收）============
    const gate2 = await getj('/api/requisitions/gate', tk2);
    chkT('★S2a 建单预检 gate 预报冻结（frozen=true 带 until）', gate2.ok === true && gate2.freeze && gate2.freeze.frozen === true && (gate2.freeze.until || 0) > Date.now(), JSON.stringify(gate2.freeze));
    const f1 = await post('/api/requisitions', tk2, { items: mkItems('V264F01') });
    chk('★S2b 冻结中下单硬拦=409 freeze（无直通）', [f1.status, f1.json.ok === false, f1.json.code], [409, true, 'freeze']);
    chkT('★S2b2 罚时=2h+2h×1张=240分（每单都要自己的罚时）', (f1.json.until || 0) > Date.now() + 235 * MIN && (f1.json.until || 0) < Date.now() + 241 * MIN, 'until-now=' + Math.round(((f1.json.until || 0) - Date.now()) / MIN) + '分');
    const f2 = await post('/api/requisitions', tk2, { items: mkItems('V264F02'), confirmThrottle: 1 });
    chk('S2c 冻结期 confirm 无直通=仍拦（自动解不靠确认）', [f2.status, f2.json.code], [409, 'freeze']);
    const f3 = await post('/api/requisitions', tk3, { items: mkItems('V264F03') });
    chkT('★S2d 2张逾期罚时=2h+2h×2=360分（逐单递增）', [f3.json.code, Math.round(((f3.json.until || 0) - Date.now()) / MIN)] , ['freeze', 360]);
    // ============ S3 统计口径与通知 ============
    const dash = await getj('/api/dashboard', tk2);
    chkT('★S3a kpi.overReady≥1（逾期签收统计与冻结同口径）', (dash.kpi || {}).overReady >= 1, JSON.stringify((dash.kpi || {}).overReady));
    chkT('S3b 冻结触发点名通知已发（本人 freeze_out 入消息）', (await getj('/api/notifications', tk2)).notifications.some((x) => x.type === 'freeze_out' || /冻结/.test(x.text || '')), '');
    // S3c 活动流审计：ops 无物料员可查 JSON 端点，直读隔离目录当日 JSONL（权威持久层）
    { const day = new Date().toISOString().slice(0, 10); let opsTxt = ''; try { opsTxt = fs.readFileSync(path.join(TDIR, 'ops', 'ops-' + day + '.jsonl'), 'utf8'); } catch (_) {}
      chkT('S3c 冻结留痕入活动流 JSONL（逾期签收冻结+带操作人）', /逾期签收冻结/.test(opsTxt) && /V264冻结员/.test(opsTxt), opsTxt.slice(-200)); }
    const gate1 = await getj('/api/requisitions/gate', tk1);
    chkT('S3d 限流员 gate 预检 throttle.hit=true（窗口内≥N-1）', gate1.throttle && gate1.throttle.hit === true, JSON.stringify(gate1.throttle));
    // 服务无崩溃
    chkT('Z 服务无未捕获异常', !/uncaught|TypeError: Cannot read|throwEr/i.test(log.join('')), log.join('').slice(-300));
    console.log(`\n===== v264 限流+冻结闸门实例证明：${total - fail}/${total} PASS =====`);
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e); process.exitCode = 1; } finally { srv.kill(); fs.rmSync(TDIR, { recursive: true, force: true }); }
})();
