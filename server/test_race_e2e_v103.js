// ㉖v103 撤扫竞态修复 · 端到端取证（真实 HTTP 打隔离实例）
// 覆盖：①启动存量迁移修正事故行(400→200/剔框/撤承诺/留痕) ②补建不坐实在库框
//      ③转单回写按实传框记账(竞态加回框自动回滚) ④撤扫即时应答+账面同步复位 ⑤二次启动幂等
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_race_v103');
const PORT = 8332, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users.push({ id: 'u_race', username: 'e2e_race_wh', name: 'E2E竞态', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Race!pw', salt) });
delete db0.reqRaceFixedV103; // 副本清开关：主库若已迁移过，继承开关会让隔离实例短路
// 注入测试单（accepted 未转单，不受启动迁移影响）：
// 行1 88E2ERACE1：issued=[X(100件,账本在架=竞态加回), Y(200件,已消位=真实发出)]，PDA 只转 Y
// 行2 88E2ERACE2：issued=[Z(50件,已消位)]，测撤扫即时应答+账本复挂
const occ = new Set(db0.ledger.map((x) => String(x.l || '').toUpperCase()));
const LX = ['NB02-A-16-4F', 'NB02-B-16-4F', 'NB02-C-16-4F', 'NB02-D-16-4F'].filter((l) => !occ.has(l));
if (LX.length < 2) { console.log('FAIL! 需两个空货位'); process.exit(1); }
const LZ = LX[1]; // Z 撤扫复挂位（必须真空，否则"原位被占不复挂"分支干扰 D5）
db0.ledger.push({ c: 'E2ERACE0X', l: LX[0], f: '1800*1200_2', t: Date.now(), p: '88E2ERACE1', n: 'E2E竞态件X', q: 100, b: '2026-11-03', pid: '', mv: '登记', src: 'E2E', by: 'E2E竞态' });
db0.requisitions.push({ id: 'rq_e2e_race', no: 'LL-E2E-RACE-1', by: 'u_race', byName: 'E2E竞态', status: 'accepted', acceptedBy: 'E2E竞态', acceptedAt: new Date().toISOString(), createdAt: new Date().toISOString(), toLoc: { WAREHOUSE_NAME: '焊-宁波-线边仓', DISTRICT_NAME: 'A109', LOC_NAME: 'A109-1' }, rush: false, note: '', history: [], items: [
  { partNo: '88E2ERACE1', itemName: 'E2E竞态件', qty: 300, issued: [{ c: 'E2ERACE0X', q: 100, l: LX[0], b: '2026-11-03', f: '1800*1200_2', n: 'E2E竞态件X' }, { c: 'E2ERACE0Y', q: 200, l: 'NB02-E-16-4F', b: '2026-11-03', f: '1800*1200_2', n: 'E2E竞态件Y' }], transferred: false, skipped: false, agvCalled: [] },
  { partNo: '88E2ERACE2', itemName: 'E2E撤扫件', qty: 999, issued: [{ c: 'E2ERACE0Z', q: 50, l: LZ, b: '2026-11-03', f: '1800*1200_2', n: 'E2E撤扫件Z' }], transferred: false, skipped: false, agvCalled: [] },
] });
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
function startSrv() { const sv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] }); const log = []; sv.stdout.on('data', (b) => log.push(b.toString())); sv.stderr.on('data', (b) => log.push(b.toString())); sv.__log = () => log.join(''); return sv; }
async function waitUp() { for (let i = 0; i < 40; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) {} } return false; }
const load = () => JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
(async () => {
  let srv = startSrv();
  if (!(await waitUp())) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    await sleep(9500); // 等启动迁移 + 8秒后的 ob-fix 补建
    let dd = load();
    console.log('\n=== A. 存量竞态修正迁移（11/3 事故行）===');
    chk('A1 迁移日志实证命中1行', /\[req-race\] v103 修正撤扫竞态误记账 1 行/.test(srv.__log()), true);
    const acc = dd.requisitions.find((r) => r.no === 'LL2026110308231354').items.find((i) => String(i.partNo).toUpperCase() === '8889330048');
    chk('A2 实发更正 400→200', acc.transferQty, 200);
    chk('A3 issued 剔除在库框300090', (acc.issued || []).map((e) => String((typeof e === 'string' ? e : e.c)).toUpperCase()), ['N26J290107']);
    chk('A4 撤销300090出库承诺', !!dd.seenOut['N26J300090'], false);
    chk('A5 290107承诺保留（真实出库）', !!dd.seenOut['N26J290107'], true);
    const hh = (dd.requisitions.find((r) => r.no === 'LL2026110308231354').history || []).filter((x) => /竞态修正/.test(String(x.text || '')));
    chk('A6 history 留痕1条且写明400→200', hh.length === 1 && /由 400 更正为 200/.test(hh[0].text), true);
    chk('A7 300090 账本在架不动(200件A-04-1F)', (() => { const x = dd.ledger.find((y) => y.c === 'N26J300090'); return x ? [x.l, x.q] : null; })(), ['NB02-A-04-1F', 200]);
    console.log('\n=== B. 补建不坐实在库框 ===');
    chk('B1 无 SRV-DT 单含300090（竞态框不被补建）', (() => { for (const o of Object.values(dd.outbound || {})) { if (!/^SRV-DT/.test(String(o.orderNo))) continue; for (const i of o.items || []) if (String(i.barcode || '').toUpperCase() === 'N26J300090') return false; } return true; })(), true);
    chk('B2 事故单290107原台账保持唯一（不重复补）', (() => { let n = 0; for (const o of Object.values(dd.outbound || {})) for (const i of o.items || []) if (String(i.barcode || '').toUpperCase() === 'N26J290107') n++; return n; })(), 1);
    const tk = (await post('/api/login', null, { username: 'e2e_race_wh', password: 'E2e#Race!pw' })).json.token;
    const rid = load().requisitions.find((r) => r.no === 'LL-E2E-RACE-1').id;
    console.log('\n=== C. 转单回写按实传框记账（竞态守卫）===');
    const t1 = await post(`/api/requisitions/${rid}/transfer`, tk, { partNo: '88E2ERACE1', codes: [{ c: 'E2ERACE0Y', q: 200 }] });
    chk('C1 转单受理', t1.json.ok, true);
    await sleep(500);
    dd = load();
    const row1 = dd.requisitions.find((r) => r.id === rid).items.find((i) => i.partNo === '88E2ERACE1');
    chk('C2 竞态框X被自动回滚，issued只剩实传Y', (row1.issued || []).map((e) => String(e.c).toUpperCase()), ['E2ERACE0Y']);
    chk('C3 实发按Y记账=200（非X+Y=300）', row1.transferQty, 200);
    chk('C4 承诺只登记Y，X不被误登', [!!dd.seenOut['E2ERACE0Y'], !!dd.seenOut['E2ERACE0X']], [true, false]);
    const h1 = (dd.requisitions.find((r) => r.id === rid).history || []).filter((x) => /退回 88E2ERACE1 标签 E2ERACE0X/.test(String(x.text || '')));
    chk('C5 history留痕X回滚', h1.length >= 1, true);
    chk('C6 X账本行保留（在架未动）', !!dd.ledger.find((x) => x.c === 'E2ERACE0X'), true);
    console.log('\n=== D. 撤扫即时应答 + 账面同步复位（物理联动异步）===');
    const t0 = Date.now();
    const t2 = await post(`/api/requisitions/${rid}/unscan`, tk, { partNo: '88E2ERACE2', barcode: 'E2ERACE0Z' });
    const el = Date.now() - t0;
    chk('D1 撤扫受理', t2.json.ok, true);
    chk('D2 即时应答（<2秒，旧版同步等联动可拖8秒+）', el < 2000, true);
    chk('D3 响应带最新单据', !!t2.json.req, true);
    await sleep(700); // save 防抖落盘
    dd = load();
    const row2 = dd.requisitions.find((r) => r.id === rid).items.find((i) => i.partNo === '88E2ERACE2');
    chk('D4 issued已移除Z（账面同步复位）', (row2.issued || []).length, 0);
    chk('D5 Z账本复挂回位（同步部分不异步）', (() => { const x = dd.ledger.find((y) => y.c === 'E2ERACE0Z'); return x ? x.l : null; })(), LZ);
    console.log('\n=== E. 幂等：二次启动不重复修正 ===');
    await sleep(500);
    srv.kill(); await sleep(600); try { srv.kill('SIGKILL'); } catch (_) {}
    const s2 = startSrv(); srv = s2;
    chk('E1 二次启动就绪', await waitUp(), true);
    await sleep(9500);
    chk('E2 竞态修正静默（不重复跑）', /\[req-race\] v103 修正撤扫竞态/.test(srv.__log()), false);
    dd = load();
    const acc2 = dd.requisitions.find((r) => r.no === 'LL2026110308231354').items.find((i) => String(i.partNo).toUpperCase() === '8889330048');
    chk('E3 修正值跨重启不漂移', [acc2.transferQty, (acc2.issued || []).length], [200, 1]);
    chk('E4 开关持久', dd.reqRaceFixedV103, 1);
    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    try { srv.kill('SIGKILL'); } catch (_) {}
    await sleep(400);
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
