// ㉖v137 领料员三件套 · 实例证明
// 用户诉求：从领料员角度把功能做得更实用更强大。数据实锤三痛点：48h 同人同零件快速复购418次(凭记忆补单)、
// done 行 9% 短装无人追补、在途已现同人同零件重复单。落地=补料建议(前算)+短装追补(后补)+重复在途提示(中拦)。
// 证明面：
//  S组 建议接口 /api/requisitions/suggest 口径（夹具确定性数字，真实 HTTP 隔离实例）：
//    S1 关开关 on=0 返回空清单
//    S2 断供件(stock0 无在途)：days=0 排最前、建议框数走"出库均值回退"(perBoxSrc=outbound)
//    S3 低库存件：days=(在架)/日均<cover 告急、perBoxSrc=stock
//    S4 充足件：days>=cover 不入清单
//    S5 在途抵扣：open 单未发件计入余量→够撑不告急（防重复建议已在路上的量）
//    S6 部分在途：need 扣在途后再算建议框数
//    S7 排序：最急先，同 0 天按日均降序
//    S8 win/cover 回显=参数值
//  P组 PDA 三件套源码锚点（建议弹层/追补缺口/重复警示接入）
//  Z组 服务日志无未捕获异常
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_req3_v137');
const PORT = 8402, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v37', username: 'v137_mt', name: 'V137线边', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V37!mt', salt) });
db0.params = Object.assign(db0.params || {}, { reqSuggestOn: 1, reqSuggestDays: 14, reqSuggestCover: 3 });
// 纯净夹具：清空生产 outbound/ledger/requisitions（否则继承的136个真实告急件把测试件挤出 top30 截断，断言不可控）
db0.outbound = {}; db0.ledger = []; db0.requisitions = []; db0.seenOut = {};
const obAt = now - 7 * 864e5; // 窗口内(近14天)
const obItem = (code, qty, barcode) => ({ code, qty, barcode, name: '件' + code });
db0.outbound = db0.outbound || {};
// PN_A 断供：出库 2 框×700=1400 → 日均100；无账本无在途 → days0，回退均值700→建议 ceil(300/700)=1
db0.outbound['OBA'] = { orderNo: 'OBA', createdAt: obAt, items: [obItem('PNA', 700, 'BX1'), obItem('PNA', 700, 'BX2')] };
// PN_B 低库存：出库140→日均10；账本1框×20=20 → days2<3 告急，perBox stock=20→建议 ceil(10/20)=1
db0.outbound['OBB'] = { orderNo: 'OBB', createdAt: obAt, items: [obItem('PNB', 140, 'BX3')] };
// PN_C 充足：出库140→日均10；账本10框×100=1000 → days100 不告急
db0.outbound['OBC'] = { orderNo: 'OBC', createdAt: obAt, items: [obItem('PNC', 140, 'BX4')] };
// PN_D 在途抵扣：出库140→日均10；账本0；open单未发40 → days4 不告急
db0.outbound['OBD'] = { orderNo: 'OBD', createdAt: obAt, items: [obItem('PND', 140, 'BX5')] };
// PN_E 部分在途：出库140→日均10；账本1框×5=5；open单未发10 → days1.5<3 告急，need=ceil(30-5-10)=15，perBox stock=5→建议 ceil(15/5)=3
db0.outbound['OBE'] = { orderNo: 'OBE', createdAt: obAt, items: [obItem('PNE', 140, 'BX6')] };
const led = (c, l, p, q, n, pid) => ({ c, l, f: '', t: now, p, n, q, b: 'B137', pid, mv: '人工', src: '', by: 'V137仓管', rec: now, hist: [] });
db0.ledger = (db0.ledger || []).concat([
  led('LB1', 'NB02-A-01-1F', 'PNB', 20, '低库存件', 'PB1'),
  led('LC1', 'NB02-A-02-1F', 'PNC', 100, '充足件', 'PC1'), led('LC2', 'NB02-A-02-2F', 'PNC', 100, '充足件', 'PC2'), led('LC3', 'NB02-A-03-1F', 'PNC', 100, '充足件', 'PC3'), led('LC4', 'NB02-A-03-2F', 'PNC', 100, '充足件', 'PC4'), led('LC5', 'NB02-A-04-1F', 'PNC', 100, '充足件', 'PC5'), led('LC6', 'NB02-A-04-2F', 'PNC', 100, '充足件', 'PC6'), led('LC7', 'NB02-A-05-1F', 'PNC', 100, '充足件', 'PC7'), led('LC8', 'NB02-A-05-2F', 'PNC', 100, '充足件', 'PC8'), led('LC9', 'NB02-A-06-1F', 'PNC', 100, '充足件', 'PC9'), led('LC10', 'NB02-A-06-2F', 'PNC', 100, '充足件', 'PC10'),
  led('LE1', 'NB02-A-07-1F', 'PNE', 5, '部分在途件', 'PE1'),
]);
db0.requisitions = (db0.requisitions || []).concat([
  { id: 'rqD', no: 'LLDUP0001', by: 'u_v37', byName: 'V137线边', status: 'pending', createdAt: new Date(now).toISOString(), items: [{ partNo: 'PND', itemName: '在途抵扣件', qty: 40, issued: [] }] },
  { id: 'rqE', no: 'LLE1000001', by: 'u_v37', byName: 'V137线边', status: 'accepted', createdAt: new Date(now).toISOString(), items: [{ partNo: 'PNE', itemName: '部分在途件', qty: 10, issued: [] }] },
]);
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 150)} want=${String(JSON.stringify(w)).slice(0, 150)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v137 领料三件套证明');
  try {
    const tk = (await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v137_mt', password: 'E2e#V37!mt' }) })).json()).token;
    const sug = async () => (await (await fetch(BASE + '/api/requisitions/suggest', { headers: { Authorization: 'Bearer ' + tk } })).json());
    const j = await sug();
    const find = (pn) => (j.list || []).find((x) => x.pn === pn) || null;
    chkT('S8 win/cover 回显=参数(14/3)', [j.win, j.cover, j.on], [14, 3, 1]);
    // S2 断供件
    const a = find('PNA');
    chkT('S2 断供件入清单 days=0', a && a.days === 0 && a.stock === 0, JSON.stringify(a));
    chk('S2b 断供件建议框数走出库均值回退(1框,perBox700,outbound)', a && [a.boxes, a.perBox, a.perBoxSrc], [1, 700, 'outbound']);
    // S3 低库存
    const b = find('PNB');
    chkT('S3 低库存件 days=2<3 告急', b && b.days === 2, JSON.stringify(b));
    chk('S3b 低库存件 perBoxSrc=stock 建议1框', b && [b.perBox, b.perBoxSrc, b.boxes], [20, 'stock', 1]);
    // S4 充足件不入清单
    chk('S4 充足件(PNC days100)不入清单', find('PNC'), null);
    // S5 在途抵扣够撑不告急
    chk('S5 在途抵扣件(PND days4)不入清单', find('PND'), null);
    // S6 部分在途 need 扣在途
    const e = find('PNE');
    chkT('S6 部分在途件 days=1.5 告急', e && e.days === 1.5 && e.transit === 10, JSON.stringify(e));
    chk('S6b 部分在途 need=15(=30-5-10) 建议3框', e && [e.need, e.boxes], [15, 3]);
    // S7 排序：清单内 PNA(0天) 必在 PNB(2天)/PNE(1.5天) 之前
    const order = (j.list || []).map((x) => x.pn);
    chkT('S7 最急先：PNA 排 PNB/PNE 前', order.indexOf('PNA') >= 0 && order.indexOf('PNA') < order.indexOf('PNE') && order.indexOf('PNE') < order.indexOf('PNB'), order.join(','));
    // S1 关开关返回空（独立第二实例：服务不重读盘，运行中改盘无效，须新进程载 on=0）
    {
      const T2 = path.join(__dirname, 'data_e2e_req3_v137_off');
      fs.rmSync(T2, { recursive: true, force: true }); fs.cpSync(TDIR, T2, { recursive: true });
      const dd = JSON.parse(fs.readFileSync(path.join(T2, 'db.json'), 'utf8')); dd.params.reqSuggestOn = 0; fs.writeFileSync(path.join(T2, 'db.json'), JSON.stringify(dd));
      const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: '8403', HOST: '127.0.0.1', DATA_DIR: T2 }, stdio: ['ignore', 'pipe', 'pipe'] });
      let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch('http://127.0.0.1:8403/api/health')).ok; } catch (_) {} }
      const tk2 = (await (await fetch('http://127.0.0.1:8403/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v137_mt', password: 'E2e#V37!mt' }) })).json()).token;
      const j2 = (await (await fetch('http://127.0.0.1:8403/api/requisitions/suggest', { headers: { Authorization: 'Bearer ' + tk2 } })).json());
      chkT('S1 关开关 on=0 且清单空', j2.on === 0 && (j2.list || []).length === 0, JSON.stringify(j2).slice(0, 80));
      srv2.kill('SIGKILL'); fs.rmSync(T2, { recursive: true, force: true });
    }
    // P组 PDA 锚点
    const dart = fs.readFileSync(path.join(__dirname, '..', 'lib', 'requisition_page.dart'), 'utf8');
    const auth = fs.readFileSync(path.join(__dirname, '..', 'lib', 'app_auth.dart'), 'utf8');
    chkT('P1 API 层接入建议端点', auth.includes('reqSuggest') && auth.includes('/api/requisitions/suggest'), '');
    chkT('P2 建单页入口芯片+弹层方法', dart.includes('🧠 补料建议') && dart.includes('_showSugSheet'), '');
    chkT('P3 弹层断供件走预约分流', dart.includes('已断供 · 建议预约到货') && dart.includes('watchlistSet'), '');
    chkT('P4 短装追补按钮(仅done且有缺口)', dart.includes('补齐缺口') && dart.includes("st == 'done'") && dart.includes('_issuedQtyOf'), '');
    chkT('P5 重复在途警示(本人未完结单命中)', dart.includes('openByPn') && dart.includes('已在途未完结') && dart.includes('重复下单会占用仓管产能'), '');
    chkT('P6 建议加入复用框数预填通道', dart.includes('_qtyCtrl[pn] = TextEditingController(text: "$boxes")') && dart.includes('_syncChosen(pn)'), '');
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = log.join('').split('\n').filter((s) => /uncaught|referenceerror|typeerror|syntaxerror/i.test(s));
  chkT('Z 服务日志无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 200));
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v137 领料三件套实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
