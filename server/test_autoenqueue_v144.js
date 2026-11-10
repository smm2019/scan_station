// ㉖v144 接单即派文案点名"被占框" · 实例证明
// 现场疑问（LL2026111011092779）：接单即派提示"1 个货架框已加入AGV队列"，实际盖章集 4 框——
// 另 3 框接单那一刻正在执行入库上架任务（队列非终态），去重规则正确跳过（防两车抢一框），
// 但旧文案不说去向，被误读成漏派。改进：autoEnqueueOnAccept 返回 {n, skip}，文案带
// "（另 N 框正在上架/盘点任务中，完成后扫码发料自动叫车）"；且 n=0 但 skip>0 时也推送（旧版静默）。
// 证明面（真实 HTTP 走接单接口，读落库 history 断言文案）：
//  A1 部分占用：4框盖章集3框在队 → "1 个货架框已加入AGV队列（另 3 框…）"
//  A2 入队实况：新出库队列项恰1个(auto=1 排队)，agvCalled 恰1条
//  A3 全部占用：n=0 skip=4 → 旧版此处静默，新版推送 "0 个…（另 4 框…）"
//  A4 无占用：n=4 skip=0 → 文案无括号（回归旧格式）
//  A5 源码锚点：返回对象化、nAuto 残留清零、v126 严重超发守卫行未被波及
//  Z  服务日志无未捕获异常
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_auto派_v144'.replace('auto派', 'autoenqueue')), PORT = 8416, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_ae', username: 'ae_wh', name: '即派仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Ae!144', salt) });
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0, receivingOn: 0 });
delete db0.rcsConfig; delete db0.wmasConfig; db0.agvDispatchMode = 'dry';
const PN = '88AE144001';
const ledBox = (c, l) => ({ c, l, f: '1600*1100', t: now - 3 * 864e5, p: PN, n: '即派件', q: 150, b: '2026-11-07', pid: '', mv: '人工', src: '', by: '即派仓管', rec: now, hist: [] });
const mkReq = (id, no) => ({ id, no, by: 'u_ae', byName: '即派仓管', status: 'pending', createdAt: new Date(now - 600000).toISOString(), items: [{ partNo: PN, itemName: '即派件', qty: 600, issued: [], agvCalled: [], sugCodes: [] }], history: [] });
const busyQ = (code) => ({ id: 'bq_' + code, code, type: 'inbound', state: '已下发', fromLoc: 'NB02-CK-01', station: '', reqNo: '', wmsTask: 'T-' + code, at: now - 60000, updAt: now - 30000 });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = 0, total = 0;
const chk = (n, g, w) => { total++; const ok = JSON.stringify(g) === JSON.stringify(w); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(g)).slice(0, 200)} want=${String(JSON.stringify(w)).slice(0, 200)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v144 接单即派文案证明');
  const req = async (method, p, tk, body) => { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
  try {
    const tk = (await req('POST', '/api/login', null, { username: 'ae_wh', password: 'E2e#Ae!144' })).json.token;
    chkT('L0 登录成功', !!tk, '');
    // 每场景：重启前直改副本库不可（服务不重读盘），改走"重置库→接口接单"三步：用写盘+服务重启太重；
    // 这里利用服务对 db 的内存态=启动快照，改为【一次装料三张单+预置队列】方案：
    // rq1 场景A1/A2：4框全在架，队列预置 3 框在途（busyQ 42/43/44）
    // rq2 场景A3：另一零件 PN2 4框全在架，队列预置 4 框全在途
    // rq3 场景A4：第三零件 PN3 4框全在架，队列无预置
    // ——但服务已启动，需先造库再启动：故上面先写盘启动，此段改为重启一次（kill+spawn 带新库）
    srv.kill('SIGKILL');
    fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
    fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
    const d2 = JSON.parse(fs.readFileSync(path.join(SRC, 'db.json'), 'utf8'));
    d2.users.push({ id: 'u_ae', username: 'ae_wh', name: '即派仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#Ae!144', salt) });
    d2.params = Object.assign(d2.params || {}, { reqHoursOn: 0, receivingOn: 0 });
    delete d2.rcsConfig; delete d2.wmasConfig; d2.agvDispatchMode = 'dry';
    const PN2 = '88AE144002', PN3 = '88AE144003';
    const ledBox2 = (c, l, p) => ({ c, l, f: '1600*1100', t: now - 3 * 864e5, p, n: '即派件', q: 150, b: '2026-11-07', pid: '', mv: '人工', src: '', by: '即派仓管', rec: now, hist: [] });
    d2.ledger = (d2.ledger || []).filter((x) => String(x.p || '') !== PN && String(x.p || '') !== PN2 && String(x.p || '') !== PN3);
    ['A1', 'A2', 'A3', 'A4'].forEach((i2) => d2.ledger.push(ledBox2('CODE1' + i2, 'NB02-B-0' + (5 + Number(i2.slice(1))) + '-1F', PN)));
    ['B1', 'B2', 'B3', 'B4'].forEach((i2) => d2.ledger.push(ledBox2('CODE2' + i2, 'NB02-D-0' + (5 + Number(i2.slice(1))) + '-1F', PN2)));
    ['C1', 'C2', 'C3', 'C4'].forEach((i2) => d2.ledger.push(ledBox2('CODE3' + i2, 'NB02-F-0' + (5 + Number(i2.slice(1))) + '-1F', PN3)));
    const mkR = (id, no, pn) => ({ id, no, by: 'u_ae', byName: '即派仓管', status: 'pending', createdAt: new Date(now - 600000).toISOString(), items: [{ partNo: pn, itemName: '即派件', qty: 600, issued: [], agvCalled: [], sugCodes: [] }], history: [] });
    d2.requisitions = (d2.requisitions || []).filter((x) => !['rq_ae1', 'rq_ae2', 'rq_ae3'].includes(x.id));
    d2.requisitions.push(mkR('rq_ae1', 'LLAE14400001', PN), mkR('rq_ae2', 'LLAE14400002', PN2), mkR('rq_ae3', 'LLAE14400003', PN3));
    d2.agvQueue = (d2.agvQueue || []).filter((x) => !/^CODE[12]/.test(String(x.code || '')));
    ['CODE1A2', 'CODE1A3', 'CODE1A4'].forEach((c) => d2.agvQueue.push(busyQ(c))); // 场景1：3框在途
    ['CODE2B1', 'CODE2B2', 'CODE2B3', 'CODE2B4'].forEach((c) => d2.agvQueue.push(busyQ(c))); // 场景3：4框全在途
    fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(d2));
    const srv2 = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    const log2 = []; srv2.stdout.on('data', (b) => log2.push(String(b))); srv2.stderr.on('data', (b) => log2.push(String(b)));
    let up2 = false; for (let i = 0; i < 40 && !up2; i++) { await sleep(250); try { up2 = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
    if (!up2) { console.log('FAIL! 第二实例未就绪'); srv2.kill(); process.exit(1); }
    const req2 = async (method, p, tk2, body) => { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(tk2 ? { Authorization: 'Bearer ' + tk2 } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const tk2 = (await req2('POST', '/api/login', null, { username: 'ae_wh', password: 'E2e#Ae!144' })).json.token;
    // 场景1：部分占用 → 接单
    const a1 = await req2('POST', '/api/requisitions/rq_ae1/accept', tk2, {});
    chkT('S1a 接单成功', a1.json.ok === true, JSON.stringify(a1.json).slice(0, 140));
    await sleep(900);
    let dbEnd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    let r1 = (dbEnd.requisitions || []).find((x) => x.id === 'rq_ae1');
    const h1 = (r1.history || []).map((x) => String(x.text)).find((t) => /接单即派/.test(t)) || '';
    chkT('A1 文案含"1 个货架框已加入AGV队列（另 3 框正在上架/盘点任务中"', /^接单即派：1 个货架框已加入AGV队列（另 3 框正在上架\/盘点任务中，完成后扫码发料自动叫车）$/.test(h1), h1);
    const newQ = (dbEnd.agvQueue || []).filter((x) => x.reqNo === 'LLAE14400001' && x.auto === 1);
    chk('A2 新出库队列项恰1个(CODE1A1 排队)', [newQ.length, newQ[0] && newQ[0].code, newQ[0] && newQ[0].state], [1, 'CODE1A1', '排队']);
    chk('A2b agvCalled 恰1条且为未占框', [(r1.items[0].agvCalled || []).length, (r1.items[0].agvCalled || [])[0] && r1.items[0].agvCalled[0].c], [1, 'CODE1A1']);
    // 场景3：全部占用 → n=0 skip=4 也要推送（旧版静默）
    await req2('POST', '/api/requisitions/rq_ae2/accept', tk2, {});
    await sleep(900);
    dbEnd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const r2 = (dbEnd.requisitions || []).find((x) => x.id === 'rq_ae2');
    const h2 = (r2.history || []).map((x) => String(x.text)).find((t) => /接单即派/.test(t)) || '';
    chkT('A3 全占用旧版静默→新版推送"0 个…（另 4 框…）"', /^接单即派：0 个货架框已加入AGV队列（另 4 框正在上架\/盘点任务中，完成后扫码发料自动叫车）$/.test(h2), h2);
    // 场景4：无占用 → 4框全派，文案无括号
    await req2('POST', '/api/requisitions/rq_ae3/accept', tk2, {});
    await sleep(900);
    dbEnd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const r3 = (dbEnd.requisitions || []).find((x) => x.id === 'rq_ae3');
    const h3 = (r3.history || []).map((x) => String(x.text)).find((t) => /接单即派/.test(t)) || '';
    chk('A4 无占用文案=旧格式无括号', h3, '接单即派：4 个货架框已加入AGV队列');
    chk('A4b 4框全部入队', (dbEnd.agvQueue || []).filter((x) => x.reqNo === 'LLAE14400003' && x.auto === 1).length, 4);
    // 日志实况
    chkT('A5 服务日志含 skip 计数输出', /接单即派入队 1 框，另 3 框被搬运任务占用本轮不派/.test(log2.join('')), log2.join('').match(/\[auto派\][^\n]*/g) ? log2.join('').match(/\[auto派\][^\n]*/g).join(' | ').slice(0, 160) : '无');
    srv2.kill('SIGKILL');
    // 源码锚点
    const sj = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    chkT('A6 返回对象化与调用方解构在位', sj.includes('return { n, skip: skipBusy };') && sj.includes('const auto = autoEnqueueOnAccept') && sj.includes('if (auto.n > 0 || auto.skip > 0)'), '');
    chkT('A7 nAuto 残留清零', !/nAuto/.test(sj), '');
    chkT('A8 v126 严重超发守卫未被波及', sj.includes('if (_needQ > 0 && _accQ - _needQ >= _needQ)'), '');
    const uncaught = (log.join('') + log2.join('')).split('\n').filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
    chkT('Z 服务日志无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 200));
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); try { srv.kill('SIGKILL'); } catch (_) {} try { srv2.kill('SIGKILL'); } catch (_) {} }
  fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v144 接单即派文案实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
