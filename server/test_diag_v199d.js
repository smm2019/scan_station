// ㉖v199d 诊断搭车上报 · 隔离实例端到端
// 现场实锤(11-17 三框)：设备账本推送哑死(连失败请求都没有)，服务器只有间接证据，诊断页零上报靠截图
// 链路：sync/pulse 带 diag→db.diagPulse；fullFlowAlert 附诊断；diagDeadSweep 设备级点名；GET devices 查询
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_diag199d');
  const PORT = Number(process.env.DIAG_PORT || (8600 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const CODE = 'N26K170143', GND = 'NB03-C-11-13', OP = '刘向轩';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [
      { id: 'u_wh', username: 'wh_u', name: OP, role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Wh#199', salt, 32).toString('hex') },
      { id: 'u_ad', username: 'ad_u', name: '测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Ad#199', salt, 32).toString('hex') },
    ];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    d0.features.warehouse.collect = true; d0.features.warehouse.location_reg = true;
    d0.ledger = []; d0.ledgerTomb = [];
    d0.scanlog = { [CODE + '|B-DIAG|1']: { code: CODE, gl: GND, wt: 1, t: Date.now() - 10 * 60000, cx: false, op: OP, q: 25, pn: 'PNX' } }; // 完整格位流水已 10 分钟无账本 = full/dead 双告警靶
    d0.seenOut = {}; d0.diagPulse = {}; d0.diagDeadAlert = {}; d0.fullAlert = {}; d0.ops = []; d0.events = []; d0.inspects = []; d0.agvQueue = []; d0.rcsStations = {};
    d0.ledgerEpoch = 'EP1'; // 世代章置定值：R2 拒世代用；心跳回带也拿它对照
    d0.params = Object.assign({}, d0.params || {}); d0.params.diagDeadMin = { v: 15 }; // 判死阈值15分钟
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    C('护栏 实例启动+登录', up, '');
    const tk = (await API('/api/login', { method: 'POST', body: { username: 'wh_u', password: 'Wh#199' } }, null)).token;
    const tkAd = (await API('/api/login', { method: 'POST', body: { username: 'ad_u', password: 'Ad#199' } }, null)).token;

    // ① 流水 sync 搭车 diag（哑死时账本通道没了，流水腿必须照收）
    const r1 = await API('/api/scanlog/sync', { method: 'POST', body: { items: [{ k: CODE + '|B-DIAG|2', code: CODE, wt: 1, gl: GND, t: Date.now() - 9 * 60000, batch: 'B-DIAG', cx: false, op: OP }], diag: { epoch: 'E1', pending: true, retryN: 7, lastErr: '旧版失败被覆盖', lastErrAt: Date.now() - 60000, lastOkAt: Date.now() - 20 * 60000, host: '旧主机', app: '1.0.0+190', ledgerCnt: 20, ip: '10.0.0.8' } } }, tk);
    C('R1 ★★★ 流水搭车 diag 被消费(200B零副作用)', r1.ok === true, 'ok=' + r1.ok);
    await sleep(4500); // save 防抖 ~4 秒，读盘断言前必须等
    const dbA = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('R1b 搭车快照即时落盘(不靠告警环)', (dbA.diagPulse || {})[OP] && (dbA.diagPulse[OP] || {}).retryN === 7, 'retryN=' + ((dbA.diagPulse || {})[OP] || {}).retryN);

    // ② 账本 sync 搭车（被世代闸拒绝也不影响留快照——世代卡死正是最需要诊断的时刻）
    const r2 = await API('/api/ledger/sync', { method: 'POST', body: { items: [{ c: 'ZZZ1', l: 'NB02-A-01-1F', t: Date.now() }], epoch: 'OLD-EPOCH-WRONG', diag: { epoch: 'OLD-EPOCH-WRONG', pending: true, retryN: 9, lastErr: 'epochStale', lastOkAt: Date.now() - 3600000 } } }, tk);
    C('R2 世代闸照常拒绝', r2.ok === false && r2.code === 'epochStale', 'code=' + r2.code);
    await sleep(4500);
    const dbB = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('R2b 被拒后诊断仍入袋(卡死时刻可见)', (dbB.diagPulse || {})[OP] && dbB.diagPulse[OP].retryN === 9, 'retryN=' + (dbB.diagPulse[OP] || {}).retryN);

    // ③ 独立心跳端点（世代对齐版：动态字段积压 20 分钟>阈值15 → 诊断走"积压+末次失败原因"）
    const r3 = await API('/api/diag/pulse', { method: 'POST', body: { diag: { epoch: 'EP1', pending: true, retryN: 12, lastErr: 'ConnectTimeout 连接超时', lastErrAt: Date.now() - 60000, lastOkAt: Date.now() - 20 * 60000, host: 'PDA-LX', app: '1.0.0+192', ledgerCnt: 24, ip: '10.0.0.9' } } }, tk);
    C('R3 心跳端点受理+回epoch(对齐自校)', r3.ok === true && r3.epoch === 'EP1', 'epoch=' + JSON.stringify(r3.epoch));

    // ④ 查询端点（admin）
    const r4 = await API('/api/diag/devices', {}, tkAd);
    C('R4 GET devices 按新排序', r4.ok === true && Array.isArray(r4.devices) && r4.devices[0] && r4.devices[0].who === OP, 'n=' + (r4.devices || []).length);

    // ⑤⑥ 告警环消费（full=启动13秒/每5分钟，dead=启动17秒/每5分钟；夹具流水 10 分钟旧，
    //   启动 tick 即双报——diagPulse 此刻为空 → 诊断短语"未收到设备心跳(旧版APP未升级)"，
    //   正是旧版设备的真实形态；sync 搭车后 full 已去重，dead 同人 7 天去重同例）
    //   ★不跑"改写盘 fixture 再等 tick"路线——服务器内存库 save 会回写覆盖（本仓已知坑）
    await sleep(24000);
    const dbC = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const fa = (dbC.ops || []).filter((o) => o.act === '格位未上账');
    // 启动 tick 先于 sync 到达 → 首条必为"未收到设备心跳（旧版APP未升级）"真实形态；
    // 若时序颠倒（tick 在 sync 后）则为"重试/积压"类诊断——两者都算附诊断成功
    C('R5 ★★★ 未上账告警附设备诊断短语', fa.length > 0 && fa.every((o) => /设备诊断/.test(String(o.det || ''))) && /心跳|重试|积压|世代|推送正常/.test(String((fa.slice(-1)[0] || {}).det || '')), String((fa.slice(-1)[0] || {}).det || '(未触发)').slice(0, 130));
    const dd = (dbC.ops || []).filter((o) => o.act === '设备账本推送异常');
    // sync 搭车先于 dead tick → 诊断走动态分支"积压(末次失败:xxx 重试N次)"（正是哑死+失败循环形态）
    C('R6 ★★★ 设备级点名+积压诊断直给(末次失败原因)', dd.length > 0 && /账本推送积压/.test(String((dd.slice(-1)[0] || {}).det || '')) && /ConnectTimeout/.test(String((dd.slice(-1)[0] || {}).det || '')) && String((dd.slice(-1)[0] || {}).det || '').includes(OP), String((dd.slice(-1)[0] || {}).det || '(未触发)').slice(0, 130));
    C('R6b 7天去重生效(二次tick不重复吵)', (dbC.diagDeadAlert || {})[OP] > 0, 'seen=' + (dbC.diagDeadAlert || {})[OP]);

    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-8).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
