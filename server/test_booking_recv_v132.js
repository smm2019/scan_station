// ㉖v132 预约到料改"二楼转入才计" · 实例证明
// 用户拍板：来料区扫码(NB04)只是"到了一楼"，预约到料/进度/自动开单必须等二楼转入落 NB02/NB03 才触发——
// 杜绝"单先到、货还躺在来料区拣不了"的时间差（bookingFulfill 自动开单发生在 NB04 阶段=病）
// 承重前提（已代码坐实）：ledgerPut 用推送行 t，转入=新采集时刻刷新 t → 跨日转入照样计入"今日到料"；
//   断料预警走 partBoxCounts（含 NB04，本次零改动）——登记一楼仍会解除断料预警，方向不变
// 证明面：
// S1 预订2框：推2框到 NB04（够数）→ 不开单、got=0（旧行为此处必开单）
// S2 转入2框到 NB02 → 自动开单、qty=件数换算(2×300=600)、got=2
// S3 跨日（独立预订 PN3 qty=1）：前天登记 NB04 → 不计；今天转入 NB02（t=今天）→ got=1（t 刷新前提端到端复现）
// S4 断料预警口径不变：partBoxCounts 无 locRecv 排除；到料循环含排除
// S5 纯提醒型预约：NB04 阶段 watchSeen 不落键（不发"今日首次"通知）
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto');
const SRC = path.join(__dirname, 'data'), TDIR = path.join(__dirname, 'data_e2e_bookrecv_v132');
const PORT = 8398, BASE = 'http://127.0.0.1:' + PORT;
fs.rmSync(TDIR, { recursive: true, force: true }); fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
const now = Date.now();
db0.users.push({ id: 'u_v2mt', username: 'v132_mt', name: 'V132预订人', role: 'material', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V2!mt', salt) });
db0.users.push({ id: 'u_v2wh', username: 'v132_wh', name: 'V132仓管', role: 'warehouse', enabled: true, createdAt: now, mustChangePw: false, salt, passHash: hashPw('E2e#V2!wh', salt) });
const PN = '88V132BK001', PN2 = '88V132BK002', PN3 = '88V132BK003';
db0.watchlist = (db0.watchlist || []).concat([
  { userId: 'u_v2mt', partNo: PN, itemName: 'V132预订甲', qty: 2, auto: true, due: '', at: now - 1000, got: 0, filledReq: '' },
  { userId: 'u_v2mt', partNo: PN2, itemName: 'V132预订乙', qty: 0, auto: true, due: '', at: now - 1000, got: 0, filledReq: '' }, // 纯提醒型
  { userId: 'u_v2mt', partNo: PN3, itemName: 'V132预订丙', qty: 1, auto: true, due: '', at: now - 1000, got: 0, filledReq: '' }, // 跨日场景专用
]);
db0.params = Object.assign(db0.params || {}, { reqHoursOn: 0, receivingOn: 1 }); // 来料区启用：否则 NB04 行被停用闸正确拒（v120b）
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return (await r.json().catch(() => ({}))); }
async function get(p, tk) { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return (await r.json().catch(() => ({}))); }
let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${String(JSON.stringify(got)).slice(0, 150)} want=${String(JSON.stringify(want)).slice(0, 150)}`); };
const chkT = (n, c, why) => { total++; if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL!'} [${n}]${c ? '' : ' ←' + (why || '')}`); };
(async () => {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = []; srv.stdout.on('data', (b) => log.push(String(b))); srv.stderr.on('data', (b) => log.push(String(b)));
  let up = false; for (let i = 0; i < 40 && !up; i++) { await sleep(250); try { up = (await fetch(BASE + '/api/health')).ok; } catch (_) {} }
  if (!up) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ') —— v132 预约转入才计证明');
  try {
    const wh = (await post('/api/login', null, { username: 'v132_wh', password: 'E2e#V2!wh' })).token;
    const mt = (await post('/api/login', null, { username: 'v132_mt', password: 'E2e#V2!mt' })).token;
    const occ = new Set(db0.ledger.map((x) => String(x.l || '').toUpperCase()));
    const freeRack = []; for (const z of ['A', 'B']) for (let r = 16; r >= 1 && freeRack.length < 4; r--) for (const f of ['4F', '3F']) { const k = `NB02-${z}-${String(r).padStart(2, '0')}-${f}`; if (!occ.has(k)) freeRack.push(k); }
    const reqsOf = async () => { const j = await get('/api/requisitions', mt); const list = Array.isArray(j) ? j : (j.reqs || j.list || []); return list.filter((r) => (r.items || []).some((i) => String(i.partNo || '').toUpperCase() === PN)); };
    const wlOf = async (pn) => { const j = await get('/api/watchlist', mt); return ((j.list || []).find((x) => String(x.partNo).toUpperCase() === pn) || {}); }; // watchlist 按属主过滤：必须预订人 token
    // ===== S1 两框只登记到 NB04（够预订数）→ 不计到料、不开单 =====
    const s1 = await post('/api/ledger/sync', wh, { items: [
      { c: 'V132A00001', l: 'NB04-A-01-021', p: PN, n: 'V132预订甲', q: 300, b: 'B261109', t: now, mv: '登记', src: '来料区', pid: 'T132A' },
      { c: 'V132A00002', l: 'NB04-A-01-022', p: PN, n: 'V132预订甲', q: 300, b: 'B261109', t: now, mv: '登记', src: '来料区', pid: 'T132B' },
    ] });
    chkT('S1a 两框 NB04 登记上账', s1.added >= 2, JSON.stringify(s1).slice(0, 160));
    await sleep(1500);
    chk('S1b 来料阶段预约不开单（旧行为此处必开单）', (await reqsOf()).length, 0);
    chk('S1c 来料阶段 got=0（NB04 不计到料）', Number((await wlOf(PN)).got) || 0, 0);
    chkT('S1d 服务日志无该零件 booking 开单记录', !log.join('').includes(PN + ' 够数自动开单'), '');
    // ===== S2 二楼转入两框 → 够数自动开单，件数换算 =====
    const s2 = await post('/api/ledger/sync', wh, { items: [
      { c: 'V132A00001', l: freeRack[0], p: PN, n: 'V132预订甲', q: 300, b: 'B261109', t: Date.now(), mv: 'AGV', src: '来料区转入', pid: 'T132A' },
      { c: 'V132A00002', l: freeRack[1], p: PN, n: 'V132预订甲', q: 300, b: 'B261109', t: Date.now(), mv: 'AGV', src: '来料区转入', pid: 'T132B' },
    ] });
    chkT('S2a 两框转入迁移（同行改位 updated≥2）', s2.ok === true && s2.updated >= 2, JSON.stringify(s2).slice(0, 160));
    await sleep(1500);
    const r2 = await reqsOf();
    chk('S2b 转入后自动开单 1 张', r2.length, 1);
    chk('S2c 开单件数=600（2框×300，件数换算口径不变）', r2[0] && r2[0].items[0].qty, 600);
    const w2 = await wlOf(PN);
    chk('S2d 预约 got=2 且已履行', [Number(w2.got) || 0, !!w2.filledReq], [2, true]);
    // ===== S3 跨日转入（独立预订 PN3）：前天登记 NB04 不计、今天转入计入 =====
    const yst = now - 2 * 36e5;
    const s3a = await post('/api/ledger/sync', wh, { items: [{ c: 'V132B00003', l: 'NB04-A-01-023', p: PN3, n: 'V132预订丙', q: 200, b: 'B261108', t: yst, mv: '登记', src: '来料区', pid: 'T132C' }] });
    chkT('S3a 跨日框 NB04 登记（t=前天）', s3a.added >= 1, JSON.stringify(s3a).slice(0, 140));
    await sleep(1200);
    chk('S3b 跨日 NB04 阶段不计（PN3 got=0）', Number((await wlOf(PN3)).got) || 0, 0);
    const s3c = await post('/api/ledger/sync', wh, { items: [{ c: 'V132B00003', l: freeRack[2], p: PN3, n: 'V132预订丙', q: 200, b: 'B261108', t: Date.now(), mv: 'AGV', src: '来料区转入', pid: 'T132C' }] });
    chkT('S3d 跨日框今天转入（t=今天）迁移成功', s3c.ok === true && s3c.updated >= 1, JSON.stringify(s3c).slice(0, 140));
    await sleep(1500);
    chk('S3e 跨日转入计入今日到料（PN3 got=1，t 刷新前提端到端成立）', Number((await wlOf(PN3)).got) || 0, 1);
    // ===== S4 断料预警口径不变（partBoxCounts 含 NB04） =====
    const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
    const pbc = src.slice(src.indexOf('function partBoxCounts'), src.indexOf('function partBoxCounts') + 420);
    chk('S4a partBoxCounts 不排除 NB04（断料预警/在架统计口径零改动）', /locRecv/.test(pbc), false);
    chkT('S4b stockWatchScan 到料循环含 locRecv 排除', /if \(\(x\.t \|\| 0\) < t0\.getTime\(\) \|\| locRecv\(x\.l\)\) continue/.test(src), '');
    // ===== S5 纯提醒型预约：NB04 阶段 watchSeen 不落键（不发"今日首次"通知） =====
    const s5 = await post('/api/ledger/sync', wh, { items: [{ c: 'V132C00005', l: 'NB04-A-01-025', p: PN2, n: 'V132预订乙', q: 50, b: 'B261109', t: Date.now(), mv: '登记', src: '来料区', pid: 'T132D' }] });
    chkT('S5a 纯提醒型零件 NB04 登记', s5.added >= 1, JSON.stringify(s5).slice(0, 140));
    await sleep(1500);
    { const dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
      const dayKey = new Date().toISOString().slice(0, 10);
      chkT('S5b NB04 阶段纯提醒型不发通知（watchSeen 无 PN2 今日键）', !Object.keys(dd.watchSeen || {}).some((k) => k.startsWith(PN2) && k.endsWith('|' + dayKey)), JSON.stringify(Object.keys(dd.watchSeen || {})).slice(0, 160)); }
  } catch (e) { console.log(e.stack); chkT('X 异常 ' + e.message, false); }
  const uncaught = log.join('').split('\n').filter((s) => /uncaught|referenceerror|typeerror/i.test(s));
  chkT('Z 服务日志无未捕获异常', uncaught.length === 0, uncaught.join('\n').slice(0, 200));
  srv.kill('SIGKILL'); fs.rmSync(TDIR, { recursive: true, force: true });
  console.log(`\n===== v132 预约转入才计实例证明 ${total - fail}/${total} PASS =====`);
  process.exit(fail ? 1 : 0);
})();
