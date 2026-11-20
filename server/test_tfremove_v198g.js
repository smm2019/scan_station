// ㉖v198g 拉下架「人已移走收口」+ 站台徽标数据 · 隔离实例端到端
// 用户要求：拉下架仿照检验下架做「人已移走」——填去向格，站台立即释放；
// PDA 站台页叠加检验挂单徽标（数据源=/api/rcs/stations 的 inspOrders/tfLedger）。
// 本套件证明：
//  F组 收口端点：正常送达（账本挂台）→ 改位+整框随改+释台+队列收口+审计；
//     排队中拒收（该走取消）；去向格式/占用校验；无台行=纯释台纠挂；
//     送达后队列项已归档=按 code+station 定位补记（幂等）。
//  G组 徽标数据：inspOrders 点名活跃检验工单；tfLedger 点名台账本挂台的拉下架框。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_tfr198g');
  const PORT = Number(process.env.TR_PORT || (8900 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const STN = 'NB02-CK-05', STN2 = 'NB02-CK-06', GND = 'NB03-A-11-05', FROM = 'NB02-A-08-2F';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_tr', username: 'tr_u', name: '收口测试仓', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Tr#198', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    if (!d0.features.warehouse) d0.features.warehouse = {};
    d0.features.warehouse.agv_control = true; d0.features.warehouse.location_reg = true; d0.features.warehouse.collect = true;
    d0.ledger = [
      { c: 'TRG001', l: STN, p: 'PNA', f: '1800*1200_2', t: Date.now() - 500000 },   // 已送达：账本挂台
      { c: 'TRG002', l: STN, p: 'PNA', f: '1800*1200_2', t: Date.now() - 500000 },   // 同框兄弟码
      { c: 'TRG003', l: 'NB02-B-02-1F', p: 'PNC', f: '1800*1200_2', t: Date.now() - 500000 }, // 排队中任务的起点
      { c: 'TRG004', l: STN2, p: 'PND', f: '1800*1200_2', t: Date.now() - 800000 },  // 送达后队列项已归档的挂台框
    ];
    d0.rcsStations = { [STN]: { station: STN, state: '有货', dir: 'out', label: FROM, codes: ['TRG001', 'TRG002'], via: '5-0777', ts: Date.now() - 480000 }, [STN2]: { station: STN2, state: '有货', dir: 'out', label: 'NB02-B-09-1F', codes: ['TRG004'], via: '5-0666', ts: Date.now() - 780000 } };
    d0.rcsCleared = {}; d0.rcsManual = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {};
    d0.agvQueue = [
      { id: 'q_ok', type: 'transfer', kind: 'shelf2shelf', from: FROM, to: STN, code: 'TRG001', boxKey: 'PNA', state: '已下发', by: '收口测试仓', at: 1794000000111, sentAt: Date.now() - 480000, taskNo: 'WMGK001', trace: [] },
      { id: 'q_q', type: 'transfer', kind: 'shelf2shelf', from: 'NB02-B-02-1F', to: 'NB02-CK-08', code: 'TRG003', boxKey: 'PNC', state: '排队', by: '收口测试仓', at: 1794000000222, trace: [] },
      // TRG004 无队列项（送达后归档被 2 小时窗剪掉的形态）→ 按 code+station 收口
    ];
    d0.inspects = [{ id: 'iq_badge', uid: 'u_tr', code: 'TRG001', from: FROM, station: STN, state: 'atStation', at: Date.now() - 900000, verdict: '' }]; // 徽标：CK-05 检验挂单
    d0.ledgerTomb = []; d0.ledgerFixes = []; d0.ops = []; d0.ledgerEpochAt = 0;
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  const ledOf = async (c, tk) => { const r = await API('/api/ledger?c=' + c, {}, tk); const it = r.items || []; return it.find((x) => String(x.c).toUpperCase() === c) || {}; };
  try {
    C('护栏 实例启动+登录', up, '');
    const tk = up && (await API('/api/login', { method: 'POST', body: { username: 'tr_u', password: 'Tr#198' } }, null)).token;
    C('护栏 token', !!tk, '');

    // ===== G组 徽标数据（先测，收口会改变状态）=====
    const st0 = await API('/api/rcs/stations', {}, tk);
    const s05 = (st0.stations || []).find((x) => x.station === STN) || {};
    C('G1 ★★★ /api/rcs/stations 附 inspOrders：CK-05 检验挂单点名 TRG001', Array.isArray(s05.inspOrders) && s05.inspOrders.some((x) => x.code === 'TRG001' && x.state === 'atStation'), JSON.stringify(s05.inspOrders || []).slice(0, 80));
    C('G2 ★★★ /api/rcs/stations 附 tfLedger：CK-05/06 台账本挂台拉下架框可见', !!s05.tfLedger && (s05.tfLedger.codes || []).includes('TRG001'), JSON.stringify(s05.tfLedger || {}).slice(0, 90));
    const sb = await API('/api/agv/stboard', {}, tk);
    const b06 = (sb.list || []).find((x) => x.code === STN2) || {};
    C('G3 站台看板 tfd 标注：CK-06 待搬 TRG004（无活跃队列项也标）', !!b06.tfd && (b06.tfd.codes || []).includes('TRG004'), JSON.stringify(b06.tfd || {}).slice(0, 90));

    // ===== F组 收口端点 =====
    const bad1 = await API('/api/agv/transfer/remove', { method: 'POST', body: { id: '1794000000222', loc: GND } }, tk); // 排队中
    C('F1 排队中拒收口（该走取消）', bad1.ok === false && /尚未送达/.test(bad1.msg || ''), (bad1.msg || '').slice(0, 40));
    const bad2 = await API('/api/agv/transfer/remove', { method: 'POST', body: { id: '1794000000111', loc: STN } }, tk);
    C('F2 去向填站台被拒', bad2.ok === false && /地面格|货架格/.test(bad2.msg || ''), (bad2.msg || '').slice(0, 40));
    const bad3 = await API('/api/agv/transfer/remove', { method: 'POST', body: { id: '1794000000111', loc: 'NB03-X-99-9999' } }, tk);
    C('F3 去向格式不符被拒', bad3.ok === false, (bad3.msg || '').slice(0, 44));

    const ok1 = await API('/api/agv/transfer/remove', { method: 'POST', body: { id: '1794000000111', loc: GND } }, tk);
    C('F4 ★★★ 正常送达收口成功（账本改位+释放文案齐）', ok1.ok === true && /收口完成/.test(ok1.msg || '') && /整框 2 标签随改/.test(ok1.msg || ''), (ok1.msg || '').slice(0, 80));
    const a1 = await ledOf('TRG001', tk), a2 = await ledOf('TRG002', tk);
    C('F5 ★★★ 账本随单改位+整框兄弟码随改（mv=人工 src=拉下架收口）', String(a1.l).toUpperCase() === GND && String(a2.l).toUpperCase() === GND && a1.mv === '人工' && a1.src === '拉下架收口', 'A1=' + a1.l + ' A2=' + a2.l);
    await sleep(1500);
    const disk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('F6 ★★★ 站台立释：rcsStations 删除 + rcsCleared 防回灌 + rcsDone 压趟', !disk.rcsStations[STN] && (disk.rcsCleared || {})[STN] > 0 && Object.keys(disk.rcsDone || {}).some((k) => k.startsWith(STN + '|')), '');
    const q1 = (disk.agvQueue || []).find((x) => x.id === 'q_ok') || {};
    C('F7 队列项收口完成＋trace 留痕（不再挂"已下发"）', q1.state === '完成' && /人已移走收口/.test((q1.trace || []).join('|')), 'st=' + q1.state);
    C('F8 审计：ledgerFixes act=人工移走 + ops 拉下架移走收口', (disk.ledgerFixes || []).some((f) => f.code === 'TRG001' && f.act === '人工移走') && (disk.ops || []).some((o) => /拉下架移走收口/.test(o.act || '')), '');

    // 送达后队列项已归档：TRG004 按 code+station 收口
    const ok2 = await API('/api/agv/transfer/remove', { method: 'POST', body: { code: 'TRG004', station: STN2, loc: 'NB03-A-11-06' } }, tk);
    await sleep(1500);
    const disk2 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    C('F9 ★★★ 无队列项（归档后）按框号+站台收口：改位+释台', ok2.ok === true && !disk2.rcsStations[STN2], (ok2.msg || '').slice(0, 70));
    const a4 = await ledOf('TRG004', tk);
    C('F10 TRG004 账本改到新地面格', String(a4.l).toUpperCase() === 'NB03-A-11-06', 'l=' + a4.l);

    // 去向格被他人占用 → 拒
    const bad4 = await API('/api/agv/transfer/remove', { method: 'POST', body: { code: 'TRG004', station: STN2, loc: GND } }, tk);
    C('F11 去向格已被占被拒（不覆盖他人）', bad4.ok === false && /已登记给/.test(bad4.msg || ''), (bad4.msg || '').slice(0, 44));
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 80));
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
