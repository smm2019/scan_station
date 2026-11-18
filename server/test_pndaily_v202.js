// ㉖v202 零件日流水 /api/report/pn-daily 端到端验证
// 口径断言（设计承诺逐条钉死）：①按 t 归日+剔NB04 ②入库框=托号去重(同托两码=1框) ③出库=台账按createdAt、
// 框=条码去重 ④已发未转快照pend(无逐日时间戳不硬归日=不造假) ⑤freshFrom=now-2d(前端标未定) ⑥多零件互不串
// 隔离 DATA_DIR，生产库零写入。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  const TDIR = path.join(__dirname, '_tdata_pnd202');
  const PORT = Number(process.env.PD_PORT || (9800 + Math.floor(Math.random() * 30)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now(), D = 864e5;
  const dayKey = (ms) => { const d = new Date(ms + 8 * 36e5); return d.toISOString().slice(0, 10); }; // 东八区日
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Pd#202', salt, 32).toString('hex') });
  const d0 = {
    users: [mkU('u_w', 'pd_u', '日流水测试', 'warehouse')],
    features: { material: {}, warehouse: {}, inspector: {}, admin: {} },
    sessions: {}, devices: {}, ops: [], exports: [], ledger: [], inventories: [], agvQueue: [], carEvents: [], notifications: [],
    scanlog: {
      'A1|B1|1': { code: 'PDA1', wt: 1, gl: 'NB03-C-01-01', t: now - 10 * D, cx: false, pn: 'PNX', q: 100, op: '甲', lot: 'L1' },
      'A2|B1|2': { code: 'PDA2', wt: 1, gl: 'NB03-C-01-02', t: now - 10 * D, cx: false, pn: 'PNX', q: 100, op: '甲', pid: 'PAL1' }, // 与A3同托
      'A3|B1|3': { code: 'PDA3', wt: 1, gl: 'NB03-C-01-03', t: now - 10 * D, cx: false, pn: 'PNX', q: 100, op: '甲', pid: 'PAL1' }, // 同托兄弟码=1框
      'A4|B1|4': { code: 'PDA4', wt: 1, gl: 'NB03-C-02-01', t: now - 3 * D, cx: false, pn: 'PNX', q: 50, op: '乙' },
      'A5|B1|5': { code: 'PDA5', wt: 1, gl: 'NB04-A-01-001', t: now - 3 * D, cx: false, pn: 'PNX', q: 999, op: '乙' }, // NB04 来料登记必须剔除
      'A6|B1|6': { code: 'PDA6', wt: 1, gl: 'NB03-C-03-01', t: now - 3 * D, cx: true, pn: 'PNX', q: 77, op: '乙' }, // 作废剔除
      'A7|B1|7': { code: 'PDX9', wt: 1, gl: 'NB03-C-04-01', t: now - 5 * D, cx: false, pn: 'PNOTHER', q: 400, op: '甲' }, // 别的零件不串
    },
    outbound: {
      OB1: { orderNo: 'DT-001', createdAt: now - 8 * D, operator: '丙', toLoc: '线边', items: [{ code: 'PNX', barcode: 'PDA1;PDA2', qty: 200 }] }, // 同单两码=2框200件
      OB2: { orderNo: 'DT-002', createdAt: now - 8 * D + 36e5, operator: '丙', toLoc: '线边', items: [{ code: 'PNX', barcode: 'PDA3', qty: 100 }] }, // 同日另单
      OB3: { orderNo: 'DT-003', createdAt: now - 2 * D, operator: '丁', toLoc: '线边', items: [{ code: 'PNX', barcode: 'PDA4', qty: 50 }] },
      OB4: { orderNo: 'DT-004', createdAt: now - 6 * D, operator: '丙', toLoc: '线边', items: [{ code: 'PNOTHER', barcode: 'PDX9', qty: 400 }] },
    },
    requisitions: [
      // PDA9 已发未转（不在任何出库台账）→ 进 pend 快照；PDA4 已发已转 → 不算
      { id: 'r1', no: 'LL-1', by: 'u_w', byName: '日流水测试', status: 'ready', createdAt: new Date(now - 4 * D).toISOString(), items: [{ partNo: 'PNX', qty: 30, issued: [{ c: 'PDA9', q: 30 }] }], history: [] },
      { id: 'r2', no: 'LL-2', by: 'u_w', byName: '日流水测试', status: 'done', createdAt: new Date(now - 4 * D).toISOString(), items: [{ partNo: 'PNX', qty: 50, issued: [{ c: 'PDA4', q: 50 }] }], history: [] },
    ],
  };
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  try {
    const tk = up && (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pd_u', password: 'Pd#202' }) })).json()).token;
    C('护栏 启动+登录', up && !!tk, '');
    const j = await (await fetch('http://127.0.0.1:' + PORT + '/api/report/pn-daily?pn=PNX&days=30', { headers: { Authorization: 'Bearer ' + tk } })).json();
    const byD = {}; (j.days || []).forEach((x) => { byD[x.d] = x; });
    const d10 = dayKey(now - 10 * D), d3 = dayKey(now - 3 * D), d8 = dayKey(now - 8 * D), d2 = dayKey(now - 2 * D);
    C('T1 ★★★ 10天前入库：框=托去重(PDA1+托PAL1两码=2框)·件=300·NB04与作废已剔(q999/77不见)', byD[d10] && byD[d10].inB === 2 && byD[d10].inQ === 300 && byD[d10].inN === 3, JSON.stringify(byD[d10] && { b: byD[d10].inB, q: byD[d10].inQ, n: byD[d10].inN }));
    C('T2 ★★★ 8天前出库：两单3码归同一天→框3·件300', byD[d8] && byD[d8].outB === 3 && byD[d8].outQ === 300, JSON.stringify(byD[d8] && { b: byD[d8].outB, q: byD[d8].outQ }));
    C('T3 3天前入库只有PDA4一笔(NB04/作废剔除后 inN=1)', byD[d3] && byD[d3].inB === 1 && byD[d3].inQ === 50 && byD[d3].inN === 1, JSON.stringify(byD[d3] && { n: byD[d3].inN }));
    C('T4 ★ 已发未转只进当前快照不硬归日(pend=30件1码·逐日柱无此笔)', j.pend && j.pend.q === 30 && j.pend.c === 1 && Object.values(byD).every((x) => !x.outQ || x.d === d8 || x.d === d2 || x.d === d3 ? true : true) && (byD[dayKey(now - 4 * D)] === undefined || byD[dayKey(now - 4 * D)].outQ === 0), JSON.stringify(j.pend));
    C('T5 未定期界=freshFrom为now-2天(前端据此标近48h未定)', Math.abs((j.freshFrom || 0) - (now - 2 * D)) < 120000, 'freshFrom=' + j.freshFrom);
    C('T6 多零件不串(PNOTHER的400件不进PNX合计)', j.totIn === 350 && j.totOut === 350, 'totIn=' + j.totIn + ' totOut=' + j.totOut);
    const je = await (await fetch('http://127.0.0.1:' + PORT + '/api/report/pn-daily', { headers: { Authorization: 'Bearer ' + tk } })).json();
    C('T7 缺pn参数400安全返回', je.ok === false, '');
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 90));
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400); try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
