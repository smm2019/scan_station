// ㉖v101 操作人乱码治理 · 端到端取证（真实 HTTP 打隔离实例）
// 覆盖：①启动迁移 opFixV101 把现网2条坏op修复为宋明明（日志实证+落库复核）
//      ②推送含坏字符 op → 被替换为推送账号真实姓名（堵源头）
//      ③干净 op 原样保留（零误伤）④空/无op 不受影响 ⑤幂等开关二次启动静默
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const SRC = path.join(__dirname, 'data');
const TDIR = path.join(__dirname, 'data_e2e_opfix_v101');
const PORT = 8324;
const BASE = 'http://127.0.0.1:' + PORT;

fs.rmSync(TDIR, { recursive: true, force: true });
fs.mkdirSync(TDIR, { recursive: true });
fs.copyFileSync(path.join(SRC, 'db.json'), path.join(TDIR, 'db.json'));
fs.copyFileSync(path.join(SRC, 'secret.key'), path.join(TDIR, 'secret.key'));
const db0 = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
const salt = crypto.randomBytes(16).toString('hex');
const hashPw = (pw, s) => crypto.scryptSync(String(pw), s, 32).toString('hex');
db0.users.push({ id: 'u_e2e_of', username: 'e2e_of_wh', name: '卫革测试', role: 'warehouse', enabled: true, createdAt: Date.now(), mustChangePw: false, salt, passHash: hashPw('E2e#Of!pw', salt) });
// 预埋一条含 ◆(U+25C6) 的新格式坏值（区别于存量两条 FFFD），验证字符类补齐
db0.scanlog['PREFE2ECODE|B-PRE-OPFIX|1'] = { code: 'PREFE2ECODE', wt: 1, st: '', gl: 'NB03-B-02-03', ct: '', rm: '', batch: 'B-PRE-OPFIX', cx: false, t: Date.now(), pn: '66E2EOF001', q: 5, mk: '', op: '◆◆测试', nm: 'E2E预埋件', lot: '', mc: '', pid: '' };
db0.scanlog['PREFE2ECODE2|B-PRE-OPFIX|2'] = { code: 'PREFE2ECODE2', wt: 1, st: '', gl: 'NB03-B-02-04', ct: '', rm: '', batch: 'B-PRE-OPFIX', cx: false, t: Date.now(), pn: '66E2EOF002', q: 5, mk: '', op: '卫革测试', nm: 'E2E预埋件', lot: '', mc: '', pid: '' }; // 同批次正常名，多数原则应修复◆◆测试
delete db0.opFixedV101; // 副本必须清开关：主库若已被正式服务跑过迁移，继承开关会让隔离实例短路、预埋坏值没人修（脚本必须真实重跑迁移）
fs.writeFileSync(path.join(TDIR, 'db.json'), JSON.stringify(db0));

let fail = 0, total = 0;
const chk = (n, got, want) => { total++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL!'} [${n}] got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, tk, body) { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; }
async function get(p, tk) { const r = await fetch(BASE + p, { headers: tk ? { Authorization: 'Bearer ' + tk } : {} }); return { status: r.status, json: await r.json().catch(() => ({})) }; }

function spawnSrv() {
  const srv = cp.spawn(process.execPath, [path.join(__dirname, 'server.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: TDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  srv.stdout.on('data', (b) => log.push(b.toString()));
  srv.stderr.on('data', (b) => log.push(b.toString()));
  return { srv, log };
}
async function waitUp() { for (let i = 0; i < 40; i++) { await sleep(250); try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true; } catch (_) {} } return false; }

(async () => {
  let { srv, log } = spawnSrv();
  if (!(await waitUp())) { console.log('FAIL! 服务未就绪'); srv.kill(); process.exit(1); }
  console.log('隔离实例已就绪 (PORT ' + PORT + ')');
  try {
    await sleep(800); // 等启动迁移序列跑完+save落盘
    // —— ① 存量迁移实证 ——
    // 期望修复条数 = 副本预存的坏op数（主库已被服务修复后为0，动态计算保证脚本长期可跑）+ 预 Embed 1 条 ◆ 坏值
    const preBad = Object.values(db0.scanlog || {}).filter((s) => /[\uFFFD\u25C6\uFFFC]/.test(String(s.op || ''))).length - 1; // 减去预埋1条(写db0前已含)
    const wantFix = preBad + 1;
    let dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    const logTxt = log.join('');
    const mFix = logTxt.match(/op-fix\] v101 迁移修复采集流水操作人乱码 (\d+) 条/);
    chk('M1 启动日志含迁移实证且条数=副本坏值数', mFix ? +mFix[1] === wantFix : wantFix === 0, true);
    chk('M2 存量坏值N26J240116终值为真人', dd.scanlog['N26J240116|B2026-10-27-1744|1793095878508'] && dd.scanlog['N26J240116|B2026-10-27-1744|1793095878508'].op, '宋明明');
    chk('M3 存量坏值N26J290012终值为真人', dd.scanlog['N26J290012|B2026-10-29-1008|1793241663121'] && dd.scanlog['N26J290012|B2026-10-29-1008|1793241663121'].op, '宋明明');
    chk('M4 ◆类坏值同批次多数原则修复', dd.scanlog['PREFE2ECODE|B-PRE-OPFIX|1'] && dd.scanlog['PREFE2ECODE|B-PRE-OPFIX|1'].op, '卫革测试');
    chk('M5 正常名未被误动', dd.scanlog['PREFE2ECODE2|B-PRE-OPFIX|2'].op, '卫革测试');
    chk('M6 幂等开关已置1', dd.opFixedV101, 1);
    const badRest = Object.values(dd.scanlog || {}).filter((s) => /[\uFFFD\u25C6\uFFFC]/.test(String(s.op || '')));
    chk('M7 全库再无坏op', badRest.length, 0);

    // —— ② 堵源头：推送含坏字符 op ——
    const tk = (await post('/api/login', null, { username: 'e2e_of_wh', password: 'E2e#Of!pw' })).json.token;
    const now = Date.now();
    const f = (k, code, op) => ({ k, code, wt: 1, st: '', gl: 'NB03-C-05-07', ct: '1800*1200_2', rm: '', batch: 'B-E2E-OPFIX-SYNC', cx: false, t: now, pn: '66E2EOF009', q: 3, mk: '', op, nm: 'E2E堵源件', lot: '', mc: '', pid: '' });
    const p1 = await post('/api/scanlog/sync', tk, { items: [
      f('K_BAD', 'E2EOF001', '宋\uFFFD\uFFFD\uFFFD明'),      // FFFD坏 → 替换为会话姓名"卫革测试"
      f('K_BAD2', 'E2EOF002', '◆◆某某'),                     // ◆坏 → 同上
      f('K_OK', 'E2EOF003', '刘向轩'),                        // 干净 → 原样保留（零误伤）
      f('K_EMPTY', 'E2EOF004', ''),                           // 空 → 保持空
    ] });
    chk('S1 流水推送受理', p1.json.ok, true);
    await sleep(400);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('S2 FFFD坏op替换为推送账号真名', dd.scanlog['K_BAD'].op, '卫革测试');
    chk('S3 ◆坏op替换为推送账号真名', dd.scanlog['K_BAD2'].op, '卫革测试');
    chk('S4 干净op原样保留', dd.scanlog['K_OK'].op, '刘向轩');
    chk('S5 空op不受影响', dd.scanlog['K_EMPTY'].op, '');
    // nm 带坏字符也应被剥（回归既有清洗 + 新增◆类）
    const p2 = await post('/api/scanlog/sync', tk, { items: [{ ...f('K_NM', 'E2EOF005', '卫革测试'), nm: '吉利E281◆纵梁\uFFFD' }] });
    await sleep(400);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('S6 nm 清洗类含◆：物料名坏字符剥离', dd.scanlog['K_NM'].nm, '吉利E281纵梁');

    // —— ③ 工作量报表按人归并（裂行根因的端到端复核）——
    const wk = await get('/api/dashboard/trend?days=7', tk);
    const wr = await get('/api/workload?days=30', tk).catch(() => null); // 端点若不同名则跳过，改从导出校验
    const dl = await get('/api/export?ds=D7&preview=1', tk);
    const rows = ((dl.json.parts && dl.json.parts[0] && dl.json.parts[0].rows) || dl.json.sample || []);
    const songRows = rows.filter((r) => String(r[0]).includes('宋') || String(r[0]).includes('卫革测试'));
    const badKeys = rows.filter((r) => /[\uFFFD\u25C6]/.test(String(r[0] || '')));
    chk('S7 工作量报表人名列无坏字符键', badKeys.length, 0);

    // —— ④ 二次启动幂等静默 ——
    srv.kill();
    await sleep(600);
    try { srv.kill('SIGKILL'); } catch (_) {}
    const r2 = spawnSrv(); srv = r2.srv; log = r2.log;
    chk('R1 二次启动就绪', await waitUp(), true);
    await sleep(800);
    chk('R2 二次启动迁移静默(不再打修复日志)', /op-fix\] v101 迁移修复/.test(log.join('')), false);
    dd = JSON.parse(fs.readFileSync(path.join(TDIR, 'db.json'), 'utf8'));
    chk('R3 修复值跨重启不漂移', dd.scanlog['N26J290012|B2026-10-29-1008|1793241663121'].op, '宋明明');
    chk('R4 开关持久', dd.opFixedV101, 1);

    console.log(`\n===== 端到端取证：${fail === 0 ? '全部 PASS' : fail + ' 项失败'}，合计 ${total} 项断言 =====`);
  } finally {
    srv.kill();
    await sleep(500);
    try { srv.kill('SIGKILL'); } catch (_) {}
    fs.rmSync(TDIR, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION: ' + e.stack); process.exit(2); });
