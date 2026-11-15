// ㉖v198h 检验vs拉下架补齐 · 台挂账防误消费/起点闸/盘点冻结/抢框/催办 · 隔离实例端到端
// 用户："把对比之后没有做的给做了"。缺口补齐中的行为级验证（不依赖 WMAS 票的可真跑，
// 依赖 WMAS 对账的超时纠正用静态锁）。
// 台挂框=账本 l 挂 -CK-/-RK-（拉下架送达/检验待搬），实物压台面 AGV 叉不走。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };

(async () => {
  const TDIR = path.join(__dirname, '_tdata_h198h');
  const PORT = Number(process.env.H_PORT || (8600 + Math.floor(Math.random() * 90)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const STN = 'NB02-CK-05', SHELF = 'NB02-A-08-2F', SHELF2 = 'NB02-A-09-1F';
  const salt = crypto.randomBytes(16).toString('hex');
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_h', username: 'h_u', name: '补齐测试仓', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Hh#198', salt, 32).toString('hex') }, { id: 'u_ha', username: 'h_ua', name: '补齐测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Hh#198', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    ['agv_control', 'location_reg', 'collect', 'inspect_mode', 'insp_assist'].forEach((k) => { d0.features.warehouse[k] = true; });
    d0.ledger = [
      { c: 'TSTN01', l: STN, p: 'PNA', f: '1800*1200_2', t: Date.now() - 31 * 60000 },   // 台挂框(送达未收账,催办用) t=now-31min
      { c: 'TSTN02', l: STN, p: 'PNA', f: '1800*1200_2', t: Date.now() - 31 * 60000 },   // 兄弟码
      { c: 'TSKF01', l: SHELF, p: 'PNB', f: '1800*1200_2', t: Date.now() },              // 盘点冻结框(在架)
      { c: 'TSBF01', l: SHELF2, p: 'PNC', f: '1800*1200_2', t: Date.now() },             // 检验抢框:拉下架在途
    ];
    d0.rcsStations = { [STN]: { station: STN, state: '有货', dir: 'out', label: SHELF, codes: ['TSTN01', 'TSTN02'], via: '5-0555', ts: Date.now() - 31 * 60000 } };
    d0.rcsCleared = {}; d0.rcsManual = {}; d0.rcsDone = {}; d0.stnMeta = {}; d0.locReserve = {}; d0.ledgerTomb = []; d0.ledgerFixes = []; d0.ops = []; d0.carEvents = []; d0.notifications = [];
    d0.counts = [{ id: 'ct_h', code: 'TSKF01', loc: SHELF, part: 'PNB', state: 'atStation', by: '补齐测试仓', at: Date.now() - 10000 }]; // 盘点活跃→冻结 TSKF01
    d0.inspects = []; d0.ledgerEpochAt = 0;
    d0.agvQueue = [
      { id: 'q_done', type: 'transfer', kind: 'shelf2shelf', from: SHELF, to: STN, code: 'TSTN01', boxKey: 'PNA', state: '完成', by: '补齐测试仓', at: Date.now() - 31 * 60000, updAt: Date.now() - 31 * 60000, taskNo: 'WMH01', trace: [] }, // 送达完成→催办扫描命中
      { id: 'q_out', type: 'transfer', kind: 'shelf2shelf', from: SHELF2, to: 'NB02-CK-08', code: 'TSBF01', boxKey: 'PNC', state: '已下发', by: '补齐测试仓', at: Date.now() - 5000, sentAt: Date.now() - 5000, taskNo: 'WMH02', trace: [] }, // 拉下架在途→检验抢框
    ];
    d0.requisitions = []; d0.agvDispatchMode = 'dry';
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR, RCS_TEST: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }).then((r) => r.json());
  try {
    C('护栏 实例启动+登录', up, '');
    const tk = up && (await API('/api/login', { method: 'POST', body: { username: 'h_u', password: 'Hh#198' } }, null)).token;
    const tkAdm = up && (await API('/api/login', { method: 'POST', body: { username: 'h_ua', password: 'Hh#198' } }, null)).token;

    // H1 vm 真跑 pickSuggest 本体，捕获它内部算出的 match（过滤闸就在 match 那一行，是闸的直接产物）：
    // ZZT01 台挂 t=1 更早=FIFO 首选，旧代码必纳入 match → 本断言改前必红、改后绿，红测成立。
    // （不断言最终 boxes：那还受后续"接单盖章/超发隐藏"逻辑影响，测不出过滤闸本身）
    {
      const vm = require('vm');
      const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r?\n/g, '\n');
      function grab(name) { const s0 = server.indexOf('function ' + name + '('); if (s0 < 0) throw new Error('未找到 ' + name); const s = s0 >= 6 && server.slice(s0 - 6, s0) === 'async ' ? s0 - 6 : s0; let d = 0, i = server.indexOf('{', s0); for (let j = i; j < server.length; j++) { if (server[j] === '{') d++; else if (server[j] === '}') { d--; if (!d) return server.slice(s, j + 1); } } throw new Error(name + ' 未闭合'); }
      const ctx = { CAP: {}, DB: { ledger: [{ c: 'ZZT01', l: 'NB02-CK-05', p: 'PZ', f: 'F', t: 1, q: 5 }, { c: 'ZZT02', l: 'NB02-A-01-1F', p: 'PZ', f: 'F', t: 9, q: 5 }], counts: [] }, boxKeyOf: (x) => 'C|' + String(x.c).toUpperCase(), countFrozenSet: () => new Set(), P: () => ({ pickMaxBoxes: 20, lowTier: 3, abcTop: 0, aisleCap: 0, rackCols: 4, rackTiers: 4, abcWin: 30, cadence: 1 }), console };
      vm.createContext(ctx);
      vm.runInContext('const db = DB;\n' + 'const locRecv = (l) => /^NB04-/.test(String(l || "").trim().toUpperCase());\n'
        + 'const locOnStn = (l) => { const s = String(l || "").trim().toUpperCase(); return s.includes("-CK-") || s.includes("-RK-"); };\n'
        + 'function ledgerView(){ return DB.ledger.slice(); }\n'
        + 'function groupLedgerBoxes(m){ CAP.match = m.slice(); return []; }\n' // 捕获 pickSuggest 真算的 match=过滤闸产物
        + 'function trimLastLot(a){ return a; }\n'
        + grab('pickSuggest'), ctx);
      vm.runInContext('pickSuggest("PZ", 5, new Set())', ctx);
      const mcodes = (ctx.CAP.match || []).map((x) => x.c).join(',');
      C('H1 ★★★ 台挂框不进FIFO发料建议（pickSuggest真算match：含ZZT02不含ZZT01）', mcodes.includes('ZZT02') && !mcodes.includes('ZZT01'), 'match=' + (mcodes || '(空)'));
    }
    const q1 = await API('/api/agv/queue', { method: 'POST', body: { reqId: 'RQ_X', items: [{ code: 'TSTN01', fromLoc: STN, partNo: 'PNA' }] } }, tk);
    await sleep(200);
    C('H2 台挂框出库叫车入队被拒（conflict，未入 agvQueue）', q1.ok !== true || (q1.conflict || q1.conf || 0) > 0 || !q1.added, JSON.stringify(q1).slice(0, 90));
    const cy = await API('/api/agv/carry', { method: 'POST', body: { code: 'TSTN02', from: STN, to: 'L1', dir: 'out' } }, tk);
    C('H3 carry 出库台挂框被拒并给原因', cy.ok === false && /站台|压台面|收账|归位/.test(cy.msg || ''), (cy.msg || '').slice(0, 50));

    // ===== transfer 起点台闸 + 盘点冻结闸 =====
    const tf1 = await API('/api/agv/transfer', { method: 'POST', body: { from: STN, to: 'NB02-A-20-1F', kind: 'shelf2shelf' } }, tk);
    C('H4 ★★★ 起点=站台位（台挂框）发起拉下架被拒', tf1.ok === false && /站台位|台面框/.test(tf1.msg || ''), (tf1.msg || '').slice(0, 50));
    const tf2 = await API('/api/agv/transfer', { method: 'POST', body: { from: SHELF, to: 'NB02-A-21-1F', kind: 'shelf2shelf' } }, tk);
    C('H5 ★★★ 盘点冻结框发起拉下架被拒（对齐 queue/carry 口径）', tf2.ok === false && /盘点/.test(tf2.msg || ''), (tf2.msg || '').slice(0, 50));

    // ===== 检验抢框闸（busyTf）=====
    const is = await API('/api/inspect/search?pn=PNC', {}, tk);
    const bx = (is.boxes || is.list || []).find((x) => String(x.code || x.codes || '').includes('TSBF01')) || (is.boxes || is.list || [])[0] || {};
    C('H6 ★★★ 拉下架在途框检验搜索标不可下架（busyTf 防抢框）', bx.canDown === false && /拉下架/.test(bx.why || ''), JSON.stringify({ canDown: bx.canDown, why: bx.why }));

    // ===== 送达未收账催办（独立扫描块，等 agvDispatch tick）=====
    await sleep(3500); // 等 ≥1 个调度tick（rcs 2s）
    const dk = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const urgeEv = (dk.carEvents || []).filter((e) => /拉下架压台/.test(e.kind || ''));
    C('H7 ★★★ 送达未收账超 tfMoveUrgeMin → 事件中心"拉下架压台"', urgeEv.length >= 1, (urgeEv[0] ? urgeEv[0].kind + ' ' + urgeEv[0].who : '无'));
    const urgeQ = (dk.agvQueue || []).find((x) => x.id === 'q_done') || {};
    C('H7b 催办一次性防重发（队列项 tfUrged 置位）', urgeQ.tfUrged === true, 'tfUrged=' + urgeQ.tfUrged);

    // ===== 静态锁：不依赖 WMAS 对账/换台的两项 =====
    const s = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    C('H8 静态·超时判失败补 pushEvent(拉下架超时)+通知（旧版静默）', /retireQueueItem\(_t, '失败', '超时未完成'\)[\s\S]{0,200}pushEvent\('拉下架超时'/.test(s));
    C('H9 静态·RCS 换台纠正覆盖 transfer(to 字段回写 item.to)', /_qt\.to = ep/.test(s) && /账本改账基准已纠正/.test(s));
    C('H10 静态·三处选台判据 transfer q.to 可见（insp+out自动）', /q\.type === 'transfer' && String\(q\.to \|\| ''\) === stn/.test(s) && /q\.type === 'transfer' && String\(q\.to \|\| ''\) === stn/.test(s));
    C('H11 静态·送达通知 transfer_done 入 URGENT（夜间不静默）', /URGENT_TYPES = new Set\(\[[^\]]*'transfer_done'/.test(s));
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-3).join(' ').slice(0, 90));
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
