// ㉖v202c 退料回流框发料豁免（N26K100080 生产事故复刻：11-16发料转MES→11-18退料重扫回库→11-19
// 再开单扫发料被历史出库单 DT20261116161506 拦"已在出库单·禁止重复出库"发不出去）
// 修复=server.js 2726 out闸：inOutbound 且【账本不在架】才拦；账本在架=退料已闭环回流→放行。
// 判据（scan 8525 调用 labelBlockReason('out')，报错是否停在"已在出库单"精确对应本闸）：
//   账本在架(退料回流) → 越过闸(报错不再含"已在出库单", 推进到后段零件号/件数)
//   账本不在架(出库途中未回) → 死在闸(报"已在出库单"=未回流不放行, 防双发双转MES)
// 注：scan 端点后续还有 FIFO建议/件数/MES 等 PDA 完整协议闸（与本修复无关），裸API不追求发料落账
//     全成功，只用"是否还卡在已在出库单"精确验证本闸；scanCheck(同源 labelBlockReason) 作独立佐证。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
(async () => {
  const TDIR = path.join(__dirname, '_tdata_reissue202c');
  const PORT = Number(process.env.RI_PORT || (9950 + Math.floor(Math.random() * 30)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const mkU = (id, un, nm, role) => ({ id, username: un, name: nm, role, enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Ri#202', salt, 32).toString('hex') });
  const now = Date.now(), D = 864e5;
  const mkReq = (id, no, items) => ({ id, no, by: 'u_m', byName: '领料员', status: 'accepted', createdAt: new Date(now - 36e5).toISOString(), items, history: [] });
  const d0 = {
    users: [mkU('u_w', 'ri_w', '仓管测试', 'warehouse'), mkU('u_m', 'ri_m', '领料员', 'material')],
    features: {}, sessions: {}, devices: {}, ops: [], exports: [], inventories: [], agvQueue: [], carEvents: [], ledgerTomb: [], inspects: [], params: { strictFifo: 0 },
    ledger: [
      { c: 'RT0080', l: 'NB02-E-14-1F', p: 'PNRT', n: '回流件', q: 48, t: now - D, by: '宋明明' },   // 退料回流（账本在架）
      { c: 'RT0081', l: 'NB02-E-14-2F', p: 'PNRT2', n: '双回流件', q: 60, t: now - D, by: '宋明明' }, // 回流2次仍账本在架
      // RT0082 故意无账本行（出库途中未回）
    ],
    scanlog: {
      'RT0080|B2|2': { code: 'RT0080', wt: 1, gl: 'NB02-E-14-1F', t: now - D, cx: false, pn: 'PNRT', q: 48, op: '宋明明' },
      'RT0081|B1|3': { code: 'RT0081', wt: 1, gl: 'NB02-E-14-2F', t: now - D, cx: false, pn: 'PNRT2', q: 60, op: '宋明明' },
    },
    seenOut: { RT0080: { at: now - 3 * D, no: 'LL-OLD-1', by: '刘向轩' }, RT0081: { at: now - 5 * D, no: 'LL-OLD-2', by: '刘向轩' }, RT0082: { at: now - 2 * D, no: 'LL-OLD-3', by: '刘向轩' } },
    outbound: {
      OB1: { orderNo: 'DT-OLD-1', createdAt: now - 3 * D, operator: '刘向轩', items: [{ code: 'PNRT', barcode: 'RT0080', qty: 48 }] },
      OB2: { orderNo: 'DT-OLD-2', createdAt: now - 5 * D, operator: '刘向轩', items: [{ code: 'PNRT2', barcode: 'RT0081', qty: 60 }] },
      OB3: { orderNo: 'DT-OLD-3', createdAt: now - 2 * D, operator: '刘向轩', items: [{ code: 'PNRT3', barcode: 'RT0082', qty: 30 }] },
    },
    requisitions: [
      // ★生产真实：退料回流框不仅挂历史出库单，还挂在旧领料单 issued[]（LL2026111615381828 同款）——
      // 上轮测试漏建此记录，才没暴露第二道 inIssued 闸。done 历史单 issued 含该码=inIssued 非空。
      { id: 'ro1', no: 'LL-OLD-A', by: 'u_m', byName: '领料员', status: 'done', createdAt: new Date(now - 3 * D).toISOString(), items: [{ partNo: 'PNRT', qty: 48, transferred: true, issued: [{ c: 'RT0080', q: 48, l: 'NB02-E-14-1F' }] }], history: [] },
      { id: 'ro4', no: 'LL-OLD-D', by: 'u_m', byName: '领料员', status: 'done', createdAt: new Date(now - 2 * D).toISOString(), items: [{ partNo: 'PNRT4', qty: 30, transferred: true, issued: [{ c: 'RT0083', q: 30, l: 'NB02-E-15-1F' }] }], history: [] }, // RT0083 无账本行(未回库)+历史发料=反证靶
      mkReq('r1', 'LL-NEW-1', [{ partNo: 'PNRT', qty: 48, issued: [] }]),
      mkReq('r2', 'LL-NEW-2', [{ partNo: 'PNRT2', qty: 60, issued: [] }]),
      mkReq('r3', 'LL-NEW-3', [{ partNo: 'PNRT3', qty: 30, issued: [] }]),
      mkReq('r4', 'LL-NEW-4', [{ partNo: 'PNRT4', qty: 30, issued: [] }]),
    ],
  };
  fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = async (p2, body, tk) => { const r = await fetch('http://127.0.0.1:' + PORT + p2, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  const lg = async (un) => (await API('/api/login', { username: un, password: 'Ri#202' })).json.token;
  const scan = async (reqId, code, tk) => { const _p = { r1: 'PNRT', r2: 'PNRT2', r3: 'PNRT3', r4: 'PNRT4' }[reqId] || '', _q = { RT0080: 48, RT0081: 60, RT0082: 30, RT0083: 30 }[code] || 0; return (await API('/api/requisitions/' + reqId + '/scan', { barcode: code, partNo: _p, qty: _q }, tk)).json; };
  try {
    const tkW = up && await lg('ri_w');
    C('护栏 启动+仓管登录', up && !!tkW, '');
    // ⓪ 同源正向佐证（所有发料动作之前查）：RT0080 账本在架+【历史出库单+历史领料发料双挂】
    //   (生产 LL2026111615381828 同款形态) → 两道闸都按"账本在架=已闭环回流"放行, 非 block
    const v0 = await API('/api/outbound/scanCheck?c=RT0080', null, tkW);
    C('T0 ★同源scanCheck正向: 双挂历史记录的账本在架框 level 非 block', v0.json.ok === true && v0.json.level !== 'block', 'level=' + v0.json.level + ' ' + String(v0.json.reason || '').slice(0, 40));
    // ① 生产链路：退料回流框(账本在架, 双挂历史出库单+历史发料) → scan 两道闸全越过并发料成功
    const s1 = await scan('r1', 'RT0080', tkW);
    C('T1 ★★★ 退料回流框(双挂历史): scan 越过两闸并成功发料（生产事故完整复刻）', s1.ok === true, 'msg=' + (s1.msg || '（成功发料）').slice(0, 40));
    // ② ★反证A：账本无行+历史出库单 → 仍死在"已在出库单"（豁免以账本在架为唯一前提）
    const s4 = await scan('r3', 'RT0082', tkW);
    C('T2 ★★★ 反证A：未回流框(无账本行)仍拦"已在出库单"', s4.ok !== true && /已在出库单/.test(s4.msg || ''), (s4.msg || '').slice(0, 50));
    // ②b ★反证B（本轮第二道闸）：账本无行+历史领料发料 → 仍死在"已发料到领料单"
    const s6 = await scan('r4', 'RT0083', tkW);
    C('T2b ★★★ 反证B：未回流框(无账本行)有历史发料仍拦"已发料到领料单"', s6.ok !== true && /已发料到领料单/.test(s6.msg || ''), (s6.msg || '').slice(0, 50));
    // ③ 回流2次框(账本在架) → 同样越过闸并发料成功（回流闭环次数不限）
    const s5 = await scan('r2', 'RT0081', tkW);
    C('T3 双回流框(账本在架)：scan 越过闸并发料成功', s5.ok === true, 'msg=' + (s5.msg || '（成功发料）').slice(0, 40));
    C('★ 无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 80));
  } catch (e) { total++; fail++; console.log('❌ 异常：' + e.message); } finally {
    try { srv.kill(); } catch (_) {}
    await sleep(400); try { srv.kill('SIGKILL'); } catch (_) {}
    try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （隔离副本，生产库零写入）');
  process.exit(fail ? 1 : 0);
})();
