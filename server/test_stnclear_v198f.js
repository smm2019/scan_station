// ㉖v198f 拉下架到台后「位置登记收账→站台自动清」闭环 · 隔离实例端到端
// 用户实问：AGV 把货放到站台上，如何清站台让系统知道货被搬走？
// 现场动线：拉下架(transfer)→AGV 放台(账本改到 CK 台,rcsStations=有货)→人工把框转去地面
// →PDA 位置登记(账本 CK台→NB03)。旧缺口：登记改位后【站台"有货"状态不跟着清】，
// 挂最长 6 小时才自愈 → 台一直被占、下一框发不进来。
// 本证明：登记把行改离站台位后，stnReleaseByLedger 立即清台（rcsStations 删 + rcsCleared
// 置位防回灌 + 移库队列项收口完成 + 台预约窗释放），且安全线成立（台上仍有账本行绝不误清）。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_stn198f');
  const PORT = Number(process.env.SF_PORT || (8800 + Math.floor(Math.random() * 180)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const STN = 'NB02-CK-05', GND = 'NB03-A-11-05', FROM = 'NB02-A-08-2F';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_sf', username: 'sf_u', name: '清台测试仓', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Sf#198', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    if (!d0.features.warehouse) d0.features.warehouse = {};
    d0.features.warehouse.location_reg = true; d0.features.warehouse.agv_control = true; d0.features.warehouse.collect = true;
    d0.ledger = [
      { c: 'TSF001', l: STN, p: 'PNA', f: '1800*1200_2', t: Date.now() - 600000 },   // 已到台（账本在台上）
      { c: 'TSF002', l: STN, p: 'PNA', f: '1800*1200_2', t: Date.now() - 600000 },   // 同框兄弟码，也在台上
      { c: 'TSF003', l: 'NB02-B-01-1F', p: 'PNB', f: '1800*1200_2', t: Date.now() },
    ];
    d0.rcsStations = { [STN]: { station: STN, state: '有货', dir: 'out', label: FROM, codes: ['TSF001', 'TSF002'], via: '5-0999', ts: Date.now() - 600000 } };
    d0.rcsCleared = {}; d0.rcsManual = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {};
    d0.agvQueue = [{ id: 'q_sf', type: 'transfer', kind: 'shelf2shelf', from: FROM, to: STN, code: 'TSF001', boxKey: 'PNA', state: '已下发', by: '清台测试仓', at: Date.now() - 600000, sentAt: Date.now() - 600000, taskNo: 'WMSF001', trace: [] }];
    d0.inspects = []; d0.ledgerTomb = []; d0.ledgerFixes = []; d0.ops = [];
    d0.ledgerRev = (d0.ledgerRev || 0) + 1; d0.ledgerEpochAt = 0;
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    C('护栏 隔离实例启动', up, '');
    const tk = up && (await API('/api/login', { method: 'POST', body: { username: 'sf_u', password: 'Sf#198' } }, null)).token;
    C('护栏 登录取 token', !!tk, '');
    const st0 = await API('/api/rcs/stations', {}, tk);
    const s0 = (st0.stations || []).find((x) => x.station === STN) || {};
    C('S0 前置：台 '+STN+' 显示有货（拉下架已到台、账本在台上）', s0.state === '有货', 'state=' + s0.state);

    // 关键动作：人工把框转去地面后，PDA 位置登记（走 /api/ledger/sync 把整框改到 NB03）
    // 模拟真实登记：兄弟码 TSF002 也应随框登记离台（一框多标签整框转地面）
    const sync = await API('/api/ledger/sync', { method: 'POST', body: { epoch: '', items: [
      { c: 'TSF001', l: GND, p: 'PNA', f: '1800*1200_2', t: Date.now(), q: 10, mv: '人工' },
      { c: 'TSF002', l: GND, p: 'PNA', f: '1800*1200_2', t: Date.now(), q: 10, mv: '人工' },
    ], del: [] } }, tk);
    C('S1 位置登记整框改到地面受理', sync.ok === true, 'msg=' + (sync.msg || '') + ' upd=' + sync.updated);

    await sleep(1800); // 等 save 防抖落盘（磁盘快照读早于异步落盘会误判 S3/S4/S5）
    const st1 = await API('/api/rcs/stations', {}, tk);
    const s1 = (st1.stations || []).find((x) => x.station === STN);
    C('S2 ★★★ 位置登记后台面自动清（不再挂"有货"最长6小时）', !s1 || s1.state === '空闲', 'state=' + (s1 ? s1.state : '无此台记录'));

    const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('S3 ★★★ rcsCleared 已置位（防 RCS 到站事件把台刷回有货）', (disk.rcsCleared || {})[STN] > 0, '');
    C('S3b rcsDone 压掉该趟任务（via=5-0999 不再算有货）', Object.keys(disk.rcsDone || {}).some((k) => k.startsWith(STN + '|')), Object.keys(disk.rcsDone || {}).join(','));
    const q1 = (disk.agvQueue || []).find((x) => x.id === 'q_sf') || {};
    C('S4 ★★★ 对应移库队列项收口完成（旧版永挂已下发烧超时判失败）', q1.state === '完成' && /位置登记收账/.test((q1.trace || []).join('|')), 'state=' + q1.state + ' trace=' + (q1.trace || []).join(''));
    C('S5 自动清台留痕进 ops 事件', (disk.ops || []).some((o) => /站台自动清台/.test(o.act || '')), (disk.ops || []).filter((o) => /清台/.test(o.act || '')).map((o) => o.act + '·' + o.obj).join(','));

    // ★ 安全线：台上仍有账本行时绝不误清 —— 造一个"台上有货、账本也还在台"的台，只登记其中一码走人
    const STN2 = 'NB02-CK-06';
    {
      const d1 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
      d1.ledger.push({ c: 'TSF010', l: STN2, p: 'PNC', f: '1800*1200_2', t: Date.now() - 1000 });
      d1.ledger.push({ c: 'TSF011', l: STN2, p: 'PNC', f: '1800*1200_2', t: Date.now() - 1000 }); // 兄弟码留在台上
      d1.rcsStations[STN2] = { station: STN2, state: '有货', dir: 'out', label: FROM, codes: ['TSF010', 'TSF011'], via: '5-0888', ts: Date.now() - 1000 };
      fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d1));
    }
    // 重启读入新夹具（sync 判据读内存 db，需实例重载；直接改内存态不行，重启最干净）
    srv.kill(); await sleep(500);
    const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    srv = srv2; let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
    srv2.stdout.on('data', (d) => { out += d; }); srv2.stderr.on('data', (d) => { out += d; });
    const tk2 = up2 && (await API('/api/login', { method: 'POST', body: { username: 'sf_u', password: 'Sf#198' } }, null)).token;
    C('S6 前置：再造 '+STN2+' 有货、账本两码都在台（模拟框未搬清）', up2 && ((await API('/api/rcs/stations', {}, tk2)).stations.find((x) => x.station === STN2) || {}).state === '有货', '');
    // 只把 TSF010 登记走人，TSF011 仍在台上 → 台【不该】被清（框没搬完）
    await API('/api/ledger/sync', { method: 'POST', body: { epoch: '', items: [{ c: 'TSF010', l: GND, p: 'PNC', f: '1800*1200_2', t: Date.now(), q: 10, mv: '人工' }], del: [] } }, tk2);
    await sleep(500);
    const st3 = await API('/api/rcs/stations', {}, tk2);
    const s3 = st3.stations.find((x) => x.station === STN2) || {};
    C('S7 ★★★ 安全线：台上仍有账本行(TSF011未搬清)→台保持有货绝不误清', s3.state === '有货', 'state=' + s3.state);

    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) {
    total++; fail++; console.log('❌ 异常：' + e.message + '\n' + String(out).split('\n').slice(-10).join('\n'));
  } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400);
    try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
