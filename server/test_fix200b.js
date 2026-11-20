// ㉖v200b 两项修复端到端实证：
// ① #79 库存页"滞留时长(批次)"排序键 t→_h：旧键 t 入库时刻同日全平局→乱序(截图 27天排到44天前)；
//    新键 _h=ctHourB(批次锚点) 数值。行为证明=从 console.html 抽 ctHourB/sortArr 纯函数进 vm 跑真数据。
// ② #80 月度对账包预览"仓库运营看板(0行)"空白 → preview 出口 renderBoardText 拍平 sections 为二维表。
const fs = require('fs'), path = require('path'), crypto = require('crypto'), vm = require('vm'), cp = require('child_process');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + i + ']' : ''}`); };
// 从 console.html 抠指定函数源码（花括号配对），注入 vm 跑（不依赖 DOM 的纯函数）
function grabFn(src, sig) {
  const i = src.indexOf(sig); if (i < 0) return null;
  let j = src.indexOf('{', i), d = 0, k = j;
  for (; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) break; } }
  return src.slice(i, k + 1);
}

(async () => {
  const TDIR = path.join(__dirname, '_tdata_fix200b');
  const PORT = Number(process.env.FX_PORT || (9100 + Math.floor(Math.random() * 80)));
  fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('hex');
  const now = Date.now(), D = 864e5;

  // ══ #79 静态+行为证明（纯前端，无需服务器）══
  const H = fs.readFileSync(path.join(__dirname, 'public/console.html'), 'utf8');
  C('R1 ★★★ 排序键已从 t 改为 _h（滞留列）', /sTh\(TM\.cs,'_h','滞留时长\(批次\)',1,'csT'\)/.test(H), '');
  C('R2 旧键 t 不再挂在该列', !/sTh\(TM\.cs,'t','滞留时长/.test(H), '');
  {
    const fHour = grabFn(H, 'function ctHour(x)');
    const fHourB = grabFn(H, 'function ctHourB(x)');
    const fSort = grabFn(H, 'function sortArr(A,st)');
    C('R3 抽出 ctHour/ctHourB/sortArr 三个纯函数', !!(fHour && fHourB && fSort), '');
    const ctx = { Date, Math, Number, String };
    vm.createContext(ctx);
    vm.runInContext(fHour + '\n' + fHourB + '\n' + fSort, ctx);
    // 复现截图：入库日全同（旧键 t 平局），批次滞留 44天 vs 27天 不同
    const boxes = [
      { l: 'NB03-F-05-05', bt: now - 27 * D, t: now - 10 * D },  // 27 天批
      { l: 'NB03-F-05-06', bt: now - 44 * D, t: now - 10 * D },  // 44 天批
      { l: 'NB03-F-05-07', bt: now - 44 * D, t: now - 10 * D },  // 44 天批
      { l: 'NB02-D-01-2F', bt: now - 27 * D, t: now - 10 * D },  // 27 天批
    ];
    // vm 脚本顶层无 arguments（不是函数体）——数据须挂上下文再调用
    for (const b of boxes) { ctx.__b = b; b._h = vm.runInContext('ctHourB(__b)', ctx); }
    const hs = boxes.map((b) => b._h);
    C('R4 ★ _h 全为数值（排序器走数值比较的前提）', hs.every((h) => typeof h === 'number' && isFinite(h)), hs.join(','));
    C('R5 ★ 44天与27天 _h 差≈17天（>15天，真区分非近似）', Math.max(...hs) - Math.min(...hs) > 15 * 24, 'max-min=' + (Math.max(...hs) - Math.min(...hs)));
    C('R6 ★ 旧键 t 全平局（这就是错排根因，钉死）', new Set(boxes.map((b) => b.t)).size === 1, '唯一t数=' + new Set(boxes.map((b) => b.t)).size);
    ctx.__boxes = boxes; // 同上：数据挂上下文，不用 arguments
    const desc = vm.runInContext('sortArr(__boxes,{k:"_h",d:-1})', ctx);
    const asc = vm.runInContext('sortArr(__boxes,{k:"_h",d:1})', ctx);
    C('R7 ★★★ 按_h降序：44天(660h+)排在27天前（截图错序已反）', desc[0]._h > desc[desc.length - 1]._h && desc[0]._h >= 43 * 24, desc.map((b) => Math.round(b._h / 24) + '天').join('>'));
    C('R8 ★★★ 按_h升序：27天排在44天前', asc[0]._h < asc[asc.length - 1]._h, asc.map((b) => Math.round(b._h / 24) + '天').join('<'));
    // 反证：旧键 t 排序完全乱序（t 全同，sortArr 返回 0 保持原序 → 展示 27/44/44/27 原序）
    const byT = vm.runInContext('sortArr(__boxes,{k:"t",d:-1})', ctx);
    const tSeq = byT.map((b) => Math.round(b._h / 24));
    C('R9 反证旧键t排序不产生单调序列（这就是用户看到的乱）', !tSeq.every((v, i) => i === 0 || tSeq[i - 1] >= v), tSeq.join(','));
  }

  // ══ #80 服务器预览拍平（HTTP 实证）══
  {
    const d0 = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
    d0.users = [{ id: 'u_ad', username: 'ad_u', name: '测试管理', role: 'admin', enabled: true, createdAt: new Date().toISOString(), mustChangePw: false, salt, passHash: crypto.scryptSync('Fx#200', salt, 32).toString('hex') }];
    d0.features = JSON.parse(JSON.stringify(d0.features || {}));
    d0.itemDict = { PN001: { nm: '左前大灯' }, PN002: { nm: '保险杠' } };
    d0.ledger = [
      { c: 'AA01', l: 'NB03-F-05-05', p: 'PN002', f: '托盘', t: now - 10 * D, q: 500 },
      { c: 'AA02', l: 'NB02-D-01-2F', p: 'PN001', f: '1800*1200_2', t: now - 40 * D, q: 315 },
      { c: 'AA03', l: 'NB02-A-04-3F', p: 'PN001', f: '1800*1200_2', t: now - 1 * D, q: 90 },
    ];
    d0.ledgerTomb = [];
    d0.scanlog = { 'AA03|B3|3': { code: 'AA03', wt: 0, st: 'NB02-CK-06', gl: '', t: now - 1 * D, cx: false, batch: 'B3', pn: 'PN001', q: 90, op: '测试管理' } };
    d0.outbound = { OB1: { orderNo: 'OB1', createdAt: now - 2 * D, operator: '测试管理', toLoc: '线边', items: [{ code: 'PN002', barcode: 'AA01', qty: 20 }] } };
    d0.requisitions = [{ id: 'r1', no: 'LL01', by: 'u_ad', byName: '测试管理', status: 'pending', createdAt: new Date(now - 1 * D).toISOString(), items: [{ partNo: 'PN001', qty: 100, issued: [] }], history: [] }];
    d0.agvQueue = [{ type: 'outbound', fromLoc: 'NB02-D-01-2F', code: 'AA02', state: '完成', at: now - 2 * D, sentAt: now - 2 * D, updAt: now - 2 * D, wmsTask: 'T1' }];
    d0.carEvents = [{ ts: now - 2 * D, kind: '告警', who: 'AGV06', msg: '障碍物' }];
    d0.rcsRun = []; d0.inventories = {}; d0.exports = []; d0.ops = []; d0.seenIn = {}; d0.seenOut = {};
    d0.params = Object.assign({}, d0.params || {});
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d0));
  }
  let srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch('http://127.0.0.1:' + PORT + '/api/health')).ok; } catch (_) {} }
  let out = ''; srv.stdout.on('data', (d) => { out += d; }); srv.stderr.on('data', (d) => { out += d; });
  const API = (p, o = {}, tk) => fetch('http://127.0.0.1:' + PORT + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  try {
    const lk = await API('/api/login', { method: 'POST', body: { username: 'ad_u', password: 'Fx#200' } }, null);
    const tk = up && (await lk.json()).token;
    C('R10 护栏 实例启动+登录', up && !!tk, '');
    const j = await (await API('/api/export?ds=PACK&preview=1', {}, tk)).json();
    C('R11 PACK 预览 200', j.ok === true, '');
    const boardSheet = (j.sheets || []).find((s) => /看板/.test(s.name));
    C('R12 ★★★ 看板 sheet 预览行数>0（此前 0 行=空白）', !!boardSheet && boardSheet.rows > 20, 'rows=' + (boardSheet ? boardSheet.rows : 'null'));
    C('R13 ★★★ sample 有内容且含看板结构（此前前0行）', Array.isArray(j.sample) && j.sample.length > 5 && j.sample.some((r) => String(r.join('')).includes('▍')), 'sample=' + (j.sample || []).length + '行');
    const flat = (j.sample || []).map((r) => r.join(' ')).join('\n');
    C('R14 ★ KPI 区块与核心指标进了 sample（入库框/呆滞/占用）', /核心指标|入库框数/.test(flat) && /呆滞|占用率/.test(flat), '');
    C('R15 数据条/表格结构进了 sample（周吞吐或人员效率）', /周吞吐|人员效率|库区占用/.test(flat), '');
    C('R16 对账四表计数不受影响', (j.sheets || []).some((s) => /库位表/.test(s.name) && s.rows > 0) && (j.sheets || []).some((s) => /入库流水/.test(s.name) && s.rows > 0), (j.sheets || []).map((s) => s.name + ':' + s.rows).join(' / '));
    // 下载路径回归：预览改动不动导出，XML 仍良构
    const r = await API('/api/export?ds=PACK&fmt=xls', {}, tk);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('Content-Type') || '';
    // ㉖v201b PACK 已由 SpreadsheetML(.xls) 升级为原生图表 .xlsx 二进制（ZIP），调用方 fmt 不再决定档次。
    // 旧断言用 ET.parse 校 XML 已随格式演进过时（在 ZIP 上必报 not well-formed）；改锁下载出口返回合法 xlsx 二进制。
    const isZip = buf.slice(0, 4).toString('hex') === '504b0304';
    C('R17 ★★★ PACK 下载出口返回合法 xlsx 二进制（ZIP 魔数+正确 MIME，预览拍平不破坏下载）', r.ok === true && isZip && /spreadsheetml\.sheet/.test(ct), 'status=' + r.status + ' zip=' + isZip + ' ct=' + ct.slice(0, 50));
    C('★ 无看板装配失败日志', !/运营看板装配失败/.test(out), out.split('\n').filter((l) => /board|preview/.test(l)).slice(-2).join(' ').slice(0, 80));
    C('★ 进程无未捕获异常', !/Unhandled|TypeError: |ReferenceError/.test(out), out.split('\n').slice(-2).join(' ').slice(0, 80));
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
