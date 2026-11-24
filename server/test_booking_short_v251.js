// ㉖v251 预约自定义筐数 + 不够数也开单 · 端到端取证（真实 HTTP 打隔离实例）
// 需求：①预订筐数支持自定义任意正整数（1~9999 服务端口径）
//      ②不够数也开单：a) 预约人手动"不够数先开单"按实际到料开单并结束本轮
//                    b) 勾选后超期望日一有到料自动按实际数结算
//                    c) 零到料拒开（0件无意义） d) 未勾选的超期预约仍只进度通知不开单（对照）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_short_v251');
const PORT = 8417, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v51mt', username: 'v251_mt', name: 'V251预订人', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V5!mt', salt) });
db0.users.push({ id: 'u_v51wh', username: 'v251_wh', name: 'V251仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V5!wh', salt) });
const fmtD = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);
const P1 = '88V251A001', P2 = '88V251A002', P3 = '88V251A003', P4 = '88V251A004';
db0.watchlist = (db0.watchlist || []).concat([
  { userId: 'u_v51mt', partNo: P1, itemName: 'V251手动先开单', qty: 5, auto: true, due: fmtD(1), shortOk: true, at: now - 1000, got: 0, filledReq: '' },  // 期望日在明天：到料只进度通知→测手动 fill
  { userId: 'u_v51mt', partNo: P2, itemName: 'V251零到料', qty: 4, auto: true, due: fmtD(1), shortOk: true, at: now - 1000, got: 0, filledReq: '' },      // 零到料 fill 拒开
  { userId: 'u_v51mt', partNo: P3, itemName: 'V251超期结算', qty: 5, auto: true, due: fmtD(-1), shortOk: true, at: now - 1000, got: 0, filledReq: '' },    // 超期望日+shortOk：一有到料自动结算
  { userId: 'u_v51mt', partNo: P4, itemName: 'V251对照', qty: 3, auto: true, due: fmtD(-1), shortOk: false, at: now - 1000, got: 0, filledReq: '' },       // 未勾选：超期也只通知不开单
]);
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p, tk) { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(got)).slice(0, 200)} want=${String(JSON.stringify(want)).slice(0, 200)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { SELFTEST_NO_LIVE: '1', ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v251 自定义筐数+不够数先开单证明');
  try {
    const wh = (await post('/api/login', null, { username: 'v251_wh', password: 'E2e#V5!wh' })).json.token;
    const mt = (await post('/api/login', null, { username: 'v251_mt', password: 'E2e#V5!mt' })).json.token;
    const occ = new Set(db0.ledger.map((x) => String(x.l || '').toUpperCase()));
    const freeRack = []; for (const z of ['A', 'B', 'C', 'D']) for (let r = 16; r >= 1 && freeRack.length < 6; r--) for (const f of ['4F', '3F']) { const k = `NB02-${z}-${String(r).padStart(2, '0')}-${f}`; if (!occ.has(k)) freeRack.push(k); }
    const reqsOf = async (pn) => { const j = (await get('/api/requisitions', mt)).json; const list = Array.isArray(j) ? j : (j.reqs || j.list || []); return list.filter((r) => (r.items || []).some((i) => String(i.partNo || '').toUpperCase() === pn)); };
    const wlOf = async (pn) => { const j = (await get('/api/watchlist', mt)).json; return ((j.list || []).find((x) => String(x.partNo).toUpperCase() === pn) || {}); };
    const push = (pn, nm, rows) => post('/api/ledger/sync', wh, { items: rows.map((r, i) => ({ c: r.c, l: r.l, p: pn, n: nm, q: 300, b: new Date().toISOString().slice(0, 10), t: Date.now(), mv: '登记', src: 'E2E', pid: '' })) });
    // ===== S1 自定义筐数：接口存 17 筐 + shortOk 落库回显；改约不带 shortOk 即清除 =====
    const s1 = await post('/api/watchlist', mt, { partNo: '88V251A005', qty: 17, auto: true, due: '', shortOk: true });
    chk('S1a 自定义 17 筐落库', [s1.json.ok === true, Number(s1.json.entry && s1.json.entry.qty), s1.json.entry && s1.json.entry.shortOk], [true, 17, true]);
    chk('S1b 列表回显 shortOk', (await wlOf('88V251A005')).shortOk, true);
    await post('/api/watchlist', mt, { partNo: '88V251A005', qty: 17, auto: true, due: '' });
    chk('S1c 改约不带 shortOk→false（不残留）', (await wlOf('88V251A005')).shortOk, false);
    // ===== S2 手动不够数先开单：到2/5框→fill→按600件开单、本轮结束，后再到货不重复开 =====
    const p1a = [{ c: 'V251A10001', l: freeRack[0] }, { c: 'V251A10002', l: freeRack[1] }];
    chkT('S2a 推2框上账', (await push(P1, 'V251手动先开单', p1a)).json.ok === true, '');
    await sleep(1500);
    chk('S2b 进度累计 arrived=2 未开单', [(await wlOf(P1)).arrived, (await reqsOf(P1)).length], [2, 0]);
    const f2 = await post('/api/watchlist/fill', mt, { partNo: P1 });
    chkT('S2c 手动先开单接口成功', f2.json.ok === true, JSON.stringify(f2.json).slice(0, 120));
    const r2 = await reqsOf(P1);
    chk('S2d 开单件数=600（2框×300 件数口径）', r2.length === 1 && r2[0].items[0].qty, 600);
    chkT('S2e 单头标注手动', String((r2[0] || {}).remark || '').includes('本人手动'), String((r2[0] || {}).remark || '').slice(0, 120));
    chk('S2f 本轮结束 done+filledShort', [(await wlOf(P1)).done, (await wlOf(P1)).filledShort], [true, true]);
    chkT('S2g 再推1框不重复开单', (await push(P1, 'V251手动先开单', [{ c: 'V251A10003', l: freeRack[2] }])).json.ok === true, '');
    await sleep(1500);
    chk('S2h 本轮结束后 reqs 仍 1 张', (await reqsOf(P1)).length, 1);
    // ===== S3 零到料 fill 拒开 =====
    const f3 = await post('/api/watchlist/fill', mt, { partNo: P2 });
    chk('S3 零到料拒开', [f3.status, f3.json.ok === true, String(f3.json.msg || '').includes('还没有到料')], [400, false, true]);
    // ===== S4 超期望日自动结算：due 已过，推2框→scan 直接按实际数先开单 =====
    chkT('S4a 推2框上账', (await push(P3, 'V251超期结算', [{ c: 'V251A20001', l: freeRack[3] }, { c: 'V251A20002', l: freeRack[4] }])).json.ok === true, '');
    await sleep(1500);
    const r4 = await reqsOf(P3);
    chk('S4b 超期一有到料自动先开单 600 件', r4.length === 1 && r4[0].items[0].qty, 600);
    chkT('S4c 单头标注超期望日自动结算', String((r4[0] || {}).remark || '').includes('超期望日自动结算'), String((r4[0] || {}).remark || '').slice(0, 120));
    chk('S4d 本轮结束 filledShort', (await wlOf(P3)).filledShort, true);
    // ===== S5 对照：未勾选 shortOk 的超期预约到料仍只通知不开单（旧行为不变） =====
    chkT('S5a 推1框上账', (await push(P4, 'V251对照', [{ c: 'V251A30001', l: freeRack[5] }])).json.ok === true, '');
    await sleep(1500);
    chk('S5b 未勾选→不开单（旧行为）', [(await reqsOf(P4)).length, (await wlOf(P4)).done], [0, false]);
    chkT('S5c 服务日志含手动/自动两条先开单记录', log.join('').includes(P1 + ' 不够数先开单') && log.join('').includes(P3 + ' 不够数先开单'), '');
    console.log(`\n结果：${total - fail}/${total} 通过` + (fail ? ` —— FAIL! ${fail} 条` : ' ✅'));
    process.exitCode = fail ? 1 : 0;
  } catch (e) { console.log('FAIL! 异常', e); process.exitCode = 1; } finally { srv.kill(); }
})();
