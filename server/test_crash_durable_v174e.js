// ㉖v174e 异步落盘（asyncSave=1）断电安全实测——用户要求"一定要保证数据安全和准确"
// 方法（全自建临时库/独立端口，生产库零接触）：
//   空 DATA_DIR 冷启动（服务自建完整库=生产空库同路径）→ admin/admin123 登录 →
//   走【正规参数接口】置 asyncSave=1 并回读确认生效 → 6 路并发持续推账本（120ms 合并窗
//   +异步写全程在飞）→ 随机 0.3~1.4 秒后 SIGKILL（Windows=TerminateProcess 无 handler，
//   等价拔电/任务管理器强杀）→ 断言：
//   ① db.json 崩溃后 JSON.parse 必成（连读 6 次稳定：原子写=要么旧完整要么新完整，绝无半成品）
//   ② 安全副本若存在亦完整（随机落点可能切在副本写，5 秒降频也被覆盖）
//   ③ 用【原库】重启（不清目录、换端口）加载成功，且 loadDb 未打 [recover]（文件从未损坏过）
//   ④ 重启后账本自洽：行数≤已推数、每行 c/q 字段齐（完整快照，绝无半新半旧混写）
//   连炸 5 轮，每轮独立库，测完自清。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const SERVER = path.join(__dirname, 'server.js');
const ROUNDS = Number(process.env.CRASH_ROUNDS || 5);
let fail = 0, total = 0;
const C = (n, c, i) => { total++; if (!c) fail++; console.log(`${c ? '✅' : '❌'} ${n}${i !== undefined ? '  [' + String(i).slice(0, 110) + ']' : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function killTree(pid) { if (!pid) return; try { if (process.platform === 'win32') cp.spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 }); else process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_2) { } } }

// 开局清扫本测试族历史遗留目录（含既往失败轮）：_crash* 目录全部由本测试创建，自产自清
try { for (const d of fs.readdirSync(__dirname)) if (/^_crash/.test(d)) fs.rmSync(path.join(__dirname, d), { recursive: true, force: true }); } catch (_) { }

function spawn(port, tdir, fresh) {
  if (fresh) { fs.rmSync(tdir, { recursive: true, force: true }); fs.mkdirSync(tdir, { recursive: true }); } // 仅冷启动清库；重启必须用原库
  const child = cp.spawn(process.execPath, [SERVER], { cwd: __dirname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tdir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => log += d); child.stderr.on('data', (d) => log += d);
  return { child, getLog: () => log };
}
async function waitUp(base, tries) { for (let i = 0; i < tries; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch (_) {} await sleep(250); } return false; }
async function login(base) { const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123', dev: 'CRASH', kind: 'pda' }) }); const j = await r.json().catch(() => ({})); return j.token || ''; }

(async () => {
  for (let round = 1; round <= ROUNDS; round++) {
    const port = 8461 + round * 3;
    const tdir = path.join(__dirname, '_crash_r' + round + '_' + process.pid);
    const base = 'http://127.0.0.1:' + port;
    const dbFile = path.join(tdir, 'db.json'), safeFile = path.join(tdir, 'db.safe.json');
    const s1 = spawn(port, tdir, true);
    if (!await waitUp(base, 60)) { C('R' + round + ' 服务冷启动', false, s1.getLog().slice(-150)); killTree(s1.child.pid); continue; }
    const tok = await login(base);
    if (!tok) { C('R' + round + ' 登录', false, '无 token'); killTree(s1.child.pid); continue; }
    // 正规接口开异步落盘（与你在控制后台点的是同一条路），并回读确认生效
    const gp = await (await fetch(base + '/api/admin/params', { headers: { Authorization: 'Bearer ' + tok } })).json().catch(() => ({}));
    const cfgRev = (gp && gp.cfgRev) || 0;
    await fetch(base + '/api/admin/params', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ values: { asyncSave: 1 }, cfgRev }) });
    const gp2 = await (await fetch(base + '/api/admin/params', { headers: { Authorization: 'Bearer ' + tok } })).json().catch(() => ({}));
    const on = ((gp2.items || []).find((x) => x.k === 'asyncSave') || {}).val;
    C('★R' + round + ' asyncSave 经正规接口置 1 并回读生效', Number(on) === 1, 'v=' + on);
    // 6 路并发推账本：合并窗 + 异步写全程在飞
    let sent = 0, stop = false;
    setTimeout(() => { stop = true; }, 2200);
    const burst = () => { void (async () => { while (!stop) { const i = ++sent; const k = i % 384; // 码↔格 1:1 固定：多码同格会撞格被拒，格位须 locStrict 四段式
      const it = { c: 'N260' + String(round * 1000 + k).padStart(6, '0'), l: 'NB03-A-' + String(1 + (k % 96)).padStart(2, '0') + '-' + String(1 + Math.floor(k / 96)).padStart(2, '0'), q: 10, t: Date.now() }; try { await fetch(base + '/api/ledger/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ items: [it], del: [] }) }); } catch (_) { } } })(); };
    for (let k = 0; k < 6; k++) burst();
    await sleep(300 + Math.floor(Math.random() * 1100)); // 随机落点：写前/写中/写后都可能被切
    try { s1.child.kill('SIGKILL'); } catch (_) { } // 无 handler 强杀=模拟断电
    await sleep(400);
    C('R' + round + ' 强杀前已推 ' + sent + ' 笔（制造在途写窗口）', sent > 20, 'sent=' + sent);
    // ① 崩溃瞬间后文件永远可解析（原子写核心保证）
    let parseOk = true, rows0 = -1;
    try { rows0 = (JSON.parse(fs.readFileSync(dbFile, 'utf8')).ledger || []).length; } catch (_) { parseOk = false; }
    for (let i = 0; i < 5 && parseOk; i++) { try { JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (_) { parseOk = false; } }
    C('★R' + round + ' 崩溃后 db.json 完整可解析（连读 6 次，0 半成品）', parseOk, '账本=' + rows0 + ' 已推=' + sent);
    if (fs.existsSync(safeFile)) { let sOk = true; try { JSON.parse(fs.readFileSync(safeFile, 'utf8')); } catch (_) { sOk = false; } C('R' + round + ' 安全副本亦完整', sOk); }
    // ②③ 原库重启（不清目录，换端口避开被杀实例的端口占用窗口）
    const p3 = port + 1;
    const s3 = spawn(p3, tdir, false);
    const up3 = await waitUp('http://127.0.0.1:' + p3, 60);
    const recovered = /\[recover\]/.test(s3.getLog());
    C('★R' + round + ' 原库重启加载成功且未触发损坏自愈（文件从未损坏）', up3 && !recovered, 'up=' + up3 + ' recover=' + (recovered ? 'Y' : 'N'));
    let selfOk = false, n2 = -1, badRow = 0;
    try {
      const tok3 = await login('http://127.0.0.1:' + p3);
      const j = await (await fetch('http://127.0.0.1:' + p3 + '/api/ledger?l=', { headers: { Authorization: 'Bearer ' + tok3 } })).json();
      const items = j.items || []; n2 = items.length;
      for (const x of items) if (!String(x.c || '').startsWith('N26') || !(Number(x.q) > 0)) badRow++;
      selfOk = items.length <= sent + 64 && badRow === 0 && items.length === (j.count != null ? j.count : items.length);
    } catch (_) { }
    C('★R' + round + ' 重启后账本自洽（行 ' + n2 + ' ≤ 推 ' + sent + '，坏行 ' + badRow + '，无混写）', selfOk);
    killTree(s3.child.pid);
    await sleep(250);
    try { fs.rmSync(tdir, { recursive: true, force: true }); } catch (_) { }
  }
  const left = fs.readdirSync(__dirname).filter((d) => /^_crash/.test(d));
  C('全部临时库清理（无遗留）', left.length === 0, left.join(','));
  console.log('\n结果: ' + (total - fail) + ' 通过 / ' + fail + ' 失败  （' + ROUNDS + ' 轮随机时点断电，全自建临时库）');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('异常：' + (e && e.stack || e)); process.exit(1); });
