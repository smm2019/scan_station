// ㉖v198e 拉下架自动选台/手动选台/不可重复下架 · 真实函数+隔离实例证明
// 用户要求：拉下架对齐检验下架规格=①自动分配空闲台 ②手动选台 ③时间线 ④不可重复下架。
// 分层验证：
//  A 组（vm 抽真实 transferFreeStns/tryDispatchTransfer）：自动选台判据、无台排队、
//    串行接力、选台 trace、空 to 不崩 aisleBusy——闸门逻辑必须真跑，静态测不出。
//  B 组（隔离实例真跑 /api/agv/transfer-stations 纯读端点）：清单 ok 分布与占用原因，
//    入库专用台/检验台/有货台/队列占用台 ok=false 带 why，空闲台 ok=true。
//  C 组（静态边界）：端点 AUTO 入参、按框判重、检验占用拒、trace 选台原因、
//    transferFreeStns 与 agvStationFree 不复用理由留档、网页 tfCancel/待自动选台、
//    PDA 三模式/选台清单/展开时间线。
const fs = require('fs'), path = require('path'), vm = require('vm');
const cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8').replace(/\r?\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, 'public', 'console.html'), 'utf8').replace(/\r?\n/g, '\n');
const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'agv_api.dart'), 'utf8').replace(/\r?\n/g, '\n');
let total = 0, fail = 0;
const C = (n, c, i) => { total++; if (!c) { fail++; console.log('FAIL! [' + n + '] ' + (i || '')); } else console.log('PASS [' + n + ']'); };
function grab(name) { const s0 = server.indexOf('function ' + name + '('); if (s0 < 0) throw new Error('未找到 ' + name); const s = s0 >= 6 && server.slice(s0 - 6, s0) === 'async ' ? s0 - 6 : s0; let d = 0, i = server.indexOf('{', s0); for (let j = i; j < server.length; j++) { if (server[j] === '{') d++; else if (server[j] === '}') { d--; if (!d) return server.slice(s, j + 1); } } throw new Error(name + ' 未闭合'); }

// ── A组 vm 真实函数：自动选台 + 串行接力 ──
const DB = { agvQueue: [], rcsStations: {}, rcsManual: {}, inspects: [], stnMeta: {}, ledger: [] };
const PP = { transferConc: 8, aisleCap: 0, manualHoldMin: 30 };
let dispCalls = [];
const ctx = {
  AGV_STNS: Array.from({ length: 12 }, (_, i) => 'NB02-CK-' + String(i + 1).padStart(2, '0')),
  P: () => PP,
  wmasDispatchOne: async (a, tk, o) => { dispCalls.push(o.to); return { ok: true, taskNo: 'T' + dispCalls.length }; },
  DB,
};
vm.createContext(ctx);
ctx.db = DB; // 别名：grab 的函数用裸 db
vm.runInContext(
  'const db = DB;\n' +
  grab('stnMetaOf') + '\n' + grab('stnOff') + '\n' + grab('stnRole') + '\n' + grab('stnAlias') + '\n' +
  grab('aisleBusy') + '\n' + grab('transferFreeStns') + '\n' + grab('tryDispatchTransfer'),
  ctx);
const TFS = () => vm.runInContext('transferFreeStns()', ctx);
const TD = (item, tk, ab, flow) => vm.runInContext('tryDispatchTransfer', ctx).call(ctx, item, tk, ab, flow);
const AB = () => vm.runInContext('aisleBusy()', ctx);

(async () => {
  try {
    // CK-01~04 设入库专用（现场常态）
    DB.stnMeta = { 'NB02-CK-01': { role: 'in' }, 'NB02-CK-02': { role: 'in' }, 'NB02-CK-03': { role: 'in' }, 'NB02-CK-04': { role: 'in' } };
    DB.agvQueue = []; DB.rcsStations = {}; DB.rcsManual = {}; DB.inspects = [];
    const f0 = TFS();
    C('A1 ★★★ 空闲台清单排除入库专用(01~04)，只剩 05~12 通用台', f0.length === 8 && f0[0] === 'NB02-CK-05' && !f0.includes('NB02-CK-01'), f0.join(','));

    // 检验工单占用 CK-07 → 从可用剔除
    DB.inspects = [{ code: 'X1', station: 'NB02-CK-07', state: 'atStation' }];
    const f1 = TFS();
    C('A2 ★★ 检验工单占用台从可用清单剔除', f1.length === 7 && !f1.includes('NB02-CK-07'), f1.join(','));
    // 队列在途占台 CK-08 → 剔除
    DB.agvQueue = [{ type: 'outbound', state: '已下发', station: 'NB02-CK-08', code: 'Y' }];
    const f2 = TFS();
    C('A2b ★★ 队列已下发占台亦剔除', !f2.includes('NB02-CK-08'), f2.join(','));
    // 台面有货 CK-09 → 剔除
    DB.rcsStations = { 'NB02-CK-09': { station: 'NB02-CK-09', state: '有货' } };
    const f3 = TFS();
    C('A2c ★★ 台面有货剔除', !f3.includes('NB02-CK-09'), f3.join(','));
    DB.inspects = []; DB.agvQueue = []; DB.rcsStations = {};

    // 自动选台：空 to + autoStn 项下发 → 选第一个空闲(05) + trace 留痕 + 置已下发
    dispCalls = [];
    {
      const t = { type: 'transfer', kind: 'shelf2shelf', state: '排队', from: 'NB02-A-08-2F', to: '', autoStn: 1, code: 'A1', trace: [] };
      const r = await TD(t, 'tk', AB(), { n: 0 });
      C('A3 ★★★ 自动选台项下发=选第一个空闲台05+置已下发+trace记选台依据', r.ok === true && t.to === 'NB02-CK-05' && t.state === '已下发' && /自动选台/.test((t.trace || []).join()), 'to=' + t.to + ' | ' + (t.trace || []).join(''));
    }
    // 全部通用台被占 → 自动选台项继续排队（不硬发），留 msg
    dispCalls = [];
    {
      DB.agvQueue = ['05', '06', '07', '08', '09', '10', '11', '12'].map((n, i) => ({ type: 'transfer', state: '已下发', to: 'NB02-CK-' + n, code: 'B' + i }));
      const t = { type: 'transfer', kind: 'shelf2shelf', state: '排队', from: 'NB02-A-09-1F', to: '', autoStn: 1, code: 'A2', trace: [] };
      const r = await TD(t, 'tk', AB(), { n: 0 });
      C('A4 ★★★ 无空闲台 → 自动选台项保持排队不硬发（台释放再发）', r.queued === true && t.to === '' && t.state === '排队' && dispCalls.length === 0, JSON.stringify(r) + ' to=' + t.to);
    }
    // 前一趟完成 → 台空 → 下一自动选台项接力
    dispCalls = [];
    {
      DB.agvQueue = ['05', '06', '07', '08', '09', '10', '11'].map((n, i) => ({ type: 'transfer', state: '已下发', to: 'NB02-CK-' + n, code: 'B' + i }));
      const t = { type: 'transfer', kind: 'shelf2shelf', state: '排队', from: 'NB02-A-10-1F', to: '', autoStn: 1, code: 'A3', trace: [] };
      const r = await TD(t, 'tk', AB(), { n: 0 });
      C('A5 ★★ 唯一空台(12)释放 → 自动选台接力到 12', r.ok === true && t.to === 'NB02-CK-12', 'to=' + t.to);
    }
    // 空 to 不污染 aisleBusy（起点巷道计、空终点不计）
    {
      DB.agvQueue = [{ type: 'transfer', state: '已下发', from: 'NB02-C-03-1F', to: '', code: 'Z' }];
      const ab = AB();
      C('A6 ★ 空终点 transfer 不崩 aisleBusy，仅起点巷道计1', ab['NB02-C-03'] === 1 && !Object.keys(ab).some((k) => k === '' || k.startsWith('undefined')), JSON.stringify(ab));
    }
    DB.agvQueue = [];

    // ── B组 隔离实例真跑 /api/agv/transfer-stations 纯读清单 ──
    const crypto = require('crypto');
    const TDIR = path.join(__dirname, '_tdata_ts198e');
    const PORT = Number(process.env.TS_PORT || (8700 + Math.floor(Math.random() * 300)));
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    {
      const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
      const salt = crypto.randomBytes(16).toString('hex');
      d0.users = [{ id: 'u_ts', username: 'ts_u', name: '选台测试仓', role: 'warehouse', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Ts#198', salt, 32).toString('hex') }];
      d0.stnMeta = { 'NB02-CK-01': { role: 'in' }, 'NB02-CK-02': { role: 'in' }, 'NB02-CK-04': { role: 'insp' }, 'NB02-CK-12': { off: true } };
      d0.rcsStations = { 'NB02-CK-06': { station: 'NB02-CK-06', state: '有货' } };
      d0.rcsManual = { 'NB02-CK-07': Date.now() - 60000 };
      d0.inspects = [{ id: 'i1', code: 'INSPECT01', station: 'NB02-CK-08', state: 'atStation', at: Date.now() }];
      d0.agvQueue = [{ id: 'q1', type: 'outbound', state: '已下发', station: 'NB02-CK-09', code: 'OCC09', at: Date.now() }];
      d0.ledger = [{ c: 'TSE2EA01', l: 'NB02-A-08-2F', p: 'PNS1', f: '1800*1200_2', t: Date.now() }]; // 确定性在架框：B10 演算校验命中"指定具体终点"而非"无货"
      d0.agvDispatchMode = 'dry';
      fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
    }
    const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
    let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
    try {
      const tk = up && (await (await fetch('http://127.0.0.1:' + PORT + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ts_u', password: 'Ts#198' }) })).json()).token;
      const j = up && (await (await fetch('http://127.0.0.1:' + PORT + '/api/agv/transfer-stations', { headers: { Authorization: 'Bearer ' + tk } })).json());
      const L = (j && j.list) || [];
      const by = (c) => L.find((x) => x.code === c) || {};
      C('B1 清单端点就绪并返回12台', up && j.ok === true && L.length === 12, 'len=' + L.length);
      C('B2 ★ 入库专用台(01/02) ok=false 原因=入库专用台', by('NB02-CK-01').ok === false && /入库专用/.test(by('NB02-CK-01').why || ''), by('NB02-CK-01').why);
      C('B2b ★ 检验专用台(04) ok=false', by('NB02-CK-04').ok === false && /检验专用/.test(by('NB02-CK-04').why || ''), by('NB02-CK-04').why);
      C('B3 ★ 台面有货(06) ok=false 带原因', by('NB02-CK-06').ok === false && /有货/.test(by('NB02-CK-06').why || ''), by('NB02-CK-06').why);
      C('B4 ★ 人工占用窗(07) ok=false', by('NB02-CK-07').ok === false && /人工占用/.test(by('NB02-CK-07').why || ''), by('NB02-CK-07').why);
      C('B5 ★ 检验工单占台在清单端点被剔除（源码占用来源含检验工单点名；行为剔除见 vm A2）', /检验工单占用（/.test(server) && /for \(const r of db\.inspects/.test(server), '');
      C('B6 ★ 出库队列占用(09) ok=false', by('NB02-CK-09').ok === false && /队列占用/.test(by('NB02-CK-09').why || ''), by('NB02-CK-09').why);
      C('B7 ★ 停用台(12) ok=false', by('NB02-CK-12').ok === false && /停用/.test(by('NB02-CK-12').why || ''), by('NB02-CK-12').why);
      C('B8 ★★★ 唯一真空闲台(05/10/11) ok=true 且进 free 列表', by('NB02-CK-05').ok === true && by('NB02-CK-10').ok === true && by('NB02-CK-11').ok === true && (j.free || []).join(',').includes('NB02-CK-05'), 'free=' + (j.free || []).join(','));
      // 不可重复下架：端点内判重在 dry 前，用起点无货触发更早的400验证链路通（真实判重由 C 组静态兜底）
      const rEmpty = await (await fetch('http://127.0.0.1:' + PORT + '/api/agv/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ from: 'NB02-ZZZ-99-9F', to: '', kind: 'shelf2shelf' }) })).json();
      C('B9 拉下架起点对空终点(自动选台)链路通（无货起点被正确拒回）', rEmpty.ok === false && /无货/.test(rEmpty.msg || ''), rEmpty.msg);
      const rNoCtl = await (await fetch('http://127.0.0.1:' + PORT + '/api/agv/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ from: 'NB02-A-08-2F', to: 'AUTO', kind: 'shelf2shelf', dry: '1' }) })).json();
      C('B10 自动选台在演算模式明确拒（选台下发时现算）', rNoCtl.ok === false && /指定具体终点/.test(rNoCtl.msg || ''), rNoCtl.msg);
      C('★ 实例进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 80));
    } finally {
      srv.kill(); await sleep(400);
      try { fs.rmSync(TDIR, { recursive: true, force: true }); } catch (_) {}
    }

    // ── C组 静态边界 ──
    C('C1 端点接受 AUTO/空终点入参（to=AUTO→空）', /to === 'AUTO'\) to = ''/.test(server), '');
    C('C2 不可重复下架·按框判重（同码或同零件兄弟码+到站态也算进行中；boxKey 存的是零件号，用 _pnD 比对）', /x\.type === 'transfer' && !x\.dry && \['排队', '下发中', '已下发', '到站'\]\.includes\(x\.state\)/.test(server) && /_pnD && String\(x\.boxKey \|\| ''\)\.toUpperCase\(\) === _pnD/.test(server), '');
    C('C2b 兄弟标签码随判重（srcBox.c 或 boxKey 命中即拒）', /String\(srcBox\.c\)\.toUpperCase\(\)/.test(server), '');
    C('C3 检验流程占用框拒拉下架', /正在检验流程中，暂不可拉下架/.test(server), '');
    C('C4 自动选台判据单一实现（transferFreeStns 共享，端点与调度器同调用）', /function transferFreeStns/.test(server) && server.includes('transferFreeStns()') && (server.match(/transferFreeStns\(\)/g) || []).length >= 2, (server.match(/transferFreeStns\(\)/g) || []).length + ' 处调用');
    C('C4b 不复用 agvStationFree 的理由留档（stnUsable out 会误杀 insp 台）', /stnUsable\('out'\)|stnUsable\(s, ''\)/.test(server) || /insp 专用台判死|检验·入库/.test(server), '');
    C('C5 自动选台 trace 留痕（谁选的、依据什么，进时间线）', /自动选台 .*（下发时刻空闲口径/.test(server), '');
    C('C6 手动选台清单端点存在（transfer-stations，判据同源）', /p === '\/api\/agv\/transfer-stations'/.test(server), '');
    C('C7 网页移库取消入口（tfCancel + 队列控制台按钮）', /async function tfCancel/.test(html) && html.includes('qTfCancel(q)'), '');
    C('C7b 网页空终点显示待自动选台', html.includes('待自动选台'), '');
    C('C8 PDA 移库表单三模式（自动/手动选台/货架格）', /toMode = 0/.test(dart) && dart.includes('手动选CK站台') && dart.includes('自动分配空闲台'), '');
    C('C9 PDA 手动选台清单（占用台 enabled=false 带原因灰显）', /agvTransferStations/.test(dart) && /enabled: s\["ok"\] == true/.test(dart), '');
    C('C10 PDA 移库卡展开时间线（ExpansionTile + trace 逐条）', /ExpansionTile/.test(dart) && /暂无调度留痕/.test(dart), '');

    console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.log('❌ 异常：' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n'));
    process.exit(1);
  }
})();
