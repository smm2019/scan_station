// ㉖v199e 急货入库提醒收紧（用户问"到货提醒逻辑是否有问题"）
// ①尚缺件数闸门：待处理单该行未发满才提醒，已发满(issued合计≥需求)不打扰
// ②归"接单与进度"(req_ready)不再"派单"(req_new)误导
// ③同单同零件 12 小时节流（防账本合并高频连环轰炸）
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_urg199e');
  const PORT = Number(process.env.URG_PORT || (8800 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Ug#199', salt, 32).toString('hex') });
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [mkU('u_wh', 'wh_u', '测试仓管', 'warehouse'), mkU('u_m', 'm_u', '测试物料员', 'material')];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    d0.requisitions = [
      // A 待接单：PNA 需求100 未发 → 新框上账应提醒（shortBy=100）
      { id: 'rA', no: 'LLA', by: 'u_m', byName: '测试物料员', status: 'pending', createdAt: new Date().toISOString(), items: [{ partNo: 'PNA', qty: 100, issued: [] }] },
      // B 备料中：PNB 需求50 已发50 → 盈余新框不应提醒（shortBy=0）
      { id: 'rB', no: 'LLB', by: 'u_m', byName: '测试物料员', status: 'accepted', createdAt: new Date().toISOString(), items: [{ partNo: 'PNB', qty: 50, issued: [{ c: 'OLDX1', q: 50 }] }] },
      // C 已完成：PNC → 已完成单不参与
      { id: 'rC', no: 'LLC', by: 'u_m', byName: '测试物料员', status: 'done', createdAt: new Date().toISOString(), items: [{ partNo: 'PNC', qty: 100, issued: [{ c: 'OLDX2', q: 100 }] }] },
    ];
    d0.ledger = [{ c: 'OLDX1', l: 'NB02-Z-99-1F', p: 'PNB', f: '1800*1200_2', t: Date.now() - 99 * 864e5, q: 50 }, { c: 'OLDX2', l: 'NB02-Z-99-2F', p: 'PNC', f: '1800*1200_2', t: Date.now() - 99 * 864e5, q: 100 }];
    d0.ledgerTomb = []; d0.seenIn = {}; d0.seenOut = {}; d0.watchlist = []; d0.urgentInSeen = {}; d0.notifications = []; d0.ops = [];
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  const syncLedger = async (tk, items) => (await API('/api/ledger/sync', { method: 'POST', body: { items } }, tk)).ok === true;
  const myNotifs = async (tk) => ((await API('/api/notifications/unread', {}, tk)).notifications || []);
  try {
    C('护栏 实例启动', up, '');
    const tk = (await API('/api/login', { method: 'POST', body: { username: 'wh_u', password: 'Ug#199' } }, null)).token;

    // ① 新框 PNA + PNB 同时上账：PNA待处理未发满→提醒；PNB已发满→不提醒
    const ok1 = await syncLedger(tk, [
      { c: 'NPA1', l: 'NB02-A-01-1F', p: 'PNA', f: '1800*1200_2', t: Date.now(), q: 20 },
      { c: 'NPB1', l: 'NB02-A-02-1F', p: 'PNB', f: '1800*1200_2', t: Date.now(), q: 20 },
    ]);
    C('R0 账本同步受理', ok1, '');
    await sleep(300);
    const ns1 = await myNotifs(tk);
    const hitA = ns1.find((n) => /急货入库提醒/.test(String(n.text || '')) && /LLA/.test(String(n.text || '')));
    const hitB = ns1.find((n) => /急货入库提醒/.test(String(n.text || '')) && /LLB/.test(String(n.text || '')));
    C('R1 ★★★ 未发满的待处理单被提醒', !!hitA, '');
    C('R2 ★★★ 已发满(盈余新框)不打扰', !hitB, 'LLB提醒=' + !!hitB);
    C('R3 ★★★ 提醒归 req_ready(接单与进度)非 req_new', hitA && hitA.type === 'req_ready', 'type=' + (hitA || {}).type);
    C('R4 文案带尚缺件数(≈100)', hitA && /尚缺约 100 件/.test(String(hitA.text || '')), String((hitA || {}).text || '').slice(0, 60));

    // ② 节流：再来一个 PNA 新框（同单同零件 12h 内）→ 不重复提醒 LLA
    await syncLedger(tk, [{ c: 'NPA2', l: 'NB02-A-03-1F', p: 'PNA', f: '1800*1200_2', t: Date.now(), q: 20 }]);
    await sleep(300);
    const ns2 = await myNotifs(tk);
    const cntA = ns2.filter((n) => /急货入库提醒/.test(String(n.text || '')) && /LLA/.test(String(n.text || ''))).length;
    C('R5 ★★★ 12小时节流（二次同零件不重复吵）', cntA === 1, 'LLA提醒数=' + cntA);

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
